// ---------------------------------------------------------------------------
// 歌词来源合并（Task 32）—— 渲染层
// ---------------------------------------------------------------------------
//
// 这个模块回答一个问题：**「这首歌的歌词，从哪儿来？」**
//
// ---------------------------------------------------------------------------
// 优先级（用户拍板）
// ---------------------------------------------------------------------------
// **NAS 优先 → NAS 没有才查外部**。
//
// 理由：
// - NAS 自带的歌词是**本地已有的**，最准、也**不依赖外网**（断网照样有歌词）；
// - 外部源只做**补齐**，不抢 NAS 的活；
// - 于是「NAS 有歌词的歌 → **完全不发外部请求**」。
//
// ---------------------------------------------------------------------------
// 为什么外部源只回 LRC 文本
// ---------------------------------------------------------------------------
// 外部源返回的 LRC 会被包成**一或两条** `LyricEntry`（原文 / 翻译），
// 然后交给**现有**的 `parseLyricEntries` —— 翻译合并、冗余副本去重、伪逐字降级
// **全都白拿，解析逻辑一行不改**。
//
// ⚠️ 网易云的 `lrc.lyric`（原文）与 `tlyric.lyric`（翻译）正好对应两条 `LyricEntry`
//    → 现有解析器自动出双语。
// ⚠️ 但 lrclib 的 `syncedLyrics` 与 `plainLyrics` 是**同一首歌的两种格式**，
//    **不是**原文与翻译 → 主进程那边就只取其一（见 `electron/lyricProvider.ts`）。
//
// ---------------------------------------------------------------------------

import type { ExternalLyricResult } from '../../shared/lyricProvider'
import type { LyricEntry } from '../api/types'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一首歌里**匹配外部源**需要的信息。
 *
 * ⚠️ 只有这四个字段 —— 不含任何地址、不含凭证。
 */
export interface LyricMatchTarget {
  /** 歌名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 专辑名（可能为空串）。 */
  album: string
  /** 时长（**秒**）。 */
  duration: number
}

/** NAS 歌词接口的最小面。 */
export interface NasLyricApi {
  /** 全部歌词条目（同一首歌可能有多条来源不同的记录）。 */
  list(songId: string): Promise<LyricEntry[]>
}

/**
 * 外部歌词的取法（可注入，便于单测）。
 *
 * ⚠️ 实现方**必须**走 IPC 到主进程（渲染层**不碰网络**）。
 */
export type ExternalLyricFetcher = (target: LyricMatchTarget) => Promise<ExternalLyricResult>

/** 取歌词的结果。 */
export interface LyricLoadResult {
  /** 歌词条目（交给 `parseLyricEntries`）。 */
  entries: LyricEntry[]
  /** 实际用到的来源。 */
  origin: 'nas' | 'external' | 'none'
  /**
   * 失败原因（**只有**在「NAS 没有 + 外部也没取到」时才有值）。
   *
   * ⚠️ 界面要**如实显示**它 —— 不能悄悄显示「暂无歌词」，
   *    用户会以为是自己网络的问题，而不是歌词源坏了。
   */
  reason: string | null
}

/** `loadLyricEntries` 的依赖。 */
export interface LyricLoadDeps {
  /** NAS 歌词接口。 */
  api: NasLyricApi
  /**
   * 外部歌词取法。
   *
   * ⚠️ **可缺省**（`undefined` / `null`）→ 不查外部。
   *    这样既有的单元测试（只注入 `api`）**行为完全不变**。
   */
  external?: ExternalLyricFetcher | null
}

/** 外部歌词包成 `LyricEntry` 用的前缀（保证 guid 不与 NAS 的撞）。 */
const EXTERNAL_GUID_PREFIX = 'external'

/**
 * 把外部源返回的原文 / 翻译包成 `LyricEntry[]`。
 *
 * ⚠️ **顺序很重要**：第一条必须是**原文**，第二条是**翻译**
 *    —— `parseLyricEntries` 按「第一条作原文、其余作翻译」的规则合并。
 *
 * @param songId 歌曲 guid（只用来拼一个不冲突的 guid）。
 * @param result 外部源的结果。
 * @returns 至少一条（原文非空时）—— 全空则返回空数组。
 */
