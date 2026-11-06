// ---------------------------------------------------------------------------
// 桌面悬浮歌词的**数据推送**（主窗口渲染进程侧，Task 10）
// ---------------------------------------------------------------------------
//
// 职责
// ---------------------------------------------------------------------------
// 播放状态（`<audio>`）**只在主窗口的渲染进程里**，悬浮窗是另一个进程——
// 所以主窗口要负责把「当前曲目 + 歌词」与「播放进度」推给主进程，
// 由主进程转发给悬浮窗。
//
// ⚠️ **拉歌词是有成本的**（一次 NAS 请求）：所以**只在悬浮窗可见时**才拉。
//    悬浮窗关着 → 既不拉歌词，也不推进度。
//
// ⚠️ **歌词只在切歌时拉一次**（`current.id` 变了才拉）；
//    进度是**高频**的（跟着 `timeupdate` 走），但**不带歌词**——
//    歌词单独走 `kind: 'track'`，进度走 `kind: 'progress'`（见 `shared/playerBridge.ts`）。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **不 import Electron**；桥通过 `window.fnPlayer` 拿（单测可注入替身）。
// - 渲染进程**永远拿不到凭证**：歌词接口走既有的 `fnm://` 代理，与本模块无关。
// ---------------------------------------------------------------------------

import type { LyricEntry } from '../api/types'
import { lyricApi } from '../api/lyric'
import { usePlayerStore } from '../state/playerStore'
import type { Song } from '../../shared/types'
import type { LyricOverlayMessage, PlayerBridge, AppPrefs } from '../../shared/playerBridge'
import { parseLyricEntries, type LyricLine } from '../ui/lyrics/parse'
import { applyAudibleLatency } from '../ui/lyrics/timing'
import {
  defaultExternalLyricFetcher,
  loadLyricEntries,
  type ExternalLyricFetcher,
} from './lyricSource'

/** 歌词接口的最小子集（便于单测注入假实现）。 */
export interface LyricOverlayApi {
  /** 取某首歌的全部歌词条目。 */
  list(songId: string): Promise<LyricEntry[]>
}

/** 桥的最小子集（便于单测注入假实现）。 */
export interface LyricOverlayBridge {
  /** 推送一条悬浮歌词消息。 */
  pushLyricState(message: LyricOverlayMessage): void
  /** 订阅悬浮窗可见性变化。 */
  onLyricVisibility(handler: (visible: boolean) => void): () => void
  /**
   * 读回偏好（启动时据此知道悬浮窗是不是开着）。
   *
   * ⚠️ **为什么需要**：主进程可能在渲染进程装好之前就把「可见性」事件发出去了
   *    （事件早于订阅 → 丢掉）→ 启动时必须**主动问一次**。
   */
  getPrefs?(): Promise<AppPrefs>
}

/** 播放器 store 的最小子集。 */
export interface LyricOverlayPlayerState {
  /** 当前曲目。 */
  current: Song | null
  /** 播放位置（秒）。 */
  position: number
  /** 是否正在播放。 */
  isPlaying: boolean
  /**
   * **可听延迟**（秒）：媒体渲染完成 → 用户真正听到之间的延迟（T66）。
   *
   * ⚠️ **可选**：拿不到时按 0 处理（**不补偿**）。
   */
  outputLatencySec?: number
}

/** 播放器 store 的最小接口。 */
export interface LyricOverlayPlayerStore {
  /** 读当前状态。 */
  getState(): LyricOverlayPlayerState
  /** 订阅状态变化（zustand 的单监听器签名：`(state, prev)`）。 */
  subscribe(listener: (state: LyricOverlayPlayerState, prev: LyricOverlayPlayerState) => void): () => void
}

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function defaultBridge(): LyricOverlayBridge | null {
  const scope = globalThis as { fnPlayer?: PlayerBridge }
  const bridge = scope.fnPlayer
  if (!bridge) return null
  return {
    pushLyricState: (message) => bridge.pushLyricState(message),
    onLyricVisibility: (handler) => bridge.onLyricVisibility(handler),
    getPrefs: () => (bridge.getPrefs ? bridge.getPrefs() : Promise.resolve({})),
  }
}

