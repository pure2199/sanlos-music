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
// 实测约束（改错任何一条都会让探测结论失真）：
// - M5：**`GET /music/api/v1/health` 的响应不是可靠的 JSON**（实测 `code=null`）。
//   故链路可达性**只以 HTTP 状态码为准**：HTTP `< 400` 即为**可达**，无论响应体长什么样
//   （非 JSON / 数组 / 缺 `code` / `code=null` 一律可达）；未登录分支**不解析业务码**。
// - 业务码**只补充 `error` 文案、不决定 `ok`**：实测部分 fnOS 音乐端点会回
//   `code=100001 unknown error`——服务端明明有响应，把它判成「不可达」是错的。
// - M2：**中继链路下所有请求都必须带 `Cookie: mode=relay`**，否则中继不识别请求、
//   返回 HTML 错误页。探测中继候选时同样要带（无 token 时也只带 `mode=relay`）。
// - M8：服务端**不校验** `authx`，但客户端仍按上游语义发送（官方 Web 端会发）。
// - 每个候选**最多只发一次请求**：不为了重试而多次打用户自己的服务器。
//
// 安全边界：
// - **绝不**把 token / 密码写进 `error` 文案、异常消息或日志。
//   `error` 只由固定文案与**服务端 `msg`** 组成；即便服务端把 token 回显在 `msg` 里，
//   也会被就地打码。
//
// 消费方须知（**`error` 不等于「不可达」**，Task 10 的派发会带上这条）：
// - **可达性只看 HTTP 状态码**：`< 400` 即 `ok: true`，无论响应体长什么样
//   （非 JSON / 数组 / 缺 `code` / `code=null` 都是可达）。
// - `ok: true` 时 `error` **可能非空**（如「token 已失效」、服务端业务码 `msg`），
//   它只是**备注**，**不能**被读成「链路不可达」；判可达只看 `ok`。
// - `ok: false` 时 `error` 必非空（连接失败 / HTTP >= 400）。

import { API_PREFIX, CODE_OK, CODE_TOKEN_EXPIRED, MUSIC_PATH, RELAY_COOKIE_KEY, RELAY_COOKIE_MODE } from '../shared/constants'
import { authx, buildCookie } from './sign'
import type { Candidate } from './connection'
import type { HttpStack } from './http'

/** 探测参数。 */
export interface ProbeOptions {
  /** 当前登录凭证；非空表示「已登录」，探测 `track/list` 以便校验 token 是否被接受。 */
  token?: string
  /**
   * 统一覆盖默认超时（毫秒）；缺省时直连 3s、中继 10s。
   *
   * - `0` / 负数 / 非有限数视为**未提供**，回落到默认超时。
   * - 合法值会被夹到 `[1, 4294967295]`（`AbortSignal.timeout` 的硬上限，
   *   越界会抛 `RangeError`，导致请求根本没发出去）。
   */
  timeoutMs?: number
  /**
   * 外部取消信号（可选）：调用方要中止整批探测时传入。
   *
   * 外部取消与「我们自己的超时」是**两回事**：前者报「请求被取消」，
   * 后者报「连接超时（端口无响应）」——措辞不同，排查方向也不同。
   */
  signal?: AbortSignal
  /**
   * 出网通道（Task 9b：Chromium 分区栈）。
   *
   * 缺省时用全局 `fetch`（单测里 `vi.stubGlobal('fetch', …)` 仍然有效）。
   * Electron 运行时里应当注入与其它层**同一个** `HttpStack` 实例，
   * 这样探测到的链路与后续业务请求走的是同一个 Chromium 分区。
   */
  http?: HttpStack
}

/** 单条候选的探测结果。 */
export interface ProbeResult {
  /** 被探测的候选。 */
  candidate: Candidate
  /**
   * 链路是否可达——**只由 HTTP 状态码决定**（`< 400` 即为可达）。
   *
   * 消费方判可达**只看这个字段**：不要用 `error` 是否为空来推断（见下）。
   */
  ok: boolean
  /**
   * 失败原因 / 备注（可读中文，**不含凭证**）。
   *
   * - `ok === false`：一定是失败原因，**必非空**。
   * - `ok === true`：**可能非空**（如「token 已失效」、服务端业务码 `msg`）——
   *   这是**备注**，**不代表链路不可达**。
   */
  error?: string
}

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

/** 直连候选的默认超时（毫秒）。 */
export const PROBE_TIMEOUT_DIRECT_MS = 3000

/** 中继候选的默认超时（毫秒）；中继多一跳，给宽一点。 */
export const PROBE_TIMEOUT_RELAY_MS = 10000

