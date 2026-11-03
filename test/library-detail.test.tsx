// ---------------------------------------------------------------------------
// Task 4（新版清单）：曲库详情下钻
//
// 覆盖三层：
// - **store 层**：下钻 = 换上下文（旧实体的数据必须清空）、幂等（StrictMode
//   双跑 effect）、**竞态**（旧实体的响应回来不得污染新实体，也不得把新实体
//   的第 1 页标记成「已加载」）；
// - **视图层**：专辑 / 歌手 / 风格三种详情视图各自渲染什么；
// - **整队口径**：详情页里双击曲目 → 传出**该详情页已加载的整队**。
//
// ⚠️ 测试里一律用占位数据（「歌一」「示例专辑」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名 / 真实专辑名**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import { DetailPage } from '../src/pages/DetailPage'
import type { Page } from '../src/api/types'

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

/** 造一张占位专辑。 */
function makeAlbum(index: number, overrides: Partial<Album> = {}): Album {
  return {
    id: `album-${index}`,
    title: `专辑${index}`,
    artist: '甲',
    artistId: '',
    coverId: null,
    year: 2000,
    trackCount: 2,
    ...overrides,
  }
}

const SONGS_A: Song[] = [makeSong(1, { id: 'a1' }), makeSong(2, { id: 'a2' })]
const SONGS_B: Song[] = [makeSong(3, { id: 'b1' }), makeSong(4, { id: 'b2' })]
const ALBUMS: Album[] = [makeAlbum(1, { id: 'alb-1', title: '专辑一' })]

/** 造一个假的曲库 API（默认各端点都返回空）。 */
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
  }
  return { ...base, ...overrides }
}

