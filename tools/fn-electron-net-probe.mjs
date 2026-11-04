// Electron 出网栈诊断（T17）。
//
// ---------------------------------------------------------------------------
// 为什么要这个脚本
// ---------------------------------------------------------------------------
// 探针（Node 的 undici fetch）能连上 `https://<fnid>.fnos.net`，但**客户端**
// （Electron 主进程，走 Chromium 分区栈 `session.fromPartition(...).fetch`）
// 登录时抛「无法连接音乐服务（网络不可达或服务未响应）」。
//
// 两边只差「网络栈」与「请求头」，所以这里在 **Electron 主进程里**逐项对比：
//   1. Node 的全局 fetch（undici）；
//   2. Chromium 分区栈 fetch，带 / 不带 `Cookie` 头；
//   3. GET / POST 两种方法；
//   4. Electron `net.fetch`；
//   5. **系统代理解析结果**（`resolveProxy`）——系统代理常常是「Node 能连、Chromium 连不上」的元凶。
//
// 脚本**不打印任何凭证**：口令从 `FN_PASS` 读，算出来的 `sha256` 只在内存里。
//
// 用法：FN_ID=... FN_USER=... FN_PASS=... node tools/fn-electron-net-probe.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const FN_ID = process.env.FN_ID ?? ''
const SERVER = process.env.FN_SERVER ?? (FN_ID ? `https://${FN_ID}.fnos.net` : '')

if (!FN_USER || !FN_PASS || !SERVER) {
  console.error('用法：FN_USER=... FN_PASS=... [FN_ID=... | FN_SERVER=...] node tools/fn-electron-net-probe.mjs')
  process.exit(2)
}

/** 取 URL 的 host（解析失败返回空串）。 */
function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 脱敏：把敏感值换成占位符。 */
function redact(text) {
  let out = String(text ?? '')
  for (const raw of [FN_PASS, FN_USER, FN_ID]) {
    if (raw) out = out.split(raw).join('<脱敏>')
  }
  try {
    out = out.split(new URL(SERVER).host).join('<服务器>')
  } catch {
    /* 忽略 */
  }
  return out
}

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-netprobe-'))

// ---------------------------------------------------------------------------
// 与 `electron/sign.ts` 完全一致的签名实现（复刻，便于在主进程里发同样的请求）
// ---------------------------------------------------------------------------

const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'
const SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'

const md5 = (input) => createHash('md5').update(input, 'utf8').digest('hex')
const sha256 = (input) => createHash('sha256').update(input, 'utf8').digest('hex')

/** 与 `electron/sign.ts` 的 `authx()` 同构。 */
function authx(method, url, body) {
  const n = String(Math.floor(Math.random() * 9e5) + 1e5)
  const t = String(Date.now())
  const payload = method.toUpperCase() === 'GET' ? '' : md5(body ?? '')
  const sign = md5([SIGN_PREFIX, new URL(url).pathname, n, t, payload, SIGN_KEY].join('_'))
  return `nonce=${n}&timestamp=${t}&sign=${sign}`
}

const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

