import { useCallback, useState, type ReactElement } from 'react'

import type { Song } from '../shared/types'
import { ConnectionBadge } from './components/ConnectionBadge'
import { PlayerBar } from './components/PlayerBar'
import { AlbumsPage } from './pages/AlbumsPage'
import { ArtistsPage } from './pages/ArtistsPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { FullPlayerPage } from './pages/FullPlayerPage'
import { GenresPage } from './pages/GenresPage'
import { LoginPage } from './pages/LoginPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SearchPage } from './pages/SearchPage'
import { SongsPage } from './pages/SongsPage'
import { usePlayerStore } from './state/playerStore'
import './styles/app-shell.css'
import './styles/tokens.css'

// ---------------------------------------------------------------------------
// 应用外壳（Task 10b）
//
// 顶栏常驻 `ConnectionBadge`（当前链路 + 中继带宽提示），主区是登录页。
//
// ---------------------------------------------------------------------------
// Task 15：播放条与全屏播放页
// ---------------------------------------------------------------------------
// - 底部常驻 **播放条**（`PlayerBar`）：封面 / 歌名 / 播放控制 / 进度 / 音量 /
//   队列 / EQ 入口 / 音质标识；
// - 播放条上的「全屏」按钮打开 **全屏播放页**（`FullPlayerPage`）：
//   封面取色背景 + 双行歌词或队列面板。
//
// 两者都只经 `playerStore` 驱动（**不直接碰** `PlayerEngine`）。
//
// ---------------------------------------------------------------------------
// Task 16：搜索页
// ---------------------------------------------------------------------------
// 顶栏加一组入口按钮（「连接」/「搜索」）切换主区：
// - 「连接」→ `LoginPage`（登录 / 登出 / 链路信息，**保持原样**）；
// - 「搜索」→ `SearchPage`（搜索 + 收藏写回 + 歌单写回）。
//
// ⚠️ 入口按钮的样式住在**应用外壳**的样式文件里（`src/styles/app-shell.css`，
//    类名 `fnm-app__nav*`）——这两颗按钮是外壳的元素，样式也归外壳；
//    将来即便改成代码分割（`React.lazy`），样式也不会丢。
//
// ---------------------------------------------------------------------------
// Task 2（新版清单）：曲库三页接路由
// ---------------------------------------------------------------------------
// 顶栏分成两组导航：
// - **主导航**：「连接」/「搜索」；
// - **曲库导航**：「歌曲」/「收藏」/「歌单」/「专辑」/「歌手」/「风格」
//   （后三颗是 Task 3 追加的）。
//
// ⚠️ **四页共用同一个 `libraryStore` 单例**（`useResolvedLibraryStore` 在没有注入
//    `api` 时返回模块级单例）→ 收藏 / 歌单的状态**只有一份**，不新增重复状态源。
//
// ⚠️ **整队口径统一**：`SearchPage` 与三页的 `onPlay` 签名都是
//    `(song, index, list)`，`list` = 当前已加载的整队 → 全部走同一个 `handlePlay`。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task 3（新版清单）：专辑 / 歌手 / 风格三页可达
// ---------------------------------------------------------------------------
// 曲库导航组追加三颗按钮（专辑 / 歌手 / 风格），主区渲染对应的三个页面。
//
// ⚠️ 这三页的**卡片点击出口**（`onOpenAlbum` / `onOpenArtist` / `onOpenGenre`）
//    **本任务不接** —— 下钻到「某专辑的曲目 / 某歌手的曲目 / 某风格的曲目」
//    属于 **Task 4（曲库详情下钻）**：那里才把 `libraryApi.albumSongs` 等
//    详情接口接进 `LibraryApi` 并做详情视图。
//    当前阶段点卡片**没有反应**是**已知且短暂的**状态，不是回归。
// ---------------------------------------------------------------------------

/** 主区的视图。 */
type MainView =
  | 'connect'
  | 'search'
  | 'songs'
  | 'favorites'
  | 'playlists'
  | 'albums'
  | 'artists'
  | 'genres'

