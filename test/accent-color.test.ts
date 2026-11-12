// ---------------------------------------------------------------------------
// T89-④：封面主色 → Fluent 强调色 的色彩数学（纯函数）
// ---------------------------------------------------------------------------
//
// ⚠️ **钉的是什么**：
// 1. hex ↔ HSL 往返；
// 2. WCAG 对比度（黑↔白 = 21；同色 = 1）；
// 3. ⚠️ **性质测试**：**任意**颜色转出来的强调色，白字压在上面的对比度
//    **必须 ≥ 4.5**（WCAG AA）—— 这是整个转换存在的理由。
// 4. 灰白封面（没有色相）⇒ 返回 `null`（不硬凑一个「脏色」）；
// 5. 非法输入（空串 / 非 hex）⇒ `null`，**不抛**。
//
// ⚠️ 本文件不碰 DOM ⇒ 全部是纯函数断言。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  FLUENT_ACCENT_MIN_CONTRAST,
  FLUENT_ACCENT_MIN_LIGHTNESS,
  FLUENT_ACCENT_MAX_LIGHTNESS,
  contrastRatio,
  hexWithAlpha,
  hslToHex,
  hslToRgb,
  parseHexColor,
  relativeLuminance,
  rgbToHsl,
  toFluentAccent,
} from '../src/ui/accentColor'

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

describe('颜色解析（T89-④）', () => {
  it('`#rrggbb` / `rrggbb` / 大写 都能解析', () => {
    expect(parseHexColor('#0a66ff')).toEqual({ r: 10, g: 102, b: 255 })
    expect(parseHexColor('0a66ff')).toEqual({ r: 10, g: 102, b: 255 })
    expect(parseHexColor('#0A66FF')).toEqual({ r: 10, g: 102, b: 255 })
  })

  it('`#rgb` 三位 shorthand 也能解析', () => {
    expect(parseHexColor('#f00')).toEqual({ r: 255, g: 0, b: 0 })
    expect(parseHexColor('#abc')).toEqual({ r: 170, g: 187, b: 204 })
  })

  it('非法输入 ⇒ `null`（**不抛**）', () => {
    expect(parseHexColor('')).toBeNull()
    expect(parseHexColor('#')).toBeNull()
    expect(parseHexColor('#12345')).toBeNull()
    expect(parseHexColor('#1234567')).toBeNull()
    expect(parseHexColor('#gggggg')).toBeNull()
    expect(parseHexColor('rgb(1,2,3)')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// HSL 往返
// ---------------------------------------------------------------------------

describe('RGB ↔ HSL（T89-④）', () => {
  it('往返不丢信息（抽样一批颜色）', () => {
    const samples = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#0a66ff', '#8b4513']
    for (const hex of samples) {
      const rgb = parseHexColor(hex)!
      const hsl = rgbToHsl(rgb)
      const back = hslToRgb(hsl)
      expect(back).toEqual(rgb)
    }
  })

  it('灰色的饱和度 = 0（**没有色相**）', () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128 }).s).toBe(0)
    expect(rgbToHsl({ r: 0, g: 0, b: 0 }).s).toBe(0)
  })

  it('`hslToHex` 输出 `#rrggbb`', () => {
    expect(hslToHex({ h: 0, s: 1, l: 0.5 })).toBe('#ff0000')
    expect(hslToHex({ h: 120, s: 1, l: 0.5 })).toBe('#00ff00')
  })
})

// ---------------------------------------------------------------------------
// 对比度
// ---------------------------------------------------------------------------

describe('WCAG 对比度（T89-④）', () => {
  it('黑 ↔ 白 = 21（同色 = 1）', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#0a66ff', '#0a66ff')).toBeCloseTo(1, 5)
  })

  it('相对亮度：白 = 1，黑 = 0', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6)
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6)
  })

  it('`hexWithAlpha` 输出 8 位 hex（与 `tokens.css` 的 `--focus-ring` 同一形态）', () => {
    expect(hexWithAlpha('#0067c0', 0.35)).toBe('#0067c059')
    expect(hexWithAlpha('#0067c0', 1)).toBe('#0067c0ff')
  })
})

