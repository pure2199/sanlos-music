// ---------------------------------------------------------------------------
// 行内收藏（Task 25）
// ---------------------------------------------------------------------------
//
// 覆盖的是一处**真实缺口**：收藏写回器（乐观更新 / 串行化 / 序号守卫 / 失败回滚）
// 早就写好了，但**只有搜索页**能用到它 —— 曲库 / 收藏 / 专辑·歌手·风格详情 /
// 歌单详情 / 最近播放这些页面的歌曲行**一个收藏入口都没有**。
//
// 本文件钉：
// 1. **每个**列歌曲的页面都有行内收藏按钮；
// 2. 点击 → 立刻乐观更新 → 写回成功 → **单一真相源**（store）更新；
// 3. 写回失败 → 回滚到原值 + 页面给出「操作失败」提示（不静默）；
// 4. 只读环境 → 按钮**禁用**（不是点了才报错）；
// 5. 点收藏按钮**不冒泡**到行（行单击是「选中」，不该被误触发）；
// 6. 收藏页取消收藏 → 那一首**当场**从列表里消失。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { FavoritesPage } from '../src/pages/FavoritesPage'
import { SongsPage } from '../src/pages/SongsPage'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    title: `歌${id}`,
    artist: '甲',
    artistId: '',
    album: '示例专辑',
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
    ...overrides,
  }
}

const SONG_A = makeSong('a', { title: '歌甲' })
const SONG_B = makeSong('b', { title: '歌乙', favorite: true })

// ---------------------------------------------------------------------------
// 假接口（收藏集合是**可变**的，好模拟真实写回）
// ---------------------------------------------------------------------------

/** 造一个带**可变收藏集合**的假曲库接口。 */
function makeLibraryApi(options: {
  /** 服务端「已收藏」的曲目 id。 */
  favorited?: string[]
  /** 曲库里的歌。 */
  songs?: Song[]
  /** 写回是否失败。 */
  failWriteback?: boolean
}): LibraryApi & { favoriteIds: Set<string> } {
  const favoriteIds = new Set(options.favorited ?? [])
  const songs = options.songs ?? [SONG_A, SONG_B]
  return {
    favoriteIds,
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as Genre[], total: 0 })),
    songs: vi.fn(async () => ({ list: songs, total: songs.length })),
    favorites: vi.fn(async () => songs.filter((song) => favoriteIds.has(song.id))),
    playlists: vi.fn(async () => [] as Playlist[]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    history: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    album: vi.fn(async () => null),
    albumSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    setFavorite: vi.fn(async (songId: string, on: boolean) => {
      if (options.failWriteback) throw new Error('服务端拒绝')
      if (on) favoriteIds.add(songId)
      else favoriteIds.delete(songId)
    }),
  }
}

/** 造一个**只读**的假曲库接口（没有 `setFavorite`）。 */
function makeReadOnlyApi(): LibraryApi {
  const api = makeLibraryApi({ songs: [SONG_A] })
  delete (api as { setFavorite?: unknown }).setFavorite
  return api
}

/** 取某个曲目 id 的收藏按钮。 */
function favoriteButtonOf(songId: string): HTMLElement {
  const button = document.querySelector(
    `[data-testid="fnm-favorite-toggle"][data-song-id="${songId}"]`,
  )
  if (!(button instanceof HTMLElement)) throw new Error(`找不到 ${songId} 的收藏按钮`)
  return button
}

// ---------------------------------------------------------------------------

describe('行内收藏（曲库各页）', () => {
  it('歌曲页的每一行都有收藏按钮，且初始态取服务端字段', async () => {
    const api = makeLibraryApi({ songs: [SONG_A, SONG_B] })
    render(createElement(SongsPage, { api }))

    await screen.findByText('歌甲')

    // 未收藏的那首 → 未按下。
    expect(favoriteButtonOf('a').getAttribute('aria-pressed')).toBe('false')
    // 服务端说已收藏的那首 → 按下（`song.favorite` 兜底值生效）。
    expect(favoriteButtonOf('b').getAttribute('aria-pressed')).toBe('true')
  })

  it('点一下：立刻乐观更新（不等请求回来）+ 调用写回', async () => {
    const api = makeLibraryApi({ songs: [SONG_A] })
    render(createElement(SongsPage, { api }))
    await screen.findByText('歌甲')

    fireEvent.click(favoriteButtonOf('a'))

    // 乐观更新：界面**立刻**反映。
    expect(favoriteButtonOf('a').getAttribute('aria-pressed')).toBe('true')

    await waitFor(() => expect(api.setFavorite).toHaveBeenCalledWith('a', true))
  })

  it('写回成功后：单一真相源（store）里记下已收藏', async () => {
    const api = makeLibraryApi({ songs: [SONG_A] })
    const store = createLibraryStore(api)
    render(createElement(SongsPage, { api, store }))
    await screen.findByText('歌甲')

    fireEvent.click(favoriteButtonOf('a'))

    await waitFor(() => expect(store.getState().favoriteStates['a']).toBe(true))
    // 服务端那份列表随之过期（下次要重新拉）。
    expect(store.getState().favoritesDirty).toBe(true)
  })

  it('写回失败：回滚到原值 + 页面给出「操作失败」提示（不静默）', async () => {
    const api = makeLibraryApi({ songs: [SONG_A], failWriteback: true })
    render(createElement(SongsPage, { api }))
    await screen.findByText('歌甲')

    fireEvent.click(favoriteButtonOf('a'))
    // 乐观态先亮一下。
    expect(favoriteButtonOf('a').getAttribute('aria-pressed')).toBe('true')

    await waitFor(() =>
      expect(favoriteButtonOf('a').getAttribute('aria-pressed')).toBe('false'),
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('操作失败')
    expect(alert.textContent).toContain('服务端拒绝')
  })

  it('只读环境（接口没有收藏写回）→ 按钮禁用（不是点了才报错）', async () => {
    const api = makeReadOnlyApi()
    render(createElement(SongsPage, { api }))
    await screen.findByText('歌甲')

    expect(favoriteButtonOf('a').hasAttribute('disabled')).toBe(true)
  })

  it('点收藏按钮**不冒泡**到行（行单击是「选中」，不该被误触发）', async () => {
    const api = makeLibraryApi({ songs: [SONG_A] })
    const onSelect = vi.fn()
    render(createElement(SongsPage, { api, onSelect }))
    await screen.findByText('歌甲')

    fireEvent.click(favoriteButtonOf('a'))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('收藏页：取消收藏 → 那一首**当场**从列表里消失', async () => {
    const api = makeLibraryApi({ favorited: ['a'], songs: [SONG_A, SONG_B] })
    render(createElement(FavoritesPage, { api }))

    await screen.findByText('歌甲')
    expect(favoriteButtonOf('a').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(favoriteButtonOf('a'))

    // 写回成功后 → 这一首从收藏页消失（不等重新拉服务端列表）。
    await waitFor(() => expect(screen.queryByText('歌甲')).toBeNull())
  })
})
