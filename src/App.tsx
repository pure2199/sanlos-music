import { useCallback, useState, type ReactElement } from 'react'

import type { Album, Artist, Genre, Song } from '../shared/types'
import { ConnectionBadge } from './components/ConnectionBadge'
import { formatCount } from './components/Cards'
import { PlayerBar } from './components/PlayerBar'
import { AlbumsPage } from './pages/AlbumsPage'
import { ArtistsPage } from './pages/ArtistsPage'
import { DetailPage } from './pages/DetailPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { FullPlayerPage } from './pages/FullPlayerPage'
import { GenresPage } from './pages/GenresPage'
import { LoginPage } from './pages/LoginPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SearchPage } from './pages/SearchPage'
import { SongsPage } from './pages/SongsPage'
import type { DetailKind } from './state/libraryStore'
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
// ---------------------------------------------------------------------------
// Task 4（新版清单）：曲库详情下钻
// ---------------------------------------------------------------------------
// 三页的卡片点击出口（`onOpenAlbum` / `onOpenArtist` / `onOpenGenre`）接到
// 同一个**详情视图**（`DetailPage`）：
// - 点卡片 → 记下「下钻目标」（类型 / id / 标题 / 副标题 / 封面）→ 切到 `detail` 视图；
// - 详情视图挂载后由**它自己**去 store 里取数据（`openAlbum` / `openArtist` / `openGenre`）
//   ——外壳不碰 store，页面职责边界不变；
// - 「返回」回到对应的列表页（专辑 → 专辑页，歌手 → 歌手页，风格 → 风格页）。
//
// ⚠️ 详情页内部再点歌手的专辑卡片会**再往下钻一层**（覆盖当前下钻目标）；
//    「返回」此时回到专辑页而不是歌手页——这是有意为之的**单层历史**，
//    不是栈式回退（曲库下钻最多两层，单层够用）。
// ---------------------------------------------------------------------------

/** 下钻目标（点卡片进入详情时携带的信息）。 */
interface DetailTarget {
  /** 实体类型。 */
  kind: DetailKind
  /** 实体 id。 */
  id: string
  /** 实体标题（来自卡片的原始对象）。 */
  title: string
  /** 实体副标题。 */
  subtitle: string
  /** 封面 id。 */
  coverId: string | null
}

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
  | 'detail'

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
  /** 当前下钻目标（`null` = 没在下钻）。 */
  const [detail, setDetail] = useState<DetailTarget | null>(null)

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

  // ---- 下钻（Task 4）-----------------------------------------------------
  //
  // ⚠️ 外壳**只记目标、切视图**，不去 store 取数据 ——
  //    数据的加载由 `DetailPage` 自己在挂载时触发（`openAlbum` 等），
  //    这样「谁负责取数」的边界仍然在页面层。

  /** 点专辑卡片 → 下钻到该专辑。 */
  const handleOpenAlbum = useCallback((album: Album): void => {
    setDetail({
      kind: 'album',
      id: album.id,
      title: album.title,
      subtitle: album.artist,
      coverId: album.coverId,
    })
    setView('detail')
  }, [])

  /** 点歌手卡片 → 下钻到该歌手。 */
  const handleOpenArtist = useCallback((artist: Artist): void => {
    setDetail({
      kind: 'artist',
      id: artist.id,
      title: artist.name,
      subtitle: `${formatCount(artist.albumCount)} 张专辑 · ${formatCount(artist.trackCount)} 首`,
      coverId: artist.coverId,
    })
    setView('detail')
  }, [])

  /** 点风格卡片 → 下钻到该风格。 */
  const handleOpenGenre = useCallback((genre: Genre): void => {
    setDetail({
      kind: 'genre',
      id: genre.guid,
      title: genre.name,
      subtitle: `${formatCount(genre.trackCount)} 首`,
      coverId: genre.coverId,
    })
    setView('detail')
  }, [])

  /** 从详情返回 → 回到对应的列表页。 */
  const handleBackFromDetail = useCallback((): void => {
    if (!detail) return
    setView(detail.kind === 'album' ? 'albums' : detail.kind === 'artist' ? 'artists' : 'genres')
    setDetail(null)
  }, [detail])

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
        return <AlbumsPage onOpenAlbum={handleOpenAlbum} />
      case 'artists':
        return <ArtistsPage onOpenArtist={handleOpenArtist} />
      case 'genres':
        return <GenresPage onOpenGenre={handleOpenGenre} />
      case 'detail':
        return detail ? (
          <DetailPage
            kind={detail.kind}
            entityId={detail.id}
            title={detail.title}
            subtitle={detail.subtitle}
            coverId={detail.coverId}
            onBack={handleBackFromDetail}
            onPlay={handlePlay}
            onOpenAlbum={handleOpenAlbum}
          />
        ) : (
          <LoginPage />
        )
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
