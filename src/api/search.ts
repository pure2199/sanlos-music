// 搜索接口。
//
// 一次搜索并发打三个端点（歌曲 / 专辑 / 歌手），各自返回列表信封。
//
// 分页：搜索端点是否支持 `page` / `size` **未实测**，但客户端**无条件透传**分页参数
// （服务端忽略也不吃亏），并把 `{ list, total }` 一起带回——
// 「所有列表型方法都返回 `{list,total}`」的契约才成立，结果页才能做增量加载与总数展示。
// 真实行为见联调清单 **Step H**。

import type { Album, Artist, Song } from '../../shared/types'
import {
  apiCall,
  DEFAULT_PAGE_SIZE,
  mapAlbum,
  mapArtist,
  mapSong,
  normalizePage,
  normalizePageNumber,
  normalizePageSize,
} from './client'
import type { Page, RawAlbum, RawArtist, RawPage, RawSong } from './types'

/** 一次搜索的结果（三类都是分页信封）。 */
export interface SearchResult {
  /** 命中的歌曲。 */
  tracks: Page<Song>
  /** 命中的专辑。 */
  albums: Page<Album>
  /** 命中的歌手。 */
  artists: Page<Artist>
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
}
