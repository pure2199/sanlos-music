import { expect, test, type Page } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { createMockServer, type MockServer } from '../mock-server/server'
import { LYRICS, SONGS } from '../mock-server/fixtures'

// ---------------------------------------------------------------------------
// T106：「**没有歌词**（匹配不到 ＋ 也没有内嵌）⇒ **不显示桌面歌词与灵动歌词**」
// —— E2E（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// ⚠️ **用户 2026-11-17 的原话**：
//    「匹配不到歌词也没有内嵌歌词的情况下，不要显示桌面歌词和灵动歌词」。
//
// ⚠️ **为什么必须是 E2E（而不是 Vitest + jsdom）**：
//    这条行为的主体是**主进程里的窗口显隐**（经典悬浮窗 / 灵动歌词岛
//    都是**另一个 BrowserWindow**）⇒ jsdom 里根本没有窗口可验。
//    ⇒ 本文件用**真实 Electron**验两件事：
//    ① 「无歌词 ⇒ **没有**那个窗口（或它不可见）」；
//    ② 「有歌词 ⇒ 那个窗口**出现且可见**」（证明不是把窗口整个干掉了）。
//
// ⚠️ **可见性怎么验**：Playwright 的 `page.isVisible()` 是 **DOM 级**的
//    （窗口被 `hide()` 了，DOM 元素照样报「可见」）⇒ 必须问**主进程**
//    `BrowserWindow.isVisible()`（OS 级）—— 这才是用户眼睛看到的事实。
//
// ⚠️ 全程**不碰真实外网**：E2E 夹具预置 `lyric.source = 'off'`
//    ⇒ 歌词只有两个来源：NAS 歌词表（`LYRICS`）与音频内嵌（T83）。
//    ⇒ 「既没有 NAS 歌词、也没有内嵌」的那首 = `SONGS` 里**不在** `LYRICS`
//    且**不是**内嵌歌词那首。
// ---------------------------------------------------------------------------

/** 有 NAS 歌词的那首。 */
const SONG_WITH_LYRIC = SONGS.find((song) => LYRICS.has(song.guid))!

/**
 * **既没有 NAS 歌词、也没有内嵌歌词**的那首（T106 的主角）。
 *
 * ⚠️ **为什么要自己造一首**：共享的 `LYRICS` 里**每首歌都有歌词**
 *    （只有内嵌歌词那首 `t2` 没有 NAS 歌词）⇒ 找不到「完全没歌词」的那首。
 * ⚠️ **不往共享 fixtures 里加歌**（那会让别的 E2E 变红：T97 断言「随机挑了 8 首」）
 *    ⇒ 复制一首**换 guid** ⇒ 歌词表按 guid 查 ⇒ 新 guid **没有**歌词。
 */
const SONG_WITHOUT_LYRIC = { ...SONGS[0]!, guid: 't106-nolyric', title: 'T106 无歌词曲目' }

/** 歌词窗口的 URL 尾巴。 */
const CLASSIC = 'lyric.html'
const ISLAND = 'island.html'

/** 读主进程那边「某个歌词窗口**在不在屏幕上**」（**OS 级**可见性）。 */
async function visibleOnScreen(fixture: AppFixture, suffix: string): Promise<boolean> {
  return await fixture.app.evaluate(({ BrowserWindow }, urlSuffix) => {
    return BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.webContents.getURL().endsWith(urlSuffix) && win.isVisible(),
    )
  }, suffix)
}

/** 那个歌词窗口**有没有被创建**（区分「没创建」与「创建了但藏起来」）。 */
async function exists(fixture: AppFixture, suffix: string): Promise<boolean> {
  return await fixture.app.evaluate(({ BrowserWindow }, urlSuffix) => {
    return BrowserWindow.getAllWindows().some((win) =>
      win.webContents.getURL().endsWith(urlSuffix),
    )
  }, suffix)
}

/** 在设置页里切到「歌词」分类。 */
async function openLyricSettings(window: Page): Promise<void> {
  const settings = window.getByRole('region', { name: '设置' })
  if ((await settings.count()) === 0) {
    await window.getByRole('button', { name: '设置', exact: true }).click()
  }
  await expect(settings).toBeVisible()
  await window
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '歌词', exact: true })
    .click()
}

