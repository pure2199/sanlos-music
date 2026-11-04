// Chromium 分区 × 证书校验回调 的对照矩阵（T17 根因定位）。
//
// ---------------------------------------------------------------------------
// 背景
// ---------------------------------------------------------------------------
// 客户端的主进程出网栈（`electron/http.ts`）在**每个分区**上注册
// `setCertificateVerifyProc`，用来「只对用户填写的 host 放行自签证书」。
// 真机实测：**走这类分区的请求全部 `net::ERR_TIMED_OUT`**，而同一个分区
// 不注册校验回调时一切正常（Node / Electron / Chromium 三个栈都能通）。
//
// 这个脚本把变量一个个拆开：
//   - 新分区**不注册**回调 → GET
//   - 新分区注册回调、返回 `-3`（交回 Chromium 默认校验）→ GET
//   - 新分区注册回调、返回 `0`（放行）→ GET
//   - 复用上面两个分区再请求一次（看是不是「第一次握手卡住、第二次正常」）
//
// 另外单独测一次**带 Cookie 的 POST**（客户端登录请求的形状），
// 确认「登录失败」与「校验回调」是同一个原因。
//
// 用法：FN_ID=... node tools/fn-partition-matrix.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_ID = process.env.FN_ID ?? ''
const SERVER = process.env.FN_SERVER ?? (FN_ID ? `https://${FN_ID}.fnos.net` : '')
if (!SERVER) {
  console.error('用法：FN_ID=... 或 FN_SERVER=... node tools/fn-partition-matrix.mjs')
  process.exit(2)
}

/** 取 host（解析失败返回空串）。 */
function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const host = safeHost(SERVER)
const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-matrix-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

try {
  const results = await app.evaluate(async ({ session }, { server, host }) => {
    const out = []
    const url = `${server}/music/api/v1/track/list?page=1&size=1`

    /** 跑一次请求并记录结果。 */
    const probe = async (step, partition, verifyCode) => {
      const ses = session.fromPartition(partition, { cache: false })
      if (verifyCode !== null) {
        ses.setCertificateVerifyProc((request, callback) => {
          // 只对目标 host 放行，其余交回 Chromium 默认校验。
          callback(request.hostname === host ? verifyCode : -3)
        })
      }
      try {
        const res = await ses.fetch(url)
        const text = (await res.text()).slice(0, 60)
        out.push({ step, ok: true, detail: `HTTP ${res.status} ${text.replace(/\s+/g, ' ')}` })
      } catch (err) {
        out.push({ step, ok: false, detail: `${err?.name}: ${err?.message}` })
      }
    }

    // 1) 新分区，不注册校验回调
    await probe('A. 新分区 · 无校验回调', 'mx-a', null)
    // 2) 新分区，回调返回 -3（Chromium 默认校验）
    await probe('B. 新分区 · 回调 -3', 'mx-b', -3)
    // 3) 新分区，回调返回 0（放行）
    await probe('C. 新分区 · 回调 0', 'mx-c', 0)
    // 4) 复用 A 分区（复用连接池）
    await probe('D. 复用 A 分区 · 第二次', 'mx-a', null)
    // 5) 复用 C 分区（带回调）第二次
    await probe('E. 复用 C 分区 · 第二次', 'mx-c', 0)

    // 6) 带 Cookie 的 POST（客户端登录请求的形状），无回调分区
    try {
      const ses = session.fromPartition('mx-a', { cache: false })
      const res = await ses.fetch(`${server}/music/api/v1/user/password-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mode=relay' },
        body: JSON.stringify({ username: 'probe', password: 'probe', deviceId: 'probe' }),
      })
      const text = (await res.text()).slice(0, 120)
      out.push({ step: 'F. A 分区 POST +cookie', ok: true, detail: `HTTP ${res.status} ${text}` })
    } catch (err) {
      out.push({ step: 'F. A 分区 POST +cookie', ok: false, detail: `${err?.name}: ${err?.message}` })
    }

    return out
  }, { server: SERVER, host })

  console.log('\n─── 分区 × 校验回调 对照矩阵 ───\n')
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
