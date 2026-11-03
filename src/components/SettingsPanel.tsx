// ---------------------------------------------------------------------------
// 设置面板（Task 8）
// ---------------------------------------------------------------------------
//
// 目前只有一项：**「关闭窗口时」的行为**。
//
// ⚠️ 这一项**此前没有 UI**（`prefs.closeBehavior` 早就写进 `prefs.json`、
//    主进程也早就消费它，但用户改不了）——审计报表 P1 的「偏好有键无 UI」。
//
// ⚠️ 偏好的**单一真相源 = 主进程 `prefs.json`**：本面板只经
//    `useAppPrefsStore` 读写，不碰偏好文件本身。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），
//    样式住在同目录的 `settings-panel.css`。
// ---------------------------------------------------------------------------

import { useCallback, type ReactElement } from 'react'

import type { CloseBehavior } from '../../shared/playerBridge'
import { useAppPrefsStore } from '../state/appPrefsStore'
import './settings-panel.css'

/** `SettingsPanel` 的属性。 */
export interface SettingsPanelProps {
  /** 附加类名。 */
  className?: string
}

/** 设置面板。 */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { className } = props
  const closeBehavior = useAppPrefsStore((state) => state.closeBehavior)
  const setCloseBehavior = useAppPrefsStore((state) => state.setCloseBehavior)
  const lyricOverlayVisible = useAppPrefsStore((state) => state.lyricOverlayVisible)
  const setLyricOverlayVisible = useAppPrefsStore((state) => state.setLyricOverlayVisible)
  const error = useAppPrefsStore((state) => state.error)

  const handleChange = useCallback(
    (behavior: CloseBehavior) => {
      void setCloseBehavior(behavior)
    },
    [setCloseBehavior],
  )

  const handleToggleLyricOverlay = useCallback(
    (visible: boolean) => {
      void setLyricOverlayVisible(visible)
    },
    [setLyricOverlayVisible],
  )

  const rootClass = className ? `fnm-settings ${className}` : 'fnm-settings'

  return (
    <section className={rootClass} role="dialog" aria-label="设置">
      <h2 className="fnm-settings__title">设置</h2>

      <fieldset className="fnm-settings__group">
        <legend className="fnm-settings__legend">关闭窗口时</legend>
        <label className="fnm-settings__option">
          <input
            type="radio"
            name="fnm-close-behavior"
            value="hide"
            checked={closeBehavior === 'hide'}
            onChange={() => handleChange('hide')}
          />
          <span>隐藏窗口（播放继续）</span>
        </label>
        <label className="fnm-settings__option">
          <input
            type="radio"
            name="fnm-close-behavior"
            value="quit"
            checked={closeBehavior === 'quit'}
            onChange={() => handleChange('quit')}
          />
          <span>直接退出应用</span>
        </label>
      </fieldset>

      <fieldset className="fnm-settings__group">
        <legend className="fnm-settings__legend">桌面悬浮歌词</legend>
        <label className="fnm-settings__option">
          <input
            type="checkbox"
            name="fnm-lyric-overlay"
            checked={lyricOverlayVisible}
            onChange={(event) => handleToggleLyricOverlay(event.target.checked)}
          />
          <span>显示悬浮歌词（双行逐字，可拖动 / 点歌跳转）</span>
        </label>
      </fieldset>

      <p className="fnm-settings__hint">窗口位置与尺寸会自动记住，下次启动时恢复。</p>

      {error && (
        <p className="fnm-settings__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
