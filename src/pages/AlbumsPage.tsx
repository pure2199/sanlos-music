// ---------------------------------------------------------------------------
// 专辑页（Task 14）
//
// - 数据来自 `libraryApi.albums()`（**分页**，实测 34,071 张专辑）；
// - 页面只渲染**已加载**的部分，且用 `CardGrid` 做**虚拟网格**裁剪，
//   DOM 节点数与可视区成正比（要求 A）；
// - 滚到底部时增量加载**一页**（`DEFAULT_PAGE_SIZE`）。
//
// ⚠️ 本页**只读**：不做专辑编辑、不做搜索、不接播放条（Task 15/16）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Album } from '../../shared/types'
import { AlbumCard, CardGrid, LibraryPageShell, formatCount } from '../components/Cards'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'

/** `AlbumsPage` 的属性。 */
export interface AlbumsPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store（不传则用注入的 `api` 造一个局部 store，再不行用默认 store）。 */
  store?: LibraryStoreApi
  /** 点击专辑卡片时回调。 */
  onOpenAlbum?: (album: Album) => void
}

/** 专辑页。 */
export function AlbumsPage({ api, store, onOpenAlbum }: AlbumsPageProps): ReactElement {
  const resolved = useResolvedLibraryStore(api, store)
  const albums = useStore(resolved, (s) => s.albums)
  const loadAlbums = useStore(resolved, (s) => s.loadAlbums)
  const pageSize = useStore(resolved, (s) => s.pageSize)

  // 首次加载第一页（store 内部是幂等的，重复调用不会重复追加）。
  useEffect(() => {
    void loadAlbums(1)
  }, [loadAlbums])

  // 增量加载：每次只追加**一页**。
  const nextPage = Math.floor(albums.items.length / pageSize) + 1
  const handleLoadMore = useCallback(() => {
    void loadAlbums(nextPage)
  }, [loadAlbums, nextPage])

  return (
    <LibraryPageShell
      title="专辑"
      status={`已加载 ${formatCount(albums.items.length)} / ${formatCount(albums.total)}`}
      error={albums.error}
      loading={albums.loading}
      loadingText="正在加载专辑…"
    >
      <CardGrid
        items={albums.items}
        keyOf={(album) => album.id}
        renderItem={(album) => <AlbumCard album={album} onOpen={onOpenAlbum} />}
        hasMore={albums.hasMore}
        loading={albums.loading}
        onLoadMore={handleLoadMore}
        emptyLabel="暂无专辑"
        ariaLabel="专辑列表"
      />
    </LibraryPageShell>
  )
}