// ---------------------------------------------------------------------------
// 主色 → 强调色
// ---------------------------------------------------------------------------

describe('toFluentAccent（T89-④）', () => {
  it('非法输入 ⇒ `null`（**不抛**）', () => {
    expect(toFluentAccent('')).toBeNull()
    expect(toFluentAccent('not-a-color')).toBeNull()
    expect(toFluentAccent('#12345')).toBeNull()
  })

  it('灰白封面（**没有色相**）⇒ `null`（不硬凑一个脏色）', () => {
    expect(toFluentAccent('#808080')).toBeNull()
    expect(toFluentAccent('#ffffff')).toBeNull()
    expect(toFluentAccent('#000000')).toBeNull()
    expect(toFluentAccent('#f5f5f5')).toBeNull()
  })

  it('有色相 ⇒ 给出 accent / hover / focusRing 三个值', () => {
    const accent = toFluentAccent('#2f6f4f')
    expect(accent).not.toBeNull()
    expect(accent!.accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(accent!.hover).toMatch(/^#[0-9a-f]{6}$/)
    expect(accent!.focusRing).toMatch(/^#[0-9a-f]{8}$/)
  })

  it('⚠️ **性质测试**：任意颜色转出来的强调色，白字压在上面的对比度**必须 ≥ 4.5**', () => {
    // 扫一大片颜色空间（每个色相 × 若干饱和度 × 若干亮度）。
    let checked = 0
    for (let h = 0; h < 360; h += 15) {
      for (const s of [0.15, 0.3, 0.5, 0.7, 0.9, 1]) {
        for (const l of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
          const hex = hslToHex({ h, s, l })
          const accent = toFluentAccent(hex)
          if (!accent) continue
          checked += 1
          expect(contrastRatio(accent.accent, '#ffffff')).toBeGreaterThanOrEqual(
            FLUENT_ACCENT_MIN_CONTRAST,
          )
        }
      }
    }
    // ⚠️ 扫描必须**真的覆盖到了一批颜色**（否则这条断言是空的）。
    expect(checked).toBeGreaterThan(100)
  })

  it('亮度落在 Fluent 的观感区间内（压暗到对比度达标后仍不越界）', () => {
    for (const hex of ['#2f6f4f', '#ffd700', '#00bfff', '#8a2be2', '#ff4500']) {
      const accent = toFluentAccent(hex)
      if (!accent) continue
      const l = rgbToHsl(parseHexColor(accent.accent)!).l
      expect(l).toBeGreaterThanOrEqual(FLUENT_ACCENT_MIN_LIGHTNESS - 0.05)
      expect(l).toBeLessThanOrEqual(FLUENT_ACCENT_MAX_LIGHTNESS + 0.001)
    }
  })

  it('悬停态比常态**更暗**（同色相）', () => {
    const accent = toFluentAccent('#2f6f4f')!
    const normal = rgbToHsl(parseHexColor(accent.accent)!)
    const hover = rgbToHsl(parseHexColor(accent.hover)!)
    expect(hover.l).toBeLessThan(normal.l)
    // ⚠️ 同色相（不是另一个颜色）。
    expect(Math.abs(hover.h - normal.h)).toBeLessThan(2)
  })

  it('纯黄封面 ⇒ 被**压暗**到白字能看清（不是直接拿纯黄当强调色）', () => {
    const accent = toFluentAccent('#ffd700')!
    expect(accent.accent).not.toBe('#ffd700')
    expect(contrastRatio(accent.accent, '#ffffff')).toBeGreaterThanOrEqual(
      FLUENT_ACCENT_MIN_CONTRAST,
    )
  })
})
