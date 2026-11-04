// ---------------------------------------------------------------------------
// 曲库详情页（Task 4 · 新版清单）
//
// 「专辑 / 歌手 / 风格」三个下钻目标**共用这一个视图**——
// 差别只有两点：
// 1. 取哪一份曲目（专辑曲目 / 歌手曲目 / 风格曲目）；
// 2. 歌手多一张**专辑网格**（点专辑可以再往下钻一层）。
//
// ---------------------------------------------------------------------------
// 数据从哪来
// ---------------------------------------------------------------------------
// - 详情接口（`/album/detail`、`/track/album-detail/list`、`/album/artist-detail/list`、
//   `/track/artist-detail/list`、`/track/genre-detail/list`）在 `src/api/library.ts`
//   里早就写好了，但一直**没人调用**（审计报表 P0-1「详情 API 死代码」）；
//   Task 4 把它们接进 `LibraryApi`，由本视图消费。
// - 加载动作在 `src/state/libraryStore.ts` 的 `openAlbum` / `openArtist` / `openGenre`
//   里；本页只负责**在进入时触发**它，并把集合渲染出来。
//
// ⚠️ **标题 / 封面是双来源**：详情接口只覆盖「专辑」（`/album/detail`），
//    歌手与风格**没有**对应的详情接口 → 头部用**卡片传来的原始对象**。
//    专辑则是「详情接口优先，查不到就回退到卡片数据」——
//    详情接口的返回形状**未实测**（校准项见联调清单 Step J），不能让它把界面搞空。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在同目录的 `detail-page.css`（页面级布局归页面自己）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Album, Song } from '../../shared/types'
import { AlbumCard, CardGrid, CoverImage, formatCount } from '../components/Cards'
import { useLibraryRowActions } from '../components/rowActions'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { PagingNotice } from '../components/PagingNotice'
import { SongList } from '../components/SongList'
import {
  useResolvedLibraryStore,
  type DetailKind,
  type LibraryApi,
  type LibraryStoreApi,
  type PagedKind,
} from '../state/libraryStore'
import './detail-page.css'

/** 头部封面的边长（像素，正方形）。 */
const DETAIL_COVER_SIZE = 96

/** `DetailPage` 的属性。 */
export interface DetailPageProps {
  /** 下钻的实体类型。 */
  kind: DetailKind
  /** 实体 id。 */
  entityId: string
  /** 实体标题（来自卡片的原始对象；专辑会被详情接口覆盖）。 */
  title: string
  /** 实体副标题（专辑 → 歌手名；歌手 → 专辑数/曲目数；风格 → 曲目数）。 */
  subtitle?: string
  /** 封面 id。 */
  coverId?: string | null
  /** 返回上一级。 */
  onBack: () => void
  /**
   * 双击歌曲时回调（整队口径：第三个参数是**当前已加载的整队**）。
   *
   * ⚠️ 两参回调（`(song, index) => void`）在类型上仍可赋值 → **纯增量**。
   */
  onPlay?: (song: Song, index: number, list: Song[]) => void
  /** 点击歌手详情里的专辑卡片时回调（再往下钻一层）。 */
  onOpenAlbum?: (album: Album) => void
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
}

