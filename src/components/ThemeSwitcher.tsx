// ---------------------------------------------------------------------------
// 主题切换按钮（Task 6）
// ---------------------------------------------------------------------------
//
// 顶栏上的一颗按钮：显示**当前**主题名，点一下切到下一套。
//
// ⚠️ **主题的单一真相源 = 主进程 `prefs.json`**——本组件只经
//    `useThemeStore` 驱动，不自己管状态、也不自己碰偏好文件。
//
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），
//    样式住在同目录的 `theme-switcher.css`。
// ---------------------------------------------------------------------------

import { useCallback, type ReactElement } from 'react'

import { THEMES, themeSpec } from '../../shared/themes'
import { useAppPrefsStore } from '../state/appPrefsStore'
import './theme-switcher.css'

/** `ThemeSwitcher` 的属性。 */
export interface ThemeSwitcherProps {
  /** 附加类名。 */
  className?: string
}

/**
 * 主题切换按钮。
 *
 * - 按钮文字 = **当前**主题名（不是「要切到哪个」——避免歧义）；
 * - `title` = 点了会切到哪一套；
 * - 切换失败（写回主进程出错）时按钮下方给出可读提示。
 */
export function ThemeSwitcher(props: ThemeSwitcherProps): ReactElement {
  const { className } = props
  const theme = useAppPrefsStore((state) => state.theme)
  const setTheme = useAppPrefsStore((state) => state.setTheme)
  const error = useAppPrefsStore((state) => state.error)

  const current = themeSpec(theme)
  // 下一套 = 清单里的下一项（到头就绕回第一项）。
  const index = THEMES.findIndex((item) => item.name === theme)
  const next = THEMES[(index + 1) % THEMES.length] ?? THEMES[0]!

  const handleClick = useCallback((): void => {
    void setTheme(next.name)
  }, [next.name, setTheme])

  const rootClass = className ? `fnm-theme ${className}` : 'fnm-theme'

  return (
    <div className={rootClass}>
      <button
        type="button"
        className="fnm-theme__button"
        onClick={handleClick}
        title={`切换到${next.label}`}
        aria-label="切换主题"
      >
        {current.label}
      </button>
      {error && (
        <p className="fnm-theme__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
