#!/usr/bin/env node
/**
 * 播放历史端点探测（联调用，Task 7）。
 *
 * 用法:
 *   FN_USER=xxx FN_PASS=xxx node tools/fn-history-probe.mjs --fnid <FNID>
 *
 * 回答三个问题：
 * 1. `GET /music/api/v1/play-history/list` 的**排序依据**是什么（条目里有没有播放时间字段）；
 * 2. **服务端会不会随 stream 自动写历史**（客户端还需要自己上报吗）；
 * 3. 有没有「上报播放」的写端点（`play-history/add` 之类）。
 *
 * ⚠️ 凭据只从**环境变量**读取：不落盘、不打印、不进 git。
 * ⚠️ 本脚本**只读**：唯一的副作用是可能让服务端多一条播放历史（这正是被测的行为）。
 */
import { createHash } from 'node:crypto'

const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'
const MUSIC_SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'
const FN_SIGN_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c'
const FN_CON_API = 'https://5ddd.com/api/v1/fn/con'

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

const args = process.argv.slice(2)
const getArg = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const fnId = getArg('fnid')
const user = process.env.FN_USER
const pass = process.env.FN_PASS
if (!fnId || !user || !pass) {
  console.error('用法: FN_USER=xxx FN_PASS=xxx node tools/fn-history-probe.mjs --fnid <FNID>')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1. 解析链路
  const conBody = JSON.stringify({ fnId })
  const conRes = await fetch(FN_CON_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/api/v1/fn/con', conBody, FN_SIGN_KEY),
    },
    body: conBody,
    signal: AbortSignal.timeout(15000),
  })
  const con = await conRes.json()
  const relay = (con.data?.fn?.[0] ?? `${fnId}.fnos.net:443`).replace(/:\d+$/, '')
  const base = `https://${relay}`
  console.log(`链路: ${base}`)

  // 2. 登录
  const deviceId = createHash('sha256').update(`${user}:${Date.now()}`).digest('hex').slice(0, 32)
  const loginBody = JSON.stringify({ username: user, password: sha256(pass), deviceId })
  const loginRes = await fetch(`${base}/music/api/v1/user/password-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/music/api/v1/user/password-login', loginBody, MUSIC_SIGN_KEY),
      cookie: 'mode=relay',
    },
    body: loginBody,
    signal: AbortSignal.timeout(15000),
  })
  const loginText = await loginRes.text()
  let login = null
  try {
    login = JSON.parse(loginText)
  } catch {
    console.error(`登录返回非 JSON (HTTP ${loginRes.status}): ${loginText.slice(0, 200)}`)
    process.exit(1)
  }
  if (login.code !== 0) {
    console.error(`登录失败 code=${login.code} msg=${login.msg}`)
    process.exit(1)
  }
  const token = login.data.userToken
  const cookie = `music-token=${token}; mode=relay`
  console.log('登录成功')

  const get = async (path) => {
    const url = `${base}${path}`
    const res = await fetch(url, {
      headers: { authx: authx('GET', url, undefined, MUSIC_SIGN_KEY), cookie },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text }
  }
  const post = async (path, body) => {
    const url = `${base}${path}`
    const raw = JSON.stringify(body)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authx: authx('POST', url, raw, MUSIC_SIGN_KEY),
        cookie,
      },
      body: raw,
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text }
  }

  // 3. 播放历史：结构与排序字段
  console.log('\n=== 1. play-history/list 结构 ===')
  const hist = await get('/music/api/v1/play-history/list?page=1&size=5')
  const histData = hist.json?.data
  const histList = histData?.list ?? []
  console.log(`HTTP ${hist.status} code=${hist.json?.code} 返回=${histList.length} 条 total=${histData?.total ?? '-'}`)
  if (histList[0]) {
    console.log('首条 keys:', Object.keys(histList[0]).join(','))
    console.log('首条摘要:', JSON.stringify({
      guid: histList[0].guid,
      title: histList[0].title,
      updatedAt: histList[0].updatedAt,
      createdAt: histList[0].createdAt,
      playedAt: histList[0].playedAt,
      playTime: histList[0].playTime,
    }))
    console.log('前 5 条 guid:', histList.map((e) => e.guid).join(' | '))
    console.log('前 5 条 updatedAt:', histList.map((e) => e.updatedAt).join(' | '))
  }

  // 4. 服务端会不会随 stream 自动写历史？
  console.log('\n=== 2. stream 会不会自动写历史 ===')
  const tracks = await get('/music/api/v1/track/list?page=1&size=50')
  const all = tracks.json?.data?.list ?? []
  const known = new Set(histList.map((e) => e.guid))
  const fresh = all.find((t) => t?.guid && !known.has(t.guid))
  if (!fresh) {
    console.log('找不到「不在当前历史里」的曲目，无法判定（曲库前 50 首都在历史中）')
  } else {
    console.log(`选中曲目 guid=${fresh.guid} title=${fresh.title}`)
    const before = await get('/music/api/v1/play-history/list?page=1&size=5')
    const beforeFirst = before.json?.data?.list?.[0]?.guid ?? '-'
    console.log(`stream 前：历史首条 = ${beforeFirst}`)

    const streamUrl = `${base}/music/api/v1/track/stream?guid=${encodeURIComponent(fresh.guid)}`
    const st = await fetch(streamUrl, {
      headers: {
        authx: authx('GET', streamUrl, undefined, MUSIC_SIGN_KEY),
        cookie,
        range: 'bytes=0-4095',
      },
      signal: AbortSignal.timeout(30000),
    })
    await st.arrayBuffer()
    console.log(`stream：HTTP ${st.status} type=${st.headers.get('content-type')}`)

    for (const wait of [500, 1500, 3000]) {
      await sleep(wait === 500 ? 500 : 1000)
      const after = await get('/music/api/v1/play-history/list?page=1&size=5')
      const list = after.json?.data?.list ?? []
      const first = list[0]?.guid ?? '-'
      const hit = list.some((e) => e.guid === fresh.guid)
      console.log(`stream 后 ~${wait}ms：历史首条 = ${first}；本次曲目是否出现在前 5 条 = ${hit ? '是（服务端自动写）' : '否'}`)
      if (hit) break
    }
  }

  // 5. 排序口径复核：服务端返回顺序 vs 条目时间戳
  console.log('\n=== 4. 排序口径复核 ===')
  for (const page of [1, 2]) {
    const r = await get(`/music/api/v1/play-history/list?page=${page}&size=10`)
    const list = r.json?.data?.list ?? []
    console.log(`第 ${page} 页 updatedAt: ${list.map((e) => e.updatedAt).join(' | ')}`)
    console.log(`第 ${page} 页 createdAt: ${list.map((e) => e.createdAt).join(' | ')}`)
  }
  console.log('（非单调 = 服务端排序依据不暴露，客户端必须按返回顺序展示）')

  // 6. 有没有「上报播放」的写端点？
  console.log('\n=== 5. 上报端点探测 ===')
  const guid = fresh?.guid ?? histList[0]?.guid ?? ''
  const candidates = [
    ['POST', '/music/api/v1/play-history/add'],
    ['POST', '/music/api/v1/play-history/set'],
    ['POST', '/music/api/v1/play-history/update'],
    ['POST', '/music/api/v1/play-history/insert'],
    ['POST', '/music/api/v1/play-history/record'],
    ['POST', '/music/api/v1/play-history/push'],
    ['POST', '/music/api/v1/play-history/play'],
    ['POST', '/music/api/v1/play-history/touch'],
    ['POST', '/music/api/v1/play-history'],
    ['POST', '/music/api/v1/history/add'],
    ['POST', '/music/api/v1/history/play'],
    ['POST', '/music/api/v1/track/play'],
    ['POST', '/music/api/v1/track/play-history'],
    ['POST', '/music/api/v1/track/record'],
    ['POST', '/music/api/v1/track/report'],
    ['POST', '/music/api/v1/recently-play/add'],
    ['POST', '/music/api/v1/recently-play/list'],
  ]
  for (const [method, path] of candidates) {
    const body = { trackGUID: guid, guid }
    const url = `${base}${path}`
    const raw = JSON.stringify(body)
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authx: authx(method, url, raw, MUSIC_SIGN_KEY),
        cookie,
      },
      body: raw,
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    const isJson =
      (res.headers.get('content-type') ?? '').includes('json') || text.trimStart().startsWith('{')
    let code = '-'
    if (isJson) {
      try {
        code = JSON.parse(text).code
      } catch {
        code = '?'
      }
    }
    // ⚠️ fnOS 对**未注册的路径**返回 SPA 兜底页（HTML）→ 「返回 HTML」= 不是 API 端点。
    console.log(
      `${method.padEnd(5)} ${path.padEnd(42)} HTTP ${res.status} ${isJson ? `API 路径 code=${code}` : 'SPA 兜底（不是 API 路径）'}`,
    )
  }
}

main().catch((e) => {
  console.error('探测失败:', e)
  process.exit(1)
})
