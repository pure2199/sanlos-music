// ---------------------------------------------------------------------------
// 本地曲目登记表（T38，**主进程**）
// ---------------------------------------------------------------------------
//
// 职责
// - 维护一张「本地曲目登记表」（`<userData>/local-library.json`）：
//   用户通过对话框挑进来的本地音频文件，登记在案；
// - 提供 `fnml://` 的 lookup（`localPath(id)`）——渲染进程**只能给 id**，
//   **给不出路径**；
// - 弹文件 / 文件夹选择对话框，递归扫描目录。
//
// 安全边界
// - 渲染进程给的路径**只是候选**：主进程必须 **stat + 扩展名白名单 +
//   确认是文件** 才登记；
// - 登记的是**绝对路径本身**（不是拼接出来的）→ 目录外的路径用户选不出来，
//   渲染进程也伪造不出来；
// - 移除操作**只改清单**，**绝不删用户的音乐文件**；
// - 本模块**不出网**、不碰 token。
//
// 模块约束
// - **模块顶层不得 import Electron**：`dialog` 与 `ipcMain` 一律**惰性解析**
//   （同 `electron/schemes.ts` 的写法）→ 单测能跑在普通 Node（Vitest）。
// - 文件读写**可注入**：单测用内存替身，**不碰真实磁盘**。

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { LOCAL_TRACK_ID_PREFIX } from '../shared/localMedia'
import { AUDIO_EXTENSIONS, fileExtension, isAudioFileName, parseTrackFileName } from '../shared/localMeta'
import type { LocalLibraryItem } from '../shared/playerBridge'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本地曲目清单文件名（落在 `app.getPath('userData')` 下）。 */
export const LOCAL_LIBRARY_FILE_NAME = 'local-library.json'

/** 清单结构版本号。 */
export const LOCAL_LIBRARY_VERSION = 1

/** 目录扫描的最大深度（**防环**：符号链接 / junction 会成环）。 */
export const MAX_SCAN_DEPTH = 8

/** 单次目录扫描最多登记多少个文件（**防拖死主进程**）。 */
export const MAX_SCAN_FILES = 20000

// ---------------------------------------------------------------------------
// 文件系统替身
// ---------------------------------------------------------------------------

/** 目录项（`readdir` 的一项）。 */
export interface LocalDirEntry {
  /** 条目名（**不含**父目录）。 */
  name: string
  /** 是不是普通文件。 */
  isFile: boolean
  /** 是不是目录。 */
  isDirectory: boolean
  /** 是不是符号链接 / reparse point（**扫描时要跳过**，否则成环）。 */
  isSymbolicLink: boolean
}

/** 文件信息（只需要大小）。 */
export interface LocalFileStat {
  /** 字节数。 */
  size: number
}

/**
 * 文件系统替身（**单测注入内存实现**，不碰真实磁盘）。
 */
export interface LocalLibraryFs {
  /** 读文本文件。 */
  readText(path: string): Promise<string>
  /** 写文本文件（**要自带建目录**）。 */
  writeText(path: string, text: string): Promise<void>
  /** 改名（原子写的最后一步）。 */
  rename(from: string, to: string): Promise<void>
  /** 删文件（清理临时文件用）。 */
  remove(path: string): Promise<void>
  /** 列目录（拿不到就抛 → 调用方按「读不到」处理）。 */
  listDir(path: string): Promise<LocalDirEntry[]>
  /** 取文件大小；**不是文件**或**不存在**都返回 `null`。 */
  statFile(path: string): Promise<LocalFileStat | null>
}

/** 默认实现：真实 `node:fs/promises`。 */
const nodeFs: LocalLibraryFs = {
  readText: async (path) => await readFile(path, 'utf8'),
  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  },
  rename: async (from, to) => {
    await rename(from, to)
  },
  remove: async (path) => {
    await rm(path, { force: true })
  },
  listDir: async (path) => {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
  },
  statFile: async (path) => {
    try {
      const info = await stat(path)
      return info.isFile() ? { size: info.size } : null
    } catch {
      return null
    }
  },
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 由**绝对路径**生成曲目 id。
 *
 * 形状：`local:<sha1(绝对路径) 前 16 位十六进制>`。
 *
 * ⚠️ **稳定**：同一路径永远同一个 id → 重复添加自动去重；
 * ⚠️ **与 NAS 的 guid 不冲突**：服务端 guid 是 32 位十六进制，没有 `local:` 前缀。
 *
 * @param absolutePath 绝对路径（**先 `resolve()` 再传进来**，否则相对路径会算出另一个 id）。
 */