/** 曲库详情页（专辑 / 歌手 / 风格共用）。 */
export function DetailPage(props: DetailPageProps): ReactElement {
  const {
    kind,
    entityId,
    title,
    subtitle,
    coverId,
    onBack,
    onPlay,
    onOpenAlbum,
    api,
    store,
  } = props

  const resolved = useResolvedLibraryStore(api, store)
  const albumDetail = useStore(resolved, (s) => s.albumDetail)
  const albumDetailError = useStore(resolved, (s) => s.albumDetailError)
  const albumSongs = useStore(resolved, (s) => s.albumSongs)
  const artistAlbums = useStore(resolved, (s) => s.artistAlbums)
  const artistSongs = useStore(resolved, (s) => s.artistSongs)
  const genreSongs = useStore(resolved, (s) => s.genreSongs)
  const openAlbum = useStore(resolved, (s) => s.openAlbum)
  const openArtist = useStore(resolved, (s) => s.openArtist)
  const openGenre = useStore(resolved, (s) => s.openGenre)

  // 下钻 = 换上下文：进入页面就载入对应实体的数据。
  // ⚠️ store 里的 `open*` 对**同一个实体**是幂等的 → StrictMode 双跑 effect 不会重复请求。
  useEffect(() => {
    if (kind === 'album') void openAlbum(entityId)
    else if (kind === 'artist') void openArtist(entityId)
    else void openGenre(entityId)
  }, [entityId, kind, openAlbum, openArtist, openGenre])

  // ---- 头部（标题 / 封面双来源）------------------------------------------
  const heading = kind === 'album' ? albumDetail?.title ?? title : title
  const cover = kind === 'album' ? albumDetail?.coverId ?? coverId : coverId

  // ---- 状态行 / 错误 / 加载中 ---------------------------------------------
  const songs = kind === 'album' ? albumSongs : kind === 'artist' ? artistSongs : genreSongs
  /** 曲目集合对应的分页键（给「继续加载」提示用）。 */
  const songsPagedKind: PagedKind =
    kind === 'album' ? 'albumSongs' : kind === 'artist' ? 'artistSongs' : 'genreSongs'
  const error =
    kind === 'album' ? albumSongs.error ?? albumDetailError : songs.error
  const loading = songs.loading

  const status =
    kind === 'artist'
      ? `曲目 ${formatCount(artistSongs.items.length)} / ${formatCount(artistSongs.total)} · 专辑 ${formatCount(artistAlbums.items.length)} / ${formatCount(artistAlbums.total)}`
      : `已加载 ${formatCount(songs.items.length)} / ${formatCount(songs.total)} 首`

  // ---- 增量加载 ------------------------------------------------------------
  const nextPage = songs.nextPage
  const handleLoadMore = useCallback(() => {
    if (kind === 'album') void resolved.getState().loadAlbumSongs(nextPage)
    else if (kind === 'artist') void resolved.getState().loadArtistSongs(nextPage)
    else void resolved.getState().loadGenreSongs(nextPage)
  }, [kind, nextPage, resolved])

  // 行内操作（Task 25）：收藏按钮 + 下载按钮。
  const rowActions = useLibraryRowActions(resolved)

  return (
    <LibraryPageShell
      title={heading}
      status={status}
      error={error}
      actionError={rowActions.error}
      loading={loading}
      loadingText="正在加载详情…"
    >
      <div className="fnm-detail">
        <div className="fnm-detail__head">
          <button type="button" className="fnm-detail__back" onClick={onBack}>
            返回
          </button>
          <CoverImage coverId={cover} alt="" boxSize={DETAIL_COVER_SIZE} />
          <p className="fnm-detail__subtitle">{subtitle}</p>
        </div>

        {kind === 'artist' && (
          <section className="fnm-detail__section">
            <h2 className="fnm-detail__section-title">专辑</h2>
            <CardGrid
              items={artistAlbums.items}
              keyOf={(album) => album.id}
              renderItem={(album) => <AlbumCard album={album} onOpen={onOpenAlbum} />}
              hasMore={artistAlbums.hasMore}
              loading={artistAlbums.loading}
              onLoadMore={() => void resolved.getState().loadArtistAlbums(artistAlbums.nextPage)}
              emptyLabel="暂无专辑"
              ariaLabel="歌手的专辑列表"
            />
            {/* 分页被护栏拦下时的「继续加载」入口（T9）。 */}
            <PagingNotice kind="artistAlbums" store={resolved} />
          </section>
        )}

        <section className="fnm-detail__section">
          <h2 className="fnm-detail__section-title">曲目</h2>
          <SongList
            songs={songs.items}
            onPlay={onPlay ?? (() => undefined)}
            total={songs.total}
            hasMore={songs.hasMore}
            loading={songs.loading}
            onLoadMore={handleLoadMore}
            emptyLabel="暂无曲目"
            ariaLabel="详情曲目列表"
            renderRowActions={rowActions.render}
          />
          {/* 分页被护栏拦下时的「继续加载」入口（T9）。 */}
          <PagingNotice kind={songsPagedKind} store={resolved} />
        </section>
      </div>
    </LibraryPageShell>
  )
}
