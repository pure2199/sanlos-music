// ---------------------------------------------------------------------------
// T100：「那个文件夹里的都是有声小说」—— E2E（真实 Electron + mock NAS）
// ---------------------------------------------------------------------------
//
// 覆盖用户 2026-11-17 的两句诉求：
//   ① 「不能一本小说就是一个专辑这样显示出来吗，不需要点搜索」
//   ② 「有声小说就只放在那个文件夹里，那文件夹里的都是有声小说」
//
// ⚠️ 这条用例覆盖**四个**新行为：
//   1. **不用点任何按钮** ⇒ 进「有声」页列表**自己出来**（自动开扫 + 落盘 ⇒ 之后秒开）；
//   2. 列表在**第一屏**（搜索框在列表**下面**）⇒ 用户不用先想「要不要搜」；
//   3. 列表项**不再**出现「判定分」「结构信号弱」⇒ 与「位置即判定」一致；
//   4. **秒搜结果按「一本小说」归并成一条**（同名 + 同作品目录）⇒ 点进去是**整组**。
//
// ⚠️ **mock 的形态按真机实测仿**（2026-11-16，本机 + 该账号）：
//   服务端把一部作品拆成**两张同名专辑**（12 集 + 1 集）⇒ 客户端必须**合成一条**。
//   ⚠️ 共享 fixtures 一条不改（T97「8 首」/ T98「12 集」断言不受影响）
//      ⇒ 这里的 13 集**只在本实例**注入。
// ⚠️ 顺序**故意打乱**（第 1 首是第 13 集）⇒ 排序是客户端自己做的。
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test'

import { ALBUMS, SONGS, type RawAlbum, type RawSong } from '../mock-server/fixtures'
import { createMockServer, type MockServer } from '../mock-server/server'
import { launchApp, login, type AppFixture } from './helpers/app'

/** 合并后的作品名（两张专辑**同名**）。 */
const WORK_NAME = '示例小说作品'
/** 作品目录（`path` 倒数第 3 段）—— 两张专辑**共用** ⇒ 归并键相同。 */
const WORK_DIR = WORK_NAME
/** 目录关键字要命中的那一段。 */
const FOLDER = '有声小说'
/** 主专辑的 guid（**集数多**的那张 ⇒ 归并后它是「主专辑」）。 */
const MAIN_ALBUM_GUID = 'al-t100-main'
/** 被拆出去的那张（只含**第 02 集** —— 正是「丢的那一集」）。 */
const SPLIT_ALBUM_GUID = 'al-t100-split'

/**
 * ⭐ **第二部作品**（「旁支作品」）：**不在**「有声小说」目录里
 * ⇒ 目录扫描**扫不到它** ⇒ 扫描结果（`hits`）里**没有**它
 * ⇒ 从**秒搜**点进去时，**只有临时组（`extraGroups`）**能让详情页认出整组。
 *
 * ⚠️ 这条用例就是为**咬住**「详情页不认临时组」那条缺陷而存在的
 *    （第一轮变异自证时它**没变红** ⇒ 因为扫描结果把缺口**兜住了**）。
 */
