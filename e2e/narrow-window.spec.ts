import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'

// ---------------------------------------------------------------------------
// T40：窄窗口适配（E2E）
// ---------------------------------------------------------------------------
//
// ⚠️ 这一组用例验的是**真实窗口**上的行为，jsdom / Vitest 里**一个都不存在**：
//    - 窗口能不能被拖到比下限更小（`BrowserWindow` 的 `minWidth` / `minHeight`）；
//    - 最小宽度下，顶栏会不会横向溢出；
//    - 最小宽度下，品牌名会不会被压成竖排；
//    - 最小宽度下，页面会不会出横向滚动条。
//
// ⚠️ 全部数据都是 mock 的占位数据，不含真实 FN ID / 账号 / 口令。
// ---------------------------------------------------------------------------

/** 窗口最小尺寸（与 `electron/windowBounds.ts` 的常量一致）。 */
const MIN_WIDTH = 800
const MIN_HEIGHT = 520

test.describe.serial('Sanlos Music 桌面端：窄窗口适配（T40）', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
    // ⚠️ T38：未登录时主区默认是本地音乐页 → 先点顶栏的「连接」进登录页。
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await expect(fixture.window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
    await login(fixture.window, fixture.mock.url)
    // ⚠️ 等**曲库导航**出现（已登录态才有 → 顶栏 10 颗按钮，最坏情况）。
    await expect(fixture.window.getByRole('button', { name: '最近', exact: true })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  test('窗口缩不到最小尺寸以下（拖不动，主进程也拦得住）', async () => {
    const bounds = await fixture.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('没有可用的主窗口')
      const b = win.getBounds()
      // 故意缩到极窄极矮 → 应该被 `minWidth` / `minHeight` **夹住**。
      win.setBounds({ x: b.x, y: b.y, width: 320, height: 240 })
      return win.getBounds()
    })

    expect(bounds.width).toBe(MIN_WIDTH)
    expect(bounds.height).toBe(MIN_HEIGHT)
  })

  test('最小尺寸下：顶栏不溢出、品牌名单行、页面无横向滚动条', async () => {
    // ⚠️ 显式摆到最小尺寸（不依赖上一条用例的副作用）。
    //    ⚠️ `app.evaluate` 的回调跑在**主进程**里 → 只能用**参数**把尺寸传进去，
    //    引用测试文件里的常量会报 `ReferenceError`。
    await fixture.app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('没有可用的主窗口')
        const b = win.getBounds()
        win.setBounds({ x: b.x, y: b.y, width: size.w, height: size.h })
      },
      { w: MIN_WIDTH, h: MIN_HEIGHT },
    )
    await fixture.window.waitForTimeout(300)

    const metrics = await fixture.window.evaluate(() => {
      const topbar = document.querySelector('.app-shell__topbar') as HTMLElement | null
      const brand = document.querySelector('.app-shell__brand') as HTMLElement | null
      const de = document.documentElement
      const rect = brand?.getBoundingClientRect()
      return {
        topbarClient: topbar?.clientWidth ?? -1,
        topbarScroll: topbar?.scrollWidth ?? -1,
        brandWidth: rect?.width ?? -1,
        brandHeight: rect?.height ?? -1,
        docClient: de.clientWidth,
        docScroll: de.scrollWidth,
      }
    })

    // 1. 顶栏**不横向溢出**（否则页面跟着出横向滚动条）。
    expect(metrics.topbarScroll).toBeLessThanOrEqual(metrics.topbarClient)

    // 2. 品牌名**单行**（一行 ≈ 21px；被压扁时会变成 4 行 ≈ 84px）。
    expect(metrics.brandHeight).toBeLessThan(30)

    // 3. 品牌名**没有被压窄**（自然宽 ≈ 60px = 4 个汉字 × 15px）。
    expect(metrics.brandWidth).toBeGreaterThanOrEqual(55)

    // 4. 页面**无横向滚动条**（播放条需要 717px，内容宽必须 ≥ 它）。
    expect(metrics.docScroll).toBeLessThanOrEqual(metrics.docClient)
  })
})
