// ---------------------------------------------------------------------------
// 风格页（Task 14）
//
// - 数据来自 `libraryApi.genres()`（**分页**，实测 592 个风格）；
// - 用 `CardGrid` 做虚拟网格裁剪（要求 A）；
// - 滚到底部时增量加载**一页**。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Genre } from '../../shared/types'
import { CardGrid, GenreCard, LibraryPageShell, formatCount } from '../components/Cards'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'

/** `GenresPage` 的属性。 */
export interface GenresPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /** 点击风格卡片时回调。 */
  onOpenGenre?: (genre: Genre) => void
}

/** 风格页。 */
export function GenresPage({ api, store, onOpenGenre }: GenresPageProps): ReactElement {
  const resolved = useResolvedLibraryStore(api, store)
  const genres = useStore(resolved, (s) => s.genres)
  const loadGenres = useStore(resolved, (s) => s.loadGenres)

  useEffect(() => {
    void loadGenres(1)
  }, [loadGenres])

  // ⚠️ 页码**直接读 store 的页码簿记**——不能用 `items.length / pageSize` 反推
  //    （短页 / 重复 id 会让翻页永久卡死，详见 `libraryStore.ts` 的 `nextPage`）。
  const nextPage = genres.nextPage
  const handleLoadMore = useCallback(() => {
    void loadGenres(nextPage)
  }, [loadGenres, nextPage])

  return (
    <LibraryPageShell
      title="风格"
      status={`已加载 ${formatCount(genres.items.length)} / ${formatCount(genres.total)}`}
      error={genres.error}
      loading={genres.loading}
      loadingText="正在加载风格…"
    >
      <CardGrid
        items={genres.items}
        keyOf={(genre) => genre.guid}
        renderItem={(genre) => <GenreCard genre={genre} onOpen={onOpenGenre} />}
        hasMore={genres.hasMore}
        loading={genres.loading}
        onLoadMore={handleLoadMore}
        emptyLabel="暂无风格"
        ariaLabel="风格列表"
      />
    </LibraryPageShell>
  )
}
