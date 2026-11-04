// ---------------------------------------------------------------------------
// T28 从曲库页批量把歌加进歌单
// ---------------------------------------------------------------------------
//
// 覆盖的是一处**真实缺口**：写回器（`playlist/add-track`）早就写好了、而且
// T25 已**真机校准**（`{ guid, trackGUIDs: [id] }`，歌单详情里那几首真的出现），
// 但入口**只在搜索页**的写回区里 —— 在曲库里选好一整批歌，却无处可加。
//
// 本文件钉：
// 1. 没选中 → **不渲染**「加入歌单」；
// 2. 点开才**懒加载**歌单列表（不是每次渲染都拉）；
// 3. 写回：调用 `addTracks(playlistId, ids)` + 提示「已把 N 首加入歌单「X」」
//    + **清空选中**（`onAdded`）；
// 4. **一个歌单都没有** → 如实说明，不假装；
// 5. 写回失败 → 「操作失败：…」；
// 6. **面板是浮层**（`position: absolute`）—— 展开不能改变高度，
//    否则会把列表顶下去 → 打断「双击播放」（T27 踩过这个坑）。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Playlist, Song } from '../shared/types'
import type { PlaylistWritebackApi } from '../src/api/playlist'
import type { LibraryStoreApi } from '../src/state/libraryStore'
import { AddToPlaylist } from '../src/components/AddToPlaylist'
import { BatchDownloadBar } from '../src/components/BatchDownloadBar'

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

const SONG_A = makeSong('track_add_a', '占位歌 A')
const SONG_B = makeSong('track_add_b', '占位歌 B')

/** 造一个占位歌单。 */
function makePlaylist(id: string, name: string): Playlist {
  return { id, name, coverId: null, trackCount: 0 }
}

/** 造一个假歌单写回接口。 */
function makePlaylistApi(
  playlists: Playlist[],
  overrides: Partial<PlaylistWritebackApi> = {},
): PlaylistWritebackApi {
  const base: PlaylistWritebackApi = {
    list: vi.fn(async () => playlists),
    create: vi.fn(async () => 'playlist-new'),
    addTracks: vi.fn(async () => undefined),
    removeTracks: vi.fn(async () => undefined),
  }
  return { ...base, ...overrides }
}

// ---------------------------------------------------------------------------

