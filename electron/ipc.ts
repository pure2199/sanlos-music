// 主进程 IPC：认证（`auth:*`）+ 播放器 / 窗口 / 偏好（Task 17）。
//
// ---------------------------------------------------------------------------
// 职责边界
// ---------------------------------------------------------------------------
// - **认证部分**（`registerAuthIpc`）：登录链路的主进程侧——探测服务器、执行登录、
//   维护会话，并把**脱敏**的状态回传给渲染进程。
// - **播放器 / 窗口 / 偏好部分**（`registerPlayerIpc`，Task 17）：播放状态同步、
//   窗口控制、偏好读写与主题持久化。
// - 渲染进程**永远拿不到凭证**：token / 密码只存在于主进程内存与 `session.bin`；
//   本文件的处理器**没有任何一个**会把 token 或密码放进返回值、错误消息或偏好文件。
// - 模块顶层**不得 import Electron**（本文件要能在 Vitest / 普通 Node 里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串）。
//   故 Electron 的 `ipcMain` 一律**惰性解析**，并允许通过 `opts.ipcMain` 注入替身。
//
// ---------------------------------------------------------------------------
// IPC 通道（**两个域，别混**）
// ---------------------------------------------------------------------------
// 认证（七个 `auth:*`，Task 10）：
//
// | 通道                  | 入参                          | 出参                       |
// |-----------------------|-------------------------------|----------------------------|
// | `auth:server-info`    | `server: string`              | `ServerInfo`              |
// | `auth:login`          | `{ server, username, password, mode }` | `AuthSessionInfo` |
// | `auth:restore`        | 无                            | `AuthSessionInfo`         |
// | `auth:logout`         | 无                            | `AuthSessionInfo`         |
// | `auth:relogin`        | 无                            | `boolean`                 |
// | `auth:probe`          | `fnId: string`                | `CandidateInfo[]`         |
// | `auth:connection-info`| 无                            | `ConnectionInfo \| null`  |
//
// 播放器 / 窗口 / 偏好（Task 17）：
//
// | 通道                  | 方向              | 机制                 | 入参 → 出参                      |
// |-----------------------|-------------------|----------------------|----------------------------------|
// | `player:state`        | 渲染进程 → 主进程 | `ipcRenderer.send`   | `PlayerStateSnapshot`            |
// | `player:command`      | 渲染进程 → 主进程 | `ipcRenderer.send`   | `PlayerCommand`                  |
// | `player:command`      | 主进程 → 渲染进程 | `webContents.send`   | `PlayerCommand`                  |
// | `win:minimize`        | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → 无                          |
// | `win:toggle-maximize` | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → 无                          |
// | `win:close`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → 无                          |
// | `prefs:get`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → `AppPrefs`                  |
// | `prefs:set`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | `Partial<AppPrefs>` → `AppPrefs` |
// | `theme:set`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | `ThemeName` → `AppPrefs`         |
//
// ⚠️ **主进程是唯一的命令路由**：渲染进程发来的 `player:command`（媒体会话的
//    action handler）会被**转发**回渲染进程执行——渲染进程**只执行**从主进程
//    收到的命令，绝不本地直接执行自己发出的命令，所以不存在「发一次执行两遍」。
//
// ---------------------------------------------------------------------------
// 依赖注入（便于单测）
// ---------------------------------------------------------------------------
// - `ipcMain`：缺省时**调用时**惰性解析 `require('electron').ipcMain`；拿不到就抛可读错误。
// - `fetchImpl`：缺省用全局 `fetch`（只用于 `auth:server-info`；
//   `auth:probe` 走 `fetchConnectionParams` / `probeCandidates`，那两个模块自己用全局 fetch）。
// - `trusted`：缺省时内部 new 一个 `TrustedHosts`；也可注入共享实例，
//   让 `auth:login` / `auth:probe` 登记过的 host 立刻对证书放行生效。
// - `nasLoginHandler`：NAS 账号（OAuth）登录的**接缝**，由 Task 11 注入；
//   未注入时 `mode: 'nas'` 抛「尚未安装 NAS 账号登录处理器」。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { API_PREFIX, CODE_OK, RELAY_DOMAIN_SUFFIX } from '../shared/constants'
import type { AuthSessionInfo, CandidateInfo, ServerInfo } from '../shared/bridge'
import { sanitizeEqPrefsPayload } from '../shared/eqPrefs'
import type {
  AppPrefs,
  CloseBehavior,
  PlayerCommand,
  PlayerStateSnapshot,
  WindowBounds,
} from '../shared/playerBridge'
import type { ConnectionInfo, ConnectionKind, ThemeName } from '../shared/types'
import { buildCandidates, fetchConnectionParams, hostOf, normalizeBase } from './connection'
import { TrustedHosts } from './cert'
import { probeCandidates } from './probe'
import { authx } from './sign'
import { SessionStateError, type SessionManager } from './session'
import { createHttpStack, type HttpStack } from './http'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * `ipcMain` 的最小接口（**依赖注入的接缝**）。
 *
 * 只要求 `handle` 一个方法，便于单测塞一个 `Map` 进来，
 * 也避免本模块依赖 Electron 的完整类型。
 */
export interface IpcMainLike {
  /** 注册一个 IPC 处理器。 */
  handle(channel: string, listener: (event: unknown, arg: unknown) => unknown): void
}

/**
 * NAS 账号（OAuth）登录处理器的入参。
 */
export interface NasLoginArgs {
  /** 归一化后的服务器基址（音乐根，如 `https://nas.local:5666/music`）。 */
  server: string
  /**
   * 当前会话的设备 id。
   *
   * ⚠️ **新会话上通常是空串**（没有可沿用的 device id）——
   * 见 `NasLoginHandler` 的契约：设备 id 由 handler 侧最终确定。
   */
  deviceId: string
}

