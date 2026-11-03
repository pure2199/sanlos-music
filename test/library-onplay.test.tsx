// ---------------------------------------------------------------------------
// Task 2（新版清单）：曲库三页的「整队口径」与向后兼容
//
// 覆盖：
// - `SongList` 双击时把**当前整队**作为第三个参数传给 `onPlay`；
// - 歌曲 / 收藏 / 歌单三页的 `onPlay` 都收到 `(song, index, list)`，
//   且 `list` 是该页**已加载**的整队（不是单首歌、也不是全库）；
// - **纯增量**：两参回调仍然可赋值、仍然被调用（既有调用方行为不变）。
//
// ⚠️ 测试里一律用占位数据（「歌一」「示例歌单」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名 / 真实专辑名**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'
import { SongList } from '../src/components/SongList'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import { FavoritesPage } from '../src/pages/FavoritesPage'
import { PlaylistsPage } from '../src/pages/PlaylistsPage'
import { SongsPage } from '../src/pages/SongsPage'

// ---------------------------------------------------------------------------
// 测试数据（占位）
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(index: number, overrides: Partial<Song> = {}): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
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
    trackNo: index,
    discNo: 1,
    ...overrides,
  }
}

/** 三首占位歌曲。 */
const SONGS: Song[] = [
  makeSong(1, { id: '1', title: '歌一' }),
  makeSong(2, { id: '2', title: '歌二' }),
  makeSong(3, { id: '3', title: '歌三' }),
]

/** 一个占位歌单。 */
const PLAYLIST: Playlist = {
  id: 'playlist-1',
  name: '示例歌单',
  coverId: null,
  trackCount: 3,
}

/** 造一个假的曲库 API（默认各端点都返回那三首歌）。 */
function createFakeApi(overrides: Partial<LibraryApi> = {}): LibraryApi {
  const base: LibraryApi = {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as Genre[], total: 0 })),
    songs: vi.fn(async () => ({ list: SONGS, total: SONGS.length })),
    favorites: vi.fn(async () => SONGS),
    playlists: vi.fn(async () => [PLAYLIST]),
    playlistSongs: vi.fn(async () => ({ list: SONGS, total: SONGS.length })),
  }
  return { ...base, ...overrides }
}

// ---------------------------------------------------------------------------
// SongList：整队口径
// ---------------------------------------------------------------------------

describe('SongList 的整队口径', () => {
  it('双击行时把当前整队作为第三个参数传出', () => {
    const onPlay = vi.fn()
    render(<SongList songs={SONGS} onPlay={onPlay} />)

    fireEvent.doubleClick(screen.getByText('歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    // ⚠️ 第三个参数 = `songs` 本身（当前已加载的整队）。
    expect(onPlay).toHaveBeenCalledWith(SONGS[1], 1, SONGS)
  })

  it('两参回调仍能被调用（第三个参数是纯增量，既有调用方行为不变）', () => {
    const calls: Array<[string, number]> = []
    render(
      <SongList
        songs={SONGS}
        onPlay={(song, index) => {
          calls.push([song.id, index])
        }}
      />,
    )

    fireEvent.doubleClick(screen.getByText('歌一'))

    expect(calls).toEqual([['1', 0]])
  })
})

// ---------------------------------------------------------------------------
// 曲库三页：onPlay 拿到的都是「该页已加载的整队」
// ---------------------------------------------------------------------------

describe('曲库三页的整队口径', () => {
  it('歌曲页：双击传出该页已加载的整队', async () => {
    const onPlay = vi.fn()
    const store = createLibraryStore(createFakeApi())
    render(<SongsPage store={store} onPlay={onPlay} />)

    await waitFor(() => expect(screen.getByText('歌二')).toBeTruthy())
    fireEvent.doubleClick(screen.getByText('歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0]!
    expect(call[0].id).toBe('2')
    expect(call[1]).toBe(1)
    // 整队 = 该页**已加载**的全部歌曲（不是单首歌）。
    expect((call[2] as Song[]).map((song) => song.id)).toEqual(['1', '2', '3'])
  })

  it('收藏页：双击传出收藏整队', async () => {
    const onPlay = vi.fn()
    const store = createLibraryStore(createFakeApi())
    render(<FavoritesPage store={store} onPlay={onPlay} />)

    await waitFor(() => expect(screen.getByText('歌二')).toBeTruthy())
    fireEvent.doubleClick(screen.getByText('歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0]!
    expect(call[0].id).toBe('2')
    expect((call[2] as Song[]).map((song) => song.id)).toEqual(['1', '2', '3'])
  })

  it('歌单页：选中歌单后双击传出该歌单的整队', async () => {
    const onPlay = vi.fn()
    const store = createLibraryStore(createFakeApi())
    render(<PlaylistsPage store={store} onPlay={onPlay} />)

    await waitFor(() => expect(screen.getByText('示例歌单')).toBeTruthy())
    fireEvent.click(screen.getByText('示例歌单'))
    await waitFor(() => expect(screen.getByText('歌二')).toBeTruthy())

    fireEvent.doubleClick(screen.getByText('歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0]!
    expect(call[0].id).toBe('2')
    expect((call[2] as Song[]).map((song) => song.id)).toEqual(['1', '2', '3'])
  })

  it('两参回调在三页上仍然可用（纯增量）', async () => {
    const calls: Array<[string, number]> = []
    const store = createLibraryStore(createFakeApi())
    render(
      <SongsPage
        store={store}
        onPlay={(song, index) => {
          calls.push([song.id, index])
        }}
      />,
    )

    await waitFor(() => expect(screen.getByText('歌三')).toBeTruthy())
    fireEvent.doubleClick(screen.getByText('歌三'))

    expect(calls).toEqual([['3', 2]])
  })
})
