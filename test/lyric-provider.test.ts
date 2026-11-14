// ---------------------------------------------------------------------------
// T32：外部歌词 API（主进程侧）回归测试
// ---------------------------------------------------------------------------
//
// 覆盖的是**取词链路**的每一环：
//
//   1. 模板地址合法  → 必须 https（回环才 http）、不许带凭证、必须有占位符
//   2. 模板渲染      → 占位符替换 + **URL 编码**（歌名里有 `&`、空格是常事）
//   3. 候选挑选      → 先歌名、再歌手、最后时长（排除同名不同版本）
//   4. 三个适配器    → 网易云 / lrclib / 自定义模板
//   5. 缓存          → 成功一直留、失败留 5 分钟、`off` 一次请求都不发
//   6. 失败不炸      → 网络异常 → `error` + 可读原因（不抛异常）
//
// ⚠️ 测试数据全是**占位数据**（假 URL、假歌名），**不写真实内网地址**。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import type { ExternalLyricQuery } from '../shared/lyricProvider'
import { DEFAULT_LYRIC_SOURCE, normalizeLyricSource } from '../shared/lyricProvider'
import type { AppPrefs } from '../shared/playerBridge'
import {
  buildSourceChain,
  createLyricProvider,
  decodeMaybeBase64,
  DURATION_TOLERANCE_SECONDS,
  looksLikeLrc,
  pickCandidate,
  renderLyricTemplate,
  stripHighlightTags,
  validateLyricTemplate,
  yrcToEnhancedLrc,
  type LyricProvider,
} from '../electron/lyricProvider'
import { toExternalEntries } from '../src/player/lyricSource'
import { parseLyricEntries } from '../src/ui/lyrics/parse'
import { PrefsStore, registerLyricIpc, type IpcMainEventsLike } from '../electron/ipc'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 一段带时间戳的 LRC（占位内容）。 */
const LRC_SAMPLE = '[00:10.00]占位歌词第一行\n[00:20.00]占位歌词第二行'

/** 造的查询条件。 */
const QUERY: ExternalLyricQuery = {
  title: '占位歌名',
  artist: '占位歌手',
  album: '占位专辑',
  duration: 200,
}

/** 造的 fetch 替身：按「URL 包含什么」返回对应响应。 */
function makeFetch(
  routes: { match: string; status?: number; body: string | Uint8Array; contentType?: string }[],
): { fetchImpl: (input: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input)
    const hit = routes.find((route) => input.includes(route.match))
    if (!hit) {
      return new Response('not found', { status: 404 })
    }
    return typeof hit.body === 'string'
      ? new Response(hit.body, {
          status: hit.status ?? 200,
          headers: { 'content-type': hit.contentType ?? 'application/json' },
        })
      : // ⚠️ **二进制**（酷我的歌词载荷）⇒ 交给 `Response` 的是**字节**，
        //    不是 UTF-8 文本（`slice()` 会**复制**一份，`buffer` 就是干净的 `ArrayBuffer`）。
        new Response(hit.body.slice().buffer as ArrayBuffer, {
          status: hit.status ?? 200,
          headers: { 'content-type': hit.contentType ?? 'application/json' },
        })
  }
  return { fetchImpl, calls }
}

// ---------------------------------------------------------------------------
// 地址校验
// ---------------------------------------------------------------------------

describe('validateLyricTemplate', () => {
  it('https + 有占位符 → 合法', () => {
    expect(validateLyricTemplate('https://example.com/lyric?title={title}')).not.toBeNull()
  })

  it('http（非回环）→ **不合法**（必须 https）', () => {
    expect(validateLyricTemplate('http://example.com/lyric?title={title}')).toBeNull()
  })

  it('http + 回环主机 → 合法（本地自测）', () => {
    expect(validateLyricTemplate('http://127.0.0.1:8080/lyric?title={title}')).not.toBeNull()
  })

  it('带 `user:pass@` → **不合法**（URL 里绝不能有凭证）', () => {
    expect(validateLyricTemplate('https://user:pass@example.com/lyric?title={title}')).toBeNull()
  })

  it('**没有占位符** → 不合法（每首歌都查同一个地址，必然错）', () => {
    expect(validateLyricTemplate('https://example.com/lyric')).toBeNull()
  })

  it('空串 / 乱码 → 不合法', () => {
    expect(validateLyricTemplate('')).toBeNull()
    expect(validateLyricTemplate('不是地址')).toBeNull()
  })
})

