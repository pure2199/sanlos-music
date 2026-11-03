// ---------------------------------------------------------------------------
// T9 一致性小修（只读审计报表 P-LIB-3 / P-LIB-4 / P-LIB-5 · P1-5 / P1-6）
//
// 覆盖三条：
// - **分页护栏停下后有「继续加载」入口**（P-LIB-4 / P1-5）：
//   之前 `stalled=true` 之后 `hasMore=false` / `nextPage` 不前进，
//   界面**没有任何**继续加载或重试的入口 → 大列表可能被提前截断。
// - **收藏态单一真相源**（P-LIB-3 / P1-6）：
//   `SearchPanel` 的收藏乐观态存在**自己的** writeback Map 里，
//   与 `libraryStore.favorites` 不互通 → 搜索页与收藏页各说各话。
// - **歌单写回两处小瑕疵**（P-LIB-5 / P1-6）：
//   写回成功后 `selectedIds` 不清空（会重复加入同一批歌）；
//   歌单 `trackCount` 不随增删刷新。
//
// ⚠️ 测试数据一律用占位值（「歌一」「示例歌单」「example-fn-id」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act, fireEvent } from '@testing-library/react'

import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'
import {
  createLibraryStore,
  LIBRARY_MAX_NO_PROGRESS_PAGES,
  type LibraryApi,
} from '../src/state/libraryStore'
import { SongsPage } from '../src/pages/SongsPage'
import { SearchPage, type PlaylistWritebackApi } from '../src/pages/SearchPage'
import { SearchPanel, type SearchPanelApi } from '../src/components/SearchPanel'

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

/** 一张占位专辑。 */
function makeAlbum(index: number): Album {
  return {
    id: `album-${index}`,
    title: `示例专辑${index}`,
    artist: '甲',
    artistId: '',
    coverId: null,
    year: null,
    trackCount: 1,
  }
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

/** 造一个假的曲库接口（默认全部返回空页）。 */
function createFakeApi(overrides: Partial<LibraryApi> = {}): LibraryApi {
  const base: LibraryApi = {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as Genre[], total: 0 })),
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
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
  return { ...base, ...overrides }
}

/** 造一个假的搜索接口。 */
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

