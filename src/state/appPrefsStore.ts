// ---------------------------------------------------------------------------
// 应用偏好的**渲染层镜像**（Task 6 / Task 8）
// ---------------------------------------------------------------------------
//
// ⚠️ **偏好的单一真相源 = 主进程的 `prefs.json`**（`AppPrefs`）。
//    本 store 只是**镜像**：读一次、写入回，不另立门户。
//
//    早先渲染层用 localStorage 存过主题名（`settingsStore` 的 `theme` 字段），
//    那与 `prefs.json` 构成「双真相源」，Task 17 已把它删干净。
//
// ⚠️ 这里**只有非敏感偏好**（主题名 / 关闭窗口的行为）——
//    **凭证（token / 口令 / deviceId）一律不许出现在这里**，那是 `session.bin` 的职责。
//
// ---------------------------------------------------------------------------
// 写回语义
// ---------------------------------------------------------------------------
// - **乐观应用**：界面立刻变（切换主题 / 改设置不能有延迟感）；
// - 写回失败 → **回滚**到原值并给出提示
//   （界面不能停在一个「没被记住」的状态上）。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { ThemeName } from '../../shared/types'
import { DEFAULT_THEME, resolveThemeName } from '../../shared/themes'
import type { CloseBehavior, PlayerBridge } from '../../shared/playerBridge'
import { applyTheme } from '../theme'

/** 默认的「关闭窗口」行为（隐藏，播放继续）。 */
export const DEFAULT_CLOSE_BEHAVIOR: CloseBehavior = 'hide'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 应用偏好镜像 store 的形状。 */
export interface AppPrefsStore {
  /** 当前主题。 */
  theme: ThemeName
  /** 「关闭窗口」的行为。 */
  closeBehavior: CloseBehavior
  /** 上一次操作的错误（`null` = 没有）。 */
  error: string | null
  /** 从主进程读一次偏好并应用（**启动时调用一次**）。 */
  load: () => Promise<void>
  /** 切换主题（乐观应用 + 写回主进程；失败则回滚）。 */
  setTheme: (theme: ThemeName) => Promise<void>
  /** 改「关闭窗口」的行为（乐观应用 + 写回主进程；失败则回滚）。 */
  setCloseBehavior: (behavior: CloseBehavior) => Promise<void>
}

/** 应用偏好镜像 store（生产用）。 */
export const useAppPrefsStore = create<AppPrefsStore>()((set, get) => ({
  theme: DEFAULT_THEME,
  closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
  error: null,

  load: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      // 没有桥（浏览器预览 / 单测）→ 用默认值，不报错、不崩。
      set({ theme: applyTheme(DEFAULT_THEME), closeBehavior: DEFAULT_CLOSE_BEHAVIOR, error: null })
      return
    }
    try {
      const prefs = await bridge.getPrefs()
      set({
        theme: applyTheme(resolveThemeName(prefs.theme)),
        closeBehavior: prefs.closeBehavior === 'quit' ? 'quit' : DEFAULT_CLOSE_BEHAVIOR,
        error: null,
      })
    } catch {
      // 读失败 → 退回默认值（**不崩**，偏好丢了不该让应用起不来）。
      set({
        theme: applyTheme(DEFAULT_THEME),
        closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
        error: null,
      })
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

  setCloseBehavior: async (next: CloseBehavior): Promise<void> => {
    const behavior: CloseBehavior = next === 'quit' ? 'quit' : DEFAULT_CLOSE_BEHAVIOR
    const previous = get().closeBehavior
    set({ closeBehavior: behavior, error: null })

    const bridge = playerBridge()
    if (!bridge) return

    try {
      await bridge.setPrefs({ closeBehavior: behavior })
    } catch {
      set({ closeBehavior: previous, error: '设置保存失败，已恢复原设置' })
    }
  },
}))
