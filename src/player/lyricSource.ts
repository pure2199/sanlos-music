// ---------------------------------------------------------------------------
// 歌词来源合并（Task 32）—— 渲染层
// ---------------------------------------------------------------------------
//
// 这个模块回答一个问题：**「这首歌的歌词，从哪儿来？」**
//
// ---------------------------------------------------------------------------
// 优先级（T70：用户拍板「线上优先，线上匹配不上再回落本地」）
// ---------------------------------------------------------------------------
// 两档，**缺省 = 线上优先**：
//
// - `online-first`（**线上优先**）：线上（外部源）匹配上就用线上的；
//   线上匹配不上 / 源不可用 / 卡住超时就**回落本地**（NAS 自带的歌词）。
//   理由：线上（网易云 yrc 等）能给出**真逐字**时间戳 ⇒ 卡拉OK 填色更跟嘴；
// - `local-first`（**本地优先**）：NAS 自带的先用，NAS 没有才查外部
//   —— **Task 32 的老口径，代码路径一字保留**。
//
// ⚠️ **优先级的口径与「用哪个源」是两件事**：
//    「用哪个源」= 网易云 / lrclib / QQ / 自定义 / 不用外部；
//    「谁优先」= 线上优先 / 本地优先。
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

import type { ExternalLyricResult, LyricPriority, LyricSource } from '../../shared/lyricProvider'
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
  origin: 'nas' | 'external' | 'embedded' | 'none'
  /**
   * **实际命中的那个线上源**（T73）。
   *
   * ⚠️ 只在 `origin === 'external'` 时有值 —— 因为源链是「**依次试**」的
   *    ⇒ 命中的**未必**是用户选的那个（如：选了网易云没匹配上 → 用了 lrclib）。
   *    ⇒ 界面要**如实显示它**，不能装作是首选源。
   */
  externalSource?: LyricSource
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
  /**
   * **音频内嵌歌词**的取法（T83）。
   *
   * ⚠️ **可缺省**（`undefined` / `null`）⇒ 不查内嵌。
   *    这样既有的单元测试（只注入 `api`）**行为完全不变**。
   */
  embedded?: EmbeddedLyricFetcher | null
  /**
   * 歌词来源的**优先级**（T70）。
   *
   * ⚠️ **缺省 = `'online-first'`**（线上优先）—— 用户显式要求。
   * ⚠️ `'local-first'` = Task 32 的老口径（本地优先）。
   */
  priority?: LyricPriority
  /**
   * 线上查询的**超时**（毫秒）。
   *
   * ⚠️ 缺省 = {@link ONLINE_LYRIC_TIMEOUT_MS}（**10 秒**）——
   *    外网不通时不能让人干等（主进程的 http 超时是 30 秒，太久）；
   *    但也不能太短（用户拍板：**5 秒太短**，慢一点的词源会被误判成「没有」）。
   */
  timeoutMs?: number
}

/** 外部歌词包成 `LyricEntry` 用的前缀（保证 guid 不与 NAS 的撞）。 */
const EXTERNAL_GUID_PREFIX = 'external'

/** 内嵌歌词包成 `LyricEntry` 用的前缀（保证 guid 不与 NAS 的撞）。 */
const EMBEDDED_GUID_PREFIX = 'embedded'

/**
 * **音频内嵌歌词**的取法（T83；可注入，便于单测）。
 *
 * ⚠️ 返回**空串** = 这个曲目没有内嵌歌词。
 * ⚠️ **主进程做**：读文件 / 取流都在主进程（渲染层不碰文件系统）。
 */
export type EmbeddedLyricFetcher = (songId: string) => Promise<string>

/**
 * 把内嵌歌词文本包成 `LyricEntry[]`。
 *
 * ⚠️ **只有一条**（内嵌歌词没有「原文 / 翻译」之分）。
 *
 * @param songId 歌曲 guid（只用来拼一个不冲突的 guid）。
 * @param content LRC 文本。
 */
