// ---------------------------------------------------------------------------
// T122：「共享库」页 —— E2E（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// ⚠️ 这条用例验的是**接线**：顶栏「共享」→ 曲库导航 → 共享库列表 → 浏览目录 → 播曲目。
//    （端点形状本身由真机实测钉住，见 `src/api/sharedLibrary.ts` 的文件头。）
//
// ⚠️ mock 的共享库**由授权目录推导**（`authedRoots`）⇒ mock 里是 **1** 个
//    （fixtures 的 8 首歌都在 `/vol02/1000-0-music/sample/` 下面）
//    ⇒ 共享库 = `/vol02/1000-0-music`，下面一级是 `sample`，`sample` 里有 8 首。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'

/** mock 的共享库路径（由 fixtures 的曲库路径推导 ⇒ 与曲库永远对得上）。 */
const LIBRARY_PATH = '/vol02/1000-0-music'
/** 共享库展示名（`name` 是空串 ⇒ 用 path 末段兜底）。 */
const LIBRARY_NAME = '1000-0-music'
/** 共享库下面的一级子目录。 */
const SUB_FOLDER = 'sample'

test.describe('T122 共享库页', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
    // ⚠️ T38：未登录时主区默认是**本地音乐页** ⇒ 登录表单**不在 DOM 里**
    //    ⇒ 先点顶栏「连接」进登录页（否则 `login()` 会等 `#sanlos-address` 等到超时）。
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await expect(fixture.window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
    await login(fixture.window, fixture.mock.url)
    // ⚠️ 等**曲库导航**出现（已登录态才有）。
    await expect(fixture.window.getByRole('button', { name: '最近', exact: true })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture.close()
  })

  test('曲库导航里有「共享」；进去能列出共享库、浏览目录、播曲目', async () => {
    // ---- ① 导航接线 ----
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '共享', exact: true })
      .click()
    await expect(fixture.window.getByRole('heading', { name: '共享库' })).toBeVisible()

    // ---- ② 共享库列表（`name` 空 ⇒ 用 path 末段兜底）----
    const library = fixture.window.getByRole('button', { name: new RegExp(LIBRARY_NAME) })
    await expect(library).toBeVisible()
    await expect(fixture.window.getByText(LIBRARY_PATH)).toBeVisible()
    await expect(fixture.window.getByText(/共享库 1 个/)).toBeVisible()

    // ---- ③ 进共享库 ⇒ 浏览它的目录 ----
    await library.click()
    // ⚠️ 浏览态里路径出现在**状态行**里（不是独立的一行文本）⇒ 用正则匹配状态行。
    await expect(fixture.window.getByText(new RegExp(`目录：${LIBRARY_PATH}`))).toBeVisible()
    const subFolder = fixture.window.getByRole('button', { name: SUB_FOLDER, exact: true })
    await expect(subFolder).toBeVisible()

    // ---- ④ 进子目录 ⇒ 曲目列出来 ----
    await subFolder.click()
    const rows = fixture.window.getByRole('option')
    await expect(rows.first()).toBeVisible()
    await expect(fixture.window.getByText(/8 首/)).toBeVisible()

    // ---- ⑤ 双击一行 ⇒ 真的开始播（播放条出现歌名）----
    await rows.first().dblclick()
    await expect(fixture.window.locator('.sanlos-playerbar')).toContainText('示例曲目 1', {
      timeout: 20_000,
    })
  })
})
