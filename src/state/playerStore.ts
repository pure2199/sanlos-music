// 播放器状态（**渲染进程**，zustand）。
//
// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------
// 字段与 `shared/types.ts` 的 `PlayerState` 对齐：
// `current` / `queue` / `isPlaying` / `position` / `duration` / `volume` / `mode` / `error`
// （另有可选的 `muted`）。
//
// 动作：`playTrack` / `togglePlay` / `next` / `prev` / `seek` / `setVolume` / `setMode`。
//
// ---------------------------------------------------------------------------
// 约定
// ---------------------------------------------------------------------------
// - `position` / `duration` 单位是**秒**（与 `Song.duration` 同单位——
//   `Song.duration` 已是**秒**，不是毫秒，别再犯 1000× 的静默误差）；
// - `volume` 取值范围 `[0,1]`（越界钳制，`NaN` 忽略）；
// - **store 里不放任何凭证**（token / 密码 / Cookie）——那些只存在于主进程；
// - 播放相关的事（真正起播、seek、音量）交给 `PlayerEngine`，store 只做状态编排；
// - 队列语义由 `src/player/queue.ts` 的 `Queue` 统一实现（next/prev/remove/add/shuffle）。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。

import { create } from 'zustand'

import type { PlayMode, PlayerState, Song } from '../../shared/types'
import { PlayerEngine, type PlayerEngineLike } from '../player/engine'
import {
  EqChain,
  EQ_CUSTOM_PRESET,
  buildBands,
  clampEqGain,
  computeEffectiveGains,
  defaultEqSettings,
  isEqPresetKey,
  normalizeEqPrefs,
  presetBaselineFor,
  remapByFrequency,
  type EqBand,
  type EqBandCount,
  type EqPrefs,
  type EqPrefsPort,
} from '../player/eq'
import { Queue } from '../player/queue'

// 引擎接口从 `engine.ts` 定义（它是引擎的对外契约），这里**再导出**一份，
// 便于「store 的依赖」与「store 的类型」从同一个入口取。
export type { PlayerEngineLike } from '../player/engine'

/** 播放器状态 + 动作。 */
export interface PlayerStore {
  /** 当前曲目，未播放时为 `null`。 */
  current: Song | null
  /** 播放队列。 */
  queue: Song[]
  /** 是否正在播放。 */
  isPlaying: boolean
  /** 播放进度（秒）。 */
  position: number
  /** 当前曲目总时长（秒）。 */
  duration: number
  /** 音量（0~1）。 */
  volume: number
  /** 播放模式。 */
  mode: PlayMode
  /** 是否静音。 */
  muted?: boolean
  /** 播放错误信息。 */
  error?: string | null

  /**
   * 播放一首曲目。
   *
   * @param song 要播放的曲目。
   * @param list 可选的队列上下文（例如用户在某个列表里点了这首歌）——
   *             给了就整队入队并定位到点击的那首；不给就把这首并入当前队列。
   */
  playTrack: (song: Song, list?: Song[]) => void
  /** 播放 / 暂停切换。 */
  togglePlay: () => void
  /** 下一首（按当前播放模式）。 */
  next: () => void
  /** 上一首（进度 > 3 秒时回到本曲开头）。 */
  prev: () => void
  /** 定位（秒）。 */
  seek: (sec: number) => void
  /** 设置音量（0~1，越界钳制，`NaN` 忽略）。 */
  setVolume: (v: number) => void
  /** 设置播放模式。 */
  setMode: (mode: PlayMode) => void

  // --- EQ（Task 21）--------------------------------------------------------
  //
  // ⚠️ 「预设基线 vs 手动偏移」是**两层**，不是一层：
  // - `eqPresetBaseline` = 预置曲线在当前段数下的原始增益；
  // - `eqManualOffset`   = 用户手动调整的偏移；
  // - `eqGains`          = 两者相加后钳制（**真正送进滤波器的就是它**）。
  //
  // ⚠️ `eqPresetKey` 变成 `'custom'` 表示「用户手动改过」（`custom` **不是**
  //    `EQ_PRESETS` 里的一条真实曲线，只是标记）。
  /** 当前选中的预置（`'flat'` / `'pop'` / … / `'custom'`）。 */
  eqPresetKey: string
  /** 预置基线（当前段数下的原始增益）。 */
  eqPresetBaseline: number[]
  /** 用户手动调整的偏移（每个段）。 */
  eqManualOffset: number[]
  /** 段数（10 / 15）。 */
  eqBandCount: EqBandCount
  /** EQ 是否启用（关掉 = 旁路）。 */
  eqEnabled: boolean
  /** 实际生效的增益（= 基线 + 偏移，钳制到 ±12）。 */
  eqGains: number[]
  /** 当前频段（含生效增益）。 */
  eqBands: EqBand[]

