// 真实客户端 × 真实 NAS 的活体验检（T17）。
//
// ---------------------------------------------------------------------------
// 这个脚本干什么
// ---------------------------------------------------------------------------
// 探针（`fn-*.mjs`）是「HTTP 层」的校准：直接打服务端接口，看返回什么。
// 本脚本是**客户端层**的校准：启动**真实的 Electron 客户端**（Playwright 的
// `_electron` 驱动本仓库 `node_modules/electron`），用真实账号连真实 NAS，
// 走一遍用户实际会走的路径：
//
//   登录 → 歌曲 → 收藏 → 歌单 → 专辑 → 专辑详情 → 歌手 → 歌手详情 → 风格 → 搜索 → 播放
//
// 每一步都记录：成功与否、界面上的关键文案、**控制台错误**、**失败请求**、**HTTP ≥ 400**。
// 产出是一份 JSON 报告 + 终端摘要，专门用来定位「客户端哪一步坏了」。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - **凭证只从环境变量读**：`FN_USER` / `FN_PASS`（可选 `FN_ID` / `FN_SERVER`）。
//   脚本**不打印**、**不落盘**、**不写进报告**；报告里的账号 / 主机名一律脱敏。
// - userData 隔离在临时目录 → 不碰用户的 `session.bin` / `prefs.json` / `downloads.json`，
//   也避开 Electron 的单实例锁。
// - 退出走 `app.exit(0)`（普通 `app.quit()` 会被窗口 close 拦截器挡下）。
//
// 用法：
//   FN_USER=xxx FN_PASS=yyy FN_ID=zzz node tools/fn-live-check.mjs
//   FN_SERVER=https://host:port node tools/fn-live-check.mjs   # 显式指定服务器地址
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const FN_ID = process.env.FN_ID ?? ''
const FN_SERVER = process.env.FN_SERVER ?? (FN_ID ? `https://${FN_ID}.fnos.net` : '')

if (!FN_USER || !FN_PASS || !FN_SERVER) {
  console.error('用法：FN_USER=... FN_PASS=... [FN_ID=... | FN_SERVER=...] node tools/fn-live-check.mjs')
  process.exit(2)
}

/** 脱敏替换表：敏感值一律换成占位符后再进报告。 */
const REDACTIONS = [
  [FN_PASS, '<密码>'],
  [FN_USER, '<账号>'],
  [FN_ID, '<FNID>'],
].filter(([raw]) => typeof raw === 'string' && raw.length > 0)

/** 把一段文本里的敏感值换成占位符。 */
function redact(text) {
  let out = String(text ?? '')
  for (const [raw, placeholder] of REDACTIONS) {
    if (raw) out = out.split(raw).join(placeholder)
  }
  // 服务器主机名也一并脱敏（报告不该泄露 NAS 域名）。
  const host = safeHost(FN_SERVER)
  if (host) out = out.split(host).join('<服务器>')
  return out
}

/** 取 URL 的 host（解析失败返回空串）。 */
function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

/** 全局收集到的异常（控制台 / 页面异常 / 网络失败）。 */
const consoleErrors = []
const pageErrors = []
const failedRequests = []
const httpErrors = []

/** 每一步的结果。 */
const steps = []

/**
 * 跑一步，记录成功 / 失败与细节。
 *
 * @param {string} name 步骤名
 * @param {() => Promise<string | void>} fn 步骤实现；返回的字符串会进报告（已脱敏）
 */
async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    steps.push({ name, ok: true, ms: Date.now() - started, detail: redact(detail ?? '') })
    console.log(`  ✓ ${name}${detail ? ` — ${redact(detail)}` : ''}`)
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err))
    steps.push({ name, ok: false, ms: Date.now() - started, error: message })
    console.log(`  ✗ ${name} — ${message}`)
  }
}

/** 读一段文本（找不到就返回空串）。 */
async function textOf(page, selector) {
  const loc = page.locator(selector).first()
  if ((await loc.count()) === 0) return ''
  return ((await loc.textContent()) ?? '').trim()
}

