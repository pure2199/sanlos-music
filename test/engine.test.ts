import { describe, it, expect, vi } from 'vitest'
import {
  PlayerEngine,
  type AudioContextLike,
  type AudioNodeLike,
  type EqChainBuilder,
  type GainNodeLike,
  type MediaElementLike,
  type MediaElementSourceLike,
} from '../src/player/engine'
import { createPlayerStore, type PlayerEngineLike } from '../src/state/playerStore'
import type { PlayMode, PlayerState, Song } from '../shared/types'

// ---------------------------------------------------------------------------
// Task 13：播放引擎 + 播放器状态
//
// 覆盖：
// - 控制器追加要求 B（createMediaElementSource 只建一次）/ C（jsdom 三件事：注入替身、
//   不 new AudioContext、不依赖真实 rAF）/ J（可注入可测）/ K（error 三类语义）
//   / L（EQ 接缝与幂等）；
// - 简报 Step 5 的 store 形状（要求 G）。
//
// ⚠️ 全部数据都是**虚构占位**（'a' / 'b' / 'c'），不含任何真实 FN ID / 账号 / 密码 / 歌曲名。
// ⚠️ 本文件**绝不** `new AudioContext()`，也**绝不**依赖真实 requestAnimationFrame 推进。
// ---------------------------------------------------------------------------

/** 构造占位歌曲。 */
const song = (id: string, codec = 'FLAC'): Song => ({
  id,
  title: id,
  artist: 'a',
  artistId: '',
  album: '',
  albumId: '',
  coverId: '',
  duration: 100,
  favorite: false,
  codec,
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 0,
  discNo: 0,
})

/** 记录连线的假 WebAudio 节点。 */
class FakeNode implements AudioNodeLike {
  /** 本节点连出去的目标集合。 */
  outputs = new Set<unknown>()
  /** 流入本节点的来源集合。 */
  inputs = new Set<unknown>()

  connect(destination: unknown): unknown {
    this.outputs.add(destination)
    const target = destination as FakeNode | undefined
    if (target && 'inputs' in target) target.inputs.add(this)
    return destination
  }

  disconnect(destination?: unknown): void {
    if (destination === undefined) {
      for (const out of [...this.outputs]) {
        const target = out as FakeNode | undefined
        if (target && 'inputs' in target) target.inputs.delete(this)
      }
      this.outputs.clear()
      return
    }
    this.outputs.delete(destination)
    const target = destination as FakeNode | undefined
    if (target && 'inputs' in target) target.inputs.delete(this)
  }
}

/** 假增益节点。 */
class FakeGainNode extends FakeNode implements GainNodeLike {
  gain = { value: 1 }
}

/** 假 AudioContext（记录 createMediaElementSource 的调用次数与目标元素）。 */
class FakeAudioContext implements AudioContextLike {
  state = 'running'
  destination = new FakeNode()
  sourceCalls = 0
  /** `createMediaElementSource` 被调用的元素（按调用顺序记录）。 */
  sourceElements: unknown[] = []
  lastGain: FakeGainNode | null = null
  lastSource: FakeNode | null = null

  createGain(): FakeGainNode {
    this.lastGain = new FakeGainNode()
    return this.lastGain
  }

  createMediaElementSource(element: unknown): MediaElementSourceLike {
    this.sourceCalls += 1
    this.sourceElements.push(element)
    this.lastSource = new FakeNode()
    return this.lastSource
  }
}

/** 假媒体元素（不碰 jsdom 的 HTMLMediaElement 实现）。 */
class FakeAudioElement implements MediaElementLike {
  src = ''
  preload = ''
  crossOrigin: string | null = null
  currentTime = 0
  duration = 0
  paused = true
  volume = 1
  muted = false
  playCalls = 0
  playResult: Promise<void> | void = undefined
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  play(): Promise<void> | void {
    this.playCalls += 1
    this.paused = false
    return this.playResult
  }

