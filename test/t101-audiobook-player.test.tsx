// ---------------------------------------------------------------------------
// T101：有声作品的**播放模块**（详情页 + 全屏播放页）
//
// ⚠️ 用户原话：「**有声业的播放模块 UI 有问题**」⇒ 真机复验（2026-11-17）定位到**三处**：
//    ① 有声专辑详情页**没有**「播放全书」入口（只能双击行）⇒ 加一个（一键整队入队 ⇒ 连播）；
//    ② 全屏播放页默认落在「歌词」标签，而**有声没有歌词**
//       ⇒ 真机 6 秒后仍卡「正在加载歌词…」⇒ 整页大片空白；
//    ③ 结构信号（那行长句）背在列表卡片上 ⇒ 卡片做不成专辑页那样的封面网格
//       ⇒ 搬到**详情页**（信息一点没丢，只是换了位置）。
//
// ⚠️ **这三条都要有测试咬住**（否则下一次重构就会悄悄退回去）。
// ⚠️ **普通专辑的行为必须一字不变**（各有一条「反向」用例守着）。
// ---------------------------------------------------------------------------

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { albumSongs, album } = vi.hoisted(() => ({
  albumSongs: vi.fn(),
  album: vi.fn(),
}))

/**
 * ⚠️ **整个 `../src/api/library` 模块都要 mock**（不只 mock 用到的那一个方法）：
 *    - `audiobookStore` 会 import `scanLibraryTracks`（缺了 ⇒ vitest 直接抛
 *      「No "scanLibraryTracks" export is defined on the mock」）；
 *    - `libraryStore` 会 import `libraryApi`（默认注入用）。
 */
vi.mock('../src/api/library', () => ({
  scanLibraryTracks: vi.fn(),
  libraryApi: {
    album,
    albumSongs,
    albums: vi.fn(async () => ({ list: [], total: 0 })),
    artists: vi.fn(async () => ({ list: [], total: 0 })),
    genres: vi.fn(async () => ({ list: [], total: 0 })),
    songs: vi.fn(async () => ({ list: [], total: 0 })),
    favorites: vi.fn(async () => []),
    playlists: vi.fn(async () => []),
    playlistSongs: vi.fn(async () => ({ list: [], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [], total: 0 })),
    history: vi.fn(async () => ({ list: [], total: 0 })),
  },
}))

import { DetailPage } from '../src/pages/DetailPage'
import { FullPlayerPage } from '../src/pages/FullPlayerPage'
import { createPlayerStore } from '../src/state/playerStore'
import { useAudiobookStore } from '../src/state/audiobookStore'
import type { PlayerEngineLike } from '../src/player/engine'
import type { PlayerState, Song } from '../shared/types'
import type { LyricEntry } from '../src/api/types'

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
    duration: 200,
    favorite: false,
    codec: 'FLAC',
    bitrate: 900,
    sampleRate: 44100,
    bitDepth: 16,
    year: 0,
    trackNo: index,
    discNo: 1,
    ...overrides,
  }
}

/** 假引擎（只记录调用，不碰媒体栈）。 */
class FakeEngine implements PlayerEngineLike {
  state: PlayerState = {
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    error: null,
  }
  private stateListeners: ((state: PlayerState) => void)[] = []
  private endedListeners: ((song: Song | null) => void)[] = []

  play(song: Song): void {
    this.state = {
      ...this.state,
      current: song,
      isPlaying: true,
      position: 0,
      duration: song.duration,
      error: null,
    }
    this.emit()
  }

  pause(): void {
    this.state = { ...this.state, isPlaying: false }
    this.emit()
  }

  resume(): void {
    this.state = { ...this.state, isPlaying: true }
    this.emit()
  }

  seek(position: number): void {
    this.state = { ...this.state, position }
    this.emit()
  }

  setVolume(volume: number): void {
    this.state = { ...this.state, volume }
    this.emit()
  }

  setQueue(queue: Song[], startIndex = 0): void {
    this.state = { ...this.state, queue }
    const song = queue[startIndex]
    if (song) this.play(song)
  }

  skipNext(): void {}

  skipPrevious(): void {}

  stop(): void {
    this.state = { ...this.state, current: null, isPlaying: false, position: 0 }
    this.emit()
  }

  onStateChange(listener: (state: PlayerState) => void): () => void {
    this.stateListeners.push(listener)
    return () => {
      this.stateListeners = this.stateListeners.filter((item) => item !== listener)
    }
  }

  onEnded(listener: (song: Song | null) => void): () => void {
    this.endedListeners.push(listener)
    return () => {
      this.endedListeners = this.endedListeners.filter((item) => item !== listener)
    }
  }

  dispose(): void {
    this.stateListeners = []
    this.endedListeners = []
  }

  private emit(): void {
    for (const listener of [...this.stateListeners]) listener(this.state)
  }
}

/** 一条有声命中（`AudiobookHit` 的完整形状）。 */
const AUDIOBOOK_HIT = {
  albumId: 'al-1',
  albumIds: ['al-1'],
  albumTitle: '某作品',
  score: 5,
  // ⚠️ 这两条是**结构信号**（判定依据）⇒ 详情页要**逐条显示**。
  reasons: ['avg-duration', 'many-episodes'],
  trackCount: 2,
  avgDurationSec: 1500,
  maxDurationSec: 1500,
  episodeRule: 'dash-prefix',
  coverId: null,
}