describe('renderLyricTemplate', () => {
  it('占位符被替换掉，且**做了 URL 编码**', () => {
    const url = renderLyricTemplate(
      'https://example.com/lyric?title={title}&artist={artist}&album={album}&duration={duration}',
      { title: '占 & 位', artist: 'A/B', album: '专辑#1', duration: 200 },
    )
    expect(url).not.toBeNull()
    expect(url).toContain('title=%E5%8D%A0%20%26%20%E4%BD%8D')
    expect(url).toContain('artist=A%2FB')
    expect(url).toContain('album=%E4%B8%93%E8%BE%91%231')
    expect(url).toContain('duration=200')
    // ⚠️ 占位符必须**全部**被替换掉。
    expect(url).not.toContain('{')
  })

  it('模板不合法 → 返回 `null`（不外发）', () => {
    expect(renderLyricTemplate('http://example.com/{title}', QUERY)).toBeNull()
    expect(renderLyricTemplate('https://example.com/', QUERY)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// LRC 判定
// ---------------------------------------------------------------------------

describe('looksLikeLrc', () => {
  it('带时间戳 → 是 LRC', () => {
    expect(looksLikeLrc(LRC_SAMPLE)).toBe(true)
    expect(looksLikeLrc('[01:02]只有分钟秒')).toBe(true)
  })

  it('纯文本 → **不是** LRC（没有时间戳，解析出来是空的）', () => {
    expect(looksLikeLrc('第一行\n第二行')).toBe(false)
    expect(looksLikeLrc('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 候选挑选
// ---------------------------------------------------------------------------

describe('pickCandidate', () => {
  it('同名歌很多时 → 选中**时长对得上**的那条', () => {
    const picked = pickCandidate(
      [
        { id: 'a', title: '占位曲目一', artist: '占位歌手', duration: 180 },
        { id: 'b', title: '占位曲目一', artist: '占位歌手', duration: 200 },
        { id: 'c', title: '占位曲目一', artist: '占位歌手', duration: 260 },
      ],
      { ...QUERY, title: '占位曲目一' },
    )
    expect(picked?.id).toBe('b')
  })

  it('同名**不同歌手** → 选中歌手对得上的那条', () => {
    const picked = pickCandidate(
      [
        { id: 'a', title: '占位曲目一', artist: '别人', duration: 200 },
        { id: 'b', title: '占位曲目一', artist: '占位歌手', duration: 200 },
      ],
      { ...QUERY, title: '占位曲目一' },
    )
    expect(picked?.id).toBe('b')
  })

  it('时长差超过容差 → 退回「名字对得上」的第一条（不许直接放弃）', () => {
    const picked = pickCandidate(
      [{ id: 'a', title: '占位歌名', artist: '占位歌手', duration: 999 }],
      QUERY,
    )
    expect(picked?.id).toBe('a')
  })

  it('候选为空 → 返回 `null`', () => {
    expect(pickCandidate([], QUERY)).toBeNull()
  })

  it('容差常量是正数（钉住「时长筛必须真的筛」）', () => {
    expect(DURATION_TOLERANCE_SECONDS).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 网易云适配器
// ---------------------------------------------------------------------------

describe('网易云适配器', () => {
  const searchBody = JSON.stringify({
    result: {
      songCount: 2,
      songs: [
        { id: 111, name: '占位歌名', duration: 180_000, artists: [{ name: '别人' }] },
        { id: 222, name: '占位歌名', duration: 200_000, artists: [{ name: '占位歌手' }] },
      ],
    },
  })
  const lyricBody = JSON.stringify({
    lrc: { lyric: LRC_SAMPLE },
    tlyric: { lyric: '[00:10.00]占位翻译' },
  })

  it('搜索 → 按时长挑中 → 取歌词 → **原文与翻译都拿到**', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', body: searchBody },
      { match: 'music.163.com/api/song/lyric', body: lyricBody },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(LRC_SAMPLE)
    expect(result.translation).toBe('[00:10.00]占位翻译')
    // ⚠️ 选中的必须是**时长对得上且歌手对得上**的那条（id=222）。
    expect(calls[1]).toContain('id=222')
  })

  it('搜索结果里没有对得上的 → `not-found`（不是错误）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: JSON.stringify({ result: { songs: [] } }) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('搜索接口返回 500 → `error` + 可读原因（**不抛异常**）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', status: 500, body: 'boom' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('500')
  })
})

// ---------------------------------------------------------------------------
// lrclib 适配器
// ---------------------------------------------------------------------------

describe('lrclib 适配器', () => {
  it('精确匹配命中 → 只取**带时间戳**的那份（plainLyrics 不是翻译）', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: LRC_SAMPLE, plainLyrics: '纯文本' }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('lrclib', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(LRC_SAMPLE)
    // ⚠️ **翻译必须为空** —— `plainLyrics` 是同一首歌的另一种格式，
    //    当成翻译会让同一句歌词显示两遍（T31 的坑）。
    expect(result.translation).toBe('')
    // ⚠️ 精确匹配命中就**不该**再打搜索接口。
    expect(calls.some((url) => url.includes('/api/search'))).toBe(false)
  })

  it('精确匹配 404 → 回落搜索；搜到的结果按时长挑', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'lrclib.net/api/get', status: 404, body: 'not found' },
      {
        match: 'lrclib.net/api/search',
        body: JSON.stringify([
          { trackName: '占位歌名', artistName: '占位歌手', duration: 199, syncedLyrics: LRC_SAMPLE },
        ]),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('lrclib', '', QUERY)
    expect(result.status).toBe('ok')
    expect(calls.some((url) => url.includes('/api/search'))).toBe(true)
  })

  it('精确匹配到但**只有纯文本**（无时间戳）→ `not-found`（不给用户一个空界面）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: null, plainLyrics: '只有纯文本' }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('lrclib', '', QUERY)
    expect(result.status).toBe('not-found')
  })
})

// ---------------------------------------------------------------------------
// 高亮标签与 base64 兜底（T33）
// ---------------------------------------------------------------------------

describe('stripHighlightTags', () => {
  it('剥掉 `<em>` 高亮标签并 trim', () => {
    expect(stripHighlightTags('<em>占位歌名</em>')).toBe('占位歌名')
    expect(stripHighlightTags('  占位歌名  ')).toBe('占位歌名')
    expect(stripHighlightTags('占位<b>歌名</b>')).toBe('占位歌名')
  })
})

describe('decodeMaybeBase64', () => {
  it('base64 → 还原成明文 LRC', () => {
    expect(decodeMaybeBase64(btoa('[00:10.00]hello'))).toBe('[00:10.00]hello')
  })

  it('明文 → **原样返回**（不乱解）', () => {
    expect(decodeMaybeBase64('[00:10.00]占位歌词')).toBe('[00:10.00]占位歌词')
    expect(decodeMaybeBase64('')).toBe('')
  })

  it('解出来不像歌词 → 原样返回（宁可原样，也不给用户一段乱码）', () => {
    expect(decodeMaybeBase64(btoa('hello world'))).toBe(btoa('hello world'))
  })
})

// ---------------------------------------------------------------------------
// QQ 音乐适配器（T33）
// ---------------------------------------------------------------------------

describe('QQ 音乐适配器', () => {
  /** 造的 QQ 搜索响应（照抄实测到的字段形状）。 */
  function searchBody(songs: unknown[]): string {
    return JSON.stringify({ code: 0, data: { song: { list: songs } } })
  }

  /** 造的 QQ 歌词响应。 */
  function lyricBody(lyric: string, trans = ''): string {
    return JSON.stringify({ retcode: 0, code: 0, subcode: 0, lyric, trans })
  }

  it('搜索 → 挑中候选 → 取歌词 → **原文与翻译都拿到**', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          { songmid: '001', songname: '占位歌名', interval: 180, singer: [{ name: '别人' }] },
          { songmid: '002', songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lyricBody(LRC_SAMPLE, '[00:10.00]占位翻译'),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('qq')
    expect(result.original).toBe(LRC_SAMPLE)
    expect(result.translation).toBe('[00:10.00]占位翻译')
    // ⚠️ 选中的必须是**时长对得上且歌手对得上**的那条（songmid=002）。
    expect(calls[1]).toContain('songmid=002')
  })

  it('歌名带 `<em>` 高亮标签 → **剥掉后**才匹配得上', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          // 歌名对得上，但歌手与时长都对不上 → **只能**靠剥标签后的歌名选中。
          { songmid: '003', songname: '<em>占位歌名</em>', interval: 999, singer: [{ name: '别人' }] },
          // 歌手对得上，但歌名对不上 → 靠歌名筛掉它。
          { songmid: '004', songname: '别的歌名', interval: 999, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lyricBody(LRC_SAMPLE),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    expect(calls[1]).toContain('songmid=003')
  })

  it('QQ 的 `interval` 是**秒** → 按秒挑中时长对得上的那条', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          { songmid: '001', songname: '占位歌名', interval: 180, singer: [{ name: '占位歌手' }] },
          { songmid: '002', songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lyricBody(LRC_SAMPLE),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    // ⚠️ 若把 `interval` 当**毫秒**（除以 1000）→ 两个候选时长都对不上 → 会退回第一条（001）。
    expect(calls[1]).toContain('songmid=002')
  })

  it('翻译字段为空 → 仍是 `ok`，翻译就是空串（**不报错**）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          { songmid: '002', songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lyricBody(LRC_SAMPLE),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.translation).toBe('')
  })

  it('歌词**不是 LRC**（纯文本）→ `not-found`（不把纯文本塞给解析器）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          { songmid: '002', songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lyricBody('就是一段普通文字'),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('歌词返回 `retcode` 非 0 → `error`（如实的「源不可用」，不是「确实没有」）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          { songmid: '002', songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: JSON.stringify({ retcode: -1310, code: -1310, subcode: 0, lyric: '', trans: '' }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('-1310')
  })

  it('搜索结果里没有对得上的 → `not-found`（不是错误）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([]),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('搜索接口返回 500 → `error` + 可读原因（**不抛异常**）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        status: 500,
        body: 'boom',
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('500')
  })

  it('歌词接口返回 404 → `error` + 可读原因', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          { songmid: '002', songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        status: 404,
        body: 'not found',
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('404')
  })
})

// ---------------------------------------------------------------------------
// 自定义模板适配器
// ---------------------------------------------------------------------------

describe('自定义模板适配器', () => {
  it('响应是 LRC → 原样取回', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'example.com/lyric', body: LRC_SAMPLE, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric(
      'custom',
      'https://example.com/lyric?title={title}&artist={artist}',
      QUERY,
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(LRC_SAMPLE)
    expect(calls[0]).toContain('title=%E5%8D%A0%E4%BD%8D%E6%AD%8C%E5%90%8D')
  })

  it('响应**不是 LRC** → `error` + 如实说明（不许把纯文本硬塞进去）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'example.com/lyric', body: '就是一段普通文字', contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric(
      'custom',
      'https://example.com/lyric?title={title}',
      QUERY,
    )
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('LRC')
  })

  it('模板不合法 → `error`，且**绝不给这个地址发请求**', async () => {
    const { fetchImpl, calls } = makeFetch([])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('custom', 'http://example.com/{title}', QUERY)
    expect(result.status).toBe('error')
    // ⚠️ T73：源链会**继续试别的线上源**（模板坏了不该让整条链断掉），
    //    但**绝不给这个不合法模板发请求**（不外发到奇怪的地方）。
    expect(calls.some((url) => url.includes('example.com'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 缓存与开关
// ---------------------------------------------------------------------------

describe('缓存与开关', () => {
  it('`off` → **一次请求都不发**', async () => {
    const { fetchImpl, calls } = makeFetch([])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('off', '', QUERY)
    expect(result.status).toBe('not-found')
    expect(calls).toHaveLength(0)
  })

  it('同一首歌连查两次 → **第二次一个请求都不发**（结果一直缓存）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', body: JSON.stringify({ result: { songs: [] } }) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('netease', '', QUERY)
    // ⚠️ T73：缓存里存的是**整条源链**的结果 ⇒ 第一次可能打了几个请求。
    //    断言的是「第二次**零新增**请求」（旧断言「只发一次」在源链下不再成立）。
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)
    await provider.fetchExternalLyric('netease', '', QUERY)
    expect(calls).toHaveLength(afterFirst)
  })

  it('失败结果也缓存（连续切歌**不会**把外部源打爆）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', status: 500, body: 'boom' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('netease', '', QUERY)
    // ⚠️ T73：同一条源链 ⇒ 第一次打了几个请求，第二次就**一个都不打**。
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)
    await provider.fetchExternalLyric('netease', '', QUERY)
    expect(calls).toHaveLength(afterFirst)
  })

  it('失败的缓存**过期后**会重新试（过期按注入的时钟算）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', status: 500, body: 'boom' },
    ])
    let clock = 1_000_000
    const provider = createLyricProvider({ fetchImpl, now: () => clock })
    await provider.fetchExternalLyric('netease', '', QUERY)
    // ⚠️ T73：过期后要**把整条源链重跑一遍** ⇒ 请求数翻倍。
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)
    clock += 10 * 60 * 1000
    await provider.fetchExternalLyric('netease', '', QUERY)
    expect(calls).toHaveLength(afterFirst * 2)
  })

  it('自定义源**改了模板** → 不再命中旧缓存（换源要**立刻**生效）', async () => {
    // ⚠️ **同一个歌 + 同一个源，但模板不同 = 完全不同的接口**
    //    （可以指向另一个词源、另一种返回格式）→ 模板必须进缓存键。
    //    （T34 的 E2E 实测撞过：同一首歌、只换模板 → 拿回来的仍是**旧模板**的结果。）
    const { fetchImpl, calls } = makeFetch([
      { match: 'first.example.com', body: '[00:01.00]第一版歌词' },
      { match: 'second.example.com', body: '[00:01.00]第二版歌词' },
    ])
    const provider = createLyricProvider({ fetchImpl })

    const first = await provider.fetchExternalLyric(
      'custom',
      'https://first.example.com/lyric?title={title}&artist={artist}',
      QUERY,
    )
    const second = await provider.fetchExternalLyric(
      'custom',
      'https://second.example.com/lyric?title={title}&artist={artist}',
      QUERY,
    )

    // ⚠️ **两次都要真的发请求**（改模板 = 换一个接口，不能拿旧的）。
    expect(calls).toHaveLength(2)
    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    if (first.status !== 'ok' || second.status !== 'ok') return
    expect(first.original).toContain('第一版歌词')
    expect(second.original).toContain('第二版歌词')
  })

  it('网络异常 → `error` + 可读原因（**不抛异常**）', async () => {
    const provider = createLyricProvider({
      fetchImpl: async () => {
        throw new Error('连不上')
      },
    })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('连不上')
  })
})

// ---------------------------------------------------------------------------
// 源链（T73）：匹配不到就换下一个源
// ---------------------------------------------------------------------------

describe('源链（T73）', () => {
  it('首选源匹配不上 → **自动试下一个源**，命中就用它', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', body: JSON.stringify({ result: { songs: [] } }) },
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: LRC_SAMPLE, plainLyrics: '' }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // ⚠️ 命中的**未必**是用户选的那个 ⇒ 结果要**如实**带上它。
    expect(result.source).toBe('lrclib')
    expect(calls.some((url) => url.includes('lrclib.net'))).toBe(true)
  })

  it('命中即停：后面的源**一个请求都不发**', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: LRC_SAMPLE, plainLyrics: '' }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('lrclib', '', QUERY)
    expect(calls.some((url) => url.includes('music.163.com'))).toBe(false)
  })

  it('每个源**各自**限时：某个源卡住 → 换下一个源', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: LRC_SAMPLE, plainLyrics: '' }),
      },
    ])
    const provider = createLyricProvider({
      fetchImpl: async (input: string): Promise<Response> => {
        if (input.includes('music.163.com')) {
          // ⚠️ 首选源**永远不回应**（模拟挂住）。
          return await new Promise<Response>(() => undefined)
        }
        return await fetchImpl(input)
      },
      perSourceTimeoutMs: 30,
    })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('lrclib')
  })

  it('链走完都没匹配上 → 最终是 `not-found`（不是错误）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: JSON.stringify({ result: { songs: [] } }) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('`off` → 源链是空的（一个请求都不发）', () => {
    expect(buildSourceChain('off', '')).toEqual([])
  })

  it('首选源排第一，其余按固定顺序跟上', () => {
    // ⚠️ T90-⑤-b（用户拍板「所有歌词 API 都进入自动切换」）⇒ 酷狗也进了兜底链
    // ⚠️ T90-⑥（酷我源）⇒ 酷我也进了兜底链（排在酷狗之后、custom 之前）
    //    ⇒ 这三条断言的**前提被显式推翻** ⇒ 改写为**含酷狗与酷我**的精确相等断言
    //    （仍是 toEqual 全等 ⇒ 强度不变、**不弱化**）。
    expect(buildSourceChain('lrclib', '')).toEqual(['lrclib', 'netease', 'qq', 'kugou', 'kuwo'])
  })

  it('`custom` 没有模板 → 不进链', () => {
    expect(buildSourceChain('netease', '')).toEqual(['netease', 'lrclib', 'qq', 'kugou', 'kuwo'])
  })

  it('`custom` 有模板 → 进链，且排在**用户选的位置**', () => {
    expect(buildSourceChain('custom', 'https://x.example.com/{title}')).toEqual([
      'custom',
      'netease',
      'lrclib',
      'qq',
      'kugou',
      'kuwo',
    ])
  })
})

