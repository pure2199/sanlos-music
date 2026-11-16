// ---------------------------------------------------------------------------
// T98：「有声读物」页的组件级测试
//
// ⚠️ 钉住的行为（**每一条都是真机复验后才想清楚的**）：
// 1. **进页面不能自动扫全库**（实测 87 页 ⇒ 并发约 1 分钟）⇒ 只读落盘、不发请求；
// 2. 点「扫描这个目录」⇒ 真的开始扫；点「从头重扫」⇒ 明确**从头**来；
// 3. 扫描中两个按钮都**禁用**（别让人重复触发）；
// 4. 文案里**不许漏出 Markdown 星号**（`识别只看**结构**` 那种）。
//
// ⚠️ **v3 改版**（用户实机反馈「有声做得不行」之后）：
// 5. **作品名秒搜**：点「搜作品」⇒ 打 `/search/album` ⇒ 出结果；
// 6. 点搜到的作品 ⇒ **记成「有声」**（用户指认）+ 下钻详情页；
// 7. **目录关键字可改** ⇒ 扫描时用的是**用户输入的那个**。
//
// ⚠️ **按钮文案改过**（v2「扫描曲库」⇒ v3「扫描这个目录」）：
//    这是**用户显式要求**改的（前提被推翻）⇒ 断言**改写为新行为**（见 ②），
//    其余断言一条没删、也没弱化。
// ---------------------------------------------------------------------------

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanLibraryTracks, albumWorkDir, album } = vi.hoisted(() => ({
  scanLibraryTracks: vi.fn(),
  albumWorkDir: vi.fn(),
  album: vi.fn(),
}))
const { searchApi } = vi.hoisted(() => ({ searchApi: { albums: vi.fn() } }))

// ⚠️ **T101**：多了一个 `libraryApi.album`（旧落盘没有封面时**补拉一次**封面）。
vi.mock('../src/api/library', () => ({ scanLibraryTracks, libraryApi: { albumWorkDir, album } }))
vi.mock('../src/api/search', () => ({ searchApi }))

import { AudiobooksPage } from '../src/pages/AudiobooksPage'
import { useAudiobookStore } from '../src/state/audiobookStore'

/** 一张搜到的专辑（`Album` 的最小形状）。 */
const FOUND_ALBUM = {
  id: 'al-1',
  title: '牧神记',
  artist: '宅猪',
  artistId: 'a-1',
  coverId: null,
  year: null,
  trackCount: 2762,
}

