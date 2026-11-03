// 媒体会话（Web Media Session API）——Task 17。
//
// ---------------------------------------------------------------------------
// 为什么在**渲染进程**做（控制器裁定，替换了计划里的主进程 SMTC）
// ---------------------------------------------------------------------------
// Windows 用 **SMTC（System Media Transport Controls）** 展示媒体会话，而
// **Chromium 正是通过 W3C 的 Media Session API（`navigator.mediaSession`）把页面会话
// 发布给 Windows** 的——Windows 11 快速设置的媒体面板、键盘媒体键、锁屏控制
// 都吃这条通道。
//
// Electron **不暴露** WinRT 的 `ISystemMediaTransportControls`：主进程要直接发布 SMTC
// 需要原生依赖（node-winrt 一类，或自带 .NET 后端 exe ~15 MB），与「不引重型依赖 +
// 控制安装包体积」冲突。故本任务走**零依赖**方案：渲染进程的 `navigator.mediaSession`。
// （`electron/smtc.ts` 因此**不创建**——主进程侧没有对应职责。）
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - 只用浏览器 API：**不 import Node 内置模块或 Electron API**；
// - `src/state/playerStore.ts` **只读**（只 `subscribe`，绝不写状态）——
//   媒体会话的逻辑一律**不**塞进 store；
// - 封面 URL 一律走 `src/components/coverUrl.ts` 的 `coverUrl(coverId, size)`
//   （**全项目唯一的封面 URL 拼装点**——别在这里手拼展开后的地址）；
//   `size` 参数将来校准（联调清单 Step K）时**只改那一处**。
// - action handler 的回调**只负责把命令发给主进程**（`player:command`），
//   **不直接改播放状态**——否则会与状态回传形成回环。
//
// ---------------------------------------------------------------------------
// ⚠️ 已知依赖（见任务报告的「遗留与风险」）
// ---------------------------------------------------------------------------
// **Chromium 只有在真的有媒体元素在播放时才会激活媒体会话。**
// Task 13 用的是 `<audio>` 元素（会激活）；若将来 Task 20b 的 FFmpeg 路径改成
// 纯 WebAudio 解码（不再经过媒体元素），Windows 侧可能**不再显示媒体会话**。

import { coverUrl } from '../components/coverUrl'
import { usePlayerStore } from '../state/playerStore'
import type { PlayerBridge, PlayerCommand, PlayerStateSnapshot } from '../../shared/playerBridge'
import type { PlayerState } from '../../shared/types'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 媒体会话封面的边长（服务端 `size` 参数）。
 *
 * ⚠️ 真实 NAS 的 `size` 取值尚未校准（联调清单 Step K），
 *    这里与托盘图标（`TRAY_COVER_SIZE = 160`）保持一致。
 */
export const MEDIA_ARTWORK_SIZE = 160

/** 媒体会话支持的 action（本任务只用这五个；Windows 的媒体键就映射到它们）。 */
export const MEDIA_SESSION_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'] as const

/** 本任务支持的 action 名。 */
export type MediaSessionAction = (typeof MEDIA_SESSION_ACTIONS)[number]

// ---------------------------------------------------------------------------
// 类型（浏览器 API 的最小子集，便于单测注入替身）
// ---------------------------------------------------------------------------

/** `MediaMetadata` 的最小接口。 */
export interface MediaMetadataLike {
  /** 标题。 */
  title?: string
  /** 艺人。 */
  artist?: string
  /** 专辑。 */
  album?: string
  /** 封面图。 */
  artwork?: Array<{ src: string; sizes?: string; type?: string }>
}

/** `navigator.mediaSession` 的最小接口。 */
export interface MediaSessionLike {
  /** 当前会话的元数据。 */
  metadata: unknown
  /** 播放状态（`none` / `paused` / `playing`）。 */
  playbackState: string
  /** 装 / 卸 action handler（`null` = 卸载）。 */
  setActionHandler(action: string, handler: ((details: unknown) => void) | null): void
  /** 设置进度状态；不带参数 = 清除。 */
  setPositionState(state?: { duration?: number; playbackRate?: number; position?: number }): void
}

