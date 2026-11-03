// ---------------------------------------------------------------------------
// 搜索页（Task 16）
//
// 内容：
// - `SearchPanel`（搜索 + 三段结果 + 行内收藏按钮）；
// - **歌单写回区**：把搜索结果里选中的歌曲加入 / 移出歌单，并支持新建歌单。
//
// ---------------------------------------------------------------------------
// 歌单写回（控制器追加要求 D）
// ---------------------------------------------------------------------------
// - 只调**已有的** `playlistApi`（`list` / `create` / `addTracks` / `removeTracks`），
//   **不自己写请求**（`src/api/**` 不归本任务管）；
// - 增删曲目成功后**刷新歌单详情缓存**（`playlistApi.songs` 的结果 → 曲库 store 的
//   `playlistSongs`）；刷新走 `libraryStore.refreshPlaylistSongs`——
//   只有「当前正在看的那个歌单」才有缓存可刷新，刷新别的歌单会把歌单页的选中项切走；
// - ⚠️ **真实 NAS 的 `playlist/list` 返回空列表**（服务端现状，**不是 bug**）：
//   界面如实显示「暂无歌单」，不报错、不白屏；
// - ⚠️ **`playlist/create` 是否回显 guid 未实测**：返回空串时提示
//   「已创建，但未能拿到歌单标识」，并按**名字**在刷新后的列表里找回新建的歌单。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在 `src/pages/search-page.css`。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Playlist, Song } from '../../shared/types'
import { playlistApi } from '../api/playlist'
import { LibraryPageShell } from '../components/LibraryPageShell'
import {
  SearchPanel,
  defaultSearchPanelApi,
  type SearchPanelApi,
} from '../components/SearchPanel'
import { useResolvedLibraryStore, type LibraryStoreApi } from '../state/libraryStore'
import './search-page.css'

// ---------------------------------------------------------------------------
// 歌单写回接口（可注入，便于测试）
// ---------------------------------------------------------------------------

/** 歌单写回用到的接口集合。 */
export interface PlaylistWritebackApi {
  /** 歌单列表（**全量**接口）。 */
  list: () => Promise<Playlist[]>
  /** 新建歌单（返回新歌单的 guid；服务端不回显时是**空串**）。 */
  create: (name: string) => Promise<string>
  /** 把歌曲加入歌单。 */
  addTracks: (playlistId: string, songIds: string[]) => Promise<void>
  /** 把歌曲移出歌单。 */
  removeTracks: (playlistId: string, songIds: string[]) => Promise<void>
}

/** 默认实现：走 `src/api/playlist.ts` 的真实实现。 */
export const defaultPlaylistWritebackApi: PlaylistWritebackApi = {
  list: () => playlistApi.list(),
  create: (name) => playlistApi.create(name),
  addTracks: (playlistId, songIds) => playlistApi.addTracks(playlistId, songIds),
  removeTracks: (playlistId, songIds) => playlistApi.removeTracks(playlistId, songIds),
}

/** 把异常变成可读的文案。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '操作失败，请稍后重试'
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/** `SearchPage` 的属性。 */
export interface SearchPageProps {
  /** 注入的搜索 / 收藏接口（测试用假实现；不传则走真实实现）。 */
  api?: SearchPanelApi
  /** 注入的歌单写回接口（测试用假实现；不传则走真实实现）。 */
  playlistApi?: PlaylistWritebackApi
  /** 注入的曲库 store（用于刷新歌单详情缓存）。 */
  store?: LibraryStoreApi
  /** 双击歌曲时回调。 */
  onPlay?: (song: Song, index: number, list: Song[]) => void
  /** 选中歌曲变化时回调。 */
  onSelect?: (ids: string[]) => void
}

