// ---------------------------------------------------------------------------
// 曲库状态（**渲染进程**，zustand）
//
// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------
// 每个列表都是同一种结构 `LibraryCollection<T>`：
// `items`（已加载的条目）+ `total`（总量）+ `loading`（是否在请求）+
// `hasMore`（是否还有更多）+ `error`（最后一次错误）+ `loaded`（是否至少成功加载过一次）。
//
// 集合：`albums` / `artists` / `genres` / `songs` / `playlists` / `favorites` /
// `playlistSongs`（某个歌单里的歌）。
//
// ---------------------------------------------------------------------------
// 约定
// ---------------------------------------------------------------------------
// - **分页是硬要求**：曲库实测 17.3 万首 / 3.4 万专辑 / 1.5 万歌手，
//   `load*()` **只取一页**（`DEFAULT_PAGE_SIZE`），由页面在滚动到底部时增量加载。
//   本模块**没有任何「取全量」的入口**——收藏 / 歌单除外（那两个接口本身就是全量的）。
// - **追加语义**：重复调用 `load*()` **不会**把已加载的数据清空重来；
//   同一页重复请求是**幂等**的（不会把同一页追加两遍，也不会重复发请求）。
// - **分页护栏**：连续若干页「没有带来任何新条目」（服务端重复返回同一批 id）时，
//   本模块**主动停下**（`hasMore = false` + `nextPage` 不再前进）。
//   护栏落在 **store 层**——页面层的「内容填不满视口就自动续一页」effect
//   （`SongList` 与 `CardGrid` 各一处）因此**同时**被挡住，不会变成无界的请求自旋。
// - **不放任何凭证**：token / 口令只存在于主进程，本 store 一个都不碰。
// - 只用浏览器 API，不 import Node 内置模块或 Electron API。
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla'

import type { Album, Artist, Genre, Playlist, Song } from '../../shared/types'
import { DEFAULT_PAGE_SIZE } from '../api/client'
import { favoriteApi } from '../api/favorite'
import { libraryApi } from '../api/library'
import { playlistApi } from '../api/playlist'
import type { Page } from '../api/types'

// ---------------------------------------------------------------------------
// API 契约（可注入）
// ---------------------------------------------------------------------------

/**
 * 曲库页面用到的接口集合。
 *
 * 页面组件可以注入一份实现（测试用假实现，生产用默认实现），
 * 于是**测试不必打网络**（控制器追加要求 M）。
 */
export interface LibraryApi {
  /** 专辑列表（分页）。 */
  albums(page: number, size: number): Promise<Page<Album>>
  /** 歌手列表（分页）。 */
  artists(page: number, size: number): Promise<Page<Artist>>
  /** 风格列表（分页）。 */
  genres(page: number, size: number): Promise<Page<Genre>>
  /** 歌曲列表（分页）。 */
  songs(page: number, size: number): Promise<Page<Song>>
  /** 收藏列表（**全量**接口）。 */
  favorites(): Promise<Song[]>
  /** 歌单列表（**全量**接口）。 */
  playlists(): Promise<Playlist[]>
  /** 某歌单里的歌曲（**分页**）。 */
  playlistSongs(playlistId: string, page: number, size: number): Promise<Page<Song>>
}

/**
 * 连续「**本页无新增**」的页数上限（分页护栏的阈值）。
 *
 * ⚠️ 「本页无新增」= 服务端给了条数，但**全是已经加载过的 id**（重复 id）。
 *    - 它**不等于**「没有更多」：服务端排序不稳定 / 页码对不齐时，
 *      后面几页可能仍然有新数据 —— 直接停会把 17.3 万首的曲库**截断**；
 *    - 但也**不能**无限继续翻页：每页都没新增时，页码会一路往前推，
 *      页面又会在「内容填不满视口」时自动续页 → 变成**无界的请求自旋**
 *      （每一轮都打一次 API，列表永远不收敛，NAS 被持续轰炸）。
 *
 * → 连续这么多页都没进展，就认定这条翻页路径走不动了：停下（`hasMore = false`）。
 *
 * 阈值取 **3** 的理由：
 * - **≥ 2**：既有用例 `test/song-list.test.tsx`「相邻两页出现重复 id 时仍能翻到下一页」
 *   要求「重复一页之后再滚一次仍会请求第 3 页」——容忍 2 页重复，第 3 页照样会请求；
 * - **≤ 3**：真机上「偶尔一页重复」是常态（排序抖动 / 页码对不齐），
 *   容忍 3 页能吸收抖动，又足以让「服务端持续吐同一批数据」在**个位数**次请求内收敛
 *   （复审探针：500ms 内 31 次 → 修完后 4 次）；
 * - 真实曲库 17.3 万首 / 每页 50 条 ≈ 3474 页，只要**每页都有新条目**，
 *   计数永远是 0 → 护栏**一次也不会触发**，不会截断曲库。
 */
