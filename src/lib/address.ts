import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT, RELAY_DOMAIN_SUFFIX } from '../../shared/constants'

// ---------------------------------------------------------------------------
// 服务器地址处理（Task 10b 修订轮 / 复审轮）
//
// ⚠️ 背景（控制器 2026-11-03 更正简报 I.6）：
//    `normalizeBase`（`electron/connection.ts`）**只补协议与 `/music` 路径前缀，不补端口**——
//    `192.168.1.10` → `http://192.168.1.10/music` → 请求打到 **80 端口**，
//    而 fnOS 音乐服务在 **5666（http）/ 5667（https）**。
//    因此**渲染进程侧**在把地址交给 `serverInfo()` / `login()` 之前补默认端口。
//
// 三条硬规则：
// 1. **只有用户输入的地址**才补端口——`probe()` 给的候选地址**原样使用**
//    （候选自带端口；中继走 443，乱补 5667 会打错端口）。
// 2. **显式写了端口的地址原样保留**（`nas.local:1234` 用 1234，不改成 5666）。
// 3. **落盘前必须剥掉 userinfo**（`user:pw@host`）——口令绝不进 localStorage，
//    **且与有没有协议无关**（`user:pw@host:5666` 同样要剥）。
//
// ⚠️ 第四条规则（T18-1，真机实测补上）
// 4. **中继域名（`<fnId>.fnos.net`）不补默认端口**：中继只监听标准 HTTPS 端口（443），
//    **不监听** fnOS 音乐服务的 5666 / 5667——补了默认端口就一定连不上。
//    顺带把协议归一到 HTTPS（中继只提供 HTTPS）。
// ---------------------------------------------------------------------------

/** 形如 `scheme://` 的协议前缀（带捕获组，取协议名）。 */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//

/** 拆开一个地址：协议 / authority（`host[:port]`）/ 其余（路径、查询、片段）。 */
interface AddressParts {
  /** 协议前缀（含 `://`），没有协议时是空串。 */
  scheme: string
  /** 协议名（小写，不含 `:`），没有协议时是空串。 */
  schemeName: string
  /** authority：`host[:port]`（可能带 userinfo）。 */
  authority: string
  /** 路径 / 查询 / 片段（含分隔符）。 */
  tail: string
}

/**
 * 把地址拆成「协议 / authority / 其余」三段。
 *
 * ⚠️ userinfo 只可能出现在 **authority** 里；路径里也可能出现 `@`
 *    （`http://host/a@b`），所以不能对整串做全局替换。
 */
