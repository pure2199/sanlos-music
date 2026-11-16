// ---------------------------------------------------------------------------
// T98：「有声读物」store（扫描 / 续跑 / 落盘 / 人工改判）
//
// ⚠️ 这几条测的是**真机复验后才发现的坑**：
//   ① 进页面**不能**自动扫全库（87 页 / 6–47 分钟）⇒ 只读落盘；
//   ② 续跑时**不能**把旧聚合跟新页**叠加**（否则集数翻倍）；
//   ③ 「没有断点」= 扫完了 ⇒ 这一轮从头扫 ⇒ 旧聚合必须**丢掉**。
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanLibraryTracks } = vi.hoisted(() => ({ scanLibraryTracks: vi.fn() }))

vi.mock('../src/api/library', () => ({ scanLibraryTracks }))

import {
  createMemoryAudiobookPort,
  useAudiobookStore,
  type AudiobookPersisted,
} from '../src/state/audiobookStore'

/** 造一条扫描用的曲目。 */
function scanTrack(partial: {
  id: string
  title: string
  albumId: string
  durationSec?: number
  path?: string | null
}): {
  id: string
  title: string
  albumId: string
  albumTitle: string
  durationSec: number
  trackNo: number | null
  path: string | null
  createdAt: number | null
} {
  return {
    id: partial.id,
    title: partial.title,
    albumId: partial.albumId,
    albumTitle: '作品名',
    durationSec: partial.durationSec ?? 1907,
    trackNo: null,
    path:
      partial.path === undefined
        ? '/vol02/1000-0-3d135437/有声小说/某某/作品名/Disc 01/01- 某集.mp3'
        : partial.path,
    createdAt: 1792563278,
  }
}

/** 让 `scanLibraryTracks` 按给定的页返回数据。 */
function mockScan(pages: { page: number; tracks: ReturnType<typeof scanTrack>[] }[], total: number) {
  scanLibraryTracks.mockImplementation(async (options: unknown) => {
    const opts = options as {
      onPage?: (
        tracks: ReturnType<typeof scanTrack>[],
        progress: { page: number; pages: number; scanned: number; total: number },
      ) => void
    }
    let scanned = 0
    for (const p of pages) {
      scanned += p.tracks.length
      opts.onPage?.(p.tracks, { page: p.page, pages: pages.length, scanned, total })
    }
    return { scanned, total, pages: pages.length, stoppedAtWatermark: false }
  })
}

/** 一张「真·有声」专辑的落盘候选（紧凑形状：只有统计，没有标题样本）。 */
function persistedCandidate(trackCount: number) {
  return {
    albumId: 'al-1',
    albumTitle: '作品名',
    trackCount,
    totalDurationSec: trackCount * 1907,
    maxDurationSec: 1907,
    episodeStats: { ruleCounts: { 'dash-prefix': trackCount }, titleCount: trackCount },
    dirs: ['作品名'],
  }
}

