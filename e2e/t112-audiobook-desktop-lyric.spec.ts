import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ALBUMS, AUDIOBOOK_ALBUM, AUDIOBOOK_SONGS, SONGS } from '../mock-server/fixtures'
import { createMockServer, type MockServer } from '../mock-server/server'
import { launchApp, login, type AppFixture } from './helpers/app'

// ---------------------------------------------------------------------------
// T112：有声读物 ⇒ 桌面歌词**不显示**、也**不查词**（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// ⚠️ **这条缺陷是 T111 真机复验时发现的**（2026-11-18，已装的 v0.4.0）：
//    有声读物的集标题是 `0001` 这种**纯数字** ⇒ 歌词源拿它去匹配
//    ⇒ **随便命中某首别的歌** ⇒ 桌面歌词窗 / 灵动歌词岛显示**不相干的词**
//    （实测 161 / 122 / 132 / 235 / 108 / 348 行）。
//
// ⇒ 全屏播放页（T101）早就有「有声读物不查词」的口径 ⇒ 这一轮把**桌面歌词这条路补上**。
//
// ⚠️ **鉴别力（缺一不可）**：
// 1. **播有声那一集** ⇒ 桌面歌词窗**不出现**（主进程 `BrowserWindow.isVisible()`，
//    **OS 级** —— `page.isVisible()` 是 DOM 级，窗口被 `hide()` 了它照样报「可见」）；
// 2. **外部源一次都没被问** ⇒ 用**本文件自己起的一台**假歌词源服务器**数请求**
//    （用 mock 的 `/mock-lyric` 数不了 ⇒ 它不记请求数）；
// 3. **对照组**：播普通歌 ⇒ 窗口**出现** ＋ 外部源**确实被问过**
//    ⇒ 证明「没出现」不是「这条路根本没通」。
//
// ⚠️ **为什么外部源指向本文件自己的服务器**：
//    共享 fixtures **一条不改**（T97 断言「随机挑了 8 首」）⇒ 不能给 mock 加歌词；
//    而 mock 的 `/mock-lyric` **不记请求数** ⇒ 数不了「有没有被问」。
//    ⇒ 自己起一台回环 HTTP 服务器（主进程只接受 https 或**回环** http）。
//
// ⚠️ 全程**不碰真实外网**：外部源 = 本文件自己的回环服务器；
//    兜底源由夹具的 `SANLOS_LYRIC_SOURCES=custom` 限死（见 `e2e/helpers/app.ts`）。
// ---------------------------------------------------------------------------

/** 假外部源给的那份 LRC（**两行正文各不相同** ⇒ 精确匹配不歧义）。 */
const FAKE_LRC = '[00:01.00]外部源第一行\n[00:03.00]外部源第二行'

/** 歌词窗口的 URL 尾巴。 */
const CLASSIC = 'lyric.html'
const ISLAND = 'island.html'

/** 有声读物的专辑名（秒搜用）。 */
const AUDIOBOOK_ALBUM_NAME = '示例有声作品'

/** 有声读物的**第 1 集**（详情页按集序排 ⇒ 第一行就是它）。 */
const EPISODE_TITLE = '01- 第1集'

/** 对照组：普通歌。 */
const NORMAL_SONG_TITLE = '示例曲目 1'

/** 本文件自己起的**假外部歌词源**（**数请求** ⇒ 能证明「一次都没被问」）。 */
interface FakeLyricSource {
  /** 基址（形如 `http://127.0.0.1:<端口>`）。 */
  url: string
  /** 已经被问过几次。 */
  requests: () => number
  /** 把计数清零。 */
  reset: () => void
  /** 关掉。 */
  close: () => Promise<void>
}

