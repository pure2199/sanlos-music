// 曲库浏览接口（专辑 / 歌曲 / 歌手 / 风格）。
//
// 分页硬要求（实测修正 M6）：**所有列表型方法都接受 `page` / `size`，并把 `{ list, total }` 一起返回**，
// 供 Task 14 的增量加载 + 虚拟滚动使用。本模块**不提供任何一次性全量拉取的路径**：
// 没有 `fetchAll`，默认 `size` 也不是全库——真实 NAS 曲库 17.3 万首，拉全量会拖垮客户端。

import type { Album, Artist, Genre, Song } from '../../shared/types'
import { apiCall, mapAlbum, mapArtist, mapGenre, mapSong, normalizePage } from './client'
import type { Page, RawAlbum, RawArtist, RawGenre, RawPage, RawSong } from './types'

/** 列表型接口的默认每页条数（服务端上限 2000；客户端默认保守取 50）。 */
const DEFAULT_PAGE_SIZE = 50

/** 曲库相关接口。 */
export const libraryApi = {
  /**
   * 专辑列表（分页）。
   *
   * @param page 页码（1 起）
   * @param size 每页条数
   * @param sort 排序表达式（服务端接受但语义待实测校准；不给则不下发该参数）
   */
  async albums(page = 1, size = DEFAULT_PAGE_SIZE, sort?: string): Promise<Page<Album>> {
    const raw = normalizePage<RawAlbum>(
      await apiCall<RawPage<RawAlbum>>('/album/list', { query: { page, size, sort } }),
    )
    return { list: raw.list.map((album) => mapAlbum(album)), total: raw.total }
  },

  /**
   * 专辑详情。
   *
   * 服务端的详情端点也用列表信封返回（`{ list: [专辑], total: 1 }`），
   * 这里取第一条；查不到返回 `null`。
   */
  async album(id: string): Promise<Album | null> {
    const raw = normalizePage<RawAlbum>(
      await apiCall<RawPage<RawAlbum>>('/album/detail', { query: { albumGUID: id } }),
    )
    const first = raw.list[0]
    return first ? mapAlbum(first) : null
  },

  /** 某专辑下的歌曲（分页）。 */
  async albumSongs(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/album-detail/list', {
        query: { albumGUID: id, page, size },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /** 某歌手的专辑（分页）。 */
  async artistAlbums(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Album>> {
    const raw = normalizePage<RawAlbum>(
      await apiCall<RawPage<RawAlbum>>('/album/artist-detail/list', {
        query: { artistGUID: id, page, size },
      }),
    )
    return { list: raw.list.map((album) => mapAlbum(album)), total: raw.total }
  },

  /** 全部歌曲（分页）。 */
  async songs(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/list', { query: { page, size } }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /** 某歌手的歌曲（分页）。 */
  async artistSongs(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/artist-detail/list', {
        query: { artistGUID: id, page, size },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /**
   * 某风格的歌曲（分页）。
   *
   * @param id 风格 guid（服务端只认 `genreGUID`）
   * @param name 风格名，仅供调用方可读性与将来按名查询；服务端不用它，故不下发
   */
  async genreSongs(
    id: string,
    name?: string,
    page = 1,
    size = DEFAULT_PAGE_SIZE,
  ): Promise<Page<Song>> {
    void name
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/genre-detail/list', {
        query: { genreGUID: id, page, size },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /** 歌手列表（分页）。 */
  async artists(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Artist>> {
    const raw = normalizePage<RawArtist>(
      await apiCall<RawPage<RawArtist>>('/artist/list', { query: { page, size } }),
    )
    return { list: raw.list.map((artist) => mapArtist(artist)), total: raw.total }
  },

  /** 风格列表（分页）。 */
  async genres(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Genre>> {
    const raw = normalizePage<RawGenre>(
      await apiCall<RawPage<RawGenre>>('/genre/list', { query: { page, size } }),
    )
    return { list: raw.list.map((genre) => mapGenre(genre)), total: raw.total }
  },
}
