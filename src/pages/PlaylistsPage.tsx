// ---------------------------------------------------------------------------
// 歌单页（Task 14；T26 起支持新建 / 删除歌单）
// ---------------------------------------------------------------------------
//
// - `playlistApi.list()` 是**全量**接口（实测该账号 2 个），可以一次取回；
// - **歌单里的歌曲仍然是分页的**（`playlistApi.songs(id, page, size)`），
//   所以歌单详情用 `SongList` 的虚拟滚动 + 增量加载（要求 B）。
//
// ---------------------------------------------------------------------------
// T26：为什么本页要能新建 / 删除歌单
// ---------------------------------------------------------------------------
// T16 把「新建歌单」做在了**搜索页**的写回区里 → 于是「建歌单」这件事
// **藏在一个跟歌单毫无关系的页面里**，而且那个账号**一个歌单都没有**
// （`playlist/list` → `total=0`）→ 用户打开「歌单」页只会看到一句
// 「暂无歌单」，**连建一个的地方都没有**。
//
// ⇒ 本页补上「新建歌单」入口（名字输入 + 按钮 + 成败提示），
//   建完**立刻刷新列表并选中**它。
// ⇒ 顺带补上「删除歌单」：只建不能删是条**单行道**（`playlistApi.remove` 早就存在）。
//
// ⚠️ **删除是两步确认**（点一次变成「确认删除？」，再点才真删）——
//    不用 `window.confirm`（Electron 里会弹原生模态框，jsdom 里也没法测）。
//
// ⚠️ **「把歌加进歌单」仍在搜索页**（T16 的写回区）：本页右侧展示的是
//    **当前歌单自己的歌**，在它里面选歌再加回自己说不通；
//    要从曲库批量加歌属于另一个功能（见台账遗留项）。
//
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Playlist, Song } from '../../shared/types'
import {
  defaultPlaylistWritebackApi,
  type PlaylistWritebackApi,
} from '../api/playlist'
import { CardGrid, PlaylistCard } from '../components/Cards'
import { BatchDownloadBar } from '../components/BatchDownloadBar'
import { useBatchSelection } from '../components/batchSelection'
import { useLibraryRowActions } from '../components/rowActions'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { PagingNotice } from '../components/PagingNotice'
import { SongList } from '../components/SongList'
import { useResolvedLibraryStore, type LibraryApi, type LibraryStoreApi } from '../state/libraryStore'
import './library-pages.css'

/** 把异常变成可读的文案。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '操作失败，请稍后重试'
}

/** `PlaylistsPage` 的属性。 */
export interface PlaylistsPageProps {
  /** 注入的接口实现（测试用假实现；不传则走 `src/api/*` 的真实实现）。 */
  api?: LibraryApi
  /** 注入的 store。 */
  store?: LibraryStoreApi
  /** 注入的歌单写回接口（测试用假实现；不传则走真实实现）。 */
  playlistApi?: PlaylistWritebackApi
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
  playlistApi = defaultPlaylistWritebackApi,
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
  const refreshPlaylists = useStore(resolved, (s) => s.refreshPlaylists)

  useEffect(() => {
    void loadPlaylists()
  }, [loadPlaylists])

  // --- 新建 / 删除歌单（T26）-------------------------------------------------
  /** 新歌单的名字（输入框）。 */
  const [newName, setNewName] = useState('')
  /** 写回在途（按钮禁用，防重复点击）。 */
  const [busy, setBusy] = useState(false)
  /** 写回失败的提示（没有则 `null`）。 */
  const [writebackError, setWritebackError] = useState<string | null>(null)
  /** 写回成功的提示（没有则 `null`）。 */
  const [message, setMessage] = useState<string | null>(null)
  /** 删除的**两步确认**：点一次变成「确认删除？」，再点才真删。 */
  const [confirmDelete, setConfirmDelete] = useState(false)

  /** 选中歌单 → 加载它的第一页歌曲。 */
  const handleOpen = useCallback(
    (playlist: Playlist): void => {
      setConfirmDelete(false)
      selectPlaylist(playlist.id)
      void loadPlaylistSongs(playlist.id, 1)
    },
    [loadPlaylistSongs, selectPlaylist],
  )

  /**
   * 新建歌单。
   *
   * ⚠️ **服务端不回显 guid 时不假装成功**：按**名字**在刷新后的列表里找回，
   *    找得到就选中它并说明原因；找不到就如实说「已创建，但未能拿到歌单标识」。
   */
  const handleCreate = useCallback(async (): Promise<void> => {
    const name = newName.trim()
    if (name.length === 0) {
      setWritebackError('请填写歌单名称')
      return
    }
    setBusy(true)
    setWritebackError(null)
    setMessage(null)
    try {
      const guid = await playlistApi.create(name)
      setNewName('')
      // ⚠️ **必须刷新列表**：新建的歌单要**当场出现在歌单列表里**。
      //    服务端返回的列表是旧的，不重拉就只看得见「已创建」的提示、列表里却没有它。
      await refreshPlaylists()
      if (guid.length > 0) {
        selectPlaylist(guid)
        void loadPlaylistSongs(guid, 1)
        setMessage(`歌单「${name}」已创建`)
        return
      }
      const items = resolved.getState().playlists.items
      const found = items.find((item) => item.name === name)
      if (found) {
        selectPlaylist(found.id)
        void loadPlaylistSongs(found.id, 1)
        setMessage('已创建，但未能拿到歌单标识（服务端未回显 guid）；已按名称选中新建的歌单')
      } else {
        setMessage('已创建，但未能拿到歌单标识（服务端未回显 guid）')
      }
    } catch (err) {
      setWritebackError(describeError(err))
    } finally {
      setBusy(false)
    }
  }, [loadPlaylistSongs, newName, playlistApi, refreshPlaylists, resolved, selectPlaylist])

