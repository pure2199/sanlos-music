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
  normalizePage,
  normalizePageNumber,
  normalizePageSize,
} from './client'
import type { Page, RawAlbum, RawArtist, RawGenre, RawPage, RawSong } from './types'

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
   * 服务端的详情端点也用列表信封返回（`{ list: [专辑], total: 1 }`），
   * 这里取第一条；查不到返回 `null`。
   *
   * ⚠️ **该返回形状未实测**（客户端按「列表信封 + 取 `list[0]`」处理），
   *    真实响应校准项见联调清单 **Step J**。
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
        query: { albumGUID: id, page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
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
