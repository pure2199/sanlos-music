// ---------------------------------------------------------------------------
// 「发现」页的聚合与推荐（T96）
// ---------------------------------------------------------------------------
//
// ⚠️ **曲库 = 当前登录用户自己的 NAS 曲库**：
//    它有多大、装了什么，**因人而异**（开发机实测 17.3 万首，那只是**那台机**的事实）。
//    ⇒ 本模块**不拉全量曲库**、**不对曲库规模做任何假设**，
//      一律**定向查询**：按歌手（`/search/artist` → `/track/artist-detail/list`）、
//      按专辑（`/track/album-detail/list`）。
//    ⇒ 「在不在曲库」「命中率」「为你推荐」**一律按当前用户的 NAS 实时算**。
//
// ⚠️ **外部榜源只在主进程**（`discover:charts`）⇒ 渲染层**不碰网络**，
//    也**不能指定地址**（与歌词源同一条纪律）。
//
// ⚠️ **宁可漏匹配，不可误匹配**：误匹配 = 用户看到「在库」点进去却播了**另一首歌**。
//
// ---------------------------------------------------------------------------
// 本模块分两半（都可单测）：
// - **查询与匹配**：`matchChartsToLibrary`（要 NAS ⇒ 异步）；
// - **打分与分块**：`buildRecommendBlocks`（**纯函数**）——
//   候选怎么来的（`gatherRecommendCandidates`）与怎么分块**分开**，
//   这样「推荐为什么这么排」可以脱离网络单测。
// ---------------------------------------------------------------------------

import type { Artist, Song } from '../../shared/types'
import type {
  ChartBoard,
  MatchedChartBoard,
  MatchedChartEntry,
} from '../../shared/chartTypes'
import {
  artistCandidates,
  matchChartEntry,
  normalizeText,
} from '../../shared/chartMatch'
import { libraryApi } from './library'
import { searchApi } from './search'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 定向查询的**并发上限**（别把 NAS / 中继打爆）。 */
export const DISCOVER_QUERY_CONCURRENCY = 6

/** 单个歌手 / 专辑最多取多少首歌（**分页**，不拉全量）。 */
export const DISCOVER_PAGE_SIZE = 200

/** 每类种子最多取多少首（收藏 / 本地历史 / 服务端历史各一份）。 */
export const RECOMMEND_SEED_LIMIT = 30

/** 每块最多几条。 */
export const RECOMMEND_LIMIT_PER_BLOCK = 10

// ---------------------------------------------------------------------------
// 依赖（可注入 ⇒ 单测不必打网络）
// ---------------------------------------------------------------------------

/** 「发现」页用到的 NAS 查询（**定向**，不拉全量）。 */
export interface DiscoverDeps {
  /** 按名字找歌手（服务端是**子串匹配** ⇒ 调用方要自己按全等筛）。 */
  searchArtists: (name: string) => Promise<Artist[]>
  /** 某歌手在**你的**曲库里的歌。 */
  artistSongs: (artistId: string) => Promise<Song[]>
  /** 某专辑在**你的**曲库里的歌。 */
  albumSongs: (albumId: string) => Promise<Song[]>
}

/** 生产用的实现（走渲染层既有的 `fnm://srv` 通道 ⇒ 自动带当前账号的凭证）。 */
export const defaultDiscoverDeps: DiscoverDeps = {
  searchArtists: async (name) => (await searchApi.artists(name, { size: 5 })).list,
  artistSongs: async (artistId) =>
    (await libraryApi.artistSongs(artistId, 1, DISCOVER_PAGE_SIZE)).list,
  albumSongs: async (albumId) =>
    (await libraryApi.albumSongs(albumId, 1, DISCOVER_PAGE_SIZE)).list,
}

/** 并发受限的 map（**保序**）。 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  let cursor = 0
  const workers = Math.max(1, Math.min(limit, items.length))
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index] as T
      results[index] = await fn(item, index)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()))
  return results
}

// ---------------------------------------------------------------------------
// (a) 榜单 ↔ 曲库匹配
// ---------------------------------------------------------------------------

/** 榜单匹配的结果。 */
export interface ChartMatchOutcome {
  /**
   * `ok` = 匹配完成；`unavailable` = **曲库查不动**。
   *
   * ⚠️ 这两件事**必须分开**：查不动 ≠ 都不在曲库（说错就是假话）。
   */
  status: 'ok' | 'unavailable'
  /** 可读中文原因（不含凭证）。 */
  message?: string
  /** 匹配后的榜单。 */
  boards: MatchedChartBoard[]
  /** 命中总数（**你的**曲库命中数）。 */
  matched: number
  /** 条目总数。 */
  total: number
}

