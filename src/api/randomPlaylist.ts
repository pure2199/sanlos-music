// 「随机 20 首」——从**你自己的** NAS 曲库随机挑一批歌，组一个临时歌单（T97）。
//
// ---------------------------------------------------------------------------
// 为什么要有这个模块
// ---------------------------------------------------------------------------
// 服务端**没有随机排序**（实测 2026-11-16，真实 NAS）：
// `/track/list` 的 `sort` **只认** `createdAt`（`,asc` / `,desc`）与 `title`（`,asc`）；
// `random` / `rand` / `shuffle` / `album` / `duration` / `updatedAt,desc`
// **一律无效**（响应回显的仍是 `createdAt,desc`）。
// ⇒ **随机只能客户端做**。
//
// ---------------------------------------------------------------------------
// ⚠️ 服务端实测事实（2026-11-16，本机 + 该账号）——**代码必须按这些事实写**
// ---------------------------------------------------------------------------
// 1. **`page` 生效，但页码上限 = 2000**：超过就**静默回绕到第 1 页**
//    （实测 `size=10` / `size=50` 都是 2000 好 / 2001 坏；`size=200` 时 869 之后是**空页**）。
//    ⇒ **页码必须 clamp 到 ≤ 2000**，否则会抽到回绕页 ⇒ 抽出来的全是同一批。
// 2. **`size` 生效**，服务端上限 **2000**。
//    ⇒ 用 `size=200` 时，总页数 = `ceil(total/200)`；本机 17.3 万首 = 869 页 < 2000
//    ⇒ **全库每一页都翻得到** ⇒ 抽样能覆盖整个曲库。
// 3. 默认排序 `createdAt,desc`（最新入库在前）⇒ 相邻页的曲目导入时间挨着
//    ⇒ **只取一页的连续 20 首会很同质** ⇒ 必须**分散到多个随机页**。
//
// ⚠️ **曲库是「当前登录用户自己的」**：规模与内容**因人而异** ⇒ 本模块
//    **不假设曲库有多大**：`total`、页数一律**运行时算**。

import type { Song } from '../../shared/types'
import { libraryApi } from './library'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 服务端**页码上限**（实测 2026-11-16）。
 *
 * ⚠️ 超过这个页码，服务端**静默回绕到第 1 页**（不是空页、也不报错）
 * ⇒ 抽样页码**必须 clamp 到这个值**。
 */
export const SERVER_MAX_PAGE = 2000

/** 抽样时**每页取多少首**（默认 200）。 */
export const RANDOM_SAMPLE_PAGE_SIZE = 200

/** 随机歌单的默认条数。 */
export const RANDOM_PLAYLIST_SIZE = 20

/** 一次抽样**最多取几页**（多样性 ↔ 请求数的折中）。 */
export const RANDOM_SAMPLE_MAX_PAGES = 4

// ---------------------------------------------------------------------------
// 依赖（可注入 ⇒ 单测不必打网络）
// ---------------------------------------------------------------------------

/** 抽样要用的曲库查询。 */
export interface RandomSampleDeps {
  /** 曲库总曲数。 */
  total: () => Promise<number>
  /** 取第 `page` 页（每页 `size` 首）。 */
  page: (page: number, size: number) => Promise<Song[]>
}

/** 抽样参数（全部可注入 ⇒ 单测可控）。 */
export interface RandomSampleOptions {
  /** 要几首（缺省 {@link RANDOM_PLAYLIST_SIZE}）。 */
  count?: number
  /** 每页取多少首（缺省 {@link RANDOM_SAMPLE_PAGE_SIZE}）。 */
  pageSize?: number
  /** 随机源（缺省 `Math.random`；单测注入固定序列 ⇒ 结果可复现）。 */
  random?: () => number
}

/** 生产用的抽样依赖（走渲染层既有的 `fnm://srv` 通道 ⇒ 自动带当前账号的凭证）。 */
export const defaultRandomSampleDeps: RandomSampleDeps = {
  // ⚠️ **只取 1 条**就能拿到 `total`（`/track/list` 的信封里带 `total`）。
  total: async () => (await libraryApi.songs(1, 1)).total,
  page: async (page, size) => (await libraryApi.songs(page, size)).list,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * Fisher–Yates 洗牌（**不用**有偏的 `sort(() => random() - 0.5)`）。
 *
 * @param items 原数组（**不改**原数组）。
 * @param random 随机源。
 * @returns 洗好的新数组。
 */
export function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    // ⚠️ `random()` 理论上可能返回 1 ⇒ 这里夹一下，避免越界。
    const span = i + 1
    const j = Math.min(span - 1, Math.floor(random() * span))
    const tmp = result[i] as T
    result[i] = result[j] as T
    result[j] = tmp
  }
  return result
}

