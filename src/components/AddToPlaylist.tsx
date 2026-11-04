// ---------------------------------------------------------------------------
// 把选中的歌曲加入歌单（T28 / T30）
// ---------------------------------------------------------------------------
//
// 干什么
// ---------------------------------------------------------------------------
// 曲库列表页里多选若干首 → 点「加入歌单」→ 挑一个或**几个**歌单 → 一次写回 NAS。
//
// ⚠️ **写回端点已真机校准**（T25 的探针 `tools/fn-writeback-probe.mjs`）：
//    `playlist/add-track` → `{ guid, trackGUIDs: [id] }` ✅ 真生效
//    （歌单详情里那几首**真的出现了**）。
//
// ---------------------------------------------------------------------------
// 三个刻意的设计
// ---------------------------------------------------------------------------
// 1. **歌单列表懒加载**：点开面板时才 `list()`。
//    五个曲库列表页若都 eager 拉一次，就是五次重复请求（而这列表是全量接口）。
// 2. **面板是浮层（absolute），不是展开的行**：
//    ⚠️ 展开成行会**改变工具条的高度** → 整个列表往下位移
//        → 用户（和 E2E）的**第二击落在别的行上** → 浏览器不再派发 `dblclick`
//        → **双击播放失效**（T27 踩过这个坑）。⇒ 浮层不占文档流，高度恒定。
// 3. **可多选 + 可搜索**（T30）：
//    服务端端点 `playlist/add-track` 是**单目标**的 → 多歌单 = **循环写回**。
//    面板用**复选列表**（不是 `<select multiple>`）：后者的多选要按住 Ctrl，
//    普通用户根本不知道；复选列表还能挂**搜索框**（歌单多了才找得到）。
//
// ---------------------------------------------------------------------------
// 写回之后
// ---------------------------------------------------------------------------
// - **全部成功**才**清空选中**（和搜索页的既有行为一致）：不然用户会不小心把同一批歌再加一遍；
//   ⚠️ **部分失败时保留选中** —— 用户能直接重试失败的那几个歌单。
// - 面板**留在原地**显示结果——
//   ⚠️ 选中清空后本组件的 `songs` 变空，但面板**不能跟着消失**
//     （否则成功提示用户根本看不到）。
// - **如实汇报**：成功几个、失败几个、失败原因是什么 —— 不把部分失败说成成功。
//
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

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

/** 面板里的一个歌单条目。 */
interface PlaylistEntry {
  id: string
  name: string
  /** 歌单里的曲目数（展示用，可能为空）。 */
  trackCount?: number
}

/** 一次写回的逐项结果。 */
interface WritebackOutcome {
  /** 成功的歌单 id。 */
  succeeded: string[]
  /** 失败的歌单 id。 */
  failed: string[]
  /** 失败原因（按歌单名归并的文案）。 */
  reasons: string[]
}

/** 把异常变成可读的文案。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '操作失败，请稍后重试'
}

/**
 * 把写回结果写成一句人话。
 *
 * ⚠️ **如实汇报**：部分失败**不能**说成「都成功了」。
 *
 * @param outcome 逐项结果。
 * @param songCount 加入的歌曲数。
 * @param nameOf 取歌单名的函数。
 */
