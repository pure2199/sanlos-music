// ---------------------------------------------------------------------------
// T27 批量下载
// ---------------------------------------------------------------------------
//
// 覆盖的是一处**真实缺口**：下载只能**逐首**点行内的「下载」按钮，
// 而 `SongList` 早就有多选接缝（Ctrl / Shift 点选）——
// 用户选好了 20 首，却只能一首一首点。
//
// 本文件钉：
// 1. `startMany`（store 层）：**幂等跳过**（已在本地 / 已在队列）、
//    单首失败**不影响其余**、无桥时不崩；
// 2. 工具条 UI：没选中**不渲染** / 选中显示「已选 N 首」/ 点「下载所选」真的发请求；
// 3. `useBatchSelection`：受控选中（页面知道选中了谁）、
//    **换列表就清空选中**（否则会下载上一张列表的歌）、外部回调不丢。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Song } from '../shared/types'
import type { DownloadEntry, DownloadTask, PlayerBridge } from '../shared/playerBridge'
import { useDownloadStore } from '../src/state/downloadStore'
import { BatchDownloadBar, describeBatchResult } from '../src/components/BatchDownloadBar'
import { useBatchSelection } from '../src/components/batchSelection'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(id: string, title: string): Song {
  return {
    id,
    title,
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

const SONG_A = makeSong('track_batch_a', '占位歌 A')
const SONG_B = makeSong('track_batch_b', '占位歌 B')
const SONG_C = makeSong('track_batch_c', '占位歌 C')

/** 已下载条目（占位）。 */
const ENTRY_A: DownloadEntry = {
  songId: SONG_A.id,
  file: 'C:\\Music\\飞牛音乐\\占位歌手 - 占位歌 A.flac',
  bytes: 2048,
  ext: 'flac',
  downloadedAt: '2026-01-01T00:00:00.000Z',
}

/** 假桥（记录下载调用；可指定某首会失败）。 */
function fakeBridge(failSongIds: string[] = []): {
  bridge: PlayerBridge
  started: string[]
} {
  const started: string[] = []
  const bridge = {
    pushState: async () => undefined,
    sendCommand: async () => undefined,
    onCommand: () => () => undefined,
    getPrefs: async () => ({ localFirst: true }),
    setPrefs: async () => ({}),
    setTheme: async () => ({}),
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
    pushLyricState: () => undefined,
    onLyricState: () => () => undefined,
    onLyricVisibility: () => () => undefined,
    setLyricVisible: async () => undefined,
    listDownloads: async () => ({ entries: {}, tasks: [] as DownloadTask[], dir: '' }),
    startDownload: async (request: { songId: string }) => {
      if (failSongIds.includes(request.songId)) {
        throw new Error('启动失败')
      }
      started.push(request.songId)
    },
    cancelDownload: async () => undefined,
    clearDownloads: async () => undefined,
    onDownloadChange: () => () => undefined,
  } as unknown as PlayerBridge
  return { bridge, started }
}

/** 装上假桥。 */
function install(bridge: PlayerBridge): void {
  ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
}

beforeEach(() => {
  delete (globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer
  useDownloadStore.setState({
    entries: {},
    tasks: {},
    localFirst: true,
    dir: '',
    error: null,
  })
})

// ---------------------------------------------------------------------------
// store 层：startMany
// ---------------------------------------------------------------------------

describe('批量下载：startMany', () => {
  it('全部排进队列（逐个发请求）', async () => {
    const fake = fakeBridge()
    install(fake.bridge)

    const result = await useDownloadStore.getState().startMany([SONG_A, SONG_B, SONG_C])

    expect(result).toEqual({ queued: 3, skipped: 0, failed: 0 })
    expect(fake.started).toEqual([SONG_A.id, SONG_B.id, SONG_C.id])
  })

  it('**已在本地**的跳过（不重复下载）', async () => {
    const fake = fakeBridge()
    install(fake.bridge)
    useDownloadStore.setState({ entries: { [SONG_A.id]: ENTRY_A } })

    const result = await useDownloadStore.getState().startMany([SONG_A, SONG_B])

    expect(result).toEqual({ queued: 1, skipped: 1, failed: 0 })
    expect(fake.started).toEqual([SONG_B.id])
  })

  it('**已在队列 / 下载中**的跳过', async () => {
    const fake = fakeBridge()
    install(fake.bridge)
    useDownloadStore.setState({
      tasks: {
        [SONG_A.id]: {
          songId: SONG_A.id,
          title: SONG_A.title,
          artist: SONG_A.artist,
          status: 'pending',
          received: 0,
          total: 0,
          error: null,
          file: null,
        },
        [SONG_B.id]: {
          songId: SONG_B.id,
          title: SONG_B.title,
          artist: SONG_B.artist,
          status: 'running',
          received: 10,
          total: 100,
          error: null,
          file: null,
        },
      },
    })

    const result = await useDownloadStore.getState().startMany([SONG_A, SONG_B, SONG_C])

    expect(result).toEqual({ queued: 1, skipped: 2, failed: 0 })
    expect(fake.started).toEqual([SONG_C.id])
  })

  it('单首失败**不影响其余**', async () => {
    const fake = fakeBridge([SONG_B.id])
    install(fake.bridge)

    const result = await useDownloadStore.getState().startMany([SONG_A, SONG_B, SONG_C])

    expect(result).toEqual({ queued: 2, skipped: 0, failed: 1 })
    expect(fake.started).toEqual([SONG_A.id, SONG_C.id])
    expect(useDownloadStore.getState().error).toContain('1 首下载启动失败')
  })

  it('同一批里重复的 id 只算一次', async () => {
    const fake = fakeBridge()
    install(fake.bridge)

    const result = await useDownloadStore.getState().startMany([SONG_A, SONG_A])

    expect(result).toEqual({ queued: 1, skipped: 1, failed: 0 })
    expect(fake.started).toEqual([SONG_A.id])
  })

  it('没有桥（浏览器预览）→ 不崩，报「当前环境不支持下载」', async () => {
    const result = await useDownloadStore.getState().startMany([SONG_A])

    expect(result.queued).toBe(0)
    expect(result.failed).toBe(1)
    expect(useDownloadStore.getState().error).toBe('当前环境不支持下载')
  })
})

// ---------------------------------------------------------------------------
// 工具条
// ---------------------------------------------------------------------------

describe('批量下载：工具条', () => {
  it('没选中 → **常驻**（显示提示，没有下载按钮）', () => {
    render(<BatchDownloadBar songs={[]} />)

    // ⚠️ **必须常驻**：工具条在「第一次单击」时冒出来会把列表往下推
    //    → 用户的第二击落在别的行上 → 浏览器不再派发 `dblclick`
    //    → **双击播放直接失效**（E2E 实测踩过这个坑）。
    expect(screen.getByTestId('fnm-batch-download-bar')).toBeTruthy()
    expect(screen.getByText('Ctrl / Shift 多选后可批量下载')).toBeTruthy()
    // 没选中时**没有**下载按钮（点了也没意义）。
    expect(screen.queryByTestId('fnm-batch-download-button')).toBeNull()
    expect(screen.queryByText('已选 1 首')).toBeNull()
  })

  it('样式：**高度写死一行**（不让列表位移）', () => {
    const { container } = render(<BatchDownloadBar songs={[]} />)
    const bar = container.querySelector('.fnm-batchdownload') as HTMLElement
    // ⚠️ 契约测试要**剥注释再匹配**（否则匹配到注释正文 = 空断言）。
    const css = readFileSync(
      join(__dirname, '..', 'src', 'components', 'batch-download-bar.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.fnm-batchdownload\s*\{[^}]*height:\s*36px/)
    expect(css).toMatch(/\.fnm-batchdownload\s*\{[^}]*flex-wrap:\s*nowrap/)
    // ⚠️ **必须 `flex: 0 0 auto`**：页面外壳是纵向 flex 容器，
    //    默认 `flex-shrink: 1` 会把工具条**压扁**（实测 36px → 2.45px），
    //    按钮被裁掉 → 点不到。
    expect(css).toMatch(/\.fnm-batchdownload\s*\{[^}]*flex:\s*0 0 auto/)
    expect(bar.className).toContain('fnm-batchdownload')
  })

  it('选中了 → 显示「已选 N 首」和「下载所选」', () => {
    render(<BatchDownloadBar songs={[SONG_A, SONG_B]} />)

    expect(screen.getByText('已选 2 首')).toBeTruthy()
    const button = screen.getByRole('button', { name: '下载所选 2 首' })
    expect(button).toBeTruthy()
  })

  it('点「下载所选」→ 真的发起下载，并如实汇报排队了几首', async () => {
    const fake = fakeBridge()
    install(fake.bridge)

    render(<BatchDownloadBar songs={[SONG_A, SONG_B]} />)
    fireEvent.click(screen.getByRole('button', { name: '下载所选 2 首' }))

    await waitFor(() => expect(fake.started).toEqual([SONG_A.id, SONG_B.id]))
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('已排队下载 2 首')
  })

  it('有歌**已在本地** → 提示里写明「跳过」，不说成排队成功', async () => {
    const fake = fakeBridge()
    install(fake.bridge)
    useDownloadStore.setState({ entries: { [SONG_A.id]: ENTRY_A } })

    render(<BatchDownloadBar songs={[SONG_A, SONG_B]} />)
    fireEvent.click(screen.getByRole('button', { name: '下载所选 2 首' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('已排队下载 1 首')
    expect(status.textContent).toContain('跳过 1 首')
    expect(fake.started).toEqual([SONG_B.id])
  })

  it('结果文案函数：三类数字都**如实**说出来', () => {
    expect(describeBatchResult({ queued: 3, skipped: 0, failed: 0 })).toBe('已排队下载 3 首')
    expect(describeBatchResult({ queued: 1, skipped: 2, failed: 0 })).toContain('跳过 2 首')
    expect(describeBatchResult({ queued: 0, skipped: 2, failed: 0 })).toContain('跳过 2 首')
    expect(describeBatchResult({ queued: 0, skipped: 0, failed: 1 })).toContain('1 首启动失败')
    expect(describeBatchResult({ queued: 0, skipped: 0, failed: 1 }, '当前环境不支持下载')).toContain(
      '当前环境不支持下载',
    )
  })
})

// ---------------------------------------------------------------------------
// 页面侧选中态
// ---------------------------------------------------------------------------

/** 用 hook 的小台子（模拟页面）。 */
function Harness({
  songs,
  listKey,
  onSelect,
}: {
  songs: Song[]
  listKey: string
  onSelect?: (ids: string[]) => void
}): React.ReactElement {
  const batch = useBatchSelection(songs, listKey, onSelect)
  return (
    <div>
      <span data-testid="count">{batch.selectedIds.length}</span>
      <BatchDownloadBar songs={batch.selectedSongs} onClear={batch.clear} />
      <button type="button" onClick={() => batch.onSelect([songs[0]?.id ?? ''])}>
        选第一首
      </button>
    </div>
  )
}

describe('批量下载：页面侧选中态', () => {
  it('选中 → 页面知道选中了谁（工具条出现）', () => {
    render(<Harness songs={[SONG_A, SONG_B]} listKey="songs" />)

    expect(screen.queryByText('已选 1 首')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '选第一首' }))

    expect(screen.getByTestId('count').textContent).toBe('1')
    expect(screen.getByText('已选 1 首')).toBeTruthy()
  })

  it('**换列表就清空选中**（否则会下载上一张列表的歌）', () => {
    const { rerender } = render(<Harness songs={[SONG_A, SONG_B]} listKey="playlist-1" />)
    fireEvent.click(screen.getByRole('button', { name: '选第一首' }))
    expect(screen.getByTestId('count').textContent).toBe('1')

    // 切到另一个歌单。
    rerender(<Harness songs={[SONG_C]} listKey="playlist-2" />)

    expect(screen.getByTestId('count').textContent).toBe('0')
    expect(screen.queryByText('已选 1 首')).toBeNull()
  })

  it('外部的选中回调**照样**被调用（既有语义不变）', () => {
    const onSelect = vi.fn()
    render(<Harness songs={[SONG_A]} listKey="songs" onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: '选第一首' }))

    expect(onSelect).toHaveBeenCalledWith([SONG_A.id])
  })

  it('「取消选择」→ 清空', () => {
    render(<Harness songs={[SONG_A, SONG_B]} listKey="songs" />)
    fireEvent.click(screen.getByRole('button', { name: '选第一首' }))
    expect(screen.getByTestId('count').textContent).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: '取消选择' }))

    expect(screen.getByTestId('count').textContent).toBe('0')
  })
})
