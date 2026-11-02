// 地址归一化与 FN Connect 候选构造。
//
// 职责边界（计划 Task 4）：
// - 本模块只负责「算出候选」，**不做并行探测与超时控制**（那是 Task 9 的职责）。
// - 不依赖 Electron API（保持可在 Vitest / Node 下直接单测），只用标准 Web API。
//
// 三条实测约束（改错任何一条都会让 FN ID 接入失败）：
// - M1：中继域名是 `<fnId>.fnos.net`，**不是** `.5ddd.com`
//   （`5ddd.com` 只是 FN 连接接口自身的服务域名）。
//   `fn` 数组非空时**必须优先使用接口返回值**，仅在数组为空时回退到 `${fnId}${RELAY_DOMAIN_SUFFIX}`。
// - M4：FN 连接接口参与签名的是**纯路径** `/api/v1/fn/con`，不是完整 URL。
// - M8：服务端当前**不校验** authx 签名，但这里仍按上游语义显式传 `{ key: FN_SIGN_KEY }`
//   （官方客户端会发这个头；将来网关若加强校验，行为不会突变）。

import {
  FN_CON_API,
  FN_CON_PATH,
  FN_SIGN_KEY,
  MUSIC_PATH,
  RELAY_DOMAIN_SUFFIX,
} from '../shared/constants'
import type { ConnectionKind } from '../shared/types'
import { authx } from './sign'

/** FN 连接接口返回的连接参数（已归一化）。 */
export interface ConnectionParams {
  /** 内网 IPv4（直连优先，速度最快）。 */
  internalIPv4s: string[]
  /** 公网 IPv4。 */
  publicIPv4s: string[]
  /** 公网 IPv6（不带方括号）。 */
  publicIPv6s: string[]
  /** HTTPS 端口。 */
  httpsPort: number
  /** HTTP 端口。 */
  httpPort: number
  /** 中继地址，形如 `<fnId>.fnos.net:443`。 */
  relayAddresses: string[]
}

/** 一条候选连接链路。 */
export interface Candidate {
  /** 链路基址（不含 `/music`）。 */
  address: string
  /** 界面展示名。 */
  label: string
  /** 链路类型：内网直连 / 公网直连 / FN 中继。 */
  kind: ConnectionKind
  /** 是否走 FN 中继（中继请求需附 `mode=relay` Cookie）。 */
  isRelay: boolean
}

/** 默认 HTTP 端口（实测与规格一致）。 */
const DEFAULT_HTTP_PORT = 5666

/** 默认 HTTPS 端口（实测与规格一致）。 */
const DEFAULT_HTTPS_PORT = 5667

/** 中继端口（回退地址用）。 */
const RELAY_PORT = 443

/** FN 连接接口单次请求上限（与上游参考实现一致）。只约束这一次请求，候选探测超时属 Task 9。 */
const FN_CON_TIMEOUT_MS = 15000

/** 形如 `scheme://` 的协议前缀。 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/** 是否是普通对象（数组与 null 都不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取字符串数组；非数组或元素类型不对时返回空数组。 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** 取端口；缺失或非法时用默认值。 */
function asPort(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.trunc(n)
}

/**
 * 归一化服务器基址为 `<scheme>://<host>[:port]/music`。
 *
 * - 缺协议时补 `http://`（直连默认 HTTP 是为了避开自签证书校验）。
 * - 路径为空或不是 `/music` 结尾时归一为 `/music`；以 `/music` 结尾的路径原样保留
 *   （兼容反向代理挂在子路径下的部署）。
 * - 去掉尾部斜杠；无法解析时返回空串。
 */
export function normalizeBase(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `http://${trimmed}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return ''
  }
  const path = u.pathname.replace(/\/+$/, '')
  const basePath =
    path === '' || !path.endsWith(MUSIC_PATH) ? MUSIC_PATH : path
  return `${u.protocol}//${u.host}${basePath}`
}

/**
 * 取 URL 的主机名：小写、IPv6 去掉方括号、不含端口。
 *
 * 用于「只放行用户填写的服务器 host」的证书信任策略（Task 9）。
 */
