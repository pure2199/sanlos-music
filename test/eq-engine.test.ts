// ---------------------------------------------------------------------------
// Task 21：EQ 接进播放链路 + store 接线
//
// 覆盖控制器追加要求 E（**真正接到播放链路上**）与 C（数据模型）、F（偏好端口）：
// - E：`<audio> → createMediaElementSource → EQ 链 → gain → destination`，
//   **复用** Task 13 已有的 source node（不重建），重复装链**不产生重复连接**；
// - C：store 的 EQ 状态 = 预设基线 + 手动偏移，生效增益 = 两者相加后钳制；
// - F：偏好**端口可注入**（Task 17 的 `prefs:*` 到位后接上），改动写出去、重启读回来；
// - 降级：引擎**没有** `setEqChain` 时 store **不生效但不崩**。
//
// ⚠️ 全部数据都是**虚构占位**，不含任何真实 FN ID / 账号 / 密码。
// ⚠️ 本文件**绝不** `new AudioContext()`——全部用假节点。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'

import { PlayerEngine, type AudioContextLike, type AudioNodeLike, type EqChainBuilder, type MediaElementLike, type MediaElementSourceLike } from '../src/player/engine'
import { EqChain } from '../src/player/eq'
import { createPlayerStore, type PlayerEngineLike } from '../src/state/playerStore'
import type { PlayerState, Song } from '../shared/types'
import { EQ_PRESETS } from '../shared/constants'

// ---------------------------------------------------------------------------
// 假节点 / 假上下文
// ---------------------------------------------------------------------------

/** 记录连线的假节点（出边用数组——重复连线必须看得见）。 */
class FakeNode implements AudioNodeLike {
  outputs: unknown[] = []
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
    const target = destination as FakeNode | undefined
    if (target && 'inputs' in target) {
      const back = target.inputs.indexOf(this)
      if (back >= 0) target.inputs.splice(back, 1)
    }
  }
}

/** 假 `AudioContext`（记录源节点与增益节点）。 */
class FakeAudioContext implements AudioContextLike {
  state = 'running'
  destination = new FakeNode()
  sourceCalls = 0
  lastSource: FakeNode | null = null
  /**
   * 造出来的增益节点（**按顺序**）。
   *
   * ⚠️ **不能只留「最后一个」**：EQ 链自己也会 `createGain()`（链的输入 / 输出端），
   *    用「最后一个」会把**引擎的音量增益节点**弄丢——断言就会指错节点。
   *    引擎的音量增益是**第一个**（`ensureAudioGraph` 先建它）。
   */
  gainNodes: Array<FakeNode & { gain: { value: number } }> = []

  createGain(): FakeNode & { gain: { value: number } } {
    const node = new FakeNode() as FakeNode & { gain: { value: number } }
    node.gain = { value: 1 }
    this.gainNodes.push(node)
    return node
  }

  createBiquadFilter(): FakeNode & {
    type: string
    frequency: { value: number }
    Q: { value: number }
    gain: { value: number }
  } {
    const node = new FakeNode() as FakeNode & {
      type: string
      frequency: { value: number }
      Q: { value: number }
      gain: { value: number }
    }
    node.type = 'peaking'
    node.frequency = { value: 0 }
    node.Q = { value: 1 }
    node.gain = { value: 0 }
    return node
  }

  createMediaElementSource(): MediaElementSourceLike {
    this.sourceCalls += 1
    const node = new FakeNode()
    this.lastSource = node
    return node
  }
}

/** 假媒体元素。 */
class FakeAudioElement implements MediaElementLike {
  src = ''
  preload = ''
  currentTime = 0
  duration = 0
  paused = true
  volume = 1
  muted = false

  play(): void {
    this.paused = false
  }

  pause(): void {
    this.paused = true
  }

  addEventListener(): void {
    // 假实现：不需要监听。
  }

  removeEventListener(): void {
    // 假实现：不需要监听。
  }
}

/** 占位歌曲。 */
function makeSong(id: string): Song {
  return {
    id,
    title: id,
    artist: 'a',
    artistId: '',
    album: '',
    albumId: '',
    coverId: '',
    duration: 100,
    favorite: false,
    codec: 'FLAC',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: 0,
    trackNo: 0,
    discNo: 0,
  }
}

/** 造一个注入齐全的引擎（假元素 + 假上下文）。 */
function createEngine() {
  const element = new FakeAudioElement()
  const context = new FakeAudioContext()
  const engine = new PlayerEngine({
    audio: element,
    createAudioContext: () => context,
    now: () => 0,
    requestFrame: () => 1,
    cancelFrame: () => {},
  })
  return { engine, element, context }
}

/** 假引擎（**有** `setEqChain`）。 */
class FakeEngine implements PlayerEngineLike {
  /** 装过的 EQ builder（按调用顺序）。 */
  eqBuilders: Array<EqChainBuilder | null> = []
  playCalls = 0

