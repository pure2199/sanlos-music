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
    bumpTrustEpoch(): void {
      epoch += 1
    },
    partitionName,
  }
}

export { TrustedHosts }
