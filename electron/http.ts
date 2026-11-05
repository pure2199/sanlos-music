// 主进程出网通道：**Chromium 分区 session**（Task 9b）。
//
// ---------------------------------------------------------------------------
// 为什么需要这个模块（Task 10 复审发现的架构级问题）
// ---------------------------------------------------------------------------
// `setCertificateVerifyProc` 挂在 **Chromium 网络栈**上，而 Node 的全局 `fetch`
// （undici）走的是 **Node 的 HTTP 栈**——它**根本不受** `setCertificateVerifyProc` 管辖。
// 于是「只对用户填写的 host 放行自签证书」这件事整套空转：
// 证书校验要么由 undici 自己按系统信任库做（自签必然失败，且**没有**放行入口），
// 要么就得全局 `callback(0)`（**绝不允许**：那会让所有站点都跳过校验）。
//
// 规格 §15.9 的实测结论（本设计的全部依据）：
// - `net.fetch` / `session.fetch` 走 Chromium 网络栈 → 受 `setCertificateVerifyProc` 管辖；
// - Chromium 按 `host:port` **缓存证书错误**：第一次握手失败后，即使后来放行，
//   `clearCache()` / `clearHostResolverCache()` 都**清不掉**；
// - **换一个 partition** 后重试同一 `host:port` → **成功**（新分区有独立的证书错误缓存）。
//
// 故本模块的设计是：
// 1. 分区名带一个**信任版本号**：`fn-nas-v<epoch>`；`epoch` 每次 +1 就换一个分区；
// 2. 每个分区注册自己的 verify proc：`callback(trusted.verify(request.hostname))`
//    —— 命中受信集合放行（`0`），**未命中一律 `-3`**（交回 Chromium 默认校验，
//    其余站点照常校验，绝不全局放行）；
// 3. `bumpTrustEpoch()` 在**信任集合真的变了**时调用（判断依据是
//    `TrustedHosts.add()` 的返回值），此后用新分区，从而绕开旧分区缓存的证书错误。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串。
//   故 Electron 相关对象一律**惰性解析**（`resolveElectronSession()`），
//   并允许通过 `opts.session` 注入替身（与 `proxy.ts` 的 `opts.protocol`、
//   `ipc.ts` 的 `opts.ipcMain` 同一套接缝写法）。
// - 单测环境下没有 Electron → 回落到 `opts.fetchImpl` 或全局 `fetch`
//   （全局 fetch 在**调用时**解析，故 Vitest 的 `vi.stubGlobal('fetch', …)` 仍然有效）。
// - 不引入新依赖；只用标准 Web API。

import { Readable } from 'node:stream'

import { TrustedHosts } from './cert'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** Chromium 会话（Electron `session` 模块里用到的最小接口）。 */
export interface ElectronSessionLike {
  /**
   * 取一个分区会话。
   *
   * @param partition 分区名（Electron 里 `persist:` 前缀的会话才是持久化的；
   *   本模块用**非持久**分区，故名字里不带 `persist:`）。
   * @param options 分区选项；本模块固定用 `{ cache: false }`。
   */
  fromPartition(partition: string, options?: { cache?: boolean }): ElectronSessionPartitionLike
}

/** 一个分区会话（Electron `Session` 里用到的最小接口）。 */
export interface ElectronSessionPartitionLike {
  /** 走 Chromium 网络栈发请求（**不是** Node 的 undici fetch）。 */
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
  /** 注册证书校验回调；`0` 放行、`-3` 交回 Chromium 默认校验。 */
  setCertificateVerifyProc(
    proc: (request: { hostname: string }, callback: (result: number) => void) => void,
  ): void
}

/**
 * Electron `net` 模块的最小接口（只用到 `request`）。
 *
 * ⚠️ **为什么二进制路径要绕开 `session.fetch`**（T56 实测根因）：
 *    `session.fetch` 会把上游响应头塞进 **undici 的 `Headers`** ⇒
 *    **ByteString 校验**（每个字符必须 ≤ 255）；而 Chromium 把响应头按 **UTF-8** 解码
 *    ⇒ 上游一旦回一个带中文的头（实测 NAS 转码产物的
 *    `Content-Disposition: attachment; filename="占位曲目一 - 占位歌手二.mp3"`），
 *    就抛 `TypeError`，且**抛在事件回调里** ⇒ 主进程未捕获异常
 *    （弹「A JavaScript error occurred in the main process」），
 *    同时那个请求**永远不会返回** ⇒ 代理的二进制路径挂死。
 *    ⇒ `net.request` 的响应头是**普通字符串记录**，**不经过** ByteString 校验。
 */
