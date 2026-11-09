// T46：灵动态词岛的根组件 —— 「指针进入 → 淡出 / 离开 → 淡回」。
//
// ⚠️ **为什么这条链路必须能测**：词岛是**点击穿透**的（`setIgnoreMouseEvents`）
//    → 忽略鼠标事件后渲染进程**收不到「鼠标离开」**（实测：移出后 0 个事件）
//    → 「移出后恢复显示」完全靠**主进程轮询**指针位置、经 `onLyricPointer`
//    通知到这里。⇒ 这条链路一旦断了，词岛就**永远淡出不再回来**。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IslandApp } from '../src/island/IslandApp'
import { barHeightPercent } from '../src/island/SpectrumBars'
import type { LyricOverlayMessage, LyricOverlayLine, PlayerBridge } from '../shared/playerBridge'

/** 仓库根目录（源码断言用）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 假桥：只实现词岛用到的几个订阅方法。 */
interface FakeBridge {
  bridge: PlayerBridge
  emitPointer: (inside: boolean) => void
  emitLyricState: (message: LyricOverlayMessage) => void
  emitSpectrum: (bins: number[]) => void
}

function fakeBridge(): FakeBridge {
  let pointerHandler: ((inside: boolean) => void) | null = null
  let lyricHandler: ((message: LyricOverlayMessage) => void) | null = null
  let spectrumHandler: ((bins: number[]) => void) | null = null
  const bridge = {
    onLyricState: (handler: (message: LyricOverlayMessage) => void) => {
      lyricHandler = handler
      return () => {
        lyricHandler = null
      }
    },
    onLyricPointer: (handler: (inside: boolean) => void) => {
      pointerHandler = handler
      return () => {
        pointerHandler = null
      }
    },
    // ⚠️ T47：频谱 —— 词岛只**收**，不推。
    onSpectrum: (handler: (bins: number[]) => void) => {
      spectrumHandler = handler
      return () => {
        spectrumHandler = null
      }
    },
  } as unknown as PlayerBridge
  return {
    bridge,
    emitPointer: (inside: boolean) => {
      pointerHandler?.(inside)
    },
    emitLyricState: (message: LyricOverlayMessage) => {
      lyricHandler?.(message)
    },
    emitSpectrum: (bins: number[]) => {
      spectrumHandler?.(bins)
    },
  }
}

afterEach(() => {
  delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  vi.restoreAllMocks()
})

describe('T46 词岛：鼠标进入隐藏', () => {
  it('指针进入 → 根元素进入「淡出」态', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    render(<IslandApp />)
    const root = screen.getByTestId('fnm-island')
    expect(root.className).not.toMatch(/fnm-island--pointer-inside/)

    act(() => {
      fake.emitPointer(true)
    })

    expect(root.className).toMatch(/fnm-island--pointer-inside/)
    expect(root.getAttribute('data-pointer-inside')).toBe('true')
  })

  it('指针离开 → 恢复显示', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    render(<IslandApp />)
    const root = screen.getByTestId('fnm-island')

    act(() => {
      fake.emitPointer(true)
    })
    expect(root.className).toMatch(/fnm-island--pointer-inside/)

    act(() => {
      fake.emitPointer(false)
    })
    expect(root.className).not.toMatch(/fnm-island--pointer-inside/)
    expect(root.getAttribute('data-pointer-inside')).toBe('false')
  })

  it('没有桥（浏览器预览 / 单测）→ 不崩，也不进入淡出态', () => {
    render(<IslandApp />)
    const root = screen.getByTestId('fnm-island')
    expect(root.getAttribute('data-pointer-inside')).toBe('false')
  })

  it('主进程必须给词岛开「点击穿透」（否则它挡住屏幕顶部的应用）', () => {
    // ⚠️ 源码断言（护栏）：这行配置一旦被静默删掉，词岛就会**吃掉**鼠标事件
    //    → 最大化应用的标题栏中央点不到 → 而这种回归**没有任何运行时症状**
    //    能暴露（窗口照常显示、歌词照常滚）。
    const source = readFileSync(resolve(REPO_ROOT, 'electron/main.ts'), 'utf8')
    expect(source).toMatch(/setIgnoreMouseEvents\(true, \{ forward: true \}\)/)
  })

  it('主进程必须轮询指针位置并通知词岛（否则移出后**永远淡出**不回来）', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'electron/main.ts'), 'utf8')
    expect(source).toMatch(/getCursorScreenPoint\(\)/)
    expect(source).toMatch(/send\('lyric:pointer', inside\)/)
  })
})