/** 起一台假外部歌词源（回环 HTTP ＋ 纯文本 LRC ＋ 请求计数）。 */
async function startFakeLyricSource(): Promise<FakeLyricSource> {
  let count = 0
  const server = createServer((_req, res) => {
    count += 1
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(FAKE_LRC)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    reset: () => {
      count = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 读主进程那边「某个歌词窗口**在不在屏幕上**」（**OS 级**可见性）。 */
async function visibleOnScreen(fixture: AppFixture, suffix: string): Promise<boolean> {
  return await fixture.app.evaluate(({ BrowserWindow }, urlSuffix) => {
    return BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.webContents.getURL().endsWith(urlSuffix) && win.isVisible(),
    )
  }, suffix)
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

/** 关掉全屏播放页（它是浮层 ⇒ 会盖住顶栏）。 */
async function closeFullPlayer(window: Page): Promise<void> {
  const fullPlayer = window.getByTestId('full-player')
  if ((await fullPlayer.count()) > 0) {
    await window.getByRole('button', { name: '关闭全屏播放页', exact: true }).click()
    await expect(fullPlayer).toHaveCount(0)
  }
}

/** 进设置页的「歌词」分类。 */
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

/**
 * 把「外部歌词源」指向**本文件自己的**假源，并打开桌面歌词（经典悬浮窗）。
 */
async function setupDesktopLyric(window: Page, source: FakeLyricSource): Promise<void> {
  await openLyricSettings(window)

  // ① 外部源 = 自定义 API ＋ 模板指向自己的服务器 ⇒ **一个真实外网请求都不发**。
  const group = window.getByRole('group', { name: '歌词来源' })
  const saveButton = group.getByRole('button', { name: '保存歌词源' })
  await group.getByRole('combobox', { name: '外部歌词源' }).selectOption('custom')
  await group
    .getByRole('textbox', { name: '自定义歌词 API 模板' })
    .fill(`${source.url}/lyric?title={title}&artist={artist}&album={album}&duration={duration}`)
  if (await saveButton.isEnabled()) await saveButton.click()

  // ② 打开「显示悬浮歌词」＋ 经典悬浮窗形态。
  const checkbox = window.getByRole('checkbox', { name: /显示悬浮歌词/ })
  if (!(await checkbox.isChecked())) await checkbox.click()
  await window.getByRole('radio', { name: '经典悬浮窗', exact: true }).click()

  await window.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(window.getByRole('region', { name: '设置' })).toHaveCount(0)
}

/**
 * 秒搜那部有声作品 ⇒ 点开 ⇒ **用户指认了它**（「这是有声」）
 * ⇒ 专辑 id 被记成有声（**并落盘**）。
 *
 * ⚠️ 走的是**产品自己的**入口（与用户点的一模一样）⇒ 不是往 store 里硬塞状态。
 */
async function markAudiobookBySearch(window: Page): Promise<void> {
  await window.getByRole('button', { name: '有声', exact: true }).click()
  await window.getByPlaceholder('输入作品名，例如：牧神记').fill(AUDIOBOOK_ALBUM_NAME)
  await window.getByRole('button', { name: '搜作品' }).click()

  const results = window.locator('.sanlos-audiobooks__result')
  await expect(results).toHaveCount(1)
  await results.first().locator('.sanlos-audiobooks__title').click()
  // ⚠️ 详情页按**集序**排 ⇒ 第一行就是第 1 集（证明「有声」已经生效）。
  await expect(window.locator('.sanlos-detail__audiobook-note')).toHaveText('已按集序排列')
}

/** 在**专辑详情页**里播第 1 集（有声读物的自然路径）。 */
async function playFirstEpisodeFromDetail(window: Page): Promise<void> {
  const rows = window.locator('.sanlos-songlist__row')
  await expect(rows.first().locator('.sanlos-songlist__title')).toHaveText(EPISODE_TITLE)
  await rows.first().dblclick()
  await expect(window.locator('.sanlos-playerbar__title')).toHaveText(EPISODE_TITLE)
}

/** 播普通歌（对照组）。 */
async function playNormalSong(window: Page): Promise<void> {
  await window.getByRole('navigation', { name: '曲库导航' }).getByRole('button', { name: '歌曲' }).click()
  const list = window.getByRole('listbox', { name: '歌曲列表' })
  await expect(list).toBeVisible()
  await list.getByRole('option').filter({ hasText: NORMAL_SONG_TITLE }).first().dblclick()
  await expect(window.locator('.sanlos-playerbar__title')).toHaveText(NORMAL_SONG_TITLE)
}

/** 登录（没连上服务器时点「连接」打开登录页 —— 与 t83 / t107 同一套稳健写法）。 */
async function ensureLoggedIn(fixture: AppFixture): Promise<void> {
  const window = fixture.window
  // ⚠️ **必须等应用起来**：重启后它**多半自动登录**（`session.bin` 还在）
  //    ⇒ 登录表单**存在但不可见** ⇒ 一看见 `#sanlos-address` 就去填 ⇒ **必然超时**
  //    （第一轮就踩了这个坑：断言没跑到，栽在 `page.fill` 上）。
  let state = 'booting'
  const start = Date.now()
  while (Date.now() - start < 30_000) {
    if ((await window.getByRole('button', { name: '歌曲', exact: true }).count()) > 0) {
      state = 'ready'
      break
    }
    if (await window.locator('#sanlos-address').isVisible().catch(() => false)) {
      state = 'login'
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (state === 'ready') return
  if (state !== 'login') throw new Error('应用没有进入可操作状态（既没进主界面，也没停在登录页）')
  await window.getByRole('button', { name: '连接', exact: true }).click()
  await login(window, fixture.mock.url)
}

/** 进「专辑」页 → 点开那部有声作品 → 详情页（**按集序排**）。 */
async function openAudiobookDetail(window: Page): Promise<void> {
  await window
    .getByRole('navigation', { name: '曲库导航' })
    .getByRole('button', { name: '专辑' })
    .click()
  await window.locator('.sanlos-card__button').filter({ hasText: AUDIOBOOK_ALBUM_NAME }).click()
  await window.waitForSelector('.sanlos-songlist__row')
}

test.describe.serial('T112：有声读物 ⇒ 桌面歌词不显示、也不查词', () => {
  let fixture: AppFixture
  let mock: MockServer
  let source: FakeLyricSource

  test.beforeAll(async () => {
    // ⚠️ **按实例注入** 12 集有声专辑（共享 fixtures 一条不改 ⇒ 别的用例不受影响）。
    mock = createMockServer({
      songs: [...SONGS, ...AUDIOBOOK_SONGS],
      albums: [...ALBUMS, AUDIOBOOK_ALBUM],
    })
    source = await startFakeLyricSource()
    fixture = await launchApp({ mock })
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
    await setupDesktopLyric(fixture.window, source)
  })

  test.afterAll(async () => {
    await fixture?.close()
    // ⚠️ mock 与假源都是**这个用例自己建的** ⇒ 得自己关。
    await mock?.close()
    await source?.close()
  })

  test('① 播有声那一集 ⇒ 桌面歌词窗**不出现**，外部源**一次都没被问**', async () => {
    const window = fixture.window
    await closeFullPlayer(window)
    await markAudiobookBySearch(window)

    source.reset()
    await playFirstEpisodeFromDetail(window)

    // ⚠️ **等一会儿**再断言「没有」：取词很快（本地回环）⇒
    //    若实现有缺陷，窗口会在这几秒内冒出来 ⇒ 「没出现」才有意义。
    await window.waitForTimeout(5000)
    expect(await visibleOnScreen(fixture, CLASSIC)).toBe(false)
    // ⚠️ **鉴别力 2**：外部源**一次都没被问**（不是「问了但没匹配上」）。
    expect(source.requests()).toBe(0)
  })

  test('② 对照组：播普通歌 ⇒ 窗口**出现**，外部源**确实被问过**', async () => {
    const window = fixture.window
    await closeFullPlayer(window)

    source.reset()
    await playNormalSong(window)

    expect(await waitForVisible(fixture, CLASSIC)).toBe(true)
    // ⚠️ 这一条证明「① 里的没出现」**不是因为这条路根本没通**。
    expect(source.requests()).toBeGreaterThan(0)
  })

  test('③ 灵动态词岛同样**不出现**（一处守卫 ⇒ 两种形态全覆盖）', async () => {
    const window = fixture.window
    await closeFullPlayer(window)
    await openLyricSettings(window)
    await window.getByRole('radio', { name: '灵动态词岛', exact: true }).click()
    await window.getByRole('button', { name: '关闭设置', exact: true }).click()

    // ⚠️ 先播普通歌 ⇒ 词岛**应该**出来（对照组：这条路是通的）。
    await playNormalSong(window)
    expect(await waitForVisible(fixture, ISLAND)).toBe(true)

    // 再播有声那一集 ⇒ 词岛**收回去**。
    await markAudiobookBySearch(window)
    source.reset()
    await playFirstEpisodeFromDetail(window)
    await window.waitForTimeout(5000)
    expect(await visibleOnScreen(fixture, ISLAND)).toBe(false)
    expect(source.requests()).toBe(0)
  })

  test('④ 重启后（**没进过「有声」页**）⇒ 仍然不显示桌面歌词（证明启动时恢复了落盘判定）', async () => {
    // ⚠️ 落盘的判定只存在于 **localStorage** ⇒ 重启后**内存里是空的**。
    //    若启动时没有 `restore()` ⇒ 应用**不知道**哪些专辑是有声读物
    //    ⇒ 桌面歌词会照查照显 ⇒ 这条用例会红。
    // ⚠️ 这条**必须放最后**：它会把当前实例关掉（同一 userData 目录的单实例锁）。
    await fixture.closeApp()
    const restarted = await launchApp({ mock, userDataDir: fixture.userDataDir })
    try {
      const window = restarted.window
      await ensureLoggedIn(restarted)

      // ⚠️ 上一条用例把形态切成了「灵动态词岛」⇒ 这里切回「经典悬浮窗」
      //    （否则「经典窗没出现」是**废话** —— 那个形态下它本来就不该出现）。
      await openLyricSettings(window)
      await window.getByRole('radio', { name: '经典悬浮窗', exact: true }).click()
      await window.getByRole('button', { name: '关闭设置', exact: true }).click()

      // --- 对照组：重启后播普通歌 ⇒ 窗口**出现**（这条路是通的）--------------
      source.reset()
      await playNormalSong(window)
      expect(await waitForVisible(restarted, CLASSIC)).toBe(true)

      // --- 有声那一集 ⇒ 窗口**不出现** ＋ 外部源**一次都没被问** --------------
      // ⚠️ **不进「有声」页**：只进「专辑」页 ⇒ 详情页要靠**落盘判定**才知道是「有声」。
      await openAudiobookDetail(window)
      // ⚠️ 详情页**按集序排** ⇒ 证明启动时确实恢复了「这是有声」的判定。
      await expect(window.locator('.sanlos-detail__audiobook-note')).toHaveText('已按集序排列')

      source.reset()
      await playFirstEpisodeFromDetail(window)

      await window.waitForTimeout(5000)
      expect(await visibleOnScreen(restarted, CLASSIC)).toBe(false)
      expect(source.requests()).toBe(0)
    } finally {
      // ⚠️ 只关这个新实例；**别动** mock 与 userData 目录（fixture 的 close 会收尾）。
      await restarted.closeApp()
    }
  })
})