/** 搜索页。 */
export function SearchPage(props: SearchPageProps): ReactElement {
  const {
    api = defaultSearchPanelApi,
    playlistApi: playlistWriteback = defaultPlaylistWritebackApi,
    store,
    onPlay,
    onSelect,
  } = props

  const resolved = useResolvedLibraryStore(undefined, store)
  const refreshPlaylistSongs = useStore(resolved, (s) => s.refreshPlaylistSongs)

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState<string | null>(null)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 搜索结果里选中的歌曲 id。 */
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  /** 拉歌单列表（**全量**接口）；返回拉到的列表（新建后要按名字找回）。 */
  const loadPlaylists = useCallback(async (): Promise<Playlist[]> => {
    setPlaylistsLoading(true)
    setPlaylistsError(null)
    try {
      const list = await playlistWriteback.list()
      setPlaylists(list)
      setSelectedPlaylistId((prev) => {
        if (prev && list.some((item) => item.id === prev)) return prev
        return list[0]?.id ?? null
      })
      return list
    } catch (err) {
      setPlaylistsError(describeError(err))
      return []
    } finally {
      setPlaylistsLoading(false)
    }
  }, [playlistWriteback])

  useEffect(() => {
    void loadPlaylists()
  }, [loadPlaylists])

  /** 当前选中的歌单。 */
  const selectedPlaylist = playlists.find((item) => item.id === selectedPlaylistId) ?? null

  /** 新建歌单。 */
  const handleCreate = useCallback(async (): Promise<void> => {
    const name = newName.trim()
    if (name.length === 0) {
      setError('请填写歌单名称')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const guid = await playlistWriteback.create(name)
      const list = await loadPlaylists()
      if (guid.length > 0) {
        setSelectedPlaylistId(guid)
        setNewName('')
        setMessage(`歌单「${name}」已创建`)
        return
      }
      // ⚠️ 服务端没回显 guid（**未实测**）：按**名字**在刷新后的列表里找回，
      //    找得到就直接选中；找不到就如实提示（不假装成功）。
      const found = list.find((item) => item.name === name)
      if (found) {
        setSelectedPlaylistId(found.id)
        setMessage('已创建，但未能拿到歌单标识（服务端未回显 guid）；已按名称选中新建的歌单')
      } else {
        setMessage('已创建，但未能拿到歌单标识（服务端未回显 guid）')
      }
      setNewName('')
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }, [loadPlaylists, newName, playlistWriteback])

  /** 把选中的歌曲加入歌单。 */
  const handleAdd = useCallback(async (): Promise<void> => {
    if (!selectedPlaylistId) {
      setError('请先选择一个歌单')
      return
    }
    if (selectedIds.length === 0) {
      setError('请先在搜索结果里选中歌曲')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await playlistWriteback.addTracks(selectedPlaylistId, selectedIds)
      // 增删成功后**刷新歌单详情缓存**（`playlistApi.songs` 的结果）。
      await refreshPlaylistSongs(selectedPlaylistId)
      const name = selectedPlaylist?.name ?? '歌单'
      setMessage(`已把 ${selectedIds.length} 首加入歌单「${name}」`)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }, [playlistWriteback, refreshPlaylistSongs, selectedIds, selectedPlaylist, selectedPlaylistId])

  /** 把选中的歌曲移出歌单。 */
  const handleRemove = useCallback(async (): Promise<void> => {
    if (!selectedPlaylistId) {
      setError('请先选择一个歌单')
      return
    }
    if (selectedIds.length === 0) {
      setError('请先在搜索结果里选中歌曲')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await playlistWriteback.removeTracks(selectedPlaylistId, selectedIds)
      await refreshPlaylistSongs(selectedPlaylistId)
      const name = selectedPlaylist?.name ?? '歌单'
      setMessage(`已把 ${selectedIds.length} 首移出歌单「${name}」`)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }, [playlistWriteback, refreshPlaylistSongs, selectedIds, selectedPlaylist, selectedPlaylistId])

  const canWritePlaylist = Boolean(selectedPlaylistId) && selectedIds.length > 0 && !busy

  return (
    <LibraryPageShell
      title="搜索"
      error={playlistsError}
      loading={playlistsLoading}
      loadingText="正在加载歌单…"
    >
      <div className="fnm-searchpage">
        <SearchPanel api={api} onPlay={onPlay} onSelect={onSelect ?? setSelectedIds} />

        {/* --- 歌单写回 --- */}
        <section className="fnm-searchpage__playlists" aria-label="歌单写回">
          <header className="fnm-searchpage__section-header">
            <h2 className="fnm-searchpage__section-title">歌单</h2>
            <span className="fnm-searchpage__status">{`已选中 ${selectedIds.length} 首歌曲`}</span>
          </header>

          {playlists.length === 0 && !playlistsLoading && (
            <p className="fnm-searchpage__empty" data-testid="fnm-playlists-empty">
              暂无歌单
            </p>
          )}

          {playlists.length > 0 && (
            <label className="fnm-searchpage__field">
              <span className="fnm-searchpage__label">选择歌单</span>
              <select
                className="fnm-searchpage__select"
                value={selectedPlaylistId ?? ''}
                onChange={(event) => setSelectedPlaylistId(event.target.value || null)}
              >
                {playlists.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="fnm-searchpage__new">
            <input
              className="fnm-searchpage__input"
              type="text"
              aria-label="新歌单名称"
              placeholder="新歌单名称"
              autoComplete="off"
              spellCheck={false}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button
              type="button"
              className="fnm-searchpage__button"
              disabled={busy || newName.trim().length === 0}
              onClick={() => void handleCreate()}
            >
              新建歌单
            </button>
          </div>

          <div className="fnm-searchpage__actions">
            <button
              type="button"
              className="fnm-searchpage__button"
              data-testid="fnm-add-to-playlist"
              disabled={!canWritePlaylist}
              onClick={() => void handleAdd()}
            >
              加入所选歌曲
            </button>
            <button
              type="button"
              className="fnm-searchpage__button fnm-searchpage__button--secondary"
              data-testid="fnm-remove-from-playlist"
              disabled={!canWritePlaylist}
              onClick={() => void handleRemove()}
            >
              从歌单移除所选歌曲
            </button>
          </div>

          {message && (
            <p className="fnm-searchpage__message" role="status">
              {message}
            </p>
          )}
          {error && (
            <p className="fnm-searchpage__error" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    </LibraryPageShell>
  )
}
