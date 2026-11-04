// ---------------------------------------------------------------------------
// 把选中的歌曲加入歌单（T28）
// ---------------------------------------------------------------------------
//
// 干什么
// ---------------------------------------------------------------------------
// 曲库列表页里多选若干首 → 点「加入歌单」→ 挑一个歌单 → 一次写回 NAS。
//
// ⚠️ **写回端点已真机校准**（T25 的探针 `tools/fn-writeback-probe.mjs`）：
//    `playlist/add-track` → `{ guid, trackGUIDs: [id] }` ✅ 真生效
//    （歌单详情里那几首**真的出现了**）。
//
// ---------------------------------------------------------------------------
// 两个刻意的设计
// ---------------------------------------------------------------------------
// 1. **歌单列表懒加载**：点开面板时才 `list()`。
//    五个曲库列表页若都 eager 拉一次，就是五次重复请求（而这列表是全量接口）。
// 2. **面板是浮层（absolute），不是展开的行**：
//    ⚠️ 展开成行会**改变工具条的高度** → 整个列表往下位移
//        → 用户（和 E2E）的**第二击落在别的行上** → 浏览器不再派发 `dblclick`
//        → **双击播放失效**（T27 踩过这个坑）。⇒ 浮层不占文档流，高度恒定。
//
// ---------------------------------------------------------------------------
// 写回之后
// ---------------------------------------------------------------------------
// - **清空选中**（和搜索页的既有行为一致）：不然用户会不小心把同一批歌**再加一遍**；
// - 面板**留在原地**显示「已把 N 首加入歌单「X」」——
//   ⚠️ 选中清空后本组件的 `songs` 变空，但面板**不能跟着消失**
//     （否则成功提示用户根本看不到）。
//
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { Song } from '../../shared/types'
import {
  defaultPlaylistWritebackApi,
  type PlaylistWritebackApi,
} from '../api/playlist'
import type { LibraryStoreApi } from '../state/libraryStore'
import './add-to-playlist.css'

/** `AddToPlaylist` 的属性。 */
export interface AddToPlaylistProps {
  /** 选中的歌曲（没选中时**不渲染**）。 */
  songs: Song[]
  /** 注入的歌单写回接口（测试用假实现；不传则走真实实现）。 */
  playlistApi?: PlaylistWritebackApi
  /**
   * 注入的曲库 store（用来**刷新缓存**）。
   *
   * ⚠️ 不传就**不会**刷新 → 用户打开该歌单看到的还是**旧列表** → 假成功。
   */
  store?: LibraryStoreApi
  /** 写回成功后回调（页面用它**清空选中**）。 */
  onAdded?: (playlistId: string, count: number) => void
}

/** 把异常变成可读的文案。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '操作失败，请稍后重试'
}

/**
 * 「加入歌单」控件。
 *
 * ⚠️ 没选中歌曲时**不渲染**（这个操作对没选中的歌没有意义）。
 */
