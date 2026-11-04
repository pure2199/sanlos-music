// ---------------------------------------------------------------------------
// 本地下载的**渲染层镜像**（Task 11）
// ---------------------------------------------------------------------------
//
// ⚠️ **渲染进程只做两件事**：
// 1. 发「我要下这首歌」的请求；
// 2. 收主进程推来的进度。
//    **落盘路径、文件名清洗、断点续传全在主进程**——渲染进程连文件系统都碰不到。
//
// ---------------------------------------------------------------------------
// 状态形状
// ---------------------------------------------------------------------------
// - `entries`：**已下载完成**的曲目（`songId → 条目`）——「本地优先播放」的唯一依据；
// - `tasks`：进行中 / 已完成 / 失败的任务（`songId → 任务`）——给行内按钮显示进度；
// - `localFirst`：本地优先播放开关（**单一真相源 = 主进程 `prefs.json`**）；
// - `dir`：当前下载目录（只读展示）。
//
// ---------------------------------------------------------------------------
// 约定
// ---------------------------------------------------------------------------
// - **store 里不放任何凭证**（token / 密码 / Cookie）——那些只存在于主进程；
// - 「本地优先」**默认开启**（`prefs.localFirst` 没写 = 开）；
// - 播放地址的解析见 `resolvePlaybackSource`：**命中本地且开关打开** → `fnml://`，
//   否则照旧走 `fnm://srv/track/stream?guid=…`（**既有行为一字不变**）。

import { create } from 'zustand'

import type { Song } from '../../shared/types'
import type {
  AppPrefs,
  DownloadEntry,
  DownloadRequest,
  DownloadTask,
  PlayerBridge,
} from '../../shared/playerBridge'
import { localMediaUrl } from '../../shared/localMedia'
import { streamUrl } from '../player/format'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 任务数组 → `songId → 任务` 的表。 */
function toTaskMap(tasks: DownloadTask[]): Record<string, DownloadTask> {
  const map: Record<string, DownloadTask> = {}
  for (const task of tasks) {
    if (!task || typeof task.songId !== 'string' || task.songId.length === 0) continue
    map[task.songId] = task
  }
  return map
}

/**
 * 由歌曲推出**下载用的扩展名**。
 *
 * ⚠️ **不猜**：先取 `audioSpec.format`（实测服务端给的就是容器名，如 `flac`），
 *    再退回 `codec`；都不合法 → `bin`（而不是瞎报 `mp3`——
 *    错的扩展名会让播放器按错误的容器解析）。
 *
 * @param song 只需要 `codec` 与 `audioSpec.format`（**结构化子集**，方便单测）。
 */
export function downloadExtension(song: {
  codec?: string | null
  audioSpec?: { format?: string | null } | null
}): string {
  const format = (song.audioSpec?.format ?? '').trim().toLowerCase().replace(/^\.+/, '')
  if (/^[a-z0-9]{1,8}$/.test(format)) return format
  const codec = (song.codec ?? '').trim().toLowerCase().replace(/^\.+/, '')
  if (/^[a-z0-9]{1,8}$/.test(codec)) return codec
  return 'bin'
}

/** 下载状态镜像 store 的形状。 */
export interface DownloadStore {
  /** 已下载完成的曲目（`songId → 条目`）。 */
  entries: Record<string, DownloadEntry>
  /** 下载任务（`songId → 任务`）。 */
  tasks: Record<string, DownloadTask>
  /** 本地优先播放（默认开启）。 */
  localFirst: boolean
  /** 当前下载目录（只读展示）。 */
  dir: string
  /** 上一次操作的错误（`null` = 没有）。 */
  error: string | null
  /** 读一次本地索引 + 偏好。 */
  load: () => Promise<void>
  /** 下载一首歌。 */
  start: (song: Song) => Promise<void>
  /** 取消下载。 */
  cancel: (songId: string) => Promise<void>
  /** 清空本地下载。 */
  clear: () => Promise<void>
  /** 切换「本地优先播放」（乐观应用 + 写回主进程；失败则回滚）。 */
  setLocalFirst: (enabled: boolean) => Promise<void>
  /** 改下载目录（写回主进程偏好；失败则回滚）。 */
  setDir: (dir: string) => Promise<void>
  /** 这首歌下完了吗。 */
  isDownloaded: (songId: string) => boolean
  /** 这首歌的任务（没有 = `null`）。 */
  taskOf: (songId: string) => DownloadTask | null
}

/**
 * 统计本地下载占用的字节数。
 *
 * ⚠️ 按索引里的 `bytes` 求和（**不遍历磁盘**）——索引是唯一真相源。
 */
export function totalDownloadedBytes(entries: Record<string, DownloadEntry>): number {
  let total = 0
  for (const entry of Object.values(entries)) {
    if (entry && Number.isFinite(entry.bytes) && entry.bytes > 0) total += entry.bytes
  }
  return total
}

