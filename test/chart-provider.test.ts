// ---------------------------------------------------------------------------
// T96：外部**音乐榜单**抓取（主进程侧）回归测试
// ---------------------------------------------------------------------------
//
// 覆盖的是**抓取链路**的每一环：
//
//   1. QQ 的**扁平**响应结构（`songlist` 在顶层，歌名是 `songname`、歌手是 `singer[]`）
//   2. 缺歌名的条目**跳过**、名次**不前移**
//   3. 榜单名取 `topinfo.ListName`（自描述），缺失时用兜底名
//   4. 失败语义：`code !== 0` / HTTP 非 2xx / 不是 JSON / fetch 抛异常
//      ⇒ 一律**可读中文**、**永不抛**
//   5. 缓存：成功留 5 分钟、**失败不缓存**、部分失败照常返回
//   6. 榜源地址可覆盖（`resolveChartBaseUrl` 把关：只 https 或回环 http）
//
// ⚠️ 测试数据全是**占位数据**（假 JSON），**不打真实外网**。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  CHART_BOARD_SIZE,
  CHART_CACHE_TTL_MS,
  createChartProvider,
  createQqChartSource,
  DEFAULT_QQ_TOPLIST_URL,
  qqChartSource,
  resolveChartBaseUrl,
  type ChartFetchLike,
} from '../electron/chartProvider'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 一次 fetch 调用。 */
interface FakeCall {
  url: string
  init?: RequestInit
}

/** 造一个假的 fetch（按 URL 返回固定内容）。 */
function fakeFetch(
  responder: (url: string) => { status?: number; body: string },
): { impl: ChartFetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const impl: ChartFetchLike = async (url, init) => {
    calls.push({ url, init })
    const result = responder(url)
    const status = result.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => result.body,
    } as unknown as Response
  }
  return { impl, calls }
}

/** QQ 榜单的成功响应（**扁平**结构）。 */
const QQ_OK_BODY = JSON.stringify({
  code: 0,
  topinfo: { ListName: '巅峰榜·热歌' },
  total_song_num: 300,
  songlist: [
    {
      data: {
        songname: '晴天',
        singer: [{ id: 1, mid: 'm1', name: '周杰伦' }],
        albumname: '叶惠美',
        interval: 269,
      },
    },
    {
      data: {
        songname: '稻香',
        singer: [
          { id: 1, mid: 'm1', name: '周杰伦' },
          { id: 2, mid: 'm2', name: '费玉清' },
        ],
        albumname: '魔杰座',
        interval: 223,
      },
    },
  ],
})

/** 造一个只返回 `QQ_OK_BODY` 的 fetch。 */
function qqFetch(): { impl: ChartFetchLike; calls: FakeCall[] } {
  return fakeFetch(() => ({ body: QQ_OK_BODY }))
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

describe('T96 榜单解析（QQ 适配器）', () => {
  it('解析**扁平**结构：歌名取 `songname`、歌手取 `singer[].name`、专辑取 `albumname`、时长取 `interval`', async () => {
    const { impl } = qqFetch()
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()

    expect(result.status).toBe('ok')
    const board = result.boards[0]
    expect(board).toBeTruthy()
    expect(board?.entries[0]).toEqual({
      rank: 1,
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      duration: 269,
    })
  })

  it('多歌手用「\' / \'」连接', async () => {
    const { impl } = qqFetch()
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.boards[0]?.entries[1]?.artist).toBe('周杰伦 / 费玉清')
  })

  it('榜单名取 `topinfo.ListName`（榜源自述）', async () => {
    const { impl } = qqFetch()
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.boards[0]?.name).toBe('巅峰榜·热歌')
  })

  it('榜源没给名字 ⇒ 用兜底名', async () => {
    const { impl } = fakeFetch(() => ({
      body: JSON.stringify({
        code: 0,
        songlist: [{ data: { songname: '晴天', singer: [{ name: '周杰伦' }] } }],
      }),
    }))
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.boards[0]?.name).toBe('巅峰榜·热歌')
  })

  it('缺歌名的条目**跳过**，且**名次不前移**（如实）', async () => {
    const { impl } = fakeFetch(() => ({
      body: JSON.stringify({
        code: 0,
        topinfo: { ListName: '测试榜' },
        songlist: [
          { data: { songname: '第一首', singer: [{ name: '甲' }] } },
          { data: { singer: [{ name: '乙' }] } },
          { data: { songname: '第三首', singer: [{ name: '丙' }] } },
        ],
      }),
    }))
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    const entries = result.boards[0]?.entries ?? []
    expect(entries.length).toBe(2)
    expect(entries[0]?.rank).toBe(1)
    expect(entries[1]?.rank).toBe(3)
  })

  it('URL 带 `topid` / `format` / `page` / `song_num`，并**带上 Referer 与 UA**', async () => {
    const { impl, calls } = qqFetch()
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    await provider.fetchCharts()

    const first = calls[0]
    expect(first?.url).toContain('topid=26')
    expect(first?.url).toContain('format=json')
    expect(first?.url).toContain(`song_num=${CHART_BOARD_SIZE}`)
    const headers = (first?.init?.headers ?? {}) as Record<string, string>
    expect(headers['referer']).toBe('https://y.qq.com/')
    expect(String(headers['user-agent'])).toContain('Mozilla/5.0')
  })
})