  play(): void {
    this.playCalls += 1
  }

  pause(): void {}
  resume(): void {}
  seek(): void {}
  setVolume(): void {}

  setEqChain(builder: EqChainBuilder | null): void {
    this.eqBuilders.push(builder)
  }

  onStateChange(): void {}
  onEnded(): void {}
}

/** 假引擎（**没有** `setEqChain`——Task 13 的旧实现者 / 测试替身）。 */
class LegacyEngine implements PlayerEngineLike {
  play(): void {}
  pause(): void {}
  resume(): void {}
  seek(): void {}
  setVolume(): void {}
  onStateChange(): void {}
  onEnded(): void {}
}

// ---------------------------------------------------------------------------
// 播放链路
// ---------------------------------------------------------------------------

describe('EQ 接进播放链路', () => {
  it('装上 EQ 链后是 source → EQ 链 → gain → destination', () => {
    const { engine, context } = createEngine()
    engine.play(makeSong('a'))

    const source = context.lastSource as FakeNode
    const gain = context.gainNodes[0] as FakeNode
    // 没装 EQ 时是旁路：source → gain
    expect(source.outputs).toEqual([gain])
    expect(gain.outputs).toEqual([context.destination])

    const chain = new EqChain({ bandCount: 10 })
    engine.setEqChain(chain)

    const nodes = chain.getNodes()
    expect(nodes).not.toBeNull()
    // source 只连到链的输入
    expect(source.outputs).toEqual([nodes?.input])
    // 链的输出连到 gain（gain 只有一路输入）
    expect(gain.inputs).toEqual([nodes?.output])
    expect(gain.outputs).toEqual([context.destination])
  })

  it('复用 Task 13 已有的 source node（createMediaElementSource 只调一次）', () => {
    const { engine, context } = createEngine()
    engine.play(makeSong('a'))

    const source = context.lastSource as FakeNode
    const chain = new EqChain({ bandCount: 10 })
    engine.setEqChain(chain)

    expect(context.sourceCalls).toBe(1)
    // 装链之后 source 仍然是**同一个**节点（只是改了出边）
    expect(source.outputs).toHaveLength(1)
  })

  it('重复装 EQ 链不会产生重复连接（音量不翻倍）', () => {
    const { engine, context } = createEngine()
    engine.play(makeSong('a'))

    const chain = new EqChain({ bandCount: 10 })
    engine.setEqChain(chain)
    engine.setEqChain(chain)

    const source = context.lastSource as FakeNode
    const gain = context.gainNodes[0] as FakeNode
    expect(source.outputs).toHaveLength(1)
    expect(gain.inputs).toHaveLength(1)
  })

  it('播放前装 EQ 链也会在建图时补上', () => {
    const { engine, context } = createEngine()
    const chain = new EqChain({ bandCount: 10 })
    // 音频图还没建（用户还没播）→ 引擎先记着
    engine.setEqChain(chain)
    engine.play(makeSong('a'))

    const source = context.lastSource as FakeNode
    const gain = context.gainNodes[0] as FakeNode
    expect(source.outputs).toEqual([chain.getNodes()?.input])
    expect(gain.inputs).toEqual([chain.getNodes()?.output])
  })

  it('卸掉 EQ 链回到旁路（source → gain）', () => {
    const { engine, context } = createEngine()
    engine.play(makeSong('a'))

    const chain = new EqChain({ bandCount: 10 })
    engine.setEqChain(chain)
    engine.setEqChain(null)

    const source = context.lastSource as FakeNode
    const gain = context.gainNodes[0] as FakeNode
    expect(source.outputs).toEqual([gain])
    expect(gain.inputs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// store 接线
// ---------------------------------------------------------------------------

describe('store 的 EQ 动作', () => {
  it('选预置：重置手动偏移，生效增益 = 预置基线', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setEqPreset('bass-boost')

    const state = store.getState()
    expect(state.eqPresetKey).toBe('bass-boost')
    expect(state.eqManualOffset).toEqual(new Array(10).fill(0))
    expect(state.eqPresetBaseline).toEqual([...EQ_PRESETS['bass-boost']!.gains])
    expect(state.eqGains).toEqual([...EQ_PRESETS['bass-boost']!.gains])
  })

  it('链拿到的增益与 store 的生效增益一致（面板显示 = 真正送进滤波器的）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setEqPreset('pop')
    const chain = engine.eqBuilders[0] as EqChain
    expect(chain.getGains()).toEqual(store.getState().eqGains)
  })

  it('拖滑块改的是手动偏移，预置变成 custom，生效增益 = 基线 + 偏移', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setEqPreset('bass-boost')
    store.getState().setEqBandGain(0, 3)

    const state = store.getState()
    expect(state.eqPresetKey).toBe('custom')
    expect(state.eqManualOffset[0]).toBe(3)
    // 基线 6 + 偏移 3 = 9
    expect(state.eqGains[0]).toBe(9)
    // 其它段不受影响
    expect(state.eqGains[1]).toBe(EQ_PRESETS['bass-boost']!.gains[1])
  })

  it('生效增益钳制在 ±12', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setEqPreset('bass-boost')
    store.getState().setEqBandGain(0, 12)

    expect(store.getState().eqGains[0]).toBe(12)
  })

  it('切段数：手动偏移按频率保留（1000 Hz 沿用），匹配不上的置 0', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setEqPreset('flat')
    // 10 段里 1000 Hz 是索引 5
    store.getState().setEqBandGain(5, 4)

    store.getState().setEqBandCount(15)

    const state = store.getState()
    expect(state.eqBandCount).toBe(15)
    expect(state.eqManualOffset).toHaveLength(15)
    // 15 段里 1000 Hz 是索引 8 → 偏移沿用
    expect(state.eqManualOffset[8]).toBe(4)
    // 31.5 Hz 在 15 段里不存在 → 置 0
    expect(state.eqManualOffset[0]).toBe(0)
    expect(state.eqGains[8]).toBe(4)
  })

  it('切段数时真实预置的基线换成该段数的那一套（gains / gains15 不可互切）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setEqPreset('pop')
    store.getState().setEqBandCount(15)

    expect(store.getState().eqPresetBaseline).toEqual([...EQ_PRESETS.pop!.gains15])
  })

  it('复位：平直 + 手动偏移清零（不动启用开关）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setEqPreset('rock')
    store.getState().setEqBandGain(0, 5)
    store.getState().setEqEnabled(false)

    store.getState().resetEq()

    const state = store.getState()
    expect(state.eqPresetKey).toBe('flat')
    expect(state.eqManualOffset).toEqual(new Array(10).fill(0))
    expect(state.eqGains).toEqual(new Array(10).fill(0))
    // 复位**不动**启用开关
    expect(state.eqEnabled).toBe(false)
  })

  it('引擎没有 setEqChain 时不生效但不崩', () => {
    const store = createPlayerStore(new LegacyEngine())
    expect(() => {
      store.getState().setEqPreset('pop')
      store.getState().setEqBandGain(0, 2)
      store.getState().setEqBandCount(15)
      store.getState().setEqEnabled(false)
      store.getState().resetEq()
    }).not.toThrow()
    // 状态照常更新
    expect(store.getState().eqPresetKey).toBe('flat')
  })

  it('开关与段数变化即时推给链（不需要重建音频图）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    const chain = engine.eqBuilders[0] as EqChain

    store.getState().setEqPreset('jazz')
    expect(chain.getGains()).toEqual([...EQ_PRESETS.jazz!.gains])

    store.getState().setEqBandCount(15)
    expect(chain.getBandCount()).toBe(15)
    expect(chain.getGains()).toEqual(store.getState().eqGains)
  })
})

