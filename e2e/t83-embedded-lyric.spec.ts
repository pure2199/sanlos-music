import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { EMBEDDED_LYRIC_LRC, EMBEDDED_LYRIC_SONG_GUID, SONGS } from '../mock-server/fixtures'

// ---------------------------------------------------------------------------
// T83：音频内嵌歌词（**真实 Electron**）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这条用例必须是 E2E**：
//    内嵌歌词这条链路**跨了三层**——主进程读文件/取流 → IPC → 渲染层优先级链 →
//    界面如实显示来源。jsdom 里既没有 preload 的桥，也没有主进程 ⇒ 单测只能钉住
//    每一层**自己**的行为（见 `test/embedded-lyric*.test.ts`），
//    **拼起来的那条链**只有真机能验。
//
// ⚠️ **鉴别力（四条，缺一不可）**：
// 1. NAS 的歌词表里**故意没有**这首歌（`t2`）⇒ 歌词只可能来自**音频文件内嵌**；
// 2. **这歌真的能播**（没有媒体错误）—— 否则歌词那条链根本没机会跑；
// 3. 歌词的**两行内容**都出现在歌词舞台里（内容对得上，不是「有歌词就行」）；
// 4. 界面**如实显示**「歌词来源：音频内嵌」⇒ 没有装作是别的源。
//
// ⚠️ **对照组**：另一首**NAS 有歌词**的歌 ⇒ **不显示**「音频内嵌」
//    （证明这条标签不会到处乱挂）。
//
// ⚠️ 全程**不碰真实外网**：E2E 夹具预置 `lyric.source = 'off'`。
// ---------------------------------------------------------------------------

/** 那首「NAS 没有歌词、但音频文件内嵌了歌词」的歌。 */
const EMBEDDED_SONG = SONGS.find((song) => song.guid === EMBEDDED_LYRIC_SONG_GUID)!

/** 对照组：NAS 歌词表里**有**它的歌。 */
const NAS_SONG = SONGS.find((song) => song.guid === 't1')!

/** 内嵌歌词的两行（从夹具常量里切出来，避免写死两遍）。 */
const EMBEDDED_LINES = EMBEDDED_LYRIC_LRC.split('\n').map((line) => line.replace(/^\[\d+:\d+[.:]?\d*\]/, ''))

test.describe.serial('T83：音频内嵌歌词（真实 Electron）', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  /** 登录（可能已经登录了）→ 进歌曲列表。 */
  async function ensureLoggedIn(): Promise<void> {
    const window = fixture.window
    // ⚠️ 上一条用例可能**留着全屏播放页**（它盖住顶栏 ⇒ 点不到「歌曲」）。
    const close = window.getByRole('button', { name: '关闭全屏播放页', exact: true })
    if ((await close.count()) > 0) await close.click()
    const songsButton = window.getByRole('button', { name: '歌曲', exact: true })
    if ((await songsButton.count()) === 0) {
      await window.getByRole('button', { name: '连接', exact: true }).click()
      await expect(window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
      await login(window, fixture.mock.url)
    }
    await window.getByRole('button', { name: '歌曲', exact: true }).click()
    await expect(window.getByRole('listbox', { name: '歌曲列表' })).toBeVisible()
  }

  /** 播放指定那首 → 打开全屏歌词舞台。 */
  async function openStageWith(songTitle: string): Promise<void> {
    const window = fixture.window
    const list = window.getByRole('listbox', { name: '歌曲列表' })
    await list.getByRole('option').filter({ hasText: songTitle }).first().dblclick()
    await expect(window.locator('.fnm-playerbar__title')).toHaveText(songTitle)
    await window.getByRole('button', { name: '全屏播放页', exact: true }).click()
    await expect(window.getByTestId('full-player')).toBeVisible()
  }

  test('NAS 没有歌词 ⇒ 回落**音频内嵌**的歌词，并如实显示来源', async () => {
    const window = fixture.window
    await ensureLoggedIn()
    await openStageWith(EMBEDDED_SONG.title)

    // --- 鉴别力 2：这歌**真的能播** --------------------------------------------
    // ⚠️ 夹具的 WAV 必须**符合 RIFF 规范**（奇数长度的块要补齐）——
    //    否则 Chromium 读不到 `data` 块 ⇒ 直接报「当前内核不支持该格式」。
    await expect(window.getByText('该音频无法播放')).toHaveCount(0)

    const stage = window.getByTestId('full-player').locator('.fnm-lyricview--all')
    await expect(stage).toBeVisible()

    // --- 鉴别力 3：内嵌歌词的**两行**都在歌词舞台里 -------------------------
    await expect(stage.getByText(EMBEDDED_LINES[0]!, { exact: true })).toBeVisible()
    await expect(stage.getByText(EMBEDDED_LINES[1]!, { exact: true })).toBeVisible()

    // --- 鉴别力 4：来源**如实显示** ------------------------------------------
    await expect(window.getByText('歌词来源：音频内嵌')).toBeVisible()
  })

  test('对照组：NAS 有歌词的歌 ⇒ **不显示**「音频内嵌」', async () => {
    const window = fixture.window
    await ensureLoggedIn()
    await openStageWith(NAS_SONG.title)

    // ⚠️ NAS 的歌词在库里 ⇒ 走的是 NAS 那一层 ⇒ **不该**出现内嵌的标签。
    await expect(window.getByText('歌词来源：音频内嵌')).toHaveCount(0)
    await expect(window.getByTestId('full-player').locator('.fnm-lyricview--all')).toBeVisible()
  })
})
