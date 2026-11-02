// `fnm://` 协议代理：渲染进程唯一的出网出口。
//
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）
// ---------------------------------------------------------------------------
// 1. **渲染进程永远拿不到凭证**：渲染进程只发 `fnm://srv/<相对路径>`，本模块在**主进程**里
//    补上 `authx` 签名与 `Cookie: music-token=…`（中继链路再追加 `mode=relay`），
//    token 只存在于主进程内存（Task 7 的 `SessionManager`）里。
// 2. **渲染进程不能指定目标主机**：上游地址**只**来自 `session.state.base`，
//    请求里任何来自渲染进程的主机 / 端口 / userinfo 一律不参与拼接。
// 3. **渲染进程不能逃出 API 前缀**：请求路径只允许「若干个普通 ASCII 段」，
//    `..`、空段、反斜杠、百分号编码、非 ASCII 全部拒绝（渲染进程只能访问
//    `<base>/api/v1/<rest>`，不能打到音乐服务的其它端点）。
// 4. **不向渲染进程泄露内部细节**：上游异常一律转成 502 + `{ code: -1, msg }`，
//    响应体 / 错误消息里不含 token、密码、堆栈。
//
// ---------------------------------------------------------------------------
// 两条路径（控制器裁定）
// ---------------------------------------------------------------------------
// - **JSON 路径（默认）**：交给 `SessionManager.request()`——复用 Task 7 的
//   `99999` 静默续期重试、正确的 `authx` 与 Cookie 拼接，代理不重复实现一遍。
// - **二进制 / 流式路径**（`track/stream` 音频、`static/cover` 封面）：
//   用 `buildUpstreamRequest()` 构造上游请求后 `fetch`，把上游 body **流式**返回
//   （不整块读进内存），并透传 `Range` 与上游状态码（`206` 必须原样保留，
//   否则中继链路下无法拖动定位）。
//
// ---------------------------------------------------------------------------
// 两条注册阶段（Electron 的硬性约束）
// ---------------------------------------------------------------------------
// - `protocol.registerSchemesAsPrivileged()` **只能在 app ready 之前调用**；
// - `protocol.handle()` **必须在 ready 之后调用**。
//
// 故导出 `registerFnmSchemePrivileges()`：**主进程必须在 `app.whenReady()` 之前调用它**
// （Task 9 的主进程入口会这么做）。`registerProxy()` 内部会**防御性地**再调一次
// （ready 之后调用会抛错，包在 try/catch 里忽略）。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串。
//   故 Electron 相关对象一律**惰性解析**（`resolveElectronProtocol()`），
//   并允许通过 `opts.protocol` 注入替身。
// - 不引入新依赖；只用 Node 内置模块与标准 Web API。

import { API_PREFIX } from '../shared/constants'
import { authx, buildCookie } from './sign'
import { SessionStateError, type SessionManager } from './session'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 协议 scheme 名（与渲染进程 `src/api/client.ts` 的 `fnm://srv` 前缀一致）。 */
const SCHEME = 'fnm'

/** 唯一允许的虚拟主机名：渲染进程只能用 `srv`（**不接受任何真实主机名**）。 */
const ALLOWED_HOST = 'srv'

/**
 * 默认的二进制（流式）路径白名单。
 *
 * 判定依据是「相对 API 基址的路径」（与 `SessionManager.request(path)` 的 `path` 同语义，
 * 不含 `/music/api/v1`）。`registerProxy` 的 `opts.binaryPaths` 可覆盖它。
 */
export const DEFAULT_BINARY_PATHS: readonly string[] = ['track/stream', 'static/cover']

/**
 * 允许透传到上游的**请求头**白名单。
 *
 * 其余请求头一律丢弃——尤其是 `cookie` / `authorization`：
 * 凭证只由主进程注入，渲染进程带来的同名头绝不能影响上游看到的身份。
 */
const FORWARD_REQUEST_HEADERS: readonly string[] = [
  'range',
  'content-type',
  'accept',
  'if-none-match',
  'if-modified-since',
]