  /** 删除当前选中的歌单（**两步确认**）。 */
  const handleDelete = useCallback(async (): Promise<void> => {
    if (!playlistId) return
    if (!confirmDelete) {
      // 第一步：只把按钮变成「确认删除？」，**什么都不做**。
      setConfirmDelete(true)
      return
    }
    if (!playlistApi.remove) {
      setWritebackError('当前环境不支持删除歌单')
      setConfirmDelete(false)
      return
    }
    setBusy(true)
    setWritebackError(null)
    setMessage(null)
    try {
      await playlistApi.remove(playlistId)
      await refreshPlaylists()
      selectPlaylist(null)
      setMessage('歌单已删除')
      setConfirmDelete(false)
    } catch (err) {
      setWritebackError(describeError(err))
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }, [confirmDelete, playlistApi, playlistId, refreshPlaylists, selectPlaylist])

  // ⚠️ 页码**直接读 store 的页码簿记**——不能用 `items.length / pageSize` 反推
  //    （短页 / 重复 id 会让翻页永久卡死，详见 `libraryStore.ts` 的 `nextPage`）。
  const nextPage = playlistSongs.nextPage
  const handleLoadMore = useCallback(() => {
    if (!playlistId) return
    void loadPlaylistSongs(playlistId, nextPage)
  }, [loadPlaylistSongs, nextPage, playlistId])

  // 行内操作（Task 25）：收藏按钮 + 下载按钮。
  const rowActions = useLibraryRowActions(resolved)

  // 批量下载（T27）：切歌单要**清空选中**（否则会下载上一张列表的歌）。
  const batch = useBatchSelection(playlistSongs.items, playlistId ?? '', onSelect)

  return (
    <LibraryPageShell
      title="歌单"
      error={playlists.error ?? playlistSongs.error}
      actionError={rowActions.error ?? writebackError}
      loading={playlists.loading}
      loadingText="正在加载歌单…"
    >
      <div className="fnm-playlists">
        <div className="fnm-playlists__side">
          {/* 新建歌单（T26）：这是「一个歌单都没有」的账号**唯一的建单入口**。 */}
          <div className="fnm-playlists__create">
            <input
              className="fnm-playlists__name"
              name="fnm-playlist-name"
              type="text"
              placeholder="新歌单名称"
              aria-label="新歌单名称"
              value={newName}
              disabled={busy}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button
              type="button"
              className="fnm-playlists__create-button"
              onClick={() => void handleCreate()}
              disabled={busy || newName.trim().length === 0}
            >
              新建歌单
            </button>
          </div>
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
            <>
              {/* 删除当前歌单（T26）：两步确认。 */}
              <div className="fnm-playlists__toolbar">
                <button
                  type="button"
                  className="fnm-playlists__delete"
                  onClick={() => void handleDelete()}
                  disabled={busy}
                >
                  {confirmDelete ? '确认删除？' : '删除歌单'}
                </button>
                {confirmDelete && (
                  <button
                    type="button"
                    className="fnm-playlists__cancel-delete"
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy}
                  >
                    取消
                  </button>
                )}
              </div>
              {/* 批量下载（T27）：选中后在这里排队下载。 */}
              <BatchDownloadBar songs={batch.selectedSongs} onClear={batch.clear} />
              <SongList
                songs={playlistSongs.items}
                onPlay={onPlay ?? (() => undefined)}
                onSelect={batch.onSelect}
                selectedIds={batch.selectedIds}
                total={playlistSongs.total}
                hasMore={playlistSongs.hasMore}
                loading={playlistSongs.loading}
                onLoadMore={handleLoadMore}
                emptyLabel="该歌单暂无歌曲"
                ariaLabel="歌单歌曲列表"
                renderRowActions={rowActions.render}
              />
            </>
          ) : (
            <p className="fnm-playlists__hint">
              {playlists.items.length > 0
                ? '请选择一个歌单'
                : '还没有歌单：在左边填个名字点「新建歌单」'}
            </p>
          )}
          {message && (
            <p className="fnm-playlists__message" role="status">
              {message}
            </p>
          )}
          {/* 分页被护栏拦下时的「继续加载」入口（T9）。 */}
          <PagingNotice kind="playlistSongs" store={resolved} />
        </div>
      </div>
    </LibraryPageShell>
  )
}
