#!/usr/bin/env node
/**
 * 真机联调定向校准探针（Step H / I / J）。
 *
 * 用法:
 *   FN_USER=xxx FN_PASS=xxx node tools/fn-calibrate-probe.mjs --fnid <FNID>
 *
 * 回答三个问题：
 *   H. `search/{track,album,artist}` 是否接受 `page`/`size`，`total` 是否准确；
 *   I. `favorite-track/list` 与 `playlist/list` 的 `size` 上限是多少，
 *      客户端的「分页循环取全」（size=200，按 total 终止）能不能真的取全；
 *   J. `/album/detail` 的返回形状（列表信封 vs 直接对象），
 *      `/playlist/create` 是否回显 `guid`。
 *
 * ⚠️ **副作用**：Step J 会真的**新建一个歌单**，并在拿到结论后**立即删除**
 *    （用 `playlist/delete`）。若删除失败，会在输出里明确告知需要手工清理的 guid。
 *
 * 凭据只从环境变量读取，不落盘、不打印。
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

const pathnameOf = (u) => {
  try {
    return new URL(u).pathname
  } catch {
    return new URL(u, 'http://local').pathname
  }
}

function authx(method, url, body, key, nonceV, tsV) {
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
  const sign = md5([SIGN_PREFIX, pathnameOf(url), nonceV, tsV, payload, key].join('_'))
  return `nonce=${nonceV}&timestamp=${tsV}&sign=${sign}`
}

const args = process.argv.slice(2)
const getArg = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const fnId = getArg('fnid')
if (!fnId) {
  console.error('用法: node tools/fn-calibrate-probe.mjs --fnid <FNID>')
  process.exit(1)
}

const user = process.env.FN_USER
const pass = process.env.FN_PASS
if (!user || !pass) {
  console.error('需要 FN_USER / FN_PASS 环境变量。')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 连通 + 登录（走中继）
// ---------------------------------------------------------------------------

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
  return res.json()
}

async function pickRelay(data) {
  const relays = data.fn?.length ? data.fn : [`${fnId}.fnos.net:443`]
  for (const r of relays) {
    const domain = String(r).replace(/:\d+$/, '')
    const address = `https://${domain}`
    try {
      const res = await fetch(`${address}/music/api/v1/health`, {
        headers: { cookie: 'mode=relay' },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status < 400) return address
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

let base = null
let cookie = ''

async function call(path, method = 'GET', body) {
  const url = `${base}${path}`
  const bodyString = body === undefined ? undefined : JSON.stringify(body)
  const res = await fetch(url, {
    method,
    headers: {
      ...(bodyString ? { 'content-type': 'application/json' } : {}),
      authx: authx(method, url, bodyString, MUSIC_SIGN_KEY, nonce(), ts()),
      cookie,
    },
    body: bodyString,
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON（SPA 兜底） */
  }
  return { status: res.status, json, isJson: json !== null }
}

const shapeOf = (v) => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `array(${v.length})`
  if (typeof v === 'object') return `{${Object.keys(v).join(',')}}`
  return typeof v
}

// ---------------------------------------------------------------------------
// Step H：搜索端点的分页行为
// ---------------------------------------------------------------------------

async function stepH() {
  console.log('\n=== Step H: 搜索端点分页行为 ===')
  const keyword = 'a'
  for (const [label, path] of [
    ['search/track', '/music/api/v1/search/track'],
    ['search/album', '/music/api/v1/search/album'],
    ['search/artist', '/music/api/v1/search/artist'],
  ]) {
    const p1 = await call(`${path}?keyword=${keyword}&page=1&size=5`)
    const p2 = await call(`${path}?keyword=${keyword}&page=2&size=5`)
    const noPage = await call(`${path}?keyword=${keyword}`)

    const ids = (r) => (r.json?.data?.list ?? []).map((x) => x.guid ?? x.id ?? '?')
    const a = ids(p1)
    const b = ids(p2)
    const c = ids(noPage)
    const overlaps = a.filter((x) => b.includes(x)).length
    console.log(
      `${label.padEnd(13)} page1=${a.length}条 total=${p1.json?.data?.total ?? '-'} | ` +
        `page2=${b.length}条 total=${p2.json?.data?.total ?? '-'} | 无分页=${c.length}条 | ` +
        `p1∩p2=${overlaps} | data形状=${shapeOf(p1.json?.data)}`,
    )
    console.log(`  结论：${overlaps === 0 ? 'page 参数**生效**（第 2 页与第 1 页无重叠）' : 'page 参数**被忽略**（两页内容重叠）'}`)
  }
}

// ---------------------------------------------------------------------------
// Step I：收藏 / 歌单的 size 上限与分页取全
// ---------------------------------------------------------------------------