function splitAddress(input: string): AddressParts {
  const trimmed = input.trim()
  const schemeMatch = SCHEME_RE.exec(trimmed)
  const scheme = schemeMatch ? schemeMatch[0] : ''
  // ⚠️ `noUncheckedIndexedAccess`：`RegExpExecArray[1]` 的类型是 `string | undefined`。
  const schemeName = (schemeMatch?.[1] ?? '').toLowerCase()
  const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed
  // authority = 到第一个 `/`、`?`、`#` 为止的部分。
  const pathStart = rest.search(/[/?#]/)
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart)
  const tail = pathStart === -1 ? '' : rest.slice(pathStart)
  return { scheme, schemeName, authority, tail }
}

/**
 * 判定 authority（`host[:port]`）里**有没有显式端口**。
 *
 * ⚠️ **不能只看 `new URL(x).port`**：http 的默认端口 80（https 的 443）会被 URL 规范化掉——
 *    `new URL('http://x').port` 与 `new URL('http://x:80').port` **都是空串**，
 *    两者无法区分。这里按**原始输入**判断：host 部分有没有「`:` + 数字」。
 */
function hasExplicitPort(authority: string): boolean {
  // 去掉 userinfo（`user:pw@host:port`）——端口只可能出现在 host 之后。
  const at = authority.lastIndexOf('@')
  const hostPart = at === -1 ? authority : authority.slice(at + 1)
  if (hostPart.startsWith('[')) {
    // IPv6 字面量：`[::1]`（无端口）/ `[::1]:5666`（有端口）。
    const close = hostPart.indexOf(']')
    if (close === -1) return false
    return /^:\d+$/.test(hostPart.slice(close + 1))
  }
  // 未加括号的 IPv6（`::1`）不是合法 URL，按「无端口」处理。
  const colons = hostPart.match(/:/g)?.length ?? 0
  if (colons > 1) return false
  return /:\d+$/.test(hostPart)
}

/**
 * 取 authority 里的 host（去掉 userinfo、端口、IPv6 方括号）。
 *
 * ⚠️ 与 `electron/cert.ts` 的 `normalizeHost` 同语义，但**渲染进程不能 import
 *    `electron/` 下的模块**（那会把 Node 依赖打进渲染 bundle），所以这里独立实现。
 */
function hostOfAuthority(authority: string): string {
  const at = authority.lastIndexOf('@')
  const hostPart = at === -1 ? authority : authority.slice(at + 1)
  // IPv6 字面量：`[::1]` → `::1`。
  if (hostPart.startsWith('[')) {
    const close = hostPart.indexOf(']')
    return close === -1 ? '' : hostPart.slice(1, close).toLowerCase()
  }
  const colon = hostPart.indexOf(':')
  return (colon === -1 ? hostPart : hostPart.slice(0, colon)).toLowerCase()
}

/**
 * 判定 host 是否是 **FN 中继域名**（`<fnId>.fnos.net`）。
 *
 * 真机实测：中继只监听标准 HTTPS 端口（443），
 * **不监听** fnOS 音乐服务的 5666 / 5667。
 */
function isRelayHost(authority: string): boolean {
  const host = hostOfAuthority(authority)
  return host.length > 0 && host.endsWith(RELAY_DOMAIN_SUFFIX)
}

/**
 * 给「用户输入的地址」补默认端口。
 *
 * - 没有显式端口 → 补协议（缺省 `http://`）与该协议的默认端口
 *   （http → `DEFAULT_HTTP_PORT`，https → `DEFAULT_HTTPS_PORT`）；
 * - **中继域名（`<fnId>.fnos.net`）例外**：中继只听 443 → **不补端口**，
 *   并把协议归一到 `https`（用户写 `http://` 也能连上）；
 * - 有显式端口 → **原样返回**（端口一个字符都不改，协议也不改）；
 * - 非 http/https 协议 → 原样返回（主进程会给出「地址无效」的可读错误）。
 *
 * 端口取自 `shared/constants.ts`，**不写字面量**。
 */
export function withDefaultPort(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed

  const { schemeName, authority, tail } = splitAddress(trimmed)
  const protocol = schemeName || 'http'
  if (protocol !== 'http' && protocol !== 'https') return trimmed

  // ⚠️ 显式端口 → 原样保留（`http://x:80` 的 80 不能被规范化掉，也不能被改成 5666）。
  if (hasExplicitPort(authority)) return trimmed

  // ⚠️ 中继域名：**不补默认端口**（T18-1 真机实测：补了 5667 就连不上），
  //    协议按 HTTPS 处理（中继只提供 HTTPS）。
  if (isRelayHost(authority)) return `https://${authority}${tail}`

  const port = protocol === 'https' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT
  // 端口追加在 authority 末尾 —— userinfo（`user:pw@host`）在 '@' 之前，不会被误伤。
  return `${protocol}://${authority}:${port}${tail}`
}

/**
 * 去掉地址里的 userinfo（`http://user:pw@host` → `http://host`）。
 *
 * ⚠️ **userinfo 与有没有协议无关**：`user:pw@host:5666`（无协议）同样要剥——
 *    复审实测过：只锚定 `scheme://` 的写法会让「无协议 + 显式端口」的地址
 *    把口令原样带进偏好存储（localStorage）。
 * ⚠️ 只动 authority 段（`@` 之前的部分）；路径里的 `@` 不受影响。
 */
export function stripUserInfo(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed

  const { scheme, authority, tail } = splitAddress(trimmed)
  const at = authority.lastIndexOf('@')
  if (at === -1) return trimmed
  return `${scheme}${authority.slice(at + 1)}${tail}`
}
