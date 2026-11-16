// ---------------------------------------------------------------------------
// 「有声读物」扫描与判定状态（T98）
//
// ---------------------------------------------------------------------------
// 这个 store 管三件事：
//   ① **扫描曲库**（逐页、增量水位、断点续跑）⇒ 聚合每张专辑的结构指标；
//   ② **判定**（复用 `src/api/audiobook.ts` 的纯函数）⇒ 哪些专辑是有声读物；
//   ③ **人工改判**（用户拍板「宁可多标 + 一键改判」）⇒ 本地优先于自动判定。
//
// ---------------------------------------------------------------------------
// ⚠️ 持久化为什么走 `localStorage` 而不是 `prefs.json`
// ---------------------------------------------------------------------------
// - `prefs.json` 的白名单是**安全边界**（绝不允许出现凭证），扩它要动主进程；
// - 这里存的是「本机扫描状态 + 用户的改判」，**不是用户偏好**（同族先例：
//   「上次播到哪」住 `localStorage`，见 `src/player/resume.ts`）；
// - ⇒ 走 `localStorage`，并做成**可注入的端口**（单测里没有 localStorage 也能跑）。
//
// ---------------------------------------------------------------------------
// ⚠️ 扫描为什么这么设计（实测，2026-11-16，本机 + 该账号）
// ---------------------------------------------------------------------------
// - 曲库 **173,671 首** ⇒ `size=2000` 只要 **87 页**；
// - ⚠️ 扫描**很贵**（中继 0.5–4 Mbps ⇒ 6–47 分钟）⇒ 必须**可中断、可续跑**；
// - ⇒ 落盘「**已扫到第几页**」+「**候选专辑**的结构指标」⇒ 续跑时接着来。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import {
  AUDIOBOOK_SCORE_THRESHOLD,
  judgeAlbum,
  parseEpisode,
  workDirOf,
  type AudiobookVerdict,
  type EpisodeStats,
} from '../api/audiobook'
import {
  scanLibraryTracks,
  type ScanProgress,
  type ScanTrack,
} from '../api/library'

/** 人工改判的结果。 */
export type AudiobookOverride = 'audiobook' | 'not-audiobook'

/** 一条改判记录（含专辑名，好让「手动判为有声」的条目也能显示在列表里）。 */
export interface AudiobookOverrideRecord {
  /** 判定。 */
  value: AudiobookOverride
  /** 专辑名。 */
  albumTitle: string
}

/** 一张被判定为「有声读物」的专辑。 */
export interface AudiobookHit {
  /** 专辑 id。 */
  albumId: string
  /** 专辑名（= 作品名）。 */
  albumTitle: string
  /** 判定分。 */
  score: number
  /** 命中的依据（**可解释**）。 */
  reasons: string[]
  /** 曲目数。 */
  trackCount: number
  /** 单集均长（秒）。 */
  avgDurationSec: number
  /** 最长单集（秒）。 */
  maxDurationSec: number
  /** 标题形态规则名（`null` = 形态不一致）。 */
  episodeRule: string | null
}

/** 落盘的候选专辑结构指标（断点续跑要用）。 */
interface CandidateSnapshot {
  albumId: string
  albumTitle: string
  trackCount: number
  totalDurationSec: number
  maxDurationSec: number
  /**
   * 标题形态统计（**每条规则命中了多少个标题**）。
   *
   * ⚠️ 为什么**不存标题样本**（真机实测的坑）：
   *   本机曲库 17.3 万首 ⇒ 候选专辑上万张 ⇒ 每张存 30 个标题样本
   *   ⇒ JSON 数 MB ⇒ **超 localStorage 配额**（Chromium 约 5 MB）
   *   ⇒ `save()` 会静默失败 ⇒ **「可续跑」直接失效**。
   *   ⇒ 只存「规则 → 命中数」+「标题总数」（约 100 字节/张 ⇒ 约 1 MB）。
   */
  episodeStats: EpisodeStats
  /** 作品目录集合（最多留几个）。 */
  dirs: string[]
}

