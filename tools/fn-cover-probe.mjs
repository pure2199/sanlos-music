// 真机诊断：封面在真机上到底显示不显示（T21 用）
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// T20 的真机活体验检刷出上千条：
//
//   MediaImage src can only be of http/https/data/blob scheme:
//   fnm://srv/static/cover?coverId=album_…&size=160
//
// ⇒ 怀疑：`<img src="fnm://…">` 被 Chromium 的**图片加载器**拒了，
//    所以封面全挂成占位块（音频能播是因为 `<audio>` 走另一条加载器）。
//
// 本脚本量四件事：
//   1. 界面上到底有几个 `<img>`、几个占位块（**别靠推断**）；
//   2. 那些 `<img>` 有没有真的解码出像素（`naturalWidth > 0`）；
//   3. 渲染层能不能 `fetch('fnm://…')` 拿到字节（CORS / CSP / scheme 权限）；
//   4. 拿到字节后转成 `blob:` URL，Chromium 能不能把它当图解出来（**修法可行性的关键**）。
//
// ⚠️ 只读：不写任何数据，只登录、浏览专辑页。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-cover-probe.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertFreshBuild } from './lib/fresh-build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_SERVER = process.env.FN_SERVER ?? ''
const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
if (!FN_USER || !FN_PASS) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-cover-probe.mjs')
  process.exit(2)
}

// ⚠️ 产物必须新：否则测的是旧代码，结论会串。
assertFreshBuild('真机封面诊断')

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-cover-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})
const window = await app.firstWindow()

/** 渲染进程的 console 计数（按类型）。 */
const logCounts = {}
/** 渲染进程 console 的原始文本（用来数特定警告）。 */
const logTexts = []
window.on('console', (msg) => {
  const key = msg.type()
  logCounts[key] = (logCounts[key] || 0) + 1
  logTexts.push(msg.text())
})

/** Chromium 拒掉非 http/https/data/blob 图片时的警告前缀。 */
const UNSUPPORTED_IMAGE_SCHEME = 'MediaImage src can only be of http/https/data/blob scheme'

