// NAS 账号 OAuth 授权登录（Task 11）。
//
// ---------------------------------------------------------------------------
// 链路（规格 §2.2 + §15.8 实测）
// ---------------------------------------------------------------------------
// 1. `GET <base>/api/v1/sys/config` → `data.nasOAuth.clientId`
//    ⚠️ 实测：`nasOAuth` 里**没有 `url` 字段**，授权地址必须**自行拼装**：
//    `<服务器根>/signin?client_id=<clientId>&redirect_uri=<base>/oauth/result&app_name=Sanlos Music`
// 2. 在**独立分区**的 Electron 窗口里打开该地址，等用户完成 fnOS 账号授权；
// 3. 拦截跳回 `redirect_uri` 的请求，取 `code`（`error` 参数代表授权失败）；
// 4. `POST <base>/api/v1/user/auth-login` `{ code, deviceId }` → `data.userToken`。
//
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串。
//   故 Electron 相关对象一律**惰性解析**，并允许注入替身
//   （与 `electron/http.ts` 的 `opts.session`、`electron/ipc.ts` 的 `opts.ipcMain` 同一套接缝写法）。
// - **渲染进程永远拿不到 token**：`code` / `userToken` 只在主进程内存里流转，
//   **绝不**出现在抛出的错误消息里（`code` 是一次性凭证，仍属敏感项）。
// - **日志里也不含凭证**：本模块唯一的 `console.*` 是静默续期失败时的那条
//   `console.warn`，内容是本模块自己的固定文案（授权 `code` 会被抹掉）。
// - **绝不全局 `callback(0)`**：授权分区上的证书校验回调只用
//   `callback(trusted.verify(request.hostname))`——命中放行（`0`）、未命中交回
//   Chromium 默认校验（`-3`）。
// - 授权地址只接受 `http(s)`：`file://` / `javascript:` 一律拒绝。
// - **授权分区与 API 分区分离**：授权窗口会种下 NAS 的会话 Cookie，
//   若与 API 流量共用 cookie jar，会和 API 请求手工拼的
//   `Cookie: music-token=…; mode=relay` 互相干扰。
//
// ---------------------------------------------------------------------------
// 出网通道（追加要求 F）
// ---------------------------------------------------------------------------
// `sys/config` 与 `auth-login` 两个请求必须走**主进程那一个** `HttpStack` 实例：
// `createHttpStack()` 在不传 `trusted` 时会内部 new 一个**空**信任集合，
// 自签 NAS 直接连不上且极难排查。故本模块**只接受注入**的 `HttpStack`，不自己 new。

import {
  API_PREFIX,
  CODE_OK,
  MUSIC_PATH,
  NAS_OAUTH_APP_NAME,
  NAS_OAUTH_REDIRECT_PATH,
  NAS_OAUTH_SIGNIN_PATH,
  RELAY_COOKIE_MODE,
  RELAY_DOMAIN_SUFFIX,
} from '../shared/constants'
import { hostOf, normalizeBase } from './connection'
import { attachAppShortcuts, adaptLooseWebContents } from './appShortcuts'
import { TrustedHosts } from './cert'
import type { ElectronSessionLike, HttpStack } from './http'
import { authx } from './sign'
import { newDeviceId, SessionStateError, type SessionManager } from './session'
import type { NasLoginHandler } from './ipc'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 授权窗口的最小接口（**依赖注入的接缝**）。 */
export interface WebContentsLike {
  /** 注册事件监听（`will-redirect` / `will-navigate` / `did-navigate` 等）。 */
  on(channel: string, listener: (...args: unknown[]) => void): void
  /** 加载授权地址。 */
  loadURL(url: string): Promise<void>
  /**
   * 复制当前选区（T36：菜单栏去掉后，编辑快捷键要自己接回来）。
   *
   * ⚠️ **可选**：单测里的替身没有这两个方法 → 缺了就**不接管**该动作。
   */
  copy?(): void
  /**
   * 把剪贴板内容粘到聚焦元素（T36）。
   *
   * ⚠️ **可选**：同上。
   */
  paste?(): void
}

