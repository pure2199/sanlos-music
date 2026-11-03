// ---------------------------------------------------------------------------
// 双行歌词的推进逻辑（**纯函数**）
//
// Task 15（播放条 / 全屏播放页 / 歌词视图）落地，**Task 19（桌面悬浮歌词）复用**。
// 悬浮歌词是同一套行为的另一个呈现 —— 两处各写一套 UI 状态机，行为迟早会漂移，
// 所以推进逻辑只在这里写一次，`LyricView` 与 `LyricOverlay` 都只负责**渲染**本模块的结果。
//
// ---------------------------------------------------------------------------
// 纯度
// ---------------------------------------------------------------------------
// - 不 import React、不碰 DOM、不依赖时钟：给定 `lines` 与 `t`，结果**完全确定**；
// - 唯一的外部引用是 `import type`（编译期被擦除，运行时不产生依赖）；
// - 只用 Task 12（`src/ui/lyrics/parse.ts`）的 `findActiveWord` 与类型，**不改**它。
//
// ---------------------------------------------------------------------------
// 语义模型（「一页两行」）
// ---------------------------------------------------------------------------
// ⚠️ **「两行」= 两行「歌词行」**：`previous` / `next` 都是 `LyricLine`。
//    `LyricLine.translation` 只是挂在歌词行下面的**副行**（一个 `string`，
//    **没有逐字时间**）→ **不参与推进**、**不是**第二行歌词。
//
//    （简报 B 末句「没有翻译时双行模式退化为单行」**是误写**——把「翻译副行」
//      与「第二行歌词」混为一谈。**以 Step 1 的测试代码与要求 A 为准**：
//      双行模式的「两行」永远是两行**歌词行**，与有没有翻译无关。
//      翻译的渲染在 `LyricView.tsx`，与本模块无关。）
//
// 双行模式同时呈现**两行歌词**：
//
//     上一行（上一行 slot）  ←  已经走满、停在全满态的那一行
//     下一行（下一行 slot）  ←  正在逐字推进的那一行
//
// 推进规则（简报 Step 3 + 控制器追加要求 B，逐条定死）：
//
// 1. **两行同时在场**：屏幕上同时能看到上一行和下一行，不是只显示一行；
// 2. **上一行保持在原位走满**：上一行从它的起始逐字状态开始，随着时间推进逐字高亮往前走；
//    **走满后停在「全满」状态**（该行所有字都处于高亮态），**不消失、不清空**；
// 3. **下一行在原位开始走**：下一行从自己的起始逐字状态开始推进；
// 4. **整页走完才一起换行**：只有当下一行也**走满**（整页两行都走完）时，才整体切换成
//    新的「上一行 / 下一行」—— 即上一行变成旧的下一行，下一行变成再下一行。
//
// 于是「一页」= 连续的两行歌词，这一页覆盖「上一行自己被唱完」到「下一行也唱完」这段时间：
//
//     t ──────────────► 上一行走完 ──────────────► 下一行走完
//       [ 上一行逐字推进 ][ 上一行全满 ][ 下一行逐字推进 ]
//                                        ▲
//                                        └── 整页走完 → 换成新的一页（上一行 = 旧的下一行）
//
// ---------------------------------------------------------------------------
// 换行时机（纯函数怎么算出「当前这一页」）
// ---------------------------------------------------------------------------
// 设 `end(i)` = 第 i 行最后一个词的结束时间（没有词时退回行时间）。
// 「第 i 行已走满」⇔ `t >= end(i)`。因为 `end` 随行号单调递增，已走满的行一定是一个**前缀**。
//
// - 已走满的行数 `done` 为 0 或 1 时 → 当前页是第 **0** 页（`上一行 = lines[0]`、`下一行 = lines[1]`）；
// - `done >= 2` 时 → 当前页是第 `done - 1` 页（`上一行 = lines[done-1]`、`下一行 = lines[done]`）。
//
// 换句话说：**当前页的上一行恰好是「刚刚走满（或正在走满）的那一行」**，
// 而**当前页的下一行是紧接着的那一行**；当下一行也走满时 `done` 加一，整页换成新的一页 ——
// 「上一行变成旧的下一行，下一行变成再下一行」。
//
// ---------------------------------------------------------------------------
// `phase`（**上一行**走满前 / 后）—— ⚠️ **不是**整页换行信号
// ---------------------------------------------------------------------------
// `phase` 描述的是**上一行**的状态：
//
// - `'before'`：上一行**还没走满**，它还在逐字推进；
// - `'after'` （原「换行后」）：上一行**已走满**，停在全满态，下一行接管推进。
//
// ⚠️ **它与「整页换行」不是同一个事件**（复审 I-1）：
//    `phase` 在**上一行走满**时翻转（t=20），而**整页换行**发生在**下一行走满**时（t=30）。
//    t=29.9 与 t=30 的 `phase` **完全相同**（都是 `'after'`）——
//    所以**绝不能**用 `phase` 决定要不要做换行动画。
//
// ---------------------------------------------------------------------------
// 整页换行（页面切换）：**确切判据**
// ---------------------------------------------------------------------------
// 「整页走完才一起换行」= 下一行也走满 → 整体换成新的「上一行 / 下一行」。
// 换行发生在**下一行走满的那一刻**。
//
// **确切判据（Task 19 的悬浮歌词照抄）**：
//
//     整页换行 ⇔ 换行**之后**的 `previousIndex` 与换行**之前**不同
//              （等价：换行后的 `previous` 就是**刚刚走满**的那一行 —— `previous.completed === true`；
//                也等价：`swappedAt` 变了 —— 它是**本页成为当前页的时刻**）
//
// 消费方（`LyricView` / Task 19 的 `LyricOverlay`）用法：
//
//     const prev = prevRef.current
//     if (isPageSwapped(prev, state)) {
//       // 整页换行 → 播换行动画
//     }
//     prevRef.current = state
//
// ⚠️ **不能用 `next.completed` 判换行**：本模块的 `next` 永远是「**还没走满**的那一行」
//    （`nextIndex = done`，而 `done` 正是已走满的行数）→ `next.completed` **恒为 false**。
//    真正「刚刚走满」的那一行，在换行**之后**是 `previous`（换行**之前**才是 `next`）。
// ---------------------------------------------------------------------------

