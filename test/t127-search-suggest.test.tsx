// ---------------------------------------------------------------------------
// T127：搜索建议端点 `/search/suggest`（组 C 第一项）
//
// 真机实测（2026-11-20，FN 中继 ＋ 真实 NAS，**只读 GET**）钉死的六条行为事实：
//   ① 参数名是 **`q`**（`?keyword=…` ⇒ `code=100002 invalid arguments`）；
//   ② **空 `q` 会被服务端拒**（`code=100002`；纯空格 ⇒ `code=0` 但四段全空）；
//   ③ **`size` 被忽略**（1/3/20/100 ⇒ 每段都是 `total=5`）；
//   ④ **`page` 被忽略**（page=1 与 page=2 首条逐字相同）⇒ **固定 top-5**；
//   ⑤ 返回**四段** `{track, album, artist, playlist}`，每段是 **`{total, items}`**
//      （**不是** `{list, total}`）；
//   ⑥ 耗时 1.39 / 1.65 / 1.42 s（比 `/search/track` 的 5.8 s 快）。
//
// 本文件钉住 7 条：
//   ① 端点路径 ＋ **不发** `page`/`size`（服务端忽略它们 ⇒ 发它们只是噪音）；
//   ② 空 / 纯空格关键字 ⇒ **一次请求都不发**（客户端自己拦）；
//   ③ 服务端的 `{total, items}` ⇒ 客户端的 `{list, total}`（形状转换）；
//   ④ `score` **条件**透传（服务端没给时领域对象里**没有这个键** ⇒ 零破坏既有断言）；
//   ⑤ 建议区渲染；
//   ⑥ **建议失败不影响完整搜索结果**；
//   ⑦ 建议区**不出现「命中 N」**（suggest 的 `total` 恒 5，不是命中总数）。
//
// ⚠ 测试数据一律用占位值（「歌一」「甲」「示例专辑」…），不写真实 FN ID / 账号 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Album, Artist, Playlist, Song } from '../shared/types'
import { mapAlbum, mapArtist, mapSong } from '../src/api/client'
import { searchApi } from '../src/api/search'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import { SearchPanel, type SearchPanelApi } from '../src/components/SearchPanel'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** 一条建议条目（服务端原样：带 `score`）。 */
const SUGGEST_TRACK = {
  guid: 'sg-track-1',
  title: '建议歌一',
  duration: 185000,
  coverId: 'album_0011223344556677',
  artists: [{ guid: 'ar-1', name: '甲' }],
  album: { guid: 'al-1', name: '示例专辑' },
  score: 2.195477722355097,
}

/** 一条建议专辑（带 `score`）。 */
const SUGGEST_ALBUM = {
  guid: 'sg-album-1',
  name: '建议专辑一',
  coverId: 'album_0011223344556677',
  artists: [{ guid: 'ar-1', name: '甲' }],
  trackCount: 3,
  score: 0.1210638803936593,
}

/** 一条建议歌手（带 `score`）。 */
const SUGGEST_ARTIST = {
  guid: 'sg-artist-1',
  name: '建议歌手一',
  coverId: 'artist_0011223344556677',
  trackCount: 2,
  albumCount: 1,
  score: 0.5325566182263356,
}

/** 服务端返回的「建议」信封（四段，每段 `{total, items}`）。 */
const SUGGEST_ENVELOPE = {
  code: 0,
  msg: '',
  data: {
    track: { total: 5, items: [SUGGEST_TRACK] },
    album: { total: 5, items: [SUGGEST_ALBUM] },
    artist: { total: 5, items: [SUGGEST_ARTIST] },
    playlist: { total: 0, items: [] },
  },
}

/** 一次 fetch 调用的快照。 */
interface FetchCall {
  url: string
}

/**
 * 装一个返回固定信封的 fetch 桩，并记录调用。
 *
 * ⚠ 与 `test/api-client.test.ts` 的同名辅助函数**形状一致**（不共用导出，
 *    免得两个文件互相依赖）。
 */
