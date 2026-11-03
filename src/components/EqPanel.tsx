// ---------------------------------------------------------------------------
// 均衡器面板（Task 21）
//
// 内容：段数切换（10 / 15）、预置曲线下拉、每段增益滑块、旁路开关、复位按钮，
//       以及「预设基线 vs 手动偏移」两层数值。
//
// ---------------------------------------------------------------------------
// 数据模型（追加要求 C —— 面板显示的必须是**真在用的**那套数）
// ---------------------------------------------------------------------------
//   presetKey        当前选中的预置（'flat' / 'pop' / … / 'custom'）
//   presetBaseline   预置曲线在当前段数下的原始增益
//   manualOffset     用户手动调整的偏移（每个段）
//   effectiveGain[i] = clamp(presetBaseline[i] + manualOffset[i], -12, +12)
//
// ⚠️ 滑块调的是**手动偏移**，不是生效增益：
//    面板上「基线 / 偏移 / 实际」三行数字必须与 `playerStore.eqGains`
//    （= 真正送进滤波器的增益）**一致**——这是追加要求 C 的硬要求。
//
// ---------------------------------------------------------------------------
// 接线说明（挂载点待控制器接线）
// ---------------------------------------------------------------------------
// ⚠️ 本组件**本轮不挂进任何页面**：播放条（`PlayerBar.tsx`）与全屏播放页
//    正由 Task 15 的并行修复轮次占用，`App.tsx` 由 Task 16 的并行修复轮次占用。
//    → 挂载点待控制器接线（需要 PlayerBar 的 EQ 入口）。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在 `src/components/eq-panel.css`（组件有自己的 `.css`——仓库约定），
//    悬停 / 按下 / 焦点 / 禁用这类**伪类**只能靠样式表表达，内联 style 做不到。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。
// ---------------------------------------------------------------------------

import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactElement,
} from 'react'

import { EQ_GAIN_LIMIT, EQ_PRESETS } from '../../shared/constants'
import { EQ_CUSTOM_PRESET, eqFrequencies, type EqBandCount } from '../player/eq'
import { usePlayerStore, type PlayerStore } from '../state/playerStore'
import './eq-panel.css'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 播放器 store 的最小面（可注入，便于测试）。
 *
 * `usePlayerStore`（zustand 的 `create` 产物）与它结构兼容。
 */
export interface EqStoreLike {
  /** 取当前状态快照。 */
  getState(): PlayerStore
  /** 订阅状态变化（返回退订函数）。 */
  subscribe(listener: (state: PlayerStore, previousState: PlayerStore) => void): () => void
}