// ---------------------------------------------------------------------------
// 失败语义
// ---------------------------------------------------------------------------

describe('T96 榜单的失败语义', () => {
  it('`code !== 0` ⇒ status = error + 可读中文（**不抛异常**）', async () => {
    const { impl } = fakeFetch(() => ({ body: JSON.stringify({ code: -1, subcode: 400 }) }))
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.status).toBe('error')
    expect(result.boards.length).toBe(0)
    expect(String(result.message)).toContain('榜单源暂时不可用')
  })

  it('HTTP 非 2xx ⇒ status = error', async () => {
    const { impl } = fakeFetch(() => ({ status: 503, body: 'oops' }))
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.status).toBe('error')
  })

  it('返回的不是 JSON ⇒ status = error', async () => {
    const { impl } = fakeFetch(() => ({ body: '<html>404</html>' }))
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.status).toBe('error')
  })

  it('fetch 本身抛异常 ⇒ status = error（**永不抛**）', async () => {
    const impl: ChartFetchLike = async () => {
      throw new Error('network down')
    }
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.status).toBe('error')
    expect(result.boards.length).toBe(0)
  })

  it('部分榜单失败 ⇒ 仍然 status = ok，并**如实说明**有几个没取到', async () => {
    const { impl } = fakeFetch((url) =>
      url.includes('topid=26')
        ? { body: QQ_OK_BODY }
        : { status: 500, body: 'boom' },
    )
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const result = await provider.fetchCharts()
    expect(result.status).toBe('ok')
    expect(result.boards.length).toBe(1)
    expect(String(result.message)).toContain('3')
  })
})

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

describe('T96 榜单缓存', () => {
  it('成功结果缓存 5 分钟 ⇒ 第二次**不再打榜源**', async () => {
    const { impl, calls } = qqFetch()
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    await provider.fetchCharts()
    const after = calls.length
    await provider.fetchCharts()
    expect(calls.length).toBe(after)
  })

  it('缓存过期后**重新拉**', async () => {
    const { impl, calls } = qqFetch()
    let now = 1000
    const provider = createChartProvider({
      fetchImpl: impl,
      now: () => now,
      sources: [qqChartSource],
    })
    await provider.fetchCharts()
    const after = calls.length
    now += CHART_CACHE_TTL_MS + 1
    await provider.fetchCharts()
    expect(calls.length).toBeGreaterThan(after)
  })

  it('⚠️ **失败不缓存**（下次重试能立刻恢复，不让用户被一次抖动卡住 5 分钟）', async () => {
    let fail = true
    const { impl, calls } = fakeFetch(() => ({
      body: fail ? JSON.stringify({ code: -1 }) : QQ_OK_BODY,
    }))
    const provider = createChartProvider({ fetchImpl: impl, sources: [qqChartSource] })
    const first = await provider.fetchCharts()
    expect(first.status).toBe('error')
    const after = calls.length
    fail = false
    const second = await provider.fetchCharts()
    expect(second.status).toBe('ok')
    expect(calls.length).toBeGreaterThan(after)
  })
})

// ---------------------------------------------------------------------------
// 榜源地址可覆盖（E2E / 自建镜像）
// ---------------------------------------------------------------------------

describe('T96 榜源地址的把关（resolveChartBaseUrl）', () => {
  it('https ⇒ 接受', () => {
    expect(resolveChartBaseUrl('https://example.com/toplist')).toBe(
      'https://example.com/toplist',
    )
  })

  it('http + 回环地址 ⇒ 接受（E2E 用）', () => {
    expect(resolveChartBaseUrl('http://127.0.0.1:12345/mock-chart')).toBe(
      'http://127.0.0.1:12345/mock-chart',
    )
    expect(resolveChartBaseUrl('http://localhost:1234/x')).toBe('http://localhost:1234/x')
  })

  it('⚠️ http + 公网地址 ⇒ **拒绝**（明文外网不放行）', () => {
    expect(resolveChartBaseUrl('http://example.com/toplist')).toBeNull()
  })

  it('空值 / 非法 URL / 非 http(s) ⇒ 拒绝（⇒ 回落默认榜源）', () => {
    expect(resolveChartBaseUrl('')).toBeNull()
    expect(resolveChartBaseUrl(undefined)).toBeNull()
    expect(resolveChartBaseUrl('不是地址')).toBeNull()
    expect(resolveChartBaseUrl('file:///etc/passwd')).toBeNull()
  })

  it('覆盖地址后**真的用它**去抓', async () => {
    const { impl, calls } = qqFetch()
    const provider = createChartProvider({
      fetchImpl: impl,
      sources: [createQqChartSource('http://127.0.0.1:9/mock-chart')],
    })
    await provider.fetchCharts()
    expect(calls[0]?.url).toContain('http://127.0.0.1:9/mock-chart')
    expect(calls[0]?.url).not.toContain(DEFAULT_QQ_TOPLIST_URL)
  })
})
