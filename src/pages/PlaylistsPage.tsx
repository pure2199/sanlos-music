// ---------------------------------------------------------------------------
// 歌单页（Task 14）
//
// - `playlistApi.list()` 是**全量**接口（实测该账号 2 个），可以一次取回；
// - **歌单里的歌曲仍然是分页的**（`playlistApi.songs(id, page, size)`），
//   所以歌单详情用 `SongList` 的虚拟滚动 + 增量加载（要求 B）。
//
// ⚠️ 本页**只读**：不做歌单增删改（那是 Task 16）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, type CSSProperties, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Playlist, Song } from '../../shared/types'
import { CardGrid, LibraryPageShell, PlaylistCard } from '../components/Cards'
import { SongList } from '../components/SongList'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'

/** 双栏布局。 */
const PANES: CSSProperties = {
  display: 'flex',
  gap: '16px',
  flex: '1 1 auto',
  minHeight: 0,
}

/** 左侧歌单栏。 */
const SIDE: CSSProperties = {
  flex: '0 0 300px',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

/** 右侧歌曲栏。 */
const DETAIL: CSSProperties = {
  flex: '1 1 auto',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

/** 提示文案样式。 */
const HINT: CSSProperties = {
  margin: 0,
  padding: '24px 12px',
  fontSize: '13px',
  color: 'var(--text-secondary)',
}

/** `PlaylistsPage` 的属性。 */
export interface PlaylistsPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /** 双击歌曲时回调（真正的播放是 Task 15 的事）。 */
  onPlay?: (song: Song, index: number) => void
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

  return (
    <LibraryPageShell
      title="歌单"
      error={playlists.error ?? playlistSongs.error}
      loading={playlists.loading}
      loadingText="正在加载歌单…"
    >
      <div style={PANES}>
        <div style={SIDE}>
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

        <div style={DETAIL}>
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
            />
          ) : (
            <p className="fnm-playlists__hint" style={HINT}>
              请选择一个歌单
            </p>
          )}
        </div>
      </div>
    </LibraryPageShell>
  )
}