/**
 * 从 `[1, usablePages]` 里挑出**互不相同**的 `count` 个页码。
 *
 * ⚠️ **页码上限必须由调用方 clamp 好**（见 {@link SERVER_MAX_PAGE}）：
 *    挑到超过上限的页 ⇒ 服务端回绕 ⇒ 抽出来全是同一批。
 *
 * @param usablePages 可用的总页数（**已 clamp**）。
 * @param count 要几个页码。
 * @param random 随机源。
 * @returns 升序无关的随机页码列表（长度 = `min(count, usablePages)`）。
 */
export function pickDistinctPages(
  usablePages: number,
  count: number,
  random: () => number,
): number[] {
  const pool: number[] = []
  for (let page = 1; page <= usablePages; page += 1) pool.push(page)
  const take = Math.min(Math.max(0, Math.floor(count)), pool.length)
  // 部分 Fisher–Yates：只洗前 take 个。
  for (let i = 0; i < take; i += 1) {
    const span = pool.length - i
    const j = i + Math.min(span - 1, Math.floor(random() * span))
    const tmp = pool[i] as number
    pool[i] = pool[j] as number
    pool[j] = tmp
  }
  return pool.slice(0, take)
}

// ---------------------------------------------------------------------------
// 抽样
// ---------------------------------------------------------------------------

/**
 * 从曲库里**随机**挑 `count` 首歌。
 *
 * 步骤（详见规格 §三）：
 * 1. 取 `total`；
 * 2. 总页数 = `ceil(total / pageSize)`，**clamp 到 ≤ {@link SERVER_MAX_PAGE}**；
 * 3. 随机挑**若干个互不相同**的页；
 * 4. 每页取 `pageSize` 首，**页内**再随机挑若干首（保证分散在库的不同角落）；
 * 5. 汇总**去重** ⇒ 洗牌 ⇒ 取前 `count` 首。
 *
 * ⚠️ **库不够就如实少给**（不拿重复的凑数）；`total ≤ 0` ⇒ 返回空数组。
 *
 * @param deps 曲库查询（可注入）。
 * @param options 抽样参数（可注入）。
 * @returns 随机挑出的歌（**都在曲库里** ⇒ 都能播）。
 */
export async function sampleRandomSongs(
  deps: RandomSampleDeps,
  options: RandomSampleOptions = {},
): Promise<Song[]> {
  const count = Math.max(0, Math.floor(options.count ?? RANDOM_PLAYLIST_SIZE))
  if (count === 0) return []
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? RANDOM_SAMPLE_PAGE_SIZE))
  const random = options.random ?? Math.random

  const total = await deps.total()
  if (!Number.isFinite(total) || total <= 0) return []

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // ⚠️⚠️ **必须 clamp**：服务端页码上限是 2000，超了会**回绕到第 1 页**
  //    ⇒ 不 clamp 就会把同一页抽成 20 首（探针 ① 实测过这个坑）。
  const usablePages = Math.min(totalPages, SERVER_MAX_PAGE)

  // 要几页、每页取几首（每页最多贡献 `pageSize` 首）。
  let pagesNeeded = Math.min(usablePages, RANDOM_SAMPLE_MAX_PAGES)
  let perPage = Math.ceil(count / pagesNeeded)
  if (perPage > pageSize) {
    // 「要的比一页能给的还多」⇒ 加页（而不是每页硬塞）。
    pagesNeeded = Math.min(usablePages, Math.ceil(count / pageSize))
    perPage = Math.ceil(count / pagesNeeded)
  }

  const pages = pickDistinctPages(usablePages, pagesNeeded, random)
  const picked: Song[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    const songs = await deps.page(page, pageSize)
    // ⚠️ **页内也要随机**：一页是排序上相邻的一批（导入时间挨着）⇒ 不洗就同质。
    const shuffled = shuffle(songs, random)
    let taken = 0
    for (const song of shuffled) {
      if (taken >= perPage) break
      if (seen.has(song.id)) continue
      seen.add(song.id)
      picked.push(song)
      taken += 1
    }
  }

  return shuffle(picked, random).slice(0, count)
}