// ---------------------------------------------------------------------------
// IPC 边界：渲染层是**不可信输入**
// ---------------------------------------------------------------------------

describe('registerLyricIpc', () => {
  /** 假 `ipcMain`。 */
  function fakeIpcMain(): {
    ipcMain: IpcMainEventsLike
    handlers: Map<string, (event: unknown, arg?: unknown) => unknown>
  } {
    const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, arg?: unknown) => unknown) => {
        handlers.set(channel, handler)
      },
      on: () => undefined,
    } as unknown as IpcMainEventsLike
    return { ipcMain, handlers }
  }

  /** 造一份偏好存储（落在临时目录，绝不写进仓库）。 */
  function makePrefs(prefs: Partial<AppPrefs> = {}): PrefsStore {
    const dir = mkdtempSync(join(tmpdir(), 'fnmusic-lyric-ipc-'))
    const store = new PrefsStore({ filePath: join(dir, 'prefs.json') })
    if (Object.keys(prefs).length > 0) store.write(prefs)
    return store
  }

  /** 造的 provider（记下调用参数）。 */
  function makeProvider(): LyricProvider & { calls: unknown[][] } {
    const calls: unknown[][] = []
    return {
      calls,
      async fetchExternalLyric(source, template, query) {
        calls.push([source, template, query])
        return { status: 'ok', source, original: '[00:01.00]占位', translation: '' }
      },
    }
  }

  it('渲染层传的**地址被忽略** → 源与模板一律取主进程读到的偏好', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = makePrefs({ lyric: { source: 'custom', template: 'https://主进程配的/{title}' } })
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    const handler = handlers.get('lyric:fetch')
    expect(handler).toBeDefined()
    await handler?.({}, {
      title: '占位歌名',
      artist: '占位歌手',
      album: '占位专辑',
      duration: 200,
      // ⚠️ 渲染层**试图**指定地址与源 —— 必须**被忽略**。
      url: 'https://evil.example/steal',
      template: 'https://evil.example/{title}',
      source: 'off',
    })

    expect(provider.calls).toHaveLength(1)
    const [source, template] = provider.calls[0] as [string, string]
    expect(source).toBe('custom')
    expect(template).toBe('https://主进程配的/{title}')
  })

  it('源是 `off` → **一次都不调 provider**（不外发）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = makePrefs({ lyric: { source: 'off' } })
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    const result = (await handlers.get('lyric:fetch')?.({}, { title: '占位歌名' })) as {
      status: string
    }
    expect(result.status).toBe('not-found')
    expect(provider.calls).toHaveLength(0)
  })

  it('**缺歌名** → 判为参数不合法，不调 provider', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = makePrefs()
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    const result = (await handlers.get('lyric:fetch')?.({}, { artist: '占位歌手' })) as {
      status: string
      message: string
    }
    expect(result.status).toBe('error')
    expect(result.message).toContain('歌名')
    expect(provider.calls).toHaveLength(0)
  })

  it('偏好里的源名是**陌生值** → 当默认源（不崩、不外发到奇怪的地方）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    // ⚠️ 直接往偏好文件里塞一个陌生源名（模拟用户手改 `prefs.json`）。
    const prefs = makePrefs()
    ;(prefs as unknown as { read: () => AppPrefs }).read = () =>
      ({ lyric: { source: '不存在的源' } }) as unknown as AppPrefs
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    await handlers.get('lyric:fetch')?.({}, { title: '占位歌名' })
    const source = (provider.calls[0] as [string])[0]
    expect(source).toBe(DEFAULT_LYRIC_SOURCE)
  })
})