/** 顶栏导航按钮。 */
interface NavButtonProps {
  /** 按钮文字。 */
  label: string
  /** 是否是当前所在视图。 */
  active: boolean
  /** 点击时切换到哪个视图。 */
  onSelect: () => void
}

/** 顶栏导航按钮（外壳的元素，样式在 `src/styles/app-shell.css`）。 */
function NavButton({ label, active, onSelect }: NavButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="fnm-app__nav-button"
      aria-pressed={active}
      onClick={onSelect}
    >
      {label}
    </button>
  )
}

export default function App() {
  const [fullPlayerOpen, setFullPlayerOpen] = useState(false)
  const [view, setView] = useState<MainView>('connect')

  /**
   * 整队播放：**四页共用这一个入口**。
   *
   * ⚠️ `list` 是各页 `onPlay` 的第三个参数 = **当前已加载的整队**；
   *    `playTrack(song, list)` 会**整队入队并定位到点的那首**
   *    （队列语义见 `src/state/playerStore.ts` 的 `playTrack`）。
   */
  const handlePlay = useCallback((song: Song, _index: number, list: Song[]): void => {
    usePlayerStore.getState().playTrack(song, list)
  }, [])

  /**
   * 主区内容：**任一时刻只渲染一个视图**（不是把页面堆在一起）。
   *
   * ⚠️ 用 `switch` 而不是嵌套三元：视图已经有 8 个分支，
   *    嵌套三元在这个规模下已经读不动了（而且加分支极易漏改一处）。
   */
  const renderMainView = (): ReactElement => {
    switch (view) {
      case 'search':
        return <SearchPage onPlay={handlePlay} />
      case 'songs':
        return <SongsPage onPlay={handlePlay} />
      case 'favorites':
        return <FavoritesPage onPlay={handlePlay} />
      case 'playlists':
        return <PlaylistsPage onPlay={handlePlay} />
      case 'albums':
        // ⚠️ 不传 `onOpenAlbum`：详情下钻是 Task 4 的范围（见文件头的说明）。
        return <AlbumsPage />
      case 'artists':
        return <ArtistsPage />
      case 'genres':
        return <GenresPage />
      default:
        return <LoginPage />
    }
  }

  return (
    <div className="app-shell">
      <header className="app-shell__topbar">
        <span className="app-shell__brand">飞牛音乐</span>
        <div className="app-shell__navs">
          <nav className="fnm-app__nav" aria-label="主导航">
            <NavButton
              label="连接"
              active={view === 'connect'}
              onSelect={() => setView('connect')}
            />
            <NavButton
              label="搜索"
              active={view === 'search'}
              onSelect={() => setView('search')}
            />
          </nav>
          <nav className="fnm-app__nav fnm-app__nav--library" aria-label="曲库导航">
            <NavButton
              label="歌曲"
              active={view === 'songs'}
              onSelect={() => setView('songs')}
            />
            <NavButton
              label="收藏"
              active={view === 'favorites'}
              onSelect={() => setView('favorites')}
            />
            <NavButton
              label="歌单"
              active={view === 'playlists'}
              onSelect={() => setView('playlists')}
            />
            <NavButton
              label="专辑"
              active={view === 'albums'}
              onSelect={() => setView('albums')}
            />
            <NavButton
              label="歌手"
              active={view === 'artists'}
              onSelect={() => setView('artists')}
            />
            <NavButton
              label="风格"
              active={view === 'genres'}
              onSelect={() => setView('genres')}
            />
          </nav>
        </div>
        <ConnectionBadge />
      </header>
      <main className="app-shell__main">
        {renderMainView()}
        {fullPlayerOpen && <FullPlayerPage onClose={() => setFullPlayerOpen(false)} />}
      </main>
      <PlayerBar onOpenFullPlayer={() => setFullPlayerOpen(true)} />
    </div>
  )
}
