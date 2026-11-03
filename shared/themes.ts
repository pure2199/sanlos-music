// ---------------------------------------------------------------------------
// 主题元信息（主进程与渲染进程共用）
// ---------------------------------------------------------------------------
//
// ⚠️ **主题的单一真相源是主进程的 `prefs.json`**（`AppPrefs.theme`）——
//    本文件**不持有**任何状态，只是「有哪些主题、各叫什么名字」的**静态清单**。
//
// ⚠️ **视觉真相源是 CSS**（`src/styles/tokens.css` 的 `[data-theme='…']` 变量覆盖）。
//    这里的 `windowBackground` 只是给主进程的一个**近似值**（避免启动瞬间白闪），
//    它**镜像** CSS 里的 `--surface`，不是第二套视觉定义。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// 这里**只有主题名与颜色**，绝不含凭证。
// ---------------------------------------------------------------------------

import type { ThemeName } from './types'

/** 一个主题的元信息。 */
export interface ThemeSpec {
  /** 主题名（写进 `<html data-theme="…">`，也是 `prefs.json` 里存的值）。 */
  name: ThemeName
  /** 界面展示名。 */
  label: string
  /**
   * 窗口底色（主进程用：`BrowserWindow.setBackgroundColor`）。
   *
   * ⚠️ 镜像的是 CSS 的 `--surface`——**近似值**，不是视觉真相源。
   */
  windowBackground: string
}

/** 全部主题（**顺序即切换器里的展示顺序**）。 */
export const THEMES: readonly ThemeSpec[] = [
  { name: 'apple', label: 'Apple 风', windowBackground: '#f2f2f7' },
  { name: 'fluent', label: 'Windows 11 风', windowBackground: '#f3f3f3' },
]

/** 默认主题（没存过偏好时用这个）。 */
export const DEFAULT_THEME: ThemeName = 'apple'

/**
 * 取主题的元信息。
 *
 * @param name 任意输入（不可信：偏好文件是用户可编辑的）。
 * @returns 对应的元信息；名字不认识时返回**默认主题**的元信息。
 */
export function themeSpec(name: unknown): ThemeSpec {
  const found = THEMES.find((theme) => theme.name === name)
  if (found) return found
  return THEMES.find((theme) => theme.name === DEFAULT_THEME) ?? THEMES[0]!
}

/**
 * 把任意输入归一成**合法的主题名**。
 *
 * @param name 任意输入。
 * @returns 合法主题名；不认识时返回**默认主题**。
 */
export function resolveThemeName(name: unknown): ThemeName {
  return themeSpec(name).name
}