import { findActiveWord } from './parse'
import type { LyricLine } from './parse'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一行歌词在某一时刻的逐字推进状态。
 *
 * 「逐字」的粒度是 **Task 12 的词（word）**：CJK 逐字成词、拉丁按词成词
 * （见 `parse.ts` 的 `splitIntoWords`），行级 LRC 由伪逐字兜底保证 `words` 非空。
 */
export interface LyricWordProgress {
  /**
   * 当前高亮到的**词下标**。
   *
   * - `-1` = 还没开始推进（时间在该行第一个词之前）；
   * - `>= 0` = 该下标的词正在被唱（`findActiveWord` 的语义）。
   */
  wordIndex: number
  /** 该行的词总数。 */
  wordCount: number
  /**
   * 高亮比例（`0 ~ 1`）：已经高亮的词数占比。
   *
   * 走满时为 `1`。
   */
  progress: number
  /**
   * 当前词**内部**的推进比例（`0 ~ 1`）。
   *
   * 词内的时间是连续的，所以这个值适合做「平滑扫光」；
   * 词级高亮只需要 `wordIndex` 就够了。
   */
  wordProgress: number
  /**
   * 是否**已走满**（该行所有词都已唱完、时间已过最后一个词）。
   *
   * 走满之后这一行**停在全满态**，不会清空、不会消失。
   */
  completed: boolean
}

/** 双行推进的阶段：**上一行**走满前 / 后（⚠️ 不是整页换行信号，见文件头注释）。 */
export type DoubleLinePhase = 'before' | 'after'

/** 双行模式在某一时刻的完整状态。 */
export interface DoubleLineState {
  /** 上一行的行下标（`-1` = 没有上一行）。 */
  previousIndex: number
  /** 下一行的行下标（`-1` = 没有下一行）。 */
  nextIndex: number
  /** 上一行的逐字推进状态（没有上一行时为 `null`）。 */
  previous: LyricWordProgress | null
  /** 下一行的逐字推进状态（没有下一行时为 `null`）。 */
  next: LyricWordProgress | null
  /**
   * 当前处于「上一行**还没走满**」还是「上一行**已走满**」。
   *
   * ⚠️ **它不是整页换行信号**（整页换行的判据见文件头注释与 `swappedAt`）。
   */
  phase: DoubleLinePhase
  /**
   * **本页成为当前页的时刻**（秒）。
   *
   * - `null` = 还在**第 0 页**（还没发生过整页换行）；
   * - 否则 = 上一页的「上一行」走满的那一刻（也就是整页换行发生的时刻）。
   *
   * ⭐ **这是整页换行的真信号**：整页换行时它**必然变化**，
   *    同一页内它**保持不变**（消费方用 `isPageSwapped(上一帧, 这一帧)` 判定）。
   */
  swappedAt: number | null
}

// ---------------------------------------------------------------------------
// 单行推进
// ---------------------------------------------------------------------------

/**
 * 一行歌词在时间 `t` 的逐字推进状态。
 *
 * - `wordIndex` 用 Task 12 的 `findActiveWord`（左闭右开；越过最后一个词时停在最后一个词）；
 * - `completed` = `t` 已经过了该行**最后一个词**的结束时间 —— 走满后停在全满态；
 * - 没有任何词的行（空文本）既没有词也没有进度：`wordIndex = -1`、`progress = 0`、`completed = false`。
 */