export function toExternalEntries(songId: string, result: ExternalLyricResult): LyricEntry[] {
  if (result.status !== 'ok') return []
  const entries: LyricEntry[] = []
  const original = result.original.trim()
  const translation = result.translation.trim()
  if (original) {
    entries.push({
      guid: `${EXTERNAL_GUID_PREFIX}:${songId}:original`,
      source: result.source,
      content: result.original,
      createdAt: null,
      updatedAt: null,
      // ⚠️ 外部源给的就是**带时间戳的 LRC**（主进程那边判过 `looksLikeLrc`）。
      isLRC: true,
      offset: 0,
    })
  }
  if (translation) {
    entries.push({
      guid: `${EXTERNAL_GUID_PREFIX}:${songId}:translation`,
      source: result.source,
      content: result.translation,
      createdAt: null,
      updatedAt: null,
      isLRC: true,
      offset: 0,
    })
  }
  return entries
}

/**
 * 取一首歌的歌词（**NAS 优先 → 缺了再查外部**）。
 *
 * ⚠️ **外部取失败不抛异常**：返回 `origin: 'none'` + `reason`，
 *    由界面如实显示 —— 不能让外部源的抖动把整个歌词功能带崩。
 *
 * @param songId 歌曲 guid。
 * @param target 匹配外部源要用的信息（歌名 / 歌手 / 专辑 / 时长）。
 * @param deps 依赖（NAS 接口 + 可选的外部取法）。
 */
export async function loadLyricEntries(
  songId: string,
  target: LyricMatchTarget,
  deps: LyricLoadDeps,
): Promise<LyricLoadResult> {
  // --- 1. NAS 优先 ---------------------------------------------------------
  let nasEntries: LyricEntry[] = []
  /** NAS 这次是**读取失败**（区别于「读到了，但本来就没歌词」）。 */
  let nasFailed = false
  try {
    nasEntries = (await deps.api.list(songId)) ?? []
  } catch {
    // ⚠️ NAS 取失败**不直接放弃**：接着问外部源（它可能是唯一有歌词的地方）。
    nasFailed = true
    nasEntries = []
  }
  if (nasEntries.length > 0) {
    return { entries: nasEntries, origin: 'nas', reason: null }
  }

  // --- 2. 外部补齐 ---------------------------------------------------------
  const external = deps.external
  if (!external) {
    // ⚠️ **保住既有语义**：NAS 读取失败 → 界面显示「歌词加载失败」；
    //    NAS 读到了但本来就没歌词 → 界面显示「暂无歌词」。
    return { entries: [], origin: 'none', reason: nasFailed ? '歌词加载失败' : null }
  }
  let result: ExternalLyricResult
  try {
    result = await external(target)
  } catch (cause) {
    return {
      entries: [],
      origin: 'none',
      reason: cause instanceof Error ? cause.message : '连接歌词源失败',
    }
  }
  if (result.status === 'error') {
    return { entries: [], origin: 'none', reason: result.message }
  }
  if (result.status === 'not-found') {
    // ⚠️ 外部源**确实没有**这首歌的歌词 → 不是错误，是「没有」。
    //    但如果 NAS 这次是**读取失败**，那还是得说「歌词加载失败」。
    return { entries: [], origin: 'none', reason: nasFailed ? '歌词加载失败' : null }
  }
  const entries = toExternalEntries(songId, result)
  if (!entries.length) {
    return { entries: [], origin: 'none', reason: null }
  }
  return { entries, origin: 'external', reason: null }
}

/**
 * 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。
 */
function playerBridge(): { fetchExternalLyric?: ExternalLyricFetcher } | null {
  const scope = globalThis as unknown as {
    fnPlayer?: { fetchExternalLyric?: ExternalLyricFetcher }
  }
  return scope.fnPlayer ?? null
}

/**
 * 默认的外部歌词取法：**经 IPC 到主进程**。
 *
 * ⚠️ 渲染层**不碰网络** —— 这里只发 IPC 请求。
 * ⚠️ 没有桥（浏览器预览 / 单测）→ 返回 `null`（**不查外部**）。
 */
export function defaultExternalLyricFetcher(): ExternalLyricFetcher | null {
  const bridge = playerBridge()
  const fn = bridge?.fetchExternalLyric
  if (!fn) return null
  return async (target: LyricMatchTarget): Promise<ExternalLyricResult> => await fn(target)
}