describe('audiobookStore（扫描 / 续跑 / 落盘 / 改判）', () => {
  beforeEach(() => {
    scanLibraryTracks.mockReset()
    useAudiobookStore.setState({
      hits: [],
      overrides: {},
      scanning: false,
      progress: null,
      error: null,
      scannedAt: null,
    })
  })

  it('① restore() 只读落盘 ⇒ **一个请求都不发**', () => {
    const saved: AudiobookPersisted = {
      version: 2,
      nextPage: 0,
      scannedCount: 89,
      total: 89,
      candidates: { 'al-1': persistedCandidate(89) },
      overrides: {},
      scannedAt: 1792563278000,
    }
    const port = createMemoryAudiobookPort(saved)
    useAudiobookStore.getState().restore(port)

    expect(scanLibraryTracks).not.toHaveBeenCalled()
    const state = useAudiobookStore.getState()
    expect(state.hits).toHaveLength(1)
    expect(state.hits[0]?.albumId).toBe('al-1')
    expect(state.hits[0]?.trackCount).toBe(89)
    expect(state.scannedAt).toBe(1792563278000)
  })

  it('② 续跑：从断点接着扫，**旧聚合不重复计数**', async () => {
    const saved: AudiobookPersisted = {
      version: 2,
      nextPage: 2,
      scannedCount: 10,
      total: 12,
      candidates: { 'al-1': persistedCandidate(10) },
      overrides: {},
      scannedAt: 1792563278000,
    }
    const port = createMemoryAudiobookPort(saved)
    mockScan(
      [
        {
          page: 2,
          tracks: [scanTrack({ id: 'x1', title: '11- 某集', albumId: 'al-1' }), scanTrack({ id: 'x2', title: '12- 某集', albumId: 'al-1' })],
        },
      ],
      12,
    )

    await useAudiobookStore.getState().scan({ port })

    const state = useAudiobookStore.getState()
    expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    // ⚠️ 断点页 = 2（不是 1）⇒ 不重扫前面的页。
    expect((scanLibraryTracks.mock.calls[0]?.[0] as { startPage: number }).startPage).toBe(2)
    // 集数 = 旧的 10 + 新的 2 = 12 ⇒ **不是 24**（那才是重复计数）。
    expect(state.hits[0]?.trackCount).toBe(12)
  })

  it('③ 没有断点（扫完了）⇒ 这一轮从头扫，**旧聚合必须丢掉**', async () => {
    const saved: AudiobookPersisted = {
      version: 2,
      nextPage: 0,
      scannedCount: 10,
      total: 10,
      candidates: { 'al-1': persistedCandidate(10) },
      overrides: {},
      scannedAt: 1792563278000,
    }
    const port = createMemoryAudiobookPort(saved)
    mockScan(
      [{ page: 1, tracks: [scanTrack({ id: 'y1', title: '01- 某集', albumId: 'al-1' })] }],
      1,
    )

    await useAudiobookStore.getState().scan({ port })

    const state = useAudiobookStore.getState()
    expect((scanLibraryTracks.mock.calls[0]?.[0] as { startPage: number }).startPage).toBe(1)
    // 只扫到 1 首 ⇒ 集数必须是 1（旧的 10 **不能**叠上来）。
    expect(state.hits[0]?.trackCount).toBe(1)
  })

  it('④ 人工改判优先于自动判定，且**改判落盘**', async () => {
    const saved: AudiobookPersisted = {
      version: 2,
      nextPage: 0,
      scannedCount: 89,
      total: 89,
      candidates: { 'al-1': persistedCandidate(89) },
      overrides: {},
      scannedAt: 1792563278000,
    }
    const port = createMemoryAudiobookPort(saved)
    useAudiobookStore.getState().restore(port)

    expect(useAudiobookStore.getState().isAudiobook('al-1')).toBe(true)
    useAudiobookStore.getState().setOverride('al-1', 'not-audiobook', port, '作品名')
    expect(useAudiobookStore.getState().isAudiobook('al-1')).toBe(false)
    expect(port.load()?.overrides['al-1']?.value).toBe('not-audiobook')

    // 手动判为有声（自动没命中）⇒ 也要能显示出来。
    useAudiobookStore.getState().setOverride('al-2', 'audiobook', port, '另一个作品')
    expect(useAudiobookStore.getState().isAudiobook('al-2')).toBe(true)
    expect(useAudiobookStore.getState().hitOf('al-2')?.reasons).toContain('user')
  })

  it('⑤ 每页落一次断点 ⇒ 中途断了也能续跑', async () => {
    const port = createMemoryAudiobookPort()
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 'z1', title: '01- 某集', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 'z2', title: '02- 某集', albumId: 'al-1' })] },
      ],
      2,
    )

    await useAudiobookStore.getState().scan({ port })

    // 扫完了 ⇒ **没有断点**（`nextPage = 0`）⇒ 下次从头来。
    expect(port.load()?.nextPage).toBe(0)
    expect(port.load()?.scannedCount).toBe(2)
    expect(port.load()?.candidates['al-1']?.trackCount).toBe(2)
  })

  it('⑥ 中途出错 ⇒ **断点仍然留着**（下次能接着扫，不必从头再来）', async () => {
    const port = createMemoryAudiobookPort()
    scanLibraryTracks.mockImplementation(async (options: unknown) => {
      const opts = options as {
        onPage?: (
          tracks: ReturnType<typeof scanTrack>[],
          progress: { page: number; pages: number; scanned: number; total: number },
        ) => void
      }
      // 第一页扫完 ⇒ 第二页炸了（模拟网络断了）。
      opts.onPage?.([scanTrack({ id: 'q1', title: '01- 某集', albumId: 'al-1' })], {
        page: 1,
        pages: 2,
        scanned: 1,
        total: 2,
      })
      throw new Error('网络断了')
    })

    await useAudiobookStore.getState().scan({ port })

    const state = useAudiobookStore.getState()
    expect(state.error).toContain('网络断了')
    // ⚠️ 断点 = **下一个要扫的页**（第 1 页扫完了 ⇒ 断点在第 2 页）。
    expect(port.load()?.nextPage).toBe(2)
    expect(port.load()?.scannedCount).toBe(1)
  })

  it('⑦ 「最长单集」用**真最长**，不用均长冒充（扫描路径）', async () => {
    const port = createMemoryAudiobookPort()
    // 10 首 20 分钟 + 1 首 60 分钟 ⇒ 均长 ≈ 23.7 分钟，**最长** 60 分钟。
    const tracks = [
      ...Array.from({ length: 10 }, (_, i) =>
        scanTrack({
          id: `m${i}`,
          title: `${String(i + 1).padStart(2, '0')}- 某集`,
          albumId: 'al-1',
          durationSec: 1200,
        }),
      ),
      scanTrack({ id: 'long', title: '11- 某集', albumId: 'al-1', durationSec: 3600 }),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port })

    const hit = useAudiobookStore.getState().hits[0]
    expect(hit?.reasons).toContain('very-long-track')
    expect(hit?.avgDurationSec).toBeLessThan(1800)
  })

  it('⑧ 形态命中率按**全量标题**算（不是只看前 30 个）', async () => {
    const port = createMemoryAudiobookPort()
    // 40 首：一半是 `01- 某集` 形态（20 首），一半解析不出来（20 首）
    // ⇒ 全量口径 = 20/40 = 50% < 60% ⇒ **形态不一致** ⇒ 那 2 分不计。
    const tracks = [
      ...Array.from({ length: 20 }, (_, i) =>
        scanTrack({ id: `d${i}`, title: `${String(i + 1).padStart(2, '0')}- 某集`, albumId: 'al-1' }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        scanTrack({ id: `u${i}`, title: `杂曲 ${i}`, albumId: 'al-1' }),
      ),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port })

    const hit = useAudiobookStore.getState().hits[0]
    expect(hit?.trackCount).toBe(40)
    expect(hit?.reasons).not.toContain('episode-pattern')
    expect(hit?.episodeRule).toBeNull()
  })
})
