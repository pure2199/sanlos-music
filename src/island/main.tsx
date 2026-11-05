// ---------------------------------------------------------------------------
// 灵动态词岛窗口的**渲染进程入口**（T45）
// ---------------------------------------------------------------------------
//
// 这是一个**独立窗口**（与主窗口、经典悬浮窗都是分开的渲染进程）：
// - 主窗口持有 `<audio>`（真正的播放器），把「曲目 + 歌词」与「播放进度」
//   经主进程转发过来；
// - 本窗口**只负责显示**：收到进度采样后，用 `requestAnimationFrame`
//   在**本地**外推当前位置 → 推进是 60fps 顺滑的，而 IPC 仍然只有 ~4Hz。
//
// ⚠️ 本窗口**不碰音频**：两个 `<audio>` 会双解码、双倍流量、还要对同步。
//
// ⚠️ **与经典悬浮窗的差别**：
//   - 经典悬浮窗（Task 10）：可自由拖动、带播放控制按钮、**可以点**；
//   - 词岛（T45/T46）：**锚在屏幕顶部居中**、胶囊外形、没有控制按钮、
//     **点击穿透**（不挡屏幕顶部的应用 → 代价是**不能点**）。
//   ⇒ 数据通路（订阅 / 外推）**完全共用**，只是**呈现与交互**不同。
//
// ⚠️ 主题跟随全局（`prefs.json` 的 `theme`）——经 `useAppPrefsStore.load()`
//    读回并应用（与主窗口同一套机制）。
//
// ⚠️ 组件本体在 `IslandApp.tsx`（拆出来是为了让单测能 import 它）。
// ---------------------------------------------------------------------------

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { IslandApp } from './IslandApp'
import '../styles/tokens.css'
import './island-window.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载节点')
}

createRoot(container).render(
  <StrictMode>
    <IslandApp />
  </StrictMode>,
)