describe('加入歌单（T28）', () => {
  it('没选中 → **不渲染**「加入歌单」', () => {
    const { container } = render(
      createElement(AddToPlaylist, { songs: [], playlistApi: makePlaylistApi([]) }),
    )
    expect(container.firstChild).toBeNull()
  })

  it('选中 → 出现「加入歌单」；**点开才**拉歌单列表（懒加载）', async () => {
    const api = makePlaylistApi([makePlaylist('p1', '占位歌单')])
    render(
      createElement(AddToPlaylist, {
        songs: [SONG_A, SONG_B],
        playlistApi: api,
      }),
    )

    // ⚠️ **还没点开** → 不该发请求。
    expect(api.list).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist-button'))

    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('option', { name: '占位歌单' })).toBeTruthy()
  })

  it('写回：调用 addTracks + 提示「已把 N 首加入歌单」+ **清空选中**', async () => {
    const api = makePlaylistApi([makePlaylist('p1', '占位歌单')])
    const onAdded = vi.fn()
    render(
      createElement(AddToPlaylist, {
        songs: [SONG_A, SONG_B],
        playlistApi: api,
        onAdded,
      }),
    )

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist-button'))
    await screen.findByRole('option', { name: '占位歌单' })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))

    await waitFor(() =>
      expect(api.addTracks).toHaveBeenCalledWith('p1', [SONG_A.id, SONG_B.id]),
    )
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('已把 2 首加入歌单「占位歌单」')
    // ⚠️ **清空选中**：否则用户会不小心把同一批歌再加一遍。
    expect(onAdded).toHaveBeenCalledWith('p1', 2)
  })

  it('写回成功后**刷新缓存**（否则就是**假成功**：打开歌单看到的还是旧列表）', async () => {
    const api = makePlaylistApi([makePlaylist('p1', '占位歌单')])
    const refreshPlaylistSongs = vi.fn(async () => undefined)
    const refreshPlaylists = vi.fn(async () => undefined)
    const store = {
      getState: () => ({ refreshPlaylistSongs, refreshPlaylists }),
    } as unknown as LibraryStoreApi

    render(
      createElement(AddToPlaylist, {
        songs: [SONG_A],
        playlistApi: api,
        store,
      }),
    )

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist-button'))
    await screen.findByRole('option', { name: '占位歌单' })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))

    await waitFor(() => expect(refreshPlaylistSongs).toHaveBeenCalledWith('p1'))
    expect(refreshPlaylists).toHaveBeenCalled()
  })

  it('写回**失败** → 不刷新缓存（别把半成品当成功）', async () => {
    const api = makePlaylistApi([makePlaylist('p1', '占位歌单')], {
      addTracks: vi.fn(async () => {
        throw new Error('服务端拒绝')
      }),
    })
    const refreshPlaylistSongs = vi.fn(async () => undefined)
    const store = {
      getState: () => ({ refreshPlaylistSongs, refreshPlaylists: vi.fn(async () => undefined) }),
    } as unknown as LibraryStoreApi

    render(
      createElement(AddToPlaylist, {
        songs: [SONG_A],
        playlistApi: api,
        store,
      }),
    )

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist-button'))
    await screen.findByRole('option', { name: '占位歌单' })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))

    await screen.findByRole('alert')
    expect(refreshPlaylistSongs).not.toHaveBeenCalled()
  })

  it('一个歌单都没有 → **如实说明**（不假装）', async () => {
    const api = makePlaylistApi([])
    render(
      createElement(AddToPlaylist, {
        songs: [SONG_A],
        playlistApi: api,
      }),
    )

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist-button'))

    expect(await screen.findByText('还没有歌单 —— 先到「歌单」页新建一个')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加入' })).toBeNull()
  })

  it('写回失败 → 「操作失败：…」', async () => {
    const api = makePlaylistApi([makePlaylist('p1', '占位歌单')], {
      addTracks: vi.fn(async () => {
        throw new Error('服务端拒绝')
      }),
    })
    render(
      createElement(AddToPlaylist, {
        songs: [SONG_A],
        playlistApi: api,
      }),
    )

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist-button'))
    await screen.findByRole('option', { name: '占位歌单' })
    fireEvent.click(screen.getByRole('button', { name: '加入' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('操作失败')
    expect(alert.textContent).toContain('服务端拒绝')
  })

  it('「取消」能关掉面板', async () => {
    const api = makePlaylistApi([makePlaylist('p1', '占位歌单')])
    render(
      createElement(AddToPlaylist, {
        songs: [SONG_A],
        playlistApi: api,
      }),
    )

    fireEvent.click(screen.getByTestId('fnm-add-to-playlist-button'))
    await screen.findByRole('option', { name: '占位歌单' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('option', { name: '占位歌单' })).toBeNull()
  })

  it('面板是**浮层**（绝对定位）—— 展开不能改变工具条高度', () => {
    const css = readFileSync(
      join(__dirname, '..', 'src', 'components', 'add-to-playlist.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    // ⚠️ 契约测试要**先剥注释再匹配**（否则匹配到注释正文 = 空断言）。
    expect(css).toMatch(/\.fnm-addtoplaylist__panel\s*\{[^}]*position:\s*absolute/)
  })

  it('工具条的高度恒定契约仍在（flex: 0 0 auto + 固定高度）', () => {
    const css = readFileSync(
      join(__dirname, '..', 'src', 'components', 'batch-download-bar.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.fnm-batchdownload\s*\{[^}]*height:\s*36px/)
    expect(css).toMatch(/\.fnm-batchdownload\s*\{[^}]*flex:\s*0 0 auto/)
    // ⚠️ **不能裁剪**：面板是浮层（挂在工具条内部）→ 被裁掉就永远点不到。
    expect(css).not.toMatch(/\.fnm-batchdownload\s*\{[^}]*overflow:\s*hidden/)
  })
})

describe('批量工具条插槽（T28）', () => {
  it('不传 extra → 工具条里**没有**「加入歌单」', () => {
    render(createElement(BatchDownloadBar, { songs: [SONG_A] }))
    expect(screen.queryByTestId('fnm-add-to-playlist-button')).toBeNull()
  })

  it('传 extra → 插槽内容出现在工具条里', () => {
    render(
      createElement(BatchDownloadBar, {
        songs: [SONG_A],
        extra: createElement(AddToPlaylist, {
          songs: [SONG_A],
          playlistApi: makePlaylistApi([]),
        }),
      }),
    )
    expect(screen.getByTestId('fnm-add-to-playlist-button')).toBeTruthy()
  })
})