  pause(): void {
    this.paused = true
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  /** 触发一个事件。 */
  emit(type: string, event: unknown = { target: this }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

/** 可注入的时钟 + 帧调度器（测试里手动推进）。 */
function createClock() {
  let now = 0
  let nextId = 1
  const callbacks = new Map<number, (time: number) => void>()
  return {
    now: (): number => now,
    requestFrame: (cb: (time: number) => void): number => {
      const id = nextId
      nextId += 1
      callbacks.set(id, cb)
      return id
    },
    cancelFrame: (id: number): void => {
      callbacks.delete(id)
    },
    advance(ms: number): void {
      now += ms
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const cb of pending) cb(now)
    },
    pendingFrames: (): number => callbacks.size,
  }
}

/** 造一个注入齐全的引擎。 */
function createEngine(overrides: { element?: FakeAudioElement; context?: FakeAudioContext } = {}) {
  const element = overrides.element ?? new FakeAudioElement()
  const context = overrides.context ?? new FakeAudioContext()
  const clock = createClock()
  const factory = vi.fn(() => context)
  const engine = new PlayerEngine({
    audio: element,
    createAudioContext: factory,
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
  })
  return { engine, element, context, clock, factory }
}

describe('PlayerEngine：懒创建与流地址', () => {
  it('构造时不创建 AudioContext（用户还没播）', () => {
    const { factory } = createEngine()
    expect(factory).not.toHaveBeenCalled()
  })

  it('第一次真正播放时才创建 AudioContext 与媒体源节点', () => {
    const { engine, context, factory } = createEngine()
    engine.play(song('a'))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(context.sourceCalls).toBe(1)
  })

  it('换歌只改 src，不重建 MediaElementAudioSourceNode', () => {
    const { engine, element, context, factory } = createEngine()
    engine.play(song('a'))
    engine.play(song('b'))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(context.sourceCalls).toBe(1)
    expect(element.src).toBe('fnm://srv/track/stream?guid=b')
  })

  it('音频地址走 fnm:// 代理，且不含凭据', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    expect(element.src.startsWith('fnm://srv/track/stream?guid=')).toBe(true)
    expect(element.src.toLowerCase()).not.toContain('authx')
    expect(element.src.toLowerCase()).not.toContain('cookie')
  })

  it('媒体元素使用 preload="auto"，且不设置 crossOrigin（同源代理）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    expect(element.preload).toBe('auto')
    expect(element.crossOrigin).toBeNull()
  })

  it('AudioContext 不可用时写入可读错误，不静默失败', () => {    const element = new FakeAudioElement()
    const engine = new PlayerEngine({
      audio: element,
      createAudioContext: () => {
        throw new Error('no AudioContext')
      },
    })
    engine.play(song('a'))
    expect(element.playCalls).toBe(0)
    expect(engine.state.error).toBeTruthy()
    expect(engine.state.error).not.toContain('token')
  })
})

