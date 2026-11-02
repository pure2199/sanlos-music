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
}