/**
 * 把榜单条目**对上你的曲库**。
 *
 * 步骤（**定向查询**，不拉全量）：
 * 1. 收集榜单里出现的歌手名（去重）；
 * 2. 每个歌手：`/search/artist` 找**全等**的那个 ⇒ `/track/artist-detail/list` 取他的歌；
 * 3. 每条榜单条目：在**该条目歌手**的歌里跑匹配判据（`shared/chartMatch.ts`）。
 *
 * ⚠️ **歌手名的处理**：榜源给的是 `' / '` 连接的多歌手串 ⇒ 先按 `/` 拆成**候选**
 *    逐个查（`A / B` ⇒ 查 `A`、查 `B`）；**都查不到**再查**整个串**
 *    （这一条是给 `AC/DC` 这种**名字里本来带斜杠**的歌手兜底）。
 *
 * ⚠️ **查不到歌手 ≠ 出错**：查得到但**没有这个人** ⇒ 那就是「不在曲库」；
 *    **请求本身失败** ⇒ 整块标 `unavailable`（**不说「都不在曲库」**）。
 */
export async function matchChartsToLibrary(
  boards: ChartBoard[],
  deps: DiscoverDeps = defaultDiscoverDeps,
): Promise<ChartMatchOutcome> {
  // ---- 1. 收集歌手 -------------------------------------------------------
  /** 归一化后的歌手名 → 展示名（首个见到的写法）。 */
  const displayNames = new Map<string, string>()
  /** 每个「歌手串」拆出来的候选（按出现顺序、去重）。 */
  const partsOf = new Map<string, string[]>()

  for (const board of boards) {
    for (const entry of board.entries) {
      const raw = entry.artist.trim()
      if (raw === '') continue
      const parts = raw
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part !== '')
      const unique = parts.length > 0 ? parts : [raw]
      if (!partsOf.has(raw)) partsOf.set(raw, unique)
      for (const part of unique) {
        const key = normalizeText(part)
        if (key === '') continue
        if (!displayNames.has(key)) displayNames.set(key, part)
      }
    }
  }

  const artistKeys = [...displayNames.keys()]
  if (artistKeys.length === 0) {
    return { status: 'ok', boards: [], matched: 0, total: 0 }
  }

  // ---- 2. 定向查每个歌手在**你的**曲库里的歌 ------------------------------
  /** 归一化歌手名 → 该歌手在曲库里的歌。 */
  const songsByArtist = new Map<string, Song[]>()

  try {
    const resolved = await mapWithLimit(
      artistKeys,
      DISCOVER_QUERY_CONCURRENCY,
      async (key): Promise<{ key: string; songs: Song[] } | null> => {
        const name = displayNames.get(key) ?? key
        const artists = await deps.searchArtists(name)
        // ⚠️ **只认归一化后全等的那个**（服务端是子串匹配 ⇒ 会返回一堆沾边的）。
        const hit = artists.find((artist) => normalizeText(artist.name) === key)
        if (!hit) return null
        const songs = await deps.artistSongs(hit.id)
        return { key, songs }
      },
    )
    for (const item of resolved) {
      if (item) songsByArtist.set(item.key, item.songs)
    }

    // ---- 2b. 兜底：拆开都查不到 ⇒ 再查**整个串**（`AC/DC` 这类） ----------
    const wholeStrings = [...partsOf.keys()].filter((raw) => {
      const parts = partsOf.get(raw) ?? []
      if (parts.length < 2) return false
      return parts.every((part) => !songsByArtist.has(normalizeText(part)))
    })
    if (wholeStrings.length > 0) {
      const fallback = await mapWithLimit(
        wholeStrings,
        DISCOVER_QUERY_CONCURRENCY,
        async (raw): Promise<{ key: string; songs: Song[] } | null> => {
          const artists = await deps.searchArtists(raw)
          const key = normalizeText(raw)
          const hit = artists.find((artist) => normalizeText(artist.name) === key)
          if (!hit) return null
          const songs = await deps.artistSongs(hit.id)
          return { key, songs }
        },
      )
      for (const item of fallback) {
        if (item) songsByArtist.set(item.key, item.songs)
      }
    }
  } catch {
    // ⚠️ **曲库查不动** ⇒ 说「暂时无法匹配曲库」，**不说「都不在曲库」**。
    return {
      status: 'unavailable',
      message: '暂时无法匹配曲库（没能连上 NAS）',
      boards: [],
      matched: 0,
      total: 0,
    }
  }

  // ---- 3. 逐条匹配 -------------------------------------------------------
  const matchedBoards: MatchedChartBoard[] = []
  let matchedCount = 0
  let totalCount = 0

  for (const board of boards) {
    const entries: MatchedChartEntry[] = []
    for (const entry of board.entries) {
      const candidates: Song[] = []
      const seen = new Set<string>()
      for (const candidate of artistCandidates(entry.artist)) {
        const key = normalizeText(candidate)
        if (key === '') continue
        const songs = songsByArtist.get(key)
        if (!songs) continue
        for (const song of songs) {
          if (seen.has(song.id)) continue
          seen.add(song.id)
          candidates.push(song)
        }
      }

      const match = matchChartEntry(
        {
          title: entry.title,
          artists: artistCandidates(entry.artist),
          duration: entry.duration,
        },
        candidates,
      )

      const song = match.song
      entries.push({
        ...entry,
        inLibrary: song !== null,
        song,
      })
      totalCount += 1
      if (song !== null) matchedCount += 1
    }
    matchedBoards.push({
      id: board.id,
      name: board.name,
      source: board.source,
      entries,
      matched: entries.filter((entry) => entry.inLibrary).length,
      total: entries.length,
    })
  }

  return { status: 'ok', boards: matchedBoards, matched: matchedCount, total: totalCount }
}

