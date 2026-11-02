#!/usr/bin/env node
/**
 * 飞牛 NAS 连接探测工具（独立于 GUI 客户端的联调用 CLI）
 *
 * 用法:
 *   node tools/fn-probe.mjs --fnid <FNID>                 仅探测候选链路
 *   FN_USER=admin FN_PASS=xxx node tools/fn-probe.mjs --fnid <FNID> --login
 *                                                       探测 + 验证登录与只读 API
 *
 * 凭据只从环境变量读取，不落盘、不写入日志。
 */
import { createHash } from 'node:crypto'

const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'
const FN_SIGN_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c'
const MUSIC_SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'
const FN_CON_API = 'https://5ddd.com/api/v1/fn/con'

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

const nonce = () => String(Math.floor(Math.random() * 9e5) + 1e5)
const ts = () => String(Date.now())

/** 取参与签名的路径：完整 URL 取 pathname；纯路径原样保留（FN 连接接口即属此类） */
const pathnameOf = (u) => {
  try {
    return new URL(u).pathname
  } catch {
    return new URL(u, 'http://local').pathname
  }
}

function authx(method, url, body, key, nonce, ts) {
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
  const sign = md5([SIGN_PREFIX, pathnameOf(url), nonce, ts, payload, key].join('_'))
  return `nonce=${nonce}&timestamp=${ts}&sign=${sign}`
}

const args = process.argv.slice(2)
const getArg = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const wantLogin = args.includes('--login')
const fnId = getArg('fnid')

if (!fnId) {
  console.error('用法: node tools/fn-probe.mjs --fnid <FNID> [--login]')
  process.exit(1)
}

async function fetchConnectionParams() {
  const body = JSON.stringify({ fnId })
  const res = await fetch(FN_CON_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/api/v1/fn/con', body, FN_SIGN_KEY, nonce(), ts()),
    },
    body,
    signal: AbortSignal.timeout(15000),
  })
  const json = await res.json().catch(() => null)
  if (!json) throw new Error(`FN 接口返回非 JSON (HTTP ${res.status})`)
  return json
}

function buildCandidates(params) {
  const out = []
  const httpPort = params.port?.httpPort ?? 5666
  const httpsPort = params.port?.httpsPort ?? 5667
  const pushIp = (ip, kind, label) => {
    out.push({ address: `http://${ip}:${httpPort}`, label: `HTTP ${label}`, kind, isRelay: false })
    out.push({ address: `https://${ip}:${httpsPort}`, label: `HTTPS ${label}`, kind, isRelay: false })
  }
  for (const ip of params.ipv4 ?? []) pushIp(ip, 'lan', `内网 ${ip}`)
  for (const ip of params.publicIpv6 ?? []) pushIp(`[${ip}]`, 'public', `公网v6 ${ip}`)
  for (const ip of params.publicIpv4 ?? []) pushIp(ip, 'public', `公网v4 ${ip}`)
  const relays = params.fn?.length ? params.fn : [`${fnId}.5ddd.com:443`]
  for (const r of relays) {
    const domain = String(r).replace(/:\d+$/, '')
    out.push({ address: `https://${domain}`, label: `HTTPS 中继 ${domain}`, kind: 'relay', isRelay: true })
  }
  return out
}