describe('PlayerEngine：error 三类语义', () => {
  it('不可解格式：播放前拦截并写入可读错误', () => {
    const { engine, element } = createEngine()
    engine.play(song('a', 'APE'))
    expect(element.playCalls).toBe(0)
    expect(engine.state.isPlaying).toBe(false)
    expect(engine.state.error).toContain('APE')
    expect(engine.state.error).toContain('无法播放')
  })

  it('媒体错误：<audio> 的 error 事件写入可读错误', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('error', { target: { error: { code: 3 } } })
    expect(engine.state.error).toContain('解码')
    expect(engine.state.isPlaying).toBe(false)
  })

  it('网络/加载错误：错误码 2 写入网络类文案', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('error', { target: { error: { code: 2 } } })
    expect(engine.state.error).toContain('网络')
  })

  it('网络/加载错误：stalled 事件也写入可读错误', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('stalled', { target: element })
    expect(engine.state.error).toBeTruthy()
  })

  it('错误文案不含任何凭证', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('error', { target: { error: { code: 4 } } })
    const message = (engine.state.error ?? '').toLowerCase()
    expect(message).not.toContain('token')
    expect(message).not.toContain('cookie')
    expect(message).not.toContain('authx')
  })

  it('播放新曲目会清掉旧错误', () => {
    const { engine, element } = createEngine()
    engine.play(song('a', 'APE'))
    expect(engine.state.error).toBeTruthy()
    engine.play(song('b'))
    expect(engine.state.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 复审 F1：换歌引发的 `abort` 是**假错误**
//
// 真实 Chromium 128（Electron 32.3.3）里改 `audio.src` 时的加载算法发的是
// `abort` → `emptied` → `loadstart` → `canplay`，**不发** `error`。
// 于是「换歌」这个**引擎自主动作**会让 `PlayerState.error` 变成「音频加载被中止」，
// 而且**此后无人清除**（下一次 `play()` 才清）→ UI 全程显示红字，音乐却正常播。
// ---------------------------------------------------------------------------
describe('PlayerEngine：换歌引发的 abort 不是错误（回归）', () => {
  it('引擎自己换歌引发的 abort 不写错误', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    engine.play(song('b'))
    // 换歌后到达的 abort：引擎的自主动作 → **不是**加载失败
    element.emit('abort', { target: element })
    expect(engine.state.error).toBeNull()
    expect(engine.state.isPlaying).toBe(true)
  })

  it('真实 Chromium 的事件序列（abort → emptied → loadstart → canplay）全程不写错误', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    engine.play(song('b'))
    element.emit('abort', { target: element })
    element.emit('emptied', { target: element })
    element.emit('loadstart', { target: element })
    element.emit('canplay', { target: element })
    expect(engine.state.error).toBeNull()
    expect(engine.state.isPlaying).toBe(true)
  })

  it('没有自主动作标记时的 abort 仍然写入可读错误', () => {
    // ⚠️ 鉴别力：把 abort 处理器整个删掉，这条也会红。
    const { engine, element } = createEngine()
    engine.play(song('a'))
    // 新的一轮加载已经开始（`emptied` / `loadstart` 会让「自主动作」标记作废）
    element.emit('emptied', { target: element })
    element.emit('loadstart', { target: element })
    // 此时的 abort 来自引擎**之外**（例如别处改了 src / 调了 load()）→ 真实错误
    element.emit('abort', { target: element })
    expect(engine.state.error).toContain('中止')
  })

  it('换歌之后到来的真实 abort 仍然会被报出来（标记不会一直挂着）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    engine.play(song('b'))
    element.emit('emptied', { target: element })
    element.emit('loadstart', { target: element })
    element.emit('abort', { target: element })
    expect(engine.state.error).toContain('中止')
  })

  it('换歌自主动作里的 error code 1 不算错误（防御性兜底）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    engine.play(song('b'))
    element.emit('error', { target: { error: { code: 1 } } })
    expect(engine.state.error).toBeNull()
    expect(engine.state.isPlaying).toBe(true)
  })

  it('自主动作窗口之外的 error code 1 仍然报错', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('emptied', { target: element })
    element.emit('loadstart', { target: element })
    element.emit('error', { target: { error: { code: 1 } } })
    expect(engine.state.error).toContain('中止')
  })
})

