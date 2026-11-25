// ---------------------------------------------------------------------------
// T138：「最近」页 **不整页溢出**、**列表不被播放条压住**（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// ⚠ **缺陷**（真机实测 2026-11-26，本机 + 真实 NAS，已装版 v0.4.7）：
//    「最近」页的文档高度 = **1155**，窗口内高只有 **761** ⇒ 整页多出 394px 滚动；
//    `.sanlos-page` = 608 / **1067**；NAS 列表视口底边 **1101** ⇒
//    **伸到播放条（696..761）底下** ⇒ 末尾几行被压在播放器下面看不见。
//    对照「歌曲」页：文档 761/761、`.sanlos-page` 608/608、视口 186..654 ⇒ 正常。
//
// ⚠ **根因**：`.sanlos-history` 是 `.sanlos-page`（纵向 flex）的 flex item，
//    却**一条 flex 声明都没有** ⇒ 默认 `flex: 0 1 auto`（basis = 内容高度）
//    ＋ 自动最小尺寸 = 内容高度 ⇒ 被 NAS 列表顶破。
//
// ⚠ **为什么注入 40 条历史**（默认 `PLAY_HISTORY` 只有 4 条）：
//    4 条 = 192px ⇒ 列表**不满一屏** ⇒ 验不了「视口自己滚」；
//    40 条 × 48px = **1920px** ⇒ 必定超过一屏 ⇒ 列表**必须**能自己滚。
//    ⚠ 共享 fixtures **一条不改**（按实例注入，同 T98/T109 的纪律）。
//
// ⚠ **为什么还有一条「窗口最矮」的用例**：
//    `min-height` 那类**下限**只在**空间不够**时才起作用 ⇒ 默认窗口下**观察不到**；
//    ⇒ 把窗口压到**最小尺寸**（外框 520 ⇒ 主区只剩 ~330px）才是它的用武之地。
//
// ⚠ **断言为什么这么写**：
//    - 先量**几何**（文档高 vs 视口高、视口底边 vs 播放条上沿）—— 这才是「有没有被压住」的直接证据；
//    - 再验**用户看得见的结果**：视口自己是滚动容器（内容 1920px > 可视区）；
//    - 最后钉**两条下限**（NAS 段不低于 120px、且不超过窗口高度 ⇒ 没被顶开）。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import { LONG_ALBUM_SONGS } from '../mock-server/fixtures'
import { createMockServer, type MockServer } from '../mock-server/server'
import { launchApp, login, type AppFixture } from './helpers/app'

/** 行高（唯一真值在 TS 侧：`SONG_ROW_HEIGHT` = 48）。 */
const ROW_HEIGHT = 48
/** 注入的播放历史条数（40 ⇒ 40 × 48px = 1920px ⇒ 必定超过一屏）。 */
const HISTORY_COUNT = 40
/** 窗口最小尺寸（与 `electron/windowBounds.ts` 的常量一致）。 */
const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 520
/** NAS 段的**高度下限**（与 `history-page.css` 的契约一致）。 */
const NAS_SECTION_MIN_HEIGHT = 120

/** 一个盒子的几何。 */
interface Box {
  top: number
  bottom: number
  height: number
}

/** 「最近」页的整页几何。 */
interface HistoryGeometry {
  /** 文档（真正在滚的那一层）。 */
  doc: { scrollHeight: number; clientHeight: number }
  /** 页面外壳。 */
  page: Box | null
  /** 本机播放记录段。 */
  local: Box | null
  /** NAS 播放历史段。 */
  nas: Box | null
  /** NAS 列表的滚动容器。 */
  viewport: (Box & { clientHeight: number; scrollHeight: number }) | null
  /** 播放条。 */
  bar: Box | null
}