// ---------------------------------------------------------------------------
// (b) 为你推荐
// ---------------------------------------------------------------------------

/** 推荐种子的来源。 */
export type RecommendOrigin = 'favorite' | 'local-history' | 'server-history'

/** 推荐是怎么扩展出来的。 */
export type RecommendVia = 'artist' | 'album'

/** 一条候选（歌 + 它凭什么被推出来）。 */
export interface RecommendCandidate {
  /** 候选歌（**已经在你的曲库里** ⇒ 一定能播）。 */
  song: Song
  /** 种子来源。 */
  origin: RecommendOrigin
  /** 扩展方式。 */
  via: RecommendVia
  /** 依据的名字（歌手名或专辑名）。 */
  because: string
}

/** 推荐里的一条（带可读理由）。 */
export interface RecommendItem {
  /** 推荐的歌。 */
  song: Song
  /** 可读理由（如「因为你收藏了 云旗」）。 */
  reason: string
  /** 打分（**同分时**才看它；不跨块比较）。 */
  score: number
}

/** 推荐的一块。 */
export interface RecommendBlock {
  /** 块 id（稳定，测试用）。 */
  id: string
  /** 块标题。 */
  title: string
  /** 这一块的条目。 */
  items: RecommendItem[]
}

/** 打分表（**来源 × 扩展方式**）。 */
const RECOMMEND_SCORES: Record<`${RecommendOrigin}:${RecommendVia}`, number> = {
  'favorite:artist': 3.0,
  'favorite:album': 1.5,
  'local-history:artist': 2.5,
  'local-history:album': 1.0,
  'server-history:artist': 1.8,
  'server-history:album': 0.8,
}

/** 生成可读理由。 */
function reasonOf(origin: RecommendOrigin, via: RecommendVia, because: string): string {
  if (via === 'album') {
    return origin === 'favorite'
      ? `因为你收藏了《${because}》`
      : `因为你最近听过《${because}》`
  }
  return origin === 'favorite' ? `因为你收藏了 ${because}` : `因为你最近听过 ${because}`
}

/** `buildRecommendBlocks` 的入参。 */
export interface RecommendInput {
  /** 候选（由 `gatherRecommendCandidates` 定向查来）。 */
  candidates: RecommendCandidate[]
  /** 要排除的歌 id（本地历史 + 种子本身）。 */
  excludeSongIds: string[]
  /** 每块最多几条（缺省 {@link RECOMMEND_LIMIT_PER_BLOCK}）。 */
  limitPerBlock?: number
}

/** 一首歌的一条推导。 */
interface Derivation {
  origin: RecommendOrigin
  via: RecommendVia
  because: string
  score: number
}

