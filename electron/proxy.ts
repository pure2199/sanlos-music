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
// 3. **渲染进程不能逃出 API 前缀**：请求路径只允许「若干个普通 ASCII 段」
//    （空段、反斜杠、百分号编码、非 ASCII 全部拒绝）。
//    ⚠️ **如实说明**：`..` 与 `%2e%2e` 在运行期**已被 URL 解析器规范化**
//    （WHATWG 规范：构造 `Request` 时就把路径里的 `..` 消解掉，Chromium 同规范），
//    所以 handler 收到的是**规范化之后**的路径——它们**不会**被 502 拒绝，
//    只是落回 API 前缀内的普通相对路径（安全，但不是「已被拒绝」）；
//    保留原样的 `%2f` 才会真正落到段级白名单上被拒。
//    **主要防线**不是「在 URL 层面拦 `..`」，而是「上游 URL 只由
//    `session.state.base` + 受限路径段拼成」：无论渲染进程怎么构造，
//    上游 URL 恒为 `<base>/api/v1/<rest>`，**逃不出 API 前缀**，
//    也就打不到音乐服务的其它端点。
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
import { createHttpStack, type HttpStack, type UpstreamStream } from './http'
import {
  APP_SCHEME_PRIVILEGES,
  FNM_SCHEME,
  registerAppSchemes,
  registerSchemePrivileges,
  resolveElectronProtocol,
  type ProtocolLike,
} from './schemes'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 协议 scheme 名（与渲染进程 `src/api/client.ts` 的 `fnm://srv` 前缀一致）。 */
const SCHEME = FNM_SCHEME

/** 唯一允许的虚拟主机名：渲染进程只能用 `srv`（**不接受任何真实主机名**）。 */
const ALLOWED_HOST = 'srv'

/**
 * 默认的二进制（流式）路径白名单。
 *
 * 判定依据是「相对 API 基址的路径」（与 `SessionManager.request(path)` 的 `path` 同语义，
 * 不含 `/music/api/v1`）。`registerProxy` 的 `opts.binaryPaths` 可覆盖它。
 *
 * ⚠️ **为什么 `download/track/transcode/file` 必须在里面**（T54 实测）：
 *    服务端转码产物是**音频字节**（官方旧下载协议里 = MP3 320k）。
 *    走 JSON 路径会**把字节丢掉**（`JSON.parse` 失败 → 变成 `null`），
 *    而且 JSON 路径有 30 秒超时、**不透传 `Range`**（拖进度条就没了）。
 *    ⇒ 必须走二进制路径：上游 body 直接作为响应体，`Range` / `206` 原样透传。
 */
export const DEFAULT_BINARY_PATHS: readonly string[] = [
  'track/stream',
  'static/cover',
  'download/track/transcode/file',
]

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

/**
 * 不允许携带响应体的状态码（Fetch 规范里的 "null body status"）。
 *
 * 只含 204 / 205 / 304：**101 不在此列**——`Response` 构造器只接受
 * `[200, 599]` 的状态码，`new Response(null, { status: 101 })` 会抛 RangeError
 * （那种状态码根本构造不出来，交给外层兜底 catch 转成 502）。
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

/** 跨源放行头：渲染进程页面来自 `file://` / dev server，与 `fnm://` 跨源。 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, range, accept, if-none-match, if-modified-since',
  'access-control-max-age': '600',
}

// ---------------------------------------------------------------------------
// 类型（**搬到 `electron/schemes.ts`**——「scheme 注册」是那儿的职责）
// ---------------------------------------------------------------------------
//
// ⚠️ 这里**重新导出**是为了不破坏既有 import（`electron/proxy` 是公开入口）。

export type {
  ProtocolLike,
  ProtocolPrivileges,
  ProtocolSchemeRegistration,
} from './schemes'

// ---------------------------------------------------------------------------
// Electron 惰性解析
// ---------------------------------------------------------------------------

// ⚠️ `resolveElectronProtocol` 住在 `electron/schemes.ts`——
//    `fnm` 与 `fnml` **共用**同一个「惰性取 protocol」的实现（见该文件的说明：
//    两个 scheme 必须**一次**注册，第二个会把第一个覆盖掉）。

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
  /**
   * 出网通道（Task 9b：Chromium 分区栈）。
   *
   * 缺省时自建一个（单测里回落到全局 `fetch`）。
   * ⚠️ 主进程应当注入与会话层**同一个**实例——否则两条路径会走不同的 Chromium 分区，
   * 证书放行与换分区就对不上了。
   */
  http?: HttpStack
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