/**
 * 二进制响应允许透传的**上游响应头**白名单。
 *
 * 只带这几个就够了：状态码、`content-type` / `content-length` /
 * `accept-ranges` / `content-range`（`206` 分段播放靠后两个）。
 */
const FORWARD_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'accept-ranges',
  'content-range',
]

/**
 * 单个路径段的合法形态：ASCII 字母数字与 `-_`。
 *
 * 刻意**不含** `.`（挡掉 `..`）、`/`（挡掉分隔符注入）、`%`（挡掉百分号编码）、
 * 任何非 ASCII 字符（挡掉各类同形字与编码绕过）。
 */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/

/** 不允许携带响应体的状态码（`Response` 构造器会拒绝）。 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

/** 跨源放行头：渲染进程页面来自 `file://` / dev server，与 `fnm://` 跨源。 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, range, accept, if-none-match, if-modified-since',
  'access-control-max-age': '600',
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** scheme 特权（与 Electron 的 `Privileges` 同形）。 */
export interface ProtocolPrivileges {
  standard?: boolean
  secure?: boolean
  bypassCSP?: boolean
  supportFetchAPI?: boolean
  corsEnabled?: boolean
  stream?: boolean
  allowServiceWorkers?: boolean
  spellcheck?: boolean
}

/** 一条 scheme 注册项。 */
export interface ProtocolSchemeRegistration {
  scheme: string
  privileges: ProtocolPrivileges
}

/**
 * Electron `protocol` 模块的最小接口（**依赖注入的接缝**）。
 *
 * 只要求 `handle` 与 `registerSchemesAsPrivileged` 两个方法，便于单测注入替身，
 * 也避免本模块依赖 Electron 的完整类型。
 */
export interface ProtocolLike {
  /** 注册协议处理器（必须在 app ready 之后调用）。 */
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void
  /** 注册 scheme 特权（**只能在 app ready 之前调用**）。 */
  registerSchemesAsPrivileged(schemes: ProtocolSchemeRegistration[]): void
}

/** `registerProxy` 的可选参数。 */
export interface ProxyOptions {
  /**
   * 中继判定的**覆盖钩子**：实际取值为 `opts.isRelay?.() ?? session.state.isRelay`。
   *
   * 供 Task 9 在「已探测出链路是中继」时覆盖会话里的推断值。
   */
  isRelay?: () => boolean
  /** `protocol` 替身；缺省时惰性取 Electron 的 `protocol`。 */
  protocol?: ProtocolLike
  /** 二进制（流式）路径白名单；缺省为 `DEFAULT_BINARY_PATHS`。 */
  binaryPaths?: readonly string[]
}