/** 下载状态镜像 store。 */
export const useDownloadStore = create<DownloadStore>()((set, get) => ({
  entries: {},
  tasks: {},
  localFirst: true,
  dir: '',
  error: null,

  load: async (): Promise<void> => {
    const bridge = playerBridge()
    // 没有桥（浏览器预览 / 单测）→ 用默认值，不报错、不崩。
    if (!bridge) return
    try {
      const [list, prefs] = await Promise.all([
        bridge.listDownloads(),
        bridge.getPrefs().catch((): AppPrefs => ({})),
      ])
      set({
        entries: list?.entries ?? {},
        tasks: toTaskMap(list?.tasks ?? []),
        dir: typeof list?.dir === 'string' ? list.dir : '',
        // ⚠️ `undefined` = 默认开启；只有显式 `false` 才关。
        localFirst: prefs?.localFirst !== false,
        error: null,
      })
    } catch {
      set({ error: '读取本地下载列表失败' })
    }
  },

  start: async (song: Song): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      set({ error: '当前环境不支持下载' })
      return
    }
    const request: DownloadRequest = {
      songId: song.id,
      title: song.title,
      artist: song.artist,
      ext: downloadExtension(song),
    }
    try {
      await bridge.startDownload(request)
      set({ error: null })
    } catch {
      set({ error: '下载启动失败' })
    }
  },

  cancel: async (songId: string): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) return
    try {
      await bridge.cancelDownload(songId)
    } catch {
      set({ error: '取消下载失败' })
    }
  },

  clear: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) return
    try {
      await bridge.clearDownloads()
      set({ entries: {}, error: null })
    } catch {
      set({ error: '清空本地下载失败' })
    }
  },

  setLocalFirst: async (enabled: boolean): Promise<void> => {
    const previous = get().localFirst
    // 乐观应用：开关必须即时反馈。
    set({ localFirst: enabled, error: null })
    const bridge = playerBridge()
    if (!bridge) return
    try {
      await bridge.setPrefs({ localFirst: enabled })
    } catch {
      set({ localFirst: previous, error: '设置保存失败，已恢复原设置' })
    }
  },

  setDir: async (dir: string): Promise<void> => {
    const previous = get().dir
    const trimmed = dir.trim()
    // 乐观应用：目录输入框要即时反馈。
    set({ dir: trimmed, error: null })
    const bridge = playerBridge()
    if (!bridge) return
    try {
      // ⚠️ **写进偏好**（主进程 `prefs.json`）——单一真相源，
      //    主进程每次下载都重新读它（`prefs.read().downloadDir`）。
      await bridge.setPrefs({ downloadDir: trimmed })
    } catch {
      set({ dir: previous, error: '保存下载目录失败，已恢复原设置' })
    }
  },

  isDownloaded: (songId: string): boolean =>
    Object.prototype.hasOwnProperty.call(get().entries, songId),

  taskOf: (songId: string) => get().tasks[songId] ?? null,
}))

/**
 * 解析这一曲的**播放地址**（Task 11 的「本地优先播放」）。
 *
 * - 本地有副本 **且** 开关打开 → `fnml://local/track/<id>`（不再走 NAS）；
 * - 否则 → `fnm://srv/track/stream?guid=…`（**与之前完全一致**）。
 *
 * ⚠️ 只看**已下载完成**的条目（`entries`）：正在下载的半成品**绝不能**拿去播。
 */
export function resolvePlaybackSource(song: Song): string {
  const state = useDownloadStore.getState()
  if (state.localFirst && Object.prototype.hasOwnProperty.call(state.entries, song.id)) {
    return localMediaUrl(song.id)
  }
  return streamUrl(song.id)
}

/**
 * 装配下载桥接（**在 `src/main.tsx` 里调用一次**）。
 *
 * - 订阅主进程推来的任务变化；
 * - 读一次本地索引与偏好。
 *
 * @returns 退订函数。
 */
export function installDownloadStore(): () => void {
  const bridge = playerBridge()
  if (!bridge) return () => undefined
  const unsubscribe = bridge.onDownloadChange((tasks) => {
    const previous = useDownloadStore.getState().tasks
    useDownloadStore.setState({ tasks: toTaskMap(tasks) })
    // ⚠️ T18-5（真机实测）：主进程只推 `tasks`，**不推 `entries`**；
    //    而「已下载」徽标（`DownloadButton` 的 `entry` 分支）与
    //    「本地优先播放」（`resolvePlaybackSource`）**都只看 `entries`**。
    //    → 任务完成时必须**重新拉一次本地索引**，否则：
    //      ① 下载完成的按钮会退回「下载」（用户看不到「已下载」）；
    //      ② 本地优先播放在本次会话内一直不生效（歌明明在本地，却还走 NAS 流）。
    const justFinished = tasks.some(
      (task) => task.status === 'done' && previous[task.songId]?.status !== 'done',
    )
    if (justFinished) void useDownloadStore.getState().load()
  })
  void useDownloadStore.getState().load()
  return unsubscribe
}