/** 落盘的整体状态。 */
export interface AudiobookPersisted {
  /** 版本号（结构变了要 +1）。 */
  version: number
  /** 已扫到第几页（**断点**；0 = 还没开始）。 */
  nextPage: number
  /** 已扫曲目数。 */
  scannedCount: number
  /** 曲库总曲目数。 */
  total: number
  /** 候选专辑的结构指标。 */
  candidates: Record<string, CandidateSnapshot>
  /** 用户的改判。 */
  overrides: Record<string, AudiobookOverrideRecord>
  /** 上次扫完的时间（Unix 毫秒）。 */
  scannedAt: number
}

/** 持久化端口（单测可注入假实现；生产用 `localStorage`）。 */
export interface AudiobookPort {
  /** 读回落盘状态（没有 / 读失败 ⇒ `null`）。 */
  load(): AudiobookPersisted | null
  /**
   * 写回状态（**失败不许抛**）。
   *
   * @returns `true` = 写成功；`false` = **写失败**（配额满 / 隐私模式）
   *   ⇒ 调用方要**如实告诉用户**（「断点没存下来」），不能装作存好了。
   */
  save(state: AudiobookPersisted): boolean
}

/** 落盘状态的键名。 */
const STORAGE_KEY = 'fnmusic-audiobook-state'
/** 当前落盘结构版本（⚠️ 落盘形状变了要 +1 ⇒ 旧数据自动作废）。 */
const STATE_VERSION = 2
/** 每张专辑保留多少个作品目录。 */
const DIR_SAMPLE = 3
/** 单集 ≥ 这么多秒 ⇒ 该专辑**进候选**（落盘用；判时长用 480）。 */
const CANDIDATE_MIN_SEC = 480

/** 生产用的 `localStorage` 端口。 */
export const localStorageAudiobookPort: AudiobookPort = {
  load(): AudiobookPersisted | null {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return null
      const record = parsed as Partial<AudiobookPersisted>
      if (record.version !== STATE_VERSION) return null
      return {
        version: STATE_VERSION,
        nextPage: typeof record.nextPage === 'number' ? record.nextPage : 0,
        scannedCount: typeof record.scannedCount === 'number' ? record.scannedCount : 0,
        total: typeof record.total === 'number' ? record.total : 0,
        candidates:
          typeof record.candidates === 'object' && record.candidates !== null
            ? (record.candidates as Record<string, CandidateSnapshot>)
            : {},
        overrides:
          typeof record.overrides === 'object' && record.overrides !== null
            ? (record.overrides as Record<string, AudiobookOverrideRecord>)
            : {},
        scannedAt: typeof record.scannedAt === 'number' ? record.scannedAt : 0,
      }
    } catch {
      return null
    }
  },
  save(state: AudiobookPersisted): boolean {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state))
      return true
    } catch {
      // ⚠️ 写不进去（配额满 / 隐私模式）**不许抛**：扫描结果仍在内存里可用。
      //    但**必须如实回报失败** ⇒ 调用方会告诉用户「断点没存下来」。
      return false
    }
  },
}

/** 内存端口（没有 `localStorage` 的环境用；也是单测的默认值）。 */
export function createMemoryAudiobookPort(initial?: AudiobookPersisted): AudiobookPort {
  let state: AudiobookPersisted | null = initial ?? null
  return {
    load: () => state,
    save: (next) => {
      state = next
      return true
    },
  }
}

/** store 的形状。 */
export interface AudiobookStore {
  /** 命中的专辑（**已按判定分降序**）。 */
  hits: AudiobookHit[]
  /** 用户的改判（**优先于**自动判定）。 */
  overrides: Record<string, AudiobookOverrideRecord>
  /** 正在扫描？ */
  scanning: boolean
  /** 扫描进度。 */
  progress: ScanProgress | null
  /** 上一次的错误。 */
  error: string | null
  /** 上次扫完的时间（Unix 毫秒；`null` = 从没扫过）。 */
  scannedAt: number | null
  /**
   * 扫描曲库。
   *
   * @param options `full` = 忽略断点从头扫；否则**续跑**（从上次断点接着来）。
   */
  scan: (options?: { full?: boolean; port?: AudiobookPort }) => Promise<void>
  /**
   * 把**上次扫描的结果**读回来显示（**不发任何请求**）。
   *
   * ⚠️ 为什么要有它：扫描很贵（实测 87 页 / 6–47 分钟）⇒
   *    进页面**不能**自动扫描 ⇒ 但要把上次的命中显示出来 ⇒ 只读落盘。
   */
  restore: (port?: AudiobookPort) => void
  /** 人工改判（`null` = 撤销改判，回到自动判定）。 */
  setOverride: (
    albumId: string,
    value: AudiobookOverride | null,
    port?: AudiobookPort,
    albumTitle?: string,
  ) => void
  /** 这张专辑是不是「有声读物」（**改判优先**）。 */
  isAudiobook: (albumId: string) => boolean
  /** 取这张专辑的判定结果（`null` = 没有）。 */
  hitOf: (albumId: string) => AudiobookHit | null
}

