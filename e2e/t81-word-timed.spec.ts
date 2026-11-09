import { expect, test, type Locator, type Page } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { LYRICS, SONGS } from '../mock-server/fixtures'

// ---------------------------------------------------------------------------
// T81：真逐字才卡拉OK，否则整行显示（**真实 Electron**）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这条用例必须是 E2E（而不是 Vitest + jsdom）**：
//    本任务承诺的是**观感** —— 「只有行级时间戳的歌词**不假装逐字**，当前行**整行**强调色」。
//    其中「整行强调色」是**纯 CSS 的事**（`.fnm-lyricview__line--whole { color: var(--accent) }`）
//    ⇒ jsdom 的 `getComputedStyle` **恒为空** ⇒ 单测只能钉**声明**（CSS 契约），
//    钉不到「**真的**渲染成那个颜色」。
//    ⇒ 这里在**真实 Chromium** 里比对「当前行的实际颜色」与「`--accent` 的实际颜色」。
//
// ⚠️ **鉴别力（三条，缺一不可）**：
//
// 1. **零**词级元素（`[data-word]` / `--karaoke` / `--overlay` 都不存在）
//    ⇒ 伪逐字**不可能**再出现假扫光；
// 2. 当前行有 `--whole`，**非**当前行没有；
// 3. 当前行的**实际颜色** == `--accent` 的**实际颜色**（⇒ CSS 真的生效，且两套主题都一致）。
//
// ⚠️ **对照组**：同一支 fixture 里另有一首**真逐字**的歌 ⇒ 卡拉OK **照旧**
//    （证明本次改动没有把真逐字一起干掉）。
//
// ⚠️ 全程**不碰真实外网**：E2E 夹具预置 `lyric.source = 'off'`。
// ---------------------------------------------------------------------------

/**
 * 那首**只有行级时间戳**的歌（普通 LRC ⇒ 走伪逐字）。
 *
 * ⚠️ **必须排除带词级标签的那首**（它也有 `[00:05.00]`）⇒ 判据是「**没有** `<00:`」。
 */
const PLAIN_SONG = SONGS.find((song) => {
  const content = LYRICS.get(song.guid)?.content ?? ''
  return content.includes('[00:05.00]') && !content.includes('<00:')
})!

/** 那首**带词级时间戳**的歌（增强型 LRC ⇒ 走真逐字）。 */
const WORD_LEVEL_SONG = SONGS.find(
  (song) => (LYRICS.get(song.guid)?.content ?? '').includes('<00:'),
)!

/**
 * 目标播放位置：落在**第二行**（`[00:05.00]`）中间。
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

/**
 * 读一个歌词面板的「整行强调色」状态。
 *
 * ⚠️ **为什么用探针元素**去取 `--accent` 的**实际颜色**：
 *    `--accent` 在两套主题里是**不同的值** ⇒ 写死某个色值等于没有断言。
 *    ⇒ 造一个临时 `div`（`color: var(--accent)`）⇒ 读它的 `getComputedStyle().color`
 *    ⇒ 拿它跟当前行的实际颜色**逐字比**。
 */
async function snapshotWholeLine(panel: Locator): Promise<{
  wholeCount: number
  wordCount: number
  karaokeCount: number
  overlayCount: number
  lineColor: string
  accentColor: string
  wholeIndexes: string[]
  otherIndexes: string[]
}> {
  return panel.evaluate((root) => {
    const lines = Array.from(root.querySelectorAll('[data-index]'))
    const whole = lines.filter((line) => line.className.includes('fnm-lyricview__line--whole'))
    const others = lines.filter((line) => !line.className.includes('fnm-lyricview__line--whole'))
    const probe = document.createElement('div')
    probe.style.color = 'var(--accent)'
    document.body.appendChild(probe)
    const accentColor = getComputedStyle(probe).color
    probe.remove()
    return {
      wholeCount: whole.length,
      wordCount: root.querySelectorAll('[data-word]').length,
      karaokeCount: root.querySelectorAll('.fnm-lyricview__word--karaoke').length,
      overlayCount: root.querySelectorAll('.fnm-lyricview__overlay').length,
      lineColor: whole[0] ? getComputedStyle(whole[0]).color : '',
      accentColor,
      wholeIndexes: whole.map((line) => line.getAttribute('data-index') ?? ''),
      otherIndexes: others.map((line) => line.getAttribute('data-index') ?? ''),
    }
  })
}

