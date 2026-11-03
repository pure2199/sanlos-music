// 播放队列（**渲染进程**）。
//
// ---------------------------------------------------------------------------
// 语义（控制器追加要求 F，逐条定死，不要自己发挥）
// ---------------------------------------------------------------------------
// - `next()`
//   - `sequence`：下一首；已是最后一首 → 返回 `null`（**不**自动回到第一首）；
//   - `shuffle`：随机下一首；队列只剩一首 → 返回当前那首；随机**不重复**当前曲（队列 >1 时）；
//   - `loop-one`：始终返回当前那首；
//   - `loop-list`：下一首；最后一首 → **回到第一首**；
//   - 队列为空 → `null`。
// - `prev(positionSec)`
//   - 播放进度 **> 3 秒**时 → 回到**本曲开头**（返回当前曲；引擎负责 seek 到 0）；
//   - 否则 → 上一首；`sequence` 在第一首 → `null`；`loop-list` 在第一首 → 最后一首；
//     `loop-one` → 当前曲。**3 秒阈值是本任务定的**，见 `PREV_RESTART_THRESHOLD_SEC`。
// - `remove(i)`：删掉当前曲**之前**的 → `index - 1`；删掉当前曲 → `index` 不变
//   （自然指向原来的下一首；删的是最后一首则 `index - 1`）；删掉当前曲**之后**的 → 不变；
//   **越界索引 → 忽略**；删空 → `index` 归 0 且不为负。
// - `add(songs, at?)`：缺省追加到末尾；越界钳到末尾；负数视为 0；
//   插入位置在当前曲**之前**时 `index` 后移（当前曲不能被顶走）。
// - `shuffle()`：Fisher–Yates 打乱 `items`，**不改变 `mode`**，
//   且**当前曲仍然是当前曲**（打乱后 `items[index]` 仍是同一首歌）。
// - `clear()`：`items` 清空，`index` 归 0。
//
// ---------------------------------------------------------------------------
// 类型来源
// ---------------------------------------------------------------------------
// `PlayMode` **从 `shared/types.ts` re-export**（唯一真相源），本文件**不另定义**一份。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。

import type { PlayMode, Song } from '../../shared/types'

export type { PlayMode } from '../../shared/types'

/**
 * `prev()` 的「回到本曲开头」阈值（**秒**）。
 *
 * 进度 **严格大于** 该值时 `prev()` 返回当前曲；正好等于该值时按「上一首」处理。
 * 这条阈值是本任务定的，引擎与 store 共用同一口径。
 */
export const PREV_RESTART_THRESHOLD_SEC = 3

/** 播放队列。 */
export class Queue {
  /** 队列内容。 */
  items: Song[] = []
  /** 当前曲下标（`items[index]`）。 */
  index = 0
  /** 播放模式。 */
  mode: PlayMode = 'sequence'

  /**
   * 入队。
   *
   * @param songs 要加入的歌曲。
   * @param at    插入位置；缺省追加到末尾；越界钳到末尾；负数视为 0。
   */
  add(songs: Song[], at?: number): void {
    if (!Array.isArray(songs) || songs.length === 0) return
    const size = this.items.length
    let position = size
    if (typeof at === 'number' && Number.isFinite(at)) {
      position = Math.floor(at)
    }
    if (position < 0) position = 0
    if (position > size) position = size

    this.items.splice(position, 0, ...songs)

    // 插入点在当前曲**之前** → 当前曲后移，不能被顶走。
    // （队列原本为空时没有「当前曲」可言，index 保持 0 即指向新加入的第一首。）
    if (size > 0 && position <= this.index) {
      this.index += songs.length
    }
  }

