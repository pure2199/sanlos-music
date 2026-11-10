// ---------------------------------------------------------------------------
// T83 音频内嵌歌词：主进程取词 + 渲染层优先级（回归测试）
// ---------------------------------------------------------------------------
//
// 钉的是两件事：
//
// 1. **主进程取词**（`electron/embeddedLyric.ts`）：
//    - ① 本地文件（`local:` 登记表 / 下载索引）⇒ 读磁盘；
//    - ② 本地没有 ⇒ 走 NAS 流（**只读文件头**）；
//    - ③ **本地曲目（`local:` 前缀）没有 NAS guid ⇒ 走不了流**；
//    - ④ 读不到 / 没有 ⇒ **空串**（**永不抛**）。
//
// 2. **渲染层优先级**（方案 A，用户 2026-11-10 拍板）：
//    - `online-first`：线上 → **内嵌** → NAS；
//    - `local-first`：**内嵌** → NAS → 线上；
//    - 线上成功 ⇒ **压根不查内嵌**（省一次 IPC）；
//    - 内嵌读失败 ⇒ 当「没有」，**不炸**整个取词流程。
//
// ⚠️ 测试数据全是占位数据，不写真实内网地址 / 真实歌名。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readAtMostBytes, readEmbeddedLyric } from '../electron/embeddedLyric'
import {
  PrefsStore,
  registerLyricIpc,
  type IpcMainEventsLike,
} from '../electron/ipc'
import type { LyricProvider } from '../electron/lyricProvider'
import { EMBEDDED_LYRIC_LRC, EMBEDDED_LYRIC_SONG_GUID } from '../mock-server/fixtures'
import { toEmbeddedLyricText } from '../shared/embeddedLyric'
import { fetchMockStream, loginMock, startMock } from './helpers/audio-fixtures'
import type { LyricEntry } from '../src/api/types'
import {
  defaultEmbeddedLyricFetcher,
  loadLyricEntries,
  toEmbeddedEntries,
  type EmbeddedLyricFetcher,
  type ExternalLyricFetcher,
  type NasLyricApi,
} from '../src/player/lyricSource'

/** IPC 处理器的形状。 */
type Handler = (event: unknown, arg: unknown) => unknown

/** 临时目录（测完清掉）。 */
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造的 NAS 歌词条目。 */
function nasEntry(content: string, guid = 'nas-1'): LyricEntry {
  return {
    guid,
    source: 'local',
    content,
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset: 0,
  }
}

/** 造的查询条件。 */
const TARGET = { title: '占位歌名', artist: '占位歌手', album: '占位专辑', duration: 200 }

/** 造的 NAS 接口。 */
function makeApi(entries: LyricEntry[] | Error): NasLyricApi {
  return {
    list: async () => {
      if (entries instanceof Error) throw entries
      return entries
    },
  }
}

/**
 * 造一个带 `USLT` 帧的最小 ID3v2.3 文件（**只有歌词，没有别的**）。
 */
function id3WithUslt(lrc: string): Buffer {
  const text = Buffer.from(lrc, 'utf8')
  const payload = Buffer.concat([
    Buffer.from([3]), // 编码 = UTF-8
    Buffer.from('chi', 'latin1'),
    Buffer.from([0x00]), // 内容描述符（空）
    text,
    Buffer.from([0x00]),
  ])
  const frame = Buffer.concat([
    Buffer.from('USLT', 'latin1'),
    (() => {
      const size = Buffer.alloc(4)
      size.writeUInt32BE(payload.length, 0)
      return size
    })(),
    Buffer.from([0, 0]),
    payload,
  ])
  const body = frame
  const synchsafe = Buffer.alloc(4)
  const value = body.length
  synchsafe[0] = (value >>> 21) & 0x7f
  synchsafe[1] = (value >>> 14) & 0x7f
  synchsafe[2] = (value >>> 7) & 0x7f
  synchsafe[3] = value & 0x7f
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0]),
    synchsafe,
    body,
  ])
}

// ---------------------------------------------------------------------------
// 主进程：readEmbeddedLyric
// ---------------------------------------------------------------------------