describe('PlayerEngine：音量与进度', () => {
  it('音量钳制到 [0,1]，NaN 被忽略', () => {
    const { engine } = createEngine()
    engine.setVolume(0.5)
    expect(engine.state.volume).toBe(0.5)
    engine.setVolume(2)
    expect(engine.state.volume).toBe(1)
    engine.setVolume(-1)
    expect(engine.state.volume).toBe(0)
    engine.setVolume(Number.NaN)
    expect(engine.state.volume).toBe(0)
  })

  it('音量同步到媒体元素与增益节点', () => {
    const { engine, element, context } = createEngine()
    engine.setVolume(0.25)
    expect(element.volume).toBe(0.25)
    engine.play(song('a'))
    expect(context.lastGain!.gain.value).toBe(0.25)
  })

  it('首播前设的音量不能丢：接管元素时套用当前音量（回归）', () => {
    // ⚠️ 回归用例：音量在**第一次 play() 之前**设好（应用恢复上次偏好、
    //    或用户在首播前拖过音量条）时，媒体元素不能还停在默认的 1，
    //    否则第一首歌会满音量播，用户以为音量设置没生效。
    const { engine, element } = createEngine()
    engine.setVolume(0.3)
    engine.play(song('a'))
    expect(element.volume).toBe(0.3)
  })

  it('首播前设的音量对「播放时才创建的元素」同样生效（回归）', () => {
    const created = new FakeAudioElement()
    const createElement = vi.fn(() => created)
    const clock = createClock()
    const engine = new PlayerEngine({
      createAudioElement: createElement,
      createAudioContext: () => new FakeAudioContext(),
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })
    engine.setVolume(0.4)
    expect(createElement).not.toHaveBeenCalled()
    engine.play(song('a'))
    expect(created.volume).toBe(0.4)
  })

  it('timeupdate 更新进度', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.currentTime = 12
    element.emit('timeupdate', { target: element })
    expect(engine.state.position).toBe(12)
  })

  it('requestAnimationFrame 按注入的时钟推进进度（不依赖真实 rAF）', () => {
    const { engine, clock } = createEngine()
    engine.play(song('a'))
    clock.advance(500)
    expect(engine.state.position).toBeCloseTo(0.5, 5)
    clock.advance(500)
    expect(engine.state.position).toBeCloseTo(1, 5)
  })

  it('暂停后停止推进进度', () => {
    const { engine, clock } = createEngine()
    engine.play(song('a'))
    clock.advance(500)
    engine.pause()
    const stopped = engine.state.position
    clock.advance(1000)
    expect(engine.state.position).toBe(stopped)
    expect(engine.state.isPlaying).toBe(false)
  })

  it('seek 钳制到 [0, 时长] 并写回媒体元素', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    engine.seek(30)
    expect(element.currentTime).toBe(30)
    expect(engine.state.position).toBe(30)
    engine.seek(-5)
    expect(element.currentTime).toBe(0)
    engine.seek(9999)
    expect(element.currentTime).toBe(100)
  })

  it('播放结束通知订阅者（由 store 负责切下一首）', () => {
    const { engine, element } = createEngine()
    const onEnded = vi.fn()
    engine.onEnded(onEnded)
    engine.play(song('a'))
    element.emit('ended', { target: element })
    expect(onEnded).toHaveBeenCalledTimes(1)
  })
})

