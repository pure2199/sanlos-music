import { rgbToHsl, hslToHex } from '../ui/accentColor'
import { coverUrl } from './coverUrl'

// ---------------------------------------------------------------------------
// T89-④：封面取色（**共享模块**）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么抽出来**：Task 15 的取色代码原本写在 `src/pages/FullPlayerPage.tsx` 里，
//    只有全屏播放页用得到。现在**主题强调色**也要用同一套取色
//    （规格 §7.1「Fluent 强调色 = 取自封面取色」）⇒ 抽成共享模块。
//
// ⚠️ **既有 import 路径不能断**：`test/lyric-view.test.tsx` 从
//    `../src/pages/FullPlayerPage` 导入 `extractCoverColor` 等 ⇒
//    `FullPlayerPage.tsx` **re-export** 这些名字 ⇒ **既有测试一字不改**。
//
// ---------------------------------------------------------------------------
// 两个算法，别混
// ---------------------------------------------------------------------------
// - `extractCoverColor`：**平均色**（Task 15 的原算法，**一字未改**）⇒
//    全屏播放页的取色背景用它。
// - `extractCoverDominantColor`：**主色**（T89-④ 新增）⇒ 主题强调色用它。
//   ⚠️ 为什么不用平均色：封面 80% 米色 + 20% 蓝 ⇒ 平均出来是**灰米色**
//      ⇒ 当强调色毫无个性。主色算法会挑出那个「有性格」的色相桶。
//
// ---------------------------------------------------------------------------
// 取色的技术前提（Task 15 真机踩出来的，别改）
// ---------------------------------------------------------------------------
// - 封面走 `fnm://` 代理，而渲染进程页面来自 `file://` / dev server → 与封面**跨源**
//   （`electron/proxy.ts` 的注释明写）→ 图片必须带 `crossOrigin = 'anonymous'`，
//   否则 canvas 被污染、`getImageData` 抛 SecurityError → **永远取不到色**。
//   代理对所有响应都带了 `access-control-allow-origin: *` → 普通 GET 不触发预检。
// - ⚠️ 这条**只针对封面图片**（要喂给 canvas 取色）；媒体元素 `<audio src="fnm://…">`
//   **不要**设 `crossOrigin`（Task 13 的要求 H）。
// - CSP（`index.html`）已放行 `fnm:`（`img-src`）→ 取色不受 CSP 阻断。

// ---------------------------------------------------------------------------
// 常量（Task 15 原样搬）
// ---------------------------------------------------------------------------

/** 取色时把封面缩到多少像素见方（越小越快）。 */
export const COVER_SAMPLE_SIZE = 8

/**
 * 取色失败后**重试**的次数上限（真机踩过的坑，2026-11-04）。
 *
 * ⚠️ 封面刚切过来时可能**还没加载好**（中继慢 / 代理首次建连）→ 第一次取色失败
 *    → 若把失败**缓存**下来，这一首歌**到重启为止都不再取色** → 背景永远是兜底色。
 * ⇒ 失败**不缓存**，并**有限次重试**。
 */
export const MAX_TINT_ATTEMPTS = 3

/** 取色失败后的重试间隔（毫秒）。 */
export const TINT_RETRY_DELAY_MS = 1500

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

/**
 * 按 `coverId` 缓存的**平均色**结果。
 *
 * ⚠️ **只缓存成功的结果**（`string`）：失败**不缓存** → 允许重试。
 */
const coverColorCache = new Map<string, string | null>()

/** 按 `coverId` 缓存的**主色**结果（同上：只缓存成功）。 */
const dominantColorCache = new Map<string, string | null>()

/**
 * 取色缓存（**按 coverId**）。
 *
 * @param coverId 封面 id。
 * @returns 已缓存的颜色；`undefined` = 从没取过（还没取或上次失败了）。
 */
export function getCachedCoverColor(coverId: string): string | null | undefined {
  return coverColorCache.get(coverId)
}

/**
 * 主色缓存（**按 coverId**）。
 *
 * @param coverId 封面 id。
 * @returns 已缓存的主色；`undefined` = 从没取过。
 */
export function getCachedDominantColor(coverId: string): string | null | undefined {
  return dominantColorCache.get(coverId)
}

/** 清空取色缓存（测试用）。⚠️ **平均色与主色两个缓存一起清**。 */
export function clearCoverColorCache(): void {
  coverColorCache.clear()
  dominantColorCache.clear()
}

/**
 * 记下一次**成功**的平均色（只缓存成功的 ⇒ 失败仍可重试）。
 */
export function setCachedCoverColor(coverId: string, color: string): void {
  coverColorCache.set(coverId, color)
}

/**
 * 记下一次**成功**的主色（只缓存成功的 ⇒ 失败仍可重试）。
 */
