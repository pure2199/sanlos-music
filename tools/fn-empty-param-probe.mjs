#!/usr/bin/env node
/**
 * 空值查询参数语义验证：用真实 NAS 判定服务端规范串是否把 `k=`（空值）计入。
 *
 * 背景：authx 的 GET 规范串对空值参数的处理有两种可能——保留（上游参考实现
 * tools/fn-probe.mjs 的做法）或丢弃。若服务端把空值计入，则客户端必须保留；
 * 反之必须丢弃。此脚本用同一 URL 分别按两种语义签名并请求服务端，用返回码判定。
 *
 * 用法: FN_USER=xxx FN_PASS=xxx node tools/fn-empty-param-probe.mjs --fnid <FNID>
 */
import { createHash } from 'node:crypto'

const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'
const MUSIC_SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'
const FN_SIGN_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c'
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const nonce = () => String(Math.floor(Math.random() * 9e5) + 1e5)
const ts = () => String(Date.now())
const pathnameOf = (u) => {
  try {
    return new URL(u).pathname
  } catch {
    return new URL(u, 'http://local').pathname
  }
}

/** mode: 'keep' 保留空值（上游语义）｜'drop' 丢弃空值 */
function canonical(url, mode) {
  const u = new URL(url)
  const sorted = new URLSearchParams()
  for (const k of [...new Set(u.searchParams.keys())].sort()) {
    for (const v of u.searchParams.getAll(k)) {
      if (v === 'undefined' || v === 'null') continue
      if (mode === 'drop' && v === '') continue
      sorted.append(k, v)
    }
  }
  const enc = sorted.toString().replace(/\+/g, '%20')
  try {
    return decodeURIComponent(enc.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'))
  } catch {
    return enc
  }
}
function authx(method, url, body, mode = 'keep') {
  const n = nonce()
  const t = ts()
  const payload = method.toUpperCase() === 'GET' ? md5(canonical(url, mode)) : md5(body ?? '')
  return `nonce=${n}&timestamp=${t}&sign=${md5([SIGN_PREFIX, pathnameOf(url), n, t, payload, MUSIC_SIGN_KEY].join('_'))}`
}

const args = process.argv.slice(2)
const fnId = args[args.indexOf('--fnid') + 1]
const user = process.env.FN_USER
const pass = process.env.FN_PASS
if (!fnId || !user || !pass) {
  console.error('用法: FN_USER=xxx FN_PASS=xxx node tools/fn-empty-param-probe.mjs --fnid <FNID>')
  process.exit(1)
}

async function main() {
  const conBody = JSON.stringify({ fnId })
  const con = await (
    await fetch('https://5ddd.com/api/v1/fn/con', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authx: authx('POST', '/api/v1/fn/con', conBody, 'keep') },
      body: conBody,
      signal: AbortSignal.timeout(15000),
    })
  ).json()
  const relay = (con.data?.fn?.[0] ?? `${fnId}.fnos.net:443`).replace(/:\d+$/, '')
  const base = `https://${relay}`

  const deviceId = createHash('sha256').update(`${user}:${Date.now()}`).digest('hex').slice(0, 32)
  const loginBody = JSON.stringify({ username: user, password: sha256(pass), deviceId })
  const login = await (
    await fetch(`${base}/music/api/v1/user/password-login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authx: authx('POST', '/music/api/v1/user/password-login', loginBody, 'keep'),
        cookie: 'mode=relay',
      },
      body: loginBody,
      signal: AbortSignal.timeout(15000),
    })
  ).json()
  if (login.code !== 0) throw new Error(`登录失败 code=${login.code} msg=${login.msg}`)
  const cookie = `music-token=${login.data.userToken}; mode=relay`
  console.log(`链路: ${base}（中继）｜登录成功\n`)

  const probe = async (label, path, mode) => {
    const url = `${base}${path}`
    const res = await fetch(url, {
      headers: { authx: authx('GET', url, undefined, mode), cookie },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    const verdict = json ? `code=${json.code}` : `非JSON(HTTP ${res.status})`
    console.log(`[${label}] ${path}\n         签名语义=${mode.padEnd(4)} → ${verdict}${json?.msg ? ` msg=${json.msg}` : ''}`)
    return json
  }

  console.log('=== 对照组：不含空值参数（两种签名语义应都成功） ===')
  await probe('A1', '/music/api/v1/search/track?q=a&page=1&size=5', 'keep')
  await probe('A2', '/music/api/v1/search/track?q=a&page=1&size=5', 'drop')

  console.log('\n=== 实验组：含空值参数 q= ===')
  const keep = await probe('B1', '/music/api/v1/search/track?q=&page=1&size=5', 'keep')
  const drop = await probe('B2', '/music/api/v1/search/track?q=&page=1&size=5', 'drop')

  console.log('\n=== 实验组：含空值参数 sort=（列表接口） ===')
  await probe('C1', '/music/api/v1/track/list?page=1&size=5&sort=', 'keep')
  await probe('C2', '/music/api/v1/track/list?page=1&size=5&sort=', 'drop')

  console.log('\n=== 对照组：故意用错误签名（验证 GET 签名是否真的被校验） ===')
  for (const [label, path, mode] of [
    ['D1', '/music/api/v1/search/track?q=a&page=1&size=5', 'keep'],
    ['D2', '/music/api/v1/track/list?page=1&size=5&sort=', 'keep'],
  ]) {
    const url = `${base}${path}`
    const res = await fetch(url, {
      headers: { authx: 'nonce=123456&timestamp=1700000000000&sign=' + '0'.repeat(32), cookie },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    console.log(`[${label}] ${path}\n         签名=全零伪造 → ${json ? `code=${json.code}` : `非JSON(HTTP ${res.status}) 片段=${text.slice(0, 60).replace(/\s+/g, ' ')}`}${json?.msg ? ` msg=${json.msg}` : ''}`)
  }

  console.log('\n=== 对照组：POST 是否校验 authx（用密码登录做实验） ===')
  const postLogin = async (label, headerValue) => {
    const body = JSON.stringify({ username: user, password: sha256(pass), deviceId: 'probe-device-fixed-0001' })
    const res = await fetch(`${base}/music/api/v1/user/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authx: headerValue, cookie: 'mode=relay' },
      body,
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    console.log(`[${label}] POST /music/api/v1/user/password-login → ${json ? `code=${json.code}${json.msg ? ` msg=${json.msg}` : ''}` : `非JSON(HTTP ${res.status}) 片段=${text.slice(0, 80).replace(/\s+/g, ' ')}`}`)
    return json
  }
  const correctHeader = authx('POST', `${base}/music/api/v1/user/password-login`, JSON.stringify({ username: user, password: sha256(pass), deviceId: 'probe-device-fixed-0001' }), 'keep')
  await postLogin('E1', correctHeader)
  await postLogin('E2', 'nonce=123456&timestamp=1700000000000&sign=' + '0'.repeat(32))

  console.log('\n=== 结论 ===')
  const keepOk = keep?.code === 0
  const dropOk = drop?.code === 0
  if (keepOk && !dropOk) {
    console.log('服务端把空值参数计入规范串 → 客户端必须【保留空值】（上游语义）。')
  } else if (!keepOk && dropOk) {
    console.log('服务端忽略空值参数 → 客户端应【丢弃空值】。')
  } else if (keepOk && dropOk) {
    console.log('两种语义都成功（服务端可能对该参数另有处理，或两边都容忍）→ 空值参数不敏感。')
  } else {
    console.log('两种语义都失败 → 该端点/参数组合本身有问题，需换实验组重试。')
  }
}

main().catch((e) => {
  console.error('验证失败:', e)
  process.exit(1)
})
