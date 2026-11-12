// ---------------------------------------------------------------------------
// T89-④：把封面主色转成「能当强调色」的颜色（纯函数，无 DOM ⇒ 可完整单测）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么需要「转换」这一步**：封面主色是**任意的** —— 可能是纯黄
//    （白字压上去完全看不清）、可能是近黑（当按钮底色太闷）。
//    而强调色会被当成**按钮底色**，上面的文字是 `--accent-text: #ffffff`
//    ⇒ **白字压在强调色上** ⇒ 必须满足 **WCAG AA 对比度 ≥ 4.5**。
//
// ⚠️ **优先级：对比度 > 保留原色** —— 强调色看不清，比「颜色不够准」严重得多。
//    ⇒ 对比度不够就**继续压暗**，而不是牺牲对比度去保住原色。
//
// ⚠️ **灰白封面没有色相** ⇒ 硬凑一个颜色只会得到一个「脏色」⇒ 返回 `null`
//    ⇒ 调用方保持主题默认色（比一个难看的灰强）。
//
// ⚠️ 本文件**不碰 DOM**、**不读环境** ⇒ 所有判定都能用纯函数测。
// ---------------------------------------------------------------------------

/** 一个 RGB 颜色（分量 0–255）。 */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** 一个 HSL 颜色（`h` 度 0–360，`s` / `l` 0–1）。 */
export interface Hsl {
  h: number
  s: number
  l: number
}

/** 一套「Fluent 强调色」三个值。 */
export interface FluentAccent {
  /** 强调色本身（按钮底色）。 */
  accent: string
  /** 悬停态（同色相、更暗）。 */
  hover: string
  /** 焦点环（强调色 + 透明度）。 */
  focusRing: string
}

// ---------------------------------------------------------------------------
// 判定阈值（**都是「观感」阈值，不是数学常量** ⇒ 集中在这里便于调）
// ---------------------------------------------------------------------------

/** 强调色亮度的下限（太暗 ⇒ 当按钮底色太闷）。 */
export const FLUENT_ACCENT_MIN_LIGHTNESS = 0.22

/** 强调色亮度的上限（太亮 ⇒ 白字看不清）。 */
export const FLUENT_ACCENT_MAX_LIGHTNESS = 0.55

/** 强调色饱和度的下限（太灰 ⇒ 不像强调色）。 */
export const FLUENT_ACCENT_MIN_SATURATION = 0.45

/** 强调色饱和度的上限（太艳 ⇒ 刺眼）。 */
export const FLUENT_ACCENT_MAX_SATURATION = 0.85

/** 白字压在强调色上要满足的对比度（WCAG AA = 4.5）。 */
export const FLUENT_ACCENT_MIN_CONTRAST = 4.5

/** 悬停态比常态暗多少（HSL 亮度）。 */
export const FLUENT_ACCENT_HOVER_LIGHTNESS_DELTA = 0.12

/** 焦点环的透明度（与 `tokens.css` 的 `#0067c059` 同一形态）。 */
export const FLUENT_ACCENT_FOCUS_ALPHA = 0.35

/**
 * **低于这个饱和度就认为「没有色相」**（灰白封面）⇒ 不硬凑颜色。
 *
 * ⚠️ 与 {@link FLUENT_ACCENT_MIN_SATURATION}（0.45）**不是一回事**：
 *    0.45 是「当强调色要有多艳」；这里是「到底有没有颜色可谈」。
 */
export const FLUENT_ACCENT_MIN_SATURATION_FOR_HUE = 0.15

// ---------------------------------------------------------------------------
// 解析与转换
// ---------------------------------------------------------------------------

/**
 * 解析 `#rgb` / `#rrggbb`（可带 `#` 前缀，可大写）。
 *
 * @returns 解析失败（空串 / 长度不对 / 非十六进制）⇒ `null`。
 */
export function parseHexColor(hex: string): Rgb | null {
  if (typeof hex !== 'string') return null
  const text = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]+$/.test(text)) return null
  if (text.length === 3) {
    // ⚠️ 用 `charAt`（不是 `text[0]`）⇒ 不会踩 `noUncheckedIndexedAccess`。
    const r = text.charAt(0)
    const g = text.charAt(1)
    const b = text.charAt(2)
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    }
  }
  if (text.length !== 6) return null
  return {
    r: parseInt(text.slice(0, 2), 16),
    g: parseInt(text.slice(2, 4), 16),
    b: parseInt(text.slice(4, 6), 16),
  }
}