// ⚠ **不用 `.serial`**：这四条用例**各自独立**（每条都自己进「最近」页），
//    故意让它们**分别报红** ⇒ 一眼看出「哪条几何约束真的在承重」。
test.describe('T138：「最近」页不整页溢出、列表不被播放条压住', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠ 播放历史**按实例注入**（共享 fixtures 一条不改 ⇒ 别的用例零影响）。
    mock = createMockServer({ history: LONG_ALBUM_SONGS })
    fixture = await launchApp({ mock })
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.close()
    await mock?.close()
  })

  /** 进「最近」页并等 NAS 列表渲染出来。 */
  async function openHistory(): Promise<void> {
    const win = fixture.window
    await win.getByRole('navigation', { name: '曲库导航' }).getByRole('button', { name: '最近' }).click()
    // ⚠ 空列表**不渲染**视口节点（`SongList` 的空态分支）⇒
    //    本机段是空的 ⇒ 页面上的视口**唯一**就是 NAS 列表那个。
    await win.waitForSelector('.sanlos-songlist__viewport')
  }

  /** 量「最近」页的整页几何。 */
  async function geometry(): Promise<HistoryGeometry> {
    const geo = await fixture.window.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement
      const box = (el: Element | null): { top: number; bottom: number; height: number } | null => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height }
      }
      const viewport = document.querySelector('.sanlos-songlist__viewport')
      const viewportBox = box(viewport)
      return {
        doc: { scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight },
        page: box(document.querySelector('.sanlos-page')),
        local: box(document.querySelector('.sanlos-history__section--local')),
        nas: box(document.querySelector('.sanlos-history__section--nas')),
        viewport: viewport && viewportBox
          ? {
              ...viewportBox,
              clientHeight: viewport.clientHeight,
              scrollHeight: viewport.scrollHeight,
            }
          : null,
        bar: box(document.querySelector('[role="region"][aria-label="播放条"]')),
      }
    })
    // ⚠ 把实测数字打出来（台账要用；也便于**变异自证**时看清「哪条声明改了哪个数」）。
    //    ⚠ 这些数字**只代表这一份构建、这个窗口尺寸**（别的地方会不一样）。
    console.log(`[t138] 「最近」页几何：${JSON.stringify(geo)}`)
    return geo
  }

  test('整页**不滚动**（文档高度 == 视口高度）⇒ 没有多出来的 394px', async () => {
    await openHistory()
    const geo = await geometry()

    // ⚠ 缺陷态：文档 1155 / 窗口 761 ⇒ 这条直接变红。
    expect(geo.doc.scrollHeight).toBeLessThanOrEqual(geo.doc.clientHeight + 1)

    // 页面外壳也不许比窗口内容区高（缺陷态 608 / 1067）。
    expect(geo.page).not.toBeNull()
    expect(geo.page!.height).toBeLessThanOrEqual(geo.doc.clientHeight)
  })

  test('NAS 列表视口底边**在播放条上沿之上**（末尾几行不再被播放器压住）', async () => {
    await openHistory()
    const geo = await geometry()

    expect(geo.viewport).not.toBeNull()
    expect(geo.bar).not.toBeNull()

    // ⚠ 缺陷态：视口底边 1101 ≫ 播放条上沿 696 ⇒ 这条直接变红。
    expect(geo.viewport!.bottom).toBeLessThanOrEqual(geo.bar!.top)
  })

  test('NAS 列表**自己滚**（视口 < 内容高度 ⇒ 40 条能滚到底）', async () => {
    await openHistory()
    const geo = await geometry()

    expect(geo.viewport).not.toBeNull()
    // ⚠ 缺陷态：视口被内容顶高 ⇒ clientHeight == scrollHeight ⇒ 这条直接变红。
    expect(geo.viewport!.scrollHeight).toBeGreaterThan(geo.viewport!.clientHeight)
    // 内容高度 = 40 行 × 48px。
    expect(geo.viewport!.scrollHeight).toBe(HISTORY_COUNT * ROW_HEIGHT)
    // ⭐ 视口**不是 0 高**（少了根容器的 `flex: 1 1 auto` ⇒ NAS 段会拿到 0 高 ⇒ 列表整段消失）。
    expect(geo.viewport!.clientHeight).toBeGreaterThan(0)
  })

  test('NAS 段吃**剩余高度**（本机段保持自然高、不越界）', async () => {
    await openHistory()
    const geo = await geometry()

    expect(geo.local).not.toBeNull()
    expect(geo.nas).not.toBeNull()
    // ⭐ NAS 段**必须拿到能用的高度**（T104 同款判据）：
    //    少了 `.sanlos-history` 的 `flex: 1 1 auto` ⇒ NAS 段（basis = 0）拿到 **0 高**
    //    ⇒ 列表整段消失（比溢出更糟）。
    expect(geo.nas!.height).toBeGreaterThan(100)
    // 本机段（本机没有记录 ⇒ 空态）比 NAS 段矮。
    expect(geo.local!.height).toBeLessThan(geo.nas!.height)
    // ⭐ 本机段**不许超过它的上限**（本机最多 100 条 ⇒ 不封顶会把 NAS 段挤没）。
    expect(geo.local!.height).toBeLessThanOrEqual(240)
  })

  test('窗口压到**最小尺寸**时：NAS 段仍**不低于下限**、也没被顶开', async () => {
    // ⚠ 显式摆到最小尺寸（不依赖别的用例的副作用）。
    //    ⚠ `app.evaluate` 的回调跑在**主进程**里 ⇒ 只能用**参数**把尺寸传进去。
    const before = await fixture.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('没有可用的主窗口')
      return win.getBounds()
    })
    await fixture.app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('没有可用的主窗口')
        const b = win.getBounds()
        win.setBounds({ x: b.x, y: b.y, width: size.w, height: size.h })
      },
      { w: MIN_WINDOW_WIDTH, h: MIN_WINDOW_HEIGHT },
    )
    await fixture.window.waitForTimeout(400)

    try {
      await openHistory()
      const geo = await geometry()
      const windowHeight = await fixture.window.evaluate(() => window.innerHeight)

      expect(geo.nas).not.toBeNull()
      expect(geo.viewport).not.toBeNull()
      // ⭐ **下限生效**：空间再紧，NAS 段也不低于 120px（否则列表整段消失）。
      expect(geo.nas!.height).toBeGreaterThanOrEqual(NAS_SECTION_MIN_HEIGHT)
      // ⭐ **没被顶开**：NAS 段的高度不超过窗口高度
      //    （少了根容器的 `min-height: 0` ⇒ 它撑到内容高度 ⇒ 整页又被顶开）。
      expect(geo.nas!.height).toBeLessThanOrEqual(windowHeight)
      // 列表还在（不是 0 高）。
      expect(geo.viewport!.clientHeight).toBeGreaterThan(0)
    } finally {
      // ⚠ 还原窗口尺寸（不影响后面的用例）。
      await fixture.app.evaluate(
        ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win) throw new Error('没有可用的主窗口')
          win.setBounds({ x: size.x, y: size.y, width: size.width, height: size.height })
        },
        before,
      )
      await fixture.window.waitForTimeout(300)
    }
  })
})
