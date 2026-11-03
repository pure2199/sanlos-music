// 软件 EQ（**渲染进程**，Task 21）。
//
// ---------------------------------------------------------------------------
// 职责
// ---------------------------------------------------------------------------
// - 纯逻辑：`buildBands` / `applyPreset` / 数据模型（预设基线 vs 手动偏移）；
// - `EqChain`：在 `AudioContext` 上串联 N 个 `BiquadFilterNode`（`type: 'peaking'`），
//   并保证**旁路切换与段数切换都是幂等的**；
// - 两个入口：媒体元素源（`<audio>`）与 PCM（`AudioBuffer`）——**两条音频路径共用一套 EQ**。
//
// ---------------------------------------------------------------------------
// 常量（追加要求 A）
// ---------------------------------------------------------------------------
// ⚠️ 频点 / Q / 增益上限 / 10 条预置曲线**全部从 `shared/constants.ts` import**，
//    **本文件不重定义任何一份**（两套真相源必然漂移）。
//
// ---------------------------------------------------------------------------
// 数据模型（追加要求 C —— 定死，Task 20b 与 UI 都依赖它）
// ---------------------------------------------------------------------------
//   presetKey: string          // 当前选中的预置（'flat' | 'pop' | … | 'custom'）
//   presetBaseline: number[]   // 预置曲线在该段数下的原始增益
//   manualOffset: number[]     // 用户手动调整的偏移（每个段）
//   effectiveGain[i] = clamp(presetBaseline[i] + manualOffset[i], -12, +12)
//
// - 选一个预置 → **重置** `manualOffset` 为全 0（`presetKey` 设为该预置）；
// - 拖滑块 → 改 `manualOffset`，`presetKey` 变成 `'custom'`；
// - 「复位」→ `presetKey='flat'`、`manualOffset` 全 0。
//
// ⚠️ **面板显示的两层数值必须与真正送进滤波器的增益一致**——
//    所以「实际增益」一律由 `computeEffectiveGains(presetBaseline, manualOffset)` 算出来，
//    UI 与 `EqChain` 都消费这**同一个**结果。
//
// ---------------------------------------------------------------------------
// 接线（追加要求 D / E）
// ---------------------------------------------------------------------------
// - `source → EQ 链 → gain → destination`：**复用** Task 13 已有的 source node
//   （同一个 `<audio>` 只能 `createMediaElementSource` 一次）；
// - ⚠️ WebAudio 里对同一对节点**重复 `connect()` 会产生重复信号（音量翻倍）**，
//    而 `disconnect()` 不传参会断掉**全部**出边。
//    → 本文件的每次重连都是「**先 disconnect 再 connect**」，保证连接关系**幂等**。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 只用浏览器 API，不 import Node 内置模块或 Electron API；
// - **不碰任何凭证**（EQ 偏好里只有曲线参数）。
// ---------------------------------------------------------------------------

import {
  EQ_BANDS_10,
  EQ_BANDS_15,
  EQ_GAIN_LIMIT,
  EQ_PRESETS,
  EQ_Q,
} from '../../shared/constants'
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioNodeLike,
  BiquadFilterLike,
  EqChainBuilder,
  EqChainContext,
  EqChainNodes,
  GainNodeLike,
} from './engine'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 段数（10 段 / 15 段）。 */
export type EqBandCount = 10 | 15

/** 一段 EQ。 */
export interface EqBand {
  /** 中心频率（Hz）。 */
  frequency: number
  /** 增益（dB，钳制在 ±`EQ_GAIN_LIMIT`）。 */
  gain: number
  /** Q 值（固定 `EQ_Q`）。 */
  q: number
}

/**
 * 「自定义」这个预置 key。
 *
 * ⚠️ 它**不是** `EQ_PRESETS` 里的一条（那里只有 10 条真实曲线），
 *    只是「用户手动改过」的标记。
 */
export const EQ_CUSTOM_PRESET = 'custom'

// ---------------------------------------------------------------------------
// 纯逻辑：频点 / 增益 / 频段
// ---------------------------------------------------------------------------

/**
 * 某一段数下的频点（**副本**）。
 *
 * ⚠️ 返回副本：`EQ_BANDS_10` / `EQ_BANDS_15` 是**共享常量**，
 *    把数组本体交出去的话，调用方一改就污染了全局。
 */
