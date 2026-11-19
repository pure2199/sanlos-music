import { expect, test, type Page } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { LYRICS, SONGS } from '../mock-server/fixtures'

// ---------------------------------------------------------------------------
// T108：外部源给的**逐字**歌词 ⇒ 渲染成**真逐字**（**真实 Electron**）
// ---------------------------------------------------------------------------
//
// ⚠️ **这条用例验的是哪一段链路**：
//    主进程（`electron/lyricProvider.ts`）从**外部源**拿到带 `<mm:ss.xx>` 的歌词
//    ⇒ 经 IPC ⇒ 渲染层 `parseLyricEntries` 解析 ⇒ `LyricView` 渲染成**真逐字**（卡拉OK）。
//
// ⚠️ **与 T81 的区别**（别混）：
//    - T81 验的是 **NAS 内嵌**歌词里的逐字（`LYRICS` 里 `t1` 那份 `ENHANCED_LRC_T1`）；
//    - 本条验的是 **外部源**给的那份 ⇒ **主进程选词 → IPC → 渲染**这一整段。
//
// ⚠️ **鉴别力（缺一不可）**：
// 1. **零**行级整行强调（`.sanlos-lyricview__line--whole` 不存在）
//    ⇒ 证明走的是**逐字**那条路，不是「行级整行显示」；
// 2. **有**词级元素（`[data-word]` / `--karaoke` / `--overlay`）
//    ⇒ 证明**真的**按词级时间戳渲染（卡拉OK 在）；
// 3. 内容是 **mock 那个端点**给的 ⇒ 证明**确实走了外部源**（NAS 里 `t2` 没有歌词）。
//
// ⚠️ **全程不碰真实外网**：E2E 夹具预置 `lyric.source = 'off'`，
//    且 `launchApp` 设 `SANLOS_LYRIC_SOURCES=custom`（T108）⇒ 链里只有 `custom`
//    ⇒ 不会去问网易云 / lrclib / QQ / 酷狗 / 酷我 / 咪咕。
// ---------------------------------------------------------------------------

/** 那首 **NAS 里没有歌词**的歌（`LYRICS` 里没有它）⇒ 歌词只能靠外部源补齐。 */
const SONG_WITHOUT_LOCAL_LYRIC = SONGS.find((song) => !LYRICS.has(song.guid))!

/** mock 的逐字歌词**去掉词级标签后**剩下的正文**。 */
const WORD_LYRIC_TEXT = '外部逐字源'

/**
 * 目标播放位置：落在**第一行**（`[00:05.00]`，铺到 `00:07.00`）**内部**。
 *
 * ⚠️ 为什么不取行首：行首时「当前行还没开始唱」⇒ 与「没高亮」**长得一样**。
 */
const TARGET_SECONDS = 6

