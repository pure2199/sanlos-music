// ---------------------------------------------------------------------------
// 「有声读物」识别与排序（**纯函数**，T98）
//
// ---------------------------------------------------------------------------
// 为什么是纯函数模块
// ---------------------------------------------------------------------------
// 识别（是不是有声读物）与排序（按集序排）都必须是**可单测的纯逻辑**：
// - 输入：一批曲目 + 一个专辑 id；
// - 输出：判定结果（分数 + 依据）/ 排好序的曲目；
// ⇒ 不碰网络、不碰 store ⇒ 单测可以拿**真实样本**直接喂。
//
// ---------------------------------------------------------------------------
// 设计依据（全部来自真机实测，2026-11-16，本机 + 该账号）
// ---------------------------------------------------------------------------
// - 真·有声形态：专辑 = 作品名、单集 **9–32 分钟**、标题**形态整本一致**
//   （`21- 序章` / `0010` / `025- 第01季25` / `让青春继续第一季 10`）；
// - 普通音乐：单集 3–5 分钟、标题形态五花八门；
// - ⚠ 全库长音频（≥8 分钟）9,029 首里**只有 5,244 首**是真有声
//   ⇒ **单靠时长会误伤 42%** ⇒ 必须靠「标题形态一致」联合判定；
// - ⚠ 专辑名 / 目录名**一律不可用**（名字误报极高；目录名因人而异）。
//
// ---------------------------------------------------------------------------
// v3 改版（2026-11-16，用户实机反馈「有声做得不行」之后）
// ---------------------------------------------------------------------------
// - 「**是不是有声**」**不再**由这里的打分决定 ⇒ 打分**降级为参考信息**
//   （仍然算、仍然显示，只是不再决定「谁能进列表」）；
//   「是不是」改由**用户指位置**决定（作品名秒搜 / 目录关键字 / 手动改判）；
// - 本文件新增**目录关键字匹配**（`pathMatchesKeyword`）—— 它只用来**定位**
//   （「找那个文件夹里的东西」），**不**用来推断「是不是有声」
//   ⇒ 「不靠目录名猜」那条不变量仍然成立；
// - 「**能不能按集序排**」仍由**形态一致性**（`resolveAlbumEpisodes`）决定。
//
// ⚠️ **方法论**（本轮踩坑）：服务端搜索是 **top-N 截断**且命中集不稳定
//    ⇒ 「搜不到」**不能**证明「不存在」⇒ 存在性结论只能靠全量扫描。
//
// ---------------------------------------------------------------------------
// T99（2026-11-16，T98 v3 真机复验后）
// ---------------------------------------------------------------------------
// - 新增集号规则 **`mid-number`**（**放最后**）⇒「**集号在中段**」的标题形态
//   （`极品家丁 0001 公子，公子`）也能解析 ⇒ 《极品家丁》1333 集**终于排得了**。
// - ⚠️ 新规则**只加在实测形态上**：每条规则都要有真实样本 + 单测钉住
//   ⇒ 不放宽形态门槛（≥ 60% 的形态一致性仍然把关）。
// ---------------------------------------------------------------------------

/** 参与识别 / 排序的**最小曲目信息**（`Song` 结构兼容，但这里不依赖它）。 */
export interface AudiobookTrack {
  /** 曲目 id。 */
  id: string
  /** 曲目标题。 */
  title: string
  /** 时长（**秒**）。 */
  durationSec: number
  /** 曲目号（服务端给的是**真实节目编号**时才有值；实测有声内容多为 `null`）。 */
  trackNo: number | null
  /** NAS 上的文件路径（可能缺失）。 */
  path: string | null
  /** 所属专辑 id。 */
  albumId: string
}

// ---------------------------------------------------------------------------
// 阈值（全部可调，且**不引用任何目录名 / 专辑名**）
// ---------------------------------------------------------------------------