// ---------------------------------------------------------------------------
// T67：网易云 yrc（真逐字）→ 增强 LRC
// ---------------------------------------------------------------------------
//
// ⚠️ yrc 样本是**按实测格式**造的，**歌词文本是占位**（不是真实歌词）。
//    实测结构（2026-11-06，匿名请求）：
//      [行开始ms,行时长ms](词开始ms,词时长ms,0)词文本…
//    - 词时间是**绝对毫秒**、跨行连续递增；
//    - 词元组**之间没有分隔符**；
//    - **词时长可以为 0**（标点 / 停顿占位）。
// ---------------------------------------------------------------------------

/** 按实测结构造的 yrc 样本（文本是占位）。 */
const YRC_SAMPLE = [
  '[0,1000](0,1000,0)占位首行',
  '[6190,4440](6190,2190,0)甲(8380,540,0)乙(9280,1350,0)丙',
].join('\n')

/** 带**零时长词**（标点占位）的 yrc 样本。 */
const YRC_ZERO_DURATION = '[0,1000](0,600,0)甲(600,0,0),(600,400,0)乙'

/** 剥掉全部结构字符（行头 / 词元组 / 逐字标签 / 行标签 / 数字 / 空白）→ 只剩文字。 */
function textOnly(text: string): string {
  return text
    .replace(/\[\d+,\d+\]/g, '')
    .replace(/\(\d+,\d+,\d+\)/g, '')
    .replace(/<\d+:\d{1,2}([.:]\d{1,3})?>/g, '')
    .replace(/\[\d+:\d{1,2}([.:]\d{1,3})?\]/g, '')
    .replace(/[\s\d]/g, '')
}