// ⚠️ `resolveElectronProtocol` 住在 `electron/schemes.ts`——
//    `fnm` 与 `fnml` **共用**同一个「惰性取 protocol」的实现（见该文件的说明：
//    两个 scheme 必须**一次**注册，第二个会把第一个覆盖掉）。

// ---------------------------------------------------------------------------
// 上游请求构造
// ---------------------------------------------------------------------------

/**
 * 构造发往上游的请求：**只加头，不发请求**（请求由调用方 `fetch` 发出）。
 *
 * - 附加 `authx` 签名（签名路径取完整 URL 的 pathname，与 Task 3 语义一致；
 *   有请求体时**按请求体参与签名**，与 `SessionManager.request()` 的行为一致）；
 * - 附加凭证 Cookie（`music-token=<token>`，中继链路再追加 `mode=relay`）；
 * - 请求头**只透传白名单**（`range` / `content-type` / `accept` /
 *   `if-none-match` / `if-modified-since`），其余一律丢弃——
 *   渲染进程带来的 `cookie` / `authorization` 绝不会影响上游看到的身份。
 *
 * @param body 可选的请求体（**新增的第 4 个参数**，前 3 个参数保持不变，向后兼容）。
 *   二进制路径用它把渲染进程的请求体带下去（否则 `POST /track/stream` 的体会被静默丢掉，
 *   而 `authx` 却按空体签名——自洽但语义错）。
 *   `GET` / `HEAD` 或空串一律按「无请求体」处理。
 */
