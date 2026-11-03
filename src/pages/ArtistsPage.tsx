// ---------------------------------------------------------------------------
// 歌手页（Task 14）
//
// - 数据来自 `libraryApi.artists()`（**分页**，实测 14,872 位歌手）；
// - 用 `CardGrid` 做虚拟网格裁剪：DOM 节点数与可视区成正比（要求 A）；
// - 滚到底部时增量加载**一页**。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Artist } from '../../shared/types'
import { ArtistCard, CardGrid, formatCount } from '../components/Cards'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { PagingNotice } from '../components/PagingNotice'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'

/** `ArtistsPage` 的属性。 */
export interface ArtistsPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /** 点击歌手卡片时回调。 */
  onOpenArtist?: (artist: Artist) => void
}

/** 歌手页。 */
export function ArtistsPage({ api, store, onOpenArtist }: ArtistsPageProps): ReactElement {
  const resolved = useResolvedLibraryStore(api, store)
  const artists = useStore(resolved, (s) => s.artists)
  const loadArtists = useStore(resolved, (s) => s.loadArtists)

  useEffect(() => {
    void loadArtists(1)
  }, [loadArtists])

  // ⚠️ 页码**直接读 store 的页码簿记**——不能用 `items.length / pageSize` 反推
  //    （短页 / 重复 id 会让翻页永久卡死，详见 `libraryStore.ts` 的 `nextPage`）。
  const nextPage = artists.nextPage
  const handleLoadMore = useCallback(() => {
    void loadArtists(nextPage)
  }, [loadArtists, nextPage])

  return (
    <LibraryPageShell
      title="歌手"
      status={`已加载 ${formatCount(artists.items.length)} / ${formatCount(artists.total)}`}
      error={artists.error}
      loading={artists.loading}
      loadingText="正在加载歌手…"
    >
      <CardGrid
        items={artists.items}
        keyOf={(artist) => artist.id}
        renderItem={(artist) => <ArtistCard artist={artist} onOpen={onOpenArtist} />}
        hasMore={artists.hasMore}
        loading={artists.loading}
        onLoadMore={handleLoadMore}
        emptyLabel="暂无歌手"
        ariaLabel="歌手列表"
      />
      {/* 分页被护栏拦下时的「继续加载」入口（T9）。 */}
      <PagingNotice kind="artists" store={resolved} />
    </LibraryPageShell>
  )
}