export function eqFrequencies(count: EqBandCount): number[] {
  return count === 15 ? [...EQ_BANDS_15] : [...EQ_BANDS_10]
}

/**
 * 增益钳制（到 ±`EQ_GAIN_LIMIT`）。
 *
 * `NaN` / `Infinity` / 非数字 → **0**（不让非法值进滤波器）。
 */
export function clampEqGain(gain: number): number {
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return 0
  return Math.min(Math.max(gain, -EQ_GAIN_LIMIT), EQ_GAIN_LIMIT)
}

/**
 * 造出该段数下的频段列表。
 *
 * @param count 段数（10 / 15）。
 * @param gains 各段增益（dB）；不够的补 0、多余的忽略、越界的钳制。
 */
export function buildBands(count: EqBandCount, gains: number[]): EqBand[] {
  const safe = Array.isArray(gains) ? gains : []
  return eqFrequencies(count).map((frequency, index) => ({
    frequency,
    gain: clampEqGain(safe[index] ?? 0),
    q: EQ_Q,
  }))
}

/**
 * 「预置基线 + 手动偏移」后钳制到 ±12 dB。
 *
 * ⚠️ 这是**有效增益**的计算口径（追加要求 C）：`applyPreset(手动偏移, 预设)`。
 *
 * @param gains  手动偏移（每个段）。
 * @param preset 预置 key（`EQ_PRESETS` 的 key；未知则原样返回）。
 * @param count  段数（**可选**）：缺省按 `gains.length` 推断
 *               （10 → `gains`，15 → `gains15`；其余长度按 10 段算）。
 */
export function applyPreset(
  gains: number[],
  preset: string,
  count?: EqBandCount,
): number[] {
  const source = Array.isArray(gains) ? gains : []
  const baseline = presetBaselineFor(preset, count ?? inferBandCount(source.length))
  // ⚠️ 未知预置 → **原样返回**（简报的既有断言）。
  if (!isEqPresetKey(preset)) return [...source]

  const result: number[] = []
  for (let index = 0; index < source.length; index += 1) {
    const base = baseline[index] ?? 0
    const offset = source[index] ?? 0
    result.push(clampEqGain(base + offset))
  }
  return result
}

/** 按数组长度推断段数（10 / 15；其余按 10 段算）。 */
function inferBandCount(length: number): EqBandCount {
  return length === 15 ? 15 : 10
}

// ---------------------------------------------------------------------------
// 纯逻辑：数据模型
// ---------------------------------------------------------------------------

/** 是不是一条**真实**的预置曲线（`'custom'` 与原型链上的键都不算）。 */
export function isEqPresetKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false
  return Object.prototype.hasOwnProperty.call(EQ_PRESETS, key)
}

/**
 * 某预置在某段数下的基线增益。
 *
 * ⚠️ 10 段取 `gains`、15 段取 `gains15`——**两套频点不同，不可互相切片**。
 * 未知预置（含 `'custom'`）→ 全 0（**不抛异常**）。
 */
export function presetBaselineFor(presetKey: string, count: EqBandCount): number[] {
  const size = count === 15 ? 15 : 10
  const preset = isEqPresetKey(presetKey) ? EQ_PRESETS[presetKey] : undefined
  if (!preset) return new Array(size).fill(0)
  const gains = count === 15 ? preset.gains15 : preset.gains
  const result = new Array<number>(size).fill(0)
  for (let index = 0; index < size; index += 1) {
    result[index] = clampEqGain(gains[index] ?? 0)
  }
  return result
}

/**
 * 有效增益 = `clamp(基线 + 手动偏移, ±12)`。
 *
 * ⚠️ 这是**面板显示的「实际增益」**与**真正送进滤波器的增益**的唯一口径。
 * 长度不一致时按可用长度取值，**缺项当 0**（不抛异常）。
 */
export function computeEffectiveGains(baseline: number[], offset: number[]): number[] {
  const base = Array.isArray(baseline) ? baseline : []
  const off = Array.isArray(offset) ? offset : []
  const length = Math.max(base.length, off.length)
  const result: number[] = []
  for (let index = 0; index < length; index += 1) {
    const rawBase = base[index]
    const rawOffset = off[index]
    const baseValue = typeof rawBase === 'number' && Number.isFinite(rawBase) ? rawBase : 0
    const offsetValue =
      typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? rawOffset : 0
    result.push(clampEqGain(baseValue + offsetValue))
  }
  return result
}