export interface ElectronNetLike {
  /**
   * 发一个请求。
   *
   * @param options `session` 传当前分区 ⇒ **证书放行语义与 `session.fetch` 一致**
   *   （自签 NAS 照常能用；`setCertificateVerifyProc` 照样生效）。
   */
  request(options: {
    url: string
    method: string
    headers: Record<string, string>
    session?: unknown
  }): ElectronNetClientRequestLike
}

/** `net.request` 返回的请求对象（只用到「事件」与「写入」）。 */
export interface ElectronNetClientRequestLike {
  on(event: 'response', listener: (response: ElectronNetResponseLike) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  write(chunk: string): void
  end(): void
}

/**
 * `net.request` 的响应（Electron 的 `IncomingMessage`：Node Readable + 状态码 + 头）。
 *
 * ⚠️ `headers` 的值**可以含非 ASCII**（Chromium 的 UTF-8 解码结果）——
 *    这正是它比 undici 的 `Headers` 安全的地方。
 */
export interface ElectronNetResponseLike extends Readable {
  statusCode: number
  headers: Record<string, string | string[]>
}

/**
 * 上游流式响应的最小形状（T56）。
 *
 * ⚠️ **响应头是「普通记录」而不是 undici 的 `Headers`**：
 *    `Headers.set` 会做 ByteString 校验，而上游头**可能含中文**
 *    ⇒ **绝不**把上游响应头塞进 `Headers`。
 */
export interface UpstreamStream {
  /** 上游状态码（`206` 必须原样保留）。 */
  readonly status: number
  /** 上游响应头（**键统一小写**；值是普通字符串，**可以**含非 ASCII）。 */
  readonly headers: Readonly<Record<string, string>>
  /** 响应体（流式；无体时为 `null`）。 */
  readonly body: ReadableStream<Uint8Array> | null
}

/** 出网请求的入参。 */
export type HttpStackInput = string | URL | Request

/**
 * 主进程出网通道。
 *
 * - `fetch`：走 Chromium 分区栈（Electron 运行时）或全局 fetch（单测 / 无 Electron）；
 * - `bumpTrustEpoch()`：信任集合变化后调用，此后换新分区。
 */
export interface HttpStack {
  /**
   * 发一次请求。
   *
   * @param input URL（或已构造好的 `Request`——二进制流式路径要带上签名与凭证 Cookie）。
   * @param init 请求选项（方法 / 头 / 体 / `signal`）。
   */
  fetch(input: HttpStackInput, init?: RequestInit): Promise<Response>
  /**
   * **流式**取上游（T56 新增）。
   *
   * ⚠️ **二进制路径必须用它，不要用 `fetch`**：`fetch` 走 `session.fetch`，
   *    它把上游响应头塞进 undici 的 `Headers` ⇒ **ByteString 校验**；
   *    而 Chromium 按 UTF-8 解码响应头 ⇒ 上游一旦回带中文的头就会崩
   *    （详见 `UpstreamStream` 的说明）。
   *    `stream` 走 Electron 的 `net.request`：响应头是**普通字符串记录**，
   *    **不经过** ByteString 校验。
   *
   * - **可选**：缺席时（第三方替身）由调用方回落到 `fetch`，行为与 T56 之前一致。
   */
  stream?(request: Request): Promise<UpstreamStream>
  /**
   * 信任版本 +1（**此后**换新分区）。
   *
   * 只在信任集合**真的变了**时调用（`TrustedHosts.add()` 返回 `true`）——
   * 每次登录都 bump 会白白丢掉 Chromium 的连接池。
   */
  bumpTrustEpoch(): void
  /** 当前分区名（诊断用：`fn-nas-v<epoch>`）。 */
  partitionName(): string
}

/** `createHttpStack` 的可选参数。 */
export interface HttpStackOptions {
  /** 受信 host 集合；缺省时内部 new 一个。 */
  trusted?: TrustedHosts
  /** 初始信任版本号；缺省 `0`。 */
  epoch?: number
  /** 分区名前缀；缺省 `fn-nas`（最终分区名 = `<前缀>-v<epoch>`，即 `fn-nas-v0`）。 */
  partitionPrefix?: string
  /** 回落用的 fetch（Electron 不可用时用）；缺省时用全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /** Electron `session` 模块替身（**单测接缝**）；缺省时惰性取真的。 */
  session?: ElectronSessionLike
  /**
   * Electron `net` 模块替身（**单测接缝**）；缺省时惰性取真的。
   *
   * ⚠️ 只有 `stream()`（二进制路径）会用到它；`net` 拿不到时 `stream()` 回落到 fetch。
   */
  net?: ElectronNetLike
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 分区名前缀（最终分区名 = `<前缀>-v<epoch>`，缺省即 `fn-nas-v0`）。
 */
export const DEFAULT_PARTITION_PREFIX = 'fn-nas'

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
 * 惰性取 Electron 的 `session` 模块（**不在模块顶层调用**）。
 *
 * 非 Electron 进程（Vitest / 普通 Node）里 `require('electron')` 返回的是可执行文件路径字符串，
 * 取不到任何 API；此时返回 `null`，由调用方退回注入的替身或全局 `fetch`。
 */
function resolveElectronSession(): ElectronSessionLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { session?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const session = (mod as { session?: unknown }).session
    if (typeof session !== 'object' || session === null) return null
    return session as ElectronSessionLike
  } catch {
    return null
  }
}

/**
 * 惰性取 Electron 的 `net` 模块（**不在模块顶层调用**）。
 *
 * ⚠️ 与 `session` 同样的道理：非 Electron 进程里 `require('electron')` 取不到 API
 * ⇒ 返回 `null`，由调用方回落到 fetch。
 */
function resolveElectronNet(): ElectronNetLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as { net?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const net = (mod as { net?: unknown }).net
    if (typeof net !== 'object' || net === null) return null
    return net as ElectronNetLike
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 上游响应头的承载方式（T56）
// ---------------------------------------------------------------------------

/** `Headers` → 普通记录（键统一小写）。 */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value
  })
  return record
}