/** 造一个「能搜到两首歌」的假搜索接口。 */
function makeSearchApiWithSongs(overrides: Partial<SearchPanelApi> = {}): SearchPanelApi {
  return makeSearchApi({
    query: vi.fn(async () => ({
      tracks: { list: [makeSong(1), makeSong(2)], total: 2 },
      albums: { list: [] as Album[], total: 0 },
      artists: { list: [] as Artist[], total: 0 },
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

// ---------------------------------------------------------------------------
// P-LIB-4 / P1-5：分页护栏停下后的「继续加载」入口
// ---------------------------------------------------------------------------

describe('P-LIB-4 分页护栏：停下后有「继续加载」入口', () => {
  /** 造一个「每页都返回同一批 id」的假接口（排序抖动的典型症状）。 */
  function duplicateApi(): { api: LibraryApi; songs: ReturnType<typeof vi.fn> } {
    const duplicate = Array.from({ length: 5 }, (_, i) => makeSong(i))
    const songs = vi.fn(async (page: number) => ({ list: duplicate, total: 100 }))
    return { api: createFakeApi({ songs }), songs }
  }

  it('store：resumePaging 复位护栏并请求「下一个没请求过的页码」', async () => {
    const { api, songs } = duplicateApi()
    const store = createLibraryStore(api)

    await store.getState().loadSongs(1)
    let rounds = 0
    while (store.getState().songs.hasMore && rounds < 50) {
      await store.getState().loadSongs(store.getState().songs.nextPage)
      rounds += 1
    }

    // 护栏已停下
    expect(store.getState().songs.stalled).toBe(true)
    const callsBefore = songs.mock.calls.length

    await store.getState().resumePaging('songs')

    // 只多发**一次**请求
    expect(songs.mock.calls.length).toBe(callsBefore + 1)
    // 请求的是「下一个没请求过的页码」：
    // 停下时 `nextPage` 停在最后请求过的那一页（= 阈值 + 1），下一个就是它 + 1。
    const requestedPage = songs.mock.calls.at(-1)?.[0]
    expect(requestedPage).toBe(LIBRARY_MAX_NO_PROGRESS_PAGES + 2)
    // 护栏被复位（不再是「永久停下」）
    expect(store.getState().songs.stalled).toBe(false)
    expect(store.getState().songs.noProgressPages).toBeLessThan(LIBRARY_MAX_NO_PROGRESS_PAGES)
  })

  it('store：没有停下时调用 resumePaging 是空操作（不发请求）', async () => {
    const songs = vi.fn(async (page: number) => ({ list: [makeSong(page)], total: 100 }))
    const store = createLibraryStore(createFakeApi({ songs }))

    await store.getState().loadSongs(1)
    await store.getState().resumePaging('songs')

    expect(songs).toHaveBeenCalledTimes(1)
  })

  it('界面：SongsPage 在护栏停下时给出「继续加载」按钮，点击后真的请求下一页', async () => {
    const { api, songs } = duplicateApi()
    const store = createLibraryStore(api)

    render(<SongsPage store={store} />)

    await waitFor(() => expect(store.getState().songs.stalled).toBe(true))
    const button = await screen.findByTestId('fnm-paging-resume-songs')
    expect(button.textContent).toContain('继续加载')

    fireEvent.click(button)

    // 「继续加载」请求的是**下一个没请求过的页码**（= 阈值 + 2）。
    await waitFor(() =>
      expect(songs.mock.calls.map((call) => call[0])).toContain(
        LIBRARY_MAX_NO_PROGRESS_PAGES + 2,
      ),
    )
    // 仍然**有上界**：恢复后护栏重新武装，最多再容忍阈值页就又停下
    // （不会变成无界的请求自旋）。
    await waitFor(() => expect(store.getState().songs.stalled).toBe(true))
    expect(songs.mock.calls.length).toBeLessThanOrEqual(
      LIBRARY_MAX_NO_PROGRESS_PAGES * 2 + 2,
    )
  })

  it('界面：没有停下时不渲染「继续加载」提示', async () => {
    const songs = vi.fn(async (page: number) => ({ list: [makeSong(page)], total: 100 }))
    const store = createLibraryStore(createFakeApi({ songs }))

    render(<SongsPage store={store} />)

    await waitFor(() => expect(store.getState().songs.loaded).toBe(true))
    expect(screen.queryByTestId('fnm-paging-resume-songs')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// P-LIB-3 / P1-6：收藏态单一真相源
// ---------------------------------------------------------------------------

describe('P-LIB-3 收藏态：单一真相源', () => {
  it('store：载入收藏列表后，收藏态以服务端列表为准', async () => {
    const api = createFakeApi({ favorites: vi.fn(async () => [makeSong(1)]) })
    const store = createLibraryStore(api)

    await store.getState().loadFavorites()

    expect(store.getState().isFavorite('song-1', false)).toBe(true)
    // 没登记过的歌曲用调用方给的兜底（搜索结果自带的收藏字段）
    expect(store.getState().isFavorite('song-2', false)).toBe(false)
    expect(store.getState().isFavorite('song-2', true)).toBe(true)
  })

  it('store：写回成功后收藏态更新，且服务端收藏列表被标记为过期', async () => {
    const store = createLibraryStore(createFakeApi())

    await store.getState().setFavorite('song-9', true, async () => undefined)

    expect(store.getState().isFavorite('song-9', false)).toBe(true)
    expect(store.getState().favoritesDirty).toBe(true)
  })

  it('store：写回失败时原样抛出，且收藏态与过期标记都不变', async () => {
    const store = createLibraryStore(createFakeApi())

    await expect(
      store.getState().setFavorite('song-9', true, async () => {
        throw new Error('服务端拒绝')
      }),
    ).rejects.toThrow('服务端拒绝')

    expect(store.getState().isFavorite('song-9', false)).toBe(false)
    expect(store.getState().favoritesDirty).toBe(false)
  })

  it('store：收藏列表已过期时 loadFavorites 会重新拉一份（不沿用旧列表）', async () => {
    const favorites = vi.fn(async () => [makeSong(1)])
    const store = createLibraryStore(createFakeApi({ favorites }))

    await store.getState().loadFavorites()
    expect(favorites).toHaveBeenCalledTimes(1)

    // 本地写回改过收藏态 → 服务端列表已过期
    await store.getState().setFavorite('song-2', true, async () => undefined)
    await store.getState().loadFavorites()

    expect(favorites).toHaveBeenCalledTimes(2)
  })

  it('界面：搜索页的收藏按钮显示态以 store 为准（不是各说各话）', async () => {
    // 服务端收藏列表里有 song-1；搜索结果自带的 `favorite` 却是 false。
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: [makeSong(1)], total: 1 },
        albums: { list: [] as Album[], total: 0 },
        artists: { list: [] as Artist[], total: 0 },
      })),
    })
    const store = createLibraryStore(
      createFakeApi({ favorites: vi.fn(async () => [makeSong(1)]) }),
    )
    await store.getState().loadFavorites()

    render(<SearchPanel api={api} store={store} debounceMs={0} />)
    await typeKeyword('甲')

    const button = await screen.findByTestId('fnm-favorite-toggle')
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('界面：搜索页收藏写回成功后，store 的收藏态同步更新', async () => {
    const setFavorite = vi.fn(async () => undefined)
    const api = makeSearchApi({
      query: vi.fn(async () => ({
        tracks: { list: [makeSong(1)], total: 1 },
        albums: { list: [] as Album[], total: 0 },
        artists: { list: [] as Artist[], total: 0 },
      })),
      setFavorite,
    })
    const store = createLibraryStore(createFakeApi())

    render(<SearchPanel api={api} store={store} debounceMs={0} />)
    await typeKeyword('甲')

    fireEvent.click(await screen.findByTestId('fnm-favorite-toggle'))

    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith('song-1', true))
    await waitFor(() => expect(store.getState().isFavorite('song-1', false)).toBe(true))
  })
})

// ---------------------------------------------------------------------------
// P-LIB-5 / P1-6：歌单写回两处小瑕疵
// ---------------------------------------------------------------------------

describe('P-LIB-5 歌单写回：清空选中 + 刷新 trackCount', () => {
  it('加入歌单成功后清空选中（不会重复加入同一批歌）', async () => {
    const store = createLibraryStore(createFakeApi())
    render(
      <SearchPage api={makeSearchApiWithSongs()} playlistApi={makePlaylistApi()} store={store} />,
    )
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌1'))

    const addButton = screen.getByTestId('fnm-add-to-playlist')
    await waitFor(() => expect((addButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(addButton)

    await waitFor(() => expect(screen.getByText('已选中 0 首歌曲')).toBeTruthy())
    await waitFor(() =>
      expect((screen.getByTestId('fnm-add-to-playlist') as HTMLButtonElement).disabled).toBe(true),
    )
  })

  it('移出歌单成功后同样清空选中', async () => {
    const store = createLibraryStore(createFakeApi())
    render(
      <SearchPage api={makeSearchApiWithSongs()} playlistApi={makePlaylistApi()} store={store} />,
    )
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌1'))

    const removeButton = screen.getByTestId('fnm-remove-from-playlist')
    await waitFor(() => expect((removeButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(removeButton)

    await waitFor(() => expect(screen.getByText('已选中 0 首歌曲')).toBeTruthy())
  })

  it('写回成功后刷新歌单列表（trackCount 跟上）', async () => {
    const list = vi.fn(async () => [PLAYLIST])
    const store = createLibraryStore(
      createFakeApi({
        playlists: vi.fn(async () => [{ ...PLAYLIST, trackCount: 4 }]),
      }),
    )

    render(
      <SearchPage
        api={makeSearchApiWithSongs()}
        playlistApi={makePlaylistApi({ list })}
        store={store}
      />,
    )
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌1'))

    fireEvent.click(await screen.findByTestId('fnm-add-to-playlist'))

    // store 里的歌单列表被刷新 → `trackCount` 跟上
    await waitFor(() => expect(store.getState().playlists.items).toHaveLength(1))
    expect(store.getState().playlists.items[0]?.trackCount).toBe(4)
    // 页内那份歌单列表也重新拉了一次
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('外部 onSelect 回调存在时，页内的选中计数照样更新', async () => {
    const onSelect = vi.fn()
    const store = createLibraryStore(createFakeApi())

    render(
      <SearchPage
        api={makeSearchApiWithSongs()}
        playlistApi={makePlaylistApi()}
        store={store}
        onSelect={onSelect}
      />,
    )
    await typeKeyword('甲')
    fireEvent.click(await screen.findByText('歌1'))

    await waitFor(() => expect(screen.getByText('已选中 1 首歌曲')).toBeTruthy())
    expect(onSelect).toHaveBeenCalledWith(['song-1'])
  })
})
