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
import { SongList } from '../components/SongList'
import { LibraryPageShell } from '../components/Cards'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'

/** `SongsPage` 的属性。 */
export interface SongsPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /** 双击歌曲时回调（真正的播放是 Task 15 的事）。 */
  onPlay?: (song: Song, index: number) => void
  /** 选中项变化时回调。 */
  onSelect?: (ids: string[]) => void
}

/** 歌曲页。 */
export function SongsPage({ api, store, onPlay, onSelect }: SongsPageProps): ReactElement {
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

  return (
    <LibraryPageShell
      title="歌曲"
      error={songs.error}
      loading={songs.loading}
      loadingText="正在加载歌曲…"
    >
      <SongList
        songs={songs.items}
        onPlay={onPlay ?? (() => undefined)}
        onSelect={onSelect}
        total={songs.total}
        hasMore={songs.hasMore}
        loading={songs.loading}
        onLoadMore={handleLoadMore}
        emptyLabel="暂无歌曲"
        ariaLabel="歌曲列表"
      />
    </LibraryPageShell>
  )
}
