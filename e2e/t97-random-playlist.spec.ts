// ---------------------------------------------------------------------------
// T97：「随机 20 首」组歌单 —— E2E（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// 覆盖**只有真实 Electron 才跑得通**的那条链路：
//   登录（主进程 IPC → HTTP → mock NAS）
//     → 歌单页 → 抽样（`fnm://` 协议代理 → mock 的 `/track/list` 分页）
//       → 列出这一批 →「播放全部」（走既有播放路径）
//         →「存为歌单」（`playlist/create` + `playlist/add-track`）
//           → **歌单列表里真的多了一个歌单**
//
// ⚠️ **mock 曲库只有 8 首** ⇒ 随机歌单给 **8** 首（= `min(20, 8)`）
//    ⇒ 顺手覆盖「库里不够就**如实少给**」那条路径。
// ⚠️ E2E **不打真实外网**（全部走 mock）。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'

test.describe.serial('T97「随机 20 首」组一个歌单', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, fixture.mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  /**
   * 打开「随机歌单」视图（左栏入口按钮）。
   *
   * ⚠️ **幂等**：存回成功后面板**不自动关闭**（提示要留在屏幕上）⇒
   *    下一条用例开始时面板可能已经开着 ⇒ 这时不能再点一次（那是「关闭」）。
   */
  async function openPanel(): Promise<void> {
    const panel = fixture.window.locator('.fnm-random')
    if ((await panel.count()) === 0) {
      await fixture.window.locator('.fnm-playlists__random-button').click()
    }
    await expect(panel).toBeVisible()
  }

  /** 点面板里的主按钮（第一次是「随机 20 首」，之后是「换一批」）。 */
  async function pressPrimary(): Promise<void> {
    await fixture.window.locator('.fnm-random__actions button').first().click()
  }

  test('随机一批 ⇒ 能播 ⇒ 能存回 NAS（歌单列表里真的多了一个）', async () => {
    // ⚠️ 「随机 20 首」入口在**歌单页左栏**。
    await fixture.window.getByRole('button', { name: '歌单', exact: true }).click()
    await openPanel()
    await pressPrimary()

    // ⚠️ mock 曲库 8 首 ⇒ **如实少给** 8 首（不是硬凑 20）。
    await expect(fixture.window.getByText('从你的曲库随机挑了 8 首')).toBeVisible()

    // 列表里真的有歌（mock 的占位曲目）。
    await expect(fixture.window.getByText(/示例曲目 \d/).first()).toBeVisible()

    // 「播放全部」⇒ 走既有播放路径（播放条出现真歌名）。
    await fixture.window.getByRole('button', { name: '播放全部' }).click()
    await expect(fixture.window.locator('.fnm-playerbar__title')).toHaveText(/示例曲目 \d/)

    // 「存为歌单」⇒ 真的建了一个歌单（**成功提示**如实出现）。
    await fixture.window.getByRole('button', { name: '存为歌单' }).click()
    await expect(fixture.window.getByText(/歌单「随机歌单 .*」已保存（8 首）/)).toBeVisible()

    // ⇒ 存完回到歌单视图，**左栏里真的多了一个歌单**。
    await expect(fixture.window.getByText(/^随机歌单 /).first()).toBeVisible()
  })

  test('歌单名**超过 32 个字符** ⇒ **本地就拦住**（不去撞服务端的 32 字符上限）', async () => {
    // ⚠️ 服务端实测（2026-11-16，真实 NAS）：`/playlist/create` 的 `name`
    //    **超过 32 个字符就被拒**（`code=100002` / `invalid arguments`）——
    //    边界 **32 OK / 33 拒**（按**字符数**算，不是字节数）。
    //    ⇒ 客户端**自己先拦**，用户看到的是中文提示，不是英文报错。
    await openPanel()
    await pressPrimary()
    await expect(fixture.window.getByText('从你的曲库随机挑了 8 首')).toBeVisible()

    await fixture.window.getByLabel('随机歌单名称').fill('x'.repeat(33))
    await expect(fixture.window.getByText('歌单名不能超过 32 个字符（现在 33 个）')).toBeVisible()
    await expect(fixture.window.getByRole('button', { name: '存为歌单' })).toBeDisabled()
  })

  test('「换一批」⇒ 重新抽样（面板仍给 8 首、列表仍在）', async () => {
    await openPanel()
    await pressPrimary()
    await expect(fixture.window.getByText('从你的曲库随机挑了 8 首')).toBeVisible()

    await fixture.window.getByRole('button', { name: '换一批' }).click()
    await expect(fixture.window.getByText('从你的曲库随机挑了 8 首')).toBeVisible()

    // ⚠️ mock 只有 8 首 ⇒ 换批后**集合**必然还是这 8 首（顺序会变，但断言顺序会 flaky）
    //    ⇒ 这里只断言「列表还在、行数对」；「换一批真的重新抽样」由组件测试
    //    （抽样调用次数 +1）钉住。
    await expect(fixture.window.locator('.fnm-songlist__row')).toHaveCount(8)
  })
})
