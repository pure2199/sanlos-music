import { useState } from 'react'

import { ConnectionBadge } from './components/ConnectionBadge'
import { PlayerBar } from './components/PlayerBar'
import { FullPlayerPage } from './pages/FullPlayerPage'
import { LoginPage } from './pages/LoginPage'
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
// ---------------------------------------------------------------------------

export default function App() {
  const [fullPlayerOpen, setFullPlayerOpen] = useState(false)

  return (
    <div className="app-shell">
      <header className="app-shell__topbar">
        <span className="app-shell__brand">飞牛音乐</span>
        <ConnectionBadge />
      </header>
      <main className="app-shell__main">
        <LoginPage />
        {fullPlayerOpen && <FullPlayerPage onClose={() => setFullPlayerOpen(false)} />}
      </main>
      <PlayerBar onOpenFullPlayer={() => setFullPlayerOpen(true)} />
    </div>
  )
}