export function computeLineProgress(line: LyricLine, t: number): LyricWordProgress {
  const words = Array.isArray(line?.words) ? line.words : []
  const wordCount = words.length
  const time = typeof t === 'number' && Number.isFinite(t) ? t : 0

  if (wordCount === 0) {
    return { wordIndex: -1, wordCount: 0, progress: 0, wordProgress: 0, completed: false }
  }

  const wordIndex = findActiveWord(line, time)
  const lastWord = words[wordCount - 1]!
  const completed = time >= lastWord.end

  let wordProgress = 0
  if (completed) {
    wordProgress = 1
  } else if (wordIndex >= 0) {
    const word = words[wordIndex]
    if (word) {
      const span = word.end - word.start
      wordProgress = span > 0 ? Math.min(1, Math.max(0, (time - word.start) / span)) : 1
    }
  }

  const progress = completed
    ? 1
    : wordIndex < 0
      ? 0
      : Math.min(1, Math.max(0, (wordIndex + 1) / wordCount))

  return { wordIndex, wordCount, progress, wordProgress, completed }
}

/**
 * 一行的「结束时间」（秒）= 最后一个词的结束时间。
 *
 * 没有词时退回行时间（这一行没有可推进的内容）。
 */
export function lineEndTime(line: LyricLine): number {
  const words = Array.isArray(line?.words) ? line.words : []
  if (!words.length) return line?.time ?? 0
  return words[words.length - 1]!.end
}

// ---------------------------------------------------------------------------
// 双行推进
// ---------------------------------------------------------------------------

/** 空状态（没有歌词）。 */
function emptyState(): DoubleLineState {
  return {
    previousIndex: -1,
    nextIndex: -1,
    previous: null,
    next: null,
    phase: 'before',
    swappedAt: null,
  }
}

/**
 * 算出双行模式在时间 `t` 的状态。
 *
 * 纯函数：同一个 `lines` + 同一个 `t` 永远得到同一个结果（**不依赖时钟、不读全局状态**）。
 *
 * @param lines 歌词行（应当按时间升序；Task 12 的 `parseLrc` 保证这一点）。
 * @param t     当前播放位置（**秒**）。
 * @returns 双行状态（上一行 / 下一行的下标与各自的逐字推进状态 + 换行阶段）。
 */
export function computeDoubleLineState(lines: LyricLine[], t: number): DoubleLineState {
  if (!Array.isArray(lines) || lines.length === 0) return emptyState()

  const time = typeof t === 'number' && Number.isFinite(t) ? t : 0

  // 已走满（时间已过最后一个词）的行数 —— 是一个前缀（`end` 随行号单调递增）。
  let done = 0
  for (const line of lines) {
    if (time >= lineEndTime(line)) done += 1
    else break
  }

  // 当前页：已走满 0 / 1 行 → 第 0 页；已走满 `done` 行 → 第 `done - 1` 页。
  const previousIndex = Math.max(0, done - 1)
  const nextIndex = previousIndex + 1

  const previousLine = lines[previousIndex]
  const nextLine = lines[nextIndex]
  const previous = previousLine ? computeLineProgress(previousLine, time) : null
  const next = nextLine ? computeLineProgress(nextLine, time) : null

  // 本页成为当前页的时刻：
  // - 第 0 页（`previousIndex === 0`）→ 还没换过页 → `null`；
  // - 第 p 页（`p >= 1`）→ 第 p-1 页的「上一行」走满的那一刻 = `end(lines[p-1])`。
  const swappedAt = previousIndex >= 1 ? lineEndTime(lines[previousIndex - 1]!) : null

  return {
    previousIndex,
    nextIndex: nextLine ? nextIndex : -1,
    previous,
    next,
    // 「上一行」走满前 / 后（⚠️ **不是**整页换行信号）。
    phase: previous?.completed ? 'after' : 'before',
    // 整页换行的真信号（同一页内不变，换行时变化）。
    swappedAt,
  }
}

/**
 * 判定相邻两帧之间是否发生了**整页换行**（页面切换）。
 *
 * ⭐ **Task 19（桌面悬浮歌词）做换行动画就用它**：
 *
 *     const prev = prevRef.current
 *     if (isPageSwapped(prev, state)) {
 *       // 整页换行 → 播换行动画
 *     }
 *     prevRef.current = state
 *
 * 判据（文件头有完整说明）：换行**之后**的 `previousIndex` 与换行**之前**不同
 * —— 等价于「换行后的 `previous` 是刚刚走满的那一行」。
 *
 * ⚠️ **不要用 `phase`**：`phase` 在**上一行走满**时翻转，与整页换行不是同一个事件。
 *
 * @param previous 上一帧的状态（没有上一帧时传 `null` → 返回 `false`，首帧不播动画）。
 * @param current  当前帧的状态。
 */
export function isPageSwapped(
  previous: DoubleLineState | null | undefined,
  current: DoubleLineState,
): boolean {
  if (!previous) return false
  return previous.previousIndex !== current.previousIndex
}