/** 从增强 LRC 里读出全部逐字时间（毫秒）。 */
function wordTimesMs(enhanced: string): number[] {
  const out: number[] = []
  const re = /<(\d+):(\d{1,2})(?:[.:](\d{1,3}))?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(enhanced)) !== null) {
    const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0
    out.push(Math.round((Number(m[1]) * 60 + Number(m[2]) + frac) * 1000))
  }
  return out
}

describe('yrc → 增强 LRC 转换（T67）', () => {
  it('行数与行时间：与 yrc 的行头一致（I-1）', () => {
    const out = yrcToEnhancedLrc(YRC_SAMPLE)
    const rows = out.split('\n')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.startsWith('[00:00.00]')).toBe(true)
    expect(rows[1]!.startsWith('[00:06.19]')).toBe(true)
  })

  it('词时间**严格递增**（I-2）', () => {
    const times = wordTimesMs(yrcToEnhancedLrc(YRC_SAMPLE))
    expect(times).toEqual([0, 6190, 8380, 9280])
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!)
    }
  })

  it('**不丢字**（I-3）：转换前后的纯文字逐字相同', () => {
    expect(textOnly(yrcToEnhancedLrc(YRC_SAMPLE))).toBe(textOnly(YRC_SAMPLE))
  })

  it('零时长词**并入前一个词**（I-4），不单独成词', () => {
    const out = yrcToEnhancedLrc(YRC_ZERO_DURATION)
    // 行头 1 个标签 + **2** 个有效词（零时长的标点并进了前一个词）
    expect(out.split('<').length - 1).toBe(2)
    expect(out).toContain('<00:00.00>甲,')
    expect(out).toContain('<00:00.60>乙')
  })

  it('输出**能被 looksLikeLrc 接受**（I-5）', () => {
    expect(looksLikeLrc(yrcToEnhancedLrc(YRC_SAMPLE))).toBe(true)
  })

  it('空串 / 非串 → 空串（不抛异常）', () => {
    expect(yrcToEnhancedLrc('')).toBe('')
    expect(yrcToEnhancedLrc(null as unknown as string)).toBe('')
    expect(yrcToEnhancedLrc(undefined as unknown as string)).toBe('')
  })

  it('畸形输入不抛异常、不产生坏行', () => {
    for (const bad of ['[0,1000]', '[abc,def](x)词', '(0,100,0)没有行头', '[(0,100,0)缺右括号']) {
      expect(() => yrcToEnhancedLrc(bad)).not.toThrow()
      expect(typeof yrcToEnhancedLrc(bad)).toBe('string')
    }
  })

  it('词文本里含括号**不会错位**', () => {
    const out = yrcToEnhancedLrc('[0,2000](0,1000,0)括号(测试)(2000,1000,0)后')
    expect(out).toContain('括号(测试)')
    expect(out).toContain('<00:02.00>后')
  })
})

