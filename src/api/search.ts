// 搜索接口。
//
// 一次搜索并发打三个端点（歌曲 / 专辑 / 歌手），各自返回列表信封。
//
// 分页：搜索端点是否支持 `page` / `size` **未实测**，但客户端**无条件透传**分页参数
// （服务端忽略也不吃亏），并把 `{ list, total }` 一起带回——
// 「所有列表型方法都返回 `{list,total}`」的契约才成立，结果页才能做增量加载与总数展示。
// 真实行为见联调清单 **Step H**。

import type { Album, Artist, Playlist, Song } from '../../shared/types'
import {
  apiCall,
  DEFAULT_PAGE_SIZE,
  mapAlbum,
  mapArtist,
  mapPlaylist,
  mapSong,
  normalizePage,
  normalizePageNumber,
  normalizePageSize,
} from './client'
import type {
  Page,
  RawAlbum,
  RawArtist,
  RawPage,
  RawPlaylist,
  RawSong,
  RawSuggestSegment,
} from './types'

/** 一次搜索的结果（三类都是分页信封）。 */
export interface SearchResult {
  /** 命中的歌曲。 */
  tracks: Page<Song>
  /** 命中的专辑。 */
  albums: Page<Album>
  /** 命中的歌手。 */
  artists: Page<Artist>
}

/**
 * 「搜索建议」的结果（T127）。
 *
 * ⚠ **与服务端那四段一一对应**，但每段都被**归一成 `{list, total}`**
 *    （服务端给的是 `{total, items}`）。
 */
export interface SuggestResult {
  /** 建议的歌曲。 */
  tracks: Page<Song>
  /** 建议的专辑。 */
  albums: Page<Album>
  /** 建议的歌手。 */
  artists: Page<Artist>
  /** 建议的歌单。 */
  playlists: Page<Playlist>
}

/** 建议端点的原始响应（四段，每段 `{total, items}`）。 */
interface RawSuggestResult {
  track?: RawSuggestSegment<RawSong>
  album?: RawSuggestSegment<RawAlbum>
  artist?: RawSuggestSegment<RawArtist>
  playlist?: RawSuggestSegment<RawPlaylist>
}

/**
 * 把建议端点的**一段**归一成 `{list, total}`。
 *
 * ⚠ 服务端给的是 **`items`**（不是 `list`）—— 实测 2026-11-20 真实 NAS。
 * ⚠ `total` 缺失 / 非法时**回落成 `items.length`**（与 `normalizePage` 同一口径）。
 */
function normalizeSuggestSegment<T, U>(
  segment: RawSuggestSegment<T> | undefined,
  map: (item: T) => U,
): Page<U> {
  const items = Array.isArray(segment?.items) ? segment.items : []
  const total = typeof segment?.total === 'number' && Number.isFinite(segment.total)
    ? segment.total
    : items.length
  return { list: items.map((item) => map(item)), total }
}