export function toEmbeddedEntries(songId: string, content: string): LyricEntry[] {
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text) return []
  return [
    {
      guid: `${EMBEDDED_GUID_PREFIX}:${songId}`,
      source: EMBEDDED_GUID_PREFIX,
      content: text,
      createdAt: null,
      updatedAt: null,
      // ⚠️ 内嵌歌词就是**带时间戳的 LRC**（`SYLT` 已被主进程转成增强 LRC）。
      isLRC: true,
      offset: 0,
    },
  ]
}

/**
 * 把外部源返回的原文 / 翻译 / 罗马音包成 `LyricEntry[]`（T90-③）。
 *
 * ⚠️ **顺序很重要**：第一条必须是**原文**，后面是**翻译**、**罗马音**
 *    —— `parseLyricEntries` 按「第一条作原文、其余作翻译」的规则合并。
 *
 * ⚠️ **每条都带 `role`**（T90-③）：角色标记是「三行」的依据 ——
 *    没有它就只能靠位置猜（第一条原文、第二条翻译），加第三行时必然歧义。
 *    `parseLyricEntries` 对**没有 `role`** 的条目仍然走旧的位置约定
 *    ⇒ **既有数据（NAS / 内嵌）行为一条不变**。
 *
 * ⚠️ **没有罗马音就不产第三条**（多数源本来就没有）⇒ 解析与渲染层**不会**多出一行。
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
  // ⚠️ 罗马音是**可选**字段（`ExternalLyricResult.romanization`）⇒ 老调用点没有它。
  const rawRomanization = typeof result.romanization === 'string' ? result.romanization : ''
  const romanization = rawRomanization.trim()
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
      role: 'original',
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
      role: 'translation',
    })
  }
  if (romanization) {
    entries.push({
      guid: `${EXTERNAL_GUID_PREFIX}:${songId}:romanization`,
      source: result.source,
      content: rawRomanization,
      createdAt: null,
      updatedAt: null,
      isLRC: true,
      offset: 0,
      role: 'romanization',
    })
  }
  return entries
}

/**
 * 线上查询的**超时上限**（毫秒）—— 超过就回落本地（T70）。
 *
 * ⚠️ 为什么不是主进程那个 30 秒：主进程的 http 超时是**通用**的，
 *    30 秒用来等一个「下歌」不算离谱；但歌词是**要立刻显示**的东西
 *    ⇒ 外网挂住时最多空窗 **10 秒**，然后立刻回落到本地那份。
 */
export const ONLINE_LYRIC_TIMEOUT_MS = 12000

/** 线上超时时的原因文案（如实告诉用户「不是没歌词，是源没回话」）。 */
export const ONLINE_TIMEOUT_REASON = '歌词源响应超时'

/**
 * 线上查询的结果 —— 除了三种源状态，还多一种「**超时**」。
 */
type OnlineOutcome =
  | { kind: 'result'; result: ExternalLyricResult }
  | { kind: 'timeout' }

/**
 * 读本地（NAS）的歌词条目。
 *
 * ⚠️ **读取失败 ≠ 没有歌词**：前者是「连不上 / 没权限」，后者是「确实没有」。
 *    两者要分开记 —— 界面的文案不一样。
 */
async function readNas(
  api: NasLyricApi,
  songId: string,
): Promise<{ entries: LyricEntry[]; failed: boolean }> {
  try {
    return { entries: (await api.list(songId)) ?? [], failed: false }
  } catch {
    // ⚠️ NAS 取失败**不直接放弃**：线上（本地优先时是外部源）可能是唯一有歌词的地方。
    return { entries: [], failed: true }
  }
}

/**
 * 读**音频内嵌歌词**（T83；**永不抛**）。
 *
 * ⚠️ 读不到 ⇒ 当「没有」（**不该**让整个取词流程炸掉）。
 */