function stubEnvelopeFetch(envelope: unknown): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push({ url })
    return new Response(JSON.stringify(envelope), { status: 200 })
  })
  return calls
}

/** 造一个假的曲库接口（组件只用到 `favorites`）。 */
function createFakeApi(): LibraryApi {
  return {
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as { guid: string; name: string; coverId: string | null; trackCount: number }[], total: 0 })),
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

/** 造一个假的搜索接口（`suggest` 缺省时组件不渲染建议区）。 */
function makeSearchApi(overrides: Partial<SearchPanelApi> = {}): SearchPanelApi {
  const base: SearchPanelApi = {
    query: vi.fn(async () => ({
      tracks: { list: [] as Song[], total: 0 },
      albums: { list: [] as Album[], total: 0 },
      artists: { list: [] as Artist[], total: 0 },
    })),
  }
  return { ...base, ...overrides }
}

/** 在输入框里打字（走 `fireEvent.change`）。 */
function typeKeyword(value: string): void {
  fireEvent.change(screen.getByLabelText('搜索关键字'), { target: { value } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// ①②③ API 层
// ---------------------------------------------------------------------------

describe('T127 API：searchApi.suggest', () => {
  it('① 打 /search/suggest?q=…（**不发** page / size —— 服务端忽略它们）', async () => {
    const calls = stubEnvelopeFetch(SUGGEST_ENVELOPE)
    await searchApi.suggest('音乐')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('sanlos://srv/search/suggest?q=%E9%9F%B3%E4%B9%90')
    // ⚠ 服务端**忽略** page / size ⇒ 客户端发了也只是噪音 ⇒ 一律不发。
    expect(calls[0]?.url).not.toContain('page=')
    expect(calls[0]?.url).not.toContain('size=')
  })

  it('② 空关键字 / 纯空格关键字 ⇒ **一次请求都不发**（服务端会回 100002）', async () => {
    const calls = stubEnvelopeFetch(SUGGEST_ENVELOPE)

    const empty = await searchApi.suggest('')
    const blank = await searchApi.suggest('   ')

    expect(calls).toHaveLength(0)
    expect(empty.tracks.list).toEqual([])
    expect(empty.albums.list).toEqual([])
    expect(empty.artists.list).toEqual([])
    expect(empty.playlists.list).toEqual([])
    expect(blank.tracks.list).toEqual([])
    expect(blank.albums.list).toEqual([])
    expect(blank.artists.list).toEqual([])
    expect(blank.playlists.list).toEqual([])
  })

  it('③ 服务端的 {total, items} ⇒ 客户端拿到 {list, total}', async () => {
    stubEnvelopeFetch(SUGGEST_ENVELOPE)
    const result = await searchApi.suggest('音乐')
    expect(result.tracks.total).toBe(5)
    expect(result.tracks.list).toHaveLength(1)
    expect(result.tracks.list[0]?.id).toBe('sg-track-1')
    expect(result.albums.total).toBe(5)
    expect(result.albums.list[0]?.id).toBe('sg-album-1')
    expect(result.artists.total).toBe(5)
    expect(result.artists.list[0]?.id).toBe('sg-artist-1')
    expect(result.playlists.total).toBe(0)
    expect(result.playlists.list).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ④ 映射层：`score` 条件透传
// ---------------------------------------------------------------------------

describe('T127 映射：score 条件透传', () => {
  it('服务端给了 score ⇒ 透传到领域对象', () => {
    expect(mapSong(SUGGEST_TRACK).score).toBe(2.195477722355097)
    expect(mapAlbum(SUGGEST_ALBUM).score).toBe(0.1210638803936593)
    expect(mapArtist(SUGGEST_ARTIST).score).toBe(0.5325566182263356)
  })

  it('服务端**没给** score ⇒ 领域对象里**没有这个键**（零破坏既有断言）', () => {
    expect('score' in mapSong({ guid: 'g', title: 'T' })).toBe(false)
    expect('score' in mapAlbum({ guid: 'al', name: 'A' })).toBe(false)
    expect('score' in mapArtist({ guid: 'ar', name: '甲' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ⑤⑥⑦ 组件层：建议区
// ---------------------------------------------------------------------------

describe('T127 界面：搜索建议区', () => {
  it('⑤ suggest 成功 ⇒ 渲染出建议（歌曲 / 专辑 / 歌手三段）', async () => {
    const api = makeSearchApi({
      suggest: vi.fn(async () => ({
        tracks: { list: [mapSong(SUGGEST_TRACK)], total: 5 },
        albums: { list: [mapAlbum(SUGGEST_ALBUM)], total: 5 },
        artists: { list: [mapArtist(SUGGEST_ARTIST)], total: 5 },
        playlists: { list: [], total: 0 },
      })),
    })
    const store = createLibraryStore(createFakeApi())

    render(<SearchPanel api={api} store={store} debounceMs={0} />)
    typeKeyword('音乐')

    expect(await screen.findByTestId('sanlos-suggest-section')).toBeTruthy()
    expect(await screen.findByText('建议歌一')).toBeTruthy()
    expect(await screen.findByText('建议专辑一')).toBeTruthy()
    expect(await screen.findByText('建议歌手一')).toBeTruthy()
    // 三段各自的容器都在。
    expect(screen.getByTestId('sanlos-suggest-tracks')).toBeTruthy()
    expect(screen.getByTestId('sanlos-suggest-albums')).toBeTruthy()
    expect(screen.getByTestId('sanlos-suggest-artists')).toBeTruthy()
  })

  it('⑥ suggest **失败** ⇒ 完整搜索结果**仍然正常显示**', async () => {
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: [makeFullSong('t1')], total: 1 },
        albums: { list: [] as Album[], total: 0 },
        artists: { list: [] as Artist[], total: 0 },
      })),
      suggest: vi.fn(async () => {
        throw new Error('建议服务不可用')
      }),
    })
    const store = createLibraryStore(createFakeApi())

    render(<SearchPanel api={api} store={store} debounceMs={0} />)
    typeKeyword('音乐')

    // 完整搜索结果照常出现。
    expect(await screen.findByText('完整结果歌')).toBeTruthy()
    // 建议区报了错，但**没有**把搜索结果顶掉。
    await waitFor(() => {
      expect(screen.getByTestId('sanlos-suggest-error')).toBeTruthy()
    })
    expect(screen.getByText('完整结果歌')).toBeTruthy()
  })

  it('⑦ 建议区**不出现**「命中 N」（suggest 的 total 恒 5，不是命中总数）', async () => {
    const api = makeSearchApi({
      suggest: vi.fn(async () => ({
        tracks: { list: [mapSong(SUGGEST_TRACK)], total: 5 },
        albums: { list: [], total: 0 },
        artists: { list: [], total: 0 },
        playlists: { list: [], total: 0 },
      })),
    })
    const store = createLibraryStore(createFakeApi())

    render(<SearchPanel api={api} store={store} debounceMs={0} />)
    typeKeyword('音乐')

    const section = await screen.findByTestId('sanlos-suggest-section')
    expect(section.textContent ?? '').not.toContain('命中')
  })
})

/** 造一首完整的占位歌曲（组件渲染需要全部字段）。 */
function makeFullSong(id: string): Song {
  return {
    id,
    title: '完整结果歌',
    artist: '甲',
    artistId: 'ar-1',
    album: '示例专辑',
    albumId: 'al-1',
    coverId: '',
    duration: 185,
    favorite: false,
    codec: 'MP3',
    bitrate: 900,
    sampleRate: 44100,
    bitDepth: 16,
    year: null,
    trackNo: null,
    discNo: null,
    releaseDate: null,
    createdAt: null,
    genres: [],
  }
}