/** 上游请求的构造入参。 */
export interface UpstreamRequestInput {
  /** HTTP 方法。 */
  method: string
  /** 上游完整 URL（**只**由 `session.state.base` 拼出）。 */
  url: string
  /** 渲染进程带来的请求头（只按白名单透传）。 */
  headers: Headers
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
 * 惰性取 Electron 的 `protocol` 模块（**不在模块顶层调用**）。
 *
 * 非 Electron 进程（Vitest / 普通 Node）里 `require('electron')` 返回的是可执行文件路径字符串，
 * 取不到任何 API；此时返回 `null`，由调用方退回注入的替身。
 */
function resolveElectronProtocol(): ProtocolLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { protocol?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const protocol = (mod as { protocol?: unknown }).protocol
    if (typeof protocol !== 'object' || protocol === null) return null
    return protocol as ProtocolLike
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 上游请求构造
// ---------------------------------------------------------------------------

/**
 * 构造发往上游的请求：**只加头，不发请求**（请求由调用方 `fetch` 发出）。
 *
 * - 附加 `authx` 签名（签名路径取完整 URL 的 pathname，与 Task 3 语义一致）；
 * - 附加凭证 Cookie（`music-token=<token>`，中继链路再追加 `mode=relay`）；
 * - 请求头**只透传白名单**（`range` / `content-type` / `accept` /
 *   `if-none-match` / `if-modified-since`），其余一律丢弃——
 *   渲染进程带来的 `cookie` / `authorization` 绝不会影响上游看到的身份。
 */
export function buildUpstreamRequest(
  input: UpstreamRequestInput,
  token: string,
  isRelay: boolean,
): Request {
  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = input.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('authx', authx(input.method, input.url))
  headers.set('cookie', buildCookie(token, isRelay))
  return new Request(input.url, { method: input.method.toUpperCase(), headers })
}

// ---------------------------------------------------------------------------
// 路径解析与护栏
// ---------------------------------------------------------------------------

/** 解析结果：`rest` 为 `null` 表示路径非法。 */
interface ParsedTarget {
  /** 虚拟主机名（小写）。 */
  host: string
  /** 相对 API 基址的路径（不含前导斜杠）；非法时为 `null`。 */
  rest: string | null
  /** 原始查询串（不含 `?`），可能为空串。 */
  query: string
}

/**
 * 校验路径：只允许「若干个普通 ASCII 段」，形如 `album/list`、`track/album-detail/list`。
 *
 * 拒绝清单：`..`（含 `.`）、空段（`album//list`）、反斜杠、百分号编码、
 * 任何非 ASCII 字符、前导斜杠缺失。
 */
function normalizeRest(rawPath: string): string | null {
  if (!rawPath.startsWith('/')) return null
  const rest = rawPath.slice(1)
  if (rest.length === 0) return null
  for (const segment of rest.split('/')) {
    if (!SEGMENT_RE.test(segment)) return null
  }
  return rest
}

/**
 * 解析渲染进程发来的 `fnm://srv/<path>?<query>`。
 *
 * **刻意手工切分而不是用 `new URL()`**：`new URL()` 会把 `..` 规范化掉
 * （`fnm://srv/album/../user/list` → pathname `/user/list`），那样就看不出
 * 「渲染进程尝试穿越」了。这里取**原始**路径做护栏校验。
 */
function parseTarget(rawUrl: string): ParsedTarget | null {
  const schemeEnd = rawUrl.indexOf('://')
  if (schemeEnd < 0) return null
  if (rawUrl.slice(0, schemeEnd).toLowerCase() !== SCHEME) return null

  let after = rawUrl.slice(schemeEnd + 3)
  const hash = after.indexOf('#')
  if (hash >= 0) after = after.slice(0, hash)

  const question = after.indexOf('?')
  const authority = question >= 0 ? after.slice(0, question) : after
  const query = question >= 0 ? after.slice(question + 1) : ''

  const slash = authority.indexOf('/')
  const host = (slash >= 0 ? authority.slice(0, slash) : authority).toLowerCase()
  const rawPath = slash >= 0 ? authority.slice(slash) : ''

  return { host, rest: normalizeRest(rawPath), query }
}

/**
 * 原始查询串 → `session.request()` 需要的查询参数表。
 *
 * 重复键取**第一个**（与 `URLSearchParams.get()` 的语义一致）。
 */
function queryToRecord(query: string): Record<string, string> {
  const record: Record<string, string> = {}
  if (query.length === 0) return record
  for (const [key, value] of new URLSearchParams(query)) {
    if (!(key in record)) record[key] = value
  }
  return record
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------

/** 构造错误响应：502 + `{ code: -1, msg }`（**不含**任何凭证或堆栈）。 */
function errorResponse(msg: string): Response {
  return new Response(JSON.stringify({ code: -1, msg }), {
    status: 502,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  })
}

/** 构造 JSON 响应（状态码沿用上游）。 */
function jsonResponse(status: number, json: unknown): Response {
  const body = NULL_BODY_STATUSES.has(status)
    ? null
    : JSON.stringify(json === undefined ? null : json)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  })
}

/**
 * CORS 预检应答。
 *
 * 渲染进程页面来自 `file://` / dev server，与 `fnm://` 跨源；
 * `POST` + `content-type: application/json` 会触发预检，这里直接应答（**不打到上游**）。
 */
function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } })
}

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

