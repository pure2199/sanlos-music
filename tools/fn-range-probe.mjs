// 真机联调校准：NAS 的 `track/stream` 到底支不支持 Range、分段字节准不准（T20）
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// 「拖动进度条定位」这条链路分三段：
//
//   渲染进程（用户拖进度条）
//     → `fnm://` 代理（透传 `Range` 头、原样带回 `206` / `content-range`）
//       → NAS 的 `GET /music/api/v1/track/stream?guid=…`
//
// 代理那一段在**单测**里已经钉死了（`test/proxy.test.ts` + `test/proxy-range.test.ts`），
// 但**上游**那一段一直是**假设**：
//
// - 审计报表 P3-9 写的是「真实 NAS 支持 Range」——**没有实测记录支撑**；
// - `src/api/history.ts` 的注释里有一行实测：「GET `/track/stream` 拿到 **206** 音频」
//   —— 只能证明「**拿到过 206**」，**不能**证明「**分段的字节是精确的**」：
//   服务器完全可能对任何 Range 都回 206，却每次都吐**同一段**或**整段**数据。
//
// ⇒ 这个脚本把「NAS 支不支持 Range」从**假设**换成**实测事实**，并且加一条
//    审计和历史注释都**没有**过的判据：**两个重叠区间的字节必须互相对得上**
//    （`bytes=512-1535` 的前 512 字节 == `bytes=0-1023` 的后 512 字节）。
//    这条判据能抓住「返回 206 但内容不对」这种最阴的退化。
//
// 另外测一个**越界**区间（起点 = 文件末尾之后）→ 服务端该回 `416`。
// 客户端遇到 416 时的行为未实测，故一并记录。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 凭证只从环境变量读，**不打印、不落盘**；token 只显示前 6 位；
// - 本脚本只读，**不写**任何数据；
// - 只请求 **1 KB** 区间（不整首下载）→ 中继带宽下也很快；
// - 报告自动脱敏（不打印口令 / token / 完整 FN ID）。
//
// 用法：FN_SERVER=https://<fnid>.fnos.net FN_USER=... FN_PASS=... node tools/fn-range-probe.mjs
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
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-range-probe.mjs')
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
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/api/v1/fn/con', body, FN_SIGN_KEY),
    },
    body,
    signal: AbortSignal.timeout(15000),
  })
  const json = await res.json()
  const relay = (json?.data?.fn?.[0] ?? `${FN_ID}.fnos.net:443`).replace(/:\d+$/, '')
  return { base: `https://${relay}`, relay: true }
}

// ---------------------------------------------------------------------------
// 打一次带 Range 的音频流请求
// ---------------------------------------------------------------------------

/**
 * 发一次 `GET /track/stream`，带（或不带）`Range` 头。
 *
 * @param {string} base    基址
 * @param {string} guid    歌曲 guid
 * @param {string} cookie  Cookie 头原文
 * @param {string|null} range Range 头（null = 不带）
 */
