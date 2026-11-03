// 播放引擎（**渲染进程**）。
//
// ---------------------------------------------------------------------------
// 职责
// ---------------------------------------------------------------------------
// - 用一个 `<audio>` 元素 + 一个 `AudioContext` 播放当前这一曲的流；
// - 把播放状态（当前曲 / 进度 / 时长 / 音量 / 错误）广播给 store；
// - 播放**前**判定格式是否 Chromium 可解，不可解就写可读错误（不静默失败）。
//
// ---------------------------------------------------------------------------
// 可注入 / 可测（控制器追加要求 J）
// ---------------------------------------------------------------------------
// 构造参数允许注入：`<audio>` 元素、`AudioContext` 工厂、时钟与帧调度器。
// **默认值只在真实浏览器里创建真实对象**；jsdom 里没有 `AudioContext`、
// `HTMLMediaElement.play()` 未实现、`requestAnimationFrame` 计时不受控，
// 所以单测一律注入替身，**绝不**在测试里 `new AudioContext()`。
//
// ---------------------------------------------------------------------------
// 节点生命周期（控制器追加要求 B / L）
// ---------------------------------------------------------------------------
// - `AudioContext`：**懒创建**——第一次真正播放（`play()`）时才建，
//   绝不在模块加载或构造时建（用户还没播就建上下文，浏览器会把它挂起）；
//   创建后**一直复用**，直到 `dispose()`。
// - `MediaElementAudioSourceNode`：**每个引擎实例只建一次**（同一个 `<audio>` 元素
//   第二次 `createMediaElementSource` 会抛 `InvalidStateError`）。
//   换歌只改 `audio.src`，**不重建** source node。
// - `GainNode`：随 `AudioContext` 一起建、一起复用，负责音量。
// - EQ 链（Task 21）：**本任务不实现 EQ**，只留接缝。链由 Task 21 的 builder 创建，
//   引擎负责「旁路 ↔ EQ 链」的切换与**幂等**（重复安装不会把音量翻倍）。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 音频流地址一律 `fnm://srv/track/stream?guid=…`（见 `format.ts`）：
//   渲染进程**永不直连 NAS**，也**不碰任何凭证**；
// - 错误文案**不含** token / Cookie / authx；
// - 只用浏览器 API，不 import Node 内置模块或 Electron API。
//
// ---------------------------------------------------------------------------
// 曲库规模
// ---------------------------------------------------------------------------
// 播放**只取当前这一曲的流**，不在播放时顺带拉列表（曲库 17.3 万首，严禁全量拉取）。

import type { PlayMode, PlayerState, Song } from '../../shared/types'
import {
  describeMediaError,
  formatUnsupportedMessage,
  songFormatExtension,
  streamUrl,
  undecodableFormat,
} from './format'

// ---------------------------------------------------------------------------
// 注入式接口（只描述用到的最小面，便于单测替换）
// ---------------------------------------------------------------------------

/** 媒体事件监听器。 */
export type MediaEventListener = (event: unknown) => void

/**
 * `<audio>` 元素的最小接口。
 *
 * 真实浏览器的 `HTMLAudioElement` 满足这个结构；单测里用假元素替换。
 */
export interface MediaElementLike {
  /** 当前音频地址。 */
  src: string
  /** 预加载策略（本任务固定 `auto`，**只影响当前这一曲**）。 */
  preload: string
  /** 播放位置（**秒**）。 */
  currentTime: number
  /** 总时长（**秒**）。 */
  readonly duration: number
  /** 是否处于暂停状态。 */
  readonly paused: boolean
  /** 音量（0~1）。 */
  volume: number
  /** 是否静音。 */
  muted: boolean
  /** 开始播放。 */
  play(): Promise<void> | void
  /** 暂停。 */
  pause(): void
  /** 订阅事件。 */
  addEventListener(type: string, listener: MediaEventListener): void
  /** 退订事件。 */
  removeEventListener(type: string, listener: MediaEventListener): void
}

/** WebAudio 节点的最小接口。 */
export interface AudioNodeLike {
  /** 连到下游。 */
  connect(destination: unknown): unknown
  /** 断开（不传参 = 断开全部出边）。 */
  disconnect(destination?: unknown): void
}

/** 增益节点（音量）。 */
export interface GainNodeLike extends AudioNodeLike {
  /** 增益参数。 */
  gain: { value: number }
}

/** 媒体元素源节点。 */
export interface MediaElementSourceLike extends AudioNodeLike {}

/**
 * peaking 滤波器节点（Task 21 的 EQ 链用）。
 *
 * 真实浏览器的 `BiquadFilterNode` 满足这个结构；单测里用假节点替换。
 */
export interface BiquadFilterLike extends AudioNodeLike {
  /** 滤波器类型（EQ 用 `'peaking'`）。 */
  type: string
  /** 中心频率（Hz）。 */
  frequency: { value: number }
  /** Q 值。 */
  Q: { value: number }
  /** 增益（dB）。 */
  gain: { value: number }
}

