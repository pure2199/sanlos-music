// ---------------------------------------------------------------------------
// 曲库各页的行内操作（Task 25）
// ---------------------------------------------------------------------------
//
// 提供**每个歌曲行**都能用的操作区：收藏按钮 + 下载按钮。
//
// ---------------------------------------------------------------------------
// 为什么要有这个 hook
// ---------------------------------------------------------------------------
// 五个列歌曲的页面（歌曲 / 收藏 / 歌单详情 / 专辑·歌手·风格详情 / 最近播放）
// 各自都写着「行内下载入口（Task 11）」，用的是 `useDownloadRowActions()`。
//
// T25 要给它们**再加**一个收藏按钮 → 如果每个页面各写一遍：
// - 收藏写回器会被造出**五份**（五个真相源）；
// - 乐观态、串行化、失败回滚的逻辑要复制五遍；
// - 以后再加工具按钮就是五处复制粘贴。
//
// ⇒ 抽成一个 hook：**写回器只造一份**（hook 实例内），
//   收藏态**只读 store 里的已确认态**（`libraryStore.favoriteStates`）——
//   全应用**一份**收藏态。
//
// ---------------------------------------------------------------------------
// 收藏态的三层合成
// ---------------------------------------------------------------------------
// 1. **已确认态**（`libraryStore.favoriteStates`）：服务端收藏列表载入后登记，
//    写回成功后更新 —— **单一真相源**；
// 2. **兜底值**（`song.favorite`）：服务端 `isFavorite` 字段
//    —— **真机已实测该字段存在且可信**（`tools/fn-writeback-probe.mjs`）；
// 3. **乐观态**（写回器的 `target`）：点击后立刻生效、失败回滚到已确认态。
//
// 合成顺序：**乐观态 > 已确认态 > 兜底值**（见 `resolveFavoriteState`）。
//
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useStore } from 'zustand'

import type { Song } from '../../shared/types'
import { createFavoriteWriteback, type FavoriteWriteback } from '../state/favoriteWriteback'
import { resolveFavoriteState, type LibraryStoreApi } from '../state/libraryStore'
import { DownloadButton } from './DownloadButton'
import { FavoriteButton } from './FavoriteButton'

/** 行内操作的返回值。 */
export interface LibraryRowActions {
  /**
   * 行内操作渲染函数（收藏按钮 + 下载按钮）。
   *
   * ⚠️ 直接传给 `SongList` 的 `renderRowActions` 接缝。
   */
  render: (song: Song, index: number) => ReactNode
  /** 收藏写回失败的提示（没有则 `null`）。 */
  error: string | null
  /** 清掉失败提示。 */
  clearError: () => void
}

/**
 * 造出行内操作（收藏 + 下载）。
 *
 * @param store **该页面正在用的那个** library store —— 必须与页面同一个，
 *   否则收藏态会出现两份（页面读 A、写回写 B）。
 */
export function useLibraryRowActions(store: LibraryStoreApi): LibraryRowActions {
  /** store 里的**已确认态**（单一真相源）。 */
  const favoriteStates = useStore(store, (s) => s.favoriteStates)
  /** 当前环境是否支持写回（只读环境 → 按钮禁用）。 */
  const writable = useStore(store, (s) => s.favoriteWritable)

  /** 收藏写回器（**只造一次**，状态跨渲染保留）。 */
  const writebackRef = useRef<FavoriteWriteback | null>(null)
  /** 最新的 store（store prop 变了也要用上最新的）。 */
  const storeRef = useRef(store)

  useEffect(() => {
    storeRef.current = store
  }, [store])

  if (!writebackRef.current) {
    writebackRef.current = createFavoriteWriteback(async (songId, on) => {
      // ⚠️ **不传 transport**：让 store 用它自己的 `api.setFavorite`
      //    （页面注入的 api 就是这个 store 的 api）。
      await storeRef.current.getState().setFavorite(songId, on)
    })
  }
  const writeback = writebackRef.current

  const subscribe = useCallback((listener: () => void) => writeback.subscribe(listener), [writeback])
  const getSnapshot = useCallback(() => writeback.getSnapshot(), [writeback])
  /**
   * 写回版本号。
   *
   * ⚠️ **必须订阅**：乐观态（点击后立刻翻转）只改写回器的内部状态，
   *    **不改** store 的 `favoriteStates`（那要等服务端确认）——
   *    不订阅就不会重渲染 → 用户点了看不到反应。
   */
  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const render = useCallback(
    (song: Song): ReactNode => {
      // 基准值 = store 里的**已确认态**（未登记时用歌曲自带的字段）。
      const base = resolveFavoriteState(favoriteStates, song.id, song.favorite)
      const entry = writeback.get(song.id, base)
      return (
        <>
          <FavoriteButton
            song={song}
            favorite={entry.target}
            pending={entry.pending}
            disabled={!writable || song.id.length === 0}
            onToggle={() => writeback.toggle(song.id, base)}
          />
          <DownloadButton song={song} />
        </>
      )
    },
    // ⚠️ `version` 变化 → 写回状态变了 → 必须重算（乐观态靠它刷新）。
    [favoriteStates, writeback, writable, version],
  )

  const clearError = useCallback(() => writeback.clearError(), [writeback])

  return { render, error: writeback.getLastError(), clearError }
}
