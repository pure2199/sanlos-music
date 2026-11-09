// ---------------------------------------------------------------------------
// 桌面悬浮歌词窗口的**渲染进程入口**（Task 10）
// ---------------------------------------------------------------------------
//
// 这是一个**独立窗口**，与主窗口是两个渲染进程：
// - 主窗口持有 `<audio>`（真正的播放器），把「曲目 + 歌词」与「播放进度」
//   经主进程转发过来；
// - 本窗口**只负责显示**：收到进度采样后，用 `requestAnimationFrame`
//   在**本地**外推当前位置 → 推进是 60fps 顺滑的，而 IPC 仍然只有 ~4Hz。
//
// ⚠️ 本窗口**不碰音频**：两个 `<audio>` 会双解码、双倍流量、还要对同步。
//
// ⚠️ **T77：纯歌词 + 透明背景 + 点穿透**（酷狗桌面歌词样式）——
//    曲名/歌手、播放控制、点击跳转**全部没有**；
//    ⇒ 本窗口**不再**发任何播放命令（`sendCommand` 也不用）。
//
// ⚠️ 主题跟随全局（`prefs.json` 的 `theme`）——经 `useAppPrefsStore.load()`
//    读回并应用（与主窗口同一套机制）。
//    ⚠️ 但**歌词文字不跟主题走**（固定白字 + 深色描边，见 `lyric-overlay.css`）。
// ---------------------------------------------------------------------------

import { StrictMode, useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

import type { PlayerBridge } from '../../shared/playerBridge'
import { useAppPrefsStore } from '../state/appPrefsStore'
import { LyricOverlay } from '../ui/lyrics/LyricOverlay'
import { extrapolatePosition } from '../ui/lyrics/overlayClock'
import { emptyOverlayState, mergeLyricMessage } from '../ui/lyrics/overlayState'
import '../styles/tokens.css'
import './lyric-window.css'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览里为 `null`）。 */
function bridge(): PlayerBridge | null {
  const scope = globalThis as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 位置更新的最小步长（秒）：小于它就不重渲染（省掉无意义的 60fps 重绘）。 */
const POSITION_EPSILON = 0.03

/** 悬浮窗的根组件。 */
function LyricWindowApp(): ReactElement {
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

  return (
    <LyricOverlay
      track={state.track}
      lines={state.lines}
      position={position}
    />
  )
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载节点')
}

createRoot(container).render(
  <StrictMode>
    <LyricWindowApp />
  </StrictMode>,
)