export function describeWriteback(
  outcome: WritebackOutcome,
  songCount: number,
  nameOf: (id: string) => string,
): string {
  const names = (ids: string[]): string => ids.map((id) => nameOf(id)).join('、')
  if (outcome.failed.length === 0) {
    const ok = outcome.succeeded.map((id) => nameOf(id))
    // ⚠️ **单个歌单时沿用旧文案**（T28 的既有断言一字不改）：
    //    「已把 N 首加入歌单「X」」/「已把 N 首加入歌单：甲、乙（2 个）」。
    if (ok.length === 1) return `已把 ${songCount} 首加入歌单「${ok[0]}」`
    return `已把 ${songCount} 首加入歌单：${names(outcome.succeeded)}（${ok.length} 个）`
  }
  if (outcome.succeeded.length === 0) {
    // ⚠️ **全部失败** → 不给「已把 N 首加入歌单」的假象。
    return `操作失败：${outcome.reasons.join('；')}`
  }
  // ⚠️ **部分成功** → 两边都说清楚。
  const reason = outcome.reasons.join('；')
  return `已把 ${songCount} 首加入歌单：${names(outcome.succeeded)}（${outcome.succeeded.length} 个成功）；${outcome.failed.length} 个失败：${reason}`
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
  const [playlists, setPlaylists] = useState<PlaylistEntry[]>([])
  /** 列表加载中。 */
  const [loading, setLoading] = useState(false)
  /** **勾选**的歌单 id（T30：从「单选一个」改成「可勾多个」）。 */
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  /** 搜索关键词（T30）。 */
  const [query, setQuery] = useState('')
  /** 在途（防重复点击）。 */
  const [busy, setBusy] = useState(false)
  /** 提示（成功）/ 错误（失败）。 */
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 面板容器（点外面关闭）。 */
  const panelRef = useRef<HTMLDivElement | null>(null)

  const count = songs.length

  /** 按搜索词过滤（大小写不敏感的子串匹配）。 */
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return playlists
    return playlists.filter((item) => item.name.toLowerCase().includes(keyword))
  }, [playlists, query])

  /** 取歌单名（写回汇报用）。 */
  const nameOf = useCallback(
    (id: string): string => playlists.find((item) => item.id === id)?.name ?? '歌单',
    [playlists],
  )

  /** 打开面板 → 懒加载歌单列表。 */
  const handleOpen = useCallback(async (): Promise<void> => {
    setOpen(true)
    setMessage(null)
    setError(null)
    setLoading(true)
    try {
      const list = await playlistApi.list()
      setPlaylists(
        list.map((item) => ({
          id: item.id,
          name: item.name,
          trackCount: item.trackCount,
        })),
      )
      // ⚠️ **默认一个都不勾**：多选场景下默认勾第一个会让用户「以为已经选好了」。
      setSelectedIds([])
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [playlistApi])

  /** 勾选 / 取消勾选某个歌单。 */
  const togglePlaylist = useCallback((id: string): void => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    )
  }, [])

  /** 写回：把选中的歌**依次**加进**每一个**勾选的歌单。 */
  const handleAdd = useCallback(async (): Promise<void> => {
    if (selectedIds.length === 0) {
      setError('请先选择歌单')
      return
    }
    if (count === 0) {
      setError('请先选中歌曲')
      return
    }
    const ids = [...selectedIds]
    const songIds = songs.map((song) => song.id)
    setBusy(true)
    setError(null)
    setMessage(null)

    const succeeded: string[] = []
    const failed: string[] = []
    const reasons: string[] = []

    // ⚠️ **串行循环**：一个失败**不影响其余**（服务端每目标独立）。
    //    不用 `Promise.all` —— 一个 reject 会把整批吞掉，且并发打 NAS 没好处。
    for (const id of ids) {
      try {
        await playlistApi.addTracks(id, songIds)
        succeeded.push(id)
        // ⚠️ **必须刷新缓存**（否则就是**假成功**）：
        //    写回成功后，歌单里的曲目变了 —— 而 store 里那个歌单的曲目**还缓存着旧的**
        //    （搜索页的写回区一直都有这一步：`refreshPlaylistSongs`）。
        //    不刷新的话：用户打开该歌单 → 看到的还是**旧列表**（比如空歌单）
        //    → 「明明加进去了，怎么没有？」。
        if (store) {
          // ⚠️ `LibraryStoreApi` 是 zustand 的 `StoreApi`（只有 getState / setState），
          //    动作在**状态里** → 经 `getState()` 取。
          const state = store.getState()
          await state.refreshPlaylistSongs(id)
        }
      } catch (err) {
        failed.push(id)
        reasons.push(`${nameOf(id)}（${describeError(err)}）`)
      }
    }

    // 歌单列表里的「N 首」也要跟上（只在有成功时刷新）。
    if (store && succeeded.length > 0) {
      try {
        await store.getState().refreshPlaylists()
      } catch {
        // ⚠️ 刷新列表失败**不影响**写回结果（写回本身已经成功了）。
      }
    }

    const outcome: WritebackOutcome = { succeeded, failed, reasons }
    if (failed.length === 0) {
      setMessage(describeWriteback(outcome, count, nameOf))
      // ⚠️ **清空选中**：否则用户会不小心把同一批歌再加一遍。
      setSelectedIds([])
      onAdded?.(ids[0] ?? '', count)
    } else if (succeeded.length === 0) {
      // ⚠️ **全部失败** → 不给「已把 N 首加入歌单」的假象。
      setError(describeWriteback(outcome, count, nameOf))
    } else {
      // ⚠️ **部分成功** → 说清楚哪几个成功了、哪几个失败；
      //    并且**保留选中**（用户能直接重试失败的那几个）。
      setMessage(describeWriteback(outcome, count, nameOf))
      setSelectedIds(failed)
    }
    setBusy(false)
  }, [count, nameOf, onAdded, playlistApi, selectedIds, songs, store])

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
              {/* ⚠️ **搜索**（T30）：歌单多了以后，光靠滚动找不动。 */}
              <input
                type="search"
                className="fnm-addtoplaylist__search"
                aria-label="搜索歌单"
                placeholder="搜索歌单…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />

              {filtered.length === 0 ? (
                <span className="fnm-addtoplaylist__empty">
                  {`没有匹配「${query.trim()}」的歌单`}
                </span>
              ) : (
                <span className="fnm-addtoplaylist__list" role="group" aria-label="歌单列表">
                  {filtered.map((item) => (
                    <label key={item.id} className="fnm-addtoplaylist__option">
                      <input
                        type="checkbox"
                        className="fnm-addtoplaylist__checkbox"
                        // ⚠️ **显式 `aria-label`**：复选框在 `<label>` 里，
                        //    没有它的话可访问名会把**曲目数**也带进去
                        //    （「占位歌单 0 首」）→ 名字不稳定、不好选中。
                        //    有了它，可访问名**只**是歌单名。
                        aria-label={item.name}
                        checked={selectedIds.includes(item.id)}
                        onChange={() => togglePlaylist(item.id)}
                      />
                      <span className="fnm-addtoplaylist__name">{item.name}</span>
                      {typeof item.trackCount === 'number' && (
                        <span className="fnm-addtoplaylist__count">{item.trackCount} 首</span>
                      )}
                    </label>
                  ))}
                </span>
              )}

              <button
                type="button"
                className="fnm-addtoplaylist__confirm"
                disabled={busy || selectedIds.length === 0 || count === 0}
                onClick={() => void handleAdd()}
              >
                {selectedIds.length > 1 ? `加入 ${selectedIds.length} 个歌单` : '加入'}
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
