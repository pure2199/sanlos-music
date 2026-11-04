// ---------------------------------------------------------------------------
// T38 未登录时的界面（外壳层）
// ---------------------------------------------------------------------------
//
// 用户诉求：「让软件没登陆的时候，也可以做为音乐播放器」。
//
// 覆盖：
// - **未登录**时顶栏只留「连接」+「本地」，**曲库导航整组不渲染**、「搜索」也不在；
// - **未登录**时主区默认停在「本地音乐」页（打开软件就是个播放器）；
// - **已登录**时曲库导航恢复，「搜索」也回来；
// - 启动时**已经登录** → 自动进「歌曲」页；
// - 用户**已经点过导航** → 启动恢复**不抢**他的手。
//
// ⚠️ 叶子页面全部打桩（与 `test/app-routing.test.tsx` 同款）——
//    本文件只关心外壳的可见性与默认视图，不碰各页的数据加载。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

import type { AuthSessionInfo } from '../shared/bridge'
import { useSessionStore } from '../src/state/sessionStore'

vi.mock('../src/pages/LoginPage', () => ({
  LoginPage: () => <div data-testid="view-connect">连接页</div>,
}))
vi.mock('../src/pages/LocalMusicPage', () => ({
  LocalMusicPage: () => <div data-testid="view-local">本地音乐页</div>,
}))
vi.mock('../src/pages/SearchPage', () => ({
  SearchPage: () => <div data-testid="view-search">搜索页</div>,
}))
vi.mock('../src/pages/SongsPage', () => ({
  SongsPage: () => <div data-testid="view-songs">歌曲页</div>,
}))
vi.mock('../src/pages/FavoritesPage', () => ({
  FavoritesPage: () => <div data-testid="view-favorites">收藏页</div>,
}))
vi.mock('../src/pages/PlaylistsPage', () => ({
  PlaylistsPage: () => <div data-testid="view-playlists">歌单页</div>,
}))
vi.mock('../src/pages/AlbumsPage', () => ({
  AlbumsPage: () => <div data-testid="view-albums">专辑页</div>,
}))
vi.mock('../src/pages/ArtistsPage', () => ({
  ArtistsPage: () => <div data-testid="view-artists">歌手页</div>,
}))
vi.mock('../src/pages/GenresPage', () => ({
  GenresPage: () => <div data-testid="view-genres">风格页</div>,
}))
vi.mock('../src/pages/HistoryPage', () => ({
  HistoryPage: () => <div data-testid="view-history">最近页</div>,
}))
vi.mock('../src/pages/DetailPage', () => ({
  DetailPage: () => <div data-testid="view-detail">详情页</div>,
}))
vi.mock('../src/pages/FullPlayerPage', () => ({
  FullPlayerPage: () => <div data-testid="view-full-player">全屏播放</div>,
}))
vi.mock('../src/components/PlayerBar', () => ({
  PlayerBar: () => <div data-testid="player-bar" />,
}))
vi.mock('../src/components/ConnectionBadge', () => ({
  ConnectionBadge: () => <div data-testid="connection-badge" />,
}))
vi.mock('../src/components/SettingsPanel', () => ({
  SettingsPanel: () => <div data-testid="view-settings">设置页</div>,
}))

import App from '../src/App'

/** 已登录的脱敏会话形态。 */
const CONNECTED: AuthSessionInfo = {
  connected: true,
  mode: 'password',
  username: 'demo',
  serverLabel: 'example',
  isRelay: false,
}

/** 未登录的脱敏会话形态。 */
const DISCONNECTED: AuthSessionInfo = {
  connected: false,
  mode: null,
  username: null,
  serverLabel: null,
  isRelay: false,
}

/** 挂一个「restore 什么时候落定由我说了算」的假认证桥。 */
function installBridge(): { resolveRestore: (info: AuthSessionInfo) => void } {
  let resolveRestore: (info: AuthSessionInfo) => void = () => undefined
  ;(window as unknown as { fn?: unknown }).fn = {
    restore: () =>
      new Promise<AuthSessionInfo>((resolve) => {
        resolveRestore = resolve
      }),
    connectionInfo: async () => null,
    logout: async () => DISCONNECTED,
  }
  return {
    resolveRestore: (info) => {
      resolveRestore(info)
    },
  }
}

beforeEach(() => {
  useSessionStore.setState({
    session: DISCONNECTED,
    connection: null,
    candidates: [],
    restored: false,
  })
})

afterEach(() => {
  delete (window as unknown as { fn?: unknown }).fn
})

describe('T38 未登录时的界面', () => {
  it('未登录：顶栏只有「连接」+「本地」，曲库导航**整组不渲染**、「搜索」也不在', () => {
    installBridge()
    useSessionStore.setState({ session: DISCONNECTED, restored: true })
    render(<App />)

    expect(screen.getByRole('button', { name: '连接' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '本地' })).toBeTruthy()
    // ⚠️ 曲库导航全都需要 NAS → 未登录时**一点都不能露**（点进去只会一路失败）。
    expect(screen.queryByRole('navigation', { name: '曲库导航' })).toBeNull()
    expect(screen.queryByRole('button', { name: '搜索' })).toBeNull()
    expect(screen.queryByRole('button', { name: '歌曲' })).toBeNull()
  })

  it('未登录：主区默认停在「本地音乐」页（打开软件就是个播放器）', () => {
    installBridge()
    useSessionStore.setState({ session: DISCONNECTED, restored: true })
    render(<App />)

    expect(screen.getByTestId('view-local')).toBeTruthy()
    expect(screen.queryByTestId('view-connect')).toBeNull()
  })

  it('已登录：曲库导航恢复，「搜索」也回来', () => {
    installBridge()
    useSessionStore.setState({ session: CONNECTED, restored: true })
    render(<App />)

    expect(screen.getByRole('navigation', { name: '曲库导航' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '歌曲' })).toBeTruthy()
  })

  it('启动时**已经登录** → 自动进「歌曲」页', async () => {
    const bridge = installBridge()
    useSessionStore.setState({ session: CONNECTED, restored: false })
    render(<App />)

    // 主区此刻还停在本地页（restore 还没落定）。
    expect(screen.getByTestId('view-local')).toBeTruthy()

    await act(async () => {
      bridge.resolveRestore(CONNECTED)
      await Promise.resolve()
    })

    expect(screen.getByTestId('view-songs')).toBeTruthy()
  })

  it('用户**已经点过导航** → 启动恢复**不抢**他的手', async () => {
    const bridge = installBridge()
    useSessionStore.setState({ session: CONNECTED, restored: false })
    render(<App />)

    // ⚠️ 鉴别力：用户在 restore 落定**之前**就点开了「本地」——
    //    若自动切页不避让，这里会被拽回「歌曲」页。
    fireEvent.click(screen.getByRole('button', { name: '本地' }))
    expect(screen.getByTestId('view-local')).toBeTruthy()

    await act(async () => {
      bridge.resolveRestore(CONNECTED)
      await Promise.resolve()
    })

    expect(screen.getByTestId('view-local')).toBeTruthy()
    expect(screen.queryByTestId('view-songs')).toBeNull()
  })

  it('未登录时点「本地」→ 停在本地页（不会被自动切页带走）', () => {
    installBridge()
    useSessionStore.setState({ session: DISCONNECTED, restored: true })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(screen.getByTestId('view-connect')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '本地' }))
    expect(screen.getByTestId('view-local')).toBeTruthy()
    expect(screen.queryByTestId('view-connect')).toBeNull()
  })
})
