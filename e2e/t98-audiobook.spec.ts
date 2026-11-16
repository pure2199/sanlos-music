// ---------------------------------------------------------------------------
// T98：「有声读物」页 —— E2E（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// 覆盖规格 §七 验收点 4：**mock 造一个 12 集有声专辑**
//   ⇒ 详情页顺序 = 集号顺序 + 显示集号。
//
// 走通的链路（**只有真实 Electron 才跑得通**）：
//   登录（主进程 IPC → HTTP → mock NAS）
//     → 曲库导航「有声」⇒ **进页面不自动扫**（空态）
//       → 点「扫描曲库」（`/track/list` 全量 ⇒ 客户端本地按专辑聚合 ⇒ 判定打分）
//         ⇒ 命中列表（判定分 / 依据 / 集数 / 均长）⇒ 普通专辑**不出现**
//           → 点专辑 ⇒ 详情页**一次性拉全量 + 按集序排** ⇒ 「第 N 集」
//             → 「这不是有声」⇒ **不再按集序排**，也不再出现在「有声」页
//
// ⚠️ **mock 的 12 集是故意乱序的**（第 1 首是「07- 第7集」）：
//    排序是**客户端自己**做的（服务端没这能力）⇒ 若 mock 按集号顺序返回，
//    **排序失效也照样通过** ⇒ 这条 E2E 就是假阳性。
//    ⇒ 必须乱序 ⇒ 排对了才是真的排对了。
//
// ⚠️ **共享 fixtures 一条不改**（T97 断言「随机挑了 8 首」）
//    ⇒ 12 集**只在本实例**注入（`createMockServer({ songs, albums })`）。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import {
  ALBUMS,
  AUDIOBOOK_ALBUM,
  AUDIOBOOK_SONGS,
  SONGS,
} from '../mock-server/fixtures'
import { createMockServer, type MockServer } from '../mock-server/server'
import { launchApp, login, type AppFixture } from './helpers/app'

test.describe.serial('T98「有声读物」识别 + 按集序排列', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠️ **按实例注入** 12 集有声专辑（默认 mock 一条不变 ⇒ 别的用例不受影响）。
    mock = createMockServer({
      songs: [...SONGS, ...AUDIOBOOK_SONGS],
      albums: [...ALBUMS, AUDIOBOOK_ALBUM],
    })
    fixture = await launchApp({ mock })
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    // ⚠️ mock 是**这个用例自己建的**（`launchApp({ mock })` 不会关它）⇒ 得自己关。
    await fixture?.close()
    await mock?.close()
  })

  test('扫描曲库 ⇒ 识别出有声专辑（判定分 / 依据 / 集数 / 均长），普通专辑不出现', async () => {
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()

    // ⚠️ **进页面不能自动扫**（实测全库扫描 87 页 / 6–47 分钟）
    //    ⇒ 进来是空态，**要用户点**才扫。
    await expect(fixture.window.locator('.fnm-page__status')).toHaveText('还没扫描过')
    await expect(fixture.window.locator('.fnm-audiobooks__empty')).toContainText(
      '点「扫描曲库」开始识别',
    )

    await fixture.window.getByRole('button', { name: '扫描曲库' }).click()

    // 命中列表里**只有**那部有声专辑（普通专辑结构信号不够 ⇒ 不该出现）。
    const items = fixture.window.locator('.fnm-audiobooks__item')
    await expect(items).toHaveCount(1)
    await expect(items.first().locator('.fnm-audiobooks__title')).toHaveText('示例有声作品')

    // 判定结果**可解释**：判定分 / 集数 / 均长。
    const meta = items.first().locator('.fnm-audiobooks__meta')
    await expect(meta).toContainText('判定分 7')
    await expect(meta).toContainText('12 集')
    await expect(meta).toContainText('单集均长 25 分')

    // 依据逐条给出来（**不黑箱**）。
    const reasons = items.first().locator('.fnm-audiobooks__reasons')
    await expect(reasons).toContainText('单集均长 ≥ 8 分钟')
    await expect(reasons).toContainText('单集均长 ≥ 20 分钟')
    await expect(reasons).toContainText('标题形态一致（可解析集号）')
    await expect(reasons).toContainText('集数 ≥ 8')
    await expect(reasons).toContainText('曲目集中在同一作品目录')
  })

  test('点进有声专辑 ⇒ 曲目**按集序排**（输入是乱序）且显示「第 N 集」', async () => {
    await fixture.window.locator('.fnm-audiobooks__title').click()

    // 头部徽标：真的排成集序了（形态不一致时会如实说「没识别到集号」）。
    await expect(fixture.window.locator('.fnm-detail__audiobook-note')).toHaveText('已按集序排列')

    const rows = fixture.window.locator('.fnm-songlist__row')
    await expect(rows).toHaveCount(12)

    // ⭐ mock 给的是**乱序**（第 1 首是「07- 第7集」）⇒ 排对了才是真的排对了。
    await expect(rows.nth(0).locator('.fnm-songlist__title')).toHaveText('01- 第1集')
    await expect(rows.nth(11).locator('.fnm-songlist__title')).toHaveText('12- 第12集')

    // 集号标签逐行递增（1…12）。
    await expect(rows.nth(0).locator('.fnm-detail__episode')).toHaveText('第 1 集')
    await expect(rows.nth(11).locator('.fnm-detail__episode')).toHaveText('第 12 集')
    const episodes = await rows.locator('.fnm-detail__episode').allTextContents()
    expect(episodes).toEqual(Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 集`))

    // 全量都拉下来了（不是只显示第一页）。
    await expect(fixture.window.locator('.fnm-songlist__status')).toHaveText('已加载 12 / 12')
  })

  test('「这不是有声」⇒ 不再按集序排（回到原序），且不再出现在「有声」页', async () => {
    await fixture.window.getByRole('button', { name: '这不是有声' }).click()

    // 徽标与集号标签都消失 ⇒ 不再按集序排。
    await expect(fixture.window.locator('.fnm-detail__audiobook-note')).toHaveCount(0)
    await expect(fixture.window.locator('.fnm-detail__episode')).toHaveCount(0)

    // 回到 **mock 给的乱序**（第 1 首 = 第 7 集）⇒ 证明确实「不再排」。
    const rows = fixture.window.locator('.fnm-songlist__row')
    await expect(rows.nth(0).locator('.fnm-songlist__title')).toHaveText('07- 第7集')

    // 底部换成了「这是有声读物」（可以反悔改回来）。
    await expect(fixture.window.getByRole('button', { name: '这是有声读物' })).toBeVisible()

    // 回「有声」页 ⇒ 改判**优先于**自动判定 ⇒ 不再列出。
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    await expect(fixture.window.locator('.fnm-audiobooks__item')).toHaveCount(0)
    await expect(fixture.window.locator('.fnm-audiobooks__empty')).toContainText(
      '当前曲库里没有识别到有声读物',
    )
  })
})
