// ---------------------------------------------------------------------------
// 搜索面板（Task 16）
//
// 内容：搜索框 + 三段结果（歌曲 / 专辑 / 歌手）+ 行内收藏按钮。
//
// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------
// - `searchApi.query(q, { page, size })` 返回**一个对象**，三个属性各是一页：
//   `tracks` / `albums` / `artists`（每个都是 `{ list, total }`）——见 `src/api/search.ts`；
// - 搜索**按分页方式**发起（带 `page` / `size`），并能容忍服务端**忽略分页参数**
//   （一次返回全量）——那种情况下**不再翻页**（详见 `mergeSection`）。
//
// ---------------------------------------------------------------------------
// 严禁全量拉取
// ---------------------------------------------------------------------------
// ⚠️ 真实曲库 17.3 万首：搜索**绝不**退化成「拉全库再本地过滤」。
//    - 单次请求的条数被 `SEARCH_PAGE_SIZE`（50）卡住；
//    - 服务端若忽略 `size`（返回条数 > 50），判定为「不支持分页」→ **不再翻页**；
//    - 界面上「加载更多」是**用户显式点击**才发下一页（不自动连拉）。
//
// ---------------------------------------------------------------------------
// 收藏写回的并发策略（控制器追加要求 C）
// ---------------------------------------------------------------------------
// 做法：**串行化**（同一首歌的写回排成一队，前一笔落地才发下一笔）。
//
// 理由：快速反复点击同一首歌时，若并发发出，服务端**处理顺序**可能与点击顺序相反，
//   最终态就与界面不一致（界面显示「已取消收藏」，服务端却是「已收藏」）。
//   串行化保证服务端按点击顺序依次处理 → 最终态 = 用户最后一次点击的意图。
//
// 另外配一条**序号守卫**：只有**最新一笔**写回失败才回滚；
//   过期的一笔失败**不回滚**更新的乐观态（否则会把用户刚点出来的状态抹掉）。
//
// 失败回滚的目标是「**已确认态**」= 最后一次写回成功的服务端态（不是"点之前"的旧值），
//   这样「收藏成功 → 取消失败」会回到「已收藏」，与服务端一致。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在 `src/components/search-panel.css`（组件有自己的 `.css`——仓库约定），
//    悬停 / 按下 / 焦点 / 禁用这类**伪类**只能靠样式表表达，内联 style 做不到。
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useStore } from 'zustand'

import type { Album, Artist, Song } from '../../shared/types'
import { favoriteApi } from '../api/favorite'
import { searchApi, type SearchResult } from '../api/search'
import type { Page } from '../api/types'
import {
  resolveFavoriteState,
  useResolvedLibraryStore,
  type LibraryStoreApi,
} from '../state/libraryStore'
import { AlbumCard, ArtistCard, CardGrid, formatCount } from './Cards'
import {
  createFavoriteWriteback,
  describeError,
  type FavoriteWriteback,
  type FavoriteWritebackState,
} from '../state/favoriteWriteback'
import { DownloadButton } from './DownloadButton'
import { FavoriteButton } from './FavoriteButton'
import { SongList } from './SongList'
import './search-panel.css'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 搜索防抖时长（毫秒）——输入停下来这么久才发起搜索。 */
export const SEARCH_DEBOUNCE_MS = 300

/**
 * 搜索单次请求的条数上限。
 *
 * ⚠️ **严禁全量拉取**：真实曲库 17.3 万首，搜索必须按页取。
 *    服务端若忽略 `size`（一次返回的条数超过这个值），就判定为「不支持分页」并停止翻页。
 */
export const SEARCH_PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// 接口（可注入，便于测试）
// ---------------------------------------------------------------------------

/** 搜索面板用到的接口集合。 */
export interface SearchPanelApi {
  /**
   * 搜索（歌曲 / 专辑 / 歌手三段，各是一页）。
   *
   * @param q 关键字
   * @param opts 分页（`page` / `size`）
   */
  query: (q: string, opts?: { page?: number; size?: number }) => Promise<SearchResult>
  /**
   * 收藏写回（**可选**）。
   *
   * 不提供时收藏按钮**禁用**（只读环境）。
   */
  setFavorite?: (songId: string, on: boolean) => Promise<void>
}

