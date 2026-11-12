// ---------------------------------------------------------------------------
// T89-⑪：全屏页「强调色当文字色」在取色背景上的对比度
// ---------------------------------------------------------------------------
//
// ⚠️ **背景**：全屏页的背景 = 封面的**平均色**（`--fnm-fullplayer__tint`），
//    强调色 = 封面的**主色**（Fluent）或主题固定色（Apple）
//    ⇒ 两者来自**同一张图**、亮度天然接近
//    ⇒ 直接把 `--accent` 当文字色用，真机实测只有 **2.94**（AA 要求 4.5）。
//    ⇒ 修法：在**文字/图标色**这个局部语境里，出一个「按背景校正过」的强调色。
//
// ⚠️ **方向是实测定的（T89-⑪ 真机诊断，修复前）**：
//    「强调色当文字色」的**真实落点**与它们**真正压着的背景**是：
//      · 歌词当前行 `.fnm-lyricview__line--whole` ⇒ 压在**全屏页渐变**上 ⇒ 3.67
//      · 悬停的底部控制按钮图标 ⇒ 压在 `--surface-sunken`（不透明）上 ⇒ 3.91
//    这两处背景**都是浅色** ⇒ **只压暗**必然提升对比度。
//    ⇒ 「深色背景就提亮」那条前提**被实测推翻** ⇒ 改写为
//      「压暗也达不到时**原样返回**」（数学上无解，不牺牲颜色）。
//
// ⚠️ **既有测试一条没改**：本文件是**新增**的（`test/lyric-view.test.tsx` 65 条一字未动）。
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

import type { PlayerEngineLike } from '../src/player/engine'
import type { PlayerState, PlayMode, Song } from '../shared/types'
import { createPlayerStore } from '../src/state/playerStore'
import { FullPlayerPage } from '../src/pages/FullPlayerPage'
import {
  clearCoverColorCache,
  getCachedCoverColor,
} from '../src/components/coverColor'
import {
  ACCENT_TEXT_MIN_CONTRAST,
  contrastRatio,
  parseHexColor,
  rgbToHsl,
  toReadableAccent,
} from '../src/ui/accentColor'

/** 造一首占位歌曲（与其它测试文件同款：各文件自带一份，不共享）。 */
function makeSong(index: number, overrides: Partial<Song> = {}): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
    artist: '甲',
    artistId: '',
    album: '示例专辑',
    albumId: '',
    coverId: '',
    duration: 200,
    favorite: false,
    codec: 'FLAC',
    bitrate: 900,
    sampleRate: 44100,
    bitDepth: 16,
    year: 0,
    trackNo: index,
    discNo: 1,
    ...overrides,
  }
}

/** 假引擎（只记录调用，不碰媒体栈）。 */
class FakeEngine implements PlayerEngineLike {
  state: PlayerState = {
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    error: null,
  }
  private stateListeners: ((state: PlayerState) => void)[] = []
  private endedListeners: ((song: Song | null) => void)[] = []

  play(song: Song): void {
    this.state = {
      ...this.state,
      current: song,
      isPlaying: true,
      position: 0,
      duration: song.duration,
      error: null,
    }
    this.emit()
  }

  pause(): void {
    this.state = { ...this.state, isPlaying: false }
    this.emit()
  }

  resume(): void {
    this.state = { ...this.state, isPlaying: true }
    this.emit()
  }

  seek(sec: number): void {
    this.state = { ...this.state, position: sec }
    this.emit()
  }

  setVolume(v: number): void {
    this.state = { ...this.state, volume: v }
    this.emit()
  }

  setQueue(items: Song[]): void {
    this.state = { ...this.state, queue: [...items] }
  }

  setMode(mode: PlayMode): void {
    this.state = { ...this.state, mode }
  }

  onStateChange(cb: (state: PlayerState) => void): void {
    this.stateListeners.push(cb)
  }

  onEnded(cb: (song: Song | null) => void): void {
    this.endedListeners.push(cb)
  }

