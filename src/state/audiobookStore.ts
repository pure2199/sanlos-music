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
//
// ---------------------------------------------------------------------------
// v3 改版（2026-11-16，用户实机反馈「有声做得不行」之后）
// ---------------------------------------------------------------------------
// - 「**是不是有声**」**不再**由打分决定（打分**降级为参考信息**）
//   ⇒ 改由**用户指位置**决定：① 作品名秒搜点开 ② **目录 `path` 关键字命中**
//     ③ 手动改判；
// - 「**那个文件夹**」= 用户给的**目录关键字**（默认 `有声小说`，**可改**）
//   ⇒ 扫描时**只聚合命中的曲目** ⇒ 列表里只有那个文件夹下的作品；
// - 打分**不再当门槛** ⇒ 该目录下的作品**全部列出**（分数低的标「结构信号弱」）；
// - **换关键字 ⇒ 断点作废**（过滤条件变了 ⇒ 断点里的聚合是按旧关键字算的）。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import { LEGACY_AUDIOBOOK_STATE_KEY } from '../../shared/legacyStorageKeys'
import {
  DEFAULT_FOLDER_KEYWORD,
  judgeAlbum,
  parseEpisode,
  pathMatchesKeyword,
  workDirOf,
  workGroupKey,
  type AudiobookVerdict,
  type EpisodeStats,
} from '../api/audiobook'
import {
  scanLibraryTracks,
  type ScanProgress,
  type ScanTrack,
} from '../api/library'
// ⚠ **T120**：按**服务端目录**浏览（替代「全库扫 87 页 ＋ 按 path 关键字挑」）。
import { scanFolderTracks, type FolderScanResult } from '../api/folder'

/** 人工改判的结果。 */
export type AudiobookOverride = 'audiobook' | 'not-audiobook'

/** 一条改判记录（含专辑名，好让「手动判为有声」的条目也能显示在列表里）。 */
export interface AudiobookOverrideRecord {
  /** 判定。 */
  value: AudiobookOverride
  /** 专辑名。 */
  albumTitle: string
}