const SIDE_NAME = '示例旁支作品'
const SIDE_DIR = SIDE_NAME
/** ⚠️ 路径里**不含**「有声小说」⇒ 扫描时会被目录关键字过滤掉。 */
const SIDE_FOLDER = '其它'
const SIDE_MAIN_GUID = 'al-t100-side-main'
const SIDE_SPLIT_GUID = 'al-t100-side-split'

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
function workSong(
  episode: number,
  albumGuid: string,
  opts: { name: string; workDir: string; folder: string },
): RawSong {
  const ep = label(episode)
  const chapter = CHAPTERS[(episode - 1) % CHAPTERS.length] ?? '某集'
  return {
    guid: `t100-${albumGuid}-${ep}`,
    title: `${opts.name} ${ep} ${chapter}`,
    duration: 1500000,
    coverId: null,
    artists: [{ guid: 'a-t100', name: '示例作者', coverId: null, createdAt: 1792563278 }],
    album: {
      guid: albumGuid,
      name: opts.name,
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
      // ⚠ 倒数第 3 段 = **作品目录** ⇒ 两张专辑的作品目录**相同** ⇒ 归并键相同。
      path: `/vol02/1000-0-3d135437/${opts.folder}/示例作者/${opts.workDir}/Disc 01/${opts.name} ${ep} ${chapter}.mp3`,
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

/** 造一张专辑。 */
function workAlbum(name: string, guid: string, trackCount: number): RawAlbum {
  return {
    guid,
    name,
    coverId: null,
    releaseDate: null,
    barcode: null,
    createdAt: 1792563278,
    updatedAt: 1792563278,
    artists: [{ guid: 'a-t100', name: '示例作者', coverId: null, createdAt: 1792563278 }],
    trackCount,
  }
}

/** 主专辑的 12 集（**不含第 02 集** —— 那一集被拆到另一张专辑去了）。 */
const MAIN_EPISODES = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
/** ⚠️ **故意打乱**（倒序）⇒ 排对了才是真的排对了。 */
const SHUFFLED_MAIN_EPISODES = [...MAIN_EPISODES].reverse()

/** 主专辑（12 集）。 */
const MAIN_ALBUM = workAlbum(WORK_NAME, MAIN_ALBUM_GUID, 12)

/** 被拆出去的那张（**同名**，只有第 02 集）。 */
const SPLIT_ALBUM = workAlbum(WORK_NAME, SPLIT_ALBUM_GUID, 1)

/** ⭐ 旁支作品（**不在**扫描目录里 ⇒ `hits` 里没有它 ⇒ 只有临时组能救）。 */
const SIDE_MAIN_ALBUM = workAlbum(SIDE_NAME, SIDE_MAIN_GUID, 12)
const SIDE_SPLIT_ALBUM = workAlbum(SIDE_NAME, SIDE_SPLIT_GUID, 1)

/** 本实例的曲库：共享的 8 首 + 两部作品的 13 集。 */
const WORK_SONGS: RawSong[] = [
  ...SHUFFLED_MAIN_EPISODES.map((episode) =>
    workSong(episode, MAIN_ALBUM_GUID, { name: WORK_NAME, workDir: WORK_DIR, folder: FOLDER }),
  ),
  workSong(2, SPLIT_ALBUM_GUID, { name: WORK_NAME, workDir: WORK_DIR, folder: FOLDER }),
  ...SHUFFLED_MAIN_EPISODES.map((episode) =>
    workSong(episode, SIDE_MAIN_GUID, { name: SIDE_NAME, workDir: SIDE_DIR, folder: SIDE_FOLDER }),
  ),
  workSong(2, SIDE_SPLIT_GUID, { name: SIDE_NAME, workDir: SIDE_DIR, folder: SIDE_FOLDER }),
]

test.describe.serial('T100「那个文件夹里的都是有声小说」', () => {
  let fixture: AppFixture
  let mock: MockServer

  test.beforeAll(async () => {
    // ⚠️ **按实例注入**（共享 fixtures 一条不改 ⇒ 别的用例不受影响）。
    mock = createMockServer({
      songs: [...SONGS, ...WORK_SONGS],
      albums: [...ALBUMS, MAIN_ALBUM, SPLIT_ALBUM, SIDE_MAIN_ALBUM, SIDE_SPLIT_ALBUM],
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

  test('① 进「有声」页**不用点任何按钮** ⇒ 列表自己出来（一本小说一条）', async () => {
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()

    // ⭐ **不点**「扫描这个目录」⇒ 列表也得自己出来（自动开扫）。
    const items = fixture.window.locator('.fnm-audiobooks__item')
    await expect(items).toHaveCount(1)
    await expect(items.first().locator('.fnm-audiobooks__title')).toHaveText(WORK_NAME)

    // 一本小说 = **一条**（服务端是两张同名专辑 ⇒ 合成一条 + 如实说明）。
    const meta = items.first().locator('.fnm-audiobooks__meta')
    await expect(meta).toContainText('13 集')
    await expect(meta).toContainText('合并了 2 张专辑')

    // 来源说得清楚（用户指的位置）。
    await expect(items.first().locator('.fnm-audiobooks__source')).toContainText(FOLDER)
  })

  test('② 列表在**第一屏**（搜索框在列表下面）⇒ 不用先想「要不要搜」', async () => {
    const order = await fixture.window.evaluate(() => {
      const list = document.querySelector('.fnm-audiobooks__list')
      const search = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes('搜作品'),
      )
      if (!list || !search) return null
      // DOCUMENT_POSITION_FOLLOWING = search 在 list 之后 ⇒ list 在前。
      return list.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'list-before'
        : 'search-before'
    })
    expect(order).toBe('list-before')
  })

  test('③ 列表项**不再**出现「判定分」「结构信号弱」⇒ 与「位置即判定」一致', async () => {
    const item = fixture.window.locator('.fnm-audiobooks__item').first()
    await expect(item.locator('.fnm-audiobooks__meta')).not.toContainText('判定分')
    await expect(item).not.toContainText('结构信号弱')
  })

  test('④ 秒搜 ⇒ **一本小说一条** ⇒ 点进去是**整组**（第 02 集在场）', async () => {
    await fixture.window.getByPlaceholder('输入作品名，例如：牧神记').fill(WORK_NAME)
    await fixture.window.getByRole('button', { name: '搜作品' }).click()

    const results = fixture.window.locator('.fnm-audiobooks__result')
    // ⭐ 服务端是**两张**同名专辑 ⇒ 界面**只给一条**（= 一本小说）。
    await expect(results).toHaveCount(1)
    await expect(results.first().locator('.fnm-audiobooks__title')).toHaveText(WORK_NAME)
    await expect(results.first().locator('.fnm-audiobooks__result-meta')).toHaveText(
      '13 集 · 合并了 2 张专辑',
    )

    // 点它 ⇒ 进的是**整组**（13 集）⇒ **第 02 集在场**（以前从搜索进去会丢）。
    await results.first().locator('.fnm-audiobooks__title').click()
    await expect(fixture.window.locator('.fnm-detail__audiobook-note')).toHaveText('已按集序排列')
    const rows = fixture.window.locator('.fnm-songlist__row')
    await expect(rows).toHaveCount(13)
    await expect(rows.nth(1).locator('.fnm-detail__episode')).toHaveText('第 2 集')
    await expect(rows.nth(1).locator('.fnm-songlist__title')).toHaveText(`${WORK_NAME} 02 承上`)
    await expect(fixture.window.locator('.fnm-songlist__status')).toHaveText('已加载 13 / 13')
  })

  test('⑤ ⭐ 扫不到的作品（不在那个目录里）⇒ 从秒搜进去**仍是整组**（只有临时组能救）', async () => {
    // ⚠️ 这部作品的路径**不含**「有声小说」⇒ 目录扫描**扫不到** ⇒ 扫描结果里没有它
    //    ⇒ 详情页只能靠**秒搜时登记的临时组**认出整组。
    //    （这条用例是为**咬住**「详情页不认临时组」那条缺陷而加的 —— 第一轮变异自证时它没变红。）
    await fixture.window.getByRole('button', { name: '有声', exact: true }).click()
    await fixture.window.getByPlaceholder('输入作品名，例如：牧神记').fill(SIDE_NAME)
    await fixture.window.getByRole('button', { name: '搜作品' }).click()

    const results = fixture.window.locator('.fnm-audiobooks__result')
    await expect(results).toHaveCount(1)
    await expect(results.first().locator('.fnm-audiobooks__result-meta')).toHaveText(
      '13 集 · 合并了 2 张专辑',
    )

    await results.first().locator('.fnm-audiobooks__title').click()
    await expect(fixture.window.locator('.fnm-detail__audiobook-note')).toHaveText('已按集序排列')
    const rows = fixture.window.locator('.fnm-songlist__row')
    // ⭐ **13 集**（12 + 1）⇒ 不认临时组的话这里只有 12 集（**第 02 集会丢**）。
    await expect(rows).toHaveCount(13)
    await expect(rows.nth(1).locator('.fnm-detail__episode')).toHaveText('第 2 集')
    await expect(rows.nth(1).locator('.fnm-songlist__title')).toHaveText(`${SIDE_NAME} 02 承上`)
  })
})