/**
 * `net.request` 的响应头 → 普通记录（键统一小写；重复头用 `, ` 连接）。
 *
 * ⚠️ 值**保留原样**（**可以**含非 ASCII）—— 这正是它绕开 ByteString 校验的关键。
 */
function normalizeNetHeaders(
  headers: Record<string, string | string[]> | undefined,
): Record<string, string> {
  const record: Record<string, string> = {}
  if (!headers) return record
  for (const [name, value] of Object.entries(headers)) {
    record[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return record
}

/**
 * 用 Electron 的 `net.request` 流式取一次上游（T56）。
 *
 * ⚠️ **为什么不用 `fetch`**：见 `UpstreamStream` 的说明（ByteString 崩溃）。
 *
 * @param request 上游请求（已带签名与凭证 Cookie）。
 * @param ses     当前分区 session（⇒ 证书放行语义与 `session.fetch` 一致）。
 * @param net     Electron 的 `net` 模块。
 */
async function streamViaNet(
  request: Request,
  ses: unknown,
  net: ElectronNetLike,
): Promise<UpstreamStream> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    headers[name] = value
  })
  // ⚠️ 请求体只能读一次：先读成字符串，`net.request` 再写出去。
  const bodyText = request.body ? await request.text() : null

  const clientRequest = net.request({
    url: request.url,
    method: request.method,
    headers,
    session: ses,
  })

  return await new Promise<UpstreamStream>((resolve, reject) => {
    let settled = false
    clientRequest.on('response', (response) => {
      settled = true
      resolve({
        status: response.statusCode,
        headers: normalizeNetHeaders(response.headers),
        body: Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>,
      })
    })
    clientRequest.on('error', (error: Error) => {
      if (!settled) reject(error)
    })
    if (bodyText !== null) clientRequest.write(bodyText)
    clientRequest.end()
  })
}

// ---------------------------------------------------------------------------
// createHttpStack
// ---------------------------------------------------------------------------

