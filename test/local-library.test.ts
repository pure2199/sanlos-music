// ---------------------------------------------------------------------------
// T38 本地曲目登记表（主进程）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **文件名反推**（`parseTrackFileName`）：`歌手 - 歌名.ext` → 歌手 / 歌名；
// - **扩展名白名单**（`isAudioFileName`）：非音频一律不登记；
// - **id 生成**（`localTrackId`）：同路径同 id、与 NAS guid 不冲突；
// - **登记表**（`LocalLibrary`）：登记 / 去重 / 移除 / 落盘与读回；
// - **目录扫描**（`collectAudioFiles`）：递归、跳过符号链接、有上限；
// - **IPC**（`registerLocalLibraryIpc`）：六个通道的形状。
//
// ⚠️ **不碰真实磁盘**：文件系统用内存替身。
// ⚠️ 测试数据一律用占位值（`D:\Music\…`），不写真实路径 / 歌名。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'

import { fileExtension, isAudioFileName, parseTrackFileName } from '../shared/localMeta'
import { isLocalTrackId, LOCAL_TRACK_ID_PREFIX } from '../shared/localMedia'
import {
  collectAudioFiles,
  localTrackId,
  LocalLibrary,
  registerLocalLibraryIpc,
  sanitizeLocalItem,
  type LocalDirEntry,
  type LocalLibraryFs,
  type LocalIpcMainLike,
} from '../electron/localLibrary'

// ---------------------------------------------------------------------------
// 内存文件系统
// ---------------------------------------------------------------------------

/** 内存文件系统的可观察状态。 */
interface MemoryFs {
  fs: LocalLibraryFs
  /** 路径 → 字节数（**普通文件**）。 */
  files: Map<string, number>
  /** 目录 → 子项。 */
  dirs: Map<string, LocalDirEntry[]>
  /** 路径 → 文本内容。 */
  texts: Map<string, string>
  /** 被 `remove()` 删掉的路径（用来断言「不会删用户的音乐」）。 */
  removed: string[]
}

/** 造一个内存文件系统。 */
function createMemoryFs(): MemoryFs {
  const files = new Map<string, number>()
  const dirs = new Map<string, LocalDirEntry[]>()
  const texts = new Map<string, string>()
  const removed: string[] = []
  const fs: LocalLibraryFs = {
    readText: async (path) => {
      const text = texts.get(path)
      if (text === undefined) throw new Error(`没有这个文件: ${path}`)
      return text
    },
    writeText: async (path, text) => {
      texts.set(path, text)
    },
    rename: async (from, to) => {
      const text = texts.get(from)
      if (text === undefined) throw new Error(`没有这个文件: ${from}`)
      texts.delete(from)
      texts.set(to, text)
    },
    remove: async (path) => {
      removed.push(path)
      texts.delete(path)
    },
    listDir: async (path) => {
      const entries = dirs.get(path)
      if (!entries) throw new Error(`没有这个目录: ${path}`)
      return entries
    },
    statFile: async (path) => {
      const size = files.get(path)
      return size === undefined ? null : { size }
    },
  }
  return { fs, files, dirs, texts, removed }
}

/** 目录项快捷方式。 */
function dirEntry(name: string, kind: 'file' | 'dir' | 'link'): LocalDirEntry {
  return {
    name,
    isFile: kind === 'file',
    isDirectory: kind === 'dir',
    isSymbolicLink: kind === 'link',
  }
}

// ---------------------------------------------------------------------------
// 文件名反推
// ---------------------------------------------------------------------------