/** 一张被判定为「有声读物」的专辑（**归并后的一组**，T99）。 */
export interface AudiobookHit {
  /**
   * **主专辑** id（集数最多的那个）—— 下钻用它。
   *
   * ⚠️ T99：服务端可能把**一部作品拆成两张同名专辑**（实测《让青春继续第一季》
   *    被拆成 31 集 + 1 集 ⇒ **第 02 集丢了**）⇒ 同名 + 同作品目录的专辑
   *    在这里**归并成一组**，主专辑只是「下钻入口」。
   */
  albumId: string
  /**
   * **组内全部专辑 id**（主专辑排第一）。
   *
   * ⚠️ 详情页要按**整组**拉全量（主专辑 + 成员）⇒ 合并后按集序排
   *    ⇒ 跨专辑的集号才**连续**（第 02 集不再丢）。
   */
  albumIds: string[]
  /** 专辑名（= 作品名；同名同目录的成员共用一个名字）。 */
  albumTitle: string
  /** 判定分。 */
  score: number
  /** 命中的依据（**可解释**）。 */
  reasons: string[]
  /** 曲目数（**组合计**）。 */
  trackCount: number
  /** 单集均长（秒；**组合计**）。 */
  avgDurationSec: number
  /** 最长单集（秒；**组内最长**）。 */
  maxDurationSec: number
  /** 标题形态规则名（`null` = 形态不一致）。 */
  episodeRule: string | null
  /**
   * 封面 id（`null` = 没有封面）。
   *
   * ⚠️ **T101**：「有声」页要画**封面卡片**（同专辑页）⇒ 命中条目必须带封面。
   *    扫描时**顺手**记下（曲目的 `coverId` 本来就在数据里 ⇒ 不要钱）；
   *    旧落盘没有 ⇒ 进页时按需补拉 `/album/detail`（见 `setCover`）。
   *
   * ⚠️ **T102**：这是「**曲目**封面」⇒ **不再用于显示**（显示一律用 `albumCoverId`），
   *    但**保留**（落盘形状不变 ⇒ T101 的旧落盘照样能读、既有测试一条不改）。
   */
  coverId: string | null
  /**
   * **专辑自己的**封面 id —— **卡片显示的就是它**。
   *
   * ⚠️ **T102**（三态，**别**用真假值判断）：
   * - `undefined` = **未知**（旧落盘没有这个字段）⇒ 要补拉一次 `/album/detail`；
   * - `null` = **确认没有封面**（专辑确实没封面）⇒ **不用**再拉；
   * - 字符串 = 有封面。
   *
   * ⚠️ **为什么必须是「专辑的」**：曲目的封面与专辑的封面是**两个不同的 id**
   *    （真机实测：「庙堂之外」曲目 `track_591e8c99…` / 专辑 `album_1988d5f2…`）
   *    ⇒ 用曲目封面**永远统一不了** ⇒ 统一到专辑封面 ⇒ 与专辑页 / 秒搜**逐字一致**。
   *
   * ⚠️ **可选**（`?`）：**缺省 = 未知** ⇒ 造一条命中记录时**不必**带这个字段
   *    ⇒ 既有测试与既有代码**一个字都不用改**。
   */
  albumCoverId?: string | null
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
  /**
   * 封面 id（`null` / 缺省 = 没有封面）。
   *
   * ⚠️ **T101**：这是**可选**字段 ⇒ **旧落盘照样能读** ⇒ `STATE_VERSION` **不升**
   *    （升了 ⇒ 用户已扫过的结果全部作废 ⇒ 白扫一次 52 秒）。
   */
  coverId?: string | null
  /**
   * **专辑自己的**封面 id（T102，**可选** ⇒ `STATE_VERSION` 仍为 3）。
   *
   * ⚠️ **三态**（**靠「字段在不在」区分**，别用真假值）：
   * - **字段缺省** = **未知** ⇒ 要补拉一次 `/album/detail`（T101 的旧落盘就是这个形状）；
   * - `null` = **确认没有封面** ⇒ 不用再拉；
   * - 字符串 = 有封面。
   *
   * ⚠️ **为什么不能复用 `coverId`**：`coverId` 装的是**曲目**封面（T101 的语义）
   *    ⇒ 两者混在一起就**分不清**「旧的曲目封面」与「新的专辑封面」⇒ 旧落盘永远统一不了。
   */
  albumCoverId?: string | null
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
  /**
   * 上次扫描用的**目录关键字**（「那个文件夹」）。
   *
   * ⚠ v3 新增：关键字**可改** ⇒ 要记住上次用的那个，页面进来看得见、
   *   也能直接改。**空串 = 还没扫过**。
   */
  keyword: string
  /** 上次扫完的时间（Unix 毫秒；`null` = 从没扫过）。 */
  scannedAt: number
  /**
   * **T120**：上次扫描定位到的目录（**绝对路径**；可能多个）。
   *
   * ⚠ **可选字段** ⇒ 旧落盘（v3）**照样读得出** ⇒ `STATE_VERSION` **不升**
   *    ⇒ 老用户上次扫的结果**直接还在**（不用重扫）。
   * ⚠ 空数组 = 上次走的是**全库扫描**（老服务端回落）。
   */
  folderPaths?: string[]
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

/** 落盘状态的键名（**新键**；旧键见 `shared/legacyStorageKeys.ts`）。 */
const STORAGE_KEY = 'sanlos-audiobook-state'
/**
 * 当前落盘结构版本（落盘形状变了要 +1 ⇒ 旧数据自动作废）。
 *
 * ⚠️ **v3**：加了 `keyword`（目录关键字）⇒ 形状变了 ⇒ 版本 +1
 *    （v2 的落盘**自动作废**，用户重扫一次即可）。
 * ⚠️ **T101 没有升版本**：只加了一个**可选**字段 `coverId` ⇒ **旧落盘照样能读**
 *    （升了 ⇒ 用户已扫过的结果全部作废 ⇒ 白扫一次 52 秒）。
 */
const STATE_VERSION = 3
/** 每张专辑保留多少个作品目录。 */
const DIR_SAMPLE = 3
/**
 * 最多保留多少部作品（**内存 + 落盘**都按这个上限）。
 *
 * ⚠ 为什么要上限：目录关键字**可以写得很宽**（比如 `vol02`）⇒ 可能命中**整库**
 *   ⇒ 落盘会**超 `localStorage` 配额**（Chromium 约 5 MB）⇒ 扫描结果**静默丢失**。
 *   ⇒ 超过上限就**如实告诉用户**（让他把目录名写得更具体），不装作存好了。
 */
export const MAX_AUDIOBOOK_ITEMS = 500

/** 生产用的 `localStorage` 端口。 */
export const localStorageAudiobookPort: AudiobookPort = {
  load(): AudiobookPersisted | null {
    try {
      // ⚠️ **T117：新键没有才回落读旧键**（旧键**只读**、**不删**）
      //    ⇒ 老用户升级后「有声读物的扫描结果」**不丢**
      //    ⇒ 不丢 ⇒ ① **自动判定**还在（T112 的桌面歌词修复继续有效）
      //    ② **手工改判**还在 ③ 「有声」页**不用**再全库重扫（87 页 / 6–47 分钟）。
      //    ⚠️ 与另外三个键同一套纪律：**新键优先**、旧键只读、写入自然落到新键。
      const raw =
        globalThis.localStorage?.getItem(STORAGE_KEY) ??
        globalThis.localStorage?.getItem(LEGACY_AUDIOBOOK_STATE_KEY)
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
        keyword: typeof record.keyword === 'string' ? record.keyword : '',
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

/**
 * 扫描进度（**T120：两种口径**）。
 *
 * ⚠ `page` / `pages` 在**全库扫描**下是「页码 / 总页数」；
 *    在**目录浏览**下是「已访问的目录数 / `0`（未知）」⇒ 界面**按 `mode` 分文案**。
 */
export interface AudiobookProgress extends ScanProgress {
  /** 口径：`library` = 全库扫描；`folder` = 按服务端目录浏览。 */
  mode?: 'library' | 'folder'
  /** 目录浏览时定位到的目录（**绝对路径**；`null` = 还没定位到）。 */
  folderPath?: string | null
}

/** store 的形状。 */
export interface AudiobookStore {
  /** 命中的专辑（**已按判定分降序**）。 */
  hits: AudiobookHit[]
  /** 用户的改判（**优先于**自动判定）。 */
  overrides: Record<string, AudiobookOverrideRecord>
  /**
   * 上次扫描用的**目录关键字**（「那个文件夹」）。
   *
   * ⚠ v3：这是**用户的位置**，不是判定依据 ⇒ 界面拿它显示「上次扫的是哪个目录」。
   */
  keyword: string
  /** 正在扫描？ */
  scanning: boolean
  /** 扫描进度。 */
  progress: AudiobookProgress | null
  /** 上一次的错误。 */
  error: string | null
  /**
   * **T120**：**提示**（不是错误）—— 例如「服务端不支持按目录浏览，已改用全库扫描」。
   *
   * ⚠ 为什么单独一个字段：塞进 `error` 会显示成「**加载失败**：…」⇒ **指错方向**。
   */
  notice: string | null
  /** 上次扫完的时间（Unix 毫秒；`null` = 从没扫过）。 */
  scannedAt: number | null
  /**
   * 扫描曲库。
   *
   * @param options `full` = 忽略断点从头扫；`keyword` = 目录关键字（**默认**取上次那个）；
   *   否则**续跑**（从上次断点接着来）。
   */
  scan: (options?: { full?: boolean; port?: AudiobookPort; keyword?: string }) => Promise<void>
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
  /**
   * **补上封面 id**（T101）。
   *
   * ⚠️ **谁调它**：页面看到命中条目**没有封面**（旧落盘 / 手动指定的条目）
   *    ⇒ 去拉一次 `/album/detail` ⇒ 拿到后调这个 ⇒ **改命中 + 回写落盘**
   *    ⇒ 下次进来**不用**再拉。
   * ⚠️ **不发请求**：这里只管状态与落盘；请求由页面编排（store 不碰网络）。
   */
  setCover: (albumId: string, coverId: string | null, port?: AudiobookPort) => void
  /**
   * **补上「专辑自己的」封面 id**（T102）—— 卡片**显示**的就是它。
   *
   * ⚠️ **谁调它**：页面看到命中的专辑封面**未知**（`albumCoverId === undefined`
   *    ⇒ T101 的旧落盘 / 手动指定的条目）⇒ 去拉一次 `/album/detail`
   *    ⇒ 拿到后调这个 ⇒ **改命中 + 回写落盘** ⇒ 下次进来**不用**再拉。
   * ⚠️ **传 `null`** = 「这张专辑**确实没有**封面」⇒ 也会回写落盘 ⇒ **不再**拉第二次。
   * ⚠️ **不发请求**：这里只管状态与落盘；请求由页面编排（store 不碰网络）。
   */
  setAlbumCover: (albumId: string, coverId: string | null, port?: AudiobookPort) => void
  /**
   * **临时组**（T100）：**秒搜路径**归并出来的组 —— `albumId` → 组内全部 id。
   *
   * ⚠️ **为什么不落盘**：这是**一次搜索的临时结果**（用户搜完就完了）
   *    ⇒ 落盘形状**不变** ⇒ `STATE_VERSION` **不升**（旧落盘不作废）。
   * ⚠️ **为什么需要它**：搜索结果**不在 `hits` 里**（`hits` 是扫描出来的）
   *    ⇒ 详情页按组拉全量时**认不到** ⇒ 会退化成单张专辑
   *    ⇒ 《让青春继续第一季》的**第 02 集又会丢**。
   */
  extraGroups: Record<string, string[]>
  /**
   * 登记一个组（**秒搜路径**用）：组内**任何一张**专辑都能查到整组。
   *
   * @param albumIds 组内全部专辑 id（主专辑排第一）。
   */
  registerGroup: (albumIds: readonly string[]) => void
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
  /**
 * 封面 id（`null` = 没有封面）。
 *
 * ⚠️ **T101**：取这张专辑**第一首**曲目的封面（曲目的 `coverId` 就在数据里 ⇒ 免费）。
 *
 * ⚠️ **T102**：这个是「**曲目**封面」⇒ **不用于显示**（保留只为落盘形状不变）。
 */
  coverId: string | null
  /**
   * **专辑自己的**封面 id（T102）。
   *
   * ⚠️ **三态**：`undefined` = 未知（要补拉）/ `null` = 确认没有 / 字符串 = 有。
   */
  albumCoverId: string | null | undefined
}

/** 新建一个聚合器。 */
function newAggregator(
  albumId: string,
  albumTitle: string,
  coverId: string | null,
  albumCoverId: string | null | undefined = null,
): Aggregator {
  return {
    albumId,
    albumTitle,
    trackCount: 0,
    totalDurationSec: 0,
    maxDurationSec: 0,
    episodeStats: { ruleCounts: {}, titleCount: 0 },
    dirs: [],
    coverId,
    albumCoverId,
  }
}

/**
 * 把一页曲目并进聚合器（**只并目录关键字命中的那些**）。
 *
 * ⚠️ **v3 的要害**：过滤发生在**这里**（扫描时）⇒ 列表里**只有**「那个文件夹」
 *    下面的作品；⚠ 也因此**换关键字必须重扫**（旧的聚合是按旧关键字算的）。
 */
function accumulate(
  target: Map<string, Aggregator>,
  tracks: readonly ScanTrack[],
  keyword: string,
): void {
  for (const t of tracks) {
    if (!t.albumId) continue
    // ⚠ 目录关键字**只用来定位**（「那个文件夹」），不用来判断「是不是有声」。
    if (!pathMatchesKeyword(t.path, keyword)) continue
    let agg = target.get(t.albumId)
    if (!agg) {
      // ⚠️ **T102**：专辑封面（**专辑自己的**那个 id）⇒ 与专辑页 / 秒搜**逐字一致**。
      // ⚠️ **来源唯一**：同一张专辑的**所有**曲目内嵌的是**同一个专辑对象**
      //    ⇒ 专辑封面**每张专辑只有一个值** ⇒ 建聚合器时取**第一条**就够了
      //    （写成「每条曲目再补一次」会多出一条**等价**的路径 ⇒ 变异自证会分不清）。
      agg = newAggregator(t.albumId, t.albumTitle, t.coverId || null, t.albumCoverId || null)
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
 * **归并组**（T99）：服务端把**一部作品**拆成**几张同名专辑**时，合起来算一部。
 *
 * ⚠️ 实测（2026-11-16，本机 + 该账号）：《让青春继续第一季》被拆成 **31 集 + 1 集**
 *    （第 02 集单独一张）⇒ 不归并的话用户**少看到一集**，列表还出现**两条同名**。
 */
interface MergedGroup {
  /** 主专辑 id（**集数最多**的那个）—— 下钻用它。 */
  albumId: string
  /** 组内全部专辑 id（主专辑第一）。 */
  albumIds: string[]
  /** 专辑名（组内同名）。 */
  albumTitle: string
  /** 曲目数（组合计）。 */
  trackCount: number
  /** 总时长（秒，组合计）。 */
  totalDurationSec: number
  /** 最长单集（秒，组内最长）。 */
  maxDurationSec: number
  /** 标题形态统计（**全量标题**，组合计）。 */
  episodeStats: EpisodeStats
  /** 作品目录集合（组内并集）。 */
  dirs: string[]
  /** 封面 id（取**主专辑**的；`null` = 没有封面）。 */
  coverId: string | null
  /**
   * **专辑自己的**封面 id（T102）：取**主专辑**的（三态：`undefined` = 未知）。
   *
   * ⚠️ **为什么取主专辑**：归并组代表「一部作品」⇒ 它的封面就是**主专辑**那张
   *    ⇒ 与秒搜路径（同样取主专辑）**一致**。
   */
  albumCoverId: string | null | undefined
}

/**
 * 归并键：**专辑名 + 唯一作品目录**。
 *
 * ⚠️ **作品目录不唯一 ⇒ 不归并**（信息不足 ⇒ 宁可分开，也不要误合）：
 *    一张专辑可能横跨**多个作品目录**（实测存在）⇒ 那时 `dirs.length !== 1`。
 * ⚠️ **不同名不归并**（季 / 卷各算一部：《让青春继续》第一/二/三季**不该**并成一部）。
 */
function groupKeyOf(agg: Aggregator): string {
  const dir = agg.dirs.length === 1 ? (agg.dirs[0] ?? null) : null
  return workGroupKey(agg.albumTitle, dir, agg.albumId)
}

/**
 * 把**按专辑聚合**的结果归并成「一部作品一条」（T99）。
 *
 * ⚠️ **为什么归并放在「判定阶段」而不是「聚合阶段」**：
 *    聚合必须**按 `albumId`** —— 实测存在「**同一张专辑横跨多个作品目录**」⇒
 *    若拿归并键（名字 + 作品目录）当聚合键，**一张专辑会被拆成两条**（更糟）。
 *    ⇒ 聚合按 `albumId`（不动），归并放在判定阶段（合并指标 + 合成一条）。
 */
function mergeAggregators(list: readonly Aggregator[]): MergedGroup[] {
  const groups = new Map<string, Aggregator[]>()
  for (const agg of list) {
    const key = groupKeyOf(agg)
    const bucket = groups.get(key)
    if (bucket) bucket.push(agg)
    else groups.set(key, [agg])
  }

  const out: MergedGroup[] = []
  for (const bucket of groups.values()) {
    // 主专辑 = 集数最多的那个（并列时按 id 定序 ⇒ 结果稳定）。
    const members = [...bucket].sort(
      (a, b) => b.trackCount - a.trackCount || a.albumId.localeCompare(b.albumId),
    )
    const main = members[0]
    if (!main) continue

    const episodeStats: EpisodeStats = { ruleCounts: {}, titleCount: 0 }
    const dirs = new Set<string>()
    let trackCount = 0
    let totalDurationSec = 0
    let maxDurationSec = 0
    for (const agg of members) {
      trackCount += agg.trackCount
      totalDurationSec += agg.totalDurationSec
      if (agg.maxDurationSec > maxDurationSec) maxDurationSec = agg.maxDurationSec
      episodeStats.titleCount += agg.episodeStats.titleCount
      for (const [rule, count] of Object.entries(agg.episodeStats.ruleCounts)) {
        episodeStats.ruleCounts[rule] = (episodeStats.ruleCounts[rule] ?? 0) + count
      }
      for (const dir of agg.dirs) dirs.add(dir)
    }

    out.push({
      albumId: main.albumId,
      albumIds: members.map((m) => m.albumId),
      albumTitle: main.albumTitle,
      trackCount,
      totalDurationSec,
      maxDurationSec,
      episodeStats,
      dirs: [...dirs],
      // ⚠️ **T101**：封面取**主专辑**的（组内其它成员封面不同时，主专辑那张最贴切）。
      coverId: main.coverId,
      // ⚠️ **T102**：**专辑自己的**封面（也取主专辑）⇒ 与秒搜路径**逐字一致**。
      albumCoverId: main.albumCoverId,
    })
  }
  return out
}

/**
 * 把聚合器判定成命中列表（**纯计算**，不发请求）。
 *
 * ⚠️ **v3：打分不再是门槛** —— 「是不是有声」由**用户指位置**决定
 *    （作品名秒搜 / 目录关键字 / 手动改判）⇒ 这里**只把命中的目录下的作品列出来**，
 *    判定分与依据**降级为参考信息**（界面照旧显示，用户自己看得懂）。
 *
 * ⚠️ **T99**：这里先按**作品目录**把同名专辑**归并**（一部作品一条），
 *    再按**合并后**的指标打分 ⇒ 判定分也是合并后的。
 *
 * ⚠️ **上限**：命中太多（关键字写得太宽）⇒ 只保留**判定分最高**的前
 *    {@link MAX_AUDIOBOOK_ITEMS} 部，并**如实告诉用户**（不能静默截断）。
 */
function judgeAggregator(aggregator: Map<string, Aggregator>): AudiobookHit[] {
  const hits: AudiobookHit[] = []
  for (const group of mergeAggregators(selectCandidates(aggregator))) {
    const verdict = judgeAlbum([], {
      trackCount: group.trackCount,
      avgDurationSec:
        group.trackCount > 0 ? Math.round(group.totalDurationSec / group.trackCount) : 0,
      maxDurationSec: group.maxDurationSec,
      workDirUnique: group.dirs.length === 1,
      episodeStats: group.episodeStats,
    })
    hits.push(
      verdictToHit(
        verdict,
        group.albumId,
        group.albumTitle,
        group.albumIds,
        group.coverId,
        group.albumCoverId,
      ),
    )
  }
  hits.sort(
    (a, b) => b.score - a.score || b.trackCount - a.trackCount || a.albumTitle.localeCompare(b.albumTitle),
  )
  return hits.slice(0, MAX_AUDIOBOOK_ITEMS)
}

/** 判定结果 ⇒ 落盘/界面用的形状。 */
function verdictToHit(
  verdict: AudiobookVerdict,
  albumId: string,
  albumTitle: string,
  albumIds?: readonly string[],
  coverId: string | null = null,
  albumCoverId: string | null | undefined = undefined,
): AudiobookHit {
  return {
    albumId,
    albumIds: albumIds && albumIds.length > 0 ? [...albumIds] : [albumId],
    albumTitle,
    score: verdict.score,
    reasons: verdict.reasons,
    trackCount: verdict.trackCount,
    avgDurationSec: verdict.avgDurationSec,
    maxDurationSec: verdict.maxDurationSec,
    episodeRule: verdict.episodeRule,
    coverId,
    // ⚠️ **T102**：专辑自己的封面（**显示就靠它**；`undefined` = 未知 ⇒ 要补拉）。
    albumCoverId,
  }
}

/**
 * 某个专辑**所在的归并组**（`null` = 不在任何组里 —— 例如用户手动指定的）。
 *
 * ⚠️ 组里**任何一张**专辑都指向同一组 ⇒ 改判 / 下钻 / 拉全量都按组来。
 */
function groupOf(hits: readonly AudiobookHit[], albumId: string): AudiobookHit | null {
  return hits.find((h) => h.albumIds.includes(albumId)) ?? null
}

/**
 * 选出要保留的聚合器（**有上限**）。
 *
 * ⚠ **内存与落盘必须用同一个选择** ⇒ 重进页面看到的列表 = 扫描完时看到的列表。
 * ⚠ 排序用**集数降序**（集数多的更像「一整部作品」）⇒ 超上限时被截掉的是
 *   **集数最少**的那些。
 */
function selectCandidates(aggregator: Map<string, Aggregator>): Aggregator[] {
  return [...aggregator.values()]
    .sort((a, b) => b.trackCount - a.trackCount || a.albumTitle.localeCompare(b.albumTitle))
    .slice(0, MAX_AUDIOBOOK_ITEMS)
}

/** 把选中的聚合器压成落盘表。 */
function snapshotCandidates(aggregator: Map<string, Aggregator>): Record<string, CandidateSnapshot> {
  const candidates: Record<string, CandidateSnapshot> = {}
  for (const agg of selectCandidates(aggregator)) {
    candidates[agg.albumId] = toSnapshot(agg)
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
    keyword: '',
    scannedAt: 0,
    // ⚠️ **T120**：默认走**全库扫描**（没有目录路径）。
    folderPaths: [],
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
    // ⚠️ **T101**：封面 id 也落盘 ⇒ 下次进来**不用**再补拉。
    coverId: agg.coverId,
    // ⚠️ **T102**：**专辑自己的**封面也落盘 ⇒ 下次进来**不用**再补拉。
    // ⚠️ `undefined` ⇒ `JSON.stringify` 会**丢掉这个 key** ⇒ 读回来还是「未知」⇒ 会再补拉
    //    （这正是我们要的：**没拿到过**就得再试一次）。
    albumCoverId: agg.albumCoverId,
  }
}

/** 把落盘的候选还原成聚合器。 */
function fromSnapshot(snap: CandidateSnapshot): Aggregator {
  const ruleCounts = snap.episodeStats?.ruleCounts
  // ⚠️ **T102**：**专辑封面是三态** ⇒ 靠「字段在不在」区分「未知」与「确认没有」：
  //   - 字段**缺省** ⇒ **未知**（T101 的旧落盘）⇒ 进页时要补拉一次 `/album/detail`；
  //   - 字段是 `null` ⇒ **确认没有封面** ⇒ 不用再拉；
  //   - 字段是字符串 ⇒ 有封面。
  const hasAlbumCover = Object.prototype.hasOwnProperty.call(snap, 'albumCoverId')
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
    // ⚠️ **T101**：旧落盘**没有**这个字段 ⇒ 读成 `null`（没封面）⇒ 进页时按需补拉。
    coverId: typeof snap.coverId === 'string' && snap.coverId.length > 0 ? snap.coverId : null,
    albumCoverId: hasAlbumCover
      ? typeof snap.albumCoverId === 'string' && snap.albumCoverId.length > 0
        ? snap.albumCoverId
        : null
      : undefined,
  }
}

/** `src/state/audiobookStore.ts` 的 store。 */
export const useAudiobookStore = create<AudiobookStore>((set, get) => ({
  hits: [],
  overrides: {},
  keyword: DEFAULT_FOLDER_KEYWORD,
  scanning: false,
  progress: null,
  error: null,
  notice: null,
  scannedAt: null,
  extraGroups: {},

  scan: async (options) => {
    const port = options?.port ?? localStorageAudiobookPort
    const saved = port.load() ?? emptyPersisted()
    const full = options?.full === true
    const savedKeyword = String(saved.keyword ?? '').trim()
    const keyword = String(options?.keyword ?? savedKeyword).trim() || DEFAULT_FOLDER_KEYWORD
    // ⚠ **换关键字 ⇒ 断点作废**：过滤条件变了 ⇒ 断点里的聚合是按**旧关键字**算的
    //    ⇒ 接着扫会把两个口径混在一起 ⇒ 这一轮从头来。
    const keywordChanged = savedKeyword !== '' && savedKeyword !== keyword

    // ⚠️ **只有真存在「未扫完的断点」才恢复旧聚合**：
    //    `nextPage === 0` ⇒ 没有断点（要么没扫过，要么上轮**扫完了**）
    //    ⇒ 这一轮从头扫 ⇒ 旧聚合**必须丢掉**，否则集数会**翻倍**。
    const hasBreakpoint = !full && !keywordChanged && saved.nextPage > 0
    const startPage = hasBreakpoint ? saved.nextPage : 1
    const aggregator = new Map<string, Aggregator>()
    // ⚠️ **T120**：**聚合器先不填** —— 「按目录浏览」那一路是**整份重来**的
    //    ⇒ 只有**回落**到全库扫描时，才把旧断点的聚合灌进来
    //    （两种口径的聚合混在一起 ⇒ 集数翻倍）。
    const baseScanned = hasBreakpoint ? saved.scannedCount : 0

    set({
      scanning: true,
      error: null,
      notice: null,
      keyword,
      overrides: { ...saved.overrides },
      progress: {
        page: startPage - 1,
        pages: 0,
        scanned: baseScanned,
        total: saved.total,
        mode: 'library',
        folderPath: null,
      },
    })

    let scannedCount = baseScanned
    let nextPage = startPage
    /** 落盘失败过没有（配额满 / 隐私模式）⇒ 要**如实告诉用户**。 */
    let persistFailed = false
    /** ⚠️ **T120**：目录浏览的结果；`null` = 走了**全库扫描**。 */
    let folderResult: FolderScanResult | null = null
    /** ⚠️ **T120**：回落提示（如实告诉用户「服务端不支持目录浏览」）。 */
    let notice: string | null = null

    try {
      // ---- ① **T120**：先试「按服务端目录浏览」------------------------------
      //
      // ⚠️ **为什么先试它**：服务端**已支持**按目录浏览（2026-11-19 真机实测）
      //    ⇒ 不用再把 17.3 万首曲目全扫一遍、再按 path 关键字挑
      //    ⇒ 「有声」页从「87 页 / 约 1 分钟」变成「几十个目录 / 几秒」。
      try {
        folderResult = await scanFolderTracks({
          keyword,
          onProgress: (p) => {
            set({
              progress: {
                page: p.dirs,
                pages: 0,
                scanned: p.tracks,
                total: p.total,
                mode: 'folder',
                folderPath: p.folders[0]?.path ?? null,
              },
            })
          },
        })
      } catch (err) {
        // ⚠️ **回落**：老服务端（没更新飞牛）**没有** `/folder-view/*`
        //    ⇒ 响应 body 是 `null` ⇒ `apiCall` 抛错 ⇒ 这里改走**旧的全库扫描**
        //    ⇒ 结果**等价**（同样的 hits），只是慢。
        notice = '服务端不支持按目录浏览（已改用全库扫描，较慢）。'
      }

      if (folderResult) {
        // ---- 目录浏览那一路：判定 ＋ 落盘 ----------------------------------
        //
        // ⚠️ **判定 / 归并 / 卡片 / 下钻 / 改判 —— 一行都没改**：
        //    目录浏览拿回来的就是 `ScanTrack[]` ⇒ 喂给**同一个** `accumulate()`。
        accumulate(aggregator, folderResult.tracks, keyword)
        scannedCount = folderResult.tracks.length

        const hits = judgeAggregator(aggregator)
        const candidates = snapshotCandidates(aggregator)
        const folderPaths = folderResult.folders.map((f) => f.path)
        const persisted: AudiobookPersisted = {
          version: STATE_VERSION,
          // ⚠️ 目录浏览**没有分页** ⇒ **没有断点** ⇒ 下次要重扫就整份重来。
          nextPage: 0,
          scannedCount,
          total: folderResult.total,
          candidates,
          // ⚠️ **T118**：**活值**（扫描期间用户做的改判不能被覆盖）。
          overrides: { ...get().overrides },
          keyword,
          scannedAt: Date.now(),
          // ⚠️ **T120**：**可选字段** ⇒ 旧落盘照样读得出 ⇒ `STATE_VERSION` **不升**。
          folderPaths,
        }
        const savedOk = port.save(persisted)
        if (!savedOk) persistFailed = true

        const tooMany = aggregator.size > MAX_AUDIOBOOK_ITEMS
        const problems: string[] = []
        if (persistFailed) {
          problems.push('扫描完成了，但**结果没存到本机**（本地存储可能已满）⇒ 下次进入不会自动恢复。')
        }
        if (tooMany) {
          problems.push(
            `这个目录下面命中了 ${aggregator.size} 部作品，超过 ${MAX_AUDIOBOOK_ITEMS} 部 ⇒ 只保留集数最多的 ${MAX_AUDIOBOOK_ITEMS} 部；把目录名写得更具体就能看全。`,
          )
        }
        // ⚠️ **目录没找到** ⇒ 如实告诉用户；⚠️ **不回落**
        //    （回落也找不到那个目录，只是白扫一遍全库）。
        if (folderResult.folders.length === 0) {
          problems.push(
            `服务端的目录里**没找到**叫「${keyword}」的文件夹 ⇒ 请确认它在音乐服务的曲库里（或换个目录名再试）。`,
          )
        }

        set({
          hits,
          keyword,
          overrides: persisted.overrides,
          scanning: false,
          error: problems.length > 0 ? problems.join(' ') : null,
          notice,
          scannedAt: persisted.scannedAt,
          progress: {
            page: folderResult.dirs,
            pages: 0,
            scanned: scannedCount,
            total: folderResult.total,
            mode: 'folder',
            folderPath: folderPaths[0] ?? null,
          },
        })
        return
      }

      // ---- ② 回落：全库扫描（**一字不改**）----------------------------------
      // ⚠️ **断点续跑**在这里才把旧聚合灌进来（目录浏览那一路是整份重来的）。
      if (hasBreakpoint) {
        for (const snap of Object.values(saved.candidates)) {
          const agg = fromSnapshot(snap)
          aggregator.set(agg.albumId, agg)
        }
      }
      // ⚠️ 服务端**没有**「跳过前 N 页」的参数，但 `page` 本身就是偏移
      //    ⇒ 直接从断点页开始（`startPage`）⇒ 续跑不会重扫前面的页。
      const result = await scanLibraryTracks({
        pageSize: 2000,
        maxPages: 2000,
        startPage,
        onPage: (tracks, progress) => {
          accumulate(aggregator, tracks, keyword)
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
            // ⚠️ **T118**：**不再写「扫描启动时的那份快照」** ⇒ 扫描期间用户做的
            //    **手工改判**（详情页「这不是有声」/「这是有声读物」、秒搜点开）
            //    **不会被这一页覆盖**。
            //    ⇒ 取内存里的**活值**（`get().overrides`）：`setOverride` 写完盘立刻同步它
            //    ⇒ 它永远是**完整且最新**的改判表。
            //    ⚠ **只能整体替换、不能 merge**（`{...saved.overrides, ...get().overrides}`）
            //    ⇒ 那样会把**「撤销改判」复活**（启动快照里有、活值里已删掉的键会回来）。
            overrides: { ...get().overrides },
            keyword,
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
        // ⚠️ **T118**：同上 ⇒ **扫完**这一次落盘也用**活值**（扫描期间改的判要留下来）。
        overrides: { ...get().overrides },
        keyword,
        scannedAt: Date.now(),
        // ⚠️ **T120**：这一路是**全库扫描** ⇒ 没有目录路径（空数组）。
        folderPaths: [],
      }
      const savedOk = port.save(persisted)
      if (!savedOk) persistFailed = true

      // ⚠ 命中太多（关键字写得太宽）⇒ **如实告诉用户**，不装作全都在。
      const tooMany = aggregator.size > MAX_AUDIOBOOK_ITEMS
      const problems: string[] = []
      if (persistFailed) {
        problems.push('扫描完成了，但**结果没存到本机**（本地存储可能已满）⇒ 下次进入不会自动恢复。')
      }
      if (tooMany) {
        problems.push(
          `这个目录下面命中了 ${aggregator.size} 部作品，超过 ${MAX_AUDIOBOOK_ITEMS} 部 ⇒ 只保留集数最多的 ${MAX_AUDIOBOOK_ITEMS} 部；把目录名写得更具体就能看全。`,
        )
      }

      set({
        hits,
        keyword,
        // ⚠️ **T118**：`persisted.overrides` 现在就是**活值**
        //    ⇒ 扫完**不会**把用户扫描期间做的改判从**内存**里抹掉
        //    （修复前这里回退到启动快照 ⇒ 界面上刚点的「这不是有声」当场消失）。
        overrides: persisted.overrides,
        scanning: false,
        error: problems.length > 0 ? problems.join(' ') : null,
        // ⚠️ **T120**：回落提示放在**提示**里（**不是** `error`）
        //    ⇒ 「加载失败：服务端不支持目录浏览」是**指错方向**的误导。
        notice,
        scannedAt: persisted.scannedAt,
        progress: {
          page: nextPage,
          pages: result.pages,
          scanned: scannedCount,
          total: result.total,
          mode: 'library',
          folderPath: null,
        },
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
      set({
        hits: [],
        overrides: {},
        keyword: DEFAULT_FOLDER_KEYWORD,
        scannedAt: null,
        progress: null,
        error: null,
        notice: null,
      })
      return
    }
    const aggregator = new Map<string, Aggregator>()
    for (const snap of Object.values(saved.candidates)) {
      const agg = fromSnapshot(snap)
      aggregator.set(agg.albumId, agg)
    }
    // ⚠️ **T120**：上次定位到的目录（**可选字段** ⇒ 旧落盘没有 ⇒ 空数组）。
    const folderPaths = Array.isArray(saved.folderPaths) ? saved.folderPaths.filter(Boolean) : []
    set({
      hits: judgeAggregator(aggregator),
      overrides: { ...saved.overrides },
      keyword: String(saved.keyword ?? '').trim() || DEFAULT_FOLDER_KEYWORD,
      scannedAt: saved.scannedAt > 0 ? saved.scannedAt : null,
      progress: {
        page: saved.nextPage,
        pages: saved.total > 0 ? Math.max(1, Math.ceil(saved.total / 2000)) : 0,
        scanned: saved.scannedCount,
        total: saved.total,
        // ⚠️ **T120**：有目录路径 ⇒ 上一轮走的是**目录浏览**；没有 ⇒ 全库扫描。
        mode: folderPaths.length > 0 ? 'folder' : 'library',
        folderPath: folderPaths[0] ?? null,
      },
      error: null,
      notice: null,
    })
  },

  setOverride: (albumId, value, port, albumTitle) => {
    const p = port ?? localStorageAudiobookPort
    const saved = p.load() ?? emptyPersisted()
    const overrides = { ...saved.overrides }
    // ⚠️ **T99：组级改判** —— 归并组里改**任何一张** ⇒ **整组**生效
    //    （override 记在**主专辑**名下 ⇒ 组内任何一张查到的是同一个结论）。
    const group = groupOf(get().hits, albumId)
    const key = group?.albumId ?? albumId
    // 先清掉组内其它成员留下的 override ⇒ 避免成员之间互相打架。
    if (group) {
      for (const member of group.albumIds) {
        if (member !== key) delete overrides[member]
      }
    }
    if (value === null) delete overrides[key]
    else {
      overrides[key] = {
        value,
        albumTitle: albumTitle ?? overrides[key]?.albumTitle ?? group?.albumTitle ?? '',
      }
    }
    p.save({ ...saved, overrides })
    set({ overrides })
  },

  isAudiobook: (albumId) => {
    // ⚠️ T99：查的是**整组**（组里任何一张专辑的结论一致）。
    const group = groupOf(get().hits, albumId)
    const key = group?.albumId ?? albumId
    const override = get().overrides[key] ?? get().overrides[albumId]
    if (override?.value === 'audiobook') return true
    if (override?.value === 'not-audiobook') return false
    return group !== null
  },

  hitOf: (albumId) => {
    // ⚠️ T99：命中的是**整组**（下钻 / 拉全量都按组来）。
    const group = groupOf(get().hits, albumId)
    const key = group?.albumId ?? albumId
    const override = get().overrides[key] ?? get().overrides[albumId]
    if (override?.value === 'not-audiobook') return null
    if (override?.value === 'audiobook' && !group) {
      // ⚠️ 用户**手动**判为有声，但自动判定没命中 ⇒ 造一条「用户判定」的记录。
      return {
        albumId,
        albumIds: [albumId],
        albumTitle: override.albumTitle,
        score: 0,
        reasons: ['user'],
        trackCount: 0,
        avgDurationSec: 0,
        maxDurationSec: 0,
        episodeRule: null,
        // ⚠️ T101：手动判定的记录**没有扫描来的封面** ⇒ 先留空，后面由页面补拉。
        coverId: null,
        // ⚠️ **T102**：专辑封面**未知** ⇒ 页面会补拉一次 `/album/detail`。
        albumCoverId: undefined,
      }
    }
    return group
  },

  /**
   * **补上封面 id**（T101）：改命中 + **回写落盘**。
   *
   * ⚠️ 为什么**回写落盘**：封面是**每个专辑一份** ⇒ 不落盘的话，
   *    每次进页面都要重新拉一次 `/album/detail`（旧落盘的用户尤其明显）。
   */
  setCover: (albumId, coverId, port) => {
    const p = port ?? localStorageAudiobookPort
    const saved = p.load() ?? emptyPersisted()
    const hits = get().hits.map((hit) =>
      hit.albumId === albumId ? { ...hit, coverId } : hit,
    )
    const snap = saved.candidates[albumId]
    const candidates = snap
      ? { ...saved.candidates, [albumId]: { ...snap, coverId } }
      : saved.candidates
    p.save({ ...saved, candidates })
    set({ hits })
  },

  /**
   * **补上「专辑自己的」封面 id**（T102）：改命中 + **回写落盘**。
   *
   * ⚠️ **为什么单独一个动作**：T101 的 `setCover` 写的是 `coverId`（**曲目**封面）
   *    ⇒ 那个字段**不用于显示** ⇒ 显示统一走 `albumCoverId`。
   * ⚠️ **回写落盘**：专辑封面是**每张专辑一份** ⇒ 不落盘的话每次进页面都要重拉一次。
   */
  setAlbumCover: (albumId, coverId, port) => {
    const p = port ?? localStorageAudiobookPort
    const saved = p.load() ?? emptyPersisted()
    const hits = get().hits.map((hit) =>
      hit.albumId === albumId ? { ...hit, albumCoverId: coverId } : hit,
    )
    const snap = saved.candidates[albumId]
    const candidates = snap
      ? { ...saved.candidates, [albumId]: { ...snap, albumCoverId: coverId } }
      : saved.candidates
    p.save({ ...saved, candidates })
    set({ hits })
  },

  registerGroup: (albumIds) => {
    // ⚠️ T100：**临时组**（秒搜路径）⇒ 组内每张专辑都指向同一组。
    const ids = [...new Set(albumIds)].filter((id) => id.length > 0)
    if (ids.length === 0) return
    const extra = { ...get().extraGroups }
    for (const id of ids) extra[id] = ids
    set({ extraGroups: extra })
  },
}))
