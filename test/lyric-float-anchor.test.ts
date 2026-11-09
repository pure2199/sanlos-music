// ---------------------------------------------------------------------------
// T77：桌面歌词（经典悬浮窗）的**默认落位**（纯函数）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么必须钉**：T77 起经典窗是**点穿透**的 ⇒ **不能再用鼠标拖动**
//    ⇒ 「第一次打开时落在哪儿」必须一次给对，
//    否则用户会看到一个飘在屏幕角落、**又挪不动**的歌词窗。
//
// ⚠️ **为什么是纯函数**：主进程要拿它算窗口位置，单测要拿它断言几何
//    （与 `shared/islandAnchor.ts` 同一套路）。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { lyricFloatBounds, LYRIC_FLOAT_VERTICAL_RATIO } from '../shared/lyricFloatAnchor'

/** 一块 1920×1040 的工作区（任务栏 80px）。 */
const DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }

/** 纯歌词窗口的默认尺寸。 */
const SIZE = { width: 560, height: 120 }

describe('T77 桌面歌词：默认落位', () => {
  it('水平**居中**于工作区', () => {
    const bounds = lyricFloatBounds(DISPLAY, SIZE)
    expect(bounds.x).toBe(Math.round((1920 - 560) / 2))
  })

  it('垂直**居中偏下**（不贴顶栏、也不贴任务栏）', () => {
    const bounds = lyricFloatBounds(DISPLAY, SIZE)
    expect(bounds.y).toBe(Math.round((1040 - 120) * LYRIC_FLOAT_VERTICAL_RATIO))
    // ⚠️ **鉴别力**：必须真的比正中**偏下**（否则会变成「贴在正中间」）。
    expect(bounds.y).toBeGreaterThan((1040 - 120) / 2)
  })

  it('副屏在**左边**（负坐标）也能算对', () => {
    const bounds = lyricFloatBounds(
      { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } },
      SIZE,
    )
    expect(bounds.x).toBe(-1920 + Math.round((1920 - 560) / 2))
  })

  it('工作区比窗口还窄 ⇒ **贴左边**（不能算出负数跑出屏幕）', () => {
    const bounds = lyricFloatBounds(
      { workArea: { x: 100, y: 0, width: 400, height: 800 } },
      SIZE,
    )
    expect(bounds.x).toBe(100)
  })

  it('尺寸原样带出', () => {
    const bounds = lyricFloatBounds(DISPLAY, { width: 640, height: 200 })
    expect(bounds.width).toBe(640)
    expect(bounds.height).toBe(200)
  })

  it('坐标是**整数**（Electron 的 `setBounds` 只收整数）', () => {
    const bounds = lyricFloatBounds(
      { workArea: { x: 13, y: 7, width: 1917, height: 1033 } },
      SIZE,
    )
    expect(Number.isInteger(bounds.x)).toBe(true)
    expect(Number.isInteger(bounds.y)).toBe(true)
  })
})
