// 歌单接口。
//
// 体量例外：实测该账号歌单 **2 个**（规格 §15.3 记载该账号歌单为空），
// 歌单列表按「体量小、允许一次取回」处理：单次请求 `size=2000`（服务端上限），
// 避免服务端默认每页 200 带来的静默截断。
// **歌单里的歌曲**是曲库数据（可能上千首），因此仍然分页。

import type { Playlist, Song } from '../../shared/types'
import { apiCall, mapPlaylist, mapSong, MAX_PAGE_SIZE, normalizePage } from './client'
import type { Page, RawPage, RawPlaylist, RawSong } from './types'

/** 列表型接口的默认每页条数。 */
const DEFAULT_PAGE_SIZE = 50

/** 歌单相关接口。 */
export const playlistApi = {
  /** 歌单列表（一次取回全部；实测 2 个）。 */
  async list(): Promise<Playlist[]> {
    const raw = normalizePage<RawPlaylist>(
      await apiCall<RawPage<RawPlaylist>>('/playlist/list', { query: { size: MAX_PAGE_SIZE } }),
    )
    return raw.list.map((playlist) => mapPlaylist(playlist))
  },

  /** 某歌单里的歌曲（分页）。 */
  async songs(id: string, page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/track/playlist-detail/list', {
        query: { playlistGUID: id, page, size },
      }),
    )
    return { list: raw.list.map((song) => mapSong(song)), total: raw.total }
  },

  /** 新建歌单，返回新歌单的 guid（服务端不回显名字，查不到时返回空串）。 */
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
