// ---------------------------------------------------------------------------
// T89-⑲：启动时恢复上次播放（**编排**）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独一个模块**：恢复要串起四件事——
//   「开关开没开」→「有没有记录」→「值不值得恢复」→「曲库里还有没有这一首」——
//   每一步都可能失败，而**每一步失败都不该让应用崩**。
//   ⇒ 把它们编排成一个**可注入**的纯流程，单测就能覆盖全部分支，
//   **不碰网络、不碰存储**。
//
// ⚠️ **为什么必须拿到曲库里的完整曲目**（规格 D4）：
//   那条记录只有 7 个字段（够显示 + 定位），但 `Song` 里的 `codec` 留空会被
//   引擎判成「Chromium 解不了」而可能根本播不起来（`src/player/engine.ts`），
//   `favorite` 留空会显示「未收藏」、用户一点可能把服务端的收藏**反过来写掉**
//   ⇒ **宁可不恢复**，也不拿残缺数据硬播。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。
// ---------------------------------------------------------------------------

import type { Song } from '../../shared/types'
import { shouldResume, type ResumeRecord } from '../player/resume'
import { libraryApi } from '../api/library'

/**
 * 恢复的结果。
 *
 * ⚠️ **「为什么没恢复」也要说得清楚**（可被界面 / 日志如实引用）：
 * - `disabled`：用户关掉了「启动时自动播放」；
 * - `no-record`：没有记录（或读不出来）；
 * - `not-worth`：位置太靠前 / 距结尾太近 ⇒ 从头播更自然；
 * - `song-gone`：这一首已不在曲库里；
 * - `lookup-failed`：查曲库失败（NAS 不通等）；
 * - `superseded`：等流程的工夫里**用户自己动手了**（已经自己播了别的）⇒ 不抢。
 */
export type ResumeOutcome =
  | {
      restored: false
      reason:
        | 'disabled'
        | 'no-record'
        | 'not-worth'
        | 'song-gone'
        | 'lookup-failed'
        | 'superseded'
    }
  | { restored: true; reason: 'ok'; song: Song; positionSec: number }

/** 恢复流程的依赖（**可注入** ⇒ 单测不碰网络与存储）。 */
export interface ResumeFlowDeps {
  /** 「启动时自动播放」开关当前的值。 */
  autoplayEnabled: () => boolean
  /** 读回上次播放的记录（读不出来就抛 / 返回 `null`）。 */
  load: () => Promise<ResumeRecord | null>
  /** 按 id 找**完整**曲目（找不到返回 `null`）。 */
  findSong: (id: string) => Promise<Song | null>
  /** 起播并定位到指定位置。 */
  play: (song: Song, positionSec: number) => void
  /**
   * 现在**还该不该**恢复（**可选**，缺省 = 该恢复）。
   *
   * ⚠️ 恢复是**异步**的（要等偏好、查曲库）⇒ 这中间用户完全可能自己点了一首歌
   *    ⇒ 那时恢复就**不该**把用户正在听的东西顶掉。
   */
  canPlay?: () => boolean
}

/**
 * 恢复上次播放。
 *
 * ⚠️ **任何一步失败都不抛异常**——返回 `restored: false` + 原因即可
 *    （启动路径上抛异常会把整个应用带崩）。
 */
export async function restoreLastPlayback(deps: ResumeFlowDeps): Promise<ResumeOutcome> {
  if (!deps.autoplayEnabled()) return { restored: false, reason: 'disabled' }

  let record: ResumeRecord | null = null
  try {
    record = await deps.load()
  } catch {
    return { restored: false, reason: 'no-record' }
  }
  if (!record) return { restored: false, reason: 'no-record' }

  // ⚠️ 位置太靠前（刚开头）或距结尾太近 ⇒ 从头播更自然。
  if (!shouldResume(record)) return { restored: false, reason: 'not-worth' }

  let song: Song | null = null
  try {
    song = await deps.findSong(record.id)
  } catch {
    // ⚠️ 查曲库失败（NAS 不通 / 会话失效）⇒ **不恢复**，不硬播残缺数据。
    return { restored: false, reason: 'lookup-failed' }
  }
  if (!song) return { restored: false, reason: 'song-gone' }

  // ⚠️ **最后一道闸**：查曲库是异步的 ⇒ 这中间用户完全可能自己点了歌
  //    ⇒ 那时恢复**不该**把用户正在听的东西顶掉（恢复是「补上没做完的事」，
  //    不是「覆盖用户的操作」）。
  if (deps.canPlay && !deps.canPlay()) {
    return { restored: false, reason: 'superseded' }
  }

  deps.play(song, record.positionSec)
  return { restored: true, reason: 'ok', song, positionSec: record.positionSec }
}

/** 扫曲库页的条数（服务端单页上限 2000）。 */
const FIND_PAGE_SIZE = 2000
/** 最多扫几页（6000 首）——扫不到就**不恢复**（如实），不无限翻页。 */
const FIND_MAX_PAGES = 3

/**
 * 按 id 在曲库里找那一首（**返回完整曲目**）。
 *
 * ⚠️ 服务端**没有**「按 guid 查单首」的端点 ⇒ 只能分页扫
 *    （实测全库 797 首 ⇒ 一页就够）。
 * ⚠️ 扫不全就返回 `null` ⇒ 上层**不恢复**（不拿残缺数据硬播）。
 */
export async function findSongById(id: string): Promise<Song | null> {
  if (typeof id !== 'string' || id.length === 0) return null
  for (let page = 1; page <= FIND_MAX_PAGES; page += 1) {
    const result = await libraryApi.songs(page, FIND_PAGE_SIZE)
    const hit = result.list.find((song) => song.id === id)
    if (hit) return hit
    // ⚠️ 这一页没满 ⇒ 后面没有了，不必再翻。
    if (result.list.length < FIND_PAGE_SIZE) return null
  }
  return null
}