  /**
   * 下一首。
   *
   * @returns 下一首歌；按当前模式无下一首时返回 `null`。
   */
  next(): Song | null {
    const size = this.items.length
    if (size === 0) return null
    this.clampIndex()

    switch (this.mode) {
      case 'loop-one':
        // 始终当前曲，index 不动。
        return this.items[this.index] ?? null

      case 'loop-list': {
        const nextIndex = (this.index + 1) % size
        this.index = nextIndex
        return this.items[nextIndex] ?? null
      }

      case 'shuffle': {
        if (size === 1) {
          this.index = 0
          return this.items[0] ?? null
        }
        // 在「除当前曲以外」的 size-1 首里等概率取一首（不重复当前曲）。
        const picked = Math.floor(Math.random() * (size - 1))
        const nextIndex = picked >= this.index ? picked + 1 : picked
        this.index = nextIndex
        return this.items[nextIndex] ?? null
      }

      case 'sequence':
      default: {
        const nextIndex = this.index + 1
        if (nextIndex >= size) return null
        this.index = nextIndex
        return this.items[nextIndex] ?? null
      }
    }
  }

  /**
   * 上一首。
   *
   * @param positionSec 当前播放进度（**秒**）。> 3 秒时视为「回到本曲开头」。
   */
  prev(positionSec = 0): Song | null {
    const size = this.items.length
    if (size === 0) return null
    this.clampIndex()

    const position = typeof positionSec === 'number' && Number.isFinite(positionSec) ? positionSec : 0

    // 播过一段（> 3 秒）→ 回到本曲开头（返回当前曲，引擎负责 seek 到 0）。
    if (position > PREV_RESTART_THRESHOLD_SEC) {
      return this.items[this.index] ?? null
    }

    if (this.mode === 'loop-one') {
      return this.items[this.index] ?? null
    }

    if (this.mode === 'loop-list') {
      const prevIndex = (this.index - 1 + size) % size
      this.index = prevIndex
      return this.items[prevIndex] ?? null
    }

    // sequence / shuffle：第一首没有上一首 → null（不自动绕回）。
    const prevIndex = this.index - 1
    if (prevIndex < 0) return null
    this.index = prevIndex
    return this.items[prevIndex] ?? null
  }

  /**
   * 移除一首歌（越界索引**忽略**，不抛错）。
   */
  remove(i: number): void {
    if (typeof i !== 'number' || !Number.isFinite(i)) return
    const target = Math.floor(i)
    if (target < 0 || target >= this.items.length) return

    this.items.splice(target, 1)

    if (this.items.length === 0) {
      this.index = 0
      return
    }

    if (target < this.index) {
      // 删的是当前曲**之前**的 → 当前曲前移一位。
      this.index -= 1
    } else if (target === this.index) {
      // 删的是当前曲 → index 保持不变，自然指向原来的下一首；
      // 删的是最后一首时 index 会越界 → 退一格。
      if (this.index >= this.items.length) this.index = this.items.length - 1
    }
    // target > index → 当前曲位置不变。

    if (this.index < 0) this.index = 0
  }

  /** 清空队列（`index` 归 0）。 */
  clear(): void {
    this.items.splice(0, this.items.length)
    this.index = 0
  }

  /**
   * 打乱顺序（**Fisher–Yates**，不用有偏的 `sort(() => Math.random() - 0.5)`）。
   *
   * - **不改变** `mode`；
   * - **当前曲仍然是当前曲**：打乱后 `items[index]` 仍是同一首歌。
   */
  shuffle(): void {
    const size = this.items.length
    if (size <= 1) return
    this.clampIndex()

    const current = this.items[this.index]
    if (!current) return

    // 先把当前曲摘出去，再对其余歌曲做 Fisher–Yates，最后把当前曲放回原位。
    const rest = this.items.filter((_, index) => index !== this.index)
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = rest[i]!
      rest[i] = rest[j]!
      rest[j] = tmp
    }

    const target = Math.min(this.index, rest.length)
    rest.splice(target, 0, current)

    // 原地替换（保持数组引用不变，避免别处持有的引用失效）。
    this.items.splice(0, this.items.length, ...rest)
    this.index = target
  }

  /** 把 `index` 夹到合法区间。 */
  private clampIndex(): void {
    if (this.items.length === 0) {
      this.index = 0
      return
    }
    if (this.index < 0) this.index = 0
    if (this.index >= this.items.length) this.index = this.items.length - 1
  }
}
