// ---------------------------------------------------------------------------
// Task 14：曲库页面与歌曲列表
//
// 覆盖简报 Step 1/3/4 与控制器追加要求 A–N 中**可测**的部分：
// - D：SongList 的单击选中 / 双击播放 / Ctrl 多选 / Shift 连选 / ↑↓ 导航；
// - E + K：虚拟滚动的裁剪、行高与可视区高度**可注入**、DOM 节点数与数据总量不成正比；
// - J：封面 URL 的**唯一**拼装点、空 coverId 走占位、加载失败走占位；
// - L：libraryStore 的追加语义、同页幂等、loading 标志；
// - M：六个页面能独立挂载（注入 API），且加载中 / 失败 / 空列表都有可读呈现；
// - A：专辑网格的 DOM 节点数与数据总量不成正比。
//
// ⚠️ 测试里一律用占位数据（「歌一」「示例专辑」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名 / 真实专辑名**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'
import { SongList, SONG_ROW_HEIGHT, SONG_LIST_BUFFER_ROWS } from '../src/components/SongList'
import { CoverImage } from '../src/components/Cards'
import { coverUrl, COVER_SIZE_DEFAULT } from '../src/components/coverUrl'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'
import { AlbumsPage } from '../src/pages/AlbumsPage'
import { ArtistsPage } from '../src/pages/ArtistsPage'
import { GenresPage } from '../src/pages/GenresPage'
import { PlaylistsPage } from '../src/pages/PlaylistsPage'
import { SongsPage } from '../src/pages/SongsPage'
import { FavoritesPage } from '../src/pages/FavoritesPage'

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

/** 四首占位歌曲（标题用「歌一」…便于按文本查找）。 */
const SONGS: Song[] = [
  makeSong(1, { id: '1', title: '歌一' }),
  makeSong(2, { id: '2', title: '歌二' }),
  makeSong(3, { id: '3', title: '歌三' }),
  makeSong(4, { id: '4', title: '歌四' }),
]

/** 一张占位专辑。 */
const ALBUM: Album = {
  id: 'album-1',
  title: '示例专辑',
  artist: '甲',
  artistId: '',
  coverId: null,
  year: null,
  trackCount: 3,
}

/** 一位占位歌手。 */
const ARTIST: Artist = {
  id: 'artist-1',
  name: '示例歌手',
  coverId: null,
  albumCount: 1,
  trackCount: 3,
}

/** 一个占位风格。 */
const GENRE: Genre = {
  guid: 'genre-1',
  name: '示例风格',
  coverId: null,
  trackCount: 3,
}

/** 一个占位歌单。 */
const PLAYLIST: Playlist = {
  id: 'playlist-1',
  name: '示例歌单',
  coverId: null,
  trackCount: 3,
}

/**
 * 造一个假的曲库 API。
 *
 * 默认全部返回空页；各用例按需覆盖。
 */
function createFakeApi(overrides: Partial<LibraryApi> = {}): LibraryApi {
  const base: LibraryApi = {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as Genre[], total: 0 })),
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    favorites: vi.fn(async () => [] as Song[]),
    playlists: vi.fn(async () => [] as Playlist[]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
  }
  return { ...base, ...overrides }
}

/**
 * 造一个「手动兑现」的 Promise（用来观察请求进行中的状态）。
 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 递归列出目录下的所有文件。 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

/**
 * 封面路径的字面量。
 *
 * ⚠️ 这里**故意拆成两段拼接**：要求 J 规定「全项目只有 `src/components/coverUrl.ts`
 *    拼装封面地址，复审会 grep」——如果测试文件里也写出连续的封面路径字面量，
 *    那次 grep 就会把测试文件也算进去。故此处用 `join` 拼出来，
 *    既能扫描源码，又不会在测试文件里留下连续字面量。
 */
const COVER_PATH_LITERAL = ['static', 'cover'].join('/')

/**
 * 仓库根目录（**不依赖 `process.cwd()`**）。
 *
 * ⚠️ 用 `process.cwd()` 锚定时，cwd ≠ 仓库根（例如从别的目录跑 vitest），
 *    扫描的就是别的目录 → 断言**空转通过**（既没扫到东西，也没报错）。
 *    这里从**本测试文件自身的位置**推导仓库根，与 cwd 无关。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 源码目录（扫描目标）。 */
const SRC_DIR = join(REPO_ROOT, 'src')

// ---------------------------------------------------------------------------
// SongList 交互语义（要求 D）
// ---------------------------------------------------------------------------

