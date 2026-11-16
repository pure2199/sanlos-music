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
  albumTitle?: string
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
    albumTitle: partial.albumTitle ?? '作品名',
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
      version: 3,
      keyword: '有声小说',
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
      version: 3,
      keyword: '有声小说',
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
      version: 3,
      keyword: '有声小说',
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
      version: 3,
      keyword: '有声小说',
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

  // -------------------------------------------------------------------------
  // v3 改版：「是不是有声」改由**用户指位置**决定（目录关键字 / 作品名秒搜）
  // -------------------------------------------------------------------------

  it('⑨ 扫描**只聚合目录关键字命中的曲目**（不在那个目录的作品不出现）', async () => {
    const port = createMemoryAudiobookPort()
    mockScan(
      [
        {
          page: 1,
          tracks: [
            scanTrack({ id: 'a1', title: '01- 某集', albumId: 'al-novel' }),
            scanTrack({
              id: 'b1',
              title: '某首歌',
              albumId: 'al-music',
              path: '/vol02/1000-0-音乐/sample/b1.mp3',
            }),
          ],
        },
      ],
      2,
    )

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })

    const hits = useAudiobookStore.getState().hits
    expect(hits.map((h) => h.albumId)).toEqual(['al-novel'])
  })

  it('⑩ **打分不再是门槛**：目录里的作品即使分很低也列出（界面标「结构信号弱」）', async () => {
    const port = createMemoryAudiobookPort()
    // 3 集、每集 3 分钟 ⇒ 打分远低于 4 分门槛 ⇒ **v2 会被过滤掉**。
    const tracks = [1, 2, 3].map((i) =>
      scanTrack({ id: `w${i}`, title: `歌 ${i}`, albumId: 'al-weak', durationSec: 180 }),
    )
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })

    const hits = useAudiobookStore.getState().hits
    expect(hits).toHaveLength(1)
    expect(hits[0]?.albumId).toBe('al-weak')
    expect(hits[0]?.score).toBeLessThan(4)
  })

  it('⑪ 关键字**落盘**；**换关键字 ⇒ 断点作废**（从头扫，不接着旧聚合）', async () => {
    const port = createMemoryAudiobookPort()
    // 这条曲目在「别的目录」下面 ⇒ 用默认关键字「有声小说」扫它 ⇒ **不匹配**。
    const otherDirTrack = scanTrack({
      id: 'k1',
      title: '01- 某集',
      albumId: 'al-1',
      path: '/vol02/1000-0-别的目录/某某/作品名/Disc 01/01- 某集.mp3',
    })
    mockScan([{ page: 1, tracks: [otherDirTrack] }], 1)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })
    expect(port.load()?.keyword).toBe('有声小说')
    expect(useAudiobookStore.getState().hits).toHaveLength(0)

    // 造一个「没扫完」的断点（关键字没变 ⇒ 正常情况下可以续跑）。
    const current = port.load()
    if (!current) throw new Error('没有落盘状态')
    port.save({ ...current, nextPage: 2, scannedCount: 10 })

    mockScan([{ page: 1, tracks: [otherDirTrack] }], 1)
    await useAudiobookStore.getState().scan({ port, keyword: '别的目录' })

    const options = scanLibraryTracks.mock.calls[
      scanLibraryTracks.mock.calls.length - 1
    ]?.[0] as { startPage: number }
    // ⚠️ 换关键字 ⇒ 断点作废 ⇒ 必须**从头**扫（第 1 页），不能接着第 2 页。
    expect(options.startPage).toBe(1)
    // 旧的 10 集**不能**叠上来（过滤条件变了 ⇒ 旧聚合作废）。
    expect(useAudiobookStore.getState().hits[0]?.trackCount).toBe(1)
    expect(port.load()?.keyword).toBe('别的目录')
  })

  it('⑫ 关键字**可以改**：换了个目录名，扫出来的东西也跟着换', async () => {
    const port = createMemoryAudiobookPort()
    const tracks = [
      scanTrack({ id: 'p1', title: '01- 某集', albumId: 'al-novel' }),
      scanTrack({
        id: 'p2',
        title: '某首歌',
        albumId: 'al-music',
        path: '/vol02/1000-0-音乐/sample/p2.mp3',
      }),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })
    expect(useAudiobookStore.getState().hits.map((h) => h.albumId)).toEqual(['al-novel'])

    await useAudiobookStore.getState().scan({ port, keyword: '音乐' })
    expect(useAudiobookStore.getState().hits.map((h) => h.albumId)).toEqual(['al-music'])
  })
})

