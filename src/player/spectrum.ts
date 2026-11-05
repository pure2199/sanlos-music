// ---------------------------------------------------------------------------
// 频谱采样（T47）
// ---------------------------------------------------------------------------
//
// 职责
// ---------------------------------------------------------------------------
// - 在**主窗口渲染进程**里取当前这一曲的频谱（`AnalyserNode`）；
// - 切成 **8 段对数分布**（低频稀、高频密），每段取区间最大值；
// - 经 IPC 推给主进程 → 转发给**词岛窗**渲染成两端的波形柱。
//
// ---------------------------------------------------------------------------
// 为什么复用现有音频图（而不是 `captureStream`）
// ---------------------------------------------------------------------------
// `src/player/engine.ts` 的 `ensureAudioGraph()` 在**每一次首次播放**时**无条件**建图
// （`createMediaElementSource` → `gain` → `destination`）——**与 EQ 开没开无关**。
// ⇒ 音频**本来就走 Web Audio** → 在同一张图上挂一个 `AnalyserNode`
//    **不新增任何劫持**（不新建 `AudioContext`、不新建解码路径），
//    而且取到的是 **EQ + 音量之后**的信号 = 用户真正听到的。
//
// 探针实测（`release/verify/t47-spectrum-probe.js`，Electron 32.3.3）：
// 两条路都拿得到数据（`peak = 249`）；选这条是因为它**零新增上下文**。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 渲染进程**永不**接触 token：本模块**不出网**，只读本地音频；
// - 频谱是**纯数字**（0–255 的 16 个值），不含任何凭证或曲目信息；
// - `AnalyserNode` **不连 destination** → 只是旁路听一听，**不出声**。
//
// ---------------------------------------------------------------------------
// 降级
// ---------------------------------------------------------------------------
// - 环境没有 `createAnalyser`（老 Chromium / 测试替身）→ **没有频谱**，
//   词岛照常显示歌词，**不崩**；
// - 用户还没播过（音频图还没建）→ 采样器**跳过这一帧**（不推空数据）；
// - 桌面歌词不可见 / 不是词岛形态 → **完全不采样**（不给「顿卡」添新堵点）。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - 不 import Electron；桥通过 `window.fnPlayer` 拿（单测可注入替身）；
// - 全部依赖**可注入** → 单测不需要真的 `AudioContext`。

import type { AppPrefs, PlayerBridge } from '../../shared/playerBridge'
import {
  SPECTRUM_BIN_COUNT,
  SPECTRUM_FALLBACK_SAMPLE_RATE,
  SPECTRUM_FRAME_MS,
  SPECTRUM_MAX_HZ,
  SPECTRUM_MIN_HZ,
} from '../../shared/spectrum'
import { useAppPrefsStore } from '../state/appPrefsStore'
import { playerEngine } from '../state/playerStore'
import type { AnalyserNodeLike } from './engine'

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 频谱源（分析节点 + 采样率）。 */
export interface SpectrumSource {
  /** 频谱分析节点。 */
  analyser: AnalyserNodeLike
  /** 上下文的采样率（Hz）——决定每个频率 bin 的宽度。 */
  sampleRate: number
}

/** 桥的最小子集（便于单测注入假实现）。 */
export interface SpectrumBridge {
  /** 推一条频谱数据（16 个 0–255 的值）。 */
  pushSpectrum(bins: number[]): void
  /** 订阅桌面歌词的可见性（可选）。 */
  onLyricVisibility?(handler: (visible: boolean) => void): () => void
  /** 读回偏好（可选；启动时兜底问一次可见性）。 */
  getPrefs?(): Promise<AppPrefs>
}

/** 「该不该采样」的观察者。 */
export interface SpectrumWatch {
  /** 当前是否该采样。 */
  isEnabled(): boolean
  /** 订阅变化；返回退订函数。 */
  subscribe(handler: () => void): () => void
  /** 释放资源（可选）。 */
  dispose?(): void
}

// ---------------------------------------------------------------------------
// 纯逻辑：线性 bin → 16 段对数分布
// ---------------------------------------------------------------------------

/**
 * 把频谱的**线性** bin 切成 **8 段对数分布**，每段取区间内的**最大值**。
 *
 * ⚠️ **为什么要对数**：FFT 的 bin 是线性刻度（低频挤在左边），
 *    而人对音高的感知接近对数 → 线性切分会让左边 3 段吃掉整个低频、
 *    右边十几段全是高频噪声。
 *
 * ⚠️ **为什么取最大值而不是平均**：平均会把瞬态峰值抹平，
 *    柱子在视觉上就「不跳」；取最大值则每次鼓点都能顶到顶。
 *
 * @param data              频谱数据（长度 = `frequencyBinCount`）。
 * @param frequencyBinCount 频率 bin 的个数（= `fftSize / 2`）。
 * @param sampleRate        采样率（Hz）。
 * @returns 长度 8 的数组（每项 0–255）。
 */
