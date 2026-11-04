// ---------------------------------------------------------------------------
// Task 2（新版清单）：应用外壳的曲库路由
// Task 3（新版清单）：专辑 / 歌手 / 风格三页也接进路由
//
// ⚠️ 这里**只测路由**：叶子组件全部打桩（不碰真实数据加载），
//    目的是钉住「顶栏哪颗按钮 → 主区渲染哪个页面」这条接线。
//    叶子组件自己的行为由各自的文件负责
//    （三页的整队口径见 `test/library-onplay.test.tsx`）。
//
// ⚠️ 这条用例补上了审计报表指出的缺口：
//    「`src/App.tsx` 接线无测试（全 `test/` 无渲染 `<App/>`）」。
//    审计报表 P0-1「六页孤儿」指的就是这六个曲库页不可达 —— 这里的
//    「六个曲库页两两互斥」用例是它的回归防线。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

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
  AlbumsPage: ({
    onOpenAlbum,
  }: {
    onOpenAlbum?: (album: {
      id: string
      title: string
      artist: string
      artistId: string
      coverId: string | null
      year: number | null
      trackCount: number
    }) => void
  }) => (
    <button
      type="button"
      data-testid="view-albums"
      onClick={() =>
        onOpenAlbum?.({
          id: 'alb-1',
          title: '示例专辑',
          artist: '甲',
          artistId: '',
          coverId: null,
          year: 2000,
          trackCount: 1,
        })
      }
    >
      专辑页
    </button>
  ),
}))
vi.mock('../src/pages/ArtistsPage', () => ({
  ArtistsPage: () => <div data-testid="view-artists">歌手页</div>,
}))
vi.mock('../src/pages/GenresPage', () => ({
  GenresPage: () => <div data-testid="view-genres">风格页</div>,
}))
vi.mock('../src/pages/DetailPage', () => ({
  DetailPage: ({
    kind,
    title,
    onBack,
  }: {
    kind: string
    title: string
    onBack: () => void
  }) => (
    <div data-testid="view-detail">
      <span>{`详情页:${kind}:${title}`}</span>
      <button type="button" onClick={onBack}>
        返回
      </button>
    </div>
  ),
}))
vi.mock('../src/pages/FullPlayerPage', () => ({
  FullPlayerPage: () => <div data-testid="view-fullplayer">全屏页</div>,
}))
vi.mock('../src/components/PlayerBar', () => ({
  PlayerBar: () => <div data-testid="player-bar" />,
}))
vi.mock('../src/components/ConnectionBadge', () => ({
  ConnectionBadge: () => <div data-testid="connection-badge" />,
}))

import App from '../src/App'
import { useSessionStore } from '../src/state/sessionStore'

/**
 * ⚠️ T38：曲库导航（歌曲 / 收藏 / …）**全都需要 NAS**
 *    → 未登录时**整组不渲染**。
 *    ⇒ 本文件（测曲库路由）默认按**已登录**设置会话状态；
 *      未登录那套另见 `test/app-guest-nav.test.tsx`。
 */
beforeEach(() => {
  useSessionStore.setState({
    session: {
      connected: true,
      mode: 'password',
      username: 'demo',
      serverLabel: 'example',
      isRelay: false,
    },
    connection: null,
    candidates: [],
    restored: true,
  })
})

describe('应用外壳的曲库路由', () => {
  it('未登录时默认停在**本地音乐页**（T38：没登录也能当播放器用）', () => {
    // ⚠️ 前提被用户显式推翻：未登录时主区**不再是**连接页，而是本地音乐页。
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
    render(<App />)
    expect(screen.getByTestId('view-local')).toBeTruthy()
    expect(screen.queryByTestId('view-search')).toBeNull()
  })

  it('顶栏的「歌曲 / 收藏 / 歌单 / 专辑 / 歌手 / 风格 / 搜索」按钮切到对应页面，且旧页面被卸载', () => {
    render(<App />)

    const cases = [
      ['歌曲', 'view-songs'],
      ['收藏', 'view-favorites'],
      ['歌单', 'view-playlists'],
      ['专辑', 'view-albums'],
      ['歌手', 'view-artists'],
      ['风格', 'view-genres'],
      ['搜索', 'view-search'],
    ] as const

    for (const [label, testId] of cases) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(screen.getByTestId(testId)).toBeTruthy()
      // 主区**只渲染当前视图**（不是把页面堆在一起）。
      expect(screen.getAllByTestId(/^view-/).length).toBe(1)
    }
  })

  it('六个曲库页两两互斥：点下一颗按钮后上一颗的页面已从 DOM 里消失', () => {
    render(<App />)

    // 审计报表 P0-1 的「六页孤儿」防线：任何一个曲库页都必须**可达**，
    // 且可达之后不能与别的页面同时存在（否则会双份加载、状态打架）。
    const libraryViews = [
      ['歌曲', 'view-songs'],
      ['收藏', 'view-favorites'],
      ['歌单', 'view-playlists'],
      ['专辑', 'view-albums'],
      ['歌手', 'view-artists'],
      ['风格', 'view-genres'],
    ] as const

    for (const [label, testId] of libraryViews) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(screen.getByTestId(testId)).toBeTruthy()
      expect(screen.getAllByTestId(/^view-/).map((node) => node.dataset['testid'])).toEqual([testId])
    }
  })

  it('当前视图对应的按钮是 aria-pressed，其余不是', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '歌单' }))

    expect(screen.getByRole('button', { name: '歌单' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '连接' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '搜索' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('顶栏分「主导航」与「曲库导航」两组', () => {
    render(<App />)
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: '曲库导航' })).toBeTruthy()
  })

  it('点专辑卡片进入详情视图，「返回」后回到专辑页', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '专辑' }))
    expect(screen.getByTestId('view-albums')).toBeTruthy()

    // 点专辑卡片 → 下钻到详情视图（Task 4）。
    fireEvent.click(screen.getByTestId('view-albums'))
    const detail = screen.getByTestId('view-detail')
    expect(detail.textContent).toContain('album')
    expect(detail.textContent).toContain('示例专辑')
    // 主区仍然**只渲染一个视图**。
    expect(screen.getAllByTestId(/^view-/).length).toBe(1)

    // 「返回」→ 回到专辑页。
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.getByTestId('view-albums')).toBeTruthy()
    expect(screen.queryByTestId('view-detail')).toBeNull()
  })
})
