// ---------------------------------------------------------------------------
// T104：详情页的曲目列表「能滚到底」（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// ⚠ **这个缺陷是 T103 真机复验顺带抓到的**（探针 `t103-03`）：
//    《极品家丁》1333 集的详情页里，`.sanlos-songlist__viewport` 的
//    `clientHeight` ＝ `scrollHeight` ＝ **63984** ⇒ 它**根本不是滚动容器**
//    ⇒ 真正在滚的是**整个文档** ⇒ `SongList` 的虚拟窗口
//    （靠**自己**的 `onScroll` → `setScrollTop`）**永不前移**
//    ⇒ 用户只看得到**最前面十几行**，下面全是空画布。
//
// 走通的链路（**只有真实 Electron 才跑得通**）：
//   登录 → 曲库导航「专辑」⇒ 点「多集专辑示例」（40 集 ⇒ 1920px ⇒ 撑破一屏）
//     ⇒ 详情页 ⇒ 量几何 ⇒ 滚到底 ⇒ **最后一行在场**。
//
// ⚠ **为什么 mock 要单独造一个 40 集的专辑**：
//    - 共享 fixtures **一条不改**（T97 断言「随机挑了 8 首」）
//      ⇒ 40 集**只在本实例**注入（`createMockServer({ songs, albums })`）；
//    - 40 集 ≤ 单页 50 ⇒ **不分页** ⇒ 「最后一行」是确定的（第 40 首）；
//    - 40 × 48px = **1920px** ⇒ 必定超过窗口（1200×800）能显示的行数
//      ⇒ 列表**必须**能滚才看得到最后一行。
//
// ⚠ **断言为什么这样写**：
//    - 先量**几何**（`scrollHeight > clientHeight`）—— 这才是「能滚」的直接证据
//      （缺陷时两个数**相等** ⇒ 列表被内容顶高）；
//    - 再验**用户看得见的结果**：滚到底 ⇒ 最后一行在场；
//    - 再验**虚拟窗口真的前移**：`data-scroll-top` 从 0 变成 > 0。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import {
  ALBUMS,
  LONG_ALBUM,
  LONG_ALBUM_ARTIST,
  LONG_ALBUM_SONGS,
  LONG_ALBUM_TRACK_COUNT,
  SONGS,
} from '../mock-server/fixtures'
import { createMockServer, type MockServer } from '../mock-server/server'
import { launchApp, login, type AppFixture } from './helpers/app'
import { collectSongListRows, scrollSongListToBottom } from './helpers/song-list'

/** 详情页的曲目视口的**几何**（`clientHeight` / `scrollHeight` / 虚拟窗口位置）。 */
interface ViewportGeometry {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  dataScrollTop: number
}

