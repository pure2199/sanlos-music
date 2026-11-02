// 收藏接口。
//
// 体量例外：实测该账号收藏 **251 首**，服务端默认每页 200——
// 若不显式给 `size`，`/favorite-track/list` 会**静默截断**到 200 首。
// 收藏列表因此按「体量小、允许一次取回」处理：单次请求 `size=2000`（服务端上限）。
// 曲库类接口没有这个例外，一律分页。

import type { Song } from '../../shared/types'
import { apiCall, mapSong, MAX_PAGE_SIZE, normalizePage } from './client'
import type { RawPage, RawSong } from './types'

/** 收藏相关接口。 */
export const favoriteApi = {
  /** 收藏列表（一次取回全部；实测 251 首，服务端单页上限 2000）。 */
  async list(): Promise<Song[]> {
    const raw = normalizePage<RawSong>(
      await apiCall<RawPage<RawSong>>('/favorite-track/list', { query: { size: MAX_PAGE_SIZE } }),
    )
    return raw.list.map((song) => mapSong(song))
  },

  /**
   * 设置 / 取消收藏。
   *
   * @param id 歌曲 guid
   * @param on `true` 收藏，`false` 取消
   */
  async set(id: string, on: boolean): Promise<void> {
    await apiCall('/favorite-track/' + (on ? 'create' : 'delete'), {
      method: 'POST',
      body: { trackGUID: id },
    })
  },
}
