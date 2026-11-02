// 歌词接口。
//
// 实测：同一首歌会返回**两条内容近乎相同但 `source` 不同**的记录，
// 因此这里同时提供两个入口：
// - `raw`：取第一条的 LRC 原文（绝大多数场景够用），无歌词返回空串；
// - `list`：返回全部条目，让 Task 12 的解析器自己挑一条（比较来源、比较更新时间等）。

import { apiCall, normalizePage } from './client'
import type { RawLyric, RawPage } from './types'

/** 取某首歌的全部歌词条目。 */
async function fetchLyrics(songId: string): Promise<RawLyric[]> {
  const raw = normalizePage<RawLyric>(
    await apiCall<RawPage<RawLyric>>('/lyric/list', { query: { trackGUID: songId } }),
  )
  return raw.list
}

/** 歌词接口。 */
export const lyricApi = {
  /** 全部歌词条目（同一首歌可能有多条来源不同的记录）。 */
  list: fetchLyrics,

  /** 第一条歌词的 LRC 原文；该歌没有歌词时返回空串。 */
  async raw(songId: string): Promise<string> {
    const list = await fetchLyrics(songId)
    const first = list[0]
    return typeof first?.content === 'string' ? first.content : ''
  },
}
