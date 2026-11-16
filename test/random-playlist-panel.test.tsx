// ---------------------------------------------------------------------------
// T97：「随机 20 首」面板的组件级测试
// ---------------------------------------------------------------------------
//
// 钉住的行为：
// 1. 点「随机 20 首」⇒ 真的抽一批出来（并说明抽到几首）；
// 2. 「换一批」⇒ **重新抽样**（不是拿旧的糊弄）；
// 3. 「存为歌单」⇒ 调 `save(名字, 歌 id 列表)`，成功后**说明成功**并通知外部；
// 4. 存回失败 ⇒ **如实报错**，不假装成功；
// 5. 抽样失败 ⇒ **如实报错**；
// 6. 「播放全部」⇒ 走**整队口径**（第三个参数 = 这一批全部的歌）。
//
// ⚠️ 曲库是**造出来的**（不依赖真实规模，也**不依赖真实歌名**）。
// ---------------------------------------------------------------------------

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Song } from '../shared/types'
import { RandomPlaylistPanel } from '../src/components/RandomPlaylistPanel'
import type { RandomSampleDeps } from '../src/api/randomPlaylist'

/** 造一首歌。 */
function song(id: string, title: string): Song {
  return {
    id,
    title,
    artist: '歌手',
    artistId: 'a1',
    album: '专辑',
    albumId: 'al1',
    coverId: '',
    duration: 200,
    favorite: false,
    codec: 'FLAC',
    bitrate: 900,
    sampleRate: 44100,
    bitDepth: 16,
    year: null,
    trackNo: null,
    discNo: null,
    isrc: null,
    path: `/x/${id}.flac`,
  } as Song
}

/** 造一批歌。 */
function songs(count: number, offset = 0): Song[] {
  return Array.from({ length: count }, (_, index) => song(`s${offset + index}`, `曲目 ${offset + index}`))
}

/** 假抽样依赖（记录被抽了几次）。 */
function fakeDeps(total = 400, page?: (page: number) => Song[]) {
  const calls = { total: 0, page: 0 }
  const deps: RandomSampleDeps = {
    total: async () => {
      calls.total += 1
      return total
    },
    page: async (pageNumber: number) => {
      calls.page += 1
      return page ? page(pageNumber) : songs(200, pageNumber * 1000)
    },
  }
  return { deps, calls }
}