  emit(): void {
    for (const cb of this.stateListeners) cb(this.state)
  }
}

/** 真机实测的取色背景（浅米灰）。 */
const REAL_TINT = '#d0cbc7'
/** Apple 风的固定强调色（真机实测：这正是那个 2.94 的来源）。 */
const APPLE_ACCENT = '#0a66ff'
const APPLE_ACCENT_HOVER = '#0a54cc'
/** Apple 风的 `--surface-sunken`（悬停按钮真正压着的背景）。 */
const APPLE_SUNKEN = '#e7e7ec'
/** Fluent 风里由封面主色派生出的强调色（真机实测：#9f663c / hover #734a2b）。 */
const FLUENT_ACCENT = '#9f663c'
const FLUENT_ACCENT_HOVER = '#734a2b'

describe('T89-⑪：toReadableAccent（强调色当文字色时的可读性校正）', () => {
  it('已经达标时**原样返回**（不要把本来就可读的颜色改掉）', () => {
    // #000000 压在纯白上 = 21 ⇒ 远远达标
    expect(toReadableAccent('#000000', '#ffffff')).toBe('#000000')
    expect(toReadableAccent('#ffffff', '#000000')).toBe('#ffffff')
  })

  it('真机那一例（Apple 风）：`#0a66ff` 压在 `#d0cbc7` 上 ⇒ 校正后 ≥ 4.5（校正前只有 2.94）', () => {
    expect(contrastRatio(APPLE_ACCENT, REAL_TINT)).toBeLessThan(ACCENT_TEXT_MIN_CONTRAST)
    const fixed = toReadableAccent(APPLE_ACCENT, REAL_TINT)
    expect(contrastRatio(fixed, REAL_TINT)).toBeGreaterThanOrEqual(ACCENT_TEXT_MIN_CONTRAST)
    // 浅背景 ⇒ 压暗
    expect(parseHexColor(fixed)!.r).toBeLessThan(parseHexColor(APPLE_ACCENT)!.r)
  })

  it('真机那一例（Fluent 风 · 封面派生）：`#9f663c` 压在 `#d0cbc7` 上 ⇒ 校正后 ≥ 4.5', () => {
    expect(contrastRatio(FLUENT_ACCENT, REAL_TINT)).toBeLessThan(ACCENT_TEXT_MIN_CONTRAST)
    const fixed = toReadableAccent(FLUENT_ACCENT, REAL_TINT)
    expect(contrastRatio(fixed, REAL_TINT)).toBeGreaterThanOrEqual(ACCENT_TEXT_MIN_CONTRAST)
    expect(parseHexColor(fixed)!.r).toBeLessThan(parseHexColor(FLUENT_ACCENT)!.r)
  })

  it('**色相不变**（仍是那张封面的颜色，只是亮度被调了）', () => {
    for (const accent of [APPLE_ACCENT, FLUENT_ACCENT]) {
      const fixed = toReadableAccent(accent, REAL_TINT)
      const before = rgbToHsl(parseHexColor(accent)!)
      const after = rgbToHsl(parseHexColor(fixed)!)
      expect(Math.abs(after.h - before.h)).toBeLessThan(1)
    }
  })

  it('**只压暗、不提亮**：深色背景压暗也达不到 4.5 ⇒ **原样返回**（不牺牲颜色）', () => {
    // ⚠️ 这一条**改写了原先的前提**（「深背景就提亮」）：
    //    真机实测证明「强调色当文字色」的落点背景**都是浅色**；
    //    而深色取色背景那边**数学上无解**（渐变两端亮度的比值 < 20.25）
    //    ⇒ 提亮只会破坏「白字压在强调色上 ≥ 4.5」和页面下半段的浅底。
    const dark = '#5c3114'
    const fixed = toReadableAccent(dark, '#301e0f')
    expect(fixed).toBe(dark)
  })

  it('输入不合法 ⇒ **原样返回**（不抛、不吞）', () => {
    expect(toReadableAccent('不是颜色', '#ffffff')).toBe('不是颜色')
    expect(toReadableAccent('#9f663c', '也不是颜色')).toBe('#9f663c')
  })

  it('**浅色背景族**都能压暗到达标（强调色比它们暗 ⇒ 压暗只会更可读）', () => {
    const backgrounds = ['#ffffff', '#f0f3ef', '#e7e7ec', '#d0cbc7', '#b0aaa6']
    for (const bg of backgrounds) {
      const fixed = toReadableAccent(APPLE_ACCENT, bg)
      expect(contrastRatio(fixed, bg), `背景 ${bg}`).toBeGreaterThanOrEqual(ACCENT_TEXT_MIN_CONTRAST)
    }
  })

  it('Fluent 风的 hover 强调色（#734a2b）压在 `--surface-sunken`（#e9e9e9）上**本来就达标** ⇒ 不动它', () => {
    expect(contrastRatio(FLUENT_ACCENT_HOVER, '#e9e9e9')).toBeGreaterThanOrEqual(ACCENT_TEXT_MIN_CONTRAST)
    expect(toReadableAccent(FLUENT_ACCENT_HOVER, '#e9e9e9')).toBe(FLUENT_ACCENT_HOVER)
  })

  it('**压暗是单调的**：压暗过程中对比度不会先掉下去再升（浅背景上）', () => {
    // ⚠️ 背景比强调色亮 ⇒ 越暗越可读 ⇒ 中途不该出现「更差」的结果。
    const before = contrastRatio(APPLE_ACCENT, REAL_TINT)
    const fixed = toReadableAccent(APPLE_ACCENT, REAL_TINT)
    expect(contrastRatio(fixed, REAL_TINT)).toBeGreaterThan(before)
  })
})

