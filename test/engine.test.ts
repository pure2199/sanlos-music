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
  /**
   * 依次交给 `play()` 的结果队列（**按调用顺序**，取完即从队列移除）。
   *
   * 空 → 每次 `play()` 都返回 `playResult`（旧行为，不变）。
   * 用来模拟「上一首的 `play()` 一直不兑现（流还在缓冲）」这类场景。
   */
  playResults: Array<Promise<void> | void> = []
  /**
   * `removeEventListener` 的调用记录（按调用顺序记录事件类型）。
   *
   * ⚠️ 有了它，「旧元素的监听已解绑」才**有鉴别力**：只断言「旧元素发事件不影响引擎」
   * 是**空洞**的（引擎读的是**新**元素，旧元素挂没挂监听都测不出来）。
   */
  removedTypes: string[] = []
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  play(): Promise<void> | void {
    this.playCalls += 1
    this.paused = false
    if (this.playResults.length > 0) return this.playResults.shift()
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
    this.removedTypes.push(type)
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

  // ⚠️ **前提被用户明确推翻**（T37）→ 本断言**改写**为**新行为**。
  //    旧断言是「stalled 事件也写入可读错误」。
  //    为什么推翻：按 HTML 规范，`stalled` 只是「浏览器在取数据，但数据一时没到」的
  //    **瞬时提示**——播放通常**自行恢复**。把它当错误 → 界面挂**红字**，
  //    而**音乐其实照放**；更糟的是**没人清它** → 红字一直挂到用户切歌。
  //    ⇒ 新行为：`stalled` 只标记「缓冲中」，**不写错误**。
  it('**stalled 不是错误**：只标记「缓冲中」，**不写错误**（音乐照放，不该报红）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('stalled', { target: element })
    expect(engine.state.error).toBeNull()
    expect(engine.state.buffering).toBe(true)
    // ⚠️ 播放**没有被停掉**（`stalled` 不代表失败）。
    expect(engine.state.isPlaying).toBe(true)
  })

  it('缓冲中 → **playing 之后自动清除**（提示不许粘在界面上）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('stalled', { target: element })
    expect(engine.state.buffering).toBe(true)

    element.emit('playing', { target: element })
    expect(engine.state.buffering).toBe(false)
  })

  it('缓冲中 → **canplay** 也清除（数据到了就该收提示）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('waiting', { target: element })
    expect(engine.state.buffering).toBe(true)

    element.emit('canplay', { target: element })
    expect(engine.state.buffering).toBe(false)
  })

  it('`waiting`（缓冲）同样**不是错误**', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('waiting', { target: element })
    expect(engine.state.error).toBeNull()
    expect(engine.state.buffering).toBe(true)
  })

  it('缓冲中 → **真出错时错误优先**（缓冲提示收掉，不与错误打架）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('stalled', { target: element })
    expect(engine.state.buffering).toBe(true)

    element.emit('error', { target: { error: { code: 2 } } })
    expect(engine.state.error).toContain('网络')
    expect(engine.state.buffering).toBe(false)
  })

  it('缓冲中 → **暂停**时提示收掉（用户主动暂停不是「在等数据」）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a'))
    element.emit('stalled', { target: element })
    expect(engine.state.buffering).toBe(true)

    element.emit('pause', { target: element })
    expect(engine.state.buffering).toBe(false)
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
    const { engine } = createEngine()
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

