// ---------------------------------------------------------------------------
// 真机复现探针 v2：EQ / 队列 / 歌词页 / 桌面歌词
// ---------------------------------------------------------------------------
//
// 复用用户真实 userData 目录的**副本**（含 `session.bin` → 自动登录）起实例，
// **播一首歌**后逐个打开那四处截图，并量关键元素几何 + 收集 console。
//
// ⚠️ 用的是副本目录 → 不碰用户自己那个实例（单实例锁互不影响）。
// ⚠️ 副本里的 `lockfile` 必须删：它记着旧实例 PID，Electron 会直接 quit。
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { cpSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP_ROOT = resolve(process.cwd())
const REAL_USER_DATA = join(process.env.APPDATA ?? '', 'fnmusic-desktop')
const OUT_DIR = join(APP_ROOT, 'release', 'shots')

/** 量一组选择器的几何（找不到就跳过）。 */
const GEOMETRY = [
  '.fnm-fullplayer',
  '.fnm-fullplayer__body',
  '.fnm-fullplayer__cover',
  '.fnm-fullplayer__panel',
  '.fnm-lyricview',
  '.fnm-lyricview__empty',
  '.fnm-lyricview__line',
  '.fnm-fullplayer__controls',
  '.fnm-playerbar',
  '.fnm-eq',
  '.fnm-eqpanel',
  '.fnm-playerbar__eq',
  '.fnm-playerbar__queue',
  '.fnm-lyricoverlay',
]

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const dir = mkdtempSync(join(tmpdir(), 'fnmusic-repro-'))
  cpSync(REAL_USER_DATA, dir, { recursive: true })
  rmSync(join(dir, 'lockfile'), { force: true })

  const app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${dir}`],
    env: process.env,
  })
  const win = await app.firstWindow()
  const logs = []
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  const shot = async (name, target = win) => {
    const path = join(OUT_DIR, `${name}.png`)
    await target.screenshot({ path })
    console.log('截图：', path)
  }
  const geometry = async () =>
    win.evaluate((sels) => {
      const out = {}
      for (const sel of sels) {
        const el = document.querySelector(sel)
        if (!el) continue
        const r = el.getBoundingClientRect()
        out[sel] = {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          clientH: el.clientHeight,
          scrollH: el.scrollHeight,
        }
      }
      return out
    }, GEOMETRY)

  await win.waitForTimeout(5000)

  // --- 1. 进曲库并播一首歌 -------------------------------------------------
  await win.getByRole('button', { name: '歌曲', exact: true }).click()
  const list = win.getByRole('listbox', { name: '歌曲列表' })
  await list.getByRole('option').first().waitFor({ timeout: 30000 })
  console.log('曲库已加载')
  await list.getByRole('option').first().dblclick()
  await win.waitForTimeout(8000)
  await shot('10-播放中')

  // --- 1b. 原始歌词诊断：两条 entry 的内容到底差在哪 -----------------------
  const lyricRaw = await win.evaluate(async () => {
    const btn = document.querySelector('.fnm-songlist__row [data-song-id], [data-song-id]')
    const id = btn ? btn.getAttribute('data-song-id') : ''
    const out = { id }
    if (!id) return out
    try {
      const r = await fetch(`fnm://srv/lyric/list?trackGUID=${encodeURIComponent(id)}`)
      const j = await r.json()
      const list = (j && (j.data?.list || j.list)) || []
      out.count = list.length
      out.entries = list.map((e) => ({
        source: e.source ?? e.lyricSource ?? '(无 source)',
        offset: e.offset,
        head: String(e.content ?? '').split('\n').slice(0, 8),
      }))
    } catch (e) {
      out.error = e.message
    }
    return out
  })
  console.log('\n=== 原始歌词诊断 ===')
  console.log(JSON.stringify(lyricRaw, null, 2))

  // --- 2. 全屏播放页（歌词页）----------------------------------------------
  await win.getByRole('button', { name: /全屏/ }).first().click()
  await win.waitForTimeout(2500)
  await shot('11-全屏歌词页')
  console.log('\n=== 全屏页几何 ===')
  console.log(JSON.stringify(await geometry(), null, 2))

  // --- 2b. 封面取色诊断 ---------------------------------------------------
  const tint = await win.evaluate(async () => {
    const img = document.querySelector('.fnm-fullplayer__cover img')
    const out = { hasImg: !!img }
    if (!img) return out
    const url = img.currentSrc || img.src
    out.url = url
    try {
      const r = await fetch(url, { mode: 'cors' })
      out.cors = `status=${r.status} acao=${r.headers.get('access-control-allow-origin')}`
    } catch (e) {
      out.cors = `fetch failed: ${e.message}`
    }
    try {
      const im = new Image()
      im.crossOrigin = 'anonymous'
      await new Promise((res, rej) => {
        im.onload = res
        im.onerror = () => rej(new Error('img load error'))
        im.src = url
      })
      const c = document.createElement('canvas')
      c.width = 8
      c.height = 8
      const ctx = c.getContext('2d')
      ctx.drawImage(im, 0, 0, 8, 8)
      const d = ctx.getImageData(0, 0, 8, 8).data
      out.canvas = `ok first=[${d[0]},${d[1]},${d[2]},${d[3]}]`
    } catch (e) {
      out.canvas = `canvas failed: ${e.message}`
    }
    const full = document.querySelector('.fnm-fullplayer')
    out.tintVar = full ? getComputedStyle(full).getPropertyValue('--fnm-fullplayer__tint') : ''
    out.background = full ? getComputedStyle(full).backgroundImage : ''
    return out
  })
  console.log('\n=== 封面取色诊断 ===')
  console.log(JSON.stringify(tint, null, 2))

  // --- 3. 队列 tab ---------------------------------------------------------
  const queueTab = win.getByRole('button', { name: '队列', exact: true }).first()
  if (await queueTab.count()) {
    await queueTab.click()
    await win.waitForTimeout(800)
    await shot('12-全屏队列')
  }

  // 关掉全屏页（⚠️ × 按钮会被队列行盖住 → 用 Esc）。
  await win.keyboard.press('Escape')
  await win.waitForTimeout(800)

  // --- 4. EQ 面板（播放条入口）--------------------------------------------
  const eqBtn = win.getByRole('button', { name: 'EQ', exact: true }).first()
  console.log('EQ 按钮数：', await eqBtn.count())
  await eqBtn.click({ timeout: 10000 })
  await win.waitForTimeout(1200)
  await shot('13-EQ面板')
  console.log('\n=== EQ 面板几何 ===')
  console.log(JSON.stringify(await geometry(), null, 2))
  const eqText = await win.evaluate(() => {
    const el = document.querySelector('.fnm-eq, .fnm-eq__panel, [class*="eq"]')
    return el ? el.innerText.slice(0, 1200) : '（找不到 EQ 面板）'
  })
  console.log('\n=== EQ 面板文本 ===\n' + eqText)

  // --- 5. 桌面悬浮歌词 -----------------------------------------------------
  await win.getByRole('button', { name: '设置' }).click()
  await win.waitForTimeout(600)
  const overlayToggle = win.locator('input[name="fnm-lyric-overlay"]')
  console.log('桌面歌词开关数：', await overlayToggle.count())
  const checked = await overlayToggle.isChecked()
  console.log('桌面歌词当前状态：', checked ? '已开' : '未开')
  if (!checked) {
    await overlayToggle.check()
    await win.waitForTimeout(2500)
  }
  await shot('14-设置面板')

  const wins = app.windows()
  console.log('\n窗口数：', wins.length)
  for (let i = 0; i < wins.length; i += 1) {
    const w = wins[i]
    const url = w.url()
    const isLyric = url.includes('lyric')
    console.log(` 窗口${i}: ${url}`)
    try {
      await w.screenshot({ path: join(OUT_DIR, `15-窗口${i}-${isLyric ? '桌面歌词' : '主'}.png`) })
      console.log('  截图 OK')
    } catch (err) {
      console.log('  截图失败：', err.message)
    }
  }

  console.log('\n=== console / pageerror（最后 40 条）===')
  for (const line of logs.slice(-40)) console.log(line)

  await app.evaluate(({ app: a }) => a.exit(0))
  await app.close().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

main().catch((err) => {
  console.error('探针失败：', err)
  process.exit(1)
})