async function stepI() {
  console.log('\n=== Step I: 收藏 / 歌单 size 上限与分页取全 ===')
  for (const [label, path] of [
    ['favorite-track/list', '/music/api/v1/favorite-track/list'],
    ['playlist/list', '/music/api/v1/playlist/list'],
    ['album/list', '/music/api/v1/album/list'],
  ]) {
    console.log(`-- ${label} --`)
    for (const size of [200, 500, 2000]) {
      const r = await call(`${path}?page=1&size=${size}`)
      const n = r.json?.data?.list?.length ?? '-'
      const total = r.json?.data?.total ?? '-'
      console.log(`   size=${String(size).padEnd(5)} 返回=${String(n).padEnd(6)} 条 total=${total}`)
    }
    // 模拟客户端的分页循环取全：size=200，按 total 终止，最多 50 页。
    let collected = 0
    let pages = 0
    let total = 0
    const seen = new Set()
    while (pages < 50) {
      pages += 1
      const r = await call(`${path}?page=${pages}&size=200`)
      const list = r.json?.data?.list ?? []
      total = r.json?.data?.total ?? total
      if (list.length === 0) break
      for (const x of list) seen.add(x.guid ?? JSON.stringify(x))
      collected += list.length
      if (collected >= total) break
    }
    console.log(
      `   分页循环取全：${pages} 页 / 累计 ${collected} 条 / 去重后 ${seen.size} 条 / total=${total} → ` +
        `${seen.size >= total ? '✅ 取全' : '⚠️ 未取全'}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Step J：album/detail 形状 + playlist/create 回显 guid
// ---------------------------------------------------------------------------

async function stepJ() {
  console.log('\n=== Step J: album/detail 形状 + playlist/create 回显 guid ===')

  // J-1：album/detail
  const albums = await call('/music/api/v1/album/list?page=1&size=1')
  const albumGuid = albums.json?.data?.list?.[0]?.guid
  if (!albumGuid) {
    console.log('   album/detail：拿不到样本专辑，跳过')
  } else {
    const detail = await call(`/music/api/v1/album/detail?albumGUID=${albumGuid}`)
    const data = detail.json?.data
    console.log(`   GET /album/detail?albumGUID=… → HTTP ${detail.status} code=${detail.json?.code}`)
    console.log(`   data 形状 = ${shapeOf(data)}`)
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      console.log(`   data keys = ${Object.keys(data).join(',')}`)
      const hasList = Array.isArray(data.list)
      console.log(
        `   客户端假设「列表信封 + 取 list[0]」 → ${hasList ? '✅ 成立' : '❌ 不成立（data 不是信封）'}`,
      )
      if (hasList) console.log(`   list 长度 = ${data.list.length}；list[0].guid = ${data.list[0]?.guid ?? '-'}`)
    }
  }

  // J-2：playlist/create（新建后立即删除）
  const name = `__校准探针_${Date.now().toString(36)}__`
  const created = await call('/music/api/v1/playlist/create', 'POST', { name })
  console.log(`\n   POST /playlist/create → HTTP ${created.status} code=${created.json?.code} msg=${created.json?.msg ?? ''}`)
  console.log(`   data 形状 = ${shapeOf(created.json?.data)}`)
  if (created.json?.data && typeof created.json.data === 'object') {
    console.log(`   data keys = ${Object.keys(created.json.data).join(',')}`)
  }
  const guid = typeof created.json?.data?.guid === 'string' ? created.json.data.guid : ''
  console.log(
    `   客户端假设「回显 data.guid，缺失则兜底 ''」 → ${guid ? '✅ 成立（回显了 guid）' : '❌ 不成立（未回显 guid）'}`,
  )

  // 清理
  if (guid) {
    const del = await call('/music/api/v1/playlist/delete', 'POST', { guid })
    console.log(`   清理：POST /playlist/delete → HTTP ${del.status} code=${del.json?.code}`)
    if (del.json?.code !== 0) {
      console.log(`   ⚠️ 删除失败，需手工清理：歌单「${name}」guid=${guid}`)
    } else {
      console.log('   ✅ 已删除探针歌单，无残留')
    }
  } else {
    // 没有 guid → 按名字找出来删
    const list = await call('/music/api/v1/playlist/list?page=1&size=200')
    const hit = (list.json?.data?.list ?? []).find((p) => p.name === name)
    if (hit?.guid) {
      const del = await call('/music/api/v1/playlist/delete', 'POST', { guid: hit.guid })
      console.log(`   清理：按名字找到 guid 后删除 → HTTP ${del.status} code=${del.json?.code}`)
    } else {
      console.log(`   ⚠️ 未找到探针歌单「${name}」，请手工确认是否残留`)
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const con = await fetchConnectionParams()
  if (con.code !== 0) {
    console.error('FN 连接接口失败:', con.code, con.msg)
    process.exit(1)
  }
  base = await pickRelay(con.data ?? {})
  if (!base) {
    console.error('没有可达的中继链路。')
    process.exit(1)
  }
  console.log('链路:', base)

  const deviceId = createHash('sha256').update(`${user}:${Date.now()}`).digest('hex').slice(0, 32)
  const loginBody = JSON.stringify({ username: user, password: sha256(pass), deviceId })
  const loginRes = await fetch(`${base}/music/api/v1/user/password-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/music/api/v1/user/password-login', loginBody, MUSIC_SIGN_KEY, nonce(), ts()),
      cookie: 'mode=relay',
    },
    body: loginBody,
    signal: AbortSignal.timeout(15000),
  })
  const login = await loginRes.json().catch(() => null)
  if (login?.code !== 0) {
    console.error('登录失败:', login?.code, login?.msg)
    process.exit(1)
  }
  console.log('登录成功')
  cookie = `music-token=${login.data.userToken}; mode=relay`

  await stepH()
  await stepI()
  await stepJ()
}

main().catch((e) => {
  console.error('探测失败:', e)
  process.exit(1)
})
