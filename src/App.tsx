import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { Album, Artist, Genre, Song } from '../shared/types'
import { onAuthLost } from './api/client'
import { ConnectionBadge } from './components/ConnectionBadge'
import { formatCount } from './components/Cards'
import { PlayerBar } from './components/PlayerBar'
import { SettingsPanel } from './components/SettingsPanel'
import { ThemeSwitcher } from './components/ThemeSwitcher'
import { AlbumsPage } from './pages/AlbumsPage'
import { ArtistsPage } from './pages/ArtistsPage'
import { DetailPage } from './pages/DetailPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { FullPlayerPage } from './pages/FullPlayerPage'
import { GenresPage } from './pages/GenresPage'
import { HistoryPage } from './pages/HistoryPage'
import { LoginPage } from './pages/LoginPage'
import { LocalMusicPage } from './pages/LocalMusicPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SearchPage } from './pages/SearchPage'
import { SongsPage } from './pages/SongsPage'
import { getBridge } from './lib/bridge'
import type { DetailKind } from './state/libraryStore'
import { useAppPrefsStore } from './state/appPrefsStore'
import { usePlayerStore } from './state/playerStore'
import { useSessionStore } from './state/sessionStore'
import './styles/global.css'
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
  | 'local'
  | 'search'
  | 'songs'
  | 'favorites'
  | 'playlists'
  | 'albums'
  | 'artists'
  | 'genres'
  | 'history'
  | 'settings'
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
  const [view, setView] = useState<MainView>('local')
  /** 当前下钻目标（`null` = 没在下钻）。 */
  const [detail, setDetail] = useState<DetailTarget | null>(null)
  /**
   * 打开设置页之前的主区视图（T35）。
   *
   * ⚠️ 设置页是**主区里的一个视图**（不是顶栏下拉的浮层）→ 关闭它要**回到来时的地方**，
   *    否则用户从「收藏」进去、关掉设置后被丢回「歌曲」页。
   */
  const [viewBeforeSettings, setViewBeforeSettings] = useState<MainView>('local')
  /** 会话是否已失效（token 续期也失败）——界面据此回登录页并给出说明。 */
  const [authLost, setAuthLost] = useState(false)
  /** 是否已登录（T38：**顶栏导航的可见性**靠它）。 */
  const connected = useSessionStore((s) => s.session.connected)
  /** 是否已经尝试过恢复会话（T38）。 */
  const restored = useSessionStore((s) => s.restored)
  /** 恢复会话的动作（T38：已收敛进 `sessionStore`）。 */
  const restoreSession = useSessionStore((s) => s.restore)

  // -------------------------------------------------------------------------
  // 会话恢复（T38：**从 App 发起**，与当前视图无关）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **为什么不能只靠 `LoginPage`**：未登录时主区默认是「本地音乐」页
  //    → 登录页**根本没挂载** → `restore()` 没人调
  //    → 应用就不知道自己登录了没有（顶栏导航的可见性全靠这个状态）。
  //    ⇒ 恢复动作必须**从 App 出发**。
  //
  // ⚠️ store 内部**只恢复一次**（并发共享同一个 Promise + `restored` 闸门），
  //    这里重复调是安全的。
  useEffect(() => {
    void restoreSession()
  }, [restoreSession])

  // -------------------------------------------------------------------------
  // 启动时若**已经登录** → 自动进「歌曲」页（T38）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **只做一次**（ref 守卫）：用户**手动登录**时**不**跳页——
  //    停在登录页显示「已连接」，与既有行为一字不差。
  // ⚠️ **用户已经点过导航就不抢**：启动恢复与用户操作之间有个时间差，
  //    用户若先点开了「本地」，自动切页不该把他手抢走。
  const autoNavigated = useRef(false)
  const userNavigated = useRef(false)
  useEffect(() => {
    if (autoNavigated.current) return
    if (!restored) return
    autoNavigated.current = true
    if (connected && !userNavigated.current) setView('songs')
  }, [connected, restored])

  /** 用户**主动**切视图（记一笔，供上面的自动切页避让）。 */
  const goTo = useCallback((next: MainView): void => {
    userNavigated.current = true
    setView(next)
  }, [])

  // 启动时读一次主进程的偏好（主题 / 关闭窗口的行为）并应用（Task 6 / Task 8）。
  // ⚠️ 偏好的**单一真相源在主进程**（`prefs.json`），这里只是把它读回来。
  useEffect(() => {
    void useAppPrefsStore.getState().load()
  }, [])

  // -------------------------------------------------------------------------
  // 会话失效 → 回登录页（规格 §5.4）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **主进程已经静默续期过一次了**：业务码 99999 透到渲染进程，
  //    意味着**续期也失败**（口令改了 / 中继不通）。
  //    这时必须把用户送回登录页，否则界面会停在「已登录、但每个请求都失败」的死状态。
  //
  // ⚠️ **立刻切视图，不等 `logout()`**：登出要先通知服务端，
  //    网络不通时可能挂住十几秒 —— 用户必须**马上**看到「登录已失效」。
  //    主进程那边的会话清理放在后台做（失败也无妨：下次启动若又读回那个死 token，
  //    第一个请求会再次触发这条路径，自愈）。
  useEffect(
    () =>
      onAuthLost(() => {
        setAuthLost(true)
        useSessionStore.getState().reset()
        setDetail(null)
        setView('connect')
        void Promise.resolve(getBridge()?.logout()).catch(() => undefined)
      }),
    [],
  )

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

  // ---- 设置页（T35）------------------------------------------------------
  //
  // ⚠️ 设置页是**主区里的一个视图**（不是顶栏下拉的浮层）→ 顶栏**不会被遮挡**，
  //    开着的时候别的顶栏按钮照样点得到（这正是旧浮层的毛病）。
  //
  // ⚠️ 打开前先**记住来时的视图** → 关闭时回到原处；
  //    否则用户从「收藏」进去、关掉设置后会被丢回「连接」页。

  /** 打开设置页（记录来时的视图）。 */
  const openSettings = useCallback((): void => {
    // ⚠️ 已经在设置页里时**不要**把「设置页自己」记成来处 → 关闭会原地打转。
    setViewBeforeSettings((before) => (view === 'settings' ? before : view))
    setView('settings')
  }, [view])

  /** 关闭设置页 → 回到打开它之前的主区视图。 */
  const closeSettings = useCallback((): void => {
    setView(viewBeforeSettings)
  }, [viewBeforeSettings])

  /**
   * 主区内容：**任一时刻只渲染一个视图**（不是把页面堆在一起）。
   *
   * ⚠️ 用 `switch` 而不是嵌套三元：视图已经有 8 个分支，
   *    嵌套三元在这个规模下已经读不动了（而且加分支极易漏改一处）。
   */
  const renderMainView = (): ReactElement => {
    switch (view) {
      case 'local':
        // ⚠️ T38：本地音乐页（**未登录也能用**）——本地文件 + 已下载。
        return <LocalMusicPage onPlay={handlePlay} onGoToLogin={() => goTo('connect')} />
      case 'search':
        // ⚠️ T18-4：搜索结果里的专辑 / 歌手卡片要能下钻到详情（原来点不动）。
        return (
          <SearchPage
            onPlay={handlePlay}
            onOpenAlbum={handleOpenAlbum}
            onOpenArtist={handleOpenArtist}
          />
        )
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
      case 'history':
        // ⚠️ 最近播放分两段：**本机记录**（本地）+ **NAS 历史**（只读）——
        //    服务端没有可用的上报端点（实测），详见 `src/pages/HistoryPage.tsx`。
        return <HistoryPage onPlay={handlePlay} />
      case 'settings':
        // ⚠️ T35：设置页是**主区里的整页**（左侧分类 + 右侧内容），
        //    **不再盖住顶栏**；「关闭设置」回到 `viewBeforeSettings`。
        return <SettingsPanel onClose={closeSettings} />
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
          <LoginPage
            notice={authLost ? '登录已失效，请重新登录。' : undefined}
            sessionLost={authLost}
          />
        )
      default:
        return (
          <LoginPage
            notice={authLost ? '登录已失效，请重新登录。' : undefined}
            sessionLost={authLost}
          />
        )
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
              onSelect={() => goTo('connect')}
            />
            {/*
             * ⚠️ T38：「本地」**永远可见**（没登录也能当播放器用）；
             *    「搜索」需要 NAS → **未登录时不渲染**。
             */}
            <NavButton
              label="本地"
              active={view === 'local'}
              onSelect={() => goTo('local')}
            />
            {connected && (
              <NavButton
                label="搜索"
                active={view === 'search'}
                onSelect={() => goTo('search')}
              />
            )}
          </nav>
          {/*
           * ⚠️ T38：曲库导航（歌曲 / 收藏 / …）**全都需要 NAS**
           *    → 未登录时**整组不渲染**（点进去只会一路请求失败）。
           */}
          {connected && (
            <nav className="fnm-app__nav fnm-app__nav--library" aria-label="曲库导航">
            <NavButton
              label="歌曲"
              active={view === 'songs'}
              onSelect={() => goTo('songs')}
            />
            <NavButton
              label="收藏"
              active={view === 'favorites'}
              onSelect={() => goTo('favorites')}
            />
            <NavButton
              label="歌单"
              active={view === 'playlists'}
              onSelect={() => goTo('playlists')}
            />
            <NavButton
              label="专辑"
              active={view === 'albums'}
              onSelect={() => goTo('albums')}
            />
            <NavButton
              label="歌手"
              active={view === 'artists'}
              onSelect={() => goTo('artists')}
            />
            <NavButton
              label="风格"
              active={view === 'genres'}
              onSelect={() => goTo('genres')}
            />
            <NavButton
              label="最近"
              active={view === 'history'}
              onSelect={() => goTo('history')}
            />
            </nav>
          )}
        </div>
        <ThemeSwitcher />
        <div className="app-shell__settings">
          <button
            type="button"
            className="fnm-app__nav-button"
            // ⚠️ T35：设置页是**主区里的一个视图** → 这颗按钮变成「进入 / 退出设置页」。
            onClick={() => (view === 'settings' ? closeSettings() : openSettings())}
            aria-expanded={view === 'settings'}
            aria-label="设置"
          >
            设置
          </button>
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
