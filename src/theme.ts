// ---------------------------------------------------------------------------
// 主题在**渲染进程**里的应用（Task 6）
// ---------------------------------------------------------------------------
//
// 主题的**单一真相源 = 主进程的 `prefs.json`**（`AppPrefs.theme`）。
// 本文件只负责「把主题名变成 DOM 上的一个属性」——
// 即 `document.documentElement.dataset.theme = 'fluent'`，
// CSS 那边由 `src/styles/tokens.css` 的 `[data-theme='fluent']` 接管配色。
//
// ⚠️ **不持有状态**：当前主题放在 `src/state/themeStore.ts`（渲染层镜像），
//    写回主进程由那里的 `setTheme` 负责。
// ---------------------------------------------------------------------------

import type { ThemeName } from '../shared/types'
import { DEFAULT_THEME, resolveThemeName } from '../shared/themes'

/** `<html>` 上用来标记主题的属性名。 */
export const THEME_ATTRIBUTE = 'theme'

/**
 * 把主题应用到文档根元素。
 *
 * ⚠️ 写的是 `data-theme` 属性（**不是** class）——CSS 侧的选择器
 *    `[data-theme='fluent']` 与属性名一一对应，加减主题不用动样式表。
 */
export function applyTheme(name: unknown): ThemeName {
  const theme = resolveThemeName(name)
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset[THEME_ATTRIBUTE] = theme
  }
  return theme
}

/**
 * 读回**当前已应用**到 DOM 上的主题名。
 *
 * @returns 已应用的主题名；没应用过（DOM 上没有这个属性）时返回默认主题。
 */
export function readAppliedTheme(): ThemeName {
  if (typeof document === 'undefined' || !document.documentElement) return DEFAULT_THEME
  const raw = document.documentElement.dataset[THEME_ATTRIBUTE]
  return raw ? resolveThemeName(raw) : DEFAULT_THEME
}
