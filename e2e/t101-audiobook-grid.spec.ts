// ---------------------------------------------------------------------------
// T101：「有声」页改成专辑页同款的**封面卡片网格** + 播放模块三处 —— E2E
// ---------------------------------------------------------------------------
//
// ⚠️ 覆盖用户 2026-11-17 的反馈：
//     「**不能做成专辑业那样吗，然后有声业的播放模块 UI 有问题**」
//   ⇒ ① 有声页 = **封面卡片网格**（专辑页同款 `.fnm-card`）；
//      ② 卡片**有封面**（不是占位块）—— mock 补了 `/static/cover` 端点；
//      ③ 卡片**不再**背结构信号长句（那行搬去了详情页 ⇒ 卡片才做得成封面网格）；
//      ④ 详情页有「**播放全书**」⇒ 一键整队入队（连播）；
//      ⑤ 全屏播放页：有声 ⇒ 默认落「**队列**」（不再卡「正在加载歌词…」）。
//
// ⚠️ **共享 fixtures 一条不改** ⇒ 带封面的专辑 / 曲目**只在本实例注入**
//    （别的用例的「12 集」「8 首」断言不受影响）。
// ⚠️ 曲目的**顺序故意打乱**（共享 fixtures 本来就是乱的）⇒ 排对了才是真的排对了。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import { ALBUMS, AUDIOBOOK_ALBUM, AUDIOBOOK_SONGS, SONGS } from '../mock-server/fixtures'
import { createMockServer, type MockServer } from '../mock-server/server'
import { launchApp, login, type AppFixture } from './helpers/app'

/** 专辑封面 id（秒搜路径用：/search/album` 自带）。 */
const ALBUM_COVER = 'album_0011223344556677'
/** 曲目封面 id（扫描路径用：曲目的 `coverId` 本来就在数据里 ⇒ 顺手记下来）。 */
const TRACK_COVER = 'track_0011223344556677'

/** 带封面的专辑（**只在本实例**注入 ⇒ 共享 fixtures 不动）。 */
const COVERED_ALBUM = { ...AUDIOBOOK_ALBUM, coverId: ALBUM_COVER }
/** 带封面的 12 集（同样只在本实例注入）。 */
const COVERED_SONGS = AUDIOBOOK_SONGS.map((song) => ({
  ...song,
  coverId: TRACK_COVER,
  album: { ...song.album, coverId: ALBUM_COVER },
}))