/** 单集**均长**门槛：≥ 8 分钟 ⇒ +2。 */
export const AVG_DURATION_SEC = 480
/** 单集**均长**门槛：≥ 20 分钟 ⇒ +1。 */
export const LONG_DURATION_SEC = 1200
/** **最长单集**门槛：≥ 30 分钟 ⇒ +1。 */
export const MAX_DURATION_SEC = 1800
/** 专辑**集数**门槛：≥ 8 集 ⇒ +1。 */
export const MIN_TRACK_COUNT = 8
/** 标题形态一致的**命中率**门槛：≥ 60% 才算「形态一致」。 */
export const EPISODE_PATTERN_RATIO = 0.6
/** 判为「有声读物」的**总分**门槛。 */
export const AUDIOBOOK_SCORE_THRESHOLD = 4

// ---------------------------------------------------------------------------
// 集号解析
// ---------------------------------------------------------------------------

/** 中文数字 → 数字（支持 1–99 的常见写法）。 */
const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  百: 100, 零: 0, 两: 2,
}

/** 中文数字转数字；解析不出来返回 `null`。 */
function cnToNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text)
  if (text.length === 1) return CN_NUM[text] ?? null
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text)
  if (m) {
    const tens = m[1] ? (CN_NUM[m[1]] ?? 1) : 1
    const ones = m[2] ? (CN_NUM[m[2]] ?? 0) : 0
    return tens * 10 + ones
  }
  return CN_NUM[text] ?? null
}

/** 4 位数且落在 1900–2100 ⇒ 很可能是**年份**，不当集号。 */
function looksLikeYear(n: number): boolean {
  return n >= 1900 && n <= 2100
}

/** 单条标题的集号解析结果。 */
export interface EpisodeParse {
  /** 命中的规则名（见 `EPISODE_RULES`）。 */
  rule: string
  /** 段式数值（如 `[1, 25]` = 第 1 季第 25 集）。 */
  value: number[]
}

/**
 * 规则优先级（命中数相同时，**更具体**的规则优先）。
 *
 * ⚠️ 顺序即优先级：`season-episode`（季+集）比 `dash-prefix`（前缀序号）更具体。
 */
export const EPISODE_RULES = [
  'season-episode',
  'episode-cn',
  'dash-prefix',
  'dotted-prefix',
  'bracket',
  'digits-only',
  'trailing',
  'mid-number',
] as const

/**
 * 从标题里解析集号（**单条**）。
 *
 * ⚠️ 单条解析**不可靠**（纯数字标题既可能是集号，也可能是歌名「2003」）
 * ⇒ 专辑里必须用 {@link resolveAlbumEpisodes} 做**形态一致性**判定。
 */
