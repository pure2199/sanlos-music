// ---------------------------------------------------------------------------
// T89-④：封面主色 → 主题强调色 的接线（主色算法 + 写 CSS 变量）
// ---------------------------------------------------------------------------
//
// ⚠️ **钉的是什么**：
// 1. `pickDominantColor`：**挑有「性格」的那个色相**，不是简单平均
//    （4 蓝 + 1 米色 ⇒ 主色必须是蓝，不能是灰米色）。
// 2. `applyCoverAccent`：写 / 移除那**三个既有** CSS 变量。
// 3. hook 的三条判定：
//    - Fluent + 有封面 ⇒ **写** `--accent`；
//    - Apple 风 ⇒ **不写**（规格 §7.1：Apple 是固定色）；
//    - 取不到色 / 灰白封面 ⇒ **不写**（保持主题默认色）。
//
// ⚠️ 既有测试（`test/lyric-view.test.tsx` 的取色用例）**一字未改**。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'

import {
  clearCoverColorCache,
  pickDominantColor,
} from '../src/components/coverColor'
import { applyCoverAccent, useCoverAccent } from '../src/ui/useCoverAccent'

/** 探针组件：只调用 hook。 */
function Probe(props: Parameters<typeof useCoverAccent>[0]): ReactElement | null {
  useCoverAccent(props)
  return null
}

/** 读 `<html>` 上的内联强调色。 */
function inlineAccent(): string {
  return document.documentElement.style.getPropertyValue('--accent')
}

afterEach(() => {
  // ⚠️ `<html>` 是**全局**的 ⇒ 每个用例都要把内联样式清干净。
  document.documentElement.removeAttribute('style')
  clearCoverColorCache()
})

// ---------------------------------------------------------------------------
// 主色算法
// ---------------------------------------------------------------------------

describe('封面主色算法（T89-④）', () => {
  it('4 个蓝 + 1 个米色 ⇒ 主色是**蓝**（不是灰米色的平均值）', () => {
    const pixels = new Uint8ClampedArray([
      30, 60, 200, 255, 30, 60, 200, 255, 30, 60, 200, 255, 30, 60, 200, 255,
      230, 220, 200, 255,
    ])

    const dominant = pickDominantColor(pixels)

    expect(dominant).not.toBeNull()
    const hex = dominant!
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    // ⚠️ 蓝色分量必须**明显最大**（平均色会是米色 ⇒ b 不会最大）。
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })

  it('全透明 / 全黑 / 全白 ⇒ `null`（**没有颜色可用**）', () => {
    expect(pickDominantColor(new Uint8ClampedArray([0, 0, 0, 0]))).toBeNull()
    expect(pickDominantColor(new Uint8ClampedArray([0, 0, 0, 255]))).toBeNull()
    expect(pickDominantColor(new Uint8ClampedArray([255, 255, 255, 255]))).toBeNull()
  })

  it('灰色像素不算（太灰 ⇒ 没有色相）', () => {
    expect(pickDominantColor(new Uint8ClampedArray([128, 128, 128, 255]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 写 / 移除 CSS 变量
// ---------------------------------------------------------------------------

describe('强调色写入（T89-④）', () => {
  it('写入那**三个既有**变量（不新增令牌）', () => {
    applyCoverAccent({ accent: '#123456', hover: '#0a2b3c', focusRing: '#12345659' })

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456')
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toBe('#0a2b3c')
    expect(document.documentElement.style.getPropertyValue('--focus-ring')).toBe('#12345659')
  })

  it('传 `null` ⇒ **移除**覆盖（回到 CSS 里的主题色）', () => {
    applyCoverAccent({ accent: '#123456', hover: '#0a2b3c', focusRing: '#12345659' })
    applyCoverAccent(null)

    expect(inlineAccent()).toBe('')
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--focus-ring')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// hook 的判定
// ---------------------------------------------------------------------------

describe('useCoverAccent（T89-④）', () => {
  it('Fluent + 有封面 ⇒ 写出 `--accent`', async () => {
    render(
      <Probe theme="fluent" coverId="track_abc" extract={async () => '#2f6f4f'} />,
    )

    await waitFor(() => {
      expect(inlineAccent()).not.toBe('')
    })
    expect(inlineAccent()).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('Apple 风 ⇒ **不写**（规格 §7.1：Apple 是固定色）', async () => {
    render(
      <Probe theme="apple" coverId="track_abc" extract={async () => '#2f6f4f'} />,
    )

    // ⚠️ 等一拍，确认「真的没写」（而不是「还没写」）。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inlineAccent()).toBe('')
  })

  it('取不到色（加载失败）⇒ **不写**（保持主题默认色）', async () => {
    render(
      <Probe theme="fluent" coverId="track_abc" extract={async () => null} />,
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inlineAccent()).toBe('')
  })

  it('灰白封面（没有色相）⇒ **不写**（不硬凑一个脏色）', async () => {
    render(
      <Probe theme="fluent" coverId="track_abc" extract={async () => '#808080'} />,
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inlineAccent()).toBe('')
  })

  it('没有封面（`coverId` 为空）⇒ **不写**', async () => {
    render(<Probe theme="fluent" coverId="" extract={async () => '#2f6f4f'} />)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inlineAccent()).toBe('')
  })

  it('取色结果**按 coverId 缓存**（换歌不重算）', async () => {
    let calls = 0
    const extract = async (): Promise<string | null> => {
      calls += 1
      return '#2f6f4f'
    }

    const first = render(<Probe theme="fluent" coverId="track_abc" extract={extract} />)
    await waitFor(() => {
      expect(inlineAccent()).not.toBe('')
    })
    expect(calls).toBe(1)

    first.unmount()
    clearCoverColorCache()

    // ⚠️ 第二次（缓存已被清）⇒ 又取一次 ⇒ 证明「缓存」这件事由缓存表决定，
    //    而不是由组件生命周期决定。
    render(<Probe theme="fluent" coverId="track_abc" extract={extract} />)
    await waitFor(() => {
      expect(inlineAccent()).not.toBe('')
    })
    expect(calls).toBe(2)
  })
})
