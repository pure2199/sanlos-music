// ---------------------------------------------------------------------------
// T99：同名专辑按**作品目录**归并 + 集号在**中段**的标题 —— E2E
// ---------------------------------------------------------------------------
//
// ⚠️ 这条用例覆盖 T98 v3 真机复验抓到的**两个真问题**：
//   ① 《极品家丁》1333 集的标题里**集号在中段**（`极品家丁 0001 公子，公子`）
//      ⇒ 现有 7 条规则都要求集号在开头 / 结尾纯数字 ⇒ 解析率 1.1% ⇒ **排不了序**；
//   ② 《让青春继续第一季》被 NAS **拆成两张同名专辑**（31 集 + 1 集）
//      ⇒ 列表出现**两条同名**，而且**第 02 集丢了**（用户少看到一集）。
//
// ⚠️ **mock 的形态按真机实测仿**（2026-11-16，本机 + 该账号）：
//   - 两张专辑**同名**（`示例合并作品`）、**同作品目录**（`path` 倒数第 3 段）
//     —— 这正是服务端「把一部作品拆开」的形态；
//   - 标题形态 = 「**作品名 + 空格 + 2 位数字 + 章节名**」⇒ 集号在**中段**
//     （⇒ 走 T99 新增的 `mid-number` 规则）；
//   - ⚠️ 章节名里**不能**出现「第N章 / 第N集」⇒ 那会命中更具体的 `episode-cn` 规则，
//     就测不到 `mid-number` 了。
//
// ⚠️ **共享 fixtures 一条不改**（T97 断言「随机挑了 8 首」、T98 断言 12 集）
//    ⇒ 这里的 13 集**只在本实例**注入（`createMockServer({ songs, albums })`）。
//
// ⚠️ **顺序故意打乱**（第 1 首是第 12 集）⇒ 排序是**客户端自己**做的
//    ⇒ 若 mock 按集号顺序返回，**排序失效也照样通过** ⇒ 这条用例就是假阳性。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import { ALBUMS, SONGS, type RawAlbum, type RawSong } from '../mock-server/fixtures'
import { createMockServer, type MockServer } from '../mock-server/server'
import { launchApp, login, type AppFixture } from './helpers/app'
import { collectSongListRows } from './helpers/song-list'

/** 合并后的作品名（两张专辑**同名**）。 */
const WORK_NAME = '示例合并作品'
/** 作品目录（`path` 倒数第 3 段）—— 两张专辑**共用** ⇒ 归并键相同。 */
const WORK_DIR = WORK_NAME
/** 目录关键字要命中的那一段。 */
const FOLDER = '有声小说'
/** 主专辑的 guid（**集数多**的那张 ⇒ 归并后它是「主专辑」）。 */
const MAIN_ALBUM_GUID = 'al-merge-main'
/** 被拆出去的那张（只含**第 02 集** —— 正是「丢的那一集」）。 */
const SPLIT_ALBUM_GUID = 'al-merge-split'

/** 各集的章节名（**不含「第N章 / 第N集」** ⇒ 不会命中更具体的规则）。 */
const CHAPTERS = [
  '开篇',
  '承上',
  '启下',
  '风云初起',
  '江湖路远',
  '恩怨难了',
  '情深似海',
  '风雨飘摇',
  '山河变色',
  '天地开阔',
  '此情可待',
  '终章',
]

/** 两位的集号（`01`–`13`）。 */
function label(episode: number): string {
  return String(episode).padStart(2, '0')
}

/** 造一条曲目（`albumGuid` 决定它属于哪张专辑）。 */
function mergeSong(episode: number, albumGuid: string): RawSong {
  const ep = label(episode)
  const chapter = CHAPTERS[(episode - 1) % CHAPTERS.length] ?? '某集'
  return {
    guid: `mg-${albumGuid}-${ep}`,
    title: `${WORK_NAME} ${ep} ${chapter}`,
    // 25 分钟（毫秒）⇒ 均长 1500 秒（真·有声实测 9–32 分钟）。
    duration: 1500000,
    coverId: null,
    artists: [
      { guid: 'a-merge', name: '示例作者', coverId: null, createdAt: 1792563278 },
    ],
    album: {
      guid: albumGuid,
      name: WORK_NAME,
      coverId: null,
      releaseDate: null,
      barcode: null,
      createdAt: 1792563278,
    },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 128000,
      codec: 'mp3',
      container: '',
      duration: 1500000,
      format: 'mp3',
      // ⚠️ 倒数第 3 段 = **作品目录** ⇒ 两张专辑的作品目录**相同** ⇒ 归并键相同。
      path: `/vol02/1000-0-3d135437/${FOLDER}/示例作者/${WORK_DIR}/Disc 01/${WORK_NAME} ${ep} ${chapter}.mp3`,
      size: 24000000,
    },
    year: null,
    trackNo: null,
    discNo: 1,
    isrc: null,
    isCue: false,
    createdAt: 1792563278,
    updatedAt: 1792563278,
    genres: [],
    isFavorite: false,
  }
}