describe('PlayerEngine：EQ 接缝（Task 21）', () => {
  /** 造一条假 EQ 链。 */
  const makeChain = (): { input: FakeNode; output: FakeNode } => ({
    input: new FakeNode(),
    output: new FakeNode(),
  })

  it('重复安装 EQ 不会把音量翻倍（旁路连接幂等）', () => {
    const { engine, context } = createEngine()
    engine.play(song('a'))
    const chain = makeChain()
    const builder: EqChainBuilder = { build: () => chain }

    engine.setEqChain(builder)
    engine.setEqChain(builder)

    const gain = context.lastGain!
    const source = context.lastSource!
    // 增益节点只有一路输入（不会被两条 EQ 支路叠加成双倍音量）
    expect(gain.inputs.size).toBe(1)
    // 媒体源节点只有一路输出
    expect(source.outputs.size).toBe(1)
  })

  it('卸载 EQ 后回到旁路，仍然只有一路连接', () => {
    const { engine, context } = createEngine()
    engine.play(song('a'))
    engine.setEqChain({ build: makeChain })
    engine.setEqChain(null)
    const gain = context.lastGain!
    const source = context.lastSource!
    expect(gain.inputs.size).toBe(1)
    expect(source.outputs.size).toBe(1)
    expect(source.outputs.has(gain)).toBe(true)
  })

  it('播放前安装的 EQ 会在建图后自动接上', () => {
    const { engine, context } = createEngine()
    const chain = makeChain()
    engine.setEqChain({ build: () => chain })
    engine.play(song('a'))
    expect(context.lastSource!.outputs.has(chain.input)).toBe(true)
    expect(context.lastGain!.inputs.has(chain.output)).toBe(true)
  })

  it('getAudioNodes 暴露 Task 21 需要的源节点与输出端', () => {
    const { engine, context } = createEngine()
    expect(engine.getAudioNodes()).toBeNull()
    engine.play(song('a'))
    const nodes = engine.getAudioNodes()!
    expect(nodes.source).toBe(context.lastSource)
    expect(nodes.gain).toBe(context.lastGain)
    expect(nodes.eq).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 复审 F3：`dispose()` 之后引擎必须仍可复用
//
// 不变量（要求 B）：**同一个 `<audio>` 元素只能 createMediaElementSource 一次**
// （真实浏览器第二次会抛 InvalidStateError）。所以 `dispose()` 之后再 `play()`，
// 必须**新建元素 + 重建音频图 + 重挂媒体事件监听**，而不是拿旧元素接着用。
// ---------------------------------------------------------------------------
describe('PlayerEngine：dispose 之后仍可复用（回归）', () => {
  it('dispose() 之后再 play()：重建元素与 AudioContext，事件监听重新挂上', () => {
    const injected = new FakeAudioElement()
    const created: FakeAudioElement[] = []
    const createElement = vi.fn(() => {
      const element = new FakeAudioElement()
      created.push(element)
      return element
    })
    const contexts: FakeAudioContext[] = []
    const clock = createClock()
    const engine = new PlayerEngine({
      audio: injected,
      createAudioElement: createElement,
      createAudioContext: () => {
        const context = new FakeAudioContext()
        contexts.push(context)
        return context
      },
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })

    engine.play(song('a'))
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.sourceElements).toEqual([injected])

    engine.dispose()

    engine.play(song('b'))
    // 新建了媒体元素与 AudioContext
    expect(createElement).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
    expect(contexts).toHaveLength(2)
    // createMediaElementSource 第二次调用发生在**新元素**上（不是同一个元素）
    expect(contexts[1]!.sourceElements).toEqual([created[0]])
    // 媒体事件监听重新挂上：timeupdate 能推进进度
    created[0]!.currentTime = 7
    created[0]!.emit('timeupdate', { target: created[0] })
    expect(engine.state.position).toBe(7)
    // 旧元素的监听已解绑（不该再影响引擎）
    injected.currentTime = 99
    injected.emit('timeupdate', { target: injected })
    expect(engine.state.position).toBe(7)
  })

  it('dispose() 之后引擎不再声称自己在播放', () => {
    const { engine } = createEngine()
    engine.play(song('a'))
    expect(engine.state.isPlaying).toBe(true)
    engine.dispose()
    expect(engine.state.isPlaying).toBe(false)
  })
})

describe('playerStore', () => {
  /** 假引擎（只记录调用，不碰媒体栈）。 */
  class FakeEngine implements PlayerEngineLike {
    state: PlayerState = {
      current: null,
      queue: [],
      isPlaying: false,
      position: 0,
      duration: 0,
      volume: 1,
      mode: 'sequence',
      error: null,
    }
    played: Song[] = []
    seeks: number[] = []
    volumes: number[] = []
    modes: PlayMode[] = []
    queues: Song[][] = []
    pauseCalls = 0
    resumeCalls = 0
    private stateListeners: ((state: PlayerState) => void)[] = []
    private endedListeners: ((song: Song | null) => void)[] = []

    play(songToPlay: Song): void {
      this.played.push(songToPlay)
      this.state = { ...this.state, current: songToPlay, isPlaying: true, error: null }
      this.emit()
    }

    pause(): void {
      this.pauseCalls += 1
      this.state = { ...this.state, isPlaying: false }
      this.emit()
    }

    resume(): void {
      this.resumeCalls += 1
      this.state = { ...this.state, isPlaying: true }
      this.emit()
    }

    seek(sec: number): void {
      this.seeks.push(sec)
      this.state = { ...this.state, position: sec }
      this.emit()
    }

    setVolume(v: number): void {
      this.volumes.push(v)
      this.state = { ...this.state, volume: v }
      this.emit()
    }

    setQueue(items: Song[]): void {
      this.queues.push(items)
    }

    setMode(mode: PlayMode): void {
      this.modes.push(mode)
      this.state = { ...this.state, mode }
      this.emit()
    }

    onStateChange(cb: (state: PlayerState) => void): void {
      this.stateListeners.push(cb)
    }

    onEnded(cb: (song: Song | null) => void): void {
      this.endedListeners.push(cb)
    }

    emit(): void {
      for (const cb of this.stateListeners) cb(this.state)
    }
  }

  it('playTrack 写入当前曲与队列，并驱动引擎', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(song('a'))
    expect(store.getState().current?.id).toBe('a')
    expect(store.getState().queue).toHaveLength(1)
    expect(engine.played.map((s) => s.id)).toEqual(['a'])
  })

  it('playTrack 带列表时整队入队并定位到点击的那首', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(song('b'), [song('a'), song('b'), song('c')])
    expect(store.getState().queue.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(store.getState().current?.id).toBe('b')
  })

  it('next / prev 按队列语义推进', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(song('a'), [song('a'), song('b')])
    store.getState().next()
    expect(store.getState().current?.id).toBe('b')
    store.getState().prev()
    expect(store.getState().current?.id).toBe('a')
  })

  it('顺序模式播到队尾时 next() 会同步引擎（暂停），并把 isPlaying 置 false', () => {
    // ⚠️ 回归用例：队尾时 `queue.next()` 返回 null，只改 store 的 isPlaying 的话，
    //    引擎仍在播（媒体元素没暂停），下一次引擎 emit 又把 isPlaying 覆盖回 true
    //    →「下一首」点击完全无效。
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(song('a'), [song('a'), song('b')])
    store.getState().next()
    expect(store.getState().current?.id).toBe('b')
    expect(store.getState().isPlaying).toBe(true)

    const pauseCallsBefore = engine.pauseCalls
    store.getState().next() // 队尾 → 没有下一首
    expect(engine.pauseCalls).toBe(pauseCallsBefore + 1)
    expect(store.getState().isPlaying).toBe(false)
  })

  it('prev 在播放超过 3 秒时回到本曲开头', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(song('a'), [song('a'), song('b')])
    store.setState({ position: 5 })
    store.getState().prev()
    expect(store.getState().current?.id).toBe('a')
  })

  it('togglePlay 在播放/暂停之间切换', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(song('a'))
    expect(store.getState().isPlaying).toBe(true)
    store.getState().togglePlay()
    expect(engine.pauseCalls).toBe(1)
    expect(store.getState().isPlaying).toBe(false)
    store.getState().togglePlay()
    expect(engine.resumeCalls).toBe(1)
  })

  it('seek / setVolume / setMode 透传到引擎并更新 store', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().seek(12)
    expect(engine.seeks).toEqual([12])
    store.getState().setVolume(0.4)
    expect(engine.volumes).toEqual([0.4])
    expect(store.getState().volume).toBe(0.4)
    store.getState().setMode('shuffle')
    expect(engine.modes).toEqual(['shuffle'])
    expect(store.getState().mode).toBe('shuffle')
  })

  it('setVolume 把越界值钳制到 [0,1]，NaN 被忽略', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().setVolume(5)
    expect(store.getState().volume).toBe(1)
    store.getState().setVolume(-2)
    expect(store.getState().volume).toBe(0)
    store.getState().setVolume(Number.NaN)
    expect(store.getState().volume).toBe(0)
  })

  it('引擎上报的状态会同步进 store', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    engine.state = { ...engine.state, position: 33, duration: 100, error: '坏了' }
    engine.emit()
    expect(store.getState().position).toBe(33)
    expect(store.getState().duration).toBe(100)
    expect(store.getState().error).toBe('坏了')
  })

  it('store 里不存放任何凭证', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    const dump = JSON.stringify(store.getState())
    expect(dump.toLowerCase()).not.toContain('token')
    expect(dump.toLowerCase()).not.toContain('password')
    expect(dump.toLowerCase()).not.toContain('cookie')
  })
})