/** 把「m:ss」/「h:mm:ss」解析成秒（解析不了返回 0）。 */
function toSeconds(text) {
  const parts = String(text ?? '')
    .split(':')
    .map((part) => Number(part))
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 临时 userData 目录。 */
const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-live-'))

/**
 * 下载目录：重定向到临时目录。
 *
 * ⚠️ 默认的下载目录是**用户真实的「我的音乐\飞牛音乐」**——
 *    活体验检会真的下载一首无损（几十 MB），绝不能往用户曲库里塞垃圾。
 *    `prefs.downloadDir` 是主进程 `PrefsStore` 的白名单键之一（非敏感偏好），
 *    故这里预置一份 `prefs.json` 即可（目录挂在 userData 下 → 退出时一并清掉）。
 */
const downloadDir = join(userDataDir, 'downloads')
mkdirSync(downloadDir, { recursive: true })
writeFileSync(
  join(userDataDir, 'prefs.json'),
  JSON.stringify({ downloadDir }, null, 2),
  'utf8',
)

/** 启动应用。 */
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

const window = await app.firstWindow()

window.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(redact(msg.text()))
})
window.on('pageerror', (err) => {
  pageErrors.push(redact(err instanceof Error ? err.message : String(err)))
})
window.on('requestfailed', (req) => {
  failedRequests.push({
    url: redact(req.url()),
    error: redact(req.failure()?.errorText ?? 'unknown'),
  })
})
window.on('response', (res) => {
  if (res.status() >= 400) {
    httpErrors.push({ url: redact(res.url()), status: res.status() })
  }
})

console.log(`\n飞牛音乐 · 真机活体验检\n服务器：${redact(FN_SERVER)}\n`)