// ---------------------------------------------------------------------------
// T46 补丁：词岛的歌词**只显示当前一行**
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么是「一行」**：词岛是**贴在屏幕顶部**的一条窄胶囊（96px 高）→
//    双行歌词会把整条胶囊撑满、当前词被挤到中间，扫一眼看不清「正在唱哪个词」。
//    一行 = 当前行**放大居中**（这正是 Lyricify「灵动歌词」的观感）。
//
// ⚠️ **实现路径**：`mode="single"` + `windowRadius={0}`。
//    - `single` 本身是**窗口裁剪**（默认半径 3 → 渲染 7 行），半径压到 **0** 才是真·一行；
//    - `single` 的当前行**照常逐字推进**（`progress: isActive ? computeLineProgress(...) : null`）
//      → T46 的**逐字发光**不受影响；
//    - 经典悬浮窗**不动**（仍 `double`）→ 主界面 / 歌词舞台行为一字不变。
// ---------------------------------------------------------------------------

/** 三行歌词（逐字用**绝对**时间，与 LRC 一致）。 */
const THREE_LINES: LyricOverlayLine[] = [
  { time: 0, text: '甲行甲', translation: '', words: [{ text: '甲行甲', start: 0, end: 10 }] },
  { time: 10, text: '乙行乙', translation: '', words: [{ text: '乙行乙', start: 10, end: 20 }] },
  { time: 20, text: '丙行丙', translation: '', words: [{ text: '丙行丙', start: 20, end: 30 }] },
]

/** 词岛里渲染出来的歌词行（`.fnm-lyricview` 里的 `[data-index]`）。 */
function islandLyricLines(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('.fnm-lyricview__line'))
}

/**
 * 当前行的文本（**只取底层文本**）。
 *
 * ⚠️ 逐字着色层（`.fnm-lyricview__overlay`，`aria-hidden`）会把同一行文字**再渲染一遍**
 *    → `getByText` 会**同时命中两处** → 「found multiple elements」。
 *    → 这里改成直接读**行节点**的 `data-index` 与 `textContent`（断言更精确）。
 */
function currentLine(container: HTMLElement): Element | null {
  return container.querySelector('.fnm-lyricview__line')
}

