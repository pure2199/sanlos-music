// ---------------------------------------------------------------------------
// T98：「有声读物」页的组件级测试
//
// ⚠️ 钉住的行为（**每一条都是真机复验后才想清楚的**）：
// 1. **进页面不能自动扫全库**（实测 87 页 / 6–47 分钟）⇒ 只读落盘、不发请求；
// 2. 点「扫描曲库」⇒ 真的开始扫；点「从头重扫」⇒ 明确**从头**来；
// 3. 扫描中两个按钮都**禁用**（别让人重复触发）；
// 4. 文案里**不许漏出 Markdown 星号**（`识别只看**结构**` 那种）。
// ---------------------------------------------------------------------------

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanLibraryTracks } = vi.hoisted(() => ({ scanLibraryTracks: vi.fn() }))

vi.mock('../src/api/library', () => ({ scanLibraryTracks }))

import { AudiobooksPage } from '../src/pages/AudiobooksPage'
import { useAudiobookStore } from '../src/state/audiobookStore'

describe('AudiobooksPage（有声读物页）', () => {
  beforeEach(() => {
    scanLibraryTracks.mockReset()
    scanLibraryTracks.mockImplementation(async () => ({
      scanned: 0,
      total: 0,
      pages: 0,
      stoppedAtWatermark: false,
    }))
    useAudiobookStore.setState({
      hits: [],
      overrides: {},
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

  it('② 点「扫描曲库」⇒ 真的开始扫', async () => {
    render(<AudiobooksPage onOpenAlbum={() => {}} />)
    fireEvent.click(screen.getByText('扫描曲库'))
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
    const hint = container.querySelector('.fnm-audiobooks__hint')
    expect(hint?.textContent ?? '').not.toContain('*')
  })
})