export function AddToPlaylist({
  songs,
  playlistApi = defaultPlaylistWritebackApi,
  store,
  onAdded,
}: AddToPlaylistProps): ReactElement | null {
  /** 面板是否展开。 */
  const [open, setOpen] = useState(false)
  /** 歌单列表（点开时才拉）。 */
  const [playlists, setPlaylists] = useState<{ id: string; name: string }[]>([])
  /** 列表加载中。 */
  const [loading, setLoading] = useState(false)
  /** 当前选中的歌单 id。 */
  const [playlistId, setPlaylistId] = useState('')
  /** 在途（防重复点击）。 */
  const [busy, setBusy] = useState(false)
  /** 提示（成功）/ 错误（失败）。 */
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 面板容器（点外面关闭）。 */
  const panelRef = useRef<HTMLDivElement | null>(null)

  const count = songs.length

  /** 打开面板 → 懒加载歌单列表。 */
  const handleOpen = useCallback(async (): Promise<void> => {
    setOpen(true)
    setMessage(null)
    setError(null)
    setLoading(true)
    try {
      const list = await playlistApi.list()
      setPlaylists(list.map((item) => ({ id: item.id, name: item.name })))
      setPlaylistId((prev) => (prev && list.some((item) => item.id === prev) ? prev : (list[0]?.id ?? '')))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [playlistApi])

  /** 写回：把选中的歌加进选中的歌单。 */
  const handleAdd = useCallback(async (): Promise<void> => {
    if (!playlistId) {
      setError('请先选择一个歌单')
      return
    }
    if (count === 0) {
      setError('请先选中歌曲')
      return
    }
    const target = playlists.find((item) => item.id === playlistId)
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await playlistApi.addTracks(
        playlistId,
        songs.map((song) => song.id),
      )
      // ⚠️ **必须刷新缓存**（否则就是**假成功**）：
      //    写回成功后，歌单里的曲目变了 —— 而 store 里那个歌单的曲目**还缓存着旧的**
      //    （搜索页的写回区一直都有这一步：`refreshPlaylistSongs`）。
      //    不刷新的话：用户打开该歌单 → 看到的还是**旧列表**（比如空歌单）
      //    → 「明明加进去了，怎么没有？」。
      if (store) {
        // ⚠️ `LibraryStoreApi` 是 zustand 的 `StoreApi`（只有 getState / setState），
        //    动作在**状态里** → 经 `getState()` 取。
        const state = store.getState()
        await state.refreshPlaylistSongs(playlistId)
        // 歌单列表里的「N 首」也要跟上。
        await state.refreshPlaylists()
      }
      setMessage(`已把 ${count} 首加入歌单「${target?.name ?? '歌单'}」`)
      // ⚠️ **清空选中**：否则用户会不小心把同一批歌再加一遍。
      onAdded?.(playlistId, count)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }, [count, onAdded, playlistApi, playlistId, playlists, songs, store])

  // 点面板外面 → 关闭。
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      const panel = panelRef.current
      if (!panel) return
      if (event.target instanceof Node && panel.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  // ⚠️ 没选中**且**面板没开 → 不渲染。
  //    （写回成功后选中被清空，但面板要**留在原地**显示成功提示。）
  if (count === 0 && !open) return null

  return (
    <span className="fnm-addtoplaylist">
      <button
        type="button"
        className="fnm-addtoplaylist__open"
        data-testid="fnm-add-to-playlist-button"
        aria-label={`把选中的 ${count} 首加入歌单`}
        aria-expanded={open}
        disabled={count === 0 || busy}
        onClick={() => {
          if (open) setOpen(false)
          else void handleOpen()
        }}
      >
        加入歌单
      </button>

      {open && (
        // ⚠️ **浮层**：绝对定位 → 不占文档流 → 工具条高度恒定（列表不位移）。
        <span className="fnm-addtoplaylist__panel" ref={panelRef} role="group" aria-label="加入歌单">
          {loading && <span className="fnm-addtoplaylist__loading">正在加载歌单…</span>}

          {!loading && playlists.length === 0 && (
            <span className="fnm-addtoplaylist__empty">
              还没有歌单 —— 先到「歌单」页新建一个
            </span>
          )}

          {!loading && playlists.length > 0 && (
            <>
              <label className="fnm-addtoplaylist__field">
                <span className="fnm-addtoplaylist__label">选择歌单</span>
                <select
                  className="fnm-addtoplaylist__select"
                  aria-label="选择歌单"
                  value={playlistId}
                  onChange={(event) => setPlaylistId(event.target.value)}
                >
                  {playlists.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="fnm-addtoplaylist__confirm"
                disabled={busy || !playlistId || count === 0}
                onClick={() => void handleAdd()}
              >
                加入
              </button>
            </>
          )}

          <button
            type="button"
            className="fnm-addtoplaylist__cancel"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            取消
          </button>

          {message && (
            <span className="fnm-addtoplaylist__message" role="status">
              {message}
            </span>
          )}
          {error && (
            <span className="fnm-addtoplaylist__error" role="alert">
              {`操作失败：${error}`}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
