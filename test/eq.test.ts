// ---------------------------------------------------------------------------
// Task 21：软件 EQ（10/15 段 + 10 条预置曲线）
//
// 覆盖简报 Step 1/3 与控制器追加要求 A–H 中**可测**的部分：
// - A：常量一律从 `shared/constants.ts` import（频点 / Q / 增益上限 / 10 条预置）；
// - B：`applyPreset` 的可选段数参数 + 未知预置原样返回 + 长度不一致安全处理；
// - C：「预设基线 vs 手动偏移」两层数据模型（`presetBaseline` / `manualOffset` /
////   `effectiveGain = clamp(基线 + 偏移)`）；
// - D：WebAudio 接线幂等（重复 attach / 反复 toggle 不产生重复连接）、
//   `setBandCount` **按频率**映射增益；
// - H：**绝不**真创建 AudioContext（jsdom 没有）——全部用假节点。
//
// ⚠️ 全部数据都是**虚构占位**，不含任何真实 FN ID / 账号 / 密码 / 真实歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import {
  EQ_CUSTOM_PRESET,
  EqChain,
  applyPreset,
  buildBands,
  computeEffectiveGains,
  defaultEqSettings,
  eqFrequencies,
  isEqPresetKey,
  presetBaselineFor,
  remapByFrequency,
  type EqBandCount,
} from '../src/player/eq'
import {
  EQ_BANDS_10,
  EQ_BANDS_15,
  EQ_GAIN_LIMIT,
  EQ_PRESETS,
  EQ_Q,
} from '../shared/constants'
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  BiquadFilterLike,
  EqChainContext,
  GainNodeLike,
  MediaElementSourceLike,
} from '../src/player/engine'

// ---------------------------------------------------------------------------
// 假 WebAudio 节点
// ---------------------------------------------------------------------------

/**
 * 记录连线的假节点。
 *
 * ⚠️ **出边用数组而不是 Set**：`Set` 会把重复的 `connect` 折叠掉，
 *    于是「重复连线 = 音量翻倍」这个缺陷在测试里**看不见**。
 *    数组保留重复项 → 断言 `outputs.length` 就能钉住幂等性。
 */
class FakeNode implements AudioNodeLike {
  /** 连出去的边（**允许重复**——重复连线必须看得见）。 */
  outputs: unknown[] = []
  /** 流入本节点的边。 */
  inputs: unknown[] = []

  connect(destination: unknown): unknown {
    this.outputs.push(destination)
    const target = destination as FakeNode | undefined
    if (target && 'inputs' in target) target.inputs.push(this)
    return destination
  }

  disconnect(destination?: unknown): void {
    if (destination === undefined) {
      for (const out of [...this.outputs]) {
        const target = out as FakeNode | undefined
        if (target && 'inputs' in target) {
          const index = target.inputs.indexOf(this)
          if (index >= 0) target.inputs.splice(index, 1)
        }
      }
      this.outputs.length = 0
      return
    }
    const index = this.outputs.indexOf(destination)
    if (index >= 0) this.outputs.splice(index, 1)
    // ⚠️ WebAudio 里断开是**双向**的：目标那边也要少一条入边。
    const target = destination as FakeNode | undefined
    if (target && 'inputs' in target) {
      const back = target.inputs.indexOf(this)
      if (back >= 0) target.inputs.splice(back, 1)
    }
  }
}

/** 假增益节点。 */
class FakeGainNode extends FakeNode implements GainNodeLike {
  gain = { value: 1 }
}

/** 假 peaking 滤波器。 */
class FakeFilterNode extends FakeNode implements BiquadFilterLike {
  type = 'peaking'
  frequency = { value: 0 }
  Q = { value: 1 }
  gain = { value: 0 }
}

/** 假 PCM 源节点。 */
class FakeBufferSource extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null
  startCalls = 0

  start(): void {
    this.startCalls += 1
  }

  stop(): void {
    // 假实现：不需要真的停。
  }
}

