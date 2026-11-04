// ---------------------------------------------------------------------------
// 新建 / 删除歌单（Task 26）
// ---------------------------------------------------------------------------
//
// 覆盖的是一处**真实缺口**：T16 把「新建歌单」做在了**搜索页**的写回区里 ——
//
// - 「建歌单」这件事**藏在一个跟歌单毫无关系的页面**里；
// - 而那个账号**一个歌单都没有**（`playlist/list` → `total=0`）
//   → 用户打开「歌单」页只看到一句「暂无歌单」，**连建一个的地方都没有**。
//
// 本文件钉：
// 1. 歌单页有「新建歌单」入口（名字输入 + 按钮）；
// 2. 建完 → 列表刷新 → **新歌单立刻出现** + 成功提示；
// 3. 服务端**不回显 guid** → 按名字找回并选中，且**如实说明**（不假装拿到 id）；
// 4. 空名字 → 按钮禁用；
// 5. 建单失败 → 「操作失败」提示（不假装成功）；
// 6. 删除歌单是**两步确认**（第一次只改文案，第二次才真删）。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { PlaylistsPage } from '../src/pages/PlaylistsPage'
import type { PlaylistWritebackApi } from '../src/api/playlist'
import type { LibraryApi } from '../src/state/libraryStore'
import type { Album, Artist, Genre, Playlist, Song } from '../shared/types'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** 造一个占位歌单。 */
function makePlaylist(id: string, name: string): Playlist {
  return { id, name, coverId: null, trackCount: 0 }
}

/**
 * 空的曲库接口（歌单列表由假接口给）。
 *
 * ⚠️ `playlists` **同步取快照**（真实接口每次都返回**新数组**）：
 *    快照在**调用那一刻**取走 —— 于是「页面初始拉列表」一定发生在
 *    「新建歌单」**之前**（`loadAll` 里的 `fetcher()` 是同步调用的）。
 *    若把快照推迟到 `await` 之后再取，初始那次请求就可能**晚于新建**落地，
 *    把新建后的列表一起带回来 → 「页面到底有没有重新拉列表」这条断言
 *    就**测不出来了**（空断言）。
 */
function makeLibraryApi(playlists: () => Playlist[]): LibraryApi {
  return {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as Genre[], total: 0 })),
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    favorites: vi.fn(async () => [] as Song[]),
    // ⚠️ **返回快照（副本）**：真实接口每次都返回**新数组**。
    //    若这里直接把同一个数组交出去，store 拿到的就是「活数组」，
    //    之后往里 push 会**自动出现在界面上** → 测不出「页面有没有重新拉列表」。
    playlists: vi.fn(async () => [...playlists()]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    history: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    album: vi.fn(async () => null),
    albumSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
  }
}

/** 造一个歌单写回接口（操作的是同一份歌单列表）。 */
function makeWritebackApi(
  list: Playlist[],
  overrides: Partial<PlaylistWritebackApi> = {},
): PlaylistWritebackApi {
  const base: PlaylistWritebackApi = {
    list: vi.fn(async () => list),
    create: vi.fn(async (name: string) => {
      const id = `playlist-${list.length + 1}`
      list.push(makePlaylist(id, name))
      return id
    }),
    addTracks: vi.fn(async () => undefined),
    removeTracks: vi.fn(async () => undefined),
    remove: vi.fn(async (id: string) => {
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
    }),
  }
  return { ...base, ...overrides }
}

// ---------------------------------------------------------------------------