// ---------------------------------------------------------------------------
// 偏好端口（Task 17 的 prefs:* 到位后接上）
// ---------------------------------------------------------------------------

describe('EQ 偏好端口', () => {
  it('改动会写出去（可注入的端口）', async () => {
    const saved: unknown[] = []
    const store = createPlayerStore(new FakeEngine(), {
      eqPrefs: {
        load: async () => null,
        save: async (prefs) => {
          saved.push(prefs)
        },
      },
    })

    store.getState().setEqPreset('rock')

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const prefs = saved[0] as { presetKey: string; manualOffset: number[]; bandCount: number }
    expect(prefs.presetKey).toBe('rock')
    expect(prefs.manualOffset).toHaveLength(10)
    expect(prefs.bandCount).toBe(10)
  })

  it('重启后能读回上次的效果', async () => {
    const store = createPlayerStore(new FakeEngine(), {
      eqPrefs: {
        load: async () => ({
          presetKey: 'custom',
          manualOffset: [0, 0, 0, 0, 0, 4, 0, 0, 0, 0],
          bandCount: 10,
          enabled: true,
          presetBaseline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        }),
        save: async () => {},
      },
    })

    await vi.waitFor(() => expect(store.getState().eqManualOffset[5]).toBe(4))
    expect(store.getState().eqPresetKey).toBe('custom')
    expect(store.getState().eqGains[5]).toBe(4)
  })

  it('偏好里绝不含凭证', async () => {
    const saved: unknown[] = []
    const store = createPlayerStore(new FakeEngine(), {
      eqPrefs: {
        load: async () => null,
        save: async (prefs) => {
          saved.push(prefs)
        },
      },
    })

    store.getState().setEqPreset('vocal')
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0))

    const dump = JSON.stringify(saved)
    expect(dump.toLowerCase()).not.toContain('token')
    expect(dump.toLowerCase()).not.toContain('password')
    expect(dump.toLowerCase()).not.toContain('cookie')
  })
})