/**
 * `AudioBuffer` 的最小接口（PCM 数据）。
 *
 * Task 20b 的 FFmpeg 解码结果要经它进 EQ 链。
 */
export interface AudioBufferLike {
  /** 时长（秒）。 */
  readonly duration: number
  /** 声道数。 */
  readonly numberOfChannels: number
  /** 采样率（Hz）。 */
  readonly sampleRate: number
  /** 帧数。 */
  readonly length: number
}

/** PCM 源节点（`createBufferSource()` 的产物）。 */
export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  /** 要播放的 PCM 缓冲（`null` = 没设）。 */
  buffer: AudioBufferLike | null
  /** 开始播放。 */
  start(when?: number): void
  /** 停止播放。 */
  stop(when?: number): void
}

/**
 * `AudioContext` 的最小接口。
 *
 * 真实浏览器的 `AudioContext` 满足这个结构；单测里用假上下文替换。
 */
export interface AudioContextLike {
  /** 上下文状态（`running` / `suspended` / `closed`）。 */
  readonly state: string
  /** 输出端。 */
  readonly destination: AudioNodeLike
  /** 由媒体元素创建源节点（**同一个元素只能调一次**）。 */
  createMediaElementSource(element: unknown): MediaElementSourceLike
  /** 创建增益节点。 */
  createGain(): GainNodeLike
  /**
   * 创建 peaking 滤波器（**可选**）。
   *
   * ⚠️ 做成**可选成员**：Task 13 已有的实现者与测试替身只实现了
   *    `createGain` / `createMediaElementSource`，加成必填会把它们全弄红。
   *    没有它时 EQ 链**退化成直通**（不生效但不崩）。
   */
  createBiquadFilter?(): BiquadFilterLike
  /**
   * 创建 PCM 源节点（**可选**）。
   *
   * ⚠️ 同上：可选成员。没有它时 PCM 入口**不可用**（抛可读错误），
   *    媒体元素那条路照常。
   */
  createBufferSource?(): AudioBufferSourceNodeLike
  /** 恢复上下文（可选）。 */
  resume?(): Promise<void>
  /** 关闭上下文（可选）。 */
  close?(): Promise<void>
}

// ---------------------------------------------------------------------------
// Task 21（EQ）接缝
// ---------------------------------------------------------------------------

/** EQ 链的输入 / 输出节点。 */
export interface EqChainNodes {
  /** 链的输入：引擎会把媒体源节点连到它。 */
  input: AudioNodeLike
  /** 链的输出：引擎会把它连到增益节点。 */
  output: AudioNodeLike
}

/** 构建 EQ 链时拿到的上下文。 */
export interface EqChainContext {
  /** 音频上下文（Task 21 建 BiquadFilterNode 用）。 */
  context: AudioContextLike
  /** 媒体源节点（**已建好，Task 21 不要自己再建一个**）。 */
  source: MediaElementSourceLike
  /** 增益节点（音量，链的输出最终会接到它上面）。 */
  gain: GainNodeLike
}

/**
 * EQ 链构建器（Task 21 实现这个接口即可接上）。
 *
 * 引擎负责「旁路 ↔ EQ 链」的连接切换；Task 21 只负责**造节点**。
 */
export interface EqChainBuilder {
  /** 造出 EQ 链的输入与输出节点。 */
  build(ctx: EqChainContext): EqChainNodes
}

/** 引擎暴露给 Task 21 的音频节点。 */
export interface PlayerAudioNodes {
  /** 音频上下文。 */
  context: AudioContextLike
  /** 媒体源节点。 */
  source: MediaElementSourceLike
  /** 增益节点（音量）。 */
  gain: GainNodeLike
  /** 当前 EQ 链（没装就是 `null`——此时是旁路）。 */
  eq: EqChainNodes | null
}

// ---------------------------------------------------------------------------
// 默认实现（真实浏览器）
// ---------------------------------------------------------------------------

/** 默认音频元素工厂：新建 `<audio>`，`preload="auto"`。 */
function defaultCreateAudioElement(): MediaElementLike {
  if (typeof document === 'undefined') {
    throw new Error('没有可用的 DOM 环境，无法创建媒体元素')
  }
  const element = document.createElement('audio') as unknown as MediaElementLike
  element.preload = 'auto'
  // ⚠️ **不设置 crossOrigin**：音频走同源代理（`fnm://`），简报既定如此。
  return element
}

/** 默认 AudioContext 工厂（**只在真正播放时才被调用**）。 */
function defaultCreateAudioContext(): AudioContextLike {
  const scope = globalThis as unknown as {
    AudioContext?: new () => AudioContextLike
    webkitAudioContext?: new () => AudioContextLike
  }
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (!Ctor) {
    throw new Error('当前环境不支持 Web Audio（AudioContext 不可用）')
  }
  return new Ctor()
}

