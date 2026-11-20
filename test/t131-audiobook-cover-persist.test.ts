// ---------------------------------------------------------------------------
// T131-D2：扫描落盘**不得冲掉**已经补拉到的专辑封面
// ---------------------------------------------------------------------------
//
// ⚠ **根因**（`src/state/audiobookStore.ts`）：
//   扫描用的聚合器是**扫描时新建**的 ⇒ 它的 `albumCoverId` 恒为 `undefined`（= 未知）
//   ⇒ 落盘时写 `albumCoverId: undefined` ⇒ `JSON.stringify` **丢掉这个 key**
//   ⇒ **补拉到的封面被下一次扫描冲掉** ⇒ 用户每次进「有声」页都要**重拉一次**
//      `/album/detail`。
//
// ⚠ **与 T118 的 `overrides` 是同一类问题**（扫描落盘覆盖了「扫描之外取得的活值」），
//   但 T118 只修了 `overrides` ⇒ **封面这一路漏了**。
//
// ⚠ **修法**：落盘时采用「**已经知道的**」封面（来源 = **当前落盘** ＋ **内存活值**）。
//   ⚠ 与 `overrides` **故意不同**：`overrides` 只能整体替换（merge 会复活「撤销改判」），
//     而**封面没有「撤销」语义** ⇒ 可以安全保留已知值。
//
// ⚠ **本文件是独立新文件** ⇒ `test/t118-audiobook-scan-override.test.tsx` **一个字节没动**。
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanLibraryTracks } = vi.hoisted(() => ({ scanLibraryTracks: vi.fn() }))

// ⚠ store 会 import `../src/api/library` ⇒ 必须 mock（否则会真去请求网络）。
vi.mock('../src/api/library', () => ({
  scanLibraryTracks,
  libraryApi: { albumWorkDir: vi.fn(), album: vi.fn() },
}))

import {
  createMemoryAudiobookPort,
  useAudiobookStore,
} from '../src/state/audiobookStore'

/** 造一条扫描用的曲目（形状同 `src/api/library.ts` 的 `ScanTrack`）。 */
function scanTrack(partial: { id: string; albumId: string; albumTitle?: string }) {
  return {
    id: partial.id,
    title: '01- 某集',
    albumId: partial.albumId,
    albumTitle: partial.albumTitle ?? '作品名',
    durationSec: 1907,
    trackNo: null,
    path: '/vol02/1000-0-3d135437/有声小说/某某/作品名/Disc 01/01- 某集.mp3',
    createdAt: 1792563278,
    coverId: '',
    albumCoverId: '',
  }
}

/** 让 `scanLibraryTracks` 按页返回数据；`betweenPages` 在**页与页之间**跑。 */
function mockScan(
  pages: { page: number; tracks: ReturnType<typeof scanTrack>[] }[],
  total: number,
  betweenPages?: (page: number) => void,
) {
  scanLibraryTracks.mockImplementation(async (options: unknown) => {
    const opts = options as { onPage?: (tracks: unknown[], progress: unknown) => void }
    let scanned = 0
    for (const p of pages) {
      scanned += p.tracks.length
      opts.onPage?.(p.tracks, { page: p.page, pages: pages.length, scanned, total })
      betweenPages?.(p.page)
    }
    return { scanned, total, pages: pages.length, stoppedAtWatermark: false }
  })
}

/** 重置 store 状态。 */
function resetStore() {
  useAudiobookStore.setState({
    hits: [],
    overrides: {},
    keyword: '有声小说',
    scanning: false,
    progress: null,
    error: null,
    notice: null,
    scannedAt: null,
    extraGroups: {},
  })
}

