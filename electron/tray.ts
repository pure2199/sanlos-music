// 系统托盘：图标 / 菜单 / tooltip / 封面缓存（Task 17）。
//
// ---------------------------------------------------------------------------
// 职责
// ---------------------------------------------------------------------------
// - 托盘图标显示**当前曲目的封面**（主进程自己去 NAS 取字节）；
// - tooltip 显示「歌名 — 歌手 + 播放状态」，**Windows 上限 127 字符**；
// - 右键菜单：播放/暂停、上一首、下一首、显示窗口、退出；
// - 左键点击：显示主窗口（窗口隐藏时，播放继续）。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**（本文件要能在 Vitest / 普通 Node 里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串）。
//   故 Electron 相关对象一律**惰性解析**（`resolveElectron()`），并允许通过
//   `deps` 注入替身（`Tray` / `nativeImage` / `Menu`）。
// - **不引入新的 npm 依赖**。
// - **主进程出网一律走同一个 `HttpStack` 实例**（Task 9b），不得用全局 `fetch`
//   或另建 `HttpStack`——自签证书场景下只有 Chromium 栈才受证书放行管辖。
//
// ---------------------------------------------------------------------------
// 封面字节从哪来（追加要求 B）
// ---------------------------------------------------------------------------
// 渲染进程的封面 URL 走 `fnm://` 协议代理（那是给 `<img>` 用的），
// **主进程拿不到那个 URL 的字节**——它必须自己去 NAS 取**上游**地址：
//
//     <session.state.base>/api/v1/static/cover?coverId=<coverId>&size=160
//
// - 基址来自 `session.state.base`；
// - 凭证（Cookie）由主进程自己拼（`buildCookie`），渲染进程全程不参与；
// - 封面**按 `coverId` 缓存**（同一首歌切来切去不反复下载），缓存**有上界**（LRU）；
// - 封面取回**必须异步**，且**不能阻塞托盘创建**（先建托盘、封面到了再 `setImage`）；
// - **取不到封面 / 取失败** → 保持默认图标。
//
// ⚠️ T75：**应用图标资源已补上**（`build/icon.png` / `build/tray.png`，
//    由 `scripts/make-app-icon.mjs` **零依赖**生成）。
//    ⇒ 「**没有封面**」（= 没在播放）时托盘显示**应用图标**，不再是空白；
//    「**播放中**」仍显示专辑封面（用户拍板的行为）。
//    ⚠️ **没注入 `appIcon`** 时退回到 `nativeImage.createEmpty()`（单测的老用法）。

import { Buffer } from 'node:buffer'

import { API_PREFIX } from '../shared/constants'
import type { PlayerCommand, PlayerStateSnapshot } from '../shared/playerBridge'
import type { HttpStack } from './http'
import type { SessionManager } from './session'
import { authx, buildCookie } from './sign'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * Windows 托盘 tooltip 的字符上限。
 *
 * ⚠️ Windows 的上限是 **127 个 TCHAR**（即 UTF-16 码元），不是 127 个码点——
 *    一个 emoji 占 2 个码元。所以截断时**既不能按码元切**（会切出半个代理对，
 *    显示成乱码），也**不能只看码点个数**（127 个 emoji 的 UTF-16 长度是 254，
 *    照样超限）。本模块的做法是：**按码点切**（`Array.from`，绝不切半个代理对），
 *    **长度预算按 UTF-16 码元计**——两个约束同时满足。
 */
export const TRAY_TOOLTIP_MAX = 127

/** 托盘图标的边长（Windows 托盘图标的标准尺寸；系统会按 DPI 缩放）。 */
export const TRAY_ICON_SIZE = 16

/** 向服务端请求封面时使用的 `size` 参数（追加要求 B：160px）。 */
export const TRAY_COVER_SIZE = 160

/** 封面缓存的默认上界（条目数；LRU 淘汰）。 */
export const DEFAULT_COVER_CACHE_ENTRIES = 32

/** 没有曲目时的托盘提示（应用名）。 */
const IDLE_TOOLTIP = 'Sanlos Music'

// ---------------------------------------------------------------------------
// Electron 惰性解析
// ---------------------------------------------------------------------------

/**
 * `require` 的最小声明。
 *
 * Electron 主进程的打包产物是 CommonJS（esbuild `--format=cjs`），运行时存在模块作用域的 `require`；
 * 单元测试跑在 Vitest（ESM）里没有它，所以**所有使用点都必须先用 `typeof` 守卫**。
 */
declare const require: ((id: string) => unknown) | undefined

