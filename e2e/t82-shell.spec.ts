import { expect, test } from '@playwright/test'

import { launchApp, type AppFixture } from './helpers/app'

// ---------------------------------------------------------------------------
// T82：外壳收尾 —— F12 / 版本号 / 项目地址 / 自动更新源
// ---------------------------------------------------------------------------
//
// ⚠️ 这组用例钉的是**真实 Electron 里才验得到**的东西：
//    ① 「按 F12 / Ctrl+Shift+I **开不出**开发者工具」——
//       jsdom 里**没有窗口、没有 devtools**，根本无从断言；
//    ② 版本号 == **主进程** `app.getVersion()`（渲染层自己读不到 package.json）；
//    ③ 项目地址链接的 `href` 真的指向仓库（白名单在主进程那一侧）；
//    ④ 更新源默认就是**项目地址**（不用先手填一遍）。
//
// ⚠️ **不出网**：自动更新那条只验「设置页里源地址已经指向项目」，
//    **不点「检查更新」**（那会真的打 GitHub ⇒ 既慢又不确定）。
//
// ⚠️ 全部数据都是 mock 的占位数据，不含真实 FN ID / 账号 / 口令。
// ---------------------------------------------------------------------------

/** 仓库地址（与 `shared/appInfo.ts` 的 `APP_INFO.repository` 一致）。 */
const REPOSITORY_URL = 'https://github.com/pure2199/sanlos-music'

/** 更新源地址（`releases/latest/download` ⇒ 永远指向最新那版）。 */
const UPDATE_BASE_URL = 'https://github.com/pure2199/sanlos-music/releases/latest/download'

