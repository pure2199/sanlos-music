// 榜单条目 ↔ 本地曲库的**匹配**（纯函数；渲染层用它把榜源条目对上 NAS 曲库）。
//
// ⚠️ **总原则：宁可漏匹配，不可误匹配**
//    误匹配 = 用户看到「在库」点进去却播了**另一首歌**（比「没匹配上」严重得多）。
//    ⇒ 归一化**保留括号内容**（去掉括号会让《Live》版匹配到录音室版）；
//    ⇒ 时长对不上就**不认**（见 `matchChartEntry`）。
//
// ⚠️ **不建全量索引**：曲库是**当前用户自己的** NAS 曲库，规模因人而异
//    （开发机实测 17.3 万首 —— 那是**那台机**的事实，不是规格）
//    ⇒ 拉全量既慢又没道理（别人的库可能很小）。
//    ⇒ 本模块只负责「在**给定的候选歌**里找出那一条」；
//      候选歌由调用方用 `/track/artist-detail/list`（某歌手的歌曲）定向取来。
//
// ⚠️ 本文件**不依赖** Electron / Node 内置模块 / DOM ⇒ 单测可直接 import。

/**
 * 时长容差（**秒**）。
 *
 * 沿用歌词源的先例（`electron/lyricProvider.ts` 的 `DURATION_TOLERANCE_SECONDS = 3`）：
 * 同一首歌在 NAS 与榜源上的时长差通常在 1 秒内。
 */
export const CHART_DURATION_TOLERANCE_SECONDS = 3

/** 参与匹配的最小歌曲形状（渲染层的 `Song` 满足它；主进程不用这一套）。 */
export interface MatchableSong {
  /** 本地歌曲 id（NAS 的 guid）。 */
  id: string
  /** 歌名。 */
  title: string
  /** 歌手（多歌手用 `' / '` 连接，与 `src/api/client.ts` 的 `mapSong` 一致）。 */
  artist: string
  /** 时长（**秒**）；服务端没给时为 `null`。 */
  duration: number | null
}

/** 参与匹配的最小榜单条目形状（歌手是一个**候选列表**）。 */
export interface MatchableEntry {
  /** 歌名。 */
  title: string
  /** 歌手名（每个一项都是一个候选）。 */
  artists: string[]
  /** 时长（**秒**）；榜源没给时为 `null`。 */
  duration: number | null
}

/**
 * 归一化：NFKC → 去所有空白 → 去标点 → 转小写。
 *
 * - **NFKC**：全角 → 半角（「（」与「(」等价）；「／」与「/」等价。
 * - **去所有空白**：本地多歌手用 `' / '` 连接、榜源用 `/` ⇒ 去空白后两边一致。
 * - **去标点**：中英文逗号/句号/顿号/连字符/引号/括号**本体**…
 * - ⚠️ **只去括号本体、保留括号里的内容** ⇒ 《Live》版不会匹配到录音室版。
 */