/** `createMediaSession` 的依赖（全部可注入，单测不依赖真实浏览器实现）。 */
export interface MediaSessionDeps {
  /** 媒体会话对象；缺省时取 `navigator.mediaSession`（没有则 `null`）。 */
  session?: MediaSessionLike | null
  /** 构造元数据；缺省时用全局 `MediaMetadata`。 */
  createMetadata?: (init: {
    title?: string
    artist?: string
    album?: string
    artwork?: Array<{ src: string; sizes?: string; type?: string }>
  }) => MediaMetadataLike | null
  /** 把命令发给主进程（`player:command`）。 */
  sendCommand?: (command: PlayerCommand) => void
  /** 封面 URL 拼装；缺省时用 `coverUrl()`（唯一拼装点）。 */
  coverUrlFor?: (coverId: string, size: number) => string | null
}

/**
 * 媒体会话控制器（**契约形状照计划**：Task 19 等后续任务按这个调用）。
 */
export interface MediaSessionController {
  /** 用新的播放器状态刷新会话（元数据 / 播放状态 / 进度）。 */
  update(state: PlayerStateSnapshot): void
  /** 卸载全部 action handler（`setActionHandler(action, null)`）。 */
  dispose(): void
}

// ---------------------------------------------------------------------------
// 浏览器 API 的惰性解析
// ---------------------------------------------------------------------------

/** 取 `navigator.mediaSession`（jsdom / 老浏览器里没有，返回 `null`）。 */
function browserMediaSession(): MediaSessionLike | null {
  const scope = globalThis as unknown as { navigator?: { mediaSession?: unknown } }
  const nav = scope.navigator
  if (!nav || typeof nav !== 'object') return null
  const session = nav.mediaSession
  if (!session || typeof session !== 'object') return null
  return session as MediaSessionLike
}

/** 用全局 `MediaMetadata` 构造元数据（没有则返回 `null`）。 */
function browserMetadata(init: {
  title?: string
  artist?: string
  album?: string
  artwork?: Array<{ src: string; sizes?: string; type?: string }>
}): MediaMetadataLike | null {
  const ctor = (globalThis as unknown as { MediaMetadata?: new (init: unknown) => unknown })
    .MediaMetadata
  if (typeof ctor !== 'function') return null
  return new ctor(init) as MediaMetadataLike
}

// ---------------------------------------------------------------------------
// createMediaSession
// ---------------------------------------------------------------------------

/**
 * 造一个媒体会话控制器。
 *
 * - `update(state)`：刷新元数据（标题 / 艺人 / 专辑 / 封面）、播放状态与进度；
 * - `dispose()`：**卸载全部 action handler**（`setActionHandler(action, null)`），
 *   避免组件卸载后回调还指向已销毁的 store。
 *
 * ⚠️ action handler 的回调**只发命令**（`player:command` → 主进程 → 转发回渲染进程执行），
 *    **不直接改播放状态**。
 */