/**
 * 惰性取 Electron 模块（**不在模块顶层调用**）。
 *
 * 非 Electron 进程（Vitest / 普通 Node）里 `require('electron')` 返回的是可执行文件路径字符串，
 * 取不到任何 API；此时返回 `null`，由调用方给出可读错误。
 */
function resolveElectron(): Record<string, unknown> | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as unknown
    if (typeof mod !== 'object' || mod === null) return null
    return mod as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 类型（Electron 的最小子集，便于单测注入替身）
// ---------------------------------------------------------------------------

/** Electron `nativeImage` 的最小接口。 */
export interface NativeImageLike {
  /** 图标是否为空。 */
  isEmpty(): boolean
  /** 缩放（返回新图标）。 */
  resize(options: { width: number; height: number }): NativeImageLike
}

/** Electron `nativeImage` 工厂的最小接口。 */
export interface NativeImageFactory {
  /** 由字节创建图标。 */
  createFromBuffer(bytes: Uint8Array): NativeImageLike
  /** 空图标（没有封面 / 没有应用图标时的降级）。 */
  createEmpty(): NativeImageLike
}

/** Electron `Tray` 的最小接口。 */
export interface TrayLike {
  /** 设置提示文字。 */
  setToolTip(tooltip: string): void
  /** 设置图标。 */
  setImage(image: NativeImageLike): void
  /** 监听托盘事件（`click` = 左键；`right-click` = 右键）。 */
  on(event: 'click' | 'right-click', listener: () => void): void
  /** 销毁托盘。 */
  destroy(): void
}

/** Electron `Menu` 的最小接口。 */
export interface MenuLike {
  /** 弹出菜单。 */
  popup(options?: { callback?: () => void }): void
}

/** 菜单项模板（Electron `MenuItemConstructorOptions` 的最小子集）。 */
export interface MenuItemLike {
  /** 菜单文字。 */
  label: string
  /** 点击回调。 */
  click?: () => void
  /** 菜单项类型（`separator` = 分隔线）。 */
  type?: 'normal' | 'separator'
}

// ---------------------------------------------------------------------------
// tooltip
// ---------------------------------------------------------------------------

/** `trayTooltip` 的入参。 */
export interface TrayTooltipInput {
  /** 歌名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 是否正在播放。 */
  playing: boolean
}

/**
 * 按**码点**截断字符串（绝不切出半个代理对）。
 *
 * - 用 `Array.from(str)` 按码点切（追加要求 C）：emoji 与组合字符都是**一个**码点，
 *   按 UTF-16 码元切会把代理对劈开，显示成乱码；
 * - **长度预算按 UTF-16 码元计**（Windows 的 127 是 TCHAR 上限）——
 *   所以结果既不会超过 127 个码元，也不会切出半个 emoji；
 * - 截断了就补一个省略号 `…`（它自己占 1 个码元，会从预算里扣掉）。
 *
 * @param text      待截断的文本。
 * @param maxUnits  长度预算（UTF-16 码元个数）。
 */
export function truncateByCodePoint(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return ''
  if (text.length <= maxUnits) return text

  const points = Array.from(text)
  let out = ''
  let units = 0
  for (const point of points) {
    const size = point.length
    if (units + size > maxUnits) break
    out += point
    units += size
  }

  if (out.length < text.length) {
    // 留一个码元给省略号：必要时砍掉末尾的码点（**按码点砍**，不砍半个代理对）。
    while (out.length > 0 && out.length + 1 > maxUnits) {
      const kept = Array.from(out)
      kept.pop()
      out = kept.join('')
    }
    out += '…'
  }
  return out
}

/**
 * 生成托盘 tooltip。
 *
 * 形如 `▶ 歌名 — 歌手` / `⏸ 歌名 — 歌手（已暂停）`：
 * - **必须包含歌名与歌手**；
 * - 暂停时标注「已暂停」；
 * - 超过 `TRAY_TOOLTIP_MAX`（127）按**码点**截断（见 `truncateByCodePoint`）。
 *
 * ⚠️ 截断时**优先砍歌名**（歌手信息更有辨识度），歌名砍到不能再砍时才砍歌手——
 *    这样「包含歌名与歌手」在截断后依然成立。
 */