export function localTrackId(absolutePath: string): string {
  const digest = createHash('sha1').update(absolutePath).digest('hex').slice(0, 16)
  return `${LOCAL_TRACK_ID_PREFIX}${digest}`
}

/**
 * 把清单里的一项**校验 + 归一**（清单文件是用户可编辑的）。
 *
 * @returns 合法项；不合法返回 `null`（**整条丢弃**，不修）。
 */
export function sanitizeLocalItem(value: unknown): LocalLibraryItem | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const path = typeof record['path'] === 'string' ? record['path'] : ''
  if (id.length === 0 || path.length === 0) return null
  const size = record['size']
  return {
    id,
    path,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    artist: typeof record['artist'] === 'string' ? record['artist'] : '',
    size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
    ext: typeof record['ext'] === 'string' ? record['ext'] : '',
    addedAt: typeof record['addedAt'] === 'string' ? record['addedAt'] : '',
  }
}

/**
 * 递归收集目录里的**音频文件**绝对路径。
 *
 * ⚠️ **有上限**（防止一个巨大的目录把主进程拖死）：
 * - 深度 ≤ `maxDepth`（默认 8）——这同时是**防环**的兜底；
 * - 数量 ≤ `maxFiles`（默认 20000）。
 *
 * ⚠️ **跳过符号链接 / reparse point**：Windows 的 junction 会成环。
 *
 * @param folder 目录绝对路径。
 * @param fs 文件系统（缺省：真实 `node:fs`）。
 * @param options 上限（单测用）。
 * @returns 音频文件的绝对路径（**按目录项名排序**，结果稳定）。
 */
export async function collectAudioFiles(
  folder: string,
  fs: LocalLibraryFs = nodeFs,
  options: { maxDepth?: number; maxFiles?: number } = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES
  const found: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    if (found.length >= maxFiles) return
    let entries: LocalDirEntry[]
    try {
      entries = await fs.listDir(dir)
    } catch {
      // 读不到（无权限 / 不是目录）→ 跳过这一层，**不抛**。
      return
    }
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of sorted) {
      if (found.length >= maxFiles) return
      if (entry.isSymbolicLink) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile) continue
      if (!isAudioFileName(entry.name)) continue
      found.push(full)
    }
  }

  await walk(folder, 0)
  return found
}

// ---------------------------------------------------------------------------
// 登记表
// ---------------------------------------------------------------------------

/** `LocalLibrary` 的构造参数。 */
export interface LocalLibraryOptions {
  /** 清单文件路径（`app.getPath('userData')` 下面）。 */
  filePath: string
  /** 文件系统替身（缺省：真实 `node:fs`）。 */
  fs?: LocalLibraryFs
}

/**
 * 本地曲目登记表。
 *
 * ⚠️ **单一真相源 = `<userData>/local-library.json`**（渲染层拿到的只是镜像）。
 */
export class LocalLibrary {
  private readonly filePath: string
  private readonly fs: LocalLibraryFs
  private items: LocalLibraryItem[] = []

  constructor(options: LocalLibraryOptions) {
    this.filePath = options.filePath
    this.fs = options.fs ?? nodeFs
  }

  /** 读清单（文件不存在 / 损坏 → **当作没有**，不抛）。 */
  async load(): Promise<LocalLibraryItem[]> {
    try {
      const raw = await this.fs.readText(this.filePath)
      const parsed = JSON.parse(raw) as { items?: unknown }
      const list = Array.isArray(parsed?.items) ? parsed.items : []
      const clean: LocalLibraryItem[] = []
      for (const item of list) {
        const normalized = sanitizeLocalItem(item)
        if (normalized) clean.push(normalized)
      }
      this.items = clean
    } catch {
      this.items = []
    }
    return this.list()
  }

  /** 当前清单（**副本**——调用方改不到内部状态）。 */
  list(): LocalLibraryItem[] {
    return this.items.map((item) => ({ ...item }))
  }