describe('T89-⑪：全屏页发布「按背景校正过」的强调色', () => {
  beforeEach(() => {
    clearCoverColorCache()
    document.documentElement.removeAttribute('style')
  })

  it('取到背景后发布 `--fnm-fullplayer__accent-text`，且与取色背景的对比度 ≥ 4.5', async () => {
    // ⚠️ **桩掉 Image 与 canvas**：让取色拿到**真机上实测的那一个像素**
    //    ⇒ 平均色 = #d0cbc7（浅米灰）。
    class StubImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      crossOrigin: string | null = null
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0)
      }
      get src(): string {
        return ''
      }
    }
    window.Image = StubImage as unknown as typeof Image
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray([208, 203, 199, 255]) }),
    })) as unknown as HTMLCanvasElement['getContext']

    // ⚠️ **桩掉 getComputedStyle 的自定义属性读取**：
    //    jsdom 的 CSS 引擎不支持从样式表解析自定义属性 ⇒ 这里只替「读变量」这一件事。
    const realGetComputedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const style = realGetComputedStyle(el, pseudo ?? undefined)
      const original = style.getPropertyValue.bind(style)
      style.getPropertyValue = (name: string): string => {
        if (name === '--accent') return APPLE_ACCENT
        if (name === '--accent-hover') return APPLE_ACCENT_HOVER
        if (name === '--surface-sunken') return APPLE_SUNKEN
        return original(name)
      }
      return style
    })

    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { coverId: 'track_abc' }))
    const api = { list: vi.fn(async () => [] as never[]) }

    const { container } = render(<FullPlayerPage store={store} lyricApi={api as never} />)

    await waitFor(() => {
      const root = container.querySelector('[data-testid="full-player"]')
      expect(root?.getAttribute('style') ?? '').toContain('--fnm-fullplayer__tint')
    })
    // 背景取到了（平均色 = #d0cbc7）
    expect(getCachedCoverColor('track_abc')).toBe(REAL_TINT)

    await waitFor(() => {
      const root = container.querySelector('[data-testid="full-player"]')
      expect(root?.getAttribute('style') ?? '').toContain('--fnm-fullplayer__accent-text')
    })

    const style = container.querySelector('[data-testid="full-player"]')?.getAttribute('style') ?? ''
    const match = /--fnm-fullplayer__accent-text:\s*([^;]+)/.exec(style)
    const readable = match?.[1]?.trim() ?? ''
    expect(readable).not.toBe('')
    expect(contrastRatio(readable, REAL_TINT)).toBeGreaterThanOrEqual(ACCENT_TEXT_MIN_CONTRAST)

    // ⚠️ 悬停态用的是**它自己真正的背景**（`--surface-sunken`，不透明）⇒ 单独校正。
    const hoverMatch = /--fnm-fullplayer__accent-text-hover:\s*([^;]+)/.exec(style)
    const readableHover = hoverMatch?.[1]?.trim() ?? ''
    expect(readableHover).not.toBe('')
    expect(contrastRatio(readableHover, APPLE_SUNKEN)).toBeGreaterThanOrEqual(ACCENT_TEXT_MIN_CONTRAST)
  })
})

