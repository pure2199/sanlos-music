// ---------------------------------------------------------------------------
// 分页「继续加载」提示（T9）
//
// ⚠️ 为什么需要它（审计 P-LIB-4 / P1-5）：
//    分页护栏（`LIBRARY_MAX_NO_PROGRESS_PAGES`）在服务端**反复返回同一批数据**时
//    会主动停下（`stalled = true` / `hasMore = false` / `nextPage` 不前进）。
//    停下是必要的——否则页面的「内容填不满视口就自动续一页」effect 会变成
//    **无界的请求自旋**（复审实测 500ms 内 31 次请求，node 100% CPU）。
//    但停下之后界面**没有任何继续加载的入口** → 大列表可能被提前截断，
//    用户既看不到原因，也没法自救。
//    → 本组件给出提示 + 一个**用户显式触发**的「继续加载」按钮：
//      护栏复位一次，再请求**下一个没请求过的页码**。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在 `src/components/paging-notice.css`（组件有自己的 `.css`——仓库约定）。
// ---------------------------------------------------------------------------

import type { ReactElement } from 'react'
import { useStore } from 'zustand'

import {
  selectPagedCollection,
  useResolvedLibraryStore,
  type LibraryStoreApi,
  type PagedKind,
} from '../state/libraryStore'
import './paging-notice.css'

/** `PagingNotice` 的属性。 */
export interface PagingNoticeProps {
  /** 要看护栏状态的集合（决定读哪个集合、点「继续加载」时复位哪一个）。 */
  kind: PagedKind
  /** 注入的 store（不传则用默认单例）。 */
  store?: LibraryStoreApi
}

/**
 * 分页被护栏拦下时的提示 + 「继续加载」入口。
 *
 * ⚠️ **没有被护栏拦下时不渲染任何节点**（不占位、不打扰）。
 */
export function PagingNotice({ kind, store }: PagingNoticeProps): ReactElement | null {
  const resolved = useResolvedLibraryStore(undefined, store)
  const collection = useStore(resolved, (s) => selectPagedCollection(s, kind))
  const resumePaging = useStore(resolved, (s) => s.resumePaging)

  if (!collection.stalled) return null

  return (
    <div
      className="fnm-pagingnotice"
      role="status"
      data-testid={`fnm-paging-notice-${kind}`}
    >
      <p className="fnm-pagingnotice__text">服务端反复返回同一批数据，已停止自动加载。</p>
      <button
        type="button"
        className="fnm-pagingnotice__button"
        data-testid={`fnm-paging-resume-${kind}`}
        disabled={collection.loading}
        onClick={() => {
          void resumePaging(kind)
        }}
      >
        {collection.loading ? '加载中…' : '继续加载'}
      </button>
    </div>
  )
}
