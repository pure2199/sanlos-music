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

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
import { useSessionStore } from '../src/state/sessionStore'
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
    // ---- 详情下钻（Task 4）------------------------------------------------
    album: vi.fn(async () => null),
    albumSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    history: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
  }
  return { ...base, ...overrides }
}

/** 让出一个宏任务（把定时器与微任务都放行）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 仓库根目录（**不依赖 `process.cwd()`**）。
 *
 * ⚠️ 用 `process.cwd()` 锚定时，cwd ≠ 仓库根（例如从别的目录跑 vitest），
 *    读到的就是别的目录 → 断言**空转通过**。
 *    这里从**本测试文件自身的位置**推导仓库根，与 cwd 无关。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读仓库里的一个源码 / 样式文件。 */
function readRepoFile(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), 'utf8')
}

/** 造一整页（`SEARCH_PAGE_SIZE` 条）占位歌曲。 */
function makeFullPage(offset: number): Song[] {
  return Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) =>
    makeSong(offset + i, { id: `song-${offset + i}`, title: `歌${offset + i}` }),
  )
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

  it('过期的一笔失败：不回滚更新的乐观态（3 连击，只有最新一笔失败才回滚）', async () => {
    const deferreds: Array<{ resolve: () => void; reject: (err: unknown) => void }> = []
    const writeback = createFavoriteWriteback(
      () =>
        new Promise<void>((resolve, reject) => {
          deferreds.push({ resolve, reject })
        }),
    )

    // ⚠️ **3 连击**（不是 2 次）：2 次点击时 `committed` 恰等于最新乐观态，
    //    断言**区分不出**「回滚」与「不回滚」两种实现（复审 I-3）。
    writeback.toggle('song-1', false) // → true
    writeback.toggle('song-1', true) // → false
    writeback.toggle('song-1', false) // → true（用户最后点击的意图）
    await tick()
    expect(deferreds.length).toBe(1)

    // 第一笔失败（**已过期**：用户后来又点了两次）
    deferreds[0]?.reject(new Error('服务端拒绝'))
    await tick()
    await tick()

    // 乐观态仍是用户**第三次**点击的值，没有被过期失败抹掉
    expect(writeback.get('song-1', false).target).toBe(true)
    // 第二笔照常发出（写回是**串行**的：一笔落地才发下一笔）
    await waitFor(() => expect(deferreds.length).toBe(2))
    deferreds[1]?.resolve()
    await tick()
    await tick()
    // 第三笔照常发出
    await waitFor(() => expect(deferreds.length).toBe(3))
    deferreds[2]?.resolve()
    await tick()
    await tick()

    const state = writeback.get('song-1', false)
    expect(state.target).toBe(true)
    expect(state.committed).toBe(true)
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
    // ⚠️ 注入**独立**的 store：收藏态是单一真相源（T9），
    //    用默认的全局 store 会与同文件的其它用例**串味**
    //    （上一个用例写回成功过 → 收藏态已经是「已收藏」）。
    const store = createLibraryStore(makeLibraryApi())
    render(createElement(SearchPanel, { api, store, debounceMs: 0 }))
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
    // ⚠️ 同样注入**独立**的 store（原值 = 「未收藏」必须由本用例自己决定）。
    const store = createLibraryStore(makeLibraryApi())
    render(createElement(SearchPanel, { api, store, debounceMs: 0 }))
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
    const store = createLibraryStore(makeLibraryApi())
    const { container } = render(createElement(SearchPanel, { api, store, debounceMs: 0 }))
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

  // ⚠️ T18-4（真机实测）：搜索结果里的**专辑 / 歌手卡片原来点不动**
  //    （`renderItem` 没有把 `onOpen` 传给卡片）——卡片渲染出来却是死的。
  it('搜索结果里的专辑 / 歌手卡片能下钻（点了会回调）', async () => {
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: [], total: 0 },
        albums: { list: [ALBUM], total: 1 },
        artists: { list: [ARTIST], total: 1 },
      })),
    })
    const onOpenAlbum = vi.fn()
    const onOpenArtist = vi.fn()
    render(
      createElement(SearchPanel, { api, onOpenAlbum, onOpenArtist, debounceMs: 0 }),
    )
    await typeKeyword('甲')

    // 专辑卡片：标题就是专辑名。
    const albumTitle = await screen.findByText('示例专辑')
    fireEvent.click(albumTitle)
    expect(onOpenAlbum).toHaveBeenCalledWith(ALBUM)

    // 歌手卡片：标题就是歌手名。
    const artistTitle = await screen.findByText('示例歌手')
    fireEvent.click(artistTitle)
    expect(onOpenArtist).toHaveBeenCalledWith(ARTIST)
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

  it('「加载更多」请求下一页并追加结果（满页才继续翻）', async () => {
    const page1 = makeFullPage(0)
    const page2 = makeFullPage(100)
    const query = vi.fn(async (_q: string, opts?: { page?: number }) => ({
      tracks: opts?.page === 1 ? { list: page1, total: 200 } : { list: page2, total: 200 },
      albums: { list: [], total: 0 },
      artists: { list: [], total: 0 },
    }))
    render(createElement(SearchPanel, { api: { query }, debounceMs: 0 }))
    await typeKeyword('甲')

    await waitFor(() => expect(screen.getByTestId('fnm-load-more-tracks')).toBeTruthy())
    expect(screen.getByText(/已加载 50 \/ 200/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('fnm-load-more-tracks'))

    await waitFor(() =>
      expect(query).toHaveBeenCalledWith('甲', { page: 2, size: SEARCH_PAGE_SIZE }),
    )
    await waitFor(() => expect(screen.getByText(/已加载 100 \/ 200/)).toBeTruthy())
  })

  it('服务端重复返回同一页时：「加载更多」不再出现（不会永远重复同一页）', async () => {
    // 每页都返回**完全相同**的 id（服务端排序抖动 / 页码对不齐时的典型症状）
    const samePage = makeFullPage(0)
    const query = vi.fn(async () => ({
      tracks: { list: samePage, total: 173669 },
      albums: { list: [], total: 0 },
      artists: { list: [], total: 0 },
    }))
    render(createElement(SearchPanel, { api: { query }, debounceMs: 0 }))
    await typeKeyword('甲')

    await waitFor(() => expect(screen.getByTestId('fnm-load-more-tracks')).toBeTruthy())
    fireEvent.click(screen.getByTestId('fnm-load-more-tracks'))
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith('甲', { page: 2, size: SEARCH_PAGE_SIZE }),
    )

    // 第 2 页去重后**没有任何新增** → 「加载更多」必须消失（否则永远重复同一页）
    await waitFor(() => expect(screen.queryByTestId('fnm-load-more-tracks')).toBeNull())
  })

  it('服务端 total 不可信（=0）但确实返回了满页时：「加载更多」仍然存在', async () => {
    // ⚠️ 简报明写「不要假设 total 一定准」→ 翻页决策**不能**依赖 total。
    const full = makeFullPage(0)
    const query = vi.fn(async () => ({
      tracks: { list: full, total: 0 },
      albums: { list: [], total: 0 },
      artists: { list: [], total: 0 },
    }))
    render(createElement(SearchPanel, { api: { query }, debounceMs: 0 }))
    await typeKeyword('甲')

    await waitFor(() => expect(screen.getByTestId('fnm-load-more-tracks')).toBeTruthy())
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
  /** 取第一行的子节点类名列表（行内结构的「指纹」）。 */
  function rowChildClasses(container: HTMLElement): string[] {
    const row = container.querySelector('.fnm-songlist__row')
    return Array.from(row?.children ?? []).map((child) => child.className)
  }

  it('不传 renderRowActions 时行内结构与基线一致（没有任何附加节点）', () => {
    // ⚠️ 基线是**写死的结构指纹**（不是「自己跟自己比」——那是恒真断言）。
    //    行内只有：封面 / 标题 / 歌手 / 专辑 / 时长（歌曲未收藏 → 没有 ♡ 标记）。
    const expected = [
      'fnm-songlist__cover',
      'fnm-songlist__title',
      'fnm-songlist__artist',
      'fnm-songlist__album',
      'fnm-songlist__duration',
    ]

    const baseline = render(createElement(SongList, { songs: SONGS, onPlay: vi.fn() }))
    expect(rowChildClasses(baseline.container)).toEqual(expected)
    expect(baseline.container.querySelector('[data-testid="fnm-favorite-toggle"]')).toBeNull()
  })

  it('传了 renderRowActions 但回调返回 null 时，行内结构与不传时逐项相等', () => {
    const baseline = render(createElement(SongList, { songs: SONGS, onPlay: vi.fn() }))
    const withNull = render(
      createElement(SongList, {
        songs: SONGS,
        onPlay: vi.fn(),
        renderRowActions: () => null,
      }),
    )
    expect(rowChildClasses(withNull.container)).toEqual(rowChildClasses(baseline.container))
  })

  it('传了 renderRowActions 时在行内渲染调用方给的内容（且只多出这一个节点）', () => {
    const baseline = render(createElement(SongList, { songs: SONGS, onPlay: vi.fn() }))
    const withButton = render(
      createElement(SongList, {
        songs: SONGS,
        onPlay: vi.fn(),
        renderRowActions: (song: Song) =>
          createElement('button', { type: 'button', 'data-testid': 'row-action' }, song.title),
      }),
    )

    const buttons = withButton.container.querySelectorAll('[data-testid="row-action"]')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons[0]?.textContent).toBe('歌一')
    // 行内只**多出**调用方给的那一个节点（其余结构一字不变）
    expect(rowChildClasses(withButton.container)).toHaveLength(
      rowChildClasses(baseline.container).length + 1,
    )
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

  it('把选中的歌曲加入歌单，成功后刷新**该歌单**的详情缓存（不受「当前选中歌单」守卫）', async () => {
    const addTracks = vi.fn(async () => undefined)
    const playlistApi = makePlaylistApi({ addTracks })
    const libraryApi = makeLibraryApi({
      playlistSongs: vi.fn(async () => ({ list: [SONGS[0] as Song], total: 1 })),
    })
    const store = createLibraryStore(libraryApi)
    // ⚠️ **不**设置 `playlistId`：运行期它恒为 null（歌单页从未被任何组件挂载）——
    //    旧实现在这里直接 return → 这次刷新**一次都不会发生**（复审 I-1）。
    render(createElement(SearchPage, { api: makeSearchApiWithSongs(), playlistApi, store }))
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌一'))

    const addButton = screen.getByTestId('fnm-add-to-playlist')
    await waitFor(() => expect((addButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(addButton)

    await waitFor(() => expect(addTracks).toHaveBeenCalledWith(PLAYLIST.id, ['song-1']))
    // 写回成功后刷新该歌单的详情缓存（重新取 `playlistApi.songs` 的结果）
    await waitFor(() =>
      expect(libraryApi.playlistSongs).toHaveBeenCalledWith(PLAYLIST.id, 1, expect.any(Number)),
    )
    // 缓存**真的**被更新了（不是静默 no-op）
    await waitFor(() =>
      expect(store.getState().playlistSongsById[PLAYLIST.id]?.items).toHaveLength(1),
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

  it('playlist/create 返回空 guid 且按名字找不回时：提示文案就是「已创建，但未能拿到歌单标识」', async () => {
    const playlistApi = makePlaylistApi({
      create: vi.fn(async () => ''),
      list: vi.fn(async () => []),
    })
    render(createElement(SearchPage, { api: makeSearchApi(), playlistApi }))

    fireEvent.change(screen.getByLabelText('新歌单名称'), { target: { value: '新歌单' } })
    fireEvent.click(screen.getByText('新建歌单'))

    const message = await screen.findByText(/已创建，但未能拿到歌单标识/)
    // ⚠️ 提示**不能**是任何形式的「创建成功」——找不到标识就如实说找不到
    expect(message.textContent).toBe('已创建，但未能拿到歌单标识（服务端未回显 guid）')
    expect(message.textContent).not.toContain('创建成功')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('playlist/create 返回空 guid 但能按名字找回时：选中该歌单并说明原因', async () => {
    const created: Playlist = { ...PLAYLIST, id: 'playlist-2', name: '新歌单' }
    const playlistApi = makePlaylistApi({
      create: vi.fn(async () => ''),
      list: vi.fn(async () => [PLAYLIST, created]),
    })
    render(createElement(SearchPage, { api: makeSearchApi(), playlistApi }))

    fireEvent.change(screen.getByLabelText('新歌单名称'), { target: { value: '新歌单' } })
    fireEvent.click(screen.getByText('新建歌单'))

    // 按名字找回了 → 选中它
    await waitFor(() =>
      expect((screen.getByLabelText('选择歌单') as HTMLSelectElement).value).toBe('playlist-2'),
    )
    const message = await screen.findByText(/已创建，但未能拿到歌单标识/)
    expect(message.textContent).toContain('已按名称选中')
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
// 歌单详情缓存的刷新语义（修复轮次 1 · I-1）
//
// ⚠️ **直接调 store 动作**（不经 UI）——复审要求的配套用例：
//    「对**非当前选中**的 playlistId 调用刷新 → 该歌单的 items 确实被更新，
//      且 playlistId（当前选中项）**不变**」。
// ---------------------------------------------------------------------------

describe('歌单详情缓存：刷新语义（I-1）', () => {
  it('刷新**非当前选中**的歌单：该歌单的曲目缓存被更新，且「当前选中歌单」不变', async () => {
    const other: Playlist = { ...PLAYLIST, id: 'playlist-2', name: '另一个歌单' }
    const libraryApi = makeLibraryApi({
      playlistSongs: vi.fn(async (playlistId: string) => ({
        list: [makeSong(9, { id: `song-of-${playlistId}`, title: `歌${playlistId}` })],
        total: 1,
      })),
    })
    const store = createLibraryStore(libraryApi)
    // 当前选中的是**另一个**歌单
    store.setState({ playlistId: PLAYLIST.id })

    await store.getState().refreshPlaylistSongs(other.id)

    // 按传入的 id 直接拉取（**不受**「当前选中歌单」守卫）
    expect(libraryApi.playlistSongs).toHaveBeenCalledWith(other.id, 1, expect.any(Number))
    // 该歌单的缓存确实被更新（找不到条目 → **新建**一条，而不是静默 no-op）
    expect(store.getState().playlistSongsById[other.id]?.items.map((song) => song.id)).toEqual([
      `song-of-${other.id}`,
    ])
    // 「当前选中歌单」**不变**
    expect(store.getState().playlistId).toBe(PLAYLIST.id)
    // 别的歌单的缓存不受影响
    expect(store.getState().playlistSongsById[PLAYLIST.id]).toBeUndefined()
  })

  it('刷新当前选中的歌单：当前歌单视图也跟着更新（且仍不改变选中项）', async () => {
    const libraryApi = makeLibraryApi({
      playlistSongs: vi.fn(async () => ({ list: [SONGS[0] as Song], total: 1 })),
    })
    const store = createLibraryStore(libraryApi)
    store.setState({ playlistId: PLAYLIST.id })

    await store.getState().refreshPlaylistSongs(PLAYLIST.id)

    expect(store.getState().playlistId).toBe(PLAYLIST.id)
    expect(store.getState().playlistSongs.items.map((song) => song.id)).toEqual(['song-1'])
    expect(store.getState().playlistSongsById[PLAYLIST.id]?.items).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 应用接线（要求 I）
// ---------------------------------------------------------------------------

describe('应用外壳：搜索页接线（要求 I）', () => {
  /**
   * ⚠️ T38：顶栏的「搜索」**需要 NAS** → 未登录时**不渲染**。
   *    ⇒ 这条用例按**已登录**设置会话状态（未登录那套见 `test/app-guest-nav.test.tsx`）。
   */
  beforeEach(() => {
    useSessionStore.setState({
      session: {
        connected: true,
        mode: 'password',
        username: 'demo',
        serverLabel: 'example',
        isRelay: false,
      },
      connection: null,
      candidates: [],
      restored: true,
    })
  })

  it('点顶栏的「搜索」进入搜索页；「连接」回到登录页', async () => {
    render(createElement(App))

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByLabelText('搜索关键字')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(screen.queryByLabelText('搜索关键字')).toBeNull()
    expect(screen.getByText('连接飞牛音乐')).toBeTruthy()
  })

  it('顶栏入口按钮的样式归属**应用外壳**（app-shell.css），类名与归属一致（M-9）', () => {
    const shell = readRepoFile('src', 'styles', 'app-shell.css')
    // 样式在**外壳**的样式文件里（将来改成代码分割也不会丢样式）
    expect(shell).toContain('.fnm-app__nav')
    expect(shell).toContain('.fnm-app__nav-button')

    // 页面样式文件里**不再有** nav 规则（避免两处各写一份）
    const pageCss = readRepoFile('src', 'pages', 'search-page.css')
    expect(pageCss).not.toContain('.fnm-app__nav')
    expect(pageCss).not.toContain('.fnm-searchpage__nav')

    // 标记用的类名与归属一致
    const app = readRepoFile('src', 'App.tsx')
    expect(app).toContain('fnm-app__nav-button')
    expect(app).not.toContain('fnm-searchpage__nav')
  })
})