/** 聚合器：把逐页扫到的曲目**按专辑**累加。 */
interface Aggregator {
  albumId: string
  albumTitle: string
  trackCount: number
  totalDurationSec: number
  maxDurationSec: number
  /** 标题形态统计（**全量标题**，不是样本）。 */
  episodeStats: EpisodeStats
  /** 作品目录（≤ `DIR_SAMPLE` 个）。 */
  dirs: string[]
}

/** 新建一个聚合器。 */
function newAggregator(albumId: string, albumTitle: string): Aggregator {
  return {
    albumId,
    albumTitle,
    trackCount: 0,
    totalDurationSec: 0,
    maxDurationSec: 0,
    episodeStats: { ruleCounts: {}, titleCount: 0 },
    dirs: [],
  }
}

/** 把一页曲目并进聚合器。 */
function accumulate(target: Map<string, Aggregator>, tracks: readonly ScanTrack[]): void {
  for (const t of tracks) {
    if (!t.albumId) continue
    let agg = target.get(t.albumId)
    if (!agg) {
      agg = newAggregator(t.albumId, t.albumTitle)
      target.set(t.albumId, agg)
    }
    agg.trackCount += 1
    agg.totalDurationSec += t.durationSec
    if (t.durationSec > agg.maxDurationSec) agg.maxDurationSec = t.durationSec
    // ⚠️ 形态统计按**全量标题**累加（不是前 30 个样本）⇒ 命中率才准。
    agg.episodeStats.titleCount += 1
    const parsed = parseEpisode(t.title)
    if (parsed) {
      agg.episodeStats.ruleCounts[parsed.rule] =
        (agg.episodeStats.ruleCounts[parsed.rule] ?? 0) + 1
    }
    const dir = workDirOf(t.path)
    if (dir !== null && !agg.dirs.includes(dir) && agg.dirs.length < DIR_SAMPLE) agg.dirs.push(dir)
  }
}

/**
 * 把聚合器判定成命中列表（**纯计算**，不发请求）。
 *
 * ⚠️ 三个覆盖项都来自聚合器（扫描路径**不能**用标题样本冒充）：
 *   集数 / 均长 / 最长单集 / 作品目录唯一性 / 形态命中率。
 */
function judgeAggregator(aggregator: Map<string, Aggregator>): AudiobookHit[] {
  const hits: AudiobookHit[] = []
  for (const agg of aggregator.values()) {
    const verdict = judgeAlbum([], {
      trackCount: agg.trackCount,
      avgDurationSec:
        agg.trackCount > 0 ? Math.round(agg.totalDurationSec / agg.trackCount) : 0,
      maxDurationSec: agg.maxDurationSec,
      workDirUnique: agg.dirs.length === 1,
      episodeStats: agg.episodeStats,
    })
    if (verdict.score < AUDIOBOOK_SCORE_THRESHOLD) continue
    hits.push(verdictToHit(verdict, agg.albumId, agg.albumTitle))
  }
  hits.sort(
    (a, b) => b.score - a.score || b.trackCount - a.trackCount || a.albumTitle.localeCompare(b.albumTitle),
  )
  return hits
}

/** 判定结果 ⇒ 落盘/界面用的形状。 */
function verdictToHit(verdict: AudiobookVerdict, albumId: string, albumTitle: string): AudiobookHit {
  return {
    albumId,
    albumTitle,
    score: verdict.score,
    reasons: verdict.reasons,
    trackCount: verdict.trackCount,
    avgDurationSec: verdict.avgDurationSec,
    maxDurationSec: verdict.maxDurationSec,
    episodeRule: verdict.episodeRule,
  }
}

