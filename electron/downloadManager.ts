// ---------------------------------------------------------------------------
// 本地下载管理器（**主进程**，Task 11）
// ---------------------------------------------------------------------------
//
// 职责
// ---------------------------------------------------------------------------
// 1. **把一首歌从 NAS 拉到本地磁盘**（原始文件，不转码——服务端转码实测不可用）；
// 2. **维护本地索引**（`downloads.json`）：`songId → 本地文件`；
// 3. **断点续传**：中断后重试从已有字节继续（`.part` 文件 + `Range` 请求）；
// 4. **进度上报**：把任务状态变化推给渲染进程。
//
// ---------------------------------------------------------------------------
// 为什么下载放在**主进程**
// ---------------------------------------------------------------------------
// - 渲染进程**不能写盘**（sandbox），几十 MB 的音频也不该在渲染进程里过一遍内存；
// - 主进程**本来就持有凭证**（`SessionManager`）与**出网通道**（`HttpStack`）——
//   下载复用它们，**渲染进程自始至终碰不到 token / Cookie**；
// - 落盘路径、文件名清洗**全在主进程**：渲染进程只能发「我要下这首歌」，
//   **不能指定写到哪**（否则它就等于一个任意写文件的口子）。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测。
//   故 Electron 相关对象（`app.getPath`）一律由调用方注入。
// - 文件系统操作**全部可注入**（`statSize` / `openSink` / `renameFile` / `removeFile`），
//   单测用内存替身，**不碰真实磁盘**。
// - 不引入新依赖；只用 Node 内置模块与标准 Web API。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - **文件名清洗**：Windows 非法字符（`< > : " / \ | ? *`）、控制字符、
//   结尾的点和空格、设备保留名（`CON` / `NUL` / `COM1`…）全部处理；
// - **路径穿越**：`..` / `.` 清洗后会变成空串 → 走兜底名，**绝不**能拼出目录外的路径；
// - **半成品不进索引**：先写 `<正式名>.part`，**全部写完并原子改名**后才登记索引；
// - 错误文案**不含** token / Cookie / authx。

import { dirname, join } from 'node:path'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'

import type { DownloadEntry, DownloadRequest, DownloadTask } from '../shared/playerBridge'
import { readFileTags, type AudioTags, type TagFileSystem } from './audioTags'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 下载索引文件名（落在 `app.getPath('userData')` 下）。 */
export const DOWNLOAD_INDEX_FILE_NAME = 'downloads.json'

/**
 * 下载目录的默认子目录名（挂在「我的音乐」下面）。
 *
 * ⚠️ **只影响「新下载」落盘**：已下载的条目在索引（`downloads.json`）里存的是
 *    **绝对路径** → 改了默认名，**老歌照样能播、照样在列表里**。
 */
export const DEFAULT_DOWNLOAD_SUBDIR = 'Sanlos music'

/** 索引结构版本号（便于将来迁移格式）。 */
export const DOWNLOAD_INDEX_VERSION = 1

/** 进度推送的最小间隔（毫秒）——太快会把 IPC 打满。 */
const PROGRESS_NOTIFY_INTERVAL_MS = 250

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 本地下载索引。 */
export interface DownloadIndex {
  /** 结构版本号。 */
  version: number
  /** `songId → 已下载条目`。 */
  entries: Record<string, DownloadEntry>
}

/** 写入句柄（流式写盘）。 */
export interface DownloadSink {
  /** 追加一段字节。 */
  write(chunk: Uint8Array): Promise<void>
  /** 关闭（必须调用，否则数据可能没落盘）。 */
  close(): Promise<void>
}