export function createMediaSession(deps: MediaSessionDeps = {}): MediaSessionController {
  const session = deps.session !== undefined ? deps.session : browserMediaSession()
  const createMetadata = deps.createMetadata ?? browserMetadata
  const sendCommand = deps.sendCommand ?? ((): void => {})
  const coverUrlFor = deps.coverUrlFor ?? coverUrl

  /** 已经装上的 action handler（`dispose()` 时逐个卸载）。 */
  const installed: MediaSessionAction[] = []
  let disposed = false

  function install(action: MediaSessionAction, handler: (details: unknown) => void): void {
    try {
      session?.setActionHandler(action, handler)
      installed.push(action)
    } catch {
      // 浏览器可能不支持这个 action（忽略即可，不能因此崩掉整个应用）。
    }
  }

  if (session) {
    install('play', () => {
      sendCommand({ type: 'play' })
    })
    install('pause', () => {
      sendCommand({ type: 'pause' })
    })
    install('previoustrack', () => {
      sendCommand({ type: 'prev' })
    })
    install('nexttrack', () => {
      sendCommand({ type: 'next' })
    })
    install('seekto', (details) => {
      const seekTime = (details as { seekTime?: unknown } | undefined)?.seekTime
      if (typeof seekTime !== 'number' || !Number.isFinite(seekTime)) return
      sendCommand({ type: 'seek', seconds: Math.max(0, seekTime) })
    })
  }

  function update(state: PlayerStateSnapshot): void {
    if (disposed || !session) return
    const current = state.current

    // 1) 元数据
    try {
      if (!current) {
        session.metadata = null
      } else {
        const artwork: Array<{ src: string; sizes?: string; type?: string }> = []
        const src = current.coverId ? coverUrlFor(current.coverId, MEDIA_ARTWORK_SIZE) : null
        if (src) {
          artwork.push({ src, sizes: `${MEDIA_ARTWORK_SIZE}x${MEDIA_ARTWORK_SIZE}` })
        }
        session.metadata = createMetadata({
          title: current.title,
          artist: current.artist,
          album: current.album,
          artwork,
        })
      }
    } catch {
      // 元数据构造失败不影响其它部分。
    }

    // 2) 播放状态
    try {
      session.playbackState = !current ? 'none' : state.isPlaying ? 'playing' : 'paused'
    } catch {
      // 忽略。
    }

    // 3) 进度（⚠️ `position` 必须在 `duration` 之内，否则 Chromium 会抛）
    const duration = state.duration > 0 ? state.duration : (current?.duration ?? 0)
    if (duration > 0) {
      const position = Math.min(Math.max(state.position, 0), duration)
      try {
        session.setPositionState({ duration, position, playbackRate: 1 })
      } catch {
        // 忽略。
      }
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (!session) return
    for (const action of installed) {
      try {
        session.setActionHandler(action, null)
      } catch {
        // 忽略。
      }
    }
    installed.length = 0
    try {
      session.metadata = null
      session.playbackState = 'none'
      session.setPositionState()
    } catch {
      // 忽略。
    }
  }

  return { update, dispose }
}

// ---------------------------------------------------------------------------
// 安装（应用级接线）
// ---------------------------------------------------------------------------

/** 安装结果。 */
export interface InstalledMediaSession {
  /** 媒体会话控制器。 */
  controller: MediaSessionController
  /** 卸载（取消 store 订阅 + 卸载 action handler）。 */
  dispose(): void
}

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览时为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 把 store 的状态压成**跨进程的精简快照**。 */
export function toSnapshot(state: PlayerState): PlayerStateSnapshot {
  const song = state.current
  return {
    current: song
      ? {
          id: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          coverId: song.coverId,
          duration: song.duration,
        }
      : null,
    isPlaying: state.isPlaying,
    position: state.position,
    duration: state.duration,
    volume: state.volume,
    mode: state.mode,
    muted: state.muted === true,
  }
}

/**
 * 安装媒体会话（**应用入口**，由 `src/main.tsx` 调用）。
 *
 * 做四件事：
 * 1. 订阅 `usePlayerStore`（**只读**：只 `subscribe`，不写状态）；
 * 2. 状态变化 → 刷新 `navigator.mediaSession`；
 * 3. 状态变化 → 经 `player:state` 推给主进程（主进程用它更新托盘）；
 * 4. 订阅主进程下发的 `player:command` → **在渲染进程里执行**（播放状态在这里）。
 *
 * ⚠️ 这是**播放状态经 IPC 同步**这条机制的**渲染进程侧**（控制器裁定 §3.7：
 *    这条机制此前**根本不存在**，由本任务新建）。
 */
export function installMediaSession(): InstalledMediaSession {
  const bridge = playerBridge()
  const controller = createMediaSession({
    sendCommand: (command) => {
      bridge?.sendCommand(command)
    },
  })

  const push = (state: PlayerStateSnapshot): void => {
    controller.update(state)
    bridge?.pushState(state)
  }

  push(toSnapshot(usePlayerStore.getState()))

  const unsubscribe = usePlayerStore.subscribe((state) => {
    push(toSnapshot(state))
  })

  // 主进程 → 渲染进程的命令：**这里执行**（播放状态由渲染进程持有）。
  // ⚠️ 渲染进程**只执行**从主进程收到的命令，绝不本地直接执行自己发出的命令——
  //    否则同一个命令会执行两遍（媒体会话 → 主进程 → 渲染进程）。
  const unsubscribeCommand = bridge?.onCommand((command) => {
    const store = usePlayerStore.getState()
    switch (command.type) {
      case 'play':
        if (!store.isPlaying) store.togglePlay()
        break
      case 'pause':
        if (store.isPlaying) store.togglePlay()
        break
      case 'toggle':
        store.togglePlay()
        break
      case 'next':
        store.next()
        break
      case 'prev':
        store.prev()
        break
      case 'seek':
        store.seek(command.seconds)
        break
    }
  })

  return {
    controller,
    dispose(): void {
      unsubscribe()
      unsubscribeCommand?.()
      controller.dispose()
    },
  }
}