describe('歌单页：新建 / 删除歌单', () => {
  it('有「新建歌单」入口（名字输入 + 按钮）', async () => {
    const list: Playlist[] = []
    render(
      createElement(PlaylistsPage, {
        api: makeLibraryApi(() => list),
        playlistApi: makeWritebackApi(list),
      }),
    )

    expect(await screen.findByPlaceholderText('新歌单名称')).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建歌单' })).toBeTruthy()
  })

  it('建完：歌单**立刻出现在列表里** + 成功提示', async () => {
    const list: Playlist[] = []
    const writeback = makeWritebackApi(list)
    render(
      createElement(PlaylistsPage, {
        api: makeLibraryApi(() => list),
        playlistApi: writeback,
      }),
    )

    fireEvent.change(screen.getByPlaceholderText('新歌单名称'), {
      target: { value: '我的新歌单' },
    })
    fireEvent.click(screen.getByRole('button', { name: '新建歌单' }))

    await waitFor(() => expect(writeback.create).toHaveBeenCalledWith('我的新歌单'))
    // 新歌单**立刻**出现在列表里（列表已刷新）。
    // ⚠️ 必须**限定在歌单列表里**找：成功提示「歌单「我的新歌单」已创建」里也含这个名字
    //    （不限定的话这条断言会命中提示文案 → **空断言**，测不出「列表有没有刷新」）。
    const grid = await screen.findByRole('list', { name: '歌单列表' })
    expect(await within(grid).findByText('我的新歌单')).toBeTruthy()
    // 成功提示。
    expect((await screen.findByRole('status')).textContent).toContain('已创建')
    // 输入框被清空（可以接着建下一个）。
    expect((screen.getByPlaceholderText('新歌单名称') as HTMLInputElement).value).toBe('')
  })

  it('名字为空 → 按钮禁用（点不动）', async () => {
    const list: Playlist[] = []
    const writeback = makeWritebackApi(list)
    render(
      createElement(PlaylistsPage, {
        api: makeLibraryApi(() => list),
        playlistApi: writeback,
      }),
    )

    const button = screen.getByRole('button', { name: '新建歌单' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(writeback.create).not.toHaveBeenCalled()
  })

  it('服务端**不回显 guid** → 按名字找回并选中，且如实说明', async () => {
    const list: Playlist[] = []
    const writeback = makeWritebackApi(list, {
      // 模拟「服务端不回显 guid」：建了但返回空串。
      create: vi.fn(async (name: string) => {
        list.push(makePlaylist('playlist-x', name))
        return ''
      }),
    })
    render(
      createElement(PlaylistsPage, {
        api: makeLibraryApi(() => list),
        playlistApi: writeback,
      }),
    )

    fireEvent.change(screen.getByPlaceholderText('新歌单名称'), {
      target: { value: '按名找回' },
    })
    fireEvent.click(screen.getByRole('button', { name: '新建歌单' }))

    expect(await screen.findByText('按名找回')).toBeTruthy()
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('未能拿到歌单标识')
  })

  it('建单失败 → 「操作失败」提示（不假装成功）', async () => {
    const list: Playlist[] = []
    const writeback = makeWritebackApi(list, {
      create: vi.fn(async () => {
        throw new Error('服务端拒绝')
      }),
    })
    render(
      createElement(PlaylistsPage, {
        api: makeLibraryApi(() => list),
        playlistApi: writeback,
      }),
    )

    fireEvent.change(screen.getByPlaceholderText('新歌单名称'), {
      target: { value: '会失败的歌单' },
    })
    fireEvent.click(screen.getByRole('button', { name: '新建歌单' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('操作失败')
    expect(alert.textContent).toContain('服务端拒绝')
  })

  it('删除歌单是**两步确认**：第一次只改文案，第二次才真删', async () => {
    const list: Playlist[] = [makePlaylist('playlist-1', '待删的歌单')]
    const writeback = makeWritebackApi(list)
    render(
      createElement(PlaylistsPage, {
        api: makeLibraryApi(() => list),
        playlistApi: writeback,
      }),
    )

    // 先选中歌单（删除按钮只对「当前选中的歌单」有意义）。
    fireEvent.click(await screen.findByText('待删的歌单'))

    const deleteButton = await screen.findByRole('button', { name: '删除歌单' })
    fireEvent.click(deleteButton)

    // 第一步：按钮变成「确认删除？」，**但还没删**。
    expect((await screen.findByRole('button', { name: '确认删除？' })).textContent).toContain('确认删除')
    expect(writeback.remove).not.toHaveBeenCalled()
    expect(screen.queryByText('待删的歌单')).not.toBeNull()

    // 第二步：真删。
    fireEvent.click(screen.getByRole('button', { name: '确认删除？' }))
    await waitFor(() => expect(writeback.remove).toHaveBeenCalledWith('playlist-1'))
    await waitFor(() => expect(screen.queryByText('待删的歌单')).toBeNull())
  })

  it('「取消」能退出删除确认（不删）', async () => {
    const list: Playlist[] = [makePlaylist('playlist-1', '留下的歌单')]
    const writeback = makeWritebackApi(list)
    render(
      createElement(PlaylistsPage, {
        api: makeLibraryApi(() => list),
        playlistApi: writeback,
      }),
    )

    fireEvent.click(await screen.findByText('留下的歌单'))
    fireEvent.click(await screen.findByRole('button', { name: '删除歌单' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))

    expect(screen.getByRole('button', { name: '删除歌单' })).toBeTruthy()
    expect(writeback.remove).not.toHaveBeenCalled()
    expect(screen.queryByText('留下的歌单')).not.toBeNull()
  })
})
