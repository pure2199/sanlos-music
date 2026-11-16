// ---------------------------------------------------------------------------
// T98：「有声读物」页 —— E2E（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// 覆盖规格 §七 验收点 4 与 **v3 追加的验收点 9**：
//   - mock 造一个 12 集有声专辑 ⇒ 详情页顺序 = 集号顺序 + 显示集号；
//   - **作品名秒搜** ⇒ 搜到 ⇒ 点开 ⇒ 按集序排 + 该作品出现在「有声」页；
//   - **改目录关键字** ⇒ 重新扫描 ⇒ 扫出来的东西**跟着换**。
//
// 走通的链路（**只有真实 Electron 才跑得通**）：
//   登录（主进程 IPC → HTTP → mock NAS）
//     → 曲库导航「有声」⇒ **进页面不自动扫**（空态）
//       → 点「扫描这个目录」（`/track/list` 全量 ⇒ 客户端按**目录关键字**过滤 ⇒ 按专辑聚合）
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
//
// ⚠️ **v3 改版**：按钮「扫描曲库」⇒「扫描这个目录」（用户显式要求改的；
//    断言**改写为新行为**，其余断言一条没删、也没弱化）。
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

  test('扫描这个目录 ⇒ 命中该目录下的作品（判定分 / 依据 / 集数 / 均长），普通专辑不出现', async () => {
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()

    // ⚠️ **T100（2026-11-17）把这条用例的前提显式推翻了**：用户口径
    //    「**不用点搜索，也不用点扫描**」⇒ 进页面**自动开扫**（实测约 1 分钟；扫完落盘）。
    //    ⇒ 下面三条断言**改写为新行为**（不弱化：一条换成更强的反向断言）。
    //
    // ⭐ **不用点任何按钮** ⇒ 列表自己出来（自动扫完成 ⇒ 状态行有「上次扫描」）。
    await expect(fixture.window.locator('.fnm-page__status')).toContainText('上次扫描')

    // 命中列表里**只有**那部有声专辑（普通专辑不在这个目录 ⇒ 不该出现）。
    const items = fixture.window.locator('.fnm-audiobooks__item')
    await expect(items).toHaveCount(1)
    await expect(items.first().locator('.fnm-audiobooks__title')).toHaveText('示例有声作品')

    // ⚠️ 还得说清楚它**凭什么**在这儿（用户指的位置）。
    await expect(items.first().locator('.fnm-audiobooks__source')).toContainText('有声小说')

    // ⚠️ **判定分不再显示**（位置已定 ⇒ 那个文件夹里的都是有声 ⇒ 打分当主信息会自相矛盾）。
    //    这条断言**改写为反向断言**（更强：确保它不再出现），不是删掉。
    const meta = items.first().locator('.fnm-audiobooks__meta')
    await expect(meta).not.toContainText('判定分')
    await expect(meta).toContainText('12 集')
    await expect(meta).toContainText('单集均长 25 分')

    // 依据逐条给出来（**不黑箱**）。
    //
    // ⚠️ **T101（2026-11-17）把这条断言改写了**：结构信号那一整行**从列表卡片搬到了
    //    详情页**（卡片要做成专辑页那样的**封面网格** ⇒ 不能再背这行长句）。
    //    ⇒ 这里是**反向断言**（卡片上**不该**再有那行）—— 比原来更强；
    //    「依据一条都不少」的正面断言**搬到下面第 ② 条**（进详情页后逐条验）。
    await expect(items.first().locator('.fnm-audiobooks__reasons')).toHaveCount(0)
    await expect(items.first()).not.toContainText('单集均长 ≥ 8 分钟')
  })

  test('点进有声专辑 ⇒ 曲目**按集序排**（输入是乱序）且显示「第 N 集」', async () => {
    await fixture.window.locator('.fnm-audiobooks__title').click()

    // 头部徽标：真的排成集序了（形态不一致时会如实说「没识别到集号」）。
    await expect(fixture.window.locator('.fnm-detail__audiobook-note')).toHaveText('已按集序排列')

    // ⚠️ **T101**：结构信号（判定依据）在**详情页**里逐条给出来 —— 信息**一点没丢**，
    //    只是从列表卡片换到了详情页。
    const reasons = fixture.window.locator('.fnm-detail__audiobook-reasons')
    await expect(reasons).toContainText('单集均长 ≥ 8 分钟')
    await expect(reasons).toContainText('单集均长 ≥ 20 分钟')
    await expect(reasons).toContainText('标题形态一致（可解析集号）')
    await expect(reasons).toContainText('集数 ≥ 8')
    await expect(reasons).toContainText('曲目集中在同一作品目录')

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

  test('v3① 作品名秒搜 ⇒ 搜到 ⇒ 点开 ⇒ 按集序排，并出现在「有声」页', async () => {
    await fixture.window.getByPlaceholder('输入作品名，例如：牧神记').fill('示例有声作品')
    await fixture.window.getByRole('button', { name: '搜作品' }).click()

    // 搜到的作品列出来（**没扫曲库**也能搜到）。
    const results = fixture.window.locator('.fnm-audiobooks__result')
    await expect(results).toHaveCount(1)
    await expect(results.first().locator('.fnm-audiobooks__title')).toHaveText('示例有声作品')

    // 点开 ⇒ 用户**指认**了它 ⇒ 详情页按集序排。
    await results.first().locator('.fnm-audiobooks__title').click()
    await expect(fixture.window.locator('.fnm-detail__audiobook-note')).toHaveText('已按集序排列')
    const rows = fixture.window.locator('.fnm-songlist__row')
    await expect(rows).toHaveCount(12)
    await expect(rows.nth(0).locator('.fnm-songlist__title')).toHaveText('01- 第1集')
    await expect(rows.nth(0).locator('.fnm-detail__episode')).toHaveText('第 1 集')

    // 回「有声」页 ⇒ 它**也在**列表里（前面扫过就在这个目录 ⇒ 来源显示目录）。
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    await expect(fixture.window.locator('.fnm-audiobooks__item')).toHaveCount(1)
    await expect(fixture.window.locator('.fnm-audiobooks__source')).toContainText('有声小说')
  })

  test('v3② 改目录关键字 ⇒ 重新扫描 ⇒ 目录命中**跟着换**', async () => {
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()

    // 换成 mock 里普通曲目所在的目录（路径段 `1000-0-music`）。
    await fixture.window.getByLabel('目录名').fill('music')
    await fixture.window.getByRole('button', { name: '扫描这个目录' }).click()

    // 目录命中换成了那三张普通专辑（按集数降序）。
    const items = fixture.window.locator('.fnm-audiobooks__item')
    await expect(items).toHaveCount(4)
    await expect(items.nth(0).locator('.fnm-audiobooks__title')).toHaveText('示例专辑一')
    await expect(items.nth(2).locator('.fnm-audiobooks__title')).toHaveText('示例专辑三')
    // ⚠ 目录命中里**不再有**「有声小说」那个目录 ⇒ 扫描确实跟着关键字换了。
    await expect(
      fixture.window.locator('.fnm-audiobooks__source', { hasText: '有声小说' }),
    ).toHaveCount(0)
    // ⚠ 那部作品因为**用户指认过**而留着，来源要说清楚是「你指定的」。
    await expect(items.nth(3).locator('.fnm-audiobooks__source')).toHaveText('你指定的')
    // 状态行记住扫的是哪个目录。
    await expect(fixture.window.locator('.fnm-page__status')).toContainText('music')
  })
})
