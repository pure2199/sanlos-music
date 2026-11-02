// 歌单接口。
//
// 体量例外：实测该账号歌单 **2 个**（规格 §15.3 记载该账号歌单为空），
// 但服务端默认页长是 200、且 `size` 上限只在 `track/list` 上验过——
// 歌单列表同样采用**分页循环取全**（每页 200 条，按 `total` 终止，带安全页数上限），
// 不依赖「一次 size=2000 就能拿全」的假设。
//
// **歌单里的歌曲**是曲库数据（可能上千首），因此仍然分页。

import type { Playlist, Song } from '../../shared/types'
import {
  apiCall,
  DEFAULT_PAGE_SIZE,
  fetchAllByPaging,
  mapPlaylist,
  mapSong,
  normalizePage,
  normalizePageNumber,
  normalizePageSize,
} from './client'
import type { Page, RawPage, RawPlaylist, RawSong } from './types'

/** 全量取回时的单页条数（与服务端默认页长一致）。 */
const FULL_FETCH_PAGE_SIZE = 200

/** 全量取回的安全上限（页数）。 */
const MAX_FULL_FETCH_PAGES = 50

/** 歌单相关接口。 */
export const playlistApi = {
  /** 歌单列表（分页循环取全）。 */
  async list(): Promise<Playlist[]> {
    return fetchAllByPaging<RawPlaylist, Playlist>('/playlist/list', mapPlaylist, {
      pageSize: FULL_FETCH_PAGE_SIZE,
      maxPages: MAX_FULL_FETCH_PAGES,
    })
  },

  /** 某歌单里的歌曲（分页）。 */
  async songs(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/playlist-detail/list', {
        query: { playlistGUID: id, page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /**
   * 新建歌单，返回新歌单的 guid（服务端不回显名字，查不到时返回空串）。
   *
   * ⚠️ **返回形状未实测**（客户端按「回显 `guid`，缺失则兜底 `''`」处理），
   *    真实响应校准项见联调清单 **Step J**。
   */
  async create(name: string): Promise<string> {
    const data = await apiCall<{ guid?: string }>('/playlist/create', {
      method: 'POST',
      body: { name },
    })
    return typeof data.guid === 'string' ? data.guid : ''
  },

  /** 重命名歌单。 */
  async rename(id: string, name: string): Promise<void> {
    await apiCall('/playlist/update', { method: 'POST', body: { guid: id, name } })
  },

  /** 删除歌单。 */
  async remove(id: string): Promise<void> {
    await apiCall('/playlist/delete', { method: 'POST', body: { guid: id } })
  },

  /** 把歌曲加入歌单。 */
  async addTracks(id: string, songIds: string[]): Promise<void> {
    await apiCall('/playlist/add-track', {
      method: 'POST',
      body: { guid: id, trackGUIDs: songIds },
    })
  },

  /** 把歌曲移出歌单。 */
  async removeTracks(id: string, songIds: string[]): Promise<void> {
    await apiCall('/playlist/remove-track', {
      method: 'POST',
      body: { guid: id, trackGUIDs: songIds },
    })
  },
}
