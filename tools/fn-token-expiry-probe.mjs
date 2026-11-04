// 真机联调校准：token 失效时服务端到底怎么回（T19-1）
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// 客户端的**静默续期**路径（`electron/session.ts` 的 `request()`）只在**一个**条件下触发：
//
//   响应体是 JSON  **且**  `code === 99999`（`shared/constants.ts` 的 `CODE_TOKEN_EXPIRED`）
//
// 这个「99999」目前**只来自规格**（设计文档 §2.1）与 mock server —— **从未在真服务端验证过**。
// 而 Step C 之所以一直标着「真机无法验证」，是因为服务端**不提供**「作废当前 token」的接口，
// 没法「等 token 自然过期」。
//
// ⇒ 但可以**反过来**做：**故意带上错的 token** 去打受保护端点。
//    服务端看来这就是「token 对不上」——与「token 过期」是同一件事。
//
// 结论只有三种：
//   A. 业务码 = 99999（JSON）        → 客户端契约成立 ✓
//   B. 业务码 = 别的值                → 客户端的续期**永远不会被触发**（潜在 bug：
//                                      token 真过期时用户会直接看到报错，而不是静默续期）
//   C. 响应**不是 JSON**（HTML 兜底页）→ 客户端**连业务码都读不到**（`readJson` 返回 null），
//                                      续期同样不会触发
//
// 另外还测一个**对照**（有效 token + 不存在的端点），用来区分「token 错误码」与「普通错误码」。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 凭证只从环境变量读，**不打印、不落盘**；
// - 本脚本只读，**不写**任何数据；
// - 报告里所有 token 都只显示前 6 位（足够定位，不泄露）。
//
// 用法：FN_SERVER=https://<fnid>.fnos.net FN_USER=... FN_PASS=... node tools/fn-token-expiry-probe.mjs
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'

const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'
const MUSIC_SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'
const FN_SIGN_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c'
const FN_CON_API = 'https://5ddd.com/api/v1/fn/con'
const API_PREFIX = '/music/api/v1'

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const FN_ID = process.env.FN_ID ?? ''
const FN_SERVER = process.env.FN_SERVER ?? ''
if (!FN_USER || !FN_PASS) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-token-expiry-probe.mjs')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 签名（与 `electron/sign.ts` 同形）
// ---------------------------------------------------------------------------

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const nonce = () => String(Math.floor(Math.random() * 9e5) + 1e5)
const ts = () => String(Date.now())

function pathnameOf(u) {
  try {
    return new URL(u).pathname
  } catch {
    return new URL(u, 'http://local').pathname
  }
}

function authx(method, url, body, key) {
  const n = nonce()
  const t = ts()
  const payload =
    method.toUpperCase() === 'GET'
      ? md5(
          (() => {
            const u = new URL(url, 'http://local')
            const sorted = new URLSearchParams()
            for (const k of [...new Set(u.searchParams.keys())].sort()) {
              for (const v of u.searchParams.getAll(k)) {
                if (v !== 'undefined' && v !== 'null') sorted.append(k, v)
              }
            }
            const enc = sorted.toString().replace(/\+/g, '%20')
            try {
              return decodeURIComponent(enc.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'))
            } catch {
              return enc
            }
          })(),
        )
      : md5(body ?? '')
  return `nonce=${n}&timestamp=${t}&sign=${md5([SIGN_PREFIX, pathnameOf(url), n, t, payload, key].join('_'))}`
}

/** token 只显示前 6 位。 */
function mask(token) {
  const text = String(token ?? '')
  if (text.length === 0) return '（空）'
  return text.length <= 6 ? '（太短）' : `${text.slice(0, 6)}…（${text.length} 字符）`
}

// ---------------------------------------------------------------------------
// 链路与登录
// ---------------------------------------------------------------------------

/** 解析基址：优先 FN_SERVER，否则走 FN CON 探测中继。 */
async function resolveBase() {
  if (FN_SERVER) return { base: FN_SERVER.replace(/\/+$/, ''), relay: false }
  if (!FN_ID) throw new Error('需要 FN_SERVER 或 FN_ID 之一')
  const body = JSON.stringify({ fnId: FN_ID })
  const res = await fetch(FN_CON_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authx: authx('POST', '/api/v1/fn/con', body, FN_SIGN_KEY) },
    body,
    signal: AbortSignal.timeout(15000),
  })
  const json = await res.json()
  const relay = (json?.data?.fn?.[0] ?? `${FN_ID}.fnos.net:443`).replace(/:\d+$/, '')
  return { base: `https://${relay}`, relay: true }
}