export function hostOf(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  } catch {
    return ''
  }
}

/**
 * 解析 FN 连接接口返回的连接参数。
 *
 * 同时兼容两种入参：接口信封 `{ code, msg, data }` 与裸的 `data` 载荷。
 * 字段缺失或类型不对时回落为空数组与默认端口 5666 / 5667。
 */
export function parseConnectionParams(json: unknown): ConnectionParams {
  const root = isPlainObject(json) ? json : {}
  // 信封入参带 `data` 时取 `data`，否则把入参本身当载荷。
  const data = isPlainObject(root.data) ? root.data : root
  const port = isPlainObject(data.port) ? data.port : {}
  return {
    internalIPv4s: asStringArray(data.ipv4),
    publicIPv4s: asStringArray(data.publicIpv4),
    publicIPv6s: asStringArray(data.publicIpv6),
    httpPort: asPort(port.httpPort, DEFAULT_HTTP_PORT),
    httpsPort: asPort(port.httpsPort, DEFAULT_HTTPS_PORT),
    relayAddresses: asStringArray(data.fn),
  }
}

/**
 * 构造候选链路列表，顺序即优先级：
 * 内网 IPv4 → 公网 IPv6 → 公网 IPv4 → 中继。
 *
 * - 每个 IP 先生成 `http`（httpPort）再生成 `https`（httpsPort）；IPv6 地址加方括号。
 * - 中继**只生成 HTTPS**，并去掉 `:443` 端口后缀。
 * - 中继地址优先取接口返回的 `fn` 数组，为空时回退到 `<fnId>.fnos.net`（实测修正 M1）。
 */
export function buildCandidates(fnId: string, params: ConnectionParams): Candidate[] {
  const out: Candidate[] = []
  const pushIp = (ip: string, kind: ConnectionKind, label: string): void => {
    out.push({
      address: `http://${ip}:${params.httpPort}`,
      label: `HTTP ${label}`,
      kind,
      isRelay: false,
    })
    out.push({
      address: `https://${ip}:${params.httpsPort}`,
      label: `HTTPS ${label}`,
      kind,
      isRelay: false,
    })
  }
  for (const ip of params.internalIPv4s) pushIp(ip, 'lan', `内网 ${ip}`)
  for (const ip of params.publicIPv6s) pushIp(`[${ip}]`, 'public', `公网v6 ${ip}`)
  for (const ip of params.publicIPv4s) pushIp(ip, 'public', `公网v4 ${ip}`)
  const relays = params.relayAddresses.length
    ? params.relayAddresses
    : [`${fnId}${RELAY_DOMAIN_SUFFIX}:${RELAY_PORT}`]
  for (const relay of relays) {
    const domain = String(relay).replace(/:\d+$/, '')
    out.push({
      address: `https://${domain}`,
      label: `HTTPS 中继 ${domain}`,
      kind: 'relay',
      isRelay: true,
    })
  }
  return out
}

/**
 * 请求 FN 连接接口，拿回候选地址所需的连接参数。
 *
 * 该接口**只需要 FN ID，不需要账号密码**。签名用 FN 连接接口专用密钥 `FN_SIGN_KEY`
 * 与纯路径 `FN_CON_PATH`（实测修正 M4/M8）。
 */
export async function fetchConnectionParams(fnId: string): Promise<ConnectionParams> {
  const body = JSON.stringify({ fnId })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FN_CON_TIMEOUT_MS)
  try {
    const res = await fetch(FN_CON_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authx: authx('POST', FN_CON_PATH, body, { key: FN_SIGN_KEY }),
      },
      body,
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as {
      code?: number
      msg?: string
      data?: unknown
    } | null
    if (!json) throw new Error(`FN 连接接口返回非 JSON (HTTP ${res.status})`)
    if (json.code !== 0) {
      throw new Error(`FN 连接接口失败: code=${json.code} msg=${json.msg ?? ''}`)
    }
    return parseConnectionParams(json.data ?? json)
  } finally {
    clearTimeout(timer)
  }
}
