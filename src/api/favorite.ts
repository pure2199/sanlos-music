// 收藏接口。
//
// 体量例外：实测该账号收藏 **251 首**，而服务端默认页长是 **200**——
// 「一次 `size=2000` 就能拿全」的假设只在 `track/list` 上验过，收藏端点并不确定。
// 因此这里采用**分页循环取全**：每页 200 条，按 `total` 终止，带安全页数上限。
//
// ⚠️ 收藏 / 歌单是控制器明确豁免的「体量小可全量」类；**曲库类接口没有这个例外**，
//    绝不可套用这里的循环取全（真实 NAS 曲库 17.3 万首）。

import type { Song } from '../../shared/types'
import { apiCall, fetchAllByPaging, mapSong } from './client'
import type { RawSong } from './types'

/** 全量取回时的单页条数（与服务端默认页长一致，避免被服务端截断）。 */
const FULL_FETCH_PAGE_SIZE = 200

/** 全量取回的安全上限（页数）——服务端 `total` 异常时不至于无限循环。 */
const MAX_FULL_FETCH_PAGES = 50

/** 收藏相关接口。 */
export const favoriteApi = {
  /** 收藏列表（分页循环取全；实测 251 首 > 服务端默认页长 200）。 */
  async list(): Promise<Song[]> {
    return fetchAllByPaging<RawSong, Song>('/favorite-track/list', mapSong, {
      pageSize: FULL_FETCH_PAGE_SIZE,
      maxPages: MAX_FULL_FETCH_PAGES,
    })
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
