// ---------------------------------------------------------------------------
// 悬浮歌词的**本地插值时钟**（Task 10）
// ---------------------------------------------------------------------------
//
// 为什么要它
// ---------------------------------------------------------------------------
// 悬浮窗是**另一个渲染进程**，它拿不到主窗口里的 `<audio>`。
// 若把播放进度**逐帧**经 IPC 推过去，60fps 下就是每秒 60 次跨进程消息——
// 纯浪费，且歌词推进会一顿一顿的。
//
// → 做法：**低频**推送进度（`timeupdate` 的 ~4Hz），悬浮窗收到后记下
//    「采样时刻 + 采样位置 + 是否在播」，之后用 `requestAnimationFrame`
//    在**本地**按经过时间外推出当前位置 → 推进是 60fps 顺滑的，
//    而 IPC 仍然只有 ~4Hz。
//
// ⚠️ 本模块是**纯函数**（不碰 DOM、不读时钟、不 import React）：
//    「采样时刻」由调用方传入，测试里可以随便给。
// ---------------------------------------------------------------------------

/** 一次进度采样。 */
export interface OverlayProgressSample {
  /** 采样时刻（**毫秒**，单调时钟；由调用方给）。 */
  at: number
  /** 采样时的播放位置（**秒**）。 */
  position: number
  /** 采样时是否正在播放。 */
  isPlaying: boolean
}

/**
 * 由「采样 + 经过的毫秒数」推出**现在**的播放位置（秒）。
 *
 * - 正在播放 → 位置按经过时间**前进**；
 * - 已暂停 → 位置**原地不动**；
 * - 经过时间为负（时钟回拨 / 采样来自未来）→ 按原位置处理，**绝不倒退**；
 * - 输入非法（位置不是有限数）→ 退化成 `0`（不产生 `NaN`）。
 */
export function extrapolatePosition(sample: OverlayProgressSample, nowMs: number): number {
  if (!sample) return 0
  // ⚠️ 位置无效（非有限数 / 负数）→ **不猜**：直接按 0 处理。
  //    （否则「NaN + 经过时间」会算出一个看似合理的假位置。）
  if (!Number.isFinite(sample.position) || sample.position < 0) return 0
  const position = sample.position
  if (!sample.isPlaying) return position

  const elapsed = nowMs - sample.at
  if (!Number.isFinite(elapsed) || elapsed <= 0) return position
  return position + elapsed / 1000
}
