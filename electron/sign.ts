// authx 签名模块（纯函数，不依赖 Electron API，可在 Node / Vitest 下直接单测）。
//
// 三条实测约束（改错任何一条，服务端会返回 HTML 错误页而非 JSON）：
// - M3：nonce / timestamp **只生成一次**，同一对值既参与签名计算又拼进返回的请求头。
//   重复调用 nonce()/ts() 会让签名里的 nonce 与请求头里的对不上。
// - M4：参与签名的路径，完整 URL 取 pathname，纯路径原样保留
//   （FN 连接接口用纯路径 /api/v1/fn/con，音乐接口用完整 URL 的 pathname）。
// - 签名密钥不可混用：音乐接口用 SIGN_KEY，FN 连接接口用 FN_SIGN_KEY。
//
// 重要前提（M8，2026-11-02 真实 NAS 实测）：**服务端目前不校验 authx 签名**
// （GET / POST 用全零伪造签名均返回 code=0），中继链路的硬性关卡是
// `Cookie` 头里的 `mode=relay`——那条由 Task 7（登录）/ Task 8（代理转发）负责。
// 本模块仍按上游语义生成并发送 authx（官方 Web 端会发，某些网关可能加强校验），
// 因此下文的签名细节属于**保真度**要求，而非当前服务端接受度或安全性的依赖。

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { SIGN_PREFIX, SIGN_KEY, MUSIC_TOKEN_COOKIE, RELAY_COOKIE_MODE } from '../shared/constants'

/** authx 可选参数：nonce / ts 用于测试注入固定值，key 用于切换签名密钥。 */
export interface AuthxOptions {
  /** 6 位数字 nonce，缺省时随机生成。 */
  nonce?: string
  /** 毫秒时间戳字符串，缺省时取当前时间。 */
  ts?: string
  /** 签名密钥，缺省为音乐接口的 SIGN_KEY；FN 连接接口必须显式传 FN_SIGN_KEY。 */
  key?: string
}

/** MD5（十六进制小写）。 */
export const md5 = (input: string): string =>
  createHash('md5').update(input, 'utf8').digest('hex')

/** SHA-256（十六进制小写）。 */
export const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex')

/** 6 位数字 nonce。 */
const newNonce = (): string => String(Math.floor(Math.random() * 9e5) + 1e5)

/** 毫秒时间戳。 */
const newTs = (): string => String(Date.now())

/**
 * 取参与签名的路径：完整 URL 取 pathname，纯路径原样保留。
 *
 * 注意 `new URL('/api/v1/x')` 会抛异常，必须有 catch 分支用 base 兜底。
 */
export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return new URL(url, 'http://local').pathname
  }
}

/**
 * GET 请求参与签名的规范查询串：参数名升序、值经 encodeURIComponent 编码、
 * `+` 替换为 `%20`，最后整体 decodeURIComponent。
 *
 * 空值参数（如 `k=`）**保留**，只丢弃值为字面量 `'undefined'` / `'null'` 的参数——
 * 这与上游参考实现（`tools/fn-probe.mjs`、`tools/fn-api-probe.mjs`）语义一致。
 *
 * 选择理由（M9）：官方 Web 端按此语义发送，某些网关或服务端将来可能加强校验，
 * 实现应与上游行为一致以免将来行为突变。实测（M8）服务端当前并不校验 authx，
 * 空值参数计入与否都不影响接受度，故这是保真度选择而非正确性依赖。
 */
function canonicalQuery(url: string): string {
  // 纯路径（如 /api/v1/x?a=1）没有 base 会抛异常，统一用 'http://local' 兜底。
  const u = new URL(url, 'http://local')
  const sorted = new URLSearchParams()
  for (const k of [...new Set(u.searchParams.keys())].sort()) {
    for (const v of u.searchParams.getAll(k)) {
      if (v === 'undefined' || v === 'null') continue
      sorted.append(k, v)
    }
  }
  return sorted.toString().replace(/\+/g, '%20')
}

/**
 * 计算参与签名的 payload 摘要：GET 取规范查询串的 MD5，非 GET 取请求体的 MD5。
 */
export function signPayload(method: string, url: string, body?: string | Uint8Array): string {
  if (method.toUpperCase() !== 'GET') {
    // body 为 undefined / null 时按空串签名（与上游参考实现的 md5(body ?? '') 一致）。
    if (body == null) return md5('')
    const raw = typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
    return md5(raw)
  }
  const encoded = canonicalQuery(url)
  try {
    return md5(decodeURIComponent(encoded.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')))
  } catch {
    return md5(encoded)
  }
}

/**
 * 生成 authx 请求头值：`nonce=<n>&timestamp=<t>&sign=<md5>`。
 *
 * nonce 与 timestamp 只在这里生成一次（M3）：同一对值既参与签名计算，也拼进返回值。
 */
export function authx(
  method: string,
  url: string,
  body?: string | Uint8Array,
  opts: AuthxOptions = {},
): string {
  const n = opts.nonce ?? newNonce()
  const t = opts.ts ?? newTs()
  // 空串密钥视为未指定，回退到音乐接口密钥（`??` 不会把 '' 当成缺省）。
  const key = opts.key || SIGN_KEY
  const sign = md5(
    [SIGN_PREFIX, pathnameOf(url), n, t, signPayload(method, url, body), key].join('_'),
  )
  return `nonce=${n}&timestamp=${t}&sign=${sign}`
}

/** 凭证 Cookie：token 与中继模式合并在同一个 Cookie 头里。 */
export const buildCookie = (token: string, isRelay: boolean): string =>
  isRelay
    ? `${MUSIC_TOKEN_COOKIE}=${token}; mode=${RELAY_COOKIE_MODE}`
    : `${MUSIC_TOKEN_COOKIE}=${token}`