describe('T131-D2：扫描落盘保留已经补拉到的专辑封面', () => {
  beforeEach(() => {
    scanLibraryTracks.mockReset()
    resetStore()
  })

  it('① 补拉过封面 ⇒ **重新扫描**后落盘里封面**还在**（走「旧落盘」那条路）', async () => {
    const port = createMemoryAudiobookPort()

    // ---- 第一轮扫描：产出 candidates（否则 `setAlbumCover` 没处写）----------
    mockScan([{ page: 1, tracks: [scanTrack({ id: 'p1', albumId: 'al-1' })] }], 1)
    await useAudiobookStore.getState().scan({ port })
    expect(port.load()?.candidates['al-1']).toBeTruthy()

    // ---- 页面补拉封面（真实路径：`setAlbumCover` ⇒ 改命中 ＋ 回写落盘）--------
    useAudiobookStore.getState().setAlbumCover('al-1', 'cover-x', port)
    expect(port.load()?.candidates['al-1']?.albumCoverId).toBe('cover-x')

    // ⚠ **模拟应用重启**（清空内存命中）⇒ 这一轮**只能**靠「旧落盘」把封面带回来。
    useAudiobookStore.setState({ hits: [] })

    // ---- 第二轮扫描 ⇒ 落盘里的封面**不能被冲掉** --------------------------------
    mockScan([{ page: 1, tracks: [scanTrack({ id: 'p2', albumId: 'al-1' })] }], 1)
    await useAudiobookStore.getState().scan({ port })

    // ⚠ 关键判据（修复前 ⇒ 这里是 `undefined` ⇒ 每次进页面都要重拉）。
    expect(port.load()?.candidates['al-1']?.albumCoverId).toBe('cover-x')
  })

  it('② 扫描**进行中**补拉封面 ⇒ 后面几页的落盘**不能**冲掉它', async () => {
    const port = createMemoryAudiobookPort()
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 'q1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 'q2', albumId: 'al-1' })] },
        { page: 3, tracks: [scanTrack({ id: 'q3', albumId: 'al-1' })] },
      ],
      3,
      // ⚠ 第 1 页之后 ⇒ **扫描还在跑** ⇒ 用户这时进页面补拉封面（真机同构）。
      (page) => {
        if (page !== 1) return
        useAudiobookStore.getState().setAlbumCover('al-1', 'cover-y', port)
      },
    )

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 关键判据（修复前 ⇒ 第 2 页的落盘就把它盖掉了）。
    expect(port.load()?.candidates['al-1']?.albumCoverId).toBe('cover-y')
  })

  it('③ 对照组：**从没补拉过**的专辑 ⇒ 落盘里仍是「未知」（字段缺省，不是 null）', async () => {
    const port = createMemoryAudiobookPort()
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 'r1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 'r2', albumId: 'al-1' })] },
      ],
      2,
    )

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 三态：`undefined` = 未知（进页面要补拉一次）/ `null` = 确认没有（不用再拉）。
    //   ⇒ 修复不能把「未知」误写成 `null`（那会让页面**永远不再补拉**）。
    //
    // ⚠ **为什么断言「值」而不是「字段缺省」**：内存端口**保留** `undefined` 属性
    //   （真实 localStorage 会 `JSON.stringify` ⇒ 丢掉 `undefined` 的 key）
    //   ⇒ 「字段缺省」这个判据**只在真实落盘成立** ⇒ 这里断言**值**（语义等价）。
    const snap = port.load()?.candidates['al-1']
    expect(snap).toBeTruthy()
    expect(snap?.albumCoverId).toBeUndefined()
    expect(snap?.albumCoverId).not.toBeNull()
  })

  it('④ 断点续跑（`fromSnapshot` 还原旧聚合）⇒ 封面仍是「未知」，**不是**「确认没有」', async () => {
    // ⚠ 这条钉的是 **`fromSnapshot` 的三态还原**（与 ①②③ 不同的另一条路）。
    //
    // ⚠ **旧落盘的形状**：`albumCoverId` **字段缺省** ⇒ 语义是「**未知**」
    //   （T101 时代的落盘就是这样）⇒ 读回来必须还是「未知」⇒ 页面才还会补拉一次。
    //   ⇒ 旧实现把「字段存在但不是字符串」**一律**还原成 `null`（「确认没有」）
    //   ⇒ 一旦续跑，落盘就变成 `albumCoverId: null` ⇒ 页面**永远不再补拉** ⇒ 卡片永远是占位图。
    const port = createMemoryAudiobookPort({
      version: 3,
      // ⚠ `nextPage > 0` ⇒ 有断点 ⇒ 这一轮会走 **`fromSnapshot`** 还原旧聚合。
      nextPage: 2,
      scannedCount: 1,
      total: 2,
      candidates: {
        'al-1': {
          albumId: 'al-1',
          albumTitle: '作品名',
          trackCount: 1,
          totalDurationSec: 1907,
          maxDurationSec: 1907,
          episodeStats: { ruleCounts: {}, titleCount: 1 },
          dirs: [],
          coverId: null,
          // ⚠ **故意不写 `albumCoverId`** ⇒ 这是「未知」的落盘形状。
        },
      },
      overrides: {},
      keyword: '有声小说',
      scannedAt: 0,
    })

    // ⚠ 续跑的那一页**还是** `al-1` ⇒ 聚合器里那个是**从快照还原**出来的（不是新建的）。
    mockScan([{ page: 2, tracks: [scanTrack({ id: 's2', albumId: 'al-1' })] }], 2)
    await useAudiobookStore.getState().scan({ port })

    const snap = port.load()?.candidates['al-1']
    expect(snap).toBeTruthy()
    // ⚠ 关键判据（修复前 ⇒ 这里是 `null` = 「确认没有」⇒ 页面永远不再补拉封面）。
    expect(snap?.albumCoverId).toBeUndefined()
    expect(snap?.albumCoverId).not.toBeNull()
  })
})