/**
 * 创建一个出网通道（Chromium 分区栈）。
 *
 * - **Electron 运行时里**：请求走 `session.fromPartition('fn-nas-v<epoch>')`，
 *   该分区上注册了 verify proc（只放行 `trusted` 里的 host）。
 * - **没有 Electron 时**（单测）：回落到 `opts.fetchImpl` 或全局 `fetch`。
 *
 * ⚠️ **不要全局 `callback(0)`**：未登记的 host 一律 `-3`，其余站点照常校验。
 */
export function createHttpStack(opts: HttpStackOptions = {}): HttpStack {
  const trusted = opts.trusted ?? new TrustedHosts()
  const prefix = opts.partitionPrefix ?? DEFAULT_PARTITION_PREFIX
  let epoch = opts.epoch ?? 0

  /** 已创建的分区会话（按分区名缓存：同名分区只创建、只注册一次 verify proc）。 */
  const partitions = new Map<string, ElectronSessionPartitionLike>()

  /** 当前分区名（`<前缀>-v<epoch>`）。 */
  function partitionName(): string {
    return `${prefix}-v${epoch}`
  }

  /** 取当前分区会话；没有 Electron 时返回 `null`。 */
  function currentPartition(): ElectronSessionPartitionLike | null {
    const mod = opts.session ?? resolveElectronSession()
    if (!mod || typeof mod.fromPartition !== 'function') return null

    const name = partitionName()
    const cached = partitions.get(name)
    if (cached) return cached

    const ses = mod.fromPartition(name, { cache: false })
    try {
      ses.setCertificateVerifyProc((request, callback) => {
        // ⚠️ 命中受信集合 → 放行（0）；未命中 → -3（交回 Chromium 默认校验）。
        //    **绝不**无条件 `callback(0)`：那会让所有站点都跳过证书校验。
        callback(trusted.verify(request.hostname))
      })
    } catch {
      // 同一个分区上重复注册 verify proc 会抛错（Electron 的限制）。
      // 此时该分区**已经有**一个 verify proc 在生效，忽略即可；
      // 正常流程下每个分区只会被创建一次（见上面的缓存）。
    }
    partitions.set(name, ses)
    return ses
  }

  /** 取 `net` 模块：注入优先 → 惰性取真的。 */
  function currentNet(): ElectronNetLike | null {
    return opts.net ?? resolveElectronNet()
  }

  return {
    async fetch(input: HttpStackInput, init?: RequestInit): Promise<Response> {
      const ses = currentPartition()
      if (ses) {
        // Electron 的 `session.fetch` 接受 `string | Request`；
        // `Request` 入参用于二进制流式路径（签名与凭证 Cookie 都已经在 Request 里）。
        return await ses.fetch(input as string | Request, init)
      }
      // 无 Electron（单测 / 普通 Node）：回落到注入的 fetch 或全局 fetch。
      // ⚠️ 全局 fetch 在**调用时**解析，故 Vitest 的 `vi.stubGlobal('fetch', …)` 仍然有效。
      const impl = opts.fetchImpl ?? globalThis.fetch
      return await impl(input as RequestInfo, init)
    },
    /**
     * **流式**取上游（T56）：Electron 运行时里走 `net.request`。
     *
     * ⚠️ **不走 `session.fetch`**：它会把上游响应头塞进 undici 的 `Headers`
     *    ⇒ ByteString 校验 ⇒ 上游回带中文的头就崩（详见 `UpstreamStream`）。
     */
    async stream(request: Request): Promise<UpstreamStream> {
      const ses = currentPartition()
      const net = currentNet()
      if (ses && net) {
        return await streamViaNet(request, ses, net)
      }
      // 回落：无 Electron（单测）→ 注入的 fetchImpl / 全局 fetch。
      // ⚠️ 这里**不预读 body**（预读会把请求体消费掉）——直接把 Request 交给 fetch。
      const impl = opts.fetchImpl ?? globalThis.fetch
      const res = await impl(request as RequestInfo)
      return { status: res.status, headers: headersToRecord(res.headers), body: res.body }
    },
    bumpTrustEpoch(): void {
      epoch += 1
    },
    partitionName,
  }
}

export { TrustedHosts }
