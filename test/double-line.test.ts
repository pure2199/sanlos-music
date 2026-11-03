// ---------------------------------------------------------------------------
// Task 15：双行歌词推进的**纯函数**
//
// 覆盖控制器追加要求 A / B / I：
// - A：双行推进必须抽成纯函数（独立可测，不依赖 DOM / React），本文件就是它的单测；
// - B：双行的六条精确行为（下面逐条钉死）；
// - I：三条断言 —— 上一行走满后停在全满态、下一行同时在走、整页走完才换行。
//
// ⚠️ 测试数据一律用**占位**（「甲行」「乙行」…），不含任何真实 FN ID / 账号 / 密码 / 真实歌曲名 / 真实歌词。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { parseLrc } from '../src/ui/lyrics/parse'
import {
  computeDoubleLineState,
  computeLineProgress,
  isPageSwapped,
  lineEndTime,
  type DoubleLineState,
} from '../src/ui/lyrics/doubleLine'

// ---------------------------------------------------------------------------
// 测试数据（占位）
// ---------------------------------------------------------------------------

/**
 * 三行占位歌词。
 *
 * 行级 LRC（没有逐字标签）→ Task 12 会按行时长**均匀切出伪逐字**，
 * 所以每一行的 `words` 都非空（双行逐字高亮有东西可推进）。
 *
 * 时间轴：
 * - 甲行：`[00:10.00] ~ [00:20.00]`（3 个词）
 * - 乙行：`[00:20.00] ~ [00:30.00]`（3 个词）
 * - 丙行：`[00:30.00] ~ [00:30.50]`（最后一行，Task 12 给 0.5s 兜底时长）
 */
const LINES = parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙\n[00:30.00]丙行丙')

/** 取状态里的上一行 / 下一行（测试里到处都要用，先收个口）。 */
function previous(state: DoubleLineState): NonNullable<DoubleLineState['previous']> {
  expect(state.previous).not.toBeNull()
  return state.previous!
}

function next(state: DoubleLineState): NonNullable<DoubleLineState['next']> {
  expect(state.next).not.toBeNull()
  return state.next!
}

// ---------------------------------------------------------------------------
// 纯函数的基本性质
// ---------------------------------------------------------------------------