/** 授权窗口的最小接口。 */
export interface BrowserWindowLike {
  /** 窗口的 webContents。 */
  readonly webContents: WebContentsLike
  /**
   * 注册**窗口级**事件监听（目前只用到 `closed`）。
   *
   * ⚠️ **少了它，用户手动关掉授权窗口（点 X）时我们就收不到通知**，
   *    `auth:login` 会一直 pending 到 5 分钟超时 → 渲染进程的登录页
   *    （`setBusy(true)` 复位不了）被锁死 5 分钟。
   */
  on(channel: string, listener: (...args: unknown[]) => void): void
  /** 销毁窗口。 */
  destroy(): void
}

/** `BrowserWindow` 构造函数的最小接口。 */
export interface BrowserWindowCtorLike {
  new (options: Record<string, unknown>): BrowserWindowLike
}

/** 本模块用到的 Electron 能力（单测可整体注入替身）。 */
export interface OAuthElectronLike {
  /** Electron 的 `BrowserWindow`。 */
  BrowserWindow: BrowserWindowCtorLike
  /** Electron 的 `session` 模块（用来拿授权分区）。 */
  session?: ElectronSessionLike
}

/** `runOAuthWindow` 的入参。 */
export interface OAuthWindowOptions {
  /** 授权地址（**只接受 http/https**）。 */
  url: string
  /** 回调地址（**只接受 http/https**）；命中即拦截并解析。 */
  redirect: string
  /**
   * 静默模式（token 续期）：窗口不显示，
   * `did-finish-load` 后 6s 内没有跳回 `redirect` 就放弃并抛「fnOS 登录已过期」。
   */
  silent?: boolean
  /** 超时（毫秒）；缺省按模式取默认值。 */
  timeoutMs?: number
  /**
   * 受信 host 集合（**可选**）。
   *
   * 提供时会在**授权分区**上注册该集合的证书校验回调
   * （命中放行 `0` / 未命中交回 Chromium 默认校验 `-3`）。
   * 主进程应当注入**同一个** `TrustedHosts` 实例（与 API 分区共用）。
   */
  trusted?: TrustedHosts
  /**
   * 出网通道（**可选**）：用来读出当前信任版本号，让授权分区跟着换代
   * （绕开授权分区里缓存的证书错误）。缺省时授权分区名固定为 `fn-oauth`。
   */
  http?: HttpStack
}

/** 打开授权窗口并拿到授权码的函数（**依赖注入的接缝**）。 */
export type OAuthWindowRunner = (opts: OAuthWindowOptions) => Promise<string>

/** `createNasOAuthHandlers` 的入参。 */
export interface NasOAuthOptions {
  /** 会话管理器（Task 7）：handler 通过它提交 mode / base / deviceId / token。 */
  session: SessionManager
  /** 出网通道（**必须是主进程那一个** `HttpStack` 实例）。 */
  http: HttpStack
  /** 受信 host 集合（与 API 分区共用同一个实例）。 */
  trusted: TrustedHosts
  /** 打开授权窗口的函数；缺省用 Electron 实现（单测注入替身）。 */
  openWindow?: OAuthWindowRunner
}

