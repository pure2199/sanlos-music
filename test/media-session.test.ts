// ---------------------------------------------------------------------------
// Task 17：媒体会话（**渲染进程侧**，Web Media Session API）
//
// 覆盖控制器追加要求 A 里**可测**的部分：
// - 元数据（标题 / 艺人 / 专辑 / 封面）随状态更新；
// - 封面 URL 走 `coverUrl(coverId, size)`（**全项目唯一的拼装点**）；
// - 五个 action handler（play / pause / previoustrack / nexttrack / seekto）
//   **只发命令**，不改播放状态；
// - `setPositionState` 的 `position` 必须在 `duration` 之内；
// - `dispose()` 把**全部** handler 卸掉（`setActionHandler(action, null)`）。
//
// ⚠️ **T21 改写了「封面」这一条的前提**（不是削弱断言，是换了被钉住的行为）：
//    旧行为 = 直接把 `fnm://…` 塞进 `metadata.artwork`；
//    新行为 = **artwork 的 src 必须是 Chromium 认得的 `data:` URL**
//    （Chromium 的媒体会话图片加载器只认 http/https/data/blob，
//      `fnm://` 会被拒 → Windows 侧不显示专辑图）。
//    ⇒ 下面「封面 URL 仍由 coverUrl() 拼装」这条**继续成立**（唯一拼装点不变），
//      但拼出来的地址是**去取字节**用的，不是 artwork 的 src。
//
// ⚠️ 测试里一律用占位数据（「歌一」「示例歌手」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  createMediaSession,
  installMediaSession,
  toSnapshot,
  bytesToDataUrl,
  dataUrlMime,
  fetchArtworkDataUrl,
  MEDIA_ARTWORK_SIZE,
  type MediaMetadataLike,
  type MediaSessionLike,
} from '../src/player/mediaSession'
import { usePlayerStore } from '../src/state/playerStore'
import type { PlayerBridge, PlayerCommand, PlayerStateSnapshot } from '../shared/playerBridge'
import type { PlayerState } from '../shared/types'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 假媒体会话（记录 handler 的装卸与元数据 / 进度的变化）。 */
interface FakeMediaSession extends MediaSessionLike {
  /** 已装的 handler（action → handler）。 */
  handlers: Map<string, ((details: unknown) => void) | null>
  /** 调用某个 action 的 handler。 */
  fire: (action: string, details?: unknown) => void
  /** 记录过的进度状态。 */
  positions: Array<{ duration?: number; position?: number; playbackRate?: number } | undefined>
}

function fakeMediaSession(): FakeMediaSession {
  const handlers = new Map<string, ((details: unknown) => void) | null>()
  const positions: FakeMediaSession['positions'] = []
  const session: FakeMediaSession = {
    handlers,
    positions,
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) {
      handlers.set(action, handler)
    },
    setPositionState(state) {
      positions.push(state)
    },
    fire(action, details) {
      const handler = handlers.get(action)
      if (!handler) throw new Error(`媒体会话 action 未注册：${action}`)
      handler(details)
    },
  }
  return session
}

/** 造一条占位曲目快照。 */
function track(overrides: Partial<NonNullable<PlayerStateSnapshot['current']>> = {}) {
  return {
    id: 'song-1',
    title: '歌一',
    artist: '示例歌手',
    album: '示例专辑',
    coverId: 'track_abc',
    duration: 100,
    ...overrides,
  }
}

/** 造一份占位播放器状态快照。 */
function state(overrides: Partial<PlayerStateSnapshot> = {}): PlayerStateSnapshot {
  return {
    current: track(),
    isPlaying: true,
    position: 0,
    duration: 100,
    volume: 1,
    mode: 'sequence',
    muted: false,
    ...overrides,
  }
}

/** 记录构造出来的元数据。 */
function metadataRecorder(): {
  create: (init: {
    title?: string
    artist?: string
    album?: string
    artwork?: Array<{ src: string; sizes?: string; type?: string }>
  }) => MediaMetadataLike
  made: MediaMetadataLike[]
} {
  const made: MediaMetadataLike[] = []
  return {
    made,
    create(init) {
      const meta: MediaMetadataLike = { ...init }
      made.push(meta)
      return meta
    },
  }
}

