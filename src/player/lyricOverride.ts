// ---------------------------------------------------------------------------
// T107：「按歌指定歌词源」的**纯函数**（渲染层）
// ---------------------------------------------------------------------------
//
// 这个模块回答一个问题：**「这首歌用哪个源取词？」**
//
// ⚠️ **为什么是「按歌」而不是「全局」**：
// - 全局源在**设置**里（`prefs.json` 的 `lyric.source`，见 `src/state/appPrefsStore.ts`）；
// - 用户真正的痛点是「**这一首**匹配不准」⇒ 需要**按歌**覆盖。
//
// ⚠️ **为什么住 `localStorage` 而不是 `prefs.json`**：
// - 「这首歌用哪个源」是**运行状态**（跟曲库走），不是「用户偏好」；
// - 仓库既有先例：「上次播到哪」明确**不进 `prefs.json`**（见 `src/player/resume.ts` 顶部）；
// - 取词与界面**都在渲染层** ⇒ 同一个 store 就是**单一真相源**，不需要镜像 / 同步。
//
// ⚠️ **本文件不许有副作用**：只有纯函数（可单测）；存储在
//    `src/state/lyricOverrideStore.ts` 里（端口形态，便于单测注入）。
//
// ---------------------------------------------------------------------------

import { PER_SONG_LYRIC_SOURCES, type LyricSource } from '../../shared/lyricProvider'

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 一条「按歌指定」。 */
export interface LyricOverrideEntry {
  /** 指定的源（**必须**是白名单里的合法源）。 */
  source: LyricSource
  /** 写入时间（Unix **毫秒**）—— 淘汰最旧用。 */
  updatedAt: number
}

/**
 * 最多存多少条指定。
 *
 * ⚠️ **为什么要有上限**：`localStorage` 配额有限（Chromium 约 5 MB），
 *    而指定是**一条一条攒**的 ⇒ 不封顶会慢慢涨满。
 *    200 条 × 约 60 B ≈ 12 KB ⇒ 配额上完全无压力。
 */
export const LYRIC_OVERRIDE_LIMIT = 200

/** 全部的指定（按曲目 guid 索引）。 */
export type LyricOverrideMap = Record<string, LyricOverrideEntry>

/**
 * 合法的源（白名单）。
 *
 * ⚠️ 用 `PER_SONG_LYRIC_SOURCES`（**不含 `off`**）：`off`（不用外部）是**全局**档位，
 *    「按歌指定」的语义是「**换一个更准的源**」⇒ 不接受 `off`。
 */
const LEGAL_SOURCES = PER_SONG_LYRIC_SOURCES as readonly string[]

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 规格化**一条**指定；任何一项不合法 ⇒ 整条丢弃。
 *
 * ⚠️ **外部数据不可信**：这份数据来自 `localStorage`（用户可编辑）
 *    ⇒ 陌生源名一律丢弃，**绝不**构造出半截数据。
 * ⚠️ **`off`（不用外部）不接受**：它是**全局**设置里的档位，
 *    而「按歌指定」的语义是「**换一个更准的源**」，不是「这首歌别查线上」。
 *
 * @param raw 任意输入。
 * @returns 合法时返回该条；否则 `null`。
 */
export function normalizeLyricOverride(raw: unknown): LyricOverrideEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const source = record['source']
  if (typeof source !== 'string') return null
  if (!LEGAL_SOURCES.includes(source)) return null

  const updatedAt = record['updatedAt']
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return null

  return { source: source as LyricSource, updatedAt }
}

/**
 * 规格化**整张表**：丢非法项 ＋ 超出上限时淘汰最旧的。
 *
 * ⚠️ 曲库 guid 是**主键** ⇒ 空串 / 纯空白的键一律丢弃。
 *
 * @param raw 任意输入（通常是 `JSON.parse` 出来的对象）。
 * @returns 干净的表（**不改动入参**）。
 */
export function normalizeLyricOverrides(raw: unknown): LyricOverrideMap {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const out: LyricOverrideMap = {}
  for (const [songId, value] of Object.entries(record)) {
    if (songId.trim() === '') continue
    const entry = normalizeLyricOverride(value)
    if (!entry) continue
    out[songId] = entry
  }
  return pruneLyricOverrides(out)
}

/**
 * 超出上限 ⇒ 淘汰**最旧**的那些（`updatedAt` 最小）。
 *
 * ⚠️ 淘汰的是「最少被改过的」⇒ 用户刚指定的那条**一定留着**。
 *
 * @param entries 现有的表。
 * @returns 清理后的表（**不改动入参**）。
 */
export function pruneLyricOverrides(entries: LyricOverrideMap): LyricOverrideMap {
  const list = Object.entries(entries)
  if (list.length <= LYRIC_OVERRIDE_LIMIT) return entries
  list.sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  const kept = list.slice(list.length - LYRIC_OVERRIDE_LIMIT)
  const out: LyricOverrideMap = {}
  for (const [songId, entry] of kept) out[songId] = entry
  return out
}

/**
 * 取某首歌的指定源。
 *
 * @param entries 现有的表。
 * @param songId 曲目 guid。
 * @returns 指定源；没有（或不合法）⇒ `null`（= 自动）。
 */
export function getLyricOverride(
  entries: LyricOverrideMap,
  songId: string,
): LyricSource | null {
  const entry = entries[songId]
  if (!entry) return null
  return entry.source
}

/**
 * 给某首歌指定源。
 *
 * ⚠️ **不改入参**（返回新表）⇒ 便于 store 用「不可变更新」比较前后。
 *
 * @param entries 现有的表。
 * @param songId 曲目 guid。
 * @param source 指定的源。
 * @param now 写入时间（Unix 毫秒）。
 * @returns 新的表（**已按上限清理**）。
 */
export function setLyricOverride(
  entries: LyricOverrideMap,
  songId: string,
  source: LyricSource,
  now: number,
): LyricOverrideMap {
  if (songId.trim() === '') return entries
  const out: LyricOverrideMap = { ...entries }
  out[songId] = { source, updatedAt: now }
  return pruneLyricOverrides(out)
}

/**
 * 清掉某首歌的指定（「恢复自动」）。
 *
 * @param entries 现有的表。
 * @param songId 曲目 guid。
 * @returns 新的表（**没有这一条时原样返回**）。
 */
export function clearLyricOverride(entries: LyricOverrideMap, songId: string): LyricOverrideMap {
  if (!(songId in entries)) return entries
  const out: LyricOverrideMap = { ...entries }
  delete out[songId]
  return out
}