/** `DownloadManager` 的依赖（全部可注入，便于单测）。 */
export interface DownloadManagerDeps {
  /**
   * 取流（**已带** `authx` 与凭证 Cookie —— 由主进程拼，渲染进程不参与）。
   *
   * @param songId    歌曲 guid。
   * @param rangeStart 断点续传的起始字节（`0` = 从头下）。
   */
  fetchStream: (songId: string, rangeStart: number) => Promise<Response>
  /** 下载根目录（绝对路径）。 */
  getDownloadDir: () => string
  /** 读索引；缺省 = 空索引。 */
  readIndex?: () => DownloadIndex
  /** 写索引。 */
  writeIndex?: (index: DownloadIndex) => void
  /** 取文件大小（断点续传用）；文件不存在返回 `null`。 */
  statSize?: (path: string) => Promise<number | null>
  /** 打开写入句柄（`append = true` 表示追加）。 */
  openSink?: (path: string, append: boolean) => Promise<DownloadSink>
  /** 重命名（`.part` → 正式名）。 */
  renameFile?: (from: string, to: string) => Promise<void>
  /** 删除文件（不存在也不报错）。 */
  removeFile?: (path: string) => Promise<void>
  /**
   * 读一段字节（T39：读音频标签用）。
   *
   * ⚠️ **可选**：没有它 = **解析能力自动降级**（时长保持未知）。
   */
  readBytes?: (path: string, offset: number, length: number) => Promise<Buffer>
  /** 任务状态变化回调（主进程据此推给渲染进程）。 */
  onChange?: (tasks: DownloadTask[]) => void
}

// ---------------------------------------------------------------------------
// 纯函数：文件名清洗
// ---------------------------------------------------------------------------

/** Windows 保留设备名（不能当文件名用）。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 文件名里允许的最大长度（不含扩展名）。 */
const MAX_BASE_LENGTH = 150

/**
 * 清洗**一段**文件名成分（歌手名 / 歌名）。
 *
 * - Windows 非法字符 `< > : " / \ | ? *` → `_`；
 * - 控制字符（含 `DEL`）→ 删除；
 * - 首尾空白 → 去掉；**结尾的点和空格** → 去掉（Windows 不允许）；
 * - 设备保留名（`CON` / `NUL` / `COM1`…）→ 前缀 `_`；
 * - `.` 与 `..` 会被「去结尾的点」规则清成**空串** → 调用方走兜底名，
 *   于是**路径穿越（`..`）根本拼不出目录外的路径**。
 *
 * @returns 清洗后的成分；**空串**表示这段没有可用名字。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = (name ?? '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
  if (cleaned.length === 0) return ''
  const base = RESERVED_NAMES.test(cleaned) ? `_${cleaned}` : cleaned
  return base.slice(0, MAX_BASE_LENGTH).replace(/[. ]+$/g, '')
}

/**
 * 归一化扩展名：只留 `[a-z0-9]{1,8}`，其余一律 `bin`。
 *
 * ⚠️ **不猜**：拿不到合法的扩展名时用 `bin`（而不是瞎报 `mp3`）——
 *    错的扩展名会让播放器按错误的容器解析。
 */
export function normalizeExtension(ext: string): string {
  const token = (ext ?? '').trim().toLowerCase().replace(/^\.+/, '')
  return /^[a-z0-9]{1,8}$/.test(token) ? token : 'bin'
}

/**
 * 由歌名 / 歌手名拼出最终文件名（**含扩展名**）。
 *
 * - 形如 `<歌手> - <歌名>.<ext>`；缺歌手时只有 `<歌名>.<ext>`；
 * - 兜底顺序：歌手+歌名 → 歌曲 guid → `track`；
 * - 长度上限 `MAX_BASE_LENGTH`（避开 Windows 260 字符路径上限）。
 */
export function downloadFileName(request: DownloadRequest): string {
  const artist = sanitizeFileName(request.artist)
  const title = sanitizeFileName(request.title)
  const parts = [artist, title].filter((part) => part.length > 0)
  let base = parts.length > 0 ? parts.join(' - ') : sanitizeFileName(request.songId)
  if (base.length === 0) base = 'track'
  base = base.slice(0, MAX_BASE_LENGTH).replace(/[. ]+$/g, '')
  if (base.length === 0) base = 'track'
  return `${base}.${normalizeExtension(request.ext)}`
}

