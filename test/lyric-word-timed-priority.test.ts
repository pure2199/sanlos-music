// ---------------------------------------------------------------------------
// T108：轮询所有歌词源，带逐字时间戳的那份优先
// ---------------------------------------------------------------------------
//
// 覆盖三件事：
//
//   1. **逐字判定**（`shared/lyricWordTimed.ts` 的 `hasWordTimedTags`）
//      —— 并且**钉住它与渲染层 `parse.ts` 的口径一致**（漂移会被当场抓住）；
//   2. **选择规则**（`pickBestLyric` / `isUsableLyric` / `isWordTimedLyric`）
//      —— 纯函数，逐条钉死；
//   3. **Provider 端到端**：并发轮询 + 逐字优先 + 早停 + 缓存 + 白名单隔离。
//
// ⚠️ 测试数据全是**占位数据**（假 URL、假歌名），**不写真实内网地址**。
//
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { ExternalLyricQuery, ExternalLyricResult, LyricSource } from '../shared/lyricProvider'
import { hasWordTimedTags } from '../shared/lyricWordTimed'
import {
  buildSourceChain,
  createLyricProvider,
  isUsableLyric,
  isWordTimedLyric,
  pickBestLyric,
  resolveAllowedLyricSources,
  type LyricCandidate,
} from '../electron/lyricProvider'
import { parseEnhancedLrc, parseLyricEntries } from '../src/ui/lyrics/parse'
import type { LyricEntry } from '../src/api/types'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 行级 LRC（只有 `[mm:ss]` ⇒ **没有**逐字）。 */
const PLAIN_LRC = '[00:10.00]占位歌词第一行\n[00:20.00]占位歌词第二行'

/** 逐字 LRC（带 `<mm:ss.xx>` 词级标签）—— 首选源那份。 */
const WORD_LRC_A = '[00:10.00]<00:10.00>逐<00:10.50>字<00:11.00>歌'

/** 逐字 LRC —— 链序更靠后的那份（内容与上面**不同** ⇒ 断言能分出胜负）。 */
const WORD_LRC_B = '[00:30.00]<00:30.00>后<00:30.50>到<00:31.00>的'

/** 咪咕实测返回的那句占位（T93 的起因）。 */
const PLACEHOLDER_LRC = '[00:00.00]此歌曲为纯音乐，请欣赏'

/** 造的查询条件。 */
const QUERY: ExternalLyricQuery = {
  title: '占位歌名',
  artist: '占位歌手',
  album: '占位专辑',
  duration: 200,
}

/** 自定义源的模板（https + 占位符 ⇒ 合法）。 */
const CUSTOM_TEMPLATE = 'https://example.com/lyric?title={title}&artist={artist}'

/**
 * 造的 fetch 替身：按「URL 包含什么」返回对应响应。
 *
 * ⚠️ `delayMs` 用来制造「**后一个源先回**」的情形 ——
 *    用来证明选择是**按链序**的，不是「谁先回谁赢」。
 */
