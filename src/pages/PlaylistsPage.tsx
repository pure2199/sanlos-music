// ---------------------------------------------------------------------------
// 歌单页（Task 14）
//
// - `playlistApi.list()` 是**全量**接口（实测该账号 2 个），可以一次取回；
// - **歌单里的歌曲仍然是分页的**（`playlistApi.songs(id, page, size)`），
//   所以歌单详情用 `SongList` 的虚拟滚动 + 增量加载（要求 B）。
//
// ⚠️ 本页**只读**：不做歌单增删改（那是 Task 16）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Playlist, Song } from '../../shared/types'
import { CardGrid, PlaylistCard } from '../components/Cards'
import { useLibraryRowActions } from '../components/rowActions'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { PagingNotice } from '../components/PagingNotice'
import { SongList } from '../components/SongList'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'
import './library-pages.css'

/** `PlaylistsPage` 的属性。 */
export interface PlaylistsPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /**
   * 双击歌曲时回调。
   *
   * ⚠️ **第三个参数 `list` 是「整队口径」**：当前歌单**已加载**的全部歌曲。
   *    消费方（`src/App.tsx`）用它调 `playerStore.playTrack(song, list)`
   *    → 整队入队并定位到点的那首。
   *
   * 两参回调（`(song, index) => void`）在类型上仍可赋值 → **纯增量**，既有调用方行为不变。
   */
  onPlay?: (song: Song, index: number, list: Song[]) => void
  /** 选中项变化时回调。 */
  onSelect?: (ids: string[]) => void
}

/** 歌单页。 */
export function PlaylistsPage({
  api,
  store,
  onPlay,
  onSelect,
}: PlaylistsPageProps): ReactElement {
  const resolved = useResolvedLibraryStore(api, store)
  const playlists = useStore(resolved, (s) => s.playlists)
  const playlistSongs = useStore(resolved, (s) => s.playlistSongs)
  const playlistId = useStore(resolved, (s) => s.playlistId)
  const loadPlaylists = useStore(resolved, (s) => s.loadPlaylists)
  const loadPlaylistSongs = useStore(resolved, (s) => s.loadPlaylistSongs)
  const selectPlaylist = useStore(resolved, (s) => s.selectPlaylist)

  useEffect(() => {
    void loadPlaylists()
  }, [loadPlaylists])

  /** 选中歌单 → 加载它的第一页歌曲。 */
  const handleOpen = useCallback(
    (playlist: Playlist): void => {
      selectPlaylist(playlist.id)
      void loadPlaylistSongs(playlist.id, 1)
    },
    [loadPlaylistSongs, selectPlaylist],
  )

  // ⚠️ 页码**直接读 store 的页码簿记**——不能用 `items.length / pageSize` 反推
  //    （短页 / 重复 id 会让翻页永久卡死，详见 `libraryStore.ts` 的 `nextPage`）。
  const nextPage = playlistSongs.nextPage
  const handleLoadMore = useCallback(() => {
    if (!playlistId) return
    void loadPlaylistSongs(playlistId, nextPage)
  }, [loadPlaylistSongs, nextPage, playlistId])

  // 行内操作（Task 25）：收藏按钮 + 下载按钮。
  const rowActions = useLibraryRowActions(resolved)

  return (
    <LibraryPageShell
      title="歌单"
      error={playlists.error ?? playlistSongs.error}
      actionError={rowActions.error}
      loading={playlists.loading}
      loadingText="正在加载歌单…"
    >
      <div className="fnm-playlists">
        <div className="fnm-playlists__side">
          <CardGrid
            items={playlists.items}
            keyOf={(playlist) => playlist.id}
            renderItem={(playlist) => (
              <PlaylistCard playlist={playlist} onOpen={handleOpen} />
            )}
            hasMore={false}
            loading={playlists.loading}
            emptyLabel="暂无歌单"
            ariaLabel="歌单列表"
          />
        </div>

        <div className="fnm-playlists__detail">
          {playlistId ? (
            <SongList
              songs={playlistSongs.items}
              onPlay={onPlay ?? (() => undefined)}
              onSelect={onSelect}
              total={playlistSongs.total}
              hasMore={playlistSongs.hasMore}
              loading={playlistSongs.loading}
              onLoadMore={handleLoadMore}
              emptyLabel="该歌单暂无歌曲"
              ariaLabel="歌单歌曲列表"
              renderRowActions={rowActions.render}
            />
          ) : (
            <p className="fnm-playlists__hint">请选择一个歌单</p>
          )}
          {/* 分页被护栏拦下时的「继续加载」入口（T9）。 */}
          <PagingNotice kind="playlistSongs" store={resolved} />
        </div>
      </div>
    </LibraryPageShell>
  )
}
