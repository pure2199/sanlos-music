import { expect, test, type Locator, type Page } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'
import { LYRICS, SONGS } from '../mock-server/fixtures'

// ---------------------------------------------------------------------------
// T71：卡拉OK 渐进填色 —— 推广到所有歌词页面（**真实 Electron**）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这条用例必须是 E2E（而不是 Vitest + jsdom）**：
//    卡拉OK 的本质是「**颜色边界连续推进**」，由三件事决定：
//    ① 词级时间戳算出的填充比例（jsdom 能验）；
//    ② **CSS `background-clip: text` 真的把渐变裁进字形**（**jsdom 算不出**——
//      `getComputedStyle().backgroundClip` 在 jsdom 里恒为 `''`）；
//    ③ 渐变的**填充宽度**（`background-size`）真的跟着那个比例走。
//    只在 jsdom 验，等于**什么都没验**。
//
// ⚠️ **用 mock 的那首带词级时间戳的歌**（`t1` 是**增强型 LRC**：`<mm:ss.xx>` 逐字标签）
//    ⇒ 填充比例由**真实词级时间戳**决定，不是「按词数均分」的假逐字。
//    歌名 / 词文本 / 词时间**全部从 fixture 里解析**，不写死
//    ⇒ mock 改了数据，这条用例不会悄悄失效。
//
// ⚠️ 全程**不碰真实外网**：E2E 夹具预置 `lyric.source = 'off'`。
//
// ⚠️ **三处页面各验一遍**（词岛 / 经典悬浮窗 / 全屏歌词舞台）：
//    「推广到所有页面」这句话的验收，就是**三处都真的在按词级时间填色**。
// ---------------------------------------------------------------------------

/** 那首**带词级时间戳**的歌（增强型 LRC）。 */
const WORD_LEVEL_SONG = SONGS.find(
  (song) => (LYRICS.get(song.guid)?.content ?? '').includes('<00:'),
)!

/** fixture 里真正的歌词行（过滤掉 `[ti:]` / `[ar:]` 这类元信息标签）。 */
const FIXTURE_LINES = (LYRICS.get(WORD_LEVEL_SONG.guid)?.content ?? '')
  .split(/\r?\n/)
  .filter((line) => /^\[\d+:\d+/.test(line))

/** 一个词（文本 + 起止秒）。 */
interface FixtureWord {
  text: string
  start: number
  end: number
}

/** 取第 index 行的词级时间轴（`start` / `end` 都从逐字标签里解析出来）。 */
function wordsOfLine(index: number): FixtureWord[] {
  const line = FIXTURE_LINES[index] ?? ''
  const tags = [...line.matchAll(/<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g)]
  const seconds = (match: RegExpMatchArray): number => Number(match[1]) * 60 + Number(match[2])
  return tags.map((match, position) => {
    const next = tags[position + 1]
    const start = seconds(match)
    return { text: match[3] ?? '', start, end: next ? seconds(next) : start + 0.5 }
  })
}

/**
 * 目标播放位置：**落在目标词中间**，且落在滑块的 0.1 秒网格上。
 *
 * ⚠️ **为什么不是行首**：行首时比例恰好是 0%，而「0%」和「没在填色」
 *    在数据上**长得一样**（都是 0）⇒ 断言没有鉴别力。
 * ⚠️ **为什么必须是 0.1 的整数倍**：进度条 `step = 0.1` ⇒ 浏览器会把值
 *    **吸附到网格**上（10.25 会被吸成 10.2）⇒ 取值必须落在网格上。
 */
const TARGET_SECONDS = 10.2

/** 记住引擎那个**没挂进 DOM** 的 `<audio>` 元素。 */
async function captureMediaElement(window: Page): Promise<void> {
  await window.evaluate(() => {
    const proto = HTMLMediaElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'currentTime')
    if (!descriptor?.get || !descriptor.set) throw new Error('currentTime 不是可劫持的 accessor')
    const scope = window as unknown as { __fnmMedia?: HTMLMediaElement }
    Object.defineProperty(proto, 'currentTime', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(this: HTMLMediaElement): number {
        scope.__fnmMedia = this
        return descriptor.get!.call(this)
      },
      set(this: HTMLMediaElement, value: number): void {
        scope.__fnmMedia = this
        descriptor.set!.call(this, value)
      },
    })
  })
}