test.describe.serial('T101「有声页 = 专辑页同款封面网格 + 播放模块」', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    mock = createMockServer({
      songs: [...SONGS, ...COVERED_SONGS],
      albums: [...ALBUMS, COVERED_ALBUM],
    })
    fixture = await launchApp({ mock })
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.close()
    await mock?.close()
  })

  test('① 有声页 = **封面卡片网格**（专辑页同款 `.fnm-card`）+ 卡片**真的**有封面', async () => {
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()

    // ⭐ 列表是**卡片网格**（`.fnm-card`），不是纯文字长列表。
    const cards = fixture.window.locator('.fnm-audiobooks__list .fnm-card')
    await expect(cards).toHaveCount(1)
    await expect(cards.first().locator('.fnm-audiobooks__title')).toHaveText('示例有声作品')

    // ⭐ 真的是**网格**（不是竖着排的列表）。
    const display = await fixture.window
      .locator('.fnm-audiobooks__list')
      .evaluate((el) => getComputedStyle(el).display)
    expect(display).toBe('grid')

    // ⭐ 卡片**有封面**（`<img>`，不是占位块）⇒ 地址里带的是**专辑**的封面 id。
    // ⚠️ **T102**：显示统一为「**专辑自己的**封面」⇒ 这里从「曲目的封面」改成了「专辑的封面」
    //    （**前提被 T102 推翻**：曲目的封面与专辑的封面是**两个不同的 id** ⇒ 用曲目的封面
    //    ⇒ 同一张卡片在「主列表」与「秒搜结果」里会显示**两张不同的图**）。
    const img = cards.first().locator('img.fnm-cover__image')
    await expect(img).toHaveCount(1)
    await expect(img).toHaveAttribute('src', new RegExp(`coverId=${ALBUM_COVER}`))
    // ⚠️ **不是**曲目的那个封面 id（这正是 T102 要消灭的分歧）。
    await expect(img).not.toHaveAttribute('src', new RegExp(`coverId=${TRACK_COVER}`))
    // 图片**真的加载成功**（不是 404 之后的占位块）。
    const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)
    expect(naturalWidth).toBeGreaterThan(0)
  })

  test('② 卡片**不再**背结构信号长句（那行搬去了详情页 ⇒ 卡片才干净）', async () => {
    const card = fixture.window.locator('.fnm-audiobooks__item').first()
    // ⚠️ 旧版卡片上有一整句「判定依据」（`.fnm-audiobooks__reasons`）⇒ 现在**不该**再有。
    await expect(card.locator('.fnm-audiobooks__reasons')).toHaveCount(0)
    await expect(card).not.toContainText('单集均长 ≥ 8 分钟')
  })

  test('③ 秒搜结果也是**同样的卡片**（自带封面 ⇒ 零额外请求）', async () => {
    await fixture.window.getByPlaceholder('输入作品名，例如：牧神记').fill('示例有声作品')
    await fixture.window.getByRole('button', { name: '搜作品' }).click()

    const results = fixture.window.locator('.fnm-audiobooks__result')
    await expect(results).toHaveCount(1)
    await expect(results.first().locator('.fnm-audiobooks__title')).toHaveText('示例有声作品')

    // ⭐ 秒搜路径的封面来自 `/search/album` **自带**的专辑封面。
    const img = results.first().locator('img.fnm-cover__image')
    await expect(img).toHaveCount(1)
    await expect(img).toHaveAttribute('src', new RegExp(`coverId=${ALBUM_COVER}`))
  })

  test('⑤ **T102**：主列表与秒搜结果的封面 **id 逐字相同**（统一到专辑封面）', async () => {
    // ⚠️ **为什么这条重要**：T101 真机复验发现 —— **同一张卡片在「主列表」与「秒搜结果」
    //    里封面 id 不同** ⇒ 用户看到的是**两张不同的图**。
    //    ⇒ T102 统一到「专辑自己的」封面 ⇒ 两条路必须**逐字相同**。

    // ① 主列表（**扫描**路径）的封面。
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    const listCard = fixture.window.locator('.fnm-audiobooks__list .fnm-card').first()
    await expect(listCard).toHaveCount(1)
    const listSrc = await listCard.locator('img.fnm-cover__image').getAttribute('src')

    // ② 秒搜（**搜索**路径）的封面。
    await fixture.window.getByPlaceholder('输入作品名，例如：牧神记').fill('示例有声作品')
    await fixture.window.getByRole('button', { name: '搜作品' }).click()
    const resultCard = fixture.window.locator('.fnm-audiobooks__result').first()
    await expect(resultCard).toHaveCount(1)
    const resultSrc = await resultCard.locator('img.fnm-cover__image').getAttribute('src')

    // ⭐ **逐字相同**（不是「看起来像同一张」⇒ 是同一个 id）。
    expect(listSrc).toBe(resultSrc)
    // ⭐ 而且就是**专辑自己的**那个封面 id。
    expect(listSrc).toContain(ALBUM_COVER)
  })

  test('④ 详情页有「**播放全书**」⇒ 一键整队入队；全屏页默认落在「**队列**」', async () => {
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    await fixture.window.locator('.fnm-audiobooks__title').first().click()

    // 详情页确实按集序排了（说明整队已经拉下来了）。
    await expect(fixture.window.locator('.fnm-detail__audiobook-note')).toHaveText('已按集序排列')

    // ⭐ 结构信号在**详情页**里逐条给出来（信息一点没丢）。
    const reasons = fixture.window.locator('.fnm-detail__audiobook-reasons')
    await expect(reasons).toContainText('单集均长 ≥ 8 分钟')
    await expect(reasons).toContainText('集数 ≥ 8')

    // ⭐ 一键播放全书。
    await fixture.window.getByRole('button', { name: '播放全书' }).click()

    // 开全屏页看队列。
    await fixture.window.getByRole('button', { name: '全屏播放页', exact: true }).click()
    const page = fixture.window.getByTestId('full-player')
    await expect(page).toBeVisible()

    // ⚠️ 有声**没有歌词** ⇒ 默认落在「队列」（真机实测：以前卡在「正在加载歌词…」）。
    // ⚠️ `exact: true` 不能省：队列里每行的「从队列移除」按钮名里也带「队列」。
    await expect(page.getByRole('button', { name: '队列', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // ⭐ 队列 = **整本书**（12 集）⇒ 播完一集自动下一集（连播）。
    await expect(page.locator('.fnm-fullplayer__queue-item')).toHaveCount(12)
    // ⭐ 正在播的是**第 1 集**（不是随便哪一集）。
    await expect(page.locator('.fnm-fullplayer__title')).toHaveText('01- 第1集')
    // 队列里**没有**「正在加载歌词…」这种卡住的状态。
    await expect(page).not.toContainText('正在加载歌词')

    // 收尾：全屏页是浮层（盖住顶栏）⇒ 关掉。
    await fixture.window.getByRole('button', { name: '关闭全屏播放页' }).click()
    await expect(page).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// T101 · ②：旧落盘（**没有封面**）⇒ 进页面**补拉一次** ⇒ 卡片出现封面
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么必须另起一个实例**：落盘在 `localStorage` 里 ⇒ 上面的实例已经跑过一次
//    **自动扫描**（落盘里**已经带封面**了）⇒ 再改落盘也**不会被重新读回来**
//    （页面组件已挂载 ⇒ `restore()` 不会重跑）⇒ 只能**另起一个实例**。
// ⚠️ **这正是「页面不补拉封面」那条变异第一轮没变红的原因**：补拉这条路
//    **原来没有任何 E2E 咬住**（卡片有封面是靠**扫描路径**拿到的）⇒ 补了这条才咬得住。
// ---------------------------------------------------------------------------

/** 一份**没有封面**的旧落盘（T101 之前的形状）⇒ 已扫过 ⇒ **不会**自动重扫。 */
const OLD_PERSISTED_STATE = {
  version: 3,
  nextPage: 0,
  scannedCount: 12,
  total: 12,
  candidates: {
    [AUDIOBOOK_ALBUM.guid]: {
      albumId: AUDIOBOOK_ALBUM.guid,
      albumTitle: AUDIOBOOK_ALBUM.name,
      trackCount: 12,
      totalDurationSec: 12 * 1500,
      maxDurationSec: 1500,
      episodeStats: { ruleCounts: { 'dash-prefix': 12 }, titleCount: 12 },
      dirs: [AUDIOBOOK_ALBUM.name],
      // ⚠️ **T101 的形状**：有**曲目**封面 ⇒ 但**没有** `albumCoverId`
      //    ⇒ 专辑封面**未知** ⇒ 进页要补拉一次 `/album/detail`。
      coverId: TRACK_COVER,
    },
  },
  overrides: {},
  keyword: '有声小说',
  scannedAt: 1792563278000,
}

test.describe.serial('T101「旧落盘补拉封面」', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    mock = createMockServer({
      songs: [...SONGS, ...COVERED_SONGS],
      albums: [...ALBUMS, COVERED_ALBUM],
    })
    fixture = await launchApp({ mock })
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.close()
    await mock?.close()
  })

  test('旧落盘没有封面 ⇒ 进页面**补拉一次** ⇒ 卡片出现封面（且**不重扫**）', async () => {
    // 预置一份**没有封面**的旧落盘。
    await fixture.window.evaluate((state) => {
      window.localStorage.setItem('fnmusic-audiobook-state', JSON.stringify(state))
    }, OLD_PERSISTED_STATE)

    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()

    const card = fixture.window.locator('.fnm-audiobooks__item').first()
    await expect(card).toHaveCount(1)
    // ⭐ 补拉到了 ⇒ 卡片出现**专辑封面**（`/album/detail` 自带的那个）。
    const img = card.locator('img.fnm-cover__image')
    await expect(img).toHaveCount(1)
    await expect(img).toHaveAttribute('src', new RegExp(`coverId=${ALBUM_COVER}`))
    // ⚠️ **T102**：旧落盘里那个**曲目**封面**不该**被用上（否则两处显示不同的图）。
    await expect(img).not.toHaveAttribute('src', new RegExp(`coverId=${TRACK_COVER}`))
    // ⚠️ **不重扫**（旧落盘还在 ⇒ 不用再花 52 秒）。
    await expect(fixture.window.locator('.fnm-page__status')).toContainText('上次扫描')
  })
})
