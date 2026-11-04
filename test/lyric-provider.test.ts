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

import type { ExternalLyricQuery } from '../shared/lyricProvider'
import { DEFAULT_LYRIC_SOURCE } from '../shared/lyricProvider'
import type { AppPrefs } from '../shared/playerBridge'
import {
  createLyricProvider,
  DURATION_TOLERANCE_SECONDS,
  looksLikeLrc,
  pickCandidate,
  renderLyricTemplate,
  validateLyricTemplate,
  type LyricProvider,
} from '../electron/lyricProvider'
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
  routes: { match: string; status?: number; body: string; contentType?: string }[],
): { fetchImpl: (input: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input)
    const hit = routes.find((route) => input.includes(route.match))
    if (!hit) {
      return new Response('not found', { status: 404 })
    }
    return new Response(hit.body, {
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

  it('模板不合法 → `error`，且**一个请求都不发**', async () => {
    const { fetchImpl, calls } = makeFetch([])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('custom', 'http://example.com/{title}', QUERY)
    expect(result.status).toBe('error')
    expect(calls).toHaveLength(0)
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

  it('同一首歌连查两次 → **只发一次**请求（成功结果一直缓存）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', body: JSON.stringify({ result: { songs: [] } }) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('netease', '', QUERY)
    await provider.fetchExternalLyric('netease', '', QUERY)
    expect(calls).toHaveLength(1)
  })

  it('失败结果也缓存（连续切歌**不会**把外部源打爆）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', status: 500, body: 'boom' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    await provider.fetchExternalLyric('netease', '', QUERY)
    await provider.fetchExternalLyric('netease', '', QUERY)
    expect(calls).toHaveLength(1)
  })

  it('失败的缓存**过期后**会重新试（过期按注入的时钟算）', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'music.163.com/api/search', status: 500, body: 'boom' },
    ])
    let clock = 1_000_000
    const provider = createLyricProvider({ fetchImpl, now: () => clock })
    await provider.fetchExternalLyric('netease', '', QUERY)
    clock += 10 * 60 * 1000
    await provider.fetchExternalLyric('netease', '', QUERY)
    expect(calls).toHaveLength(2)
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