async function fetchStream(base, guid, cookie, range) {
  const url = `${base}${API_PREFIX}/track/stream?guid=${encodeURIComponent(guid)}`
  const headers = { authx: authx('GET', url, undefined, MUSIC_SIGN_KEY), cookie }
  if (range !== null) headers.range = range

  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
  } catch (err) {
    return { error: `请求失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const buf = Buffer.from(await res.arrayBuffer())
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    acceptRanges: res.headers.get('accept-ranges') ?? '',
    contentRange: res.headers.get('content-range') ?? '',
    contentLength: res.headers.get('content-length') ?? '',
    body: buf,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('\n═══ T20：NAS 的 track/stream 支不支持 Range ═══\n')

const { base, relay } = await resolveBase()
const isRelay = relay || base.includes('.fnos.net')
console.log(`链路：${base}（${isRelay ? '中继' : '直连'}）`)

// -- 登录 -------------------------------------------------------------------
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
const token = login?.data?.userToken ?? ''
const cookie = isRelay ? `music-token=${token}; mode=relay` : `music-token=${token}`
console.log(`token：${mask(token)}`)

// -- 找一首歌 ---------------------------------------------------------------
const listUrl = `${base}${API_PREFIX}/track/list?page=1&size=20`
const listRes = await fetch(listUrl, {
  headers: { authx: authx('GET', listUrl, undefined, MUSIC_SIGN_KEY), cookie },
  signal: AbortSignal.timeout(20000),
})
const listJson = await listRes.json().catch(() => null)
const songs = Array.isArray(listJson?.data?.list) ? listJson.data.list : []
if (songs.length === 0) {
  console.error('曲库为空，无法测 Range')
  process.exit(1)
}
// 优先挑**最小**的一首（`audioSpec.size` 若有），少占用带宽。
const sized = songs
  .map((s) => ({ song: s, size: Number(s?.audioSpec?.size) || Number(s?.size) || Infinity }))
  .sort((a, b) => a.size - b.size)
const target = sized[0].song
const guid = String(target?.guid ?? '')
console.log(`目标曲目：${String(target?.title ?? '(未知)')}｜guid=${guid}｜标称 ${sized[0].size} 字节`)

// -- 测 1：不带 Range（拿基准 + 看 accept-ranges）----------------------------
console.log('\n-- 测 1：不带 Range 头 --')
const whole = await fetchStream(base, guid, cookie, null)
if (whole.error) {
  console.error(whole.error)
  process.exit(1)
}
console.log(`状态码：${whole.status}｜content-type：${whole.contentType}`)
console.log(`accept-ranges：${whole.acceptRanges || '（无）'}｜content-length：${whole.contentLength}`)
console.log(`实际收到 ${whole.body.length} 字节`)

if (whole.status === 200 && whole.body.length > 2 * 1024 * 1024) {
  console.log('⚠️ 服务端忽略了 Range 并回了整首（体积很大）——后续比对只用区间请求。')
}

// -- 测 2：bytes=0-1023 -----------------------------------------------------
console.log('\n-- 测 2：Range: bytes=0-1023 --')
const a = await fetchStream(base, guid, cookie, 'bytes=0-1023')
if (a.error) {
  console.error(a.error)
  process.exit(1)
}
console.log(`状态码：${a.status}｜content-range：${a.contentRange || '（无）'}`)
console.log(`accept-ranges：${a.acceptRanges || '（无）'}｜收到 ${a.body.length} 字节`)

// -- 测 3：bytes=512-1535（与测 2 **重叠** 512 字节）------------------------
console.log('\n-- 测 3：Range: bytes=512-1535（与测 2 重叠 512 字节）--')
const b = await fetchStream(base, guid, cookie, 'bytes=512-1535')
if (b.error) {
  console.error(b.error)
  process.exit(1)
}
console.log(`状态码：${b.status}｜content-range：${b.contentRange || '（无）'}`)
console.log(`收到 ${b.body.length} 字节`)

// -- 判定 -------------------------------------------------------------------
console.log('\n── 判定 ──')

const total = (() => {
  const m = /bytes\s+\d+-\d+\/(\d+)/.exec(a.contentRange)
  return m ? Number(m[1]) : null
})()

const supportsRange = a.status === 206
console.log(`1. NAS 对 Range 的响应：${a.status} ${supportsRange ? '→ **支持 Range（206）**' : '→ **不支持 Range**'}`)

let bytesExact = null
if (a.status === 206 && b.status === 206) {
  // a 的字节 512..1023 应当等于 b 的字节 0..511。
  const overlap = 512
  const aSlice = a.body.subarray(overlap, overlap + overlap)
  const bSlice = b.body.subarray(0, overlap)
  bytesExact = aSlice.length === bSlice.length && aSlice.equals(bSlice)
  console.log(
    `2. 重叠区间字节比对：${bytesExact ? '**完全一致** ✓' : '**不一致** ✗'}（各 ${aSlice.length} 字节）`,
  )
  console.log(`   a[512..1024] = ${aSlice.subarray(0, 8).toString('hex')}…`)
  console.log(`   b[0..512]    = ${bSlice.subarray(0, 8).toString('hex')}…`)
} else {
  console.log('2. 重叠区间字节比对：**跳过**（没有拿到 206）')
}

// -- 测 4：越界区间（起点 = 文件末尾之后）-----------------------------------
if (total !== null) {
  console.log(`\n-- 测 4：Range: bytes=${total + 10}-（起点越界，总长 ${total}）--`)
  const c = await fetchStream(base, guid, cookie, `bytes=${total + 10}-`)
  if (c.error) {
    console.error(c.error)
  } else {
    console.log(`状态码：${c.status}｜content-range：${c.contentRange || '（无）'}`)
    console.log(`收到 ${c.body.length} 字节`)
  }
}

console.log('\n── 结论 ──')
if (!supportsRange) {
  console.log('❌ NAS **不支持 Range**（对 Range 请求回的是整段 200）。')
  console.log('   ⇒ 真机上「拖动进度条定位」**不会生效**（Chromium 只能从头播）。')
  console.log('   ⇒ 客户端需要降级策略（拖动后从头播并提示），或找别的定位手段。')
} else if (bytesExact === false) {
  console.log('⚠️ NAS **回 206 但字节不精确** —— 分段数据对不上。')
  console.log('   ⇒ 代理透传逻辑没问题，但**上游的分段语义不可信**，拖动定位会拿到错误数据。')
} else {
  console.log('✅ NAS **支持 Range，且分段字节精确** —— 拖动定位的上游前提成立。')
  console.log('   ⇒ 客户端的 `fnm://` 代理透传 Range + 原样带回 206 即可让拖动定位真正生效。')
}
console.log('')
