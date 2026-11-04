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

/**
 * 封面 `data:` URL 的缓存条数上限。
 *
 * ⚠️ 每条封面原始约 9 KB（`size=160` 的 JPEG），base64 后约 12 KB，
 *    16 条 ≈ 200 KB —— 可以忽略，但**必须有上界**：
 *    否则长时间播放会把见过的封面全留在内存里。
 */
export const MEDIA_ARTWORK_CACHE_ENTRIES = 16

// ---------------------------------------------------------------------------
// 封面字节 → `data:` URL
// ---------------------------------------------------------------------------

/**
 * ⚠️ **为什么媒体会话的封面必须转成 `data:` URL**（T21 真机实测）：
 *
 * - Chromium 的**媒体会话**封面（`navigator.mediaSession.metadata.artwork`）
 *   走的是**图片加载器**那条路，它**只认** `http/https/data/blob`；
 * - 我们自己的协议代理 `fnm://` **不在这个名单里** → 封面被直接拒掉，
 *   表现是 **Windows 侧（快速设置 / SMTC / 锁屏）不显示专辑图**，
 *   渲染进程还会刷一串
 *   `MediaImage src can only be of http/https/data/blob scheme: fnm://…`。
 * - ⚠️ **应用内 `<img src="fnm://…">` 是另一条加载器**（能正常显示）——
 *   所以「曲库封面有图、但系统媒体面板没图」是**同一个根因**，
 *   别误判成「封面整体挂了」。
 *
 * ⇒ 修法：渲染层自己把封面字节取回来，转成 `data:` URL 再喂给媒体会话。
 *   `data:` URL 在渲染进程与浏览器进程两侧都能解，**不需要**改主进程或 IPC。
 */

/**
 * 字节 → `data:` URL（base64）。
 *
 * @param bytes 图片字节。
 * @param mime MIME 类型（默认 `image/jpeg`）。
 * @returns `data:` URL。
 */