/** RGB → HSL。 */
export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const l = (max + min) / 2

  if (delta === 0) return { h: 0, s: 0, l }

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let h: number
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/** HSL → RGB（分量取整 0–255）。 */
export function hslToRgb(hsl: Hsl): Rgb {
  const h = ((hsl.h % 360) + 360) % 360
  const s = Math.min(1, Math.max(0, hsl.s))
  const l = Math.min(1, Math.max(0, hsl.l))
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let rp = 0
  let gp = 0
  let bp = 0
  if (h < 60) {
    rp = c
    gp = x
  } else if (h < 120) {
    rp = x
    gp = c
  } else if (h < 180) {
    gp = c
    bp = x
  } else if (h < 240) {
    gp = x
    bp = c
  } else if (h < 300) {
    rp = x
    bp = c
  } else {
    rp = c
    bp = x
  }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  }
}

/** HSL → `#rrggbb`。 */
export function hslToHex(hsl: Hsl): string {
  const { r, g, b } = hslToRgb(hsl)
  const part = (v: number): string => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

// ---------------------------------------------------------------------------
// 对比度（WCAG 2.1）
// ---------------------------------------------------------------------------

/** sRGB 相对亮度（WCAG 2.1 定义）。 */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/**
 * 两个颜色之间的对比度（WCAG 2.1）。
 *
 * ⚠️ 范围 1–21（黑↔白 = 21）。
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = parseHexColor(hexA)
  const b = parseHexColor(hexB)
  if (!a || !b) return 1
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 给 hex 颜色加透明度（`#rrggbbaa`，与 `tokens.css` 的 `--focus-ring` 同一形态）。 */
export function hexWithAlpha(hex: string, alpha: number): string {
  const rgb = parseHexColor(hex)
  if (!rgb) return hex
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
  const part = (v: number): string => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}${part(a).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// 主色 → Fluent 强调色
// ---------------------------------------------------------------------------

/**
 * 把封面主色转成一套「能当强调色」的颜色。
 *
 * ⚠️ 返回 `null` 的两种情况：
 * 1. 输入不是合法 hex；
 * 2. **灰白封面（没有色相）** ⇒ 硬凑只会得到「脏色」⇒ 不如保持主题默认色。
 *
 * @param hex 封面主色（`#rrggbb`）。
 */
export function toFluentAccent(hex: string): FluentAccent | null {
  const rgb = parseHexColor(hex)
  if (!rgb) return null

  const hsl = rgbToHsl(rgb)
  // ⚠️ 没有色相 ⇒ 放弃（调用方保持主题默认色）。
  if (hsl.s < FLUENT_ACCENT_MIN_SATURATION_FOR_HUE) return null

  const h = hsl.h
  // 饱和度夹紧：太灰不像强调色；太艳刺眼。
  const s = Math.min(FLUENT_ACCENT_MAX_SATURATION, Math.max(FLUENT_ACCENT_MIN_SATURATION, hsl.s))
  // 亮度夹紧：落在 Fluent 强调色的观感区间。
  let l = Math.min(FLUENT_ACCENT_MAX_LIGHTNESS, Math.max(FLUENT_ACCENT_MIN_LIGHTNESS, hsl.l))

  // ⚠️ **对比度不够就继续压暗**（白字压在上面）。
  //    ⚠️ 步长 0.02、最多 100 步 ⇒ 最多压到 L=0.02；那时对比度必然已达标
  //    （纯黑的对比度是 21），所以这个循环一定会结束。
  for (let i = 0; i < 100 && l > 0.02; i += 1) {
    if (contrastRatio(hslToHex({ h, s, l }), '#ffffff') >= FLUENT_ACCENT_MIN_CONTRAST) break
    l -= 0.02
  }

  const accent = hslToHex({ h, s, l })
  const hover = hslToHex({
    h,
    s,
    l: Math.max(0.02, l - FLUENT_ACCENT_HOVER_LIGHTNESS_DELTA),
  })
  return {
    accent,
    hover,
    focusRing: hexWithAlpha(accent, FLUENT_ACCENT_FOCUS_ALPHA),
  }
}

// ---------------------------------------------------------------------------
// 强调色当「文字色」用：按背景校正可读性（T89-⑪）
// ---------------------------------------------------------------------------

/**
 * 强调色**当文字色**压在背景上要满足的对比度（WCAG AA = 4.5）。
 *
 * ⚠️ 与 {@link FLUENT_ACCENT_MIN_CONTRAST} **不是一回事**：
 *    那个保证的是「**白字**压在强调色上」（强调色作**底色**的场合）；
 *    这个保证的是「**强调色**压在背景上」（强调色当**文字/图标色**的场合）。
 */
export const ACCENT_TEXT_MIN_CONTRAST = 4.5

/**
 * 把强调色校正成「压在给定背景上仍然可读」的颜色。
 *
 * ⚠️ **为什么需要它**：全屏播放页的背景是封面的**平均色**，
 *    而强调色是封面的**主色** ⇒ 两者来自**同一张图**、亮度天然接近
 *    ⇒ 同一个强调色压在同一个背景上，对比度必然低（真机实测 2.94）。
 *    ⇒ 这里只**调亮度**（色相与饱和度**不变** ⇒ 仍是那张封面的颜色），
 *    直到与背景的对比度达标。
 *
 * ⚠️ **只压暗、不提亮**（真机实测后定的方向，T89-⑪）：
 *    实测「强调色当文字色」的**真实落点**与它们**真正压着的背景**是：
 *      · 歌词当前行（`.fnm-lyricview__line--whole`）⇒ 压在全屏页渐变上（实测 3.67）
 *      · 悬停的底部控制按钮图标 ⇒ 压在 `--surface-sunken` 上（实测 3.91）
 *    这两处背景**都是浅色** ⇒ 把强调色**压暗**必然提升对比度（且不会让任何一处变差）。
 *    ⚠️ 反过来「提亮」会踩两个坑：
 *      ① 强调色同时要当**底色**（上面压白字）⇒ 提亮会破坏「白字 ≥ 4.5」；
 *      ② 全屏页背景是**渐变**（取色 → `--surface`）⇒ 提亮后在**下半页的浅色**上更看不清。
 *
 * ⚠️ **为什么不能反过来改全局强调色**：
 *    全局强调色同时要当**底色**（上面压白字）⇒ 对**深色**封面来说，
 *    「浅强调色」与「白字 ≥ 4.5」互相矛盾 ⇒ 校正只能在**局部语境**里做。
 *
 * ⚠️ **压暗也达不到 4.5 怎么办 ⇒ 原样返回**：
 *    深色封面（取色背景本身就很深）时，**任何**颜色都不可能同时在渐变两端都 ≥ 4.5
 *    （两端亮度的比值 < 20.25 ⇒ 数学上不可能）⇒ 这时**保持原色**，
 *    把「深色取色背景」这个问题留给**页面背景**那一层（见台账 T89-⑪ 的遗留项），
 *    而不是把强调色改成纯黑、丢掉「这是封面主色」的语义。
 *
 * @param accentHex 强调色（`#rrggbb`）。
 * @param bgHex 背景色（`#rrggbb`）。
 * @param minContrast 目标对比度（缺省 {@link ACCENT_TEXT_MIN_CONTRAST}）。
 * @returns 校正后的颜色；**输入不合法、或压暗也达不到目标时原样返回**（不抛、不吞）。
 */
export function toReadableAccent(
  accentHex: string,
  bgHex: string,
  minContrast: number = ACCENT_TEXT_MIN_CONTRAST,
): string {
  const accent = parseHexColor(accentHex)
  const bg = parseHexColor(bgHex)
  // ⚠️ 输入不合法 ⇒ **原样返回**（调用方保留自己的回退逻辑）。
  if (!accent || !bg) return accentHex
  // 已经达标 ⇒ 一律不动（不要把「本来就可读」的颜色改掉）。
  if (contrastRatio(accentHex, bgHex) >= minContrast) return accentHex

  const hsl = rgbToHsl(accent)
  const { h, s } = hsl
  const step = 0.02
  let l = hsl.l
  // ⚠️ 步长 0.02、最多 100 步 ⇒ 最远能走到 L=0（纯黑）。
  for (let i = 0; i < 100; i += 1) {
    const next = l - step
    if (next < 0) break
    l = next
    const hex = hslToHex({ h, s, l })
    if (contrastRatio(hex, bgHex) >= minContrast) return hex
  }
  // ⚠️ 压到纯黑仍没达标 ⇒ **原样返回**（深色取色背景 ⇒ 数学上无解，见上面的说明）。
  return accentHex
}

// ---------------------------------------------------------------------------
// 全屏页背景的亮度下限（T89-⑮）
// ---------------------------------------------------------------------------

/**
 * 全屏页**取色背景**的相对亮度下限。
 *
 * ⚠️ **为什么需要它**（T89-⑬ 真机逐封面复验的结论）：
 *    全屏页的背景是封面的**平均色**，当前歌词行用**强调色当文字色**，
 *    而强调色与背景**来自同一张图** ⇒ 深色封面上那行字**基本读不出来**
 *    （43 张去重封面里 **24 张低于 AA**，最差 **1.01**）。
 *
 * ⚠️ **数学门槛**：校正只能**压暗**（见 {@link toReadableAccent}），压到**纯黑**时对比度是
 *    `(L_bg + 0.05) / 0.05` ⇒ 要达到 4.5 必须有 **`L_bg ≥ 0.175`**。
 *    而深色封面的取色背景实测只有 **0.009–0.164**
 *    ⇒ **连纯黑都不够** ⇒ 校正函数**放弃校正、原样返回** ⇒ 那行字又变回「几乎看不见」。
 *
 * ⚠️ **为什么取 0.60 而不是 0.175**：0.175 只够「纯黑达标」
 *    ⇒ 强调色会被压成**接近纯黑**（丢掉「这是封面主色」的观感）；
 *    0.60 时强调色可到 L≈0.36–0.38（与浅色封面那一例 `#0049c2` **同档**）
 *    ⇒ 两类封面的歌词行观感一致。
 *
 * ⚠️ **只作用于全屏页的背景**：全局强调色、按钮底色、其它页面**一律不动**。
 */
export const FULLPLAYER_BG_MIN_LUMINANCE = 0.6

/**
 * 把颜色**保色相、保饱和度**地提亮到「相对亮度 ≥ 下限」。
 *
 * ⚠️ **为什么是「提亮」而不是「遮罩」**：遮罩是把暗部**洗向一个固定色**
 *    （丢饱和度、还要新增 token、且「洗向什么色」需要额外决策）；
 *    提亮则是**把封面自己的颜色提亮** ⇒ 同样把背景抬到可读区间，
 *    但**色相与饱和度完整保留** ⇒ 更保色、更可测、**CSS 零改动**。
 *
 * ⚠️ **为什么用 HSL 的亮度来提亮**：要改的只是**明度**，
 *    色相（h）与饱和度（s）**一字不动** ⇒ 提亮后**仍是那张封面的颜色**。
 *
 * @param hexColor 要提亮的颜色（`#rrggbb`）。
 * @param minLuminance 目标相对亮度（缺省 {@link FULLPLAYER_BG_MIN_LUMINANCE}）。
 * @returns 提亮后的颜色；**输入不合法时原样返回**，**已经达标时不动**（幂等）。
 */
export function liftToMinLuminance(
  hexColor: string,
  minLuminance: number = FULLPLAYER_BG_MIN_LUMINANCE,
): string {
  const rgb = parseHexColor(hexColor)
  // ⚠️ 输入不合法 ⇒ **原样返回**（不抛、不吞）。
  if (!rgb) return hexColor
  // ⚠️ 已经达标 ⇒ **不动**（⇒ 幂等：再调用一次结果不变）。
  if (relativeLuminance(rgb) >= minLuminance) return hexColor

  const { h, s, l: l0 } = rgbToHsl(rgb)
  // ⚠️ 步长 0.005、最多 240 步 ⇒ 最远能走到 L=1（纯白 ⇒ 亮度 1 ⇒ 必然达标）。
  for (let i = 0; i < 240; i += 1) {
    const l = Math.min(1, l0 + (i + 1) * 0.005)
    const lifted = hslToRgb({ h, s, l })
    if (relativeLuminance(lifted) >= minLuminance) return hslToHex({ h, s, l })
  }
  return '#ffffff'
}

/**
 * CSS `linear-gradient(180deg, a, b)` 在比例 `ratio` 处的颜色（**sRGB 插值**，与浏览器一致）。
 *
 * ⚠️ **为什么要它**：全屏页背景是**渐变**（取色背景 → 主题浅底），
 *    文字压在哪一点上取决于那一行落在页面多高 ⇒ 要算「那一行真正压着的背景色」
 *    就得按**渐变插值**算，而不是拿渐变的两端去猜。
 *
 * @param fromHex 渐变起点（上端，`#rrggbb`）。
 * @param toHex 渐变终点（下端，`#rrggbb`）。
 * @param ratio 位置比例（0 = 起点，1 = 终点；**会被夹紧到 [0, 1]**）。
 */
export function lerpGradientColor(fromHex: string, toHex: string, ratio: number): string {
  const a = parseHexColor(fromHex)
  const b = parseHexColor(toHex)
  if (!a || !b) return fromHex
  const t = Math.min(1, Math.max(0, ratio))
  const part = (v: number): string =>
    Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')
  return `#${part(a.r + (b.r - a.r) * t)}${part(a.g + (b.g - a.g) * t)}${part(a.b + (b.b - a.b) * t)}`
}