export function trayTooltip(input: TrayTooltipInput): string {
  const playing = input.playing === true
  const title = sanitize(input.title)
  const artist = sanitize(input.artist)

  // 没有曲目：显示应用名（此时既没有歌名也没有歌手可显示）。
  if (title.length === 0 && artist.length === 0) return IDLE_TOOLTIP

  const marker = playing ? '▶' : '⏸'
  const status = playing ? '' : '（已暂停）'
  const head = `${marker} `
  const tail = artist.length > 0 ? ` — ${artist}` : ''

  // 固定部分（标记 + 状态 + 歌手）优先保留；剩下的预算给歌名。
  let budget = TRAY_TOOLTIP_MAX - head.length - status.length
  let artistPart = tail
  if (artistPart.length > budget) {
    // 歌手自己都超长 → 砍歌手，并把一半预算让给歌名。
    artistPart = truncateByCodePoint(artistPart, Math.max(0, Math.floor(budget / 2)))
  }
  // 歌手占掉的那部分要从歌名的预算里扣掉（否则总长会超限）。
  budget = TRAY_TOOLTIP_MAX - head.length - status.length - artistPart.length
  const titlePart = truncateByCodePoint(title, Math.max(0, budget))

  return `${head}${titlePart}${artistPart}${status}`
}

