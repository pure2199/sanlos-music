// ---------------------------------------------------------------------------
// 最近播放页（Task 7）
// ---------------------------------------------------------------------------
//
// 两段，**刻意不混**：
// 1. **本机播放记录**（本地 `localStorage`）：这台电脑上播过的歌；
// 2. **NAS 播放历史**（`GET /music/api/v1/play-history/list`，**只读**）：
//    服务端记录的那份——由 fnOS 音乐网页端 / 其它客户端写入。
//
// ⚠️ **服务端不会随 stream 自动写历史，也没有可用的上报端点**（实测），
//    所以本机播放记录**只能**留在本地（见 `src/state/historyStore.ts`）。
//
// ⚠️ **NAS 那份的顺序按服务端返回的来**——实测其排序依据不暴露给客户端，
//    客户端**不自行按时间戳排序**（否则会把「最近播放」排错）。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），
//    样式住在同目录的 `history-page.css`。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Song } from '../../shared/types'
import { AddToPlaylist } from '../components/AddToPlaylist'
import { BatchDownloadBar } from '../components/BatchDownloadBar'
import { useBatchSelection } from '../components/batchSelection'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { useLibraryRowActions } from '../components/rowActions'
import { PagingNotice } from '../components/PagingNotice'
import { SongList } from '../components/SongList'
import { useLocalHistory } from '../state/historyStore'
import { defaultPlaylistWritebackApi, type PlaylistWritebackApi } from '../api/playlist'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'
import './history-page.css'

/** `HistoryPage` 的属性。 */
export interface HistoryPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /** 注入的歌单写回接口（测试用假实现；不传则走真实实现）。 */
  playlistApi?: PlaylistWritebackApi
  /**
   * 双击歌曲时回调（整队口径：第三个参数是**当前列表已加载的整队**）。
   *
   * ⚠️ 两参回调（`(song, index) => void`）在类型上仍可赋值 → **纯增量**。
   */
  onPlay?: (song: Song, index: number, list: Song[]) => void
}

/** 最近播放页。 */
export function HistoryPage({
  api,
  store,
  playlistApi = defaultPlaylistWritebackApi,
  onPlay,
}: HistoryPageProps): ReactElement {
  const resolved = useResolvedLibraryStore(api, store)
  const history = useStore(resolved, (s) => s.history)
  const loadHistory = useStore(resolved, (s) => s.loadHistory)

  const localItems = useLocalHistory((s) => s.items)

  useEffect(() => {
    void loadHistory(1)
  }, [loadHistory])

  // ⚠️ 页码**直接读 store 的页码簿记**——不能用 `items.length / pageSize` 反推
  //    （短页 / 重复 id 会让翻页永久卡死，详见 `libraryStore.ts` 的 `nextPage`）。
  const nextPage = history.nextPage
  const handleLoadMore = useCallback(() => {
    void loadHistory(nextPage)
  }, [loadHistory, nextPage])

  // 行内操作（Task 25）：收藏按钮 + 下载按钮。
  const rowActions = useLibraryRowActions(resolved)

  // 批量下载（T27）：本页有**两段**列表（本机记录 + NAS 历史），
  // 但它们是**同一份页面级选中态** → 工具条画在整页上方。
  const pageSongs = useMemo(() => [...localItems, ...history.items], [history.items, localItems])
  const batch = useBatchSelection(pageSongs, 'history')

  return (
    <LibraryPageShell
      title="最近播放"
      status={`NAS 播放历史：已加载 ${history.items.length} / ${history.total}`}
      error={history.error}
      actionError={rowActions.error}
      loading={history.loading}
      loadingText="正在加载播放历史…"
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
      <div className="fnm-history">
        <section className="fnm-history__section">
          <h2 className="fnm-history__section-title">本机播放记录</h2>
          <p className="fnm-history__hint">这台电脑上播过的歌（只保存在本机，不会写回 NAS）</p>
          <SongList
            songs={localItems}
            onPlay={onPlay ?? (() => undefined)}
            onSelect={batch.onSelect}
            selectedIds={batch.selectedIds}
            total={localItems.length}
            emptyLabel="本机还没有播放记录"
            ariaLabel="本机播放记录"
            renderRowActions={rowActions.render}
          />
        </section>

        <section className="fnm-history__section">
          <h2 className="fnm-history__section-title">NAS 播放历史</h2>
          <p className="fnm-history__hint">
            fnOS 音乐服务记录的播放历史（服务端未开放写入接口，客户端只能读取）
          </p>
          <SongList
            songs={history.items}
            onPlay={onPlay ?? (() => undefined)}
            onSelect={batch.onSelect}
            selectedIds={batch.selectedIds}
            total={history.total}
            hasMore={history.hasMore}
            loading={history.loading}
            onLoadMore={handleLoadMore}
            emptyLabel="暂无播放历史"
            ariaLabel="NAS 播放历史"
            renderRowActions={rowActions.render}
          />
          {/* 分页被护栏拦下时的「继续加载」入口（T9）。 */}
          <PagingNotice kind="history" store={resolved} />
        </section>
      </div>
    </LibraryPageShell>
  )
}