/** `createNasOAuthHandlers` 的返回值。 */
export interface NasOAuthHandlers {
  /** 注入 `registerAuthIpc({ nasLoginHandler })` 的处理器（Task 10 的契约）。 */
  nasLoginHandler: NasLoginHandler
  /** 注入 `session.setNasRelogin(...)` 的处理器：返回新 token，**空串 = 失败**。 */
  nasReloginHandler: () => Promise<string>
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 授权窗口专用分区名前缀（最终分区名 = `<前缀>-v<epoch>`）。
 *
 * ⚠️ **必须与 API 分区（`fn-nas-v<epoch>`）分开**：授权窗口会种下 NAS 的会话 Cookie，
 * 与 API 流量共用 cookie jar 会互相干扰。
 */
export const OAUTH_PARTITION_PREFIX = 'fn-oauth'

/**
 * 授权分区名：**跟随信任版本号换代**。
 *
 * 为什么：Chromium 按 `host:port` **缓存证书错误**，且**只有换分区才清得掉**
 * （规格 §15.9 的实测结论）。授权分区与 API 分区的证书错误缓存是**互相独立**的，
 * 所以授权分区也必须能换代——否则某个 host 在授权分区里缓存过证书错误后，
 * 「重新授权」不会自动清掉它。
 *
 * 信任版本号从 API 分区的名字里取（`fn-nas-v<epoch>` → `<epoch>`），
 * 两个分区便在**同一个信任版本**上同步换代：信任集合一变 → 换分区 →
 * 绕开旧分区里缓存的证书错误。
 *
 * 副作用（可接受）：换代会丢掉授权分区里的 fnOS 会话 Cookie，
 * 静默续期会因此失败并提示「fnOS 登录已过期」，用户重新授权一次即可。
 */
export function oauthPartitionName(http?: HttpStack): string {
  if (!http) return OAUTH_PARTITION_PREFIX
  const match = /-v(\d+)$/.exec(http.partitionName())
  return match ? `${OAUTH_PARTITION_PREFIX}-v${match[1]}` : OAUTH_PARTITION_PREFIX
}

/** 静默模式：页面加载完成后等待跳回回调的时长（规格：6s）。 */
export const SILENT_WAIT_MS = 6000

/** 静默模式的总超时（页面一直没加载完时的兜底）。 */
export const SILENT_TIMEOUT_MS = 30_000

/** 非静默模式的授权总超时（5 分钟）。 */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000

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
 * 惰性取 Electron 运行时（**不在模块顶层调用**）。
 *
 * 非 Electron 进程（Vitest / 普通 Node）里 `require('electron')` 返回的是可执行文件路径字符串，
 * 取不到任何 API；此时返回 `null`，由调用方给出可读错误。
 */
function resolveElectron(): OAuthElectronLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { BrowserWindow?: unknown; session?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const BrowserWindow = mod.BrowserWindow
    if (typeof BrowserWindow !== 'function') return null
    return {
      BrowserWindow: BrowserWindow as BrowserWindowCtorLike,
      session: mod.session as ElectronSessionLike | undefined,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 是否是普通对象（数组与 null 都不算）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 取字符串字段（不是字符串就当没有）。 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 取业务码（缺失 / 非法时返回 -1，表示「不是业务信封」）。 */
function readCode(value: unknown): number {
  const code = asRecord(value)?.['code']
  return typeof code === 'number' ? code : -1
}

/** 读响应体并解析 JSON（**不是 JSON 时返回 `null`，不抛异常**）。 */
async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text()
    if (!text) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 把敏感值从文本里抹掉。 */
function redact(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('***')
}

/**
 * 把敏感值从抛出的错误里抹掉（**就地改写**，保留错误类型与 `cause` 链）。
 *
 * ⚠️ **必须连 `stack` 一起改**：Electron 会把主进程错误的 message 与 stack 一起
 * 序列化给渲染进程的 `ipcRenderer.invoke` 拒绝值——只改 message 的话旧值仍会泄漏。
 */
function redactError(err: unknown, secret: string): unknown {
  if (!secret) return err
  if (!(err instanceof Error)) return err

  if (err.message.includes(secret)) err.message = redact(err.message, secret)
  if (typeof err.stack === 'string' && err.stack.includes(secret)) {
    err.stack = redact(err.stack, secret)
  }

  let cursor: unknown = (err as { cause?: unknown }).cause
  for (let depth = 0; depth < 5; depth++) {
    if (!(cursor instanceof Error)) break
    if (cursor.message.includes(secret)) cursor.message = redact(cursor.message, secret)
    if (typeof cursor.stack === 'string' && cursor.stack.includes(secret)) {
      cursor.stack = redact(cursor.stack, secret)
    }
    cursor = (cursor as { cause?: unknown }).cause
  }
  return err
}

/** 归一化音乐根；非法时抛可读错误。 */
function requireMusicBase(server: unknown): string {
  const base = normalizeBase(typeof server === 'string' ? server.trim() : '')
  if (!base) throw new Error('服务器地址无效：只支持 http/https 地址')
  return base
}

/** 按基址 host 推断是否走 FN 中继（host 以 `.fnos.net` 结尾）。 */
function isRelayHost(base: string): boolean {
  const host = hostOf(base)
  return host.length > 0 && host.endsWith(RELAY_DOMAIN_SUFFIX)
}

/**
 * 校验地址只允许 `http(s)`，返回**原始**（去空白）字符串。
 *
 * ⚠️ 授权窗口会加载这个地址：`file://` / `javascript:` 之类必须在这里挡掉。
 */
function requireHttpUrl(input: unknown, label: string): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label}无效：只支持 http/https 地址`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}无效：只支持 http/https 地址`)
  }
  return raw
}

