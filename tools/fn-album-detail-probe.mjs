#!/usr/bin/env node
/**
 * 专项校准探针：album/detail 的真实形态 + 搜索分页（Step H / J-1）。
 *
 * 用法:
 *   FN_USER=xxx FN_PASS=xxx node tools/fn-album-detail-probe.mjs --fnid <FNID>
 *
 * 回答：
 *   J-1. `/album/detail` 到底怎么调？（路径 / 参数名变体扫一遍）
 *        若它根本不存在 → 客户端应改用哪个端点。
 *   H.   `search/{track,album,artist}` 用 `q` 参数时，page/size 是否生效、total 是否准确。
 *   附.  `/album/list` 的条目字段是否已经足够当「详情」用。
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
const user = process.env.FN_USER
const pass = process.env.FN_PASS
if (!fnId || !user || !pass) {
  console.error('用法: FN_USER=xxx FN_PASS=xxx node tools/fn-album-detail-probe.mjs --fnid <FNID>')
  process.exit(1)
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
    /* SPA 兜底 */
  }
  return { status: res.status, json }
}

const keysOf = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).join(',') : typeof v

async function main() {
  // 连接 + 登录
  const conBody = JSON.stringify({ fnId })
  const conRes = await fetch(FN_CON_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/api/v1/fn/con', conBody, FN_SIGN_KEY, nonce(), ts()),
    },
    body: conBody,
    signal: AbortSignal.timeout(15000),
  })
  const con = await conRes.json()
  const relays = con.data?.fn?.length ? con.data.fn : [`${fnId}.fnos.net:443`]
  for (const r of relays) {
    const address = `https://${String(r).replace(/:\d+$/, '')}`
    try {
      const res = await fetch(`${address}/music/api/v1/health`, {
        headers: { cookie: 'mode=relay' },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status < 400) {
        base = address
        break
      }
    } catch {
      /* next */
    }
  }
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
  const login = await loginRes.json()
  if (login?.code !== 0) {
    console.error('登录失败:', login?.code, login?.msg)
    process.exit(1)
  }
  cookie = `music-token=${login.data.userToken}; mode=relay`
  console.log('登录成功\n')

  // 取一个真实专辑样本
  const albums = await call('/music/api/v1/album/list?page=1&size=3')
  const sample = albums.json?.data?.list?.[0]
  const guid = sample?.guid
  console.log('=== 专辑样本 ===')
  console.log('  guid =', guid)
  console.log('  /album/list 条目 keys =', keysOf(sample))
  console.log('  /album/list 条目值   =', JSON.stringify(sample).slice(0, 400))

  // ---------------------------------------------------------------------
  // J-1：album/detail 的路径 / 参数名变体
  // ---------------------------------------------------------------------
  console.log('\n=== J-1: /album/detail 变体扫描 ===')
  const variants = [
    ['/music/api/v1/album/detail?albumGUID=', 'albumGUID（客户端现用）'],
    ['/music/api/v1/album/detail?guid=', 'guid'],
    ['/music/api/v1/album/detail?albumGuid=', 'albumGuid（驼峰）'],
    ['/music/api/v1/album/detail?albumId=', 'albumId'],
    ['/music/api/v1/album/detail?id=', 'id'],
    ['/music/api/v1/album/detail?albumGUID=', 'albumGUID + page/size'],
    ['/music/api/v1/album/detail', '无参数'],
    ['/music/api/v1/album/album-detail/list?albumGUID=', 'album/album-detail/list'],
    ['/music/api/v1/album/list?albumGUID=', 'album/list + albumGUID'],
    ['/music/api/v1/album/detail/list?albumGUID=', 'album/detail/list'],
  ]
  for (const [path, label] of variants) {
    const suffix = label.includes('page/size') ? '&page=1&size=1' : ''
    const r = await call(path + guid + suffix)
    const data = r.json?.data
    const n = Array.isArray(data?.list) ? data.list.length : undefined
    const isEnvelope = data && typeof data === 'object' && Array.isArray(data.list)
    console.log(
      `  ${label.padEnd(26)} HTTP ${r.status} code=${String(r.json?.code ?? '-').padEnd(7)} ` +
        `data=${keysOf(data)}${n !== undefined ? ` list=${n}` : ''}${isEnvelope ? ' ✅信封' : ''}` +
        `${r.json?.msg ? ' msg=' + r.json.msg : ''}`,
    )
  }

  // 参照：同族的 album-detail/list（客户端取专辑歌曲用的）
  const songsOfAlbum = await call(`/music/api/v1/track/album-detail/list?albumGUID=${guid}&page=1&size=3`)
  console.log(
    `  [对照] track/album-detail/list   HTTP ${songsOfAlbum.status} code=${songsOfAlbum.json?.code} ` +
      `total=${songsOfAlbum.json?.data?.total ?? '-'} 返回=${songsOfAlbum.json?.data?.list?.length ?? '-'} 条`,
  )

  // ---------------------------------------------------------------------
  // H：搜索分页（用正确的 q 参数）
  // ---------------------------------------------------------------------
  console.log('\n=== Step H: 搜索分页（q 参数）===')
  for (const [label, path] of [
    ['search/track', '/music/api/v1/search/track'],
    ['search/album', '/music/api/v1/search/album'],
    ['search/artist', '/music/api/v1/search/artist'],
  ]) {
    const q = encodeURIComponent('占位歌手三')
    const p1 = await call(`${path}?q=${q}&page=1&size=5`)
    const p2 = await call(`${path}?q=${q}&page=2&size=5`)
    const noPage = await call(`${path}?q=${q}&size=5`)
    const ids = (r) => (r.json?.data?.list ?? []).map((x) => x.guid ?? '?')
    const a = ids(p1)
    const b = ids(p2)
    const c = ids(noPage)
    const overlap = a.filter((x) => b.includes(x)).length
    const total = p1.json?.data?.total
    const total2 = p2.json?.data?.total
    console.log(`  ${label.padEnd(13)} HTTP ${p1.status} code=${p1.json?.code} msg=${p1.json?.msg ?? ''}`)
    console.log(
      `      page1=${a.length}条 total=${total ?? '-'} | page2=${b.length}条 total=${total2 ?? '-'} | 无page=${c.length}条 | p1∩p2=${overlap}`,
    )
    if (a.length > 0) {
      console.log(`      → page ${overlap === 0 ? '✅ 生效（第2页与第1页无重叠）' : '❌ 被忽略（两页重叠）'}`)
      console.log(`      → 无 page 参数时返回 ${c.length} 条（与 page1 ${a.length} 条 ${c.length === a.length ? '相同 → 默认第1页' : '不同' }）`)
    } else {
      console.log(`      → 该关键字无命中或端点形状不符（data=${keysOf(p1.json?.data)}）`)
    }
  }
}

main().catch((e) => {
  console.error('探测失败:', e)
  process.exit(1)
})
