// ---------------------------------------------------------------------------
// 播放模式（Task 24）
// ---------------------------------------------------------------------------
//
// 这个模块回答一个问题：**「现在按什么规则往下播？」**
//
// ---------------------------------------------------------------------------
// 为什么要单独一个模块
// ---------------------------------------------------------------------------
// 四种模式的**语义**（下一首 / 上一首怎么走）住在 `src/player/queue.ts`，
// 那里**早就实现完整、也早有测试**（`test/queue.test.ts`）。
//
// 但「怎么切到某个模式」这件事一直**没有出口** ——
// `playerStore.setMode()` 写好了、引擎也认，但**播放条上没有任何按钮能点到它**，
// 于是这个能力对用户**等于不存在**（典型的「底层齐了、UI 没接」）。
//
// 本模块只负责**纯逻辑**（名字 + 循环顺序），不放 React：
// 这样「循环顺序」这类容易写错的东西可以**脱离渲染**直接测。
//
// ---------------------------------------------------------------------------
// 模式的口径
// ---------------------------------------------------------------------------
// | 值 | 名字 | 下一首 |
// |---|---|---|
// | `sequence` | 顺序播放 | 下一首；到队尾**停**（不绕回）|
// | `shuffle` | 随机播放 | 在「除当前曲以外」里等概率取一首 |
// | `loop-one` | 单曲循环 | 始终当前曲 |
// | `loop-list` | 列表循环 | 下一首；到队尾**回到第一首** |
//
// ⚠️ **按钮的循环顺序固定为**「顺序 → 随机 → 单曲循环 → 列表循环 → 顺序」——
//    「随机」放在第二个，是因为它是用户最常用的非默认项（少点一次）。
//
// ⚠️ **模式已持久化**（T29）：落在主进程的 `prefs.json`（`AppPrefs.playMode`）——
//    切歌不丢，**重启应用也还在**。
//    ⇒ 落盘由 `playerStore` 负责（`options.playModePrefs` 端口），
//    本模块仍然只管**纯逻辑**（名字 + 循环顺序），不碰任何 IO。
//
// ---------------------------------------------------------------------------

import type { PlayMode } from '../../shared/types'

export type { PlayMode } from '../../shared/types'

/** 四种播放模式的中文名。 */
export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  sequence: '顺序播放',
  shuffle: '随机播放',
  'loop-one': '单曲循环',
  'loop-list': '列表循环',
}

/**
 * 播放模式按钮的**循环顺序**。
 *
 * ⚠️ 这是一个**有序数组**（不是集合）——「下一个模式」就是「数组里的下一项」，
 *    末项回到首项。
 */
export const PLAY_MODE_CYCLE: readonly PlayMode[] = [
  'sequence',
  'shuffle',
  'loop-one',
  'loop-list',
]

/**
 * 取下一个播放模式（循环到首项）。
 *
 * @param mode 当前模式。
 * @returns 下一个模式；传入的不是合法模式时按「顺序播放」处理（不抛错）。
 */
export function nextPlayMode(mode: PlayMode): PlayMode {
  const index = PLAY_MODE_CYCLE.indexOf(mode)
  if (index < 0) return 'sequence'
  const next = PLAY_MODE_CYCLE[(index + 1) % PLAY_MODE_CYCLE.length]
  return next ?? 'sequence'
}

/**
 * 取播放模式的显示文案。
 *
 * @param mode 播放模式（`undefined` / 非法值 → 「顺序播放」）。
 */
export function playModeLabel(mode: PlayMode | undefined | null): string {
  if (!mode) return PLAY_MODE_LABELS.sequence
  return PLAY_MODE_LABELS[mode] ?? PLAY_MODE_LABELS.sequence
}