// ---------------------------------------------------------------------------
// 授权地址与回调地址
// ---------------------------------------------------------------------------

/**
 * 服务器根：**去掉 `/music` 后的服务器根**。
 *
 * 规则沿用 `electron/connection.ts` 的 `normalizeBase`（**不另写一套**）：
 * - `https://host:5667/music` → `https://host:5667`；
 * - `https://host/nas` → 归一化成 `https://host/nas/music` → 服务器根 `https://host/nas`
 *   （反向代理挂在子路径下的部署不会被改成错误路径）。
 */
export function serverRootOf(base: string): string {
  const root = requireMusicBase(base)
  return root.endsWith(MUSIC_PATH) ? root.slice(0, -MUSIC_PATH.length) : root
}

/**
 * 回调地址：`<音乐根>/oauth/result`。
 *
 * ⚠️ 这是 query 的**值**，拼进授权地址时要 URL 编码。
 */
export function redirectUriOf(base: string): string {
  return `${requireMusicBase(base)}${NAS_OAUTH_REDIRECT_PATH}`
}

/**
 * 自行拼装授权地址（实测：`nasOAuth` 里**没有** `url` 字段）。
 *
 * ```
 * <服务器根>/signin?client_id=<clientId>&redirect_uri=<base>/oauth/result&app_name=Sanlos Music
 * ```
 *
 * ⚠️ `app_name` 里的内容与 `redirect_uri` 都必须 URL 编码
 * （`redirect_uri` 本身是 query 的值，不编码会被 `&` / `:` 截断）。
 */
export function buildAuthorizeUrl(opts: { base: string; clientId: string }): string {
  const clientId = opts.clientId.trim()
  if (!clientId) {
    // ⚠️ 绝不拼出 `client_id=undefined` 的 URL 去请求。
    throw new Error('该服务器不支持 NAS 账号登录')
  }
  const root = serverRootOf(opts.base)
  const params = [
    `client_id=${encodeURIComponent(clientId)}`,
    `redirect_uri=${encodeURIComponent(redirectUriOf(opts.base))}`,
    `app_name=${encodeURIComponent(NAS_OAUTH_APP_NAME)}`,
  ].join('&')
  return `${root}${NAS_OAUTH_SIGNIN_PATH}?${params}`
}

// ---------------------------------------------------------------------------
// 授权码解析
// ---------------------------------------------------------------------------

/**
 * 从重定向 URL 里取授权码。
 *
 * - `error` 参数**存在** → 返回 `null`（授权失败，`error` 与 `code` 同时存在时 `error` 优先）；
 * - 否则返回 `code`；没有 `code` → 返回 `null`；
 * - 输入不是合法 URL / 空串 → 返回 `null`（**不抛异常**）。
 */
export function extractCode(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // ⚠️ `error` 优先：授权失败时服务端可能同时带上 `code`。
  if (parsed.searchParams.has('error')) return null
  const code = parsed.searchParams.get('code')
  return code && code.length > 0 ? code : null
}

/**
 * 判断某个导航目标是不是「跳回我们的回调地址」。
 *
 * 前缀匹配，但**不会**把 `.../oauth/resultXYZ` 误判成命中
 * （前缀后面必须是结尾 / `?` / `#` / `/`）。
 */