/**
 * 把候选**分块**并**排序**（**纯函数** ⇒ 不碰网络、可单测）。
 *
 * 三块：
 * 1. `favorites`「因为你收藏过」= 收藏派生的候选；
 * 2. `recent`「因为你最近听过」= 本地 / 服务端历史派生的候选；
 * 3. `same-artist`「同一位歌手的其他歌」= 因**歌手**扩展、但前两块没展示完的剩余曲目。
 *
 * 全局规则：
 * - **跨块去重**（先到先得）；
 * - **排除** `excludeSongIds`（本地历史 + 种子本身）；
 * - 同分时**优先「歌手」推导**（理由更贴近用户直觉）；
 * - 某块**没有内容就不显示**（不留空壳）。
 */
export function buildRecommendBlocks(input: RecommendInput): RecommendBlock[] {
  const limit = input.limitPerBlock ?? RECOMMEND_LIMIT_PER_BLOCK
  const excluded = new Set(input.excludeSongIds)

  /** 歌 id → 那首歌的所有推导。 */
  const bySong = new Map<string, { song: Song; derivations: Derivation[] }>()
  for (const candidate of input.candidates) {
    if (excluded.has(candidate.song.id)) continue
    const score = RECOMMEND_SCORES[`${candidate.origin}:${candidate.via}`]
    const derivation: Derivation = {
      origin: candidate.origin,
      via: candidate.via,
      because: candidate.because,
      score,
    }
    const existing = bySong.get(candidate.song.id)
    if (existing) existing.derivations.push(derivation)
    else bySong.set(candidate.song.id, { song: candidate.song, derivations: [derivation] })
  }

  /** 已经被前面某块用掉的歌。 */
  const used = new Set<string>()

  /** 按「推导」挑一批（分高优先；同分优先「歌手」推导）。 */
  const pick = (
    accept: (derivation: Derivation) => boolean,
  ): { song: Song; derivation: Derivation }[] => {
    const rows: { song: Song; derivation: Derivation }[] = []
    for (const entry of bySong.values()) {
      if (used.has(entry.song.id)) continue
      const matched = entry.derivations.filter(accept)
      if (matched.length === 0) continue
      let best = matched[0] as Derivation
      for (const derivation of matched) {
        if (derivation.score > best.score) best = derivation
        else if (
          derivation.score === best.score &&
          derivation.via === 'artist' &&
          best.via !== 'artist'
        ) {
          best = derivation
        }
      }
      rows.push({ song: entry.song, derivation: best })
    }
    rows.sort((a, b) => {
      if (b.derivation.score !== a.derivation.score) return b.derivation.score - a.derivation.score
      if (a.song.title !== b.song.title) return a.song.title < b.song.title ? -1 : 1
      return 0
    })
    return rows.slice(0, limit)
  }

  const blocks: RecommendBlock[] = []

  const favoriteRows = pick((derivation) => derivation.origin === 'favorite')
  if (favoriteRows.length > 0) {
    for (const row of favoriteRows) used.add(row.song.id)
    blocks.push({
      id: 'favorites',
      title: '因为你收藏过',
      items: favoriteRows.map((row) => ({
        song: row.song,
        reason: reasonOf(row.derivation.origin, row.derivation.via, row.derivation.because),
        score: row.derivation.score,
      })),
    })
  }

  const recentRows = pick(
    (derivation) => derivation.origin === 'local-history' || derivation.origin === 'server-history',
  )
  if (recentRows.length > 0) {
    for (const row of recentRows) used.add(row.song.id)
    blocks.push({
      id: 'recent',
      title: '因为你最近听过',
      items: recentRows.map((row) => ({
        song: row.song,
        reason: reasonOf(row.derivation.origin, row.derivation.via, row.derivation.because),
        score: row.derivation.score,
      })),
    })
  }

  const moreRows = pick((derivation) => derivation.via === 'artist')
  if (moreRows.length > 0) {
    for (const row of moreRows) used.add(row.song.id)
    blocks.push({
      id: 'same-artist',
      title: '同一位歌手的其他歌',
      items: moreRows.map((row) => ({
        song: row.song,
        reason: `同样喜欢 ${row.derivation.because}`,
        score: row.derivation.score,
      })),
    })
  }

  return blocks
}

/** `gatherRecommendCandidates` 的入参。 */
export interface RecommendGatherInput {
  /** 收藏（强信号）。 */
  favorites: Song[]
  /** 本机播放记录（**最新在前**）。 */
  localHistory: Song[]
  /** NAS 服务端播放记录（**顺序不可信**，只当曲目池）。 */
  serverHistory: Song[]
  /** 依赖（测试可注入）。 */
  deps?: DiscoverDeps
  /** 每类种子最多取多少首。 */
  seedLimit?: number
}

