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
//   - 经典悬浮窗（Task 10）：可自由拖动、带播放控制按钮；
//   - 词岛（T45）：**锚在屏幕顶部居中**、胶囊外形、没有控制按钮。
//   ⇒ 数据通路（订阅 / 外推 / 点歌跳转）**完全共用**，只是**呈现**不同。
//
// ⚠️ 主题跟随全局（`prefs.json` 的 `theme`）——经 `useAppPrefsStore.load()`
//    读回并应用（与主窗口同一套机制）。
// ---------------------------------------------------------------------------

import { StrictMode, useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

import type { PlayerBridge } from '../../shared/playerBridge'
import { useAppPrefsStore } from '../state/appPrefsStore'
import { LyricView } from '../ui/lyrics/LyricView'
import { extrapolatePosition } from '../ui/lyrics/overlayClock'
import { emptyOverlayState, mergeLyricMessage } from '../ui/lyrics/overlayState'
import '../styles/tokens.css'
import './island-window.css'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览里为 `null`）。 */
function bridge(): PlayerBridge | null {
  const scope = globalThis as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 位置更新的最小步长（秒）：小于它就不重渲染（省掉无意义的 60fps 重绘）。 */
const POSITION_EPSILON = 0.03

/** 词岛的根组件。 */
function IslandApp(): ReactElement {
  const [state, setState] = useState(emptyOverlayState)
  const [position, setPosition] = useState(0)

  /** 最近一次进度采样（本地外推的基准；放在 ref 里避免每帧重建闭包）。 */
  const sampleRef = useRef(state.sample)
  /** 当前已渲染的位置（用来判断要不要重绘）。 */
  const positionRef = useRef(0)

  // --- 订阅主进程转发的歌词消息 --------------------------------------------
  useEffect(() => {
    const player = bridge()
    if (!player) return undefined
    return player.onLyricState((message) => {
      const now = Date.now()
      setState((prev) => {
        const next = mergeLyricMessage(prev, message, now)
        sampleRef.current = next.sample
        return next
      })
    })
  }, [])

  // --- 本地插值：按经过时间外推当前位置 ------------------------------------
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined
    let frame = 0
    const tick = (): void => {
      const next = extrapolatePosition(sampleRef.current, Date.now())
      if (Math.abs(next - positionRef.current) >= POSITION_EPSILON) {
        positionRef.current = next
        setPosition(next)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [])

  // --- 主题：读回主进程 `prefs.json` 的主题并应用 ----------------------------
  useEffect(() => {
    void useAppPrefsStore.getState().load()
  }, [])

  // --- 交互：点歌词跳转 ---------------------------------------------------
  const handleSeek = (seconds: number): void => {
    bridge()?.sendCommand({ type: 'seek', seconds })
  }

  const track = state.track
  const title = track?.title ?? ''
  const artist = track?.artist ?? ''

  return (
    <div className="fnm-island" data-testid="fnm-island">
      <div className="fnm-island__meta">
        <span className="fnm-island__title">{title}</span>
        <span className="fnm-island__artist">{artist}</span>
      </div>
      <div className="fnm-island__lyrics">
        <LyricView
          lines={state.lines}
          currentTime={position}
          onSeek={handleSeek}
          mode="double"
          emptyLabel="暂无歌词"
        />
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载节点')
}

createRoot(container).render(
  <StrictMode>
    <IslandApp />
  </StrictMode>,
)