/**
 * 让挂起的 Promise 链跑完（微任务 + 一个宏任务）。
 *
 * ⚠️ 封面取回是**异步**的（取字节 → `data:` URL），断言前必须让它落地。
 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

/** 假播放器桥（记录推送与命令）。 */
function fakeBridge(): {
  bridge: PlayerBridge
  pushed: PlayerStateSnapshot[]
  sent: PlayerCommand[]
  /** 触发主进程下发命令。 */
  deliver: (command: PlayerCommand) => void
  unsubscribed: () => boolean
} {
  const pushed: PlayerStateSnapshot[] = []
  const sent: PlayerCommand[] = []
  let handler: ((command: PlayerCommand) => void) | null = null
  let unsubscribed = false
  const bridge: PlayerBridge = {
    pushState(snapshot) {
      pushed.push(snapshot)
    },
    sendCommand(command) {
      sent.push(command)
    },
    onCommand(next) {
      handler = next
      return () => {
        handler = null
        unsubscribed = true
      }
    },
    getPrefs: async () => ({}),
    setPrefs: async () => ({}),
    setTheme: async () => ({}),
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    // 桌面悬浮歌词（Task 10）：本用例不碰它，给个空实现即可。
    pushLyricState: () => {},
    onLyricState: () => () => {},
    onLyricVisibility: () => () => {},
    setLyricVisible: async () => {},
    // 本地下载（Task 11）：本用例不碰它，给个空实现即可。
    listDownloads: async () => ({ entries: {}, tasks: [], dir: '' }),
    startDownload: async () => {},
    cancelDownload: async () => {},
    clearDownloads: async () => {},
    onDownloadChange: () => () => {},
    // FFmpeg 兜底解码（Task 12）：本用例不碰它，给个空实现即可。
    ffmpegStatus: async () => ({ available: false, path: '', version: '' }),
    ffmpegFallback: async () => ({ url: '', reason: 'no-ffmpeg', detail: null }),
    // 自动更新（Task 23）：本用例不碰它，给个空实现即可。
    checkUpdate: async () => ({ status: 'not-configured' }),
    downloadUpdate: async () => ({ status: 'error', message: '未实现' }),
    installUpdate: async () => ({ status: 'error', message: '未实现' }),
    // 外部歌词（Task 32）：本用例不碰它，给个空实现即可。
    fetchExternalLyric: async () => ({ status: 'not-found' }),
    // 本地曲目（T38）：本用例不碰它，给个空实现即可。
    listLocalTracks: async () => [],
    pickLocalFiles: async () => [],
    pickLocalFolder: async () => '',
    addLocalTracks: async () => [],
    addLocalFolder: async () => [],
    removeLocalTrack: async () => [],
    // ⚠️ T39：清单变化推送（假用例用不到，给个空实现即可）。
    onLocalChanged: () => () => undefined,
  }
  return {
    bridge,
    pushed,
    sent,
    deliver(command) {
      if (!handler) throw new Error('没有注册命令处理器')
      handler(command)
    },
    unsubscribed: () => unsubscribed,
  }
}

