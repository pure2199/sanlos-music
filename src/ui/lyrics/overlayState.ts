// ---------------------------------------------------------------------------
// 悬浮窗的**状态合并**（纯函数，Task 10）
// ---------------------------------------------------------------------------
//
// 悬浮窗收到两类消息（见 `shared/playerBridge.ts` 的 `LyricOverlayMessage`）：
// - `track`：曲目 + 整份歌词（低频，切歌时一次）；
// - `progress`：播放位置 + 是否在播（高频，~4Hz）。
//
// → 本模块把两者**合并**成一份悬浮窗状态，并记下「进度采样」
//    （采样时刻 + 采样位置），供 `overlayClock.ts` 在本地外推当前位置。
//
// ⚠️ **纯函数**：不碰 DOM、不读时钟（`nowMs` 由调用方传入）→ 可单测。
// ---------------------------------------------------------------------------

import type { LyricOverlayMessage, LyricOverlayTrack } from '../../../shared/playerBridge'
import type { LyricLine } from './parse'
import type { OverlayProgressSample } from './overlayClock'

/** 悬浮窗的状态。 */
export interface OverlayWindowState {
  /** 当前曲目（没有播放时为 `null`）。 */
  track: LyricOverlayTrack | null
  /** 歌词行。 */
  lines: LyricLine[]
  /** 最近一次进度采样（本地插值的基准）。 */
  sample: OverlayProgressSample
}

/** 空的悬浮窗状态。 */
export function emptyOverlayState(): OverlayWindowState {
  return {
    track: null,
    lines: [],
    sample: { at: 0, position: 0, isPlaying: false },
  }
}

/**
 * 把一条消息合并进当前状态。
 *
 * @param state  当前状态。
 * @param message 新到的消息。
 * @param nowMs  **当前时刻**（毫秒，单调时钟）——记进进度采样，供本地外推。
 */
export function mergeLyricMessage(
  state: OverlayWindowState,
  message: LyricOverlayMessage,
  nowMs: number,
): OverlayWindowState {
  if (!message) return state
  if (message.kind === 'track') {
    return { ...state, track: message.track, lines: message.lines }
  }
  if (message.kind === 'progress') {
    return {
      ...state,
      sample: { at: nowMs, position: message.position, isPlaying: message.isPlaying },
    }
  }
  return state
}
