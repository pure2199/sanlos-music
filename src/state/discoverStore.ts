// ---------------------------------------------------------------------------
// 「发现」页的状态（T96）
// ---------------------------------------------------------------------------
//
// ⚠️ **曲库 = 当前登录用户自己的 NAS 曲库**（规模与内容**因人而异**）⇒
//    本 store **不假设曲库有多大**，也**不缓存整份曲库**：
//    榜单的「在不在曲库」是**每次打开时按当前账号实时查**出来的。
//
// ⚠️ **两类失败必须分开**（不许混成一句话）：
// - `chartsError`：**榜源**挂了（外部网络 / 榜源抽风）；
// - `matchError`：**曲库**查不动（NAS 没响应）——
//   ⚠️ **这不等于「都不在曲库」**，界面不许这么写。
//
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { ChartBoard, ChartResult, MatchedChartBoard } from '../../shared/chartTypes'
import type { PlayerBridge } from '../../shared/playerBridge'
import {
  buildRecommendBlocks,
  defaultDiscoverDeps,
  gatherRecommendCandidates,
  matchChartsToLibrary,
  pendingChartBoards,
  type DiscoverDeps,
  type RecommendBlock,
} from '../api/discover'
import { favoriteApi } from '../api/favorite'
import { historyApi } from '../api/history'
import { useLocalHistory } from './historyStore'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { sanlosPlayer?: PlayerBridge }
  return scope.sanlosPlayer ?? null
}

/** 服务端历史的取多少条（**只当曲目池**：顺序不可信、没有次数）。 */
const SERVER_HISTORY_SIZE = 50

// ---------------------------------------------------------------------------
// T124：匹配结果**会话内缓存**（二次进入「发现」不再打 NAS）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么缓存**：匹配要**逐个歌手定向查** NAS（榜单里出现几个歌手就查几次）
//    ⇒ 中继链路上要 **30–40 秒** ⇒ 二次进入再打一遍纯属浪费。
//    ⇒ 缓存**匹配结果**（榜单条目 → 命中与否，体量只有几十条，**不是整份曲库**）。
//
// ⚠️ **为什么是「会话内」而不是带 TTL 的长期缓存**：
//    曲库内容会变（用户新加了歌）⇒ 缓存久了会给出**过时**的命中状态；
//    而「二次进入不重打」这个诉求**只需要覆盖同一次运行**⇒ 进程退出即失效，最安全。
//
// ⚠️ **缓存 key**：榜单 id ＋ 每个榜单的条目数 ＋ 首条标题
//    ⇒ 榜单内容变了（条目数/标题变了）⇒ key 变了 ⇒ **不会命中旧缓存**。
const matchCache = new Map<string, CachedMatch>()

/** 缓存里的一条匹配结果。 */
interface CachedMatch {
  /** 匹配后的榜单。 */
  boards: MatchedChartBoard[]
  /** 命中数。 */
  matched: number
  /** 条目总数。 */
  total: number
}

/** 算出榜单的**缓存 key**（内容变了 ⇒ key 变 ⇒ 不会命中旧缓存）。 */
function cacheKeyOf(boards: ChartBoard[]): string {
  return boards
    .map((board) => `${board.id}:${board.entries.length}:${board.entries[0]?.title ?? ''}`)
    .join('|')
}

/** 「发现」页 store 的形状。 */
export interface DiscoverStore {
  /** 原始榜单（主进程回的，**还没跟曲库对过**）。 */
  charts: ChartBoard[]
  /** 匹配后的榜单（**在你的曲库**里标好了命中 / 未命中）。 */
  boards: MatchedChartBoard[]
  /** 榜单正在拉。 */
  chartsLoading: boolean
  /**
   * **匹配**正在跑（T124：榜单先出、命中异步补）。
   *
   * ⚠️ `chartsLoading === false` 但 `matching === true` ⇒ 榜单**已经在屏幕上**，
   *    命中结果**还没到**（条目显示「匹配中…」）。
   */
  matching: boolean
  /** **榜源**失败（可读中文）。 */
  chartsError: string | null
  /** 榜源部分失败（警告，**不是**错误）。 */
  chartsNotice: string | null
  /** **曲库**查不动（**不是**「都不在曲库」）。 */
  matchError: string | null
  /** 命中数（**你的**曲库命中数）。 */
  matchedCount: number
  /** 条目总数。 */
  totalCount: number
  /** 推荐块。 */
  blocks: RecommendBlock[]
  /** 推荐正在算。 */
  recommendLoading: boolean
  /** 推荐失败（可读中文）。 */
  recommendError: string | null
  /** 推荐结果**不完整**（部分定向查询失败 ⇒ 如实说明）。 */
  recommendPartial: boolean
  /** 拉榜单 + 跟曲库对上（`deps` 供测试注入）。 */
  loadCharts: (deps?: DiscoverDeps) => Promise<void>
  /** 算推荐（`deps` 供测试注入）。 */
  loadRecommendations: (deps?: DiscoverDeps) => Promise<void>
  /** 两块都重来。 */
  reload: (deps?: DiscoverDeps) => Promise<void>
}

