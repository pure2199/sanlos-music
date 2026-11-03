// ---------------------------------------------------------------------------
// T11 本地下载（主进程下载管理器）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **文件名清洗**（`sanitizeFileName` / `downloadFileName` / `normalizeExtension`）：
//   Windows 非法字符、控制字符、结尾的点与空格、设备保留名、**路径穿越**（`..`）；
// - **`Content-Range` 解析**（断点续传的正确性判据）；
// - **下载管理器**（`DownloadManager`）：
//   成功落盘 + 登记索引、**半成品不进索引**、断点续传、
//   **服务端忽略 Range 时从头重下**、取消、清空、重复下载不再下第二遍。
//
// ⚠️ 文件系统**全部用内存替身**（不碰真实磁盘）。
// ⚠️ 测试数据一律用占位值，不写真实歌曲名 / FN ID / 用户路径。

import { describe, it, expect, vi } from 'vitest'

import {
  DEFAULT_DOWNLOAD_SUBDIR,
  DOWNLOAD_INDEX_FILE_NAME,
  DownloadManager,
  downloadFileName,
  normalizeExtension,
  parseContentRangeStart,
  sanitizeFileName,
  type DownloadIndex,
  type DownloadSink,
} from '../electron/downloadManager'

// ---------------------------------------------------------------------------
// 内存文件系统（替身）
// ---------------------------------------------------------------------------

function memoryFs(): {
  files: Map<string, Uint8Array>
  statSize: (path: string) => Promise<number | null>
  openSink: (path: string, append: boolean) => Promise<DownloadSink>
  renameFile: (from: string, to: string) => Promise<void>
  removeFile: (path: string) => Promise<void>
} {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    async statSize(path: string): Promise<number | null> {
      return files.get(path)?.byteLength ?? null
    },
    async openSink(path: string, append: boolean): Promise<DownloadSink> {
      let buffer: Uint8Array = append ? (files.get(path) ?? new Uint8Array(0)) : new Uint8Array(0)
      return {
        async write(chunk: Uint8Array): Promise<void> {
          const next = new Uint8Array(buffer.length + chunk.byteLength)
          next.set(buffer, 0)
          next.set(chunk, buffer.length)
          buffer = next
          files.set(path, buffer)
        },
        async close(): Promise<void> {
          // 内存实现：写的时候就落到 map 里了。
        },
      }
    },
    async renameFile(from: string, to: string): Promise<void> {
      const data = files.get(from)
      if (!data) throw new Error('源文件不存在')
      files.set(to, data)
      files.delete(from)
    },
    async removeFile(path: string): Promise<void> {
      files.delete(path)
    },
  }
}

/** 造一个带字节流的响应（`Response` 的 body 是 web ReadableStream）。 */
function streamResponse(
  bytes: Uint8Array,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: init?.headers ?? {},
  })
}

