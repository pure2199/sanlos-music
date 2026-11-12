// ---------------------------------------------------------------------------
// T89-⑮：全屏页取色背景的「亮度下限」（深色封面 ⇒ 当前歌词行读不出来）
// ---------------------------------------------------------------------------
//
// ⚠️ **背景**：T89-⑬ 真机逐封面复验发现 —— 全屏页背景是封面**平均色**，
//    当前歌词行用**强调色当文字色**，而强调色与背景**来自同一张图**
//    ⇒ 43 张去重封面里 **24 张低于 AA**（最差 1.01）⇒ 基本读不出来。
//
// ⚠️ **根因（两道门槛）**：
//    ① 校正只能**压暗** ⇒ 压到纯黑时对比度是 `(L_bg + 0.05) / 0.05`
//       ⇒ 要 4.5 就得 **`L_bg ≥ 0.175`**；而深色封面的取色背景实测只有 0.009–0.164
//       ⇒ **连纯黑都不够** ⇒ 校正函数放弃、原样返回；
//    ② 歌词行随播放滚动 ⇒ 背景明暗跨度太大 ⇒ 单靠调颜色解决不了。
//    ⇒ 修法：**把取色背景保色相地提亮到亮度下限**（T89-⑮，用户拍板下限 0.60）。
//
// ⚠️ **数据来源**：下面的样本是 T89-⑬ 真机扫描（release/verify/t89-13-artifacts/，
//    gitignored ⇒ **不能**在 CI 上直接读）⇒ 这里**内联真实取值**作为回归样本。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  FULLPLAYER_BG_MIN_LUMINANCE,
  contrastRatio,
  lerpGradientColor,
  liftToMinLuminance,
  parseHexColor,
  relativeLuminance,
  rgbToHsl,
} from '../src/ui/accentColor'

/** 生产代码里「算不算有颜色」的同一道门槛（低于它 ⇒ 色相无意义）。 */
const HUE_MIN_SATURATION = 0.15

/**
 * T89-⑬ 真机扫描里**最暗的 12 张取色背景**（去重后 43 张不同的图中按亮度排序）。
 * ⚠️ 每一条都对应一个真实封面 ⇒ 提亮后必须仍然达标。
 */
const DARK_SAMPLES: ReadonlyArray<{ tint: string; title: string; artist: string }> = [
  { tint: '#0e191e', title: 'Time', artist: 'DJ of Time' },
  { tint: '#241614', title: 'Shadows', artist: 'Shadows' },
  { tint: '#201a1b', title: '16', artist: 'bloomcr4zy / 16' },
  { tint: '#1d1c1c', title: '裂缝中的阳光', artist: '林俊杰' },
  { tint: '#301e0f', title: '9', artist: 'SSSmoke / 9' },
  { tint: '#1d1863', title: '28', artist: '28' },
  { tint: '#442022', title: 'Gunfire', artist: 'Gunfire' },
  { tint: '#4a2222', title: '16', artist: '16' },
  { tint: '#3a3b42', title: 'Intermission', artist: 'Intermission Banda' },
  { tint: '#323f4c', title: 'Time', artist: 'Time / Azar_s' },
  { tint: '#404040', title: '4', artist: 'B 4' },
  { tint: '#374447', title: '身为风帆', artist: '林俊杰' },
]

/**
 * T89-⑬ 真机扫描里**最亮的 4 张取色背景** ⇒ 亮度已高于下限 ⇒ **必须一字不动**
 * （浅色封面的观感**零变化**是本改动的硬约束）。
 */
const BRIGHT_SAMPLES: ReadonlyArray<{ tint: string; title: string }> = [
  { tint: '#d0cbc7', title: '问情 — 于春洋' },
  { tint: '#ededed', title: 'No Friends — No Friends' },
  { tint: '#f4ece8', title: '浪花季节 — 李克勤' },
  { tint: '#f0f3ef', title: '今生最爱 — 小梁的（梁思琪）' },
]