afterEach(() => {
  delete (globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer
  usePlayerStore.setState({
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    muted: false,
    error: null,
  })
})

// ---------------------------------------------------------------------------
// 封面字节 → data: URL（T21）
// ---------------------------------------------------------------------------

describe('bytesToDataUrl / dataUrlMime', () => {
  it('字节 → data: URL（base64，能原样还原）', () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    const url = bytesToDataUrl(bytes, 'image/png')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const b64 = url.slice('data:image/png;base64,'.length)
    expect(atob(b64)).toBe(String.fromCharCode(1, 2, 3, 250))
  })

  it('字节很多时也不爆栈（分块编码）', () => {
    const bytes = new Uint8Array(200_000).fill(7)
    const url = bytesToDataUrl(bytes)
    expect(url.length).toBeGreaterThan(100_000)
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('dataUrlMime：从 data: URL 取 MIME；不是 data: 就 undefined', () => {
    expect(dataUrlMime('data:image/webp;base64,AAA')).toBe('image/webp')
    expect(dataUrlMime('fnm://srv/static/cover?coverId=x')).toBeUndefined()
    expect(dataUrlMime('data:image/png')).toBeUndefined()
  })
})

describe('fetchArtworkDataUrl（默认实现：渲染层自取）', () => {
  /** 临时替换 `globalThis.fetch`，返回一个假响应。 */
  async function withFetch(
    impl: () => Promise<unknown>,
    run: () => Promise<void>,
  ): Promise<void> {
    const original = globalThis.fetch
    globalThis.fetch = impl as unknown as typeof fetch
    try {
      await run()
    } finally {
      globalThis.fetch = original
    }
  }

  it('把封面字节转成 data: URL（**不是**把 fnm:// 原样交出去）', async () => {
    await withFetch(
      async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      }),
      async () => {
        const url = await fetchArtworkDataUrl('fnm://srv/static/cover?coverId=x')
        expect(url?.startsWith('data:image/jpeg;base64,')).toBe(true)
        expect(url?.startsWith('fnm://')).toBe(false)
      },
    )
  })

  it('HTTP 非 2xx 时返回 null（不抛）', async () => {
    await withFetch(
      async () => ({ ok: false, blob: async () => new Blob([]) }),
      async () => {
        expect(await fetchArtworkDataUrl('fnm://srv/static/cover?coverId=x')).toBeNull()
      },
    )
  })

  it('请求抛异常时返回 null（不能因此影响播放）', async () => {
    await withFetch(
      async () => {
        throw new Error('网络炸了')
      },
      async () => {
        expect(await fetchArtworkDataUrl('fnm://srv/static/cover?coverId=x')).toBeNull()
      },
    )
  })

  it('空字节返回 null', async () => {
    await withFetch(
      async () => ({
        ok: true,
        blob: async () => new Blob([], { type: 'image/jpeg' }),
      }),
      async () => {
        expect(await fetchArtworkDataUrl('fnm://srv/static/cover?coverId=x')).toBeNull()
      },
    )
  })
})

// ---------------------------------------------------------------------------
// createMediaSession
// ---------------------------------------------------------------------------