/** 默认时钟（毫秒）。 */
function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/** 默认帧调度器（requestAnimationFrame）。 */
function defaultRequestFrame(callback: (time: number) => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback)
  }
  return setTimeout(() => callback(defaultNow()), 16) as unknown as number
}

/** 默认帧取消。 */
function defaultCancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
    return
  }
  clearTimeout(handle)
}

// ---------------------------------------------------------------------------
// 纯逻辑：EQ 链切换（幂等）
// ---------------------------------------------------------------------------

/**
 * 把 EQ 链接到音频图上（**幂等**）。
 *
 * WebAudio 里对同一个输出**重复 `connect()`** 会把信号**翻倍**（两路相同信号叠加）。
 * 所以这里的切换顺序是固定的：
 *
 * 1. 先把**旧**链的输出从增益节点上断开（`current.output.disconnect(gain)`）；
 * 2. 再把媒体源节点的**全部出边**断开（`source.disconnect()`）；
 * 3. 然后才接新链：`source → next.input`、`next.output → gain`。
 *
 * 于是无论 Task 21 装几次 EQ，增益节点**永远只有一路输入**、媒体源节点
 * **永远只有一路输出**——重复安装不会把音量翻倍。
 *
 * @param graph   媒体源节点与增益节点。
 * @param next    要装的新链（`null` = 回到旁路 `source → gain`）。
 * @param current 当前已装的链（用于先断开）。
 * @returns 装好后的当前链（`null` 表示现在是旁路）。
 */