export const LIBRARY_MAX_NO_PROGRESS_PAGES = 3

/** 默认实现：走 `src/api/*` 的真实实现。 */
export const defaultLibraryApi: LibraryApi = {
  albums: (page, size) => libraryApi.albums(page, size),
  artists: (page, size) => libraryApi.artists(page, size),
  genres: (page, size) => libraryApi.genres(page, size),
  songs: (page, size) => libraryApi.songs(page, size),
  favorites: () => favoriteApi.list(),
  playlists: () => playlistApi.list(),
  playlistSongs: (playlistId, page, size) => playlistApi.songs(playlistId, page, size),
}

// ---------------------------------------------------------------------------
// 集合形状
// ---------------------------------------------------------------------------

/** 一个列表集合的状态。 */
export interface LibraryCollection<T> {
  /** 已加载的条目（**只含已加载的部分**，不是全量）。 */
  items: T[]
  /** 总量（服务端给的 `total`）。 */
  total: number
  /** 是否正在请求。 */
  loading: boolean
  /** 是否还有更多（`items.length < total`）。 */
  hasMore: boolean
  /** 最后一次错误（`null` 表示没有）。 */
  error: string | null
  /** 是否至少成功加载过一次。 */
  loaded: boolean
  /**
   * **下一个应该请求的页码**（页码簿记对外的视图）。
   *
   * ⚠️ 页面**必须**直接读这个值去请求下一页，
   *    **不能**用 `Math.floor(items.length / pageSize) + 1` 反推：
   *    - 服务端某页返回条数**少于** `pageSize`（短页）时，反推会退回已加载过的页；
   *    - 相邻两页出现**重复 id**（去重后不足整页）时，同样会退回；
   *    - 退回来的页码会被下面的**页码幂等守卫**变成空操作 →
   *      `hasMore` 仍为 true，但列表**永远停在原地**（不可恢复的功能性卡死）。
   *
   * 这里记录的是「**请求过**的页码」，与「**收到多少条**」无关——
   * 所以短页 / 重复 id 都**不会**让翻页停滞。
   *
   * ⚠️ 但「一直往前推」也不能没边：连续 `LIBRARY_MAX_NO_PROGRESS_PAGES` 页
   *    **都没带来新条目**时，本页簿记**停止前进**（并把 `hasMore` 置 false），
   *    否则重复 id 的页会把翻页变成**无界的请求自旋**（详见该常量的注释）。
   */
  nextPage: number
  /**
   * **连续「本页无新增」的页数**（分页护栏的计数）。
   *
   * - 「本页无新增」= 服务端给了条数，但全是已经加载过的 id（重复 id）；
   * - 只要有一页带来了**新条目**，计数就**归零**（重新开始数）；
   * - 空页（服务端说「没有更多了」）**不计入**——那不是护栏该管的事。
   */
  noProgressPages: number
  /**
   * 是否**因护栏停下**（连续无进展页数达到 `LIBRARY_MAX_NO_PROGRESS_PAGES`）。
   *
   * 护栏状态**暴露在集合上**，便于测试断言与 UI 反馈
   * （「服务端反复返回同一批数据，已停止继续翻页」）。
   */
  stalled: boolean
}

/** 造一个空集合。 */
function emptyCollection<T>(): LibraryCollection<T> {
  return {
    items: [],
    total: 0,
    loading: false,
    hasMore: false,
    error: null,
    loaded: false,
    nextPage: 1,
    noProgressPages: 0,
    stalled: false,
  }
}