  /** 选一个预置曲线（**重置**手动偏移为全 0）。 */
  setEqPreset: (presetKey: string) => void
  /** 改某一段的**手动偏移**（dB，越界钳制）。 */
  setEqBandGain: (index: number, offset: number) => void
  /** 切换段数（10 ↔ 15；手动偏移**按频率**保留）。 */
  setEqBandCount: (count: EqBandCount) => void
  /** 启用 / 旁路。 */
  setEqEnabled: (enabled: boolean) => void
  /** 复位（平直 + 手动偏移清零；**不动启用开关**）。 */
  resetEq: () => void
}

/**
 * `createPlayerStore` 的可选参数。
 */
export interface PlayerStoreOptions {
  /**
   * EQ 偏好的持久化端口（**可选**）。
   *
   * ⚠️ **本任务不自己造 IPC 通道**：Task 17 正在建 `prefs:get` / `prefs:set`，
   *    通道到位后用 `createEqPrefsPort` 把那两个函数接上即可。
   *    不给端口时 EQ 设置**只在本次运行内有效**（不崩、不静默写盘）。
   */
  eqPrefs?: EqPrefsPort
}

/**
 * 造一个播放器 store（**依赖注入**）。
 *
 * @param engine  播放引擎；单测可以注入假引擎，生产用默认引擎。
 * @param options 可选参数（EQ 偏好持久化端口）。
 */
