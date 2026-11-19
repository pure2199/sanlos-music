// ---------------------------------------------------------------------------
// T96：「发现」页 E2E
// ---------------------------------------------------------------------------
//
// 覆盖**只有真实 Electron 才跑得通**的那条链路：
//   登录（主进程 IPC → HTTP → mock NAS）
//     → 发现页 → 主进程抓榜（`discover:charts` → mock 的 `/mock-chart`）
//       → 渲染层**定向查曲库**（`sanlos://` 协议代理 → mock）
//         → 榜单条目标出「在不在曲库」
//           → 点「播放」走既有播放路径（真实 `<audio>` ← `sanlos://` 流 → mock 的 WAV）
//
// ⚠️ **榜源指向 mock**（`SANLOS_CHART_URL`，见 `e2e/helpers/app.ts`）
//    ⇒ E2E **不打真实外网**（QQ 音乐），既确定又不被限流。
// ⚠️ **曲库是 mock 自己的那 8 首歌** ⇒ 「命中 8 / 榜上 9」是**这台 mock** 的事实，
//    不是通用结论（真实用户的曲库是**他自己的**，命中率因人而异）。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'

test.describe.serial('T96「发现」页：榜单 + 为你推荐', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
    // ⚠️ **登录页要先点顶栏「连接」才出现**（T38：启动后主区默认是「本地音乐页」）。
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, fixture.mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  test('榜单条目对上曲库：命中的**可播**、没命中的标「不在曲库」、并给出命中率', async () => {
    // ⚠️ 「发现」**需要 NAS** ⇒ 未登录时不渲染（与「搜索」同一条纪律）。
    await fixture.window.getByRole('button', { name: '发现', exact: true }).click()

    // 页内两个 Tab。
    await expect(fixture.window.getByRole('tab', { name: '榜单' })).toBeVisible()
    await expect(fixture.window.getByRole('tab', { name: '为你推荐' })).toBeVisible()

    // 榜单条目真的出现了（榜源 = mock 的 `/mock-chart`）。
    await expect(fixture.window.getByText('示例曲目 1', { exact: true })).toBeVisible()

    // ⚠️ **命中率按当前曲库算**：mock 曲库 8 首 + 榜上另有 1 首「榜外之曲」。
    await expect(fixture.window.getByText('榜上 9 首，你的曲库里有 8 首')).toBeVisible()

    // 没命中的那首：**灰显 + 标「不在曲库」**（且**没有**播放按钮）。
    await expect(fixture.window.getByText('不在曲库', { exact: true })).toHaveCount(1)
    await expect(fixture.window.getByRole('button', { name: '播放 榜外之曲' })).toHaveCount(0)

    // 命中的那首：**能播**（走既有 `playerStore` → NAS `track/stream`，不新增播放路径）。
    await fixture.window.getByRole('button', { name: '播放 示例曲目 1' }).click()
    await expect(fixture.window.locator('.sanlos-playerbar__title')).toHaveText('示例曲目 1')
  })

  test('「为你推荐」：每条都带**可读理由**，且点得动', async () => {
    // ⚠️ 上一条用例已经停在「发现」页 ⇒ 直接切 Tab（**不重复登录**）。
    await fixture.window.getByRole('tab', { name: '为你推荐' }).click()

    // 服务端播放历史（mock 的 4 首）⇒ 种子 ⇒ 有推荐。
    await expect(fixture.window.getByText('因为你最近听过', { exact: true })).toBeVisible()

    // 每条都带理由（「因为你最近听过 …」）。
    const reasons = fixture.window.locator('.sanlos-discover__reason')
    await expect(reasons.first()).toBeVisible()
    await expect(reasons.first()).toContainText('因为你最近听过')

    // 推荐项**能播**（走同一条既有播放路径）。
    const playButton = fixture.window.locator('.sanlos-discover__block .sanlos-discover__play').first()
    const title = await fixture.window
      .locator('.sanlos-discover__block .sanlos-discover__entrytitle')
      .first()
      .textContent()
    await playButton.click()
    await expect(fixture.window.locator('.sanlos-playerbar__title')).toHaveText(
      (title ?? '').trim(),
    )
  })
})