describe('T46 补丁：词岛歌词只显示当前一行', () => {
  it('只渲染**一行**歌词（不是双行、也不是窗口裁剪的一堆行）', async () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手' },
        lines: THREE_LINES,
      })
      fake.emitLyricState({ kind: 'progress', position: 15, isPlaying: false })
    })

    // ⚠️ 等待条件就是**目标状态本身**（位置传播到 15 秒 → 当前行是第二行）：
    //    只等「有一行」会抢跑（位置还没传播时也已经有行了）。
    await waitFor(() => {
      expect(currentLine(container)?.getAttribute('data-index')).toBe('1')
    })
    expect(islandLyricLines(container)).toHaveLength(1)
  })

  it('那一行就是**播放位置所在行**', async () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手' },
        lines: THREE_LINES,
      })
      fake.emitLyricState({ kind: 'progress', position: 15, isPlaying: false })
    })

    await waitFor(() => {
      expect(currentLine(container)?.getAttribute('data-index')).toBe('1')
    })
    // 三行歌词（甲/乙/丙）里，15 秒落在**第二行**（行时间 10~20）。
    expect(currentLine(container)?.getAttribute('data-index')).toBe('1')
    expect(currentLine(container)?.textContent).toContain('乙行乙')
    expect(currentLine(container)?.textContent).not.toContain('甲行甲')
    expect(currentLine(container)?.textContent).not.toContain('丙行丙')
  })

  it('当前行仍然**逐字推进**，并带 T48 的**卡拉OK 填色**', async () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手' },
        lines: THREE_LINES,
      })
      fake.emitLyricState({ kind: 'progress', position: 15, isPlaying: false })
    })

    // ⚠️ **等待条件就是目标状态本身**（当前词 = 「乙行乙」）：
    //    位置还没传播到 15 秒时，**上一行**的「甲行甲」就已经带着 `--karaoke`
    //    （词内比例 0%）了 → 只等「有一个 `--karaoke`」会**抢跑**。
    await waitFor(() => {
      expect(container.querySelector('.fnm-lyricview__word--karaoke')?.textContent).toBe('乙行乙')
    })
    const karaoke = container.querySelector('.fnm-lyricview__word--karaoke')
    expect(karaoke?.textContent).toBe('乙行乙')
    // ⚠️ 当前词**不许**再整词上色：整词已是强调色 → 词内填色就看不见了。
    expect(karaoke?.className).not.toContain('fnm-lyricview__word--sung')
    // ⚠️ 词「乙行乙」占 10~20s → t=15 → 词内比例正好 **50%**。
    expect(karaoke?.getAttribute('data-karaoke-progress')).toBe('50.0')
  })

  it('**伪逐字**（只有行级时间戳）⇒ **不假装逐字**：词岛也没有卡拉OK 填色（T81）', async () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手' },
        // ⚠️ `wordTimed: false` = 「这行的词级时间是插值编造的」⇒ 不走卡拉OK。
        lines: THREE_LINES.map((line) => ({ ...line, wordTimed: false })),
      })
      fake.emitLyricState({ kind: 'progress', position: 15, isPlaying: false })
    })

    await waitFor(() => {
      expect(currentLine(container)?.getAttribute('data-index')).toBe('1')
    })
    // ⚠️ 鉴别力：**零**词级元素 ⇒ 词岛也不会假装逐字（假扫光不可能出现）。
    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
    // ⚠️ 当前行**整行**是强调色（不假装逐字）。
    expect(currentLine(container)?.className).toContain('fnm-lyricview__line--whole')
  })

  it('词岛**不再**用整词发光（T46 的旧机制，已被卡拉OK 取代）', async () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手' },
        lines: THREE_LINES,
      })
      fake.emitLyricState({ kind: 'progress', position: 15, isPlaying: false })
    })

    await waitFor(() => {
      expect(currentLine(container)?.getAttribute('data-index')).toBe('1')
    })
    // ⚠️ **整词发光与填色不能共存**：光晕会把填色的边界糊掉 → 看到的还是一条模糊亮边。
    expect(container.querySelector('.fnm-lyricview__word--active')).toBeNull()
  })

  it('播放位置跨行 → 显示的行跟着换（仍只一行）', async () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    act(() => {
      fake.emitLyricState({
        kind: 'track',
        track: { id: 't1', title: '歌名', artist: '歌手' },
        lines: THREE_LINES,
      })
      fake.emitLyricState({ kind: 'progress', position: 15, isPlaying: false })
    })
    await waitFor(() => {
      expect(currentLine(container)?.getAttribute('data-index')).toBe('1')
    })

    act(() => {
      fake.emitLyricState({ kind: 'progress', position: 25, isPlaying: false })
    })

    await waitFor(() => {
      expect(currentLine(container)?.getAttribute('data-index')).toBe('2')
    })
    expect(islandLyricLines(container)).toHaveLength(1)
    expect(currentLine(container)?.textContent).toContain('丙行丙')
    expect(currentLine(container)?.textContent).not.toContain('乙行乙')
  })
})