function makeFetch(
  routes: { match: string; body: string; status?: number; contentType?: string; delayMs?: number }[],
): { fetchImpl: (input: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input)
    const hit = routes.find((route) => input.includes(route.match))
    if (!hit) return new Response('not found', { status: 404 })
    if (hit.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, hit.delayMs))
    }
    return new Response(hit.body, {
      status: hit.status ?? 200,
      headers: { 'content-type': hit.contentType ?? 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

/** 造一条候选结果。 */
function candidate(index: number, source: LyricSource, result: ExternalLyricResult): LyricCandidate {
  return { index, source, result }
}

/** 造一个「成功」的结果。 */
function ok(source: LyricSource, original: string): ExternalLyricResult {
  return { status: 'ok', source, original, translation: '' }
}

/** 造一条歌词条目（喂给渲染层的 `parseLyricEntries`）。 */
function entry(content: string): LyricEntry {
  return {
    guid: 'g1',
    source: 'local',
    content,
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset: 0,
  }
}

// ---------------------------------------------------------------------------
// 逐字判定
// ---------------------------------------------------------------------------

describe('hasWordTimedTags（T108）', () => {
  it('行级 LRC（只有 `[mm:ss]`）⇒ **没有**逐字', () => {
    expect(hasWordTimedTags(PLAIN_LRC)).toBe(false)
  })

  it('带 `<mm:ss.xx>` ⇒ **有**逐字', () => {
    expect(hasWordTimedTags(WORD_LRC_A)).toBe(true)
  })

  it('各种小数位写法都认（`.xx` / `.xxx` / `:xx`）', () => {
    expect(hasWordTimedTags('[00:10.00]<00:10.5>词')).toBe(true)
    expect(hasWordTimedTags('[00:10.00]<00:10.500>词')).toBe(true)
    expect(hasWordTimedTags('[00:10.00]<00:10:50>词')).toBe(true)
  })

  it('空串 / 非字符串 ⇒ `false`（不炸）', () => {
    expect(hasWordTimedTags('')).toBe(false)
    expect(hasWordTimedTags(undefined as unknown as string)).toBe(false)
    expect(hasWordTimedTags(null as unknown as string)).toBe(false)
  })

  it('尖括号但**不是**时间标签 ⇒ `false`', () => {
    expect(hasWordTimedTags('[00:10.00]<b>词</b>')).toBe(false)
    expect(hasWordTimedTags('[00:10.00]<3>词')).toBe(false)
  })

  it('⭐ **与渲染层口径一致**：判定结果 = `parseLyricEntries` 解析出的「有没有真逐字行」', () => {
    const samples = [
      PLAIN_LRC,
      WORD_LRC_A,
      WORD_LRC_B,
      '[00:10.00]只有行级\n[00:20.00]第二行',
      '[00:10.00]<00:10.00>逐<00:10.50>字\n[00:20.00]这行没有词级标签',
      '',
    ]
    for (const raw of samples) {
      // 渲染层的两个入口（`parseLrc` 委托给 `parseEnhancedLrc` ⇒ 两者等价）。
      const viaEntries = parseLyricEntries([entry(raw)])
      const viaEnhanced = parseEnhancedLrc(raw)
      const rendererSays = viaEntries.some((line) => line.wordTimed === true)
      const rendererSaysEnhanced = viaEnhanced.some((line) => line.wordTimed === true)
      expect(rendererSays).toBe(hasWordTimedTags(raw))
      expect(rendererSaysEnhanced).toBe(hasWordTimedTags(raw))
    }
  })
})

// ---------------------------------------------------------------------------
// 「用得上」与「带逐字」
// ---------------------------------------------------------------------------

describe('isUsableLyric / isWordTimedLyric（T108）', () => {
  it('`ok` 且原文非空 ⇒ 用得上', () => {
    expect(isUsableLyric(ok('lrclib', PLAIN_LRC))).toBe(true)
  })

  it('`error` / `not-found` ⇒ 用不上', () => {
    expect(isUsableLyric({ status: 'not-found' })).toBe(false)
    expect(isUsableLyric({ status: 'error', message: 'boom' })).toBe(false)
  })

  it('原文是**占位提示** ⇒ 用不上（T93 口径）', () => {
    expect(isUsableLyric(ok('migu', PLACEHOLDER_LRC))).toBe(false)
  })

  it('带逐字 ⇒ 「用得上」**且**带逐字', () => {
    expect(isWordTimedLyric(ok('kugou', WORD_LRC_A))).toBe(true)
    expect(isWordTimedLyric(ok('lrclib', PLAIN_LRC))).toBe(false)
    // ⚠️ 占位歌词**即使**带逐字标签，也**不算**「用得上」。
    expect(isWordTimedLyric(ok('migu', `[00:00.00]<00:00.00>${PLACEHOLDER_LRC}`))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 选择规则（纯函数）
// ---------------------------------------------------------------------------

describe('pickBestLyric（T108）', () => {
  it('**唯一带逐字**的那份胜出（哪怕它链序更靠后）', () => {
    const best = pickBestLyric(
      [candidate(0, 'lrclib', ok('lrclib', PLAIN_LRC)), candidate(3, 'kugou', ok('kugou', WORD_LRC_B))],
      'lrclib',
    )
    expect(best?.status).toBe('ok')
    if (best?.status !== 'ok') return
    expect(best.source).toBe('kugou')
  })

  it('**都带逐字** ⇒ 按**链序**取第一个（不是「谁先回」）', () => {
    const best = pickBestLyric(
      [candidate(0, 'lrclib', ok('lrclib', WORD_LRC_A)), candidate(3, 'kugou', ok('kugou', WORD_LRC_B))],
      'kugou',
    )
    expect(best?.status).toBe('ok')
    if (best?.status !== 'ok') return
    expect(best.source).toBe('lrclib')
  })

  it('**都不带逐字** ⇒ 用**首选源**那份', () => {
    const best = pickBestLyric(
      [candidate(0, 'lrclib', ok('lrclib', PLAIN_LRC)), candidate(3, 'kugou', ok('kugou', PLAIN_LRC))],
      'lrclib',
    )
    expect(best?.status).toBe('ok')
    if (best?.status !== 'ok') return
    expect(best.source).toBe('lrclib')
  })

  it('首选源**不可用** ⇒ 链序第一个可用的', () => {
    const best = pickBestLyric(
      [
        candidate(0, 'lrclib', { status: 'error', message: 'boom' }),
        candidate(1, 'netease', ok('netease', PLAIN_LRC)),
      ],
      'lrclib',
    )
    expect(best?.status).toBe('ok')
    if (best?.status !== 'ok') return
    expect(best.source).toBe('netease')
  })

  it('全都不可用、首选源**报错** ⇒ 报它的错（不是 not-found）', () => {
    const best = pickBestLyric(
      [
        candidate(0, 'lrclib', { status: 'error', message: 'boom' }),
        candidate(1, 'netease', { status: 'not-found' }),
      ],
      'lrclib',
    )
    expect(best?.status).toBe('error')
    if (best?.status !== 'error') return
    expect(best.message).toContain('boom')
  })

  it('全都不可用、首选源只是**没有** ⇒ `null`（调用方补成 not-found）', () => {
    const best = pickBestLyric([candidate(0, 'lrclib', { status: 'not-found' })], 'lrclib')
    expect(best).toBeNull()
  })

  it('**占位歌词**视同没匹配上（不会顶掉别的源）', () => {
    const best = pickBestLyric(
      [
        candidate(0, 'migu', ok('migu', PLACEHOLDER_LRC)),
        candidate(1, 'lrclib', ok('lrclib', PLAIN_LRC)),
      ],
      'migu',
    )
    expect(best?.status).toBe('ok')
    if (best?.status !== 'ok') return
    expect(best.source).toBe('lrclib')
  })
})

// ---------------------------------------------------------------------------
// Provider 端到端
// ---------------------------------------------------------------------------

describe('并发轮询 + 逐字优先（T108）', () => {
  it('**唯一带逐字**的那份胜出（哪怕它链序更靠后）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'lrclib.net/api/get', body: JSON.stringify({ syncedLyrics: PLAIN_LRC, plainLyrics: '' }) },
      { match: 'example.com/lyric', body: WORD_LRC_B, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('lrclib', CUSTOM_TEMPLATE, QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('custom')
    expect(result.original).toBe(WORD_LRC_B)
  })

  it('**都带逐字** ⇒ 按**链序**取第一个（哪怕后面的源**先回**）', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: 'lrclib.net/api/get',
        body: JSON.stringify({ syncedLyrics: WORD_LRC_A, plainLyrics: '' }),
        // ⚠️ 首选源**故意慢一点** ⇒ 若实现是「谁先回谁赢」，这里就会选错。
        delayMs: 40,
      },
      { match: 'example.com/lyric', body: WORD_LRC_B, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('lrclib', CUSTOM_TEMPLATE, QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('lrclib')
    expect(result.original).toBe(WORD_LRC_A)
  })

  it('**都不带逐字** ⇒ 用**首选源**那份', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'lrclib.net/api/get', body: JSON.stringify({ syncedLyrics: PLAIN_LRC, plainLyrics: '' }) },
      { match: 'example.com/lyric', body: PLAIN_LRC, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('lrclib', CUSTOM_TEMPLATE, QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('lrclib')
  })

  it('**轮询** ⇒ 链上**后面的源**也会被问（不再「命中即停」）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'lrclib.net/api/get', body: JSON.stringify({ syncedLyrics: PLAIN_LRC, plainLyrics: '' }) },
      { match: 'example.com/lyric', body: PLAIN_LRC, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('lrclib', CUSTOM_TEMPLATE, QUERY)
    expect(calls.some((url) => url.includes('music.163.com'))).toBe(true)
    expect(calls.some((url) => url.includes('lrclib.net'))).toBe(true)
    expect(calls.some((url) => url.includes('example.com'))).toBe(true)
  })

  it('**占位歌词**仍视同没匹配上 ⇒ 让位给带逐字的那份', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'lrclib.net/api/get', body: JSON.stringify({ syncedLyrics: PLACEHOLDER_LRC, plainLyrics: '' }) },
      { match: 'example.com/lyric', body: WORD_LRC_B, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('lrclib', CUSTOM_TEMPLATE, QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.source).toBe('custom')
  })

  it('同一首歌第二次查 ⇒ **零新增请求**（缓存里存的是轮询后的最佳结果）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'lrclib.net/api/get', body: JSON.stringify({ syncedLyrics: PLAIN_LRC, plainLyrics: '' }) },
      { match: 'example.com/lyric', body: WORD_LRC_B, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('lrclib', CUSTOM_TEMPLATE, QUERY)
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)
    await provider.fetchExternalLyric('lrclib', CUSTOM_TEMPLATE, QUERY)
    expect(calls).toHaveLength(afterFirst)
  })

  it('首选源**报错** ⇒ 仍**报它的错**（T73 语义不变）', async () => {
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
// 白名单隔离（E2E 不打真实外网）
// ---------------------------------------------------------------------------

describe('resolveAllowedLyricSources（T108）', () => {
  it('没给 / 空串 ⇒ `undefined`（**不限制** ⇒ 生产行为一字不变）', () => {
    expect(resolveAllowedLyricSources(undefined)).toBeUndefined()
    expect(resolveAllowedLyricSources(null)).toBeUndefined()
    expect(resolveAllowedLyricSources('')).toBeUndefined()
    expect(resolveAllowedLyricSources('   ')).toBeUndefined()
  })

  it('合法源名 ⇒ 白名单', () => {
    expect(resolveAllowedLyricSources('custom')).toEqual(['custom'])
    expect(resolveAllowedLyricSources('custom,lrclib')).toEqual(['custom', 'lrclib'])
  })

  it('陌生值**丢弃**；全是陌生值 ⇒ 视为「没配」（不锁死用户）', () => {
    expect(resolveAllowedLyricSources('custom,bogus')).toEqual(['custom'])
    expect(resolveAllowedLyricSources('bogus')).toBeUndefined()
  })

  it('`off` **不在**白名单里（那是全局档位，不是兜底源）', () => {
    expect(resolveAllowedLyricSources('off')).toBeUndefined()
  })
})

describe('buildSourceChain + 白名单（T108）', () => {
  it('白名单只限制**兜底源**；**首选源永远在链里**', () => {
    expect(buildSourceChain('lrclib', CUSTOM_TEMPLATE, ['custom'])).toEqual(['lrclib', 'custom'])
    expect(buildSourceChain('lrclib', '', ['lrclib'])).toEqual(['lrclib'])
    expect(buildSourceChain('off', '', ['custom'])).toEqual([])
  })

  it('不传白名单 ⇒ 既有行为一字不变', () => {
    expect(buildSourceChain('netease', '')).toEqual([
      'netease',
      'lrclib',
      'qq',
      'kugou',
      'kuwo',
      'migu',
    ])
  })
})

describe('Provider + 白名单（T108：E2E 隔离公网）', () => {
  it('白名单里的源**会被问**，白名单外的**一个请求都不发**', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'example.com/lyric', body: PLAIN_LRC, contentType: 'text/plain' },
    ])
    const provider = createLyricProvider({ fetchImpl, allowedSources: ['custom'] })
    const result = await provider.fetchExternalLyric('custom', CUSTOM_TEMPLATE, QUERY)
    expect(result.status).toBe('ok')
    expect(calls.every((url) => url.includes('example.com'))).toBe(true)
  })
})
