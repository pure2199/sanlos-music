import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installLocalHistory } from './state/historyStore'
import { installMediaSession } from './player/mediaSession'
import { installLyricOverlay } from './player/lyricOverlay'
import { installSpectrum } from './player/spectrum'
import { installDownloadStore } from './state/downloadStore'
import { installLocalLibraryStore } from './state/localLibraryStore'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载节点')
}

// 媒体会话（Task 17）：Windows 的 SMTC 由 Chromium 经 `navigator.mediaSession`
// 发布——这条通道必须在**渲染进程**里装上（主进程没有这个浏览器 API）。
// ⚠️ 装在 `main.tsx` 而不是 `App.tsx`：后者由并行的修复轮次占用，
//    两个任务碰同一个文件会互相覆盖提交。
installMediaSession()

// 本机播放记录（Task 7）：订阅播放器的 `current` 变化，换歌就记一笔。
// ⚠️ 服务端**不会**随 stream 自动写播放历史，也没有可用的上报端点（实测），
//    所以本机记录只能留在本地——见 `src/state/historyStore.ts`。
installLocalHistory()

// 桌面悬浮歌词（Task 10）：把「曲目 + 歌词」与「播放进度」推给主进程，
// 由主进程转发给**悬浮窗**的渲染进程。
// ⚠️ **只在悬浮窗可见时才拉歌词**（关着就不多打 NAS）。
installLyricOverlay()

// 频谱（T47）：取当前这一曲的频谱（16 段），推给主进程 → 词岛窗渲染成两端的波形柱。
// ⚠️ **只在桌面歌词可见且形态 = 词岛时才采样**（采样器自己判）——
//    不给「顿卡」添新堵点。
installSpectrum()

// 本地下载（Task 11）：订阅下载进度 + 读一次本地索引（决定「本地优先播放」）。
installDownloadStore()

// 本地曲目（T38 / T39）：订阅主进程推来的清单变化（后台读标签的结果）
// + 读一次本地曲目清单。
installLocalLibraryStore()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
