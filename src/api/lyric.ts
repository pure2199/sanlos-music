// 歌词接口。
//
// 实测：同一首歌会返回**两条内容近乎相同但 `source` 不同**的记录，
// 因此这里同时提供两个入口：
// - `raw`：取第一条的 LRC 原文（绝大多数场景够用），无歌词返回空串；
// - `list`：返回全部条目，让 Task 12 的解析器自己挑一条（比较来源、比较更新时间等）。
//
// 时间字段：服务端给的是 **Unix 秒**（实测），领域层统一归一为 **ISO 8601 字符串**
// （`shared/types.ts` 的领域时间字段约定是 `string | null`）；服务端给 ISO 串时原样保留。

import { apiCall, mapLyric, normalizePage } from './client'
import type { LyricEntry, RawLyric, RawPage } from './types'

/** 取某首歌的全部歌词条目（时间已归一为 ISO 串）。 */
async function fetchLyrics(songId: string): Promise<LyricEntry[]> {
  const raw = normalizePage<RawLyric>(
    await apiCall<RawPage<RawLyric>>('/lyric/list', { query: { trackGUID: songId } }),
  )
  return raw.list.map((lyric) => mapLyric(lyric))
}

/** 歌词接口。 */
export const lyricApi = {
  /** 全部歌词条目（同一首歌可能有多条来源不同的记录）。 */
  list: fetchLyrics,

  /** 第一条歌词的 LRC 原文；该歌没有歌词时返回空串。 */
  async raw(songId: string): Promise<string> {
    const list = await fetchLyrics(songId)
    return list[0]?.content ?? ''
  },
}