async function probe(candidate) {
  const timeout = candidate.isRelay ? 10000 : 3000
  const cookie = candidate.isRelay ? 'mode=relay' : ''
  const started = Date.now()
  try {
    const res = await fetch(`${candidate.address}/music/api/v1/health`, {
      headers: cookie ? { cookie } : undefined,
      signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    const ms = Date.now() - started
    let code = null
    try {
      code = JSON.parse(text).code
    } catch {
      /* 非 JSON 响应 */
    }
    return { ...candidate, ok: res.status < 400 && (code === null || code === 0), status: res.status, code, ms }
  } catch (e) {
    return { ...candidate, ok: false, error: e.cause?.code ?? e.name ?? e.message, ms: Date.now() - started }
  }
}

async function main() {
  console.log(`=== FN 连接参数 (fnId=${fnId}) ===`)
  const con = await fetchConnectionParams()
  console.log(`code=${con.code} msg=${con.msg ?? ''}`)
  if (con.code !== 0) {
    console.log('原始响应:', JSON.stringify(con).slice(0, 400))
    process.exit(1)
  }
  const data = con.data ?? {}
  console.log('内网 IPv4 :', data.ipv4 ?? [])
  console.log('公网 IPv4 :', data.publicIpv4 ?? [])
  console.log('公网 IPv6 :', data.publicIpv6 ?? [])
  console.log('中继域名  :', data.fn ?? [])
  console.log('端口      :', JSON.stringify(data.port ?? {}))

  const candidates = buildCandidates(data)
  console.log(`\n=== 并行探测 ${candidates.length} 条候选 ===`)
  const results = await Promise.all(candidates.map(probe))
  for (const r of results) {
    const mark = r.ok ? 'OK  ' : 'FAIL'
    const extra = r.ok ? `HTTP ${r.status} code=${r.code} ${r.ms}ms` : `${r.error ?? ''} ${r.ms}ms`
    console.log(`[${mark}] ${r.kind.padEnd(6)} ${r.address.padEnd(38)} ${extra}`)
  }

  const best = results.find((r) => r.ok)
  if (!best) {
    console.log('\n所有候选均不可达。')
    return
  }
  console.log(`\n=== 命中链路: ${best.address} (${best.label}) ===`)

  const cookie = best.isRelay ? 'mode=relay' : ''
  const cfgRes = await fetch(`${best.address}/music/api/v1/sys/config`, {
    headers: cookie ? { cookie } : undefined,
    signal: AbortSignal.timeout(10000),
  })
  const cfg = await cfgRes.json().catch(() => null)
  if (cfg?.code === 0) {
    const d = cfg.data ?? {}
    console.log('服务器名称 :', d.serverName ?? '(无)')
    console.log('服务器版本 :', d.serverVersion ?? '(无)')
    console.log('NAS OAuth  :', d.nasOAuth?.clientId ? '支持 (clientId 已下发)' : '不支持')
  } else {
    console.log('sys/config 失败:', JSON.stringify(cfg ?? cfgRes.status).slice(0, 200))
  }

  if (!wantLogin) {
    console.log('\n（加 --login 并设置 FN_USER / FN_PASS 可继续验证登录与只读 API）')
    return
  }

  const user = process.env.FN_USER
  const pass = process.env.FN_PASS
  if (!user || !pass) {
    console.log('\n未提供 FN_USER / FN_PASS，跳过登录验证。')
    return
  }

  const deviceId = createHash('sha256').update(`${user}:${Date.now()}`).digest('hex').slice(0, 32)
  const loginBody = JSON.stringify({ username: user, password: sha256(pass), deviceId })
  const loginRes = await fetch(`${best.address}/music/api/v1/user/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authx: authx('POST', '/api/v1/user/password-login', loginBody, MUSIC_SIGN_KEY, nonce(), ts()), ...(cookie ? { cookie } : {}) },
    body: loginBody,
    signal: AbortSignal.timeout(15000),
  })
  const login = await loginRes.json().catch(() => null)
  console.log(`\n=== 密码登录 (${user}) ===`)
  console.log('code=', login?.code, 'msg=', login?.msg ?? '')
  if (login?.code !== 0) {
    console.log('→ 该账号不是飞牛音乐独立账号，或密码错误。改用「NAS 账号 OAuth 登录」路径。')
    return
  }
  const token = login.data?.userToken
  console.log('拿到 music-token:', token ? `${token.slice(0, 8)}…（长度 ${token.length}）` : '(无)')

  const authCookie = token ? (best.isRelay ? `music-token=${token}; mode=relay` : `music-token=${token}`) : cookie
  const call = async (path) => {
    const url = `${best.address}${path}`
    const res = await fetch(url, {
      headers: { authx: authx('GET', url, undefined, MUSIC_SIGN_KEY, nonce(), ts()), cookie: authCookie },
      signal: AbortSignal.timeout(15000),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  const me = await call('/music/api/v1/user/me')
  console.log('user/me      :', me.json?.code === 0 ? `code=0 用户=${me.json.data?.user?.username ?? '?'}` : `code=${me.json?.code} ${me.json?.msg ?? ''}`)

  for (const [label, path] of [
    ['专辑列表', '/music/api/v1/album/list?page=1&size=5'],
    ['歌曲列表', '/music/api/v1/track/list?page=1&size=5'],
    ['歌手列表', '/music/api/v1/artist/list?page=1&size=5'],
    ['风格列表', '/music/api/v1/genre/list?page=1&size=5'],
    ['歌单列表', '/music/api/v1/playlist/list?page=1&size=5'],
    ['收藏列表', '/music/api/v1/favorite-track/list?page=1&size=5'],
  ]) {
    const r = await call(path)
    const d = r.json?.data
    const n = d?.list?.length
    const total = d?.total
    console.log(`${label.padEnd(6)}: code=${r.json?.code} 返回=${n ?? '-'} 条 total=${total ?? '-'}${r.json?.msg ? ` msg=${r.json.msg}` : ''}`)
  }
}

main().catch((e) => {
  console.error('探测失败:', e)
  process.exit(1)
})