/** 「发现」页 store（生产用）。 */
export const useDiscoverStore = create<DiscoverStore>()((set, get) => ({
  charts: [],
  boards: [],
  chartsLoading: false,
  matching: false,
  chartsError: null,
  chartsNotice: null,
  matchError: null,
  matchedCount: 0,
  totalCount: 0,
  blocks: [],
  recommendLoading: false,
  recommendError: null,
  recommendPartial: false,

  loadCharts: async (deps?: DiscoverDeps): Promise<void> => {
    const bridge = playerBridge()
    set({ chartsLoading: true, chartsError: null, chartsNotice: null, matchError: null })
    if (!bridge) {
      set({ chartsLoading: false, matching: false, chartsError: '当前环境不支持榜单（缺少主进程桥）' })
      return
    }

    let result: ChartResult
    try {
      result = await bridge.fetchCharts()
    } catch {
      set({ chartsLoading: false, matching: false, chartsError: '榜单源暂时不可用' })
      return
    }

    if (!result || result.status !== 'ok') {
      set({
        chartsLoading: false,
        matching: false,
        charts: [],
        boards: [],
        chartsError: result?.message ?? '榜单源暂时不可用',
        chartsNotice: null,
        matchError: null,
        matchedCount: 0,
        totalCount: 0,
      })
      return
    }

    // ⚠️ **榜源部分失败**只是**警告**（已取到的照常显示）。
    const notice = result.message ?? null

    // ---- T124：命中**异步补**（榜单先出）＋ **会话内缓存** ------------------
    //
    // ⚠️ 匹配要逐个歌手定向查 NAS ⇒ 中继链路上 **30–40 秒** ⇒
    //    **不能**让它挡住榜单的显示 ⇒ 榜单先出（条目标 `pending`），命中**后台补**。
    const cacheKey = cacheKeyOf(result.boards)
    const cached = matchCache.get(cacheKey)
    if (cached) {
      // ⚠️ **缓存命中** ⇒ 直接用，**一个 NAS 请求都不发**（二次进入秒开）。
      set({
        chartsLoading: false,
        charts: result.boards,
        boards: cached.boards,
        chartsError: null,
        chartsNotice: notice,
        matchError: null,
        matchedCount: cached.matched,
        totalCount: cached.total,
        matching: false,
      })
      return
    }

    // 榜单**先出**（未匹配的条目显示「匹配中…」）。
    set({
      chartsLoading: false,
      charts: result.boards,
      boards: pendingChartBoards(result.boards),
      chartsError: null,
      chartsNotice: notice,
      matchError: null,
      matchedCount: 0,
      totalCount: result.boards.reduce((sum, board) => sum + board.entries.length, 0),
      matching: true,
    })

    const outcome = await matchChartsToLibrary(result.boards, deps ?? defaultDiscoverDeps)
    if (outcome.status === 'unavailable') {
      // ⚠️ **曲库查不动** ⇒ 说「暂时无法匹配曲库」，**不说「都不在曲库」**。
      set({
        chartsLoading: false,
        matching: false,
        charts: result.boards,
        boards: pendingChartBoards(result.boards),
        chartsError: null,
        chartsNotice: notice,
        matchError: outcome.message ?? '暂时无法匹配曲库',
        matchedCount: 0,
        totalCount: result.boards.reduce((sum, board) => sum + board.entries.length, 0),
      })
      return
    }

    // ⚠️ 匹配完成 ⇒ **补上**命中结果（榜单**已经**在屏幕上了）。
    matchCache.set(cacheKey, {
      boards: outcome.boards,
      matched: outcome.matched,
      total: outcome.total,
    })
    set({
      chartsLoading: false,
      matching: false,
      charts: result.boards,
      boards: outcome.boards,
      chartsError: null,
      chartsNotice: notice,
      matchError: null,
      matchedCount: outcome.matched,
      totalCount: outcome.total,
    })
  },

  loadRecommendations: async (deps?: DiscoverDeps): Promise<void> => {
    set({ recommendLoading: true, recommendError: null, recommendPartial: false })
    const resolved = deps ?? defaultDiscoverDeps
    try {
      const [favorites, serverHistory] = await Promise.all([
        favoriteApi.list(),
        historyApi.list(1, SERVER_HISTORY_SIZE),
      ])
      const localHistory = useLocalHistory.getState().items
      const gathered = await gatherRecommendCandidates({
        favorites,
        localHistory,
        serverHistory: serverHistory.list,
        deps: resolved,
      })
      const blocks = buildRecommendBlocks({
        candidates: gathered.candidates,
        excludeSongIds: gathered.excludeSongIds,
      })
      set({
        recommendLoading: false,
        blocks,
        recommendError: null,
        // ⚠️ 部分查询失败 ⇒ 结果**不完整** ⇒ 如实说明（不装作完整）。
        recommendPartial: gathered.failures > 0,
      })
    } catch {
      set({ recommendLoading: false, blocks: [], recommendError: '暂时无法加载推荐', recommendPartial: false })
    }
  },

  reload: async (deps?: DiscoverDeps): Promise<void> => {
    await get().loadCharts(deps)
    await get().loadRecommendations(deps)
  },
}))