describe('computeDoubleLineState：纯函数性质', () => {
  it('同一个输入永远得到同一个结果（不依赖时钟 / 全局状态）', () => {
    const a = computeDoubleLineState(LINES, 25)
    const b = computeDoubleLineState(LINES, 25)
    expect(a).toEqual(b)
  })

  it('空歌词返回空状态（不抛异常）', () => {
    const state = computeDoubleLineState([], 12)
    expect(state.previousIndex).toBe(-1)
    expect(state.nextIndex).toBe(-1)
    expect(state.previous).toBeNull()
    expect(state.next).toBeNull()
  })

  it('非法的 t（NaN / Infinity）不会抛异常', () => {
    expect(() => computeDoubleLineState(LINES, Number.NaN)).not.toThrow()
    expect(() => computeDoubleLineState(LINES, Number.POSITIVE_INFINITY)).not.toThrow()
  })

  it('时间早于第一行时，第一页的两行仍然在场（不白屏）', () => {
    const state = computeDoubleLineState(LINES, 0)
    expect(state.previousIndex).toBe(0)
    expect(state.nextIndex).toBe(1)
    expect(previous(state).completed).toBe(false)
    expect(next(state).wordIndex).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// 要求 B-1：两行同时在场
// ---------------------------------------------------------------------------

describe('要求 B-1：两行同时在场', () => {
  it('任意时刻都给出「上一行 + 下一行」两个行下标', () => {
    for (const t of [0, 12, 25, 30]) {
      const state = computeDoubleLineState(LINES, t)
      expect(state.previousIndex).toBeGreaterThanOrEqual(0)
      expect(state.nextIndex).toBe(state.previousIndex + 1)
    }
  })

  it('下一行走到头（没有下一行了）时，下一行下标为 -1', () => {
    const state = computeDoubleLineState(LINES, 999)
    expect(state.nextIndex).toBe(-1)
    expect(state.next).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 要求 B-2：上一行保持在原位走满，走满后停在全满态
// ---------------------------------------------------------------------------

describe('要求 B-2：上一行走满后停在全满态', () => {
  it('上一行走满后：所有词都处于高亮态（wordIndex 落在最后一个词、progress = 1）', () => {
    // t=25 时甲行（10~20s）早已唱完
    const state = computeDoubleLineState(LINES, 25)
    const top = previous(state)

    expect(top.completed).toBe(true)
    expect(top.progress).toBe(1)
    expect(top.wordIndex).toBe(top.wordCount - 1)
  })

  it('走满后不会清空、不会消失（时间继续推进，它仍然停在全满态）', () => {
    const before = previous(computeDoubleLineState(LINES, 25))
    const after = previous(computeDoubleLineState(LINES, 28))

    expect(after.completed).toBe(true)
    expect(after.wordIndex).toBe(before.wordIndex)
    expect(after.progress).toBe(1)
  })

  it('还在走的那一行没有走满（completed 为 false）', () => {
    const state = computeDoubleLineState(LINES, 25)
    expect(previous(state).completed).toBe(true)
    expect(next(state).completed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 要求 B-3：下一行在原位开始走（同时在走）
// ---------------------------------------------------------------------------

describe('要求 B-3：下一行同时在走', () => {
  it('上一行已经走满时，下一行正在逐字推进（不是空转）', () => {
    const state = computeDoubleLineState(LINES, 25)
    const bottom = next(state)

    expect(bottom.completed).toBe(false)
    expect(bottom.wordIndex).toBeGreaterThanOrEqual(0)
    expect(bottom.progress).toBeGreaterThan(0)
  })

  it('下一行的推进随时间前进（词下标往前走）', () => {
    const early = next(computeDoubleLineState(LINES, 21))
    const later = next(computeDoubleLineState(LINES, 28))

    expect(early.wordIndex).toBe(0)
    expect(later.wordIndex).toBeGreaterThan(early.wordIndex)
  })

  it('下一行还没开始时（时间在其第一个词之前）不推进', () => {
    const state = computeDoubleLineState(LINES, 12)
    expect(next(state).wordIndex).toBe(-1)
    expect(next(state).progress).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 要求 B-4：整页走完才一起换行
// ---------------------------------------------------------------------------

describe('要求 B-4：整页走完才一起换行', () => {
  it('下一行还没走满时，这一页的两行不变', () => {
    // 乙行 20~30s：t=25 时乙行还没唱完 → 仍是（甲行，乙行）
    const state = computeDoubleLineState(LINES, 25)
    expect(state.previousIndex).toBe(0)
    expect(state.nextIndex).toBe(1)
  })

  it('下一行走满的那一刻才整体换成新的两行（上一行 = 旧的下一行）', () => {
    // 乙行的最后一个词在 30.000s 结束 → 30s 整页走完
    const state = computeDoubleLineState(LINES, 30)
    expect(state.previousIndex).toBe(1)
    expect(state.nextIndex).toBe(2)
    // 新的「上一行」就是旧的「下一行」
    expect(state.previousIndex).toBe(1)
    expect(previous(state).completed).toBe(true)
  })

  it('整页走完前的最后一刻仍是旧的两行', () => {
    const state = computeDoubleLineState(LINES, 29.9)
    expect(state.previousIndex).toBe(0)
    expect(state.nextIndex).toBe(1)
  })

  it('换行后新的下一行从头开始走（progress 从 0 重新起步）', () => {
    const state = computeDoubleLineState(LINES, 30)
    expect(next(state).wordIndex).toBe(0)
    expect(next(state).completed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// phase：换行前 / 换行后
// ---------------------------------------------------------------------------

describe('phase：换行前 / 换行后', () => {
  it('上一行还没走满 → 换行前', () => {
    expect(computeDoubleLineState(LINES, 12).phase).toBe('before')
  })

  it('上一行已走满（停在全满态）→ 换行后', () => {
    expect(computeDoubleLineState(LINES, 25).phase).toBe('after')
  })
})

// ---------------------------------------------------------------------------
// 整页换行（页面切换）的**真信号**（复审 I-1）
// ---------------------------------------------------------------------------

describe('整页换行信号（页面切换）：phase 不是换行信号', () => {
  it('跨越点：t=29.9 与 t=30 的状态差异能反映换行（swappedAt 变了）', () => {
    // 乙行 20~30s → t=30 整页走完 → 换成新的一页（上一行 = 乙行）
    const before = computeDoubleLineState(LINES, 29.9)
    const after = computeDoubleLineState(LINES, 30)

    // 「刚刚走满的那一行」换行后成了 previous
    expect(before.previousIndex).toBe(0)
    expect(after.previousIndex).toBe(1)
    expect(after.previous?.completed).toBe(true)

    // 真信号：swappedAt（= 本页成为当前页的时刻）在跨越点**变化**
    //   跨越前还在第 0 页（还没换过页）→ null；跨越后是第 1 页 → 甲行走满的那一刻（20s）
    expect(before.swappedAt).toBeNull()
    expect(after.swappedAt).toBe(20)
    expect(after.swappedAt).not.toBe(before.swappedAt)
  })

  it('phase 在跨越点上**完全相同**（所以不能用 phase 判换行）', () => {
    const before = computeDoubleLineState(LINES, 29.9)
    const after = computeDoubleLineState(LINES, 30)

    expect(before.phase).toBe(after.phase)
    expect(before.phase).toBe('after')
  })

  it('上一行走满（t=20）时 phase 变了，但换行信号**没变**（两者不是同一个事件）', () => {
    const atBoundary = computeDoubleLineState(LINES, 20)
    const later = computeDoubleLineState(LINES, 25)

    expect(atBoundary.phase).toBe('after')
    expect(later.phase).toBe('after')
    // 还在同一页 → 换行信号不变
    expect(atBoundary.swappedAt).toBe(later.swappedAt)
    expect(atBoundary.previousIndex).toBe(later.previousIndex)
  })

  it('isPageSwapped：跨过换行点为 true，同一页内为 false', () => {
    const before = computeDoubleLineState(LINES, 29.9)
    const after = computeDoubleLineState(LINES, 30)

    expect(isPageSwapped(before, after)).toBe(true)
    expect(isPageSwapped(computeDoubleLineState(LINES, 20), computeDoubleLineState(LINES, 25))).toBe(false)
    // 没有上一帧时不算换行（首帧不播换行动画）
    expect(isPageSwapped(null, after)).toBe(false)
  })

  it('第一页还没换过页（swappedAt 为 null）', () => {
    const state = computeDoubleLineState(LINES, 12)
    expect(state.swappedAt).toBeNull()
    expect(state.previousIndex).toBe(0)
  })

  it('换行后「刚刚走满的那一行」是 previous（completed === true）', () => {
    const state = computeDoubleLineState(LINES, 30)
    expect(state.previousIndex).toBe(1)
    expect(state.previous?.completed).toBe(true)
    expect(state.previous?.progress).toBe(1)
  })

  it('next 永远是「还没走满的那一行」（next.completed 恒为 false，不能用来判换行）', () => {
    for (const t of [0, 12, 20, 25, 29.9, 30, 30.5, 999]) {
      expect(computeDoubleLineState(LINES, t).next?.completed ?? false).toBe(false)
    }
  })

  it('空歌词时没有换行信号（swappedAt 为 null）', () => {
    const state = computeDoubleLineState([], 12)
    expect(state.swappedAt).toBeNull()
    expect(state.previousIndex).toBe(-1)
    expect(state.nextIndex).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// 单行推进（computeLineProgress / lineEndTime）
// ---------------------------------------------------------------------------

describe('computeLineProgress', () => {
  it('走之前没有词被高亮', () => {
    const progress = computeLineProgress(LINES[0]!, 5)
    expect(progress.wordIndex).toBe(-1)
    expect(progress.progress).toBe(0)
    expect(progress.completed).toBe(false)
  })

  it('走到某个词上时该词被高亮，且 progress 递增', () => {
    const early = computeLineProgress(LINES[0]!, 11)
    const later = computeLineProgress(LINES[0]!, 16)
    expect(early.wordIndex).toBeGreaterThanOrEqual(0)
    expect(later.wordIndex).toBeGreaterThan(early.wordIndex)
    expect(later.progress).toBeGreaterThan(early.progress)
  })

  it('走完之后停在全满态', () => {
    const progress = computeLineProgress(LINES[0]!, 25)
    expect(progress.completed).toBe(true)
    expect(progress.progress).toBe(1)
  })

  it('没有词的行（空文本）不推进也不崩', () => {
    const empty = { time: 5, text: '', words: [], translation: '' }
    const progress = computeLineProgress(empty, 6)
    expect(progress.wordIndex).toBe(-1)
    expect(progress.wordCount).toBe(0)
    expect(progress.completed).toBe(false)
  })
})

describe('lineEndTime', () => {
  it('取最后一个词的结束时间', () => {
    const line = LINES[0]!
    expect(lineEndTime(line)).toBe(line.words[line.words.length - 1]!.end)
  })

  it('没有词时退回行时间', () => {
    expect(lineEndTime({ time: 7, text: '', words: [], translation: '' })).toBe(7)
  })
})
