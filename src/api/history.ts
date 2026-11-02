// 播放历史接口（实测确认的端点 `GET /music/api/v1/play-history/list`，实测默认 50 条、total=414）。
//
// ⚠️ **条目形状是占位**：真实 NAS 的播放历史条目字段**只实测到「端点存在、默认 50 条、total=414」**，
//    具体字段（是否内嵌完整 `track`、播放时间的单位与格式）**未实测**。
//    本模块按「条目内嵌一首原始歌曲」推导，`playTime` 原样透传（数字或字符串都收）。
//    **Task 16 必须按真实响应校准**本模块的映射与 `HistoryEntry` 形状。
//
// 分页：播放历史按 `page` / `size` 分页取回，`total` 一并返回（供「最近播放」页增量加载）。

import type { Song } from '../../shared/types'
import { apiCall, mapSong, normalizePage } from './client'
import type { Page, RawHistoryItem, RawPage } from './types'

/** 列表型接口的默认每页条数。 */
const DEFAULT_PAGE_SIZE = 50

/** 播放历史条目（领域侧）。 */
export interface HistoryEntry {
  /** 条目 guid（服务端没有时为空串）。 */
  id: string
  /** 播放时间（原始值透传：可能是数字时间戳，也可能是 ISO 字符串）。 */
  playTime: number | string | null
  /** 对应歌曲。 */
  song: Song
}

/** 把原始条目转成领域条目；没有内嵌歌曲的条目直接丢弃。 */
function toEntry(item: RawHistoryItem): HistoryEntry | null {
  if (!item || typeof item !== 'object') return null
  const track = item.track
  if (!track || typeof track !== 'object') return null
  const playTime =
    typeof item.playTime === 'number' || typeof item.playTime === 'string' ? item.playTime : null
  return {
    id: typeof item.guid === 'string' ? item.guid : '',
    playTime,
    song: mapSong(track),
  }
}

/** 取一页播放历史条目（含播放时间）。 */
async function fetchEntries(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<HistoryEntry>> {
  const raw = normalizePage<RawHistoryItem>(
    await apiCall<RawPage<RawHistoryItem>>('/play-history/list', { query: { page, size } }),
  )
  const entries: HistoryEntry[] = []
  for (const item of raw.list) {
    const entry = toEntry(item)
    if (entry) entries.push(entry)
  }
  return { list: entries, total: raw.total }
}

/** 播放历史接口。 */
export const historyApi = {
  /** 播放历史里的歌曲（分页）。 */
  async list(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<Song>> {
    const raw = await fetchEntries(page, size)
    return { list: raw.list.map((entry) => entry.song), total: raw.total }
  },

  /** 播放历史条目（含播放时间，分页）——「最近播放」页需要按时间排序时用这个。 */
  async listItems(page = 1, size = DEFAULT_PAGE_SIZE): Promise<Page<HistoryEntry>> {
    return fetchEntries(page, size)
  },
}