describe('AudiobooksPage（有声读物页）', () => {
  beforeEach(() => {
    scanLibraryTracks.mockReset()
    scanLibraryTracks.mockImplementation(async () => ({
      scanned: 0,
      total: 0,
      pages: 0,
      stoppedAtWatermark: false,
    }))
    searchApi.albums.mockReset()
    searchApi.albums.mockResolvedValue({ list: [], total: 0 })
    // ⚠️ T100：秒搜归并要**每个候选补拉 1 首**拿作品目录（拿不到 ⇒ 不归并）。
    albumWorkDir.mockReset()
    albumWorkDir.mockResolvedValue(null)
    // ⚠️ **T101**：补拉封面（拿不到 ⇒ 画占位块 ⇒ 不报错）。
    album.mockReset()
    album.mockResolvedValue(null)
    useAudiobookStore.setState({
      hits: [],
      overrides: {},
      keyword: '有声小说',
      scanning: false,
      progress: null,
      error: null,
      scannedAt: null,
      extraGroups: {},
    })
    window.localStorage.clear()
  })

  it('① 进页面**自动开扫**（用户不用点任何按钮；扫完落盘 ⇒ 之后秒开）', async () => {
    // ⚠️ **T100（2026-11-17）把这条用例的前提显式推翻了**：
    //    用户口径「不用点搜索、也不用点扫描」⇒ 进页面**自动开扫**
    //    ⇒ 断言**改写为新行为**（不弱化：从「一个请求都不发」变成「必须自动开扫」）。
    render(<AudiobooksPage onOpenAlbum={() => {}} />)
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    })
    // ⚠️ 自动扫用的是**当前目录关键字**（默认「有声小说」）。
    const options = scanLibraryTracks.mock.calls[0]?.[0] as
      | { startPage: number; keyword?: string }
      | undefined
    expect(options?.startPage).toBe(1)
  })

  it('② 点「扫描这个目录」⇒ 真的开始扫（**又**扫一次）', async () => {
    render(<AudiobooksPage onOpenAlbum={() => {}} />)
    // ⚠️ 进页面已经自动扫过一次 ⇒ 这里点按钮是**第二次**扫描。
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    })
    // ⚠️ 自动扫描期间按钮是「正在扫描…」（禁用）⇒ 先等它结束再点。
    await waitFor(() => {
      expect(useAudiobookStore.getState().scanning).toBe(false)
    })
    fireEvent.click(screen.getByText('扫描这个目录'))
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(2)
    })
  })

  it('③ 点「从头重扫」⇒ 明确从头来（`full: true`）', async () => {
    // ⚠️ 先埋一个**断点**（上次扫到第 2 页）⇒ 「续跑」会从第 2 页开始，
    //    而「从头重扫」必须从**第 1 页**开始 ⇒ 这样才真能区分两者。
    window.localStorage.setItem(
      'fnmusic-audiobook-state',
      JSON.stringify({
        version: 3,
        nextPage: 2,
        scannedCount: 100,
        total: 1000,
        candidates: {},
        overrides: {},
        keyword: '有声小说',
        scannedAt: 0,
      }),
    )
    render(<AudiobooksPage onOpenAlbum={() => {}} />)

    // 进页面**自动续跑**（从断点第 2 页接着来）。
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    })
    const resumed = scanLibraryTracks.mock.calls[0]?.[0] as { startPage: number } | undefined
    expect(resumed?.startPage).toBe(2)

    fireEvent.click(screen.getByText('从头重扫'))
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(2)
    })
    // ⭐ 「从头重扫」⇒ **从第 1 页**开始（忽略断点）。
    const full = scanLibraryTracks.mock.calls[1]?.[0] as { startPage: number } | undefined
    expect(full?.startPage).toBe(1)
  })

  it('④ 扫描中 ⇒ 两个按钮都禁用（别重复触发）', async () => {
    useAudiobookStore.setState({ scanning: true })
    render(<AudiobooksPage onOpenAlbum={() => {}} />)
    const scanButton = screen.getByText('正在扫描…') as HTMLButtonElement
    expect(scanButton.disabled).toBe(true)
    expect((screen.getByText('从头重扫') as HTMLButtonElement).disabled).toBe(true)
  })

  it('⑤ 文案里**不许漏出 Markdown 星号**', () => {
    const { container } = render(<AudiobooksPage onOpenAlbum={() => {}} />)
    const hints = Array.from(container.querySelectorAll('.fnm-audiobooks__hint'))
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) {
      expect(hint.textContent ?? '').not.toContain('*')
    }
  })

  it('⑥ 「搜作品」⇒ 打专辑搜索并列出结果（**搜索本身**不触发扫描）', async () => {
    searchApi.albums.mockResolvedValue({ list: [FOUND_ALBUM], total: 1 })
    render(<AudiobooksPage onOpenAlbum={() => {}} />)

    // ⚠️ 进页面**已经自动扫过一次**（T100）⇒ 这里记下当前的扫描次数，
    //    再断言「点搜索**不会**再多扫一次」（搜索这条路**自己**不扫曲库）。
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    })
    const before = scanLibraryTracks.mock.calls.length

    fireEvent.change(screen.getByPlaceholderText('输入作品名，例如：牧神记'), {
      target: { value: '牧神记' },
    })
    fireEvent.click(screen.getByText('搜作品'))

    await waitFor(() => {
      expect(searchApi.albums).toHaveBeenCalledWith('牧神记')
    })
    expect(await screen.findByText('牧神记')).toBeTruthy()
    // ⚠️ 搜作品这条路径**不许**触发全库扫描。
    expect(scanLibraryTracks.mock.calls.length).toBe(before)
  })

  it('⑦ 点搜到的作品 ⇒ 记成「有声」+ 下钻详情页', async () => {
    searchApi.albums.mockResolvedValue({ list: [FOUND_ALBUM], total: 1 })
    const opened: string[] = []
    render(<AudiobooksPage onOpenAlbum={(album) => opened.push(album.id)} />)

    fireEvent.change(screen.getByPlaceholderText('输入作品名，例如：牧神记'), {
      target: { value: '牧神记' },
    })
    fireEvent.click(screen.getByText('搜作品'))
    const result = await screen.findByText('牧神记')
    fireEvent.click(result)

    await waitFor(() => {
      expect(opened).toEqual(['al-1'])
    })
    // ⚠️ 用户**指认**了它 ⇒ 记成「有声」（详情页才会按集序排）。
    expect(useAudiobookStore.getState().isAudiobook('al-1')).toBe(true)
  })

  it('⑧ 目录关键字**可改** ⇒ 扫描时用的是用户输入的那个', async () => {
    scanLibraryTracks.mockImplementation(async (options: unknown) => {
      const opts = options as {
        onPage?: (tracks: unknown[], progress: unknown) => void
      }
      opts.onPage?.(
        [
          {
            id: 'x1',
            title: '01- 某集',
            albumId: 'al-1',
            albumTitle: '某作品',
            durationSec: 1900,
            trackNo: null,
            path: '/vol02/1000-0-我的有声书/作者/某作品/Disc 01/01.mp3',
            createdAt: null,
          },
        ],
        { page: 1, pages: 1, scanned: 1, total: 1 },
      )
      return { scanned: 1, total: 1, pages: 1, stoppedAtWatermark: false }
    })
    render(<AudiobooksPage onOpenAlbum={() => {}} />)

    fireEvent.change(screen.getByLabelText('目录名'), { target: { value: '我的有声书' } })
    // ⚠️ 自动扫描期间按钮是「正在扫描…」（禁用）⇒ 先等它结束再点。
    await waitFor(() => {
      expect(useAudiobookStore.getState().scanning).toBe(false)
    })
    fireEvent.click(screen.getByText('扫描这个目录'))

    // ⚠️ 进页面已自动扫过一次 ⇒ 这里是**第二次**扫描（用用户输入的关键字）。
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(2)
    })
    // ⚠ 默认关键字是「有声小说」⇒ 若用户输入的没生效，这条曲目**不该**被选中。
    await waitFor(() => {
      expect(useAudiobookStore.getState().hits).toHaveLength(1)
    })
    expect(useAudiobookStore.getState().hits[0]?.albumId).toBe('al-1')
    expect(useAudiobookStore.getState().keyword).toBe('我的有声书')
  })

  // -------------------------------------------------------------------------
  // T101：「有声」页改成专辑页同款的**封面卡片网格**
  //
  // ⚠️ **为什么这几条重要**：用户说「不能做成专辑页那样吗」⇒ 卡片**必须有封面**
  //    ⇒ 封面从哪来？三条路各测一条：
  //    - **扫描路径**：曲目的 `coverId` 顺手记下来（**零额外请求**）；
  //    - **秒搜路径**：`/search/album` **自带** `coverId`（**零额外请求**）；
  //    - **旧落盘**：没有封面 ⇒ 补拉**一次** `/album/detail` ⇒ **回写落盘**。
  // -------------------------------------------------------------------------

  it('⑨ 列表是**封面卡片网格**（专辑页同款 `.fnm-card`）+ 卡片**有封面**', async () => {
    scanLibraryTracks.mockImplementation(async (options: unknown) => {
      const opts = options as { onPage?: (tracks: unknown[], progress: unknown) => void }
      opts.onPage?.(
        [
          {
            id: 'g1',
            title: '01- 某集',
            albumId: 'al-1',
            albumTitle: '某作品',
            durationSec: 1900,
            trackNo: null,
            path: '/vol02/1000-0-有声小说/某作品/Disc 01/01.mp3',
            createdAt: null,
            // ⚠️ **T101**：曲目的封面（扫描时**顺手**记下来 ⇒ 不要钱）。
            coverId: 'track_0011223344556677',
          },
        ],
        { page: 1, pages: 1, scanned: 1, total: 1 },
      )
      return { scanned: 1, total: 1, pages: 1, stoppedAtWatermark: false }
    })

    const { container } = render(<AudiobooksPage onOpenAlbum={() => {}} />)

    await waitFor(() => {
      expect(container.querySelectorAll('.fnm-audiobooks__item').length).toBe(1)
    })
    const item = container.querySelector('.fnm-audiobooks__item') as HTMLElement
    // ⭐ 与专辑页**同款**的卡片结构（不是纯文字行）。
    expect(item.classList.contains('fnm-card')).toBe(true)
    expect(item.querySelector('.fnm-card__title')).not.toBeNull()
    // ⭐ 卡片**有封面**（不是占位块）。
    const img = item.querySelector('img.fnm-cover__image')
    expect(img?.getAttribute('src')).toContain('track_0011223344556677')
  })

  it('⑩ 旧落盘没有封面 ⇒ **补拉一次** `/album/detail` ⇒ 卡片出现封面（且**不重扫**）', async () => {
    window.localStorage.setItem(
      'fnmusic-audiobook-state',
      JSON.stringify({
        version: 3,
        nextPage: 0,
        scannedCount: 12,
        total: 12,
        candidates: {
          'al-old': {
            albumId: 'al-old',
            albumTitle: '旧作品',
            trackCount: 12,
            totalDurationSec: 12 * 1900,
            maxDurationSec: 1900,
            episodeStats: { ruleCounts: { 'dash-prefix': 12 }, titleCount: 12 },
            dirs: ['有声小说'],
            // ⚠️ **没有** `coverId`（T101 之前落盘的形状 ⇒ 旧用户不用重扫）。
          },
        },
        overrides: {},
        keyword: '有声小说',
        scannedAt: 1792563278000,
      }),
    )
    album.mockResolvedValue({
      id: 'al-old',
      title: '旧作品',
      artist: '',
      artistId: '',
      coverId: 'album_0011223344556677',
      year: null,
      trackCount: 12,
    })

    const { container } = render(<AudiobooksPage onOpenAlbum={() => {}} />)

    await waitFor(() => {
      expect(album).toHaveBeenCalledWith('al-old')
    })
    await waitFor(() => {
      const img = container.querySelector('.fnm-audiobooks__item img.fnm-cover__image')
      expect(img?.getAttribute('src')).toContain('album_0011223344556677')
    })
    // ⚠️ **不重扫**（旧落盘还在 ⇒ 不用再花 52 秒）。
    expect(scanLibraryTracks).not.toHaveBeenCalled()
  })

  it('⑪ 补拉封面**只做一次**（同一张专辑不会被反复拉）', async () => {
    window.localStorage.setItem(
      'fnmusic-audiobook-state',
      JSON.stringify({
        version: 3,
        nextPage: 0,
        scannedCount: 12,
        total: 12,
        candidates: {
          'al-old': {
            albumId: 'al-old',
            albumTitle: '旧作品',
            trackCount: 12,
            totalDurationSec: 12 * 1900,
            maxDurationSec: 1900,
            episodeStats: { ruleCounts: { 'dash-prefix': 12 }, titleCount: 12 },
            dirs: ['有声小说'],
          },
        },
        overrides: {},
        keyword: '有声小说',
        scannedAt: 1792563278000,
      }),
    )
    album.mockResolvedValue({
      id: 'al-old',
      title: '旧作品',
      artist: '',
      artistId: '',
      coverId: 'album_0011223344556677',
      year: null,
      trackCount: 12,
    })

    render(<AudiobooksPage onOpenAlbum={() => {}} />)

    await waitFor(() => {
      expect(album).toHaveBeenCalledTimes(1)
    })
    // 等一会儿（封面到货 ⇒ hits 变 ⇒ effect 重跑）⇒ **不该**有第二次。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(album).toHaveBeenCalledTimes(1)
  })

  it('⑫ 秒搜结果卡片**自带**封面（`/search/album` 就带着 ⇒ 零额外请求）', async () => {
    searchApi.albums.mockResolvedValue({
      list: [{ ...FOUND_ALBUM, coverId: 'album_0011223344556677' }],
      total: 1,
    })

    const { container } = render(<AudiobooksPage onOpenAlbum={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('输入作品名，例如：牧神记'), {
      target: { value: '牧神记' },
    })
    fireEvent.click(screen.getByText('搜作品'))

    await waitFor(() => {
      expect(container.querySelectorAll('.fnm-audiobooks__result').length).toBe(1)
    })
    const img = container.querySelector('.fnm-audiobooks__result img.fnm-cover__image')
    expect(img?.getAttribute('src')).toContain('album_0011223344556677')
  })
})
