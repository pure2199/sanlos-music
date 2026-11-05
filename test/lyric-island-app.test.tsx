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
import type { LyricOverlayMessage, LyricOverlayLine, PlayerBridge } from '../shared/playerBridge'

/** 仓库根目录（源码断言用）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 假桥：只实现词岛用到的两个订阅方法。 */
interface FakeBridge {
  bridge: PlayerBridge
  emitPointer: (inside: boolean) => void
  emitLyricState: (message: LyricOverlayMessage) => void
}

function fakeBridge(): FakeBridge {
  let pointerHandler: ((inside: boolean) => void) | null = null
  let lyricHandler: ((message: LyricOverlayMessage) => void) | null = null
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
  } as unknown as PlayerBridge
  return {
    bridge,
    emitPointer: (inside: boolean) => {
      pointerHandler?.(inside)
    },
    emitLyricState: (message: LyricOverlayMessage) => {
      lyricHandler?.(message)
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

  it('当前行仍然**逐字推进**，并带 T46 的发光钩子', async () => {
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
      expect(container.querySelector('.fnm-lyricview__word--active')?.textContent).toBe('乙行乙')
    })
    const active = container.querySelector('.fnm-lyricview__word--active')
    expect(active?.textContent).toBe('乙行乙')
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
