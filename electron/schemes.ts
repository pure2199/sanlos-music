// ---------------------------------------------------------------------------
// 自定义 scheme 的**统一注册**（Task 13：E2E 冒烟发现的阻断缺陷修复）
// ---------------------------------------------------------------------------
//
// ⚠️⚠️⚠️ **Electron 的 `protocol.registerSchemesAsPrivileged()` 只能调用一次**：
//    第二次调用会**静默覆盖**第一次的注册结果——Electron 文档原文：
//    *"This method can only be used before the ready event … and can be called
//    only once. As a result - you're silently overwriting previously defined
//    schemes with your own, without warning."*
//
// ---------------------------------------------------------------------------
// 真实踩坑（本项目原本就中招了）
// ---------------------------------------------------------------------------
// 主进程原本注册了**两次**：先 `fnm`（NAS 代理），再 `fnml`（本地媒体）——
// 于是 `fnm` 的特权被 `fnml` **覆盖掉**。后果极其隐蔽：
//
// - **主进程照常工作**：`protocol.handle()` 是**显式**注册，与特权无关 →
//   `net.fetch('fnm://…')` 正常返回 200；
// - **渲染进程里坏了**：Blink 的 scheme 白名单里**没有** `fnm`
//   → `fetch('fnm://…')` 直接抛 `TypeError: Failed to fetch`
//     + 控制台 `URL scheme "fnm" is not supported`；
// - ⇒ **整个曲库都拉不出来**（登录能成，因为登录走主进程 IPC，不走 `fnm://`）；
// - ⇒ 而**单元测试全绿**（jsdom 没有自定义协议，替身也不模拟「只能注册一次」），
//   单测**根本够不到**这一层——只有真起一个 Electron 进程才会暴露。
//
// ⇒ 本模块把两个 scheme **合并成一次**注册，谁都不覆盖谁。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 两个 scheme 都**不出网**：`fnm` 由主进程代理转发到 NAS，`fnml` 只读本地磁盘；
// - 特权**不放宽**：`standard` + `secure` + `supportFetchAPI` + `stream` + `corsEnabled`
//   ——`corsEnabled` 是**必须**的（CVE-2026-70604：`supportFetchAPI` 不配
//   `corsEnabled` 会让远程页面跨源读本地资源）；
// - 本模块**不 import Electron**（顶层），协议模块一律**惰性解析**（可单测）。

// ---------------------------------------------------------------------------
// 类型（从 `electron/proxy.ts` 搬到这里——它们是「scheme 注册」这件事的形状）
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
  /** 注册 scheme 特权（**只能在 app ready 之前调用**，且**全局只能调用一次**）。 */
  registerSchemesAsPrivileged(schemes: ProtocolSchemeRegistration[]): void
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** NAS 代理 scheme（渲染进程唯一的出网出口）。 */
export const FNM_SCHEME = 'fnm'

/** 本地媒体 scheme（已下载的音频文件）。 */
export const FNML_SCHEME = 'fnml'

/**
 * 两个自定义 scheme 共用的特权。
 *
 * ⚠️ `corsEnabled: true` **不是可选项**：`supportFetchAPI` 一旦开启，
 *    Chromium 就会对该 scheme 施加 CORS 校验 → 协议处理器**必须**回
 *    `Access-Control-Allow-Origin`（`electron/proxy.ts` 与
 *    `electron/localMedia.ts` 都已带）。
 */
export const APP_SCHEME_PRIVILEGES: ProtocolPrivileges = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true,
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
 * 取不到任何 API；此时返回 `null`，由调用方给出可读错误。
 */
export function resolveElectronProtocol(): ProtocolLike | null {
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
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册**一批** scheme 特权（**一次调用**）。
 *
 * ⚠️ 整个进程里**只能调用一次**——Electron 会用这次调用的内容**覆盖**
 *    之前注册过的 scheme。故这里刻意做成「批量」接口：调用方要把几个 scheme
 *    一起注册，就**必须**放进同一个数组。
 *
 * @param schemes 要注册的 scheme 列表。
 * @param protocol `protocol` 替身；缺省时惰性取 Electron 的 `protocol`。
 */
export function registerSchemePrivileges(
  schemes: ProtocolSchemeRegistration[],
  protocol?: ProtocolLike,
): void {
  const target = protocol ?? resolveElectronProtocol()
  if (!target) {
    throw new Error('自定义 scheme 特权注册失败：当前进程没有可用的 Electron protocol 模块')
  }
  target.registerSchemesAsPrivileged(schemes)
}

/**
 * 注册**应用的全部**自定义 scheme（**唯一的、正确的注册入口**）。
 *
 * ⚠️ **主进程启动时只应调用本函数一次**（且必须在 `app.whenReady()` 之前）。
 *    任何「再加一个 scheme」的改动都**必须**改这里（加进同一个数组），
 *    **不许**再单独调一次 `registerSchemesAsPrivileged`——那会覆盖掉别的 scheme。
 */
export function registerAppSchemes(protocol?: ProtocolLike): void {
  registerSchemePrivileges(
    [
      { scheme: FNM_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } },
      { scheme: FNML_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } },
    ],
    protocol,
  )
}