describe('T83 主进程：readEmbeddedLyric', () => {
  it('本地有文件 ⇒ 读磁盘里的内嵌歌词', async () => {
    const data = id3WithUslt('[00:01.00]内嵌歌词')
    const result = await readEmbeddedLyric('local:abc123', {
      resolveTrackPath: () => 'D:\\占位\\示例.mp3',
      statSize: async () => data.length,
      readFileBytes: async (_path, offset, length) =>
        data.subarray(Math.max(0, offset), Math.min(offset + length, data.length)),
      fetchStreamHead: async () => {
        throw new Error('本地有文件时不该走流')
      },
    })
    expect(result.content).toBe('[00:01.00]内嵌歌词')
    expect(result.layer).toBe('file')
  })

  it('本地没有文件 ⇒ 走 NAS 流（只读文件头）', async () => {
    const data = id3WithUslt('[00:02.00]流里的歌词')
    const fetchStreamHead = vi.fn(async () => data)
    const result = await readEmbeddedLyric('0123456789abcdef0123456789abcdef', {
      resolveTrackPath: () => null,
      fetchStreamHead,
    })
    expect(result.content).toBe('[00:02.00]流里的歌词')
    expect(result.layer).toBe('stream')
    expect(fetchStreamHead).toHaveBeenCalledTimes(1)
  })

  it('本地曲目（local: 前缀）没有 NAS guid ⇒ **不走流**', async () => {
    const fetchStreamHead = vi.fn(async () => id3WithUslt('[00:03.00]不该出现的歌词'))
    const result = await readEmbeddedLyric('local:abc123', {
      resolveTrackPath: () => null,
      fetchStreamHead,
    })
    expect(result.content).toBe('')
    expect(result.layer).toBe('none')
    expect(fetchStreamHead).not.toHaveBeenCalled()
  })

  it('什么都没有 ⇒ 空串（不抛）', async () => {
    const result = await readEmbeddedLyric('local:abc123', {
      resolveTrackPath: () => null,
      fetchStreamHead: async () => null,
    })
    expect(result.content).toBe('')
    expect(result.layer).toBe('none')
  })

  it('读文件抛异常 ⇒ 空串（不抛）', async () => {
    const result = await readEmbeddedLyric('local:abc123', {
      resolveTrackPath: () => 'D:\\占位\\示例.mp3',
      statSize: async () => {
        throw new Error('磁盘炸了')
      },
      readFileBytes: async () => Buffer.alloc(0),
    })
    expect(result.content).toBe('')
  })

  it('id 为空 ⇒ 空串（不查任何东西）', async () => {
    const resolveTrackPath = vi.fn(() => null)
    const result = await readEmbeddedLyric('   ', { resolveTrackPath })
    expect(result.content).toBe('')
    expect(resolveTrackPath).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 渲染层：toEmbeddedEntries
// ---------------------------------------------------------------------------

describe('T83 渲染层：toEmbeddedEntries', () => {
  it('包成一条条目（guid 前缀不与 NAS 撞）', () => {
    const entries = toEmbeddedEntries('song-1', '[00:01.00]内嵌歌词')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.guid).toBe('embedded:song-1')
    expect(entries[0]?.source).toBe('embedded')
    expect(entries[0]?.content).toBe('[00:01.00]内嵌歌词')
    expect(entries[0]?.isLRC).toBe(true)
  })

  it('空文本 ⇒ 没有条目', () => {
    expect(toEmbeddedEntries('song-1', '   ')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 渲染层：优先级矩阵
// ---------------------------------------------------------------------------

describe('T83 优先级：线上优先（缺省）', () => {
  it('线上有歌词 ⇒ 用线上的，**压根不查内嵌**', async () => {
    const embedded = vi.fn<EmbeddedLyricFetcher>(async () => '[00:09.00]内嵌歌词')
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external: async () => ({
        status: 'ok',
        source: 'netease',
        original: '[00:01.00]线上原文',
        translation: '',
      }),
      embedded,
    })
    expect(result.origin).toBe('external')
    expect(result.entries[0]?.content).toBe('[00:01.00]线上原文')
    expect(embedded).not.toHaveBeenCalled()
  })

  it('线上没有 + 内嵌有 ⇒ 用内嵌（origin = embedded）', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external: async () => ({ status: 'not-found' }),
      embedded: async () => '[00:02.00]内嵌歌词',
    })
    expect(result.origin).toBe('embedded')
    expect(result.entries[0]?.content).toBe('[00:02.00]内嵌歌词')
  })

  it('线上没有 + 内嵌没有 + NAS 有 ⇒ 用 NAS（既有行为不变）', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external: async () => ({ status: 'not-found' }),
      embedded: async () => '',
    })
    expect(result.origin).toBe('nas')
    expect(result.entries[0]?.content).toBe('[00:08.00]NAS歌词')
  })

  it('内嵌读失败 ⇒ 当「没有」，不炸', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external: async () => ({ status: 'not-found' }),
      embedded: async () => {
        throw new Error('IPC 断了')
      },
    })
    expect(result.origin).toBe('nas')
  })
})