/**
 * 解析 `Content-Range` 的起始字节（`bytes 100-200/300` → `100`）。
 *
 * @returns 起始字节；头缺失或格式不对时返回 `null`（= **不知道**，不能瞎猜）。
 */
export function parseContentRangeStart(header: string | null): number | null {
  if (!header) return null
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim())
  if (!match) return null
  const start = Number(match[1])
  return Number.isFinite(start) ? start : null
}

// ---------------------------------------------------------------------------
// 默认文件系统实现（单测会换成内存替身）
// ---------------------------------------------------------------------------

/** 默认：取文件大小（不存在返回 `null`）。 */
async function defaultStatSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** 默认：打开写入句柄（自动建目录）。 */
async function defaultOpenSink(path: string, append: boolean): Promise<DownloadSink> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, append ? 'a' : 'w')
  return {
    async write(chunk: Uint8Array): Promise<void> {
      await handle.write(chunk)
    },
    async close(): Promise<void> {
      await handle.close()
    },
  }
}

/** 默认：重命名（原子替换）。 */
async function defaultRenameFile(from: string, to: string): Promise<void> {
  await rename(from, to)
}

/** 默认：删除文件（不存在也不报错）。 */
async function defaultRemoveFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

// ---------------------------------------------------------------------------
// 取消信号
// ---------------------------------------------------------------------------

/** 「用户取消了」内部信号（**不是**给渲染进程的错误文案）。 */
class CanceledError extends Error {
  constructor() {
    super('canceled')
    this.name = 'CanceledError'
  }
}

// ---------------------------------------------------------------------------
// 下载管理器
// ---------------------------------------------------------------------------

/**
 * 本地下载管理器。
 *
 * - **串行**：一次只下一个（中继带宽有限，并发只会互相抢带宽）；
 * - **断点续传**：`.part` 文件 + `Range` 请求；
 * - **索引只在成功后写**：半成品永远不进索引。
 */
export class DownloadManager {
  private readonly deps: DownloadManagerDeps
  /** 已完成的条目（单一真相源 = 索引）。 */
  private entries: Record<string, DownloadEntry> = {}
  /** 任务表（`songId → 任务`）。 */
  private readonly tasks = new Map<string, DownloadTask>()
  /** 请求表（`songId → 原始请求`，任务里只留展示字段）。 */
  private readonly requests = new Map<string, DownloadRequest>()
  /** 排队中的歌曲 id。 */
  private queue: string[] = []
  /** 正在跑的任务（避免重入）。 */
  private pumping = false
  /** 被取消的歌曲 id。 */
  private readonly canceled = new Set<string>()
  /** `.part` 文件路径（清理时要用）。 */
  private readonly partPaths = new Map<string, string>()
  /** 上次推送进度的时刻（节流用）。 */
  private lastNotifyAt = 0
  /** 标签回填的 Promise（T39；**只跑一次**）。 */
  private tagsReady: Promise<void> | null = null

  constructor(deps: DownloadManagerDeps) {
    this.deps = deps
    this.entries = this.readIndexSafely()
  }

  // --- 读 -----------------------------------------------------------------