// ---------------------------------------------------------------------------
// 修复轮次 2 · I-1：`play()` 的 Promise 被拒（`AbortError`）也要区分「换歌」与「真实中止」
//
// 真实 Chromium 128（Electron 32.3.3）实测：**上一首的 `play()` Promise 尚未兑现
// （流还在缓冲）时切歌**，那个 Promise 会被以 `AbortError` 拒掉——
// 机制**不是** `abort` 事件，而是 **Promise 拒绝**，所以上一轮（F1）那个
// 「自主动作」布尔标记**管不到它**（`emptied`/`loadstart` 一到就把标记清零了）。
//
// 判据：**记住「这次 `play()` 调用属于哪一轮加载」**（`loadGeneration`）。
// - 引擎每改一次 `src` 就把轮次号 +1；
// - Promise 被拒时若轮次号**已经变了** → 引擎**后来换过歌** → 这次中止是
//   **自主动作** → 不写错误、也不动 `playing`（新歌照播）；
// - 轮次号**没变** → 没有任何引擎自主动作介入 → **真实**的中止 → 必须报错。
//
// ⚠️ 为什么不能只看布尔标记：标记在 `emptied`/`loadstart` 时清零，而浏览器把这两个
// 事件排在**上一首的 play() Promise 被拒之前**送达 → 到达拒绝处理器时标记早已是 false。
// 轮次号**只增不减**，不受事件顺序影响。
// ---------------------------------------------------------------------------
describe('PlayerEngine：play() 被 AbortError 拒掉（修复轮次 2 · I-1）', () => {
  /** 造一个 `AbortError`（`DOMException` 不是 `Error` 的实例，用普通对象模拟）。 */
  const abortError = (): { name: string } => ({ name: 'AbortError' })

  /** 造一个「永不兑现」的 Promise（模拟流还在缓冲）。 */
  const neverSettles = (): Promise<void> => new Promise<void>(() => {})

  /** 造一个「稍后会被拒」的 Promise。 */
  const rejectable = (): { promise: Promise<void>; reject: (reason: unknown) => void } => {
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((_resolve, r) => {
      reject = r
    })
    return { promise, reject }
  }

  /** 冲刷微任务（让 `play()` 的拒绝处理器跑完）。 */
  const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('换歌后：上一首未兑现的 play() 被 AbortError 拒掉也不写错误', async () => {
    // ⚠️ 鉴别力：把「按加载轮次判定」的守卫删掉 → 本条**红**。
    const { engine, element } = createEngine()
    const first = rejectable()
    element.playResults.push(first.promise)
    engine.play(song('a'))
    // 切歌：引擎改 `src` → 上一首那个还没兑现的 play() Promise 被中止
    element.playResults.push(neverSettles())
    engine.play(song('b'))
    // ⚠️ 真实浏览器里 `emptied`/`loadstart` 会**先于**拒绝送达
    //    → 布尔「自主动作」标记此时已被清零（这正是单靠布尔标记不够的原因）。
    element.emit('emptied', { target: element })
    element.emit('loadstart', { target: element })
    first.reject(abortError())
    await flush()
    expect(engine.state.error).toBeNull()
    expect(engine.state.isPlaying).toBe(true)
  })

  it('同一任务内连续换两次歌：最早的 play() 被 AbortError 拒掉同样不写错误', async () => {
    // ⚠️ 鉴别力：这一条覆盖「同任务连改两次 `src`」——上一轮报告曾写它「现网不可达」，
    //    复审实测证伪（机制是 Promise 拒绝，不是 `abort` 事件）。
    const { engine, element } = createEngine()
    const first = rejectable()
    const second = rejectable()
    element.playResults.push(first.promise, second.promise, neverSettles())
    engine.play(song('a'))
    engine.play(song('b'))
    engine.play(song('c'))
    element.emit('emptied', { target: element })
    element.emit('loadstart', { target: element })
    first.reject(abortError())
    second.reject(abortError())
    await flush()
    expect(engine.state.error).toBeNull()
    expect(engine.state.isPlaying).toBe(true)
  })

  it('非换歌场景：真实的 AbortError 仍然写入可读错误（反向用例）', async () => {
    // ⚠️ 反向用例：防止「把整个 `AbortError` 分支删掉 / 一律忽略」这种假修复。
    const { engine, element } = createEngine()
    const only = rejectable()
    element.playResults.push(only.promise)
    engine.play(song('a'))
    // 引擎**没有**再改 `src` → 这次中止不是换歌造成的 → 真实错误
    only.reject(abortError())
    await flush()
    expect(engine.state.error).toContain('中止')
    expect(engine.state.isPlaying).toBe(false)
  })

  it('真实 abort 之后引擎不再声称在播放（修复轮次 2 · M-4）', () => {
    // ⚠️ 鉴别力：把 `handleAbort` 里的 `playing = false` / `stopTicking()` 删掉 → 本条**红**。
    const { engine, element, clock } = createEngine()
    engine.play(song('a'))
    expect(clock.pendingFrames()).toBe(1)
    // 新一轮加载已经开始 → 此时的 abort 来自引擎**之外** → 真实错误
    element.emit('emptied', { target: element })
    element.emit('loadstart', { target: element })
    element.emit('abort', { target: element })
    expect(engine.state.error).toContain('中止')
    expect(engine.state.isPlaying).toBe(false)
    expect(clock.pendingFrames()).toBe(0)
  })

  it('换歌自主动作的 abort 不打断播放（不置 playing=false，也不停进度推进）', () => {
    // ⚠️ M-4 的另一半：自主动作的 abort 必须**只静默忽略**，不得停播放。
    const { engine, element, clock } = createEngine()
    engine.play(song('a'))
    engine.play(song('b'))
    element.emit('abort', { target: element })
    expect(engine.state.error).toBeNull()
    expect(engine.state.isPlaying).toBe(true)
    expect(clock.pendingFrames()).toBe(1)
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
    // ⚠️ 鉴别力：只断言「旧元素发事件不影响引擎」是**空洞**的——引擎读的是**新**元素，
    //    旧元素上就算还挂着监听也测不出来。真正能钉住「解绑」的是
    //    **旧元素的 `removeEventListener` 确实被调用过**（假元素记录调用）。
    expect(injected.removedTypes).toContain('timeupdate')
    expect(injected.removedTypes.length).toBeGreaterThan(0)
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

  it('非队尾的 next() 不会调用引擎的 pause()（只换歌，不打断播放）', () => {
    // ⚠️ 鉴别力：在**非队尾**分支加一次 `engine.pause()` → 本条**红**。
    //    基线必须在**第一次 `next()` 之前**取，否则会被后续调用污染。
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(song('a'), [song('a'), song('b'), song('c')])
    const pauseCallsBefore = engine.pauseCalls
    store.getState().next() // 从 a → b（非队尾）
    expect(store.getState().current?.id).toBe('b')
    expect(engine.pauseCalls).toBe(pauseCallsBefore)
    expect(store.getState().isPlaying).toBe(true)
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
