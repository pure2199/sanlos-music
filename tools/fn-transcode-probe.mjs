#!/usr/bin/env node
/**
 * 转码端点参数探测：找出 fnOS 飞牛音乐服务端转码的正确调用方式。
 * 用法: FN_USER=xxx FN_PASS=xxx node tools/fn-transcode-probe.mjs --fnid <FNID>
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
function authx(method, url, body, key) {
  const n = nonce()
  const t = ts()
  const payload = method.toUpperCase() === 'GET' ? md5(new URL(url, 'http://local').search) : md5(body ?? '')
  return `nonce=${n}&timestamp=${t}&sign=${md5([SIGN_PREFIX, pathnameOf(url), n, t, payload, key].join('_'))}`
}

const args = process.argv.slice(2)
const fnId = args[args.indexOf('--fnid') + 1]
const user = process.env.FN_USER
const pass = process.env.FN_PASS

async function main() {
  const conBody = JSON.stringify({ fnId })
  const con = await (
    await fetch('https://5ddd.com/api/v1/fn/con', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authx: authx('POST', '/api/v1/fn/con', conBody, FN_SIGN_KEY) },
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
      headers: { 'content-type': 'application/json', authx: authx('POST', '/music/api/v1/user/password-login', loginBody, MUSIC_SIGN_KEY), cookie: 'mode=relay' },
      body: loginBody,
      signal: AbortSignal.timeout(15000),
    })
  ).json()
  const token = login.data.userToken
  const cookie = `music-token=${token}; mode=relay`

  const call = async (method, path, body) => {
    const url = `${base}${path}`
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const res = await fetch(url, {
      method,
      headers: { ...(raw ? { 'content-type': 'application/json' } : {}), authx: authx(method, url, raw, MUSIC_SIGN_KEY), cookie },
      body: raw,
      signal: AbortSignal.timeout(30000),
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

  // 找一首 codec 非 flac/mp3/aac 的曲目；找不到就用第一首
  const scan = await call('GET', '/music/api/v1/track/list?page=1&size=500')
  const all = scan.json?.data?.list ?? []
  const hard = all.find((t) => !['flac', 'mp3', 'aac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le'].includes(String(t?.audioSpec?.codec).toLowerCase()))
  const soft = all.find((t) => ['pcm_s16le', 'pcm_s24le', 'pcm_f32le'].includes(String(t?.audioSpec?.codec).toLowerCase()))
  const target = hard ?? soft ?? all[0]
  console.log(`目标曲目: ${target?.title} codec=${target?.audioSpec?.codec} format=${target?.audioSpec?.format} guid=${target?.guid}`)
  console.log(`path=${target?.audioSpec?.path}\n`)

  const shapes = [
    ['POST /track/transcode {trackGUID}', 'POST', '/music/api/v1/track/transcode', { trackGUID: target.guid }],
    ['POST /track/transcode {guid}', 'POST', '/music/api/v1/track/transcode', { guid: target.guid }],
    ['POST /track/transcode {trackGUID,format}', 'POST', '/music/api/v1/track/transcode', { trackGUID: target.guid, format: 'mp3' }],
    ['POST /track/transcode {trackGUID,codec}', 'POST', '/music/api/v1/track/transcode', { trackGUID: target.guid, codec: 'mp3' }],
    ['POST /track/transcode {trackGUID,quality}', 'POST', '/music/api/v1/track/transcode', { trackGUID: target.guid, quality: 'standard' }],
    ['POST /track/transcode {guid,path}', 'POST', '/music/api/v1/track/transcode', { guid: target.guid, path: target.audioSpec?.path }],
    ['GET  /track/transcode?trackGUID=', 'GET', `/music/api/v1/track/transcode?trackGUID=${encodeURIComponent(target.guid)}`, undefined],
    ['GET  /track/transcode?guid=', 'GET', `/music/api/v1/track/transcode?guid=${encodeURIComponent(target.guid)}`, undefined],
    ['POST /transcode/track {trackGUID}', 'POST', '/music/api/v1/transcode/track', { trackGUID: target.guid }],
    ['POST /track/convert {trackGUID}', 'POST', '/music/api/v1/track/convert', { trackGUID: target.guid }],
    ['POST /track/stream-info {trackGUID}', 'POST', '/music/api/v1/track/stream-info', { trackGUID: target.guid }],
    ['POST /track/stream {trackGUID}', 'POST', '/music/api/v1/track/stream', { trackGUID: target.guid }],
    ['GET  /track/stream?guid= (带 format 参数)', 'GET', `/music/api/v1/track/stream?guid=${encodeURIComponent(target.guid)}&format=mp3`, undefined],
  ]

  for (const [label, method, path, body] of shapes) {
    const r = await call(method, path, body)
    const code = r.json?.code
    const data = r.json?.data
    const ok = code === 0
    let detail = ''
    if (ok) detail = `data=${JSON.stringify(data).slice(0, 200)}`
    else if (r.json) detail = `msg=${r.json.msg ?? ''}`
    else detail = `非JSON HTTP ${r.status} 片段=${r.text.slice(0, 60).replace(/\s+/g, ' ')}`
    console.log(`${label.padEnd(42)} HTTP ${r.status} code=${code ?? '-'} ${detail}`)
    if (ok) {
      const quit = await call('POST', '/music/api/v1/track/quit-transcode', { trackGUID: target.guid })
      console.log(`  → quit-transcode: code=${quit.json?.code}`)
      break
    }
  }
}

main().catch((e) => {
  console.error('探测失败:', e)
  process.exit(1)
})