/** 打开「显示悬浮歌词」开关（已开着就不动它）。 */
async function enableDesktopLyric(window: Page): Promise<void> {
  const checkbox = window.getByRole('checkbox', { name: /显示悬浮歌词/ })
  if (!(await checkbox.isChecked())) await checkbox.click()
}

/** 切桌面歌词的形态。 */
async function switchMode(window: Page, mode: '经典悬浮窗' | '灵动态词岛'): Promise<void> {
  await window.getByRole('radio', { name: mode, exact: true }).click()
}

/** 播一首指定的歌（双击歌曲行）。 */
async function playSong(window: Page, title: string): Promise<void> {
  await window.getByRole('button', { name: '歌曲', exact: true }).click()
  const list = window.getByRole('listbox', { name: '歌曲列表' })
  await expect(list).toBeVisible()
  await list.getByRole('option').filter({ hasText: title }).first().dblclick()
  await expect(window.locator('.sanlos-playerbar__title')).toHaveText(title)
}

/** 等到「那个歌词窗口」出现（最多 15 秒）。 */
async function waitForVisible(
  fixture: AppFixture,
  suffix: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await visibleOnScreen(fixture, suffix)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

test.describe.serial('T106：没有歌词 ⇒ 不显示桌面歌词 / 灵动歌词', () => {
  let fixture: AppFixture
  /** 自建的 mock（**按实例注入**曲库 ⇒ 共享 fixtures 一条未改）。 */
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠️ **按实例注入曲库**：一有歌词 ＋ 一首**没有歌词**。
    mock = createMockServer({ songs: [SONG_WITH_LYRIC, SONG_WITHOUT_LYRIC] })
    fixture = await launchApp({ mock })
  })

  test.afterAll(async () => {
    await fixture?.close()
    // ⚠️ mock 是**自建**的（`launchApp` 不负责关它）⇒ 得自己关。
    await mock?.close()
  })

  test('① 经典悬浮窗：无歌词的歌 ⇒ **不出现**；换成有歌词的歌 ⇒ 出现', async () => {
    const window = fixture.window
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await login(window, fixture.mock.url)

    // 先播那首**没有歌词**的歌。
    await playSong(window, SONG_WITHOUT_LYRIC.title)

    await openLyricSettings(window)
    await switchMode(window, '经典悬浮窗')
    await enableDesktopLyric(window)
    await window.getByRole('button', { name: '关闭设置', exact: true }).click()

    // ⚠️ **等一会儿**再断言「没有」：歌词取回很快（mock 本地）⇒
    //    若实现有缺陷，窗口会在这几秒内冒出来 ⇒ 「没出现」才有意义。
    await window.waitForTimeout(4000)
    expect(await visibleOnScreen(fixture, CLASSIC)).toBe(false)

    // 换成**有歌词**的那首 ⇒ 窗口自己出来（**不依赖**用户再点一次开关）。
    await playSong(window, SONG_WITH_LYRIC.title)
    expect(await waitForVisible(fixture, CLASSIC)).toBe(true)
  })

  test('② 灵动态词岛：无歌词的歌 ⇒ **不出现**；换成有歌词的歌 ⇒ 出现', async () => {
    const window = fixture.window
    // 全屏页是浮层 ⇒ 先关掉（否则点不到顶栏）。
    const fullPlayer = window.getByTestId('full-player')
    if ((await fullPlayer.count()) > 0) {
      await window.getByRole('button', { name: '关闭全屏播放页', exact: true }).click()
      await expect(fullPlayer).toHaveCount(0)
    }

    await openLyricSettings(window)
    await switchMode(window, '灵动态词岛')
    await enableDesktopLyric(window)
    await window.getByRole('button', { name: '关闭设置', exact: true }).click()

    // 播那首**没有歌词**的歌（词岛还要「正在播放」才可能出现）。
    await playSong(window, SONG_WITHOUT_LYRIC.title)
    await window.waitForTimeout(4000)
    expect(await visibleOnScreen(fixture, ISLAND)).toBe(false)

    // 换成有歌词的那首 ⇒ 词岛出来。
    await playSong(window, SONG_WITH_LYRIC.title)
    expect(await waitForVisible(fixture, ISLAND)).toBe(true)

    // ⚠️ **反向核对**：不能是「窗口被干掉了」——它只是**没歌词时不显示**。
    expect(await exists(fixture, ISLAND)).toBe(true)
  })
})
