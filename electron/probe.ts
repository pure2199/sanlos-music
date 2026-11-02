// 链路并行探测：把「内网直连 → 公网 IPv6 → 公网 IPv4 → 中继」多条候选并行探一遍，
// 由调用方挑出优先级最高的**可达**项（候选顺序即优先级，顺序由 `buildCandidates` 决定）。
//
// 职责边界（计划 Task 9）：
// - 本模块只负责**探测与归类错误**，不负责选路（挑哪条链路是 Task 10 的界面逻辑），
//   也不负责落盘任何状态。
// - 模块顶层**不 import Electron**，只用标准 Web API（可在 Vitest / Node 下直接单测）。
// - 复用 Task 4 的 `Candidate`（地址基址**不含** `/music`）与 Task 3 的
//   `authx` / `buildCookie`。
//
// 四条实测约束（改错任何一条都会让探测结论失真）：
// - M5：**`GET /music/api/v1/health` 的响应不是可靠的 JSON**（实测 `code=null`）。
//   故链路可达性**只以 HTTP 状态码为准**，未登录分支**不解析业务码**。
// - M2：**中继链路下所有请求都必须带 `Cookie: mode=relay`**，否则中继不识别请求、
//   返回 HTML 错误页。探测中继候选时同样要带（无 token 时也只带 `mode=relay`）。
// - M8：服务端**不校验** `authx`，但客户端仍按上游语义发送（官方 Web 端会发）。
// - 每个候选**最多只发一次请求**：不为了重试而多次打用户自己的服务器。
//
// 安全边界：
// - **绝不**把 token / 密码写进 `error` 文案、异常消息或日志。
//   `error` 只由固定文案与**服务端 `msg`** 组成；即便服务端把 token 回显在 `msg` 里，
//   也会被就地打码。

import { API_PREFIX, CODE_OK, CODE_TOKEN_EXPIRED, MUSIC_PATH, RELAY_COOKIE_MODE } from '../shared/constants'
import { authx, buildCookie } from './sign'
import type { Candidate } from './connection'

/** 探测参数。 */
export interface ProbeOptions {
  /** 当前登录凭证；非空表示「已登录」，探测 `track/list` 以便校验 token 是否被接受。 */
  token?: string
  /** 统一覆盖默认超时（毫秒）；缺省时直连 3s、中继 10s。 */
  timeoutMs?: number
}

/** 单条候选的探测结果。 */
export interface ProbeResult {
  /** 被探测的候选。 */
  candidate: Candidate
  /** 链路是否可达（HTTP 状态码 < 400 即视为可达）。 */
  ok: boolean
  /** 失败原因 / 备注（可读中文，**不含凭证**）；`ok` 为真时也可能存在（如 token 已失效）。 */
  error?: string
}

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

/** 直连候选的默认超时（毫秒）。 */
export const PROBE_TIMEOUT_DIRECT_MS = 3000

/** 中继候选的默认超时（毫秒）；中继多一跳，给宽一点。 */
export const PROBE_TIMEOUT_RELAY_MS = 10000

// ---------------------------------------------------------------------------
// 错误文案（固定文案，绝不含凭证）
// ---------------------------------------------------------------------------

/** 无法解析主机（DNS）。 */
export const PROBE_ERROR_DNS = '无法解析主机（DNS）'

/** 连接被拒绝（端口不通或服务未启动）。 */
export const PROBE_ERROR_REFUSED = '连接被拒绝（端口不通或服务未启动）'

/** 连接超时（端口无响应）。 */
export const PROBE_ERROR_TIMEOUT = '连接超时（端口无响应）'

/** 网络不可达。 */
export const PROBE_ERROR_UNREACHABLE = '网络不可达'

/** TLS 握手失败（附带可操作的放行提示——这正是 `TrustedHosts` 要解决的场景）。 */
export const PROBE_ERROR_TLS = 'TLS 握手失败：证书不受信，可在设置里放行该主机后重试'

/** 无法归类的连接失败。 */
export const PROBE_ERROR_UNKNOWN = '连接失败（网络异常或服务未响应）'

/** token 已失效（链路可达，但需要先续期再重探）。 */
export const PROBE_ERROR_TOKEN_EXPIRED = 'token 已失效'

// ---------------------------------------------------------------------------
// 错误归类
// ---------------------------------------------------------------------------

/** 视为「连接超时」的错误码。 */
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** 视为「TLS 握手失败」的错误码前缀。 */
const TLS_CODE_PREFIXES = ['CERT_', 'UNABLE_TO_VERIFY', 'DEPTH_ZERO', 'SELF_SIGNED']

/** 视为「TLS 握手失败」的 message 片段（覆盖 `ERR_TLS_CERT_ALTNAME_INVALID` 这类码）。 */
const TLS_MESSAGE_RE = /certificate|self-signed|altname/i

/**
 * 从异常链上收集错误码 / 消息 / 异常名。
 *
 * Node 的 `fetch` 失败时抛的是 `TypeError: fetch failed`，真正的错误在 `cause` 上，
 * 所以必须沿 `cause` 链收集（最多 5 层）。
 */
function collectCauses(err: unknown): { codes: string[]; messages: string[]; names: string[] } {
  const codes: string[] = []
  const messages: string[] = []
  const names: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 5; depth++) {
    if (typeof cur !== 'object' || cur === null) break
    const e = cur as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown }
    if (typeof e.code === 'string') codes.push(e.code)
    if (typeof e.message === 'string') messages.push(e.message)
    if (typeof e.name === 'string') names.push(e.name)
    cur = e.cause
  }
  return { codes, messages, names }
}

