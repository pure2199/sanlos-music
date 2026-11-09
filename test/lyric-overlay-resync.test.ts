// ---------------------------------------------------------------------------
// T73：桌面歌词**跟随**歌词源切换（切源 ⇒ 立刻重新取词并重推）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这是独立的用例文件**：
//    桌面歌词（经典悬浮窗 + 灵动态词岛）的取词在 `installLyricOverlay` 里，
//    它**自己**取词 ⇒ 用户在设置里换了歌词源时，桌面歌词**一直停在旧内容**
//    （全屏歌词页有自己的 effect，会重取）⇒ 同一个应用里两处歌词对不上。
//
// ⚠️ 测试数据全是占位数据，不写真实歌曲名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { Song } from '../shared/types'
import type { LyricOverlayMessage } from '../shared/playerBridge'
import { installLyricOverlay } from '../src/player/lyricOverlay'
import { useAppPrefsStore } from '../src/state/appPrefsStore'

/** 让出一个宏任务（把定时器与微任务都放行）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 一首占位歌曲。 */
const SONG: Song = {
  id: 'song-1',
  title: '歌一',
  artist: '示例歌手',
  artistId: '',
  album: '示例专辑',
  albumId: '',
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
      const previous = state
      state = { ...state, ...next }
      listeners.forEach((listener) => listener(state, previous))
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

describe('T73：桌面歌词跟随歌词源切换', () => {
  it('切歌词源 → **立刻重新取词并重推**（桌面歌词不再停在旧内容）', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    await tick()
    expect(api.list).toHaveBeenCalledTimes(1)
    const tracksBefore = messages.filter((message) => message.kind === 'track').length

    // 切源（用户在设置里改了「外部歌词源」）⇒ 桌面歌词必须**立刻**跟上。
    const before = useAppPrefsStore.getState().lyricSource
    useAppPrefsStore.setState({ lyricSource: 'lrclib' })
    await tick()
    await tick()

    expect(api.list).toHaveBeenCalledTimes(2)
    const tracksAfter = messages.filter((message) => message.kind === 'track').length
    expect(tracksAfter).toBeGreaterThan(tracksBefore)

    // 复原（别把全局 store 的状态留给别的用例）。
    useAppPrefsStore.setState({ lyricSource: before })
    handle?.dispose()
  })

  it('切**优先级** → 同样立刻重新取词', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    await tick()
    expect(api.list).toHaveBeenCalledTimes(1)

    const before = useAppPrefsStore.getState().lyricPriority
    useAppPrefsStore.setState({ lyricPriority: 'local-first' })
    await tick()
    await tick()
    expect(api.list).toHaveBeenCalledTimes(2)

    useAppPrefsStore.setState({ lyricPriority: before })
    handle?.dispose()
  })

  it('桌面歌词**关着**时切源 → **不多打 NAS**', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    const before = useAppPrefsStore.getState().lyricSource
    useAppPrefsStore.setState({ lyricSource: 'qq' })
    await tick()
    await tick()

    expect(api.list).not.toHaveBeenCalled()

    useAppPrefsStore.setState({ lyricSource: before })
    handle?.dispose()
  })
})