export function createPlayerStore(engine: PlayerEngineLike, options?: PlayerStoreOptions) {
  // 队列模型（不放进 zustand 的 state 里：它是可变对象，不是可序列化状态）。
  const queue = new Queue()

  // --- EQ（Task 21）--------------------------------------------------------
  //
  // ⚠️ **每个 store 一条 EQ 链**：链的状态（段数 / 增益 / 开关）是**权威数据**，
  //    store 的状态只是它的**可序列化镜像**（界面显示用）。
  //    链在音频图建好之前不碰任何 WebAudio 节点（`build()` 由引擎在建图时调用）。
  const eqChain = new EqChain({ bandCount: 10, gains: new Array(10).fill(0) })
  // ⚠️ 引擎**没有**这个方法时（Task 13 的旧实现者 / 测试替身）→ 降级为
  //    「不生效但不崩」：EQ 状态照常更新，只是没接进音频图。
  engine.setEqChain?.(eqChain)

  /** 初始 EQ 状态（平直 / 10 段 / 启用）。 */
  const initialEq = defaultEqSettings()
  const initialEqGains = computeEffectiveGains(initialEq.presetBaseline, initialEq.manualOffset)

  /**
   * 把模型算出来的生效增益推给 EQ 链。
   *
   * ⚠️ **顺序要紧**：先切段数（链内部按频率映射旧增益），再写**模型**算出的生效增益
   *    ——模型是唯一真相源，链自己的映射只是过渡，随后就被覆盖。
   */
  const pushEqToChain = (state: {
    eqBandCount: EqBandCount
    eqGains: number[]
    eqEnabled: boolean
  }): void => {
    eqChain.setBandCount(state.eqBandCount)
    eqChain.setGains(state.eqGains)
    eqChain.setEnabled(state.eqEnabled)
  }

  /**
   * 把 EQ 偏好写出去（**可注入**：Task 17 的 `prefs:*` 通道到位后接上）。
   *
   * ⚠️ 偏好文件里**绝不会有凭证**——这里只有曲线参数。
   */
  const persistEq = (state: {
    eqPresetKey: string
    eqManualOffset: number[]
    eqBandCount: EqBandCount
    eqEnabled: boolean
    eqPresetBaseline: number[]
  }): void => {
    const port = options?.eqPrefs
    if (!port) return
    const prefs: EqPrefs = {
      presetKey: state.eqPresetKey,
      manualOffset: [...state.eqManualOffset],
      bandCount: state.eqBandCount,
      enabled: state.eqEnabled,
      presetBaseline: [...state.eqPresetBaseline],
    }
    void Promise.resolve()
      .then(() => port.save(prefs))
      .catch(() => {
        // ⚠️ 偏好写失败**不影响播放**（偏好不是关键路径）。
      })
  }

  const store = create<PlayerStore>()((set, get) => ({
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    muted: false,
    error: null,

    // --- EQ 的初始状态 ---
    eqPresetKey: initialEq.presetKey,
    eqPresetBaseline: initialEq.presetBaseline,
    eqManualOffset: initialEq.manualOffset,
    eqBandCount: initialEq.bandCount,
    eqEnabled: initialEq.enabled,
    eqGains: initialEqGains,
    eqBands: buildBands(initialEq.bandCount, initialEqGains),

    playTrack: (song, list) => {
      if (Array.isArray(list) && list.length > 0) {
        // 整队入队，并定位到点击的那首。
        queue.clear()
        queue.add(list)
        const at = list.findIndex((item) => item.id === song.id)
        queue.index = at >= 0 ? at : 0
      } else {
        const at = queue.items.findIndex((item) => item.id === song.id)
        if (at >= 0) {
          queue.index = at
        } else {
          queue.add([song])
          queue.index = queue.items.length - 1
        }
      }

      engine.setQueue?.(queue.items)
      set({ queue: [...queue.items], current: song })
      engine.play(song)
    },

    togglePlay: () => {
      const state = get()
      if (state.isPlaying) {
        engine.pause()
        return
      }
      if (!state.current) return
      engine.resume()
    },

    next: () => {
      const song = queue.next()
      if (!song) {
        // 没有下一首了（顺序模式播到队尾）——停在这里，不自动绕回。
        // ⚠️ **必须同步引擎**：只改 store 的 `isPlaying` 的话，媒体元素仍在播、
        //    引擎的 `playing` 仍是 true，下一次引擎 emit 又会把 `isPlaying`
        //    覆盖回 true →「下一首」点击完全无效（当前曲继续播到底）。
        engine.pause()
        set({ isPlaying: false })
        return
      }
      engine.setQueue?.(queue.items)
      set({ queue: [...queue.items], current: song })
      engine.play(song)
    },

    prev: () => {
      const song = queue.prev(get().position)
      if (!song) return
      engine.setQueue?.(queue.items)
      set({ queue: [...queue.items], current: song })
      // 进度 > 3 秒时 queue.prev 返回的是**当前曲**：
      // 重播当前曲 = 回到本曲开头（引擎内部会把 currentTime 归 0）。
      engine.play(song)
    },

    seek: (sec) => {
      const value = typeof sec === 'number' && Number.isFinite(sec) ? sec : 0
      engine.seek(value)
      const max = get().duration > 0 ? get().duration : Number.POSITIVE_INFINITY
      set({ position: Math.min(Math.max(value, 0), max) })
    },

    setVolume: (v) => {
      if (typeof v !== 'number' || Number.isNaN(v)) return
      const clamped = Math.min(Math.max(v, 0), 1)
      engine.setVolume(clamped)
      set({ volume: clamped })
    },

    setMode: (mode) => {
      queue.mode = mode
      engine.setMode?.(mode)
      set({ mode })
    },

    // --- EQ 动作（Task 21）-------------------------------------------------

    /**
     * 选一个预置曲线。
     *
     * ⚠️ 选预置会**重置手动偏移**为全 0（追加要求 C）：
     *    否则「基线 + 偏移」会把旧的手动调整叠加到新曲线上。
     */
    setEqPreset: (presetKey) => {
      const state = get()
      const key = isEqPresetKey(presetKey) ? presetKey : EQ_CUSTOM_PRESET
      const presetBaseline = presetBaselineFor(key, state.eqBandCount)
      const manualOffset = new Array(state.eqBandCount).fill(0)
      const gains = computeEffectiveGains(presetBaseline, manualOffset)
      set({
        eqPresetKey: key,
        eqPresetBaseline: presetBaseline,
        eqManualOffset: manualOffset,
        eqGains: gains,
        eqBands: buildBands(state.eqBandCount, gains),
      })
      pushEqToChain(get())
      persistEq(get())
    },

    /**
     * 改某一段的**手动偏移**（不是生效增益）。
     *
     * ⚠️ 生效增益 = `基线 + 偏移`（钳制到 ±12）——面板显示的两层数值
     *    与真正送进滤波器的增益**必须一致**，所以这里改的是偏移，
     *    生效增益由 `computeEffectiveGains` 统一算。
     * 手动改过之后 `presetKey` 变成 `'custom'`。
     */
    setEqBandGain: (index, offset) => {
      const state = get()
      if (!Number.isInteger(index) || index < 0 || index >= state.eqBandCount) return
      const manualOffset = [...state.eqManualOffset]
      manualOffset[index] = clampEqGain(offset)
      const gains = computeEffectiveGains(state.eqPresetBaseline, manualOffset)
      set({
        eqManualOffset: manualOffset,
        eqPresetKey: EQ_CUSTOM_PRESET,
        eqGains: gains,
        eqBands: buildBands(state.eqBandCount, gains),
      })
      pushEqToChain(get())
      persistEq(get())
    },

    /**
     * 切换段数（10 ↔ 15）。
     *
     * ⚠️ 手动偏移**按频率保留**（用户的手动调整不该丢）：共有频点
     *    （63 / 250 / 1000 / 4000 / 16000）沿用，匹配不上的置 0。
     */
    setEqBandCount: (count) => {
      const state = get()
      if (count !== 10 && count !== 15) return
      if (count === state.eqBandCount) return
      const manualOffset = remapByFrequency(state.eqManualOffset, state.eqBandCount, count)
      // 真实预置 → 取该预置在**新段数**下的基线（gains / gains15 不可互相切片）；
      // 「自定义」→ 基线按频率映射（保留用户当时的基线上下文）。
      const presetBaseline = isEqPresetKey(state.eqPresetKey)
        ? presetBaselineFor(state.eqPresetKey, count)
        : remapByFrequency(state.eqPresetBaseline, state.eqBandCount, count)
      const gains = computeEffectiveGains(presetBaseline, manualOffset)
      set({
        eqBandCount: count,
        eqManualOffset: manualOffset,
        eqPresetBaseline: presetBaseline,
        eqGains: gains,
        eqBands: buildBands(count, gains),
      })
      pushEqToChain(get())
      persistEq(get())
    },

    /** 启用 / 旁路（即时生效，不需要重建音频图）。 */
    setEqEnabled: (enabled) => {
      set({ eqEnabled: enabled !== false })
      pushEqToChain(get())
      persistEq(get())
    },

    /** 复位：平直 + 手动偏移清零（**不动启用开关**）。 */
    resetEq: () => {
      const state = get()
      const presetBaseline = presetBaselineFor('flat', state.eqBandCount)
      const manualOffset = new Array(state.eqBandCount).fill(0)
      const gains = computeEffectiveGains(presetBaseline, manualOffset)
      set({
        eqPresetKey: 'flat',
        eqPresetBaseline: presetBaseline,
        eqManualOffset: manualOffset,
        eqGains: gains,
        eqBands: buildBands(state.eqBandCount, gains),
      })
      pushEqToChain(get())
      persistEq(get())
    },
  }))

  // --- EQ 偏好读回（追加要求 F：重启后要能恢复）---------------------------
  //
  // ⚠️ **端口是注入的**：Task 17 的 `prefs:get` / `prefs:set` 通道到位后，
  //    把那两个函数包成 `createEqPrefsPort` 传进来即可，这里**不自己造通道**。
  const prefsPort = options?.eqPrefs

  /**
   * 把读回来的偏好套进状态。
   *
   * ⚠️ 外部数据**逐项校验**（`normalizeEqPrefs`）：`prefs.json` 是用户可编辑的文件。
   */
  const applyEqPrefs = (raw: EqPrefs | null): void => {
    const prefs = normalizeEqPrefs(raw)
    if (!prefs) return
    // 基线：存了就用存的（无损恢复「自定义」曲线），否则按预置反推。
    const presetBaseline = prefs.presetBaseline
      ? [...prefs.presetBaseline]
      : isEqPresetKey(prefs.presetKey)
        ? presetBaselineFor(prefs.presetKey, prefs.bandCount)
        : new Array(prefs.bandCount).fill(0)
    const manualOffset = [...prefs.manualOffset]
    const gains = computeEffectiveGains(presetBaseline, manualOffset)
    store.setState({
      eqPresetKey: prefs.presetKey,
      eqPresetBaseline: presetBaseline,
      eqManualOffset: manualOffset,
      eqBandCount: prefs.bandCount,
      eqEnabled: prefs.enabled,
      eqGains: gains,
      eqBands: buildBands(prefs.bandCount, gains),
    })
    pushEqToChain(store.getState())
  }

  if (prefsPort) {
    void Promise.resolve()
      .then(() => prefsPort.load())
      .then((prefs) => {
        applyEqPrefs(prefs)
      })
      .catch(() => {
        // ⚠️ 读偏好失败**不影响播放**（没有偏好就按默认值走）。
      })
  }

  // 引擎的状态变化 → store（`current` / 队列 / 模式由 store 自己管，这里只同步传输层字段）。
  engine.onStateChange((state: PlayerState) => {
    store.setState({
      current: state.current,
      isPlaying: state.isPlaying,
      position: state.position,
      duration: state.duration,
      volume: state.volume,
      muted: state.muted ?? false,
      error: state.error ?? null,
    })
  })

  // 本曲播完 → 切下一首（顺序/循环模式由 `Queue` 决定；没有下一首就停）。
  engine.onEnded(() => {
    store.getState().next()
  })

  return store
}

/** 默认播放器 store（生产用：默认引擎 + 真实的 `<audio>` 与 `AudioContext`）。 */
export const usePlayerStore = createPlayerStore(new PlayerEngine())