/**
 * 把底层异常归类成一句可读中文。
 *
 * 归类依据是 `cause.code`（以及 TLS 场景下的 `cause.message`），
 * **不靠匹配 `err.message` 的中文或英文片段**——底层文案随 Node / undici 版本变化。
 */
export function classifyProbeError(err: unknown): string {
  const { codes, messages, names } = collectCauses(err)
  const has = (code: string): boolean => codes.includes(code)
  if (has('ENOTFOUND') || has('EAI_AGAIN')) return PROBE_ERROR_DNS
  if (has('ECONNREFUSED')) return PROBE_ERROR_REFUSED
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return PROBE_ERROR_TIMEOUT
  if (has('ENETUNREACH') || has('EHOSTUNREACH')) return PROBE_ERROR_UNREACHABLE
  if (codes.some((c) => TLS_CODE_PREFIXES.some((p) => c.startsWith(p)))) return PROBE_ERROR_TLS
  if (messages.some((m) => TLS_MESSAGE_RE.test(m))) return PROBE_ERROR_TLS
  if (names.some((n) => n.includes('Timeout'))) return PROBE_ERROR_TIMEOUT
  if (names.some((n) => n === 'AbortError')) return PROBE_ERROR_TIMEOUT
  return PROBE_ERROR_UNKNOWN
}

/**
 * 打码：服务端若把 token 回显在 `msg` 里，也不能让它出现在 error 文案中。
 *
 * 没有 token 时原样返回。
 */
function redact(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join('***')
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/** 中继链路专用 Cookie（无 token 时也要带，否则中继不认请求）。 */
const RELAY_ONLY_COOKIE = `mode=${RELAY_COOKIE_MODE}`

/**
 * 探测请求的 Cookie。
 *
 * - 有 token：走 `buildCookie`，`music-token` 与 `mode=relay` 合并在同一个 Cookie 头
 *   （拆成两个键会互相覆盖丢失中继标志）。
 * - 无 token：中继候选**必须**带 `mode=relay`；直连候选不带 Cookie。
 */
function probeCookie(token: string, isRelay: boolean): string {
  if (token) return buildCookie(token, isRelay)
  return isRelay ? RELAY_ONLY_COOKIE : ''
}

/** 探测端点：已登录打 `track/list`（最小 size），未登录打 `health`。 */
function probeUrl(candidate: Candidate, loggedIn: boolean): string {
  const endpoint = loggedIn ? '/track/list?size=1' : '/health'
  return `${candidate.address}${MUSIC_PATH}${API_PREFIX}${endpoint}`
}

/**
 * 读取响应体并解析为业务信封。
 *
 * 解析失败 / 不是普通对象时返回 `null`（调用方据此判定「响应体不是 JSON」，不报错）。
 */
async function readEnvelope(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = (await res.json()) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/**
 * 探测单条候选。**永远不会抛异常**——失败一律转成 `ok: false` + `error`。
 */
async function probeOne(candidate: Candidate, opts: ProbeOptions): Promise<ProbeResult> {
  const token = typeof opts.token === 'string' ? opts.token : ''
  const loggedIn = token.length > 0
  const isRelay = candidate.isRelay || candidate.kind === 'relay'
  // `opts.timeoutMs` 存在即统一覆盖所有候选的默认超时；只有非法值（非有限数 / 负数）才回落默认。
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0
      ? opts.timeoutMs
      : isRelay
        ? PROBE_TIMEOUT_RELAY_MS
        : PROBE_TIMEOUT_DIRECT_MS

  const url = probeUrl(candidate, loggedIn)
  const headers: Record<string, string> = { authx: authx('GET', url) }
  const cookie = probeCookie(token, isRelay)
  if (cookie) headers['cookie'] = cookie

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })

    // 状态码是可达性的唯一依据（M5：health 的业务码不可信）。
    if (res.status >= 400) {
      return { candidate, ok: false, error: `HTTP ${res.status}` }
    }

    // 未登录分支只看状态码，不解析业务码。
    if (!loggedIn) return { candidate, ok: true }

    const envelope = await readEnvelope(res)
    if (envelope === null) {
      // 响应体不是 JSON：不报错（状态码 < 400 即视为可达）。
      return { candidate, ok: true }
    }

    const code = envelope['code']
    if (code === undefined) {
      // 不是业务信封：既没有 code 也没有 msg 可依据，视为该端点不是音乐服务接口。
      return { candidate, ok: false, error: '响应格式异常（缺少 code）' }
    }
    if (code === CODE_OK) return { candidate, ok: true }
    if (code === CODE_TOKEN_EXPIRED) {
      // 服务端有响应 → 链路可达；是否先续期由上层决定。
      return { candidate, ok: true, error: PROBE_ERROR_TOKEN_EXPIRED }
    }
    const msg = envelope['msg']
    const reason =
      typeof msg === 'string' && msg.trim() !== '' ? msg : `code=${String(code)}`
    return { candidate, ok: false, error: redact(reason, token) }
  } catch (err) {
    return { candidate, ok: false, error: classifyProbeError(err) }
  }
}

/**
 * **并行**探测所有候选，返回结果数组。
 *
 * - 所有请求**同时发出**（不串行等待），全部结束后一次性返回。
 * - 返回数组的顺序**与输入候选顺序一致**（不是完成顺序）；候选顺序即优先级，
 *   调用方取第一个 `ok` 的即可。
 * - 单个候选失败**不影响**其它候选，每个失败都带自己的 `error`。
 * - 每个候选**最多只发一次请求**。
 */
export async function probeCandidates(
  candidates: Candidate[],
  opts: ProbeOptions = {},
): Promise<ProbeResult[]> {
  return Promise.all(candidates.map((candidate) => probeOne(candidate, opts)))
}
