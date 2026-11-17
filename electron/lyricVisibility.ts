// ---------------------------------------------------------------------------
// T106：桌面歌词窗（经典悬浮窗）的**可见性判定** —— 主进程侧
// ---------------------------------------------------------------------------
//
// ⚠️ **纯函数**：不碰 Electron、不碰窗口对象 —— 判定逻辑单独拿出来测
//    （窗口显隐的 bug 只有真机上才看得见，判定逻辑必须能单测钉死）。
//
// ---------------------------------------------------------------------------
// 这一轮要解决什么（用户 2026-11-17 的原话）
// ---------------------------------------------------------------------------
// 「匹配不到歌词也没有内嵌歌词的情况下，**不要显示桌面歌词和灵动歌词**」
//
// ⇒ **有歌、但这首歌没有歌词**（线上没匹配上 ＋ 内嵌也没有）⇒
//    经典悬浮窗与灵动态词岛**都不该出现**（现在会弹一个空窗 / 一个空胶囊，
//    上面写着「暂无歌词」—— 对用户就是「弹了个没用的东西」）。
//
// ---------------------------------------------------------------------------
// 三种「曲目状态」（为什么不能只看「有没有歌词」）
// ---------------------------------------------------------------------------
// | 状态 | 含义 | 经典窗 | 词岛 |
// |---|---|---|---|
// | `unknown` | **还没收到**渲染层推来的曲目消息 | **不显示**（等它推） | 不显示 |
// | `no-track` | 没有歌（`track === null`） | **显示**（「未在播放」＝既有行为，一字不改） | 不显示（本来就要 `playing`） |
// | `has-track` | 有歌 | **只在有歌词时显示**（T106） | 同左（另加 `playing`） |
//
// ⚠️ **为什么要有 `unknown`**：用户「打开桌面歌词」时，主进程**不知道**当前这首
//    有没有歌词（歌词是渲染层去取的）⇒ 若此时按「旧状态」显示，会闪一下
//    **上一首**的歌词 ⇒ ⇒ 打开时先**不显示**，等渲染层把当前曲目的歌词状态
//    推过来（`kind: 'track'`）再决定 ⇒ 宁可不显示，也不显示错的。
//
// ⚠️ **为什么不落盘 / 不发 `lyric:visibility`**：那会让渲染层**停止推送**
//    ⇒ 主进程再也收不到「这首歌有歌词了」⇒ **窗口永远回不来（死锁）**
//    （T69 已经踩过这个坑：见 `electron/islandVisibility.ts` 的注释）。
//    ⇒ 「无歌词 ⇒ 收起」只能是**主进程内部的临时态**。
// ---------------------------------------------------------------------------

import type { LyricOverlayMessage } from '../shared/playerBridge'

/** 当前曲目在「歌词」这条链上的状态。 */
export type LyricTrackState =
  /** 还没收到渲染层推来的曲目消息（**不知道**，不是「没有」）。 */
  | 'unknown'
  /** 没有歌（`track === null`）。 */
  | 'no-track'
  /** 有歌。 */
  | 'has-track'

/**
 * 从「最近一条曲目消息」推出曲目状态。
 *
 * @param message 最近一条 `kind: 'track'` 的消息（`null` = 还没收到过）。
 */
export function lyricTrackState(message: LyricOverlayMessage | null): LyricTrackState {
  // ⚠️ `LyricOverlayMessage` 是**判别联合**：`progress` 消息里没有 `track` ⇒
  //    只认 `kind: 'track'` 的那条（其余一律「不知道」）。
  if (!message || message.kind !== 'track') return 'unknown'
  return message.track === null ? 'no-track' : 'has-track'
}

/** 经典悬浮窗可见性判定的输入。 */
export interface ClassicLyricVisibilityInput {
  /** 用户是否开着桌面歌词（**落盘**的偏好）。 */
  visible: boolean
  /** 当前曲目状态（见 {@link LyricTrackState}）。 */
  trackState: LyricTrackState
  /** 当前这首**有没有歌词**（临时态：线上没匹配上 ＋ 内嵌也没有 ⇒ `false`）。 */
  hasLyrics: boolean
}

/**
 * 经典悬浮窗（classic）**实际**该不该显示。
 *
 * ```
 * shouldShow = 用户开着桌面歌词
 *            && (没歌 ⇒ 显示「未在播放」｜有歌 ⇒ 只在有歌词时显示)
 * ```
 *
 * ⚠️ **三个条件缺一不可**：
 * - `visible` 缺了 ⇒ 用户关了桌面歌词却被弹窗；
 * - `trackState === 'unknown'` 缺了 ⇒ 打开时闪一下**上一首**的歌词；
 * - `hasLyrics` 缺了 ⇒ **有歌但没歌词**时弹一个空窗（T106 要修的正是这个）。
 */
export function shouldShowClassicLyric(input: ClassicLyricVisibilityInput): boolean {
  if (!input.visible) return false
  if (input.trackState === 'unknown') return false
  if (input.trackState === 'no-track') return true
  return input.hasLyrics
}