/** 假 `AudioContext`（记录造出来的节点）。 */
class FakeAudioContext implements AudioContextLike {
  state = 'running'
  destination = new FakeNode()
  gainNodes: FakeGainNode[] = []
  filters: FakeFilterNode[] = []
  bufferSources: FakeBufferSource[] = []
  sourceCalls = 0

  createGain(): FakeGainNode {
    const node = new FakeGainNode()
    this.gainNodes.push(node)
    return node
  }

  createBiquadFilter(): FakeFilterNode {
    const node = new FakeFilterNode()
    this.filters.push(node)
    return node
  }

  createBufferSource(): FakeBufferSource {
    const node = new FakeBufferSource()
    this.bufferSources.push(node)
    return node
  }

  createMediaElementSource(): MediaElementSourceLike {
    this.sourceCalls += 1
    return new FakeNode()
  }
}

/** 没有 `createBiquadFilter` 的假上下文（用来验「退化成直通」）。 */
class FakeContextWithoutFilter implements AudioContextLike {
  state = 'running'
  destination = new FakeNode()
  gainNodes: FakeGainNode[] = []

  createGain(): FakeGainNode {
    const node = new FakeGainNode()
    this.gainNodes.push(node)
    return node
  }

  createMediaElementSource(): MediaElementSourceLike {
    return new FakeNode()
  }
}

/** 读一个节点的出边（假节点用数组存边，重复连线看得见）。 */
function outputsOf(node: AudioNodeLike): unknown[] {
  return (node as unknown as FakeNode).outputs
}

/** 造一份 EQ 链上下文。 */
function makeContext(context: FakeAudioContext): EqChainContext {
  const gain = context.createGain()
  const source = context.createMediaElementSource()
  return { context, source, gain }
}

/** 造一段占位 PCM 缓冲。 */
function makeBuffer(): AudioBufferLike {
  return { duration: 1, numberOfChannels: 2, sampleRate: 44100, length: 44100 }
}

// ---------------------------------------------------------------------------
// buildBands
// ---------------------------------------------------------------------------

describe('buildBands：频点、Q 与增益', () => {
  it('10 段与 15 段频点正确且 Q 固定', () => {
    const ten = buildBands(10, new Array(10).fill(0))
    const fifteen = buildBands(15, new Array(15).fill(0))
    expect(ten[0]?.frequency).toBe(31.5)
    expect(fifteen[14]?.frequency).toBe(16000)
    expect(ten[0]?.q).toBe(1.41)
  })

  it('频点与 shared/constants.ts 完全一致（常量只 import，不重定义）', () => {
    expect(eqFrequencies(10)).toEqual([...EQ_BANDS_10])
    expect(eqFrequencies(15)).toEqual([...EQ_BANDS_15])
    expect(buildBands(10, []).map((band) => band.frequency)).toEqual([...EQ_BANDS_10])
    expect(buildBands(15, []).map((band) => band.frequency)).toEqual([...EQ_BANDS_15])
  })

  it('Q 值取自常量（EQ_Q）', () => {
    for (const band of buildBands(15, [])) {
      expect(band.q).toBe(EQ_Q)
    }
  })

  it('增益按索引取用；不够的补 0、多余的忽略', () => {
    const bands = buildBands(10, [3, -4])
    expect(bands[0]?.gain).toBe(3)
    expect(bands[1]?.gain).toBe(-4)
    expect(bands[2]?.gain).toBe(0)
    expect(bands).toHaveLength(10)
  })

  it('增益钳制在 ±EQ_GAIN_LIMIT', () => {
    const bands = buildBands(10, [99, -99])
    expect(bands[0]?.gain).toBe(EQ_GAIN_LIMIT)
    expect(bands[1]?.gain).toBe(-EQ_GAIN_LIMIT)
  })

  it('返回的是副本——改返回值不会污染共享常量', () => {
    const freqs = eqFrequencies(10)
    freqs[0] = 999
    expect(EQ_BANDS_10[0]).toBe(31.5)
  })
})

