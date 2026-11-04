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

import { assertFreshBuild } from './lib/fresh-build.mjs'

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

// ⚠️ **构建新鲜度闸门（T20 引入）**：
//    活体验检跑的是**磁盘上那份 `dist/`**，不是源码。
//    T20 曾因为 `dist/` 陈旧，把「拖动定位失败」误判成产品缺陷——
//    实际上那次跑的根本不是当前代码。产物过期就在这里**硬失败**，
//    绝不允许「拿旧代码的结论当现在的结论」。
assertFreshBuild('真机活体验检')

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

  // -- 5a. 拖动进度条定位（Range 分段请求）-----------------------------------
  //
  // ⚠️ 这条链路**此前整条都没有被任何测试覆盖过**：
  //    用户拖进度条 → UI 预览 → 松手提交 → 引擎写 `currentTime`
  //      → Chromium 对 `fnm://` 发起 **Range 分段请求** → 代理透传 → NAS 回 206。
  //
  // ⚠️ **真机独有的断言**是最后那一条「**进度从新位置继续推进**」：
  //    mock 做不到（mock 的 WAV 从中间字节开始返回时没有文件头，Chromium 的 WAV
  //    解码器解不了），而真机 NAS **确实支持 Range**（T20 探针实测：206 +
  //    `content-range`，且**重叠区间字节完全一致**）→ 这条断言是真机才跑得起来的。
  //
  // ⚠️ 只往前挪 5 秒：真机走中继，带宽有限（~230 KB/s），挪太远要等很久。
  await step('拖动进度条定位（Range 分段 → 媒体真的跳到新位置并继续播）', async () => {
    // 劫持 `currentTime` 的 setter（引擎的 <audio> **从不挂进 DOM**，只能从原型上观测）。
    // 同时劫持 `src`：用它判断**媒体元素到底存不存在**（引擎懒创建，没建就没有 element）。
    await window.evaluate(() => {
      window.__seekWrites = []
      window.__mediaSrcs = []
      // ⚠️ **读**也劫持：引擎每帧读一次 `element.currentTime`（`tick` 里）。
      //    记录最后一次读到的值 → 能**直接**看出「媒体元素本身在不在推进」。
      //    ⚠️ 这很重要：引擎的进度**也可能是时钟外推**出来的
      //    （`tick` 里 `mediaTime > 0` 才用媒体值，否则用 `position + 经过的秒数`）
      //    → **只看界面上的进度条，证明不了音频真的在响**（T18-6 同一类假绿）。
      window.__ctReads = { last: null, count: 0 }
      const proto = HTMLMediaElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'currentTime')
      window.__hasCurrentTimeAccessor = Boolean(desc && desc.get && desc.set)
      if (desc && desc.get && desc.set) {
        Object.defineProperty(proto, 'currentTime', {
          configurable: true,
          get() {
            const value = desc.get.call(this)
            window.__ctReads.last = Number(value)
            window.__ctReads.count += 1
            return value
          },
          set(value) {
            window.__seekWrites.push(Number(value))
            desc.set.call(this, value)
          },
        })
      }
      const srcDesc = Object.getOwnPropertyDescriptor(proto, 'src')
      if (srcDesc && srcDesc.get && srcDesc.set) {
        Object.defineProperty(proto, 'src', {
          configurable: true,
          get() {
            return srcDesc.get.call(this)
          },
          set(value) {
            window.__mediaSrcs.push(String(value))
            srcDesc.set.call(this, value)
          },
        })
      }
    })

    /** 收集这一步的现场（失败时一并报出来，免得再猜一轮）。 */
    const diagnose = async () =>
      await window.evaluate(() => {
        const slider = document.querySelector('input[aria-label="播放进度"]')
        return {
          writes: window.__seekWrites ?? [],
          hasAccessor: window.__hasCurrentTimeAccessor === true,
          mediaSrcs: window.__mediaSrcs ?? [],
          ctReads: window.__ctReads ?? null,
          sliderCount: document.querySelectorAll('input[aria-label="播放进度"]').length,
          sliderValue: slider ? slider.value : null,
          sliderMax: slider ? slider.max : null,
          sliderDisabled: slider ? slider.disabled : null,
          position: document.querySelector('[data-testid="player-position"]')?.textContent ?? '',
        }
      })

    const slider = window.locator('input[aria-label="播放进度"]')
    await slider.waitFor({ timeout: 20000 })
    // 等媒体元素报出时长（进度条才可用）。
    const enableDeadline = Date.now() + 30000
    while (Date.now() < enableDeadline) {
      if ((await slider.getAttribute('disabled')) === null) break
      await window.waitForTimeout(500)
    }
    const max = Number(await slider.getAttribute('max'))
    if (!Number.isFinite(max) || max <= 0) throw new Error('进度条没有可用时长（媒体没报出 duration）')

    const before = toSeconds(await textOf(window, '[data-testid="player-position"]'))

    // ⚠️ 先确认「**媒体元素本身**」在推进——界面上的进度**也可能是时钟外推**出来的
    //    （引擎的 `tick` 在 `element.currentTime` 为 0 时用 `position + 经过的秒数`）。
    //    只看进度条证明不了音频真的在响（T18-6 同一类假绿）。
    const ctSample = async () => await window.evaluate(() => window.__ctReads?.last ?? null)
    const ctA = await ctSample()
    await window.waitForTimeout(2500)
    const ctB = await ctSample()

    const target = Math.min(before + 5, max - 1)
    if (target <= 1) throw new Error(`曲目太短（${max}s），没法验拖动定位`)

    // ⚠️ 必须用**原生 setter**：React 给 `<input>` 装的 value 追踪器会把
    //    `el.value = x` 判成「值没变」→ onChange 不触发 → 这次拖动是假的。
    await slider.evaluate((el, value) => {
      const input = el
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, target)
    await slider.dispatchEvent('mouseup')

    // -- 断言 1：媒体元素真的被 seek 到目标位置（不是只动了滑块）----------
    const writeDeadline = Date.now() + 10000
    let writes = []
    while (Date.now() < writeDeadline) {
      writes = await window.evaluate(() => window.__seekWrites ?? [])
      if (writes.some((v) => Math.abs(v - target) <= 0.5)) break
      await window.waitForTimeout(300)
    }
    if (!writes.some((v) => Math.abs(v - target) <= 0.5)) {
      const d = await diagnose()
      throw new Error(
        `媒体元素没有被 seek 到 ${target}s｜媒体 currentTime 采样 ${ctA}→${ctB}` +
          `｜现场：${JSON.stringify(d)}`,
      )
    }

    // -- 断言 2（真机独有）：**从新位置继续播** -----------------------------
    //    需要上游支持 Range **且**格式可随机访问；否则 Chromium 会从头播，
    //    进度会退回 0 附近 → 这里就会红。
    const posDeadline = Date.now() + 60000
    let after = 0
    while (Date.now() < posDeadline) {
      await window.waitForTimeout(1000)
      after = toSeconds(await textOf(window, '[data-testid="player-position"]'))
      if (after >= target - 1) break
    }
    if (after < target - 1) {
      throw new Error(
        `seek 之后进度没有从新位置继续（目标 ${target}s，实际停在 ${after}s）` +
          `——上游可能不支持 Range，或该格式不可随机访问`,
      )
    }
    return (
      `从 ${before}s 拖到 ${target}s｜媒体写入 ${JSON.stringify(writes)}` +
      `｜媒体 currentTime ${ctA}→${ctB}｜进度继续到 ${after}s`
    )
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

  // -- 7. 自动更新（Task 23）-------------------------------------------------
  //
  // ⚠️ **只验「没配地址时如实提示」**：真机没有更新服务器，
  //    也不该去访问第三方地址（那不是本应用该做的事）。
  //    「检查更新」在没配地址时必须**立刻**回「还没填地址」，而不是去联网。
  await step('自动更新（未配置地址时如实提示，不联网）', async () => {
    await window.getByRole('button', { name: '设置' }).click()
    await window.waitForTimeout(400)
    const baseUrl = window.locator('input[name="fnm-update-base-url"]')
    await baseUrl.waitFor({ timeout: 10000 })
    const current = await baseUrl.inputValue()
    if (current.trim() !== '') {
      throw new Error(`更新服务器地址本该是空的，却读到「${current}」`)
    }
    await window.getByRole('button', { name: '检查更新' }).click()
    const hint = window.getByTestId('update-not-configured')
    await hint.waitFor({ timeout: 10000 })
    const text = (await hint.textContent())?.trim() ?? ''
    return text
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