/** 默认实现：走 `src/api/*` 的真实实现。 */
export const defaultSearchPanelApi: SearchPanelApi = {
  query: (q, opts) => searchApi.query(q, opts),
  setFavorite: (songId, on) => favoriteApi.set(songId, on),
}

// ---------------------------------------------------------------------------
// 收藏写回（串行化 + 序号守卫）
// ---------------------------------------------------------------------------
//
// ⚠️ **实现已搬到 `src/state/favoriteWriteback.ts`**（Task 25）：
//    行内收藏要铺到**所有**列歌曲的页面 → 写回器必须是**公共件**；
//    每个页面各造一份就又成了「多个真相源」。
//
//    这里**继续原样导出** → 既有导入路径（`test/favorite-writeback.test.ts`）
//    **一个字都不用改**。

export { createFavoriteWriteback }
export type { FavoriteWriteback, FavoriteWritebackState }

// ---------------------------------------------------------------------------
// 分段状态
// ---------------------------------------------------------------------------

/** 一段结果的状态。 */
interface Section<T> {
  /** 已加载的条目（**只含已加载的部分**）。 */
  items: T[]
  /** 命中总数（服务端给的 `total`；不可信时退化成已加载条数）。 */
  total: number
  /** 下一个该请求的页码。 */
  nextPage: number
  /** 是否正在请求。 */
  loading: boolean
  /** 最后一次错误。 */
  error: string | null
  /** 是否至少成功加载过一次。 */
  loaded: boolean
  /** 是否还有更多（可点「加载更多」）。 */
  hasMore: boolean
}

/** 造一个空段。 */
function emptySection<T>(): Section<T> {
  return {
    items: [],
    total: 0,
    nextPage: 1,
    loading: false,
    error: null,
    loaded: false,
    hasMore: false,
  }
}

/** 三段合起来的状态。 */
interface SearchState {
  tracks: Section<Song>
  albums: Section<Album>
  artists: Section<Artist>
}

/** 造一份空的三段状态。 */
function emptyState(): SearchState {
  return {
    tracks: emptySection<Song>(),
    albums: emptySection<Album>(),
    artists: emptySection<Artist>(),
  }
}

/** 要更新哪一段。 */
type SectionTarget = 'all' | 'tracks' | 'albums' | 'artists'

/**
 * 把一页结果并进某一段。
 *
 * ⚠️ **服务端可能忽略分页参数**（一次返回全量）——这时**不再翻页**，
 *    否则会把 17.3 万首的曲库一页页拉完（严禁全量拉取）。
 *
 * ⚠️ **翻页决策不依赖服务端的 `total`**（简报明写「不要假设 `total` 一定准」）：
 *    `total` 偏小 / 为 0 时，若拿它当翻页依据，「加载更多」会**直接消失**
 *    （明明还有下一页，用户再也翻不动）。
 *    → 判据是「**本页返回条数达到请求的 size** 且**去重后有新增**」。
 *    `total` 只用于**显示**「命中 N 首」。
 */