// ---------------------------------------------------------------------------
// applyPreset
// ---------------------------------------------------------------------------

describe('applyPreset：预置叠加与钳制', () => {
  it('预置曲线与手动增益叠加并钳制在 ±12', () => {
    const g = applyPreset(new Array(10).fill(12), 'bass-boost')
    expect(Math.max(...g)).toBeLessThanOrEqual(12)
    expect(Math.min(...g)).toBeGreaterThanOrEqual(-12)
  })

  it('未知预设返回原增益', () => {
    const g = applyPreset([1, 2, 3], 'nope')
    expect(g).toEqual([1, 2, 3])
  })

  it('叠加是**逐点相加**：基线 + 手动偏移', () => {
    const g = applyPreset([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'bass-boost')
    expect(g).toEqual([...EQ_PRESETS['bass-boost']!.gains])
  })

  it('缺省段数按 gains.length 推断（10 → gains，15 → gains15）', () => {
    const ten = applyPreset(new Array(10).fill(0), 'pop')
    const fifteen = applyPreset(new Array(15).fill(0), 'pop')
    expect(ten).toEqual([...EQ_PRESETS.pop!.gains])
    expect(fifteen).toEqual([...EQ_PRESETS.pop!.gains15])
    // 两套数组**不可互相切片**（值不同）
    expect(ten).not.toEqual(fifteen)
  })

  it('显式 count=15 时取 gains15', () => {
    const g = applyPreset(new Array(15).fill(0), 'pop', 15)
    expect(g).toEqual([...EQ_PRESETS.pop!.gains15])
  })

  it('长度不一致时安全处理（截断 / 补零），不抛异常', () => {
    // 10 段的手动偏移配 15 段预置 → 前 10 个用预置值，后 5 个没有预置值（补 0）
    const g = applyPreset(new Array(10).fill(0), 'pop', 15)
    expect(g).toHaveLength(10)
    expect(g[0]).toBe(EQ_PRESETS.pop!.gains15[0])
    // 预置数组比手动偏移短 → 后面的段只用手动偏移
    const short = applyPreset([1, 2, 3], 'flat', 10)
    expect(short).toEqual([1, 2, 3])
  })

  it('applyPreset 与 computeEffectiveGains(presetBaselineFor(...)) 恒等', () => {
    for (const key of Object.keys(EQ_PRESETS)) {
      for (const count of [10, 15] as EqBandCount[]) {
        const offset = new Array(count).fill(2)
        expect(applyPreset(offset, key, count)).toEqual(
          computeEffectiveGains(presetBaselineFor(key, count), offset),
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 数据模型（追加要求 C）
// ---------------------------------------------------------------------------

describe('EQ 数据模型：预设基线 vs 手动偏移', () => {
  it('预置恰好 10 条，含 bass-boost（带连字符）', () => {
    expect(Object.keys(EQ_PRESETS)).toHaveLength(10)
    expect(Object.keys(EQ_PRESETS)).toContain('bass-boost')
    expect(isEqPresetKey('bass-boost')).toBe(true)
    expect(isEqPresetKey('custom')).toBe(false)
    expect(isEqPresetKey('toString')).toBe(false)
  })

  it('presetBaselineFor 按段数取对应数组（10 → gains，15 → gains15）', () => {
    expect(presetBaselineFor('pop', 10)).toEqual([...EQ_PRESETS.pop!.gains])
    expect(presetBaselineFor('pop', 15)).toEqual([...EQ_PRESETS.pop!.gains15])
  })

  it('未知预置的基线是全 0（不抛异常）', () => {
    expect(presetBaselineFor('nope', 10)).toEqual(new Array(10).fill(0))
    expect(presetBaselineFor(EQ_CUSTOM_PRESET, 10)).toEqual(new Array(10).fill(0))
  })

  it('effectiveGain = clamp(基线 + 手动偏移, ±12)', () => {
    const baseline = [6, 5, 4]
    const offset = [0, 0, 0]
    expect(computeEffectiveGains(baseline, offset)).toEqual([6, 5, 4])
    expect(computeEffectiveGains([6], [6])).toEqual([12])
    expect(computeEffectiveGains([6], [12])).toEqual([12])
    expect(computeEffectiveGains([-6], [-12])).toEqual([-12])
  })

  it('缺项补 0（长度不一致不抛异常）', () => {
    expect(computeEffectiveGains([1, 2, 3], [1])).toEqual([2, 2, 3])
    expect(computeEffectiveGains([1], [1, 2, 3])).toEqual([2, 2, 3])
  })

  it('remapByFrequency 按**频率值**映射（不是按索引）', () => {
    // 10 段 → 15 段：63 / 250 / 1000 / 4000 / 16000 是共有频点
    const ten = new Array(10).fill(0)
    ten[1] = 5 // 63 Hz
    ten[3] = 7 // 250 Hz
    ten[5] = 9 // 1000 Hz
    const fifteen = remapByFrequency(ten, 10, 15)
    expect(fifteen[2]).toBe(5) // 63 Hz
    expect(fifteen[5]).toBe(7) // 250 Hz
    expect(fifteen[8]).toBe(9) // 1000 Hz
    // 匹配不上的置 0
    expect(fifteen[0]).toBe(0) // 25 Hz
    expect(fifteen[1]).toBe(0) // 40 Hz
  })

  it('默认设置：平直、10 段、启用', () => {
    const settings = defaultEqSettings()
    expect(settings.presetKey).toBe('flat')
    expect(settings.bandCount).toBe(10)
    expect(settings.enabled).toBe(true)
    expect(settings.manualOffset).toEqual(new Array(10).fill(0))
    expect(settings.presetBaseline).toEqual(new Array(10).fill(0))
  })
})

// ---------------------------------------------------------------------------
// EqChain：接线与幂等
// ---------------------------------------------------------------------------

describe('EqChain：节点与接线', () => {
  it('build 造出 N 个 peaking 滤波器（频点 / Q / 增益）', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10, gains: new Array(10).fill(0) })
    const nodes = chain.build(makeContext(context))

    expect(context.filters).toHaveLength(10)
    for (const [index, filter] of context.filters.entries()) {
      expect(filter.type).toBe('peaking')
      expect(filter.frequency.value).toBe(EQ_BANDS_10[index])
      expect(filter.Q.value).toBe(EQ_Q)
      expect(filter.gain.value).toBe(0)
    }
    // 链的输入 / 输出是引擎要接的那两个端点
    expect(nodes.input).toBeDefined()
    expect(nodes.output).toBeDefined()
  })

  it('串联顺序是 input → f0 → … → fN-1 → output', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    const nodes = chain.build(makeContext(context))

    const input = nodes.input as FakeNode
    const output = nodes.output as FakeNode
    expect(input.outputs).toHaveLength(1)
    expect(input.outputs[0]).toBe(context.filters[0])

    for (let i = 0; i < context.filters.length - 1; i += 1) {
      const filter = context.filters[i]
      expect(filter?.outputs).toHaveLength(1)
      expect(filter?.outputs[0]).toBe(context.filters[i + 1])
    }
    const last = context.filters[context.filters.length - 1]
    expect(last?.outputs).toHaveLength(1)
    expect(last?.outputs[0]).toBe(output)
  })

  it('重复 attach 不叠加连接（幂等）', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    const ctx = makeContext(context)
    const nodes = chain.build(ctx)

    chain.attach(ctx.context, nodes.input, nodes.output)
    chain.attach(ctx.context, nodes.input, nodes.output)

    const input = nodes.input as FakeNode
    expect(input.outputs).toHaveLength(1)
  })

  it('setEnabled(false) 旁路：input 直连 output，滤波器全部断开', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    const nodes = chain.build(makeContext(context))

    chain.setEnabled(false)

    const input = nodes.input as FakeNode
    const output = nodes.output as FakeNode
    expect(input.outputs).toEqual([output])
    for (const filter of context.filters) {
      expect(filter.outputs).toHaveLength(0)
    }
  })

  it('反复 toggle 不产生重复连接', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    const nodes = chain.build(makeContext(context))
    const input = nodes.input as FakeNode
    const output = nodes.output as FakeNode

    for (let i = 0; i < 5; i += 1) {
      chain.setEnabled(false)
      chain.setEnabled(true)
    }

    expect(input.outputs).toHaveLength(1)
    expect(output.inputs).toHaveLength(1)
    // 最后一个滤波器只连着 output 一条边
    const last = context.filters[context.filters.length - 1]
    expect(last?.outputs).toHaveLength(1)
  })

  it('setBandGain 只改对应那一段', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    chain.build(makeContext(context))

    chain.setBandGain(2, -6)
    expect(context.filters[2]?.gain.value).toBe(-6)
    expect(context.filters[1]?.gain.value).toBe(0)
    expect(chain.getGains()[2]).toBe(-6)
  })

  it('setBandGain 越界索引被忽略', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    chain.build(makeContext(context))
    chain.setBandGain(99, 5)
    chain.setBandGain(-1, 5)
    expect(context.filters).toHaveLength(10)
    expect(chain.getGains().every((g) => g === 0)).toBe(true)
  })

  it('setBandCount(15) 重建滤镜链，并**按频率**沿用增益', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    chain.build(makeContext(context))
    const oldFilters = chain.getFilters()

    // 10 段：63 Hz（索引 1）、1000 Hz（索引 5）
    chain.setBandGain(1, 4)
    chain.setBandGain(5, -3)

    chain.setBandCount(15)

    const filters = chain.getFilters()
    expect(filters).toHaveLength(15)
    expect(filters[2]?.frequency.value).toBe(63)
    expect(filters[2]?.gain.value).toBe(4)
    expect(filters[8]?.frequency.value).toBe(1000)
    expect(filters[8]?.gain.value).toBe(-3)
    // 匹配不上的置 0（25 Hz 是 15 段独有的）
    expect(filters[0]?.gain.value).toBe(0)
    // 旧滤镜**已经断开**（不留孤立的边）
    for (const old of oldFilters) {
      expect(outputsOf(old)).toHaveLength(0)
    }
  })

  it('setBandCount 之后连接关系仍然只有一条', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    const nodes = chain.build(makeContext(context))
    chain.setBandCount(15)

    const input = nodes.input as FakeNode
    expect(input.outputs).toHaveLength(1)
    expect(input.outputs[0]).toBe(chain.getFilters()[0])
  })

  it('没有 createBiquadFilter 时退化成直通（不生效但不崩）', () => {
    const context = new FakeContextWithoutFilter()
    const chain = new EqChain({ bandCount: 10 })
    const gain = context.createGain()
    const source = context.createMediaElementSource()
    const nodes = chain.build({ context, source, gain })

    const input = nodes.input as FakeNode
    const output = nodes.output as FakeNode
    expect(input.outputs).toEqual([output])
  })

  it('fromMediaElementSource 把媒体源接到链的输入，且幂等', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    const ctx = makeContext(context)
    const source = ctx.source as FakeNode

    chain.fromMediaElementSource(ctx.source, ctx)
    chain.fromMediaElementSource(ctx.source, ctx)

    expect(source.outputs).toHaveLength(1)
    expect(source.outputs[0]).toBe(chain.getNodes()?.input)
  })

  it('fromAudioBuffer 造出 PCM 源并接到链的输入（Task 20b 的入口）', () => {
    const context = new FakeAudioContext()
    const chain = new EqChain({ bandCount: 10 })
    const ctx = makeContext(context)
    const buffer = makeBuffer()

    const nodes = chain.fromAudioBuffer(buffer, ctx)

    expect(context.bufferSources).toHaveLength(1)
    const bufferSource = context.bufferSources[0]
    expect(bufferSource?.buffer).toBe(buffer)
    expect(bufferSource?.outputs).toHaveLength(1)
    expect(bufferSource?.outputs[0]).toBe(nodes.input)
  })
})
