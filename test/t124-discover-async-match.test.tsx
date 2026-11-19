// ---------------------------------------------------------------------------
// T124：发现页「先出榜单、命中异步补」＋「二次进入不重打 NAS」
// ---------------------------------------------------------------------------
//
// ⚠️ 钉住的行为：
// 1. **榜单先出**：榜单一到就渲染（条目标 `pending`），**不等**匹配（30–40 秒）；
// 2. **命中异步补**：匹配在后台跑 ⇒ 完成后 `pending` 清空、命中数正确；
// 3. ⚠️ **「还没查完」≠「不在曲库」** ⇒ pending 的条目显示「**匹配中…**」；
// 4. **会话内缓存**：同样的榜单**第二次**进来 ⇒ **一个 NAS 请求都不发**；
// 5. ⚠️ **曲库查不动** ⇒ 榜单**仍在**（先出）＋ 说「暂时无法匹配曲库」
//    ⇒ **不说「都不在曲库」**（那是**结论**，而这里**还没有结论**）。
//
// ⚠️ 缓存是**模块级**的（进程内）⇒ 每个用例**用不同的榜单 id** ⇒ 互不干扰。
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChartBoard, ChartResult } from '../shared/chartTypes'
import type { Artist, Song } from '../shared/types'
import type { DiscoverDeps } from '../src/api/discover'
import { useDiscoverStore } from '../src/state/discoverStore'
import { DiscoverPage } from '../src/pages/DiscoverPage'

/** 造一个榜单（**每个用例用不同的 id** ⇒ 不撞模块级缓存）。 */
function boardOf(id: string): ChartBoard {
  return {
    id,
    name: `榜单 ${id}`,
    source: 'qq',
    entries: [
      { rank: 1, title: `曲目 ${id}-1`, artist: `歌手 ${id}`, album: '', duration: 200 },
      { rank: 2, title: `曲目 ${id}-2`, artist: `别的歌手 ${id}`, album: '', duration: 180 },
    ],
  }
}

/** 造一个假桥（榜单从这儿来）。 */
function installBridge(board: ChartBoard): void {
  const scope = globalThis as unknown as {
    sanlosPlayer?: { fetchCharts: () => Promise<ChartResult> }
  }
  scope.sanlosPlayer = {
    fetchCharts: async () => ({ status: 'ok', boards: [board] }),
  }
}

/** 造一个假依赖（NAS 查询）。 */
function depsOf(overrides?: Partial<DiscoverDeps>): DiscoverDeps {
  return {
    searchArtists: async (): Promise<Artist[]> => [],
    artistSongs: async (): Promise<Song[]> => [],
    albumSongs: async (): Promise<Song[]> => [],
    ...overrides,
  }
}

/** 复位 store（每个用例开始时）。 */
function resetStore(): void {
  useDiscoverStore.setState({
    charts: [],
    boards: [],
    chartsLoading: false,
    matching: false,
    chartsError: null,
    chartsNotice: null,
    matchError: null,
    matchedCount: 0,
    totalCount: 0,
    blocks: [],
    recommendLoading: false,
    recommendError: null,
    recommendPartial: false,
  })
}

