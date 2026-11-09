// ---------------------------------------------------------------------------
// 桌面悬浮歌词的内容组件（Task 10）
// ---------------------------------------------------------------------------
//
// 它是**独立窗口**里的内容：双行逐字歌词 + 歌名/歌手 + 播放控制。
//
// ---------------------------------------------------------------------------
// 分工（与已有模块的关系）
// ---------------------------------------------------------------------------
// - **双行推进逻辑**不重写：直接复用 `src/ui/lyrics/doubleLine.ts` 的
//   `computeDoubleLineState`——它本来就被设计成 Task 19（桌面悬浮歌词）复用的
//   纯函数（见该文件头注释）。
// - **逐字渲染**不重写：直接复用 `LyricView` 的 `mode="double"`。
// - **播放位置**由调用方给（本组件是纯展示，不自己取时间）。
//
// ---------------------------------------------------------------------------
// 交互（用户选定：**完全可交互**）
// ---------------------------------------------------------------------------
// - **点歌词行** → `onSeek(秒)`（跳转到那一行）；
// - **播放控制** → `onCommand(...)`（上一首 / 播放暂停 / 下一首）；
// - **拖动窗口** → 靠**标题条**（`.fnm-lyricoverlay__head`）上的
//   `-webkit-app-region: drag`（**只能**靠样式表表达，内联 style 做不到）。
//   歌词区与控制区是 `no-drag`，否则点不动它们。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在 `src/ui/lyrics/lyric-overlay.css`。
// ---------------------------------------------------------------------------

import type { ReactElement } from 'react'

import type { PlayerCommand } from '../../../shared/playerBridge'
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
  /** 当前曲目；没有播放时为 `null`。 */
  track: LyricOverlayTrack | null
  /** 歌词行（已解析；没有歌词时是空数组）。 */
  lines: LyricLine[]
  /** 当前播放位置（**秒**）。 */
  position: number
  /** 是否正在播放。 */
  isPlaying: boolean
  /** 点击歌词行时回调（秒）。 */
  onSeek?: (seconds: number) => void
  /** 播放控制回调。 */
  onCommand?: (command: PlayerCommand) => void
}

/**
 * 桌面悬浮歌词的内容。
 *
 * - 没有曲目 → 显示「未在播放」（**不白屏**）；
 * - 没有歌词 → `LyricView` 显示「暂无歌词」（**不白屏**）。
 */
export function LyricOverlay(props: LyricOverlayProps): ReactElement {
  const { track, lines, position, isPlaying, onSeek, onCommand } = props
  const safeLines = Array.isArray(lines) ? lines : []

  return (
    <div className="fnm-lyricoverlay" data-testid="fnm-lyricoverlay">
      {/* 标题条 = **拖动把手**（`-webkit-app-region: drag` 在样式表里）。 */}
      <header
        className="fnm-lyricoverlay__head"
        data-drag-handle="true"
        title="拖动可移动悬浮窗"
      >
        <span className="fnm-lyricoverlay__title">{track?.title ?? '未在播放'}</span>
        <span className="fnm-lyricoverlay__artist">{track?.artist ?? ''}</span>
      </header>

      {/* 歌词区：`-webkit-app-region: no-drag`（要点歌词跳转，不能被拖动区吃掉）。 */}
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
          onSeek={onSeek}
          emptyLabel="暂无歌词"
        />
      </div>

      {/* 播放控制：同样 `no-drag`。 */}
      <div className="fnm-lyricoverlay__controls">
        <button
          type="button"
          className="fnm-lyricoverlay__button"
          data-testid="fnm-lyricoverlay-prev"
          aria-label="上一首"
          title="上一首"
          onClick={() => onCommand?.({ type: 'prev' })}
        >
          上一首
        </button>
        <button
          type="button"
          className="fnm-lyricoverlay__button fnm-lyricoverlay__button--primary"
          data-testid="fnm-lyricoverlay-toggle"
          aria-label={isPlaying ? '暂停' : '播放'}
          title={isPlaying ? '暂停' : '播放'}
          onClick={() => onCommand?.({ type: 'toggle' })}
        >
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button
          type="button"
          className="fnm-lyricoverlay__button"
          data-testid="fnm-lyricoverlay-next"
          aria-label="下一首"
          title="下一首"
          onClick={() => onCommand?.({ type: 'next' })}
        >
          下一首
        </button>
      </div>
    </div>
  )
}
