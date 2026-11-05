// T46：词岛的「鼠标进入隐藏」—— **指针是否落在词岛矩形内**的判定。
//
// ⚠️ 为什么要有这个纯函数：词岛在屏幕顶部，要是不「点击穿透」，
//    最大化应用的标题栏中央就点不到 → 必须 `setIgnoreMouseEvents`。
//    而忽略鼠标事件后，渲染进程**收不到「鼠标离开」**（实测：移出后 0 个事件）
//    → 恢复只能靠主进程轮询指针位置 → 判定逻辑必须**可单测**。
//
// ⚠️ 边界：**包含**边缘（指针正好压在词岛边缘上 → 算「在岛上」）。

import { describe, expect, it } from 'vitest'

import { isPointInsideRect } from '../shared/islandAnchor'

const RECT = { x: 1020, y: 8, width: 520, height: 96 }

describe('T46 指针命中判定', () => {
  it('矩形内部 → 在岛上', () => {
    expect(isPointInsideRect({ x: 1280, y: 56 }, RECT)).toBe(true)
  })

  it('四个角（边缘）→ 算在岛上（边界含）', () => {
    expect(isPointInsideRect({ x: RECT.x, y: RECT.y }, RECT)).toBe(true)
    expect(isPointInsideRect({ x: RECT.x + RECT.width, y: RECT.y }, RECT)).toBe(true)
    expect(isPointInsideRect({ x: RECT.x, y: RECT.y + RECT.height }, RECT)).toBe(true)
    expect(isPointInsideRect({ x: RECT.x + RECT.width, y: RECT.y + RECT.height }, RECT)).toBe(true)
  })

  it('四个方向刚好在外 → 不在岛上', () => {
    expect(isPointInsideRect({ x: RECT.x - 1, y: 56 }, RECT)).toBe(false)
    expect(isPointInsideRect({ x: RECT.x + RECT.width + 1, y: 56 }, RECT)).toBe(false)
    expect(isPointInsideRect({ x: 1280, y: RECT.y - 1 }, RECT)).toBe(false)
    expect(isPointInsideRect({ x: 1280, y: RECT.y + RECT.height + 1 }, RECT)).toBe(false)
  })

  it('副屏在左边（负坐标矩形）→ 判定照常', () => {
    const left = { x: -1220, y: 8, width: 520, height: 96 }
    expect(isPointInsideRect({ x: -960, y: 56 }, left)).toBe(true)
    expect(isPointInsideRect({ x: -1221, y: 56 }, left)).toBe(false)
    expect(isPointInsideRect({ x: 0, y: 56 }, left)).toBe(false)
  })

  it('指针在屏幕最左上角 → 不在任何词岛矩形内', () => {
    expect(isPointInsideRect({ x: 0, y: 0 }, RECT)).toBe(false)
  })
})
