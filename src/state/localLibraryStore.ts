// ---------------------------------------------------------------------------
// 本地曲目清单（渲染层镜像，T38）
// ---------------------------------------------------------------------------
//
// ⚠️ **渲染进程不碰文件系统**：它只能
// ① 让主进程弹对话框（选文件 / 选文件夹）；
// ② 把**选中的路径**交给主进程登记；
// ③ 拿到登记好的清单。
//
// ⚠️ **登记的门槛在主进程**：路径必须真实存在、是普通文件、扩展名在白名单里
//    → 渲染进程给不出「任意路径」。
//
// ⚠️ store 里**只有路径与歌名**，没有任何凭证（token / 口令）。
//
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { Song } from '../../shared/types'
import type { LocalLibraryItem, PlayerBridge } from '../../shared/playerBridge'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/**
 * 把本地曲目映射成 `Song` 形状。
 *
 * ⚠️ **本地曲目没有服务端元数据**：
 * - `coverId` = 空串 → 列表渲染**占位块**（不发封面请求）；
 * - `duration` = 0（**未知**）→ 播放后由媒体元素的 `durationchange` 补；
 * - `artist` / `album` 可能为空串。
 *
 * ⚠️ `codec` / `audioSpec.format` 填**扩展名**（如 `flac`）——
 *    这样 Chromium 播不了的格式能走**既有的 FFmpeg 兜底**。
 */
export function localItemToSong(item: LocalLibraryItem): Song {
  const ext = item.ext ?? ''
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    artistId: '',
    album: '',
    albumId: '',
    coverId: '',
    duration: 0,
    favorite: false,
    codec: ext,
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: null,
    trackNo: null,
    discNo: null,
    audioSpec: {
      bitDepth: null,
      sampleRate: null,
      channel: null,
      bitrate: null,
      codec: ext || null,
      container: ext || null,
      duration: null,
      format: ext || null,
      path: item.path,
      size: item.size,
    },
  }
}

/** 本地曲目清单 store 的形状。 */
export interface LocalLibraryStore {
  /** 已登记的本地曲目。 */
  items: LocalLibraryItem[]
  /** 正在弹对话框 / 扫描 / 写盘。 */
  loading: boolean
  /** 上一次操作的错误（`null` = 没有）。 */
  error: string | null
  /** 读一次清单。 */
  load: () => Promise<void>
  /** 「添加文件」：弹对话框（多选）→ 交给主进程登记。 */
  addFiles: () => Promise<void>
  /** 「添加文件夹」：弹对话框 → 主进程递归扫描 → 登记。 */
  addFolder: () => Promise<void>
  /**
   * 从清单里移除一项。
   *
   * ⚠️ **只改清单，绝不删用户的音乐文件**。
   */
  remove: (id: string) => Promise<void>
  /** 清掉错误提示。 */
  clearError: () => void
}

/** 本地曲目清单 store。 */
export const useLocalLibraryStore = create<LocalLibraryStore>()((set, get) => ({
  items: [],
  loading: false,
  error: null,

  load: async (): Promise<void> => {
    const bridge = playerBridge()
    // 没有桥（浏览器预览 / 单测）→ 用默认值，不报错、不崩。
    if (!bridge) return
    try {
      const list = await bridge.listLocalTracks()
      set({ items: Array.isArray(list) ? list : [], error: null })
    } catch {
      set({ error: '读取本地音乐列表失败' })
    }
  },

  addFiles: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      set({ error: '当前环境不支持添加本地音乐' })
      return
    }
    set({ loading: true, error: null })
    try {
      const picked = await bridge.pickLocalFiles()
      // ⚠️ 用户**取消**对话框 → 什么都不做（**不报错**）。
      if (!Array.isArray(picked) || picked.length === 0) {
        set({ loading: false })
        return
      }
      const items = await bridge.addLocalTracks(picked)
      set({ items: Array.isArray(items) ? items : [], loading: false, error: null })
    } catch {
      set({ loading: false, error: '添加本地音乐失败' })
    }
  },

  addFolder: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      set({ error: '当前环境不支持添加本地音乐' })
      return
    }
    set({ loading: true, error: null })
    try {
      const picked = await bridge.pickLocalFolder()
      // ⚠️ 用户**取消**对话框 → 什么都不做（**不报错**）。
      if (typeof picked !== 'string' || picked.length === 0) {
        set({ loading: false })
        return
      }
      const items = await bridge.addLocalFolder(picked)
      set({ items: Array.isArray(items) ? items : [], loading: false, error: null })
    } catch {
      set({ loading: false, error: '添加本地音乐失败' })
    }
  },

  remove: async (id: string): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) return
    try {
      const items = await bridge.removeLocalTrack(id)
      set({ items: Array.isArray(items) ? items : get().items, error: null })
    } catch {
      set({ error: '移除本地音乐失败' })
    }
  },

  clearError: (): void => {
    set({ error: null })
  },
}))
