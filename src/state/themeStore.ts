// ---------------------------------------------------------------------------
// 主题 store（**渲染进程**，Task 6）
// ---------------------------------------------------------------------------
//
// ⚠️ **主题的单一真相源 = 主进程的 `prefs.json`**（`AppPrefs.theme`）。
//    本 store 只是**渲染层的镜像**：
// - 启动时 `load()` 读一次主进程偏好并应用；
// - 切换时 `setTheme()` **乐观应用**（界面立刻变）+ 写回主进程；
//   写回失败 → **回滚**到原主题（别让界面显示一个没被记住的主题）。
//
// ⚠️ 早先这里用过 localStorage（`settingsStore` 的 `theme` 字段）——
//    那与 `prefs.json` 构成「双真相源」，Task 17 已把它删干净，
//    主题只认主进程这一条路。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { ThemeName } from '../../shared/types'
import { DEFAULT_THEME, resolveThemeName } from '../../shared/themes'
import type { PlayerBridge } from '../../shared/playerBridge'
import { applyTheme } from '../theme'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 主题 store 的形状。 */
export interface ThemeStore {
  /** 当前主题（渲染层镜像；真相源在主进程）。 */
  theme: ThemeName
  /** 上一次操作的错误（`null` = 没有）。 */
  error: string | null
  /** 从主进程读一次偏好并应用（**启动时调用一次**）。 */
  load: () => Promise<void>
  /** 切换主题（乐观应用 + 写回主进程；失败则回滚）。 */
  setTheme: (theme: ThemeName) => Promise<void>
}

/** 主题 store（生产用）。 */
export const useThemeStore = create<ThemeStore>()((set, get) => ({
  theme: DEFAULT_THEME,
  error: null,

  load: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      // 没有桥（浏览器预览 / 单测）→ 用默认主题，不报错、不崩。
      set({ theme: applyTheme(DEFAULT_THEME), error: null })
      return
    }
    try {
      const prefs = await bridge.getPrefs()
      set({ theme: applyTheme(resolveThemeName(prefs.theme)), error: null })
    } catch {
      // 读失败 → 退回默认主题（**不崩**，偏好丢了不该让应用起不来）。
      set({ theme: applyTheme(DEFAULT_THEME), error: null })
    }
  },

  setTheme: async (next: ThemeName): Promise<void> => {
    const theme = resolveThemeName(next)
    const previous = get().theme
    // 乐观应用：切换主题**必须即时反馈**。
    set({ theme: applyTheme(theme), error: null })

    const bridge = playerBridge()
    // 没有桥 → 只在本地生效（浏览器预览；不崩、也不静默写盘）。
    if (!bridge) return

    try {
      await bridge.setTheme(theme)
    } catch {
      // 写回失败 → 回滚（界面不能停在一个「没被记住」的主题上）。
      set({ theme: applyTheme(previous), error: '主题保存失败，已恢复原主题' })
    }
  },
}))
