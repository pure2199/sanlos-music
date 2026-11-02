// 搜索接口。
//
// 一次搜索并发打三个端点（歌曲 / 专辑 / 歌手），各自返回列表信封。
// ⚠️ 搜索结果**不分页**：服务端按 `q` 命中并用自己的默认页长返回，
//    命中过多时会被服务端截断（真实 NAS 的搜索页长未实测）——Task 14 若要「搜索结果分页」，
//    需要先实测服务端搜索端点是否接受 `page` / `size`，再决定是否在此扩展签名。

import type { Album, Artist, Song } from '../../shared/types'
import { apiCall, mapAlbum, mapArtist, mapSong, normalizePage } from './client'
import type { RawAlbum, RawArtist, RawPage, RawSong } from './types'

/** 一次搜索的结果。 */
export interface SearchResult {
  /** 命中的歌曲。 */
  tracks: Song[]
  /** 命中的专辑。 */
  albums: Album[]
  /** 命中的歌手。 */
  artists: Artist[]
}

/** 搜索接口。 */
export const searchApi = {
  /** 并发搜索歌曲 / 专辑 / 歌手。 */
  async query(q: string): Promise<SearchResult> {
    const [trackData, albumData, artistData] = await Promise.all([
      apiCall<RawPage<RawSong>>('/search/track', { query: { q } }),
      apiCall<RawPage<RawAlbum>>('/search/album', { query: { q } }),
      apiCall<RawPage<RawArtist>>('/search/artist', { query: { q } }),
    ])
    const tracks = normalizePage<RawSong>(trackData)
    const albums = normalizePage<RawAlbum>(albumData)
    const artists = normalizePage<RawArtist>(artistData)
    return {
      tracks: tracks.list.map((song) => mapSong(song)),
      albums: albums.list.map((album) => mapAlbum(album)),
      artists: artists.list.map((artist) => mapArtist(artist)),
    }
  },
}