  /** 读索引（失败 = 当作没有，不抛）。 */
  private readIndexSafely(): Record<string, DownloadEntry> {
    try {
      const index = this.deps.readIndex?.()
      const entries = index?.entries
      if (!entries || typeof entries !== 'object') return {}
      // ⚠️ 逐条校验：`downloads.json` 是用户可编辑的文件。
      const clean: Record<string, DownloadEntry> = {}
      for (const [songId, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') continue
        const file = (entry as DownloadEntry).file
        if (typeof file !== 'string' || file.length === 0) continue
        if (typeof songId !== 'string' || songId.length === 0) continue
        clean[songId] = {
          songId,
          file,
          bytes: Number.isFinite(entry.bytes) ? entry.bytes : 0,
          ext: typeof entry.ext === 'string' ? entry.ext : 'bin',
          downloadedAt: typeof entry.downloadedAt === 'string' ? entry.downloadedAt : '',
          // ⚠️ T38：标题 / 歌手快照是**可选**的——只有本次升级后下载的条目才有。
          //    老条目没有 → 渲染层用**文件名反推**兜底（近似值）。
          title: typeof entry.title === 'string' ? entry.title : undefined,
          artist: typeof entry.artist === 'string' ? entry.artist : undefined,
          // ⚠️ T39：时长 / 专辑来自文件内嵌标签——同样**可选**。
          duration:
            typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0
              ? entry.duration
              : undefined,
          album: typeof entry.album === 'string' ? entry.album : undefined,
        }
      }
      return clean
    } catch {
      return {}
    }
  }

  /** 索引 + 任务列表（给渲染进程）。 */
  list(): { entries: Record<string, DownloadEntry>; tasks: DownloadTask[] } {
    return {
      entries: { ...this.entries },
      tasks: [...this.tasks.values()].map((task) => ({ ...task })),
    }
  }

  /** 这首歌下完了吗（**只看索引**：文件被用户手动删了也仍然算已下载）。 */
  isDownloaded(songId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.entries, songId)
  }

  /** 这首歌的本地绝对路径（没下过 = `null`）。 */
  localPath(songId: string): string | null {
    const entry = this.entries[songId]
    return entry ? entry.file : null
  }

  /** 当前下载目录（绝对路径）。 */
  getDir(): string {
    return this.deps.getDownloadDir()
  }

  // --- 标签（T39）---------------------------------------------------------

  /**
   * 读一个文件的音频标签（T39）。
   *
   * ⚠️ **读不到 / 解析失败 → `null`**（不抛）：下载结果**不受影响**。
   */
  private async readTags(file: string): Promise<AudioTags | null> {
    const readBytes = this.deps.readBytes
    if (!readBytes) return null
    const statSize = this.deps.statSize ?? defaultStatSize
    const fs: TagFileSystem = {
      readBytes: (path, offset, length) => readBytes(path, offset, length),
      statSize: (path) => statSize(path),
    }
    try {
      return await readFileTags(fs, file)
    } catch {
      return null
    }
  }

  /**
   * 回填**老条目**的时长 / 专辑（T39）。
   *
   * ⚠️ 老条目（升级前下的）索引里没有时长 → 这里逐个读文件头补上。
   * ⚠️ **读不出来就跳过**（下次启动再试）——文件可能暂时不在（移动硬盘没插）。
   *
   * @returns 补上了多少条。
   */
  async backfillTags(): Promise<number> {
    let changed = 0
    for (const entry of Object.values(this.entries)) {
      if (entry.duration !== undefined) continue
      const tags = await this.readTags(entry.file)
      if (!tags || tags.duration === undefined) continue
      entry.duration = tags.duration
      if (tags.album) entry.album = tags.album
      changed += 1
    }
    if (changed > 0) this.writeIndex()
    return changed
  }

  /**
   * 确保标签回填**跑过一次**（**幂等**）。
   *
   * ⚠️ 渲染进程第一次读下载列表时**等它**→ 第一次就能看到时长。
   */
  ensureTags(): Promise<void> {
    if (!this.tagsReady) {
      this.tagsReady = this.backfillTags()
        .then(() => undefined)
        .catch(() => undefined)
    }
    return this.tagsReady
  }

  // --- 写 -----------------------------------------------------------------

  /**
   * 开始下载一首歌。
   *
   * - 已在队列 / 下载中 → **直接返回现有任务**（不重复下）；
   * - 已下载 → 直接标成 `done`（不重复下）；
   * - 否则入队。
   */
  start(request: DownloadRequest): DownloadTask {
    const songId = request.songId
    const existing = this.tasks.get(songId)
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      return { ...existing }
    }

