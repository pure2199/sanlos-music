// 客户端登录请求「逐项减法」定位（T17 根因）。
//
// ---------------------------------------------------------------------------
// 已知：Electron / Chromium / Node 三个栈都能连上中继，带 `Cookie: mode=relay`
// 的 POST 也能通（返回 code=120001）。但**客户端自己的登录请求**却抛
// 「无法连接音乐服务（网络不可达或服务未响应）」——说明失败点在**请求的某个细节**上。
//
// 这里对登录请求做「逐项加减」：从「客户端同形」开始，一次只拿掉一个要素，
// 看哪一次会从「抛异常」变成「拿到服务端响应」：
//   1. 客户端同形（authx + cookie + 真账号 + 真 body）
//   2. 去掉 authx
//   3. 去掉 cookie
//   4. 去掉 content-type
//   5. 只留 cookie（探针已知可通）
//
// 每次都用**新分区**（隔离连接池），避免中继的连接节流干扰结论。
//
// 用法：FN_USER=... FN_PASS=... FN_ID=... node tools/fn-login-shape-probe.mjs
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
  console.error('用法：FN_USER=... FN_PASS=... [FN_ID=... | FN_SERVER=...] node tools/fn-login-shape-probe.mjs')
  process.exit(2)
}

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

const loginUrl = `${SERVER}/music/api/v1/user/password-login`
const loginBody = JSON.stringify({
  username: FN_USER,
  password: sha256(FN_PASS),
  deviceId: '0123456789abcdef0123456789abcdef',
})
const authxHeader = authx('POST', loginUrl, loginBody)

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-loginshape-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

try {
  const results = await app.evaluate(async ({ session }, arg) => {
    const { loginUrl, loginBody, authxHeader } = arg
    const out = []
    let seq = 0

    /** 每次用新分区，隔离连接池。 */
    const probe = async (step, headers) => {
      seq += 1
      const ses = session.fromPartition(`ls-${seq}`, { cache: false })
      try {
        const res = await ses.fetch(loginUrl, {
          method: 'POST',
          headers,
          body: loginBody,
        })
        const text = (await res.text()).slice(0, 160)
        out.push({ step, ok: true, detail: `HTTP ${res.status} ${text}` })
      } catch (err) {
        let cause = ''
        let c = err?.cause
        while (c) {
          cause += ` | cause: ${c?.name ?? ''} ${c?.message ?? c}`
          c = c?.cause
        }
        out.push({ step, ok: false, detail: `${err?.name}: ${err?.message}${cause}` })
      }
    }

    await probe('1. 客户端同形（authx + cookie + ct）', {
      'content-type': 'application/json',
      authx: authxHeader,
      cookie: 'mode=relay',
    })
    await probe('2. 去掉 authx', {
      'content-type': 'application/json',
      cookie: 'mode=relay',
    })
    await probe('3. 去掉 cookie', {
      'content-type': 'application/json',
      authx: authxHeader,
    })
    await probe('4. 去掉 content-type', {
      authx: authxHeader,
      cookie: 'mode=relay',
    })
    await probe('5. 只留 cookie', {
      cookie: 'mode=relay',
    })

    return out
  }, { loginUrl, loginBody, authxHeader })

  console.log('\n─── 登录请求逐项减法 ───\n')
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.step} — ${r.detail}`)
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