function isRedirectTarget(target: string, redirect: string): boolean {
  if (!target || !redirect) return false
  if (target.startsWith(redirect)) {
    const rest = target.slice(redirect.length)
    if (rest === '' || rest.startsWith('?') || rest.startsWith('#') || rest.startsWith('/')) {
      return true
    }
  }
  try {
    const t = new URL(target)
    const r = new URL(redirect)
    return t.origin === r.origin && t.pathname === r.pathname
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 授权分区
// ---------------------------------------------------------------------------

/**
 * 已创建的授权分区（按 Electron `session` 模块实例 → 分区名两级缓存）。
 *
 * 用 `WeakMap` 而不是模块级单例：不同 Electron session 模块各拿各的分区，
 * 单测里换替身不会串味。
 */
const partitionCache = new WeakMap<ElectronSessionLike, Set<string>>()

/**
 * 取（并按需创建）授权分区，在其上注册**同一个 trusted 集合**的证书校验回调。
 *
 * ⚠️ **绝不** `callback(0)`：命中受信集合才放行（`0`），未命中一律 `-3`
 * （交回 Chromium 默认校验，其余站点照常校验）。
 */
function ensureOAuthPartition(
  electron: OAuthElectronLike,
  partition: string,
  trusted?: TrustedHosts,
): void {
  const mod = electron.session
  if (!mod || typeof mod.fromPartition !== 'function') return

  let created = partitionCache.get(mod)
  if (!created) {
    created = new Set<string>()
    partitionCache.set(mod, created)
  }
  if (created.has(partition)) return

  const ses = mod.fromPartition(partition, { cache: false })
  if (trusted) {
    try {
      ses.setCertificateVerifyProc((request, callback) => {
        // ⚠️ 命中受信集合 → 放行（0）；未命中 → -3（交回 Chromium 默认校验）。
        callback(trusted.verify(request.hostname))
      })
    } catch {
      // 同一个分区上重复注册 verify proc 会抛错（Electron 的限制）。
      // 此时该分区**已经有**一个 verify proc 在生效，忽略即可。
    }
  }
  created.add(partition)
}

// ---------------------------------------------------------------------------
// 授权窗口
// ---------------------------------------------------------------------------

/**
 * 打开授权窗口并等授权码（**Electron 可注入版**；单测用替身调它）。
 *
 * - 只接受 `http(s)` 的授权地址与回调地址；
 * - 窗口走**独立分区**（`fn-oauth-v<epoch>`，跟随信任版本号换代），
 *   并在其上注册同一个 `trusted` 集合的证书校验回调；
 * - 监听 `will-redirect` / `will-navigate` / `did-redirect-navigation` / `did-navigate`，
 *   命中回调前缀即拦截并解析 `code`；
 * - 命中后**立即销毁**窗口；
 * - 静默模式：`did-finish-load` 后 6s 内没有跳回回调 → 抛「fnOS 登录已过期」。
 */
export async function runOAuthWindowWith(
  electron: OAuthElectronLike,
  opts: OAuthWindowOptions,
): Promise<string> {
  const url = requireHttpUrl(opts.url, '授权地址')
  const redirect = requireHttpUrl(opts.redirect, '回调地址')
  const silent = opts.silent === true
  const timeoutMs = opts.timeoutMs ?? (silent ? SILENT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)

  // 授权分区：独立于 API 分区，证书信任与 API 分区共用同一个 trusted 集合。
  // 分区名跟随信任版本号换代（绕开授权分区里缓存的证书错误）。
  const partition = oauthPartitionName(opts.http)
  ensureOAuthPartition(electron, partition, opts.trusted)

  const win = new electron.BrowserWindow({
    width: 520,
    height: 720,
    show: !silent,
    title: 'Sanlos Music · NAS 账号授权',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // ⚠️ T82：授权窗加载的是**外部页面** ⇒ 永远不开 devtools。
      devTools: false,
    },
  })

  // ⚠️ T36：菜单栏去掉后，**Ctrl+V 粘贴**得自己接回来
  //    （授权页是 NAS 的账号密码表单，用户很可能要粘贴）。
  attachAppShortcuts(adaptLooseWebContents(win.webContents))

  return await new Promise<string>((resolve, reject) => {
    let settled = false
    let silentTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (error: Error | null, code?: string): void => {
      if (settled) return
      settled = true
      if (silentTimer) clearTimeout(silentTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      // 拦截到回调后**立即销毁**窗口，不留着。
      try {
        win.destroy()
      } catch {
        // 窗口可能已经关了。
      }
      if (error) reject(error)
      else resolve(code ?? '')
    }

    /** 命中回调 → 解析授权码并结束。 */
    const onRedirect = (target: string): void => {
      if (!isRedirectTarget(target, redirect)) return
      const code = extractCode(target)
      if (code) finish(null, code)
      // ⚠️ 错误消息里**不回显** `error` 参数的值（避免服务端把敏感值塞进去）。
      else finish(new Error('NAS 账号授权失败：服务器拒绝了本次授权请求'))
    }

    // ⚠️ 用户手动关掉授权窗口（点右上角 X）时必须**立即**结束，
    //    否则 `auth:login` 一直 pending 到 5 分钟超时，
    //    渲染进程登录页的 `setBusy(true)` 复位不了 → 整页锁死 5 分钟。
    //    这条与「授权超时」是**两回事**：用户主动取消 ≠ 超时，文案要能区分。
    win.on('closed', () => {
      finish(new Error('授权窗口已关闭：已取消本次 NAS 账号授权'))
    })

    win.webContents.on('will-redirect', (event: unknown, target: unknown) => {
      const url = typeof target === 'string' ? target : ''
      if (!isRedirectTarget(url, redirect)) return
      // 只拦截我们关心的那一次跳转，授权流程内部的跳转照常放行。
      ;(event as { preventDefault?: () => void } | null)?.preventDefault?.()
      onRedirect(url)
    })

    win.webContents.on('will-navigate', (event: unknown, target: unknown) => {
      const url = typeof target === 'string' ? target : ''
      if (!isRedirectTarget(url, redirect)) return
      ;(event as { preventDefault?: () => void } | null)?.preventDefault?.()
      onRedirect(url)
    })

    win.webContents.on('did-redirect-navigation', (_event: unknown, target: unknown) => {
      onRedirect(typeof target === 'string' ? target : '')
    })

    win.webContents.on('did-navigate', (_event: unknown, target: unknown) => {
      onRedirect(typeof target === 'string' ? target : '')
    })

    win.webContents.on(
      'did-fail-load',
      (
        _event: unknown,
        code: unknown,
        description: unknown,
        _validatedURL: unknown,
        isMainFrame: unknown,
      ) => {
        // -3 = ERR_ABORTED：被我们 `preventDefault()` 掉的跳转，不是失败。
        if (typeof code === 'number' && code === -3) return
        // ⚠️ 只看**主框架**：fnOS 登录页里的子框架（验证码、第三方挂件）加载失败
        //    不该打断正在进行的授权。
        //    `isMainFrame === false` 才忽略；字段缺失时按主框架处理（宁可报错也不静默卡住）。
        if (isMainFrame === false) return
        const reason =
          typeof description === 'string' && description.length > 0 ? description : '未知错误'
        finish(new Error(`授权页面加载失败：${reason}`))
      },
    )

    win.webContents.on('did-finish-load', () => {
      if (!silent) return
      // ⚠️ 页面二次加载时**先清掉旧的定时器**：否则旧定时器先到，
      //    等待窗口实际锚定在**第一次**加载上（与「加载完成后 6s」的语义有偏差），
      //    旧定时器也会泄漏。
      if (silentTimer) {
        clearTimeout(silentTimer)
        silentTimer = null
      }
      // 静默模式：加载完成后 6s 内没有跳回回调 → fnOS 登录已过期。
      silentTimer = setTimeout(() => finish(new Error('fnOS 登录已过期')), SILENT_WAIT_MS)
    })

    timeoutTimer = setTimeout(
      () => finish(new Error('授权超时：未在规定时间内完成授权')),
      timeoutMs,
    )

    win.webContents.loadURL(url).catch(() => {
      finish(new Error('无法打开授权页面'))
    })
  })
}

/**
 * 打开授权窗口并等授权码（生产入口）。
 *
 * - 地址校验在**调用 Electron 之前**完成（纯逻辑，可单测）；
 * - 没有 Electron 运行时时抛可读错误。
 */
export async function runOAuthWindow(opts: OAuthWindowOptions): Promise<string> {
  const url = requireHttpUrl(opts.url, '授权地址')
  const redirect = requireHttpUrl(opts.redirect, '回调地址')
  const electron = resolveElectron()
  if (!electron) {
    throw new Error('无法打开授权窗口：当前进程没有可用的 Electron 运行时')
  }
  return await runOAuthWindowWith(electron, { ...opts, url, redirect })
}

// ---------------------------------------------------------------------------
// 与服务器的两次交互
// ---------------------------------------------------------------------------

/**
 * 读服务器的 `nasOAuth.clientId`。
 *
 * `GET <base>/api/v1/sys/config`（⚠️ 实测 §15.8：真实路径在**音乐 API 前缀**下，
 * `/sys/config` 会得到 404 + HTML）。
 *
 * ⚠️ clientId 缺失 → 抛「该服务器不支持 NAS 账号登录」，
 * **绝不**拼出 `client_id=undefined` 的 URL 去请求。
 */
export async function fetchNasClientId(base: string, http: HttpStack): Promise<string> {
  const root = requireMusicBase(base)
  const url = `${root}${API_PREFIX}/sys/config`

  let res: Response
  try {
    // 该端点免凭证：只带 authx（服务端当前不校验，但按上游语义发送）。
    res = await http.fetch(url, { method: 'GET', headers: { authx: authx('GET', url) } })
  } catch (cause) {
    throw new Error('无法连接服务器（网络不可达或服务未响应）', { cause })
  }

  // ⚠️ 先判 HTTP 状态码：4xx/5xx 的响应体里也可能带着合法信封。
  if (typeof res.status === 'number' && res.status >= 400) {
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }

  const envelope = asRecord(await readJson(res))
  if (!envelope) throw new Error(`服务器响应异常（HTTP ${res.status}）`)

  const code = readCode(envelope)
  if (code !== CODE_OK) {
    const msg = readString(envelope['msg'])
    throw new Error(
      `读取服务器信息失败：${msg.length > 0 ? msg : '服务端拒绝请求'}（code=${code}）`,
    )
  }

  const data = asRecord(envelope['data'])
  const nasOAuth = asRecord(data?.['nasOAuth'])
  const clientId = readString(nasOAuth?.['clientId']).trim()
  if (!clientId) throw new Error('该服务器不支持 NAS 账号登录')
  return clientId
}

/**
 * 用授权码换 token。
 *
 * `POST <base>/api/v1/user/auth-login`，body `{ code, deviceId }`，
 * 响应 `{ code: 0, data: { userToken, user } }`。
 *
 * ⚠️ **token 从 `data.userToken` 取**（不是 `data.token`）；
 * ⚠️ **响应里没有 `deviceId`**——用自己生成的那个。
 * ⚠️ 错误消息里**不含**授权 `code`。
 */
export async function exchangeAuthCode(opts: {
  base: string
  code: string
  deviceId: string
  http: HttpStack
}): Promise<string> {
  const root = requireMusicBase(opts.base)
  const body = JSON.stringify({ code: opts.code, deviceId: opts.deviceId })
  const url = `${root}${API_PREFIX}/user/auth-login`

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authx: authx('POST', url, body),
  }
  // 中继关卡：登录请求本身也要带 mode=relay（否则中继返回 HTML 错误页）。
  if (isRelayHost(root)) headers['cookie'] = `mode=${RELAY_COOKIE_MODE}`

  let res: Response
  try {
    res = await opts.http.fetch(url, { method: 'POST', headers, body })
  } catch (cause) {
    throw redactError(
      new Error('无法连接音乐服务（网络不可达或服务未响应）', { cause }),
      opts.code,
    )
  }

  if (typeof res.status === 'number' && res.status >= 400) {
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }

  const envelope = asRecord(await readJson(res))
  if (!envelope) throw new Error(`服务器响应异常（HTTP ${res.status}）`)

  const code = readCode(envelope)
  if (code !== CODE_OK) {
    // ⚠️ **不回显服务端的 msg**：追加要求 H 要求错误消息里既不能有授权 `code`、
    //    也不能有 `userToken`，而服务端回什么文本我们无法预判
    //    （`code` 是一次性凭证、`userToken` 是身份凭据）。
    //    只保留业务码供诊断——它是纯数字，不含任何凭证。
    throw new Error(`NAS 账号登录失败：服务端拒绝了本次授权请求（code=${code}）`)
  }

  const data = asRecord(envelope['data'])
  const token = readString(data?.['userToken'])
  if (!token) throw new Error('NAS 账号登录失败：服务端未返回 token')
  return token
}

// ---------------------------------------------------------------------------
// 接线：NAS 登录处理器 + 静默续期处理器
// ---------------------------------------------------------------------------

/**
 * 造出 NAS 账号 OAuth 的两个处理器。
 *
 * ---------------------------------------------------------------------------
 * `nasLoginHandler`（注入 `registerAuthIpc({ nasLoginHandler })`）
 * ---------------------------------------------------------------------------
 * Task 10 的契约要求它**在返回前**做完三件事：
 * 1. 置 `state.mode = 'nas'`；
 * 2. 把拿到的 token 写进 `session.state.token`；
 * 3. 确定最终 device id。
 *
 * ⚠️ **授权成功之前不许调 `session.nasLogin()`**：它会让世代号 +1，
 * 在授权窗口还没返回时就提交一个半成品会话。
 *
 * **device id 的取用规则**：传进来的 `deviceId` 只是「当前会话已有的」，
 * 新会话上是空串；设备 id 是**服务端作用域**的，所以
 * **同一台服务器沿用、换了服务器重新生成**。
 *
 * ---------------------------------------------------------------------------
 * `nasReloginHandler`（注入 `session.setNasRelogin(...)`）
 * ---------------------------------------------------------------------------
 * Task 7 的契约：返回**新 token 字符串**，**空串 = 失败**（不是 boolean）。
 * 静默模式打开授权窗口；`did-finish-load` 后 6s 内没有跳回回调 → 放弃。
 * ⚠️ 失败**返回空串**而不是抛穿（调用方按空串判断）。
 * ⚠️ 它**不直接改** `state.token`——由管理器在世代守卫下提交。
 */
export function createNasOAuthHandlers(opts: NasOAuthOptions): NasOAuthHandlers {
  const openWindow: OAuthWindowRunner = opts.openWindow ?? runOAuthWindow

  const nasLoginHandler: NasLoginHandler = async (args) => {
    const base = requireMusicBase(args.server)
    const clientId = await fetchNasClientId(base, opts.http)

    const code = await openWindow({
      url: buildAuthorizeUrl({ base, clientId }),
      redirect: redirectUriOf(base),
      silent: false,
      trusted: opts.trusted,
      http: opts.http,
    })

    // 设备 id 是服务端作用域的：同一台服务器沿用，换服务器重新生成。
    const deviceId =
      opts.session.state.base === base && opts.session.state.deviceId
        ? opts.session.state.deviceId
        : newDeviceId()

    const token = await exchangeAuthCode({ base, code, deviceId, http: opts.http })

    // ⚠️ 授权成功之后才提交会话（nasLogin 会让世代号 +1，作废在飞行的续期）。
    await opts.session.nasLogin(base, deviceId)
    opts.session.state.token = token
  }

  const nasReloginHandler = async (): Promise<string> => {
    // 授权码在**窗口返回之后**才有值；失败时要靠它把错误消息里的凭证抹掉。
    let authCode = ''
    try {
      const base = requireMusicBase(opts.session.state.base)
      const clientId = await fetchNasClientId(base, opts.http)

      authCode = await openWindow({
        url: buildAuthorizeUrl({ base, clientId }),
        redirect: redirectUriOf(base),
        silent: true,
        trusted: opts.trusted,
        http: opts.http,
      })

      // 静默续期沿用同一个 device id（它标识的是这台客户端）。
      const existingDeviceId = opts.session.state.deviceId
      const deviceId = existingDeviceId || newDeviceId()

      const token = await exchangeAuthCode({ base, code: authCode, deviceId, http: opts.http })

      // ⚠️ 拿到 token **之后**才写 deviceId：失败时一个字节都不动会话状态
      //    （否则失败会留下一个既没绑定成功、也不回滚的 device id）。
      if (!existingDeviceId) opts.session.state.deviceId = deviceId
      return token
    } catch (err) {
      // 契约：失败返回**空串**，不抛穿（调用方按空串判断）。
      recordReloginFailure(opts.session, err, authCode)
      return ''
    }
  }

  return { nasLoginHandler, nasReloginHandler }
}

/**
 * 记录一次 NAS 静默续期的失败。
 *
 * ⚠️ **失败原因必须透出**：否则 `session.ts` 只能记下通用的
 * 「OAuth 静默续期失败：未取得新 token」，
 * 「fnOS 登录已过期」这类**可操作**信息就既到不了诊断、也到不了用户。
 *
 * 落点两处：
 * - `session.lastReloginError`：主进程的诊断通道（`session.ts` 会**保留**它，
 *   不覆盖成通用文案）；
 * - 一条 `console.warn`：让用户 / 运维在主进程日志里直接看到原因。
 *
 * ⚠️ 原因里**不含**授权 `code`（一次性凭证）与 `userToken`：
 * `authCode` 会被抹掉，其余文案都是本模块自己的固定字符串。
 */
function recordReloginFailure(
  session: SessionManager,
  err: unknown,
  authCode: string,
): void {
  const raw = err instanceof Error ? err.message : '未知错误'
  const reason = redact(raw, authCode)
  session.lastReloginError = new SessionStateError(
    'NO_CREDENTIAL',
    `OAuth 静默续期失败：${reason}`,
  )
  console.warn(`[fnmusic] OAuth 静默续期失败：${reason}`)
}