  /**
   * 按 id 查本地绝对路径。
   *
   * ⚠️ **只查登记过的**——没登记的路径**给不出来**（渲染进程伪造不了）。
   *
   * @param id 曲目 id。
   */
  localPath(id: string): string | null {
    if (typeof id !== 'string' || id.length === 0) return null
    for (const item of this.items) {
      if (item.id === id) return item.path
    }
    return null
  }

  /**
   * 登记这些路径（**幂等**）。
   *
   * ⚠️ **逐个校验**：路径必须**真实存在**、是**普通文件**、扩展名在**白名单**里
   *    ——渲染进程给不出「任意路径」。
   * ⚠️ **已经在清单里的跳过**（同路径 → 同 id → 不重复登记）。
   *
   * @param paths 绝对路径数组。
   */
  async addPaths(paths: string[]): Promise<LocalLibraryItem[]> {
    if (!Array.isArray(paths) || paths.length === 0) return this.list()
    let changed = false
    for (const raw of paths) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      const absolute = resolve(trimmed)
      const info = await this.fs.statFile(absolute)
      // ⚠️ 不是文件 / 不存在 → **跳过**（不报错：用户可能选到已被删掉的文件）。
      if (!info) continue
      if (!isAudioFileName(absolute)) continue
      const id = localTrackId(absolute)
      if (this.items.some((item) => item.id === id)) continue
      const meta = parseTrackFileName(basename(absolute))
      this.items.push({
        id,
        path: absolute,
        title: meta.title,
        artist: meta.artist,
        size: info.size,
        ext: fileExtension(absolute),
        addedAt: new Date().toISOString(),
      })
      changed = true
    }
    if (changed) await this.save()
    return this.list()
  }

  /**
   * 递归扫描目录并登记。
   *
   * @param folder 目录绝对路径。
   */
  async addFolder(folder: string): Promise<LocalLibraryItem[]> {
    const trimmed = typeof folder === 'string' ? folder.trim() : ''
    if (trimmed.length === 0) return this.list()
    const files = await collectAudioFiles(trimmed, this.fs)
    return this.addPaths(files)
  }

  /**
   * 从清单里移除一项。
   *
   * ⚠️ **只改清单，绝不删用户的音乐文件**。
   *
   * @param id 曲目 id。
   */
  async remove(id: string): Promise<LocalLibraryItem[]> {
    if (typeof id !== 'string' || id.length === 0) return this.list()
    const before = this.items.length
    this.items = this.items.filter((item) => item.id !== id)
    if (this.items.length !== before) await this.save()
    return this.list()
  }

  /** 写盘（**原子写**：先 `.tmp` 再改名）。 */
  private async save(): Promise<void> {
    const payload = { version: LOCAL_LIBRARY_VERSION, items: this.items }
    const tmpPath = `${this.filePath}.tmp`
    try {
      await this.fs.writeText(tmpPath, JSON.stringify(payload, null, 2))
      await this.fs.rename(tmpPath, this.filePath)
    } catch {
      // 半成品临时文件不能留下。
      try {
        await this.fs.remove(tmpPath)
      } catch {
        // 清理失败不掩盖原始错误。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** `ipcMain` 的最小接口（**单测注入替身**）。 */
export interface LocalIpcMainLike {
  /** 注册一个 IPC 处理器。 */
  handle(channel: string, listener: (event: unknown, arg: unknown) => unknown): void
}

/** 文件选择对话框的选项（只列我们用得上的）。 */
export interface LocalOpenDialogOptions {
  /** 对话框标题。 */
  title?: string
  /** 窗口类型（`'openFile'` / `'openDirectory'` / `'multiSelections'`）。 */
  properties?: string[]
  /** 文件类型过滤。 */
  filters?: { name: string; extensions: string[] }[]
}

/** 文件选择对话框的最小接口（**单测注入替身**）。 */
export interface LocalDialogLike {
  /** 弹文件 / 文件夹选择对话框。 */
  showOpenDialog(options: LocalOpenDialogOptions): Promise<{
    canceled: boolean
    filePaths: string[]
  }>
}

/**
 * `require` 的最小声明。
 *
 * ⚠️ Electron 主进程的产物是 CommonJS，运行时存在模块作用域的 `require`；
 *    单元测试跑在 Vitest（ESM）里没有它 → **所有使用点都必须先用 `typeof` 守卫**。
 */
declare const require: ((id: string) => unknown) | undefined

/**
 * 惰性取 Electron 的 `dialog`（**不在模块顶层调用**）。
 *
 * @returns 窄化后的对话框；非 Electron 进程里返回 `null`。
 */
export function resolveElectronDialog(): LocalDialogLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { dialog?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const dialog = (mod as { dialog?: unknown }).dialog
    if (!dialog || typeof dialog !== 'object') return null
    const raw = (dialog as { showOpenDialog?: unknown }).showOpenDialog
    if (typeof raw !== 'function') return null
    const call = raw as (options: unknown) => Promise<unknown>
    return {
      showOpenDialog: async (options) => {
        const result = await call.call(dialog, options)
        const record = (result ?? {}) as { canceled?: unknown; filePaths?: unknown }
        const paths = Array.isArray(record.filePaths)
          ? record.filePaths.filter((item): item is string => typeof item === 'string')
          : []
        return { canceled: record.canceled === true, filePaths: paths }
      },
    }
  } catch {
    return null
  }
}

/**
 * 惰性取 Electron 的 `ipcMain`（**不在模块顶层调用**）。
 *
 * @returns `ipcMain`；非 Electron 进程里返回 `null`。
 */
export function resolveElectronIpcMain(): LocalIpcMainLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { ipcMain?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const ipcMain = (mod as { ipcMain?: unknown }).ipcMain
    if (!ipcMain || typeof ipcMain !== 'object') return null
    const handle = (ipcMain as { handle?: unknown }).handle
    if (typeof handle !== 'function') return null
    return ipcMain as LocalIpcMainLike
  } catch {
    return null
  }
}

/** `registerLocalLibraryIpc` 的参数。 */
export interface LocalLibraryIpcOptions {
  /** 登记表实例。 */
  library: LocalLibrary
  /** `ipcMain` 替身；缺省时惰性取 Electron 的 `ipcMain`。 */
  ipcMain?: LocalIpcMainLike
  /** `dialog` 替身；缺省时惰性取 Electron 的 `dialog`。 */
  dialog?: LocalDialogLike
}

/** 取字符串数组（**只留字符串**）。 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 注册本地曲目 IPC（`local:*`）。
 *
 * | 通道              | 入参            | 出参                  |
 * |-------------------|-----------------|-----------------------|
 * | `local:list`      | 无              | `LocalLibraryItem[]`  |
 * | `local:pick-files`| 无              | `string[]`（取消 = `[]`） |
 * | `local:pick-folder`| 无             | `string`（取消 = `''`） |
 * | `local:add`       | `string[]`      | `LocalLibraryItem[]`  |
 * | `local:add-folder`| `string`        | `LocalLibraryItem[]`  |
 * | `local:remove`    | `string`（id）  | `LocalLibraryItem[]`  |
 */
export function registerLocalLibraryIpc(opts: LocalLibraryIpcOptions): void {
  const ipcMain = opts.ipcMain ?? resolveElectronIpcMain()
  const dialog = opts.dialog ?? resolveElectronDialog()
  const library = opts.library

  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('无法注册本地曲目 IPC：当前进程没有可用的 ipcMain')
  }

  ipcMain.handle('local:list', () => library.list())

  ipcMain.handle('local:pick-files', async () => {
    if (!dialog) return []
    const result = await dialog.showOpenDialog({
      title: '选择本地音乐文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频文件', extensions: [...AUDIO_EXTENSIONS] }],
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('local:pick-folder', async () => {
    if (!dialog) return ''
    const result = await dialog.showOpenDialog({
      title: '选择本地音乐文件夹',
      properties: ['openDirectory'],
    })
    if (result.canceled) return ''
    return result.filePaths[0] ?? ''
  })

  ipcMain.handle('local:add', async (_event, arg) => await library.addPaths(readStringArray(arg)))

  ipcMain.handle('local:add-folder', async (_event, arg) => {
    const folder = typeof arg === 'string' ? arg : ''
    return await library.addFolder(folder)
  })

  ipcMain.handle('local:remove', async (_event, arg) => {
    const id = typeof arg === 'string' ? arg : ''
    return await library.remove(id)
  })
}
