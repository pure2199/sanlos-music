// 主进程认证 IPC：渲染进程的登录页通过 `window.fn` → `ipcRenderer.invoke('auth:*')` 调用这里。
//
// ---------------------------------------------------------------------------
// 职责边界
// ---------------------------------------------------------------------------
// - 本模块是**登录链路的主进程侧**：探测服务器、执行登录、维护会话，
//   并把**脱敏**的状态回传给渲染进程。
// - 渲染进程**永远拿不到凭证**：token / 密码只存在于主进程内存与 `session.bin`。
//   本模块的七个处理器**没有任何一个**会把 token 或密码放进返回值或错误消息。
// - 模块顶层**不得 import Electron**（本文件要能在 Vitest / 普通 Node 里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串）。
//   故 Electron 的 `ipcMain` 一律**惰性解析**，并允许通过 `opts.ipcMain` 注入替身。
//
// ---------------------------------------------------------------------------
// 七个 IPC 通道
// ---------------------------------------------------------------------------
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

import { API_PREFIX, CODE_OK } from '../shared/constants'
import type { AuthSessionInfo, CandidateInfo, ServerInfo } from '../shared/bridge'
import type { ConnectionInfo, ConnectionKind } from '../shared/types'
import { buildCandidates, fetchConnectionParams, hostOf, normalizeBase } from './connection'
import { TrustedHosts } from './cert'
import { probeCandidates } from './probe'
import { authx } from './sign'
import { SessionStateError, type SessionManager } from './session'

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

/** NAS 账号（OAuth）登录处理器的入参。 */
export interface NasLoginArgs {
  /** 归一化后的服务器基址（音乐根，如 `https://nas.local:5666/music`）。 */
  server: string
  /** 当前会话的设备 id（新会话时可能是空串）。 */
  deviceId: string
}

/**
 * NAS 账号（OAuth）登录处理器（**接缝**，由 Task 11 注入）。
 *
 * 契约：处理器负责跑完整个授权流程，并让会话进入**已登录**状态
 * （拿到 token、写入 `session.state`）；返回后主进程只负责登记受信 host。
 */
export type NasLoginHandler = (args: NasLoginArgs) => Promise<void>

/** `registerAuthIpc` 的可选参数（全部可注入，便于单测）。 */
export interface AuthIpcOptions {
  /** `ipcMain` 替身；缺省时惰性取 Electron 的 `ipcMain`。 */
  ipcMain?: IpcMainLike
  /** `fetch` 替身；缺省时用全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /** 受信 host 集合；缺省时内部 new 一个（注入共享实例才能让证书放行立刻生效）。 */
  trusted?: TrustedHosts
  /** NAS 账号登录处理器；未注入时 `mode: 'nas'` 抛可读错误。 */
  nasLoginHandler?: NasLoginHandler
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
 */
function redactError(err: unknown, secret: string): unknown {
  if (!secret) return err
  if (err instanceof Error && err.message.includes(secret)) {
    err.message = redactSecret(err.message, secret)
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
 * 是否是**内网**地址段（用于区分「内网直连」与「公网直连」）。
 *
 * 判定规则（控制器裁定）：私有地址段（`10.x` / `172.16–31.x` / `192.168.x` / `127.x`）
 * 或 `.local` 结尾 → 内网；其余 → 公网。
 *
 * 注意：这是**展示用的粗粒度判定**，不是安全判定——
 * 真正的安全性由「只有用户填写的 host 才放行证书」保证。
 */
function isPrivateHost(host: string): boolean {
  if (!host) return false
  if (host.startsWith('10.')) return true
  if (host.startsWith('192.168.')) return true
  if (host.startsWith('127.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (host.endsWith('.local')) return true
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
 */
async function handleServerInfo(arg: unknown, fetchImpl: typeof fetch): Promise<ServerInfo> {
  const base = requireBase(arg)
  const url = `${base}${API_PREFIX}/sys/config`

  let res: Response
  try {
    // 该端点免凭证：只带 authx（服务端当前不校验，但按上游语义发送）。
    res = await fetchImpl(url, { method: 'GET', headers: { authx: authx('GET', url) } })
  } catch (cause) {
    throw new Error('无法连接服务器（网络不可达或服务未响应）', { cause })
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
): Promise<AuthSessionInfo> {
  const args = asRecord(arg)
  const server = readString(args?.['server'])
  const username = readString(args?.['username'])
  const password = readString(args?.['password'])
  const mode = args?.['mode'] === 'nas' ? 'nas' : 'password'
  const base = requireBase(server)

  if (mode === 'nas') {
    if (!nasLoginHandler) {
      throw new Error('尚未安装 NAS 账号登录处理器')
    }
    try {
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
  trusted.add(base)
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
 * `session.load()` 失败（文件不存在 / 损坏 / 解密失败）时返回**未登录**形态，
 * 且**不把错误细节里的原始异常透出**（解密失败的原因留在 `session.lastLoadError`）。
 */
function handleRestore(session: SessionManager): AuthSessionInfo {
  const loaded = session.load()
  if (!loaded) return disconnectedInfo()
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
 * 探测完成后把候选地址的 host 登记进 `trusted`（用户接下来要连的就是它们）。
 */
async function handleProbe(arg: unknown, trusted: TrustedHosts): Promise<CandidateInfo[]> {
  const fnId = readString(arg).trim()
  if (!fnId) throw new Error('缺少 FN ID')

  let params: Awaited<ReturnType<typeof fetchConnectionParams>>
  try {
    params = await fetchConnectionParams(fnId)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : '未知错误'
    throw new Error(`探测失败：无法获取连接信息（${reason}）`)
  }

  const candidates = buildCandidates(fnId, params)
  const results = await probeCandidates(candidates)
  return results.map((result) => {
    trusted.add(result.candidate.address)
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
 */
function handleConnectionInfo(session: SessionManager): ConnectionInfo | null {
  const state = session.state
  if (!state.base) return null

  const isRelay = state.isRelay === true
  const host = hostOf(state.base)
  const kind: ConnectionKind = isRelay ? 'relay' : isPrivateHost(host) ? 'lan' : 'public'
  const label = isRelay ? 'FN 中继' : kind === 'lan' ? '内网直连' : '公网直连'

  const info: ConnectionInfo = { kind, url: state.base, label, isRelay }
  if (isRelay) info.bandwidthHint = '带宽受限'
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

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const trusted = opts.trusted ?? new TrustedHosts()
  const nasLoginHandler = opts.nasLoginHandler

  ipcMain.handle('auth:server-info', (_event, arg) => handleServerInfo(arg, fetchImpl))
  ipcMain.handle('auth:login', (_event, arg) =>
    handleLogin(session, arg, trusted, nasLoginHandler),
  )
  ipcMain.handle('auth:restore', () => handleRestore(session))
  ipcMain.handle('auth:logout', () => handleLogout(session))
  ipcMain.handle('auth:relogin', () => handleRelogin(session))
  ipcMain.handle('auth:probe', (_event, arg) => handleProbe(arg, trusted))
  ipcMain.handle('auth:connection-info', () => handleConnectionInfo(session))
}