/** 主专辑的 12 集（**不含第 02 集** —— 那一集被拆到另一张专辑去了）。 */
const MAIN_EPISODES = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
/** ⚠️ **故意打乱**（倒序 ⇒ 第 1 首是第 13 集）⇒ 排对了才是真的排对了。 */
const SHUFFLED_MAIN_EPISODES = [...MAIN_EPISODES].reverse()

/** 主专辑（12 集）。 */
const MAIN_ALBUM: RawAlbum = {
  guid: MAIN_ALBUM_GUID,
  name: WORK_NAME,
  coverId: null,
  releaseDate: null,
  barcode: null,
  createdAt: 1792563278,
  updatedAt: 1792563278,
  artists: [{ guid: 'a-merge', name: '示例作者', coverId: null, createdAt: 1792563278 }],
  trackCount: 12,
}

/** 被拆出去的那张（**同名**，只有第 02 集）。 */
const SPLIT_ALBUM: RawAlbum = {
  ...MAIN_ALBUM,
  guid: SPLIT_ALBUM_GUID,
  trackCount: 1,
}

/** 本实例的曲库：共享的 8 首 + 合并用的 13 集。 */
const MERGE_SONGS: RawSong[] = [
  ...SHUFFLED_MAIN_EPISODES.map((episode) => mergeSong(episode, MAIN_ALBUM_GUID)),
  mergeSong(2, SPLIT_ALBUM_GUID),
]