export function toLogBins(
  data: Uint8Array,
  frequencyBinCount: number,
  sampleRate: number,
): number[] {
  const bins: number[] = new Array<number>(SPECTRUM_BIN_COUNT).fill(0)
  if (frequencyBinCount <= 0 || sampleRate <= 0) return bins
  const binHz = sampleRate / (frequencyBinCount * 2)
  if (binHz <= 0) return bins

  const ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ
  for (let i = 0; i < SPECTRUM_BIN_COUNT; i += 1) {
    const from = SPECTRUM_MIN_HZ * Math.pow(ratio, i / SPECTRUM_BIN_COUNT)
    const to = SPECTRUM_MIN_HZ * Math.pow(ratio, (i + 1) / SPECTRUM_BIN_COUNT)
    let low = Math.floor(from / binHz)
    let high = Math.ceil(to / binHz) - 1
    if (low < 0) low = 0
    if (high > frequencyBinCount - 1) high = frequencyBinCount - 1
    // ⚠️ 某一段比一个频率 bin 还窄 → 至少取一个（否则这一段永远是 0）。
    if (high < low) high = low
    let peak = 0
    for (let k = low; k <= high; k += 1) {
      const value = data[k] ?? 0
      if (value > peak) peak = value
    }
    bins[i] = peak
  }
  return bins
}

// ---------------------------------------------------------------------------
// 采样器
// ---------------------------------------------------------------------------

/** 采样器的参数（全部可注入，便于单测）。 */
export interface SpectrumSamplerOptions {
  /** 取频谱源；没有（还没播 / 不支持）时返回 `null`。 */
  getSource: () => SpectrumSource | null
  /** 推一条频谱数据。 */
  push: (bins: number[]) => void
  /** 帧间隔（毫秒）；缺省 42（约 24fps）。 */
  frameMs?: number
  /** 定时器工厂（单测注入假定时器）。 */
  createTimer?: (fn: () => void, ms: number) => number
  /** 定时器取消。 */
  cancelTimer?: (handle: number) => void
}

/** 采样器的对外接口。 */
export interface SpectrumSampler {
  /** 开始采样（已在跑则**不重复**启动）。 */
  start(): void
  /** 停止采样（没在跑则**不重复**停止）。 */
  stop(): void
  /** 当前是否在采样。 */
  isRunning(): boolean
  /** 采样一帧（测试用）；没有源时返回 `null`。 */
  sample(): number[] | null
  /** 释放资源。 */
  dispose(): void
}

/**
 * 造一个频谱采样器。
 *
 * ⚠️ **帧率是硬上限**：每帧只做一次 `getByteFrequencyData` + 一次 IPC 推送。
 */
export function createSpectrumSampler(options: SpectrumSamplerOptions): SpectrumSampler {
  const frameMs = options.frameMs ?? SPECTRUM_FRAME_MS
  const createTimer =
    options.createTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number)
  const cancelTimer = options.cancelTimer ?? ((handle: number) => clearTimeout(handle))

  /** 定时器句柄；`null` = 没在采样。 */
  let handle: number | null = null
  /** 复用的频谱缓冲（避免每帧 new 一个）。 */
  let buffer: Uint8Array | null = null

  const sample = (): number[] | null => {
    const source = options.getSource()
    if (!source) return null
    const analyser = source.analyser
    const count = analyser.frequencyBinCount
    if (!count || count <= 0) return null
    if (!buffer || buffer.length !== count) buffer = new Uint8Array(count)
    analyser.getByteFrequencyData(buffer)
    const bins = toLogBins(buffer, count, source.sampleRate)
    options.push(bins)
    return bins
  }

  const tick = (): void => {
    if (handle === null) return
    sample()
    handle = createTimer(tick, frameMs)
  }

  return {
    start(): void {
      if (handle !== null) return
      handle = createTimer(tick, frameMs)
    },
    stop(): void {
      if (handle === null) return
      cancelTimer(handle)
      handle = null
    },
    isRunning(): boolean {
      return handle !== null
    },
    sample,
    dispose(): void {
      if (handle !== null) {
        cancelTimer(handle)
        handle = null
      }
      buffer = null
    },
  }
}

// ---------------------------------------------------------------------------
// 默认接线
// ---------------------------------------------------------------------------

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function defaultBridge(): SpectrumBridge | null {
  const scope = globalThis as { fnPlayer?: PlayerBridge }
  const bridge = scope.fnPlayer
  if (!bridge) return null
  return {
    pushSpectrum: (bins) => bridge.pushSpectrum(bins),
    onLyricVisibility: (handler) => bridge.onLyricVisibility(handler),
    getPrefs: () => bridge.getPrefs(),
  }
}