async function readEmbedded(
  embedded: EmbeddedLyricFetcher | null | undefined,
  songId: string,
): Promise<LyricEntry[]> {
  if (!embedded) return []
  try {
    return toEmbeddedEntries(songId, await embedded(songId))
  } catch {
    return []
  }
}

/**
 * 查线上歌词，**带超时**。
 *
 * ⚠️ **抛异常也当成一种结果**（`status: 'error'`）—— 不能让 IPC 断了
 *    把整个取词流程炸掉。
 * ⚠️ **超时后那个请求还在跑**：它的结果被丢弃即可（主进程那边有缓存）。
 */
async function fetchOnline(
  external: ExternalLyricFetcher,
  target: LyricMatchTarget,
  timeoutMs: number,
): Promise<OnlineOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<OnlineOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  try {
    const resultPromise: Promise<OnlineOutcome> = external(target).then(
      (result): OnlineOutcome => ({ kind: 'result', result }),
      (cause): OnlineOutcome => ({
        kind: 'result',
        result: {
          status: 'error',
          message: cause instanceof Error ? cause.message : '连接歌词源失败',
        },
      }),
    )
    return await Promise.race([resultPromise, timeoutPromise])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 「本地优先」（Task 32 的老口径）—— **代码路径一字不改**。
 *
 * ⚠️ NAS 有歌词 → 直接用（**完全不发外部请求**）；NAS 没有 → 才查外部。
 * ⚠️ **T83**：**内嵌歌词算「本地侧」，排在 NAS 前面**（用户 2026-11-10 拍板的方案 A）——
 *    内嵌是**作者自己放的**，比服务端刮来的更准。
 */
async function loadLocalFirst(
  songId: string,
  target: LyricMatchTarget,
  deps: LyricLoadDeps,
): Promise<LyricLoadResult> {
  const embedded = await readEmbedded(deps.embedded, songId)
  if (embedded.length > 0) {
    return { entries: embedded, origin: 'embedded', reason: null }
  }

  const nas = await readNas(deps.api, songId)
  if (nas.entries.length > 0) {
    return { entries: nas.entries, origin: 'nas', reason: null }
  }

  const external = deps.external
  if (!external) {
    // ⚠️ **保住既有语义**：NAS 读取失败 → 界面显示「歌词加载失败」；
    //    NAS 读到了但本来就没歌词 → 界面显示「暂无歌词」。
    return { entries: [], origin: 'none', reason: nas.failed ? '歌词加载失败' : null }
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
    return { entries: [], origin: 'none', reason: nas.failed ? '歌词加载失败' : null }
  }
  const entries = toExternalEntries(songId, result)
  if (!entries.length) {
    return { entries: [], origin: 'none', reason: null }
  }
  return { entries, origin: 'external', externalSource: result.source, reason: null }
}

/**
 * 「线上优先」（T70 的新口径）—— 线上匹配不上就**回落本地**。
 */
async function loadOnlineFirst(
  songId: string,
  target: LyricMatchTarget,
  deps: LyricLoadDeps,
): Promise<LyricLoadResult> {
  const external = deps.external
  // ⚠️ **没有外部取法** ⇒ **零外部请求**，直接用本地（**内嵌 → NAS**，T83）。
  if (!external) {
    const embedded = await readEmbedded(deps.embedded, songId)
    if (embedded.length > 0) {
      return { entries: embedded, origin: 'embedded', reason: null }
    }
    const nas = await readNas(deps.api, songId)
    if (nas.entries.length > 0) {
      return { entries: nas.entries, origin: 'nas', reason: null }
    }
    return { entries: [], origin: 'none', reason: nas.failed ? '歌词加载失败' : null }
  }

  const outcome = await fetchOnline(external, target, deps.timeoutMs ?? ONLINE_LYRIC_TIMEOUT_MS)

  if (outcome.kind === 'result' && outcome.result.status === 'ok') {
    const entries = toExternalEntries(songId, outcome.result)
    if (entries.length > 0) {
      // ⚠️ 线上匹配上 ⇒ **用线上的**（本地那份**不用**）。
      //    代价：线上没翻译时，这首歌就没翻译（用户已拍板接受）。
      // ⚠️ T73：带上**实际命中的那个源**（源链是依次试的，未必是首选源）。
      return { entries, origin: 'external', externalSource: outcome.result.source, reason: null }
    }
    // ⚠️ `ok` 但原文与翻译**都为空** ⇒ 视同**匹配不上** ⇒ 回落本地。
  }

  // --- 线上匹配不上（not-found / error / 超时 / ok 但内容空）⇒ 回落本地（**内嵌 → NAS**，T83）----
  const embedded = await readEmbedded(deps.embedded, songId)
  if (embedded.length > 0) {
    return { entries: embedded, origin: 'embedded', reason: null }
  }
  const nas = await readNas(deps.api, songId)
  if (nas.entries.length > 0) {
    // ⚠️ 线上坏**不该**让用户看不到本地已有的歌词 ⇒ `reason = null`。
    return { entries: nas.entries, origin: 'nas', reason: null }
  }

  // 两边都没有 ⇒ **如实带出原因**（不假装成「暂无歌词」）。
  // ⚠️ 优先级：本地读取失败 > 线上报错 > 线上超时 > 无。
  const onlineReason =
    outcome.kind === 'timeout'
      ? ONLINE_TIMEOUT_REASON
      : outcome.kind === 'result' && outcome.result.status === 'error'
        ? outcome.result.message
        : null
  return {
    entries: [],
    origin: 'none',
    reason: nas.failed ? '歌词加载失败' : onlineReason,
  }
}

/**
 * 取一首歌的歌词。
 *
 * ⚠️ **优先级**由 `deps.priority` 决定（缺省 `'online-first'`，T70）：
 * - `'online-first'`：线上匹配上就用线上的；匹配不上 / 报错 / 超时 ⇒ **回落本地**；
 * - `'local-first'`：本地优先（Task 32 的老口径）。
 *
 * ⚠️ **取不到不抛异常**：返回 `origin: 'none'` + `reason`，
 *    由界面如实显示 —— 不能让外部源的抖动把整个歌词功能带崩。
 *
 * @param songId 歌曲 guid。
 * @param target 匹配外部源要用的信息（歌名 / 歌手 / 专辑 / 时长）。
 * @param deps 依赖（NAS 接口 + 可选的外部取法 + 优先级）。
 */
export async function loadLyricEntries(
  songId: string,
  target: LyricMatchTarget,
  deps: LyricLoadDeps,
): Promise<LyricLoadResult> {
  const priority = deps.priority ?? 'online-first'
  if (priority === 'local-first') {
    return await loadLocalFirst(songId, target, deps)
  }
  return await loadOnlineFirst(songId, target, deps)
}

/**
 * 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。
 */
function playerBridge(): {
  fetchExternalLyric?: ExternalLyricFetcher
  readEmbeddedLyric?: (id: string) => Promise<string>
} | null {
  const scope = globalThis as unknown as {
    fnPlayer?: {
      fetchExternalLyric?: ExternalLyricFetcher
      readEmbeddedLyric?: (id: string) => Promise<string>
    }
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

/**
 * 默认的**内嵌歌词**取法：**经 IPC 到主进程**（T83）。
 *
 * ⚠️ 渲染层**不碰文件系统** —— 这里只发 IPC 请求（只报曲目 id）。
 * ⚠️ 没有桥（浏览器预览 / 单测）→ 返回 `null`（**不查内嵌**）。
 */
export function defaultEmbeddedLyricFetcher(): EmbeddedLyricFetcher | null {
  const bridge = playerBridge()
  const fn = bridge?.readEmbeddedLyric
  if (!fn) return null
  return async (songId: string): Promise<string> => {
    const content = await fn(songId)
    return typeof content === 'string' ? content : ''
  }
}
