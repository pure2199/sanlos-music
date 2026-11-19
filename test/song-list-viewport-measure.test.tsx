// ---------------------------------------------------------------------------
// T109：`SongList` 的「可视区高度」在**列表初始为空**时量不到
//
// ---------------------------------------------------------------------------
// 钉的是什么
// ---------------------------------------------------------------------------
// 量高 effect 的依赖写死 `[]` ⇒ 它**只在挂载时**跑一次；而列表**初始为空**时
// 组件走**空态分支**（**根本不渲染视口节点**）⇒ 挂载那一刻拿不到节点
// ⇒ effect 第一行就 return ⇒ 既没量、也没挂 `ResizeObserver`
// ⇒ 数据后来到了、节点才挂上，但 effect **不会重跑**
// ⇒ `measuredHeight` 永远停在 0 ⇒ 一路用兜底常量 **600**
// ⇒ 虚拟窗口按 600px 算（可见 13 行），而不是真实视口（真机约 240px ⇒ 5 行）。
//
// ⇒ **DOM 行数随导航路径摇摆**（「初始就有数据」量得到 ⇒ 8 行；
//    「初始为空」用兜底 ⇒ 18 行）—— 这就是 T104 规格 §五 记的
//    「`toHaveCount` 随导航路径变红」的**根因**。
//
// ⚠ **为什么能在 jsdom 里钉**：
//    jsdom 没有布局引擎 ⇒ `getBoundingClientRect()` 恒返回 0 ⇒ 量不到高度。
//    ⇒ 我们**故意 mock** 一个高度（240px）⇒ 于是「量到了没有」这件事
//    **变成了可观察的 DOM 行数差异**（10 行 vs 18 行）。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'

import type { Song } from '../shared/types'
import {
  SongList,
  SONG_ROW_HEIGHT,
  SONG_LIST_BUFFER_ROWS,
  SONG_LIST_FALLBACK_VIEWPORT_HEIGHT,
} from '../src/components/SongList'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造一首占位歌曲（**不写真实 FN ID / 账号 / 真实歌名**）。 */
function makeSong(index: number): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
    artist: '甲',
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
    trackNo: index,
    discNo: 1,
  }
}

/** 1000 首歌（够长 ⇒ 虚拟裁剪才显形）。 */
const MANY = Array.from({ length: 1000 }, (_, index) => makeSong(index))

/**
 * 把 `getBoundingClientRect` mock 成固定高度（模拟「量得到」）。
 *
 * ⚠ jsdom 里 `getBoundingClientRect` 定义在 **`Element.prototype`** 上
 *    （不是 `HTMLElement`）⇒ 挂在 `Element.prototype` 上才拦得住。
 *
 * ⚠⚠ **只给「视口元素」高度**（其余元素仍是 0，贴近 jsdom 的真实行为）：
 *    若把**所有**元素都 mock 成 240，那么「量错了元素」（例如去量文档根）
 *    这类缺陷**量出来还是 240** ⇒ 单测就**咬不住**它
 *    （变异自证 M3 就是这样被漏掉的：它只有 E2E 层变红）。
 */
function mockMeasuredHeight(height: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const measured = this.classList?.contains('sanlos-songlist__viewport') ? height : 0
    return {
      height: measured,
      width: 1200,
      top: 0,
      left: 0,
      right: 1200,
      bottom: measured,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  })
}

/** 按「可视区高度」算出来的 DOM 行数（可见行 ＋ 下方缓冲行）。 */
function expectedRows(viewportHeight: number): number {
  return Math.ceil(viewportHeight / SONG_ROW_HEIGHT) + SONG_LIST_BUFFER_ROWS
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('SongList 的可视区量高（T109）', () => {
  it('列表**初始为空** ⇒ 数据到达后 ⇒ 按**实测**的视口高度裁剪（不是兜底 600）', () => {
    mockMeasuredHeight(240)

    // ⚠ 初始为空 ⇒ 走空态分支 ⇒ **没有视口节点**（这正是缺陷的触发条件）。
    const { container, rerender } = render(<SongList songs={[]} onPlay={vi.fn()} />)
    expect(container.querySelector('.sanlos-songlist__viewport')).toBeNull()

    // 数据到达 ⇒ 视口节点挂上。
    rerender(<SongList songs={MANY} onPlay={vi.fn()} />)

    const rows = container.querySelectorAll('[role="option"]')
    // 240px ⇒ 可见 5 行 ＋ 缓冲 5 行 = 10 行。
    expect(rows.length).toBe(expectedRows(240))
    // ⚠ 兜底 600 会是 18 行 ⇒ 这里明确排除（**缺陷态**）。
    expect(rows.length).not.toBe(expectedRows(SONG_LIST_FALLBACK_VIEWPORT_HEIGHT))
  })

  it('列表**初始就有数据** ⇒ 同样按实测的视口高度裁剪（基线：修复前后都成立）', () => {
    mockMeasuredHeight(240)

    const { container } = render(<SongList songs={MANY} onPlay={vi.fn()} />)

    const rows = container.querySelectorAll('[role="option"]')
    expect(rows.length).toBe(expectedRows(240))
    expect(rows.length).not.toBe(expectedRows(SONG_LIST_FALLBACK_VIEWPORT_HEIGHT))
  })

  it('**量不到**高度（jsdom 默认返回 0）⇒ 仍用兜底常量，不渲染零行', () => {
    // ⚠ 故意**不** mock ⇒ `getBoundingClientRect()` 返回 0 ⇒ 走兜底。
    const { container } = render(<SongList songs={MANY} onPlay={vi.fn()} />)

    const rows = container.querySelectorAll('[role="option"]')
    expect(rows.length).toBe(expectedRows(SONG_LIST_FALLBACK_VIEWPORT_HEIGHT))
    expect(rows.length).toBeGreaterThan(0)
  })

  it('初始为空 ⇒ 数据到达后：空态文案消失、状态行跟着变', () => {
    mockMeasuredHeight(240)

    const { container, rerender, getByText } = render(
      <SongList songs={[]} onPlay={vi.fn()} total={1000} />,
    )
    expect(getByText('暂无歌曲')).toBeTruthy()
    expect(getByText('已加载 0 / 1,000')).toBeTruthy()

    rerender(<SongList songs={MANY} onPlay={vi.fn()} total={1000} />)

    expect(container.textContent).not.toContain('暂无歌曲')
    expect(getByText('已加载 1,000 / 1,000')).toBeTruthy()
  })
})