try {
  // -- 登录 -----------------------------------------------------------------
  await window.fill('#fnm-address', FN_SERVER.replace(/\/+$/, ''))
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window
    .getByRole('heading', { name: '已连接' })
    .waitFor({ timeout: 30000 })
    .catch(() => undefined)

  // -- 专辑页（有封面最多的页面）---------------------------------------------
  await window.locator('nav[aria-label="曲库导航"] button', { hasText: '专辑' }).first().click()
  await window.waitForTimeout(6000)

  // -- ① ② 界面上的封面实况 --------------------------------------------------
  const dom = await window.evaluate(() => {
    const imgs = [...document.querySelectorAll('img.fnm-cover__image')]
    const placeholders = document.querySelectorAll('[data-testid="cover-placeholder"]')
    const first = imgs[0]
    // ⚠️ 网格是「虚拟裁剪」的（只渲染可视区）——这里量清楚**到底挂了多少**。
    const grid = document.querySelector('.fnm-cardgrid')
    const canvas = document.querySelector('.fnm-cardgrid__canvas')
    const gridRect = grid ? grid.getBoundingClientRect() : null
    let outside = 0
    for (const img of imgs) {
      const r = img.getBoundingClientRect()
      if (gridRect && (r.top >= gridRect.bottom || r.bottom <= gridRect.top)) outside += 1
    }
    return {
      imgCount: imgs.length,
      placeholderCount: placeholders.length,
      cardCount: document.querySelectorAll('.fnm-card').length,
      gridClientHeight: grid ? grid.clientHeight : null,
      gridScrollHeight: grid ? grid.scrollHeight : null,
      gridRectHeight: gridRect ? Math.round(gridRect.height) : null,
      canvasChildren: canvas ? canvas.children.length : null,
      rowHeightVar: grid ? getComputedStyle(grid).getPropertyValue('--grid-row-height') : null,
      imgsOutsideGridViewport: outside,
      firstSrc: first ? first.currentSrc || first.src : null,
      firstComplete: first ? first.complete : null,
      firstNaturalWidth: first ? first.naturalWidth : null,
      firstNaturalHeight: first ? first.naturalHeight : null,
      /** 有多少张真的解出了像素。 */
      decodedCount: imgs.filter((i) => i.naturalWidth > 0).length,
    }
  })
  console.log(`\n[① 界面实况] ${JSON.stringify(dom, null, 2)}`)

  // ⚠️ **只看专辑页、还没播放**时就已经出现的错误 —— 这一段**没有媒体会话参与**
  //    （媒体会话封面是播放之后才发生的）⇒ 它与 T21 无关，是「曲库网格把封面打爆了」。
  console.log(`\n[①-b 仅浏览专辑页阶段] console 计数 = ${JSON.stringify(logCounts)}`)
  const errTextsBeforePlay = logTexts.filter((t) => t.includes('502') || t.includes('Bad Gateway'))
  console.log(`[①-b 仅浏览专辑页阶段] 502/Bad Gateway 条数 = ${errTextsBeforePlay.length}`)

  // ⚠️ **量整条高度链**：哪一层的 `clientHeight` 等于内容高度 → 那一层就没被约束。
  const chain = await window.evaluate(() => {
    const pick = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return { selector, missing: true }
      const style = getComputedStyle(el)
      return {
        selector,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        offsetHeight: el.offsetHeight,
        display: style.display,
        flex: style.flex,
        minHeight: style.minHeight,
        height: style.height,
        overflowY: style.overflowY,
        position: style.position,
      }
    }
    return {
      windowInnerHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      layers: [
        pick('.app-shell'),
        pick('.app-shell__main'),
        pick('.fnm-page'),
        pick('.fnm-cardgrid'),
        pick('.fnm-cardgrid__canvas'),
      ],
    }
  })
  console.log(`\n[①-c 高度链] ${JSON.stringify(chain, null, 2)}`)

  // -- ③ 渲染层能不能 fetch 到封面字节 ----------------------------------------
  const fetched = await window.evaluate(async () => {
    const el = document.querySelector('img.fnm-cover__image')
    const url = el ? el.currentSrc || el.src : null
    if (!url) return { error: '界面上没有 <img>' }
    try {
      const res = await fetch(url)
      const buf = await res.arrayBuffer()
      return {
        url,
        status: res.status,
        contentType: res.headers.get('content-type'),
        bytes: buf.byteLength,
      }
    } catch (e) {
      return { url, error: String((e && e.message) || e) }
    }
  })
  console.log(`\n[③ 渲染层 fetch 封面] ${JSON.stringify(fetched, null, 2)}`)

  // -- ④ 转成 blob: URL 后 Chromium 能不能当图解出来 --------------------------
  const blob = await window.evaluate(async () => {
    const el = document.querySelector('img.fnm-cover__image')
    const url = el ? el.currentSrc || el.src : null
    if (!url) return { error: '界面上没有 <img>' }
    try {
      const res = await fetch(url)
      const blobObj = await res.blob()
      const objectUrl = URL.createObjectURL(blobObj)
      const decoded = await new Promise((resolvePromise) => {
        const probe = new Image()
        probe.onload = () => resolvePromise({ ok: true, w: probe.naturalWidth, h: probe.naturalHeight })
        probe.onerror = () => resolvePromise({ ok: false })
        probe.src = objectUrl
      })
      URL.revokeObjectURL(objectUrl)
      return { blobType: blobObj.type, blobBytes: blobObj.size, decoded }
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  })
  console.log(`\n[④ blob: URL 解码] ${JSON.stringify(blob, null, 2)}`)

  // -- ⑤ 媒体会话（Windows SMTC）的封面 -------------------------------------
  //
  // ⚠️ 这一步才是 T21 的正题：**应用内 `<img>` 本来就能显示 `fnm://`**，
  //    挂掉的是 `navigator.mediaSession.metadata.artwork` ——
  //    Chromium 的**媒体会话**图片加载器只认 http/https/data/blob。
  await window.locator('nav[aria-label="曲库导航"] button', { hasText: '歌曲' }).first().click()
  const row = window.locator('[role="option"]').first()
  await row.waitFor({ timeout: 30000 })
  await row.dblclick()
  // 等封面取回（异步 fetch → data: URL → 重设元数据）。
  await window.waitForTimeout(8000)

  const mediaSession = await window.evaluate(() => {
    const nav = globalThis.navigator
    const session = nav && nav.mediaSession
    const metadata = session ? session.metadata : null
    const artwork = metadata && metadata.artwork ? metadata.artwork : []
    return {
      hasSession: Boolean(session),
      title: metadata ? metadata.title : null,
      artist: metadata ? metadata.artist : null,
      artworkCount: artwork.length,
      artwork: artwork.map((a) => ({
        scheme: String(a.src).split(':')[0],
        prefix: String(a.src).slice(0, 32),
        sizes: a.sizes ?? null,
        type: a.type ?? null,
      })),
    }
  })
  console.log(`\n[⑤ 媒体会话封面] ${JSON.stringify(mediaSession, null, 2)}`)

  const unsupported = logTexts.filter((t) => t.includes(UNSUPPORTED_IMAGE_SCHEME))
  console.log(`\n渲染进程 console 计数：${JSON.stringify(logCounts)}`)
  console.log(`「图片 scheme 不受支持」警告数：${unsupported.length}`)
  for (const line of unsupported.slice(0, 5)) console.log(`  ${line}`)

  console.log('\n── 判读 ──')
  const artworkSrc = mediaSession.artwork[0]?.scheme ?? '(无)'
  if (artworkSrc === 'data') {
    console.log('✅ 媒体会话封面是 data: URL（Chromium 认得）→ Windows 侧能显示专辑图。')
  } else {
    console.log(`⚠️ 媒体会话封面 scheme = ${artworkSrc}（不是 data:）→ Windows 侧仍不显示专辑图。`)
  }
  if (unsupported.length === 0) {
    console.log('✅ 没有「MediaImage src can only be …」警告。')
  } else {
    console.log(`⚠️ 仍有 ${unsupported.length} 条该警告。`)
  }
} finally {
  await Promise.race([
    app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined),
    new Promise((r) => setTimeout(r, 3000)),
  ])
  await app.close().catch(() => undefined)
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 忽略 */
  }
}