/** `gatherRecommendCandidates` 的结果。 */
export interface RecommendGatherResult {
  /** 候选。 */
  candidates: RecommendCandidate[]
  /** 要排除的歌 id（本地历史 + 种子本身）。 */
  excludeSongIds: string[]
  /** 有多少次定向查询**失败**（非 0 ⇒ 结果**不完整**，界面要如实说明）。 */
  failures: number
}

/**
 * 定向查候选（**不拉全量曲库**）。
 *
 * 做法：拿种子（收藏 / 本地历史 / 服务端历史）**定向**展开成
 * 「同歌手的其他歌」+「同专辑的其他歌」。
 *
 * ⚠️ **种子要限量**（每类 {@link RECOMMEND_SEED_LIMIT} 首）⇒ 请求数可控；
 *    否则一个收藏了两百首的用户会打出几百个请求。
 * ⚠️ **同一个歌手 / 专辑只查一次**（结果缓存）⇒ 收藏里同歌手的歌只花一份代价。
 */
export async function gatherRecommendCandidates(
  input: RecommendGatherInput,
): Promise<RecommendGatherResult> {
  const deps = input.deps ?? defaultDiscoverDeps
  const seedLimit = input.seedLimit ?? RECOMMEND_SEED_LIMIT

  const seeds: { song: Song; origin: RecommendOrigin }[] = []
  for (const song of input.favorites.slice(0, seedLimit)) {
    seeds.push({ song, origin: 'favorite' })
  }
  for (const song of input.localHistory.slice(0, seedLimit)) {
    seeds.push({ song, origin: 'local-history' })
  }
  for (const song of input.serverHistory.slice(0, seedLimit)) {
    seeds.push({ song, origin: 'server-history' })
  }

  // 排除集合：本地历史（刚听过的别推）+ 种子本身（收藏过的不用再推）。
  const excluded = new Set<string>()
  for (const song of input.localHistory) excluded.add(song.id)
  for (const seed of seeds) excluded.add(seed.song.id)

  // ⚠️ **缓存的是 Promise，不是结果** —— 否则两个**并发**的同歌手任务
  //    会各自去查一次（缓存要等结果回来才填 ⇒ 并发时都看到空缓存）。
  const artistCache = new Map<string, Promise<Song[] | null>>()
  const albumCache = new Map<string, Promise<Song[] | null>>()
  let failures = 0

  const loadArtistSongs = (artistId: string): Promise<Song[] | null> => {
    const cached = artistCache.get(artistId)
    if (cached) return cached
    const promise = deps.artistSongs(artistId).catch(() => {
      // ⚠️ 失败**不缓存**（下一次还能重试）。
      artistCache.delete(artistId)
      failures += 1
      return null
    })
    artistCache.set(artistId, promise)
    return promise
  }

  const loadAlbumSongs = (albumId: string): Promise<Song[] | null> => {
    const cached = albumCache.get(albumId)
    if (cached) return cached
    const promise = deps.albumSongs(albumId).catch(() => {
      albumCache.delete(albumId)
      failures += 1
      return null
    })
    albumCache.set(albumId, promise)
    return promise
  }

  const tasks: { seed: Song; origin: RecommendOrigin; via: RecommendVia; id: string; because: string }[] =
    []
  for (const seed of seeds) {
    if (seed.song.artistId !== '') {
      tasks.push({
        seed: seed.song,
        origin: seed.origin,
        via: 'artist',
        id: seed.song.artistId,
        because: seed.song.artist,
      })
    }
    if (seed.song.albumId !== '') {
      tasks.push({
        seed: seed.song,
        origin: seed.origin,
        via: 'album',
        id: seed.song.albumId,
        because: seed.song.album,
      })
    }
  }

  const groups = await mapWithLimit(tasks, DISCOVER_QUERY_CONCURRENCY, async (task) => {
    const songs =
      task.via === 'artist' ? await loadArtistSongs(task.id) : await loadAlbumSongs(task.id)
    if (!songs) return null
    const out: RecommendCandidate[] = []
    for (const song of songs) {
      if (song.id === task.seed.id) continue
      out.push({ song, origin: task.origin, via: task.via, because: task.because })
    }
    return out
  })

  const candidates: RecommendCandidate[] = []
  for (const group of groups) {
    if (group) candidates.push(...group)
  }

  return { candidates, excludeSongIds: [...excluded], failures }
}
