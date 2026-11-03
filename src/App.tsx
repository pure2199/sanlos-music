import { useState } from 'react'

import { ConnectionBadge } from './components/ConnectionBadge'
import { PlayerBar } from './components/PlayerBar'
import { FullPlayerPage } from './pages/FullPlayerPage'
import { LoginPage } from './pages/LoginPage'
import { SearchPage } from './pages/SearchPage'
import { usePlayerStore } from './state/playerStore'
import './styles/app-shell.css'
import './styles/tokens.css'

// ---------------------------------------------------------------------------
// 应用外壳（Task 10b）
//
// 顶栏常驻 `ConnectionBadge`（当前链路 + 中继带宽提示），主区是登录页。
// Task 12+ 会把主区换成曲库 / 播放器。
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
// ⚠️ 搜索结果双击播放 → `playerStore.playTrack(song, list)`：
//    队列上下文用**当前搜索结果**（整队入队并定位到点的那首）。
//
// ⚠️ 入口按钮的样式住在**应用外壳**的样式文件里（`src/styles/app-shell.css`，
//    类名 `fnm-app__nav*`）——这两颗按钮是外壳的元素，样式也归外壳；
//    将来即便改成代码分割（`React.lazy`），样式也不会丢。
// ---------------------------------------------------------------------------

/** 主区的两个视图。 */
type MainView = 'connect' | 'search'

export default function App() {
  const [fullPlayerOpen, setFullPlayerOpen] = useState(false)
  const [view, setView] = useState<MainView>('connect')

  return (
    <div className="app-shell">
      <header className="app-shell__topbar">
        <span className="app-shell__brand">飞牛音乐</span>
        <nav className="fnm-app__nav" aria-label="主导航">
          <button
            type="button"
            className="fnm-app__nav-button"
            aria-pressed={view === 'connect'}
            onClick={() => setView('connect')}
          >
            连接
          </button>
          <button
            type="button"
            className="fnm-app__nav-button"
            aria-pressed={view === 'search'}
            onClick={() => setView('search')}
          >
            搜索
          </button>
        </nav>
        <ConnectionBadge />
      </header>
      <main className="app-shell__main">
        {view === 'search' ? (
          <SearchPage
            onPlay={(song, _index, list) => {
              usePlayerStore.getState().playTrack(song, list)
            }}
          />
        ) : (
          <LoginPage />
        )}
        {fullPlayerOpen && <FullPlayerPage onClose={() => setFullPlayerOpen(false)} />}
      </main>
      <PlayerBar onOpenFullPlayer={() => setFullPlayerOpen(true)} />
    </div>
  )
}