describe('createMediaSession 元数据', () => {
  it('update 时写入标题 / 艺人 / 专辑', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state())

    const meta = recorder.made[0]
    expect(meta?.title).toBe('歌一')
    expect(meta?.artist).toBe('示例歌手')
    expect(meta?.album).toBe('示例专辑')
    expect(session.metadata).toBe(meta)
  })

  it('封面 URL 仍由 coverUrl() 拼装，但**不直接**塞进 artwork（Chromium 不认 fnm://）', async () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    /** 被请求过的封面 URL（用来验证「唯一拼装点」没被绕过）。 */
    const requested: string[] = []
    const controller = createMediaSession({
      session,
      createMetadata: recorder.create,
      fetchArtwork: async (url) => {
        requested.push(url)
        return 'data:image/jpeg;base64,AAAA'
      },
    })

    controller.update(state())
    await flush()

    // ① 封面 URL 仍然走 `coverUrl()`（**全项目唯一拼装点**不变）。
    expect(requested.length).toBe(1)
    expect(requested[0]?.startsWith('fnm://srv/')).toBe(true)
    expect(requested[0]).toContain('coverId=track_abc')
    expect(requested[0]).toContain(`size=${MEDIA_ARTWORK_SIZE}`)

    // ② artwork 的 src 是 **data: URL**，**不是** `fnm://`
    //    （Chromium 的媒体会话图片加载器只认 http/https/data/blob）。
    const artwork = recorder.made[recorder.made.length - 1]?.artwork ?? []
    expect(artwork.length).toBe(1)
    expect(artwork[0]?.src.startsWith('data:image/')).toBe(true)
    expect(artwork[0]?.src.startsWith('fnm://')).toBe(false)
    expect(artwork[0]?.type).toBe('image/jpeg')

    // ③ **任何一版**元数据都不得出现过 `fnm://` 的 artwork。
    for (const made of recorder.made) {
      for (const item of made.artwork ?? []) {
        expect(item.src.startsWith('fnm://')).toBe(false)
      }
    }
  })

  it('封面字节还没到时：先出元数据（无 artwork），字节到了再补一次', async () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    /** 手动控制封面请求何时返回（用数组收集 resolver，避免 TS 把 `let` 收窄成 `never`）。 */
    const pending: Array<(value: string | null) => void> = []
    const controller = createMediaSession({
      session,
      createMetadata: recorder.create,
      fetchArtwork: () => new Promise((resolve) => { pending.push(resolve) }),
    })

    controller.update(state())
    await flush()

    // 封面还在路上：标题等元数据**已经可用**，artwork 暂时为空。
    const first = recorder.made[0]
    expect(first?.title).toBe('歌一')
    expect(first?.artwork).toEqual([])

    pending[0]?.('data:image/jpeg;base64,ZZZZ')
    await flush()

    const last = recorder.made[recorder.made.length - 1]
    expect(last?.artwork?.[0]?.src).toBe('data:image/jpeg;base64,ZZZZ')
  })

  it('封面取不到（返回 null）时：元数据照常设置，不崩、不报错', async () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({
      session,
      createMetadata: recorder.create,
      fetchArtwork: async () => null,
    })

    controller.update(state())
    await flush()

    expect(session.metadata).not.toBeNull()
    const last = recorder.made[recorder.made.length - 1]
    expect(last?.title).toBe('歌一')
    expect(last?.artwork).toEqual([])
  })

  it('封面请求抛异常时：不影响播放（元数据照常，artwork 为空）', async () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({
      session,
      createMetadata: recorder.create,
      fetchArtwork: async () => {
        throw new Error('取封面炸了')
      },
    })

    controller.update(state())
    await flush()

    expect(session.metadata).not.toBeNull()
    const last = recorder.made[recorder.made.length - 1]
    expect(last?.title).toBe('歌一')
    expect(last?.artwork).toEqual([])
  })

  it('换歌后：旧封面回来不能盖掉新歌的封面', async () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    /** 手动控制每个封面请求何时返回。 */
    const pending: Array<(value: string | null) => void> = []
    const controller = createMediaSession({
      session,
      createMetadata: recorder.create,
      fetchArtwork: () => new Promise((resolve) => { pending.push(resolve) }),
    })

    controller.update(state({ current: track({ id: 'song-1', coverId: 'track_1' }) }))
    await flush()
    expect(pending.length).toBe(1)

    // 换歌 → 新歌的封面请求也发出去。
    controller.update(state({ current: track({ id: 'song-2', title: '歌二', coverId: 'track_2' }) }))
    await flush()
    expect(pending.length).toBe(2)

    // ⚠️ **旧封面这时才回来** —— 必须被丢弃，不能盖到新歌头上。
    pending[0]?.('data:image/jpeg;base64,OLD')
    await flush()
    const afterOld = recorder.made[recorder.made.length - 1]
    expect(afterOld?.title).toBe('歌二')
    for (const item of afterOld?.artwork ?? []) {
      expect(item.src).not.toContain('OLD')
    }

    // 新封面回来 → 生效。
    pending[1]?.('data:image/jpeg;base64,NEW')
    await flush()
    const afterNew = recorder.made[recorder.made.length - 1]
    expect(afterNew?.artwork?.[0]?.src).toContain('NEW')
  })

  it('同一首歌反复推状态（进度在变）：封面只取一次', async () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    let calls = 0
    const controller = createMediaSession({
      session,
      createMetadata: recorder.create,
      fetchArtwork: async () => {
        calls += 1
        return 'data:image/jpeg;base64,AAAA'
      },
    })

    controller.update(state())
    await flush()
    controller.update(state({ position: 10 }))
    await flush()
    controller.update(state({ position: 20 }))
    await flush()

    expect(calls).toBe(1)
    // 缓存命中：后续的元数据**直接**带上封面（不必等异步）。
    const last = recorder.made[recorder.made.length - 1]
    expect(last?.artwork?.[0]?.src).toBe('data:image/jpeg;base64,AAAA')
  })

  it('没有封面时不挂 artwork', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state({ current: track({ coverId: '' }) }))

    expect(recorder.made[0]?.artwork).toEqual([])
  })

  it('没有曲目时清空元数据', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state({ current: null }))

    expect(session.metadata).toBeNull()
  })

  it('播放状态：playing / paused / none', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state({ isPlaying: true }))
    expect(session.playbackState).toBe('playing')
    controller.update(state({ isPlaying: false }))
    expect(session.playbackState).toBe('paused')
    controller.update(state({ current: null }))
    expect(session.playbackState).toBe('none')
  })
})