describe('T124 发现页：先出榜单、命中异步补、会话内缓存', () => {
  beforeEach(() => {
    resetStore()
  })

  it('① 榜单**先出**（匹配还没完成时，条目已在屏幕上且标 pending）', async () => {
    const board = boardOf('t124-a')
    installBridge(board)
    // ⚠️ 让匹配**卡住** ⇒ 才观察得到「榜单已出、命中还没到」。
    let release: (value: Artist[]) => void = () => {}
    const gate = new Promise<Artist[]>((resolve) => {
      release = resolve
    })
    const deps = depsOf({ searchArtists: () => gate })

    const pending = useDiscoverStore.getState().loadCharts(deps)

    await waitFor(() => expect(useDiscoverStore.getState().charts.length).toBe(1))
    const state = useDiscoverStore.getState()
    // ⚠️ 榜单**已经**在状态里（界面能渲染了）。
    expect(state.boards.length).toBe(1)
    expect(state.boards[0]?.entries.length).toBe(2)
    // ⚠️ 但**还没有结论** ⇒ 标 pending（界面显示「匹配中…」）。
    expect(state.boards[0]?.entries[0]?.pending).toBe(true)
    expect(state.matching).toBe(true)
    expect(state.chartsLoading).toBe(false)

    release([])
    await pending
    expect(useDiscoverStore.getState().matching).toBe(false)
  })

  it('② 命中**异步补**上：匹配完成后 pending 清空、命中数正确', async () => {
    const board = boardOf('t124-b')
    installBridge(board)
    let release: (value: Artist[]) => void = () => {}
    const gate = new Promise<Artist[]>((resolve) => {
      release = resolve
    })
    const deps = depsOf({
      searchArtists: () => gate,
      artistSongs: async () => [],
    })
    const pending = useDiscoverStore.getState().loadCharts(deps)
    await waitFor(() => expect(useDiscoverStore.getState().matching).toBe(true))

    release([])
    await pending

    const state = useDiscoverStore.getState()
    expect(state.matching).toBe(false)
    // ⚠️ 定案后**不再**是 pending（界面改口「在/不在曲库」）。
    expect(state.boards[0]?.entries.every((entry) => entry.pending !== true)).toBe(true)
    expect(state.totalCount).toBe(2)
    expect(state.matchedCount).toBe(0)
  })

  it('③ 会话内缓存：同样的榜单**第二次**进来 ⇒ **一个 NAS 请求都不发**', async () => {
    const board = boardOf('t124-c')
    installBridge(board)
    const searchArtists = vi.fn(async (): Promise<Artist[]> => [])

    await useDiscoverStore.getState().loadCharts(depsOf({ searchArtists }))
    expect(searchArtists).toHaveBeenCalled()

    searchArtists.mockClear()
    await useDiscoverStore.getState().loadCharts(depsOf({ searchArtists }))
    // ⚠️ 命中缓存 ⇒ **不再**定向查 NAS（二次进入不再 30–40 秒）。
    expect(searchArtists).not.toHaveBeenCalled()
    // ⚠️ 但**结果照样在**（不是空列表）。
    expect(useDiscoverStore.getState().boards.length).toBe(1)
    expect(useDiscoverStore.getState().matching).toBe(false)
  })

  it('④ 曲库查不动 ⇒ 榜单**仍在** ＋ 如实说「暂时无法匹配曲库」', async () => {
    const board = boardOf('t124-d')
    installBridge(board)
    const deps = depsOf({
      searchArtists: async () => {
        throw new Error('NAS 不通')
      },
    })

    await useDiscoverStore.getState().loadCharts(deps)

    const state = useDiscoverStore.getState()
    expect(state.matchError).toBeTruthy()
    // ⚠️ 榜单**已经出了**（先出）⇒ 用户先看到榜单，不用干等。
    expect(state.charts.length).toBe(1)
    expect(state.boards.length).toBe(1)
    // ⚠️ 但**没有结论** ⇒ 全部 pending（界面显示「匹配中…」，**不是**「不在曲库」）。
    expect(state.boards[0]?.entries.every((entry) => entry.pending === true)).toBe(true)
    expect(state.matching).toBe(false)
  })

  it('⑤ 界面：pending 的条目显示「匹配中…」，**不是**「不在曲库」', async () => {
    const board = boardOf('t124-e')
    installBridge(board)
    let release: (value: Artist[]) => void = () => {}
    const gate = new Promise<Artist[]>((resolve) => {
      release = resolve
    })
    const pending = useDiscoverStore.getState().loadCharts(depsOf({ searchArtists: () => gate }))
    await waitFor(() => expect(useDiscoverStore.getState().boards.length).toBe(1))

    render(<DiscoverPage onPlay={() => {}} />)

    await waitFor(() => expect(screen.getAllByText('匹配中…').length).toBeGreaterThan(0))
    // ⚠️ **一个「不在曲库」都不许出现**（那是没有结论时**说错话**）。
    expect(screen.queryAllByText('不在曲库').length).toBe(0)
    // ⚠️ 状态行也要说「正在匹配」，不能报「0 条命中」。
    expect(screen.getByText(/正在匹配你的曲库/)).toBeTruthy()

    release([])
    await pending
  })
})