export function parseEpisode(title: string): EpisodeParse | null {
  const text = String(title ?? '').trim()
  if (!text) return null

  // ① 「第N季 MM」/「第一季 10」⇒ [季, 集]
  const season = /第\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*季\s*(\d{1,4})/.exec(text)
  if (season) {
    const s = cnToNumber(season[1] ?? '')
    const e = Number(season[2])
    if (s !== null && Number.isFinite(e)) return { rule: 'season-episode', value: [s, e] }
  }

  // ② 「第12集 / 第3回 / 第三回」
  const cn = /第\s*(\d{1,4}|[一二三四五六七八九十百零两]{1,4})\s*[集回章节卷部篇话]/.exec(text)
  if (cn) {
    const n = cnToNumber(cn[1] ?? '')
    if (n !== null) return { rule: 'episode-cn', value: [n] }
  }

  // ③ 「21- 序章」/「025- …」
  const dash = /^(\d{1,5})\s*[-–—]\s*\S/.exec(text)
  if (dash) {
    const n = Number(dash[1])
    if (!looksLikeYear(n)) return { rule: 'dash-prefix', value: [n] }
  }

  // ④ 「17.0315丨…」/「001_开篇」/「1. 开篇」/「12、开篇」
  const lead = /^(\d{1,4}(?:\.\d{1,4})*)\s*[._、|丨]/.exec(text)
  if (lead) {
    const raw = lead[1] ?? ''
    const segs = raw.split('.').map((s) => Number(s))
    if (raw.includes('.')) return { rule: 'dotted-prefix', value: segs }
    if (!(raw.length === 4 && looksLikeYear(segs[0] ?? 0))) {
      return { rule: 'dotted-prefix', value: segs }
    }
  }

  // ⑤ 「【01】」/「(01)」
  const bracketed = /[（(\[【]\s*(\d{1,4})\s*[）)\]】]/.exec(text)
  if (bracketed) {
    const n = Number(bracketed[1])
    if (!looksLikeYear(n)) return { rule: 'bracket', value: [n] }
  }

  // ⑥ 「0010」⇒ 纯数字标题
  //
  // ⚠️ **纯数字标题不做年份保护**（真机实测踩到的坑）：
  //    《牧神记》共 2762 集，集号**必然穿过 1900–2100 区间** ⇒ 若按年份挡，
  //    201 集（"1900"–"2100"）会解析不出集号 ⇒ 被排到末尾（用户看到「最后一批没集号」）。
  //    ⭐ 而歌名正好是 "1900" 的概率极低 ⇒ **纯数字一律按集号**。
  const digitsOnly = /^(\d{1,5})$/.exec(text)
  if (digitsOnly) {
    return { rule: 'digits-only', value: [Number(digitsOnly[1])] }
  }

  // ⑦ 「让青春继续第一季 10」⇒ 末尾集号（**宽松规则**，只在专辑级一致时用）
  const trailing = /^(.*\S)\s+(\d{1,4})$/.exec(text)
  if (trailing) {
    const head = trailing[1] ?? ''
    const n = Number(trailing[2])
    if (!looksLikeYear(n)) {
      const headSeason = /第\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*季/.exec(head)
      if (headSeason) {
        const s = cnToNumber(headSeason[1] ?? '')
        if (s !== null) return { rule: 'trailing', value: [s, n] }
      }
      return { rule: 'trailing', value: [n] }
    }
  }

  // ⑧ 「极品家丁 0001 公子，公子」⇒ **集号在中段**（T99）
  //
  // ⚠️ **为什么需要它**（真机实测 2026-11-16，本机 + 该账号）：
  //    《极品家丁》1333 集的标题形态是「**作品名 + 空格 + 4 位数字 + 标题**」，
  //    现有 7 条规则都要求集号在**开头**（`dash-prefix` / `dotted-prefix` / `bracket` /
  //    `digits-only`）或**结尾纯数字**（`trailing`）⇒ 解析率只有 **1.1%**
  //    ⇒ 形态不一致 ⇒ **完全排不了序**（用户看到的是服务端原序 `createdAt,desc` ⇒ 倒着）。
  //
  // ⚠️ **数字后可以没有空格**（实测 `极品家丁 0000预告片`）⇒ 尾巴写成 `(?:\s*.*)?`。
  // ⚠️ **前面必须有文字**（`(.+?)`）⇒ 与 `digits-only`（纯数字）/ `dash-prefix`（数字开头）
  //    **不重叠**。
  // ⚠️ **不做年份保护**：与 `digits-only` 同理 —— 2000+ 集的长篇真实存在
  //    （《牧神记》2762 集）⇒ 靠**形态一致性门槛（≥ 60%）**兜底，不靠年份猜。
  // ⚠️ **放在最后** ⇒ 最宽松 ⇒ 命中数相同时**不抢**更具体的规则
  //    （`trailing` 仍能拿到 `[季, 集]`；`digits-only` / `dash-prefix` 不受影响）。
  const mid = /^(.+?)\s+(\d{1,5})(?:\s*.*)?$/.exec(text)
  if (mid) {
    const head = mid[1] ?? ''
    const n = Number(mid[2])
    if (Number.isFinite(n)) {
      const headSeason = /第\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*季/.exec(head)
      if (headSeason) {
        const s = cnToNumber(headSeason[1] ?? '')
        if (s !== null) return { rule: 'mid-number', value: [s, n] }
      }
      return { rule: 'mid-number', value: [n] }
    }
  }

  return null
}

/** 专辑级解析结果。 */
export interface AlbumEpisodes {
  /** 每个标题的集号（解析不出来 = `null`）。 */
  values: (number[] | null)[]
  /** 选中的规则名（`null` = 形态不一致 ⇒ 不按标题排序）。 */
  rule: string | null
  /** 选中规则的命中率。 */
  hitRatio: number
}

