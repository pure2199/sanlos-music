// ---------------------------------------------------------------------------
// T112：桌面歌词**不**给有声读物**误配**歌词
// ---------------------------------------------------------------------------
//
// ⚠️ **这条缺陷是 T111 真机复验时发现的**（2026-11-18，已装的 v0.4.0）：
//    有声读物的集标题是 `0001` 这种**纯数字** ⇒ 歌词源拿它去匹配
//    ⇒ **随便命中某首别的歌** ⇒ 桌面歌词窗 / 灵动歌词岛显示**不相干的词**
//    （实测 161 / 122 / 132 / 235 / 108 / 348 行）。
//
// ⇒ 全屏播放页（T101）早就有「有声读物不查词」的口径 ⇒ 这一轮把**桌面歌词这条路补上**。
//
// ⚠️ **鉴别力（缺一不可，缺一条这条用例就可能是假绿）**：
// 1. **有声** ⇒ **一次取词请求都不发**（NAS 的 `api.list` ＋ 外部源**都没被问**）；
// 2. 推给主进程的 `lines` 是 **[]**（⇒ 主进程按 T106 的规则把窗口收起来）；
// 3. **对照组**：普通歌 ⇒ **照常取词**（证明不是「一律不取词」）；
// 4. **默认判据**（不注入 `isAudiobook`）也认账 ⇒ 读的是 `useAudiobookStore`
//    （与全屏页**同一份真相**，人工改判**优先**）。
//
// ⚠️ 测试数据一律用占位值（「示例专辑」「第1集」…），不写真实作品名 / FN ID。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Song } from '../shared/types'
import type { LyricEntry } from '../src/api/types'
import type { LyricOverlayMessage } from '../shared/playerBridge'
import type { ExternalLyricResult } from '../shared/lyricProvider'
import { installLyricOverlay } from '../src/player/lyricOverlay'
import { useAudiobookStore } from '../src/state/audiobookStore'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** 让出一个宏任务（把定时器与微任务都放行）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 一首占位歌曲（普通专辑）。 */
const SONG: Song = {
  id: 'song-1',
  title: '示例歌名',
  artist: '示例歌手',
  artistId: '',
  album: '示例专辑',
  albumId: 'al-plain',
  coverId: '',
  duration: 100,
  favorite: false,
  codec: 'FLAC',
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 1,
  discNo: 1,
}

/** 有声读物的**那一集**（**专辑 id 是 `al-novel`** ⇒ 判据只看专辑）。 */
const AUDIOBOOK_SONG: Song = {
  ...SONG,
  id: 'ep-1',
  title: '示例第1集',
  album: '示例有声作品',
  albumId: 'al-novel',
}

/** 一条占位歌词条目（NAS 那份）。 */
const NAS_ENTRY: LyricEntry = {
  guid: 'ly-1',
  source: 'local',
  content: '[00:01.00]示例歌词',
  createdAt: null,
  updatedAt: null,
  isLRC: true,
  offset: 0,
}

/** 外部源那份（**内容各不相同** ⇒ 一眼能认出是哪个源给的）。 */
const EXTERNAL_RESULT: ExternalLyricResult = {
  status: 'ok',
  source: 'custom',
  original: '[00:02.00]外部示例歌词',
  translation: '',
}

/** 假播放器 store（可手动推进状态）。 */
function fakeStore(initial: { current: Song | null; position: number; isPlaying: boolean }) {
  let state = initial
  const listeners = new Set<(s: typeof state, p: typeof state) => void>()
  return {
    getState: () => state,
    subscribe(listener: (s: typeof state, p: typeof state) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: Partial<typeof state>): void {
      const prev = state
      state = { ...state, ...next }
      for (const listener of listeners) listener(state, prev)
    },
  }
}