describe('RandomPlaylistPanel', () => {
  it('点「随机 20 首」⇒ 抽出一批并**说明抽到几首**', async () => {
    const { deps } = fakeDeps()
    render(<RandomPlaylistPanel deps={deps} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))

    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 20 首')).toBeTruthy()
    })
    // 列表里真的有歌（虚拟滚动只渲染可视区内的行 ⇒ 断言「有行」而不是「第一首是它」；
    // ⚠️ 结果是**洗过牌**的 ⇒ 不能断言某一首固定排在最上面）。
    expect(screen.getAllByText(/^曲目 \d+$/).length).toBeGreaterThan(0)
  })

  it('「换一批」⇒ **重新抽样**（不是拿旧的糊弄）', async () => {
    const { deps, calls } = fakeDeps()
    render(<RandomPlaylistPanel deps={deps} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))
    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 20 首')).toBeTruthy()
    })
    expect(calls.total).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    await waitFor(() => {
      expect(calls.total).toBe(2)
    })
  })

  it('「换一批」⇒ 拿到的是**新的一批**（内容确实变了，不只是又调了一次接口）', async () => {
    // ⚠️ 用**两轮不同的曲库**把「重新抽样」钉死：第一轮 400 首（⇒ 抽 20 首）；
    //    第二轮只有 8 首 ⇒ 面板必须如实说「8 首」。
    //    ⇒ 若「换一批」沿用上一批，提示会一直停在「20 首」⇒ 断言变红。
    //    ⚠️ `total` 只决定**页数**、不决定取回多少首 ⇒ 「第二轮只有 8 首」
    //    必须由 `page` 的返回值体现（见下）。
    let totalCalls = 0
    let pageCalls = 0
    const deps: RandomSampleDeps = {
      total: async () => {
        totalCalls += 1
        return totalCalls === 1 ? 400 : 8
      },
      page: async () => {
        pageCalls += 1
        // 第一轮抽样（total=400 ⇒ 2 页）会取 2 次 ⇒ 之后都算「第二轮」。
        return pageCalls <= 2 ? songs(200, 0) : songs(8, 0)
      },
    }
    render(<RandomPlaylistPanel deps={deps} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))
    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 20 首')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 8 首')).toBeTruthy()
    })
  })

  it('「存为歌单」⇒ 调 `save(名字, 歌 id)`，成功后**说明成功**并通知外部', async () => {
    const { deps } = fakeDeps()
    const save = vi.fn(async (_name: string, _ids: string[]) => 'pl1')
    const onSaved = vi.fn()
    render(<RandomPlaylistPanel deps={deps} save={save} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))
    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 20 首')).toBeTruthy()
    })

    const nameInput = screen.getByLabelText('随机歌单名称') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '我的随机歌单' } })
    fireEvent.click(screen.getByRole('button', { name: '存为歌单' }))

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1)
    })
    expect(save.mock.calls[0]?.[0]).toBe('我的随机歌单')
    const ids = save.mock.calls[0]?.[1] as string[]
    expect(ids).toHaveLength(20)
    expect(new Set(ids).size).toBe(20)
    await waitFor(() => {
      expect(screen.getByText('歌单「我的随机歌单」已保存（20 首）')).toBeTruthy()
    })
    expect(onSaved).toHaveBeenCalledWith('pl1')
  })

  it('歌单名**超过 32 个字符** ⇒ **本地就拦住**（不调 save，也不去撞服务端）', async () => {
    // ⚠️ 服务端实测（2026-11-16，真实 NAS）：`/playlist/create` 的 `name`
    //    **超过 32 个字符就被拒**（`code=100002` / `invalid arguments`）——
    //    实测边界 **32 OK / 33 拒**（按**字符数**算，不是字节数）。
    const { deps } = fakeDeps()
    const save = vi.fn(async () => 'pl1')
    render(<RandomPlaylistPanel deps={deps} save={save} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))
    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 20 首')).toBeTruthy()
    })

    const nameInput = screen.getByLabelText('随机歌单名称') as HTMLInputElement
    const saveButton = () => screen.getByRole('button', { name: '存为歌单' }) as HTMLButtonElement

    // 33 个字符 ⇒ **禁用** + 中文提示 + 不调 save。
    fireEvent.change(nameInput, { target: { value: 'x'.repeat(33) } })
    await waitFor(() => {
      expect(screen.getByText('歌单名不能超过 32 个字符（现在 33 个）')).toBeTruthy()
    })
    expect(saveButton().disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()

    // 32 个字符 ⇒ **放行**（边界是「≤ 32」，不是「< 32」）。
    fireEvent.change(nameInput, { target: { value: 'x'.repeat(32) } })
    await waitFor(() => {
      expect(saveButton().disabled).toBe(false)
    })
    expect(screen.queryByText(/歌单名不能超过/)).toBeNull()
  })

  it('存回失败 ⇒ **如实报错**，不假装成功', async () => {
    const { deps } = fakeDeps()
    const save = vi.fn(async (_name: string, _ids: string[]) => {
      throw new Error('服务端拒绝')
    })
    render(<RandomPlaylistPanel deps={deps} save={save} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))
    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 20 首')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '存为歌单' }))

    await waitFor(() => {
      expect(screen.getByText('存为歌单失败：服务端拒绝')).toBeTruthy()
    })
  })

  it('抽样失败 ⇒ **如实报错**', async () => {
    const deps: RandomSampleDeps = {
      total: async () => {
        throw new Error('连不上 NAS')
      },
      page: async () => [],
    }
    render(<RandomPlaylistPanel deps={deps} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))

    await waitFor(() => {
      expect(screen.getByText('随机失败：连不上 NAS')).toBeTruthy()
    })
  })

  it('「播放全部」⇒ 走**整队口径**（第三个参数 = 这一批全部的歌）', async () => {
    const { deps } = fakeDeps()
    const onPlay = vi.fn()
    render(<RandomPlaylistPanel deps={deps} onPlay={onPlay} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))
    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 20 首')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '播放全部' }))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const call = onPlay.mock.calls[0] as [Song, number, Song[]]
    expect(call[1]).toBe(0)
    expect(call[2]).toHaveLength(20)
  })

  it('库里没那么多 ⇒ **如实少给**（面板说明实际抽到几首）', async () => {
    const { deps } = fakeDeps(8, () => songs(8))
    render(<RandomPlaylistPanel deps={deps} />)

    fireEvent.click(screen.getByRole('button', { name: '随机 20 首' }))

    await waitFor(() => {
      expect(screen.getByText('从你的曲库随机挑了 8 首')).toBeTruthy()
    })
  })
})