export function normalizeText(raw: string): string {
  if (!raw) return ''
  let s = raw.normalize('NFKC')
  s = s.replace(/\s+/gu, '')
  s = s.replace(/[.,;:!?"'`~·・…、。！？；：，＂＇｀｜／＼（）()[\]{}【】〔〕《》〈〉「」『』—–\-_]/gu, '')
  return s.toLowerCase()
}

/**
 * 把一个「歌手串」拆成**候选**列表。
 *
 * ⚠️ **只按 `/` 拆**（那是 `mapSong` 连接多歌手用的分隔符）：
 *    像 `AC/DC` 这种名字里本来带斜杠的 ⇒ 拆开后**再补上整个原串**当候选 ⇒ 仍能匹配上。
 */
export function artistCandidates(raw: string): string[] {
  const whole = raw.trim()
  if (!whole) return []
  const parts = whole.split('/').map((p) => p.trim()).filter((p) => p.length > 0)
  const all = parts.length > 0 ? [...parts, whole] : [whole]
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of all) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 时长差最小的那首。 */
function closestByDuration<T extends MatchableSong>(
  candidates: T[],
  target: number,
): T | null {
  let best: T | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const song of candidates) {
    if (song.duration == null || song.duration <= 0) continue
    const delta = Math.abs(song.duration - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = song
    }
  }
  return best
}

/** 匹配结果。 */
export interface ChartMatch<T extends MatchableSong = MatchableSong> {
  /** 命中的本地歌曲 id；没命中为 `null`。 */
  songId: string | null
  /** 命中的那首；没命中为 `null`。 */
  song: T | null
  /** 时长对不上而被否掉的候选数（**诊断用**：非 0 说明榜源与本地的时长有系统性偏差）。 */
  durationMismatch: number
}

/**
 * 在**给定的候选歌**里找与这条榜单条目对应的那一首。
 *
 * 判定顺序（**每一步都写清楚了为什么**）：
 *
 * 1. **歌名**必须归一化后**完全相等**（不做包含 / 前缀匹配 ⇒ 宁可漏匹配）。
 * 2. **歌手**必须有**至少一个候选**归一化后相等
 *    （榜源给的是歌手数组；本地 `Song.artist` 是 `' / '` 连接的多歌手串 ⇒ 两边都拆成候选再比）。
 * 3. **时长闸**：
 *    a. 条目有时长、本地候选也有时长 ⇒ 只认 `|Δ| ≤ 3 秒` 的那条；有多条就取**时长差最小**的
 *       （这一条解决「同一首歌有录音室版与 Live 版」的情况）；
 *    b. 本地候选**都没有时长** ⇒ 时长闸用不上 ⇒ 取第一条；
 *    c. 本地候选**都有时长但一首都对不上** ⇒ **不匹配**
 *       （⚠️ **宁可漏匹配，不可误匹配** —— 宁可显示「不在曲库」，也不能让用户点开是另一首歌）。
 *
 * @param entry 榜单条目（歌名 / 歌手候选 / 时长）。
 * @param songs 候选歌（**定向查来的那几首**）。
 */
export function matchChartEntry<T extends MatchableSong = MatchableSong>(
  entry: MatchableEntry,
  songs: T[],
): ChartMatch<T> {
  const titleKey = normalizeText(entry.title)
  if (!titleKey) return { songId: null, song: null, durationMismatch: 0 }

  const entryArtistKeys = new Set(
    entry.artists.map((a) => normalizeText(a)).filter((key) => key.length > 0),
  )
  if (entryArtistKeys.size === 0) return { songId: null, song: null, durationMismatch: 0 }

  const candidates = songs.filter((song) => {
    if (normalizeText(song.title) !== titleKey) return false
    for (const candidate of artistCandidates(song.artist)) {
      if (entryArtistKeys.has(normalizeText(candidate))) return true
    }
    return false
  })

  if (candidates.length === 0) return { songId: null, song: null, durationMismatch: 0 }

  const entryDuration = entry.duration
  const first = candidates[0] ?? null
  if (entryDuration == null || entryDuration <= 0) {
    return { songId: first ? first.id : null, song: first, durationMismatch: 0 }
  }

  const withDuration = candidates.filter((song) => song.duration != null && song.duration > 0)
  if (withDuration.length === 0) {
    // 本地一条时长都没有 ⇒ 时长闸用不上 ⇒ 按「歌名 + 歌手」命中。
    return { songId: first ? first.id : null, song: first, durationMismatch: 0 }
  }

  const within = withDuration.filter(
    (song) => Math.abs((song.duration as number) - entryDuration) <= CHART_DURATION_TOLERANCE_SECONDS,
  )
  if (within.length === 0) {
    // ⚠️ 标题+歌手对上了、但时长全对不上 ⇒ 判为**不匹配**（见函数注释第 3.c 条）。
    return { songId: null, song: null, durationMismatch: withDuration.length }
  }

  const best = closestByDuration(within, entryDuration) ?? within[0] ?? null
  return { songId: best ? best.id : null, song: best, durationMismatch: 0 }
}
