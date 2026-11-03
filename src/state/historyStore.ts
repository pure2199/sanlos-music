// ---------------------------------------------------------------------------
// 本机播放记录（**本地**，Task 7）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么是本地**：实测服务端**不会**随 `track/stream` 自动写播放历史，
//    且 `/music/api/v1/` 下**没有**可用的「上报播放」端点
//    （探测了 50+ 个候选路径，全部返回 fnOS 的 SPA 兜底页——详见
//    `src/api/history.ts` 顶部的实测结论）。
//    → 客户端**不臆造**上报调用；本机自己的播放记录改由这里记录。
//
// ⚠️ **存哪儿**：`localStorage`（键 `fnmusic-local-history`）——
//    这里**只有曲目标题等播放相关信息，没有任何凭证**。
//
// ⚠️ **与 NAS 历史是两回事**：NAS 那份是**只读**的（别的客户端 / 网页端写的），
//    本页把两者分成两段展示，**不混为一谈**。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { Song } from '../../shared/types'
import { usePlayerStore } from './playerStore'

/** `localStorage` 的键。 */
export const LOCAL_HISTORY_KEY = 'fnmusic-local-history'

/** 最多保留多少条（超了丢最旧的）。 */
export const LOCAL_HISTORY_LIMIT = 100

/** 本机播放记录 store 的形状。 */
export interface LocalHistoryStore {
  /** 本机最近播放过的歌（**最新的在前**）。 */
  items: Song[]
  /** 记一笔播放（同一首会**移到最前**，不重复占位）。 */
  record: (song: Song) => void
  /** 清空本机播放记录。 */
  clear: () => void
}

/** 从 `localStorage` 读回（损坏 / 不可用 → 空列表，不抛异常）。 */
function readStored(): Song[] {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_HISTORY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is Song => {
      if (typeof item !== 'object' || item === null) return false
      const song = item as Partial<Song>
      return typeof song.id === 'string' && typeof song.title === 'string'
    })
  } catch {
    return []
  }
}

/** 写进 `localStorage`（写不进去就算了——只是不持久化，不崩）。 */
function writeStored(items: Song[]): void {
  try {
    globalThis.localStorage?.setItem(LOCAL_HISTORY_KEY, JSON.stringify(items))
  } catch {
    // 隐私模式 / 配额满 / 无 localStorage → 静默降级为「只在本会话内有效」。
  }
}

/** 本机播放记录 store。 */
export const useLocalHistory = create<LocalHistoryStore>()((set, get) => ({
  items: readStored(),

  record: (song: Song): void => {
    // 同一首移到最前（不重复占位）。
    const rest = get().items.filter((item) => item.id !== song.id)
    const items = [song, ...rest].slice(0, LOCAL_HISTORY_LIMIT)
    writeStored(items)
    set({ items })
  },

  clear: (): void => {
    writeStored([])
    set({ items: [] })
  },
}))

/**
 * 安装「播放即记录」（应用级接线）。
 *
 * ⚠️ 订阅 `playerStore` 的 **`current` 变化**才记一笔：
 * - **换歌**才记（换到下一首 / 上一首 / 点了另一首）；
 * - **同一首重播**不重复记（避免列表被同一首歌刷满）。
 *
 * @returns 退订函数。
 */
export function installLocalHistory(): () => void {
  return usePlayerStore.subscribe((state, previous) => {
    const song = state.current
    if (!song) return
    const before = previous.current
    if (before && before.id === song.id) return
    useLocalHistory.getState().record(song)
  })
}
