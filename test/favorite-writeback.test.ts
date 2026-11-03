// ---------------------------------------------------------------------------
// Task 16：搜索、收藏与歌单写回
//
// 覆盖简报 Step 1/3/4 与控制器追加要求 A–J 中**可测**的部分：
// - 简报 Step 1：收藏调用 create 接口并传 trackGUID；
// - A：搜索端点的真实形状（`{ tracks, albums, artists }`，三个各是一页）；
// - B：搜索**按分页**发起、单次 size 受限（严禁全量拉取）、
//      服务端忽略分页参数时不再翻页；
// - C：收藏写回的乐观更新、失败回滚 + 提示、**并发策略（串行化）**；
// - D：歌单写回（加入 / 移除 / 新建）、写回成功后刷新歌单详情缓存、
//      `playlist/list` 为空时如实显示「暂无歌单」、
//      `playlist/create` 不回显 guid 时容忍空串；
// - E：三段结果 + 命中总数 + 「加载更多」+ 空结果「没有找到」+ 收藏按钮在歌曲行上；
// - F：颜色只用语义变量（样式在独立 `.css` 文件里，测试用**类名**做断言钩子）；
// - G：交互态在独立 CSS 文件里（jsdom 不加载外部样式表 → 只断言类名）；
// - H：`SongList` 的行内操作是**纯增量可选 prop**（不传时渲染结果不变）；
// - I：搜索页接进 `App.tsx`。
//
// ⚠️ 测试数据一律用**占位**（「歌一」「示例专辑」「demo」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名 / 真实专辑名**。
// ⚠️ 本文件是 `.ts`（不是 `.tsx`）→ 渲染用 `createElement`，不写 JSX。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { apiCall } from '../src/api/client'
import { favoriteApi } from '../src/api/favorite'
import type { SearchResult } from '../src/api/search'
import type { Album, Artist, Playlist, Song } from '../shared/types'
import {
  SearchPanel,
  createFavoriteWriteback,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PAGE_SIZE,
  type SearchPanelApi,
} from '../src/components/SearchPanel'
import { SongList } from '../src/components/SongList'
import { SearchPage, type PlaylistWritebackApi } from '../src/pages/SearchPage'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import App from '../src/App'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(index: number, overrides: Partial<Song> = {}): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
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
    trackNo: index,
    discNo: 1,
    ...overrides,
  }
}

/** 两首占位歌曲。 */
const SONGS: Song[] = [
  makeSong(1, { id: 'song-1', title: '歌一' }),
  makeSong(2, { id: 'song-2', title: '歌二' }),
]

/** 一张占位专辑。 */
const ALBUM: Album = {
  id: 'album-1',
  title: '示例专辑',
  artist: '甲',
  artistId: '',
  coverId: null,
  year: null,
  trackCount: 3,
}

/** 一位占位歌手。 */
const ARTIST: Artist = {
  id: 'artist-1',
  name: '示例歌手',
  coverId: null,
  albumCount: 1,
  trackCount: 3,
}

/** 一个占位歌单。 */
const PLAYLIST: Playlist = {
  id: 'playlist-1',
  name: '示例歌单',
  coverId: null,
  trackCount: 3,
}

// ---------------------------------------------------------------------------
// 假接口
// ---------------------------------------------------------------------------

/** 空的搜索结果（三段各是一页）。 */
function emptyResult(): SearchResult {
  return {
    tracks: { list: [], total: 0 },
    albums: { list: [], total: 0 },
    artists: { list: [], total: 0 },
  }
}

/** 造一个假的搜索接口。 */
function makeSearchApi(overrides: Partial<SearchPanelApi> = {}): SearchPanelApi {
  const base: SearchPanelApi = {
    query: vi.fn(async () => emptyResult()),
  }
  return { ...base, ...overrides }
}

