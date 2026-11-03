// ---------------------------------------------------------------------------
// T10 桌面悬浮歌词（独立窗）
//
// 覆盖三条：
// - **本地插值时钟**（`overlayClock.ts`）：悬浮窗不逐帧收 IPC，
//   而是用「最近一次进度采样 + 经过时间」在本地推出当前位置；
// - **悬浮窗内容组件**（`LyricOverlay.tsx`）：双行逐字歌词 + 歌名/歌手 +
//   点歌词跳转 + 播放控制（可拖动区域由样式表表达）；
// - **IPC 消息清洗**（`electron/ipc.ts`）：主进程**只转发、不解析**歌词内容，
//   但形状不对的消息必须被丢弃。
//
// ⚠️ 测试数据一律用占位值（「歌一」「示例歌手」…），不写真实歌曲名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import type { Song } from '../shared/types'
import type { LyricEntry } from '../src/api/types'
import type { LyricOverlayMessage } from '../shared/playerBridge'
import { extrapolatePosition } from '../src/ui/lyrics/overlayClock'
import { emptyOverlayState, mergeLyricMessage } from '../src/ui/lyrics/overlayState'
import { LyricOverlay } from '../src/ui/lyrics/LyricOverlay'
import type { LyricLine } from '../src/ui/lyrics/parse'
import { installLyricOverlay } from '../src/player/lyricOverlay'
import { sanitizeLyricMessage } from '../electron/ipc'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/**
 * 两行占位歌词（带逐字时间）。
 *
 * ⚠️ 逐字**故意拆成两个字**：逐字着色层会复制一份同样的文字，
 *    若某个词的文本恰好等于整行文本，`getByText` 会命中**两个**元素
 *    （底层原文 + 着色层的词）→ 查询歧义。拆开后没有单个词等于整行。
 */
const LINES: LyricLine[] = [
  {
    time: 0,
    text: '歌一',
    words: [
      { text: '歌', start: 0, end: 1 },
      { text: '一', start: 1, end: 2 },
    ],
    translation: '',
  },
  {
    time: 2,
    text: '歌二',
    words: [
      { text: '歌', start: 2, end: 3 },
      { text: '二', start: 3, end: 4 },
    ],
    translation: '',
  },
]

// ---------------------------------------------------------------------------
// 本地插值时钟
// ---------------------------------------------------------------------------