/** 判定一张专辑是否**进候选**（要落盘的结构指标）。 */
function isCandidate(agg: Aggregator): boolean {
  if (agg.trackCount >= 8) return true
  return agg.maxDurationSec >= CANDIDATE_MIN_SEC
}

/** 把聚合器里**进候选**的压成落盘表。 */
function snapshotCandidates(aggregator: Map<string, Aggregator>): Record<string, CandidateSnapshot> {
  const candidates: Record<string, CandidateSnapshot> = {}
  for (const agg of aggregator.values()) {
    if (isCandidate(agg)) candidates[agg.albumId] = toSnapshot(agg)
  }
  return candidates
}

/** 落盘状态（默认）。 */
function emptyPersisted(): AudiobookPersisted {
  return {
    version: STATE_VERSION,
    nextPage: 0,
    scannedCount: 0,
    total: 0,
    candidates: {},
    overrides: {},
    scannedAt: 0,
  }
}

/** 把聚合器压成落盘形状。 */
function toSnapshot(agg: Aggregator): CandidateSnapshot {
  return {
    albumId: agg.albumId,
    albumTitle: agg.albumTitle,
    trackCount: agg.trackCount,
    totalDurationSec: agg.totalDurationSec,
    maxDurationSec: agg.maxDurationSec,
    episodeStats: {
      ruleCounts: { ...agg.episodeStats.ruleCounts },
      titleCount: agg.episodeStats.titleCount,
    },
    dirs: agg.dirs.slice(0, DIR_SAMPLE),
  }
}

/** 把落盘的候选还原成聚合器。 */
function fromSnapshot(snap: CandidateSnapshot): Aggregator {
  const ruleCounts = snap.episodeStats?.ruleCounts
  return {
    albumId: snap.albumId,
    albumTitle: snap.albumTitle,
    trackCount: snap.trackCount,
    totalDurationSec: snap.totalDurationSec,
    maxDurationSec: snap.maxDurationSec,
    episodeStats: {
      ruleCounts:
        typeof ruleCounts === 'object' && ruleCounts !== null ? { ...ruleCounts } : {},
      titleCount: typeof snap.episodeStats?.titleCount === 'number' ? snap.episodeStats.titleCount : 0,
    },
    dirs: Array.isArray(snap.dirs) ? snap.dirs.slice(0, DIR_SAMPLE) : [],
  }
}