export function buildUpstreamRequest(
  input: UpstreamRequestInput,
  token: string,
  isRelay: boolean,
  body?: string | null,
): Request {
  const method = input.method.toUpperCase()
  const hasBody =
    typeof body === 'string' && body.length > 0 && method !== 'GET' && method !== 'HEAD'

  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = input.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  if (hasBody && headers.get('content-type') === null) {
    // 渲染进程没声明类型时按 JSON 处理（与 `src/api/client.ts` 的实际行为一致）。
    headers.set('content-type', 'application/json')
  }
  headers.set('authx', authx(method, input.url, hasBody ? body : undefined))
  headers.set('cookie', buildCookie(token, isRelay))
  return new Request(input.url, {
    method,
    headers,
    ...(hasBody ? { body } : {}),
  })
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
 * 拒绝清单（作用在**原始路径**形态上）：含 `.` 的段（`..`）、空段（`album//list`）、
 * 反斜杠、百分号编码、任何非 ASCII 字符、前导斜杠缺失。
 *
 * ⚠️ **关于 `..` 与 `%2e%2e`（如实说明，勿误读）**：
 * WHATWG 的 URL 解析器在**构造 `Request` 时**就把它们规范化掉了
 * （`fnm://srv/album/../user/list` 与 `fnm://srv/album/%2e%2e/user/list`
 * **都**变成 `fnm://srv/user/list`），Chromium 同规范。
 * 因此**运行期的 handler 收到的是规范化后的路径**，本护栏看到的是规范化之后的结果——
 * 它**不能**在这里识别出「渲染进程原本想穿越」（也不需要：见下）。
 * 兜底的安全保证是：规范化后的路径**仍然是一个普通的相对路径**，
 * 上游 URL 恒为 `<base>/api/v1/<rest>`，**不可能逃出 API 前缀**。
 * 只有**无法被规范化**的形态（例如 `%2f`）才会真正落到本护栏上并被拒绝。
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
 * **刻意手工切分而不是用 `new URL()`**：要拿到**未经 URL 规范化**的原始路径，
 * 才知道渲染进程到底写了什么（`new URL()` 会把 `..` / `%2e%2e` 规范化掉）。
 *
 * ⚠️ **反斜杠分支的适用面**：`fnm` 注册为 `standard: true` 之后，
 * Chromium 可能把 `\` 当作路径分隔符（Node / 单测里它是普通字符）。
 * 所以「反斜杠被拒」这条分支主要在**原始路径形态**下生效；
 * 即便生产环境把它当成分隔符，结果也只是多切一个段，**仍在 API 前缀内**，
 * 不构成逃逸。这条分支**不是**主要防线——主要防线是「上游 URL 只由
 * `session.state.base` + 受限路径段拼成」这件事本身。
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
 * - **无原型**（`Object.create(null)`）：避免 `key in record` 命中
 *   `Object.prototype` 上的 `constructor` / `toString` / `__proto__`
 *   ——那会让这些查询参数被静默丢弃，`__proto__` 赋值还会变成一次静默 no-op。
 *   判重一律用 `Object.prototype.hasOwnProperty.call()`。
 * - **重复键取第一个**（与 `URLSearchParams.get()` 的语义一致）：
 *   `session.request()` 的 `query` 是单值 `Record<string, string>`，
 *   表达不了同键多值（上游签名的多值语义由 `sign.ts` 自己按 `getAll` 处理）。
 */
function queryToRecord(query: string): Record<string, string> {
  const record = Object.create(null) as Record<string, string>
  if (query.length === 0) return record
  for (const [key, value] of new URLSearchParams(query)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = value
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
  isRelay: boolean,
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
      // 中继覆盖钩子同样作用在 JSON 路径上：两条路径的链路模式必须一致
      // （中继关卡 `Cookie: mode=relay` 是硬性要求）。
      isRelay,
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
 * - 上游状态码原样保留（`206` 不能被改成 `200`）；
 * - 上游 401 / 403 时**静默续期一次并重发一次**（token 失效的全局约束同样适用）。
 */
async function proxyBinary(
  session: SessionManager,
  request: Request,
  rest: string,
  query: string,
  isRelay: boolean,
  http: HttpStack,
): Promise<Response> {
  const stateError = checkSession(session)
  if (stateError) return errorResponse(errorMessage(stateError))

  const url = `${session.state.base}${API_PREFIX}/${rest}${query.length > 0 ? `?${query}` : ''}`
  const method = request.method.toUpperCase()

  // 请求体：二进制路径也可能带体（实测端点里有 `POST /track/stream {trackGUID}`）。
  // 读一次存成字符串，重试时复用（不重复消费渲染进程的 body，也不缓冲响应体）。
  let requestBody: string | null = null
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      requestBody = await request.text()
    } catch {
      return errorResponse('无法读取请求体')
    }
  }

  const send = (): Promise<UpstreamStream> => {
    const upstreamRequest = buildUpstreamRequest(
      { method, url, headers: request.headers },
      session.state.token,
      isRelay,
      requestBody,
    )
    // ⚠️ **优先走 `http.stream`**（T56）：`http.fetch` 走 Electron 的 `session.fetch`，
    //    它把上游响应头塞进 undici 的 `Headers` ⇒ **ByteString 校验**
    //    （每个字符必须 ≤ 255）；而 Chromium 按 **UTF-8** 解码响应头 ⇒
    //    上游一旦回带中文的头（实测 NAS 转码产物的
    //    `Content-Disposition: attachment; filename="占位曲目一 - 占位歌手二.mp3"`），
    //    就抛 `TypeError`，且**抛在事件回调里** ⇒ 主进程未捕获异常
    //    + 那个请求**永不返回** ⇒ 二进制路径挂死。
    //    `http.stream` 走 Electron 的 `net.request`：响应头是**普通字符串记录**，
    //    **不经过** ByteString 校验。
    if (typeof http.stream === 'function') return http.stream(upstreamRequest)
    // 回落（替身没有 `stream`）：行为与 T56 之前一致。
    return streamViaFetch(http, upstreamRequest)
  }

  let upstream: UpstreamStream
  try {
    upstream = await send()
  } catch {
    return errorResponse('无法连接音乐服务（网络不可达或服务未响应）')
  }

  // token 失效：流式路径拿不到「200 + JSON 信封里的 99999」（读 body 就破坏流式），
  // 上游只会用 401 / 403 表达。这里**静默续期一次**再重发一次（只重试一次）。
  if (upstream.status === 401 || upstream.status === 403) {
    await discardBody(upstream.body)
    const renewed = await renewSession(session)
    if (!renewed) {
      // 续期失败：按「上游异常」处理，**不把上游的 401 原样透给渲染进程**。
      return errorResponse('身份凭据已失效，自动续期失败，请重新登录')
    }
    try {
      // 重新构造请求：续期后 token 已变，必须带上新 token。
      upstream = await send()
    } catch {
      return errorResponse('无法连接音乐服务（网络不可达或服务未响应）')
    }
  }

  const headers = new Headers()
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers[name.toLowerCase()]
    if (value === undefined) continue
    // ⚠️ **只转发 ByteString 安全的值**（每个字符的码位 ≤ 255）：
    //    `Headers.set` 会做 ByteString 校验，撞上就抛 ⇒ 整个响应失败。
    //    宁可**少转一个头**，也不能让整个响应挂掉。
    if (!isByteStringSafe(value)) continue
    headers.set(name, value)
  }
  // Electron 会自动解压上游的 gzip：留着原始 content-encoding 会让渲染进程二次解压而报错。
  //
  // ⚠️ `content-length` 必须与 `content-encoding` **同生共死**：
  // undici 会在解压 body 的同时**保留压缩态的 `content-length`**（实测：gzip 响应
  // `content-length: 24` 而解压后 body 100 字节）。只删 `content-encoding` 而留着
  // `content-length`，渲染进程会拿到「声明 24 字节、实际 100 字节」的响应 →
  // Chromium `ERR_CONTENT_LENGTH_MISMATCH` / 截断，**封面与音频流直接加载失败**。
  // 解压后长度未知，故上游带 `content-encoding` 时**一并删掉** `content-length`。
  if (upstream.headers['content-encoding'] !== undefined) {
    headers.delete('content-length')
  }
  headers.delete('content-encoding')
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)

  const responseBody = NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body
  return new Response(responseBody, { status: upstream.status, headers })
}

/** 丢弃一个响应体（释放连接），忽略失败。 */
async function discardBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel()
  } catch {
    // 忽略：丢弃失败不影响主流程
  }
}

/**
 * 回落：`http.stream` 缺席时用 `http.fetch` 取上游，并转成 `UpstreamStream`。
 *
 * ⚠️ 行为与 T56 之前**完全一致**（单测环境没有 Electron，走的就是这条路）。
 */
async function streamViaFetch(http: HttpStack, request: Request): Promise<UpstreamStream> {
  const res = await http.fetch(request)
  const headers: Record<string, string> = {}
  res.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  return { status: res.status, headers, body: res.body }
}

/**
 * 值是不是 **ByteString 安全的**（每个字符的码位 ≤ 255）。
 *
 * ⚠️ `Headers.set` 会做这个校验，撞上就抛 `TypeError` ⇒ 宁可**不转**这个头。
 */
function isByteStringSafe(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 255) return false
  }
  return true
}

/**
 * 静默续期一次（Task 7 的 `SessionManager.relogin()`）。
 *
 * 返回 `false` 表示续期失败（会话没拿到新 token）——调用方据此转成 502，
 * **不把上游的 401 原样透给渲染进程**。
 */
async function renewSession(session: SessionManager): Promise<boolean> {
  try {
    return await session.relogin()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 协议处理器
// ---------------------------------------------------------------------------

/** 处理一次 `fnm://` 请求。 */
async function handleProxyRequest(
  session: SessionManager,
  request: Request,
  opts: { isRelay?: () => boolean; binaryPaths: readonly string[]; http: HttpStack },
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
  opts: { isRelay?: () => boolean; binaryPaths: readonly string[]; http: HttpStack },
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
    return await proxyBinary(session, request, target.rest, target.query, isRelay, opts.http)
  }
  return await proxyJson(session, request, target.rest, target.query, isRelay)
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册 `fnm` scheme 的特权（**单个** scheme）。
 *
 * ⚠️⚠️ **应用启动时不要用本函数**——Electron 的
 *    `registerSchemesAsPrivileged()` **整个进程只能调用一次**，
 *    第二次会**静默覆盖**第一次的注册结果。
 *    应用启动的正确入口是 `electron/schemes.ts` 的 `registerAppSchemes()`
 *    （把 `fnm` 与 `fnml` **合并成一次**注册）。
 *    本函数保留下来是为了**单测**（钉住 `fnm` 的特权形状）与按需单注册。
 */
export function registerFnmSchemePrivileges(protocol?: ProtocolLike): void {
  registerSchemePrivileges(
    [{ scheme: FNM_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } }],
    protocol,
  )
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
    // ⚠️ **防御性调用**：ready 之后调 `registerSchemesAsPrivileged()` 会抛错，
    //    包在 try/catch 里忽略（正常流程由主进程入口在 ready 前调一次）。
    // ⚠️ 这里必须调 `registerAppSchemes()`（**两个 scheme 一起**），
    //    **不能**只调 `registerFnmSchemePrivileges()`——
    //    `registerSchemesAsPrivileged()` 整个进程**只能调用一次**，
    //    单个注册会**覆盖掉**另一个 scheme 的特权（见 `electron/schemes.ts`）。
    registerAppSchemes(protocol)
  } catch {
    // 忽略：ready 之后调用 registerSchemesAsPrivileged 会抛错；
    // 正常流程由主进程入口在 app.whenReady() 之前先调一次 registerAppSchemes()。
  }

  const binaryPaths = opts.binaryPaths ?? DEFAULT_BINARY_PATHS
  // 出网通道：注入优先；没注入就自建一个（单测里回落到全局 fetch）。
  const http = opts.http ?? createHttpStack()
  protocol.handle(SCHEME, (request) =>
    handleProxyRequest(session, request, { isRelay: opts.isRelay, binaryPaths, http }),
  )
}
