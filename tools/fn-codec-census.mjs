#!/usr/bin/env node
/**
 * 曲库格式普查：统计各 codec / format 分布，判断 Chromium 解码覆盖率。
 * 用法: FN_USER=xxx FN_PASS=xxx node tools/fn-codec-census.mjs --fnid <FNID>
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
const CHROMIUM_OK = new Set(['flac', 'mp3', 'aac', 'wav', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'ogg', 'opus', 'vorbis', 'm4a'])

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
  const cookie = `music-token=${login.data.userToken}; mode=relay`

  const get = async (path) => {
    const url = `${base}${path}`
    const res = await fetch(url, { headers: { authx: authx('GET', url, undefined, MUSIC_SIGN_KEY), cookie }, signal: AbortSignal.timeout(30000) })
    return res.json().catch(() => null)
  }

  const codecs = new Map()
  const formats = new Map()
  let scanned = 0
  let total = 0
  const pages = [1, 20, 60, 120, 200, 260, 300, 330, 340]
  for (const p of pages) {
    const r = await get(`/music/api/v1/track/list?page=${p}&size=500`)
    const list = r?.data?.list ?? []
    total = r?.data?.total ?? total
    scanned += list.length
    for (const t of list) {
      const c = String(t?.audioSpec?.codec ?? '未知')
      const f = String(t?.audioSpec?.format ?? '未知')
      codecs.set(c, (codecs.get(c) ?? 0) + 1)
      formats.set(f, (formats.get(f) ?? 0) + 1)
    }
  }

  console.log(`抽样 ${scanned} 首 / 全库 ${total} 首\n`)
  console.log('codec 分布:')
  for (const [k, v] of [...codecs].sort((a, b) => b[1] - a[1])) {
    const ok = CHROMIUM_OK.has(k.toLowerCase())
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}  ${ok ? '✅ Chromium 可解' : '❌ 需兜底'}`)
  }
  console.log('\nformat 分布:')
  for (const [k, v] of [...formats].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}`)
  }
  const unsupported = [...codecs].filter(([k]) => !CHROMIUM_OK.has(k.toLowerCase()))
  console.log(`\n结论: ${unsupported.length === 0 ? '抽样范围内全部可由 Chromium 直接解码，无需转码兜底' : `存在 ${unsupported.length} 种需兜底的编码`}`)
}

main().catch((e) => {
  console.error('普查失败:', e)
  process.exit(1)
})