/**
 * 把异常映射成给渲染进程的可读中文提示。
 *
 * - `SessionStateError` 用**可判别的错误码**分支（不靠中文文案匹配）：
 *   `NO_SESSION` = 未连接服务器，`NO_CREDENTIAL` = 未登录；
 * - 其它异常一律归为「连不上」，**不把原始异常消息 / 堆栈带给渲染进程**。
 */
function errorMessage(err: unknown): string {
  if (err instanceof SessionStateError) {
    switch (err.code) {
      case 'NO_SESSION':
        return '未连接服务器：请先连接音乐服务器'
      case 'NO_CREDENTIAL':
        return '未登录：缺少身份凭据，请重新登录'
      default:
        return '会话状态异常，请重新登录后再试'
    }
  }
  return '无法连接音乐服务（网络不可达或服务未响应）'
}

/**
 * 会话前置检查：返回非 `null` 表示没有可用会话（未连接 / 未登录）。
 *
 * 二进制路径自己拼上游 URL（不走 `SessionManager.request()`），故需要自己检查；
 * 错误码与 `SessionManager` 保持一致，便于统一映射成提示文案。
 */
function checkSession(session: SessionManager): SessionStateError | null {
  if (!session.state.base) {
    return new SessionStateError('NO_SESSION', '尚未连接服务器：缺少会话基址')
  }
  if (!session.state.token) {
    return new SessionStateError('NO_CREDENTIAL', '尚未登录：缺少身份凭据')
  }
  return null
}

// ---------------------------------------------------------------------------
// 转发
// ---------------------------------------------------------------------------

/**
 * JSON 路径：交给会话层发请求（复用 `99999` 静默续期重试）。
 *
 * 会话层只返回 `{ status, json }`，这里把 `json` 序列化回 JSON 返回；
 * 上游状态码原样保留（渲染进程按信封里的 `code` 判业务错误）。
 */
async function proxyJson(
  session: SessionManager,
  request: Request,
  rest: string,
  query: string,
): Promise<Response> {
  const method = request.method.toUpperCase()

  let body: unknown
  try {
    body = await readJsonBody(request, method)
  } catch {
    return errorResponse('请求体不是合法的 JSON')
  }

  try {
    const result = await session.request(rest, {
      method,
      body,
      query: queryToRecord(query),
    })
    return jsonResponse(result.status, result.json)
  } catch (err) {
    return errorResponse(errorMessage(err))
  }
}

/** 读请求体并解析成 JSON（无体或空体时返回 `undefined`）。 */
async function readJsonBody(request: Request, method: string): Promise<unknown> {
  if (method === 'GET' || method === 'HEAD') return undefined
  const text = await request.text()
  if (text.trim().length === 0) return undefined
  return JSON.parse(text) as unknown
}

/**
 * 二进制路径：流式转发（音频流 / 封面）。
 *
 * - 上游 URL **只**由 `session.state.base` + 受护栏约束的相对路径拼出；
 * - `Range` 等白名单请求头透传（拖动定位靠它）；
 * - 上游 body **直接作为响应 body**（流式，不整块读进内存）；
 * - 上游状态码原样保留（`206` 不能被改成 `200`）。
 */
async function proxyBinary(
  session: SessionManager,
  request: Request,
  rest: string,
  query: string,
  isRelay: boolean,
): Promise<Response> {
  const stateError = checkSession(session)
  if (stateError) return errorResponse(errorMessage(stateError))

  const url = `${session.state.base}${API_PREFIX}/${rest}${query.length > 0 ? `?${query}` : ''}`
  const upstreamRequest = buildUpstreamRequest(
    { method: request.method, url, headers: request.headers },
    session.state.token,
    isRelay,
  )

  let upstream: Response
  try {
    upstream = await fetch(upstreamRequest)
  } catch {
    return errorResponse('无法连接音乐服务（网络不可达或服务未响应）')
  }

  const headers = new Headers()
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  // Electron 会自动解压上游的 gzip：留着原始 content-encoding 会让渲染进程二次解压而报错。
  headers.delete('content-encoding')
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)

  const body = NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body
  return new Response(body, { status: upstream.status, headers })
}