/** 假桥（记录消息；可手动触发可见性变化）。 */
function fakeBridge() {
  const messages: LyricOverlayMessage[] = []
  let visibility: ((visible: boolean) => void) | null = null
  return {
    messages,
    bridge: {
      pushLyricState: (message: LyricOverlayMessage) => {
        messages.push(message)
      },
      onLyricVisibility: (handler: (visible: boolean) => void) => {
        visibility = handler
        return () => {
          visibility = null
        }
      },
      getPrefs: async () => ({ lyricOverlay: { visible: false } }),
    },
    setVisible(visible: boolean): void {
      visibility?.(visible)
    },
  }
}

/** 取出「曲目」消息里最后一条（供断言）。 */
function lastTrack(messages: LyricOverlayMessage[]): Extract<LyricOverlayMessage, { kind: 'track' }> | null {
  const tracks = messages.filter(
    (message): message is Extract<LyricOverlayMessage, { kind: 'track' }> => message.kind === 'track',
  )
  return tracks.at(-1) ?? null
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('T112：桌面歌词不给有声读物误配歌词', () => {
  it('有声读物 ⇒ **一次取词请求都不发** ＋ 推的 lines 是空的', async () => {
    const api = { list: vi.fn(async () => [NAS_ENTRY]) }
    const external = vi.fn(async () => EXTERNAL_RESULT)
    const store = fakeStore({ current: AUDIOBOOK_SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({
      bridge,
      api,
      store: store as never,
      external: external as never,
      isAudiobook: (albumId) => albumId === 'al-novel',
    })
    setVisible(true)
    await tick()
    await tick()

    // ⚠️ **鉴别力 1**：NAS 歌词表与外部源**一个都没被问**。
    expect(api.list).not.toHaveBeenCalled()
    expect(external).not.toHaveBeenCalled()

    // ⚠️ **鉴别力 2**：推的是**空行** ⇒ 主进程按 T106 的规则把窗口收起来。
    const track = lastTrack(messages)
    expect(track).not.toBeNull()
    expect(track?.lines).toEqual([])
    // ⚠️ 曲目**照推**（`track !== null`）⇒ 主进程认得出「有歌但没歌词」
    //    （推 `null` 会被当成「没在播放」⇒ 反而显示「未在播放」）。
    expect(track?.track?.id).toBe('ep-1')
    handle?.dispose()
  })

  it('**对照组**：普通歌 ⇒ 照常取词（证明不是「一律不取词」）', async () => {
    const api = { list: vi.fn(async () => [NAS_ENTRY]) }
    const external = vi.fn(async () => EXTERNAL_RESULT)
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({
      bridge,
      api,
      store: store as never,
      external: external as never,
      isAudiobook: (albumId) => albumId === 'al-novel',
    })
    setVisible(true)
    await tick()
    await tick()

    // ⚠️ 普通专辑**不在**有声名单里 ⇒ 线上照查（线上优先），线上有 ⇒ 不回落本地。
    expect(external).toHaveBeenCalled()
    const track = lastTrack(messages)
    expect(track?.lines.length).toBeGreaterThan(0)
    handle?.dispose()
  })

  it('**对照组**：普通歌 ⇒ 线上没匹配上时**照常回落本地**（本地那一份照取）', async () => {
    const api = { list: vi.fn(async () => [NAS_ENTRY]) }
    const external = vi.fn(async () => ({ status: 'not-found' }) as ExternalLyricResult)
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({
      bridge,
      api,
      store: store as never,
      external: external as never,
      isAudiobook: (albumId) => albumId === 'al-novel',
    })
    setVisible(true)
    await tick()
    await tick()

    expect(external).toHaveBeenCalled()
    expect(api.list).toHaveBeenCalledWith('song-1')
    const track = lastTrack(messages)
    expect(track?.lines.length).toBeGreaterThan(0)
    handle?.dispose()
  })

  it('判据认的是**专辑**：同一张专辑的别的集**同样不查词**', async () => {
    const api = { list: vi.fn(async () => [NAS_ENTRY]) }
    const store = fakeStore({
      current: { ...AUDIOBOOK_SONG, id: 'ep-2', title: '示例第2集' },
      position: 0,
      isPlaying: false,
    })
    const { bridge, setVisible } = fakeBridge()

    const handle = installLyricOverlay({
      bridge,
      api,
      store: store as never,
      external: null,
      isAudiobook: (albumId) => albumId === 'al-novel',
    })
    setVisible(true)
    await tick()
    await tick()

    expect(api.list).not.toHaveBeenCalled()
    handle?.dispose()
  })

  it('**默认判据**（不注入）⇒ 读 `useAudiobookStore`（与全屏页同一份真相）', async () => {
    // ⚠️ 直接改**全局 store**（人工改判 ⇒ 改判**优先**于自动判定），
    //    用完**还原**（不许把状态漏给别的用例）。
    const before = useAudiobookStore.getState()
    const api = { list: vi.fn(async () => [NAS_ENTRY]) }
    const store = fakeStore({ current: AUDIOBOOK_SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    useAudiobookStore.setState({
      hits: [],
      overrides: { 'al-novel': { value: 'audiobook', albumTitle: '示例有声作品' } },
    })
    try {
      const handle = installLyricOverlay({
        bridge,
        api,
        store: store as never,
        external: null,
      })
      setVisible(true)
      await tick()
      await tick()

      expect(api.list).not.toHaveBeenCalled()
      expect(lastTrack(messages)?.lines).toEqual([])
      handle?.dispose()
    } finally {
      useAudiobookStore.setState({
        hits: before.hits,
        overrides: before.overrides,
      })
    }
  })

  it('**默认判据**：人工改判成「**这不是有声**」⇒ 照常取词（改判优先）', async () => {
    const before = useAudiobookStore.getState()
    const api = { list: vi.fn(async () => [NAS_ENTRY]) }
    const store = fakeStore({ current: AUDIOBOOK_SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    useAudiobookStore.setState({
      hits: [],
      overrides: { 'al-novel': { value: 'not-audiobook', albumTitle: '示例有声作品' } },
    })
    try {
      const handle = installLyricOverlay({
        bridge,
        api,
        store: store as never,
        external: null,
      })
      setVisible(true)
      await tick()
      await tick()

      expect(api.list).toHaveBeenCalledWith('ep-1')
      expect(lastTrack(messages)?.lines.length).toBeGreaterThan(0)
      handle?.dispose()
    } finally {
      useAudiobookStore.setState({
        hits: before.hits,
        overrides: before.overrides,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// 启动时的落盘恢复（T112 的第二条腿）
// ---------------------------------------------------------------------------

describe('T112：启动时恢复有声读物的落盘状态', () => {
  const before = useAudiobookStore.getState()

  afterEach(() => {
    useAudiobookStore.setState({ hits: before.hits, overrides: before.overrides })
  })

  it('`restore()` 读回落盘里的**人工改判** ⇒ 不进「有声」页也知道哪些专辑是有声读物', () => {
    // ⚠️ 用**内存端口**模拟「上次会话落盘的状态」（只读、不发任何请求）。
    const saved = {
      version: 3,
      nextPage: 0,
      scannedCount: 12,
      total: 12,
      candidates: {},
      overrides: { 'al-novel': { value: 'audiobook' as const, albumTitle: '示例有声作品' } },
      keyword: '有声小说',
      scannedAt: 1,
    }
    useAudiobookStore.getState().restore({
      load: () => saved,
      save: () => true,
    })

    expect(useAudiobookStore.getState().isAudiobook('al-novel')).toBe(true)
    expect(useAudiobookStore.getState().isAudiobook('al-plain')).toBe(false)
  })

  it('落盘里**没有**判定的专辑 ⇒ 不是有声（别把普通专辑误判成有声）', () => {
    useAudiobookStore.getState().restore({
      load: () => null,
      save: () => true,
    })

    expect(useAudiobookStore.getState().isAudiobook('al-novel')).toBe(false)
    expect(useAudiobookStore.getState().isAudiobook('al-plain')).toBe(false)
  })
})