/** 让出一个宏任务（把定时器与微任务都放行）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 造一个手动兑现的 Promise（用来观察请求进行中的状态）。
 *
 * ⚠️ 用 `let resolve!:` 的**确定赋值断言**：赋值发生在 Promise 回调里，
 *    TS 的控制流分析看不到它 → 普通 `let` 会被窄化成 `never`。
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// store 层：下钻语义
// ---------------------------------------------------------------------------

describe('曲库详情下钻（store 层）', () => {
  it('下钻到专辑：同时拉专辑详情与专辑曲目', async () => {
    const api = createFakeApi({
      album: vi.fn(async () => makeAlbum(1, { id: 'alb-1', title: '详情标题' })),
      albumSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)

    await store.getState().openAlbum('alb-1')

    expect(api.album).toHaveBeenCalledWith('alb-1')
    expect(api.albumSongs).toHaveBeenCalledWith('alb-1', 1, expect.any(Number))
    expect(store.getState().detailKind).toBe('album')
    expect(store.getState().detailId).toBe('alb-1')
    expect(store.getState().albumDetail?.title).toBe('详情标题')
    expect(store.getState().albumSongs.items.map((s) => s.id)).toEqual(['a1', 'a2'])
  })

  it('下钻到歌手：同时拉该歌手的专辑与曲目', async () => {
    const api = createFakeApi({
      artistAlbums: vi.fn(async () => ({ list: ALBUMS, total: ALBUMS.length })),
      artistSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)

    await store.getState().openArtist('artist-1')

    expect(api.artistAlbums).toHaveBeenCalledWith('artist-1', 1, expect.any(Number))
    expect(api.artistSongs).toHaveBeenCalledWith('artist-1', 1, expect.any(Number))
    expect(store.getState().artistAlbums.items.map((a) => a.id)).toEqual(['alb-1'])
    expect(store.getState().artistSongs.items.map((s) => s.id)).toEqual(['a1', 'a2'])
  })

  it('下钻到风格：拉该风格的曲目', async () => {
    const api = createFakeApi({
      genreSongs: vi.fn(async () => ({ list: SONGS_B, total: SONGS_B.length })),
    })
    const store = createLibraryStore(api)

    await store.getState().openGenre('genre-1')

    expect(api.genreSongs).toHaveBeenCalledWith('genre-1', 1, expect.any(Number))
    expect(store.getState().genreSongs.items.map((s) => s.id)).toEqual(['b1', 'b2'])
  })

  it('切到另一个实体：旧实体的数据被清空（不残留）', async () => {
    const api = createFakeApi({
      albumSongs: vi.fn(async (id: string) =>
        id === 'alb-1' ? { list: SONGS_A, total: SONGS_A.length } : { list: SONGS_B, total: SONGS_B.length },
      ),
    })
    const store = createLibraryStore(api)

    await store.getState().openAlbum('alb-1')
    expect(store.getState().albumSongs.items.map((s) => s.id)).toEqual(['a1', 'a2'])

    await store.getState().openAlbum('alb-2')

    // ⚠️ 关键：新实体的列表里**不能**有旧实体的歌。
    expect(store.getState().albumSongs.items.map((s) => s.id)).toEqual(['b1', 'b2'])
  })

  it('重复下钻同一个实体是空操作（幂等，StrictMode 双跑 effect 不会重复请求）', async () => {
    const api = createFakeApi({
      albumSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)

    await store.getState().openAlbum('alb-1')
    await store.getState().openAlbum('alb-1')

    expect(api.albumSongs).toHaveBeenCalledTimes(1)
    expect(store.getState().albumSongs.items.map((s) => s.id)).toEqual(['a1', 'a2'])
  })

  it('竞态：旧实体的响应回来后既不污染新实体，也不把新实体的第 1 页标记成已加载', async () => {
    const old = deferred<Page<Song>>()
    const api = createFakeApi({
      albumSongs: vi.fn(async (id: string) => {
        if (id === 'alb-1') return old.promise
        return { list: SONGS_B, total: SONGS_B.length }
      }),
    })
    const store = createLibraryStore(api)

    // 旧专辑的请求挂起。
    const pending = store.getState().openAlbum('alb-1')
    // 新专辑正常完成。
    await store.getState().openAlbum('alb-2')
    expect(store.getState().albumSongs.items.map((s) => s.id)).toEqual(['b1', 'b2'])

    // 旧专辑的响应姗姗来迟。
    old.resolve({ list: SONGS_A, total: SONGS_A.length })
    await pending
    await tick()

    // ⚠️ 旧数据不得进新实体的列表。
    expect(store.getState().albumSongs.items.map((s) => s.id)).toEqual(['b1', 'b2'])
    // ⚠️ 更隐蔽的坑：旧响应若往**共用**簿记里写「第 1 页已加载」，
    //    新实体自己的第 1 页就会被幂等守卫吞掉 → 列表永远空白。
    expect(store.getState().albumSongs.total).toBe(SONGS_B.length)
    expect(store.getState().albumSongs.hasMore).toBe(false)
  })

  it('详情接口查不到时 albumDetail 为 null（不抛异常）', async () => {
    const api = createFakeApi({ album: vi.fn(async () => null) })
    const store = createLibraryStore(api)

    await store.getState().openAlbum('alb-x')

    expect(store.getState().albumDetail).toBeNull()
    expect(store.getState().albumDetailError).toBeNull()
  })

  it('详情接口报错时错误落在 albumDetailError 上，不影响曲目', async () => {
    const api = createFakeApi({
      album: vi.fn(async () => {
        throw new Error('详情接口炸了')
      }),
      albumSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)

    await store.getState().openAlbum('alb-1')

    expect(store.getState().albumDetailError).toBe('详情接口炸了')
    expect(store.getState().albumSongs.items.map((s) => s.id)).toEqual(['a1', 'a2'])
  })
})

// ---------------------------------------------------------------------------
// 视图层
// ---------------------------------------------------------------------------

describe('曲库详情页（视图层）', () => {
  it('专辑详情：显示专辑名与该专辑的曲目，双击传出整队', async () => {
    const api = createFakeApi({
      album: vi.fn(async () => makeAlbum(1, { id: 'alb-1', title: '示例专辑' })),
      albumSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)
    const onPlay = vi.fn()

    render(
      <DetailPage
        kind="album"
        entityId="alb-1"
        title="卡片上的标题"
        subtitle="甲"
        onBack={() => undefined}
        onPlay={onPlay}
        store={store}
      />,
    )

    await waitFor(() => expect(screen.getByText('歌1')).toBeTruthy())
    // 详情接口优先于卡片标题。
    expect(screen.getByRole('heading', { name: '示例专辑' })).toBeTruthy()

    fireEvent.doubleClick(screen.getByText('歌2'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0]!
    expect(call[0].id).toBe('a2')
    // 整队 = 该详情页**已加载**的全部曲目。
    expect((call[2] as Song[]).map((song) => song.id)).toEqual(['a1', 'a2'])
  })

  it('专辑详情：详情接口查不到时回退到卡片传来的标题', async () => {
    const api = createFakeApi({
      album: vi.fn(async () => null),
      albumSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)

    render(
      <DetailPage
        kind="album"
        entityId="alb-1"
        title="卡片上的标题"
        subtitle="甲"
        onBack={() => undefined}
        store={store}
      />,
    )

    await waitFor(() => expect(screen.getByRole('heading', { name: '卡片上的标题' })).toBeTruthy())
  })

  it('歌手详情：同时有专辑网格与曲目列表', async () => {
    const api = createFakeApi({
      artistAlbums: vi.fn(async () => ({ list: ALBUMS, total: ALBUMS.length })),
      artistSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)
    const onOpenAlbum = vi.fn()

    render(
      <DetailPage
        kind="artist"
        entityId="artist-1"
        title="示例歌手"
        subtitle="1 张专辑 · 2 首"
        onBack={() => undefined}
        onOpenAlbum={onOpenAlbum}
        store={store}
      />,
    )

    await waitFor(() => expect(screen.getByText('歌1')).toBeTruthy())
    expect(screen.getByText('专辑一')).toBeTruthy()

    // 歌手详情里的专辑卡片可以再往下钻一层。
    fireEvent.click(screen.getByText('专辑一'))
    expect(onOpenAlbum).toHaveBeenCalledTimes(1)
    expect(onOpenAlbum.mock.calls[0]![0].id).toBe('alb-1')
  })

  it('风格详情：显示该风格的曲目', async () => {
    const api = createFakeApi({
      genreSongs: vi.fn(async () => ({ list: SONGS_B, total: SONGS_B.length })),
    })
    const store = createLibraryStore(api)

    render(
      <DetailPage
        kind="genre"
        entityId="genre-1"
        title="示例风格"
        subtitle="2 首"
        onBack={() => undefined}
        store={store}
      />,
    )

    await waitFor(() => expect(screen.getByText('歌3')).toBeTruthy())
    expect(screen.queryByText('歌1')).toBeNull()
  })

  it('「返回」按钮回调 onBack', async () => {
    const api = createFakeApi({
      albumSongs: vi.fn(async () => ({ list: SONGS_A, total: SONGS_A.length })),
    })
    const store = createLibraryStore(api)
    const onBack = vi.fn()

    render(
      <DetailPage
        kind="album"
        entityId="alb-1"
        title="示例专辑"
        onBack={onBack}
        store={store}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('详情接口报错时页面给出错误提示而不是白屏', async () => {
    const api = createFakeApi({
      albumSongs: vi.fn(async () => {
        throw new Error('曲目拉取失败')
      }),
    })
    const store = createLibraryStore(api)

    render(
      <DetailPage
        kind="album"
        entityId="alb-1"
        title="示例专辑"
        onBack={() => undefined}
        store={store}
      />,
    )

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('曲目拉取失败'))
  })
})