try {
  // -- 1. 登录 ---------------------------------------------------------------
  await step('登录（真实 NAS）', async () => {
    await window.fill('#fnm-address', FN_SERVER)
    await window.fill('#fnm-username', FN_USER)
    await window.fill('#fnm-password', FN_PASS)
    await window.click('button[type="submit"]')
    const ok = await window
      .getByText('已连接', { exact: false })
      .first()
      .waitFor({ timeout: 30000 })
      .then(() => true)
      .catch(() => false)
    if (!ok) {
      const err = await textOf(window, '.fnm-login__error')
      throw new Error(err ? `登录失败：${err}` : '登录失败：未出现「已连接」')
    }
    return '已连接'
  })

  // -- 2. 曲库各页 -----------------------------------------------------------
  const navTo = async (label) => {
    await window.locator('nav[aria-label="曲库导航"] button', { hasText: label }).first().click()
  }

  const listStats = async (page) => {
    // ⚠️ 虚拟列表要先量出视口高度才渲染行，所以**轮询**等行出现，不能只看一次。
    const deadline = Date.now() + 30000
    let rows = 0
    let status = ''
    while (Date.now() < deadline) {
      rows = await page.locator('[role="option"]').count()
      if (rows > 0) break
      await page.waitForTimeout(250)
    }
    status = await textOf(page, '.fnm-songlist__status')
    return { rows, status }
  }

  await step('歌曲页加载', async () => {
    await navTo('歌曲')
    const { rows, status } = await listStats(window)
    if (rows === 0) throw new Error(`没有渲染出歌曲行（状态：${status || '无'}）`)
    return `${rows} 行｜${status}`
  })

  await step('收藏页加载', async () => {
    await navTo('收藏')
    const { rows, status } = await listStats(window)
    return `${rows} 行｜${status}`
  })

  await step('歌单页加载', async () => {
    await navTo('歌单')
    await window.waitForTimeout(1500)
    const cards = await window.locator('[data-testid="fnm-card"]').count()
    const empty = await textOf(window, '.fnm-page__empty')
    const err = await textOf(window, '.fnm-page__error')
    if (err) throw new Error(err)
    return `${cards} 张卡片${empty ? `｜${empty}` : ''}`
  })

  await step('专辑页加载', async () => {
    await navTo('专辑')
    await window.locator('[data-testid="fnm-card"] button.fnm-card__button').first().waitFor({ timeout: 20000 })
    const cards = await window.locator('[data-testid="fnm-card"]').count()
    return `${cards} 张卡片`
  })

  // -- 3. 专辑详情（已知缺陷点）--------------------------------------------
  await step('专辑详情（点开第一张专辑卡）', async () => {
    await navTo('专辑')
    const card = window.locator('[data-testid="fnm-card"] button.fnm-card__button').first()
    await card.waitFor({ timeout: 20000 })
    const title = ((await card.locator('.fnm-card__title').textContent()) ?? '').trim()
    await card.click()
    await window.waitForTimeout(4000)
    const err = await textOf(window, '.fnm-page__error')
    const rows = await window.locator('[role="option"]').count()
    if (err) throw new Error(`${title}：${err}`)
    if (rows === 0) throw new Error(`${title}：详情页没有曲目行`)
    return `${title}：${rows} 首`
  })

  await step('歌手页加载', async () => {
    await navTo('歌手')
    await window.locator('[data-testid="fnm-card"] button.fnm-card__button').first().waitFor({ timeout: 20000 })
    const cards = await window.locator('[data-testid="fnm-card"]').count()
    return `${cards} 张卡片`
  })

  await step('歌手详情（点开第一位歌手卡）', async () => {
    await navTo('歌手')
    const card = window.locator('[data-testid="fnm-card"] button.fnm-card__button').first()
    await card.waitFor({ timeout: 20000 })
    const name = ((await card.locator('.fnm-card__title').textContent()) ?? '').trim()
    await card.click()
    await window.waitForTimeout(4000)
    const err = await textOf(window, '.fnm-page__error')
    if (err) throw new Error(`${name}：${err}`)
    const rows = await window.locator('[role="option"]').count()
    return `${name}：${rows} 首`
  })

  await step('风格页加载', async () => {
    await navTo('风格')
    await window.locator('[data-testid="fnm-card"] button.fnm-card__button').first().waitFor({ timeout: 20000 })
    const cards = await window.locator('[data-testid="fnm-card"]').count()
    return `${cards} 张卡片`
  })

  await step('风格详情（点开第一个风格卡）', async () => {
    await navTo('风格')
    const card = window.locator('[data-testid="fnm-card"] button.fnm-card__button').first()
    await card.waitFor({ timeout: 20000 })
    const name = ((await card.locator('.fnm-card__title').textContent()) ?? '').trim()
    await card.click()
    await window.waitForTimeout(4000)
    const err = await textOf(window, '.fnm-page__error')
    if (err) throw new Error(`${name}：${err}`)
    const rows = await window.locator('[role="option"]').count()
    return `${name}：${rows} 首`
  })

  // -- 4. 搜索 ---------------------------------------------------------------
  await step('搜索（真实服务端）', async () => {
    await window.locator('nav[aria-label="主导航"] button', { hasText: '搜索' }).first().click()
    const input = window.locator('input[type="search"], input[type="text"]').first()
    await input.waitFor({ timeout: 10000 })
    await input.fill('占位歌手三')
    await input.press('Enter')
    await window.waitForTimeout(6000)
    const tracks = await textOf(window, '[data-testid="fnm-search-count-tracks"]')
    const albums = await textOf(window, '[data-testid="fnm-search-count-albums"]')
    const artists = await textOf(window, '[data-testid="fnm-search-count-artists"]')
    const err = await textOf(window, '.fnm-page__error')
    if (err) throw new Error(err)
    return `${tracks}｜${albums}｜${artists}`
  })

  // -- 5. 播放 ---------------------------------------------------------------
  await step('播放（双击歌曲行 → 播放条更新 + 进度真的推进）', async () => {
    await navTo('歌曲')
    const listbox = window.locator('[role="listbox"]').first()
    await listbox.waitFor({ timeout: 20000 })
    const row = window.locator('[role="option"]').first()
    await row.waitFor({ timeout: 20000 })
    const title = ((await row.locator('.fnm-songlist__title').textContent()) ?? '').trim()
    await row.dblclick()

    // ⚠️ **必须验「进度真的推进了」**——只看播放条标题会把「媒体根本没播起来」判成通过。
    //    （T18-6 的 CSP 缺陷就是这么漏过去的：标题变了，音频却被 URL 安全检查拒了。）
    const deadline = Date.now() + 30000
    let position = ''
    let errorNotice = ''
    while (Date.now() < deadline) {
      await window.waitForTimeout(1000)
      position = await textOf(window, '[data-testid="player-position"]')
      // ⚠️ 只认 **role="alert"** 的提示：那才是错误；role="status" 是「正在转换…」/「音质有损」这类说明。
      errorNotice = await textOf(window, '[data-testid="player-notice"][role="alert"]')
      if (toSeconds(position) > 0 || errorNotice) break
    }

    const barTitle = await textOf(window, '.fnm-playerbar__title')
    if (barTitle === '未在播放') throw new Error(`播放条仍是「未在播放」${errorNotice ? `｜提示：${errorNotice}` : ''}`)
    if (errorNotice) throw new Error(`播放报错：${errorNotice}`)
    if (toSeconds(position) <= 0) {
      throw new Error(`进度没有推进（仍停在 ${position || '（无）'}）——音频没有真正播起来`)
    }
    return `曲目「${title}」→ 播放条「${barTitle}」｜进度 ${position}`
  })

  // -- 5b. 本地播放（下载到本地 → 走 fnml://）---------------------------------
  //
  // ⚠️ 这条路径**曾经整条是坏的**：CSP 的 `media-src` 漏了 `fnml:` →
  //    Chromium 的 URL 安全检查直接拒绝 `<audio src="fnml://…">`，
  //    而报错文案却写着「当前内核不支持该格式」——极具误导性。
  //    ⇒ 这条 step 必须真的**下载 + 本地播**，只看播放条标题是抓不到的。
  await step('本地播放（下载后走 fnml:// 且进度推进）', async () => {
    await navTo('歌曲')
    const listbox = window.locator('[role="listbox"]').first()
    await listbox.waitFor({ timeout: 20000 })
    const row = window.locator('[role="option"]').first()
    await row.waitFor({ timeout: 20000 })

    // 劫持媒体元素的 src 赋值（引擎的 <audio> **从不挂进 DOM**，只能从原型上观测）。
    await window.evaluate(() => {
      window.__srcs = []
      const proto = HTMLMediaElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'src')
      Object.defineProperty(proto, 'src', {
        configurable: true,
        get() {
          return desc.get.call(this)
        },
        set(value) {
          window.__srcs.push(String(value))
          desc.set.call(this, value)
        },
      })
    })

    const dlButton = row.locator('[data-testid="fnm-download-button"]').first()
    await dlButton.waitFor({ timeout: 10000 })
    await dlButton.scrollIntoViewIfNeeded()
    await dlButton.click()

    // 等下载完成（走 NAS；中继带宽有限，**无损**文件几十 MB，可能要几分钟）。
    const dlDeadline = Date.now() + 600000
    let status = ''
    while (Date.now() < dlDeadline) {
      status = (await dlButton.getAttribute('data-status')) ?? ''
      if (status === 'done' || status === 'error') break
      await window.waitForTimeout(1500)
    }
    if (status !== 'done') throw new Error(`下载没有完成（状态 ${status || '（无）'}）`)

    // 本地优先播放会切到 `fnml://` —— 再播一次，验它确实走本地。
    await row.dblclick()
    const playDeadline = Date.now() + 30000
    let position = ''
    let srcs = []
    while (Date.now() < playDeadline) {
      await window.waitForTimeout(1000)
      position = await textOf(window, '[data-testid="player-position"]')
      srcs = await window.evaluate(() => window.__srcs ?? [])
      if (toSeconds(position) > 0) break
    }
    const localSrc = srcs.find((value) => value.startsWith('fnml://')) ?? ''
    if (!localSrc) {
      throw new Error(`没有观察到 fnml:// 播放源（实际 src：${srcs.join(' | ') || '（无）'}）`)
    }
    if (toSeconds(position) <= 0) {
      throw new Error(`本地播放进度没有推进（仍停在 ${position || '（无）'}）`)
    }
    return `播放源 ${localSrc}｜进度 ${position}`
  })

  // -- 6. 最近播放（本地记录）------------------------------------------------
  await step('最近播放（本机记录）', async () => {
    await navTo('最近')
    await window.waitForTimeout(1500)
    const { rows, status } = await listStats(window)
    return `${rows} 行｜${status}`
  })
} finally {
  // -- 退出 -----------------------------------------------------------------
  await Promise.race([
    app
      .evaluate(({ app: electronApp }) => electronApp.exit(0))
      .catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  await app.close().catch(() => undefined)
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 清理失败不掩盖结果 */
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const report = {
  at: new Date().toISOString(),
  server: redact(FN_SERVER),
  steps,
  consoleErrors,
  pageErrors,
  failedRequests,
  httpErrors,
}

const outDir = join(APP_ROOT, 'release', 'verify')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `live-check-${Date.now()}.json`)
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const failed = steps.filter((s) => !s.ok)
console.log('\n────────── 摘要 ──────────')
console.log(`步骤：${steps.length - failed.length}/${steps.length} 成功`)
if (failed.length > 0) {
  console.log('\n失败步骤：')
  for (const s of failed) console.log(`  ✗ ${s.name} — ${s.error}`)
}
if (consoleErrors.length > 0) {
  console.log(`\n控制台错误（${consoleErrors.length} 条，前 12 条）：`)
  for (const e of consoleErrors.slice(0, 12)) console.log(`  · ${e}`)
}
if (pageErrors.length > 0) {
  console.log(`\n页面异常（${pageErrors.length} 条，前 8 条）：`)
  for (const e of pageErrors.slice(0, 8)) console.log(`  · ${e}`)
}
if (httpErrors.length > 0) {
  console.log(`\nHTTP ≥ 400（${httpErrors.length} 条，前 12 条）：`)
  for (const e of httpErrors.slice(0, 12)) console.log(`  · ${e.status} ${e.url}`)
}
if (failedRequests.length > 0) {
  console.log(`\n失败请求（${failedRequests.length} 条，前 12 条）：`)
  for (const e of failedRequests.slice(0, 12)) console.log(`  · ${e.error} ${e.url}`)
}
console.log(`\n报告：${outFile}`)
process.exit(failed.length > 0 ? 1 : 0)
