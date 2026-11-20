// ---------------------------------------------------------------------------
// T132：歌单面板（`AddToPlaylist`）的**排序**与**分页**
// ---------------------------------------------------------------------------
//
// ⚠ **为什么是面板**：台账原话 ——「面板里的歌单**不排序**（按服务端返回顺序）」
//    「面板里的歌单**没有分页**（`playlist/list` 是全量接口）」。
//
// ⚠ **为什么分页只能是「前端切片」**：`playlist/list` 是**全量**接口
//    （`fetchAllByPaging` 取全）⇒ 面板本来拿到的就是**全部**歌单；
//    而面板有**搜索**（前端子串匹配）⇒ 一旦改成「只取一页」，
//    搜索就**搜不到不在这一页的歌单** ⇒ 功能倒退。
//    ⇒ 排序 + 分页都在**前端**做。
//
// ⚠ **三态时间字段**：`Playlist.updatedAt` 的**服务端形状至今未实测**
//    （该账号 `playlist/list` 实测 `total=0`）⇒ 缺失时按「未知」处理，
//    排序时**排最后**（不是最前）⇒ 本轮只能靠 mock 验，真机效果**未验证**。
//
// ⚠ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import type { Playlist, Song } from '../shared/types'
import type { PlaylistWritebackApi } from '../src/api/playlist'
import {
  AddToPlaylist,
  PANEL_PAGE_SIZE,
  sortPlaylistEntries,
} from '../src/components/AddToPlaylist'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

function makeSong(id: string): Song {
  return {
    id,
    title: '占位歌',
    artist: '占位歌手',
    artistId: '',
    album: '占位专辑',
    albumId: '',
    coverId: '',
    duration: 100,
    favorite: false,
    codec: 'FLAC',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: 0,
    trackNo: 1,
    discNo: 1,
  }
}

const SONG = makeSong('track_t132')

/** 造一个占位歌单（`updatedAt` 不传 = **没有**这个字段 = 「未知」）。 */
function makePlaylist(id: string, name: string, updatedAt?: string | null): Playlist {
  const base: Playlist = { id, name, coverId: null, trackCount: 0 }
  return updatedAt === undefined ? base : { ...base, updatedAt }
}

/** 造一个假歌单写回接口。 */
function makePlaylistApi(playlists: Playlist[]): PlaylistWritebackApi {
  return {
    list: vi.fn(async () => playlists),
    create: vi.fn(async () => 'playlist-new'),
    addTracks: vi.fn(async () => undefined),
    removeTracks: vi.fn(async () => undefined),
  }
}

/** 渲染并**点开**面板（等歌单列表出现）。 */
async function openPanel(playlists: Playlist[]): Promise<void> {
  render(
    createElement(AddToPlaylist, { songs: [SONG], playlistApi: makePlaylistApi(playlists) }),
  )
  fireEvent.click(screen.getByTestId('sanlos-add-to-playlist-button'))
  await screen.findByRole('group', { name: '歌单列表' })
}

/** 当前这一页渲染出来的歌单名（**按渲染顺序**）。 */
function visibleNames(): string[] {
  const list = screen.getByRole('group', { name: '歌单列表' })
  return Array.from(list.querySelectorAll('input[type="checkbox"]')).map(
    (el) => el.getAttribute('aria-label') ?? '',
  )
}

/** 造 n 个「组 NN」歌单（名字里都有「组」⇒ 搜索「组」能一次命中全部）。 */
function makeGroupPlaylists(n: number): Playlist[] {
  return Array.from({ length: n }, (_, i) =>
    makePlaylist(`g${String(i + 1).padStart(2, '0')}`, `组 ${String(i + 1).padStart(2, '0')}`),
  )
}

// ---------------------------------------------------------------------------

describe('T132：歌单面板的排序', () => {
  it('① 默认按**名称**升序（中文按拼音；不是服务端返回顺序）', async () => {
    // ⚠ 故意**乱序**输入 ⇒ 渲染顺序若等于输入顺序 ⇒ 说明没排序。
    await openPanel([
      makePlaylist('p3', '张歌单'),
      makePlaylist('p1', '阿歌单'),
    ])

    // ⚠ 本机 ICU=full ⇒ `localeCompare('zh-Hans-CN')` 按**拼音**：
    //   「阿」(a) 在「张」(z) 前 ⇒ **与 Unicode 码点序不同**（码点序是 张在前）
    //   ⇒ 这条断言**能分辨**「用了 zh-Hans-CN」与「退化成码点序」。
    expect(visibleNames()).toEqual(['阿歌单', '张歌单'])
  })

  it('② 切到「按更新时间」⇒ **新→旧**，**未知排最后**', async () => {
    await openPanel([
      makePlaylist('p1', '旧的', '2026-01-01T00:00:00.000Z'),
      makePlaylist('p2', '新的', '2026-03-01T00:00:00.000Z'),
      makePlaylist('p3', '没有更新时间的'),
    ])

    fireEvent.change(screen.getByLabelText('歌单排序'), { target: { value: 'updatedAt' } })

    expect(visibleNames()).toEqual(['新的', '旧的', '没有更新时间的'])
  })

  it('③ 服务端**一个更新时间都没给** ⇒ 「按更新时间」**禁用**（不让用户点一个没用的选项）', async () => {
    await openPanel([makePlaylist('p1', '占位歌单')])

    const option = screen.getByRole('option', { name: '按更新时间（新→旧）' }) as HTMLOptionElement
    expect(option.disabled).toBe(true)
  })
})