/**
 * 探测超时的下界（毫秒）。
 *
 * `AbortSignal.timeout(0)` 等于「立即中止」，不是任何有意义的超时；`timeoutMs: 0`
 * 一律按「未提供」处理（回落到默认 3s / 10s）。
 */
export const PROBE_TIMEOUT_MIN_MS = 1

/**
 * 探测超时的上界（毫秒）。
 *
 * `AbortSignal.timeout` 的硬上限是 4294967295；越过它会抛 `RangeError`，
 * 于是请求**根本没发出去**，每个候选都会变成「连接失败（网络异常或服务未响应）」——
 * 看起来像网络问题，实际是入参越界。故这里把超时**夹**到这个区间内。
 *
 * 注：Node 的定时器内部是 32 位有符号数，**大于 2147483647 的值会被折算成 1ms**
 * （并打印 `TimeoutOverflowWarning`）。这是 Node 层面的行为，不是本模块能绕开的；
 * 夹到上限后**至少请求会真的发出去**，超时也归类为「连接超时」而不是「连接失败」。
 */
export const PROBE_TIMEOUT_MAX_MS = 4294967295

/**
 * 把 `opts.timeoutMs` 解析成实际使用的超时（毫秒）。
 *
 * - **未提供 / 非法值**（非有限数、负数、`0`）→ 回落到该链路的默认超时
 *   （直连 3s、中继 10s）。`0` 几乎总是调用方的 bug，按字面「存在即覆盖」会让
 *   每个候选 ~5ms 就以「连接超时」失败。
 * - **合法值** → 夹到 `[PROBE_TIMEOUT_MIN_MS, PROBE_TIMEOUT_MAX_MS]`
 *   并取整（`AbortSignal.timeout` 只接受整数）。
 */
function resolveTimeoutMs(raw: unknown, isRelay: boolean): number {
  const fallback = isRelay ? PROBE_TIMEOUT_RELAY_MS : PROBE_TIMEOUT_DIRECT_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(Math.floor(raw), PROBE_TIMEOUT_MIN_MS), PROBE_TIMEOUT_MAX_MS)
}

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

/**
 * 请求被取消（**不是**超时）：外部取消信号触发时用这句，
 * 免得把「调用方主动取消」说成「端口无响应」。
 */
export const PROBE_ERROR_ABORTED = '请求被取消'

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
const TLS_CODE_PREFIXES = ['CERT_', 'ERR_CERT', 'UNABLE_TO_VERIFY', 'DEPTH_ZERO', 'SELF_SIGNED']

/** 视为「TLS 握手失败」的 message 片段（覆盖 `ERR_TLS_CERT_ALTNAME_INVALID` 这类码）。 */
const TLS_MESSAGE_RE = /certificate|self-signed|altname/i

/**
 * Chromium 网络栈的 net 错误码：**只出现在 message 里**，形如
 * `net::ERR_CERT_AUTHORITY_INVALID`。
 *
 * ⚠️ **实测（Electron 32.3.3 主进程，`ses.fetch` 打自签 HTTPS）**：Chromium 抛出的错误形态是
 * - `name = 'Error'`
 * - `message = 'net::ERR_CERT_AUTHORITY_INVALID'`
 * - **`code = undefined`**
 * - **`cause = undefined`**
 * - 自有属性只有 `['stack', 'message']`
 *
 * 也就是说 Chromium **不填 `code`**——只靠 `collectCauses` 收 `code` 是**收不到**它的。
 * 若不单独处理，证书类错误会被误报成「连接失败（网络异常或服务未响应）」，
 * 丢掉「可在设置里放行该主机后重试」这个**可操作提示**（用户会误判成 NAS 宕机），
 * 而这恰恰是 Task 9b 要解决的场景。
 *
 * ⚠️ **只认证书类错误码**：`ERR_CERT_*` 家族（权威未知 / 域名不匹配 / 过期 / 已吊销 …）。
 * **绝不**放宽成「凡带 `ERR_` 都算 TLS」——那会把协议错误、连接错误一并误报成证书问题。
 */
const CHROMIUM_NET_CODE_RE = /net::(ERR_[A-Z0-9_]+)/g

/**
 * 从异常链的 message 里抽出 Chromium 的 net 错误码（`net::ERR_XXX` → `ERR_XXX`）。
 *
 * 只做**抽取**，不做判定——判定由调用方按错误码族决定。
 */