test.describe.serial('Sanlos Music 桌面端：T82 外壳（F12 / 版本号 / 项目地址 / 更新源）', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  // -------------------------------------------------------------------------
  // T82-a：F12 **开不出**开发者工具
  // -------------------------------------------------------------------------
  //
  // ⚠️ **鉴别力（关键）**：这条断言的是**主进程里的真实状态**
  //    （`webContents.isDevToolsOpened()`），不是「界面上没弹什么东西」。
  //    ⇒ 把 F12 重新绑回 `openDevTools`（T82 之前那样），它**必定变红**。
  //
  // ⚠️ **必须用主进程的 `sendInputEvent`，不能用 `page.keyboard.press`**：
  //    实测（`release/verify/fnm-keylog2-probe.mjs`，真机探针）：
  //    · `page.keyboard.press(...)` = CDP `Input.dispatchKeyEvent`
  //      ⇒ **直接注入渲染进程** ⇒ **根本不触发** `before-input-event`
  //      ⇒ 我们的快捷键接缝**一次都不会执行** ⇒ 测出来的「没反应」是**假绿**；
  //    · `webContents.sendInputEvent(...)` = **主进程模拟真实按键**
  //      ⇒ 走完整输入管线 ⇒ `before-input-event` **确实触发**（探针里逐键记录过）。
  //    ⇒ 只有后者才真的走了一遍「按键 → 快捷键接缝 → 吞掉」这条路。
  //
  // ⚠️ **带一条对照组**：主进程**主动** `openDevTools()` ⇒ 必须能测到 `true`
  //    ⇒ 证明上面那些 `false` 是「真的没开」，而不是「量测方法失灵」。
  //
  // ⚠️ **为什么要问「所有窗口」而不是「主窗口」**：授权窗 / 悬浮窗 / 词岛
  //    也各自接了快捷键 ⇒ 任何一处能开出来都不算「去掉」。
  //
  // ⚠️ **E2E 跑的是开发构建**（`app.isPackaged === false` ⇒ `devTools: true`）
  //    ⇒ 这条验的是「**按键这条路**被吞掉了」；
  //    「打包后彻底关掉」由 `test/t82-shell-contract.test.ts` 钉声明。
  test('按 F12 / Ctrl+Shift+I：开发者工具**开不出来**', async () => {
    const devToolsOpened = async (): Promise<boolean[]> =>
      fixture.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((win) => win.webContents.isDevToolsOpened()),
      )

    /** 用主进程模拟一次真实按键（走完整输入管线）。 */
    const pressKey = async (
      keyCode: string,
      modifiers: Array<'control' | 'shift' | 'alt'> = [],
    ): Promise<void> => {
      await fixture.app.evaluate(
        ({ BrowserWindow }, payload) => {
          const target = BrowserWindow.getAllWindows()[0]?.webContents
          if (!target) throw new Error('找不到主窗口')
          target.sendInputEvent({ type: 'keyDown', keyCode: payload.keyCode, modifiers: payload.modifiers })
          target.sendInputEvent({ type: 'keyUp', keyCode: payload.keyCode, modifiers: payload.modifiers })
        },
        { keyCode, modifiers },
      )
      // ⚠️ 等一下「按键 → 接缝 → 开开发者工具」这条链走完。
      await fixture.window.waitForTimeout(600)
    }

    // 起点：**一个都没开**。
    expect(await devToolsOpened()).not.toContain(true)

    // --- F12 ---
    await pressKey('F12')
    expect(await devToolsOpened()).not.toContain(true)

    // --- Ctrl+Shift+I（Chromium 的另一个开发者工具快捷键）---
    await pressKey('I', ['control', 'shift'])
    expect(await devToolsOpened()).not.toContain(true)

    // --- 对照组：主进程**主动**开一次 ⇒ 必须测得到 ⇒ 量测方法有效 ----------
    await fixture.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.openDevTools()
    })
    await fixture.window.waitForTimeout(1500)
    expect(await devToolsOpened()).toContain(true)

    // --- 收尾：把对照组开的开发者工具关掉（别影响后面的用例）--------------
    await fixture.app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.closeDevTools()
    })
    await fixture.window.waitForTimeout(1000)
    expect(await devToolsOpened()).not.toContain(true)
  })

  // -------------------------------------------------------------------------
  // T82-b / T82-c：版本号 + 项目地址
  // -------------------------------------------------------------------------
  test('设置 →「关于」：版本号来自主进程，项目地址指向仓库', async () => {
    // 主进程的真实版本号（= `app.getVersion()`，与安装包 FileVersion 同源）。
    const mainVersion = await fixture.app.evaluate(({ app }) => app.getVersion())
    expect(mainVersion.length).toBeGreaterThan(0)

    await fixture.window.getByRole('button', { name: '设置', exact: true }).click()
    const settingsRegion = fixture.window.getByRole('region', { name: '设置' })
    await expect(settingsRegion).toBeVisible()
    await fixture.window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '关于', exact: true })
      .click()

    // 版本号：界面上的 == 主进程给的。
    await expect(fixture.window.getByTestId('app-about-version')).toHaveText(`v${mainVersion}`)

    // 项目地址：链接的 `href` 与文案都指向仓库。
    const repository = fixture.window.getByTestId('app-about-repository')
    await expect(repository).toHaveAttribute('href', REPOSITORY_URL)
    await expect(repository).toHaveText(REPOSITORY_URL)

    // ⚠️ **只断言、不点击**：点了会真的调 `shell.openExternal`
    //    → 在测试机上**拉起系统浏览器**（不可控）。
    //    「点击走 openExternal 而不是把窗口导航走」由单测钉住
    //    （`test/settings-page.test.tsx`：`preventDefault` + 请主进程打开）。

    await fixture.window.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(settingsRegion).toBeHidden()
  })

  // -------------------------------------------------------------------------
  // T82-d：自动更新源默认就是**项目地址**
  // -------------------------------------------------------------------------
  test('设置 →「更新」：当前版本可见，更新源默认指向项目 Releases', async () => {
    const mainVersion = await fixture.app.evaluate(({ app }) => app.getVersion())

    await fixture.window.getByRole('button', { name: '设置', exact: true }).click()
    const settingsRegion = fixture.window.getByRole('region', { name: '设置' })
    await expect(settingsRegion).toBeVisible()
    await fixture.window
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '更新', exact: true })
      .click()

    // 当前版本（与关于页同源）。
    await expect(fixture.window.getByTestId('update-current-version')).toContainText(
      `v${mainVersion}`,
    )

    // 「未签名更新包」开关**默认关**（本项目暂未办理代码签名证书）。
    await expect(fixture.window.getByTestId('update-allow-unsigned')).not.toBeChecked()

    // 更新源输入框：**空**（没配）⇒ 主进程会**回落项目地址**；
    // placeholder 就是那个项目地址。
    const input = fixture.window.locator('input[name="fnm-update-base-url"]')
    await expect(input).toHaveValue('')
    await expect(input).toHaveAttribute('placeholder', UPDATE_BASE_URL)

    // 一键填入项目地址。
    await fixture.window.getByTestId('update-use-project-source').click()
    await expect(input).toHaveValue(UPDATE_BASE_URL)

    await fixture.window.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(settingsRegion).toBeHidden()
  })
})
