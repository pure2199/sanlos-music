// ---------------------------------------------------------------------------
// 歌曲页（Task 14）
//
// - 数据来自 `libraryApi.songs()`（**分页**，实测 17.3 万首）；
// - 列表用 `SongList`（**虚拟滚动**：DOM 节点数与可视区成正比，与总量无关）；
// - 滚到底部时增量加载**一页**；
// - 「播放」只是把 `onPlay` 抛出去——真正的播放条是 Task 15（要求 I）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Song } from '../../shared/types'
import { AddToPlaylist } from '../components/AddToPlaylist'
import { BatchDownloadBar } from '../components/BatchDownloadBar'
import { useBatchSelection } from '../components/batchSelection'
import { SongList } from '../components/SongList'
import { useLibraryRowActions } from '../components/rowActions'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { PagingNotice } from '../components/PagingNotice'
import { defaultPlaylistWritebackApi, type PlaylistWritebackApi } from '../api/playlist'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'

/** `SongsPage` 的属性。 */
export interface SongsPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /** 注入的歌单写回接口（测试用假实现；不传则走真实实现）。 */
  playlistApi?: PlaylistWritebackApi
  /**
   * 双击歌曲时回调。
   *
   * ⚠️ **第三个参数 `list` 是「整队口径」**：当前页**已加载**的全部歌曲。
   *    消费方（`src/App.tsx`）用它调 `playerStore.playTrack(song, list)`
   *    → 整队入队并定位到点的那首。
   *
   * 两参回调（`(song, index) => void`）在类型上仍可赋值 → **纯增量**，既有调用方行为不变。
   */
  onPlay?: (song: Song, index: number, list: Song[]) => void
  /** 选中项变化时回调。 */
  onSelect?: (ids: string[]) => void
}

/** 歌曲页。 */
export function SongsPage({
  api,
  store,
  playlistApi = defaultPlaylistWritebackApi,
  onPlay,
  onSelect,
}: SongsPageProps): ReactElement {
  const resolved = useResolvedLibraryStore(api, store)
  const songs = useStore(resolved, (s) => s.songs)
  const loadSongs = useStore(resolved, (s) => s.loadSongs)

  useEffect(() => {
    void loadSongs(1)
  }, [loadSongs])

  // ⚠️ 页码**直接读 store 的页码簿记**——不能用 `items.length / pageSize` 反推
  //    （短页 / 重复 id 会让翻页永久卡死，详见 `libraryStore.ts` 的 `nextPage`）。
  const nextPage = songs.nextPage
  const handleLoadMore = useCallback(() => {
    void loadSongs(nextPage)
  }, [loadSongs, nextPage])

  // 行内操作（Task 25）：收藏按钮 + 下载按钮（复用 `SongList` 已有的 `renderRowActions` 接缝）。
  const rowActions = useLibraryRowActions(resolved)

  // 批量下载（T27）：选中态**提到页面**（受控）→ 顶部才画得出「已选 N 首」。
  const batch = useBatchSelection(songs.items, 'songs', onSelect)

  return (
    <LibraryPageShell
      title="歌曲"
      error={songs.error}
      actionError={rowActions.error}
      loading={songs.loading}
      loadingText="正在加载歌曲…"
    >
      <BatchDownloadBar
        songs={batch.selectedSongs}
        onClear={batch.clear}
        extra={
          <AddToPlaylist
            songs={batch.selectedSongs}
            playlistApi={playlistApi}
            store={resolved}
            onAdded={batch.clear}
          />
        }
      />
      <SongList
        songs={songs.items}
        onPlay={onPlay ?? (() => undefined)}
        onSelect={batch.onSelect}
        selectedIds={batch.selectedIds}
        total={songs.total}
        hasMore={songs.hasMore}
        loading={songs.loading}
        onLoadMore={handleLoadMore}
        emptyLabel="暂无歌曲"
        ariaLabel="歌曲列表"
        renderRowActions={rowActions.render}
      />
      {/* 分页被护栏拦下时的「继续加载」入口（T9）。 */}
      <PagingNotice kind="songs" store={resolved} />
    </LibraryPageShell>
  )
}