/**
 * 专辑级**形态一致性**解析（防误判的关键）。
 *
 * ⚠️ 只有当**某一个规则**命中 ≥ `minRatio` 时，才用该规则解析全部标题；
 *    否则整张专辑**不按标题排序**（保持原序）⇒ **宁可不动也不乱**。
 */
export function resolveAlbumEpisodes(
  titles: readonly string[],
  minRatio: number = EPISODE_PATTERN_RATIO,
): AlbumEpisodes {
  const parsed = titles.map((t) => parseEpisode(t))
  const counts = new Map<string, number>()
  for (const p of parsed) if (p) counts.set(p.rule, (counts.get(p.rule) ?? 0) + 1)

  let bestRule: string | null = null
  let bestCount = 0
  for (const rule of EPISODE_RULES) {
    const count = counts.get(rule) ?? 0
    if (count > bestCount) {
      bestRule = rule
      bestCount = count
    }
  }
  const total = titles.length
  const hitRatio = total > 0 ? bestCount / total : 0
  if (!bestRule || hitRatio < minRatio) {
    return { values: titles.map(() => null), rule: null, hitRatio }
  }
  const values = titles.map((t) => {
    const p = parseEpisode(t)
    return p && p.rule === bestRule ? p.value : null
  })
  return { values, rule: bestRule, hitRatio }
}

/**
 * 专辑级**标题形态统计**（可增量累加 ⇒ 扫描时逐条标题累加）。
 *
 * ⚠️ 为什么要有它（真机实测踩到的坑）：
 *   扫描时**不能**把整张专辑的标题都留在内存里（17 万首 ⇒ 落盘会超配额），
 *   但**形态命中率必须按全量标题算**（只按前 30 个样本算 ⇒ 会误判），
 *   ⇒ 落盘只留「**每条规则命中了多少个标题**」+「标题总数」两样。
 */
export interface EpisodeStats {
  /** 每条规则命中了多少个标题（键 = 规则名）。 */
  ruleCounts: Record<string, number>
  /** 标题总数（**含**解析不出来的那些 —— 它们是分母的一部分）。 */
  titleCount: number
}

/** 把一批标题汇总成形态统计（**纯函数**）。 */
export function summarizeEpisodes(titles: readonly string[]): EpisodeStats {
  const ruleCounts: Record<string, number> = {}
  let titleCount = 0
  for (const title of titles) {
    titleCount += 1
    const parsed = parseEpisode(title)
    if (parsed) ruleCounts[parsed.rule] = (ruleCounts[parsed.rule] ?? 0) + 1
  }
  return { ruleCounts, titleCount }
}

/**
 * 按形态统计算出「用哪条规则 + 命中率」。
 *
 * ⚠️ 与 {@link resolveAlbumEpisodes} **同一套规则与优先级**（命中数相同时，
 *    {@link EPISODE_RULES} 里更靠前的规则优先）。
 */
export function resolveEpisodeStats(
  stats: EpisodeStats,
  minRatio: number = EPISODE_PATTERN_RATIO,
): { rule: string | null; hitRatio: number } {
  let bestRule: string | null = null
  let bestCount = 0
  for (const rule of EPISODE_RULES) {
    const count = stats.ruleCounts[rule] ?? 0
    if (count > bestCount) {
      bestRule = rule
      bestCount = count
    }
  }
  const hitRatio = stats.titleCount > 0 ? bestCount / stats.titleCount : 0
  if (!bestRule || hitRatio < minRatio) return { rule: null, hitRatio }
  return { rule: bestRule, hitRatio }
}