export function bytesToDataUrl(bytes: Uint8Array, mime = 'image/jpeg'): string {
  // ⚠️ 分块编码：`String.fromCharCode(...bytes)` 一次展开几万个参数会**爆栈**。
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = Array.from(bytes.subarray(i, i + chunk))
    binary += String.fromCharCode(...part)
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * 取 `data:` URL 里的 MIME 类型（不是 `data:` URL 就返回 `undefined`）。
 *
 * @param src URL。
 * @returns MIME 类型。
 */
export function dataUrlMime(src: string): string | undefined {
  if (!src.startsWith('data:')) return undefined
  const end = src.indexOf(';')
  if (end < 0) return undefined
  return src.slice('data:'.length, end)
}

/**
 * **默认**的封面取字节实现：渲染层直接 `fetch` 协议代理地址。
 *
 * ⚠️ 渲染层能 `fetch('fnm://…')`（协议已注册 `supportFetchAPI` + `corsEnabled`，
 *    代理也带 CORS 头）—— 真机实测取到 `200 / image/jpeg / 8684 字节` ✓。
 * ⚠️ 取不到就返回 `null`（**不抛**）：封面只是锦上添花，不能因此影响播放。
 *
 * @param url 封面 URL（由 `coverUrl()` 拼装）。
 * @returns `data:` URL；取不到时 `null`。
 */
export async function fetchArtworkDataUrl(url: string): Promise<string | null> {
  const scope = globalThis as unknown as { fetch?: typeof fetch }
  if (typeof scope.fetch !== 'function') return null
  try {
    const res = await scope.fetch(url)
    if (!res || res.ok === false) return null
    const blob = await res.blob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.length === 0) return null
    return bytesToDataUrl(bytes, blob.type || 'image/jpeg')
  } catch {
    return null
  }
}

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
  /**
   * 取封面字节并转成 Chromium 认得的 `data:` URL。
   *
   * ⚠️ **为什么不是直接把 `fnm://` 塞进 artwork**：Chromium 的媒体会话封面
   *    只认 `http/https/data/blob`（详见 `bytesToDataUrl` 上方的说明）。
   * ⚠️ 缺省用渲染层 `fetch` 自取；单测注入替身即可（不必真联网）。
   */
  fetchArtwork?: (url: string) => Promise<string | null>
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
  const fetchArtwork = deps.fetchArtwork ?? fetchArtworkDataUrl

  /** 已经装上的 action handler（`dispose()` 时逐个卸载）。 */
  const installed: MediaSessionAction[] = []
  let disposed = false

  // --- 封面（T21）-----------------------------------------------------------
  //
  // ⚠️ 媒体会话的封面**必须**是 Chromium 认得的 URL（`data:`）——
  //    `fnm://` 会被图片加载器拒掉（详见 `bytesToDataUrl` 上方的说明）。
  /** 封面 `data:` URL 缓存（键 = `coverId|size`；插入序即 LRU 序）。 */
  const artworkCache = new Map<string, string>()
  /** 已经发起过封面请求的键（避免同一首歌反复请求）。 */
  const pendingArtwork = new Set<string>()
  /** 封面请求令牌：**换歌**才作废在飞的请求（进度每秒推一次，不能每次都作废）。 */
  let artworkToken = 0
  /** 当前曲目标识（`id|coverId`）；变了 = 换歌了。 */
  let lastTrackKey = ''
  /** 最近一次设置的曲目（封面异步回来后要**重设一次**元数据）。 */
  let lastCurrent: NonNullable<PlayerStateSnapshot['current']> | null = null

  /** 缓存超上限时淘汰最久没用的那几条。 */
  function trimArtworkCache(): void {
    while (artworkCache.size > MEDIA_ARTWORK_CACHE_ENTRIES) {
      const oldest = artworkCache.keys().next()
      if (oldest.done) return
      artworkCache.delete(oldest.value)
    }
  }

  /**
   * 设置元数据。
   *
   * @param current 当前曲目。
   * @param artworkSrc 封面地址（`data:` URL）；`null` = 这一版不带封面。
   */
  function applyMetadata(
    current: NonNullable<PlayerStateSnapshot['current']>,
    artworkSrc: string | null,
  ): void {
    // ⚠️ `session` 可能是 `null`（没有媒体会话的环境）——`update()` 里已判过，
    //    但这里是**独立函数**，TypeScript 看不到那个收窄，这里再判一次。
    if (!session) return
    const artwork: Array<{ src: string; sizes?: string; type?: string }> = []
    if (artworkSrc) {
      const type = dataUrlMime(artworkSrc)
      artwork.push({
        src: artworkSrc,
        sizes: `${MEDIA_ARTWORK_SIZE}x${MEDIA_ARTWORK_SIZE}`,
        ...(type ? { type } : {}),
      })
    }
    session.metadata = createMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album,
      artwork,
    })
  }

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
        lastCurrent = null
        lastTrackKey = ''
        artworkToken += 1
        pendingArtwork.clear()
      } else {
        // ⚠️ **换歌**才作废在飞的封面请求 —— 进度每秒推一次，不能每次都作废。
        const trackKey = `${current.id ?? ''}|${current.coverId ?? ''}`
        if (trackKey !== lastTrackKey) {
          lastTrackKey = trackKey
          artworkToken += 1
          pendingArtwork.clear()
        }
        lastCurrent = current

        // 封面 URL 仍然由 `coverUrl()` 拼装（**全项目唯一拼装点**不变），
        // 只是**不再直接塞进 artwork**（Chromium 不认 `fnm://`）。
        const url = current.coverId ? coverUrlFor(current.coverId, MEDIA_ARTWORK_SIZE) : null
        const cacheKey = url ? `${current.coverId ?? ''}|${MEDIA_ARTWORK_SIZE}` : ''
        const cached = cacheKey ? (artworkCache.get(cacheKey) ?? null) : null
        applyMetadata(current, cached)

        // 封面还没取到 → 异步取；回来后**重设一次**元数据（带上 `data:` URL）。
        if (url && !cached && cacheKey && !pendingArtwork.has(cacheKey)) {
          const token = artworkToken
          pendingArtwork.add(cacheKey)
          void Promise.resolve()
            .then(() => fetchArtwork(url))
            .then((dataUrl) => {
              pendingArtwork.delete(cacheKey)
              if (disposed || token !== artworkToken) return
              if (!dataUrl) return
              artworkCache.set(cacheKey, dataUrl)
              trimArtworkCache()
              // ⚠️ 期间又切了歌 → 这份封面已经过时，丢弃。
              if (lastCurrent?.id !== current.id) return
              applyMetadata(current, dataUrl)
            })
            .catch(() => {
              pendingArtwork.delete(cacheKey)
            })
        }
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
