// 真机联调校准：Step C —— **静默续期**（T17）。
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// Step C 的问题：「token 失效后，客户端的静默续期路径是否真的能用」。
//
// 客户端的续期链路是：`SessionManager.relogin()` → 用内存里保留的**明文口令**
// 重新走一次 `password-login` → 拿到新 token → 落盘（DPAPI）。
// 服务端用 `code=99999` 表达 token 失效，`SessionManager.request()` 会在收到
// 99999 时自动续期并重试一次。
//
// 这里**不能**在真机上制造 99999（服务端不提供「作废当前 token」的接口），
// 所以分两层验证：
//   C-1 显式续期：`window.fn.relogin()` 返回 true（走的就是那条静默续期路径）；
//   C-2 续期后可用：续期完成后重新拉一次曲库数据，确认新 token 立刻可用。
//
// 凭证只从环境变量读，不打印、不落盘。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-session-renew-probe.mjs
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
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-session-renew-probe.mjs')
  process.exit(2)
}

/** 切到某个曲库页并等卡片出现，返回卡片数（0 = 没加载出来）。 */
async function waitCards(window, label, timeoutMs = 30000) {
  await window.locator('nav[aria-label="曲库导航"] button', { hasText: label }).first().click()
  const deadline = Date.now() + timeoutMs
  let count = 0
  while (Date.now() < deadline) {
    count = await window.locator('[data-testid="fnm-card"]').count()
    if (count > 0) break
    await window.waitForTimeout(250)
  }
  return count
}

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-renew-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

try {
  const window = await app.firstWindow()
  console.log('\n─── Step C：静默续期 ───\n')

  // -- 登录 -----------------------------------------------------------------
  await window.fill('#fnm-address', SERVER)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window.getByText('已连接', { exact: false }).first().waitFor({ timeout: 30000 })
  console.log('✓ 登录成功')

  // -- 续期前：数据可用 -----------------------------------------------------
  const before = await waitCards(window, '专辑')
  console.log(`${before > 0 ? '✓' : '✗'} 续期前拉取曲库：${before} 张专辑卡片`)
  if (before === 0) throw new Error('续期前就拉不到数据，后续验证无意义')

  // -- C-1 显式静默续期 -----------------------------------------------------
  const renewed = await window.evaluate(async () => {
    const bridge = globalThis.fn
    if (!bridge || typeof bridge.relogin !== 'function') return { error: '桥上没有 relogin' }
    try {
      return { ok: await bridge.relogin() }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  if (renewed.error) throw new Error(`续期调用失败：${renewed.error}`)
  console.log(`${renewed.ok ? '✓' : '✗'} 静默续期返回：${renewed.ok}`)
  if (!renewed.ok) throw new Error('静默续期返回 false')

  // -- C-2 续期后：数据仍可用 ------------------------------------------------
  const after = await waitCards(window, '歌手')
  console.log(`${after > 0 ? '✓' : '✗'} 续期后拉取曲库：${after} 张歌手卡片`)
  if (after === 0) throw new Error('续期后拉不到数据')

  // -- 链路信息仍一致 -------------------------------------------------------
  const conn = await window.evaluate(async () => {
    const info = await globalThis.fn.connectionInfo()
    return info ? { kind: info.kind, isRelay: info.isRelay, url: info.url } : null
  })
  console.log(`✓ 链路信息：${conn ? `${conn.kind}｜中继=${conn.isRelay}` : '（无）'}`)

  console.log('\n结论：静默续期路径在真机上可用，续期后新 token 立即生效。')
} catch (err) {
  console.log(`\n✗ Step C 失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
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