describe('T83 优先级：本地优先', () => {
  it('内嵌有 ⇒ 用内嵌，**完全不碰外部**', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]线上原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external,
      embedded: async () => '[00:02.00]内嵌歌词',
      priority: 'local-first',
    })
    expect(result.origin).toBe('embedded')
    expect(result.entries[0]?.content).toBe('[00:02.00]内嵌歌词')
    expect(external).not.toHaveBeenCalled()
  })

  it('内嵌没有 + NAS 有 ⇒ 用 NAS，**完全不碰外部**', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]线上原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external,
      embedded: async () => '',
      priority: 'local-first',
    })
    expect(result.origin).toBe('nas')
    expect(external).not.toHaveBeenCalled()
  })

  it('内嵌没有 + NAS 没有 ⇒ 才查外部', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([]),
      external: async () => ({
        status: 'ok',
        source: 'lrclib',
        original: '[00:01.00]线上原文',
        translation: '',
      }),
      embedded: async () => '',
      priority: 'local-first',
    })
    expect(result.origin).toBe('external')
  })
})

describe('T83 优先级：不用外部源（off）', () => {
  it('没有外部取法 ⇒ 内嵌照用（它不需要外网）', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([]),
      embedded: async () => '[00:02.00]内嵌歌词',
    })
    expect(result.origin).toBe('embedded')
    expect(result.entries[0]?.content).toBe('[00:02.00]内嵌歌词')
  })

  it('没有外部取法 + 没有内嵌 ⇒ 回落 NAS', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      embedded: async () => '',
    })
    expect(result.origin).toBe('nas')
  })
})

// ---------------------------------------------------------------------------
// T83 跨进程契约（IPC → 桥 → 渲染层）
// ---------------------------------------------------------------------------
//
// ⚠️ **这一段是「静默失效」的护栏**（实测踩过）：
//    主进程 IPC 回的是**对象** `{ content, layer }`，而渲染层桥的契约是
//    **字符串**（`Promise<string>`）—— 两者不对齐时，渲染层会拿到对象、
//    被 `typeof content === 'string'` 判成「**没有**内嵌歌词」
//    ⇒ 主进程明明取到了，界面却一直显示「暂无歌词」，**且没有任何报错**。
//
// ⇒ 这里把**整条链**（真 IPC 处理器 → 桥适配器 → 渲染层取法）**串起来**断言：
//    任何一环的形状漂移 ⇒ 这里必红。
// ---------------------------------------------------------------------------

