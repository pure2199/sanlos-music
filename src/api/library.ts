// 曲库浏览接口（专辑 / 歌曲 / 歌手 / 风格）。
//
// 分页硬要求（实测修正 M6）：**所有列表型方法都接受 `page` / `size`，并把 `{ list, total }` 一起返回**，
// 供 Task 14 的增量加载 + 虚拟滚动使用。本模块**不提供任何一次性全量拉取的路径**：
// 没有 `fetchAll`，默认 `size` 也不是全库——真实 NAS 曲库 17.3 万首，拉全量会拖垮客户端。
//
// `page` / `size` 在**方法入口统一归一**（非法值回落默认、超限值截断），
// 不会把 `page=0` / `size=NaN` 这类值发到服务端。

import type { Album, Artist, Genre, Song } from '../../shared/types'
import {
  apiCall,
  DEFAULT_PAGE_SIZE,
  mapAlbum,
  mapArtist,
  mapGenre,
  mapSong,
  MAX_PAGE_SIZE,
  normalizePage,
  normalizePageNumber,
  normalizePageSize,
  unixSeconds,
} from './client'
import type { Page, RawAlbum, RawArtist, RawGenre, RawPage, RawSong } from './types'
import { workDirOf } from './audiobook'

/** 是否是普通对象（数组与 null 都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从专辑详情响应里取出专辑对象。
 *
 * ⚠️ **实测（T18-3）服务端返回的是裸专辑对象**（`data` 直接是专辑本身），
 *    不是 `{ list, total }` 列表信封。
 *
 * 这里**同时兼容两种形状**：
 * - 裸对象（实测）：直接当专辑用；
 * - 列表信封（服务端若哪天改回去）：取 `list` 的第一条。
 *
 * 兼容不是为了「防未来」，而是为了让这段代码**读起来是自洽的**：
 * 拿不准形状时，两种都能解，而不是默默返回空。
 */
function extractAlbum(data: unknown): RawAlbum | null {
  if (!isRecord(data)) return null
  const list = data['list']
  if (Array.isArray(list)) {
    const first = list[0]
    return isRecord(first) ? (first as unknown as RawAlbum) : null
  }
  return typeof data['guid'] === 'string' ? (data as unknown as RawAlbum) : null
}

