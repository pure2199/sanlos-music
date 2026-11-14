// ---------------------------------------------------------------------------
// T93：占位歌词视同「没匹配上」
// ---------------------------------------------------------------------------
//
// ⚠️ **背景（实测）**：咪咕对「茨厂街（粤语谐剧·黄庆全 陈自成 吴金英）」返回
//    `[00:00.00]此歌曲为纯音乐，请欣赏` —— 一句 **21 字**的占位文本；
//    而这首歌的**内嵌歌词有 265 行真对白**。
//    旧的命中判据只看「`ok` 且原文非空」⇒ **占位骗过了整条源链**
//    ⇒ 链子立刻返回 ⇒ **内嵌歌词根本没被读**。
//
// 本文件钉四件事：
//   1. **判定**（`isPlaceholderLyric`）：占位 ⇔ 短正文 + 命中占位特征；
//   2. **不误伤**真歌词（哪怕只有 **1 行**）；
//   3. **源链**：占位**不算命中** ⇒ 链子继续试下一个源；全链都是占位 ⇒ `not-found`；
//   4. **渲染层兜底**：线上是占位 ⇒ **回落内嵌**（`origin = 'embedded'`）。
//
// ⚠️ 测试数据全是**占位数据**，不写真实内网地址。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { ExternalLyricQuery } from '../shared/lyricProvider'
import { isPlaceholderLyric } from '../shared/lyricPlaceholder'
import { createLyricProvider } from '../electron/lyricProvider'
import type { LyricEntry } from '../src/api/types'
import {
  loadLyricEntries,
  type EmbeddedLyricFetcher,
  type ExternalLyricFetcher,
  type NasLyricApi,
} from '../src/player/lyricSource'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 一段带时间戳的 LRC（占位内容）。 */
const LRC_SAMPLE = '[00:10.00]占位歌词第一行\n[00:20.00]占位歌词第二行'

/** 咪咕实测返回的那句占位（T93 的起因）。 */
const PLACEHOLDER_LRC = '[00:00.00]此歌曲为纯音乐，请欣赏'

/** 造的查询条件。 */
const QUERY: ExternalLyricQuery = {
  title: '占位歌名',
  artist: '占位歌手',
  album: '占位专辑',
  duration: 200,
}

/** 渲染层用的匹配目标。 */
const TARGET = { title: '占位歌名', artist: '占位歌手', album: '占位专辑', duration: 200 }

/** 网易云搜索结果（时长对得上、歌手对得上 ⇒ 会被选中）。 */
const NETEASE_SEARCH_BODY = JSON.stringify({
  result: {
    songCount: 1,
    songs: [{ id: 222, name: '占位歌名', duration: 200_000, artists: [{ name: '占位歌手' }] }],
  },
})

/** 造的 NAS 歌词条目。 */
function nasEntry(content: string): LyricEntry {
  return {
    guid: 'nas-1',
    source: 'local',
    content,
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset: 0,
  }
}

/** 造的 NAS 接口。 */
function makeApi(entries: LyricEntry[]): NasLyricApi {
  return { list: async () => entries }
}

/**
 * 造的 fetch 替身：按「URL 包含什么」返回对应响应。
 *
 * ⚠️ 与 `test/lyric-provider.test.ts` 同一套路（那边是那份的**原型**）。
 */
function makeFetch(
  routes: { match: string; body: string }[],
): { fetchImpl: (input: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input)
    const hit = routes.find((route) => input.includes(route.match))
    if (!hit) return new Response('not found', { status: 404 })
    return new Response(hit.body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

describe('isPlaceholderLyric：占位判定', () => {
  it('咪咕实测那句 ⇒ **是**占位', () => {
    expect(isPlaceholderLyric(PLACEHOLDER_LRC)).toBe(true)
  })

  it('英文 instrumental ⇒ **是**占位', () => {
    expect(isPlaceholderLyric('[00:00.00]Instrumental')).toBe(true)
  })

  it('空串 ⇒ **是**占位（本来就当「没有」）', () => {
    expect(isPlaceholderLyric('')).toBe(true)
  })

  it('**1 行的真歌词** ⇒ **不是**占位（不许误伤）', () => {
    expect(isPlaceholderLyric('[00:12.00]冷酷な天使のテーゼ')).toBe(false)
  })

  it('长歌词 ⇒ **不是**占位', () => {
    const long = [
      '[00:00.00]这是一段真歌词的第一行内容',
      '[00:10.00]这是一段真歌词的第二行内容',
      '[00:20.00]这是一段真歌词的第三行内容',
      '[00:30.00]这是一段真歌词的第四行内容',
    ].join('\n')
    expect(isPlaceholderLyric(long)).toBe(false)
  })

  it('含「纯音乐」但**正文很长** ⇒ **不是**占位（长度闸门生效）', () => {
    const text =
      '[00:00.00]这是一首很长的歌词里面也提到了纯音乐这两个字但它显然不是占位提示语因为它已经远远超过了长度上限'
    expect(isPlaceholderLyric(text)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 源链：占位**不算命中**
// ---------------------------------------------------------------------------

describe('源链（T93）：占位不算命中', () => {
  it('首选源返回占位 ⇒ **继续试下一个源**，命中真歌词就用它', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', body: NETEASE_SEARCH_BODY },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({ lrc: { lyric: PLACEHOLDER_LRC } }),
      },
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: LRC_SAMPLE, plainLyrics: '' }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // ⚠️ **必须落到下一个源** —— 旧判据会让那句占位直接「命中」。
    expect(result.source).toBe('lrclib')
    expect(result.original).toBe(LRC_SAMPLE)
    expect(calls.some((url) => url.includes('lrclib.net'))).toBe(true)
  })

  it('全链都是占位 ⇒ `not-found`（不是「命中了一句占位」）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: NETEASE_SEARCH_BODY },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({ lrc: { lyric: PLACEHOLDER_LRC } }),
      },
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: PLACEHOLDER_LRC, plainLyrics: '' }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('**1 行的真歌词**照样命中（不许被占位规则误伤）', async () => {
    const oneLine = '[00:12.00]冷酷な天使のテーゼ'
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: NETEASE_SEARCH_BODY },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({ lrc: { lyric: oneLine } }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('netease')
    expect(result.original).toBe(oneLine)
  })
})

// ---------------------------------------------------------------------------
// 渲染层兜底
// ---------------------------------------------------------------------------

describe('渲染层（T93）：线上是占位 ⇒ 回落内嵌', () => {
  it('线上返回占位 ⇒ `origin = embedded`（内嵌真对白被用上）', async () => {
    const embedded = vi.fn<EmbeddedLyricFetcher>(async () => '[00:02.00]内嵌真对白')
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'migu',
      original: PLACEHOLDER_LRC,
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external,
      embedded,
    })
    expect(result.origin).toBe('embedded')
    expect(result.entries[0]?.content).toBe('[00:02.00]内嵌真对白')
  })

  it('线上是**短的真歌词** ⇒ 仍然用线上的（**压根不查内嵌**）', async () => {
    const embedded = vi.fn<EmbeddedLyricFetcher>(async () => '[00:02.00]内嵌真对白')
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]线上原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:08.00]NAS歌词')]),
      external,
      embedded,
    })
    expect(result.origin).toBe('external')
    expect(embedded).not.toHaveBeenCalled()
  })
})
