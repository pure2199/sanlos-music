import { ConnectionBadge } from './components/ConnectionBadge'
import { LoginPage } from './pages/LoginPage'
import './styles/app-shell.css'
import './styles/tokens.css'

// ---------------------------------------------------------------------------
// 应用外壳（Task 10b）
//
// 顶栏常驻 `ConnectionBadge`（当前链路 + 中继带宽提示），主区是登录页。
// Task 12+ 会把主区换成曲库 / 播放器。
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-shell__topbar">
        <span className="app-shell__brand">飞牛音乐</span>
        <ConnectionBadge />
      </header>
      <main className="app-shell__main">
        <LoginPage />
      </main>
    </div>
  )
}