describe('createMediaSession 进度', () => {
  it('写入 duration / position / playbackRate', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state({ position: 12, duration: 100 }))

    expect(session.positions.at(-1)).toEqual({ duration: 100, position: 12, playbackRate: 1 })
  })

  it('position 超出 duration 时被钳制（Chromium 会抛）', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state({ position: 999, duration: 100 }))

    const last = session.positions.at(-1)
    expect(last?.duration).toBe(100)
    expect(last?.position).toBe(100)
  })

  it('负进度被钳到 0', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state({ position: -5, duration: 100 }))

    expect(session.positions.at(-1)?.position).toBe(0)
  })

  it('没有时长时不写进度', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })

    controller.update(state({ position: 0, duration: 0, current: track({ duration: 0 }) }))

    expect(session.positions.length).toBe(0)
  })
})

describe('createMediaSession action handler', () => {
  it('装上了五个 action', () => {
    const session = fakeMediaSession()
    createMediaSession({ session })
    expect([...session.handlers.keys()].sort()).toEqual([
      'nexttrack',
      'pause',
      'play',
      'previoustrack',
      'seekto',
    ])
  })

  it('play / pause / previoustrack / nexttrack 只发命令，不改状态', () => {
    const session = fakeMediaSession()
    const sent: PlayerCommand[] = []
    const controller = createMediaSession({
      session,
      sendCommand: (command) => sent.push(command),
    })

    session.fire('play')
    session.fire('pause')
    session.fire('previoustrack')
    session.fire('nexttrack')

    expect(sent).toEqual([
      { type: 'play' },
      { type: 'pause' },
      { type: 'prev' },
      { type: 'next' },
    ])
    // handler **没有**碰媒体会话的元数据 / 播放状态（那是状态回传的事）。
    expect(session.playbackState).toBe('none')
    expect(session.metadata).toBeNull()
    controller.dispose()
  })

  it('seekto 带上秒数', () => {
    const session = fakeMediaSession()
    const sent: PlayerCommand[] = []
    createMediaSession({ session, sendCommand: (command) => sent.push(command) })

    session.fire('seekto', { seekTime: 42 })

    expect(sent).toEqual([{ type: 'seek', seconds: 42 }])
  })

  it('seekto 的 seekTime 非法时不发命令', () => {
    const session = fakeMediaSession()
    const sent: PlayerCommand[] = []
    createMediaSession({ session, sendCommand: (command) => sent.push(command) })

    session.fire('seekto', { seekTime: 'x' })
    session.fire('seekto', {})
    session.fire('seekto', { seekTime: Number.NaN })

    expect(sent).toEqual([])
  })

  it('seekto 的负数被钳到 0', () => {
    const session = fakeMediaSession()
    const sent: PlayerCommand[] = []
    createMediaSession({ session, sendCommand: (command) => sent.push(command) })

    session.fire('seekto', { seekTime: -3 })

    expect(sent).toEqual([{ type: 'seek', seconds: 0 }])
  })
})

describe('createMediaSession dispose', () => {
  it('卸掉全部 action handler', () => {
    const session = fakeMediaSession()
    const controller = createMediaSession({ session })

    controller.dispose()

    for (const [, handler] of session.handlers) {
      expect(handler).toBeNull()
    }
  })

  it('清空元数据与播放状态', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })
    controller.update(state())

    controller.dispose()

    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
  })

  it('dispose 之后 update 不再改会话', () => {
    const session = fakeMediaSession()
    const recorder = metadataRecorder()
    const controller = createMediaSession({ session, createMetadata: recorder.create })
    controller.dispose()

    controller.update(state())

    expect(recorder.made.length).toBe(0)
    expect(session.playbackState).toBe('none')
  })

  it('dispose 可重复调用', () => {
    const session = fakeMediaSession()
    const controller = createMediaSession({ session })
    controller.dispose()
    expect(() => controller.dispose()).not.toThrow()
  })
})