/** `EqPanel` 的属性。 */
export interface EqPanelProps {
  /** 播放器 store（可注入；缺省用全局 store）。 */
  store?: EqStoreLike
  /** 附加类名。 */
  className?: string
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 频率（Hz）→ 界面文案（`31.5` / `1k` / `16k`）。 */
export function formatEqFrequency(hz: number): string {
  if (!Number.isFinite(hz)) return '—'
  if (hz >= 1000) {
    const khz = hz / 1000
    return `${Number.isInteger(khz) ? khz : khz.toFixed(1)}k`
  }
  return String(hz)
}

/** 增益（dB）→ 界面文案（`+3.0` / `0.0` / `-4.5`）。 */
export function formatEqGain(gain: number): string {
  if (!Number.isFinite(gain)) return '0.0'
  const value = Math.round(gain * 10) / 10
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`
}

/** 订阅 store 状态。 */
function usePlayerState(store: EqStoreLike): PlayerStore {
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(() => onChange()),
    [store],
  )
  const getSnapshot = useCallback(() => store.getState(), [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/**
 * 均衡器面板。
 *
 * - 段数切换（10 / 15）：**手动偏移按频率保留**（用户的手动调整不丢）；
 * - 预置曲线下拉：显示 `EQ_PRESETS` 的**中文 label**（10 条）；
 * - 每段一个滑块（±12 dB）：调的是**手动偏移**；
 * - 旁路开关：关掉即旁路（EQ 不参与链路，音量与音色不变）；
 * - 复位按钮：平直 + 手动偏移清零（不动旁路开关）；
 * - 每段显示「基线 / 偏移 / 实际」三层数字——**「实际」就是送进滤波器的增益**。
 */
export function EqPanel(props: EqPanelProps): ReactElement {
  const { store = usePlayerStore, className } = props

  const state = usePlayerState(store)
  const { eqPresetKey, eqPresetBaseline, eqManualOffset, eqBandCount, eqEnabled, eqGains } = state

  /** 当前段数下的频点。 */
  const frequencies = useMemo(() => eqFrequencies(eqBandCount), [eqBandCount])

  /** 预置曲线（10 条，中文 label）。 */
  const presets = useMemo(() => Object.entries(EQ_PRESETS), [])

  /** 选预置。 */
  const handlePresetChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      store.getState().setEqPreset(event.target.value)
    },
    [store],
  )

  /** 切段数。 */
  const handleBandCount = useCallback(
    (count: EqBandCount) => {
      store.getState().setEqBandCount(count)
    },
    [store],
  )

  /** 拖滑块（改的是**手动偏移**）。 */
  const handleBandGain = useCallback(
    (index: number, value: string) => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return
      store.getState().setEqBandGain(index, parsed)
    },
    [store],
  )

  /** 旁路开关（`enabled` = EQ 是否参与链路）。 */
  const handleEnabledChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      store.getState().setEqEnabled(event.target.checked)
    },
    [store],
  )

  /** 复位。 */
  const handleReset = useCallback(() => {
    store.getState().resetEq()
  }, [store])

  const rootClass = className ? `fnm-eqpanel ${className}` : 'fnm-eqpanel'

  return (
    <section className={rootClass} aria-label="均衡器">
      <header className="fnm-eqpanel__header">
        {/* --- 预置曲线下拉（中文 label） --- */}
        <label className="fnm-eqpanel__field">
          <span className="fnm-eqpanel__field-label">预置</span>
          <select
            className="fnm-eqpanel__preset"
            value={eqPresetKey}
            onChange={handlePresetChange}
            aria-label="预置曲线"
          >
            {/* 「自定义」不是一个真实预置——手动改过之后才出现。 */}
            {eqPresetKey === EQ_CUSTOM_PRESET && (
              <option value={EQ_CUSTOM_PRESET}>自定义</option>
            )}
            {presets.map(([key, preset]) => (
              <option key={key} value={key}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        {/* --- 段数切换 --- */}
        <div className="fnm-eqpanel__field">
          <span className="fnm-eqpanel__field-label">段数</span>
          <div className="fnm-eqpanel__bands-toggle" role="group" aria-label="段数">
            {([10, 15] as EqBandCount[]).map((count) => (
              <button
                key={count}
                type="button"
                className={`fnm-eqpanel__band-count${
                  eqBandCount === count ? ' fnm-eqpanel__band-count--active' : ''
                }`}
                aria-pressed={eqBandCount === count}
                onClick={() => handleBandCount(count)}
              >
                {`${count} 段`}
              </button>
            ))}
          </div>
        </div>

        {/* --- 旁路开关 --- */}
        <label className="fnm-eqpanel__field fnm-eqpanel__bypass">
          <input
            type="checkbox"
            className="fnm-eqpanel__bypass-input"
            aria-label="启用 EQ"
            checked={eqEnabled}
            onChange={handleEnabledChange}
          />
          <span className="fnm-eqpanel__field-label">启用 EQ</span>
          <span className="fnm-eqpanel__hint">关闭即旁路</span>
        </label>

        {/* --- 复位 --- */}
        <button type="button" className="fnm-eqpanel__reset" onClick={handleReset}>
          复位
        </button>
      </header>

      {/* --- 各段 --- */}
      <div className="fnm-eqpanel__bands">
        {frequencies.map((frequency, index) => {
          const baseline = eqPresetBaseline[index] ?? 0
          const offset = eqManualOffset[index] ?? 0
          const effective = eqGains[index] ?? 0
          const label = formatEqFrequency(frequency)
          return (
            <div className="fnm-eqpanel__band" key={frequency}>
              <span className="fnm-eqpanel__freq">{label}</span>
              <input
                type="range"
                className="fnm-eqpanel__slider"
                min={-EQ_GAIN_LIMIT}
                max={EQ_GAIN_LIMIT}
                step={0.5}
                value={offset}
                aria-label={`${label} 增益偏移`}
                onChange={(event) => handleBandGain(index, event.target.value)}
              />
              <div className="fnm-eqpanel__values">
                <span className="fnm-eqpanel__baseline">{`基线 ${formatEqGain(baseline)}`}</span>
                <span className="fnm-eqpanel__offset">{`偏移 ${formatEqGain(offset)}`}</span>
                <span className="fnm-eqpanel__effective">{`实际 ${formatEqGain(effective)}`}</span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