describe('T89-⑪：样式表里「当文字色用」与「当底色用」必须分开', () => {
  it('只有「文字色 / 图标色」那几处改用校正变量；「底色 + 白字」那几处**一字未动**', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(__dirname, '..', 'src', 'pages', 'full-player.css'), 'utf8')

    // ⚠️ **文字色 / 图标色** ⇒ 用校正后的变量（带回退）。
    expect(css).toMatch(
      /\.fnm-fullplayer__queue-item--current\s*\{[^}]*color:\s*var\(--fnm-fullplayer__accent-text,\s*var\(--accent\)\)/,
    )
    expect(css).toMatch(
      /\.fnm-fullplayer__button:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--fnm-fullplayer__accent-text,\s*var\(--accent\)\)/,
    )
    expect(css).toMatch(
      /\.fnm-fullplayer__button:active:not\(:disabled\)\s*\{[^}]*color:\s*var\(--fnm-fullplayer__accent-text-hover,\s*var\(--accent-hover\)\)/,
    )

    // ⚠️ **底色 + 白字** ⇒ 仍用全局 `--accent` + `--accent-text`（设计保证的那条）。
    expect(css).toMatch(/\.fnm-fullplayer__tab--active\s*\{[^}]*background:\s*var\(--accent\)/)
    expect(css).toMatch(/\.fnm-fullplayer__tab--active\s*\{[^}]*color:\s*var\(--accent-text\)/)
    expect(css).toMatch(/\.fnm-fullplayer__button--primary\s*\{[^}]*background:\s*var\(--accent\)/)
    expect(css).toMatch(/\.fnm-fullplayer__button--primary:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-hover\)/)
  })

  it('**歌词视图**里当文字色用的那三处也要用校正变量（真机实测 3.67 的主犯）', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(__dirname, '..', 'src', 'ui', 'lyrics', 'lyric-view.css'), 'utf8')

    // 整行强调色（当前行）
    expect(css).toMatch(
      /\.fnm-lyricview__line--whole\s*\{[^}]*color:\s*var\(--fnm-fullplayer__accent-text,\s*var\(--accent\)\)/,
    )
    // 已唱过的词
    expect(css).toMatch(
      /\.fnm-lyricview__word--sung\s*\{[^}]*color:\s*var\(--fnm-fullplayer__accent-text,\s*var\(--accent\)\)/,
    )
    // 卡拉OK 逐字填色（`background-clip: text` ⇒ 字形被强调色填充）
    expect(css).toMatch(/\.fnm-lyricview__word--karaoke\s*\{[^}]*var\(--fnm-fullplayer__accent-text,\s*var\(--accent\)\)/)

    // ⚠️ **顺序不变式**：`--whole` 必须排在 `--active` **之后**
    //    （两者特异性相同 ⇒ 后者胜 ⇒ `--active` 的 `--text-primary` 才会被盖掉）。
    expect(css.indexOf('.fnm-lyricview__line--active')).toBeLessThan(
      css.indexOf('.fnm-lyricview__line--whole'),
    )
  })
})