// ---------------------------------------------------------------------------
// 协议处理器
// ---------------------------------------------------------------------------

/** 处理一次 `fnm://` 请求。 */
async function handleProxyRequest(
  session: SessionManager,
  request: Request,
  opts: { isRelay?: () => boolean; binaryPaths: readonly string[] },
): Promise<Response> {
  try {
    return await dispatch(session, request, opts)
  } catch {
    // 兜底：任何未预期的异常也只回 502 + 通用提示，**不把异常消息 / 堆栈带给渲染进程**。
    return errorResponse('无法连接音乐服务（网络不可达或服务未响应）')
  }
}

/** `handleProxyRequest` 的实际分流逻辑。 */
async function dispatch(
  session: SessionManager,
  request: Request,
  opts: { isRelay?: () => boolean; binaryPaths: readonly string[] },
): Promise<Response> {
  const target = parseTarget(request.url)
  if (!target) return errorResponse('无法识别的 fnm:// 请求地址')
  if (target.host !== ALLOWED_HOST) {
    return errorResponse(`不支持的 fnm:// 主机（只允许 ${ALLOWED_HOST}）`)
  }
  if (target.rest === null) {
    return errorResponse('非法的 API 路径：只允许形如 segment/segment 的 ASCII 路径')
  }

  const method = request.method.toUpperCase()
  if (method === 'OPTIONS') return preflightResponse()

  // 中继判定：覆盖钩子优先于会话状态。
  const isRelay = opts.isRelay?.() ?? session.state.isRelay

  if (opts.binaryPaths.includes(target.rest)) {
    return await proxyBinary(session, request, target.rest, target.query, isRelay)
  }
  return await proxyJson(session, request, target.rest, target.query)
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册 `fnm` scheme 的特权。
 *
 * ⚠️ **主进程必须在 `app.whenReady()` 之前调用它**（Electron 的硬性约束：
 * `registerSchemesAsPrivileged()` 只在 ready 之前可用）。
 * Task 9 的主进程入口会这么做；`registerProxy()` 内部另有一次防御性调用。
 */
export function registerFnmSchemePrivileges(protocol?: ProtocolLike): void {
  const target = protocol ?? resolveElectronProtocol()
  if (!target) {
    throw new Error('fnm:// scheme 特权注册失败：当前进程没有可用的 Electron protocol 模块')
  }
  target.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ])
}

/**
 * 注册 `fnm://` 协议代理（**必须在 app ready 之后调用**）。
 *
 * - `protocol` 缺省时**惰性**取 Electron 的 `protocol`（模块顶层不 import Electron）；
 * - 内部防御性地调用一次 `registerFnmSchemePrivileges()`：
 *   ready 之后调用它会抛错，包在 try/catch 里忽略（Task 9 会在 ready 前先调一次）；
 * - `opts.isRelay` 是中继判定的覆盖钩子，实际取值 `opts.isRelay?.() ?? session.state.isRelay`；
 * - `opts.binaryPaths` 可覆盖默认的二进制（流式）路径白名单。
 */
export function registerProxy(session: SessionManager, opts: ProxyOptions = {}): void {
  const protocol = opts.protocol ?? resolveElectronProtocol()
  if (!protocol) {
    throw new Error('fnm:// 协议代理注册失败：当前进程没有可用的 Electron protocol 模块')
  }

  try {
    registerFnmSchemePrivileges(protocol)
  } catch {
    // 忽略：ready 之后调用 registerSchemesAsPrivileged 会抛错；
    // 正常流程由主进程入口在 app.whenReady() 之前先调一次 registerFnmSchemePrivileges()。
  }

  const binaryPaths = opts.binaryPaths ?? DEFAULT_BINARY_PATHS
  protocol.handle(SCHEME, (request) =>
    handleProxyRequest(session, request, { isRelay: opts.isRelay, binaryPaths }),
  )
}
