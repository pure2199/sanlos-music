// ---------------------------------------------------------------------------
// T118：「有声读物」扫描落盘**不得覆盖**用户的手工改判
//
// ⚠ **根因**（`src/state/audiobookStore.ts` 的 `scan()`）：
//   扫描启动时读一次落盘成**快照** `saved`（此后不再更新）⇒ 之后
//   **每页断点落盘**与**扫完落盘**都写 `overrides: { ...saved.overrides }`
//   ⇒ 写回的是**扫描启动那一刻的快照** ⇒ **覆盖**扫描期间用户新做的改判；
//   扫完时 `set({ overrides: persisted.overrides })` ⇒ **内存状态也一起回退**
//   ⇒ 界面上刚点的「这不是有声」**当场消失**。
//
// ⚠ 一句话机理：**「谁最后写谁赢」的整对象落盘模型下，扫描这一路对 `overrides`
//    没有写权限，却仍然在写。**（同文件另外三处 `setOverride` / `setCover` /
//    `setAlbumCover` 都是「**先读最新的**再只改自己那个字段」⇒ 没问题。）
//
// ⚠ 这几条钉的是**竞态**：改判**故意发生在扫描的页与页之间**
//   ⇒ 与真机上「扫描还在跑，用户点了一下」的时序**同构**。
// ---------------------------------------------------------------------------

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanLibraryTracks, albumWorkDir, album } = vi.hoisted(() => ({
  scanLibraryTracks: vi.fn(),
  albumWorkDir: vi.fn(),
  album: vi.fn(),
}))
const { searchApi } = vi.hoisted(() => ({ searchApi: { albums: vi.fn() } }))

// ⚠ 页面要 `libraryApi`（补拉封面 + 秒搜取作品目录）；store 只要 `scanLibraryTracks`。
vi.mock('../src/api/library', () => ({ scanLibraryTracks, libraryApi: { albumWorkDir, album } }))
vi.mock('../src/api/search', () => ({ searchApi }))

import { AudiobooksPage } from '../src/pages/AudiobooksPage'
import {
  createMemoryAudiobookPort,
  useAudiobookStore,
  type AudiobookPersisted,
} from '../src/state/audiobookStore'

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

/** 造一条扫描用的曲目（形状同 `src/api/library.ts` 的 `ScanTrack`）。 */
function scanTrack(partial: { id: string; albumId: string; albumTitle?: string; path?: string | null }) {
  return {
    id: partial.id,
    title: '01- 某集',
    albumId: partial.albumId,
    albumTitle: partial.albumTitle ?? '作品名',
    durationSec: 1907,
    trackNo: null,
    path:
      partial.path ??
      '/vol02/1000-0-3d135437/有声小说/某某/作品名/Disc 01/01- 某集.mp3',
    createdAt: 1792563278,
    coverId: '',
    albumCoverId: '',
  }
}

/**
 * 让 `scanLibraryTracks` 按页返回数据。
 *
 * ⚠ `betweenPages` 在**页与页之间**跑 ⇒ 用来模拟「扫描还在跑，用户这时点了一下」
 *    （真机上那几秒～几十秒的窗口就是它）。
 */
function mockScan(
  pages: { page: number; tracks: ReturnType<typeof scanTrack>[] }[],
  total: number,
  betweenPages?: (page: number) => void,
) {
  scanLibraryTracks.mockImplementation(async (options: unknown) => {
    const opts = options as {
      onPage?: (tracks: unknown[], progress: unknown) => void
    }
    let scanned = 0
    for (const p of pages) {
      scanned += p.tracks.length
      opts.onPage?.(p.tracks, { page: p.page, pages: pages.length, scanned, total })
      betweenPages?.(p.page)
    }
    return { scanned, total, pages: pages.length, stoppedAtWatermark: false }
  })
}

/** 一份「启动时就有改判」的落盘。 */
function persistedWith(
  overrides: AudiobookPersisted['overrides'],
): AudiobookPersisted {
  return {
    version: 3,
    keyword: '有声小说',
    nextPage: 0,
    scannedCount: 0,
    total: 0,
    candidates: {},
    overrides,
    scannedAt: 1792563278000,
  }
}

/** 重置 store 状态（与既有 store 测试同一套）。 */
function resetStore() {
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
}