/** `installLyricOverlay` 的参数（全部可注入，便于单测）。 */
export interface LyricOverlayOptions {
  /** 桥；不传则取 `window.fnPlayer`（没有则整个模块**不装**）。 */
  bridge?: LyricOverlayBridge | null
  /** 歌词接口；不传则用真实的 `lyricApi`。 */
  api?: LyricOverlayApi
  /** 播放器 store；不传则用全局 `usePlayerStore`。 */
  store?: LyricOverlayPlayerStore
  /**
   * 外部歌词取法（Task 32）。
   *
   * ⚠️ **可缺省** → 不查外部（既有单测的行为完全不变）。
   * ⚠️ 不传时走**默认取法**（IPC 到主进程）；桌面壳里桥存在 → 默认会查。
   */
  external?: ExternalLyricFetcher | null
}

/** 装配结果（供单测断言）。 */
export interface LyricOverlayHandle {
  /** 当前是否在推送（= 悬浮窗可见）。 */
  isEnabled(): boolean
  /** 立即推一次当前曲目与进度（测试用）。 */
  publishNow(): Promise<void>
  /** 退订。 */
  dispose(): void
}

/**
 * 安装「悬浮歌词数据推送」。
 *
 * @returns 装配句柄；**没有桥**时返回 `null`（浏览器预览 / 单测）。
 */
