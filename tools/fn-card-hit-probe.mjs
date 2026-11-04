// 卡片点击被拦截的根因定位（T17）。
//
// 活体验检里「点开第一张专辑卡」始终失败，Playwright 报：
//   <div data-index="3" role="listitem" class="fnm-cardgrid__cell"> intercepts pointer events
// 也就是：**点击点落在单元格子本身，而不是里面的按钮**。
//
// 这个脚本直接问浏览器「那个点上到底是什么元素」：
//   - 按钮 / 单元格的 bounding box；
//   - `document.elementFromPoint(按钮中心)` 返回谁；
//   - 中心点上 `elementFromPoint` 链上的每一层；
//   - 顺带截一张图（肉眼确认布局）。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-card-hit-probe.mjs
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
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-card-hit-probe.mjs')
  process.exit(2)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-cardhit-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

try {
  const window = await app.firstWindow()
  await window.fill('#fnm-address', SERVER)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window.getByText('已连接', { exact: false }).first().waitFor({ timeout: 30000 })

  await window.locator('nav[aria-label="曲库导航"] button', { hasText: '专辑' }).first().click()
  await window.locator('[data-testid="fnm-card"] button.fnm-card__button').first().waitFor({ timeout: 20000 })
  await window.waitForTimeout(1500)

  const info = await window.evaluate(() => {
    const button = document.querySelector('[data-testid="fnm-card"] button.fnm-card__button')
    if (!button) return { error: 'no button' }
    const rect = button.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const hit = document.elementFromPoint(cx, cy)

    /** 命中点上的元素链（自上而下）。 */
    const chain = []
    let node = hit
    while (node && chain.length < 8) {
      chain.push({
        tag: node.tagName,
        cls: node.className?.toString?.().slice(0, 80) ?? '',
        testid: node.getAttribute?.('data-testid') ?? '',
        index: node.getAttribute?.('data-index') ?? '',
        rect: (() => {
          const r = node.getBoundingClientRect()
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        })(),
      })
      node = node.parentElement
    }

    const cell = button.closest('.fnm-cardgrid__cell')
    const cellRect = cell?.getBoundingClientRect()
    const styles = button ? getComputedStyle(button) : null
    const cellStyles = cell ? getComputedStyle(cell) : null

    const grid = document.querySelector('.fnm-cardgrid')
    const cells = Array.from(document.querySelectorAll('.fnm-cardgrid__cell')).slice(0, 8)

    return {
      buttonRect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      cells: cells.map((c) => {
        const r = c.getBoundingClientRect()
        const cs = getComputedStyle(c)
        return {
          index: c.getAttribute('data-index'),
          inlineStyle: c.getAttribute('style'),
          computedLeft: cs.left,
          computedWidth: cs.width,
          rect: { x: Math.round(r.left), w: Math.round(r.width) },
        }
      }),
      canvasInlineStyle: document.querySelector('.fnm-cardgrid__canvas')?.getAttribute('style') ?? '',
      cellRect: cellRect
        ? { x: Math.round(cellRect.left), y: Math.round(cellRect.top), w: Math.round(cellRect.width), h: Math.round(cellRect.height) }
        : null,
      cellIndex: cell?.getAttribute('data-index') ?? '',
      hitTag: hit?.tagName ?? 'none',
      hitClass: hit?.className?.toString?.().slice(0, 100) ?? '',
      hitIsButtonOrChild: hit ? button.contains(hit) : false,
      buttonStyle: styles
        ? {
            display: styles.display,
            position: styles.position,
            height: styles.height,
            overflow: styles.overflow,
            pointerEvents: styles.pointerEvents,
            visibility: styles.visibility,
            opacity: styles.opacity,
          }
        : null,
      cellStyle: cellStyles
        ? {
            display: cellStyles.display,
            position: cellStyles.position,
            overflow: cellStyles.overflow,
            zIndex: cellStyles.zIndex,
            pointerEvents: cellStyles.pointerEvents,
          }
        : null,
      chain,
      gridRect: (() => {
        const grid = document.querySelector('.fnm-cardgrid')
        if (!grid) return null
        const r = grid.getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      })(),
      canvasRect: (() => {
        const canvas = document.querySelector('.fnm-cardgrid__canvas')
        if (!canvas) return null
        const r = canvas.getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      })(),
    }
  })

  console.log('\n─── 卡片命中检测 ───\n')
  console.log(JSON.stringify(info, null, 2))

  const shot = join(APP_ROOT, 'release', 'verify', 'card-hit.png')
  await window.screenshot({ path: shot })
  console.log(`\n截图：${shot}`)
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
