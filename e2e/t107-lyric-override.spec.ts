import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'

// ---------------------------------------------------------------------------
// T107：**按歌选源**（真实 Electron）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这条用例必须是 E2E**：
//    「用户给这首歌指定了源 ⇒ 歌词真的换成了那个源的」这条链**跨了四层**——
//    全屏页的控件 → 渲染层的 store → IPC（渲染层把源名报给主进程）→
//    主进程按它建链去抓 → 抓回来的歌词显示在歌词舞台。
//    jsdom 里既没有 preload 的桥，也没有主进程 ⇒ 单测只能钉住每一层**自己**的行为。
//
// ⚠️ **鉴别力（缺一不可）**：
// 1. **全局源 = 不用外部**（`off`）⇒ 不指定时**一次网络请求都不发**
//    ⇒ 歌词只能来自 NAS（mock 的「第一行歌词」）；
// 2. **模板指向 mock 的 `/mock-lyric`** ⇒ 指定「自定义 API」后，
//    主进程抓的是 **mock**（不是真实外网）⇒ 歌词变成「外部歌词源第一行」；
// 3. **两向断言**：指定后是外部那份、「恢复自动」后**又是** NAS 那份
//    ⇒ 不是「随便换了点东西」，是**真的按源换了**；
// 4. **换歌 ⇒ 指定不跟着走**（只对这一首生效）。
//
// ⚠️ 全程**不碰真实外网**：全局源是 `off`，指定的源是 mock 自己。
// ---------------------------------------------------------------------------

/** NAS 那首歌的歌词（mock 的普通行级 LRC）。 */
const NAS_LYRIC_LINE = '第一行歌词'

/** mock 的外部歌词源返回的那份。 */
const EXTERNAL_LYRIC_LINE = '外部歌词源第一行'

test.describe.serial('T107：按歌选源（真实 Electron）', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  /** 登录（没连上服务器时点「连接」打开登录页 —— 与 t83 同一套稳健写法）。 */
  async function ensureLoggedIn(): Promise<void> {
    const window = fixture.window
    const songsButton = window.getByRole('button', { name: '歌曲', exact: true })
    if ((await songsButton.count()) > 0) return
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await expect(window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
    await login(window, fixture.mock.url)
  }

  /** 把「模板」指向 mock，并把**全局源**设成「不用外部」。 */
  async function prepareExternalTemplate(): Promise<void> {
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
    // ① 先选「自定义 API」并把模板填成 mock 的端点 ⇒ **保存**（这一步把模板存下来）。
    await group.getByRole('combobox', { name: '外部歌词源' }).selectOption('custom')
    await group
      .getByRole('textbox', { name: '自定义歌词 API 模板' })
      .fill(
        `${fixture.mock.url}/mock-lyric?title={title}&artist={artist}&album={album}&duration={duration}`,
      )
    // ⚠️ 「保存」按钮在**没有改动**时是禁用的 ⇒ 先判一下再点（否则会等到超时）。
    if (await saveButton.isEnabled()) await saveButton.click()

    // ② 再把**全局源**改回「不用外部」⇒ **模板保留**（设置面板保存时一起写）。
    //    ⚠️ 这一步是本用例的**关键前提**：不指定时**一次网络请求都不发**
    //    ⇒ 歌词只能来自 NAS ⇒ 「指定之后变了」才有说服力。
    await group.getByRole('combobox', { name: '外部歌词源' }).selectOption('off')
    if (await saveButton.isEnabled()) await saveButton.click()

    // ⚠️ 设置页开着的时候**曲库导航不在 DOM 里** ⇒ 先关掉设置页。
    await window.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(settingsPage).toHaveCount(0)
  }

  /** 播放指定那首 → 打开全屏播放页。 */
  async function openStageWith(songTitle: string): Promise<void> {
    const window = fixture.window
    await window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '歌曲' })
      .click()
    const list = window.getByRole('listbox', { name: '歌曲列表' })
    await list.getByRole('option').filter({ hasText: songTitle }).first().dblclick()
    await expect(window.locator('.fnm-playerbar__title')).toHaveText(songTitle)
    await window.getByRole('button', { name: /全屏/ }).first().click()
    await expect(window.getByTestId('full-player')).toBeVisible()
  }

  test('给这首歌指定源 ⇒ 歌词换成那个源的；「恢复自动」⇒ 回到全局', async () => {
    const window = fixture.window
    await prepareExternalTemplate()
    await openStageWith('示例曲目 3')

    const page = window.getByTestId('full-player')
    const stage = page.locator('.fnm-lyricview--all')
    await expect(stage).toBeVisible()

    // --- 鉴别力 1：不指定时 = NAS 那份（全局源是「不用外部」）----------------
    await expect(stage.getByText(NAS_LYRIC_LINE, { exact: true })).toBeVisible()
    await expect(stage.getByText(EXTERNAL_LYRIC_LINE, { exact: true })).toHaveCount(0)

    // --- 指定「自定义 API」⇒ 重新取词 ⇒ 换成那个源的歌词 --------------------
    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    await expect(stage.getByText(EXTERNAL_LYRIC_LINE, { exact: true })).toBeVisible()
    await expect(stage.getByText(NAS_LYRIC_LINE, { exact: true })).toHaveCount(0)
    // ⚠️ **如实显示实际命中的源**（T73 既有口径）。
    await expect(window.getByText('歌词来源：自定义 API')).toBeVisible()
    // ⚠️ 有指定 ⇒ 「恢复自动」才出现。
    await expect(page.getByRole('button', { name: '恢复自动', exact: true })).toBeVisible()

    // --- 「恢复自动」⇒ 回到全局（NAS 那份）----------------------------------
    await page.getByRole('button', { name: '恢复自动', exact: true }).click()
    await expect(stage.getByText(NAS_LYRIC_LINE, { exact: true })).toBeVisible()
    await expect(stage.getByText(EXTERNAL_LYRIC_LINE, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '恢复自动', exact: true })).toHaveCount(0)

    // 收尾：全屏页是全屏浮层 → 盖住顶栏 → 下一条用例点不到顶栏按钮。
    await window.getByRole('button', { name: '关闭全屏播放页' }).click()
    await expect(window.getByTestId('full-player')).toHaveCount(0)
  })

  test('指定**只对这一首歌**生效（换歌 ⇒ 没有指定）', async () => {
    const window = fixture.window
    await prepareExternalTemplate()
    await openStageWith('示例曲目 3')

    const page = window.getByTestId('full-player')
    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复自动', exact: true })).toBeVisible()

    // 换一首歌 ⇒ 上一首的指定**不跟着走**。
    await window.getByRole('button', { name: '关闭全屏播放页' }).click()
    await expect(window.getByTestId('full-player')).toHaveCount(0)
    await openStageWith('示例曲目 4')

    const nextPage = window.getByTestId('full-player')
    await expect(nextPage.getByRole('button', { name: '恢复自动', exact: true })).toHaveCount(0)

    // 收尾：清掉这首歌的指定（别留给别的用例）。
    await nextPage.getByRole('button', { name: '自定义 API', exact: true }).click()
    await nextPage.getByRole('button', { name: '恢复自动', exact: true }).click()
    await window.getByRole('button', { name: '关闭全屏播放页' }).click()
    await expect(window.getByTestId('full-player')).toHaveCount(0)
  })
})