// ---------------------------------------------------------------------------
// 打一次受保护端点
// ---------------------------------------------------------------------------

/**
 * 打一次受保护端点，返回「服务端怎么回的」的完整描述。
 *
 * @param {string} base    基址
 * @param {string} path    API 相对路径（不含 `/music/api/v1`）
 * @param {string} cookie  Cookie 头原文（可为 null = 不带 Cookie）
 */
async function callProtected(base, path, cookie) {
  const url = `${base}${API_PREFIX}/${path}`
  const headers = { authx: authx('GET', url, undefined, MUSIC_SIGN_KEY) }
  if (cookie !== null) headers.cookie = cookie

  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  } catch (err) {
    return { error: `请求失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 不是 JSON */
  }
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    json,
    code: typeof json?.code === 'number' ? json.code : null,
    msg: typeof json?.msg === 'string' ? json.msg : '',
    isJson: json !== null,
    // 非 JSON 时给一小段正文（足以认出「SPA 兜底页」）
    head: json === null ? text.slice(0, 120).replace(/\s+/g, ' ') : '',
    length: text.length,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('\n═══ Step C 补测：token 失效时服务端怎么回 ═══\n')

const { base, relay } = await resolveBase()
const isRelay = relay || base.includes('.fnos.net')
console.log(`链路：${base}（${isRelay ? '中继' : '直连'}）`)

// -- 登录，拿到一个**有效** token ------------------------------------------------
const deviceId = createHash('sha256').update(`${FN_USER}:${Date.now()}`).digest('hex').slice(0, 32)
const loginBody = JSON.stringify({ username: FN_USER, password: sha256(FN_PASS), deviceId })
const loginRes = await fetch(`${base}${API_PREFIX}/user/password-login`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authx: authx('POST', `${base}${API_PREFIX}/user/password-login`, loginBody, MUSIC_SIGN_KEY),
    cookie: isRelay ? 'mode=relay' : '',
  },
  body: loginBody,
  signal: AbortSignal.timeout(15000),
})
const loginText = await loginRes.text()
let login = null
try {
  login = JSON.parse(loginText)
} catch {
  console.error(`登录返回非 JSON（HTTP ${loginRes.status}）：${loginText.slice(0, 200)}`)
  process.exit(1)
}
if (login?.code !== 0) {
  console.error(`登录失败：code=${login?.code} msg=${login?.msg}`)
  process.exit(1)
}
const token = login.data.userToken
console.log(`✓ 登录成功，拿到有效 token：${mask(token)}\n`)

// -- 造几个「错的 token」---------------------------------------------------------
const flipped = `${token.slice(0, -1)}${token.slice(-1) === 'a' ? 'b' : 'a'}`
const random32 = createHash('sha256').update(`random-${Date.now()}`).digest('hex').slice(0, 32)

/** 每一组：给 Cookie 头（null = 不带）。 */
const cases = [
  { label: '基线：有效 token', cookie: `music-token=${token}${isRelay ? '; mode=relay' : ''}`, kind: 'control' },
  { label: '对照：有效 token + 不存在的端点', cookie: `music-token=${token}${isRelay ? '; mode=relay' : ''}`, kind: 'control', path: 'definitely-not-a-real-endpoint' },
  { label: '随机 32 位十六进制 token', cookie: `music-token=${random32}${isRelay ? '; mode=relay' : ''}`, kind: 'invalid' },
  { label: '有效 token 改最后一个字符', cookie: `music-token=${flipped}${isRelay ? '; mode=relay' : ''}`, kind: 'invalid' },
  { label: '空 token', cookie: `music-token=${isRelay ? '; mode=relay' : ''}`, kind: 'invalid' },
  { label: '只有中继 Cookie（没有 music-token）', cookie: isRelay ? 'mode=relay' : '', kind: 'invalid' },
  // ⚠️ **客户端到不了这个状态**：`buildCookie()` 永远会带上 `music-token=<token>`
  //    （哪怕 token 是空串）。故它只是「服务端边界行为」的记录，**不参与判定**。
  { label: '完全不带 Cookie 头（客户端到不了）', cookie: null, kind: 'boundary' },
]

console.log('用例'.padEnd(34) + 'HTTP  业务码   说明')
console.log('─'.repeat(78))

const results = []
for (const item of cases) {
  const path = item.path ?? 'track/list?page=1&size=1'
  const r = await callProtected(base, path, item.cookie)
  results.push({ item, r })
  const codeText = r.code === null ? (r.isJson ? '(无 code 字段)' : '(非 JSON)') : String(r.code)
  let note = ''
  if (r.error) note = r.error
  else if (!r.isJson) note = `非 JSON 响应（${r.type || '无类型'}）${r.head ? `｜${r.head}` : ''}`
  else note = r.msg || ''
  console.log(
    `${item.label.padEnd(30)} ${String(r.status ?? '-').padEnd(6)} ${codeText.padEnd(9)} ${note.slice(0, 44)}`,
  )
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------

console.log('\n【结论】')
// ⚠️ 只判「客户端真能碰到的」那些用例（客户端永远会带 `music-token=<token>`）。
const invalid = results.filter((x) => x.item.kind === 'invalid')
const nonJson = invalid.filter((x) => x.r.isJson === false)
const codes = [...new Set(invalid.map((x) => x.r.code))]
const statuses = [...new Set(invalid.map((x) => x.r.status))]

if (nonJson.length > 0) {
  console.log('  ✗ **C**：有', nonJson.length, '个「错误 token」用例返回的不是 JSON')
  console.log('    → 客户端 `readJson()` 拿不到业务码 → **静默续期不会触发**（token 真过期时用户直接看到报错）')
} else if (codes.length === 1 && codes[0] === 99999) {
  console.log('  ✓ **A**：所有「错误 token」用例都返回业务码 99999 → 客户端契约成立')
  console.log('    → `CODE_TOKEN_EXPIRED = 99999` 与真服务端一致，静默续期路径可用')
  console.log(`    → 实测 HTTP 状态：${statuses.join(' / ')}（**客户端不按状态码判定**，只读 body 里的业务码 → 401 照样能续期）`)
} else if (codes.length === 1) {
  console.log(`  ✗ **B**：所有「错误 token」用例都返回业务码 ${codes[0]}（**不是 99999**）`)
  console.log('    → 客户端等的是 99999 → **静默续期永远不会被触发**')
  console.log('    → 需要改：`shared/constants.ts` 的 `CODE_TOKEN_EXPIRED` 与 `electron/session.ts` 的判定')
} else {
  console.log(`  ✗ **B**：「错误 token」用例返回了**多个不同的码**：${codes.join(' / ')}`)
  console.log('    → 服务端对 token 失效的表达不唯一 → 客户端按单一码判定的做法不可靠')
}

const boundary = results.filter((x) => x.item.kind === 'boundary')
for (const b of boundary) {
  console.log(
    `  ℹ 边界（客户端到不了）：${b.item.label} → HTTP ${b.r.status ?? '-'}｜` +
      (b.r.isJson ? `业务码 ${b.r.code}` : `非 JSON（${b.r.type || '无类型'}，fnOS SPA 兜底页）`),
  )
}

const control = results.find((x) => x.item.label.startsWith('对照'))
if (control && control.r.code !== null) {
  console.log(
    `  对照组（有效 token + 不存在的端点）返回业务码 ${control.r.code}` +
      (codes.includes(control.r.code) ? ' ← **与 token 错误码相同**，说明服务端不区分这两种错误' : ''),
  )
}
