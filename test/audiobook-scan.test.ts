// ---------------------------------------------------------------------------
// T98 v3：曲库扫描的**并发**（批内并发、批间有序、断点语义不变）
//
// ---------------------------------------------------------------------------
// 为什么单独测它
// ---------------------------------------------------------------------------
// v2 的扫描是**纯顺序**的（87 页 ⇒ 实测 ≈ 106 秒）⇒ 用户等不起。
// v3 改成**批内并发**（默认 8 路）⇒ 实测 52 秒。
//
// ⚠️ 并发最容易踩的坑：**回调乱序** ⇒ 断点（`nextPage`）会算错
//   （断点必须是「下一个要扫的页」）⇒ 所以这里**专门钉住「按页序回调」**。
//
// ⚠️ 本文件只桩掉 `apiCall`（`normalizePage` 等仍是真实现）⇒ 测的是真逻辑。
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiCall } = vi.hoisted(() => ({ apiCall: vi.fn() }))

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>()
  return { ...actual, apiCall }
})

import { scanLibraryTracks } from '../src/api/library'

/** 造一页原始曲目（服务端形状）。 */
function rawSongs(page: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    guid: `t${page}-${i}`,
    title: `${page}-${i}`,
    duration: 1000,
    coverId: null,
    artists: [],
    album: { guid: 'al1', name: '专辑一' },
    audioSpec: { path: `/vol02/1000-0-有声小说/某某/专辑一/Disc 01/${page}-${i}.mp3` },
    year: null,
    trackNo: null,
    discNo: null,
    isrc: null,
    isCue: false,
    createdAt: 1792563278,
    updatedAt: 1792563278,
    genres: [],
    isFavorite: false,
  }))
}

describe('scanLibraryTracks（并发扫描）', () => {
  beforeEach(() => {
    apiCall.mockReset()
  })

  it('① 同一批里**确实并发**（不止一个请求在飞）', async () => {
    let inflight = 0
    let maxInflight = 0
    apiCall.mockImplementation(async (_path: string, opts: unknown) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inflight -= 1
      const query = (opts as { query?: { page?: number } }).query ?? {}
      const page = Number(query.page ?? 1)
      return { list: rawSongs(page, 10), total: 40 }
    })

    const pages: number[] = []
    const result = await scanLibraryTracks({
      pageSize: 10,
      concurrency: 4,
      onPage: (_tracks, progress) => pages.push(progress.page),
    })

    // ⚠️ 第一页**单独**取（拿 total），其余 3 页**并发**取 ⇒ 最多 3 个在飞。
    expect(maxInflight).toBeGreaterThanOrEqual(2)
    expect(apiCall).toHaveBeenCalledTimes(4)
    expect(result.scanned).toBe(40)
    expect(result.total).toBe(40)
    // ⚠️ **按页序回调**（断点语义依赖它）。
    expect(pages).toEqual([1, 2, 3, 4])
  })

  it('② 断点续跑：从断点页开始，**回调仍然按页序**', async () => {
    apiCall.mockImplementation(async (_path: string, opts: unknown) => {
      const query = (opts as { query?: { page?: number } }).query ?? {}
      const page = Number(query.page ?? 1)
      return { list: rawSongs(page, 10), total: 40 }
    })

    const pages: number[] = []
    await scanLibraryTracks({
      pageSize: 10,
      concurrency: 4,
      startPage: 3,
      onPage: (_tracks, progress) => pages.push(progress.page),
    })

    expect(pages).toEqual([3, 4])
    const queried = apiCall.mock.calls.map((call) =>
      Number((call[1] as { query?: { page?: number } }).query?.page ?? 0),
    )
    expect(queried[0]).toBe(3)
  })

  it('③ 某一页是空的 ⇒ **停**（不再往后取）', async () => {
    apiCall.mockImplementation(async (_path: string, opts: unknown) => {
      const query = (opts as { query?: { page?: number } }).query ?? {}
      const page = Number(query.page ?? 1)
      if (page === 2) return { list: [], total: 40 }
      return { list: rawSongs(page, 10), total: 40 }
    })

    const pages: number[] = []
    await scanLibraryTracks({
      pageSize: 10,
      concurrency: 4,
      onPage: (_tracks, progress) => pages.push(progress.page),
    })

    expect(pages).toEqual([1, 2])
  })

  it('④ 显式指定并发数 ⇒ 批的大小就是它（不超）', async () => {
    let inflight = 0
    let maxInflight = 0
    apiCall.mockImplementation(async (_path: string, opts: unknown) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inflight -= 1
      const query = (opts as { query?: { page?: number } }).query ?? {}
      const page = Number(query.page ?? 1)
      return { list: rawSongs(page, 10), total: 200 }
    })

    await scanLibraryTracks({ pageSize: 10, concurrency: 2 })
    // 第一页单独取 ⇒ 批里最多 2 个 ⇒ 峰值 2。
    expect(maxInflight).toBe(2)
  })
})
