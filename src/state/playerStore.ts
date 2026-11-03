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
}

/**
 * 造一个播放器 store（**依赖注入**）。
 *
 * @param engine 播放引擎；单测可以注入假引擎，生产用默认引擎。
 */
export function createPlayerStore(engine: PlayerEngineLike) {
  // 队列模型（不放进 zustand 的 state 里：它是可变对象，不是可序列化状态）。
  const queue = new Queue()

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
  }))

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