/** 搜索接口。 */
export const searchApi = {
  /**
   * 并发搜索歌曲 / 专辑 / 歌手。
   *
   * @param q 关键字
   * @param opts 分页（`page` / `size` 会无条件透传给三个端点）
   */
  async query(q: string, opts: { page?: number; size?: number } = {}): Promise<SearchResult> {
    const page = normalizePageNumber(opts.page ?? 1)
    const size = normalizePageSize(opts.size ?? DEFAULT_PAGE_SIZE)
    const [trackData, albumData, artistData] = await Promise.all([
      apiCall<RawPage<RawSong>>('/search/track', { query: { q, page, size } }),
      apiCall<RawPage<RawAlbum>>('/search/album', { query: { q, page, size } }),
      apiCall<RawPage<RawArtist>>('/search/artist', { query: { q, page, size } }),
    ])
    const tracks = normalizePage<RawSong>(trackData)
    const albums = normalizePage<RawAlbum>(albumData)
    const artists = normalizePage<RawArtist>(artistData)
    return {
      tracks: { list: tracks.list.map((song) => mapSong(song)), total: tracks.total },
      albums: { list: albums.list.map((album) => mapAlbum(album)), total: albums.total },
      artists: { list: artists.list.map((artist) => mapArtist(artist)), total: artists.total },
    }
  },

  /**
   * **只**搜歌手（`/search/artist`）。
   *
   * ⚠️ **为什么单独开一个方法**：`query()` 会**并发打三个端点**（歌曲 / 专辑 / 歌手），
   *    而「按歌手名找本地歌手」只需要歌手那一个 ⇒ 单独走能省掉 **2/3 的请求**。
   *    （T96 的「发现」页要按榜单里的歌手**逐个**定向查，量很大 ⇒ 这点很值钱。）
   *
   * ⚠️ 服务端的搜索是**子串匹配**（实测：`includes`）⇒ 返回的可能是一堆**只沾边**的歌手；
   *    调用方要**自己**按名字全等筛一遍（见 `src/api/discover.ts`）。
   */
  async artists(q: string, opts: { page?: number; size?: number } = {}): Promise<Page<Artist>> {
    const page = normalizePageNumber(opts.page ?? 1)
    const size = normalizePageSize(opts.size ?? DEFAULT_PAGE_SIZE)
    const raw = normalizePage<RawArtist>(
      await apiCall<RawPage<RawArtist>>('/search/artist', { query: { q, page, size } }),
    )
    return { list: raw.list.map((artist) => mapArtist(artist)), total: raw.total }
  },

  /**
   * **只**搜专辑（`/search/album`）。
   *
   * ⚠️ **为什么单独开一个方法**（T98 v3）：「按**作品名**找有声作品」只需要专辑那一个端点
   *    ⇒ 单独走能省掉 **2/3 的请求**；实测 `/search/album?q=牧神记` **106 ms** 返回 1 条。
   *
   * ⚠️ 服务端的搜索是 **top-N 截断 + 命中集不稳定** ⇒ 这条路径**只能当「发现」**：
   *    「搜不到」**不能**证明「不存在」⇒ 调用方要如实告诉用户（可改用目录扫描兜底）。
   */
  async albums(q: string, opts: { page?: number; size?: number } = {}): Promise<Page<Album>> {
    const page = normalizePageNumber(opts.page ?? 1)
    const size = normalizePageSize(opts.size ?? DEFAULT_PAGE_SIZE)
    const raw = normalizePage<RawAlbum>(
      await apiCall<RawPage<RawAlbum>>('/search/album', { query: { q, page, size } }),
    )
    return { list: raw.list.map((album) => mapAlbum(album)), total: raw.total }
  },

  /**
   * **搜索建议**（`/search/suggest`）—— 一次拿回四类「最相关」的 top-N（T127）。
   *
   * ⚠ **为什么值得单独接**（实测 2026-11-20，FN 中继 ＋ 真实 NAS，只读 GET）：
   *   - 端点返回**四段**（歌曲 / 专辑 / 歌手 / 歌单），**一次请求**全给；
   *   - 每段**带 `score`**（相关性分）—— 这是 `/search/*` 的普通端点**也给不了**的
   *     （`/search/track` 的条目其实也带 `score`，只是客户端之前一直丢掉了）；
   *   - 实测耗时 **1.39 / 1.65 / 1.42 s**，比 `/search/track`（5.8 s）**快得多**
   *     ⇒ 适合当「先出建议、后出完整结果」里的**第一段**。
   *
   * ⚠ **服务端会忽略 `page` / `size`**（实测 size=1/3/20/100 都是每段 5 条；
   *    page=1 与 page=2 结果逐字相同）⇒ **固定 top-5**、**不分页**
   *    ⇒ 客户端**一律不发**这两个参数（发了也只是噪音）。
   *
   * ⚠ **空关键字会被服务端拒**（实测 `?q=` ⇒ `code=100002 invalid arguments`）
   *    ⇒ **客户端自己拦下**，**一次请求都不发**。
   *
   * ⚠ **服务端是模糊匹配**（实测搜「不存在的词」仍回 5 首 ＋ 5 张专辑）
   *    ⇒ 建议里的条目**未必命中关键字** ⇒ 界面上它是「推荐」而不是「筛选结果」。
   */
  async suggest(q: string): Promise<SuggestResult> {
    const keyword = q.trim()
    // ⚠ 空 / 纯空格关键字 ⇒ 服务端会回 `code=100002` ⇒ 客户端自己拦，**不发请求**。
    if (keyword.length === 0) {
      return {
        tracks: { list: [], total: 0 },
        albums: { list: [], total: 0 },
        artists: { list: [], total: 0 },
        playlists: { list: [], total: 0 },
      }
    }
    const data = await apiCall<RawSuggestResult>('/search/suggest', { query: { q: keyword } })
    return {
      tracks: normalizeSuggestSegment(data.track, mapSong),
      albums: normalizeSuggestSegment(data.album, mapAlbum),
      artists: normalizeSuggestSegment(data.artist, mapArtist),
      playlists: normalizeSuggestSegment(data.playlist, mapPlaylist),
    }
  },
}
