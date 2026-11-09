// ---------------------------------------------------------------------------
// T76：灵动态词岛左端的**专辑封面**（替换原先的频谱柱）
// ---------------------------------------------------------------------------
//
// ⚠️ 用户指令：「灵动歌词的左边音效动画换成专辑封面」。
//
// 覆盖四条链路：
// - **组件**（`src/island/IslandCover.tsx`）：有封面 → `<img>`；没有 / 加载失败 → 占位块；
// - **词岛集成**（`src/island/IslandApp.tsx`）：左端是封面、**不再有频谱柱**；右端频谱柱**保持不变**；
// - **数据链路**（`src/player/lyricOverlay.ts` → `electron/ipc.ts`）：`coverId` 一路透传；
// - **护栏**：封面地址**只**由 `coverUrl()` 拼（词岛源码里不许出现 `fnm://` 字面量）。
//
// ⚠️ 测试数据一律用占位值，不写真实歌曲名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IslandApp } from '../src/island/IslandApp'
import { IslandCover, ISLAND_COVER_SIZE } from '../src/island/IslandCover'
import { installLyricOverlay } from '../src/player/lyricOverlay'
import { sanitizeLyricMessage } from '../electron/ipc'
import type { Song } from '../shared/types'
import type { LyricOverlayMessage, PlayerBridge } from '../shared/playerBridge'

/** 仓库根目录（源码断言用）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

afterEach(() => {
  delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

describe('T76 词岛封面：组件', () => {
  it('有封面 id → 渲染 `<img>`，地址由 `coverUrl()` 拼（`fnm://` 协议代理）', () => {
    render(<IslandCover coverId="album_abc123" />)

    const img = screen.getByTestId('fnm-island-cover')
    const src = img.getAttribute('src') ?? ''
    expect(src).toContain('fnm://srv/static/cover')
    expect(src).toContain('coverId=album_abc123')
    expect(src).toContain(`size=${ISLAND_COVER_SIZE}`)
    expect(screen.queryByTestId('fnm-island-cover-placeholder')).toBeNull()
  })

  it('没有封面 → 渲染**占位块**，不渲染 `<img>`（不留浏览器默认破图）', () => {
    render(<IslandCover coverId="" />)

    expect(screen.getByTestId('fnm-island-cover-placeholder')).toBeTruthy()
    expect(screen.queryByTestId('fnm-island-cover')).toBeNull()
  })

  it('封面 id 是 `undefined` / `null` → 同样是占位块', () => {
    const { unmount } = render(<IslandCover coverId={undefined} />)
    expect(screen.getByTestId('fnm-island-cover-placeholder')).toBeTruthy()
    unmount()

    render(<IslandCover coverId={null} />)
    expect(screen.getByTestId('fnm-island-cover-placeholder')).toBeTruthy()
  })

  it('封面加载失败 → 切成占位块（不留破图）', () => {
    render(<IslandCover coverId="album_abc123" />)

    fireEvent.error(screen.getByTestId('fnm-island-cover'))

    expect(screen.getByTestId('fnm-island-cover-placeholder')).toBeTruthy()
    expect(screen.queryByTestId('fnm-island-cover')).toBeNull()
  })

  it('换了封面 id → **重置**失败状态（上一张的失败不该连累下一张）', () => {
    const { rerender } = render(<IslandCover coverId="album_abc123" />)
    fireEvent.error(screen.getByTestId('fnm-island-cover'))
    expect(screen.getByTestId('fnm-island-cover-placeholder')).toBeTruthy()

    rerender(<IslandCover coverId="album_def456" />)

    expect(screen.getByTestId('fnm-island-cover')).toBeTruthy()
    expect(screen.getByTestId('fnm-island-cover').getAttribute('src')).toContain('coverId=album_def456')
  })
})

// ---------------------------------------------------------------------------
// 词岛集成
// ---------------------------------------------------------------------------

/** 假桥：只实现词岛用到的几个订阅方法。 */
function fakeBridge(): {
  bridge: PlayerBridge
  emitLyricState: (message: LyricOverlayMessage) => void
} {
  let lyricHandler: ((message: LyricOverlayMessage) => void) | null = null
  const bridge = {
    onLyricState: (handler: (message: LyricOverlayMessage) => void) => {
      lyricHandler = handler
      return () => {
        lyricHandler = null
      }
    },
    onLyricPointer: () => () => undefined,
    onSpectrum: () => () => undefined,
  } as unknown as PlayerBridge
  return {
    bridge,
    emitLyricState: (message: LyricOverlayMessage) => {
      lyricHandler?.(message)
    },
  }
}