describe('T38 文件名反推', () => {
  it('`歌手 - 歌名.ext` → 歌手 + 歌名', () => {
    expect(parseTrackFileName('示例歌手 - 示例歌名.flac')).toEqual({
      artist: '示例歌手',
      title: '示例歌名',
    })
  })

  it('没有 ` - ` 时 → 歌手为空，歌名取整段', () => {
    expect(parseTrackFileName('示例歌名.mp3')).toEqual({ artist: '', title: '示例歌名' })
  })

  it('带路径时也能反推（只取文件名部分）', () => {
    expect(parseTrackFileName('D:\\Music\\子目录\\示例歌手 - 示例歌名.mp3')).toEqual({
      artist: '示例歌手',
      title: '示例歌名',
    })
  })

  it('**不是**音频扩展名的点号不当扩展名（歌名不被砍掉一截）', () => {
    expect(parseTrackFileName('Album 03. Intro')).toEqual({ artist: '', title: 'Album 03. Intro' })
  })

  it('分割出来歌手是空 → 歌手留空，歌名照常', () => {
    expect(parseTrackFileName(' - 示例歌名.flac')).toEqual({ artist: '', title: '示例歌名' })
  })

  it('扩展名判定：白名单内为真、白名单外为假、大小写不敏感', () => {
    expect(isAudioFileName('a.mp3')).toBe(true)
    expect(isAudioFileName('a.FLAC')).toBe(true)
    expect(isAudioFileName('a.txt')).toBe(false)
    expect(isAudioFileName('a')).toBe(false)
    expect(fileExtension('D:\\Music\\a.FLAC')).toBe('flac')
  })
})

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------