/** `src/state/audiobookStore.ts` 的 store。 */
export const useAudiobookStore = create<AudiobookStore>((set, get) => ({
  hits: [],
  overrides: {},
  scanning: false,
  progress: null,
  error: null,
  scannedAt: null,

  scan: async (options) => {
    const port = options?.port ?? localStorageAudiobookPort
    const saved = port.load() ?? emptyPersisted()
    const full = options?.full === true

    // ⚠️ **只有真存在「未扫完的断点」才恢复旧聚合**：
    //    `nextPage === 0` ⇒ 没有断点（要么没扫过，要么上轮**扫完了**）
    //    ⇒ 这一轮从头扫 ⇒ 旧聚合**必须丢掉**，否则集数会**翻倍**。
    const hasBreakpoint = !full && saved.nextPage > 0
    const startPage = hasBreakpoint ? saved.nextPage : 1
    const aggregator = new Map<string, Aggregator>()
    if (hasBreakpoint) {
      for (const snap of Object.values(saved.candidates)) {
        const agg = fromSnapshot(snap)
        aggregator.set(agg.albumId, agg)
      }
    }
    const baseScanned = hasBreakpoint ? saved.scannedCount : 0

    set({
      scanning: true,
      error: null,
      overrides: { ...saved.overrides },
      progress: { page: startPage - 1, pages: 0, scanned: baseScanned, total: saved.total },
    })

    let scannedCount = baseScanned
    let nextPage = startPage
    /** 落盘失败过没有（配额满 / 隐私模式）⇒ 要**如实告诉用户**。 */
    let persistFailed = false

    try {
      // ⚠️ 服务端**没有**「跳过前 N 页」的参数，但 `page` 本身就是偏移
      //    ⇒ 直接从断点页开始（`startPage`）⇒ 续跑不会重扫前面的页。
      const result = await scanLibraryTracks({
        pageSize: 2000,
        maxPages: 2000,
        startPage,
        onPage: (tracks, progress) => {
          accumulate(aggregator, tracks)
          scannedCount = baseScanned + progress.scanned
          nextPage = progress.page
          set({ progress: { ...progress, scanned: scannedCount } })
          // ⚠️ **每页落一次断点** ⇒ 中途断了也能接着扫（规格 §3.3.3）。
          const ok = port.save({
            version: STATE_VERSION,
            // `nextPage` = **下一个要扫的页**（0 = 没有断点）。
            nextPage: progress.page + 1,
            scannedCount,
            total: progress.total,
            candidates: snapshotCandidates(aggregator),
            overrides: { ...saved.overrides },
            scannedAt: saved.scannedAt,
          })
          if (!ok) persistFailed = true
        },
      })

      // ---- 判定 ----
      const hits = judgeAggregator(aggregator)

      // ---- 落盘（只留候选 + 改判）----
      const candidates = snapshotCandidates(aggregator)
      const persisted: AudiobookPersisted = {
        version: STATE_VERSION,
        // ⚠️ 扫完了 ⇒ **没有断点**（`nextPage = 0`）⇒ 下次扫描从头来。
        nextPage: 0,
        scannedCount,
        total: result.total,
        candidates,
        overrides: { ...saved.overrides },
        scannedAt: Date.now(),
      }
      const savedOk = port.save(persisted)
      if (!savedOk) persistFailed = true

      set({
        hits,
        overrides: persisted.overrides,
        scanning: false,
        error: persistFailed
          ? '扫描完成了，但**结果没存到本机**（本地存储可能已满）⇒ 下次进入不会自动恢复。'
          : null,
        scannedAt: persisted.scannedAt,
        progress: { page: nextPage, pages: result.pages, scanned: scannedCount, total: result.total },
      })
    } catch (err) {
      set({
        scanning: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  /**
   * 把上次扫描的结果**读回来**（**不发任何请求**）。
   *
   * ⚠️ 进页面**只做这件事** —— 扫描很贵（87 页 / 6–47 分钟），
   *    不能因为「看了一眼页面」就自动扫全库。
   */
  restore: (port) => {
    const p = port ?? localStorageAudiobookPort
    const saved = p.load()
    if (!saved) {
      set({ hits: [], overrides: {}, scannedAt: null, progress: null, error: null })
      return
    }
    const aggregator = new Map<string, Aggregator>()
    for (const snap of Object.values(saved.candidates)) {
      const agg = fromSnapshot(snap)
      aggregator.set(agg.albumId, agg)
    }
    set({
      hits: judgeAggregator(aggregator),
      overrides: { ...saved.overrides },
      scannedAt: saved.scannedAt > 0 ? saved.scannedAt : null,
      progress: {
        page: saved.nextPage,
        pages: saved.total > 0 ? Math.max(1, Math.ceil(saved.total / 2000)) : 0,
        scanned: saved.scannedCount,
        total: saved.total,
      },
      error: null,
    })
  },

  setOverride: (albumId, value, port, albumTitle) => {
    const p = port ?? localStorageAudiobookPort
    const saved = p.load() ?? emptyPersisted()
    const overrides = { ...saved.overrides }
    if (value === null) delete overrides[albumId]
    else overrides[albumId] = { value, albumTitle: albumTitle ?? overrides[albumId]?.albumTitle ?? '' }
    p.save({ ...saved, overrides })
    set({ overrides })
  },

  isAudiobook: (albumId) => {
    const override = get().overrides[albumId]
    if (override?.value === 'audiobook') return true
    if (override?.value === 'not-audiobook') return false
    return get().hits.some((h) => h.albumId === albumId)
  },

  hitOf: (albumId) => {
    const override = get().overrides[albumId]
    if (override?.value === 'not-audiobook') return null
    const hit = get().hits.find((h) => h.albumId === albumId) ?? null
    if (override?.value === 'audiobook' && !hit) {
      // ⚠️ 用户**手动**判为有声，但自动判定没命中 ⇒ 造一条「用户判定」的记录。
      return {
        albumId,
        albumTitle: override.albumTitle,
        score: 0,
        reasons: ['user'],
        trackCount: 0,
        avgDurationSec: 0,
        maxDurationSec: 0,
        episodeRule: null,
      }
    }
    return hit
  },
}))