describe('SongList 交互语义', () => {
  it('双击行触发 onPlay，index 是该歌在 songs 里的真实下标', () => {
    const onPlay = vi.fn()
    render(<SongList songs={SONGS} onPlay={onPlay} />)

    fireEvent.doubleClick(screen.getByText('歌二'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onPlay).toHaveBeenCalledWith(SONGS[1], 1)
  })

  it('单击行选中该行并回调 onSelect', () => {
    const onSelect = vi.fn()
    render(<SongList songs={SONGS} onPlay={vi.fn()} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('歌一'))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith(['1'])
  })

  it('Ctrl + 单击切换选中态（多选），onSelect 的 id 按 songs 原始顺序', () => {
    const onSelect = vi.fn()
    render(<SongList songs={SONGS} onPlay={vi.fn()} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('歌三'))
    fireEvent.click(screen.getByText('歌一'), { ctrlKey: true })

    expect(onSelect).toHaveBeenLastCalledWith(['1', '3'])
  })

  it('Shift + 单击从上一次锚点连选到该行', () => {
    const onSelect = vi.fn()
    render(<SongList songs={SONGS} onPlay={vi.fn()} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('歌一'))
    fireEvent.click(screen.getByText('歌四'), { shiftKey: true })

    expect(onSelect).toHaveBeenLastCalledWith(['1', '2', '3', '4'])
  })

  it('↑ / ↓ 移动选中行；到边界停住（不越界、不重复回调）', () => {
    const onSelect = vi.fn()
    render(<SongList songs={SONGS} onPlay={vi.fn()} onSelect={onSelect} />)
    const viewport = screen.getByRole('listbox')

    // ↓：从第一行移到第二行
    fireEvent.click(screen.getByText('歌一'))
    fireEvent.keyDown(viewport, { key: 'ArrowDown' })
    expect(onSelect).toHaveBeenLastCalledWith(['2'])

    // ↑：回到第一行
    fireEvent.keyDown(viewport, { key: 'ArrowUp' })
    expect(onSelect).toHaveBeenLastCalledWith(['1'])

    // ↑：已在第一行 → 停住，**不再**回调
    const calls = onSelect.mock.calls.length
    fireEvent.keyDown(viewport, { key: 'ArrowUp' })
    expect(onSelect.mock.calls.length).toBe(calls)
  })

  it('没有任何选中项时不调用 onSelect；Ctrl 取消最后一项时传空数组', () => {
    const onSelect = vi.fn()
    render(<SongList songs={SONGS} onPlay={vi.fn()} onSelect={onSelect} />)

    // 初始（无选中）不回调
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('歌一'))
    expect(onSelect).toHaveBeenLastCalledWith(['1'])

    fireEvent.click(screen.getByText('歌一'), { ctrlKey: true })
    expect(onSelect).toHaveBeenLastCalledWith([])
  })

  it('键盘移动后把目标行滚进可视区', () => {
    // 注入一个只有一行高的可视区：第二行本来在可视区之外
    render(<SongList songs={SONGS} onPlay={vi.fn()} viewportHeight={SONG_ROW_HEIGHT} />)
    const viewport = screen.getByRole('listbox')

    fireEvent.click(screen.getByText('歌一'))
    fireEvent.keyDown(viewport, { key: 'ArrowDown' })

    // 滚动偏移被记录在 data-scroll-top 上（jsdom 里 scrollTop 赋值可能是空操作）
    expect(Number(viewport.getAttribute('data-scroll-top'))).toBeGreaterThan(0)
  })

  it('单击行后焦点随之移到该行', () => {
    render(<SongList songs={SONGS} onPlay={vi.fn()} />)
    const row = screen.getByText('歌二').closest('[role="option"]')

    fireEvent.click(screen.getByText('歌二'))

    expect(document.activeElement).toBe(row)
  })

  it('展示「已加载 / 总共」', () => {
    render(<SongList songs={SONGS} onPlay={vi.fn()} total={173669} />)
    expect(screen.getByText('已加载 4 / 173,669')).toBeTruthy()
  })

  it('空列表有可读的空态提示（不是白屏）', () => {
    render(<SongList songs={[]} onPlay={vi.fn()} />)
    expect(screen.getByText('暂无歌曲')).toBeTruthy()
  })

  it('空列表时**也**渲染状态行（已加载 0 / 总共 N）', () => {
    render(<SongList songs={[]} onPlay={vi.fn()} total={173669} />)
    expect(screen.getByText('已加载 0 / 173,669')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 虚拟滚动（要求 A / E / K）
// ---------------------------------------------------------------------------

describe('SongList 虚拟滚动', () => {
  it('1000 首歌时渲染的行元素数远小于总量（DOM 节点数与数据量不成正比）', () => {
    const many = Array.from({ length: 1000 }, (_, i) => makeSong(i))
    const { container } = render(<SongList songs={many} onPlay={vi.fn()} />)

    const rows = container.querySelectorAll('[role="option"]')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(100)
  })

  it('注入可视区高度后只渲染「可视区 + 缓冲」的行', () => {
    const many = Array.from({ length: 1000 }, (_, i) => makeSong(i))
    const { container } = render(
      <SongList songs={many} onPlay={vi.fn()} viewportHeight={SONG_ROW_HEIGHT * 10} />,
    )

    const rows = container.querySelectorAll('[role="option"]')
    // 可视区 10 行 + 下方缓冲 5 行（上方缓冲为 0，因为还没滚动）
    expect(rows.length).toBe(10 + SONG_LIST_BUFFER_ROWS)
    expect(rows.length).toBeLessThan(many.length)
  })

  it('滚动后渲染窗口随之移动（裁剪而不是全量铺开）', () => {
    const many = Array.from({ length: 1000 }, (_, i) => makeSong(i))
    const { container } = render(<SongList songs={many} onPlay={vi.fn()} />)
    const viewport = screen.getByRole('listbox')

    // jsdom 没有布局引擎，scrollTop 需要手动定义后再派发 scroll 事件
    Object.defineProperty(viewport, 'scrollTop', {
      value: SONG_ROW_HEIGHT * 100,
      writable: true,
      configurable: true,
    })
    fireEvent.scroll(viewport)

    const rows = Array.from(container.querySelectorAll('[role="option"]'))
    expect(rows[0]?.getAttribute('data-index')).toBe(String(100 - SONG_LIST_BUFFER_ROWS))
    expect(rows.length).toBeLessThan(100)
  })

  it('双击被裁剪掉的行时仍传真实下标', () => {
    const many = Array.from({ length: 1000 }, (_, i) => makeSong(i))
    const onPlay = vi.fn()
    render(<SongList songs={many} onPlay={onPlay} />)
    const viewport = screen.getByRole('listbox')

    Object.defineProperty(viewport, 'scrollTop', {
      value: SONG_ROW_HEIGHT * 100,
      writable: true,
      configurable: true,
    })
    fireEvent.scroll(viewport)

    // 窗口里的第一行是真实下标 95
    const rows = screen.getAllByRole('option')
    fireEvent.doubleClick(rows[0] as HTMLElement)

    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onPlay.mock.calls[0]?.[1]).toBe(100 - SONG_LIST_BUFFER_ROWS)
  })
})

// ---------------------------------------------------------------------------
// 封面 URL 收敛点（要求 C / J）
// ---------------------------------------------------------------------------

describe('封面 URL 收敛点', () => {
  it('coverId 为空串（Song）或 null（Album/Artist/Genre）时返回 null', () => {
    expect(coverUrl('')).toBeNull()
    expect(coverUrl(null)).toBeNull()
    expect(coverUrl(undefined)).toBeNull()
    expect(coverUrl('   ')).toBeNull()
  })

  it('默认 size 取具名常量', () => {
    expect(COVER_SIZE_DEFAULT).toBe(200)
    expect(coverUrl('track_abc123')).toContain(`size=${COVER_SIZE_DEFAULT}`)
  })

  it('coverId 与 size 都被转义 / 归一', () => {
    expect(coverUrl('track_a b')).toContain('coverId=track_a%20b')
    expect(coverUrl('track_abc', 320)).toContain('size=320')
    expect(coverUrl('track_abc', Number.NaN)).toContain(`size=${COVER_SIZE_DEFAULT}`)
  })

  it('URL 形如 fnm://srv/... 且带 coverId 与 size 查询参数', () => {
    const url = coverUrl('track_abc123')
    expect(url).not.toBeNull()
    expect(url?.startsWith('fnm://srv/')).toBe(true)
    expect(url).toContain('coverId=track_abc123')
    expect(url).toContain('size=')
  })

  it('全项目只有 src/components/coverUrl.ts 拼装封面地址', () => {
    // ⚠️ 先确认扫描目录**确实**是仓库的 src（否则下面的断言会空转通过）。
    expect(existsSync(join(SRC_DIR, 'components', 'coverUrl.ts'))).toBe(true)
    expect(listFiles(SRC_DIR).length).toBeGreaterThan(0)

    // ⚠️ **严格全文扫描**（不去注释）：注释里也不许出现封面路径字面量——
    //    「只有一处拼装」的约束对**注释**同样成立（否则注释可以随便抄一份地址）。
    const hits = listFiles(SRC_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes(COVER_PATH_LITERAL))
      .map((file) => relative(SRC_DIR, file).split(sep).join('/'))
      .sort()
    expect(hits).toEqual(['components/coverUrl.ts'])
  })
})

describe('封面占位', () => {
  it('coverId 为空时不渲染 <img>，改渲染占位块', () => {
    const { container } = render(<CoverImage coverId="" alt="封面" />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('cover-placeholder')).toBeTruthy()
  })

  it('封面加载失败时切成占位块（不留浏览器默认破图）', () => {
    const { container } = render(<CoverImage coverId="track_abc123" alt="封面" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()

    fireEvent.error(img as HTMLImageElement)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('cover-placeholder')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// libraryStore（要求 F / L）
// ---------------------------------------------------------------------------

describe('libraryStore', () => {
  it('loadAlbums 是追加语义：第二页接在第一页之后，不清空', async () => {
    const api = createFakeApi({
      albums: vi.fn(async (page: number) => ({
        list: page === 1 ? [ALBUM] : [{ ...ALBUM, id: 'album-2', title: '示例专辑二' }],
        total: 2,
      })),
    })
    const store = createLibraryStore(api)

    await store.getState().loadAlbums(1)
    await store.getState().loadAlbums(2)

    const state = store.getState().albums
    expect(state.items).toHaveLength(2)
    expect(state.items.map((item) => item.id)).toEqual(['album-1', 'album-2'])
    expect(state.total).toBe(2)
    expect(state.hasMore).toBe(false)
    expect(state.loading).toBe(false)
  })

  it('同一页重复请求是幂等的（不重复追加、不重复发请求）', async () => {
    const api = createFakeApi({
      albums: vi.fn(async () => ({ list: [ALBUM], total: 1 })),
    })
    const store = createLibraryStore(api)

    await store.getState().loadAlbums(1)
    await store.getState().loadAlbums(1)

    expect(api.albums).toHaveBeenCalledTimes(1)
    expect(store.getState().albums.items).toHaveLength(1)
  })

  it('请求期间 loading 为 true，且不会重复触发同一页', async () => {
    const deferred = createDeferred<{ list: Album[]; total: number }>()
    const api = createFakeApi({
      albums: vi.fn(() => deferred.promise),
    })
    const store = createLibraryStore(api)

    const pending = store.getState().loadAlbums(1)
    expect(store.getState().albums.loading).toBe(true)

    // 加载中重复触发同一页 → 直接返回，不发第二次请求
    await store.getState().loadAlbums(1)
    expect(api.albums).toHaveBeenCalledTimes(1)

    deferred.resolve({ list: [ALBUM], total: 1 })
    await pending

    expect(store.getState().albums.loading).toBe(false)
    expect(store.getState().albums.items).toHaveLength(1)
  })

  it('加载失败时保留已加载的数据并记录错误', async () => {
    const api = createFakeApi({
      albums: vi
        .fn()
        .mockResolvedValueOnce({ list: [ALBUM], total: 2 })
        .mockRejectedValueOnce(new Error('服务器响应异常（HTTP 500）')),
    })
    const store = createLibraryStore(api)

    await store.getState().loadAlbums(1)
    await store.getState().loadAlbums(2)

    const state = store.getState().albums
    expect(state.items).toHaveLength(1)
    expect(state.error).toContain('服务器响应异常')
    expect(state.loading).toBe(false)
  })

  it('收藏是全量接口：重复 load 不会把已加载的数据清空重来', async () => {
    const api = createFakeApi({
      favorites: vi.fn(async () => [SONGS[0] as Song, SONGS[1] as Song]),
    })
    const store = createLibraryStore(api)

    await store.getState().loadFavorites()
    await store.getState().loadFavorites()

    expect(store.getState().favorites.items).toHaveLength(2)
    expect(store.getState().favorites.total).toBe(2)
  })

  it('store 里没有任何凭证字段', async () => {
    const store = createLibraryStore(createFakeApi())
    const dump = JSON.stringify(store.getState(), (key, value) =>
      typeof value === 'function' ? undefined : value,
    )
    expect(dump).not.toMatch(/token|password|cookie/i)
  })
})

// ---------------------------------------------------------------------------
// 页面组件（要求 M / N）
// ---------------------------------------------------------------------------

describe('曲库页面', () => {
  it('AlbumsPage：加载中、失败、空列表、可渲染四种状态都有可读呈现', async () => {
    // 加载中
    const pendingApi = createFakeApi({
      albums: vi.fn(() => new Promise<{ list: Album[]; total: number }>(() => {})),
    })
    const { unmount } = render(<AlbumsPage api={pendingApi} />)
    expect(screen.getByText('正在加载专辑…')).toBeTruthy()
    unmount()

    // 失败
    const failedApi = createFakeApi({
      albums: vi.fn(async () => {
        throw new Error('服务器响应异常（HTTP 500）')
      }),
    })
    const { unmount: unmount2 } = render(<AlbumsPage api={failedApi} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/加载失败/)).toBeTruthy()
    unmount2()

    // 空列表
    const emptyApi = createFakeApi()
    render(<AlbumsPage api={emptyApi} />)
    expect(await screen.findByText('暂无专辑')).toBeTruthy()
  })

  it('AlbumsPage：渲染专辑卡片，且卡片数与数据总量不成正比', async () => {
    const many: Album[] = Array.from({ length: 2000 }, (_, i) => ({
      ...ALBUM,
      id: `album-${i}`,
      title: `示例专辑${i}`,
    }))
    const store = createLibraryStore(createFakeApi())
    store.setState({
      albums: {
        items: many,
        total: 34071,
        loading: false,
        hasMore: true,
        error: null,
        loaded: true,
        // 页码簿记的对外视图：已加载第 1 页 → 下一个该请求第 2 页。
        nextPage: 2,
        // 分页护栏的计数：还没有任何一页「无进展」。
        noProgressPages: 0,
        stalled: false,
      },
    })

    const { container } = render(<AlbumsPage store={store} />)

    await waitFor(() => expect(container.querySelectorAll('[data-testid="fnm-card"]').length).toBeGreaterThan(0))
    expect(container.querySelectorAll('[data-testid="fnm-card"]').length).toBeLessThan(100)
  })

  it('ArtistsPage / GenresPage / PlaylistsPage：能独立挂载并渲染各自的数据', async () => {
    const api = createFakeApi({
      artists: vi.fn(async () => ({ list: [ARTIST], total: 1 })),
      genres: vi.fn(async () => ({ list: [GENRE], total: 1 })),
      // ⚠️ 歌单是**全量**接口：返回数组，不是分页信封
      playlists: vi.fn(async () => [PLAYLIST]),
    })

    const artists = render(<ArtistsPage api={api} />)
    expect(await screen.findByText('示例歌手')).toBeTruthy()
    artists.unmount()

    const genres = render(<GenresPage api={api} />)
    expect(await screen.findByText('示例风格')).toBeTruthy()
    genres.unmount()

    const playlists = render(<PlaylistsPage api={api} />)
    expect(await screen.findByText('示例歌单')).toBeTruthy()
  })

  it('SongsPage：渲染歌曲行', async () => {
    const api = createFakeApi({
      songs: vi.fn(async () => ({ list: [SONGS[0] as Song], total: 1 })),
    })
    render(<SongsPage api={api} />)
    expect(await screen.findByText('歌一')).toBeTruthy()
  })

  it('FavoritesPage：渲染收藏的歌曲', async () => {
    const api = createFakeApi({
      favorites: vi.fn(async () => [SONGS[2] as Song]),
    })
    render(<FavoritesPage api={api} />)
    expect(await screen.findByText('歌三')).toBeTruthy()
  })

  it('PlaylistsPage：选中歌单后按分页加载歌单内的歌曲', async () => {
    const api = createFakeApi({
      playlists: vi.fn(async () => [PLAYLIST]),
      playlistSongs: vi.fn(async () => ({ list: [SONGS[0] as Song], total: 1 })),
    })
    render(<PlaylistsPage api={api} />)

    const card = await screen.findByText('示例歌单')
    fireEvent.click(card)

    expect(await screen.findByText('歌一')).toBeTruthy()
    expect(api.playlistSongs).toHaveBeenCalledWith('playlist-1', expect.any(Number), expect.any(Number))
  })
})

// ---------------------------------------------------------------------------
// 增量翻页（OF-01：页码簿记必须暴露成状态，页面**不许**从 items.length 反推）
//
// ⚠️ 这三条用例守护的是**页面层**的增量加载触发：
//    - 服务端某页返回条数少于 `pageSize`（短页）；
//    - 相邻两页出现重复 id（去重后不足整页）；
//    - 一次滚到底只追加**一页**。
//
//    三者在「用 `Math.floor(items.length / pageSize) + 1` 反推页码」的实现下
//    都会**永久卡死**：反推出的页码退回已加载过的页 → store 的页码幂等守卫
//    把它变成空操作 → `hasMore` 仍为 true，但列表永远停在原地。
// ---------------------------------------------------------------------------

describe('曲库页面的增量翻页', () => {
  /** jsdom 没有布局引擎：`scrollTop` 必须手工定死。 */
  function pinScrollTop(element: HTMLElement, value: number): void {
    Object.defineProperty(element, 'scrollTop', {
      value,
      writable: true,
      configurable: true,
    })
  }

  /** 等当前这页请求结束（`loading` 回到 false）。 */
  async function waitForIdle(
    store: ReturnType<typeof createLibraryStore>,
    key: 'songs' | 'albums',
  ): Promise<void> {
    await waitFor(() => expect(store.getState()[key].loading).toBe(false))
  }

  it('服务端返回短页（少于 pageSize）时仍能翻到下一页', async () => {
    // 每页只给 20 条（`pageSize` 是 50）——反推页码会退回第 1 页 → 永久卡死。
    const api = createFakeApi({
      songs: vi.fn(async (page: number) => ({
        list: Array.from({ length: 20 }, (_, i) => makeSong((page - 1) * 20 + i)),
        total: 100,
      })),
    })
    const store = createLibraryStore(api)
    render(<SongsPage store={store} />)
    await waitFor(() => expect(store.getState().songs.items).toHaveLength(20))

    const viewport = screen.getByRole('listbox')
    pinScrollTop(viewport, 10_000)
    fireEvent.scroll(viewport)

    // 必须请求**第 2 页**（反推页码的实现会一直请求第 1 页 → 被幂等守卫吞掉）。
    await waitFor(() => expect(api.songs).toHaveBeenCalledWith(2, 50))
    await waitForIdle(store, 'songs')
    expect(store.getState().songs.items).toHaveLength(40)
  })

  it('相邻两页出现重复 id 时仍能翻到下一页', async () => {
    // 第 2 页返回与第 1 页**完全相同**的 50 个 id → 去重后 items 不增长。
    const firstPage = Array.from({ length: 50 }, (_, i) => makeSong(i))
    const api = createFakeApi({
      songs: vi.fn(async () => ({ list: firstPage, total: 100 })),
    })
    const store = createLibraryStore(api)
    render(<SongsPage store={store} />)
    await waitFor(() => expect(store.getState().songs.items).toHaveLength(50))

    const viewport = screen.getByRole('listbox')
    pinScrollTop(viewport, 10_000)

    fireEvent.scroll(viewport)
    await waitFor(() => expect(api.songs).toHaveBeenCalledWith(2, 50))
    await waitForIdle(store, 'songs')
    // 重复 id → 条数不增长（这是对的），但**页码必须继续往前推**。
    expect(store.getState().songs.items).toHaveLength(50)

    // 再滚一次 → 必须请求**第 3 页**（反推页码的实现会永远停在第 2 页）。
    fireEvent.scroll(viewport)
    await waitFor(() => expect(api.songs).toHaveBeenCalledWith(3, 50))
  })

  it('滚动到底只追加一页（一次滚动不多拉）', async () => {
    const api = createFakeApi({
      albums: vi.fn(async (page: number) => ({
        list: Array.from({ length: 20 }, (_, i) => ({
          ...ALBUM,
          id: `album-${(page - 1) * 20 + i}`,
          title: `示例专辑${(page - 1) * 20 + i}`,
        })),
        total: 100,
      })),
    })
    const store = createLibraryStore(api)
    render(<AlbumsPage store={store} />)
    await waitFor(() => expect(store.getState().albums.items).toHaveLength(20))

    const grid = screen.getByRole('list')
    pinScrollTop(grid, 10_000)
    fireEvent.scroll(grid)

    await waitFor(() => expect(api.albums).toHaveBeenCalledWith(2, 50))
    await waitForIdle(store, 'albums')
    // 一次滚动 → **恰好一页**（既不追加零页，也不追加两页）。
    expect(store.getState().albums.items).toHaveLength(40)
    expect(api.albums).toHaveBeenCalledTimes(2)
  })
})