/**
 * 按**频率值**把一排数值映射到另一种段数。
 *
 * ⚠️ **按频率匹配，不是按索引**——10 段与 15 段只有部分频点重合
 *    （63 / 250 / 1000 / 4000 / 16000），按索引映射会把增益贴到错误的频点上。
 * 匹配不上的置 0。
 */
export function remapByFrequency(
  values: number[],
  from: EqBandCount,
  to: EqBandCount,
): number[] {
  const source = Array.isArray(values) ? values : []
  const fromFreqs = eqFrequencies(from)
  const toFreqs = eqFrequencies(to)
  return toFreqs.map((frequency) => {
    const index = fromFreqs.indexOf(frequency)
    if (index < 0) return 0
    const value = source[index]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  })
}

/** EQ 的完整设置（追加要求 C 的四元组 + 段数与开关）。 */
export interface EqSettings {
  /** 当前选中的预置（`'flat'` / `'pop'` / … / `'custom'`）。 */
  presetKey: string
  /** 预置基线（当前段数下的原始增益）。 */
  presetBaseline: number[]
  /** 用户手动调整的偏移（每个段）。 */
  manualOffset: number[]
  /** 段数。 */
  bandCount: EqBandCount
  /** EQ 是否启用（关掉 = 旁路）。 */
  enabled: boolean
}

/** 默认设置：平直、10 段、启用。 */
export function defaultEqSettings(): EqSettings {
  return {
    presetKey: 'flat',
    presetBaseline: presetBaselineFor('flat', 10),
    manualOffset: new Array(10).fill(0),
    bandCount: 10,
    enabled: true,
  }
}

// ---------------------------------------------------------------------------
// 偏好持久化（追加要求 F —— 可注入，通道待 Task 17）
// ---------------------------------------------------------------------------

/**
 * 要落进 `prefs.json` 的那部分 EQ 设置。
 *
 * ⚠️ **绝不含凭证**（这里只有曲线参数）。
 */
export interface EqPrefs {
  /** 选中的预置（`'custom'` 也合法）。 */
  presetKey: string
  /** 手动偏移（每个段）。 */
  manualOffset: number[]
  /** 段数。 */
  bandCount: EqBandCount
  /** 是否启用。 */
  enabled: boolean
  /**
   * 预置基线（**可选**）。
   *
   * 存了就能**无损**恢复「自定义」曲线（否则重启后基线丢失，
   * 原本「基线 + 偏移」会退化成「只有偏移」）。缺省时按 `presetKey` 反推。
   */
  presetBaseline?: number[]
}

/**
 * EQ 偏好的持久化端口（**可注入**）。
 *
 * ⚠️ **本任务不自己造 IPC 通道**：Task 17 正在建 `prefs:get` / `prefs:set`，
 *    通道到位后用 `createEqPrefsPort` 把那两个函数接上即可（见报告）。
 */
export interface EqPrefsPort {
  /** 读取偏好（没有就返回 `null`）。 */
  load(): Promise<EqPrefs | null>
  /** 写入偏好。 */
  save(prefs: EqPrefs): Promise<void>
}

/**
 * 由两个函数造一个持久化端口。
 *
 * @param load 读取（Task 17 的 `prefs:get`）。
 * @param save 写入（Task 17 的 `prefs:set`）。
 */
export function createEqPrefsPort(
  load: () => Promise<EqPrefs | null>,
  save: (prefs: EqPrefs) => Promise<void>,
): EqPrefsPort {
  return { load, save }
}

/**
 * 把任意来源的数据**校验**成 EQ 偏好。
 *
 * ⚠️ `prefs.json` 是**用户可编辑的文件**——外部数据一律当不可信输入处理：
 *    段数只认 10 / 15、增益逐个钳制、预置 key 只认已知 key（其余当 `'custom'`）。
 *
 * @returns 合法的偏好；无法解析时返回 `null`。
 */
