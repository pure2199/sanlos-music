import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { createMockServer, type MockServer } from '../mock-server/server'

// ---------------------------------------------------------------------------
// T128：服务端「未初始化」的如实提示（真实 Electron）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这条用例必须用 mock 注入 `false`**：
//    真实 NAS 上 `initialized` **恒为 `true`**（实测 2026-11-20）
//    ⇒ 真机上**看不到**「未初始化」这条路 ⇒ 只能由 mock 制造。
//    （这是**如实标注的边界**，不是「真机验过了」。）
//
// ⚠️ **鉴别力（三条，缺一不可）**：
//    1. mock 的 `/initialization/state` 返回 `initialized: false`（**按实例注入**）；
//    2. **对照组**：默认实例（`initialized` 不传 ⇒ `true`）⇒ 连接页显示「已初始化」
//       且**不出现**未初始化提示 ⇒ 证明提示**确实**由这个端点驱动，不是无中生有；
//    3. 搜索页**空结果**处换成「尚未初始化」的说明 ⇒ 证明两个落点都接上了。
//
// ⚠ **共享 fixtures 一条不改**（T97 断言「随机挑了 8 首」）
//    ⇒ 只按**实例**注入 `initialized`，不动 `SONGS`。
// ---------------------------------------------------------------------------

test.describe.serial('T128：服务端未初始化 ⇒ 如实提示（真实 Electron）', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠ **按实例注入**：服务端「未初始化」。
    mock = createMockServer({ initialized: false })
    fixture = await launchApp({ mock })
  })

  test.afterAll(async () => {
    await fixture?.close()
    await mock?.close()
  })

  test('未初始化 ⇒ 连接页如实说明；搜索空结果也换文案', async () => {
    const window = fixture.window
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await login(window, fixture.mock.url)

    // --- 落点 A：连接页 ---------------------------------------------------
    await expect(window.getByText('未初始化', { exact: true })).toBeVisible()
    // ⚠ 提示要给出**可行动**的下一步（去飞牛音乐网页端完成初始化）。
    await expect(window.getByText(/飞牛音乐网页端完成初始化/)).toBeVisible()

    // --- 落点 B：搜索页空结果 ---------------------------------------------
    await window.getByRole('button', { name: '搜索', exact: true }).click()
    await window.getByLabel('搜索关键字').fill('绝对搜不到的词')
    await expect(window.getByText(/服务端尚未初始化/)).toBeVisible()
    // ⚠ 未初始化时**不该**再说「没有找到」（那会把用户引向错误方向）。
    await expect(window.getByText('没有找到', { exact: true })).toHaveCount(0)
  })

  test('对照组：已初始化 ⇒ 显示「已初始化」，**不**出现未初始化提示', async () => {
    const other = createMockServer()
    const otherFixture = await launchApp({ mock: other })
    try {
      const window = otherFixture.window
      await window.getByRole('button', { name: '连接', exact: true }).click()
      await login(window, otherFixture.mock.url)

      await expect(window.getByText('已初始化', { exact: true })).toBeVisible()
      await expect(window.getByText('未初始化', { exact: true })).toHaveCount(0)
      await expect(window.getByText(/尚未初始化/)).toHaveCount(0)
    } finally {
      await otherFixture?.close()
      await other?.close()
    }
  })
})