/** 媒体元素的**真实**播放位置（秒）。 */
async function mediaPosition(window: Page): Promise<number> {
  const value = await window.evaluate(() => {
    const scope = window as unknown as { __fnmMedia?: HTMLMediaElement }
    return scope.__fnmMedia?.currentTime ?? Number.NaN
  })
  expect(Number.isFinite(value)).toBe(true)
  return value
}

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

/** 打开设置页并切到「歌词」分类。 */
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

/** 一个歌词面板里「当前正在填色的那个词」。 */
interface KaraokeWord {
  /** 面板里正在填色的词的**数量**（必须恰好 1 个）。 */
  count: number
  /** 词的文本。 */
  text: string
  /** 词内填色比例（0~100）。 */
  percent: number
  /** 词在**行内**的下标（`data-word`）。 */
  wordIndex: number
  /** 词所在的**歌词行**的绝对下标（`data-index`）。 */
  lineIndex: number
  /** CSS 是不是真的把渐变裁进字形（`background-clip: text`）。 */
  clip: string
  /** CSS 的填充宽度（`background-size`）。 */
  size: string
}

/**
 * 读一个歌词面板里**正在填色的那个词**（**一次 `evaluate` 取全部字段**）。
 *
 * ⚠️ **为什么必须一次读完**：词岛**播放中**时填色比例一直在变 ⇒ 分两次读
 *    （先读 `data-karaoke-progress`、再读 `getComputedStyle`）拿到的是
 *    **两个时刻**的值 ⇒ 断言「CSS 宽度 == 比例」会**假红**
 *    （实测差 7.4 个百分点：16.7% vs 24.1%）。
 *    ⇒ 一次同步 `evaluate` ⇒ 同一个瞬间的快照。
 */
async function snapshotKaraoke(panel: Locator): Promise<KaraokeWord> {
  return panel.evaluate((root) => {
    const words = root.querySelectorAll('.fnm-lyricview__word--karaoke')
    const word = words.length === 1 ? words[0]! : null
    const line = word ? word.closest('[data-index]') : null
    const computed = word ? getComputedStyle(word) : null
    return {
      count: words.length,
      text: word?.textContent ?? '',
      percent: word ? Number(word.getAttribute('data-karaoke-progress')) : Number.NaN,
      wordIndex: word ? Number(word.getAttribute('data-word')) : -1,
      lineIndex: line ? Number(line.getAttribute('data-index')) : -1,
      clip: computed?.backgroundClip ?? '',
      size: computed?.backgroundSize ?? '',
    }
  })
}

/** 读那个**唯一**正在填色的词；数量不对就抛错（消息说清现场）。 */
async function readKaraokeWord(panel: Locator): Promise<KaraokeWord> {
  const snapshot = await snapshotKaraoke(panel)
  if (snapshot.count !== 1) {
    throw new Error(`面板里正在填色的词有 ${snapshot.count} 个（应为 1）`)
  }
  return snapshot
}

/**
 * 这个词**隐含**的播放位置（秒）。
 *
 * `implied = 词起点 + (比例/100) × 词长` ⇒ 拿它跟媒体元素的真实位置比，
 * 就知道填色比例是不是**真的**由词级时间戳算出来的。
 */
function impliedPosition(karaoke: KaraokeWord): number {
  const word = wordsOfLine(karaoke.lineIndex)[karaoke.wordIndex]
  if (!word) throw new Error(`fixture 里没有第 ${karaoke.lineIndex} 行`)
  return word.start + (karaoke.percent / 100) * (word.end - word.start)
}

/**
 * 断言「**一个歌词面板**正在做真·卡拉OK」（**位置确定**的场景）。
 *
 * ⚠️ **鉴别力（三条，缺一不可）**：
 *
 * 1. **比例反推的位置 ≈ 媒体元素的真实位置**：
 *    `implied = 词起点 + (比例/100) × 词长` ⇒ 必须与 `audio.currentTime` 相符
 *    （容差 120ms：seek 期间 Chromium 会先报一个**中间位置**，
 *      store 因此会比媒体元素慢约 50ms ⇒ 不能要求严丝合缝）。
 *    ⇒ 只有**按词级时间戳**算比例才会对上；
 *    若退化成「按词数均分 / 按行时长推算」，反推出来的位置会**差一大截** ⇒ 必红。
 *
 * 2. **比例 ≈ 按词级时间戳算出来的期望值**：
 *    期望比例 = `(真实位置 - 词起点) / 词长` ⇒ 与实测比例的偏差 ≤ 15%
 *    （15% ≈ 半个词；「按词数均分」的退化实现会差 20% ⇒ 必红）。
 *
 * 3. **CSS 真的按这个比例裁切**：`background-clip: text`（渐变裁进字形）
 *    且 `background-size` 的宽度就是这个百分比（CSS 变量接对了）。
 *    ⇒ jsdom 验不了这一条（`backgroundClip` 恒为 `''`）。
 */