describe('T89-⑮：liftToMinLuminance（把取色背景保色相地提亮到亮度下限）', () => {
  it('输入不合法 ⇒ **原样返回**（不抛、不吞）', () => {
    expect(liftToMinLuminance('不是颜色')).toBe('不是颜色')
    expect(liftToMinLuminance('')).toBe('')
  })

  it('已经达标 ⇒ **一字不动**', () => {
    expect(liftToMinLuminance('#ffffff')).toBe('#ffffff')
    expect(liftToMinLuminance('#d0cbc7')).toBe('#d0cbc7')
  })

  it('**幂等**：提亮后再提一次 ⇒ 结果不变', () => {
    const once = liftToMinLuminance('#0e191e')
    expect(liftToMinLuminance(once)).toBe(once)
  })

  it('提亮后**相对亮度达到下限**', () => {
    const lifted = liftToMinLuminance('#0e191e')
    expect(relativeLuminance(parseHexColor(lifted)!)).toBeGreaterThanOrEqual(
      FULLPLAYER_BG_MIN_LUMINANCE,
    )
  })

  it('**色相与饱和度不变**（只是变亮 ⇒ 仍是那张封面的颜色）', () => {
    for (const { tint } of DARK_SAMPLES) {
      const before = rgbToHsl(parseHexColor(tint)!)
      // ⚠️ 灰白封面（饱和度太低）**没有色相可言** ⇒ 只断言饱和度那一半。
      if (before.s < HUE_MIN_SATURATION) continue
      const after = rgbToHsl(parseHexColor(liftToMinLuminance(tint))!)
      expect(Math.abs(after.h - before.h), `色相 ${tint}`).toBeLessThan(1.5)
      expect(Math.abs(after.s - before.s), `饱和度 ${tint}`).toBeLessThan(0.03)
    }
  })

  it('**亮度只增不减**', () => {
    for (const { tint } of DARK_SAMPLES) {
      const before = rgbToHsl(parseHexColor(tint)!)
      const after = rgbToHsl(parseHexColor(liftToMinLuminance(tint))!)
      expect(after.l, `亮度 ${tint}`).toBeGreaterThan(before.l)
    }
  })

  it('真实最差样本（12 张）⇒ 提亮后**全部达到下限**', () => {
    for (const { tint, title, artist } of DARK_SAMPLES) {
      const lifted = liftToMinLuminance(tint)
      expect(
        relativeLuminance(parseHexColor(lifted)!),
        `${title} — ${artist}（${tint}）`,
      ).toBeGreaterThanOrEqual(FULLPLAYER_BG_MIN_LUMINANCE)
    }
  })

  it('**最亮的 4 张完全不变**（浅色封面观感零变化）', () => {
    for (const { tint, title } of BRIGHT_SAMPLES) {
      expect(liftToMinLuminance(tint), title).toBe(tint)
    }
  })

  it('提亮后 ⇒ **纯黑也终于够得到 4.5**（这正是「连纯黑都不够」那道门槛）', () => {
    // ⚠️ 门槛：`(L_bg + 0.05) / 0.05 ≥ 4.5` ⇒ `L_bg ≥ 0.175`。
    for (const { tint, title } of DARK_SAMPLES) {
      const lifted = liftToMinLuminance(tint)
      expect(contrastRatio('#000000', lifted), title).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('T89-⑮：lerpGradientColor（CSS 渐变的 sRGB 插值）', () => {
  it('两端**精确**（ratio 0 / 1）', () => {
    expect(lerpGradientColor('#000000', '#ffffff', 0)).toBe('#000000')
    expect(lerpGradientColor('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('中点 = 两端逐分量取平均', () => {
    expect(lerpGradientColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(lerpGradientColor('#d0cbc7', '#f2f2f7', 0.5)).toBe('#e1dfdf')
  })

  it('ratio **夹紧**到 [0, 1]', () => {
    expect(lerpGradientColor('#000000', '#ffffff', -5)).toBe('#000000')
    expect(lerpGradientColor('#000000', '#ffffff', 5)).toBe('#ffffff')
  })

  it('输入不合法 ⇒ **原样返回**起点（不抛）', () => {
    expect(lerpGradientColor('不是颜色', '#ffffff', 0.5)).toBe('不是颜色')
    expect(lerpGradientColor('#000000', '也不是颜色', 0.5)).toBe('#000000')
  })
})