export function normalizeEqPrefs(value: unknown): EqPrefs | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Partial<EqPrefs>
  const bandCount: EqBandCount = raw.bandCount === 15 ? 15 : 10
  const presetKey =
    typeof raw.presetKey === 'string' && raw.presetKey.length > 0
      ? raw.presetKey
      : EQ_CUSTOM_PRESET
  const offsetSource = Array.isArray(raw.manualOffset) ? raw.manualOffset : []
  const manualOffset: number[] = []
  for (let index = 0; index < bandCount; index += 1) {
    const item = offsetSource[index]
    manualOffset.push(typeof item === 'number' && Number.isFinite(item) ? clampEqGain(item) : 0)
  }
  const prefs: EqPrefs = {
    presetKey,
    manualOffset,
    bandCount,
    enabled: raw.enabled !== false,
  }
  // 基线是**可选**的：有就校验后带上（恢复时才能无损）。
  const baselineSource = Array.isArray(raw.presetBaseline) ? raw.presetBaseline : null
  if (baselineSource) {
    const baseline: number[] = []
    for (let index = 0; index < bandCount; index += 1) {
      const item = baselineSource[index]
      baseline.push(typeof item === 'number' && Number.isFinite(item) ? clampEqGain(item) : 0)
    }
    prefs.presetBaseline = baseline
  }
  return prefs
}

// ---------------------------------------------------------------------------
// EQ 链
// ---------------------------------------------------------------------------

/**
 * EQ 链用到的 `AudioContext` 最小接口。
 *
 * `engine.ts` 的 `AudioContextLike` **结构兼容**它。
 */
export interface EqAudioContext {
  /** 创建增益节点（链的输入 / 输出端）。 */
  createGain(): GainNodeLike
  /** 创建 peaking 滤波器（**可选**：没有就退化成直通，不生效但不崩）。 */
  createBiquadFilter?(): BiquadFilterLike
  /** 创建 PCM 源节点（**可选**：没有就不能走 PCM 入口）。 */
  createBufferSource?(): AudioBufferSourceNodeLike
}

/** PCM 入口的产物：EQ 链 + 播放该 PCM 的源节点。 */
export interface PcmEqChainNodes extends EqChainNodes {
  /** 播放这段 PCM 的源节点（已经接到链的输入上）。 */
  bufferSource: AudioBufferSourceNodeLike
}

/** `EqChain` 的构造参数。 */
export interface EqChainOptions {
  /** 段数（缺省 10）。 */
  bandCount?: EqBandCount
  /** 各段增益（缺省全 0）。 */
  gains?: number[]
  /** 是否启用（缺省启用）。 */
  enabled?: boolean
}

/**
 * 软件 EQ 链。
 *
 * 内部拓扑：`input → f0 → f1 → … → fN-1 → output`；
 * 旁路时：`input → output`（滤波器全部断开）。
 *
 * ⚠️ **幂等**是这里的第一要务：
 * - 每次重连都是「先 `disconnect` 再 `connect`」；
 * - 重复 `attach` / 反复 `setEnabled` **不会**产生第二条并行路径（否则音量翻倍）。
 */
export class EqChain implements EqChainBuilder {
  private bandCount: EqBandCount
  private gains: number[]
  private enabled: boolean

  /** 已挂载的上下文（还没挂时为 `null`）。 */
  private context: EqAudioContext | null = null
  /** 链的输入 / 输出端（各是一个增益节点）。 */
  private input: AudioNodeLike | null = null
  private output: AudioNodeLike | null = null
  /** 当前的 peaking 滤波器（按频率顺序）。 */
  private filters: BiquadFilterLike[] = []
  /** 滤镜是在哪个上下文上造的（换上下文要重建）。 */
  private filterContext: EqAudioContext | null = null
  /** 通过 `fromMediaElementSource` 接进来的媒体源（用于幂等重连）。 */
  private mediaSource: AudioNodeLike | null = null

  constructor(options: EqChainOptions = {}) {
    this.bandCount = options.bandCount === 15 ? 15 : 10
    this.gains = normalizeGainList(options.gains ?? [], this.bandCount)
    this.enabled = options.enabled !== false
  }

  // --- Task 13 接缝 --------------------------------------------------------

  /**
   * 造出 EQ 链的输入与输出节点（引擎用它接进音频图）。
   *
   * - **不**自己接媒体源：引擎的 `applyEqChain` 负责 `source → input` / `output → gain`；
   * - 重复调用**幂等**：已挂载时复用同一对端点，只重连一次。
   */
  build(ctx: EqChainContext): EqChainNodes {
    const context = ctx.context
    if (!this.input || !this.output || this.context !== context) {
      const input = context.createGain()
      const output = context.createGain()
      this.attach(context, input, output)
      return { input, output }
    }
    this.rewire()
    return { input: this.input, output: this.output }
  }

  // --- 两个入口 ------------------------------------------------------------