describe('T83 跨进程契约：IPC 载荷 → 桥 → 渲染层', () => {
  /** 假 `ipcMain`（收集 handler）。 */
  function fakeIpcMain(): { ipcMain: IpcMainEventsLike; handlers: Map<string, Handler> } {
    const handlers = new Map<string, Handler>()
    const ipcMain: IpcMainEventsLike = {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      on() {
        /* 本测试用不到推送通道 */
      },
    }
    return { ipcMain, handlers }
  }

  /** 造一个**不联网**的歌词源提供器（本段只关心内嵌这一层）。 */
  const stubProvider: LyricProvider = {
    fetchExternalLyric: async () => ({ status: 'not-found', message: '本测试不查外部源' }),
  }

  /** 造一份临时偏好文件（`PrefsStore` 需要一个真实路径）。 */
  function tempPrefs(): PrefsStore {
    const dir = mkdtempSync(join(tmpdir(), 'fnm-t83-'))
    tempDirs.push(dir)
    return new PrefsStore({ filePath: join(dir, 'prefs.json') })
  }

  it('IPC 回 `{content, layer}` ⇒ 经桥适配 ⇒ 渲染层拿到**字符串**', async () => {
    // ⚠️ 用**真字节**（mock 里那首带 `ID3 ` 块的歌的文件头）⇒
    //    走的是「真实字节 → 真实解析器 → 真实 IPC → 桥 → 渲染层」整条链。
    const mock = startMock()
    try {
      const token = await loginMock(mock)
      const head = await fetchMockStream(mock, token, EMBEDDED_LYRIC_SONG_GUID, 64 * 1024)

      const { ipcMain, handlers } = fakeIpcMain()
      registerLyricIpc({
        ipcMain,
        prefs: tempPrefs(),
        provider: stubProvider,
        embedded: {
          resolveTrackPath: () => null,
          fetchStreamHead: async () => head,
        },
      })

      const handler = handlers.get('lyric:embedded')
      expect(handler).toBeTruthy()

      // ① 主进程回的**载荷**：对象（带命中层）。
      const payload = await handler?.({}, { id: 'song-1' })
      expect(payload).toEqual({ content: EMBEDDED_LYRIC_LRC, layer: 'stream' })

      // ② **桥适配**（preload 用的是 `toEmbeddedLyricText`）⇒ 字符串。
      const bridged = toEmbeddedLyricText(payload)
      expect(typeof bridged).toBe('string')
      expect(bridged).toBe(EMBEDDED_LYRIC_LRC)

      // ③ 渲染层取法（真函数 + 真桥）⇒ 仍是那串歌词。
      const scope = globalThis as unknown as {
        fnPlayer?: { readEmbeddedLyric?: (id: string) => Promise<string> }
      }
      scope.fnPlayer = { readEmbeddedLyric: async () => bridged }
      try {
        const fetcher = defaultEmbeddedLyricFetcher()
        expect(fetcher).not.toBeNull()
        await expect(fetcher?.('song-1')).resolves.toBe(EMBEDDED_LYRIC_LRC)
      } finally {
        delete scope.fnPlayer
      }
    } finally {
      await mock.close()
    }
  })

  it('内嵌取不到 ⇒ IPC 回空串（不是**空对象**）⇒ 渲染层判「没有」', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    registerLyricIpc({
      ipcMain,
      prefs: tempPrefs(),
      provider: stubProvider,
      embedded: { resolveTrackPath: () => null },
    })

    const handler = handlers.get('lyric:embedded')
    const payload = await handler?.({}, { id: 'song-1' })
    expect(payload).toEqual({ content: '', layer: 'none' })
    expect(toEmbeddedLyricText(payload)).toBe('')
  })

  it('载荷形状不对（`null` / 垃圾 / `content` 不是字符串）⇒ **空串**，不抛', () => {
    expect(toEmbeddedLyricText(null)).toBe('')
    expect(toEmbeddedLyricText(undefined)).toBe('')
    expect(toEmbeddedLyricText(42)).toBe('')
    expect(toEmbeddedLyricText({})).toBe('')
    expect(toEmbeddedLyricText({ content: 42 })).toBe('')
  })
})

// ---------------------------------------------------------------------------
// T83 流式层：读满即断开
// ---------------------------------------------------------------------------

describe('T83 流式层：读满即断开（不把整首歌拉下来）', () => {
  it('只取到上限那么多字节，并立刻 `cancel()`', async () => {
    const chunk = new Uint8Array(1024).fill(7)
    let pulled = 0
    let cancelled = false
    // ⚠️ 流是**有限**的（64 KB）⇒ 就算「读满不中断」也只会多读，不会挂死。
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 64) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })

    const head = await readAtMostBytes(stream, 4096)
    expect(head.length).toBe(4096)
    // ⚠️ **鉴别力**：读了**几块** —— 读满就该停（不该把 64 块全读完）。
    expect(pulled).toBeLessThanOrEqual(8)
    expect(cancelled).toBe(true)
  })

  it('流比上限还短 ⇒ 照样读完（不多读、不报错）', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10))
        controller.close()
      },
    })
    const head = await readAtMostBytes(stream, 4096)
    expect(head.length).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// T83 纪律：渲染层**不碰文件系统**
// ---------------------------------------------------------------------------

describe('T83 纪律：渲染层不碰文件系统', () => {
  it('`src/player/lyricSource.ts` 不得 import `node:fs` / `electron`', () => {
    // ⚠️ 用**测试文件自己的位置**推仓库根（cwd 无关）。
    //    ⚠️ 不能用 `new URL(...)`：`URL` 在 jsdom 环境里是 jsdom 的实现，
    //    Node 的 `readFileSync` 认不出它（"The URL must be of scheme file"）。
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const source = readFileSync(
      join(repoRoot, 'src', 'player', 'lyricSource.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/node:fs/)
    expect(source).not.toMatch(/from ['"]electron['"]/)
  })
})