export function setCachedDominantColor(coverId: string, color: string): void {
  dominantColorCache.set(coverId, color)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 把 RGB 三个分量拼成十六进制颜色串。
 *
 * ⚠️ 这里**不写死任何颜色**——分量来自 canvas 取到的像素。
 */
function toHex(r: number, g: number, b: number): string {
  const part = (value: number): string =>
    Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * 取封面地址（**全项目唯一的拼装点**是 `components/coverUrl.ts`）。
 */
export function coverUrlFor(coverId: string): string | null {
  return coverUrl(coverId)
}

// ---------------------------------------------------------------------------
// 采样
// ---------------------------------------------------------------------------

/**
 * 加载封面并采样出像素（缩到 {@link COVER_SAMPLE_SIZE} 见方）。
 *
 * - **异步**：返回 Promise，**不阻塞**首屏渲染；
 * - 失败（图片加载失败 / canvas 被污染 / 取不到 2D 上下文）⇒ 解析成 `null`；
 * - ⚠️ **必须设 `crossOrigin = 'anonymous'`**（且**在设 `src` 之前**）。
 *
 * @param url 封面地址（由 `coverUrlFor()` 拼）。
 */
export function sampleCoverPixels(url: string): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null)
      return
    }
    const image = new Image()
    // ⚠️ **在设 `src` 之前**设置（顺序有意义：先设 crossOrigin，再让图片开始加载）。
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = COVER_SAMPLE_SIZE
        canvas.height = COVER_SAMPLE_SIZE
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(null)
          return
        }
        context.drawImage(image, 0, 0, COVER_SAMPLE_SIZE, COVER_SAMPLE_SIZE)
        const data = context.getImageData(0, 0, COVER_SAMPLE_SIZE, COVER_SAMPLE_SIZE).data
        if (!data || data.length < 4) {
          resolve(null)
          return
        }
        resolve(data)
      } catch {
        // canvas 被污染（`getImageData` 抛安全错误）→ 取不到色。
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = url
  })
}

// ---------------------------------------------------------------------------
// 平均色（Task 15 的原算法，**一字未改**）
// ---------------------------------------------------------------------------

/**
 * 用 canvas 绘制封面并取像素，算出一个**平均色**。
 *
 * ⚠️ 全屏播放页的取色背景用它（**既有行为与既有断言一字不变**）。
 *
 * @param url 封面地址（由 `coverUrlFor()` 拼）。
 */
export async function extractCoverColor(url: string): Promise<string | null> {
  const data = await sampleCoverPixels(url)
  if (!data) return null
  let r = 0
  let g = 0
  let b = 0
  const count = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    r += data[i] ?? 0
    g += data[i + 1] ?? 0
    b += data[i + 2] ?? 0
  }
  return toHex(r / count, g / count, b / count)
}

// ---------------------------------------------------------------------------
// 主色（T89-④）
// ---------------------------------------------------------------------------

/** 主色算法：像素的筛选阈值。 */
const DOMINANT_MIN_LIGHTNESS = 0.12
const DOMINANT_MAX_LIGHTNESS = 0.92
const DOMINANT_MIN_SATURATION = 0.18
/** 透明像素不算（封面可能有透明边）。 */
const DOMINANT_MIN_ALPHA = 128
/** 色相分桶数（每桶 30°）。 */
const DOMINANT_HUE_BUCKETS = 12

/**
 * 从采样像素里挑出**主色**。
 *
 * ⚠️ 算法：
 * 1. 逐像素转 HSL；
 * 2. **滤掉**：太暗 / 太亮 / 太灰 / 透明；
 * 3. **量化**：色相分 12 个桶；
 * 4. 取**权重最大**的桶（权重 = 饱和度 × 「亮度居中度」）；
 * 5. 该桶内按权重平均 **HSL**（不平均 RGB ⇒ 不损失饱和度）。
 *
 * @param pixels 采样出来的像素（RGBA，每像素 4 字节）。
 * @returns 主色（`#rrggbb`）；**一个可用像素都没有** ⇒ `null`。
 */
export function pickDominantColor(pixels: Uint8ClampedArray): string | null {
  const buckets = new Map<number, { h: number; s: number; l: number; weight: number }>()

  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 0) < DOMINANT_MIN_ALPHA) continue
    const hsl = rgbToHsl({
      r: pixels[i] ?? 0,
      g: pixels[i + 1] ?? 0,
      b: pixels[i + 2] ?? 0,
    })
    if (hsl.l < DOMINANT_MIN_LIGHTNESS || hsl.l > DOMINANT_MAX_LIGHTNESS) continue
    if (hsl.s < DOMINANT_MIN_SATURATION) continue

    const bucket = Math.floor(hsl.h / (360 / DOMINANT_HUE_BUCKETS)) % DOMINANT_HUE_BUCKETS
    // ⚠️ 权重：饱和度越高越有「性格」；越接近中间亮度越像主色。
    const weight = hsl.s * (1 - Math.abs(hsl.l - 0.5))
    const entry = buckets.get(bucket) ?? { h: 0, s: 0, l: 0, weight: 0 }
    entry.h += hsl.h * weight
    entry.s += hsl.s * weight
    entry.l += hsl.l * weight
    entry.weight += weight
    buckets.set(bucket, entry)
  }

  let best: { h: number; s: number; l: number; weight: number } | null = null
  for (const entry of buckets.values()) {
    if (!best || entry.weight > best.weight) best = entry
  }
  if (!best || best.weight <= 0) return null

  return hslToHex({
    h: best.h / best.weight,
    s: best.s / best.weight,
    l: best.l / best.weight,
  })
}

/**
 * 取封面的**主色**（给主题强调色用）。
 *
 * ⚠️ **失败不缓存**（与平均色同口径）⇒ 允许重试。
 *
 * @param url 封面地址（由 `coverUrlFor()` 拼）。
 */
export async function extractCoverDominantColor(url: string): Promise<string | null> {
  const data = await sampleCoverPixels(url)
  if (!data) return null
  return pickDominantColor(data)
}