  /**
   * 入口 1：**媒体元素源**（`<audio>` 走的那条路）。
   *
   * 把媒体源接到链的输入上（**幂等**：重复调用只有一条边）。
   *
   * @param source 媒体源节点（**Task 13 已建好的那个**，不要重建）。
   * @param ctx    链的上下文。
   */
  fromMediaElementSource(source: AudioNodeLike, ctx: EqChainContext): EqChainNodes {
    const nodes = this.build(ctx)
    // ⚠️ 先断开这一条边再接——否则重复调用会多一条并行路径（音量翻倍）。
    if (this.mediaSource) {
      safeDisconnect(this.mediaSource, nodes.input)
    }
    source.connect(nodes.input)
    this.mediaSource = source
    return nodes
  }

  /**
   * 入口 2：**PCM**（`AudioBuffer`，Task 20b 的 FFmpeg 解码路径）。
   *
   * 造一个缓冲源节点、挂上 PCM、接进链的输入。
   * 调用方拿到 `bufferSource` 后自己 `start()`。
   *
   * ⚠️ 上下文不支持 `createBufferSource` 时**抛错**——PCM 路径没有它就无从播放，
   *    与其静默失败不如让调用方明确知道。
   */
  fromAudioBuffer(buffer: AudioBufferLike, ctx: EqChainContext): PcmEqChainNodes {
    const create = ctx.context.createBufferSource
    if (!create) {
      throw new Error('当前音频上下文不支持 PCM 源节点（createBufferSource 不可用）')
    }
    const nodes = this.build(ctx)
    const source = create.call(ctx.context)
    source.buffer = buffer
    source.connect(nodes.input)
    return { input: nodes.input, output: nodes.output, bufferSource: source }
  }

  // --- 挂载与连线 ----------------------------------------------------------

  /**
   * 把链挂到已有的图上（**幂等**）。
   *
   * @param ctx    音频上下文。
   * @param input  链的输入端。
   * @param output 链的输出端。
   */
  attach(ctx: EqAudioContext, input: AudioNodeLike, output: AudioNodeLike): void {
    this.context = ctx
    this.input = input
    this.output = output
    this.ensureFilters(ctx)
    this.rewire()
  }

  /** 当前链的输入 / 输出端（还没挂载时返回 `null`）。 */
  getNodes(): EqChainNodes | null {
    if (!this.input || !this.output) return null
    return { input: this.input, output: this.output }
  }

  // --- 参数 ----------------------------------------------------------------