describe('T38 本地曲目 id', () => {
  it('同一路径 → 同一个 id（重复添加自动去重）', () => {
    expect(localTrackId('D:\\Music\\a.flac')).toBe(localTrackId('D:\\Music\\a.flac'))
  })

  it('不同路径 → 不同 id', () => {
    expect(localTrackId('D:\\Music\\a.flac')).not.toBe(localTrackId('D:\\Music\\b.flac'))
  })

  it('带 `local:` 前缀，且**不是** NAS 的 guid', () => {
    const id = localTrackId('D:\\Music\\a.flac')
    expect(id.startsWith(LOCAL_TRACK_ID_PREFIX)).toBe(true)
    expect(isLocalTrackId(id)).toBe(true)
    // ⚠️ 服务端 guid 是 32 位十六进制、没有前缀 → 不能被误认成本地曲目。
    expect(isLocalTrackId('0123456789abcdef0123456789abcdef')).toBe(false)
    // ⚠️ 光有前缀不算（是空壳）。
    expect(isLocalTrackId(LOCAL_TRACK_ID_PREFIX)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 登记表
// ---------------------------------------------------------------------------

const MUSIC_FILE = resolve('D:\\Music\\示例歌手 - 示例歌名.flac')
const TEXT_FILE = resolve('D:\\Music\\说明.txt')
const INDEX_PATH = resolve('D:\\AppData\\local-library.json')

describe('T38 本地曲目登记表', () => {
  it('登记一个真实存在的音频文件 → 歌名 / 歌手 / 大小 / 扩展名都对', async () => {
    const mem = createMemoryFs()
    mem.files.set(MUSIC_FILE, 4096)
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    const items = await library.addPaths([MUSIC_FILE])

    expect(items).toHaveLength(1)
    expect(items[0]?.path).toBe(MUSIC_FILE)
    expect(items[0]?.title).toBe('示例歌名')
    expect(items[0]?.artist).toBe('示例歌手')
    expect(items[0]?.size).toBe(4096)
    expect(items[0]?.ext).toBe('flac')
    expect(items[0]?.id).toBe(localTrackId(MUSIC_FILE))
  })

  it('**不存在的文件**不登记（也不报错）', async () => {
    const mem = createMemoryFs()
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    expect(await library.addPaths([resolve('D:\\Music\\根本没有.flac')])).toEqual([])
  })

  it('**非音频文件**不登记（扩展名白名单）', async () => {
    const mem = createMemoryFs()
    mem.files.set(TEXT_FILE, 10)
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    expect(await library.addPaths([TEXT_FILE])).toEqual([])
  })

  it('同一个路径登记两次 → 只有一条（幂等）', async () => {
    const mem = createMemoryFs()
    mem.files.set(MUSIC_FILE, 4096)
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    await library.addPaths([MUSIC_FILE])
    const items = await library.addPaths([MUSIC_FILE])

    expect(items).toHaveLength(1)
  })

  it('移除一项 → 清单里没有了，且**没有删用户的音乐文件**', async () => {
    const mem = createMemoryFs()
    mem.files.set(MUSIC_FILE, 4096)
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    const items = await library.addPaths([MUSIC_FILE])
    const id = items[0]?.id ?? ''
    const after = await library.remove(id)

    expect(after).toEqual([])
    // ⚠️ **删用户的音乐文件是不可接受的** —— 移除只改清单。
    expect(mem.removed).not.toContain(MUSIC_FILE)
    // ⚠️ 音乐文件本身还在。
    expect(mem.files.has(MUSIC_FILE)).toBe(true)
  })

  it('落盘后能读回来', async () => {
    const mem = createMemoryFs()
    mem.files.set(MUSIC_FILE, 4096)
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })
    await library.addPaths([MUSIC_FILE])

    const restored = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })
    const items = await restored.load()

    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('示例歌名')
    expect(restored.localPath(localTrackId(MUSIC_FILE))).toBe(MUSIC_FILE)
  })

  it('清单文件损坏 → 当作没有（不抛）', async () => {
    const mem = createMemoryFs()
    mem.texts.set(INDEX_PATH, '{ 这不是 JSON')
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    expect(await library.load()).toEqual([])
  })

  it('没登记过的 id → 查不到路径（渲染进程伪造不出来）', async () => {
    const mem = createMemoryFs()
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    expect(library.localPath(localTrackId(MUSIC_FILE))).toBeNull()
    expect(library.localPath('')).toBeNull()
  })

  it('清单里不合法的一条**整条丢弃**（用户可编辑的 JSON）', () => {
    expect(sanitizeLocalItem(null)).toBeNull()
    expect(sanitizeLocalItem({ path: 'D:\\a.flac' })).toBeNull()
    expect(sanitizeLocalItem({ id: 'local:x' })).toBeNull()
    expect(sanitizeLocalItem({ id: 'local:x', path: 'D:\\a.flac' })?.title).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 目录扫描
// ---------------------------------------------------------------------------

describe('T38 目录扫描', () => {
  it('递归收集音频文件，**跳过**非音频', async () => {
    const mem = createMemoryFs()
    const root = resolve('D:\\Music')
    const sub = resolve('D:\\Music\\子目录')
    mem.dirs.set(root, [dirEntry('子目录', 'dir'), dirEntry('a.flac', 'file'), dirEntry('b.txt', 'file')])
    mem.dirs.set(sub, [dirEntry('c.mp3', 'file')])

    const found = await collectAudioFiles(root, mem.fs)

    // ⚠️ 顺序按**区域排序**（`localeCompare`）→ 断言不写死顺序。
    expect(found).toHaveLength(2)
    expect(found).toContain(resolve('D:\\Music\\a.flac'))
    expect(found).toContain(resolve('D:\\Music\\子目录\\c.mp3'))
  })

  it('**跳过符号链接**（junction 会成环）', async () => {
    const mem = createMemoryFs()
    const root = resolve('D:\\Music')
    mem.dirs.set(root, [dirEntry('a.flac', 'file'), dirEntry('环', 'link')])

    const found = await collectAudioFiles(root, mem.fs)

    expect(found).toEqual([resolve('D:\\Music\\a.flac')])
  })

  it('深度有上限', async () => {
    const mem = createMemoryFs()
    const root = resolve('D:\\Music')
    const deep = resolve('D:\\Music\\a\\b\\c')
    mem.dirs.set(root, [dirEntry('a', 'dir')])
    mem.dirs.set(resolve('D:\\Music\\a'), [dirEntry('b', 'dir')])
    mem.dirs.set(resolve('D:\\Music\\a\\b'), [dirEntry('c', 'dir')])
    mem.dirs.set(deep, [dirEntry('deep.flac', 'file')])

    const found = await collectAudioFiles(root, mem.fs, { maxDepth: 1 })

    expect(found).toEqual([])
  })

  it('数量有上限', async () => {
    const mem = createMemoryFs()
    const root = resolve('D:\\Music')
    mem.dirs.set(root, [dirEntry('a.flac', 'file'), dirEntry('b.flac', 'file'), dirEntry('c.flac', 'file')])

    const found = await collectAudioFiles(root, mem.fs, { maxFiles: 2 })

    expect(found).toHaveLength(2)
  })

  it('读不到的目录 → 跳过，不抛', async () => {
    const mem = createMemoryFs()
    expect(await collectAudioFiles(resolve('D:\\根本没有'), mem.fs)).toEqual([])
  })

  it('addFolder → 扫目录并登记', async () => {
    const mem = createMemoryFs()
    const root = resolve('D:\\Music')
    mem.dirs.set(root, [dirEntry('a.flac', 'file')])
    mem.files.set(resolve('D:\\Music\\a.flac'), 100)
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })

    const items = await library.addFolder(root)

    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

describe('T38 本地曲目 IPC', () => {
  /** 假 ipcMain（收集六个通道的处理器）。 */
  function fakeIpcMain(): {
    ipcMain: LocalIpcMainLike
    handlers: Map<string, (event: unknown, arg: unknown) => unknown>
  } {
    const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>()
    return {
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener)
        },
      },
      handlers,
    }
  }

  it('六个通道都注册了', async () => {
    const mem = createMemoryFs()
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })
    const { ipcMain, handlers } = fakeIpcMain()
    registerLocalLibraryIpc({ library, ipcMain })

    expect([...handlers.keys()].sort()).toEqual([
      'local:add',
      'local:add-folder',
      'local:list',
      'local:pick-files',
      'local:pick-folder',
      'local:remove',
    ])
  })

  it('`local:pick-files` → 返回对话框选中的路径；取消 → 空数组', async () => {
    const mem = createMemoryFs()
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })
    const { ipcMain, handlers } = fakeIpcMain()
    let canceled = false
    registerLocalLibraryIpc({
      library,
      ipcMain,
      dialog: {
        showOpenDialog: async () => ({
          canceled,
          filePaths: canceled ? [] : [MUSIC_FILE],
        }),
      },
    })

    const pick = handlers.get('local:pick-files')
    expect(await pick?.(null, null)).toEqual([MUSIC_FILE])
    canceled = true
    expect(await pick?.(null, null)).toEqual([])
  })

  it('`local:pick-folder` → 返回选中的目录；取消 → 空串', async () => {
    const mem = createMemoryFs()
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })
    const { ipcMain, handlers } = fakeIpcMain()
    let canceled = false
    registerLocalLibraryIpc({
      library,
      ipcMain,
      dialog: {
        showOpenDialog: async () => ({
          canceled,
          filePaths: canceled ? [] : [resolve('D:\\Music')],
        }),
      },
    })

    const pick = handlers.get('local:pick-folder')
    expect(await pick?.(null, null)).toBe(resolve('D:\\Music'))
    canceled = true
    expect(await pick?.(null, null)).toBe('')
  })

  it('`local:add` / `local:list` / `local:remove` 串得起来', async () => {
    const mem = createMemoryFs()
    mem.files.set(MUSIC_FILE, 4096)
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })
    const { ipcMain, handlers } = fakeIpcMain()
    registerLocalLibraryIpc({ library, ipcMain })

    const added = (await handlers.get('local:add')?.(null, [MUSIC_FILE])) as { id: string }[]
    expect(added).toHaveLength(1)

    const listed = (await handlers.get('local:list')?.(null, null)) as { id: string }[]
    expect(listed).toHaveLength(1)

    const removed = (await handlers.get('local:remove')?.(null, added[0]?.id)) as unknown[]
    expect(removed).toEqual([])
  })

  it('`local:add` 只接受字符串数组（形状不对 → 当空处理）', async () => {
    const mem = createMemoryFs()
    const library = new LocalLibrary({ filePath: INDEX_PATH, fs: mem.fs })
    const { ipcMain, handlers } = fakeIpcMain()
    registerLocalLibraryIpc({ library, ipcMain })

    expect(await handlers.get('local:add')?.(null, '不是数组')).toEqual([])
    expect(await handlers.get('local:add')?.(null, null)).toEqual([])
  })
})