export function installLyricOverlay(options: LyricOverlayOptions = {}): LyricOverlayHandle | null {
  const bridge = options.bridge === undefined ? defaultBridge() : options.bridge
  if (!bridge) return null

  const api: LyricOverlayApi = options.api ?? lyricApi
  const store: LyricOverlayPlayerStore = options.store ?? (usePlayerStore as unknown as LyricOverlayPlayerStore)
  /**
   * 外部歌词取法（Task 32）。
   *
   * ⚠️ `options.external` 显式给 `null` = **明确不查外部**；
   *    没给这个键 → 用**默认取法**（IPC 到主进程；单测里没有桥 → `null` → 不查）。
   */
  const external: ExternalLyricFetcher | null =
    options.external === undefined ? defaultExternalLyricFetcher() : options.external

  /** 悬浮窗是否可见（关着就不拉歌词、不推进度）。 */
  let enabled = false
  /**
   * 是否**已经收到过**可见性事件。
   *
   * ⚠️ 竞态：启动时「读回偏好」是**异步**的，它的 resolve 可能**晚于**一次
   *    可见性事件到达 → 用旧值覆盖新状态（用户刚打开就被关掉）。
   * → 收到过事件就**不再**用启动时的读取覆盖它。
   */
  let visibilityKnown = false
  /** 已经推过歌词的曲目 id（换歌才重新拉）。 */
  let loadedSongId: string | null = null
  /**
   * 已解析好的**原始**歌词行（**未**施加可听延迟补偿）。
   *
   * ⚠️ 为什么要缓存：换输出设备 → 延迟变了 → 需要**重推**一份带新偏移的歌词。
   *    若每次都重新解析/重新拉 NAS ⇒ 白花一次请求。缓存后**只重推，不重取**。
   */
  let cachedLines: LyricLine[] = []
  /** 当前缓存的曲目（重推时用）；`null` = 没有歌。 */
  let cachedTrack: { id: string; title: string; artist: string } | null = null
  /** 拉歌词的令牌：切歌后旧请求回来时直接丢弃。 */
  let fetchToken = 0

  const push = (message: LyricOverlayMessage): void => {
    bridge.pushLyricState(message)
  }

  /**
   * 推一次「曲目 + 歌词」（**已施加**当前的可听延迟补偿）。
   *
   * ⚠️ **补偿施加在歌词行上**（不是进度上）⇒ 悬浮窗 / 词岛的进度条与时间
   *    仍然是**媒体真实位置**，只有歌词跟着延迟走。
   */
  function pushTrack(): void {
    const latency = store.getState().outputLatencySec ?? 0
    push({
      kind: 'track',
      track: cachedTrack,
      lines: applyAudibleLatency(cachedLines, latency),
    })
  }

  /** 拉当前曲目的歌词并推送（`kind: 'track'`）。 */
  async function publishTrack(force = false): Promise<void> {
    const song = store.getState().current
    if (!song || song.id.length === 0) {
      loadedSongId = null
      cachedLines = []
      cachedTrack = null
      pushTrack()
      return
    }
    // ⚠️ `force` = 悬浮窗**刚打开**（可能刚创建，缓存里什么都没有）→ 必须重推。
    if (!force && song.id === loadedSongId) return
    loadedSongId = song.id

    const token = (fetchToken += 1)
    try {
      // ⚠️ **NAS 优先 → 缺了才查外部**（Task 32）；外部源只回 LRC 文本，
      //    这里包成条目后仍交给**现有**的 `parseLyricEntries`（解析逻辑一行不改）。
      const result = await loadLyricEntries(
        song.id,
        {
          title: song.title,
          artist: song.artist,
          album: song.album,
          duration: song.duration,
        },
        { api, external: external },
      )
      // 期间又切了歌 → 这份歌词已经过时，丢弃。
      if (token !== fetchToken) return
      cachedLines = parseLyricEntries(result.entries)
      cachedTrack = { id: song.id, title: song.title, artist: song.artist }
      pushTrack()
    } catch {
      if (token !== fetchToken) return
      // 取不到歌词不是致命错误：推一份空的（悬浮窗显示「暂无歌词」）。
      cachedLines = []
      cachedTrack = { id: song.id, title: song.title, artist: song.artist }
      pushTrack()
    }
  }

  /** 推送当前进度（`kind: 'progress'`）。 */
  function publishProgress(): void {
    const state = store.getState()
    push({ kind: 'progress', position: state.position, isPlaying: state.isPlaying })
  }

  // 订阅播放器状态：换歌 → 拉歌词；进度变 → 推进度。
  const unsubscribeStore = store.subscribe((state, previous) => {
    if (!enabled) return
    if (state.current?.id !== previous.current?.id) {
      void publishTrack()
    }
    if (state.position !== previous.position || state.isPlaying !== previous.isPlaying) {
      publishProgress()
    }
    // ⚠️ **换输出设备**（换耳机 / 换声卡 / 蓝牙连上）→ 可听延迟变了
    //    ⇒ **重推**一份带新偏移的歌词（**不重新取歌词**，不花 NAS 请求）。
    if (state.outputLatencySec !== previous.outputLatencySec) {
      pushTrack()
    }
  })

  // 订阅悬浮窗可见性：开 → 立刻把当前曲目与进度推过去；关 → 停止推送。
  const unsubscribeVisibility = bridge.onLyricVisibility((visible) => {
    visibilityKnown = true
    enabled = visible
    if (!visible) return
    // 刚打开：当前曲目**可能已经拉过**了（loadedSongId 命中）→
    // 这时要把「曲目 + 歌词」**重新**推给（可能刚创建的）悬浮窗。
    void publishTrack(true)
    publishProgress()
  })

  // ⚠️ **启动时主动问一次可见性**：主进程可能在渲染进程订阅之前就发过事件
  //    （事件早于订阅 → 丢掉）→ 只靠订阅会漏掉「上次就是开着的」这种情况。
  void Promise.resolve(bridge.getPrefs?.())
    .then((prefs) => {
      // ⚠️ 已经收到过可见性事件 → **不覆盖**（启动时的读取可能更旧）。
      if (visibilityKnown) return
      const visible = prefs?.lyricOverlay?.visible === true
      enabled = visible
      if (!visible) return
      void publishTrack(true)
      publishProgress()
    })
    .catch(() => undefined)

  return {
    isEnabled: () => enabled,
    async publishNow(): Promise<void> {
      await publishTrack(true)
      publishProgress()
    },
    dispose(): void {
      unsubscribeStore()
      unsubscribeVisibility()
    },
  }
}