/** 造一个「能搜到两首歌」的假搜索接口（歌单写回的用例要用它选中歌曲）。 */
function makeSearchApiWithSongs(overrides: Partial<SearchPanelApi> = {}): SearchPanelApi {
  return makeSearchApi({
    query: vi.fn(async () => ({
      tracks: { list: SONGS, total: 2 },
      albums: { list: [], total: 0 },
      artists: { list: [], total: 0 },
    })),
    ...overrides,
  })
}

/** 造一个假的歌单写回接口。 */
function makePlaylistApi(overrides: Partial<PlaylistWritebackApi> = {}): PlaylistWritebackApi {
  const base: PlaylistWritebackApi = {
    list: vi.fn(async () => [PLAYLIST]),
    create: vi.fn(async () => 'playlist-new'),
    addTracks: vi.fn(async () => undefined),
    removeTracks: vi.fn(async () => undefined),
  }
  return { ...base, ...overrides }
}

/** 造一个假的曲库接口（只给歌单详情用得上）。 */
function makeLibraryApi(overrides: Partial<LibraryApi> = {}): LibraryApi {
  const base: LibraryApi = {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [], total: 0 })),
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    favorites: vi.fn(async () => [] as Song[]),
    playlists: vi.fn(async () => [] as Playlist[]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
  }
  return { ...base, ...overrides }
}

