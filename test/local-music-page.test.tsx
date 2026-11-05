// ---------------------------------------------------------------------------
// T38 本地音乐页
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **未登录**时给出提示条 + 「去登录」出口（**没登录也能当播放器用**）；
// - 两个分区（本地文件 / 已下载）都在；
// - 「添加文件」→ 弹对话框（`pickLocalFiles`）→ 交给主进程登记（`addLocalTracks`）；
// - 「添加文件夹」→ 弹对话框（`pickLocalFolder`）→ 交给主进程登记（`addLocalFolder`）；
// - 用户**取消**对话框 → **不报错**、也不做任何登记；
// - 行内「移除」→ 调 `removeLocalTrack`；
// - 双击一行 → 把**整队**交给 `onPlay`。
//
// ⚠️ 测试数据一律用占位值，不写真实路径 / 歌名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { PlayerBridge } from '../shared/playerBridge'
import { LocalMusicPage } from '../src/pages/LocalMusicPage'
import { useDownloadStore } from '../src/state/downloadStore'
import { useLocalLibraryStore } from '../src/state/localLibraryStore'
import { useSessionStore } from '../src/state/sessionStore'

const LOCAL_ID = 'local:0123456789abcdef'

/** 登记项（占位值）。 */
const ITEM = {
  id: LOCAL_ID,
  path: 'D:\\Music\\本地歌手 - 本地歌名.flac',
  title: '本地歌名',
  artist: '本地歌手',
  size: 4096,
  ext: 'flac',
  addedAt: '2026-01-01T00:00:00.000Z',
}

/** 假桥（只实现本地曲目那六个方法）。 */
function fakeBridge(overrides: Partial<Record<string, unknown>> = {}): PlayerBridge {
  return {
    listLocalTracks: vi.fn(async () => [ITEM]),
    pickLocalFiles: vi.fn(async () => [ITEM.path]),
    pickLocalFolder: vi.fn(async () => 'D:\\Music'),
    addLocalTracks: vi.fn(async () => [ITEM]),
    addLocalFolder: vi.fn(async () => [ITEM]),
    removeLocalTrack: vi.fn(async () => []),
    ...overrides,
  } as unknown as PlayerBridge
}

/** 把假桥挂到 `globalThis.fnPlayer`（渲染层唯一的入口）。 */
function installBridge(bridge: PlayerBridge): void {
  ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
}

beforeEach(() => {
  useLocalLibraryStore.setState({ items: [], loading: false, error: null })
  useDownloadStore.setState({ entries: {}, tasks: {}, localFirst: true, error: null, dir: '' })
  useSessionStore.setState({
    session: {
      connected: false,
      mode: null,
      username: null,
      serverLabel: null,
      isRelay: false,
    },
    restored: true,
  })
})