/** 把异常变成可读的文案。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '加载失败，请稍后重试'
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** 曲库 store 的形状。 */
export interface LibraryStore {
  /** 专辑。 */
  albums: LibraryCollection<Album>
  /** 歌手。 */
  artists: LibraryCollection<Artist>
  /** 风格。 */
  genres: LibraryCollection<Genre>
  /** 歌曲（全部歌曲，分页）。 */
  songs: LibraryCollection<Song>
  /** 歌单（全量接口）。 */
  playlists: LibraryCollection<Playlist>
  /** 收藏（全量接口）。 */
  favorites: LibraryCollection<Song>
  /** 当前歌单里的歌曲（分页）。 */
  playlistSongs: LibraryCollection<Song>
  /** 当前选中的歌单 id。 */
  playlistId: string | null
  /** 每页条数。 */
  pageSize: number

  /** 加载专辑的某一页（追加语义；同一页幂等）。 */
  loadAlbums: (page?: number) => Promise<void>
  /** 加载歌手的某一页（追加语义；同一页幂等）。 */
  loadArtists: (page?: number) => Promise<void>
  /** 加载风格的某一页（追加语义；同一页幂等）。 */
  loadGenres: (page?: number) => Promise<void>
  /** 加载歌曲的某一页（追加语义；同一页幂等）。 */
  loadSongs: (page?: number) => Promise<void>
  /** 加载歌单列表（全量接口）。 */
  loadPlaylists: () => Promise<void>
  /** 加载收藏列表（全量接口）。 */
  loadFavorites: () => Promise<void>
  /** 加载某个歌单里的歌曲（分页；追加语义）。 */
  loadPlaylistSongs: (playlistId: string, page?: number) => Promise<void>
  /** 选中歌单（切换歌单会重置歌单内的歌曲列表）。 */
  selectPlaylist: (playlistId: string | null) => void
  /**
   * 刷新某个歌单里的歌曲（**清空后重取第一页**）。
   *
   * ⚠️ 这是「**追加语义**」的例外：增删曲目后必须重取，否则列表里还留着
   *    已被移走的歌、也看不到刚加进去的歌。
   *
   * ⚠️ **只刷新「当前正在看的那个歌单」**：缓存里只有它的歌；
   *    刷新别的歌单会把歌单页的选中项切走（那是「切换上下文」，不是「刷新缓存」）。
   */
  refreshPlaylistSongs: (playlistId: string) => Promise<void>
  /** 显式刷新歌单列表（清空后重取——这是「重复 load 不清空」的例外）。 */
  refreshPlaylists: () => Promise<void>
  /** 显式刷新收藏列表（清空后重取）。 */
  refreshFavorites: () => Promise<void>
}

/** store 的（vanilla）接口类型：页面注入时用这个类型。 */
export type LibraryStoreApi = StoreApi<LibraryStore>

/** 分页加载的通用参数。 */
interface PagedLoadParams<T> {
  /** 读当前集合。 */
  read: () => LibraryCollection<T>
  /** 写回集合。 */
  write: (next: LibraryCollection<T>) => void
  /** 已加载过的页码（用于幂等）。 */
  pages: Set<number>
  /** 取一页数据。 */
  fetcher: (page: number, size: number) => Promise<Page<T>>
  /** 条目的稳定标识（用于去重）。 */
  idOf: (item: T) => string
  /** 要加载的页码。 */
  page: number
}

/**
 * 造一个曲库 store（**依赖注入**）。
 *
 * @param api 接口实现；单测可以注入假实现，生产用 `defaultLibraryApi`。
 */