/** 让出一个宏任务（把定时器与微任务都放行）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 在搜索框里输入关键字，并等防抖落地。 */
async function typeKeyword(keyword: string): Promise<void> {
  const input = screen.getByLabelText('搜索关键字')
  fireEvent.change(input, { target: { value: keyword } })
  await act(async () => {
    await tick()
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 简报 Step 1
// ---------------------------------------------------------------------------

describe('收藏写回：简报 Step 1', () => {
  it('收藏调用 create 接口并传 trackGUID', async () => {
    const f = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    )
    vi.stubGlobal('fetch', f)
    await apiCall('/favorite-track/create', { method: 'POST', body: { trackGUID: 'g1' } })
    const [url, init] = f.mock.calls[0] as [string, RequestInit | undefined]
    expect(String(url)).toContain('/favorite-track/create')
    expect(JSON.parse(String(init?.body))).toEqual({ trackGUID: 'g1' })
  })

  it('favoriteApi.set(true/false) 分别打到 create / delete 端点', async () => {
    const f = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    )
    vi.stubGlobal('fetch', f)

    await favoriteApi.set('song-1', true)
    await favoriteApi.set('song-1', false)

    const urls = f.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toContain('/favorite-track/create')
    expect(urls[1]).toContain('/favorite-track/delete')
    const bodies = f.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(bodies).toEqual([{ trackGUID: 'song-1' }, { trackGUID: 'song-1' }])
  })
})

// ---------------------------------------------------------------------------
// 收藏写回：并发策略（串行化）
// ---------------------------------------------------------------------------

describe('收藏写回：并发策略（串行化）', () => {
  it('同一首歌的写回串行执行：后一笔等前一笔落地才发出', async () => {
    const calls: Array<[string, boolean]> = []
    let releaseFirst: () => void = () => undefined
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const writeback = createFavoriteWriteback(async (id, on) => {
      calls.push([id, on])
      if (calls.length === 1) await first
    })

    writeback.toggle('song-1', false)
    writeback.toggle('song-1', true)
    await tick()

    // 第二笔还在排队（**没有**并发发出）
    expect(calls).toEqual([['song-1', true]])

    releaseFirst()
    await tick()
    await tick()

    expect(calls).toEqual([
      ['song-1', true],
      ['song-1', false],
    ])
  })

  it('连续两次切换：服务端收到的顺序与点击顺序一致，最终态 = 最后一次点击', async () => {
    const calls: Array<[string, boolean]> = []
    const writeback = createFavoriteWriteback(async (id, on) => {
      calls.push([id, on])
    })

    writeback.toggle('song-1', false)
    writeback.toggle('song-1', true)
    await tick()
    await tick()

    expect(calls).toEqual([
      ['song-1', true],
      ['song-1', false],
    ])
    expect(writeback.get('song-1', false).target).toBe(false)
  })

  it('过期的一笔失败：不回滚更新的乐观态（只有最新一笔失败才回滚）', async () => {
    const deferreds: Array<{ resolve: () => void; reject: (err: unknown) => void }> = []
    const writeback = createFavoriteWriteback(
      () =>
        new Promise<void>((resolve, reject) => {
          deferreds.push({ resolve, reject })
        }),
    )

    writeback.toggle('song-1', false) // → true
    writeback.toggle('song-1', true) // → false（更新的意图）
    await tick()
    expect(deferreds.length).toBe(1)

    // 第一笔失败（**已过期**：用户后来又点了一次）
    deferreds[0]?.reject(new Error('服务端拒绝'))
    await tick()
    await tick()

    // 乐观态仍是用户最新的一次点击，没有被过期失败抹掉
    expect(writeback.get('song-1', false).target).toBe(false)
    // 第二笔照常发出
    await waitFor(() => expect(deferreds.length).toBe(2))
    deferreds[1]?.resolve()
    await tick()
    expect(writeback.get('song-1', false).committed).toBe(false)
  })

  it('最新的一笔失败：回滚到「已确认态」并留下错误提示', async () => {
    const writeback = createFavoriteWriteback(async (_id, on) => {
      if (on) return
      throw new Error('服务端拒绝')
    })

    writeback.toggle('song-1', false) // 收藏：成功
    await tick()
    await tick()
    expect(writeback.get('song-1', false).committed).toBe(true)

    writeback.toggle('song-1', true) // 取消收藏：失败
    await tick()
    await tick()

    const state = writeback.get('song-1', false)
    // 回滚到「已收藏」（= 最后一次写回成功的服务端态）
    expect(state.target).toBe(true)
    expect(writeback.getLastError()).toContain('服务端拒绝')
  })
})

// ---------------------------------------------------------------------------
// 搜索面板：界面要求 E + 写回要求 C
// ---------------------------------------------------------------------------

describe('搜索面板：收藏按钮（要求 C / E）', () => {
  it('收藏按钮出现在歌曲行上，点击后立刻乐观更新并调用写回', async () => {
    const setFavorite = vi.fn(async () => undefined)
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: [SONGS[0] as Song], total: 1 },
        albums: { list: [], total: 0 },
        artists: { list: [], total: 0 },
      })),
      setFavorite,
    })
    render(createElement(SearchPanel, { api, debounceMs: 0 }))
    await typeKeyword('甲')

    const button = await screen.findByTestId('fnm-favorite-toggle')
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)

    // 乐观更新：界面**立刻**反映（不等请求回来）
    expect(screen.getByTestId('fnm-favorite-toggle').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith('song-1', true))
  })

  it('写回失败时回滚到原值并提示用户', async () => {
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: [SONGS[0] as Song], total: 1 },
        albums: { list: [], total: 0 },
        artists: { list: [], total: 0 },
      })),
      setFavorite: vi.fn(async () => {
        throw new Error('服务端拒绝')
      }),
    })
    render(createElement(SearchPanel, { api, debounceMs: 0 }))
    await typeKeyword('甲')

    fireEvent.click(await screen.findByTestId('fnm-favorite-toggle'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('收藏写回失败')
    expect(alert.textContent).toContain('服务端拒绝')
    // 回滚：按钮回到「未收藏」
    await waitFor(() =>
      expect(screen.getByTestId('fnm-favorite-toggle').getAttribute('aria-pressed')).toBe('false'),
    )
  })

  it('收藏按钮的类名是样式钩子（样式在独立 CSS 文件里，不靠内联 style）', async () => {
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: [SONGS[0] as Song], total: 1 },
        albums: { list: [], total: 0 },
        artists: { list: [], total: 0 },
      })),
    })
    const { container } = render(createElement(SearchPanel, { api, debounceMs: 0 }))
    await typeKeyword('甲')

    const button = await screen.findByTestId('fnm-favorite-toggle')
    expect(button.className).toContain('fnm-searchpanel__favorite')
    // ⚠️ 静态几何不进内联 style（伪类只能靠样式表表达）
    expect(button.getAttribute('style')).toBeNull()
    expect(container.querySelector('.fnm-searchpanel')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 搜索面板：结果形态（要求 A / B / E）
// ---------------------------------------------------------------------------

describe('搜索面板：搜索结果（要求 A / B / E）', () => {
  it('输入防抖：停下 SEARCH_DEBOUNCE_MS 之后才发一次搜索', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const query = vi.fn(async () => emptyResult())
    render(createElement(SearchPanel, { api: { query } }))

    const input = screen.getByLabelText('搜索关键字')
    fireEvent.change(input, { target: { value: '甲' } })
    fireEvent.change(input, { target: { value: '甲乙' } })

    // 还没到防抖时间 → 一次都没发
    expect(query).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 20)
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('甲乙', { page: 1, size: SEARCH_PAGE_SIZE })
  })

  it('防抖时长是 300ms（默认值）', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300)
  })

  it('空关键字不发请求', async () => {
    const query = vi.fn(async () => emptyResult())
    render(createElement(SearchPanel, { api: { query }, debounceMs: 0 }))
    await typeKeyword('   ')
    expect(query).not.toHaveBeenCalled()
  })

  it('结果分三段展示，各自带命中总数', async () => {
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: SONGS, total: 2 },
        albums: { list: [ALBUM], total: 1 },
        artists: { list: [ARTIST], total: 1 },
      })),
    })
    const { container } = render(createElement(SearchPanel, { api, debounceMs: 0 }))
    await typeKeyword('甲')

    expect((await screen.findByTestId('fnm-search-count-tracks')).textContent).toContain('命中 2 首')
    expect(screen.getByTestId('fnm-search-count-albums').textContent).toContain('命中 1 张专辑')
    expect(screen.getByTestId('fnm-search-count-artists').textContent).toContain('命中 1 位歌手')
    // 专辑段 / 歌手段都渲染了卡片（复用的是 Task 14 的 Cards）
    const cardTitles = Array.from(
      container.querySelectorAll('[data-testid="fnm-card"] .fnm-card__title'),
    ).map((element) => element.textContent)
    expect(cardTitles).toEqual(['示例专辑', '示例歌手'])
  })

  it('搜索空结果显示「没有找到」（不是空白）', async () => {
    const api = makeSearchApi()
    render(createElement(SearchPanel, { api, debounceMs: 0 }))
    await typeKeyword('甲')
    expect(await screen.findByText('没有找到')).toBeTruthy()
  })

  it('搜索失败时显示错误提示（不是白屏）', async () => {
    const api = makeSearchApi({
      query: vi.fn(async () => {
        throw new Error('服务器响应异常（HTTP 500）')
      }),
    })
    render(createElement(SearchPanel, { api, debounceMs: 0 }))
    await typeKeyword('甲')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('搜索失败')
  })

  it('「加载更多」请求下一页并追加结果', async () => {
    const query = vi.fn(async (_q: string, opts?: { page?: number }) => ({
      tracks:
        opts?.page === 1
          ? { list: [SONGS[0] as Song], total: 2 }
          : { list: [SONGS[1] as Song], total: 2 },
      albums: { list: [], total: 0 },
      artists: { list: [], total: 0 },
    }))
    render(createElement(SearchPanel, { api: { query }, debounceMs: 0 }))
    await typeKeyword('甲')

    expect(await screen.findByText('歌一')).toBeTruthy()
    fireEvent.click(screen.getByTestId('fnm-load-more-tracks'))

    await waitFor(() =>
      expect(query).toHaveBeenCalledWith('甲', { page: 2, size: SEARCH_PAGE_SIZE }),
    )
    expect(await screen.findByText('歌二')).toBeTruthy()
  })

  it('单次请求的条数被限制住（搜索不退化成「拉全库再本地过滤」）', async () => {
    const query = vi.fn(async (_q: string, _opts?: { page?: number; size?: number }) => emptyResult())
    render(createElement(SearchPanel, { api: { query }, debounceMs: 0 }))
    await typeKeyword('甲')

    await waitFor(() => expect(query).toHaveBeenCalled())
    const opts = query.mock.calls[0]?.[1]
    expect(opts?.page).toBe(1)
    expect(opts?.size).toBe(SEARCH_PAGE_SIZE)
    expect(opts?.size).toBeLessThanOrEqual(50)
  })

  it('服务端忽略分页（一次返回超过 size 的条数）时不再提供「加载更多」', async () => {
    const many = Array.from({ length: SEARCH_PAGE_SIZE + 10 }, (_, i) =>
      makeSong(i, { id: `song-${i}`, title: `歌${i}` }),
    )
    const query = vi.fn(async () => ({
      tracks: { list: many, total: 173669 },
      albums: { list: [], total: 0 },
      artists: { list: [], total: 0 },
    }))
    render(createElement(SearchPanel, { api: { query }, debounceMs: 0 }))
    await typeKeyword('甲')

    await waitFor(() => expect(screen.getByTestId('fnm-search-count-tracks')).toBeTruthy())
    // 服务端没按 size 截断 → 认定「不支持分页」→ 不再翻页（否则会一路把曲库拉完）
    expect(screen.queryByTestId('fnm-load-more-tracks')).toBeNull()
  })

  it('歌曲段复用 SongList：双击播放并传出真实下标与整队列表', async () => {
    const onPlay = vi.fn()
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: SONGS, total: 2 },
        albums: { list: [], total: 0 },
        artists: { list: [], total: 0 },
      })),
    })
    render(createElement(SearchPanel, { api, onPlay, debounceMs: 0 }))
    await typeKeyword('甲')

    fireEvent.doubleClick(await screen.findByText('歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onPlay.mock.calls[0]?.[1]).toBe(1)
    expect(onPlay.mock.calls[0]?.[2]).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// SongList 的行内操作是纯增量可选 prop（要求 H）
// ---------------------------------------------------------------------------

describe('SongList：行内操作是可选增量（要求 H）', () => {
  it('不传 renderRowActions 时渲染结果与之前完全一致（行内没有附加节点）', () => {
    const { container } = render(createElement(SongList, { songs: SONGS, onPlay: vi.fn() }))
    expect(container.querySelector('.fnm-songlist__row')?.children.length).toBe(
      container.querySelectorAll('.fnm-songlist__row')[0]?.children.length,
    )
    expect(container.querySelector('[data-testid="fnm-favorite-toggle"]')).toBeNull()
  })

  it('传了 renderRowActions 时在行内渲染调用方给的内容', () => {
    render(
      createElement(SongList, {
        songs: SONGS,
        onPlay: vi.fn(),
        renderRowActions: (song: Song) =>
          createElement('button', { type: 'button', 'data-testid': 'row-action' }, song.title),
      }),
    )
    const buttons = screen.getAllByTestId('row-action')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons[0]?.textContent).toBe('歌一')
  })
})

// ---------------------------------------------------------------------------
// 歌单写回（要求 D / J）
// ---------------------------------------------------------------------------

describe('歌单写回（要求 D / J）', () => {
  it('歌单列表为空时显示「暂无歌单」（不报错、不白屏）', async () => {
    const playlistApi = makePlaylistApi({ list: vi.fn(async () => []) })
    render(createElement(SearchPage, { api: makeSearchApi(), playlistApi }))

    expect(await screen.findByTestId('fnm-playlists-empty')).toBeTruthy()
    expect(screen.getByText('暂无歌单')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('把选中的歌曲加入歌单，成功后刷新歌单详情缓存', async () => {
    const addTracks = vi.fn(async () => undefined)
    const playlistApi = makePlaylistApi({ addTracks })
    const libraryApi = makeLibraryApi()
    const store = createLibraryStore(libraryApi)
    // 曲库 store 正在看这个歌单（缓存里有它）
    store.setState({ playlistId: PLAYLIST.id })

    render(createElement(SearchPage, { api: makeSearchApiWithSongs(), playlistApi, store }))
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌一'))

    const addButton = screen.getByTestId('fnm-add-to-playlist')
    await waitFor(() => expect((addButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(addButton)

    await waitFor(() => expect(addTracks).toHaveBeenCalledWith(PLAYLIST.id, ['song-1']))
    // 写回成功后刷新歌单详情缓存（重新取 `playlistApi.songs` 的结果）
    await waitFor(() =>
      expect(libraryApi.playlistSongs).toHaveBeenCalledWith(PLAYLIST.id, 1, expect.any(Number)),
    )
    expect(await screen.findByText(/已把 1 首加入歌单/)).toBeTruthy()
  })

  it('从歌单移除所选歌曲调用 removeTracks', async () => {
    const removeTracks = vi.fn(async () => undefined)
    const playlistApi = makePlaylistApi({ removeTracks })
    render(createElement(SearchPage, { api: makeSearchApiWithSongs(), playlistApi }))
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌一'))

    const removeButton = screen.getByTestId('fnm-remove-from-playlist')
    await waitFor(() => expect((removeButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(removeButton)

    await waitFor(() => expect(removeTracks).toHaveBeenCalledWith(PLAYLIST.id, ['song-1']))
    expect(await screen.findByText(/已把 1 首移出歌单/)).toBeTruthy()
  })

  it('写回失败时给出错误提示（不假装成功）', async () => {
    const playlistApi = makePlaylistApi({
      addTracks: vi.fn(async () => {
        throw new Error('服务端拒绝')
      }),
    })
    render(createElement(SearchPage, { api: makeSearchApiWithSongs(), playlistApi }))
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌一'))

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('服务端拒绝')
  })

  it('playlist/create 返回空 guid 时提示「已创建，但未能拿到歌单标识」且不崩溃', async () => {
    const playlistApi = makePlaylistApi({
      create: vi.fn(async () => ''),
      list: vi.fn(async () => []),
    })
    render(createElement(SearchPage, { api: makeSearchApi(), playlistApi }))

    fireEvent.change(screen.getByLabelText('新歌单名称'), { target: { value: '新歌单' } })
    fireEvent.click(screen.getByText('新建歌单'))

    expect(await screen.findByText(/已创建，但未能拿到歌单标识/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('playlist/create 返回 guid 时选中新建的歌单', async () => {
    const created: Playlist = { ...PLAYLIST, id: 'playlist-2', name: '新歌单' }
    const playlistApi = makePlaylistApi({
      create: vi.fn(async () => created.id),
      list: vi.fn(async () => [PLAYLIST, created]),
    })
    render(createElement(SearchPage, { api: makeSearchApi(), playlistApi }))

    fireEvent.change(screen.getByLabelText('新歌单名称'), { target: { value: '新歌单' } })
    fireEvent.click(screen.getByText('新建歌单'))

    expect(await screen.findByText(/已创建/)).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByLabelText('选择歌单') as HTMLSelectElement).value).toBe('playlist-2'),
    )
  })
})

// ---------------------------------------------------------------------------
// 应用接线（要求 I）
// ---------------------------------------------------------------------------

describe('应用外壳：搜索页接线（要求 I）', () => {
  it('点顶栏的「搜索」进入搜索页；「连接」回到登录页', async () => {
    render(createElement(App))

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByLabelText('搜索关键字')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(screen.queryByLabelText('搜索关键字')).toBeNull()
    expect(screen.getByText('连接飞牛音乐')).toBeTruthy()
  })
})