afterEach(() => {
  delete (globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer
})

describe('T38 本地音乐页', () => {
  it('未登录时给出提示条与「去登录」出口（**没登录也能当播放器用**）', async () => {
    installBridge(fakeBridge())
    const onGoToLogin = vi.fn()
    render(<LocalMusicPage onGoToLogin={onGoToLogin} />)

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('未登录')
    expect(screen.getByRole('button', { name: '去登录' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '去登录' }))
    expect(onGoToLogin).toHaveBeenCalledTimes(1)
  })

  it('已登录时**不**显示「未登录」提示条', async () => {
    installBridge(fakeBridge())
    useSessionStore.setState({
      session: {
        connected: true,
        mode: 'password',
        username: 'demo',
        serverLabel: 'example',
        isRelay: false,
      },
    })
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('listbox', { name: '本地文件列表' })).toBeTruthy())
    expect(screen.queryByText('未登录')).toBeNull()
  })

  it('两个分区都在：「本地文件」与「已下载」', async () => {
    installBridge(fakeBridge())
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('listbox', { name: '本地文件列表' })).toBeTruthy())
    expect(screen.getByRole('region', { name: '本地文件' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '已下载' })).toBeTruthy()
    // ⚠️ 空列表时 `SongList` 只渲染空态（**不渲染 listbox**）→ 这里断言空态文案。
    expect(screen.getByText('还没有下载过曲目')).toBeTruthy()
  })

  it('本地文件出现在「本地文件」分区里', async () => {
    installBridge(fakeBridge())
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByText('本地歌名')).toBeTruthy())
    expect(screen.getByText('本地歌手')).toBeTruthy()
  })

  it('已下载的条目出现在「已下载」分区里', async () => {
    installBridge(fakeBridge())
    useDownloadStore.setState({
      entries: {
        track_example01: {
          songId: 'track_example01',
          file: 'C:\\Music\\示例歌手 - 示例歌名.flac',
          bytes: 2048,
          ext: 'flac',
          downloadedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByText('示例歌名')).toBeTruthy())
    expect(screen.getByText('示例歌手')).toBeTruthy()
  })

  it('点「添加文件」→ 弹对话框 → 把选中的路径交给主进程登记', async () => {
    const bridge = fakeBridge()
    installBridge(bridge)
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '添加文件' }))

    await waitFor(() => {
      expect((bridge.pickLocalFiles as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })
    expect((bridge.addLocalTracks as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith([ITEM.path])
  })

  it('点「添加文件夹」→ 弹对话框 → 把目录交给主进程扫描', async () => {
    const bridge = fakeBridge()
    installBridge(bridge)
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件夹' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))

    await waitFor(() => {
      expect((bridge.pickLocalFolder as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })
    expect((bridge.addLocalFolder as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('D:\\Music')
  })

  it('用户**取消**对话框 → 不登记、也不报错', async () => {
    const bridge = fakeBridge({
      pickLocalFiles: vi.fn(async () => []),
      pickLocalFolder: vi.fn(async () => ''),
    })
    installBridge(bridge)
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '添加文件' }))
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))

    await waitFor(() => {
      expect((bridge.pickLocalFiles as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    })
    expect((bridge.addLocalTracks as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((bridge.addLocalFolder as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('行内「移除」→ 调 `removeLocalTrack`（**不删用户的文件**）', async () => {
    const bridge = fakeBridge()
    installBridge(bridge)
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByText('本地歌名')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '移除 本地歌名' }))

    await waitFor(() => {
      expect((bridge.removeLocalTrack as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(LOCAL_ID)
    })
  })

  it('双击一行 → 把**整队**交给 `onPlay`', async () => {
    installBridge(fakeBridge())
    const onPlay = vi.fn()
    render(<LocalMusicPage onPlay={onPlay} />)

    await waitFor(() => expect(screen.getByText('本地歌名')).toBeTruthy())
    fireEvent.doubleClick(screen.getByText('本地歌名'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    const [song, index, list] = onPlay.mock.calls[0] as [
      { id: string },
      number,
      { id: string }[],
    ]
    expect(song.id).toBe(LOCAL_ID)
    expect(index).toBe(0)
    expect(list).toHaveLength(1)
  })

  it('空列表时给出空态提示（不是白屏）', async () => {
    installBridge(fakeBridge({ listLocalTracks: vi.fn(async () => []) }))
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByText('还没有添加本地音乐')).toBeTruthy())
    expect(screen.getByText('还没有下载过曲目')).toBeTruthy()
  })

  it('界面上写明「标签优先、文件名兜底」与「移除不删文件」（T39）', async () => {
    installBridge(fakeBridge())
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件' })).toBeTruthy())
    const hint = screen.getByText(/优先读文件内标签/)
    // ⚠️ T39（前提被用户批准改写）：歌名 / 歌手**优先取文件内嵌标签**。
    expect(hint.textContent).toContain('优先读文件内标签')
    // ⚠️ 读不到才按文件名推断——**兜底说明不能少**。
    expect(hint.textContent).toContain('读不到才按文件名推断')
    // ⚠️ 「移除不删用户的音乐文件」这个承诺**一字未改**。
    expect(hint.textContent).toContain('不会删除磁盘上的文件')
  })

  it('还有没解析完的条目 → 显示「正在读取标签，还剩 N 首…」（T39）', async () => {
    installBridge(fakeBridge())
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByText(/正在读取标签，还剩 1 首/)).toBeTruthy())
  })

  it('条目都解析完了 → **不**显示进度提示（T39）', async () => {
    installBridge(
      fakeBridge({ listLocalTracks: vi.fn(async () => [{ ...ITEM, tagSource: 'tag' }]) }),
    )
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('listbox', { name: '本地文件列表' })).toBeTruthy())
    expect(screen.queryByText(/正在读取标签/)).toBeNull()
  })

  it('时长来自标签 → 列表里**显示得出**（T39）', async () => {
    installBridge(
      fakeBridge({
        listLocalTracks: vi.fn(async () => [{ ...ITEM, duration: 180, tagSource: 'tag' }]),
      }),
    )
    render(<LocalMusicPage />)

    await waitFor(() => expect(screen.getByRole('listbox', { name: '本地文件列表' })).toBeTruthy())
    expect(screen.getByText('3:00')).toBeTruthy()
  })
})