function extractChromiumNetCodes(messages: string[]): string[] {
  const codes: string[] = []
  for (const message of messages) {
    for (const match of message.matchAll(CHROMIUM_NET_CODE_RE)) {
      const code = match[1]
      if (code) codes.push(code)
    }
  }
  return codes
}

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
 *
 * ⚠️ **例外：Chromium 的 net 错误码**。切到 Chromium 栈后（Task 9b），
 * 证书错误变成 `Error('net::ERR_CERT_AUTHORITY_INVALID')`——`code` 与 `cause` 都是 undefined，
 * 错误码**只在 message 里**。故这里额外从 message 里抽出 `net::ERR_*` 再判定
 * （**只认证书类**错误码，见 `CHROMIUM_NET_CODE_RE` 的说明）。
 *
 * `ctx` 用来区分**谁**中止了请求（M7）：
 * - `timedOut`：是**我们自己的**超时信号中止的 → 归类为「连接超时（端口无响应）」。
 * - `cancelled`：是**调用方传入的外部信号**中止的 → 归类为「请求被取消」
 *   （外部取消不是超时，说成「端口无响应」会误导排查方向）。
 */
export function classifyProbeError(
  err: unknown,
  ctx: { timedOut?: boolean; cancelled?: boolean } = {},
): string {
  const { codes, messages, names } = collectCauses(err)
  const has = (code: string): boolean => codes.includes(code)
  if (has('ENOTFOUND') || has('EAI_AGAIN')) return PROBE_ERROR_DNS
  if (has('ECONNREFUSED')) return PROBE_ERROR_REFUSED
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return PROBE_ERROR_TIMEOUT
  if (has('ENETUNREACH') || has('EHOSTUNREACH')) return PROBE_ERROR_UNREACHABLE
  if (codes.some((c) => TLS_CODE_PREFIXES.some((p) => c.startsWith(p)))) return PROBE_ERROR_TLS
  // Chromium 的 net 错误码只出现在 message 里（`code` / `cause` 都是 undefined），
  // 必须单独抽出来判定，否则证书错误会被误报成「连接失败（网络异常或服务未响应）」，
  // 丢掉「可在设置里放行该主机后重试」这个可操作提示。
  if (
    extractChromiumNetCodes(messages).some((c) =>
      TLS_CODE_PREFIXES.some((p) => c.startsWith(p)),
    )
  ) {
    return PROBE_ERROR_TLS
  }
  if (messages.some((m) => TLS_MESSAGE_RE.test(m))) return PROBE_ERROR_TLS
  // 我们自己的超时信号已经触发 → 连接超时。
  if (ctx.timedOut) return PROBE_ERROR_TIMEOUT
  // 异常名含 Timeout（如 `TimeoutError`）→ 连接超时。
  if (names.some((n) => n.includes('Timeout'))) return PROBE_ERROR_TIMEOUT
  // 调用方主动取消 → 请求被取消（**不是**超时）。
  if (ctx.cancelled) return PROBE_ERROR_ABORTED
  // `AbortError`：不是我们自己的超时（那会是 `TimeoutError`）→ 外部取消。
  if (names.some((n) => n === 'AbortError')) return PROBE_ERROR_ABORTED
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

/**
 * 中继链路专用 Cookie（无 token 时也要带，否则中继不认请求）。
 *
 * 键名取自 `shared/constants.ts` 的 `RELAY_COOKIE_KEY`（单一真相源）。
 * 注：`electron/sign.ts` 的 `buildCookie()` 里那一处仍写着字面量 `mode=relay`
 * （Task 3 已审查文件，本轮不动），**Task 24 打包前**统一收敛到本常量。
 */
const RELAY_ONLY_COOKIE = `${RELAY_COOKIE_KEY}=${RELAY_COOKIE_MODE}`

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
 * Node 定时器的最大毫秒数（32 位有符号数上限）。
 *
 * `setTimeout` 的延时**大于**这个值会被折算成 1ms（并打印 `TimeoutOverflowWarning`），
 * 于是「49 天的超时」会变成「1ms 就超时」。故兜底计时器必须夹到这个上限。
 */
const MAX_TIMER_MS = 2147483647

/**
 * 带超时兜底的请求：**绝不让探测挂死**。
 *
 * 为什么要这一层：`init.signal` 能不能真的中止 Chromium 栈的请求，取决于
 * `session.fetch` 的实现（Task 9b 的运行时实测结论见报告）。
 * 万一它**不认** `signal`，光靠 `AbortSignal.timeout()` 就会让探测永远挂着
 * （界面卡在「正在探测」）。故这里额外用 `Promise.race` + 定时器兜底：
 * 无论底层 fetch 认不认 signal，超时一到就一定返回。
 *
 * - 正常路径：fetch 先完成 → 返回响应；
 * - fetch 被 signal 中止 → 返回 fetch 的异常（`AbortError` / `TimeoutError`）；
 * - fetch 不认 signal → 定时器到点，抛 `TimeoutError`（归类为「连接超时」）。
 */
async function fetchWithTimeout(
  doFetch: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }, Math.min(timeoutMs, MAX_TIMER_MS))
  })
  try {
    return await Promise.race([doFetch(url, init), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 探测单条候选。**永远不会抛异常**——失败一律转成 `ok: false` + `error`。
 *
 * 判定规则（控制器裁定，修复轮次 1）：
 * - **可达性只看 HTTP 状态码**：`< 400` 即 `ok: true`，**无论响应体长什么样**。
 * - 业务码**只补充 `error` 文案，不影响 `ok`**：
 *   - `99999` → 可达 + 「token 已失效」；
 *   - 其它数值型非 0 码 → 可达 + 服务端 `msg`（无 msg 记 `code=<n>`）——
 *     实测部分 fnOS 音乐端点会回 `code=100001 unknown error`，服务端明明有响应，
 *     把它判成「不可达」是错的；
 *   - 缺 `code` / `code=null` / 非 JSON / 数组 → 可达，只记一句不误导的说明。
 */
async function probeOne(candidate: Candidate, opts: ProbeOptions): Promise<ProbeResult> {
  const token = typeof opts.token === 'string' ? opts.token : ''
  const loggedIn = token.length > 0
  const isRelay = candidate.isRelay || candidate.kind === 'relay'
  // `opts.timeoutMs` 非法（0 / 负数 / 非有限数）时回落到默认；合法值夹到 AbortSignal 的合法区间。
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs, isRelay)

  const url = probeUrl(candidate, loggedIn)
  const headers: Record<string, string> = { authx: authx('GET', url) }
  const cookie = probeCookie(token, isRelay)
  if (cookie) headers['cookie'] = cookie

  // 我们自己的超时信号（超时后 reason 是 `TimeoutError`）；调用方给了外部信号就并联——
  // 外部取消要报「请求被取消」，不能混成「连接超时（端口无响应）」。
  // 信号在 try 内创建：万一构造失败也不会把异常抛给调用方。
  let timeoutSignal: AbortSignal | undefined
  let raceTimedOut = false
  try {
    timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal

    // 出网通道：注入的 `HttpStack`（Chromium 分区栈）优先，否则全局 `fetch`
    // （在**调用时**解析，故 Vitest 的 `vi.stubGlobal('fetch', …)` 仍然有效）。
    const doFetch = opts.http
      ? (u: string, i: RequestInit): Promise<Response> => opts.http!.fetch(u, i)
      : (u: string, i: RequestInit): Promise<Response> => globalThis.fetch(u, i)

    const res = await fetchWithTimeout(
      doFetch,
      url,
      {
        method: 'GET',
        headers,
        signal,
      },
      timeoutMs,
      () => {
        raceTimedOut = true
      },
    )

    // 状态码是可达性的唯一依据（M5：health 的业务码不可信）。
    if (res.status >= 400) {
      return { candidate, ok: false, error: `HTTP ${res.status}` }
    }

    // 未登录分支只看状态码，不解析业务码。
    if (!loggedIn) return { candidate, ok: true }

    const envelope = await readEnvelope(res)
    if (envelope === null) {
      // 响应体不是 JSON（或不是对象）：服务端**有响应** → 可达，不报错。
      return { candidate, ok: true }
    }

    const code = envelope['code']
    if (code === undefined || code === null) {
      // 不是业务信封（缺 `code` / `code=null`）：服务端**有响应** → 可达。
      // 不写 `error`：这不是失败，附一句说明反而容易被读成「不可达」（见文件头「消费方须知」）。
      return { candidate, ok: true }
    }
    if (typeof code !== 'number' || !Number.isFinite(code)) {
      // 业务码不是数值：同样不是可判定的信封，但服务端有响应 → 可达。
      return { candidate, ok: true }
    }
    if (code === CODE_OK) return { candidate, ok: true }
    if (code === CODE_TOKEN_EXPIRED) {
      // 服务端有响应 → 链路可达；是否先续期由上层决定。
      return { candidate, ok: true, error: PROBE_ERROR_TOKEN_EXPIRED }
    }
    // 其它数值型非 0 码：服务端**有响应**（实测 `code=100001 unknown error`）→ 链路可达；
    // 业务码只补充 `error` 文案，**不影响** `ok`。
    const msg = envelope['msg']
    const reason =
      typeof msg === 'string' && msg.trim() !== '' ? msg : `code=${String(code)}`
    return { candidate, ok: true, error: redact(reason, token) }
  } catch (err) {
    // 区分「我们自己的超时」与「调用方取消」：前者是连接超时，后者是请求被取消。
    const timedOut = raceTimedOut || timeoutSignal?.aborted === true
    const cancelled = !timedOut && opts.signal?.aborted === true
    return { candidate, ok: false, error: classifyProbeError(err, { timedOut, cancelled }) }
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