test.describe.serial('T81：真逐字才卡拉OK，否则整行显示（真实 Electron）', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  /** 登录 → 歌曲列表 → 播放指定那首 → 暂停 + 定位 → 开全屏歌词舞台。 */
  async function openStageWith(songTitle: string): Promise<Locator> {
    const window = fixture.window

    // ⚠️ **可能已经登录**（上一条用例登录过了）⇒ 判据用「**曲库导航在不在**」：
    //    未登录时整个曲库导航**整组不渲染**（见 `app-guest-nav` 的既有约定），
    //    「歌曲」按钮也就**不存在** ⇒ 用它当「要不要登录」的判据。
    const songsButton = window.getByRole('button', { name: '歌曲', exact: true })
    if ((await songsButton.count()) === 0) {
      // ⚠️ T38：未登录时主区**默认**是本地音乐页 ⇒ 先点顶栏的「连接」进登录页。
      await window.getByRole('button', { name: '连接', exact: true }).click()
      await expect(window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
      await login(window, fixture.mock.url)
    }

    await window.getByRole('button', { name: '歌曲', exact: true }).click()
    const list = window.getByRole('listbox', { name: '歌曲列表' })
    await expect(list).toBeVisible()

    await list.getByRole('option').filter({ hasText: songTitle }).first().dblclick()
    await expect(window.locator('.fnm-playerbar__title')).toHaveText(songTitle)

    // --- 暂停 + 精确定位：位置冻结 ⇒ 断言才可复现 ---------------------------
    await window.getByRole('button', { name: '暂停', exact: true }).click()
    await expect(window.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await seekTo(window, TARGET_SECONDS)

    await window.getByRole('button', { name: '全屏播放页', exact: true }).click()
    const stage = window.getByTestId('full-player').locator('.fnm-lyricview--all')
    await expect(stage).toBeVisible()
    return stage
  }

  test('**行级**歌词 ⇒ **零**词级元素，当前行**整行**强调色（不假装逐字）', async () => {
    const stage = await openStageWith(PLAIN_SONG.title)

    const snapshot = await snapshotWholeLine(stage)

    // --- 鉴别力 1：零词级元素 ⇒ 假扫光不可能出现 ---------------------------
    expect(snapshot.wordCount).toBe(0)
    expect(snapshot.karaokeCount).toBe(0)
    expect(snapshot.overlayCount).toBe(0)

    // --- 鉴别力 2：当前行有 `--whole`，非当前行没有 -------------------------
    expect(snapshot.wholeCount).toBe(1)
    expect(snapshot.wholeIndexes).toEqual(['1'])
    expect(snapshot.otherIndexes.length).toBeGreaterThan(0)
    expect(snapshot.otherIndexes).not.toContain('1')

    // --- 鉴别力 3：当前行的**实际颜色** == `--accent` 的实际颜色 -------------
    // ⚠️ 这一条 jsdom 验不了（`getComputedStyle` 恒为空）⇒ 必须真实 Chromium。
    expect(snapshot.lineColor).not.toBe('')
    expect(snapshot.lineColor).toBe(snapshot.accentColor)
  })

  test('对照：**真逐字**歌词 ⇒ 卡拉OK **照旧**（没有被一起干掉）', async () => {
    const window = fixture.window

    // 关掉上一条留下的全屏浮层（它盖住顶栏）。
    const fullPlayer = window.getByTestId('full-player')
    if ((await fullPlayer.count()) > 0) {
      await window.getByRole('button', { name: '关闭全屏播放页', exact: true }).click()
      await expect(fullPlayer).toHaveCount(0)
    }

    const stage = await openStageWith(WORD_LEVEL_SONG.title)

    // ⚠️ 真逐字 ⇒ 逐字元素**在**，卡拉OK **在**。
    expect(await stage.locator('[data-word]').count()).toBeGreaterThan(0)
    // ⚠️ 真逐字**不走**整行强调色那条路（两套机制互斥）。
    const snapshot = await snapshotWholeLine(stage)
    expect(snapshot.wholeCount).toBe(0)
  })
})
