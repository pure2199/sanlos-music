// 播放历史接口（实测确认的端点 `GET /music/api/v1/play-history/list`，实测默认 50 条、total=414）。
//
// ⚠️ **条目本身就是完整的歌曲对象**（实测 §15.7 第 6 条）：
//    条目含 `guid,title,coverId,duration,album,artists,audioSpec,isFavorite` 等字段，
//    **不是** `{ track: <歌曲> }` 包装——所以这里对条目直接调用 `mapSong`。
//    （早前按「条目内嵌 track」推导的占位形状已作废。）
//
// 「最近播放」的**排序依据待定**：条目里没有单独的播放时间字段，
// 真实排序该按条目的 `updatedAt` 还是别的字段，要等 Task 16 按真实响应决定，
// 真实响应校准项见联调清单 **Step F**。
//
// 分页：播放历史按 `page` / `size` 分页取回，`total` 一并返回（供「最近播放」页增量加载）。

import type { Song } from '../../shared/types'
import {
  apiCall,
  DEFAULT_PAGE_SIZE,
  mapSong,
  normalizePage,
  normalizePageNumber,
  normalizePageSize,
} from './client'
import type { Page, RawHistoryItem, RawPage } from './types'

/** 播放历史接口。 */
export const historyApi = {
  /** 播放历史里的歌曲（分页；条目即歌曲对象，直接走 `mapSong`）。 */
  async list(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = normalizePage<RawHistoryItem>(
      await apiCall<RawPage<RawHistoryItem>>('/play-history/list', {
        query: { page: normalizePageNumber(page), size: normalizePageSize(size) },
      }),
    )
    return { list: raw.list.map((entry) => mapSong(entry)), total: raw.total }
  },
}