// ---------------------------------------------------------------------------
// T47：词岛两端的**频谱波形柱**
// ---------------------------------------------------------------------------
//
// ⚠️ **T76：左端已换成专辑封面**（用户指令：「灵动歌词的左边音效动画换成专辑封面」）
//    ⇒ 频谱柱**只剩右端**一组；下面这些断言的前提被显式推翻 ⇒ **改写**（不删），
//    改写后仍保留鉴别力（谁把左端柱子加回来，谁就红）。
//
// ⚠️ 镜像的定义（T47 老规矩，**右端仍然成立**）：整条频谱 = 16 段（低频 → 高频），
//    右端显示**原序**（低频 → 高频）。
// ---------------------------------------------------------------------------

/** 词岛里的某一侧波形柱（`.fnm-island__spectrum--<side>` 里的 `.fnm-island__bar`）。 */
function barsOf(container: HTMLElement, side: 'left' | 'right'): Element[] {
  return Array.from(container.querySelectorAll(`.fnm-island__spectrum--${side} .fnm-island__bar`))
}

/** 柱子的高度（百分比，去掉 % 号）。 */
function heightsOf(container: HTMLElement, side: 'left' | 'right'): number[] {
  return barsOf(container, side).map((bar) => Number.parseFloat(bar.getAttribute('style')?.match(/height:\s*([\d.]+)%/)?.[1] ?? '0'))
}

describe('T47 词岛：两端的频谱波形柱（T76：左端换成封面，只剩右端）', () => {
  it('**右端**仍是 8 根柱子；**左端**不再是频谱柱（换成专辑封面）', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)

    expect(barsOf(container, 'right')).toHaveLength(8)
    // ⚠️ T76：左端**没有**频谱柱了（它的位置现在是封面）。
    expect(barsOf(container, 'left')).toHaveLength(0)
    expect(container.querySelector('.fnm-island__spectrum--left')).toBeNull()
  })

  it('还没收到频谱 → **右端**柱子是最小高度（**留一个小点**，不是空白）', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)

    expect(heightsOf(container, 'right').every((h) => h === 4)).toBe(true)
  })

  it('收到频谱 → **右端**柱子高度跟着变（DOM 顺序 = **原序**：低频 → 高频）', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    // 8 段，值各不相同 → 高度各不相同 → 顺序能被认出来。
    const bins = [10, 20, 30, 40, 50, 60, 70, 80]

    act(() => {
      fake.emitSpectrum(bins)
    })

    // 右端：DOM 顺序 = 原序（低频 → 高频）。
    expect(heightsOf(container, 'right')).toEqual(bins.map(barHeightPercent))
    // ⚠️ T76：左端**不再**显示任何频段（只剩右端有柱）。
    expect(heightsOf(container, 'left')).toEqual([])
  })

  it('左端**彻底不显示**频段（频谱柱只剩右端一组）', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    const { container } = render(<IslandApp />)
    const bins = [10, 20, 30, 40, 50, 60, 70, 80]

    act(() => {
      fake.emitSpectrum(bins)
    })

    // ⚠️ **鉴别力**：左端一根柱都没有，且整个胶囊里**只有一组**频谱柱。
    //    若有人把左端柱子加回来（哪怕只有一根），这个断言**必红**。
    expect(container.querySelectorAll('.fnm-island__spectrum')).toHaveLength(1)
    expect(barsOf(container, 'left')).toHaveLength(0)
  })

  it('柱高映射：`0` → 4%、`255` → 100%（中间线性）', () => {
    expect(barHeightPercent(0)).toBe(4)
    expect(barHeightPercent(255)).toBe(100)
    expect(barHeightPercent(128)).toBe(52)
    // 越界不许越界（负数按 0 算、超 255 按 255 算）。
    expect(barHeightPercent(-10)).toBe(4)
    expect(barHeightPercent(999)).toBe(100)
  })

  it('经典悬浮窗**不显示**频谱柱（它的显示内容一字不变）', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src', 'lyric', 'main.tsx'), 'utf8')
    // ⚠️ 经典窗**不订阅** `onSpectrum` → 它拿不到频谱 → 显示内容一字不变。
    expect(source).not.toMatch(/onSpectrum/)
    expect(source).not.toMatch(/fnm-island__spectrum/)
  })
})
