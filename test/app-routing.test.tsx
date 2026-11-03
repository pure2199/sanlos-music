// ---------------------------------------------------------------------------
// Task 2（新版清单）：应用外壳的曲库路由
//
// ⚠️ 这里**只测路由**：叶子组件全部打桩（不碰真实数据加载），
//    目的是钉住「顶栏哪颗按钮 → 主区渲染哪个页面」这条接线。
//    叶子组件自己的行为由各自的文件负责
//    （三页的整队口径见 `test/library-onplay.test.tsx`）。
//
// ⚠️ 这条用例补上了审计报表指出的缺口：
//    「`src/App.tsx` 接线无测试（全 `test/` 无渲染 `<App/>`）」。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../src/pages/LoginPage', () => ({
  LoginPage: () => <div data-testid="view-connect">连接页</div>,
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

describe('应用外壳的曲库路由', () => {
  it('默认停在连接页', () => {
    render(<App />)
    expect(screen.getByTestId('view-connect')).toBeTruthy()
    expect(screen.queryByTestId('view-search')).toBeNull()
  })

  it('顶栏的「歌曲 / 收藏 / 歌单 / 搜索」按钮切到对应页面，且旧页面被卸载', () => {
    render(<App />)

    const cases = [
      ['歌曲', 'view-songs'],
      ['收藏', 'view-favorites'],
      ['歌单', 'view-playlists'],
      ['搜索', 'view-search'],
    ] as const

    for (const [label, testId] of cases) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(screen.getByTestId(testId)).toBeTruthy()
      // 主区**只渲染当前视图**（不是把页面堆在一起）。
      expect(screen.getAllByTestId(/^view-/).length).toBe(1)
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
})