describe('T118：扫描落盘不得覆盖手工改判（store 级）', () => {
  beforeEach(() => {
    scanLibraryTracks.mockReset()
    resetStore()
  })

  it('① 扫描期间**新增**的改判 ⇒ 扫完**落盘**里还在', async () => {
    const port = createMemoryAudiobookPort()
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 'p1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 'p2', albumId: 'al-1' })] },
        { page: 3, tracks: [scanTrack({ id: 'p3', albumId: 'al-1' })] },
      ],
      3,
      // ⚠ 第 1 页之后 ⇒ **扫描还在跑** ⇒ 用户这时改判（真机同构）。
      (page) => {
        if (page !== 1) return
        useAudiobookStore.getState().setOverride('al-x', 'audiobook', port, '手动指定')
      },
    )

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 关键判据：**落盘**里改判还在（修复前 ⇒ 第 2 页的落盘就把它盖掉了）。
    expect(port.load()?.overrides['al-x']?.value).toBe('audiobook')
  })

  it('② 扫描期间改判成「这不是有声」⇒ 扫完落盘里**仍是** not-audiobook', async () => {
    const port = createMemoryAudiobookPort()
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 'q1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 'q2', albumId: 'al-1' })] },
      ],
      2,
      (page) => {
        if (page !== 1) return
        useAudiobookStore.getState().setOverride('al-1', 'not-audiobook', port, '作品名')
      },
    )

    await useAudiobookStore.getState().scan({ port })

    expect(port.load()?.overrides['al-1']?.value).toBe('not-audiobook')
  })

  it('③ 扫描期间**撤销**改判 ⇒ 扫完**不会被启动快照复活**', async () => {
    // ⚠ 启动时 `al-a` 是「有声」⇒ 用户在扫描中撤销它。
    const port = createMemoryAudiobookPort(
      persistedWith({ 'al-a': { value: 'audiobook', albumTitle: '甲' } }),
    )
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 'r1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 'r2', albumId: 'al-1' })] },
      ],
      2,
      (page) => {
        if (page !== 1) return
        useAudiobookStore.getState().setOverride('al-a', null, port)
      },
    )

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 关键判据：`al-a` **仍然没有**（修复前 ⇒ 启动快照把它复活了）。
    expect(port.load()?.overrides['al-a']).toBeUndefined()
  })

  it('④ 扫描期间**新增**的改判 ⇒ 扫完**内存状态**也不回退', async () => {
    const port = createMemoryAudiobookPort()
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 's1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 's2', albumId: 'al-1' })] },
      ],
      2,
      (page) => {
        if (page !== 1) return
        useAudiobookStore.getState().setOverride('al-x', 'audiobook', port, '手动指定')
      },
    )

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 关键判据：内存里**还在**（修复前 ⇒ 扫完那次 `set` 把它回退掉了）。
    expect(useAudiobookStore.getState().overrides['al-x']?.value).toBe('audiobook')
  })

  it('⑤ 对照组：扫描期间**不改判** ⇒ 启动时的改判原样保留', async () => {
    const port = createMemoryAudiobookPort(
      persistedWith({ 'al-a': { value: 'not-audiobook', albumTitle: '甲' } }),
    )
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 't1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 't2', albumId: 'al-1' })] },
      ],
      2,
    )

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 这条是**对照组**（没有中途改判 ⇒ 行为不许变）⇒ 修复前后都应成立。
    expect(port.load()?.overrides['al-a']?.value).toBe('not-audiobook')
  })

  it('⑦ 扫描**进行中**（页边界落盘之后）⇒ 落盘里的改判**已经在**', async () => {
    const port = createMemoryAudiobookPort()
    /** 每页落盘**之后**看到的 `overrides`（= 扫描进行中的**真实**磁盘状态）。 */
    const seen: (string | undefined)[] = []
    mockScan(
      [
        { page: 1, tracks: [scanTrack({ id: 'u1', albumId: 'al-1' })] },
        { page: 2, tracks: [scanTrack({ id: 'u2', albumId: 'al-1' })] },
        { page: 3, tracks: [scanTrack({ id: 'u3', albumId: 'al-1' })] },
      ],
      3,
      (page) => {
        // ⚠ **先**看这一页落盘之后的磁盘状态（= 用户还没改判时的样子）。
        seen.push(port.load()?.overrides['al-x']?.value)
        // ⚠ 第 1 页之后 ⇒ 用户改判（**扫描还在跑**）。
        if (page === 1) {
          useAudiobookStore.getState().setOverride('al-x', 'audiobook', port, '手动指定')
        }
      },
    )

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 第 1 页落盘时改判**还没发生** ⇒ 看不到（正常）；
    //    第 2、3 页落盘后**必须能看到**（修复前 ⇒ 中途就被覆盖了 ⇒ 看不到）。
    expect(seen).toEqual([undefined, 'audiobook', 'audiobook'])
  })

  it('⑧ 扫描**中途出错**（网络断了）⇒ 落盘里的改判**还在**', async () => {
    const port = createMemoryAudiobookPort()
    scanLibraryTracks.mockImplementation(async (options: unknown) => {
      const opts = options as {
        onPage?: (tracks: unknown[], progress: unknown) => void
      }
      opts.onPage?.([scanTrack({ id: 'v1', albumId: 'al-1' })], {
        page: 1,
        pages: 2,
        scanned: 1,
        total: 2,
      })
      // ⚠ 第 1 页之后 ⇒ 用户改判。
      useAudiobookStore.getState().setOverride('al-x', 'audiobook', port, '手动指定')
      // ⚠ 第 2 页落盘之后 ⇒ **网络断了** ⇒ 扫完那次落盘**不会**发生。
      opts.onPage?.([scanTrack({ id: 'v2', albumId: 'al-1' })], {
        page: 2,
        pages: 2,
        scanned: 2,
        total: 2,
      })
      throw new Error('网络断了')
    })

    await useAudiobookStore.getState().scan({ port })

    // ⚠ 关键判据：断点落盘已经写过 ⇒ 用户的改判**不能丢**
    //    （丢了 ⇒ 下次续跑的那次落盘会把它抹掉 ⇒ 改判白做）。
    expect(port.load()?.overrides['al-x']?.value).toBe('audiobook')
    // ⚠ 断点语义不变（断点 = 下一个要扫的页）。
    expect(port.load()?.nextPage).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 页面级集成：**用户真实路径**（扫描还在跑 ⇒ 秒搜点开 ⇒ 记成「有声」）
// ---------------------------------------------------------------------------

describe('T118（页面级）：扫描还在跑时点开秒搜结果 ⇒ 改判不被覆盖', () => {
  beforeEach(() => {
    scanLibraryTracks.mockReset()
    searchApi.albums.mockReset()
    searchApi.albums.mockResolvedValue({ list: [], total: 0 })
    albumWorkDir.mockReset()
    albumWorkDir.mockResolvedValue(null)
    album.mockReset()
    album.mockResolvedValue(null)
    resetStore()
    window.localStorage.clear()
  })

  it('⑥ 扫描**卡住**时点开秒搜结果 ⇒ 放行扫描后落盘里改判**还在**', async () => {
    // ⚠ 把扫描**卡在第 1 页之后** ⇒ 模拟「扫描还没完，用户这时点了一下秒搜结果」。
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    scanLibraryTracks.mockImplementation(async (options: unknown) => {
      const opts = options as {
        onPage?: (tracks: unknown[], progress: unknown) => void
      }
      opts.onPage?.([scanTrack({ id: 'g1', albumId: 'al-scan' })], {
        page: 1,
        pages: 2,
        scanned: 1,
        total: 2,
      })
      await gate
      opts.onPage?.([scanTrack({ id: 'g2', albumId: 'al-scan' })], {
        page: 2,
        pages: 2,
        scanned: 2,
        total: 2,
      })
      return { scanned: 2, total: 2, pages: 2, stoppedAtWatermark: false }
    })
    searchApi.albums.mockResolvedValue({ list: [FOUND_ALBUM], total: 1 })

    render(<AudiobooksPage onOpenAlbum={() => {}} />)

    // ⚠ 等扫描**真的在跑**（否则下面等 `scanning === false` 会**秒过** ⇒ 假绿）。
    await waitFor(() => {
      expect(useAudiobookStore.getState().scanning).toBe(true)
    })

    // 秒搜 ⇒ 点开结果 ⇒ `setOverride('al-1', 'audiobook')`（用户指认）。
    fireEvent.change(screen.getByPlaceholderText('输入作品名，例如：牧神记'), {
      target: { value: '牧神记' },
    })
    fireEvent.click(screen.getByText('搜作品'))
    const result = await screen.findByText('牧神记')
    fireEvent.click(result)

    // ⚠ 点开的**当下**改判就已经写进内存了。
    expect(useAudiobookStore.getState().overrides['al-1']?.value).toBe('audiobook')

    // 放行扫描 ⇒ 让它跨过页边界 + 扫完（⇒ 落盘发生两次）。
    release?.()
    await waitFor(() => {
      expect(useAudiobookStore.getState().scanning).toBe(false)
    })

    // ⚠ 关键判据：**落盘**里改判还在（修复前 ⇒ 被扫完那次落盘盖掉）。
    const raw = window.localStorage.getItem('sanlos-audiobook-state')
    const persisted = JSON.parse(raw ?? '{}') as {
      overrides?: Record<string, { value?: string }>
    }
    expect(persisted.overrides?.['al-1']?.value).toBe('audiobook')
    expect(useAudiobookStore.getState().overrides['al-1']?.value).toBe('audiobook')
  })
})