try {
  const results = await app.evaluate(async ({ net, session }, arg) => {
    const { server, serverHost, loginUrl, loginBody, authxHeader } = arg
    const base = server
    const out = []

    // ---- 0. 系统代理解析（Chromium 走系统代理，Node 不走）------------------
    try {
      const proxy = await session.defaultSession.resolveProxy(base)
      out.push({ step: 'resolveProxy', ok: true, detail: proxy })
    } catch (err) {
      out.push({ step: 'resolveProxy', ok: false, detail: String(err) })
    }

    // ---- 1. Node 全局 fetch（undici）--------------------------------------
    try {
      const res = await fetch(`${base}/music/api/v1/track/list?page=1&size=1`)
      const text = (await res.text()).slice(0, 120)
      out.push({ step: 'node-fetch GET', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({ step: 'node-fetch GET', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    // ---- 2. Chromium 分区栈 fetch（GET）-----------------------------------
    const part = session.fromPartition('fn-nas-v0', { cache: false })
    try {
      const res = await part.fetch(`${base}/music/api/v1/track/list?page=1&size=1`)
      const text = (await res.text()).slice(0, 120)
      out.push({ step: 'partition GET', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({ step: 'partition GET', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    // ---- 3. 分区栈 GET + Cookie 头 ----------------------------------------
    try {
      const res = await part.fetch(`${base}/music/api/v1/track/list?page=1&size=1`, {
        headers: { cookie: 'mode=relay' },
      })
      const text = (await res.text()).slice(0, 120)
      out.push({ step: 'partition GET +cookie', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({ step: 'partition GET +cookie', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    // ---- 4. 分区栈 POST + Cookie 头（与客户端登录同形）---------------------
    try {
      const res = await part.fetch(`${base}/music/api/v1/user/password-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mode=relay' },
        body: JSON.stringify({ username: 'probe', password: 'probe', deviceId: 'probe' }),
      })
      const text = (await res.text()).slice(0, 160)
      out.push({ step: 'partition POST +cookie', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({ step: 'partition POST +cookie', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    // ---- 5. Electron net.fetch --------------------------------------------
    try {
      const res = await net.fetch(`${base}/music/api/v1/track/list?page=1&size=1`)
      const text = (await res.text()).slice(0, 120)
      out.push({ step: 'net.fetch GET', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({ step: 'net.fetch GET', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    // ---- 6. 分区栈 fetch + signal 超时（看是超时还是立刻抛）---------------
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const res = await part.fetch(`${base}/music/api/v1/track/list?page=1&size=1`, {
        signal: controller.signal,
      })
      clearTimeout(timer)
      out.push({ step: 'partition GET (timeout 8s)', ok: true, detail: `HTTP ${res.status}` })
    } catch (err) {
      out.push({ step: 'partition GET (timeout 8s)', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    // ---- 7. 新分区 + verify proc（复刻客户端 `http.ts` 的行为）--------------
    const partV1 = session.fromPartition('fn-nas-v1', { cache: false })
    partV1.setCertificateVerifyProc((request, callback) => {
      callback(request.hostname === serverHost ? 0 : -3)
    })    try {
      const res = await partV1.fetch(`${base}/music/api/v1/track/list?page=1&size=1`)
      out.push({ step: 'partition v1 (verify proc) GET', ok: true, detail: `HTTP ${res.status}` })
    } catch (err) {
      out.push({
        step: 'partition v1 (verify proc) GET',
        ok: false,
        detail: `${err?.name}: ${err?.message}${err?.cause ? ` | cause: ${err.cause}` : ''}`,
      })
    }

    // ---- 8. **完全复刻客户端登录请求**（authx + cookie + 真 body）------------
    try {
      const res = await part.fetch(loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authx: authxHeader, cookie: 'mode=relay' },
        body: loginBody,
      })
      const text = (await res.text()).slice(0, 200)
      out.push({ step: 'partition POST (客户端同形)', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({
        step: 'partition POST (客户端同形)',
        ok: false,
        detail: `${err?.name}: ${err?.message}${err?.cause ? ` | cause: ${err.cause}` : ''}`,
      })
    }

    // ---- 9. 同上，但走 v1 分区（verify proc 在场）----------------------------
    try {
      const res = await partV1.fetch(loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authx: authxHeader, cookie: 'mode=relay' },
        body: loginBody,
      })
      const text = (await res.text()).slice(0, 200)
      out.push({ step: 'partition v1 POST (客户端同形)', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({
        step: 'partition v1 POST (客户端同形)',
        ok: false,
        detail: `${err?.name}: ${err?.message}${err?.cause ? ` | cause: ${err.cause}` : ''}`,
      })
    }

    // ---- 10. Node fetch + authx + cookie（排除 authx 本身的问题）-------------
    try {
      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authx: authxHeader, cookie: 'mode=relay' },
        body: loginBody,
      })
      const text = (await res.text()).slice(0, 200)
      out.push({ step: 'node POST (客户端同形)', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({ step: 'node POST (客户端同形)', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    return out
  }, {
    server: SERVER,
    serverHost: safeHost(SERVER),
    loginUrl: `${SERVER}/music/api/v1/user/password-login`,
    loginBody: JSON.stringify({
      username: FN_USER,
      password: sha256(FN_PASS),
      deviceId: '0123456789abcdef0123456789abcdef',
    }),
    authxHeader: authx('POST', `${SERVER}/music/api/v1/user/password-login`, JSON.stringify({
      username: FN_USER,
      password: sha256(FN_PASS),
      deviceId: '0123456789abcdef0123456789abcdef',
    })),
  })

  console.log('\n─── Electron 出网栈诊断 ───\n')
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.step} — ${redact(r.detail)}`)
  }
} finally {
  await Promise.race([
    app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  await app.close().catch(() => undefined)
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 忽略 */
  }
}
