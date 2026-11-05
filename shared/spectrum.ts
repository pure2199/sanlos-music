// ---------------------------------------------------------------------------
// 频谱数据的**共享契约**（T47）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么放在 `shared/`**：主进程（`electron/ipc.ts`）与 preload
//    （`electron/preload.ts`）**都要**校验频谱载荷 → 放一份纯函数，
//    两边共用，规则不会走样（与 `shared/appInfo.ts` 的白名单同一思路）。
//
// ⚠️ 本文件**只能是纯逻辑**：不得 import Electron / Node 内置模块 / DOM 类型，
//    也不得携带任何凭证。
//
// ---------------------------------------------------------------------------
// 频谱是什么
// ---------------------------------------------------------------------------
//
// 词岛两端那两排小柱子，**不是**画出来的假动画——它是真的频谱：
// 主窗口渲染进程用 `AnalyserNode` 取当前这一曲的频谱数据，切成
// **8 段对数分布**（低频稀、高频密，符合听感），每段取区间最大值，
// 再经 IPC 送到词岛窗渲染成柱子的高度。
//
// ⚠️ **一条频谱 = 8 段**：词岛把它**左右各 8 根**画出来，右组是左组的**镜像**
//    ⇒ 整条胶囊从左到右是「高频 → 低频 | 低频 → 高频」，**左右永远对称**。
//
//    ⚠️ **为什么是 8 段而不是 16**：镜像意味着左右显示**同一组**频段
//    （真正对称的波形）→ 8 段各显示两次 = 16 根柱子。
//    ⚠️ **为什么左右必须同源**：若左右各显示**不同的**频段（低频一半 + 高频一半），
//    高频段的能量天然远低于低频段（实测：低频柱 46%、高频柱 4%）→
//    **右边几乎是空的**，整条胶囊**左右不对称**（真机截图证实）。
//
// ---------------------------------------------------------------------------

/** 频谱 bin 的个数（一条频谱 = 8 段；左右各 8 根 = 右组是左组的镜像）。 */
export const SPECTRUM_BIN_COUNT = 8

/** 频谱的最低频（Hz）。 */
export const SPECTRUM_MIN_HZ = 80

/** 频谱的最高频（Hz）。 */
export const SPECTRUM_MAX_HZ = 8000

/** 采样帧率（每秒多少帧）。 */
export const SPECTRUM_FPS = 24

/** 帧间隔（毫秒）：`1000 / 24 ≈ 41.7` → 取 42。 */
export const SPECTRUM_FRAME_MS = Math.round(1000 / SPECTRUM_FPS)

/**
 * FFT 长度（T47）。
 *
 * ⚠️ 必须是 2 的幂。`2048` → 频率 bin 数 = 1024 → 在 48kHz 下每 bin ≈ 23.4Hz
 *    → 80Hz 那一段也能分到 2 个 bin（分辨率够用）。
 */
export const SPECTRUM_FFT_SIZE = 2048

/** 频谱的平滑系数（0~1）：越大越平滑、越迟钝。 */
export const SPECTRUM_SMOOTHING = 0.7

/**
 * 采样率兜底（Hz）。
 *
 * ⚠️ 真实的 `AudioContext` 一定有 `sampleRate`；这里只是给**拿不到**的场景兜底
 *    （测试替身 / 老实现）——48000 是最常见的值。
 */
export const SPECTRUM_FALLBACK_SAMPLE_RATE = 48000

/**
 * 校验频谱载荷（**渲染进程推来的值不可信**）。
 *
 * @param value 原始值（通常来自 IPC）。
 * @returns 合法时返回长度 16 的数组（每项 0–255 的整数）；不合法返回 `null`。
 *
 * ⚠️ **不合法一律丢弃**（不抛、不截断）——主进程只转发，不修补数据。
 */
export function sanitizeSpectrumBins(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  if (value.length !== SPECTRUM_BIN_COUNT) return null
  const bins: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null
    if (item < 0 || item > 255) return null
    bins.push(Math.round(item))
  }
  return bins
}