describe('T76 词岛封面：集成', () => {
  it('收到带 `coverId` 的曲目 → 左端渲染**专辑封面**', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手', coverId: 'album_abc123' },
        lines: [],
      })
    })

    const img = screen.getByTestId('fnm-island-cover')
    expect(img.getAttribute('src')).toContain('coverId=album_abc123')
  })

  it('左端**不再是频谱柱**（用户指令：左边换成专辑封面）', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手', coverId: 'album_abc123' },
        lines: [],
      })
    })

    // ⚠️ 胶囊里**只剩右端**一组频谱柱（8 根）——左端没有柱子了。
    const spectra = Array.from(container.querySelectorAll('.fnm-island__spectrum'))
    expect(spectra).toHaveLength(1)
    expect(spectra[0]?.className).toContain('fnm-island__spectrum--right')
    expect(container.querySelector('.fnm-island__spectrum--left')).toBeNull()
  })

  it('右端频谱柱**保持不变**（指令只说「左边」）', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)

    const bars = container.querySelectorAll('.fnm-island__spectrum--right .fnm-island__bar')
    expect(bars).toHaveLength(8)
  })

  it('曲目**没有封面** → 左端是占位块，不渲染 `<img>`', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手' },
        lines: [],
      })
    })

    expect(screen.getByTestId('fnm-island-cover-placeholder')).toBeTruthy()
    expect(screen.queryByTestId('fnm-island-cover')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 数据链路
// ---------------------------------------------------------------------------

/** 一首占位歌曲（带封面 id）。 */
const SONG: Song = {
  id: 'song-1',
  title: '歌一',
  artist: '示例歌手',
  artistId: '',
  album: '示例专辑',
  albumId: '',
  coverId: 'album_abc123',
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
      const prev = state
      state = { ...state, ...next }
      for (const listener of listeners) listener(state, prev)
    },
  }
}

/** 让微任务队列跑空（歌词是异步取的）。 */
async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('T76 词岛封面：数据链路', () => {
  it('推给词岛的 track 消息**带 `coverId`**（从 `Song.coverId` 来）', async () => {
    const messages: LyricOverlayMessage[] = []
    // ⚠️ 用**数组**存可见性回调（不是单个变量）：赋值发生在回调里，
    //    TypeScript 的控制流分析会把单个变量窄化成 `null` ⇒ 调用点报错。
    const visibilityHandlers: Array<(visible: boolean) => void> = []
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
      getPrefs: async () => ({ lyricOverlay: { visible: false } }),
    }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })

    const handle = installLyricOverlay({
      bridge,
      api: { list: vi.fn(async () => []) },
      store: store as never,
      external: null,
    })
    visibilityHandlers.forEach((handler) => handler(true))
    await tick()
    await tick()

    const track = messages.find((message) => message.kind === 'track')
    expect(track?.kind).toBe('track')
    if (track?.kind === 'track') {
      expect(track.track?.coverId).toBe('album_abc123')
    }
    handle?.dispose()
  })

  it('主进程净化器**透传**合法 `coverId`', () => {
    const message = sanitizeLyricMessage({
      kind: 'track',
      track: { id: 'song-1', title: '歌一', artist: '示例歌手', coverId: 'album_abc123' },
      lines: [],
    })

    expect(message?.kind).toBe('track')
    if (message?.kind === 'track') {
      expect(message.track?.coverId).toBe('album_abc123')
    }
  })

  it('形状不对的 `coverId` → **当没有封面**（绝不放行任意字符串）', () => {
    const message = sanitizeLyricMessage({
      kind: 'track',
      track: { id: 'song-1', title: '歌一', artist: '示例歌手', coverId: 'not a cover id' },
      lines: [],
    })

    expect(message?.kind).toBe('track')
    if (message?.kind === 'track') {
      expect(message.track?.coverId).toBe('')
    }
  })

  it('老消息（没有 `coverId` 这个键）→ 依然合法（经典悬浮窗不受影响）', () => {
    const message = sanitizeLyricMessage({
      kind: 'track',
      track: { id: 'song-1', title: '歌一', artist: '示例歌手' },
      lines: [],
    })

    expect(message?.kind).toBe('track')
    if (message?.kind === 'track') {
      expect(message.track?.coverId).toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// 护栏
// ---------------------------------------------------------------------------

describe('T76 词岛封面：护栏', () => {
  it('词岛源码里**不许**出现封面路径字面量（地址只由 `coverUrl()` 拼）', () => {
    // ⚠️ 与 `test/song-list.test.tsx` 的「全项目只有一处拼装」**同口径**：
    //    字面量用 `join` 拼出来（否则这个测试文件自己就带着字面量了）。
    const literal = ['static', 'cover'].join('/')
    for (const file of ['src/island/IslandCover.tsx', 'src/island/IslandApp.tsx']) {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8')
      expect(source).not.toContain(literal)
    }
    // 拼装点**必须**被用上。
    const cover = readFileSync(resolve(REPO_ROOT, 'src/island/IslandCover.tsx'), 'utf8')
    expect(cover).toMatch(/coverUrl\(/)
  })

  it('经典悬浮窗**不显示**封面（指令只针对灵动歌词）', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/lyric/main.tsx'), 'utf8')
    expect(source).not.toMatch(/IslandCover/)
  })
})
