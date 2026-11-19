// ---------------------------------------------------------------------------
// T125：页码上界 clamp（离谱页码兜底）
//
// 背景（**真机实测**，2026-11-20，FN 中继 / 真实 NAS，**只读 GET**，曲库 total = 173 671）：
// - `page=1&size=50`     → 50 条，首曲「茨厂街…」
// - `page=1000&size=50`  → 首曲「勇敢一点 - Live」⇒ **翻页正常**
// - `page=10000 / 100000 / 10000000 / 999999999999 / 0 / -5`
//   → **全部** `code=0`、**50 条**、首曲 = **第一页那首**、~300–430 ms
//     （重复 3 次：303 / 429 / 327 ms，**不变慢**）
//   ⇒ ⚠ 服务端对**越界 / 非法 page 一律静默回退第一页**（**不报错、不返回空**）
//
// 由此得出的客户端义务（**不是**「猜服务端第几页」——那做不到）：
// **别把离谱的页码发出去**。
// 旧实现 `normalizePageNumber()` **只夹下界**（≥ 1）⇒ `page = 1e300` 会被 `String()`
// 序列化成 **`1e+300`**（**指数记数法**）原样上线 ⇒ 服务端的整数解析行为**未定义**。
//
// 本文件钉四件事：
// 1. 离谱页码被夹到 `MAX_PAGE_NUMBER`（单元）；
// 2. **既有归一语义一条没变**（非法值回落 1 / 小数向下取整 / 正常页码原样）（单元）；
// 3. 夹在**出口**生效：真的发出去的是夹过的页码，且是**十进制整数**（线上）；
// 4. **不**按 `total` 夹页码 ⇒ 曲库变大时新增曲目**不会被静默截断**（store）。
//
// ⚠ 命名空间导入（`import * as apiClient`）：常量还没导出的阶段，用例要能
//    **干净地失败**（断言失败），而不是模块级报错（加载失败）——TDD 的 RED 需要前者。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'

import * as apiClient from '../src/api/client'
import { libraryApi } from '../src/api/library'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 装一个返回固定信封的 fetch 桩，并记录请求 URL。 */
function stubEnvelopeFetch(envelope: unknown): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(envelope), { status: 200 })
  })
  return urls
}

/** 造一批占位歌曲（`from` 起，共 `count` 首，id 唯一）。 */
function makeSongs(from: number, count: number): Song[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `song-${from + i}`,
    title: `歌${from + i}`,
    artist: '甲',
    artistId: '',
    album: '示例专辑',
    albumId: '',
    coverId: '',
    duration: 100,
    favorite: false,
    codec: 'FLAC',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: 0,
    trackNo: from + i,
    discNo: 1,
  }))
}

/** 造一个「只有 songs 有用」的假曲库接口。 */
function createFakeLibraryApi(songs: LibraryApi['songs']): LibraryApi {
  return {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as Genre[], total: 0 })),
    songs,
    favorites: vi.fn(async () => [] as Song[]),
    playlists: vi.fn(async () => [] as Playlist[]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    album: vi.fn(async () => null),
    albumSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    history: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 钉子
// ---------------------------------------------------------------------------

describe('T125 页码上界 clamp', () => {
  it('① 离谱页码被夹到上界（上界之内的一切原样通过）', () => {
    // 上界本身的取值被**写死**在用例里：改它必须同步改本用例并说明理由。
    expect(apiClient.MAX_PAGE_NUMBER).toBe(1_000_000)

    expect(apiClient.normalizePageNumber(1_000_001)).toBe(1_000_000)
    expect(apiClient.normalizePageNumber(1e12)).toBe(1_000_000)
    expect(apiClient.normalizePageNumber(999_999_999_999)).toBe(1_000_000)
    expect(apiClient.normalizePageNumber(Number.MAX_SAFE_INTEGER)).toBe(1_000_000)
    // ⚠ `1e300` 会被 `String()` 写成 `1e+300`（指数记数法）⇒ 这是最该夹的一个。
    expect(apiClient.normalizePageNumber(1e300)).toBe(1_000_000)

    // 上界之内：原样通过（不越界夹）。
    expect(apiClient.normalizePageNumber(1_000_000)).toBe(1_000_000)
    expect(apiClient.normalizePageNumber(1_000_000.9)).toBe(1_000_000)
    // 实测曲库折算的页数（173 671 首 ÷ 50 条/页 = 3474 页）远在上界之内 ⇒ 不会被截断。
    expect(apiClient.normalizePageNumber(3474)).toBe(3474)
  })

  it('② 既有归一语义一条没变（非法值回落 1 / 小数向下取整 / 正常页码原样）', () => {
    expect(apiClient.normalizePageNumber(0)).toBe(1)
    expect(apiClient.normalizePageNumber(-3)).toBe(1)
    expect(apiClient.normalizePageNumber(Number.NaN)).toBe(1)
    expect(apiClient.normalizePageNumber(Number.POSITIVE_INFINITY)).toBe(1)
    expect(apiClient.normalizePageNumber(2.9)).toBe(2)
    expect(apiClient.normalizePageNumber(5)).toBe(5)
  })

  it('③ 出口生效：真的发出去的是夹过的页码（十进制整数，不是 1e+300）', async () => {
    const urls = stubEnvelopeFetch({ code: 0, msg: '', data: { list: [], total: 0 } })

    await libraryApi.songs(1e300, 50)
    expect(urls[0]).toBe('sanlos://srv/track/list?page=1000000&size=50')
    expect(urls[0]).not.toMatch(/e\+/i)

    // 正常页码不受影响。
    await libraryApi.songs(12, 50)
    expect(urls[1]).toBe('sanlos://srv/track/list?page=12&size=50')
  })

  it('④ 不按 total 夹页码：曲库变大后新增曲目照样翻得出来', async () => {
    // 假接口：第 1 页时服务端说 total = 50；随后「曲库变大」⇒ total = 120。
    const songs = vi.fn(async (page: number) => {
      if (page === 1) return { list: makeSongs(0, 50), total: 50 }
      if (page === 2) return { list: makeSongs(50, 50), total: 120 }
      return { list: makeSongs(100, 20), total: 120 }
    })
    const store = createLibraryStore(createFakeLibraryApi(songs))

    await store.getState().loadSongs(1)
    expect(store.getState().songs.items).toHaveLength(50)

    await store.getState().loadSongs(store.getState().songs.nextPage)
    await store.getState().loadSongs(store.getState().songs.nextPage)

    // ⚠ 页码一路往前推（1 → 2 → 3），**没有**被 total 掐断
    //    （若按 `ceil(total/size)` 夹，total=50 时下一页会被夹回第 1 页 ⇒ 新增曲目永远翻不到）。
    expect(songs.mock.calls.map((call) => call[0])).toEqual([1, 2, 3])
    expect(store.getState().songs.items).toHaveLength(120)
  })
})