export function createLibraryStore(api: LibraryApi = defaultLibraryApi): LibraryStoreApi {
  // 已加载过的页码（不放在 state 里：它是幂等用的簿记，不是界面状态）。
  const pages = {
    albums: new Set<number>(),
    artists: new Set<number>(),
    genres: new Set<number>(),
    songs: new Set<number>(),
    playlistSongs: new Set<number>(),
  }

  /** 分页加载的真正实现（带 pageSize）。 */
  async function loadPage<T>(params: PagedLoadParams<T>, pageSize: number): Promise<void> {
    const { read, write, pages: loadedPages, fetcher, idOf, page } = params
    const current = read()

    if (current.loading) return
    if (loadedPages.has(page)) return

    write({ ...current, loading: true, error: null })
    try {
      const result = await fetcher(page, pageSize)
      const latest = read()
      const seen = new Set(latest.items.map((item) => idOf(item)))
      const merged = [...latest.items]
      for (const item of result.list) {
        const id = idOf(item)
        if (seen.has(id)) continue
        seen.add(id)
        merged.push(item)
      }
      loadedPages.add(page)

      // ---- 分页护栏 ------------------------------------------------------
      //
      // 「本页无新增」= 服务端给了条数，但**全是已经加载过的 id**（重复 id）。
      // 每页都没新增时：条数不增长 → `hasMore` 仍为 true → 页面层
      // 「内容填不满视口就自动续一页」的 effect 会继续触发 → **无界的请求自旋**。
      //
      // → 连续 `LIBRARY_MAX_NO_PROGRESS_PAGES` 页没有新条目就**停下**：
      //    `hasMore = false` **且** `nextPage` 不再前进（两者必须同时成立，
      //    否则 effect 仍会触发 / 页码簿记会空转）。
      const addedCount = merged.length - latest.items.length
      // 空页 = 服务端说「没有更多了」→ **不计入**「无进展」（那不是护栏该管的事）。
      const isEmptyPage = result.list.length === 0
      const noProgressPages =
        addedCount > 0 || isEmptyPage ? 0 : latest.noProgressPages + 1
      const stalled = noProgressPages >= LIBRARY_MAX_NO_PROGRESS_PAGES
      const hasMore = !stalled && merged.length < result.total && result.list.length > 0
      // 停下时页码簿记**不再前进**（`Math.max(latest.nextPage, page)` = 停在刚请求的那一页）。
      const nextPage = stalled
        ? Math.max(latest.nextPage, page)
        : Math.max(latest.nextPage, page + 1)

      write({
        items: merged,
        total: result.total,
        loading: false,
        hasMore,
        error: null,
        loaded: true,
        noProgressPages,
        stalled,
        // 页码簿记的对外视图：**请求过的页码**往前推一格。
        // （与 `items.length` 无关——短页 / 重复 id 都不会让翻页停滞；
        //   护栏停下时**不前进**，见上面的 `nextPage` 计算。）
        nextPage,
      })
    } catch (err) {
      const latest = read()
      write({ ...latest, loading: false, error: describeError(err) })
    }
  }

  /** 全量加载（收藏 / 歌单）：追加（按 id 去重），不清空。 */
  async function loadAll<T>(
    params: {
      read: () => LibraryCollection<T>
      write: (next: LibraryCollection<T>) => void
      fetcher: () => Promise<T[]>
      idOf: (item: T) => string
    },
    skipIfLoaded: boolean,
  ): Promise<void> {
    const { read, write, fetcher, idOf } = params
    const current = read()
    if (current.loading) return
    if (skipIfLoaded && current.loaded) return

    write({ ...current, loading: true, error: null })
    try {
      const result = await fetcher()
      const latest = read()
      const seen = new Set(latest.items.map((item) => idOf(item)))
      const merged = [...latest.items]
      for (const item of result) {
        const id = idOf(item)
        if (seen.has(id)) continue
        seen.add(id)
        merged.push(item)
      }
      write({
        items: merged,
        total: merged.length,
        loading: false,
        hasMore: false,
        error: null,
        loaded: true,
        // 全量接口：没有「下一页」，也没有分页护栏可言。
        nextPage: 1,
        noProgressPages: 0,
        stalled: false,
      })
    } catch (err) {
      const latest = read()
      write({ ...latest, loading: false, error: describeError(err) })
    }
  }

  const creator: StateCreator<LibraryStore> = (set, get) => {
    const pageSize = DEFAULT_PAGE_SIZE
    return {
      albums: emptyCollection<Album>(),
      artists: emptyCollection<Artist>(),
      genres: emptyCollection<Genre>(),
      songs: emptyCollection<Song>(),
      playlists: emptyCollection<Playlist>(),
      favorites: emptyCollection<Song>(),
      playlistSongs: emptyCollection<Song>(),
      playlistId: null,
      pageSize,

      loadAlbums: (page = 1) =>
        loadPage<Album>(
          {
            read: () => get().albums,
            write: (next) => set({ albums: next }),
            pages: pages.albums,
            fetcher: (p, size) => api.albums(p, size),
            idOf: (album) => album.id,
            page,
          },
          pageSize,
        ),

      loadArtists: (page = 1) =>
        loadPage<Artist>(
          {
            read: () => get().artists,
            write: (next) => set({ artists: next }),
            pages: pages.artists,
            fetcher: (p, size) => api.artists(p, size),
            idOf: (artist) => artist.id,
            page,
          },
          pageSize,
        ),

      loadGenres: (page = 1) =>
        loadPage<Genre>(
          {
            read: () => get().genres,
            write: (next) => set({ genres: next }),
            pages: pages.genres,
            fetcher: (p, size) => api.genres(p, size),
            idOf: (genre) => genre.guid,
            page,
          },
          pageSize,
        ),

      loadSongs: (page = 1) =>
        loadPage<Song>(
          {
            read: () => get().songs,
            write: (next) => set({ songs: next }),
            pages: pages.songs,
            fetcher: (p, size) => api.songs(p, size),
            idOf: (song) => song.id,
            page,
          },
          pageSize,
        ),

      loadPlaylists: () =>
        loadAll<Playlist>(
          {
            read: () => get().playlists,
            write: (next) => set({ playlists: next }),
            fetcher: () => api.playlists(),
            idOf: (playlist) => playlist.id,
          },
          true,
        ),

      loadFavorites: () =>
        loadAll<Song>(
          {
            read: () => get().favorites,
            write: (next) => set({ favorites: next }),
            fetcher: () => api.favorites(),
            idOf: (song) => song.id,
          },
          true,
        ),

      loadPlaylistSongs: (playlistId, page = 1) => {
        // 换歌单 = 换上下文：清空并重置页码簿记（**这是「不清空」的例外**）。
        if (get().playlistId !== playlistId) {
          pages.playlistSongs.clear()
          set({ playlistId, playlistSongs: emptyCollection<Song>() })
        }
        return loadPage<Song>(
          {
            read: () => get().playlistSongs,
            write: (next) => set({ playlistSongs: next }),
            pages: pages.playlistSongs,
            fetcher: (p, size) => api.playlistSongs(playlistId, p, size),
            idOf: (song) => song.id,
            page,
          },
          pageSize,
        )
      },

      selectPlaylist: (playlistId) => {
        if (get().playlistId === playlistId) return
        pages.playlistSongs.clear()
        set({ playlistId, playlistSongs: emptyCollection<Song>() })
      },

      refreshPlaylistSongs: async (playlistId) => {
        // 只有「当前正在看的那个歌单」才有缓存可刷新（见接口注释）。
        if (get().playlistId !== playlistId) return
        // 清空后重取第一页：追加语义在这里是错的（移走的歌会留在列表里）。
        pages.playlistSongs.clear()
        set({ playlistSongs: emptyCollection<Song>() })
        await get().loadPlaylistSongs(playlistId, 1)
      },

      refreshPlaylists: async () => {
        set({ playlists: emptyCollection<Playlist>() })
        await get().loadPlaylists()
      },

      refreshFavorites: async () => {
        set({ favorites: emptyCollection<Song>() })
        await get().loadFavorites()
      },
    }
  }

  return createStore<LibraryStore>(creator)
}

/** 默认曲库 store（生产用：真实 API 实现）。 */
export const libraryStore: LibraryStoreApi = createLibraryStore(defaultLibraryApi)

/** 默认 store 的选择器 hook（页面通常直接用 `useStore(store, selector)`）。 */
export function useLibraryStore<T>(selector: (state: LibraryStore) => T): T {
  return useStore(libraryStore, selector)
}

/**
 * 解析页面该用哪个 store。
 *
 * - 传了 `store` → 用它（测试可以完全控制状态）；
 * - 传了 `api` → 造一个**局部** store（测试不必打网络，也不污染全局状态）；
 * - 都没传 → 用默认 store。
 *
 * ⚠️ `api` 用 `useMemo` 记忆：父组件每次渲染都新建 `api` 字面量的话，
 *    局部 store 会被反复重建（订阅也会反复重挂）。
 */
export function useResolvedLibraryStore(
  api?: LibraryApi,
  store?: LibraryStoreApi,
): LibraryStoreApi {
  const local = useMemo(() => (api ? createLibraryStore(api) : null), [api])
  return store ?? local ?? libraryStore
}
