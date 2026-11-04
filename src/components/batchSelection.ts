// ---------------------------------------------------------------------------
// 批量选择的**页面侧状态**（T27）
// ---------------------------------------------------------------------------
//
// 为什么需要它
// ---------------------------------------------------------------------------
// `SongList` 早就有多选接缝（`onSelect` + 受控 `selectedIds`），但五个曲库列表页
// （歌曲 / 收藏 / 最近播放 / 歌单详情 / 专辑·歌手·风格详情）都只是把 `onSelect`
// **原样透传**给外部 → **页面自己不知道用户选中了哪几首**。
// ⇒ 批量下载（以及任何「对选中项批量操作」的功能）都无从下手。
//
// 本 hook 把「选中态」提到**页面**持有（受控模式）：
// - `selectedIds` → 传给 `SongList`（受控）；
// - `onSelect` → 传给 `SongList`（变更抛出来）；
// - `selectedSongs` → 把 id **还原成歌曲对象**（批量下载要的是歌曲，不只是 id）。
//
// ⚠️ **外部回调不丢**：页面上游也可能关心选中变化（`onSelect` prop），
//    本 hook 内部更新状态的同时**照样**把 ids 抛给上游 → 既有语义不变。
//
// ---------------------------------------------------------------------------
// 「列表换了就清空选中」
// ---------------------------------------------------------------------------
// 切歌单 / 换下钻目标之后，**上一张列表的选中项已经不在当前列表里** ——
// 若不清空，用户会看到「已选 3 首」，而点「下载所选」下的是**上一张列表的歌**。
// ⇒ 用 `listKey` 标识「当前列表是谁」，变了就清空。
//
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Song } from '../../shared/types'

/** 批量选择的返回值。 */
export interface BatchSelection {
  /** 受控模式的选中项（id 数组；顺序按列表原始顺序）。 */
  selectedIds: string[]
  /** 选中变化 → 交给 `SongList` 的 `onSelect`。 */
  onSelect: (ids: string[]) => void
  /** 选中的**歌曲**（id 还原成对象；当前列表里没有的直接丢掉）。 */
  selectedSongs: Song[]
  /** 清空选中。 */
  clear: () => void
}

/**
 * 批量选择的页面侧状态。
 *
 * @param songs    当前列表的**全部**歌曲（用来把 id 还原成歌曲对象）。
 * @param listKey  「当前列表是谁」的标识（切歌单 / 换下钻目标时要变）。
 * @param onSelect 外部的选中回调（可选；**既有语义不变**）。
 */
export function useBatchSelection(
  songs: Song[],
  listKey: string,
  onSelect?: (ids: string[]) => void,
): BatchSelection {
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // ⚠️ 用 ref 记住上一个 key：**首次挂载不做无谓的清空**
  //    （否则会多一次渲染），只有「真的换了列表」才清。
  const lastKeyRef = useRef(listKey)
  useEffect(() => {
    if (lastKeyRef.current === listKey) return
    lastKeyRef.current = listKey
    setSelectedIds([])
  }, [listKey])

  const handleSelect = useCallback(
    (ids: string[]): void => {
      setSelectedIds(ids)
      // ⚠️ 上游的回调**照样**抛（既有语义不变）。
      onSelect?.(ids)
    },
    [onSelect],
  )

  const clear = useCallback((): void => {
    setSelectedIds([])
  }, [])

  const selectedSongs = useMemo(() => {
    const byId = new Map<string, Song>()
    for (const song of songs) {
      if (song && typeof song.id === 'string') byId.set(song.id, song)
    }
    const out: Song[] = []
    for (const id of selectedIds) {
      const song = byId.get(id)
      if (song) out.push(song)
    }
    return out
  }, [selectedIds, songs])

  return { selectedIds, onSelect: handleSelect, selectedSongs, clear }
}
