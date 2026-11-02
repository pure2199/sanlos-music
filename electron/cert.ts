// 证书信任策略：只对「用户填写的服务器 host」放行自签 / 非受信证书。
//
// 职责边界（计划 Task 9）：
// - 本模块只提供**受信 host 集合**的判定，**不含 Electron API 调用**：
//   调用方（主进程）在 `session.setCertificateVerifyProc((req, cb) => cb(trusted.verify(req.hostname)))`
//   里把返回值交给 Electron 即可。`-3` 是 Electron 的约定值，表示「交给 Chromium 默认校验」，
//   `0` 表示放行。
// - **绝不做全局「忽略所有证书错误」**：未登记的 host 一律返回 -3，
//   其余站点照常校验（规格 §6「仅放行用户填写的 host，其他站点仍严格校验」）。
// - 模块顶层**不 import Electron**（本文件要在 Vitest / Node 下直接单测）。
//
// 分工（重要，别在这里扩大放行范围）：
// - 「**谁**要被放行」由调用方决定（Task 10 的设置流程）：用户填写的服务器 host；
//   若用户填的是 FN ID，还要把由该 FN ID 推导出的中继域名 `<fnId>.fnos.net` 一并登记。
// - 本模块只负责把 URL / host 归一成规范形态并**精确匹配**：
//   没有通配符、没有后缀匹配——放行范围严格等于用户填写的那个 host。
//
// 受信集合**不落盘**：持久化是 Task 10 / 11 的职责。

import { hostOf } from './connection'

/** 命中受信集合：放行该 host 的证书校验。 */
export const VERIFY_ACCEPT = 0

/** 未命中受信集合：交给 Chromium 默认校验（Electron 约定值 -3）。 */
export const VERIFY_REJECT = -3

/**
 * 把 URL / host 归一成受信集合使用的规范形态。
 *
 * 规则（只有这三条，别加通配符）：
 * 1. **去端口**：`nas.local:5666` → `nas.local`（端口不同也算同一个 host）。
 *    —— 信任粒度是 **host 级**：登记 `nas.local:5666` 也会信任 `nas.local:8443`。
 *    这是控制器明文要求的「去端口」，本轮不改，仅备注。
 * 2. **去 IPv6 方括号**：`[2409::1]` → `2409::1`。
 * 3. **小写归一**：比较时大小写不敏感（`NAS.Local` → `nas.local`）。
 *
 * 完整 URL（含 `://`）走 `hostOf` 取 hostname，顺带丢掉路径、查询串与 userinfo；
 * 裸 host 走同一个解析器；只有 `hostOf` 解析不了的**裸 IPv6 字面量**（如 `2409::1`）
 * 才走 IPv6 兜底分支——**该分支只接受真正能解析成 IPv6 字面量的输入**。
 */
export function normalizeHost(input: string): string {
  const raw = input.trim().toLowerCase()
  if (!raw) return ''
  const viaUrl = hostOf(raw)
  if (viaUrl) return viaUrl
  // hostOf 解析失败：只可能是裸 IPv6 字面量或非法输入。
  if (raw.includes('://')) return ''
  return bareIpv6Host(raw)
}

/**
 * 裸 IPv6 字面量兜底：只有**真正能解析成 IPv6 字面量**的输入才被接受。
 *
 * 做法：套上中括号交给 URL 解析器（`new URL('http://[2409::1]')`）。
 * 解析器会严格校验 IPv6 结构，于是
 * - `2409::1`、`::`、`2409:0:0:0:0:0:0:1` → 接受（并给出**规范形式**）；
 * - `::::`、`nas.local:5666:extra`、`fe80::1%25eth0`、`2409::1]` → 一律拒绝（返回空串）。
 *
 * 拒绝的输入**不进受信集合**（`add` 忽略它），也不会被 `verify` 命中。
 * 返回规范形式（去方括号）而不是原样字符串，是为了让「裸字面量」与
 * 「方括号 / URL 形式」归一到同一个键（Chromium 的 `req.hostname` 也是规范形式）。
 */
function bareIpv6Host(raw: string): string {
  // IPv6 字面量至少含两个冒号；少于两个的一定不是 IPv6。
  if ((raw.match(/:/g) ?? []).length < 2) return ''
  try {
    const u = new URL(`http://[${raw}]`)
    const host = u.hostname.toLowerCase()
    if (!host.startsWith('[') || !host.endsWith(']')) return ''
    return host.slice(1, -1)
  } catch {
    return ''
  }
}

/**
 * 受信 host 集合。
 *
 * 用法：
 * ```ts
 * const trusted = new TrustedHosts()
 * trusted.add('https://nas.local:5666/music')   // 登记用户填写的服务器 host
 * trusted.verify('nas.local')                   // → 0（放行）
 * trusted.verify('evil.com')                    // → -3（照常校验）
 * ```
 */
export class TrustedHosts {
  /** 已登记的规范 host（小写、无端口、无方括号）。 */
  private readonly trusted = new Set<string>()

  /**
   * 登记一个 host。
   *
   * 入参可以是完整 URL（`https://nas.local:5666/music`）、`host:port`（`nas.local:5666`）
   * 或裸 host / 裸 IPv6（`nas.local`、`2409::1`）。
   * 解析不出 host 的输入（空串、非法 URL）会被忽略，不会污染集合。
   */
  add(url: string): void {
    const host = normalizeHost(url)
    if (!host) return
    this.trusted.add(host)
  }

  /**
   * 判定某个 host 是否受信。
   *
   * @param hostname 待判定的主机名，可带端口或 IPv6 方括号（会被归一后再比较）。
   * @returns 命中返回 `0`（放行），未命中返回 `-3`（照常校验）。
   */
  verify(hostname: string): number {
    const host = normalizeHost(hostname)
    if (host && this.trusted.has(host)) return VERIFY_ACCEPT
    return VERIFY_REJECT
  }
}
