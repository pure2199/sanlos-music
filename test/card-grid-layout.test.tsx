// ---------------------------------------------------------------------------
// T18-2 回归：卡片虚拟网格的列定位（真机实测发现的严重布局缺陷）
//
// ---------------------------------------------------------------------------
// 缺陷
// ---------------------------------------------------------------------------
// `CardGrid` 的单元格内联样式原来写成：
//   left: `calc(${(column * 100) / columns}% / ${columns})`
// —— **列数在 JS 里除了一次，CSS 里又除了一次**，实际除以 `columns²`
// （6 列时除以 36 而不是 6）。真机表现（`release/verify/card-hit.png`）：
//   - 专辑 / 歌手 / 风格 / 歌单 / 搜索结果五个页面的卡片**全部叠在左侧 1/6 区域**；
//   - 卡片互相遮挡，标题压在一起；
//   - 后面的卡片把前面的卡片**完全挡住** → **点不中**（Playwright 报
//     `<div class="fnm-cardgrid__cell"> intercepts pointer events`）。
//
// 为什么单测之前没抓到：没有任何用例断言过单元格的 `left`；
// 而这个缺陷**只影响布局**，不产生任何 DOM 结构差异，
// 于是「单测全绿」与「真机完全错乱」可以长期并存。
//
// 本文件断言的正是**布局真值**：`left` / `width` 的百分比。
// 注意：jsdom 会把 `calc()` **求值后**再写回 `style` 属性
// （`calc(300% / 6)` → `calc(50%)`），所以这里断言的是**数值**，不是原始字符串。
//
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'

import { CardGrid } from '../src/components/Cards'

/**
 * 从单元格的 `style` 里取出 `left` 的百分比值。
 *
 * ⚠️ jsdom 会把 `calc()` **求值后**再写回 `style`，且求值结果如果是单个百分比，
 *    会**去掉 `calc()` 包裹**（`calc(150%)` → `150%`）——两种形态都要认。
 */
function leftPercent(cells: Element[], index: number): number {
  const style = cells[index]?.getAttribute('style') ?? ''
  const matched = /left:\s*(?:calc\()?([-\d.]+)%\)?/.exec(style)
  return matched?.[1] === undefined ? Number.NaN : Number(matched[1])
}

/** 从单元格的 `style` 里取出 `width` 的百分比值。 */
function widthPercent(cells: Element[], index: number): number {
  const style = cells[index]?.getAttribute('style') ?? ''
  const matched = /width:\s*(?:calc\()?([-\d.]+)%\)?/.exec(style)
  return matched?.[1] === undefined ? Number.NaN : Number(matched[1])
}

describe('CardGrid 列定位（T18-2）', () => {
  it('第 N 列落在「列号 ÷ 列数」的位置上（列数只除一次）', () => {
    const columns = 6
    const items = Array.from({ length: 6 }, (_, i) => i)
    render(
      <CardGrid
        items={items}
        keyOf={(item) => `k-${item}`}
        renderItem={(item): ReactElement => <span>卡片{item}</span>}
        columns={columns}
        rowHeight={224}
        viewportHeight={224}
        bufferRows={0}
      />,
    )

    const cells = screen.getAllByRole('listitem')
    expect(cells.length).toBe(6)

    // 正确布局：第 N 列的 left = N / columns。
    expect(leftPercent(cells, 0)).toBeCloseTo(0, 3)
    expect(leftPercent(cells, 1)).toBeCloseTo(100 / 6, 3)
    expect(leftPercent(cells, 3)).toBeCloseTo(50, 3)
    expect(leftPercent(cells, 5)).toBeCloseTo(500 / 6, 3)

    // ⚠️ 旧缺陷：列数被除了两次 → 第 3 列落到 8.33%（100 ÷ 12）而不是 50%。
    expect(leftPercent(cells, 3)).not.toBeCloseTo(100 / 12, 2)
    // 旧缺陷下所有列都挤在左侧 1/6 内；正确布局下第 5 列必须越过 80%。
    expect(leftPercent(cells, 5)).toBeGreaterThan(80)
  })

  it('列数变化时 left 随之变化（除数只出现一次）', () => {
    const items = Array.from({ length: 4 }, (_, i) => i)
    // ⚠️ 虚拟网格**只渲染可视区的行**：4 项 2 列 = 2 行 → 视口要够高，第 2 行才会渲染出来。
    const { unmount } = render(
      <CardGrid
        items={items}
        keyOf={(item) => `k-${item}`}
        renderItem={(item): ReactElement => <span>卡片{item}</span>}
        columns={4}
        rowHeight={224}
        viewportHeight={224 * 4}
        bufferRows={0}
      />,
    )
    let cells = screen.getAllByRole('listitem')
    expect(cells.length).toBe(4)
    expect(leftPercent(cells, 1)).toBeCloseTo(25, 3)
    expect(leftPercent(cells, 2)).toBeCloseTo(50, 3)
    unmount()

    render(
      <CardGrid
        items={items}
        keyOf={(item) => `k-${item}`}
        renderItem={(item): ReactElement => <span>卡片{item}</span>}
        columns={2}
        rowHeight={224}
        viewportHeight={224 * 4}
        bufferRows={0}
      />,
    )
    cells = screen.getAllByRole('listitem')
    expect(cells.length).toBe(4)
    // 2 列时：`column = index % columns` → index 3 落在**第 1 列**（不是第 3 列）。
    expect(leftPercent(cells, 1)).toBeCloseTo(50, 3)
    expect(leftPercent(cells, 3)).toBeCloseTo(50, 3)
    expect(leftPercent(cells, 2)).toBeCloseTo(0, 3)
  })

  it('width 始终是「100% ÷ 列数」，与 left 的除数保持一致', () => {
    const columns = 6
    const items = Array.from({ length: 6 }, (_, i) => i)
    render(
      <CardGrid
        items={items}
        keyOf={(item) => `k-${item}`}
        renderItem={(item): ReactElement => <span>卡片{item}</span>}
        columns={columns}
        rowHeight={224}
        viewportHeight={224}
        bufferRows={0}
      />,
    )
    const cells = screen.getAllByRole('listitem')
    for (let i = 0; i < cells.length; i += 1) {
      expect(widthPercent(cells, i)).toBeCloseTo(100 / columns, 3)
    }
  })
})