    const entry = this.entries[songId]
    if (entry) {
      const task: DownloadTask = {
        songId,
        title: request.title,
        artist: request.artist,
        status: 'done',
        received: entry.bytes,
        total: entry.bytes,
        error: null,
        file: entry.file,
      }
      this.tasks.set(songId, task)
      this.notify()
      return { ...task }
    }

    const task: DownloadTask = {
      songId,
      title: request.title,
      artist: request.artist,
      status: 'pending',
      received: 0,
      total: 0,
      error: null,
      file: null,
    }
    this.tasks.set(songId, task)
    this.requests.set(songId, request)
    this.queue.push(songId)
    this.notify()
    void this.pump()
    return { ...task }
  }

  /**
   * 取消下载。
   *
   * - `pending` → 直接出队并标成 `canceled`；
   * - `running` → 置取消标记，**下一次读块**时停下（`.part` 保留，可续传）。
   */
  cancel(songId: string): void {
    const task = this.tasks.get(songId)
    if (!task) return
    if (task.status === 'pending') {
      this.queue = this.queue.filter((id) => id !== songId)
      this.canceled.delete(songId)
      task.status = 'canceled'
      task.error = null
      this.notify()
      return
    }
    if (task.status === 'running') {
      this.canceled.add(songId)
    }
  }

  /**
   * 清空本地下载：**删文件 + 清索引**。
   *
   * ⚠️ 进行中的任务会被取消（它们的 `.part` 也一并删掉）。
   */
  async clear(): Promise<void> {
    for (const songId of [...this.tasks.keys()]) this.cancel(songId)
    this.queue = []
    for (const songId of [...this.tasks.keys()]) {
      const task = this.tasks.get(songId)
      if (task && (task.status === 'pending' || task.status === 'running')) {
        task.status = 'canceled'
      }
    }

    const remove = this.deps.removeFile ?? defaultRemoveFile
    for (const entry of Object.values(this.entries)) {
      try {
        await remove(entry.file)
      } catch {
        // 删不掉不阻断清理（索引照样清）。
      }
    }
    for (const partPath of this.partPaths.values()) {
      try {
        await remove(partPath)
      } catch {
        // 同上。
      }
    }
    this.partPaths.clear()
    this.entries = {}
    this.writeIndex()
    this.notify()
  }

  // --- 内部 ---------------------------------------------------------------

  /** 写索引（失败不抛——索引丢了只是要重新下）。 */
  private writeIndex(): void {
    try {
      this.deps.writeIndex?.({ version: DOWNLOAD_INDEX_VERSION, entries: { ...this.entries } })
    } catch {
      // 忽略：写索引失败不该让下载流程崩掉。
    }
  }

  /** 通知渲染进程（任务列表变化）。 */
  private notify(): void {
    this.lastNotifyAt = Date.now()
    try {
      this.deps.onChange?.(this.list().tasks)
    } catch {
      // 忽略：回调异常不该影响下载。
    }
  }

  /** 通知进度（**节流**：太快会把 IPC 打满）。 */
  private notifyProgress(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastNotifyAt < PROGRESS_NOTIFY_INTERVAL_MS) return
    this.notify()
  }

  /** 串行泵：一次只跑一个。 */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const songId = this.queue.shift()
        if (!songId) continue
        const task = this.tasks.get(songId)
        if (!task) continue
        if (this.canceled.has(songId)) {
          this.canceled.delete(songId)
          task.status = 'canceled'
          this.notify()
          continue
        }
        await this.run(task)
      }
    } finally {
      this.pumping = false
    }
  }

  /** 真正下载一首。 */
  private async run(task: DownloadTask): Promise<void> {
    const deps = this.deps
    const request = this.requests.get(task.songId)
    if (!request) {
      this.fail(task, '下载失败：缺少下载请求')
      return
    }

    const dir = deps.getDownloadDir()
    const fileName = downloadFileName(request)
    const finalPath = join(dir, fileName)
    const partPath = `${finalPath}.part`
    this.partPaths.set(task.songId, partPath)

    // 断点续传：已有多少字节。
    let resumeFrom = 0
    try {
      resumeFrom = (await (deps.statSize ?? defaultStatSize)(partPath)) ?? 0
    } catch {
      resumeFrom = 0
    }
    if (!Number.isFinite(resumeFrom) || resumeFrom < 0) resumeFrom = 0

    let response: Response
    try {
      response = await deps.fetchStream(task.songId, resumeFrom)
    } catch {
      this.fail(task, '下载失败：无法连接音乐服务（网络不可达或服务未响应）')
      return
    }

    if (response.status !== 200 && response.status !== 206) {
      this.fail(task, `下载失败：服务器返回 ${response.status}`)
      return
    }

    // ⚠️ **断点续传的正确性护栏**：
    //    服务端可能**忽略** `Range`（回 `200` + 完整内容）→ 追加会把文件写坏；
    //    也可能回一个起点对不上的 `Content-Range`。
    //    这两种情况都必须**从头重下**（append = false）。
    let append = resumeFrom > 0
    if (append) {
      if (response.status === 200) {
        append = false
      } else {
        const rangeStart = parseContentRangeStart(response.headers.get('content-range'))
        if (rangeStart !== resumeFrom) append = false
      }
    }
    const startOffset = append ? resumeFrom : 0

    const contentLength = Number(response.headers.get('content-length') ?? '0')
    task.status = 'running'
    task.received = startOffset
    task.total = startOffset + (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0)
    task.error = null
    this.notify()

    const sink = await (deps.openSink ?? defaultOpenSink)(partPath, append)
    try {
      const body = response.body
      if (!body) throw new Error('响应没有内容')
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (this.canceled.has(task.songId)) {
          await reader.cancel().catch(() => undefined)
          throw new CanceledError()
        }
        await sink.write(value)
        task.received += value.byteLength
        this.notifyProgress()
      }
    } catch (err) {
      await sink.close().catch(() => undefined)
      if (err instanceof CanceledError) {
        this.canceled.delete(task.songId)
        task.status = 'canceled'
        task.error = null
        this.notify()
        return
      }
      this.fail(task, '下载失败：写入文件时出错')
      return
    }
    await sink.close().catch(() => undefined)

    // ⚠️ 取消发生在最后一段之后 → 不改名、不登记（`.part` 留着可续传）。
    if (this.canceled.has(task.songId)) {
      this.canceled.delete(task.songId)
      task.status = 'canceled'
      task.error = null
      this.notify()
      return
    }

    try {
      await (deps.renameFile ?? defaultRenameFile)(partPath, finalPath)
    } catch {
      this.fail(task, '下载失败：无法保存文件（请检查下载目录是否可写）')
      return
    }

    this.partPaths.delete(task.songId)
    // ⚠️ T39：读一下文件头的**内嵌标签** → 时长 / 专辑。
    //    读不出来就缺省（**不影响下载结果**）。
    const tags = await this.readTags(finalPath)
    this.entries[task.songId] = {
      songId: task.songId,
      file: finalPath,
      bytes: task.received,
      ext: normalizeExtension(request.ext),
      downloadedAt: new Date().toISOString(),
      // ⚠️ T38：**元数据快照**——存下来，未登录时也能显示曲名 / 歌手
      //    （服务端曲库这时拿不到）。老条目没有这两个字段 → 渲染层反推文件名兜底。
      title: request.title,
      artist: request.artist,
      // ⚠️ T39：时长 / 专辑来自标签（**可选**）。
      duration: tags?.duration,
      album: tags?.album,
    }
    this.writeIndex()
    task.status = 'done'
    task.file = finalPath
    task.error = null
    this.notify()
  }

  /** 标记失败（`error` 是可读文案，**不含凭证**）。 */
  private fail(task: DownloadTask, message: string): void {
    task.status = 'error'
    task.error = message
    this.notify()
  }
}