async function expectRealKaraoke(panel: Locator, window: Page): Promise<void> {
  const karaoke = await readKaraokeWord(panel)

  // 当前词就是词级时间轴上**当前正在唱**的那一个。
  const fixtureWord = wordsOfLine(karaoke.lineIndex)[karaoke.wordIndex]
  expect(fixtureWord).toBeTruthy()
  expect(karaoke.text).toBe(fixtureWord!.text)

  // 确实在词**中间**（不是 0%、也不是 100%）。
  expect(karaoke.percent).toBeGreaterThan(5)
  expect(karaoke.percent).toBeLessThan(95)

  // --- 鉴别力 1：比例反推的位置 ≈ 媒体元素真实位置 --------------------------
  const media = await mediaPosition(window)
  expect(Math.abs(impliedPosition(karaoke) - media)).toBeLessThan(0.12)

  // --- 鉴别力 2：比例 ≈ 按词级时间戳算出来的期望值 --------------------------
  const expected = ((media - fixtureWord!.start) / (fixtureWord!.end - fixtureWord!.start)) * 100
  expect(Math.abs(karaoke.percent - expected)).toBeLessThan(15)

  // --- 鉴别力 3：CSS 真的按这个比例裁切（真实浏览器才有） ------------------
  expect(karaoke.clip).toBe('text')
  expect(karaoke.size).toMatch(/^(\d+(\.\d+)?)% 100%$/)
  expect(Number.parseFloat(karaoke.size)).toBeCloseTo(karaoke.percent, 1)
}

/**
 * 断言「**一个歌词面板**正在做真·卡拉OK」（**位置在动**的场景）。
 *
 * ⚠️ **为什么容差松一些**：词岛只在**播放中**出现（T69），此时位置一直在动 ⇒
 *    面板里的位置是「最近一次进度采样 + 本地外推」，与媒体元素真实位置之间
 *    有采样间隔（~250ms）级别的偏差 ⇒ 容差 250ms。
 *    ⇒ 「按词数均分」的退化实现（偏差 ≥ 100ms）在这里**抓不住**——
 *    所以这条断言的鉴别力由**全屏舞台 / 经典悬浮窗**那两条（位置确定）承担；
 *    这里验的是「**词岛也是同一套机制**」（有 karaoke 词 + CSS 真裁切 + 位置跟得上）。
 */
async function expectKaraokeTracksAudio(panel: Locator, window: Page): Promise<void> {
  // --- 位置跟得上音频 ------------------------------------------------------
  await expect
    .poll(
      async () => {
        const snapshot = await snapshotKaraoke(panel)
        if (snapshot.count !== 1) return Number.POSITIVE_INFINITY
        if (!Number.isFinite(snapshot.percent)) return Number.POSITIVE_INFINITY
        if (snapshot.percent <= 5 || snapshot.percent >= 95) return Number.POSITIVE_INFINITY
        return Math.abs(impliedPosition(snapshot) - (await mediaPosition(window)))
      },
      { timeout: 20000, intervals: [250] },
    )
    .toBeLessThan(0.25)

  // --- CSS 真裁切（jsdom 验不了的那一条）——**同一份快照**里比，别跨时刻 ---
  await expect
    .poll(
      async () => {
        const snapshot = await snapshotKaraoke(panel)
        if (snapshot.count !== 1) return false
        if (snapshot.clip !== 'text') return false
        if (!/^(\d+(\.\d+)?)% 100%$/.test(snapshot.size)) return false
        return Math.abs(Number.parseFloat(snapshot.size) - snapshot.percent) <= 0.05
      },
      { timeout: 20000, intervals: [250] },
    )
    .toBe(true)
}
// ---------------------------------------------------------------------------