describe('createMediaSession 无浏览器实现时', () => {
  it('session 为 null 时不崩', () => {
    const controller = createMediaSession({ session: null })
    expect(() => controller.update(state())).not.toThrow()
    expect(() => controller.dispose()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// toSnapshot
// ---------------------------------------------------------------------------

describe('toSnapshot', () => {
  it('压成跨进程的精简快照（不含队列）', () => {
    const storeState: PlayerState = {
      current: {
        id: 'song-1',
        title: '歌一',
        artist: '示例歌手',
        artistId: 'a1',
        album: '示例专辑',
        albumId: 'b1',
        coverId: 'track_abc',
        duration: 100,
        favorite: false,
        codec: 'FLAC',
        bitrate: 1000,
        sampleRate: 44100,
        bitDepth: 16,
        year: 2024,
        trackNo: 1,
        discNo: 1,
      },
      queue: [],
      isPlaying: true,
      position: 3,
      duration: 100,
      volume: 0.5,
      mode: 'shuffle',
      muted: true,
      error: null,
    }

    const snapshot = toSnapshot(storeState)

    expect(snapshot).toEqual({
      current: {
        id: 'song-1',
        title: '歌一',
        artist: '示例歌手',
        album: '示例专辑',
        coverId: 'track_abc',
        duration: 100,
      },
      isPlaying: true,
      position: 3,
      duration: 100,
      volume: 0.5,
      mode: 'shuffle',
      muted: true,
    })
    expect(Object.keys(snapshot)).not.toContain('queue')
  })

  it('没有曲目时 current 为 null', () => {
    const snapshot = toSnapshot({
      current: null,
      queue: [],
      isPlaying: false,
      position: 0,
      duration: 0,
      volume: 1,
      mode: 'sequence',
    })
    expect(snapshot.current).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// installMediaSession（渲染进程侧的 IPC 同步机制）
// ---------------------------------------------------------------------------

describe('installMediaSession', () => {
  it('安装时把当前状态推给主进程', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const installed = installMediaSession()

    expect(fake.pushed.length).toBe(1)
    expect(fake.pushed[0]?.isPlaying).toBe(false)
    installed.dispose()
  })

  it('store 状态变化时继续推送', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const installed = installMediaSession()
    fake.pushed.length = 0

    usePlayerStore.setState({ position: 7 })

    expect(fake.pushed.length).toBeGreaterThan(0)
    expect(fake.pushed.at(-1)?.position).toBe(7)
    installed.dispose()
  })

  it('主进程下发的命令在渲染进程执行', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const installed = installMediaSession()
    usePlayerStore.setState({ position: 0, duration: 100 })

    fake.deliver({ type: 'seek', seconds: 30 })

    expect(usePlayerStore.getState().position).toBe(30)
    installed.dispose()
  })

  it('dispose 后不再推送、也不再接收命令', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const installed = installMediaSession()
    installed.dispose()
    fake.pushed.length = 0

    usePlayerStore.setState({ position: 9 })

    expect(fake.pushed.length).toBe(0)
    expect(fake.unsubscribed()).toBe(true)
  })

  it('没有桥时（纯浏览器预览）不崩', () => {
    delete (globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer
    const installed = installMediaSession()
    expect(() => usePlayerStore.setState({ position: 1 })).not.toThrow()
    installed.dispose()
  })
})

// ---------------------------------------------------------------------------
// 媒体会话的 action handler 不直接改状态（回环防护）
// ---------------------------------------------------------------------------

describe('媒体会话 action handler 不改播放状态', () => {
  it('触发 play 不会改 store 的播放状态', () => {
    const session = fakeMediaSession()
    const sent: PlayerCommand[] = []
    createMediaSession({ session, sendCommand: (command) => sent.push(command) })

    usePlayerStore.setState({ isPlaying: false, current: null })
    session.fire('play')

    expect(sent).toEqual([{ type: 'play' }])
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('媒体会话的命令**只发给主进程**（不直接 send 到渲染进程自己）', () => {
    const session = fakeMediaSession()
    const sendCommand = vi.fn()
    createMediaSession({ session, sendCommand })

    session.fire('nexttrack')

    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(sendCommand).toHaveBeenCalledWith({ type: 'next' })
  })
})
