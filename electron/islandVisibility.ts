// ---------------------------------------------------------------------------
// T69：灵动态词岛的**可见性判定** —— 主进程侧
// ---------------------------------------------------------------------------
//
// ⚠️ **纯函数**：不碰 Electron、不碰窗口对象 —— 判定逻辑单独拿出来测
//    （窗口显隐的 bug 只有真机上才看得见，判定逻辑必须能单测钉死）。
//
// ⚠️ **为什么不复用 `setLyricVisible(false)` 实现「暂停隐藏」**：
//    `setLyricVisible(false)` 会发 `lyric:visibility(false)` ⇒ 渲染层
//    `enabled = false` ⇒ **不再推任何 `lyric:state`** ⇒ 主进程再也收不到
//    `isPlaying: true` ⇒ **恢复播放后词岛永远不再出现（死锁）**。
//    ⇒ 「暂停隐藏」只能是**纯主进程内部的临时态**（不动用户偏好、不发事件）。
// ---------------------------------------------------------------------------

import type { LyricOverlayMessage, LyricOverlayMode } from '../shared/playerBridge'

/** 词岛可见性判定的输入。 */
export interface IslandVisibilityInput {
  /** 用户是否开着桌面歌词（**落盘**的偏好）。 */
  visible: boolean
  /** 当前形态：`classic` 经典悬浮窗 / `island` 灵动态词岛。 */
  mode: LyricOverlayMode
  /** 当前是否正在播放（**临时态**，不落盘）。 */
  playing: boolean
}

/**
 * 词岛窗口**实际**该不该可见。
 *
 * ```
 * shouldShow = 用户开着桌面歌词 && 当前形态是词岛 && 正在播放
 * ```
 *
 * ⚠️ 三个条件缺一不可：
 * - `visible` 缺了 ⇒ 用户关了桌面歌词却被弹窗；
 * - `mode` 缺了 ⇒ **经典悬浮窗会被误伤**（它的显隐行为一字不变）；
 * - `playing` 缺了 ⇒ 没歌 / 暂停时词岛仍常驻屏幕顶部（T69 要修的正是这个）。
 */
export function shouldShowIsland(input: IslandVisibilityInput): boolean {
  return input.visible && input.mode === 'island' && input.playing
}

/**
 * 从一条歌词消息推出「当前是否正在播放」。
 *
 * | 消息 | 结果 |
 * | --- | --- |
 * | `{ kind: 'progress', isPlaying }` | **直接**置为 `isPlaying` |
 * | `{ kind: 'track', track: null }` | **置为 `false`**（没有歌 ⇒ 不可能在播） |
 * | `{ kind: 'track', track: {...} }` | **保持** `current`（切歌不代表播放状态变了） |
 *
 * ⚠️ `current` 是**上一次的播放状态** —— 主进程侧的临时态，
 *    收到 `progress` 之前必须靠它维持。
 */
export function playingFromLyricMessage(message: LyricOverlayMessage, current: boolean): boolean {
  if (message.kind === 'progress') return message.isPlaying
  // `track` 消息：没有歌 ⇒ 不可能在播；有歌 ⇒ 保持原值。
  return message.track === null ? false : current
}