/** 把播放进度条定位到指定秒（**原生 setter** —— React 装了变更追踪器，直接赋值不触发 onChange）。 */
async function seekTo(window: Page, seconds: number): Promise<void> {
  const slider = window.getByRole('slider', { name: '播放进度' })
  await expect(slider).toBeEnabled()
  await expect
    .poll(async () => Number(await slider.getAttribute('max')), { timeout: 15000 })
    .toBeGreaterThan(seconds)
  await slider.evaluate((element, value) => {
    const input = element as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('拿不到 value 的原生 setter')
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, seconds)
  await slider.dispatchEvent('mouseup')
}

test.describe.serial('T108：外部源的逐字歌词 ⇒ 真逐字（真实 Electron）', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  /** 登录（没连上服务器时点「连接」打开登录页 —— 与 t83/t107 同一套稳健写法）。 */
  async function ensureLoggedIn(): Promise<void> {
    const window = fixture.window
    const songsButton = window.getByRole('button', { name: '歌曲', exact: true })
    if ((await songsButton.count()) > 0) return
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await expect(window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
    await login(window, fixture.mock.url)
  }

  /** 把「歌词源」设成**自定义 API**，模板指向 mock 的**逐字**端点。 */
  async function useWordTimedExternalSource(): Promise<void> {
    const window = fixture.window
    await ensureLoggedIn()

    // 设置页是主区里的一个视图；「歌词来源」在「歌词」这一档里，默认不显示。
    const settingsPage = window.getByRole('region', { name: '设置' })
    if ((await settingsPage.count()) === 0) {
      await window.getByRole('button', { name: '设置', exact: true }).click()
    }
    await expect(settingsPage).toBeVisible()
    await window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '歌词', exact: true })
      .click()

    const group = window.getByRole('group', { name: '歌词来源' })
    const saveButton = group.getByRole('button', { name: '保存歌词源' })
    await group.getByRole('combobox', { name: '外部歌词源' }).selectOption('custom')
    await group
      .getByRole('textbox', { name: '自定义歌词 API 模板' })
      .fill(
        `${fixture.mock.url}/mock-lyric-word?title={title}&artist={artist}&album={album}&duration={duration}`,
      )
    // ⚠️ 「保存」按钮在**没有改动**时是禁用的 ⇒ 先判一下再点（否则会等到超时）。
    if (await saveButton.isEnabled()) await saveButton.click()

    // ⚠️ 设置页开着的时候**曲库导航不在 DOM 里** ⇒ 先关掉设置页。
    await window.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(settingsPage).toHaveCount(0)
  }

  test('外部源给的**逐字**歌词 ⇒ 渲染成**真逐字**（卡拉OK 在，整行强调不在）', async () => {
    const window = fixture.window
    await useWordTimedExternalSource()

    // 播那首 **NAS 没有歌词**的歌 ⇒ 歌词只能来自外部源。
    await window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '歌曲' })
      .click()
    const list = window.getByRole('listbox', { name: '歌曲列表' })
    await list.getByRole('option').filter({ hasText: SONG_WITHOUT_LOCAL_LYRIC.title }).first().dblclick()
    await expect(window.locator('.sanlos-playerbar__title')).toHaveText(SONG_WITHOUT_LOCAL_LYRIC.title)

    // ⚠️ **暂停 + 精确定位**：位置冻结 ⇒ 断言才可复现。
    await window.getByRole('button', { name: '暂停', exact: true }).click()
    await expect(window.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await seekTo(window, TARGET_SECONDS)

    await window.getByRole('button', { name: '全屏播放页', exact: true }).click()
    const page = window.getByTestId('full-player')
    await expect(page).toBeVisible()
    const stage = page.locator('.sanlos-lyricview--all')
    await expect(stage).toBeVisible()

    // --- 鉴别力 1：内容确实来自 mock 的**外部源**（NAS 里这首歌没有歌词）-----
    await expect(stage.getByText(WORD_LYRIC_TEXT, { exact: true })).toBeVisible()
    // ⚠️ 如实显示**实际命中的源**（T73 既有口径）。
    await expect(window.getByText('歌词来源：自定义 API')).toBeVisible()

    // --- 鉴别力 2：**有**词级元素 ⇒ 真的按词级时间戳渲染了 ---------------------
    expect(await stage.locator('[data-word]').count()).toBeGreaterThan(0)
    expect(await stage.locator('.sanlos-lyricview__word--karaoke').count()).toBeGreaterThan(0)
    expect(await stage.locator('.sanlos-lyricview__overlay').count()).toBeGreaterThan(0)

    // --- 鉴别力 3：**没有**整行强调 ⇒ 走的是「逐字」那条路，不是「行级整行」 -----
    //    （T81：真逐字与整行强调**互斥** ⇒ 这一条同时排除了「退化成行级」。）
    expect(await stage.locator('.sanlos-lyricview__line--whole').count()).toBe(0)

    // 收尾：全屏页是全屏浮层 → 盖住顶栏 → 下一条用例点不到顶栏按钮。
    await window.getByRole('button', { name: '关闭全屏播放页' }).click()
    await expect(window.getByTestId('full-player')).toHaveCount(0)
  })
})
