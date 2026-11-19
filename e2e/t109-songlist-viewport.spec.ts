// ---------------------------------------------------------------------------
// T109：`SongList` 的「可视区高度」在**列表初始为空**时量不到（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// ⚠ **这个缺陷是 T104 规格 §六 记下的「T105 候选」**（当时刻意不修，另开编号）：
//    `src/components/SongList.tsx` 的量高 effect 依赖写死 `[]` ⇒ 只在**挂载时**跑一次；
//    而列表**初始为空**时组件走**空态分支**（**根本不渲染视口节点**）
//    ⇒ 挂载那一刻拿不到节点 ⇒ effect 第一行就 return（连 `ResizeObserver` 都没挂上）
//    ⇒ 数据后来到了、节点才挂上，但 effect **不会重跑**
//    ⇒ `measuredHeight` 永远停在 0 ⇒ 一路用兜底常量 **600**
//    ⇒ 虚拟窗口按 600px 算（可见 13 行），而不是真实视口。
//
// ⚠ **为什么 DOM 行数能当证据**：
//    缺陷态：DOM 行数 = `ceil(600 / 48) + 5` = **18**（**与真实视口无关**）；
//    修好之后：DOM 行数 = `ceil(真实视口 / 48) + 5`（真实视口 ≈ 几百 px ⇒ **明显更少**）。
//    ⇒ 断言「DOM 行数 == 按**真实**视口算出来的值」就能**咬住**这个缺陷。
//
// ⚠ **为什么用 40 集的专辑**：
//    - 共享 fixtures **一条不改**（T97 断言「随机挑了 8 首」）⇒ 40 集**只在本实例**注入；
//    - 40 × 48px = **1920px** ⇒ 必定超过一屏 ⇒ 虚拟裁剪**必须**生效；
//    - 详情页的曲目是**异步加载**的 ⇒ 列表**初始为空** ⇒ **正好命中缺陷的触发条件**。
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

/** 行高（唯一真值在 TS 侧：`SONG_ROW_HEIGHT` = 48）。 */
const ROW_HEIGHT = 48
/** 上下各缓冲的行数（`SONG_LIST_BUFFER_ROWS` = 5；滚动到顶时上方缓冲为 0）。 */
const BUFFER_ROWS = 5
/** 兜底常量（`SONG_LIST_FALLBACK_VIEWPORT_HEIGHT` = 600）—— **缺陷态**就是它。 */
const FALLBACK_VIEWPORT_HEIGHT = 600

/** 视口的**真实**几何 ＋ 当前 DOM 行数。 */
interface ViewportInfo {
  /** 视口真实高度（`getBoundingClientRect().height` —— 组件就是量这个）。 */
  height: number
  /** 钳到窗口高度之后的可视区高度（与组件口径一致）。 */
  clamped: number
  /** 按真实视口算出来的 DOM 行数（可见行 ＋ 缓冲行）。 */
  expected: number
  /** 当前 DOM 里真实存在的行数。 */
  actual: number
}

test.describe.serial('T109：列表初始为空时也要量到真实视口高度', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠ 按实例注入 40 集专辑（默认 mock 一条不变 ⇒ 别的用例不受影响）。
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
    await fixture?.close()
    await mock?.close()
  })

  /** 读「视口真实高度 ⇒ 应有的 DOM 行数」与「实际 DOM 行数」。 */
  async function readViewportInfo(): Promise<ViewportInfo | null> {
    return fixture.window.evaluate(
      ({ rowHeight, bufferRows, total }) => {
        const v = document.querySelector('.sanlos-songlist__viewport')
        if (!v) return null
        const height = v.getBoundingClientRect().height
        // ⚠ 与组件口径一致：`clampViewportHeight` 把量到的值钳到**窗口高度**。
        const clamped = Math.min(height, window.innerHeight)
        const expected = Math.min(total, Math.ceil(clamped / rowHeight) + bufferRows)
        return {
          height,
          clamped,
          expected,
          actual: document.querySelectorAll('.sanlos-songlist__row').length,
        }
      },
      { rowHeight: ROW_HEIGHT, bufferRows: BUFFER_ROWS, total: LONG_ALBUM_TRACK_COUNT },
    )
  }

  test('详情页列表**初始为空** ⇒ 数据到达后 ⇒ DOM 行数按**真实**视口算（不是兜底 600）', async () => {
    const win = fixture.window

    // 进「多集专辑示例」（40 集）的详情页 ⇒ 曲目**异步加载** ⇒ 列表初始为空。
    await win.getByRole('navigation', { name: '曲库导航' }).getByRole('button', { name: '专辑' }).click()
    await win.locator('.sanlos-card__button').filter({ hasText: '多集专辑示例' }).click()
    await win.waitForSelector('.sanlos-songlist__row')

    // ⚠ 先等布局稳定（量高是**效果**触发的，布局还在动时会读到中间态）。
    await expect
      .poll(async () => {
        const info = await readViewportInfo()
        return info ? info.actual - info.expected : -1
      }, { timeout: 10_000, message: 'DOM 行数应等于按真实视口算出来的行数' })
      .toBe(0)

    const info = await readViewportInfo()
    expect(info).not.toBeNull()
    const real = info as ViewportInfo

    // ⚠ 把实测数字打出来（文档与台账要用）。
    //    ⚠ 这些数字**只代表这一份构建、这个窗口尺寸**（别的地方会不一样）。
    console.log(
      `[t109] 详情页曲目视口：真实高度=${real.height}px（钳到窗口=${real.clamped}px）` +
        ` ⇒ DOM 行数=${real.actual}（按真实视口应为 ${real.expected}）`,
    )

    // ① ⭐ **真实视口高度 ≠ 兜底 600** ⇒ 这条用例才**有鉴别力**
    //    （若两者相等，下面那条断言就恒真 ⇒ 白测）。
    expect(real.height).not.toBe(FALLBACK_VIEWPORT_HEIGHT)

    // ② ⭐ DOM 行数 == 按真实视口算出来的行数。
    expect(real.actual).toBe(real.expected)

    // ③ ⭐ 虚拟裁剪**确实生效**（DOM 里不是全部 40 行）。
    expect(real.actual).toBeLessThan(LONG_ALBUM_TRACK_COUNT)

    // ④ 状态行说「已加载 40 / 40」⇒ 数据本身是齐的（**行数少不是数据少**）。
    await expect(win.locator('.sanlos-songlist__status')).toHaveText(
      `已加载 ${LONG_ALBUM_TRACK_COUNT} / ${LONG_ALBUM_TRACK_COUNT}`,
    )
  })
})
