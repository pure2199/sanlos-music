// ---------------------------------------------------------------------------
// 收藏页（Task 14）
//
// - `favoriteApi.list()` 是**全量**接口（实测 251 首），可以一次取回；
// - 但列表仍然走 `SongList` 的**虚拟滚动**：DOM 节点数与可视区成正比，
//   收藏涨到几万首也不会铺满 DOM（要求 A / B）。
//
// ⚠️ 本页**只读**：不做收藏写回（那是 Task 16）。
// ---------------------------------------------------------------------------

import { useEffect, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Song } from '../../shared/types'
import { SongList } from '../components/SongList'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'

/** `FavoritesPage` 的属性。 */
export interface FavoritesPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
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

/** 收藏页。 */
export function FavoritesPage({ api, store, onPlay, onSelect }: FavoritesPageProps): ReactElement {
  const resolved = useResolvedLibraryStore(api, store)
  const favorites = useStore(resolved, (s) => s.favorites)
  const loadFavorites = useStore(resolved, (s) => s.loadFavorites)

  useEffect(() => {
    void loadFavorites()
  }, [loadFavorites])

  return (
    <LibraryPageShell
      title="收藏"
      error={favorites.error}
      loading={favorites.loading}
      loadingText="正在加载收藏…"
    >
      <SongList
        songs={favorites.items}
        onPlay={onPlay ?? (() => undefined)}
        onSelect={onSelect}
        total={favorites.total}
        // 收藏是全量接口：没有「下一页」。
        hasMore={false}
        loading={favorites.loading}
        emptyLabel="暂无收藏"
        ariaLabel="收藏列表"
      />
    </LibraryPageShell>
  )
}