/**
 * NAS 账号（OAuth）登录处理器（**接缝**，由 Task 11 注入）。
 *
 * ---------------------------------------------------------------------------
 * 契约（Task 11 照此实现；审查 M8 的裁定：**只写清契约，本轮不改逻辑**）
 * ---------------------------------------------------------------------------
 * 处理器负责跑完整个授权流程，并让会话进入**已登录**状态，具体有三条：
 *
 * 1. **置 `state.mode = 'nas'`**：要么调 `session.nasLogin(server, deviceId)`
 *    （Task 7 的语义：它会置好 `mode` / `base` / `deviceId`，
 *    且 `deviceId` 传空串时**自动生成**一个新的随机 device id），
 *    要么直接写 `session.state`。
 * 2. **把拿到的 token 写进 `session.state.token`**（否则会话其实没登录，
 *    `toSessionInfo()` 会把它报成未连接）。
 * 3. **设备 id 由 handler 侧最终确定**：本模块传进来的 `deviceId` 只是
 *    「当前会话已有的 device id」，**新会话上是空串**，不能当成最终值直接用；
 *    沿用旧 id（同一台服务器）还是新生成，交给 handler 判断。
 *
 * ⚠️ **本模块刻意不自己调 `session.nasLogin()`**：Task 7 的 `nasLogin()` 会让世代号 +1
 * （作废在飞行的续期），若在授权**之前**就调用，会把一个还没拿到 token 的半成品会话
 * 提交进状态机。授权成功后再一次性提交（mode / base / deviceId / token）才是对的。
 *
 * 返回后本模块只负责登记受信 host 与落盘。
 */
export type NasLoginHandler = (args: NasLoginArgs) => Promise<void>

/** `registerAuthIpc` 的可选参数（全部可注入，便于单测）。 */
export interface AuthIpcOptions {
  /** `ipcMain` 替身；缺省时惰性取 Electron 的 `ipcMain`。 */
  ipcMain?: IpcMainLike
  /**
   * `fetch` 替身；缺省时用全局 `fetch`。
   *
   * 它是**整个出网通道的回落实现**（`auth:server-info` 与 `auth:probe` 都用它）——
   * 单测里注入它，就等于告诉模块「没有 Electron 栈，用这个替身发请求」。
   */
  fetchImpl?: typeof fetch
  /** 受信 host 集合；缺省时内部 new 一个（注入共享实例才能让证书放行立刻生效）。 */
  trusted?: TrustedHosts
  /** NAS 账号登录处理器；未注入时 `mode: 'nas'` 抛可读错误。 */
  nasLoginHandler?: NasLoginHandler
  /**
   * 出网通道（Task 9b：Chromium 分区栈）。
   *
   * 缺省时自建一个（`fetchImpl` 作为回落）。主进程应当注入**同一个**实例给
   * 会话层 / 代理层 / 认证 IPC——否则各层的信任版本号各走各的，
   * 「信任集合变了 → 换分区」就对不上了。
   */
  http?: HttpStack
}

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
 * 惰性取 Electron 的 `ipcMain`（**不在模块顶层调用**）。
 *
 * 非 Electron 进程（Vitest / 普通 Node）里 `require('electron')` 返回的是可执行文件路径字符串，
 * 取不到任何 API；此时返回 `null`，由调用方给出可读错误。
 */