/** 从引擎取频谱源（音频图还没建 / 没有 analyser 时返回 `null`）。 */
function defaultGetSource(): SpectrumSource | null {
  const nodes = playerEngine.getAudioNodes?.()
  if (!nodes) return null
  const analyser = nodes.analyser ?? null
  if (!analyser) return null
  return {
    analyser,
    sampleRate: nodes.context.sampleRate ?? SPECTRUM_FALLBACK_SAMPLE_RATE,
  }
}

/**
 * 默认的「该不该采样」观察者。
 *
 * ⚠️ **可见性**走 `lyric:visibility` 事件（主进程推的）→ **托盘切换**也能立刻生效；
 * ⚠️ **形态**走偏好 store（`lyricOverlayMode`）——形态**只在设置页**改，
 *    而设置页就在主窗口里 → store 里的值永远是准的。
 */
function defaultWatch(bridge: SpectrumBridge): SpectrumWatch {
  let visible = false
  /**
   * 是否**已经收到过**可见性事件。
   *
   * ⚠️ 竞态：启动时「读回偏好」是**异步**的，它的 resolve 可能**晚于**一次
   *    可见性事件到达 → 用旧值覆盖新状态（用户刚打开就被关掉）。
   *    → 收到过事件就**不再**用启动时的读取覆盖它。
   */
  let visibilityKnown = false
  const handlers: Array<() => void> = []
  const notify = (): void => {
    for (const handler of handlers.slice()) handler()
  }

  const offVisibility = bridge.onLyricVisibility
    ? bridge.onLyricVisibility((next) => {
        visibilityKnown = true
        visible = next
        notify()
      })
    : () => undefined

  // 形态变了（设置页切换样式）→ 重算。
  const offStore = useAppPrefsStore.subscribe(() => {
    notify()
  })

  // ⚠️ **启动时主动问一次可见性**：主进程可能在渲染进程订阅之前就发过事件。
  void Promise.resolve(bridge.getPrefs?.())
    .then((prefs) => {
      if (visibilityKnown) return
      visible = prefs?.lyricOverlay?.visible === true
      notify()
    })
    .catch(() => undefined)

  return {
    isEnabled: () => visible && useAppPrefsStore.getState().lyricOverlayMode === 'island',
    subscribe: (handler) => {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    dispose: () => {
      offVisibility()
      offStore()
      handlers.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/** `installSpectrum` 的参数（全部可注入，便于单测）。 */
export interface SpectrumInstallOptions {
  /** 桥；不传则取 `window.fnPlayer`（没有则整个模块**不装**）。 */
  bridge?: SpectrumBridge | null
  /** 取频谱源；不传则从引擎取。 */
  getSource?: () => SpectrumSource | null
  /** 「该不该采样」的观察者；不传则用默认（可见性事件 + 偏好 store）。 */
  watch?: SpectrumWatch
  /** 帧间隔（毫秒）。 */
  frameMs?: number
  /** 定时器工厂（单测注入）。 */
  createTimer?: (fn: () => void, ms: number) => number
  /** 定时器取消（单测注入）。 */
  cancelTimer?: (handle: number) => void
}

/** 装配结果（供单测断言）。 */
export interface SpectrumHandle {
  /** 当前是否在采样（= 桌面歌词可见 **且** 形态 = 词岛）。 */
  isEnabled(): boolean
  /** 退订。 */
  dispose(): void
}

/**
 * 装配「频谱采样与推送」。
 *
 * @returns 装配句柄；**没有桥**时返回 `null`（浏览器预览 / 单测）。
 */
export function installSpectrum(options: SpectrumInstallOptions = {}): SpectrumHandle | null {
  const bridge = options.bridge === undefined ? defaultBridge() : options.bridge
  if (!bridge) return null

  const getSource = options.getSource ?? defaultGetSource
  const watch = options.watch ?? defaultWatch(bridge)
  const sampler = createSpectrumSampler({
    getSource,
    push: (bins) => bridge.pushSpectrum(bins),
    frameMs: options.frameMs,
    createTimer: options.createTimer,
    cancelTimer: options.cancelTimer,
  })

  const sync = (): void => {
    if (watch.isEnabled()) sampler.start()
    else sampler.stop()
  }

  const unsubscribe = watch.subscribe(sync)
  sync()

  return {
    isEnabled: () => watch.isEnabled(),
    dispose(): void {
      unsubscribe()
      watch.dispose?.()
      sampler.dispose()
    },
  }
}
