// T45：灵动态词岛的**锚定计算**（纯函数，不依赖 Electron）。
//
// ⚠️ 为什么单独抽成纯函数：词岛的位置要按「主窗口所在显示器的 workArea」算，
//    算错了就只有真机上才看得出来（而且很难复现）→ 必须有单测钉死。
//
// ⚠️ 为什么用 `workArea` 而不是 `bounds`：`bounds` 含任务栏，
//    副屏的任务栏在**左侧**时两者不同 → 用 bounds 会把词岛算偏。

import { describe, expect, it } from 'vitest'

import { islandBounds } from '../shared/islandAnchor'

describe('T45 词岛锚定计算', () => {
  it('主屏：水平居中，贴在工作区顶部', () => {
    const bounds = islandBounds(
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { width: 520, height: 72 },
    )
    // 水平：(1920 - 520) / 2 = 700
    expect(bounds).toEqual({ x: 700, y: 8, width: 520, height: 72 })
  })

  it('副屏在右边：用的是 workArea 的起点，不是屏幕 0 点', () => {
    const bounds = islandBounds(
      { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
      { width: 520, height: 72 },
    )
    // 1920 + (2560 - 520) / 2 = 1920 + 1020 = 2940
    expect(bounds.x).toBe(2940)
    expect(bounds.y).toBe(8)
  })

  it('副屏在左边（负坐标）：同样按 workArea 起点算', () => {
    const bounds = islandBounds(
      { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } },
      { width: 520, height: 72 },
    )
    // -1920 + (1920 - 520) / 2 = -1920 + 700 = -1220
    expect(bounds.x).toBe(-1220)
  })

  it('副屏在工作区上方（负 y）：顶部仍然贴着该屏的工作区上沿', () => {
    const bounds = islandBounds(
      { workArea: { x: 0, y: -1080, width: 1920, height: 1080 } },
      { width: 520, height: 72 },
      8,
    )
    expect(bounds.y).toBe(-1080 + 8)
  })

  it('边距可调：margin = 0 时紧贴工作区上沿', () => {
    const bounds = islandBounds(
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { width: 520, height: 72 },
      0,
    )
    expect(bounds.y).toBe(0)
  })

  it('窗口比工作区还宽时：贴左边，**不能**算出负的右边', () => {
    const bounds = islandBounds(
      { workArea: { x: 100, y: 0, width: 400, height: 800 } },
      { width: 520, height: 72 },
    )
    // (400 - 520) / 2 = -60 → 夹到 0 → x = 100
    expect(bounds.x).toBe(100)
  })

  it('返回的是整数坐标（Electron 的 setBounds 只收整数）', () => {
    const bounds = islandBounds(
      { workArea: { x: 0, y: 0, width: 1367, height: 700 } },
      { width: 520, height: 72 },
    )
    // (1367 - 520) / 2 = 423.5 → 取整
    expect(Number.isInteger(bounds.x)).toBe(true)
    expect(Number.isInteger(bounds.y)).toBe(true)
  })
})