/** 曲库相关接口。 */
export const libraryApi = {
  /**
   * 专辑列表（分页）。
   *
   * @param page 页码（1 起）
   * @param size 每页条数
   * @param sort 排序表达式
   *
   * ⚠️ **`sort` 的真实语义未实测**（服务端接受但排序行为待校准），客户端只做透传，
   *    真实响应校准项见联调清单 **Step J**。
   */
  async albums(page = 1, size = DEFAULT_PAGE_SIZE, sort?: string): Promise<Page<Album>> {
    const raw = normalizePage<RawAlbum>(
      await apiCall<RawPage<RawAlbum>>('/album/list', {
        query: { page: normalizePageNumber(page), size: normalizePageSize(size), sort },
      }),
    )
    return { list: raw.list.map((album) => mapAlbum(album)), total: raw.total }
  },

  /**
   * 专辑详情。
   *
   * ⚠️ **实测（T18-3 真机校准）**：这个端点的参数名与其它端点**不一样**：
   *   - 参数名是 **`guid`**（不是 `albumGUID`）——用 `albumGUID` / `albumGuid` /
   *     `albumId` / `id` 全部返回 `code=100002`（invalid arguments）；
   *   - 响应 `data` 是**专辑对象本身**，**不是** `{ list, total }` 列表信封。
   *     （对照：`/track/album-detail/list` 用的是 `albumGUID`，那个才是对的。）
   *
   * 所以这里**不能**走 `normalizePage`（它只认 `{ list, total }`，套上去会得到空列表）。
   * 查不到返回 `null`。
   */
  async album(id: string): Promise<Album | null> {
    const data = await apiCall<unknown>('/album/detail', { query: { guid: id } })
    const raw = extractAlbum(data)
    return raw ? mapAlbum(raw) : null
  },

  /** 某专辑下的歌曲（分页）。 */
  async albumSongs(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/album-detail/list', {
        query: { albumGUID: id, page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /**
   * 某张专辑的**作品目录**（`null` = 拿不到）。
   *
   * ⚠️ **为什么只要 1 个请求**：实测 `/album/list` 与 `/album/detail` **都不返 path**
   *    （2026-11-17，探针 `t100-01`）⇒ 目录信息**只挂在曲目**的 `audioSpec.path` 上
   *    ⇒ 拉该专辑的**第一首**（`size=1`）就够定位作品目录（目录取 path 的倒数第 3 段）。
   *    ⇒ 秒搜归并因此很便宜（每个候选 **1 个请求**，不拉全量曲目）。
   */
  async albumWorkDir(id: string): Promise<string | null> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/album-detail/list', {
        query: { albumGUID: id, page: 1, size: 1 },
      }),
    )
    const path = raw.list[0]?.audioSpec?.path ?? null
    return workDirOf(path)
  },

  /** 某歌手的专辑（分页）。 */
  async artistAlbums(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Album>> {
    const raw = normalizePage<RawAlbum>(
      await apiCall<RawPage<RawAlbum>>('/album/artist-detail/list', {
        query: { artistGUID: id, page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((album) => mapAlbum(album)), total: raw.total }
  },

  /** 全部歌曲（分页）。 */
  async songs(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/list', {
        query: { page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /** 某歌手的歌曲（分页）。 */
  async artistSongs(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/artist-detail/list', {
        query: { artistGUID: id, page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /**
   * 某风格的歌曲（分页）。
   *
   * @param id 风格 guid（服务端只认 `genreGUID`；风格名存在大小写重复，只能用 guid）
   *
   * 注：曾经带一个 `name` 参数，但它对服务端毫无作用（服务端只按 guid 查），
   * 留着会误导调用方以为「可以按名查询」，故删除。
   */
  async genreSongs(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/genre-detail/list', {
        query: { genreGUID: id, page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /** 歌手列表（分页）。 */
  async artists(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Artist>> {
    const raw = normalizePage<RawArtist>(
      await apiCall<RawPage<RawArtist>>('/artist/list', {
        query: { page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((artist) => mapArtist(artist)), total: raw.total }
  },

  /** 风格列表（分页）。 */
  async genres(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Genre>> {
    const raw = normalizePage<RawGenre>(
      await apiCall<RawPage<RawGenre>>('/genre/list', {
        query: { page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((genre) => mapGenre(genre)), total: raw.total }
  },
}

// ---------------------------------------------------------------------------
// 曲库流式扫描（T98「有声读物」识别用）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单开一个函数**（而不是给 `libraryApi` 加方法）：
//   ① 它**逐页回调**（不累积 17 万首到内存）⇒ 形状与常规分页接口完全不同；
//   ② 它**带增量水位**（按 `createdAt` 停）⇒ 是 T98 专用语义；
//   ③ 常规接口那句「**不提供任何一次性全量拉取的路径**」针对的是**界面消费**，
//      而这里是**后台扫描**：逐页、逐页释放，不占界面内存。
//
// 实测（2026-11-16，本机 + 该账号）：
// - `/track/list` 的 `size` 上限 **2000**、`page` 上限 **2000**；
// - 曲库共 **173,671 首** ⇒ `size=2000` 只要 **87 页**；
// - 默认排序实测就是 `createdAt,desc`（这里**显式**带上，不依赖默认值）；
// - ⭐ **并发是实打实的收益**（v3 实测，同一台机、同一条中继链路）：
//   顺序 6 页 = **7,323 ms**（1.22 s/页）⇒ 并发 8 路 6 页 = **4,944 ms**（**1.48×**）；
//   全量 87 页并发 = **52,193 ms ≈ 52 s**（顺序按 1.22 s/页推算 ≈ 106 s）。
//   ⇒ 瓶颈是**带宽**不是延迟 ⇒ 再加并发收益递减 ⇒ 取 **8 路**。
// ---------------------------------------------------------------------------

/** 扫描用的一条曲目（**只取识别 / 排序需要的字段**）。 */
export interface ScanTrack {
  /** 曲目 id。 */
  id: string
  /** 曲目标题。 */
  title: string
  /** 所属专辑 id。 */
  albumId: string
  /** 所属专辑名。 */
  albumTitle: string
  /** 时长（**秒**）。 */
  durationSec: number
  /** 曲目号（可为 `null`）。 */
  trackNo: number | null
  /** NAS 上的文件路径（可为 `null`）。 */
  path: string | null
  /** 服务端入库时间（Unix 秒；可为 `null`）。 */
  createdAt: number | null
}

/** 扫描进度。 */
export interface ScanProgress {
  /** 已扫到第几页（1 起）。 */
  page: number
  /** 总页数（按 `total` 与 `pageSize` 估算）。 */
  pages: number
  /** 已扫曲目数。 */
  scanned: number
  /** 曲库总曲目数。 */
  total: number
}

/** 扫描选项。 */
export interface ScanOptions {
  /** 每页条数（服务端上限 2000；默认取 2000 ⇒ 87 页扫完 17 万首）。 */
  pageSize?: number
  /** 最多扫多少页（护栏；默认 2000 = 服务端上限）。 */
  maxPages?: number
  /**
   * 从第几页开始扫（**断点续跑**用；默认 1）。
   *
   * ⚠️ 服务端**没有**「跳过前 N 页」的参数，但 `page` 本身就是偏移 ⇒ 直接从断点页开始即可。
   */
  startPage?: number
  /**
   * 增量水位：**只取** `createdAt` 严格大于它的曲目；`null` / 缺省 = 全量。
   *
   * ⚠️ 服务端对**同一秒**的曲目没有二级排序键 ⇒ 水位取「最小 `createdAt` − 1」
   *    会重复扫那一秒 ⇒ 调用方**必须按曲目 id 去重**。
   */
  sinceCreatedAt?: number | null
  /**
   * **并发**页数（默认 {@link DEFAULT_SCAN_CONCURRENCY} = 8）。
   *
   * ⚠️ 实测见本节顶部：并发 8 路 = **1.48×**（顺序 6 页 7,323 ms ⇒ 并发 4,944 ms）。
   * ⚠️ **批内并发、批间有序**：同一批的页**并发**取回，但**按页序**回调
   *    ⇒ 断点语义不变（断点 = 「下一个要扫的页」），中途断了最多重扫一批。
   */
  concurrency?: number
  /** 每页回调（**逐页**，页处理完这一页的数组即可释放）。 */
  onPage?: (tracks: ScanTrack[], progress: ScanProgress) => void
}

/** 扫描结果。 */
export interface ScanResult {
  /** 实际扫到的曲目数（**含**水位重复的那部分）。 */
  scanned: number
  /** 曲库总曲目数。 */
  total: number
  /** 实际扫的页数。 */
  pages: number
  /** 是否因为「到达增量水位」而提前停止。 */
  stoppedAtWatermark: boolean
}

/** 把一条原始歌曲压成扫描用的形状。 */
function toScanTrack(raw: RawSong): ScanTrack {
  const album = raw.album
  return {
    id: typeof raw.guid === 'string' ? raw.guid : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    albumId: album && typeof album.guid === 'string' ? album.guid : '',
    albumTitle: album && typeof album.name === 'string' ? album.name : '',
    durationSec: Math.round(Number(raw.duration ?? 0) / 1000),
    trackNo: typeof raw.trackNo === 'number' && Number.isFinite(raw.trackNo) ? raw.trackNo : null,
    path: typeof raw.audioSpec?.path === 'string' ? raw.audioSpec.path : null,
    createdAt: unixSeconds(raw.createdAt),
  }
}

/**
 * 扫描的默认**并发**页数。
 *
 * ⚠️ 实测（2026-11-16，本机 + 该账号）：并发 8 路 = 顺序的 **1.48×**
 *    （瓶颈是带宽 ⇒ 再加收益递减）。
 */
export const DEFAULT_SCAN_CONCURRENCY = 8

/** 取一页扫描数据（**只发一个请求**，并发由调用方编排）。 */
async function fetchScanPage(
  page: number,
  pageSize: number,
): Promise<{ list: RawSong[]; total: number }> {
  const raw = normalizePage<RawSong>(
    await apiCall<RawPage<RawSong>>('/track/list', {
      query: { page, size: pageSize, sort: 'createdAt,desc' },
    }),
  )
  return { list: raw.list, total: raw.total }
}

/**
 * 流式扫描整个曲库（**逐页回调**，不把全库留在内存里）。
 *
 * ⚠️ 这是**唯一**被允许「接近全量」读曲库的路径（T98 的识别要用）；
 *    界面上的曲库浏览仍走 `libraryApi.songs` 的分页。
 */
export async function scanLibraryTracks(options?: ScanOptions): Promise<ScanResult> {
  const pageSize = normalizePageSize(options?.pageSize ?? MAX_PAGE_SIZE)
  const maxPages = Math.max(1, Math.floor(options?.maxPages ?? 2000))
  const startPage = Math.max(1, Math.floor(options?.startPage ?? 1))
  const since = typeof options?.sinceCreatedAt === 'number' ? options.sinceCreatedAt : null
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? DEFAULT_SCAN_CONCURRENCY))

  let total = 0
  let scanned = 0
  let pages = 0
  let stoppedAtWatermark = false

  /**
   * 处理一页：回调 + 返回「**还要不要继续**」。
   *
   * ⚠️ 顺序与 v2 一致：空页 ⇒ 停；水位到底 ⇒ 停；已取满 ⇒ 停。
   */
  const handlePage = (page: number, raw: { list: RawSong[]; total: number }): boolean => {
    if (raw.total > total) total = raw.total
    const tracks = raw.list.map(toScanTrack)
    pages = page - startPage + 1
    scanned += tracks.length
    options?.onPage?.(tracks, {
      page,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      scanned,
      total,
    })
    if (tracks.length === 0) return false
    // 增量：这一页里**全部**都不新 ⇒ 后面只会更旧 ⇒ 停。
    if (since !== null && tracks.every((t) => t.createdAt === null || t.createdAt <= since)) {
      stoppedAtWatermark = true
      return false
    }
    if (scanned >= total) return false
    return true
  }

  // ---- ① 先单独取第一页：拿到 total ⇒ 知道到底有几页（免得多取空页）--------
  const first = await fetchScanPage(startPage, pageSize)
  if (!handlePage(startPage, first)) {
    return { scanned, total, pages, stoppedAtWatermark }
  }
  let next = startPage + 1

  // ---- ② 其余页：**批内并发**，批内**按页序**处理 ---------------------------
  while (next <= maxPages) {
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : maxPages
    // ⚠ 剩余页数 = 曲库的总页数**减去**已经取过的那些（页码从 1 起算）。
    const remaining = Math.max(0, totalPages - next + 1)
    const batchCount = Math.min(concurrency, remaining, maxPages - next + 1)
    if (batchCount <= 0) break
    const batchPages: number[] = []
    for (let i = 0; i < batchCount; i += 1) batchPages.push(next + i)

    // ⚠ 批内**并发**取回（任一页失败 ⇒ 整批失败 ⇒ 抛给调用方如实报错）。
    const batch = await Promise.all(batchPages.map((p) => fetchScanPage(p, pageSize)))

    // ⚠ **按页序**处理 ⇒ `onPage` 的顺序与顺序扫描一致 ⇒ 断点语义不变。
    let keepGoing = true
    for (let i = 0; i < batch.length && keepGoing; i += 1) {
      const page = batchPages[i] ?? next
      const raw = batch[i]
      if (!raw) continue
      keepGoing = handlePage(page, raw)
    }
    next = (batchPages[batchPages.length - 1] ?? next) + 1
    if (!keepGoing) break
  }

  return { scanned, total, pages, stoppedAtWatermark }
}
