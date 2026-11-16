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

const { scanLibraryTracks } = vi.hoisted(() => ({ scanLibraryTracks: vi.fn() }))
const { searchApi } = vi.hoisted(() => ({ searchApi: { albums: vi.fn() } }))

vi.mock('../src/api/library', () => ({ scanLibraryTracks }))
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
    useAudiobookStore.setState({
      hits: [],
      overrides: {},
      keyword: '有声小说',
      scanning: false,
      progress: null,
      error: null,
      scannedAt: null,
    })
    window.localStorage.clear()
  })

  it('① 进页面**不自动扫描**（一个请求都不发）', async () => {
    render(<AudiobooksPage onOpenAlbum={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('还没扫描过')).toBeTruthy()
    })
    expect(scanLibraryTracks).not.toHaveBeenCalled()
  })

  it('② 点「扫描这个目录」⇒ 真的开始扫', async () => {
    render(<AudiobooksPage onOpenAlbum={() => {}} />)
    fireEvent.click(screen.getByText('扫描这个目录'))
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    })
  })

  it('③ 点「从头重扫」⇒ 明确从头来（`full: true`）', async () => {
    render(<AudiobooksPage onOpenAlbum={() => {}} />)
    fireEvent.click(screen.getByText('从头重扫'))
    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    })
    const options = scanLibraryTracks.mock.calls[0]?.[0] as { startPage: number } | undefined
    expect(options?.startPage).toBe(1)
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

  it('⑥ 「搜作品」⇒ 打专辑搜索并列出结果（**不扫曲库**）', async () => {
    searchApi.albums.mockResolvedValue({ list: [FOUND_ALBUM], total: 1 })
    render(<AudiobooksPage onOpenAlbum={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('输入作品名，例如：牧神记'), {
      target: { value: '牧神记' },
    })
    fireEvent.click(screen.getByText('搜作品'))

    await waitFor(() => {
      expect(searchApi.albums).toHaveBeenCalledWith('牧神记')
    })
    expect(await screen.findByText('牧神记')).toBeTruthy()
    // ⚠️ 搜作品这条路径**不许**触发全库扫描。
    expect(scanLibraryTracks).not.toHaveBeenCalled()
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
    fireEvent.click(screen.getByText('扫描这个目录'))

    await waitFor(() => {
      expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    })
    // ⚠ 默认关键字是「有声小说」⇒ 若用户输入的没生效，这条曲目**不该**被选中。
    await waitFor(() => {
      expect(useAudiobookStore.getState().hits).toHaveLength(1)
    })
    expect(useAudiobookStore.getState().hits[0]?.albumId).toBe('al-1')
    expect(useAudiobookStore.getState().keyword).toBe('我的有声书')
  })
})
