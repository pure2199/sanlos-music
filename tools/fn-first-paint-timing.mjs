// 首屏加载耗时测量（T17）。
//
// 活体验检里「歌曲页」与「收藏页」在 20 秒内没渲染出行，但几分钟后又能拿到行。
// 这个脚本精确测量「从切页到第一行出现」的耗时，并记录每个 `fnm://` 请求的
// 发起时刻、状态码与体积，用来区分三种可能：
//   1. 服务端慢（中继带宽低）→ 请求耗时长；
//   2. 客户端慢（渲染/竞态）→ 请求很快但迟迟不渲染；
//   3. 请求压根没发出去 → 根本没有请求记录。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-first-paint-timing.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const SERVER = process.env.FN_SERVER ?? ''
if (!FN_USER || !FN_PASS || !SERVER) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-first-paint-timing.mjs')
  process.exit(2)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-timing-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

/** 请求流水：{t, url, status, ms, bytes}。 */
const requests = []
let t0 = Date.now()

try {
  const window = await app.firstWindow()

  window.on('response', (res) => {
    const url = res.url()
    if (!url.startsWith('fnm://')) return
    requests.push({ t: Date.now() - t0, url: url.replace(/^fnm:\/\/srv/, ''), status: res.status() })
  })

  await window.fill('#fnm-address', SERVER)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window.getByText('已连接', { exact: false }).first().waitFor({ timeout: 30000 })
  console.log(`登录耗时：${Date.now() - t0} ms`)

  /** 切页并等待第一行出现，返回耗时与当时的请求流水。 */
  const measure = async (navLabel, timeoutMs = 90000) => {
    const before = requests.length
    const started = Date.now()
    await window.locator('nav[aria-label="曲库导航"] button', { hasText: navLabel }).first().click()
    let rows = 0
    let status = ''
    let error = ''
    while (Date.now() - started < timeoutMs) {
      rows = await window.locator('[role="option"]').count()
      status = await window.locator('.fnm-songlist__status').first().textContent().catch(() => null)
      error = await window.locator('.fnm-page__error').first().textContent().catch(() => null)
      if (rows > 0) break
      await window.waitForTimeout(250)
    }
    const elapsed = Date.now() - started
    console.log(
      `\n【${navLabel}】耗时 ${elapsed} ms｜行数 ${rows}｜状态「${(status ?? '').trim()}」｜错误「${(error ?? '').trim()}」`,
    )
    console.log(`  本页新增请求 ${requests.length - before} 条：`)
    for (const r of requests.slice(before)) console.log(`   +${r.t} ms  HTTP ${r.status}  ${r.url}`)
    return { elapsed, rows }
  }

  t0 = Date.now()
  await measure('歌曲')
  await measure('收藏')
  await measure('歌单')
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