// -------------------------------------------------------------------------
// T99：服务端把**一部作品**拆成**几张同名专辑** ⇒ 按**作品目录**归并
// -------------------------------------------------------------------------
//
// ⚠️ 实测形态（2026-11-16，本机 + 该账号）：
//   《让青春继续第一季》被拆成 **31 集 + 1 集**（第 02 集单独一张专辑）
//   ⇒ 两张专辑**同名**、**同作品目录**（`让青春继续`）、**同分段目录**。
// -------------------------------------------------------------------------

describe('T99：同名专辑按作品目录归并', () => {
  /** 实测的作品目录路径（作品目录 = 倒数第 3 段）。 */
  const WORK_DIR_PATH = '/vol02/1000-0-3d135437/有声小说/让青春继续/让青春继续第1季(全32集)'
  /** 另一个作品目录（同名但**不同目录** ⇒ 真的是两部作品）。 */
  const OTHER_WORK_DIR_PATH =
    '/vol02/1000-0-3d135437/有声小说/别的人/另一部作品/让青春继续第1季(全32集)'

  it('① 同名 + 同作品目录 ⇒ 合成**一条**，集数相加（31 + 1 = 32）', async () => {
    const port = createMemoryAudiobookPort()
    const tracks = [
      ...Array.from({ length: 31 }, (_, i) =>
        scanTrack({
          id: `q${i}`,
          title: `让青春继续第一季 ${String(i + 1).padStart(2, '0')}`,
          albumId: 'al-q1',
          albumTitle: '让青春继续第一季',
          path: `${WORK_DIR_PATH}/让青春继续第一季${String(i + 1).padStart(2, '0')}.mp3`,
        }),
      ),
      // ⚠️ 第 02 集**单独**一张专辑（服务端把它拆开了）⇒ 用户现在**少看到一集**。
      scanTrack({
        id: 'q-extra',
        title: '让青春继续第一季 02',
        albumId: 'al-q2',
        albumTitle: '让青春继续第一季',
        path: `${WORK_DIR_PATH}/让青春继续第一季02.mp3`,
      }),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })

    const hits = useAudiobookStore.getState().hits
    expect(hits).toHaveLength(1)
    expect(hits[0]?.albumTitle).toBe('让青春继续第一季')
    expect(hits[0]?.trackCount).toBe(32)
    // 主专辑 = 集数多的那张；组内 id 都在。
    expect(hits[0]?.albumId).toBe('al-q1')
    expect(hits[0]?.albumIds).toEqual(['al-q1', 'al-q2'])
    // 形态统计也是**合并后**的（32 个标题全命中同一条规则）。
    expect(hits[0]?.episodeRule).toBe('season-episode')
  })

  it('② 同名 + **不同作品目录** ⇒ **两条**（那是真的两部作品，不合并）', async () => {
    const port = createMemoryAudiobookPort()
    const tracks = [
      ...Array.from({ length: 10 }, (_, i) =>
        scanTrack({
          id: `r${i}`,
          title: `让青春继续第一季 ${String(i + 1).padStart(2, '0')}`,
          albumId: 'al-r1',
          albumTitle: '让青春继续第一季',
          path: `${WORK_DIR_PATH}/让青春继续第一季${String(i + 1).padStart(2, '0')}.mp3`,
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        scanTrack({
          id: `s${i}`,
          title: `让青春继续第一季 ${String(i + 1).padStart(2, '0')}`,
          albumId: 'al-r2',
          albumTitle: '让青春继续第一季',
          path: `${OTHER_WORK_DIR_PATH}/让青春继续第一季${String(i + 1).padStart(2, '0')}.mp3`,
        }),
      ),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })

    const hits = useAudiobookStore.getState().hits
    expect(hits).toHaveLength(2)
    expect(hits.map((h) => h.albumId).sort()).toEqual(['al-r1', 'al-r2'])
    // 每条都**只含自己**（没被合并）。
    expect(hits.every((h) => h.albumIds.length === 1)).toBe(true)
  })

  it('③ **不同名** ⇒ **两条**（季 / 卷各算一部，不合并）', async () => {
    const port = createMemoryAudiobookPort()
    const tracks = [
      ...Array.from({ length: 10 }, (_, i) =>
        scanTrack({
          id: `t${i}`,
          title: `让青春继续第一季 ${String(i + 1).padStart(2, '0')}`,
          albumId: 'al-s1',
          albumTitle: '让青春继续第一季',
          path: `${WORK_DIR_PATH}/让青春继续第一季${String(i + 1).padStart(2, '0')}.mp3`,
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        scanTrack({
          id: `u${i}`,
          title: `让青春继续第二季 ${String(i + 1).padStart(2, '0')}`,
          albumId: 'al-s2',
          albumTitle: '让青春继续第二季',
          // ⚠️ 作品目录**也一样**（实测：第一/二/三季共用 `让青春继续` 目录）。
          path: `${WORK_DIR_PATH}/让青春继续第二季${String(i + 1).padStart(2, '0')}.mp3`,
        }),
      ),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })

    const hits = useAudiobookStore.getState().hits
    expect(hits).toHaveLength(2)
    expect(hits.map((h) => h.albumTitle).sort()).toEqual(['让青春继续第一季', '让青春继续第二季'])
  })

  it('④ 组级改判：对组内**任一成员**「不是有声」⇒ **整组**不再是有声', async () => {
    const port = createMemoryAudiobookPort()
    const tracks = [
      ...Array.from({ length: 10 }, (_, i) =>
        scanTrack({
          id: `v${i}`,
          title: `让青春继续第一季 ${String(i + 1).padStart(2, '0')}`,
          albumId: 'al-t1',
          albumTitle: '让青春继续第一季',
          path: `${WORK_DIR_PATH}/让青春继续第一季${String(i + 1).padStart(2, '0')}.mp3`,
        }),
      ),
      scanTrack({
        id: 'v-extra',
        title: '让青春继续第一季 02',
        albumId: 'al-t2',
        albumTitle: '让青春继续第一季',
        path: `${WORK_DIR_PATH}/让青春继续第一季02.mp3`,
      }),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })

    const store = useAudiobookStore.getState()
    expect(store.isAudiobook('al-t1')).toBe(true)
    expect(store.isAudiobook('al-t2')).toBe(true)

    // ⚠️ 改的是**成员**（al-t2），不是主专辑 ⇒ 整组都要生效。
    store.setOverride('al-t2', 'not-audiobook', port, '让青春继续第一季')

    expect(useAudiobookStore.getState().isAudiobook('al-t1')).toBe(false)
    expect(useAudiobookStore.getState().isAudiobook('al-t2')).toBe(false)
    expect(useAudiobookStore.getState().hitOf('al-t1')).toBeNull()
    // override 记在**主专辑**名下（组里只有一个结论）。
    expect(port.load()?.overrides['al-t1']?.value).toBe('not-audiobook')
    expect(port.load()?.overrides['al-t2']).toBeUndefined()
  })

  it('⑤ 归并**不改变落盘形状** ⇒ 旧落盘可用（`STATE_VERSION` 不变）', async () => {
    const port = createMemoryAudiobookPort()
    const tracks = [
      scanTrack({
        id: 'w1',
        title: '让青春继续第一季 01',
        albumId: 'al-u1',
        albumTitle: '让青春继续第一季',
        path: `${WORK_DIR_PATH}/让青春继续第一季01.mp3`,
      }),
      scanTrack({
        id: 'w2',
        title: '让青春继续第一季 02',
        albumId: 'al-u2',
        albumTitle: '让青春继续第一季',
        path: `${WORK_DIR_PATH}/让青春继续第一季02.mp3`,
      }),
    ]
    mockScan([{ page: 1, tracks }], tracks.length)

    await useAudiobookStore.getState().scan({ port, keyword: '有声小说' })

    // 落盘仍是**按专辑**的候选表（形状没变 ⇒ 旧落盘不会被作废）。
    const saved = port.load()
    expect(saved?.version).toBe(3)
    expect(Object.keys(saved?.candidates ?? {})).toEqual(['al-u1', 'al-u2'])
    // 但**读回来**时照样归并成一条。
    useAudiobookStore.getState().restore(port)
    expect(useAudiobookStore.getState().hits).toHaveLength(1)
    expect(useAudiobookStore.getState().hits[0]?.trackCount).toBe(2)
  })
})
