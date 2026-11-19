// 「发现」页的跨进程共享类型：音乐榜单 + 匹配结果。
//
// ⚠️ 本文件**只能是纯类型**：不得有运行时代码，不得 import Electron / Node 内置模块 / DOM 类型。
//    （渲染进程在 `contextIsolation: true` 的沙箱里跑，混进运行时代码等于把主进程逻辑打进 bundle。）
//
// 背景（T96）：榜单条目来自**外部公开榜源**（QQ 音乐），只有「歌名 / 歌手 / 专辑 / 时长」，
// **没有** NAS 的 guid ⇒ 必须**匹配回本地曲库**才能播。
//
// ⚠️ **曲库 = 当前登录用户自己的 NAS 曲库**，规模与内容**因人而异**
//    （开发机实测 17.3 万首，那只是**那台机、那个账号**的事实，不是产品规格）
//    ⇒ **绝不拉全量**、**不对规模做任何假设**；
//    匹配只针对「榜单里出现的那几个歌手」定向查询（`/track/artist-detail/list`）。

import type { Song } from './types'

/** 榜单里的一条（**榜源原始信息**，还没跟本地曲库对过）。 */
export interface ChartEntry {
  /** 排名（1 起；榜源不给时按返回顺序补）。 */
  rank: number
  /** 歌名。 */
  title: string
  /** 歌手（多歌手用 `' / '` 连接，**展示用**）。 */
  artist: string
  /** 专辑名；榜源不给时为空串 `''`。 */
  album: string
  /** 时长（**秒**）；榜源不给时为 `null`。 */
  duration: number | null
}

/** 一个榜单。 */
export interface ChartBoard {
  /** 榜单 id（如 `'qq-26'`）。 */
  id: string
  /** 榜单名（如 `'巅峰榜·热歌'`；取自榜源自述的 `topinfo.ListName`）。 */
  name: string
  /** 数据源 id（如 `'qq'`）。 */
  source: string
  /** 条目。 */
  entries: ChartEntry[]
}

/** 榜单拉取结果（主进程 → 渲染进程）。 */
export interface ChartResult {
  /** `ok` = 至少有一个榜单拿到了；`error` = 榜源失败。 */
  status: 'ok' | 'error'
  /** 失败原因（可读中文，**不含凭证**）；`status === 'ok'` 时可缺省。 */
  message?: string
  /** 榜单列表。 */
  boards: ChartBoard[]
}

/** 榜单条目 + **与本地曲库对过之后**的结果。 */
export interface MatchedChartEntry extends ChartEntry {
  /** 是否在本地曲库里。 */
  inLibrary: boolean
  /** 命中时的本地歌曲（**完整对象**：能直接播、也能显示封面）；未命中为 `null`。 */
  song: Song | null
  /**
   * 是否**还没匹配完**（T124：榜单**先出**、命中**异步补**）。
   *
   * ⚠️ **缺省 = 已匹配完**（既有行为一字未变）。
   * ⚠️ `pending === true` 时，`inLibrary` / `song` **都还没有结论**
   *    ⇒ 界面必须显示「**匹配中…**」，**不许**显示「不在曲库」
   *    （那是**结论**，不是「还没查」）。
   */
  pending?: boolean
}

/** 一个已匹配的榜单。 */
export interface MatchedChartBoard {
  /** 榜单 id。 */
  id: string
  /** 榜单名。 */
  name: string
  /** 数据源 id。 */
  source: string
  /** 条目。 */
  entries: MatchedChartEntry[]
  /** **命中**的条数（页面上显示「榜上 N 首，你的曲库里有 M 首」）。 */
  matched: number
  /** 条目总数。 */
  total: number
}
