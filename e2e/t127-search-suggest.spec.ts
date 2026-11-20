import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { createMockServer, type MockServer } from '../mock-server/server'

// ---------------------------------------------------------------------------
// T127：搜索建议区（`/search/suggest`）—— 真实 Electron
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这条用例必须是 E2E**：
//    建议这条链路跨了四层 —— 渲染层 `apiCall` → 主进程协议代理 → NAS 的
//    `/search/suggest` → 界面渲染。单测只能钉住每一层**自己**的行为
//    （见 `test/t127-search-suggest.test.tsx`），**拼起来的那条链**只有真机能验。
//
// ⚠️ **鉴别力（三条，缺一不可）**：
//    1. mock 的 `/search/suggest` 是**另一个端点** ⇒ 建议里的条目只可能来自它；
//    2. ⚠️ **建议区与完整搜索结果里有同名的歌**（mock 的 `/search/track` 也命中）
//       ⇒ 断言**必须限定在建议区容器内**，否则「出现了歌名」证明不了任何事；
//    3. **完整搜索结果照常出现** ⇒ 证明建议区是**增量**（没把既有行为顶掉）。
//
// ⚠️ **不断言「命中 N」**：suggest 的 `total` 恒为 5（是「给了几条」，
//    **不是**「总命中数」）⇒ 界面上不许出现「命中」字样。
// ---------------------------------------------------------------------------

test.describe.serial('T127：搜索建议区（真实 Electron）', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    mock = createMockServer()
    fixture = await launchApp({ mock })
  })

  test.afterAll(async () => {
    await fixture?.close()
    // ⚠️ mock 是**自建**的（`launchApp` 不负责关它）⇒ 得自己关。
    await mock?.close()
  })

  test('输入关键字 ⇒ 建议区出现（歌曲/专辑/歌手），且完整搜索结果照常显示', async () => {
    const window = fixture.window
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await login(window, fixture.mock.url)

    await window.getByRole('button', { name: '搜索', exact: true }).click()
    await window.getByLabel('搜索关键字').fill('示例')

    // --- 建议区出现 --------------------------------------------------------
    const suggest = window.getByTestId('sanlos-suggest-section')
    await expect(suggest).toBeVisible()

    // ⚠️ 鉴别力 2：断言**限定在建议区容器内**（完整结果里也有同名的歌）。
    await expect(suggest.getByTestId('sanlos-suggest-tracks')).toBeVisible()
    await expect(suggest.getByTestId('sanlos-suggest-tracks').getByText('示例曲目 1')).toBeVisible()
    await expect(suggest.getByTestId('sanlos-suggest-albums').getByText('示例专辑一')).toBeVisible()
    await expect(suggest.getByTestId('sanlos-suggest-artists').getByText('示例歌手甲')).toBeVisible()

    // ⚠️ 建议区**不许**出现「命中 N」（`total` 恒 5，不是命中总数）。
    await expect(suggest).not.toContainText('命中')

    // --- 鉴别力 3：完整搜索结果**照常**出现（建议是增量）-------------------
    const tracks = window.getByRole('listbox', { name: '搜索结果歌曲列表' })
    await expect(tracks).toBeVisible()
    await expect(tracks.getByRole('option').filter({ hasText: '示例曲目 1' }).first()).toBeVisible()
  })
})
