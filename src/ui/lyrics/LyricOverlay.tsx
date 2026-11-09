// ---------------------------------------------------------------------------
// 桌面悬浮歌词的内容组件（T77：改成「酷狗桌面歌词」样式）
// ---------------------------------------------------------------------------
//
// 它是**独立窗口**里的内容：**纯歌词**（双行逐字 + 卡拉OK）。
//
// ---------------------------------------------------------------------------
// T77 的口径（用户 2026-11-09 拍板）
// ---------------------------------------------------------------------------
//
// 「桌面歌词改成酷狗桌面歌词那样，背景透明……不需要其他功能，就是歌词功能」
//
// ⇒ 本组件**只剩歌词**：
// - ❌ 曲名 / 歌手（原先的标题条，同时兼**拖动把手**）；
// - ❌ 播放控制（上一首 / 播放暂停 / 下一首）；
// - ❌ 点击歌词跳转；
// - ✅ 双行逐字歌词 + **卡拉OK 渐进填色**（T71 起就有，**一字不变**）。
//
// ⚠️ **拖动为什么没了**：经典窗是**点穿透**的（`setIgnoreMouseEvents`，
//    与词岛同款）⇒ 窗口收不到鼠标 ⇒ 拖不动、也点不到。
//    这是用户**明确知情并接受**的代价（酷狗桌面歌词即如此）。
//
// ---------------------------------------------------------------------------
// 分工（与已有模块的关系）
// ---------------------------------------------------------------------------
//
// - **双行推进逻辑**不重写：直接复用 `src/ui/lyrics/doubleLine.ts` 的
//   `computeDoubleLineState`——它本来就被设计成 Task 19（桌面悬浮歌词）复用的
//   纯函数（见该文件头注释）。
// - **逐字渲染**不重写：直接复用 `LyricView` 的 `mode="double"`。
// - **播放位置**由调用方给（本组件是纯展示，不自己取时间）。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
//
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在 `src/ui/lyrics/lyric-overlay.css`。
// ⚠️ **T77：文字固定白字 + 深色描边**，**不跟主题走**
//    （浮层是压在**任意壁纸**上的透明文字，主题色会看不见）。

import type { ReactElement } from 'react'

import { LyricView } from './LyricView'
import type { LyricLine } from './parse'
import './lyric-overlay.css'

/** 悬浮窗显示的曲目信息。 */
export interface LyricOverlayTrack {
  /** 歌曲 guid。 */
  id: string
  /** 歌曲名。 */
  title: string
  /** 歌手名。 */
  artist: string
}

/** `LyricOverlay` 的属性。 */
export interface LyricOverlayProps {
  /**
   * 当前曲目；没有播放时为 `null`。
   *
   * ⚠️ T77：**只用它判断「有没有在播」**（决定空态文案）——
   *    曲名与歌手**不再显示**。
   */
  track: LyricOverlayTrack | null
  /** 歌词行（已解析；没有歌词时是空数组）。 */
  lines: LyricLine[]
  /** 当前播放位置（**秒**）。 */
  position: number
}

/**
 * 桌面悬浮歌词的内容（**纯歌词**）。
 *
 * - 没有曲目 → 显示「未在播放」（**不白屏**）；
 * - 没有歌词 → `LyricView` 显示「暂无歌词」（**不白屏**）。
 */
export function LyricOverlay(props: LyricOverlayProps): ReactElement {
  const { track, lines, position } = props
  const safeLines = Array.isArray(lines) ? lines : []

  return (
    <div className="fnm-lyricoverlay" data-testid="fnm-lyricoverlay">
      {/* 歌词区：⚠️ T77 **不给 `onSeek`** —— 纯歌词，点歌词**不跳转**。 */}
      <div className="fnm-lyricoverlay__lyrics">
        {/* ⚠️ T71：经典悬浮窗**也是卡拉OK**（当前词按词内连续比例从左到右染色）。
            ⚠️ **不显式传 `karaoke`** —— `LyricView` 的缺省已是**开**（T71）
                ⇒ 行为只由**一处**决定，将来新增歌词页面自动一致，不会漏一处。
            ⚠️ 词级时间戳（真逐字 / 伪逐字）由 `lines` 带进来：
                本窗**不自己拉歌词**（主窗口推过来，见 `src/player/lyricOverlay.ts`）。 */}
        <LyricView
          lines={safeLines}
          currentTime={position}
          mode="double"
          emptyLabel={track ? '暂无歌词' : '未在播放'}
        />
      </div>
    </div>
  )
}