function resolveIpcMain(): IpcMainLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { ipcMain?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const ipcMain = (mod as { ipcMain?: unknown }).ipcMain
    if (typeof ipcMain !== 'object' || ipcMain === null) return null
    return ipcMain as IpcMainLike
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 合法 FN ID 的形态：字母、数字、`-` 与 `_`（实测形如 `<fnId>`）。
 *
 * ⚠️ 为什么要卡形态（审查 I2）：FN ID 会被拼进**中继域名**（`<fnId>.fnos.net`）
 * 并据此登记进证书信任集合。形态不受控就能拼出别的 host 来——
 * 例如 `a/b` 经 `hostOf()` 解析出的主机名是 `a`（`/` 被当成路径分隔符），
 * 等于让调用方往信任集合里塞任意 host。故这里只接受「不可能带分隔符」的形态。
 */
const FN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

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

/** 取字符串字段（不是字符串就当 `null`）。 */
function readStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 归一化服务器地址；非法时抛可读错误。 */
function requireBase(server: unknown): string {
  const base = normalizeBase(typeof server === 'string' ? server.trim() : '')
  if (!base) throw new Error('服务器地址无效：只支持 http/https 地址')
  return base
}

/**
 * 打码：把口令从错误消息里替换掉。
 *
 * 正常情况下服务端错误消息不含口令，但**不能依赖服务端守规矩**——
 * 密码只应该在这一次 IPC 里经过，绝不能出现在任何错误消息里。
 */
function redactSecret(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('***')
}

/**
 * 把口令从抛出的错误里抹掉（**就地改写**，保留错误类型与业务码）。
 *
 * 就地改而不是新建错误：`SessionApiError` 的 `code` 要留给上层判别。
 *
 * ⚠️ **必须连 `stack` 一起改**（审查 M4）：Electron 会把主进程错误的
 * **message 与 stack 一起**序列化给渲染进程的 `ipcRenderer.invoke` 拒绝值——
 * 只改 `message` 的话，旧口令仍然会出现在 stack 的首行里被送到渲染进程。
 *
 * `cause` 链也一并处理（最多 5 层，与 Task 9 的错误归类同深度）：
 * `cause` 可能是服务端响应体或底层异常的原文，同样不该带出口令。
 */
function redactError(err: unknown, secret: string): unknown {
  if (!secret) return err
  if (!(err instanceof Error)) return err

  if (err.message.includes(secret)) {
    err.message = redactSecret(err.message, secret)
  }
  if (typeof err.stack === 'string' && err.stack.includes(secret)) {
    err.stack = redactSecret(err.stack, secret)
  }

  // cause 链：逐层改写（不新建错误，保留原始类型与业务码）。
  let cursor: unknown = (err as { cause?: unknown }).cause
  for (let depth = 0; depth < 5; depth++) {
    if (!(cursor instanceof Error)) break
    if (cursor.message.includes(secret)) {
      cursor.message = redactSecret(cursor.message, secret)
    }
    if (typeof cursor.stack === 'string' && cursor.stack.includes(secret)) {
      cursor.stack = redactSecret(cursor.stack, secret)
    }
    cursor = (cursor as { cause?: unknown }).cause
  }
  return err
}

/** 服务器展示名：`host[:port]`（不含协议与路径）。 */
function serverLabelOf(base: string): string | null {
  try {
    return new URL(base).host
  } catch {
    return null
  }
}

/**
 * 登记受信 host，并在**信任集合真的变了**时换 Chromium 分区（追加要求 A / B）。
 *
 * 三处登记点（用户填写的 host / 登录成功的 base / FN ID 推导出的中继域名）
 * **全部走这一条路径**，避免某处漏掉「换分区」——
 * 漏掉的后果是：Chromium 按 `host:port` 缓存的证书错误还在，
 * 用户明明放行了却仍然连不上（规格 §15.9 的实测结论：
 * `clearCache()` / `clearHostResolverCache()` 都清不掉，只有换分区才行）。
 *
 * 顺序必须是「登记 → bump epoch → 发起请求」：
 * - **登记**让 verify proc 之后放行这个 host；
 * - **bump** 让下一次请求落到新分区（绕开旧分区缓存的证书错误）。
 *
 * @returns 本次是否**新增**了一个 host（`false` = 已是受信 host，或解析不出 host）。
 */
function trustHost(url: string, trusted: TrustedHosts, http: HttpStack): boolean {
  const changed = trusted.add(url)
  if (changed) {
    // 信任集合真的变了 → 换分区（其余情况不换：换分区会丢掉 Chromium 的连接池）。
    http.bumpTrustEpoch()
  }
  return changed
}

/**
 * 是否是**内网**地址段（用于区分「内网直连」与「公网直连」）。
 *
 * 判定规则（控制器裁定 + 审查 M5 补正）：
 * - IPv4 私有段：`10.x` / `172.16–31.x` / `192.168.x` / `127.x`；
 * - IPv6：`::1`（回环）与 `fc00::/7`（唯一本地地址，含 `fd00::/8`）；
 * - 主机名：`localhost`（含 `*.localhost`）与 `.local` 结尾；
 * - 其余 → 公网。
 *
 * 注意：这是**展示用的粗粒度判定**，不是安全判定——
 * 真正的安全性由「只有用户填写的 host 才放行证书」保证。
 */
function isPrivateHost(host: string): boolean {
  if (!host) return false
  const h = host.toLowerCase()

  // ---- IPv4 ----
  if (h.startsWith('10.')) return true
  if (h.startsWith('192.168.')) return true
  if (h.startsWith('127.')) return true
  // 172.16.0.0/12：172.16 – 172.31（172.15 与 172.32 都在范围外）
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true

  // ---- 主机名 ----
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local')) return true

  // ---- IPv6 ----
  if (h === '::1') return true
  // fc00::/7（唯一本地地址）：首组的高 7 位是 0b1111110，即 (first & 0xfe00) === 0xfc00
  const first = h.split(':')[0] ?? ''
  if (/^[0-9a-f]{1,4}$/.test(first)) {
    const value = Number.parseInt(first, 16)
    if ((value & 0xfe00) === 0xfc00) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 未登录时的统一返回形态。 */
function disconnectedInfo(): AuthSessionInfo {
  return { connected: false, mode: null, username: null, serverLabel: null, isRelay: false }
}

/**
 * 把会话状态压成**脱敏**的 `AuthSessionInfo`。
 *
 * ⚠️ 这里**只**取 `mode` / `username` / `base`（算展示名）/ `isRelay`——
 * **绝不**读 `token` / `password` / `deviceId`，更不把它们放进返回值。
 */
function toSessionInfo(session: SessionManager): AuthSessionInfo {
  const state = session.state
  const connected = state.base.length > 0 && state.token.length > 0
  if (!connected) return disconnectedInfo()
  return {
    connected: true,
    mode: state.mode === 'nas' ? 'nas' : 'password',
    username: state.username.length > 0 ? state.username : null,
    serverLabel: serverLabelOf(state.base),
    isRelay: state.isRelay === true,
  }
}

// ---------------------------------------------------------------------------
// 处理器
// ---------------------------------------------------------------------------

/**
 * `auth:server-info`：读取服务器信息（**免凭证**）。
 *
 * - `GET <base>/api/v1/sys/config`（实测 §15.8：真实路径在音乐 API 前缀下，
 *   `/sys/config` 会得到 404 + HTML）；
 * - 只回 `{ serverName, serverVersion, supportsNasLogin }` 三个字段，
 *   **不把整个 `sys/config` 透出去**；
 * - `supportsNasLogin` = `!!data.nasOAuth?.clientId`（实测 `nasOAuth` 里**没有** `url`）。
 *
 * ⚠️ **追加要求 A**：用户填写的 host 必须在**第一次请求它之前**就登记进信任集合。
 * 本处理器是用户填完地址后的**第一次**请求；若此时才登记，第一次握手就会失败，
 * 而 Chromium 会把这个证书错误按 `host:port` 缓存住——用户后来放行了也连不上
 * （规格 §15.9 的实测：只有换分区才行）。
 */
async function handleServerInfo(
  arg: unknown,
  http: HttpStack,
  trusted: TrustedHosts,
): Promise<ServerInfo> {
  const base = requireBase(arg)
  // 顺序：登记 → bump epoch（集合真的变了才 bump）→ 发起请求。
  trustHost(base, trusted, http)
  const url = `${base}${API_PREFIX}/sys/config`

  let res: Response
  try {
    // 该端点免凭证：只带 authx（服务端当前不校验，但按上游语义发送）。
    res = await http.fetch(url, { method: 'GET', headers: { authx: authx('GET', url) } })
  } catch (cause) {
    throw new Error('无法连接服务器（网络不可达或服务未响应）', { cause })
  }

  // ⚠️ **先判 HTTP 状态码**（审查 M6）：4xx/5xx 的响应体里也可能恰好带着
  // `{"code":0,...}`（反向代理 / 网关的错误页偶尔长这样），
  // 只看 body 会把失败当成功。状态码 >= 400 一律按「服务器响应异常」处理。
  if (typeof res.status === 'number' && res.status >= 400) {
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }

  const text = await res.text().catch(() => '')
  let json: unknown = null
  try {
    json = text.length > 0 ? (JSON.parse(text) as unknown) : null
  } catch {
    json = null
  }
  const envelope = asRecord(json)
  if (!envelope) {
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }

  const code = typeof envelope['code'] === 'number' ? envelope['code'] : -1
  if (code !== CODE_OK) {
    const msg = readString(envelope['msg'])
    throw new Error(
      `读取服务器信息失败：${msg.length > 0 ? msg : '服务端拒绝请求'}（code=${code}）`,
    )
  }

  const data = asRecord(envelope['data'])
  const nasOAuth = asRecord(data?.['nasOAuth'])
  const clientId = readString(nasOAuth?.['clientId'])
  return {
    serverName: readStringOrNull(data?.['serverName']),
    serverVersion: readStringOrNull(data?.['serverVersion']),
    supportsNasLogin: clientId.length > 0,
  }
}

/**
 * `auth:login`：执行登录。
 *
 * - `mode === 'password'`：`session.passwordLogin(base, username, password)` → `session.save()`；
 * - `mode === 'nas'`：走 `opts.nasLoginHandler`（Task 11 注入的 OAuth 流程）；
 *   未注入时抛「尚未安装 NAS 账号登录处理器」。
 *
 * 成功后把该服务器 host 登记进 `trusted`（证书放行只对**用户填过**的 host 生效）。
 *
 * ⚠️ **口令只在这一趟 IPC 里经过**：进主进程后交给 `passwordLogin`（内部会 sha256），
 * 之后**不进日志、不进错误消息、不进任何返回值**。
 */
async function handleLogin(
  session: SessionManager,
  arg: unknown,
  trusted: TrustedHosts,
  nasLoginHandler: NasLoginHandler | undefined,
  http: HttpStack,
): Promise<AuthSessionInfo> {
  const args = asRecord(arg)
  const server = readString(args?.['server'])
  const username = readString(args?.['username'])
  const password = readString(args?.['password'])
  const mode = args?.['mode'] === 'nas' ? 'nas' : 'password'
  const base = requireBase(server)

  // ⚠️ 追加要求 A：登录请求本身也打在这个 host 上 → **请求之前**就登记 + 换分区。
  //    （用户显式输入即显式信任；登记失败不影响登录本身。）
  trustHost(base, trusted, http)

  if (mode === 'nas') {
    if (!nasLoginHandler) {
      throw new Error('尚未安装 NAS 账号登录处理器')
    }
    try {
      // ⚠️ 契约见 `NasLoginHandler`：handler 负责把 `state.mode` 置成 `'nas'`、
      // 把 token 写进 `state`，并确定最终 device id；本模块**不**代它调
      // `session.nasLogin()`（那会在授权成功前就提交半成品会话）。
      await nasLoginHandler({ server: base, deviceId: session.state.deviceId })
    } catch (err) {
      throw redactError(err, password)
    }
  } else {
    try {
      await session.passwordLogin(base, username, password)
    } catch (err) {
      throw redactError(err, password)
    }
  }

  persistSession(session)
  return toSessionInfo(session)
}

/**
 * 落盘会话（**失败不阻断登录**）。
 *
 * 会话在内存里已经生效（登录/续期都成功），落盘失败只意味着「下次启动要重新登录」——
 * 与 Task 7 的续期落盘失败同理，**不能**因此把一次成功的登录报成失败。
 * 失败原因记在 `session.lastSaveError` 供上层诊断。
 */
function persistSession(session: SessionManager): void {
  try {
    session.save()
  } catch (err) {
    session.lastSaveError =
      err instanceof SessionStateError
        ? err
        : new SessionStateError('SAVE_FAILED', '会话保存失败：无法写入会话文件', { cause: err })
  }
}

/**
 * `auth:restore`：恢复上次会话。
 *
 * ⚠️ **`load()` 失败不等于「没登录」**（审查 M3 修正）：
 * `load()` 失败可能是「文件不存在」（真的没登录）、也可能是「文件损坏 / 解密失败」——
 * 后者发生时**内存里的会话可能仍然有效**（例如 NAS 模式会话尚未落盘、
 * 或上一次落盘失败但内存已生效）。此时若一律返回「未登录」，
 * 界面会显示未登录，而 `fnm://` 代理其实仍带着有效 token 工作——两边对不上。
 *
 * 故：`load()` 失败**且**内存里没有 token 时才返回未登录形态；
 * 内存里还有 token 时回落到 `toSessionInfo(session)`（按内存状态如实上报）。
 *
 * 另外**不把错误细节里的原始异常透出**（解密失败的原因留在 `session.lastLoadError`）。
 *
 * ⚠️ 附带说明（本轮不改）：`load()` 会让会话的世代号 +1（`electron/session.ts`），
 * 于是**每次调 `restore()` 都会作废在飞行的续期**——这是 Task 7 的既有语义，
 * 调用方（Task 10b 的登录页）应尽量少调 `restore()`。
 */
function handleRestore(session: SessionManager): AuthSessionInfo {
  const loaded = session.load()
  if (!loaded && !session.state.token) return disconnectedInfo()
  return toSessionInfo(session)
}

/**
 * `auth:logout`：登出。
 *
 * 尽力通知服务端（`user/logout`），**失败不阻断**本地清理——
 * 服务端不可达时用户也必须能登出。
 */
async function handleLogout(session: SessionManager): Promise<AuthSessionInfo> {
  try {
    await session.request('user/logout')
  } catch {
    // 尽力而为：服务端登出失败不影响本地清理。
  }
  session.clear()
  return toSessionInfo(session)
}

/** `auth:relogin`：静默续期（成功返回 `true`）。 */
async function handleRelogin(session: SessionManager): Promise<boolean> {
  return session.relogin()
}

/**
 * `auth:probe`：用 FN ID 探测候选链路。
 *
 * `fetchConnectionParams(fnId)` → `buildCandidates(fnId, params)` → `probeCandidates(candidates)`。
 *
 * ⚠️ **只把 FN ID 发给 FN 连接接口**（`5ddd.com/api/v1/fn/con`），
 * **绝不**发送账号口令。探测请求本身也不带 token。
 *
 * ---------------------------------------------------------------------------
 * 证书信任登记范围（审查 I2 修正：**收紧**）
 * ---------------------------------------------------------------------------
 * 候选地址来自 `fn/con` 的响应（内网 IP、公网 IPv4/IPv6、中继域名），
 * **不是用户填写过的地址**。早先的实现把**所有**候选批量登记进 `trusted`，
 * 后果是：用户从未填过的 host 拿到了证书豁免，**探测失败**的候选也一样，
 * 而能控制 `fn/con` 响应的一方就能把任意 host 塞进应用的证书信任集合。
 *
 * 现在只登记**由用户自己提供的 FN ID 推导出的**中继域名 `<fnId>.fnos.net`：
 * - (a) 用户提交的 host → 由 `auth:login` 登记（登录成功后登记 `base` 的 host）；
 * - (b) `<fnId>.fnos.net` → 由本函数登记（**用户自己的 FN ID**，不是候选地址）；
 * - (c) 用户最终选中并登录成功的那个候选 → 同样由 `auth:login` 覆盖。
 *
 * 其余候选（内网 IP、公网 IP、接口返回的 `fn[]` 域名）**一个都不登记**。
 */
async function handleProbe(
  arg: unknown,
  trusted: TrustedHosts,
  http: HttpStack,
): Promise<CandidateInfo[]> {
  const fnId = readString(arg).trim()
  if (!fnId) throw new Error('缺少 FN ID')
  // FN ID 只能是字母数字与 `-` / `_`：它会被拼进域名（`<fnId>.fnos.net`），
  // 形态不受控就可能拼出别的 host 来（例：`a/b` → 解析出的 host 是 `a`）。
  if (!FN_ID_RE.test(fnId)) {
    throw new Error('FN ID 格式无效：只允许字母、数字、- 与 _')
  }

  let params: Awaited<ReturnType<typeof fetchConnectionParams>>
  try {
    params = await fetchConnectionParams(fnId)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : '未知错误'
    throw new Error(`探测失败：无法获取连接信息（${reason}）`)
  }

  const candidates = buildCandidates(fnId, params)
  const results = await probeCandidates(candidates, { http })

  // (b) 只登记「用户自己的 FN ID 推导出的中继域名」。
  const relayHost = `${fnId}${RELAY_DOMAIN_SUFFIX}`
  if (hostOf(relayHost) === relayHost.toLowerCase()) {
    trustHost(relayHost, trusted, http)
  }

  return results.map((result) => {
    const info: CandidateInfo = {
      address: result.candidate.address,
      label: result.candidate.label,
      kind: result.candidate.kind,
      isRelay: result.candidate.isRelay,
      ok: result.ok,
    }
    if (result.error !== undefined) info.error = result.error
    return info
  })
}

/**
 * `auth:connection-info`：当前链路信息；没有会话时返回 `null`。
 *
 * - `kind`：`isRelay` 为真 → `'relay'`；否则按 host 判定内网 / 公网；
 * - `url`：`state.base`（音乐根，**不含**任何凭证——`normalizeBase` 已丢弃 userinfo）；
 * - `label`：中继「FN 中继」/ 内网「内网直连」/ 公网「公网直连」。
 * - `bandwidthHint`：**仅中继链路有值**——完整的带宽提示文案（实测中继约 0.5–4 Mbps，
 *   无损与下载建议在局域网内进行）。这里给**完整**文案而不是「带宽受限」四个字，
 *   是为了让渲染进程不需要自己拼装文案（渲染进程的兜底文案只在主进程没给值时才用）。
 */
function handleConnectionInfo(session: SessionManager): ConnectionInfo | null {
  const state = session.state
  if (!state.base) return null

  const isRelay = state.isRelay === true
  const host = hostOf(state.base)
  const kind: ConnectionKind = isRelay ? 'relay' : isPrivateHost(host) ? 'lan' : 'public'
  const label = isRelay ? 'FN 中继' : kind === 'lan' ? '内网直连' : '公网直连'

  const info: ConnectionInfo = { kind, url: state.base, label, isRelay }
  if (isRelay) {
    info.bandwidthHint = '中继带宽受限（约 0.5–4 Mbps），无损与下载建议在局域网内进行'
  }
  return info
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册七个 `auth:*` 处理器。
 *
 * - `opts.ipcMain` 缺省时**惰性**取 Electron 的 `ipcMain`；取不到就抛可读错误
 *   （不静默注册一半——半个认证链路比报错更难查）。
 * - `opts.trusted` 缺省时内部 new 一个 `TrustedHosts`；要让证书放行生效，
 *   主进程应当注入**同一个**实例（见 `electron/main.ts`）。
 */
export function registerAuthIpc(session: SessionManager, opts: AuthIpcOptions = {}): void {
  const ipcMain = opts.ipcMain ?? resolveIpcMain()
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('无法注册认证 IPC：当前进程没有可用的 ipcMain（缺少 Electron 运行时）')
  }

  const trusted = opts.trusted ?? new TrustedHosts()
  const nasLoginHandler = opts.nasLoginHandler
  // 出网通道：注入优先；没注入就自建一个（`fetchImpl` 作为回落实现）。
  // ⚠️ 会话层 / 代理层 / 本模块必须共用**同一个**实例（信任版本号才能对上）。
  const http = opts.http ?? createHttpStack({ trusted, fetchImpl: opts.fetchImpl })

  ipcMain.handle('auth:server-info', (_event, arg) => handleServerInfo(arg, http, trusted))
  ipcMain.handle('auth:login', (_event, arg) =>
    handleLogin(session, arg, trusted, nasLoginHandler, http),
  )
  ipcMain.handle('auth:restore', () => handleRestore(session))
  ipcMain.handle('auth:logout', () => handleLogout(session))
  ipcMain.handle('auth:relogin', () => handleRelogin(session))
  ipcMain.handle('auth:probe', (_event, arg) => handleProbe(arg, trusted, http))
  ipcMain.handle('auth:connection-info', () => handleConnectionInfo(session))
}

// ===========================================================================
// Task 17：偏好（`<userData>/prefs.json`）+ 播放器 / 窗口 IPC
// ===========================================================================

// ---------------------------------------------------------------------------
// 偏好文件
// ---------------------------------------------------------------------------

/** 偏好文件名（落在 `app.getPath('userData')` 下）。 */
const PREFS_FILE_NAME = 'prefs.json'

/** 偏好文件的结构版本号（便于将来迁移格式）。 */
const PREFS_FORMAT_VERSION = 1

/** `PrefsStore` 的可选参数。 */
export interface PrefsStoreOptions {
  /** 偏好文件路径；缺省时惰性取 `<userData>/prefs.json`。 */
  filePath?: string
}

/**
 * 偏好存储（`<userData>/prefs.json`）。
 *
 * ---------------------------------------------------------------------------
 * 安全边界（不可放宽）
 * ---------------------------------------------------------------------------
 * 1. **偏好文件里绝不能出现凭证**（token / 密码 / deviceId）——
 *    那是 `session.bin`（DPAPI 加密）的职责，两者**不许混**。
 *    本类用**白名单**实现这一点：`write()` 只接受 `theme` / `closeBehavior` /
 *    `windowBounds` 三个键，其余键**一律丢弃**——渲染进程就算塞进来也写不进去。
 * 2. 写盘**原子化**：先写 `<file>.tmp` 再 `rename` 覆盖，
 *    避免写到一半崩溃留下截断的偏好文件。
 * 3. 读盘**容错**：文件不存在 / 内容损坏 → 返回默认值，**不抛异常**
 *    （偏好丢了不该让应用起不来）。
 */
export class PrefsStore {
  private readonly options: PrefsStoreOptions
  /** 解析出来的文件路径（缓存，避免每次读写都问一遍 Electron）。 */
  private resolvedPath: string | null

  constructor(opts: PrefsStoreOptions = {}) {
    this.options = opts
    this.resolvedPath = opts.filePath ?? null
  }

  /**
   * 偏好文件路径。
   *
   * 拿不到（没有 Electron 运行时且没注入 `filePath`）时抛可读错误——
   * **不静默把偏好写到别处**（与 `SessionManager` 同一纪律）。
   */
  private resolveFilePath(): string {
    if (this.resolvedPath) return this.resolvedPath
    const dir = resolveUserDataDir()
    if (!dir) {
      throw new Error('偏好文件路径不可用：当前进程没有 Electron 运行时，且未注入 filePath')
    }
    this.resolvedPath = join(dir, PREFS_FILE_NAME)
    return this.resolvedPath
  }

  /**
   * 读偏好。
   *
   * 文件不存在 / 内容损坏 → 返回**默认偏好**（不抛异常）。
   */
  read(): AppPrefs {
    let raw: string
    try {
      raw = readFileSync(this.resolveFilePath(), 'utf8')
    } catch {
      // 文件不存在 = 正常的「还没设置过偏好」。
      return defaultPrefs()
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      return sanitizePrefs(parsed)
    } catch {
      // 损坏的偏好文件 → 当作没有偏好。
      return defaultPrefs()
    }
  }

  /**
   * 合并写入偏好（**只接受白名单键**），返回落盘后的完整偏好。
   *
   * ⚠️ 未知键**一律丢弃**——这是「偏好文件里绝不能出现凭证」的实现方式：
   *    即使渲染进程传了 `{ token: '…' }`，也不会被写进文件。
   */
  write(patch: Partial<AppPrefs>): AppPrefs {
    const current = this.read()
    const incoming = sanitizePatch(patch)
    const merged: AppPrefs = { ...current, ...incoming }
    this.persist(merged)
    return merged
  }

  /** 把偏好原子地写到磁盘。 */
  private persist(prefs: AppPrefs): void {
    const filePath = this.resolveFilePath()
    const payload = JSON.stringify(
      { version: PREFS_FORMAT_VERSION, prefs },
      null,
      2,
    )
    const tmpPath = `${filePath}.tmp`
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(tmpPath, payload, 'utf8')
      renameSync(tmpPath, filePath)
    } catch (cause) {
      // 半成品临时文件不能留下（否则下次启动会把它当成偏好文件）。
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // 清理失败不掩盖原始错误。
      }
      throw new Error('偏好保存失败：无法写入偏好文件', { cause })
    }
  }
}

/** 默认偏好（空）。 */
function defaultPrefs(): AppPrefs {
  return {}
}

/** 合法的主题名。 */
const THEME_NAMES: readonly ThemeName[] = ['apple', 'fluent']

/** 合法的「关闭窗口」行为。 */
const CLOSE_BEHAVIORS: readonly CloseBehavior[] = ['hide', 'quit']

/** 取数字（非有限值 / 非数字 → `undefined`）。 */
function readNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把任意输入压成**合法的偏好补丁**（白名单）。
 *
 * 不认识的键**一律丢弃**——偏好文件里绝不允许出现凭证。
 */
function sanitizePatch(patch: unknown): Partial<AppPrefs> {
  const record = asRecord(patch)
  if (!record) return {}
  const out: Partial<AppPrefs> = {}

  const theme = record['theme']
  if (typeof theme === 'string' && (THEME_NAMES as readonly string[]).includes(theme)) {
    out.theme = theme as ThemeName
  }

  const closeBehavior = record['closeBehavior']
  if (
    typeof closeBehavior === 'string' &&
    (CLOSE_BEHAVIORS as readonly string[]).includes(closeBehavior)
  ) {
    out.closeBehavior = closeBehavior as CloseBehavior
  }

  const bounds = asRecord(record['windowBounds'])
  if (bounds) {
    const width = readNumberOrUndefined(bounds['width'])
    const height = readNumberOrUndefined(bounds['height'])
    if (width !== undefined && height !== undefined && width > 0 && height > 0) {
      const x = readNumberOrUndefined(bounds['x'])
      const y = readNumberOrUndefined(bounds['y'])
      const sanitized: WindowBounds = { width: Math.floor(width), height: Math.floor(height) }
      if (x !== undefined) sanitized.x = Math.floor(x)
      if (y !== undefined) sanitized.y = Math.floor(y)
      out.windowBounds = sanitized
    }
  }

  // EQ 偏好（Task 5）：**形状不对就整段丢弃**（不写半截进文件）。
  // ⚠️ 这里只做**浅**校验；深度校验（增益钳制等）在渲染进程的 `normalizeEqPrefs`。
  if (record['eq'] !== undefined) {
    const eq = sanitizeEqPrefsPayload(record['eq'])
    if (eq) out.eq = eq
  }

  return out
}

/** 把磁盘上的内容压成合法偏好（读盘时的同一套白名单）。 */
function sanitizePrefs(value: unknown): AppPrefs {
  return sanitizePatch(asRecord(value)?.['prefs'] ?? value)
}

// ---------------------------------------------------------------------------
// 播放器 / 窗口 IPC
// ---------------------------------------------------------------------------

/**
 * `ipcMain` 的最小接口（**含 `on`**）。
 *
 * 播放状态与播放命令是**推送**（`ipcRenderer.send`），不是调用（`invoke`），
 * 所以还需要 `on`。
 */
export interface IpcMainEventsLike extends IpcMainLike {
  /** 注册一个推送通道的监听器。 */
  on(channel: string, listener: (event: unknown, arg: unknown) => void): void
}

/** 主进程 → 渲染进程：命令下发的目标（`webContents` 的最小子集）。 */
export interface CommandTargetLike {
  /** 向渲染进程发送一条消息。 */
  send(channel: string, payload: unknown): void
}

/** 主窗口的最小接口。 */
export interface WindowLike {
  /** 最小化。 */
  minimize(): void
  /** 最大化。 */
  maximize(): void
  /** 取消最大化。 */
  unmaximize(): void
  /** 当前是否最大化。 */
  isMaximized(): boolean
  /** 隐藏窗口（播放继续）。 */
  hide(): void
  /** 关闭窗口（会触发窗口自己的 `close` 事件）。 */
  close(): void
  /** 窗口是否已销毁。 */
  isDestroyed?(): boolean
}

/** `registerPlayerIpc` 的参数（全部可注入，便于单测）。 */
export interface PlayerIpcOptions {
  /** `ipcMain` 替身；缺省时惰性取 Electron 的 `ipcMain`（必须带 `on`）。 */
  ipcMain?: IpcMainEventsLike
  /** 偏好存储（`<userData>/prefs.json`）。 */
  prefs: PrefsStore
  /** 主进程 → 渲染进程的下发目标（`webContents`）。 */
  getTarget?: () => CommandTargetLike | null
  /** 主窗口。 */
  getWindow?: () => WindowLike | null
  /** 渲染进程推来播放器状态时的回调（主进程用它更新托盘）。 */
  onPlayerState?: (state: PlayerStateSnapshot) => void
  /**
   * 主题变更后的回调（Task 6）。
   *
   * ⚠️ 只在 `theme:set` **落盘成功之后**才调用——
   *    主进程据此把窗口底色换成新主题的表面色（避免启动/切主题瞬间的白闪）。
   */
  onTheme?: (theme: ThemeName) => void
  /** 「关闭窗口」请求（默认只是隐藏；由主进程决定隐藏还是退出）。 */
  requestClose?: () => void
}

/**
 * 注册播放器 / 窗口 / 偏好 IPC（Task 17）。
 *
 * 通道：
 * - `player:state`（`on`，渲染进程 → 主进程）：更新托盘；
 * - `player:command`（`on`，渲染进程 → 主进程）：**转发**回渲染进程执行
 *   （主进程是唯一的命令路由）；
 * - `player:command`（`webContents.send`，主进程 → 渲染进程）：托盘菜单点击时下发；
 * - `win:minimize` / `win:toggle-maximize` / `win:close`（`handle`）；
 * - `prefs:get` / `prefs:set` / `theme:set`（`handle`）。
 */
export function registerPlayerIpc(opts: PlayerIpcOptions): void {
  const ipcMain = opts.ipcMain ?? resolveIpcMainEvents()
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new Error(
      '无法注册播放器 IPC：当前进程没有可用的 ipcMain（缺少 Electron 运行时，或替身没有 on）',
    )
  }

  const prefs = opts.prefs

  // 渲染进程 → 主进程：播放器状态（推给托盘）。
  ipcMain.on('player:state', (_event, arg) => {
    const snapshot = sanitizeSnapshot(arg)
    if (!snapshot) return
    opts.onPlayerState?.(snapshot)
  })

  // 渲染进程 → 主进程：播放命令 → **转发**回渲染进程执行。
  ipcMain.on('player:command', (_event, arg) => {
    const command = sanitizeCommand(arg)
    if (!command) return
    opts.getTarget?.()?.send('player:command', command)
  })

  // 窗口控制。
  ipcMain.handle('win:minimize', () => {
    const win = opts.getWindow?.()
    if (!win || win.isDestroyed?.()) return
    win.minimize()
  })
  ipcMain.handle('win:toggle-maximize', () => {
    const win = opts.getWindow?.()
    if (!win || win.isDestroyed?.()) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('win:close', () => {
    if (opts.requestClose) {
      opts.requestClose()
      return
    }
    const win = opts.getWindow?.()
    if (!win || win.isDestroyed?.()) return
    win.hide()
  })

  // 偏好。
  ipcMain.handle('prefs:get', () => prefs.read())
  ipcMain.handle('prefs:set', (_event, arg) => prefs.write(asRecord(arg) ?? {}))
  ipcMain.handle('theme:set', async (_event, arg) => {
    const theme = readString(arg)
    if (!(THEME_NAMES as readonly string[]).includes(theme)) {
      throw new Error('主题名无效：只支持 apple / fluent')
    }
    const written = prefs.write({ theme: theme as ThemeName })
    // ⚠️ 只在**落盘成功之后**通知主进程改窗口底色。
    opts.onTheme?.(written.theme ?? (theme as ThemeName))
    return written
  })
}

/** 把渲染进程推来的状态压成合法快照。 */
function sanitizeSnapshot(value: unknown): PlayerStateSnapshot | null {
  const record = asRecord(value)
  if (!record) return null

  const currentRaw = asRecord(record['current'])
  const current = currentRaw
    ? {
        id: readString(currentRaw['id']),
        title: readString(currentRaw['title']),
        artist: readString(currentRaw['artist']),
        album: readString(currentRaw['album']),
        coverId: readString(currentRaw['coverId']),
        duration: readNumberOrUndefined(currentRaw['duration']) ?? 0,
      }
    : null

  const mode = record['mode']
  const modeText = readString(mode)
  const safeMode: PlayerStateSnapshot['mode'] =
    modeText === 'shuffle' || modeText === 'loop-one' || modeText === 'loop-list'
      ? modeText
      : 'sequence'

  return {
    current,
    isPlaying: record['isPlaying'] === true,
    position: readNumberOrUndefined(record['position']) ?? 0,
    duration: readNumberOrUndefined(record['duration']) ?? 0,
    volume: readNumberOrUndefined(record['volume']) ?? 0,
    mode: safeMode,
    muted: record['muted'] === true,
  }
}

/** 把渲染进程发来的命令压成合法命令。 */
function sanitizeCommand(value: unknown): PlayerCommand | null {
  const record = asRecord(value)
  if (!record) return null
  switch (readString(record['type'])) {
    case 'play':
      return { type: 'play' }
    case 'pause':
      return { type: 'pause' }
    case 'toggle':
      return { type: 'toggle' }
    case 'next':
      return { type: 'next' }
    case 'prev':
      return { type: 'prev' }
    case 'seek': {
      const seconds = readNumberOrUndefined(record['seconds'])
      if (seconds === undefined) return null
      return { type: 'seek', seconds: Math.max(0, seconds) }
    }
    default:
      return null
  }
}

/**
 * 惰性取带 `on` 的 Electron `ipcMain`（**不在模块顶层调用**）。
 *
 * 与 `resolveIpcMain()` 的区别：这里要求 `ipcMain.on` 存在
 * （播放状态 / 播放命令是推送通道）。
 */
function resolveIpcMainEvents(): IpcMainEventsLike | null {
  const base = resolveIpcMain()
  if (!base) return null
  const mod = base as unknown as { on?: unknown }
  if (typeof mod.on !== 'function') return null
  return base as IpcMainEventsLike
}

/**
 * 惰性取 `app.getPath('userData')`（**不在模块顶层调用**）。
 *
 * 非 Electron 进程里返回 `null`，由调用方给出可读错误。
 */
function resolveUserDataDir(): string | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { app?: { getPath?: (name: string) => string } } | string
    if (typeof mod !== 'object' || mod === null) return null
    const app = mod.app
    if (!app || typeof app.getPath !== 'function') return null
    const dir = app.getPath('userData')
    return typeof dir === 'string' && dir.length > 0 ? dir : null
  } catch {
    return null
  }
}