describe('T101：详情页的播放模块', () => {
  beforeEach(() => {
    album.mockReset()
    album.mockResolvedValue(null)
    albumSongs.mockReset()
    albumSongs.mockResolvedValue({ list: [], total: 0 })
    useAudiobookStore.setState({
      hits: [],
      overrides: {},
      scanning: false,
      progress: null,
      error: null,
      scannedAt: null,
      extraGroups: {},
    })
  })

  it('① 有声专辑详情页有「**播放全书**」⇒ 一键把**整本书**入队并从第 1 集开始', async () => {
    useAudiobookStore.setState({ hits: [AUDIOBOOK_HIT] })
    const songs = [
      makeSong(1, { id: 's1', title: '01- 第1集', albumId: 'al-1' }),
      makeSong(2, { id: 's2', title: '02- 第2集', albumId: 'al-1' }),
    ]
    albumSongs.mockResolvedValue({ list: songs, total: songs.length })
    const onPlay = vi.fn()

    render(
      <DetailPage
        kind="album"
        entityId="al-1"
        title="某作品"
        onBack={() => undefined}
        onPlay={onPlay}
      />,
    )

    const button = await screen.findByRole('button', { name: '播放全书' })
    fireEvent.click(button)

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0]!
    // 从**第 1 集**开始。
    expect(call[0].id).toBe('s1')
    expect(call[1]).toBe(0)
    // ⚠️ **整队** = 这本书的全部集（⇒ 播完一集自动下一集 ⇒ 连播）。
    expect((call[2] as Song[]).map((song) => song.id)).toEqual(['s1', 's2'])
  })

  it('② 结构信号（判定依据）**搬到了详情页**（信息不丢，只是不再背在卡片上）', async () => {
    useAudiobookStore.setState({ hits: [AUDIOBOOK_HIT] })
    const songs = [
      makeSong(1, { id: 's1', title: '01- 第1集', albumId: 'al-1' }),
      makeSong(2, { id: 's2', title: '02- 第2集', albumId: 'al-1' }),
    ]
    albumSongs.mockResolvedValue({ list: songs, total: songs.length })

    const { container } = render(
      <DetailPage kind="album" entityId="al-1" title="某作品" onBack={() => undefined} />,
    )

    const reasons = await waitFor(() => {
      const element = container.querySelector('.sanlos-detail__audiobook-reasons')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(reasons.textContent).toContain('为什么列在这里')
    expect(reasons.textContent).toContain('单集均长 ≥ 8 分钟')
    expect(reasons.textContent).toContain('集数 ≥ 8')
  })

  it('③ **普通专辑**没有「播放全书」⇒ 详情页行为**一字不变**', async () => {
    albumSongs.mockResolvedValue({ list: [makeSong(1)], total: 1 })

    render(
      <DetailPage kind="album" entityId="al-x" title="普通专辑" onBack={() => undefined} />,
    )

    await waitFor(() => {
      expect(screen.getByText('歌1')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: '播放全书' })).toBeNull()
    expect(document.querySelector('.sanlos-detail__audiobook-reasons')).toBeNull()
  })
})

describe('T101：全屏播放页（有声）', () => {
  beforeEach(() => {
    useAudiobookStore.setState({
      hits: [],
      overrides: {},
      scanning: false,
      progress: null,
      error: null,
      scannedAt: null,
      extraGroups: {},
    })
  })

  it('④ 有声曲目 ⇒ **不查歌词**（查了也是白等一轮外部源）；切到歌词页也**如实说明**', async () => {
    useAudiobookStore.setState({ hits: [AUDIOBOOK_HIT] })
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { id: 's1', albumId: 'al-1' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    // ⚠️ 有声**没有歌词** ⇒ 一个请求都不该发。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '队列' }).getAttribute('aria-pressed')).toBe('true')
    })
    expect(api.list).not.toHaveBeenCalled()

    // 就算用户**手动**切到歌词页 ⇒ 如实说明「有声读物没有歌词」（不是「暂无歌词」）。
    fireEvent.click(screen.getByRole('button', { name: '歌词' }))
    expect(await screen.findByText('有声读物没有歌词')).toBeTruthy()
    expect(api.list).not.toHaveBeenCalled()
  })

  it('⑤ 有声曲目 ⇒ 全屏页默认落在「**队列**」（不是永远空的歌词）', async () => {
    useAudiobookStore.setState({ hits: [AUDIOBOOK_HIT] })
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { id: 's1', albumId: 'al-1' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '队列' }).getAttribute('aria-pressed')).toBe('true')
    })
    expect(screen.getByRole('button', { name: '歌词' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('⑥ **普通歌曲**照旧查歌词、默认落在「歌词」⇒ 行为**一字不变**', async () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { id: 's1', albumId: 'al-normal' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    expect(await screen.findByText('暂无歌词')).toBeTruthy()
    expect(api.list).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '歌词' }).getAttribute('aria-pressed')).toBe('true')
  })
})
