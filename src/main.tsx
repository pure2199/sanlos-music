import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installMediaSession } from './player/mediaSession'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载节点')
}

// 媒体会话（Task 17）：Windows 的 SMTC 由 Chromium 经 `navigator.mediaSession`
// 发布——这条通道必须在**渲染进程**里装上（主进程没有这个浏览器 API）。
// ⚠️ 装在 `main.tsx` 而不是 `App.tsx`：后者由并行的修复轮次占用，
//    两个任务碰同一个文件会互相覆盖提交。
installMediaSession()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