function mergeSection<T extends { id: string }>(
  section: Section<T>,
  page: Page<T>,
  requestedPage: number,
): Section<T> {
  const seen = new Set(section.items.map((item) => item.id))
  const merged = [...section.items]
  for (const item of page.list) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  const added = merged.length - section.items.length
  // 返回条数超过请求的 size → 服务端**忽略了 size**（返回的是全量）→ 停止翻页。
  const ignoredPaging = page.list.length > SEARCH_PAGE_SIZE
  // 「本页无新增」= 服务端重复返回同一批 id → 停下（否则「加载更多」永远重复同一页）。
  // 「本页不足一整页」= 服务端大概率没有下一页了 → 也停下（不依赖 total）。
  const hasMore =
    !ignoredPaging && added > 0 && page.list.length >= SEARCH_PAGE_SIZE
  return {
    items: merged,
    total: Math.max(page.total, merged.length),
    nextPage: requestedPage + 1,
    loading: false,
    error: null,
    loaded: true,
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/** `SearchPanel` 的属性。 */
export interface SearchPanelProps {
  /** 注入的接口实现（测试用假实现；不传则走真实实现）。 */
  api?: SearchPanelApi
  /** 双击歌曲时回调（`list` 是当前搜索结果，便于整队入队）。 */
  onPlay?: (song: Song, index: number, list: Song[]) => void
  /**
   * 点专辑卡片时回调（下钻到专辑详情）。
   *
   * ⚠️ **T18-4**：搜索结果里的专辑 / 歌手卡片原来**没有**这个出口，
   *    卡片渲染出来却点不动（真机实测：搜索「十年一刻」点专辑卡片毫无反应）。
   */
  onOpenAlbum?: (album: Album) => void
  /** 点歌手卡片时回调（下钻到歌手详情）。⚠️ 同 `onOpenAlbum`（T18-4）。 */
  onOpenArtist?: (artist: Artist) => void
  /**
   * 选中歌曲变化时回调（id 数组，按搜索结果顺序）。
   *
   * ⚠️ 与 `selectedIds` 是一对：**同时**给 → 本组件进入**受控**模式
   *    （选中态由调用方持有）；只给 `onSelect` → 仍是内部自管（向后兼容）。
   */
  onSelect?: (ids: string[]) => void
  /**
   * 选中歌曲变化时回调（**歌曲对象**，不是 id）。
   *
   * ⚠️ **可选**（T27）：批量下载要的是歌曲本身（标题 / 歌手 / 扩展名），
   *    而 `onSelect` 只给 id → 调用方拿不到歌曲。
   *    不传 → 行为一字不变（只是少一次回调）。
   */
  onSelectSongs?: (songs: Song[]) => void
  /**
   * 受控模式下的选中项（id 数组）。
   *
   * ⚠️ **可选**：不传 → 选中态由 `SongList` 内部自管（既有行为，一字不变）。
   */
  selectedIds?: string[]
  /**
   * 注入的曲库 store（收藏态的**单一真相源**）。
   *
   * ⚠️ 不传则用默认单例 —— 与曲库页共用同一份收藏态，
   *    搜索页收藏的歌会**立刻**出现在收藏页里（审计 P-LIB-3 / P1-6）。
   */
  store?: LibraryStoreApi
  /**
   * 防抖时长（毫秒；缺省 `SEARCH_DEBOUNCE_MS`）。
   *
   * 只是一个**测试钩子**（让单测不必真的等 300ms）；生产用缺省值。
   */
  debounceMs?: number
}

/**
 * 搜索面板。
 *
 * - 输入即搜，但**防抖** `SEARCH_DEBOUNCE_MS` 毫秒（避免每敲一个字打一次 NAS）；
 * - 结果分**三段**：歌曲 / 专辑 / 歌手，各自带命中总数与「加载更多」；
 * - 歌曲段复用 `SongList`（双击播放 / 单选 / 多选），收藏按钮作为**行内操作**渲染。
 */
export function SearchPanel(props: SearchPanelProps): ReactElement {
  const {
    api = defaultSearchPanelApi,
    onPlay,
    onOpenAlbum,
    onOpenArtist,
    onSelect,
    onSelectSongs,
    selectedIds,
    store,
    debounceMs = SEARCH_DEBOUNCE_MS,
  } = props

  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>(emptyState)

  // 收藏态的**单一真相源**在 store 里（`favoriteStates`）。
  const resolved = useResolvedLibraryStore(undefined, store)
  const favoriteStates = useStore(resolved, (s) => s.favoriteStates)

  /** 搜索代次：换关键字就 +1；**过期响应一律丢弃**（避免旧结果盖掉新结果）。 */
  const generationRef = useRef(0)
  /** 收藏写回器（只造一次，状态跨渲染保留）。 */
  const writebackRef = useRef<FavoriteWriteback | null>(null)
  /** 最新的写回实现（`api` 变了也要用上最新的）。 */
  const setFavoriteRef = useRef(api.setFavorite)
  /** 最新的 store（`store` prop 变了也要用上最新的）。 */
  const resolvedRef = useRef(resolved)

  useEffect(() => {
    setFavoriteRef.current = api.setFavorite
  }, [api.setFavorite])

  useEffect(() => {
    resolvedRef.current = resolved
  }, [resolved])

  if (!writebackRef.current) {
    writebackRef.current = createFavoriteWriteback(async (songId, on) => {
      const fn = setFavoriteRef.current
      if (!fn) return Promise.reject(new Error('当前环境不支持收藏写回'))
      // ⚠️ 写回**成功**后由 store 登记「已确认态」→ 收藏页与搜索页共用一份
      //    （审计 P-LIB-3 / P1-6：之前这份状态只存在本组件的 writeback Map 里）。
      await resolvedRef.current.getState().setFavorite(songId, on, fn)
    })
  }
  const writeback = writebackRef.current

  const subscribe = useCallback(
    (listener: () => void) => writeback.subscribe(listener),
    [writeback],
  )
  const getSnapshot = useCallback(() => writeback.getSnapshot(), [writeback])
  /** 版本号：每次写回状态变化就 +1（用它作为依赖，强制重算派生数据）。 */
  const writebackVersion = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // --- 防抖 ---------------------------------------------------------------

  useEffect(() => {
    const keyword = text.trim()
    if (keyword.length === 0) {
      setQuery('')
      return undefined
    }
    const timer = setTimeout(() => setQuery(keyword), debounceMs)
    return () => clearTimeout(timer)
  }, [debounceMs, text])

  // --- 请求 ---------------------------------------------------------------

  /** 请求一页结果（三段一起回来，只更新 `target` 指定的那一段）。 */
  const loadPage = useCallback(
    async (
      keyword: string,
      page: number,
      target: SectionTarget,
    ): Promise<void> => {
      const generation = generationRef.current
      setState((prev) => {
        const next: SearchState = { ...prev }
        if (target === 'all' || target === 'tracks') {
          next.tracks = { ...prev.tracks, loading: true, error: null }
        }
        if (target === 'all' || target === 'albums') {
          next.albums = { ...prev.albums, loading: true, error: null }
        }
        if (target === 'all' || target === 'artists') {
          next.artists = { ...prev.artists, loading: true, error: null }
        }
        return next
      })
      try {
        const result = await api.query(keyword, { page, size: SEARCH_PAGE_SIZE })
        // 过期响应（用户已经换了关键字）→ 丢弃。
        if (generation !== generationRef.current) return
        setState((prev) => {
          const next: SearchState = { ...prev }
          if (target === 'all' || target === 'tracks') {
            next.tracks = mergeSection(prev.tracks, result.tracks, page)
          }
          if (target === 'all' || target === 'albums') {
            next.albums = mergeSection(prev.albums, result.albums, page)
          }
          if (target === 'all' || target === 'artists') {
            next.artists = mergeSection(prev.artists, result.artists, page)
          }
          return next
        })
      } catch (err) {
        if (generation !== generationRef.current) return
        const message = describeError(err)
        setState((prev) => {
          const next: SearchState = { ...prev }
          if (target === 'all' || target === 'tracks') {
            next.tracks = { ...prev.tracks, loading: false, error: message }
          }
          if (target === 'all' || target === 'albums') {
            next.albums = { ...prev.albums, loading: false, error: message }
          }
          if (target === 'all' || target === 'artists') {
            next.artists = { ...prev.artists, loading: false, error: message }
          }
          return next
        })
      }
    },
    [api],
  )

  // 关键字变化 → 重新搜索（第一页）。
  useEffect(() => {
    generationRef.current += 1
    writeback.clearError()
    if (query.length === 0) {
      setState(emptyState())
      return
    }
    setState(emptyState())
    void loadPage(query, 1, 'all')
  }, [query, loadPage, writeback])

  // --- 派生数据 -----------------------------------------------------------

  /** 叠加了乐观收藏态的歌曲列表。 */
  const effectiveTracks = useMemo(
    () =>
      state.tracks.items.map((song) => {
        // 基准值 = store 里的**已确认态**（未登记时用搜索结果自带的字段）。
        const base = resolveFavoriteState(favoriteStates, song.id, song.favorite)
        const entry = writeback.get(song.id, base)
        return entry.target === song.favorite ? song : { ...song, favorite: entry.target }
      }),
    // `writebackVersion` 变化说明收藏态变了 → 必须重算；
    // `favoriteStates` 变化说明 store 里的确认态变了 → 同样要重算。
    [favoriteStates, state.tracks.items, writeback, writebackVersion],
  )

  const tracksCount = Math.max(state.tracks.total, state.tracks.items.length)
  const albumsCount = Math.max(state.albums.total, state.albums.items.length)
  const artistsCount = Math.max(state.artists.total, state.artists.items.length)

  const searchError = state.tracks.error ?? state.albums.error ?? state.artists.error
  const favoriteError = writeback.getLastError()
  const hasAnyResult =
    state.tracks.items.length > 0 ||
    state.albums.items.length > 0 ||
    state.artists.items.length > 0
  const showEmpty = query.length > 0 && state.tracks.loaded && !hasAnyResult
  const busy =
    state.tracks.loading || state.albums.loading || state.artists.loading

  // --- 交互 ---------------------------------------------------------------

  /** 双击歌曲 → 播放（把当前搜索结果整队带出去）。 */
  const handlePlay = useCallback(
    (song: Song, index: number): void => {
      onPlay?.(song, index, effectiveTracks)
    },
    [effectiveTracks, onPlay],
  )

  /**
   * 选中变化 → 原样抛给 `onSelect`，并（可选）把**歌曲对象**抛给 `onSelectSongs`。
   *
   * ⚠️ `onSelect` 的**既有语义不变**（同样的 ids、同样的时机）。
   */
  const handleSelect = useCallback(
    (ids: string[]): void => {
      onSelect?.(ids)
      if (!onSelectSongs) return
      const byId = new Map<string, Song>()
      for (const song of effectiveTracks) byId.set(song.id, song)
      const picked: Song[] = []
      for (const id of ids) {
        const song = byId.get(id)
        if (song) picked.push(song)
      }
      onSelectSongs(picked)
    },
    [effectiveTracks, onSelect, onSelectSongs],
  )

  /** 行内操作：收藏按钮（乐观更新 + 串行化写回）+ 下载按钮（Task 11）。 */
  const renderRowActions = useCallback(
    (song: Song): ReactNode => {
      // 基准值 = store 里的**已确认态**（未登记时用搜索结果自带的字段）。
      const base = resolveFavoriteState(favoriteStates, song.id, song.favorite)
      const entry = writeback.get(song.id, base)
      const canWrite = Boolean(api.setFavorite) && song.id.length > 0
      return (
        <>
          {/* 收藏按钮（Task 25 抽成公共件；搜索页沿用它自己的样式钩子）。 */}
          <FavoriteButton
            song={song}
            favorite={entry.target}
            pending={entry.pending}
            disabled={!canWrite}
            className="fnm-searchpanel__favorite"
            onToggle={() => writeback.toggle(song.id, base)}
          />
          {/* 下载入口（Task 11）：同样是行内操作，点击不冒泡到行上。 */}
          <DownloadButton song={song} />
        </>
      )
    },
    [api.setFavorite, favoriteStates, writeback],
  )

  /** 「加载更多」：只补目标那一段。 */
  const handleLoadMore = useCallback(
    (target: Exclude<SectionTarget, 'all'>): void => {
      if (query.length === 0) return
      const page =
        target === 'tracks'
          ? state.tracks.nextPage
          : target === 'albums'
            ? state.albums.nextPage
            : state.artists.nextPage
      void loadPage(query, page, target)
    },
    [loadPage, query, state.albums.nextPage, state.artists.nextPage, state.tracks.nextPage],
  )

  // --- 渲染 ---------------------------------------------------------------

  return (
    <div className="fnm-searchpanel">
      <div className="fnm-searchpanel__bar">
        <label className="fnm-searchpanel__label" htmlFor="fnm-search-input">
          搜索
        </label>
        <input
          id="fnm-search-input"
          className="fnm-searchpanel__input"
          type="search"
          placeholder="搜索歌曲、专辑、歌手"
          aria-label="搜索关键字"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {busy && (
          <span className="fnm-searchpanel__status" role="status">
            搜索中…
          </span>
        )}
      </div>

      {searchError && (
        <p className="fnm-searchpanel__error" role="alert">
          {`搜索失败：${searchError}`}
        </p>
      )}

      {favoriteError && (
        <p className="fnm-searchpanel__error" role="alert">
          {`收藏写回失败：${favoriteError}`}
        </p>
      )}

      {showEmpty && <p className="fnm-searchpanel__empty">没有找到</p>}

      {/* --- 歌曲段 --- */}
      <section className="fnm-searchpanel__section" aria-label="歌曲结果">
        <header className="fnm-searchpanel__section-header">
          <h2 className="fnm-searchpanel__section-title">歌曲</h2>
          <span className="fnm-searchpanel__count" data-testid="fnm-search-count-tracks">
            {`命中 ${formatCount(tracksCount)} 首`}
          </span>
        </header>
        <SongList
          songs={effectiveTracks}
          onPlay={handlePlay}
          onSelect={handleSelect}
          selectedIds={selectedIds}
          total={state.tracks.total}
          emptyLabel="没有找到歌曲"
          ariaLabel="搜索结果歌曲列表"
          renderRowActions={renderRowActions}
        />
        {state.tracks.hasMore && (
          <button
            type="button"
            className="fnm-searchpanel__more"
            data-testid="fnm-load-more-tracks"
            disabled={state.tracks.loading}
            onClick={() => handleLoadMore('tracks')}
          >
            {state.tracks.loading ? '加载中…' : '加载更多'}
          </button>
        )}
      </section>

      {/* --- 专辑段 --- */}
      <section className="fnm-searchpanel__section" aria-label="专辑结果">
        <header className="fnm-searchpanel__section-header">
          <h2 className="fnm-searchpanel__section-title">专辑</h2>
          <span className="fnm-searchpanel__count" data-testid="fnm-search-count-albums">
            {`命中 ${formatCount(albumsCount)} 张专辑`}
          </span>
        </header>
        <CardGrid
          items={state.albums.items}
          keyOf={(album) => album.id}
          renderItem={(album) => <AlbumCard album={album} onOpen={onOpenAlbum} />}
          hasMore={false}
          loading={state.albums.loading}
          emptyLabel="没有找到专辑"
          ariaLabel="搜索结果专辑列表"
        />
        {state.albums.hasMore && (
          <button
            type="button"
            className="fnm-searchpanel__more"
            data-testid="fnm-load-more-albums"
            disabled={state.albums.loading}
            onClick={() => handleLoadMore('albums')}
          >
            {state.albums.loading ? '加载中…' : '加载更多'}
          </button>
        )}
      </section>

      {/* --- 歌手段 --- */}
      <section className="fnm-searchpanel__section" aria-label="歌手结果">
        <header className="fnm-searchpanel__section-header">
          <h2 className="fnm-searchpanel__section-title">歌手</h2>
          <span className="fnm-searchpanel__count" data-testid="fnm-search-count-artists">
            {`命中 ${formatCount(artistsCount)} 位歌手`}
          </span>
        </header>
        <CardGrid
          items={state.artists.items}
          keyOf={(artist) => artist.id}
          renderItem={(artist) => <ArtistCard artist={artist} onOpen={onOpenArtist} />}
          hasMore={false}
          loading={state.artists.loading}
          emptyLabel="没有找到歌手"
          ariaLabel="搜索结果歌手列表"
        />
        {state.artists.hasMore && (
          <button
            type="button"
            className="fnm-searchpanel__more"
            data-testid="fnm-load-more-artists"
            disabled={state.artists.loading}
            onClick={() => handleLoadMore('artists')}
          >
            {state.artists.loading ? '加载中…' : '加载更多'}
          </button>
        )}
      </section>
    </div>
  )
}
