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
//
// ---------------------------------------------------------------------------
// Task 7 实测结论（2026-11-05，真机）
// ---------------------------------------------------------------------------
// 1. **读**：`GET /music/api/v1/play-history/list?page=&size=` → HTTP 200、`code=0`、
//    `total=426`，条目即歌曲对象（含 `createdAt` / `updatedAt`，Unix 秒）。
// 2. **排序**：服务端返回顺序**不是**按 `updatedAt` / `createdAt` 排的——
//    实测第 1 页时间戳为 `1791611092 | 1791623756 | 1793678781 | 1791611092 | …`
//    （非单调：第 3 条比第 1 条新得多却排在后面）。
//    → 服务端内部有一个**不暴露**的「最近播放」排序依据，
//      **客户端只能按服务端返回顺序展示，不要自行按时间戳排序**。
// 3. **写（上报）**：**服务端不会随 stream 自动写历史**
//    （实测：GET `/track/stream` 拿到 206 音频后，0.5s / 1.5s / 3s 三次复查，
//    历史前 5 条未变、本次曲目未出现）。
//    且在 `/music/api/v1/` 前缀下探测了 50+ 个候选写路径
//    （`play-history/{add,set,update,insert,record,append,push,play,touch,…}` 等），
//    **全部返回 fnOS 的 SPA 兜底页**（即不是 API 端点），只有 `play-history/delete` 是真端点。
//    → **当前没有可用的「上报播放」端点**：客户端**不臆造**上报调用；
//      本机播放记录改由本地记录（见 `src/state/historyStore.ts`）。
//    待校准项见联调清单 **Step F**（需要用户在 fnOS 音乐**网页端**播放一首歌并抓包，
//    看它到底调了哪个写端点）。
// ---------------------------------------------------------------------------

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