/** 让出一个宏任务。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const SONG_ID = 'track_example01'
const DIR = 'C:\\Music\\飞牛音乐'
const FINAL = `${DIR}\\示例歌手 - 示例歌名.flac`

// ---------------------------------------------------------------------------
// 文件名清洗
// ---------------------------------------------------------------------------

describe('下载：文件名清洗', () => {
  it('Windows 非法字符换成下划线', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('控制字符直接删掉', () => {
    expect(sanitizeFileName('歌\u0000一\u001f')).toBe('歌一')
  })

  it('结尾的点与空格去掉（Windows 不允许）', () => {
    expect(sanitizeFileName('歌名.  ')).toBe('歌名')
    expect(sanitizeFileName('  歌名  ')).toBe('歌名')
  })

  it('设备保留名加前缀', () => {
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('com1')).toBe('_com1')
    expect(sanitizeFileName('CONSOLE')).toBe('CONSOLE')
  })

  it('「.」与「..」清成空串（路径穿越无从下手）', () => {
    expect(sanitizeFileName('..')).toBe('')
    expect(sanitizeFileName('.')).toBe('')
  })

  it('扩展名归一化：不合法的一律 bin（不猜）', () => {
    expect(normalizeExtension('FLAC')).toBe('flac')
    expect(normalizeExtension('.flac')).toBe('flac')
    expect(normalizeExtension('dts-hd')).toBe('bin')
    expect(normalizeExtension('')).toBe('bin')
    expect(normalizeExtension('../../x')).toBe('bin')
  })

  it('最终文件名 = 歌手 - 歌名.扩展名；缺歌手时只有歌名', () => {
    expect(
      downloadFileName({ songId: SONG_ID, title: '示例歌名', artist: '示例歌手', ext: 'flac' }),
    ).toBe('示例歌手 - 示例歌名.flac')

    expect(downloadFileName({ songId: SONG_ID, title: '示例歌名', artist: '', ext: 'flac' })).toBe(
      '示例歌名.flac',
    )
  })

  it('歌名与歌手都空时退回歌曲 id', () => {
    expect(downloadFileName({ songId: SONG_ID, title: '', artist: '', ext: 'flac' })).toBe(
      `${SONG_ID}.flac`,
    )
  })

  it('歌名里的路径分隔符被清洗（拼不出目录外的路径）', () => {
    const name = downloadFileName({
      songId: SONG_ID,
      title: '../../etc/passwd',
      artist: 'a/b',
      ext: 'flac',
    })
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name).toBe('a_b - .._.._etc_passwd.flac')
  })
})

// ---------------------------------------------------------------------------
// Content-Range
// ---------------------------------------------------------------------------

describe('下载：Content-Range 解析', () => {
  it('解析出起始字节', () => {
    expect(parseContentRangeStart('bytes 100-200/300')).toBe(100)
    expect(parseContentRangeStart('bytes 0-0/1')).toBe(0)
  })

  it('头缺失或格式不对时返回 null（不知道 ≠ 猜）', () => {
    expect(parseContentRangeStart(null)).toBeNull()
    expect(parseContentRangeStart('')).toBeNull()
    expect(parseContentRangeStart('bytes abc-def/1')).toBeNull()
    expect(parseContentRangeStart('items 1-2/3')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 下载管理器
// ---------------------------------------------------------------------------

describe('下载：管理器', () => {
  /** 造一个管理器（内存 fs + 可控的取流）。 */
  function makeManager(
    fetchStream: (songId: string, rangeStart: number) => Promise<Response>,
    overrides?: { index?: DownloadIndex; dir?: string },
  ): {
    manager: DownloadManager
    fs: ReturnType<typeof memoryFs>
    written: DownloadIndex[]
  } {
    const fs = memoryFs()
    const written: DownloadIndex[] = []
    let index: DownloadIndex = overrides?.index ?? { version: 1, entries: {} }
    const manager = new DownloadManager({
      fetchStream,
      getDownloadDir: () => overrides?.dir ?? DIR,
      readIndex: () => index,
      writeIndex: (next) => {
        written.push(next)
        index = next
      },
      statSize: fs.statSize,
      openSink: fs.openSink,
      renameFile: fs.renameFile,
      removeFile: fs.removeFile,
    })
    return { manager, fs, written }
  }

  it('下载成功：文件落盘（.part 改名）+ 索引登记 + 状态 done', async () => {
    const { manager, fs, written } = makeManager(async () =>
      streamResponse(new Uint8Array([1, 2, 3, 4]), {
        headers: { 'content-length': '4' },
      }),
    )

    manager.start({ songId: SONG_ID, title: '示例歌名', artist: '示例歌手', ext: 'flac' })
    await tick()
    await tick()
    await tick()

    const list = manager.list()
    expect(list.entries[SONG_ID]).toBeTruthy()
    expect(list.entries[SONG_ID]?.file).toBe(FINAL)
    expect(list.tasks[0]?.status).toBe('done')
    // ⚠️ `.part` 半成品**必须**已经改名掉。
    expect([...fs.files.keys()].some((key) => key.endsWith('.part'))).toBe(false)
    expect(fs.files.has(FINAL)).toBe(true)
    // 索引**只在成功后**写一次。
    expect(written).toHaveLength(1)
    expect(written[0]?.entries[SONG_ID]).toBeTruthy()
  })

  it('下载失败：索引里**没有**这一条（半成品绝不登记）', async () => {
    const { manager, fs, written } = makeManager(async () =>
      streamResponse(new Uint8Array([1]), { status: 500 }),
    )

    manager.start({ songId: SONG_ID, title: '示例歌名', artist: '示例歌手', ext: 'flac' })
    await tick()
    await tick()

    expect(manager.list().entries[SONG_ID]).toBeUndefined()
    expect(manager.list().tasks[0]?.status).toBe('error')
    expect(fs.files.size).toBe(0)
    expect(written).toHaveLength(0)
  })

  it('断点续传：`.part` 已有字节 → 从该字节继续请求', async () => {
    const fs = memoryFs()
    fs.files.set(`${FINAL}.part`, new Uint8Array([1, 2, 3]))
    const rangeStarts: number[] = []

    const manager = new DownloadManager({
      fetchStream: async (_songId, rangeStart) => {
        rangeStarts.push(rangeStart)
        return streamResponse(new Uint8Array([4, 5]), {
          status: 206,
          headers: { 'content-length': '2', 'content-range': 'bytes 3-4/5' },
        })
      },
      getDownloadDir: () => DIR,
      statSize: fs.statSize,
      openSink: fs.openSink,
      renameFile: fs.renameFile,
      removeFile: fs.removeFile,
    })

    manager.start({ songId: SONG_ID, title: '示例歌名', artist: '示例歌手', ext: 'flac' })
    await tick()
    await tick()
    await tick()

    expect(rangeStarts).toEqual([3])
    expect(manager.list().entries[SONG_ID]?.bytes).toBe(5)
    // 前 3 个字节是**上次留下的**，后 2 个是这次续传写的。
    expect(fs.files.get(FINAL)?.byteLength).toBe(5)
  })

  it('服务端**忽略 Range**（回 200 整份）→ 从头重下，不追加写坏文件', async () => {
    const fs = memoryFs()
    fs.files.set(`${FINAL}.part`, new Uint8Array([9, 9, 9]))
    const appendFlags: boolean[] = []

    const manager = new DownloadManager({
      fetchStream: async () =>
        streamResponse(new Uint8Array([1, 2]), { headers: { 'content-length': '2' } }),
      getDownloadDir: () => DIR,
      statSize: fs.statSize,
      openSink: async (path, append) => {
        appendFlags.push(append)
        return fs.openSink(path, append)
      },
      renameFile: fs.renameFile,
      removeFile: fs.removeFile,
    })

    manager.start({ songId: SONG_ID, title: '示例歌名', artist: '示例歌手', ext: 'flac' })
    await tick()
    await tick()
    await tick()

    // ⚠️ 必须是**覆盖**（append = false），不能把整份追加到旧的 3 个字节后面。
    expect(appendFlags).toEqual([false])
    expect(fs.files.get(FINAL)?.byteLength).toBe(2)
  })

  it('已下载的同一首**不再下第二遍**', async () => {
    const fetchStream = vi.fn(async () => streamResponse(new Uint8Array([1])))
    const { manager } = makeManager(fetchStream, {
      index: {
        version: 1,
        entries: {
          [SONG_ID]: {
            songId: SONG_ID,
            file: FINAL,
            bytes: 1,
            ext: 'flac',
            downloadedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    })

    const task = manager.start({ songId: SONG_ID, title: '示例歌名', artist: '示例歌手', ext: 'flac' })
    await tick()

    expect(task.status).toBe('done')
    expect(fetchStream).not.toHaveBeenCalled()
    expect(manager.isDownloaded(SONG_ID)).toBe(true)
    expect(manager.localPath(SONG_ID)).toBe(FINAL)
  })

  it('取消排队中的任务 → 状态 canceled，且**不再取流**', async () => {
    const fetched: string[] = []
    // ⚠️ 用**数组**持有 resolver：变量在回调里赋值、在外层调用时，
    //    TypeScript 的控制流分析会把 `let` 收窄成初始值（这里会收窄成 `null`）。
    const releasers: Array<() => void> = []
    const gate = new Promise<void>((resolve) => {
      releasers.push(resolve)
    })

    const manager = new DownloadManager({
      fetchStream: async (songId) => {
        fetched.push(songId)
        await gate
        return streamResponse(new Uint8Array([1]))
      },
      getDownloadDir: () => DIR,
    })

    // 第一个占住执行位，第二个留在队列里。
    manager.start({ songId: 'song-a', title: '甲', artist: '乙', ext: 'flac' })
    manager.start({ songId: 'song-b', title: '丙', artist: '丁', ext: 'flac' })

    manager.cancel('song-b')
    expect(manager.list().tasks.find((t) => t.songId === 'song-b')?.status).toBe('canceled')

    releasers.forEach((release) => release())
    await tick()
    await tick()

    expect(fetched).toEqual(['song-a'])
  })

  it('清空本地下载：删文件 + 清索引', async () => {
    const { manager, fs } = makeManager(async () =>
      streamResponse(new Uint8Array([1, 2]), { headers: { 'content-length': '2' } }),
    )
    manager.start({ songId: SONG_ID, title: '示例歌名', artist: '示例歌手', ext: 'flac' })
    await tick()
    await tick()
    await tick()
    expect(manager.isDownloaded(SONG_ID)).toBe(true)
    expect(fs.files.size).toBe(1)

    await manager.clear()

    expect(manager.isDownloaded(SONG_ID)).toBe(false)
    expect(fs.files.size).toBe(0)
  })

  it('索引里的坏条目被丢弃（downloads.json 是用户可编辑的文件）', () => {
    const { manager } = makeManager(async () => streamResponse(new Uint8Array([1])), {
      index: {
        version: 1,
        entries: {
          good: {
            songId: 'good',
            file: 'C:\\Music\\a.flac',
            bytes: 10,
            ext: 'flac',
            downloadedAt: '2026-01-01T00:00:00.000Z',
          },
          // @ts-expect-error 故意塞一个形状不对的条目
          bad: { songId: 'bad', file: 123 },
        },
      },
    })

    expect(manager.isDownloaded('good')).toBe(true)
    expect(manager.isDownloaded('bad')).toBe(false)
  })

  it('默认子目录名与索引文件名是常量（主进程据此落盘）', () => {
    expect(DEFAULT_DOWNLOAD_SUBDIR).toBe('飞牛音乐')
    expect(DOWNLOAD_INDEX_FILE_NAME).toBe('downloads.json')
  })
})