test.describe.serial('T104：详情页的曲目列表能滚到底', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠ **按实例注入** 40 集专辑 + 它的歌手（默认 mock 一条不变 ⇒ 别的用例不受影响）。
    //    ⚠ 歌手也**按实例注入**（`artists`）：歌手详情页要验「两个区块各占一半」。
    mock = createMockServer({
      songs: [...SONGS, ...LONG_ALBUM_SONGS],
      albums: [...ALBUMS, LONG_ALBUM],
      artists: [LONG_ALBUM_ARTIST],
    })
    fixture = await launchApp({ mock })
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    // ⚠ mock 是**这个用例自己建的**（`launchApp({ mock })` 不会关它）⇒ 得自己关。
    await fixture?.close()
    await mock?.close()
  })

  /** 读详情页曲目视口的几何。 */
  async function geometry(): Promise<ViewportGeometry | null> {
    return fixture.window.evaluate(() => {
      const v = document.querySelector('.sanlos-songlist__viewport')
      if (!v) return null
      return {
        clientHeight: v.clientHeight,
        scrollHeight: v.scrollHeight,
        scrollTop: v.scrollTop,
        dataScrollTop: Number(v.getAttribute('data-scroll-top') ?? '0'),
      }
    })
  }

  /** 滚到底（并等虚拟窗口**真的**挪了）。 */
  async function scrollToBottom(): Promise<void> {
    await scrollSongListToBottom(fixture.window)
  }

  /** 滚到第 `index` 行（行高 48px ⇒ 偏移 = 行号 × 48；虚拟窗口会围绕它渲染）。 */
  async function scrollToRow(index: number): Promise<void> {
    const before = await fixture.window.evaluate(() =>
      Number(document.querySelector('.sanlos-songlist__viewport')?.getAttribute('data-scroll-top') ?? '0'),
    )
    await fixture.window.evaluate((offset) => {
      const v = document.querySelector('.sanlos-songlist__viewport')
      if (v) v.scrollTop = offset
    }, index * 48)
    await fixture.window
      .waitForFunction(
        (prev) =>
          Number(document.querySelector('.sanlos-songlist__viewport')?.getAttribute('data-scroll-top') ?? '0') !==
          prev,
        before,
        { timeout: 5_000, polling: 100 },
      )
      .catch(() => undefined)
  }

  /** 进「多集专辑示例」的详情页。 */
  async function openLongAlbumDetail(): Promise<void> {
    const win = fixture.window
    await win.getByRole('navigation', { name: '曲库导航' }).getByRole('button', { name: '专辑' }).click()
    await win.locator('.sanlos-card__button').filter({ hasText: '多集专辑示例' }).click()
    await win.waitForSelector('.sanlos-songlist__row')
  }

  test('列表**自己滚**（视口 < 内容高度）⇒ 滚到底 ⇒ **最后一行在场**', async () => {
    const win = fixture.window
    await openLongAlbumDetail()

    // ① ⭐ 视口**真的是滚动容器**：可视区 < 内容高度。
    //    ⚠️ 缺陷时这两个数**相等**（列表被内容顶高）⇒ 滚不动。
    const geo = await geometry()
    expect(geo).not.toBeNull()
    expect(geo!.scrollHeight).toBeGreaterThan(geo!.clientHeight)
    // 40 集 × 48px = 1920px 的画布 ⇒ 可视区必须**远小于**它。
    expect(geo!.scrollHeight).toBe(LONG_ALBUM_TRACK_COUNT * 48)
    // ⭐⭐ **视口高度不得超过窗口高度** —— 这一条钉的是「**页面没被内容顶开**」。
    //    ⚠️ 少了 `.sanlos-detail` 的 `min-height: 0` ⇒ 详情页被 1920px 的画布顶开
    //      ⇒ 视口被撑到 ~1700px（**比窗口还高**）⇒ 滚动条跑到了错误的层上。
    const windowHeight = await win.evaluate(() => window.innerHeight)
    expect(geo!.clientHeight).toBeLessThanOrEqual(windowHeight)

    // ② 首行在位（列表从顶部开始）。
    const rows = win.locator('.sanlos-songlist__row')
    await expect(rows.first().locator('.sanlos-songlist__title')).toHaveText('多集专辑 第01首')

    // ③ ⭐ 滚到底 ⇒ **最后一行（第 40 首）在场**。
    //    ⚠️ 边滚边加载（分页）⇒ 循环滚，直到状态行说全到了。
    for (let i = 0; i < 12; i += 1) {
      const status = (await win.locator('.sanlos-songlist__status').textContent()) ?? ''
      const m = /已加载\s*([\d,]+)\s*\/\s*([\d,]+)/.exec(status)
      // ⚠ `noUncheckedIndexedAccess` ⇒ 捕获组要判空。
      const loaded = m?.[1] ? Number(m[1].replace(/[,\s]/g, '')) : 0
      const total = m?.[2] ? Number(m[2].replace(/[,\s]/g, '')) : 0
      if (total > 0 && loaded >= total) break
      await scrollToBottom()
      await win.waitForTimeout(250)
    }
    await expect(win.locator('.sanlos-songlist__status')).toHaveText(
      `已加载 ${LONG_ALBUM_TRACK_COUNT} / ${LONG_ALBUM_TRACK_COUNT}`,
    )
    await scrollToBottom()
    await expect(rows.last().locator('.sanlos-songlist__title')).toHaveText('多集专辑 第40首')

    // ④ ⭐ **整张列表都收得到**（滚一遍 ⇒ 40 行全在，按 `data-index` 去重）。
    //    ⚠️ 这一条比「DOM 里有 40 行」**更强**：旧缺陷下 DOM 里**只有前面十几行**
    //    （虚拟窗口永不前移）⇒ 根本收不齐 40 行。
    const all = await collectSongListRows(win)
    expect(all).toHaveLength(LONG_ALBUM_TRACK_COUNT)
    expect(all[0]?.title).toBe('多集专辑 第01首')
    expect(all[LONG_ALBUM_TRACK_COUNT - 1]?.title).toBe('多集专辑 第40首')
  })

  test('虚拟窗口**真的前移**（`data-scroll-top` 从 0 变成 > 0）⇒ 中段的行也在场', async () => {
    const win = fixture.window
    await openLongAlbumDetail()

    // 起点：虚拟窗口在顶部。
    const before = await geometry()
    expect(before?.dataScrollTop).toBe(0)

    // 滚到第 20 行附近 ⇒ 窗口前移 ⇒ 中段那行在场。
    await scrollToRow(20)
    const after = await geometry()
    expect(after?.dataScrollTop).toBeGreaterThan(0)

    const titles = await win.locator('.sanlos-songlist__title').allTextContents()
    expect(titles).toContain('多集专辑 第21首')
  })

  test('**连带效果**：歌手详情页的两个区块**各占一半**、各自内部滚动', async () => {
    const win = fixture.window
    // 进「示例长作者」的歌手详情页（专辑网格 + 曲目两个区块）。
    await win.getByRole('navigation', { name: '曲库导航' }).getByRole('button', { name: '歌手' }).click()
    await win.locator('.sanlos-card__button').filter({ hasText: '示例长作者' }).click()
    await win.waitForSelector('.sanlos-songlist__row')

    const sections = await win.evaluate(() =>
      Array.from(document.querySelectorAll('.sanlos-detail__section')).map((el) => {
        const grid = el.querySelector('.sanlos-cardgrid')
        const view = el.querySelector('.sanlos-songlist__viewport')
        return {
          title: el.querySelector('.sanlos-detail__section-title')?.textContent ?? '',
          clientHeight: el.clientHeight,
          grid: grid ? { clientHeight: grid.clientHeight, scrollHeight: grid.scrollHeight } : null,
          view: view ? { clientHeight: view.clientHeight, scrollHeight: view.scrollHeight } : null,
        }
      }),
    )

    // ① 两个区块都在（专辑网格 + 曲目）。
    expect(sections).toHaveLength(2)
    expect(sections[0]?.title).toBe('专辑')
    expect(sections[1]?.title).toBe('曲目')

    // ② ⭐ **两个区块都拿到了能用的高度**。
    //    ⚠️ 若区块按**内容高度**分配空间（`flex: 1 1 auto`）⇒ 专辑网格（只有 1 张卡）
    //      会被挤成**几像素** ⇒ 专辑网格**直接看不见** ⇒ 这就是 `flex: 1 1 0` 要防的塌法。
    for (const section of sections) {
      expect(section.clientHeight).toBeGreaterThan(100)
    }

    // ③ ⭐ **各占一半**（basis = 0 ⇒ 空间按 grow 均分 ⇒ 两块高度大致相等）。
    const heights = sections.map((s) => s.clientHeight)
    const ratio = Math.abs(heights[0]! - heights[1]!) / Math.max(heights[0]!, heights[1]!)
    expect(ratio).toBeLessThan(0.3)

    // ④ 曲目区块的视口**自己**能滚（内容 40 × 48 = 1920px）。
    expect(sections[1]?.view?.clientHeight).toBeLessThan(sections[1]?.view?.scrollHeight ?? 0)

    // ⑤ ⭐ 视口高度**不得超过窗口高度**（超过 ⇒ 页面被内容顶开了）。
    const windowHeight = await win.evaluate(() => window.innerHeight)
    expect(sections[1]?.view?.clientHeight ?? 0).toBeLessThanOrEqual(windowHeight)
  })
})