/** 去首尾空白；非字符串按空串处理。 */
function sanitize(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

// ---------------------------------------------------------------------------
// 封面缓存与取回
// ---------------------------------------------------------------------------

/** 封面字节的来源（主进程自己去 NAS 取）。 */
export interface CoverFetcher {
  /**
   * 按 `coverId` 取封面字节。
   *
   * 命中缓存则**不发请求**；取不到（无封面 / 请求失败 / 响应非图片）返回 `null`。
   */
  fetch(coverId: string): Promise<Uint8Array | null>
  /** 缓存里的条目数（诊断用）。 */
  size(): number
  /** 清空缓存。 */
  clear(): void
}

/** `createCoverFetcher` 的参数。 */
export interface CoverFetcherOptions {
  /**
   * 出网通道。
   *
   * ⚠️ **必须是 Task 9b 的那个 `HttpStack` 实例**（`electron/main.ts` 里创建的那一个）——
   *    另建一个或用全局 `fetch` 都会在自签证书场景下连不上。
   */
  http: HttpStack
  /**
   * 会话（提供 `base` / `token` / `isRelay`）。
   *
   * 只用到 `state`，不调用 `session.request()`——那个方法会把响应按 JSON 解析，
   * 封面是二进制，走不了它。
   */
  session: Pick<SessionManager, 'state'>
  /** 缓存上界（条目数）；缺省 `DEFAULT_COVER_CACHE_ENTRIES`。 */
  maxEntries?: number
}

/**
 * 造一个封面取回器（**带 LRU 缓存**）。
 *
 * - 缓存键是 `coverId`（同一首歌切来切去不反复下载）；
 * - 缓存**有上界**（默认 32 条，命中即刷新顺序，超限淘汰最久未用的那条）；
 * - 走**同一个 `HttpStack` 实例**，凭证由主进程自己拼（渲染进程全程不参与）。
 */
export function createCoverFetcher(opts: CoverFetcherOptions): CoverFetcher {
  const maxEntries = opts.maxEntries ?? DEFAULT_COVER_CACHE_ENTRIES
  // `Map` 的插入序即 LRU 序：命中时 delete + set 把条目移到末尾。
  const cache = new Map<string, Uint8Array>()

  async function download(coverId: string): Promise<Uint8Array | null> {
    const state = opts.session.state
    const base = state.base
    const token = state.token
    // 没有会话就没有基址 / 凭证 → 直接放弃（不报错，托盘降级到默认图标）。
    if (!base || !token) return null

    const url =
      `${base}${API_PREFIX}/static/cover` +
      `?coverId=${encodeURIComponent(coverId)}&size=${TRAY_COVER_SIZE}`
    const headers = new Headers()
    headers.set('authx', authx('GET', url))
    headers.set('cookie', buildCookie(token, state.isRelay))

    try {
      const res = await opts.http.fetch(url, { method: 'GET', headers })
      if (typeof res.status === 'number' && res.status >= 400) return null
      const buffer = await res.arrayBuffer()
      if (buffer.byteLength === 0) return null
      return new Uint8Array(buffer)
    } catch {
      // 取封面失败**不是致命错误**：托盘降级到默认图标即可。
      return null
    }
  }

  return {
    async fetch(coverId: string): Promise<Uint8Array | null> {
      const key = typeof coverId === 'string' ? coverId.trim() : ''
      if (key.length === 0) return null

      const hit = cache.get(key)
      if (hit) {
        cache.delete(key)
        cache.set(key, hit)
        return hit
      }

      const bytes = await download(key)
      if (!bytes) return null

      cache.set(key, bytes)
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next()
        if (oldest.done) break
        cache.delete(oldest.value)
      }
      return bytes
    },
    size(): number {
      return cache.size
    },
    clear(): void {
      cache.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

/** `createTray` 的依赖（全部可注入，单测不依赖真实 Electron）。 */
export interface TrayDeps {
  /** 取当前的播放器状态（主进程侧缓存的快照）。 */
  getState?: () => PlayerStateSnapshot | null
  /** 主进程 → 渲染进程：下发播放命令。 */
  sendCommand?: (command: PlayerCommand) => void
  /** 显示主窗口。 */
  showWindow?: () => void
  /**
   * 切换**桌面悬浮歌词**的显示（Task 10）。
   *
   * ⚠️ 由主进程负责创建 / 隐藏悬浮窗并落盘。
   * ⚠️ 菜单是**一次性构建**的（Electron 的 `Menu` 是静态的），所以这里的文案
   *    只能是静态的「桌面歌词」；**当前开关状态**看设置面板。
   */
  toggleLyricOverlay?: () => void
  /** 真正退出应用（托盘菜单的「退出」）。 */
  quit?: () => void
  /** 封面字节来源（主进程自己去 NAS 取）。 */
  cover?: CoverFetcher
  /**
   * **应用图标**（T75）：没有封面 / 封面取失败时托盘显示它。
   *
   * ⚠️ **不注入就没有**（退回到 `nativeImage.createEmpty()`）——
   *    这样单测的既有老用法**行为一字不变**。
   */
  appIcon?: NativeImageLike
  /** 托盘工厂；缺省用 Electron 的 `Tray`。 */
  createTray?: (icon: NativeImageLike) => TrayLike
  /** 图标工厂；缺省用 Electron 的 `nativeImage`。 */
  nativeImage?: NativeImageFactory
  /** 菜单工厂；缺省用 Electron 的 `Menu.buildFromTemplate`。 */
  buildMenu?: (template: MenuItemLike[]) => MenuLike
}

/** 托盘控制器的对外接口。 */
export interface TrayController {
  /** 托盘实例（单测用）。 */
  readonly tray: TrayLike
  /** 用新的播放器状态刷新托盘（tooltip + 图标）。 */
  update(state: PlayerStateSnapshot | null): void
  /** 销毁托盘。 */
  destroy(): void
}

/**
 * 造一个系统托盘。
 *
 * 流程：
 * 1. **立刻**建托盘（默认图标 = **应用图标**；没有则 `nativeImage.createEmpty()`）——**不阻塞**在封面下载上；
 * 2. 装右键菜单（播放/暂停、上一首、下一首、显示窗口、退出）与左键「显示窗口」；
 * 3. 之后每次 `update(state)`：刷新 tooltip；**封面 id 变了**才异步取封面，
 *    取到了再 `setImage`（取不到就保持默认图标）。
 */
export function createTray(deps: TrayDeps): TrayController {
  const nativeImage = deps.nativeImage ?? resolveNativeImage()
  const createTrayImpl = deps.createTray ?? resolveTrayFactory()
  const buildMenu = deps.buildMenu ?? resolveMenuBuilder()

  let lastTooltip = ''
  let lastCoverId = ''
  /** 封面请求的令牌：旧的请求回来时若令牌已变，直接丢弃（避免旧封面盖掉新封面）。 */
  let coverToken = 0

  // ⚠️ T75：建托盘时就用**应用图标**（没在播放时不再是空白）。
  const tray = createTrayImpl(deps.appIcon ?? nativeImage.createEmpty())

  const menu = buildMenu(buildMenuTemplate())
  // 右键 → 菜单；左键 → 显示窗口。
  // ⚠️ **不调用 `tray.setContextMenu()`**：Windows 上设了上下文菜单之后，
  //    左键点击也会弹菜单（Electron 的平台差异），就点不出「显示窗口」了。
  tray.on('right-click', () => {
    menu.popup()
  })
  tray.on('click', () => {
    deps.showWindow?.()
  })

  function buildMenuTemplate(): MenuItemLike[] {
    return [
      {
        label: '播放 / 暂停',
        click: () => {
          deps.sendCommand?.({ type: 'toggle' })
        },
      },
      {
        label: '上一首',
        click: () => {
          deps.sendCommand?.({ type: 'prev' })
        },
      },
      {
        label: '下一首',
        click: () => {
          deps.sendCommand?.({ type: 'next' })
        },
      },
      { label: '', type: 'separator' },
      {
        label: '显示窗口',
        click: () => {
          deps.showWindow?.()
        },
      },
      {
        // ⚠️ 桌面悬浮歌词（Task 10）：开 / 关切换。
        label: '桌面歌词',
        click: () => {
          deps.toggleLyricOverlay?.()
        },
      },
      {
        label: '退出',
        click: () => {
          deps.quit?.()
        },
      },
    ]
  }

  async function refreshCover(state: PlayerStateSnapshot | null): Promise<void> {
    const coverId = state?.current?.coverId ?? ''
    // 没换歌 → 什么都不做（`update` 每秒会被调好几次，别重复干活）。
    if (coverId === lastCoverId) return
    lastCoverId = coverId

    if (coverId.length === 0) {
      // 没有封面（= **没在播放**）→ **应用图标**（T75：不再是空白）。
      tray.setImage(deps.appIcon ?? nativeImage.createEmpty())
      return
    }

    const token = (coverToken += 1)
    const bytes = await deps.cover?.fetch(coverId)
    // 期间又切了歌 → 这份封面已经过时，丢弃。
    if (token !== coverToken) return
    if (!bytes) {
      // 封面没取到 → **应用图标**（T75：不是空白）。
      tray.setImage(deps.appIcon ?? nativeImage.createEmpty())
      return
    }

    try {
      const image = nativeImage.createFromBuffer(bytes).resize({
        width: TRAY_ICON_SIZE,
        height: TRAY_ICON_SIZE,
      })
      if (image.isEmpty()) {
        // 封面字节解不出图 → **应用图标**。
        tray.setImage(deps.appIcon ?? nativeImage.createEmpty())
        return
      }
      tray.setImage(image)
    } catch {
      // 字节不是合法图片 → **应用图标**（不是空白）。
      tray.setImage(deps.appIcon ?? nativeImage.createEmpty())
    }
  }

  function update(state: PlayerStateSnapshot | null): void {
    const tooltip = tooltipOf(state)
    if (tooltip !== lastTooltip) {
      lastTooltip = tooltip
      tray.setToolTip(tooltip)
    }
    void refreshCover(state)
  }

  // 初始状态：先建托盘（**不等封面**），再异步补图标。
  update(deps.getState?.() ?? null)

  return {
    tray,
    update,
    destroy(): void {
      coverToken += 1
      try {
        tray.destroy()
      } catch {
        // 托盘可能已经被销毁（应用退出时）。
      }
    },
  }
}

/** 由播放器状态算出 tooltip 文本。 */
function tooltipOf(state: PlayerStateSnapshot | null): string {
  const current = state?.current
  return trayTooltip({
    title: current?.title ?? '',
    artist: current?.artist ?? '',
    playing: state?.isPlaying === true,
  })
}

// ---------------------------------------------------------------------------
// Electron 工厂的惰性解析
// ---------------------------------------------------------------------------

/** 惰性取 Electron 的 `nativeImage`。 */
function resolveNativeImage(): NativeImageFactory {
  const mod = resolveElectron()?.['nativeImage'] as
    | { createEmpty?: unknown; createFromBuffer?: unknown }
    | undefined
  if (
    !mod ||
    typeof mod.createEmpty !== 'function' ||
    typeof mod.createFromBuffer !== 'function'
  ) {
    throw new Error('无法创建托盘：当前进程没有可用的 Electron nativeImage（缺少 Electron 运行时）')
  }
  const createEmpty = mod.createEmpty as () => NativeImageLike
  const createFromBuffer = mod.createFromBuffer as (buffer: Buffer) => NativeImageLike
  return {
    createEmpty: () => createEmpty(),
    createFromBuffer: (bytes: Uint8Array) => createFromBuffer(Buffer.from(bytes)),
  }
}

/** 惰性取 Electron 的 `Tray` 构造函数。 */
function resolveTrayFactory(): (icon: NativeImageLike) => TrayLike {
  const TrayCtor = resolveElectron()?.['Tray'] as (new (icon: unknown) => TrayLike) | undefined
  if (typeof TrayCtor !== 'function') {
    throw new Error('无法创建托盘：当前进程没有可用的 Electron Tray（缺少 Electron 运行时）')
  }
  return (icon: NativeImageLike) => new TrayCtor(icon)
}

/** 惰性取 Electron 的 `Menu.buildFromTemplate`。 */
function resolveMenuBuilder(): (template: MenuItemLike[]) => MenuLike {
  const menu = resolveElectron()?.['Menu'] as { buildFromTemplate?: unknown } | undefined
  if (!menu || typeof menu.buildFromTemplate !== 'function') {
    throw new Error('无法创建托盘菜单：当前进程没有可用的 Electron Menu（缺少 Electron 运行时）')
  }
  const buildFromTemplate = menu.buildFromTemplate as (template: unknown) => MenuLike
  return (template: MenuItemLike[]) => buildFromTemplate(template)
}