describe('T132：歌单面板的分页', () => {
  it('④ 超过一页 ⇒ **只渲染一页**（20 条）＋ 出现分页控件', async () => {
    await openPanel(makeGroupPlaylists(45))

    expect(visibleNames()).toHaveLength(PANEL_PAGE_SIZE)
    // ⚠ 45 条 / 20 ⇒ 3 页。
    expect(screen.getByText('第 1/3 页')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
  })

  it('⑤ 点「下一页」⇒ 换成**下一批**（不是同一批）', async () => {
    await openPanel(makeGroupPlaylists(45))

    const firstPage = visibleNames()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))

    const secondPage = visibleNames()
    expect(screen.getByText('第 2/3 页')).toBeTruthy()
    expect(secondPage).toHaveLength(PANEL_PAGE_SIZE)
    // ⚠ 两页**没有交集** ⇒ 确实翻页了（不是把同一批重画一遍）。
    expect(secondPage.filter((name) => firstPage.includes(name))).toEqual([])
  })

  it('⑥ 搜索 ⇒ **回到第 1 页**（否则搜到的结果落在第 2 页 ⇒ 用户眼前一片空白）', async () => {
    await openPanel(makeGroupPlaylists(30))

    // 先翻到第 2 页。
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('第 2/2 页')).toBeTruthy()

    // ⚠ 搜索后过滤结果**仍有 2 页**（30 条 ⇒ 2 页）⇒ 页码 2 **依然合法**
    //   ⇒ 只有「主动回到第 1 页」才能让用户看见第一条 ⇒ **能分辨**。
    fireEvent.change(screen.getByLabelText('搜索歌单'), { target: { value: '组' } })

    expect(screen.getByText('第 1/2 页')).toBeTruthy()
    expect(visibleNames()[0]).toBe('组 01')
  })

  it('⑦ 翻页**不丢勾选**（跨页勾的歌单照样算数）', async () => {
    await openPanel(makeGroupPlaylists(45))

    fireEvent.click(screen.getByRole('checkbox', { name: '组 01' }))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '组 25' }))

    // ⚠ 跨页勾了两个 ⇒ 按钮必须显示**总数**（否则用户以为只勾了一个）。
    expect(screen.getByRole('button', { name: '加入 2 个歌单' })).toBeTruthy()
  })

  it('⑧ 歌单不足一页 ⇒ **不出现**分页控件（界面与今天一致）', async () => {
    await openPanel(makeGroupPlaylists(3))

    expect(screen.queryByRole('group', { name: '歌单分页' })).toBeNull()
    expect(visibleNames()).toHaveLength(3)
  })
})

describe('T132：排序纯函数（`sortPlaylistEntries`）', () => {
  const entries = [
    { id: 'b', name: '张歌单', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'a', name: '阿歌单', updatedAt: null },
    { id: 'c', name: '丙歌单', updatedAt: '2026-05-01T00:00:00.000Z' },
  ]

  it('按名称：拼音升序（同名 ⇒ 按 id ⇒ 顺序**确定**）', () => {
    expect(sortPlaylistEntries(entries, 'name').map((e) => e.name)).toEqual([
      '阿歌单',
      '丙歌单',
      '张歌单',
    ])
    expect(sortPlaylistEntries(entries, 'name').map((e) => e.id)).toEqual(['a', 'c', 'b'])
  })

  it('按更新时间：新→旧，**未知排最后**', () => {
    expect(sortPlaylistEntries(entries, 'updatedAt').map((e) => e.name)).toEqual([
      '丙歌单',
      '张歌单',
      '阿歌单',
    ])
  })

  it('**不改动入参**（不污染调用方的数组）', () => {
    const source = [...entries]
    sortPlaylistEntries(source, 'name')
    expect(source.map((e) => e.id)).toEqual(['b', 'a', 'c'])
  })
})