/** 段式数值比较：`[17,315] < [17,329]`；`[9,1] < [10,1]`；无集号的**排后面**。 */
export function compareEpisode(a: number[] | null, b: number[] | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// 识别（打分）
// ---------------------------------------------------------------------------

/** 一张专辑的判定结果。 */
export interface AudiobookVerdict {
  /** 总分（≥ {@link AUDIOBOOK_SCORE_THRESHOLD} 即判为有声读物）。 */
  score: number
  /** 命中的依据（**可解释**，逐条给人看）。 */
  reasons: string[]
  /** 曲目数。 */
  trackCount: number
  /** 单集均长（秒）。 */
  avgDurationSec: number
  /** 最长单集（秒）。 */
  maxDurationSec: number
  /** 标题形态规则名（`null` = 形态不一致）。 */
  episodeRule: string | null
  /** 标题形态命中率。 */
  episodeHitRatio: number
}

/** 判定依据的**中文说明**（给界面用）。 */
export const REASON_LABELS: Record<string, string> = {
  'avg-duration': '单集均长 ≥ 8 分钟',
  'long-duration': '单集均长 ≥ 20 分钟',
  'very-long-track': '最长单集 ≥ 30 分钟',
  'episode-pattern': '标题形态一致（可解析集号）',
  'many-episodes': '集数 ≥ 8',
  'single-work-dir': '曲目集中在同一作品目录',
}

/**
 * 「作品目录」= `path` 去掉文件名后，取**倒数第 3 段**。
 *
 * ⚠️ 为什么要倒数第 3 段（实测）：
 *   `/…/有声小说/刘慈欣/三体/Disc 01/21- 序章.mp3` ⇒ 倒数第 3 段 = `三体`（作品）
 *   `/…/有声小说/宅猪/牧神记/0001-0115/0010.mp3`   ⇒ 倒数第 3 段 = `牧神记`（作品）
 *   ⇒ 同一作品的**分段目录**（`Disc 01` / `0001-0115`）不同也能归到同一作品 ✓
 */
export function workDirOf(path: string | null): string | null {
  const text = String(path ?? '').trim()
  if (!text) return null
  const segs = text.split('/').filter(Boolean)
  // segs 至少要有 [根, 作品, 文件] 三段才有「倒数第 3 段」。
  if (segs.length < 3) return null
  return segs[segs.length - 3] ?? null
}

/**
 * **归并键**（T100）：一部作品 = **专辑名 + 唯一作品目录**。
 *
 * ⚠️ **单一来源**：扫描路径（`src/state/audiobookStore.ts` 的 `groupKeyOf`）与
 *    秒搜路径（`src/pages/AudiobooksPage.tsx`）**都调它** ⇒ 两条路径的口径**完全一致**
 *    （否则会出现「扫出来是一条、搜出来是两条」）。
 *
 * ⚠️ **作品目录拿不到（`null`）⇒ 不归并**（信息不足 ⇒ 宁可分开，也不要误合）：
 *    这时退化成「按专辑单独成组」。
 *
 * @param albumTitle 专辑名（= 作品名）。
 * @param workDir 作品目录（`null` = 拿不到 / 不唯一）。
 * @param albumId 专辑 id（拿不到目录时的兜底键）。
 */
export function workGroupKey(
  albumTitle: string,
  workDir: string | null,
  albumId: string,
): string {
  if (workDir === null) return `album:${albumId}`
  return `work:${albumTitle.length}:${albumTitle}:${workDir}`
}

/**
 * `judgeAlbum` 的可选覆盖项。
 *
 * ⚠️ **为什么要有**：扫描时我们**按专辑聚合**（内存里只留结构指标与**形态统计**，
 *    不留 17 万首曲目）⇒ 那时
 *    - 真实**曲目数**只有聚合器知道（标题样本只有 30 个）；
 *    - **均长 / 最长单集**也由聚合器累加（不能用样本的平均值冒充）；
 *    - 作品目录**是否唯一**也由聚合器判定（样本的 path 是拼出来的，不可用）；
 *    - 形态命中率按**全量标题**算 ⇒ 传 `episodeStats`。
 */
export interface JudgeOptions {
  /** 真实曲目数（不传 = 用传入数组的长度）。 */
  trackCount?: number
  /** 作品目录是否唯一（不传 = 按传入曲目的 `path` 推导）。 */
  workDirUnique?: boolean
  /** 单集均长（秒）的覆盖值（不传 = 由传入曲目算）。 */
  avgDurationSec?: number
  /** 最长单集（秒）的覆盖值（不传 = 由传入曲目算）。 */
  maxDurationSec?: number
  /** 标题形态统计的覆盖值（不传 = 由传入曲目的标题算）。 */
  episodeStats?: EpisodeStats
}

/**
 * 给一张专辑打分。
 *
 * ⚠️ **不引用任何目录名 / 专辑名**（名字误报极高、目录名因人而异）。
 */
export function judgeAlbum(
  tracks: readonly AudiobookTrack[],
  options?: JudgeOptions,
): AudiobookVerdict {
  const count = options?.trackCount ?? tracks.length
  if (count === 0) {
    return {
      score: 0,
      reasons: [],
      trackCount: 0,
      avgDurationSec: 0,
      maxDurationSec: 0,
      episodeRule: null,
      episodeHitRatio: 0,
    }
  }

  const durations = tracks.map((t) => (Number.isFinite(t.durationSec) ? t.durationSec : 0))
  const totalDuration = durations.reduce((a, b) => a + b, 0)
  const avgDurationSec =
    options?.avgDurationSec ??
    (tracks.length > 0 ? Math.round(totalDuration / tracks.length) : 0)
  const maxDurationSec =
    options?.maxDurationSec ?? durations.reduce((a, b) => (b > a ? b : a), 0)

  // ⚠️ 形态一致性：扫描路径传**全量标题**的统计；单测/详情页路径直接用曲目标题算。
  const episodes = options?.episodeStats
    ? resolveEpisodeStats(options.episodeStats)
    : (() => {
        const resolved = resolveAlbumEpisodes(tracks.map((t) => t.title))
        return { rule: resolved.rule, hitRatio: resolved.hitRatio }
      })()
  const dirs = new Set<string>()
  let pathCount = 0
  for (const t of tracks) {
    const dir = workDirOf(t.path)
    if (dir === null) continue
    dirs.add(dir)
    pathCount += 1
  }

  let score = 0
  const reasons: string[] = []

  if (avgDurationSec >= AVG_DURATION_SEC) {
    score += 2
    reasons.push('avg-duration')
  }
  if (avgDurationSec >= LONG_DURATION_SEC) {
    score += 1
    reasons.push('long-duration')
  }
  if (maxDurationSec >= MAX_DURATION_SEC) {
    score += 1
    reasons.push('very-long-track')
  }
  // ⚠️ 「标题形态一致」**必须与时长联动**：
  //    否则 `01- 标题` 形态的普通音乐专辑（每首 3–5 分钟）会拿到 2 分而压线误判。
  if (episodes.rule !== null && avgDurationSec >= AVG_DURATION_SEC) {
    score += 2
    reasons.push('episode-pattern')
  }
  if (count >= MIN_TRACK_COUNT) {
    score += 1
    reasons.push('many-episodes')
  }
  // ⚠️ 全部曲目都缺 path 时**不计**（信息不足，不猜）。
  const workDirUnique =
    options?.workDirUnique ?? (pathCount > 0 && dirs.size === 1)
  if (workDirUnique) {
    score += 1
    reasons.push('single-work-dir')
  }

  return {
    score,
    reasons,
    trackCount: count,
    avgDurationSec,
    maxDurationSec,
    episodeRule: episodes.rule,
    episodeHitRatio: episodes.hitRatio,
  }
}

/** 判定结果是否达到「有声读物」门槛。 */
export function isAudiobookVerdict(verdict: AudiobookVerdict): boolean {
  return verdict.score >= AUDIOBOOK_SCORE_THRESHOLD
}

// ---------------------------------------------------------------------------
// 排序（按集序，不乱）
// ---------------------------------------------------------------------------

/**
 * `trackNo` 是否**质量合格**（可用作排序键）。
 *
 * ⚠️ 实测真·有声内容的 `trackNo` **大多为 `null`**（《三体》《牧神记》《赶尸客栈》
 *    全是 `null`）⇒ 这一层**多半用不上**，只当兜底。
 */
export function trackNoQualityOk(tracks: readonly AudiobookTrack[]): boolean {
  if (tracks.length === 0) return false
  const values = tracks.map((t) => t.trackNo).filter((v): v is number => v !== null)
  if (values.length < tracks.length * 0.9) return false
  return new Set(values).size >= values.length * 0.9
}

/**
 * 按集序排列（**稳定**）。
 *
 * 排序键（自上而下）：① 标题解析出的集号 → ② `trackNo`（**仅当质量合格**）→ ③ 原下标。
 *
 * ⚠️ 「形态不一致」的专辑 ⇒ 集号层**整层作废** ⇒ 只按原下标排（= 原序，不动）。
 */
export function sortTracksByEpisode<T extends AudiobookTrack>(tracks: readonly T[]): T[] {
  const episodes = resolveAlbumEpisodes(tracks.map((t) => t.title))
  const useTrackNo = trackNoQualityOk(tracks)
  return tracks
    .map((track, index) => ({ track, index, episode: episodes.values[index] ?? null }))
    .sort((a, b) => {
      const byEpisode = compareEpisode(a.episode, b.episode)
      if (byEpisode !== 0) return byEpisode
      if (useTrackNo) {
        const av = a.track.trackNo
        const bv = b.track.trackNo
        if (av !== null && bv !== null && av !== bv) return av - bv
        if (av !== null && bv === null) return -1
        if (av === null && bv !== null) return 1
      }
      return a.index - b.index
    })
    .map((x) => x.track)
}

/**
 * 给一批曲目按专辑聚合，并逐张给判定结果。
 *
 * ⚠️ 这是**扫描**后的聚合入口：只吃**已加载**的曲目，不发请求。
 */
export function judgeAlbums(tracks: readonly AudiobookTrack[]): Map<string, AudiobookVerdict> {
  const byAlbum = new Map<string, AudiobookTrack[]>()
  for (const t of tracks) {
    const bucket = byAlbum.get(t.albumId)
    if (bucket) bucket.push(t)
    else byAlbum.set(t.albumId, [t])
  }
  const out = new Map<string, AudiobookVerdict>()
  for (const [albumId, list] of byAlbum) out.set(albumId, judgeAlbum(list))
  return out
}

// ---------------------------------------------------------------------------
// 目录关键字匹配（T98 v3：「**那个文件夹**」）
// ---------------------------------------------------------------------------
//
// ⚠️ **用途边界**（v3 改版的要害）：
//   目录关键字只用来**定位**（「找那个文件夹里的东西」），
//   **不**用来判断「是不是有声」——那是**用户指认**的事（作品名秒搜 / 手动改判）。
//   ⇒ 「不靠目录名猜」这条不变量**没有被破坏**：程序不拿目录名去**推断**，
//     只把用户给的目录名当**过滤器**用。
// ---------------------------------------------------------------------------

/**
 * 默认的目录关键字（**只是默认值** —— 目录名因人而异，别的库可能叫别的）。
 *
 * ⚠️ 它**可以改**（界面上有输入框）⇒ 不得把「有声小说」当成「有声」的判据。
 */
export const DEFAULT_FOLDER_KEYWORD = '有声小说'

/**
 * 取路径里的**目录段**（去掉最后一段文件名）。
 *
 * ⚠️ 为什么只看目录段：用户说的是「**那个文件夹**」
 *    ⇒ 文件名里出现同名字样（例如 `有声小说.mp3`）**不算命中**（那是文件，不是目录）。
 */
export function pathSegments(path: string | null | undefined): string[] {
  const text = String(path ?? '').trim()
  if (!text) return []
  const segs = text.split('/').filter(Boolean)
  return segs.slice(0, Math.max(0, segs.length - 1))
}

/**
 * 路径里有没有**目录段**包含关键字（大小写不敏感）。
 *
 * - 空关键字 / 空路径 ⇒ `false`（**不猜**）；
 * - 只看**目录段**（不含文件名）；
 * - 命中**任一段**即算命中（关键字可以是目录名的一部分：`有声` 命中 `有声小说`）。
 */
export function pathMatchesKeyword(path: string | null | undefined, keyword: string): boolean {
  const key = String(keyword ?? '').trim().toLowerCase()
  if (!key) return false
  return pathSegments(path).some((seg) => seg.toLowerCase().includes(key))
}