  /**
   * 改某一段的增益（dB）。
   *
   * 越界索引被忽略；增益钳制到 ±12。
   */
  setBandGain(index: number, gain: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.bandCount) return
    const clamped = clampEqGain(gain)
    this.gains[index] = clamped
    const filter = this.filters[index]
    if (filter) filter.gain.value = clamped
  }

  /** 一次改所有段（长度不足的补 0、多余的忽略）。 */
  setGains(gains: number[]): void {
    this.gains = normalizeGainList(gains, this.bandCount)
    this.applyGainsToFilters()
  }

  /**
   * 切换启用 / 旁路（**幂等**：反复切换不会产生重复连接）。
   *
   * 关闭时整条链被旁路：`input → output` 直连，滤波器全部断开。
   */
  setEnabled(on: boolean): void {
    this.enabled = on !== false
    this.rewire()
  }

  /**
   * 切换段数（10 ↔ 15）。
   *
   * 重建滤镜链，**频率相同的段沿用原增益，其余置 0**
   * （按频率匹配，不是按索引）。
   */
  setBandCount(count: EqBandCount): void {
    if (count !== 10 && count !== 15) return
    if (count === this.bandCount) {
      this.rewire()
      return
    }
    const oldFreqs = eqFrequencies(this.bandCount)
    const oldGains = [...this.gains]
    const newFreqs = eqFrequencies(count)
    const newGains = newFreqs.map((frequency) => {
      const index = oldFreqs.indexOf(frequency)
      if (index < 0) return 0
      return oldGains[index] ?? 0
    })
    this.bandCount = count
    this.gains = newGains
    this.rebuildFilters()
    this.rewire()
  }

  /** 当前各段增益（副本）。 */
  getGains(): number[] {
    return [...this.gains]
  }

  /**
   * 当前的滤镜节点（**按频率顺序**，副本）。
   *
   * 换段数时旧的滤镜会被丢弃——想知道「现在生效的是哪几个」看这里。
   */
  getFilters(): BiquadFilterLike[] {
    return [...this.filters]
  }

  /** 当前段数。 */
  getBandCount(): EqBandCount {
    return this.bandCount
  }

  /** 当前是否启用（`false` = 旁路）。 */
  isEnabled(): boolean {
    return this.enabled
  }

  /** 当前频段（含生效增益），给界面用。 */
  getBands(): EqBand[] {
    return buildBands(this.bandCount, this.gains)
  }

  /** 断开所有内部连接（释放用）。 */
  dispose(): void {
    safeDisconnect(this.input)
    for (const filter of this.filters) safeDisconnect(filter)
    this.filters = []
    this.input = null
    this.output = null
    this.context = null
    this.filterContext = null
    this.mediaSource = null
  }

  // --- 内部：滤镜与连线 ----------------------------------------------------

  /** 确保滤镜链存在（数量或上下文变了就重建）。 */
  private ensureFilters(ctx: EqAudioContext): void {
    const create = ctx.createBiquadFilter
    if (!create) {
      // 没有 peaking 滤镜 → 退化成直通（**不生效但不崩**）。
      this.filters = []
      this.filterContext = ctx
      return
    }
    if (this.filters.length === this.bandCount && this.filterContext === ctx) {
      this.applyGainsToFilters()
      return
    }
    this.buildFilters(ctx)
  }

  /** 重建滤镜链（旧的先断开，避免留下孤立的边）。 */
  private rebuildFilters(): void {
    for (const filter of this.filters) safeDisconnect(filter)
    this.filters = []
    this.filterContext = null
    if (!this.context) return
    this.buildFilters(this.context)
  }

  /** 造出 `bandCount` 个 peaking 滤波器。 */
  private buildFilters(ctx: EqAudioContext): void {
    const create = ctx.createBiquadFilter
    if (!create) {
      this.filters = []
      this.filterContext = ctx
      return
    }
    const frequencies = eqFrequencies(this.bandCount)
    for (let index = 0; index < this.bandCount; index += 1) {
      const filter = create.call(ctx)
      filter.type = 'peaking'
      filter.frequency.value = frequencies[index] ?? 0
      filter.Q.value = EQ_Q
      filter.gain.value = this.gains[index] ?? 0
      this.filters.push(filter)
    }
    this.filterContext = ctx
  }

  /** 把当前增益写进滤镜节点。 */
  private applyGainsToFilters(): void {
    for (let index = 0; index < this.filters.length; index += 1) {
      const filter = this.filters[index]
      if (filter) filter.gain.value = this.gains[index] ?? 0
    }
  }

  /**
   * 重建链内部的连接关系（**幂等**的核心）。
   *
   * ⚠️ 顺序固定：**先断开、再连接**。
   *    直接 `connect` 会让同一对节点出现两条边 → 信号叠加 → 音量翻倍。
   */
  private rewire(): void {
    const input = this.input
    const output = this.output
    if (!input || !output) return

    // 拆掉旧连接：输入端的全部出边 + 每个滤波器的出边。
    safeDisconnect(input)
    for (const filter of this.filters) safeDisconnect(filter)

    if (!this.enabled || this.filters.length === 0) {
      // 旁路（或没有滤镜可用）：输入端直连输出端。
      input.connect(output)
      return
    }

    let previous: AudioNodeLike = input
    for (const filter of this.filters) {
      previous.connect(filter)
      previous = filter
    }
    previous.connect(output)
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把任意长度的增益数组整理成「正好 `count` 段、全部合法」的数组。 */
function normalizeGainList(gains: number[], count: EqBandCount): number[] {
  const source = Array.isArray(gains) ? gains : []
  const result: number[] = []
  for (let index = 0; index < count; index += 1) {
    result.push(clampEqGain(source[index] ?? 0))
  }
  return result
}

/**
 * 安全断开。
 *
 * - 不传参 = 断开**全部**出边；
 * - 传参 = 只断开到该目标的那条边。
 *
 * 没连上时 WebAudio 会抛 `InvalidAccessError`——**忽略**即可（不是错误）。
 */
function safeDisconnect(node: AudioNodeLike | null, destination?: unknown): void {
  if (!node) return
  try {
    if (destination === undefined) node.disconnect()
    else node.disconnect(destination)
  } catch {
    // 没连上就是 no-op。
  }
}
