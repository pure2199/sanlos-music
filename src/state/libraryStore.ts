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
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla'

import type { Album, Artist, Genre, Playlist, Song } from '../../shared/types'
import { DEFAULT_PAGE_SIZE } from '../api/client'
import { favoriteApi } from '../api/favorite'
import { historyApi } from '../api/history'
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
  /**
   * 收藏写回（收藏 / 取消收藏）。
   *
   * ⚠️ **可选**：不提供时 `setFavorite` 会拒绝（界面提示「当前环境不支持收藏写回」）。
   *    做成可选是为了让「只读环境」的假实现不必硬造一个写回口。
   */
  setFavorite?: (songId: string, on: boolean) => Promise<void>
  /** 歌单列表（**全量**接口）。 */
  playlists(): Promise<Playlist[]>
  /** 某歌单里的歌曲（**分页**）。 */
  playlistSongs(playlistId: string, page: number, size: number): Promise<Page<Song>>

  // ---- 详情下钻（Task 4）------------------------------------------------
  //
  // ⚠️ 这五个接口在 `src/api/library.ts` 里**早就写好了但一直没人调用**
  //    （审计报表 P0-1「详情 API 死代码」）——Task 4 把它们接进来，
  //    由「专辑 / 歌手 / 风格」三个详情视图消费。
  //
  // ⚠️ `album()` 的**返回形状未实测**（服务端用列表信封返回，客户端取 `list[0]`），
  //    校准项见联调清单 **Step J**；查不到返回 `null`（不是抛异常）。

  /** 专辑详情（列表信封取第一条；查不到返回 `null`）。 */
  album(id: string): Promise<Album | null>
  /** 某专辑下的歌曲（分页）。 */
  albumSongs(id: string, page: number, size: number): Promise<Page<Song>>
  /** 某歌手的专辑（分页）。 */
  artistAlbums(id: string, page: number, size: number): Promise<Page<Album>>
  /** 某歌手的歌曲（分页）。 */
  artistSongs(id: string, page: number, size: number): Promise<Page<Song>>
  /** 某风格的歌曲（分页）。 */
  genreSongs(id: string, page: number, size: number): Promise<Page<Song>>
  /**
   * NAS 侧的播放历史（分页，**只读**）。
   *
   * ⚠️ 服务端**没有**可用的「上报播放」端点（实测，见 `src/api/history.ts` 的说明），
   *    所以这个接口**只能读**；客户端自己的播放记录走本地 store。
   * ⚠️ **顺序按服务端返回的来**——实测其排序依据不暴露给客户端，不要自行按时间戳排序。
   */
  history(page: number, size: number): Promise<Page<Song>>
}

/**
 * 下钻实体的类型（专辑 / 歌手 / 风格）。
 *
 * ⚠️ 三者共用**同一个**详情视图（`src/pages/DetailPage.tsx`）——
 *    差别只在「取哪一份曲目」以及「有没有专辑网格」。
 */
export type DetailKind = 'album' | 'artist' | 'genre'

/**
 * **可以「继续加载」的分页集合**（分页护栏停下后，用户可以手动重新武装一次）。
 *
 * ⚠️ 每一项都对应 store 里的**一个** `LibraryCollection`；
 *    `resumePaging` 按这个键找回「集合 + 加载器」。
 */
export type PagedKind =
  | 'albums'
  | 'artists'
  | 'genres'
  | 'songs'
  | 'playlistSongs'
  | 'albumSongs'
  | 'artistAlbums'
  | 'artistSongs'
  | 'genreSongs'
  | 'history'

/**
 * 按 `PagedKind` 取对应的集合（给界面读「是不是停下了」用）。
 *
 * ⚠️ 返回的是 store 里**同一个对象引用**（zustand 的选择器要靠引用稳定才不会每次重渲染）。
 */
export function selectPagedCollection(
  state: LibraryStore,
  kind: PagedKind,
): LibraryCollection<unknown> {
  switch (kind) {
    case 'albums':
      return state.albums
    case 'artists':
      return state.artists
    case 'genres':
      return state.genres
    case 'songs':
      return state.songs
    case 'playlistSongs':
      return state.playlistSongs
    case 'albumSongs':
      return state.albumSongs
    case 'artistAlbums':
      return state.artistAlbums
    case 'artistSongs':
      return state.artistSongs
    case 'genreSongs':
      return state.genreSongs
    case 'history':
      return state.history
  }
}

