// ---------------------------------------------------------------------------
// Task 7（新版清单）：最近播放
//
// 覆盖三件事：
// - **NAS 历史（只读）**：走 `GET /play-history/list`，**按服务端返回顺序**展示
//   （实测服务端排序依据不暴露，客户端不自行排序）；
// - **本机播放记录**：换歌才记一笔、同一首重播不重复记、超过上限丢最旧的、
//   写进 `localStorage`；
// - **整队口径**：两段列表里双击曲目都传出**该段已加载的整队**。
//
// ⚠️ 测试里一律用占位数据，不写真实 FN ID / 账号 / 口令。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import { HistoryPage } from '../src/pages/HistoryPage'
import { LOCAL_HISTORY_KEY, useLocalHistory, installLocalHistory } from '../src/state/historyStore'
import { usePlayerStore } from '../src/state/playerStore'

// ---------------------------------------------------------------------------
// 测试数据（占位）
// ---------------------------------------------------------------------------

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

const NAS_SONGS: Song[] = [makeSong(1, { id: 'n1', title: 'NAS歌一' }), makeSong(2, { id: 'n2', title: 'NAS歌二' })]

function createFakeApi(overrides: Partial<LibraryApi> = {}): LibraryApi {
  const base: LibraryApi = {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as Genre[], total: 0 })),
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    favorites: vi.fn(async () => [] as Song[]),
    playlists: vi.fn(async () => [] as Playlist[]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    album: vi.fn(async () => null),
    albumSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    history: vi.fn(async () => ({ list: NAS_SONGS, total: NAS_SONGS.length })),
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  window.localStorage.clear()
  useLocalHistory.setState({ items: [] })
})

// ---------------------------------------------------------------------------
// NAS 历史（只读）
// ---------------------------------------------------------------------------

describe('最近播放页：NAS 播放历史（只读）', () => {
  it('挂载时拉第一页，并按服务端返回顺序展示', async () => {
    const api = createFakeApi()
    const store = createLibraryStore(api)
    render(<HistoryPage store={store} />)

    await waitFor(() => expect(screen.getByText('NAS歌一')).toBeTruthy())
    expect(api.history).toHaveBeenCalledWith(1, expect.any(Number))
    // ⚠️ **顺序按服务端返回的来**（实测服务端排序依据不暴露给客户端）。
    const titles = screen.getAllByRole('option').map((node) => node.textContent ?? '')
    expect(titles[0]).toContain('NAS歌一')
    expect(titles[1]).toContain('NAS歌二')
  })

  it('双击 NAS 历史里的歌 → 传出该段整队', async () => {
    const api = createFakeApi()
    const store = createLibraryStore(api)
    const onPlay = vi.fn()
    render(<HistoryPage store={store} onPlay={onPlay} />)

    await waitFor(() => expect(screen.getByText('NAS歌二')).toBeTruthy())
    fireEvent.doubleClick(screen.getByText('NAS歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0]!
    expect(call[0].id).toBe('n2')
    expect((call[2] as Song[]).map((song) => song.id)).toEqual(['n1', 'n2'])
  })

  it('服务端出错时给出错误提示而不是白屏', async () => {
    const api = createFakeApi({
      history: vi.fn(async () => {
        throw new Error('历史拉取失败')
      }),
    })
    const store = createLibraryStore(api)
    render(<HistoryPage store={store} />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('历史拉取失败'))
  })
})

// ---------------------------------------------------------------------------
// 本机播放记录
// ---------------------------------------------------------------------------

describe('本机播放记录', () => {
  it('换歌才记一笔', () => {
    const unsubscribe = installLocalHistory()
    try {
      usePlayerStore.getState().playTrack(makeSong(1, { id: 'p1', title: '本机歌一' }))
      expect(useLocalHistory.getState().items.map((s) => s.id)).toEqual(['p1'])

      usePlayerStore.getState().playTrack(makeSong(2, { id: 'p2', title: '本机歌二' }))
      expect(useLocalHistory.getState().items.map((s) => s.id)).toEqual(['p2', 'p1'])
    } finally {
      unsubscribe()
    }
  })

  it('同一首重播不重复记', () => {
    const unsubscribe = installLocalHistory()
    try {
      const song = makeSong(1, { id: 'p1' })
      usePlayerStore.getState().playTrack(song)
      // 重播同一首：`current` 没变 → 不该再记。
      usePlayerStore.getState().playTrack(song)
      expect(useLocalHistory.getState().items.map((s) => s.id)).toEqual(['p1'])
    } finally {
      unsubscribe()
    }
  })

  it('写进 localStorage（重启后还在）', () => {
    const unsubscribe = installLocalHistory()
    try {
      usePlayerStore.getState().playTrack(makeSong(1, { id: 'p1', title: '本机歌一' }))
      const raw = window.localStorage.getItem(LOCAL_HISTORY_KEY)
      expect(raw).toBeTruthy()
      const parsed = JSON.parse(raw ?? '[]') as Song[]
      expect(parsed[0]?.id).toBe('p1')
    } finally {
      unsubscribe()
    }
  })

  it('超过上限时丢最旧的', () => {
    const store = useLocalHistory.getState()
    for (let index = 0; index < 120; index += 1) {
      store.record(makeSong(index, { id: `p${index}` }))
    }
    const items = useLocalHistory.getState().items
    expect(items.length).toBeLessThanOrEqual(100)
    // 最新的在**最前**，最旧的被丢掉。
    expect(items[0]?.id).toBe('p119')
  })

  it('本机记录在页面上可见，双击传出该段整队', async () => {
    const store = createLibraryStore(createFakeApi())
    useLocalHistory.setState({ items: [makeSong(3, { id: 'l1', title: '本机歌一' }), makeSong(4, { id: 'l2', title: '本机歌二' })] })
    const onPlay = vi.fn()
    render(<HistoryPage store={store} onPlay={onPlay} />)

    await waitFor(() => expect(screen.getByText('本机歌一')).toBeTruthy())
    fireEvent.doubleClick(screen.getByText('本机歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0]!
    expect(call[0].id).toBe('l2')
    expect((call[2] as Song[]).map((song) => song.id)).toEqual(['l1', 'l2'])
  })

  it('本机记录里绝不含凭证', () => {
    const store = useLocalHistory.getState()
    store.record(makeSong(1, { id: 'p1' }))
    const dumped = JSON.stringify(useLocalHistory.getState().items).toLowerCase()
    expect(dumped).not.toContain('token')
    expect(dumped).not.toContain('password')
  })
})