describe('悬浮歌词：本地插值时钟', () => {
  it('播放中：位置随经过时间前进', () => {
    const sample = { at: 1000, position: 10, isPlaying: true }
    expect(extrapolatePosition(sample, 1500)).toBeCloseTo(10.5, 6)
  })

  it('暂停：位置原地不动', () => {
    const sample = { at: 1000, position: 10, isPlaying: false }
    expect(extrapolatePosition(sample, 5000)).toBe(10)
  })

  it('时钟回拨（经过时间为负）时按原位置处理，不倒退', () => {
    const sample = { at: 1000, position: 10, isPlaying: true }
    expect(extrapolatePosition(sample, 500)).toBe(10)
  })

  it('非法输入退化成 0（不崩、不出 NaN）', () => {
    expect(extrapolatePosition({ at: 0, position: Number.NaN, isPlaying: true }, 1000)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 悬浮窗内容组件
// ---------------------------------------------------------------------------

describe('悬浮歌词：内容与交互', () => {
  it('显示歌名与歌手', () => {
    render(
      <LyricOverlay
        track={{ id: 'song-1', title: '示例歌名', artist: '示例歌手' }}
        lines={LINES}
        position={0}
        isPlaying
      />,
    )

    expect(screen.getByText('示例歌名')).toBeTruthy()
    expect(screen.getByText('示例歌手')).toBeTruthy()
  })

  it('渲染双行逐字歌词（复用 LyricView 的双行推进：第 0 页 = 第一行 + 第二行）', () => {
    render(
      <LyricOverlay
        track={{ id: 'song-1', title: '示例歌名', artist: '示例歌手' }}
        lines={LINES}
        position={0}
        isPlaying
      />,
    )

    const view = screen.getByTestId('lyric-view')
    expect(view.className).toContain('fnm-lyricview--double')
    expect(screen.getByText('歌一')).toBeTruthy()
    expect(screen.getByText('歌二')).toBeTruthy()
  })

  it('点歌词行 → 回调跳转秒数', () => {
    const onSeek = vi.fn()
    render(
      <LyricOverlay
        track={{ id: 'song-1', title: '示例歌名', artist: '示例歌手' }}
        lines={LINES}
        position={0}
        isPlaying
        onSeek={onSeek}
      />,
    )

    fireEvent.click(screen.getByText('歌二'))

    expect(onSeek).toHaveBeenCalledWith(2)
  })

  it('播放控制按钮 → 回调播放命令', () => {
    const onCommand = vi.fn()
    render(
      <LyricOverlay
        track={{ id: 'song-1', title: '示例歌名', artist: '示例歌手' }}
        lines={LINES}
        position={0}
        isPlaying
        onCommand={onCommand}
      />,
    )

    fireEvent.click(screen.getByTestId('fnm-lyricoverlay-prev'))
    expect(onCommand).toHaveBeenCalledWith({ type: 'prev' })

    fireEvent.click(screen.getByTestId('fnm-lyricoverlay-toggle'))
    expect(onCommand).toHaveBeenCalledWith({ type: 'toggle' })

    fireEvent.click(screen.getByTestId('fnm-lyricoverlay-next'))
    expect(onCommand).toHaveBeenCalledWith({ type: 'next' })
  })

  it('没有歌词时显示空态（不白屏、不崩）', () => {
    render(
      <LyricOverlay
        track={{ id: 'song-1', title: '示例歌名', artist: '示例歌手' }}
        lines={[]}
        position={0}
        isPlaying={false}
      />,
    )

    expect(screen.getByText('暂无歌词')).toBeTruthy()
  })

  it('没有曲目时显示占位文案（不白屏）', () => {
    render(<LyricOverlay track={null} lines={[]} position={0} isPlaying={false} />)

    expect(screen.getByTestId('fnm-lyricoverlay')).toBeTruthy()
    expect(screen.getByText('未在播放')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 悬浮窗的状态合并
// ---------------------------------------------------------------------------

describe('悬浮歌词：状态合并', () => {
  it('track 消息替换曲目与歌词', () => {
    const next = mergeLyricMessage(
      emptyOverlayState(),
      {
        kind: 'track',
        track: { id: 'song-1', title: '示例歌名', artist: '示例歌手' },
        lines: LINES,
      },
      1000,
    )
    expect(next.track?.title).toBe('示例歌名')
    expect(next.lines).toHaveLength(2)
  })

  it('progress 消息更新采样（本地插值的基准）', () => {
    const next = mergeLyricMessage(
      emptyOverlayState(),
      { kind: 'progress', position: 12.5, isPlaying: true },
      2000,
    )
    expect(next.sample).toEqual({ at: 2000, position: 12.5, isPlaying: true })
  })
})

// ---------------------------------------------------------------------------
// 渲染进程侧的数据推送
// ---------------------------------------------------------------------------

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

/** 另一首占位歌曲（用于「拉歌词期间切歌」）。 */
const SONG_B: Song = { ...SONG, id: 'song-2', title: '歌二' }

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

describe('悬浮歌词：渲染进程侧推送', () => {
  it('悬浮窗不可见时**不拉歌词**（不多打 NAS）', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    store.set({ position: 5 })
    await tick()

    expect(api.list).not.toHaveBeenCalled()
    handle?.dispose()
  })

  it('可见时切歌 → 拉一次歌词并推 track 消息', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    await tick()

    expect(api.list).toHaveBeenCalledWith('song-1')
    const track = messages.find((message) => message.kind === 'track')
    expect(track?.kind).toBe('track')
    if (track?.kind === 'track') {
      expect(track.track?.title).toBe('歌一')
    }

    // 同一首歌**不重复拉**
    store.set({ position: 9 })
    await tick()
    expect(api.list).toHaveBeenCalledTimes(1)
    handle?.dispose()
  })

  it('进度变化 → 推 progress 消息（不带歌词）', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    store.set({ position: 7, isPlaying: true })
    await tick()

    const progress = messages.filter((message) => message.kind === 'progress')
    expect(progress.length).toBeGreaterThan(0)
    const last = progress.at(-1)
    if (last?.kind === 'progress') {
      expect(last.position).toBe(7)
      expect(last.isPlaying).toBe(true)
    }
    handle?.dispose()
  })

  // -------------------------------------------------------------------------
  // 两条竞态护栏（实现里刻意处理过的，回归必须钉住）
  // -------------------------------------------------------------------------

  it('启动时可见性事件先到 → 不会被后到的启动读取覆盖', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const messages: LyricOverlayMessage[] = []
    // ⚠️ 用**数组**持有回调：变量在回调里赋值、在外层调用时，
    //    TypeScript 的控制流分析会把 `let` 收窄成初始值（这里会收窄成 `null`）。
    const visibilityHandlers: Array<(visible: boolean) => void> = []
    const prefsResolvers: Array<(prefs: { lyricOverlay: { visible: boolean } }) => void> = []
    const bridge = {
      pushLyricState: (message: LyricOverlayMessage) => {
        messages.push(message)
      },
      onLyricVisibility: (handler: (visible: boolean) => void) => {
        visibilityHandlers.push(handler)
        return () => {
          const index = visibilityHandlers.indexOf(handler)
          if (index >= 0) visibilityHandlers.splice(index, 1)
        }
      },
      // ⚠️ 启动读取**故意拖到最后**才 resolve：它带着**更旧**的「不可见」。
      getPrefs: () =>
        new Promise<{ lyricOverlay: { visible: boolean } }>((resolve) => {
          prefsResolvers.push(resolve)
        }),
    }

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    // 事件先到（用户刚打开悬浮窗）→ 它是**更新的**状态。
    visibilityHandlers.forEach((handler) => handler(true))
    // 启动读取随后才到（内容更旧）→ **不许覆盖**事件。
    prefsResolvers.forEach((resolve) => resolve({ lyricOverlay: { visible: false } }))
    await tick()
    await tick()

    expect(handle?.isEnabled()).toBe(true)

    // 可见性仍是「开」→ 进度照常推。
    store.set({ position: 5 })
    await tick()
    const progress = messages.filter((message) => message.kind === 'progress')
    expect(progress.some((message) => message.kind === 'progress' && message.position === 5)).toBe(true)
    handle?.dispose()
  })

  it('拉歌词期间切歌 → 旧歌词不推送（过时的响应被丢弃）', async () => {
    // ⚠️ 第一首歌的歌词请求**故意挂住**，直到切歌之后才 resolve。
    const pending: Array<(entries: LyricEntry[]) => void> = []
    const api = {
      list: vi.fn((songId: string): Promise<LyricEntry[]> => {
        if (songId === 'song-1') {
          return new Promise<LyricEntry[]>((resolve) => {
            pending.push(resolve)
          })
        }
        return Promise.resolve<LyricEntry[]>([])
      }),
    }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    expect(api.list).toHaveBeenCalledWith('song-1')

    // 切歌 → 拉第二首的歌词。
    store.set({ current: SONG_B })
    await tick()
    await tick()
    // 第一首的歌词这时才回来 → **必须被丢弃**（它已经过时）。
    pending.forEach((resolve) => resolve([]))
    await tick()
    await tick()

    const trackIds = messages
      .filter((message): message is Extract<LyricOverlayMessage, { kind: 'track' }> => message.kind === 'track')
      .map((message) => message.track?.id)
    expect(trackIds).toContain('song-2')
    expect(trackIds).not.toContain('song-1')
    handle?.dispose()
  })

  it('悬浮窗关闭后 → 不再推送进度（不白费力气）', async () => {
    const api = { list: vi.fn(async () => []) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    store.set({ position: 3 })
    await tick()
    const before = messages.filter((message) => message.kind === 'progress').length
    expect(before).toBeGreaterThan(0)

    // 关掉悬浮窗 → 不再推进度。
    setVisible(false)
    store.set({ position: 4 })
    await tick()
    const after = messages.filter((message) => message.kind === 'progress').length
    expect(after).toBe(before)
    handle?.dispose()
  })
})

// ---------------------------------------------------------------------------
// IPC 消息清洗
// ---------------------------------------------------------------------------
describe('悬浮歌词：IPC 消息清洗', () => {
  it('合法的 track 消息被接受', () => {
    const message = sanitizeLyricMessage({
      kind: 'track',
      track: { id: 'song-1', title: '示例歌名', artist: '示例歌手' },
      lines: [{ time: 0, text: '歌一', words: [{ text: '歌一', start: 0, end: 2 }], translation: '' }],
    })

    expect(message?.kind).toBe('track')
  })

  it('合法的 progress 消息被接受', () => {
    const message = sanitizeLyricMessage({ kind: 'progress', position: 12.5, isPlaying: true })
    expect(message?.kind).toBe('progress')
  })

  it('形状不对的消息被丢弃（null）', () => {
    expect(sanitizeLyricMessage(null)).toBeNull()
    expect(sanitizeLyricMessage({ kind: 'unknown' })).toBeNull()
    expect(sanitizeLyricMessage({ kind: 'progress', position: 'abc', isPlaying: true })).toBeNull()
    expect(
      sanitizeLyricMessage({ kind: 'track', track: { id: 1, title: 'x', artist: 'y' }, lines: [] }),
    ).toBeNull()
  })
})