export function applyEqChain(
  graph: { source: AudioNodeLike; gain: AudioNodeLike },
  next: EqChainNodes | null,
  current: EqChainNodes | null,
): EqChainNodes | null {
  if (current) {
    try {
      current.output.disconnect(graph.gain)
    } catch {
      // 没连上时 `disconnect(gain)` 会抛 InvalidAccessError——忽略即可。
    }
  }

  try {
    // 不传参 = 断开全部出边，保证 source 同时只有一路输出。
    graph.source.disconnect()
  } catch {
    // 同上：没有出边时是 no-op。
  }

  if (!next) {
    graph.source.connect(graph.gain)
    return null
  }

  graph.source.connect(next.input)
  next.output.connect(graph.gain)
  return next
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

/** 引擎的构造参数（全部可注入）。 */
export interface PlayerEngineOptions {
  /** 音频元素；缺省时在**真正播放**时创建 `<audio>`。 */
  audio?: MediaElementLike
  /** 音频元素工厂（缺省用 `document.createElement('audio')`）。 */
  createAudioElement?: () => MediaElementLike
  /** `AudioContext` 工厂（缺省用全局 `AudioContext`）；**只在真正播放时被调用**。 */
  createAudioContext?: () => AudioContextLike
  /** 时钟（毫秒）；缺省用 `performance.now()`。 */
  now?: () => number
  /** 帧调度器；缺省用 `requestAnimationFrame`。 */
  requestFrame?: (callback: (time: number) => void) => number
  /** 帧取消；缺省用 `cancelAnimationFrame`。 */
  cancelFrame?: (handle: number) => void
  /**
   * 解析这一曲的**播放地址**（Task 11 的「本地优先播放」接缝）。
   *
   * ⚠️ **不给就用默认的 `streamUrl(song.id)`**——既有行为与既有断言**一字不变**。
   *    给了就可以在本地有副本时改用 `fnml://local/track/<id>`。
   * ⚠️ 解析器**抛异常或返回空串**时一律**退回流式地址**（不崩、不黑屏）。
   */
  resolveSource?: (song: Song) => string
}

/** 引擎的对外接口（store 依赖它；也是单测替身的形状）。 */
export interface PlayerEngineLike {
  /** 播放一首歌。 */
  play(song: Song): void
  /** 暂停。 */
  pause(): void
  /** 继续播放。 */
  resume(): void
  /** 定位（秒）。 */
  seek(sec: number): void
  /** 设置音量（0~1，内部钳制）。 */
  setVolume(v: number): void
  /** 同步队列（只读镜像）。 */
  setQueue?(songs: Song[]): void
  /** 同步播放模式。 */
  setMode?(mode: PlayMode): void
  /**
   * 装 / 卸 EQ 链（**可选**，Task 21）。
   *
   * ⚠️ 做成**可选成员**：Task 13 已有的实现者与测试替身没有这个方法，
   *    加成必填会把它们全弄红。store 侧在方法缺失时**降级**为
   *    「不生效但不崩」（EQ 状态照样更新，只是没接进音频图）。
   */
  setEqChain?(builder: EqChainBuilder | null): void
  /**
   * 暴露音频节点（**可选**，Task 21）。
   *
   * @returns 音频图节点；**还没建**（用户还没播过）时返回 `null`。
   */
  getAudioNodes?(): PlayerAudioNodes | null
  /** 订阅状态变化。 */
  onStateChange(cb: (state: PlayerState) => void): void
  /** 订阅「播完一曲」。 */
  onEnded(cb: (song: Song | null) => void): void
}

/** 播放引擎。 */
export class PlayerEngine implements PlayerEngineLike {
  private readonly options: PlayerEngineOptions
  private readonly createAudioElement: () => MediaElementLike
  private readonly createAudioContextFactory: () => AudioContextLike
  private readonly now: () => number
  private readonly requestFrame: (callback: (time: number) => void) => number
  private readonly cancelFrame: (handle: number) => void

  // --- 媒体与音频图（全部懒创建） -----------------------------------------
  /** 构造时注入的音频元素（还没挂监听，等真正使用时统一挂）。 */
  private injectedElement: MediaElementLike | null
  private element: MediaElementLike | null = null
  private context: AudioContextLike | null = null
  private source: MediaElementSourceLike | null = null
  private gain: GainNodeLike | null = null
  private eqChain: EqChainNodes | null = null
  /** 播放前就装好的 EQ builder（建图时补装）。 */
  private pendingEqBuilder: EqChainBuilder | null = null

  /**
   * 「自主动作」标记：引擎**自己**改 `src`（换歌）时置位。
   *
   * 背景（真实 Chromium 128 / Electron 32.3.3 实测）：改 `audio.src` 时的加载算法
   * 发的是 `abort` → `emptied` → `loadstart` → `canplay`，**不发** `error`。
   * 也就是说换歌必然让媒体元素「中止」上一次加载——那是**引擎自己的动作**，
   * 不是加载失败，绝不能写进 `PlayerState.error`（否则从第 2 首歌起全程显示
   * 红字「音频加载被中止」，而音乐在正常播）。
   *
   * 生命周期：
   * - 改 `src` **之前**置位；
   * - 在 `emptied` / `loadstart`（新一轮加载开始）时**清零**——
   *   于是新一轮加载开始之后到达的 `abort` / `error` 都是**真实**的加载失败，
   *   必须报错（不会被这个标记吞掉）。
   */
  private selfInitiatedLoad = false

  /**
   * 加载轮次号（**单调递增**，只在引擎自己换歌时 +1）。
   *
   * 用途：区分「`play()` 的 Promise 被 `AbortError` 拒掉」到底是**引擎自己换歌**
   * 造成的，还是**真实的加载被中止**。
   *
   * 背景（真实 Chromium 128 / Electron 32.3.3 实测）：**上一首的 `play()` Promise
   * 尚未兑现（流还在缓冲）时切歌**，那个 Promise 会被以 `AbortError` 拒掉——
   * 机制**不是** `abort` 事件，而是 **Promise 拒绝**，所以上面那个布尔标记
   * （`selfInitiatedLoad`）**管不到它**：`emptied`/`loadstart` 一到就把标记清零，
   * 等拒绝处理器跑到时标记早已是 `false`。
   *
   * 判据：**记住「这次 `play()` 调用属于哪一轮加载」**——
   * - 轮次号**变了** → 引擎在这之后**换过歌** → 这次中止是**自主动作**
   *   → 不写错误、不动 `playing`（新歌照播）；
   * - 轮次号**没变** → 没有任何引擎自主动作介入 → **真实**的中止 → 必须报错。
   *
   * 轮次号**只增不减**，所以不受媒体事件到达顺序的影响。
   */
  private loadGeneration = 0

  // --- 状态 ---------------------------------------------------------------
  private currentSong: Song | null = null
  private queueItems: Song[] = []
  private playing = false
  private positionSec = 0
  private durationSec = 0
  private volumeValue = 1
  private modeValue: PlayMode = 'sequence'
  private errorMessage: string | null = null

  // --- 进度推进 -----------------------------------------------------------
  private frameHandle: number | null = null
  private lastTick = 0

  private readonly stateListeners = new Set<(state: PlayerState) => void>()
  private readonly endedListeners = new Set<(song: Song | null) => void>()
  private readonly mediaListeners: Array<[string, MediaEventListener]> = []

  constructor(options: PlayerEngineOptions = {}) {
    this.options = options
    this.createAudioElement = options.createAudioElement ?? defaultCreateAudioElement
    this.createAudioContextFactory = options.createAudioContext ?? defaultCreateAudioContext
    this.now = options.now ?? defaultNow
    this.requestFrame = options.requestFrame ?? defaultRequestFrame
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame

    this.injectedElement = options.audio ?? null
  }

  // --- 状态 ---------------------------------------------------------------

  /** 当前播放器状态（**快照**）。 */
  get state(): PlayerState {
    return {
      current: this.currentSong,
      queue: [...this.queueItems],
      isPlaying: this.playing,
      position: this.positionSec,
      duration: this.durationSec,
      volume: this.volumeValue,
      mode: this.modeValue,
      muted: false,
      error: this.errorMessage,
    }
  }

  /**
   * 解析这一曲的播放地址。
   *
   * ⚠️ **默认行为一字不变**：没注入 `resolveSource` 时就是 `streamUrl(song.id)`。
   *    注入后（Task 11 的「本地优先播放」）可以在本地有副本时改用 `fnml://`。
   * ⚠️ 解析器**抛异常或返回空串** → 一律**退回流式地址**（不崩、不黑屏）。
   */
  private resolveSource(song: Song): string {
    const resolver = this.options.resolveSource
    if (!resolver) return streamUrl(song.id)
    try {
      const url = resolver(song)
      return typeof url === 'string' && url.length > 0 ? url : streamUrl(song.id)
    } catch {
      return streamUrl(song.id)
    }
  }

  /** 订阅状态变化，返回退订函数。 */
  onStateChange(cb: (state: PlayerState) => void): () => void {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  /** 订阅「当前曲播完」，返回退订函数。 */
  onEnded(cb: (song: Song | null) => void): () => void {
    this.endedListeners.add(cb)
    return () => {
      this.endedListeners.delete(cb)
    }
  }

  // --- 播放控制 -----------------------------------------------------------

  /**
   * 播放一首歌。
   *
   * 顺序：
   * 1. **先判格式**：Chromium 不可解 → 写可读错误、**不播放**（不静默失败）；
   * 2. 懒创建音频元素与 `AudioContext`（第一次真正播放时才建）；
   * 3. 把 `audio.src` 指到 `fnm://srv/track/stream?guid=…`；
   * 4. 起播并推进进度。
   */
  play(song: Song): void {
    const undecodable = undecodableFormat(song.codec, songFormatExtension(song))
    if (undecodable !== null) {
      // 不可解格式：**不静默失败**——停下当前播放并把可读错误写进状态。
      this.stopTicking()
      this.playing = false
      this.currentSong = song
      this.positionSec = 0
      this.durationSec = song.duration
      this.errorMessage = formatUnsupportedMessage(undecodable)
      this.element?.pause()
      this.emit()
      return
    }

    const element = this.ensureAudioElement()
    if (!element) return
    if (!this.ensureAudioGraph(element)) return

    this.errorMessage = null
    this.currentSong = song
    this.positionSec = 0
    this.durationSec = song.duration

    const url = this.resolveSource(song)
    if (this.currentSrc() === url) {
      // 同一首重播：回到开头，**不要**重设 src（重设 src 会让媒体元素重新加载）。
      element.currentTime = 0
    } else {
      // ⚠️ 换歌 = 引擎**自己**改 `src`：媒体元素必然中止上一次加载
      //    （Chromium 发 `abort` → `emptied` → `loadstart`，**不发** `error`）。
      //    置「自主动作」标记：这个 `abort` 不是加载失败，不能写错误。
      this.selfInitiatedLoad = true
      // ⚠️ 轮次号必须**先**自增再改 `src`：改 `src` 会触发媒体元素的加载算法，
      //    它会把**上一首**尚未兑现的 `play()` Promise 以 `AbortError` 拒掉。
      //    先自增 → 那个拒绝处理器跑起来时，轮次号已经变了 → 判定为「换歌自主动作」。
      this.loadGeneration += 1
      element.src = url
    }

    this.playing = true
    this.emit()
    this.startTicking()
    this.invokePlay(element)
  }

  /** 暂停。 */
  pause(): void {
    this.element?.pause()
    this.playing = false
    this.stopTicking()
    this.emit()
  }

  /** 继续播放。 */
  resume(): void {
    const element = this.element
    if (!element) return
    this.playing = true
    this.emit()
    this.startTicking()
    this.invokePlay(element)
  }

  /** 定位（**秒**）；越界会被钳制。 */
  seek(sec: number): void {
    const value = typeof sec === 'number' && Number.isFinite(sec) ? sec : 0
    const max = this.durationSec > 0 ? this.durationSec : Number.POSITIVE_INFINITY
    const clamped = Math.min(Math.max(value, 0), max)
    const element = this.element
    if (element) element.currentTime = clamped
    this.positionSec = clamped
    this.emit()
  }

  /**
   * 设置音量（**钳制到 [0,1]**）。
   *
   * `NaN` **忽略**（不让非法值进 store）；`±Infinity` 被钳到边界。
   * ⚠️ 音量 0 与 `muted` 是两回事，本任务不碰静音。
   */
  setVolume(v: number): void {
    if (typeof v !== 'number' || Number.isNaN(v)) return
    const clamped = Math.min(Math.max(v, 0), 1)
    this.volumeValue = clamped
    if (this.element) this.element.volume = clamped
    // ⚠️ **播放前设的音量不能丢**：此时 `this.element` 还没被接管（`ensureAudioElement`
    //    要到第一次 `play()` 才跑），但注入的元素**已经存在**。
    //    应用恢复上次的音量、或用户在首播前拖过音量条，都走这条路。
    //    否则第一首歌会按音量 1 播，用户以为设置没生效。
    else if (this.injectedElement) this.injectedElement.volume = clamped
    if (this.gain) this.gain.gain.value = clamped
    this.emit()
  }

  /** 同步队列（只读镜像，供状态快照使用）。 */
  setQueue(songs: Song[]): void {
    this.queueItems = Array.isArray(songs) ? [...songs] : []
    this.emit()
  }

  /** 同步播放模式。 */
  setMode(mode: PlayMode): void {
    this.modeValue = mode
    this.emit()
  }

  // --- Task 21（EQ）接缝 ---------------------------------------------------

  /**
   * 装 / 卸 EQ 链。
   *
   * - 传 `builder` → 装上 Task 21 的链；
   * - 传 `null` → 卸掉，回到旁路（`source → gain`）。
   *
   * **幂等**：重复安装不会把音量翻倍（见 `applyEqChain`）。
   * **播放前调用也有效**：builder 会被记住，等音频图建好时自动接上。
   */
  setEqChain(builder: EqChainBuilder | null): void {
    this.installEqChain(builder)
  }

  /**
   * 暴露音频节点给 Task 21。
   *
   * @returns 音频图节点；**还没建**（用户还没播过）时返回 `null`。
   */
  getAudioNodes(): PlayerAudioNodes | null {
    if (!this.context || !this.source || !this.gain) return null
    return { context: this.context, source: this.source, gain: this.gain, eq: this.eqChain }
  }

  /** 释放资源（关掉音频上下文、断开节点）。 */
  dispose(): void {
    this.stopTicking()
    for (const [type, listener] of this.mediaListeners) {
      this.element?.removeEventListener(type, listener)
    }
    this.mediaListeners.length = 0
    if (this.source) {
      try {
        this.source.disconnect()
      } catch {
        // 忽略
      }
    }
    if (this.gain) {
      try {
        this.gain.disconnect()
      } catch {
        // 忽略
      }
    }
    void this.context?.close?.()
    this.context = null
    this.source = null
    this.gain = null
    this.eqChain = null
    // ⚠️ **媒体元素必须一起丢掉**：同一个 `<audio>` 元素**只能** createMediaElementSource
    //    一次（真实浏览器第二次会抛 InvalidStateError）。`dispose()` 之后再 `play()` 时
    //    必须**新建元素 + 重建音频图 + 重挂媒体事件监听**（要求 B 的不变量）；
    //    否则会出现「被 catch 成『音频引擎初始化失败：当前环境不支持 Web Audio』」
    //    的误导性错误，且 timeupdate / ended / error 全部失联、进度不再推进。
    this.element = null
    this.injectedElement = null
    this.selfInitiatedLoad = false
    // ⚠️ 轮次号**只增不减**（这里 +1 而不是归零）：`dispose()` 丢弃了当前加载，
    //    旧元素上还没兑现的 `play()` Promise 若随后被拒（`AbortError`），
    //    轮次号已变 → 判定为「被丢弃的自主动作」→ 不写错误。
    this.loadGeneration += 1
    this.playing = false
  }

  // --- 内部：音频元素与音频图 ---------------------------------------------

  /** 懒创建（或取回）`<audio>` 元素，并挂上事件监听。 */
  private ensureAudioElement(): MediaElementLike | null {
    if (this.element) return this.element
    try {
      // ⚠️ `dispose()` 会把注入的元素一起丢掉（同一个元素只能 createMediaElementSource
      //    一次），所以 dispose() 之后再进来时走的是工厂 → **新元素**。
      const element = this.injectedElement ?? this.createAudioElement()
      // 简报既定：`preload="auto"`（只影响**当前**这个元素，不会预取整张专辑）。
      element.preload = 'auto'
      // ⚠️ 接管元素时**必须套用当前音量**：音量可能在播放前就设好了
      //    （恢复上次偏好），元素此刻还是默认的 1 → 第一首歌会满音量播。
      element.volume = this.volumeValue
      this.element = element
      this.attachMediaListeners(element)
      return element
    } catch {
      this.errorMessage = '音频播放失败：无法创建媒体元素'
      this.emit()
      return null
    }
  }

  /**
   * 懒创建音频图（`AudioContext` + `MediaElementAudioSourceNode` + `GainNode`）。
   *
   * **只在第一次真正播放时调用**——用户还没播就建 `AudioContext`，浏览器会把它挂起。
   */
  private ensureAudioGraph(element: MediaElementLike): boolean {
    if (this.context && this.source && this.gain) return true
    try {
      const context = this.createAudioContextFactory()
      const gain = context.createGain()
      gain.gain.value = this.volumeValue
      // ⚠️ 同一个媒体元素**只能** createMediaElementSource 一次（第二次抛 InvalidStateError）。
      const source = context.createMediaElementSource(element)

      this.context = context
      this.gain = gain
      this.source = source

      // 旁路：source → gain → destination（gain → destination 只连一次，不会翻倍）。
      source.connect(gain)
      gain.connect(context.destination)
    } catch {
      this.context = null
      this.gain = null
      this.source = null
      this.playing = false
      this.errorMessage = '音频引擎初始化失败：当前环境不支持 Web Audio'
      this.emit()
      return false
    }

    // 播放前就装好的 EQ，在这里补上。
    if (this.pendingEqBuilder) {
      this.installEqChain(this.pendingEqBuilder)
    }
    return true
  }

  /** 装 / 卸 EQ 链（内部实现）。 */
  private installEqChain(builder: EqChainBuilder | null): void {
    if (!this.source || !this.gain || !this.context) {
      // 音频图还没建 → 记住 builder，建图时补装。
      this.pendingEqBuilder = builder
      return
    }
    const next = builder
      ? builder.build({ context: this.context, source: this.source, gain: this.gain })
      : null
    this.eqChain = applyEqChain({ source: this.source, gain: this.gain }, next, this.eqChain)
    this.pendingEqBuilder = null
  }

  /** 当前 `src`（用于判断是不是同一首）。 */
  private currentSrc(): string {
    return this.element?.src ?? ''
  }

  /**
   * 调 `audio.play()` 并处理异步拒绝。
   *
   * ⚠️ 记下「这次 `play()` 调用属于**哪一轮加载**」（`loadGeneration`），
   *    好在 Promise 被拒时区分「换歌导致的中止」与「真实的中止」（见 `loadGeneration`）。
   */
  private invokePlay(element: MediaElementLike): void {
    const generation = this.loadGeneration
    let result: Promise<void> | void
    try {
      result = element.play()
    } catch {
      this.handlePlayRejection({ name: 'NotSupportedError' }, generation)
      return
    }
    if (isPromiseLike(result)) {
      result.then(undefined, (error: unknown) => this.handlePlayRejection(error, generation))
    }
  }

  // --- 内部：媒体事件 -----------------------------------------------------

  /** 给媒体元素挂事件监听。 */
  private attachMediaListeners(element: MediaElementLike): void {
    const bindings: Array<[string, MediaEventListener]> = [
      ['timeupdate', () => this.handleTimeUpdate()],
      ['durationchange', () => this.handleDurationChange()],
      ['play', () => {
        this.playing = true
        this.emit()
      }],
      ['pause', () => {
        this.playing = false
        this.stopTicking()
        this.emit()
      }],
      ['ended', () => this.handleEnded()],
      ['error', (event) => this.handleMediaError(event)],
      ['stalled', () => this.handleStalled()],
      ['emptied', () => this.handleLoadCycleStart()],
      ['loadstart', () => this.handleLoadCycleStart()],
      ['abort', () => this.handleAbort()],
    ]
    for (const [type, listener] of bindings) {
      element.addEventListener(type, listener)
      this.mediaListeners.push([type, listener])
    }
  }

  /** `timeupdate`：进度以媒体元素为准。 */
  private handleTimeUpdate(): void {
    const element = this.element
    if (!element) return
    const time = element.currentTime
    if (typeof time === 'number' && Number.isFinite(time)) {
      this.setPosition(time)
    }
  }

  /** `durationchange`：媒体元素给出的时长更准。 */
  private handleDurationChange(): void {
    const element = this.element
    if (!element) return
    const duration = element.duration
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      this.durationSec = duration
      this.emit()
    }
  }

  /** `ended`：本曲播完，通知订阅者（由 store 决定下一首）。 */
  private handleEnded(): void {
    this.playing = false
    this.stopTicking()
    if (this.durationSec > 0) this.positionSec = this.durationSec
    this.emit()
    const song = this.currentSong
    for (const listener of [...this.endedListeners]) listener(song)
  }

  /** `error` 事件：媒体错误 / 网络错误。 */
  private handleMediaError(event: unknown): void {
    const code = readMediaErrorCode(event)
    // ⚠️ 防御性兜底：`code === 1`（MEDIA_ERR_ABORTED）若落在**换歌自主动作**的窗口里，
    //    那是引擎自己引发的中止，不是加载失败——不能把正在播放的新歌打成
    //    `playing = false` + 假错误。
    //    （实测 Chromium 改 `src` 时**只**发 `abort`、**不发** `error`，
    //     所以这条分支平时走不到；留着是为了别的内核不踩同一个坑。）
    if (code === 1 && this.selfInitiatedLoad) return
    const info = describeMediaError(code)
    this.errorMessage = info.message
    this.playing = false
    this.stopTicking()
    this.emit()
  }

  /** `stalled` 事件：加载停滞（网络类）。 */
  private handleStalled(): void {
    this.errorMessage = '音频加载停滞：网络较慢或连接中断'
    this.emit()
  }

  /**
   * `emptied` / `loadstart`：媒体**新一轮**加载开始了。
   *
   * 「自主动作」标记到此作废：此后到达的 `abort` / `error` 都属于新一轮加载，
   * 是**真实**的加载失败，必须报错（所以这个标记不会吞掉后续的真实错误）。
   */
  private handleLoadCycleStart(): void {
    this.selfInitiatedLoad = false
  }

  /**
   * `abort`：媒体加载被中止。
   *
   * **判据（什么算真实错误）**：
   * - **引擎自己换歌**引发的 abort → **不是错误**（直接忽略）。
   *   Chromium 改 `audio.src` 时的加载算法必然发 `abort`（随后 `emptied`、
   *   `loadstart`，**不发** `error`）——那是引擎的**自主动作**，不是加载失败。
   * - 其余 abort → **真实错误**：引擎之外改了 `src` / 调了 `load()`，
   *   或 UA 主动中止了资源选择 → 写入可读文案。
   *
   * 之所以不吞掉真实 abort：「自主动作」标记在 `emptied` / `loadstart` 时清零，
   * 新一轮加载开始之后到达的 abort 一律照常报错。
   *
   * ⚠️ 真实 abort 与 `handlePlayRejection` 的 `AbortError` 分支**行为一致**：
   *    都要 `playing = false` + `stopTicking()`——真实中止后媒体元素已经停了，
   *    UI 却还显示「正在播放」是错的。
   *    但**引擎自己换歌**引发的 abort 仍然**只静默忽略**（不得停播放）。
   */
  private handleAbort(): void {
    if (this.selfInitiatedLoad) return
    this.errorMessage = '音频加载被中止'
    this.playing = false
    this.stopTicking()
    this.emit()
  }

  /**
   * `play()` 的 Promise 被拒。
   *
   * @param error      被拒的原因（读它的 `name`）。
   * @param generation **发起这次 `play()` 时**的加载轮次号（见 `loadGeneration`）。
   */
  private handlePlayRejection(error: unknown, generation: number): void {
    const name = readErrorName(error)
    // ⚠️ **换歌导致的中止不算错误**：`AbortError` 说明这次 `play()` 所属的加载被中止了。
    //    若轮次号已经变了 → 引擎在这之后**换过歌** → 是**自主动作**，不是加载失败：
    //    既不写错误，也**不动 `playing`**（新歌照播，旧歌那个 Promise 只是被拒了）。
    //    轮次号没变 → 没有任何引擎自主动作介入 → **真实**的中止 → 照常报错。
    if (name === 'AbortError' && generation !== this.loadGeneration) return
    switch (name) {
      case 'NotAllowedError':
        this.errorMessage = '浏览器阻止了自动播放，请手动点击播放按钮'
        break
      case 'NotSupportedError':
        this.errorMessage = '该音频无法播放：当前内核不支持该格式'
        break
      case 'AbortError':
        this.errorMessage = '音频加载被中止'
        break
      case 'NetworkError':
        this.errorMessage = '音频加载失败：网络错误或连接中断'
        break
      default:
        this.errorMessage = '音频播放失败'
        break
    }
    this.playing = false
    this.stopTicking()
    this.emit()
  }

  // --- 内部：进度推进 -----------------------------------------------------

  /** 启动帧循环（推进进度）。 */
  private startTicking(): void {
    if (this.frameHandle !== null) return
    this.lastTick = this.now()
    this.frameHandle = this.requestFrame(this.tick)
  }

  /** 停掉帧循环。 */
  private stopTicking(): void {
    if (this.frameHandle === null) return
    this.cancelFrame(this.frameHandle)
    this.frameHandle = null
  }

  /**
   * 帧回调：用**注入的时钟**推进进度。
   *
   * 媒体元素给了 `currentTime` 就用它（准）；没给（jsdom / 尚未开始读）就用
   * 时钟外推（`position + 经过的秒数`）。
   */
  private readonly tick = (): void => {
    this.frameHandle = null
    if (!this.playing) return

    const now = this.now()
    const elapsed = Math.max(0, now - this.lastTick) / 1000
    this.lastTick = now

    const element = this.element
    const mediaTime = element ? element.currentTime : 0
    if (typeof mediaTime === 'number' && Number.isFinite(mediaTime) && mediaTime > 0) {
      this.setPosition(mediaTime)
    } else {
      this.setPosition(this.positionSec + elapsed)
    }

    this.startTicking()
  }

  /** 写进度（越界钳制；变了才广播）。 */
  private setPosition(value: number): void {
    if (!Number.isFinite(value)) return
    const max = this.durationSec > 0 ? this.durationSec : Number.POSITIVE_INFINITY
    const clamped = Math.min(Math.max(value, 0), max)
    if (clamped === this.positionSec) return
    this.positionSec = clamped
    this.emit()
  }

  // --- 内部：广播 ---------------------------------------------------------

  /** 广播状态快照。 */
  private emit(): void {
    if (this.stateListeners.size === 0) return
    const snapshot = this.state
    for (const listener of [...this.stateListeners]) listener(snapshot)
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 像不像 Promise。 */
function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** 从媒体错误事件里读 `MediaError.code`。 */
function readMediaErrorCode(event: unknown): number | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const target = (event as { target?: unknown }).target
  if (typeof target !== 'object' || target === null) return undefined
  const error = (target as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/** 从任意异常里读 `name`（`DOMException` 不是 `Error` 的实例，要单独取）。 */
function readErrorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}