/**
 * 从收藏态表里解析某首歌的收藏态。
 *
 * - **登记过**（表里有这个 id）→ 以表为准（那是客户端的**已确认态**）；
 * - **没登记过** → 用调用方给的兜底值（搜索结果自带的 `song.favorite`）。
 *
 * ⚠️ 「登记过但值为 false」是有意义的：用户**取消收藏**后必须记住这件事，
 *    否则兜底值（服务端的 `favorite` 字段）会把它又变回「已收藏」。
 */
export function resolveFavoriteState(
  states: Record<string, boolean>,
  songId: string,
  fallback: boolean,
): boolean {
  return Object.prototype.hasOwnProperty.call(states, songId) ? states[songId] === true : fallback
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
  setFavorite: (songId, on) => favoriteApi.set(songId, on),
  playlists: () => playlistApi.list(),
  playlistSongs: (playlistId, page, size) => playlistApi.songs(playlistId, page, size),
  // ---- 详情下钻（Task 4）------------------------------------------------
  album: (id) => libraryApi.album(id),
  albumSongs: (id, page, size) => libraryApi.albumSongs(id, page, size),
  artistAlbums: (id, page, size) => libraryApi.artistAlbums(id, page, size),
  artistSongs: (id, page, size) => libraryApi.artistSongs(id, page, size),
  genreSongs: (id, page, size) => libraryApi.genreSongs(id, page, size),
  history: (page, size) => historyApi.list(page, size),
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
  /** 当前歌单里的歌曲（分页）——「**当前选中**歌单」的那一份缓存。 */
  playlistSongs: LibraryCollection<Song>
  /**
   * **各歌单的曲目缓存**（key = 歌单 id）。
   *
   * ⚠️ 为什么不能只有 `playlistSongs` 一个槽位：
   *    写回（加歌 / 删歌）之后要刷新的是**指定歌单**的缓存，
   *    而那个歌单**不一定是当前选中的那个**（歌单页根本没被挂载时更是如此）——
   *    单槽位只能存一份 → 刷新别的歌单就会把当前视图顶掉。
   *
   * → 缓存**按歌单 id 分开存**；`playlistSongs` 是「当前选中歌单」的那一份视图。
   */
  playlistSongsById: Record<string, LibraryCollection<Song>>
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
   * **刷新指定歌单**的曲目缓存（**清空后重取第一页**）。
   *
   * ⚠️ 这是「**追加语义**」的例外：增删曲目后必须重取，否则列表里还留着
   *    已被移走的歌、也看不到刚加进去的歌。
   *
   * ⚠️ **不受「当前选中歌单」守卫**：按传入的 `id` 直接拉取并**覆盖该歌单**的缓存，
   *    即使它不是当前选中的那个；找不到缓存条目就**新建**一条（不静默 no-op）。
   *    「守卫」属于 `selectPlaylist`（那是**切换上下文**），不属于「刷新缓存」——
   *    否则写回成功却没刷新缓存 = **假成功**。
   *
   * ⚠️ **不修改**「当前选中歌单」这个 UI 状态（`playlistId` 原样保留）。
   */
  refreshPlaylistSongs: (playlistId: string) => Promise<void>
  /** 显式刷新歌单列表（清空后重取——这是「重复 load 不清空」的例外）。 */
  refreshPlaylists: () => Promise<void>
  /** 显式刷新收藏列表（清空后重取）。 */
  refreshFavorites: () => Promise<void>

  // ---- 分页护栏的「继续加载」（T9）----------------------------------------
  //
  // ⚠️ 护栏停下后 `hasMore = false` / `nextPage` 不前进，界面**没有任何**继续加载的入口
  //    → 大列表可能被提前截断（审计 P-LIB-4 / P1-5）。
  //    → 这里补一个**用户显式触发**的入口：护栏复位 + 请求下一个页码。

  /**
   * 「继续加载」：把分页护栏复位，并请求**下一个没请求过的页码**。
   *
   * ⚠️ 只在被护栏拦下（`stalled = true`）时有效；否则是**空操作**（不发请求）。
   * ⚠️ 请求的页码是 `nextPage + 1`：停下时 `nextPage` 停在「最后请求过的那一页」
   *    （见 `loadPage` 的 `nextPage` 计算），下一个**没请求过**的页码就是它 + 1。
   */
  resumePaging: (kind: PagedKind) => Promise<void>

  // ---- 收藏态（单一真相源 · T9）------------------------------------------
  //
  // ⚠️ 之前 `SearchPanel` 的收藏乐观态存在**它自己的** writeback Map 里，
  //    与 `libraryStore.favorites` 不互通 → 搜索页与收藏页各说各话（审计 P-LIB-3 / P1-6）。
  //    → 收藏态统一收敛到本 store：写回成功后写进 `favoriteStates`，
  //      搜索页 / 收藏页都从这里读。

  /**
   * 收藏态（**已确认态**）：songId → 是否收藏。
   *
   * - 服务端收藏列表载入后，每首歌登记为 `true`；
   * - 写回成功后登记为该次写入的值（取消收藏登记为 `false`）。
   */
  favoriteStates: Record<string, boolean>
  /**
   * 服务端收藏列表是否已过期。
   *
   * ⚠️ 本地写回改过收藏态 → 服务端那份列表**不再完整**（新的收藏不在里面，
   *    取消掉的还在里面）→ 下次 `loadFavorites()` 必须**重新拉**，
   *    不能沿用 `loadAll` 的「已载入就跳过」语义。
   */
  favoritesDirty: boolean
  /**
   * 收藏写回。
   *
   * - `transport` = 真正的写回实现；不传则用 `LibraryApi.setFavorite`；
   * - **成功**后更新 `favoriteStates` 并把服务端列表标记为过期；
   * - **失败**时**原样抛出**（由调用方的写回器负责回滚乐观态）。
   */
  setFavorite: (
    songId: string,
    on: boolean,
    transport?: (songId: string, on: boolean) => Promise<void>,
  ) => Promise<void>
  /**
   * 某首歌当前**是否已收藏**。
   *
   * @param fallback 收藏态表里**没登记**这首歌时用的兜底值
   *   （通常是搜索结果自带的 `song.favorite` 字段）。
   */
  isFavorite: (songId: string, fallback: boolean) => boolean

  // ---- 详情下钻（Task 4）------------------------------------------------
  //
  // ⚠️ **下钻 = 换上下文**：和 `selectPlaylist` 一个语义 ——
  //    切到另一个实体时，旧实体的曲目**必须清空**，
  //    否则用户会看到「A 专辑的最后一首 + B 专辑的第一首」拼在一起。
  //
  // ⚠️ **幂等**：重复下钻**同一个**实体是空操作
  //    （React StrictMode 会把 effect 跑两遍；不加守卫会重复请求 + 重复重置）。

  /** 当前下钻实体的类型（`null` = 未下钻）。 */
  detailKind: DetailKind | null
  /** 当前下钻实体的 id。 */
  detailId: string | null
  /** 专辑详情（`openAlbum` 拉取；查不到 / 出错为 `null`）。 */
  albumDetail: Album | null
  /** 专辑详情是否正在加载。 */
  albumDetailLoading: boolean
  /** 专辑详情的错误。 */
  albumDetailError: string | null
  /** 专辑的曲目（分页）。 */
  albumSongs: LibraryCollection<Song>
  /** 歌手的专辑（分页）。 */
  artistAlbums: LibraryCollection<Album>
  /** 歌手的曲目（分页）。 */
  artistSongs: LibraryCollection<Song>
  /** 风格的曲目（分页）。 */
  genreSongs: LibraryCollection<Song>
  /** NAS 侧的播放历史（分页，**只读**；顺序按服务端返回的来）。 */
  history: LibraryCollection<Song>

  /** 下钻到某个专辑（载入详情 + 曲目第一页）。 */
  openAlbum: (albumId: string) => Promise<void>
  /** 加载专辑曲目的一页（追加语义；同一页幂等）。 */
  loadAlbumSongs: (page?: number) => Promise<void>
  /** 下钻到某个歌手（载入其专辑 + 曲目第一页）。 */
  openArtist: (artistId: string) => Promise<void>
  /** 加载歌手专辑的一页（追加语义；同一页幂等）。 */
  loadArtistAlbums: (page?: number) => Promise<void>
  /** 加载歌手曲目的一页（追加语义；同一页幂等）。 */
  loadArtistSongs: (page?: number) => Promise<void>
  /** 下钻到某个风格（载入曲目第一页）。 */
  openGenre: (genreId: string) => Promise<void>
  /** 加载风格曲目的一页（追加语义；同一页幂等）。 */
  loadGenreSongs: (page?: number) => Promise<void>
  /** 加载 NAS 播放历史的一页（追加语义；同一页幂等）。 */
  loadHistory: (page?: number) => Promise<void>
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
    history: new Set<number>(),
  }

  /**
   * 详情列表的页码簿记：**按实体 id 分开存**（Task 4）。
   *
   * ⚠️ 为什么不能像上面的 `pages` 那样用**一份**簿记：
   *    切到另一个实体时，旧实体的请求**可能还在飞**。
   *    若共用一份簿记，旧实体的响应回来后会往这份簿记里写「第 1 页已加载」，
   *    而新实体恰好也要第 1 页 → 被幂等守卫吞掉 → **新实体的列表永远空白**。
   *
   * → 每个实体一份簿记：旧实体的响应只污染它自己那份。
   */
  const detailPages = {
    albumSongs: new Map<string, Set<number>>(),
    artistAlbums: new Map<string, Set<number>>(),
    artistSongs: new Map<string, Set<number>>(),
    genreSongs: new Map<string, Set<number>>(),
  }

  /** 取（必要时新建）某个实体的页码簿记。 */
  function detailPageSet(map: Map<string, Set<number>>, entityId: string): Set<number> {
    const existing = map.get(entityId)
    if (existing) return existing
    const created = new Set<number>()
    map.set(entityId, created)
    return created
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

    /**
     * 载入专辑详情（服务端用列表信封返回，客户端取第一条）。
     *
     * ⚠️ **竞态守卫**：下钻已经切到别的实体时，这次结果**直接丢弃**
     *    （否则会把 A 专辑的详情写进 B 专辑的视图）。
     */
    async function loadAlbumDetail(albumId: string): Promise<void> {
      try {
        const album = await api.album(albumId)
        const state = get()
        if (state.detailKind !== 'album' || state.detailId !== albumId) return
        set({ albumDetail: album, albumDetailLoading: false, albumDetailError: null })
      } catch (err) {
        const state = get()
        if (state.detailKind !== 'album' || state.detailId !== albumId) return
        set({ albumDetailLoading: false, albumDetailError: describeError(err) })
      }
    }

    return {
      albums: emptyCollection<Album>(),
      artists: emptyCollection<Artist>(),
      genres: emptyCollection<Genre>(),
      songs: emptyCollection<Song>(),
      playlists: emptyCollection<Playlist>(),
      favorites: emptyCollection<Song>(),
      playlistSongs: emptyCollection<Song>(),
      playlistSongsById: {},
      playlistId: null,
      pageSize,
      // 收藏态（已确认态）——收藏页与搜索页都从这里读（T9）。
      favoriteStates: {},
      favoritesDirty: false,
      detailKind: null,
      detailId: null,
      albumDetail: null,
      albumDetailLoading: false,
      albumDetailError: null,
      albumSongs: emptyCollection<Song>(),
      artistAlbums: emptyCollection<Album>(),
      artistSongs: emptyCollection<Song>(),
      genreSongs: emptyCollection<Song>(),
      history: emptyCollection<Song>(),

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

      loadFavorites: async () => {
        const state = get()
        // ⚠️ 本地写回改过收藏态 → 服务端那份列表**不再完整** →
        //    必须**清空后重取**，不能沿用「已载入就跳过」的语义
        //    （否则新收藏的那首永远不出现在收藏页里）。
        if (state.favoritesDirty) {
          set({ favorites: emptyCollection<Song>(), favoritesDirty: false })
          await loadAll<Song>(
            {
              read: () => get().favorites,
              write: (next) => set({ favorites: next }),
              fetcher: () => api.favorites(),
              idOf: (song) => song.id,
            },
            false,
          )
        } else {
          await loadAll<Song>(
            {
              read: () => get().favorites,
              write: (next) => set({ favorites: next }),
              fetcher: () => api.favorites(),
              idOf: (song) => song.id,
            },
            true,
          )
        }
        // 把服务端确认的收藏态登记进 `favoriteStates`（单一真相源）。
        const items = get().favorites.items
        set((s) => {
          const next: Record<string, boolean> = { ...s.favoriteStates }
          for (const song of items) next[song.id] = true
          return { favoriteStates: next }
        })
      },

      loadPlaylistSongs: (playlistId, page = 1) => {
        // 换歌单 = 换上下文：清空并重置页码簿记（**这是「不清空」的例外**）。
        if (get().playlistId !== playlistId) {
          pages.playlistSongs.clear()
          set({ playlistId, playlistSongs: emptyCollection<Song>() })
        }
        return loadPage<Song>(
          {
            read: () => get().playlistSongs,
            // 缓存按歌单 id 分开存（写回后刷新的就是它）→ 每次写入都同步一份。
            write: (next) =>
              set((state) => ({
                playlistSongs: next,
                playlistSongsById: { ...state.playlistSongsById, [playlistId]: next },
              })),
            pages: pages.playlistSongs,
            fetcher: (p, size) => api.playlistSongs(playlistId, p, size),
            idOf: (song) => song.id,
            page,
          },
          pageSize,
        )
      },

      selectPlaylist: (playlistId) => {
        // ⚠️ **守卫属于这里**：「当前选中歌单」是**上下文**，
        //    重复选中同一个歌单是空操作，换歌单则重置该歌单的视图。
        if (get().playlistId === playlistId) return
        pages.playlistSongs.clear()
        set({ playlistId, playlistSongs: emptyCollection<Song>() })
      },

      refreshPlaylistSongs: async (playlistId) => {
        // ⚠️ **不受「当前选中歌单」守卫**：按传入的 id 直接拉取并覆盖**该歌单**的缓存。
        //    「守卫」属于 `selectPlaylist`（切换上下文），不属于「刷新缓存」。
        const isCurrent = get().playlistId === playlistId
        try {
          const result = await api.playlistSongs(playlistId, 1, pageSize)
          const collection: LibraryCollection<Song> = {
            items: result.list,
            total: result.total,
            loading: false,
            hasMore: result.list.length > 0 && result.list.length < result.total,
            error: null,
            loaded: true,
            nextPage: 2,
            noProgressPages: 0,
            stalled: false,
          }
          set((state) => {
            const next: Partial<LibraryStore> = {
              playlistSongsById: { ...state.playlistSongsById, [playlistId]: collection },
            }
            // 当前选中的正好是它 → 「当前歌单视图」也跟着更新
            //（但**不改** `playlistId`：刷新缓存不是切换上下文）。
            if (state.playlistId === playlistId) next.playlistSongs = collection
            return next
          })
          // 页码簿记重置：否则后续按页加载会被幂等守卫吞掉（视图停在第一页）。
          if (isCurrent) pages.playlistSongs.clear()
        } catch (err) {
          // ⚠️ 刷新失败**不抛**：写回本身已经成功，
          //    让异常冒到调用方会把「写回成功」误报成「写回失败」。
          const message = describeError(err)
          set((state) => ({
            playlistSongsById: {
              ...state.playlistSongsById,
              [playlistId]: {
                ...(state.playlistSongsById[playlistId] ?? emptyCollection<Song>()),
                loading: false,
                error: message,
              },
            },
          }))
        }
      },

      refreshPlaylists: async () => {
        set({ playlists: emptyCollection<Playlist>() })
        await get().loadPlaylists()
      },

      refreshFavorites: async () => {
        set({ favorites: emptyCollection<Song>() })
        await get().loadFavorites()
      },

      // ---- 分页护栏的「继续加载」（T9）--------------------------------------
      resumePaging: async (kind) => {
        const state = get()

        /**
         * 「继续加载」的通用实现。
         *
         * - 只在 `stalled` 时生效（否则是**空操作**：不发明请求）；
         * - 护栏复位（`noProgressPages = 0` / `stalled = false`），
         *   但**不动** `items` / `hasMore`（`hasMore` 由响应重新算）；
         * - 请求 `nextPage + 1`：停下时 `nextPage` 停在「最后请求过的那一页」，
         *   下一个**没请求过**的页码就是它 + 1。
         */
        const resume = async <T>(
          collection: LibraryCollection<T>,
          write: (next: LibraryCollection<T>) => void,
          load: (page: number) => Promise<void>,
        ): Promise<void> => {
          if (!collection.stalled) return
          write({ ...collection, noProgressPages: 0, stalled: false })
          await load(collection.nextPage + 1)
        }

        switch (kind) {
          case 'albums':
            return resume(state.albums, (next) => set({ albums: next }), (p) =>
              get().loadAlbums(p),
            )
          case 'artists':
            return resume(state.artists, (next) => set({ artists: next }), (p) =>
              get().loadArtists(p),
            )
          case 'genres':
            return resume(state.genres, (next) => set({ genres: next }), (p) =>
              get().loadGenres(p),
            )
          case 'songs':
            return resume(state.songs, (next) => set({ songs: next }), (p) =>
              get().loadSongs(p),
            )
          case 'playlistSongs': {
            const playlistId = state.playlistId
            if (!playlistId) return
            return resume(
              state.playlistSongs,
              (next) =>
                set((s) => ({
                  playlistSongs: next,
                  playlistSongsById: { ...s.playlistSongsById, [playlistId]: next },
                })),
              (p) => get().loadPlaylistSongs(playlistId, p),
            )
          }
          case 'albumSongs':
            return resume(state.albumSongs, (next) => set({ albumSongs: next }), (p) =>
              get().loadAlbumSongs(p),
            )
          case 'artistAlbums':
            return resume(state.artistAlbums, (next) => set({ artistAlbums: next }), (p) =>
              get().loadArtistAlbums(p),
            )
          case 'artistSongs':
            return resume(state.artistSongs, (next) => set({ artistSongs: next }), (p) =>
              get().loadArtistSongs(p),
            )
          case 'genreSongs':
            return resume(state.genreSongs, (next) => set({ genreSongs: next }), (p) =>
              get().loadGenreSongs(p),
            )
          case 'history':
            return resume(state.history, (next) => set({ history: next }), (p) =>
              get().loadHistory(p),
            )
        }
      },

      // ---- 收藏态（单一真相源 · T9）-----------------------------------------
      setFavorite: async (songId, on, transport) => {
        const fn = transport ?? api.setFavorite
        if (!fn) throw new Error('当前环境不支持收藏写回')
        await fn(songId, on)
        // 写回成功 → 更新**已确认态**；服务端那份列表随之过期（要重新拉）。
        set((state) => ({
          favoriteStates: { ...state.favoriteStates, [songId]: on },
          favoritesDirty: true,
        }))
      },

      isFavorite: (songId, fallback) =>
        resolveFavoriteState(get().favoriteStates, songId, fallback),

      // ---- 详情下钻（Task 4）--------------------------------------------
      openAlbum: async (albumId) => {
        // ⚠️ 幂等：重复下钻同一个专辑是空操作（StrictMode 会把 effect 跑两遍）。
        const state = get()
        if (state.detailKind === 'album' && state.detailId === albumId) return
        // 换上下文 = 重置该实体的页码簿记与集合。
        detailPageSet(detailPages.albumSongs, albumId).clear()
        set({
          detailKind: 'album',
          detailId: albumId,
          albumDetail: null,
          albumDetailLoading: true,
          albumDetailError: null,
          albumSongs: emptyCollection<Song>(),
        })
        // 详情与曲目**并行**拉（互不依赖，串行会把首屏时间翻倍）。
        await Promise.all([loadAlbumDetail(albumId), get().loadAlbumSongs(1)])
      },

      loadAlbumSongs: (page = 1) => {
        const state = get()
        if (state.detailKind !== 'album' || !state.detailId) return Promise.resolve()
        const albumId = state.detailId
        return loadPage<Song>(
          {
            read: () => get().albumSongs,
            write: (next) => {
              // ⚠️ 竞态守卫：下钻已切走 → 丢弃这次结果，别把旧专辑的曲目写进来。
              const now = get()
              if (now.detailKind !== 'album' || now.detailId !== albumId) return
              set({ albumSongs: next })
            },
            pages: detailPageSet(detailPages.albumSongs, albumId),
            fetcher: (p, size) => api.albumSongs(albumId, p, size),
            idOf: (song) => song.id,
            page,
          },
          pageSize,
        )
      },

      openArtist: async (artistId) => {
        const state = get()
        if (state.detailKind === 'artist' && state.detailId === artistId) return
        detailPageSet(detailPages.artistAlbums, artistId).clear()
        detailPageSet(detailPages.artistSongs, artistId).clear()
        set({
          detailKind: 'artist',
          detailId: artistId,
          artistAlbums: emptyCollection<Album>(),
          artistSongs: emptyCollection<Song>(),
        })
        await Promise.all([get().loadArtistAlbums(1), get().loadArtistSongs(1)])
      },

      loadArtistAlbums: (page = 1) => {
        const state = get()
        if (state.detailKind !== 'artist' || !state.detailId) return Promise.resolve()
        const artistId = state.detailId
        return loadPage<Album>(
          {
            read: () => get().artistAlbums,
            write: (next) => {
              const now = get()
              if (now.detailKind !== 'artist' || now.detailId !== artistId) return
              set({ artistAlbums: next })
            },
            pages: detailPageSet(detailPages.artistAlbums, artistId),
            fetcher: (p, size) => api.artistAlbums(artistId, p, size),
            idOf: (album) => album.id,
            page,
          },
          pageSize,
        )
      },

      loadArtistSongs: (page = 1) => {
        const state = get()
        if (state.detailKind !== 'artist' || !state.detailId) return Promise.resolve()
        const artistId = state.detailId
        return loadPage<Song>(
          {
            read: () => get().artistSongs,
            write: (next) => {
              const now = get()
              if (now.detailKind !== 'artist' || now.detailId !== artistId) return
              set({ artistSongs: next })
            },
            pages: detailPageSet(detailPages.artistSongs, artistId),
            fetcher: (p, size) => api.artistSongs(artistId, p, size),
            idOf: (song) => song.id,
            page,
          },
          pageSize,
        )
      },

      openGenre: async (genreId) => {
        const state = get()
        if (state.detailKind === 'genre' && state.detailId === genreId) return
        detailPageSet(detailPages.genreSongs, genreId).clear()
        set({ detailKind: 'genre', detailId: genreId, genreSongs: emptyCollection<Song>() })
        await get().loadGenreSongs(1)
      },

      loadGenreSongs: (page = 1) => {
        const state = get()
        if (state.detailKind !== 'genre' || !state.detailId) return Promise.resolve()
        const genreId = state.detailId
        return loadPage<Song>(
          {
            read: () => get().genreSongs,
            write: (next) => {
              const now = get()
              if (now.detailKind !== 'genre' || now.detailId !== genreId) return
              set({ genreSongs: next })
            },
            pages: detailPageSet(detailPages.genreSongs, genreId),
            fetcher: (p, size) => api.genreSongs(genreId, p, size),
            idOf: (song) => song.id,
            page,
          },
          pageSize,
        )
      },

      loadHistory: (page = 1) =>
        loadPage<Song>(
          {
            read: () => get().history,
            write: (next) => set({ history: next }),
            pages: pages.history,
            fetcher: (p, size) => api.history(p, size),
            idOf: (song) => song.id,
            page,
          },
          pageSize,
        ),
    }
  }

  return createStore<LibraryStore>(creator)
}

/** 默认曲库 store（生产用：真实 API 实现）。 */
export const libraryStore: LibraryStoreApi = createLibraryStore(defaultLibraryApi)

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
