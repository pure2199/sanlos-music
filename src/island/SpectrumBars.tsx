// ---------------------------------------------------------------------------
// 词岛两端的**频谱波形柱**（T47）
// ---------------------------------------------------------------------------
//
// ⚠️ **纯展示**：本组件不碰音频、不出网、不接触任何凭证——
//    它只把「一条 16 段的频谱」画成两排小柱子。
//
// ---------------------------------------------------------------------------
// 镜像的定义
// ---------------------------------------------------------------------------
//
// 整条频谱 = **8 段**（低频 → 高频）：
// - **左端**显示**逆序**（高频 → 低频）；
// - **右端**显示**原序**（低频 → 高频）。
//
// ⇒ 整条胶囊从左到右是「**高频 → 低频 | 低频 → 高频**」⇒ 左右**互为镜像**、
//    **永远对称**。
//
// ⚠️ **为什么左右必须同源**（真机截图教训）：若左右各显示**不同的**频段
//    （低频一半 + 高频一半），高频段的能量天然远低于低频段
//    （实测：低频柱 46%、高频柱 4%）→ **右边几乎是空的** → 整条胶囊不对称。
//    ⇒ 两端显示**同一组**频段，右组取**逆序**。
//
// ---------------------------------------------------------------------------
// 高度怎么算
// ---------------------------------------------------------------------------
//
// - 值 `0` → **4%**（留一个可见的小点，别让整排柱子「消失」）；
// - 值 `255` → **100%**（顶到头）；
// - 中间线性。
//
// ⚠️ 柱子在容器里**垂直居中**（`align-items: center`，样式在 CSS 里）
//    ⇒ 柱子从胶囊的**中线上下对称生长**（Dynamic Island 的观感）。

import { memo, type ReactElement } from 'react'

/** 柱子的最小高度百分比（值 0 时也留一个小点）。 */
export const MIN_BAR_PERCENT = 4

/** 频谱值的上限（`getByteFrequencyData` 的量纲）。 */
export const MAX_SPECTRUM_VALUE = 255

/** 频谱柱的属性。 */
export interface SpectrumBarsProps {
  /** 该侧的柱值（0–255；空数组 = 没有柱子）。 */
  values: number[]
  /** 位置（只影响类名与测试标识）。 */
  side: 'left' | 'right'
}

/**
 * 柱值 → 高度百分比。
 *
 * @param value 频谱值（0–255）。
 * @returns 高度百分比（4–100）。
 */
export function barHeightPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_BAR_PERCENT
  const clamped = Math.min(value, MAX_SPECTRUM_VALUE)
  return Math.round(MIN_BAR_PERCENT + (100 - MIN_BAR_PERCENT) * (clamped / MAX_SPECTRUM_VALUE))
}

/** 波形柱的本体（未记忆化，便于单测直接调用）。 */
function SpectrumBarsImpl(props: SpectrumBarsProps): ReactElement {
  const { values, side } = props
  return (
    <div
      className={`fnm-island__spectrum fnm-island__spectrum--${side}`}
      data-testid={`fnm-spectrum-${side}`}
      aria-hidden="true"
    >
      {values.map((value, index) => (
        <span
          key={index}
          className="fnm-island__bar"
          data-index={index}
          style={{ height: `${barHeightPercent(value)}%` }}
        />
      ))}
    </div>
  )
}

/**
 * 波形柱（**记忆化**）。
 *
 * ⚠️ **为什么要 `memo`**：词岛根组件的进度插值是 **60fps** 重渲染的，
 *    而频谱只有 **24fps** → 频谱没变的那 36 次重渲染**不该**重画柱子。
 *    ⚠️ `values` 必须是**同一个数组引用**才拦得住 → 父组件要用 `useMemo` 记住它。
 */
export const SpectrumBars = memo(SpectrumBarsImpl)