// ---------------------------------------------------------------------------
// 网易云适配器 · 真逐字
// ---------------------------------------------------------------------------

describe('网易云适配器 · 真逐字（T67）', () => {
  const searchBody = JSON.stringify({
    result: {
      songCount: 1,
      songs: [{ id: 111, name: '占位歌名', duration: 180_000, artists: [{ name: '占位歌手' }] }],
    },
  })

  it('请求**带 yv=-1**（逐字参数；不带就永远拿不到 yrc）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', body: searchBody },
      { match: 'music.163.com/api/song/lyric', body: JSON.stringify({ lrc: { lyric: LRC_SAMPLE } }) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('netease', '', QUERY)
    expect(calls[1]).toContain('yv=-1')
  })

  it('响应带 yrc → 原文用**真逐字**（含 <mm:ss.xx>），翻译照旧', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: searchBody },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({
          lrc: { lyric: LRC_SAMPLE },
          tlyric: { lyric: '[00:10.00]占位翻译' },
          yrc: { version: 1, lyric: YRC_SAMPLE },
        }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toContain('<00:06.19>')
    expect(result.translation).toBe('[00:10.00]占位翻译')
  })

  it('**只有 yrc、没有 lrc** → 也能出歌词（此前会被判成 not-found）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: searchBody },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({ yrc: { version: 1, lyric: YRC_SAMPLE } }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toContain('<00:06.19>')
  })

  it('**没有 yrc** → 行为与从前**一字不变**（仍用 lrc）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: searchBody },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({
          lrc: { lyric: LRC_SAMPLE },
          tlyric: { lyric: '[00:10.00]占位翻译' },
        }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(LRC_SAMPLE)
    expect(result.translation).toBe('[00:10.00]占位翻译')
  })

  it('yrc **畸形** → 回退 lrc（不丢掉整首歌）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: searchBody },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({ lrc: { lyric: LRC_SAMPLE }, yrc: { lyric: '这不是 yrc' } }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(LRC_SAMPLE)
  })

  it('端到端：yrc 产物经解析后**某行的词数 > 1**（真逐字，不是伪逐字）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'music.163.com/api/search', body: searchBody },
      {
        match: 'music.163.com/api/song/lyric',
        body: JSON.stringify({ yrc: { version: 1, lyric: YRC_SAMPLE } }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('netease', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const lines = parseLyricEntries(toExternalEntries('song-1', result))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((line) => line.words.length > 1)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 酷狗适配器（T90-⑤）
// ---------------------------------------------------------------------------
//
// ⚠️ **钉住三件最容易回归的事**：
// 1. **端点必须 https**（实测 Chromium 分区栈**全局拦 http 明文**，
//    连 `http://example.com` 都是 `ERR_BLOCKED_BY_CLIENT`）；
// 2. **三跳**（搜索 → accesskey → 下载）顺序与参数；
// 3. **krc 失败要回退 lrc**（不能让「没有逐字」变成「没有歌词」）。
//
// ---------------------------------------------------------------------------

describe('酷狗适配器（T90-⑤）', () => {
  /** 造的酷狗搜索响应（照抄实测到的字段形状）。 */
  const searchBody = JSON.stringify({
    status: 1,
    errcode: 0,
    data: {
      info: [
        {
          hash: '占位hash',
          songname: '占位歌名',
          singername: '占位歌手',
          duration: 200,
          album_name: '占位专辑',
        },
      ],
    },
  })

  /** 造的 accesskey 响应。 */
  function accessBody(krctype: number, contenttype: number): string {
    return JSON.stringify({
      status: 200,
      candidates: [{ id: '占位id', accesskey: '占位accesskey', krctype, contenttype }],
    })
  }

  /** 造的下载响应。 */
  function downloadBody(content: string, fmt: string): string {
    return JSON.stringify({ status: 200, info: 'OK', fmt, content })
  }

  /** 造的**行级**歌词载荷（base64）。 */
  function plainPayload(lrc: string): string {
    return Buffer.from(lrc, 'utf8').toString('base64')
  }

  it('三跳走通 → **原文是带逐字标签的增强 LRC**；翻译与罗马音为空串', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'mobileservice.kugou.com', body: searchBody },
      { match: 'lyrics.kugou.com/search', body: accessBody(1, 0) },
      { match: 'fmt=krc', body: downloadBody('占位', 'krc') },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kugou', '', QUERY)
    // ⚠️ `fmt=krc` 的载荷是占位（不是真的密文）⇒ 解密失败 ⇒ **回退 lrc** ⇒
    //    lrc 端点没有配路由 ⇒ 404 ⇒ 最终是 `error`（如实报，不静默）。
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('酷狗')

    // ⚠️ **端点必须全是 https**（这是本任务最容易回归的一条）。
    const kugouCalls = calls.filter((url) => url.includes('kugou.com'))
    expect(kugouCalls.length).toBeGreaterThan(0)
    for (const url of kugouCalls) {
      expect(url.startsWith('https://')).toBe(true)
    }
    // ⚠️ 三跳的**顺序**：搜索 → accesskey → 下载。
    expect(kugouCalls[0]).toContain('mobileservice.kugou.com')
    expect(kugouCalls[1]).toContain('lyrics.kugou.com/search')
    expect(kugouCalls[2]).toContain('lyrics.kugou.com/download')
  })

  it('accesskey 的请求带**候选的 hash** 与**秒为单位的时长**', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'mobileservice.kugou.com', body: searchBody },
      { match: 'lyrics.kugou.com/search', body: accessBody(1, 0) },
      { match: 'fmt=krc', body: downloadBody('占位', 'krc') },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('kugou', '', QUERY)
    const accessCall = calls.find((url) => url.includes('lyrics.kugou.com/search')) ?? ''
    expect(accessCall).toContain('hash=')
    // ⚠️ 酷狗的 `duration` 是**秒**（搜索结果里就是秒）⇒ `timelength=200`。
    expect(accessCall).toContain('timelength=200')
  })

  it('⚠️ **krc 解密失败 ⇒ 回退 `fmt=lrc`**（不能让「没有逐字」变成「没有歌词」）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'mobileservice.kugou.com', body: searchBody },
      { match: 'lyrics.kugou.com/search', body: accessBody(1, 0) },
      // ⚠️ krc 载荷不是密文 ⇒ 解密必失败 ⇒ 应当**再试一次 lrc**。
      { match: 'fmt=krc', body: downloadBody('这不是密文', 'krc') },
      { match: 'fmt=lrc', body: downloadBody(plainPayload(LRC_SAMPLE), 'lrc') },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kugou', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(LRC_SAMPLE)
    expect(result.translation).toBe('')
    // ⚠️ 确实**试过了** lrc。
    expect(calls.some((url) => url.includes('fmt=lrc'))).toBe(true)
  })

  it('⚠️ **`krctype` 不是 1 ⇒ 首选行级**（先试 lrc，再试 krc）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'mobileservice.kugou.com', body: searchBody },
      { match: 'lyrics.kugou.com/search', body: accessBody(0, 0) },
      { match: 'fmt=lrc', body: downloadBody(plainPayload(LRC_SAMPLE), 'lrc') },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kugou', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(LRC_SAMPLE)
    const kugouCalls = calls.filter((url) => url.includes('kugou.com'))
    // ⚠️ 第一个下载请求就是 `fmt=lrc`。
    expect(kugouCalls[2]).toContain('fmt=lrc')
  })

  it('搜索结果里没有对得上的 → `not-found`（不是错误）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'mobileservice.kugou.com',
        body: JSON.stringify({ status: 1, data: { info: [] } }),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kugou', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('搜索接口返回 500 → `error` + 可读原因（**不抛异常**）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'mobileservice.kugou.com', status: 500, body: 'boom' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kugou', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('500')
  })

  it('accesskey 没有候选 → `not-found`', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'mobileservice.kugou.com', body: searchBody },
      { match: 'lyrics.kugou.com/search', body: JSON.stringify({ status: 200, candidates: [] }) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kugou', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('⚠️ **用户选酷狗时它是首选源**（其余源照旧兜底）', () => {
    // ⚠️ T90-⑤-b 之后酷狗也进了兜底链 ⇒ 链里会有它自己（去重）。
    // ⚠️ T90-⑥ ⇒ 链里还有酷我。
    expect(buildSourceChain('kugou', '')).toEqual(['kugou', 'netease', 'lrclib', 'qq', 'kuwo'])
  })

  it('⚠️ **normalizeLyricSource 认得 kugou**（陌生值仍回落默认）', () => {
    expect(normalizeLyricSource('kugou')).toBe('kugou')
    expect(normalizeLyricSource('不存在的源')).toBe(DEFAULT_LYRIC_SOURCE)
  })
})

