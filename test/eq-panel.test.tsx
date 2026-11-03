// ---------------------------------------------------------------------------
// Task 21：均衡器面板（EqPanel）
//
// 覆盖控制器追加要求 G：
// - 段数切换（10 / 15）、10 条预置曲线下拉（**中文 label**）、每段滑块（±12 dB）、
//   旁路开关、复位按钮；
// - **「预设基线 vs 手动偏移」两层数值**必须与真正送进滤波器的增益一致
//   （面板显示 = `playerStore.eqGains`）。
//
// ⚠️ 全部数据都是**虚构占位**，不含任何真实 FN ID / 账号 / 密码。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { EqPanel, formatEqFrequency, formatEqGain } from '../src/components/EqPanel'
import { createPlayerStore, type PlayerEngineLike } from '../src/state/playerStore'
import { EQ_PRESETS } from '../shared/constants'

/** 假引擎（只满足 store 需要的最小面；没有 `setEqChain` → 走降级路径）。 */
const engine: PlayerEngineLike = {
  play: () => {},
  pause: () => {},
  resume: () => {},
  seek: () => {},
  setVolume: () => {},
  onStateChange: () => {},
  onEnded: () => {},
}

/** 造一个带独立 store 的面板。 */
function renderPanel() {
  const store = createPlayerStore(engine)
  const view = render(<EqPanel store={store} />)
  return { store, ...view }
}

describe('EqPanel：界面元素', () => {
  it('预置下拉里有 10 条曲线，显示中文 label', () => {
    renderPanel()
    const select = screen.getByLabelText('预置曲线') as HTMLSelectElement
    const labels = Array.from(select.options).map((option) => option.textContent)
    expect(labels).toHaveLength(10)
    expect(labels).toContain('平直')
    expect(labels).toContain('流行')
    expect(labels).toContain('低音增强')
  })

  it('默认是平直 + 10 段 + 启用', () => {
    renderPanel()
    expect((screen.getByLabelText('预置曲线') as HTMLSelectElement).value).toBe('flat')
    expect(screen.getAllByRole('slider')).toHaveLength(10)
    expect((screen.getByLabelText('启用 EQ') as HTMLInputElement).checked).toBe(true)
  })

  it('段数切换：15 段时滑块变成 15 个', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '15 段' }))
    expect(screen.getAllByRole('slider')).toHaveLength(15)
  })

  it('滑块范围是 ±12 dB', () => {
    renderPanel()
    const slider = screen.getAllByRole('slider')[0] as HTMLInputElement
    expect(slider.min).toBe('-12')
    expect(slider.max).toBe('12')
  })

  it('旁路开关会切到「不启用」', () => {
    const { store } = renderPanel()
    fireEvent.click(screen.getByLabelText('启用 EQ'))
    expect(store.getState().eqEnabled).toBe(false)
    expect((screen.getByLabelText('启用 EQ') as HTMLInputElement).checked).toBe(false)
  })

  it('复位：回到平直、手动偏移清零', () => {
    const { store } = renderPanel()
    fireEvent.change(screen.getByLabelText('预置曲线'), { target: { value: 'rock' } })
    expect(store.getState().eqPresetKey).toBe('rock')

    fireEvent.click(screen.getByRole('button', { name: '复位' }))
    expect(store.getState().eqPresetKey).toBe('flat')
    expect(store.getState().eqManualOffset).toEqual(new Array(10).fill(0))
  })
})

describe('EqPanel：两层数值与实际增益一致', () => {
  it('选预置后显示「基线 / 偏移 / 实际」三层数字', () => {
    const { container } = renderPanel()
    fireEvent.change(screen.getByLabelText('预置曲线'), { target: { value: 'bass-boost' } })

    // 31.5 Hz（第一段）：基线 +6、偏移 0、实际 +6
    const firstBand = container.querySelectorAll('.fnm-eqpanel__band')[0]
    expect(firstBand?.textContent).toContain('基线 +6.0')
    expect(firstBand?.textContent).toContain('偏移 0.0')
    expect(firstBand?.textContent).toContain('实际 +6.0')
  })

  it('拖滑块改的是手动偏移，「实际」= 基线 + 偏移', () => {
    const { store } = renderPanel()
    fireEvent.change(screen.getByLabelText('预置曲线'), { target: { value: 'bass-boost' } })

    fireEvent.change(screen.getByLabelText('31.5 增益偏移'), { target: { value: '3' } })

    // 手动偏移 +3 → 实际 = 6 + 3 = 9
    expect(store.getState().eqManualOffset[0]).toBe(3)
    expect(store.getState().eqGains[0]).toBe(9)
    expect(screen.getByText('偏移 +3.0')).toBeInTheDocument()
    expect(screen.getByText('实际 +9.0')).toBeInTheDocument()
  })

  it('手动改过之后预置变成「自定义」', () => {
    const { store } = renderPanel()
    fireEvent.change(screen.getByLabelText('预置曲线'), { target: { value: 'pop' } })
    fireEvent.change(screen.getByLabelText('1k 增益偏移'), { target: { value: '2' } })

    expect(store.getState().eqPresetKey).toBe('custom')
    expect((screen.getByLabelText('预置曲线') as HTMLSelectElement).value).toBe('custom')
  })

  it('面板显示的「实际」逐段等于 store 的生效增益（= 真正送进滤波器的）', () => {
    const { store, container } = renderPanel()
    fireEvent.change(screen.getByLabelText('预置曲线'), { target: { value: 'vocal' } })
    fireEvent.change(screen.getByLabelText('1k 增益偏移'), { target: { value: '-4' } })

    // 面板上逐段显示的「实际」必须与 store 的生效增益**逐项相等**
    const shown = Array.from(container.querySelectorAll('.fnm-eqpanel__effective')).map(
      (node) => node.textContent,
    )
    const expected = store.getState().eqGains.map((gain) => `实际 ${formatEqGain(gain)}`)
    expect(shown).toEqual(expected)
  })

  it('预置基线与 `EQ_PRESETS` 一致（10 段取 gains）', () => {
    const { store } = renderPanel()
    fireEvent.change(screen.getByLabelText('预置曲线'), { target: { value: 'rock' } })
    expect(store.getState().eqPresetBaseline).toEqual([...EQ_PRESETS.rock!.gains])
  })
})

describe('格式化小工具', () => {
  it('频率：31.5 → 31.5，1000 → 1k，16000 → 16k', () => {
    expect(formatEqFrequency(31.5)).toBe('31.5')
    expect(formatEqFrequency(1000)).toBe('1k')
    expect(formatEqFrequency(16000)).toBe('16k')
  })

  it('增益：带符号、一位小数', () => {
    expect(formatEqGain(3)).toBe('+3.0')
    expect(formatEqGain(0)).toBe('0.0')
    expect(formatEqGain(-4.5)).toBe('-4.5')
  })
})