test.describe.serial('T99「同名专辑归并」+「集号在中段」', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠️ **按实例注入**（共享 fixtures 一条不改 ⇒ 别的用例不受影响）。
    mock = createMockServer({
      songs: [...SONGS, ...MERGE_SONGS],
      albums: [...ALBUMS, MAIN_ALBUM, SPLIT_ALBUM],
    })
    fixture = await launchApp({ mock })
    await fixture.window.getByRole('button', { name: '连接', exact: true }).click()
    await login(fixture.window, mock.url)
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.close()
    await mock?.close()
  })

  test('两张同名同目录的专辑 ⇒ 列表**合成一条**，集数相加并说明合并了几张', async () => {
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    await fixture.window.getByRole('button', { name: '扫描这个目录' }).click()

    // ⭐ 核心：服务端是**两张**同名专辑，客户端要**合成一条**。
    const items = fixture.window.locator('.sanlos-audiobooks__item')
    await expect(items).toHaveCount(1)
    await expect(items.first().locator('.sanlos-audiobooks__title')).toHaveText(WORK_NAME)

    // 集数是**组合计**（12 + 1 = 13）⇒ 原来「丢的那一集」在计数里已经补回来了。
    const meta = items.first().locator('.sanlos-audiobooks__meta')
    await expect(meta).toContainText('13 集')
    // 如实说明合并了几张（不黑箱）。
    await expect(meta).toContainText('合并了 2 张专辑')
  })

  test('点进去 ⇒ 两张专辑的曲目**合并**后按集序排 ⇒ **第 02 集出现**', async () => {
    await fixture.window.locator('.sanlos-audiobooks__title').click()

    // 徽标：真的排成集序了。
    await expect(fixture.window.locator('.sanlos-detail__audiobook-note')).toHaveText('已按集序排列')

    const rows = fixture.window.locator('.sanlos-songlist__row')
    // ⚠️ **T104（2026-11-17）**：「DOM 里有 13 行」只在**滚不动**（旧缺陷）时成立
    //    ⇒ 改成**滚着收齐**（按 `data-index` 去重）：**收齐 13 行 = 能滚到底**。
    const all = await collectSongListRows(fixture.window)
    // 13 集（12 + 1）⇒ 整部作品一集不少。
    expect(all).toHaveLength(13)

    // ⭐ **第 02 集来自另一张专辑**（服务端把它拆开了）⇒ 合并后它**必须出现**。
    await expect(rows.nth(0).locator('.sanlos-detail__episode')).toHaveText('第 1 集')
    await expect(rows.nth(1).locator('.sanlos-detail__episode')).toHaveText('第 2 集')
    // ⭐ 这一行的标题**只可能**来自被拆出去的那张专辑（主专辑里**没有**第 02 集）。
    await expect(rows.nth(1).locator('.sanlos-songlist__title')).toHaveText(`${WORK_NAME} 02 承上`)
    expect(all[12]?.episode).toBe('第 13 集')

    // 集号**连续**（1…13，中间没有洞）。
    expect(all.map((row) => row.episode)).toEqual(
      Array.from({ length: 13 }, (_, i) => `第 ${i + 1} 集`),
    )

    // 总数按**整组**算（不是主专辑那 12 集）⇒ 不能出现「已加载 13 / 12」。
    await expect(fixture.window.locator('.sanlos-songlist__status')).toHaveText('已加载 13 / 13')
  })

  test('「这不是有声」⇒ **整组**都不再出现在「有声」页（组级改判）', async () => {
    await fixture.window.getByRole('button', { name: '这不是有声' }).click()

    // 不再按集序排（回到原序）⇒ 徽标与集号标签都消失。
    await expect(fixture.window.locator('.sanlos-detail__audiobook-note')).toHaveCount(0)
    await expect(fixture.window.locator('.sanlos-detail__episode')).toHaveCount(0)

    // 回「有声」页 ⇒ 整组都消失（**不是只消失一张**）。
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    await expect(fixture.window.locator('.sanlos-audiobooks__item')).toHaveCount(0)
    await expect(fixture.window.locator('.sanlos-audiobooks__empty')).toContainText(
      '当前曲库里没有识别到有声读物',
    )
  })

  test('T100 改写：秒搜结果**按「一本小说」归并成一条** ⇒ 点进去是**整组**（第 02 集在）', async () => {
    // ⚠️ **T100（2026-11-17）把这条用例的前提显式推翻了**：
    //    以前秒搜给的是**两张同名专辑**（用户要点对那张）⇒ 现在按「**一本小说 = 一条**」
    //    归并成**一条**（同名 + 同作品目录）⇒ 断言改写为**新行为**（不弱化：更严）。
    //    ⚠️ 「从**非主成员**进去」这条路径现在**产品上不可达**（列表与秒搜都给归并后的一条）
    //    ⇒ 该覆盖改由**单测**承担（`test/audiobook-store.test.ts` ④「组级改判：对组内任一成员」）。
    await fixture.window.getByPlaceholder('输入作品名，例如：牧神记').fill(WORK_NAME)
    await fixture.window.getByRole('button', { name: '搜作品' }).click()

    const results = fixture.window.locator('.sanlos-audiobooks__result')
    // ⭐ 服务端是**两张**同名专辑 ⇒ 界面**只给一条**（= 一本小说）。
    await expect(results).toHaveCount(1)
    // 集数是**组合计**（12 + 1 = 13）⇒ 并如实说明合并了几张。
    await expect(results.first().locator('.sanlos-audiobooks__result-meta')).toHaveText(
      '13 集 · 合并了 2 张专辑',
    )

    // 点它 ⇒ 进的是**整组**（13 集）⇒ **第 02 集在场**（从搜索进去以前会丢）。
    await results.first().locator('.sanlos-audiobooks__title').click()
    await expect(fixture.window.locator('.sanlos-detail__audiobook-note')).toHaveText('已按集序排列')
    const rows = fixture.window.locator('.sanlos-songlist__row')
    // ⚠️ T104：同上（「DOM 行数」→「滚着收齐」；收齐 13 行 = 能滚到底）。
    const all = await collectSongListRows(fixture.window)
    expect(all).toHaveLength(13)
    await expect(rows.nth(1).locator('.sanlos-detail__episode')).toHaveText('第 2 集')
    await expect(rows.nth(1).locator('.sanlos-songlist__title')).toHaveText(`${WORK_NAME} 02 承上`)

    // 改判 ⇒ **整组**都不再出现在「有声」页（改判是**组级**的）。
    await fixture.window.getByRole('button', { name: '这不是有声' }).click()
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    await expect(fixture.window.locator('.sanlos-audiobooks__item')).toHaveCount(0)
  })
})