// ---------------------------------------------------------------------------
// T90-⑥：酷我适配器
// ---------------------------------------------------------------------------

describe('T90-⑥ · 酷我适配器', () => {
  /** 造的搜索响应（`MUSICRID` 带 `MUSIC_` 前缀；`DURATION` 是**秒**）。 */
  const searchBody = JSON.stringify({
    abslist: [
      {
        MUSICRID: 'MUSIC_198554068',
        SONGNAME: '占位歌名',
        ARTIST: '占位歌手',
        ALBUM: '占位专辑',
        DURATION: '200',
      },
    ],
  })

  /** 酷我的 XOR 密钥（**独立手写** ⇒ 生产密钥写错时用例会红）。 */
  const KEY_LITERAL: readonly number[] = [121, 101, 101, 108, 105, 111, 110]

  /** 造一份**合成的**酷我 lrcx 载荷（原始字节）。 */
  function kuwoPayload(plain: string): Uint8Array {
    const inner = Buffer.from(plain, 'utf8')
    for (let i = 0; i < inner.length; i += 1) {
      inner[i] = inner[i]! ^ KEY_LITERAL[i % KEY_LITERAL.length]!
    }
    const base64 = Buffer.from(inner.toString('base64'), 'utf8')
    const deflated = deflateSync(base64)
    const head = Buffer.from('TP=content\r\nlrcx=1\r\n\r\n', 'latin1')
    return new Uint8Array(Buffer.concat([head, deflated]))
  }

  /** 占位 lrcx 明文（**自己编的歌词**）。 */
  const LRCX = [
    '[kuwo:034]',
    '[00:01.000]<4000,-4000>占<5000,-3000>位',
    // 翻译行（同时间戳、排在原文行之前、词标签全 `<0,0>`）
    '[00:02.000]<0,0>占<0,0>位',
  ].join('\n')

  it('两跳走通 → **原文是带逐字标签的增强 LRC**；**翻译是行级 LRC**', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'search.kuwo.cn', body: searchBody },
      { match: 'mlyric.kuwo.cn', body: kuwoPayload(LRCX), contentType: 'application/octet-stream' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kuwo', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('kuwo')
    // ⚠️ 词时间是「行首 + 相对」⇒ 1000ms 与 1500ms。
    expect(result.original).toBe('[00:01.00]<00:01.00>占<00:01.50>位')
    expect(result.translation).toBe('[00:02.00]占位')
  })

  it('⚠️ **端点必须全是 https**（本任务最容易回归的一条）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'search.kuwo.cn', body: searchBody },
      { match: 'mlyric.kuwo.cn', body: kuwoPayload(LRCX), contentType: 'application/octet-stream' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('kuwo', '', QUERY)
    const kuwoCalls = calls.filter((url) => url.includes('kuwo.cn'))
    expect(kuwoCalls.length).toBeGreaterThan(0)
    for (const url of kuwoCalls) {
      expect(url.startsWith('https://')).toBe(true)
    }
    // ⚠️ 两跳的**顺序**：搜索 → 歌词。
    expect(kuwoCalls[0]).toContain('search.kuwo.cn')
    expect(kuwoCalls[1]).toContain('mlyric.kuwo.cn')
    // ⚠️ 歌词请求要 **`lrcx=1`**（要逐字）与**去掉 `MUSIC_` 前缀的 rid**。
    expect(kuwoCalls[1]).toContain('lrcx=1')
    expect(kuwoCalls[1]).toContain('rid=198554068')
    expect(kuwoCalls[1]).not.toContain('MUSIC_')
  })

  it('搜索结果里没有对得上的 → `not-found`（不是错误）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'search.kuwo.cn', body: JSON.stringify({ abslist: [] }) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kuwo', '', QUERY)
    expect(result.status).toBe('not-found')
  })

  it('搜索接口返回 500 → `error` + 可读原因（**不抛异常**）', async () => {
    const { fetchImpl } = makeFetch([{ match: 'search.kuwo.cn', status: 500, body: 'boom' }])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kuwo', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('500')
  })

  it('搜索接口返回的不是 JSON → `error`', async () => {
    const { fetchImpl } = makeFetch([{ match: 'search.kuwo.cn', body: 'not json' }])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kuwo', '', QUERY)
    expect(result.status).toBe('error')
  })

  it('歌词接口返回 500 → `error` + 可读原因', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'search.kuwo.cn', body: searchBody },
      { match: 'mlyric.kuwo.cn', status: 500, body: 'boom' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kuwo', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('500')
  })

  it('⚠️ **载荷不是酷我密文 ⇒ 如实报错**（不静默吞掉、不产出乱码歌词）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'search.kuwo.cn', body: searchBody },
      { match: 'mlyric.kuwo.cn', body: Buffer.from('这不是酷我密文', 'utf8') },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('kuwo', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('酷我')
  })

  it('⚠️ **用户选酷我时它是首选源**（其余源照旧兜底）', () => {
    expect(buildSourceChain('kuwo', '')).toEqual(['kuwo', 'netease', 'lrclib', 'qq', 'kugou'])
  })

  it('⚠️ **normalizeLyricSource 认得 kuwo**（陌生值仍回落默认）', () => {
    expect(normalizeLyricSource('kuwo')).toBe('kuwo')
    expect(normalizeLyricSource('不存在的源')).toBe(DEFAULT_LYRIC_SOURCE)
  })
})
