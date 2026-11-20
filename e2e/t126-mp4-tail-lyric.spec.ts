import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { createMockServer, type MockServer } from '../mock-server/server'
import { MP4_TAIL_LYRIC_LRC, MP4_TAIL_LYRIC_SONG, SONGS } from '../mock-server/fixtures'

// ---------------------------------------------------------------------------
// T126：MP4 / M4A 的 `moov` 在**文件尾** ⇒ 尾读文件尾 ⇒ 内嵌歌词照样拿得到
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这条用例必须是 E2E**：
//    这条链路跨了四层 —— 主进程**尾读**（`Range: bytes=-N`）→ 解析 `moov` →
//    IPC → 渲染层优先级链 → 界面如实显示来源。
//    单测只能钉住每一层**自己**的行为（见 `test/t126-mp4-tail-lyrics.test.ts`），
//    **拼起来的那条链**只有真机能验。
//
// ⚠️ **鉴别力（三条，缺一不可）**：
// 1. mock 给这首歌的流是一个「**`moov` 在文件尾**」的 MP4
//    （`mdat` > 64 KB ⇒ **头 64 KB 里没有 `moov`**）⇒ 歌词**只可能**来自尾读；
// 2. NAS 的歌词表里**故意没有**这首歌 ⇒ 歌词只可能来自**音频文件内嵌**；
// 3. 界面**如实显示**「歌词来源：音频内嵌」⇒ 没有装作是别的源。
//
// ⚠️ **不断言「能播」**：这个 MP4 的 `mdat` 是**占位字节**（不是真 AAC）
//    ⇒ Chromium 解不出来 ⇒ 「无法播放」是**预期的**
//    ⇒ 这条用例只验「歌词从内嵌层拿到了」，**不假装验过播放**。
//
// ⚠️ **共享 fixtures 一条不改**（T97 断言「随机挑了 8 首」）
//    ⇒ 这首歌**按实例注入**（`createMockServer({ songs: [...] })`）。
// ---------------------------------------------------------------------------

/** 内嵌歌词的两行（从夹具常量里切出来，避免写死两遍）。 */
const LINES = MP4_TAIL_LYRIC_LRC.split('\n').map((line) => line.replace(/^\[\d+:\d+[.:]?\d*\]/, ''))

test.describe.serial('T126：MP4 的 moov 在文件尾 ⇒ 尾读内嵌歌词（真实 Electron）', () => {
  let fixture: AppFixture
  /** 自建的 mock（**按实例注入**曲库 ⇒ 共享 fixtures 一条未改）。 */
  let mock: MockServer

  test.beforeAll(async () => {
    mock = createMockServer({ songs: [...SONGS, MP4_TAIL_LYRIC_SONG] })
    fixture = await launchApp({ mock })
  })

  test.afterAll(async () => {
    await fixture?.close()
    // ⚠️ mock 是**自建**的（`launchApp` 不负责关它）⇒ 得自己关。
    await mock?.close()
  })

  test('moov 在文件尾 ⇒ 尾读也能拿到内嵌歌词，并如实显示来源', async () => {
    const window = fixture.window
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await login(window, fixture.mock.url)

    await window.getByRole('button', { name: '歌曲', exact: true }).click()
    const list = window.getByRole('listbox', { name: '歌曲列表' })
    await expect(list).toBeVisible()

    // 播那首「`moov` 在文件尾」的歌 ⇒ 打开全屏歌词舞台。
    await list.getByRole('option').filter({ hasText: MP4_TAIL_LYRIC_SONG.title }).first().dblclick()
    await expect(window.locator('.sanlos-playerbar__title')).toHaveText(MP4_TAIL_LYRIC_SONG.title)
    await window.getByRole('button', { name: '全屏播放页', exact: true }).click()
    await expect(window.getByTestId('full-player')).toBeVisible()

    // --- 鉴别力 3：内嵌歌词的**两行**都在歌词舞台里 -------------------------
    const stage = window.getByTestId('full-player').locator('.sanlos-lyricview--all')
    await expect(stage).toBeVisible()
    await expect(stage.getByText(LINES[0]!, { exact: true })).toBeVisible()
    await expect(stage.getByText(LINES[1]!, { exact: true })).toBeVisible()

    // --- 来源**如实显示** ---------------------------------------------------
    await expect(window.getByText('歌词来源：音频内嵌')).toBeVisible()
  })
})