test.describe.serial('T71：卡拉OK —— 所有歌词页面一致（真实 Electron）', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  test('全屏歌词舞台：当前词按**词级时间**连续填色（真·卡拉OK）', async () => {
    const window = fixture.window

    // ⚠️ T38：未登录时主区**默认**是本地音乐页 ⇒ 地址框**不在屏幕上**；
    //    先点顶栏的「连接」进登录页。
    await window.getByRole('button', { name: '连接', exact: true }).click()
    await expect(window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
    await login(window, fixture.mock.url)

    await window.getByRole('button', { name: '歌曲', exact: true }).click()
    const list = window.getByRole('listbox', { name: '歌曲列表' })
    await expect(list).toBeVisible()

    // 播那首带**词级时间戳**的歌。
    await list.getByRole('option').filter({ hasText: WORD_LEVEL_SONG.title }).first().dblclick()
    await expect(window.locator('.fnm-playerbar__title')).toHaveText(WORD_LEVEL_SONG.title)

    // 先记住引擎那个媒体元素（后面要用它的**真实**位置）。
    await captureMediaElement(window)

    // --- 暂停 + 精确定位：位置冻结 ⇒ 断言才可复现 ---------------------------
    await window.getByRole('button', { name: '暂停', exact: true }).click()
    await expect(window.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await seekTo(window, TARGET_SECONDS)

    // --- 开全屏页（歌词舞台）--------------------------------------------------
    await window.getByRole('button', { name: '全屏播放页', exact: true }).click()
    const stage = window.getByTestId('full-player').locator('.fnm-lyricview--all')
    await expect(stage).toBeVisible()

    await expectRealKaraoke(stage, window)
  })

  test('经典悬浮窗：同样按**词级时间**连续填色', async () => {
    const window = fixture.window

    // ⚠️ 全屏页是**浮层**（盖住顶栏）⇒ 先关掉，否则点不到「设置」。
    const fullPlayer = window.getByTestId('full-player')
    if ((await fullPlayer.count()) > 0) {
      await window.getByRole('button', { name: '关闭全屏播放页', exact: true }).click()
      await expect(fullPlayer).toHaveCount(0)
    }

    // --- 经典悬浮窗 ----------------------------------------------------------
    // ⚠️ **顺序**：先切形态、再打开「显示悬浮歌词」——
    //    打开开关会让主窗口**重推**一次「曲目 + 歌词」+ 一次「进度」⇒ 新窗口拿得到。
    await openLyricSettings(window)
    await window.getByRole('radio', { name: '经典悬浮窗', exact: true }).click()
    const checkbox = window.getByRole('checkbox', { name: /显示悬浮歌词/ })
    if (!(await checkbox.isChecked())) await checkbox.click()
    await window.getByRole('button', { name: '关闭设置', exact: true }).click()

    // 等经典窗（`lyric.html`）出现。
    let classic: Page | null = null
    for (let attempt = 0; attempt < 40 && !classic; attempt += 1) {
      classic = fixture.app.windows().find((page) => page.url().endsWith('lyric.html')) ?? null
      if (!classic) await window.waitForTimeout(250)
    }
    expect(classic).not.toBeNull()

    // ⚠️ **T71 真机补丁的验收点**：新建的窗口会收到主进程**补发的两条**
    //    （曲目 + 歌词 **和** 播放位置）⇒ 位置不是 0 ⇒ 当前词在**被渲染的行里**。
    //    （补丁前：只有「曲目 + 歌词」⇒ 位置停在 0 ⇒ `--karaoke` 数量 = 0。）
    // ⚠️ **T79**：经典浮窗用 `mode="current"`（当前句 / 下一句）⇒ 定位器跟着换。
    //    **断言强度不变**：仍然验「卡拉OK 填色真的跟着音频走」。
    await expectRealKaraoke(classic!.locator('.fnm-lyricview--current'), window)
  })

  test('灵动态词岛：同样按**词级时间**连续填色', async () => {
    const window = fixture.window

    // ⚠️ 词岛只在**播放中**出现（T69：暂停 ⇒ 收起）⇒ 先恢复播放。
    await window.getByRole('button', { name: '播放', exact: true }).click()
    await expect(window.getByRole('button', { name: '暂停', exact: true })).toBeVisible()

    await openLyricSettings(window)
    await window.getByRole('radio', { name: '灵动态词岛', exact: true }).click()
    await window.getByRole('button', { name: '关闭设置', exact: true }).click()

    let island: Page | null = null
    for (let attempt = 0; attempt < 40 && !island; attempt += 1) {
      island = fixture.app.windows().find((page) => page.url().endsWith('island.html')) ?? null
      if (!island) await window.waitForTimeout(250)
    }
    expect(island).not.toBeNull()

    await expectKaraokeTracksAudio(island!.locator('.fnm-lyricview--single'), window)
  })
})
