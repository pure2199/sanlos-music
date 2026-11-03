import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { ThemeName } from '../../shared/types'

// ---------------------------------------------------------------------------
// 偏好设置（渲染进程）
//
// ⚠️ 这里**只放非敏感偏好**：上次用的服务器地址。
//    **任何凭证类字段都不许进这个 store**，持久化到 localStorage 的也只允许是
//    上面的偏好（`partialize` 白名单）。
//
// ⚠️ **主题名不在这里**（Task 17 起）：主题的**单一真相源 = 主进程 `prefs.json`**
//    （通道 `prefs:get` / `prefs:set` / `theme:set`，由 Task 17 建）。
//    早先这里持久化过主题名（localStorage 键 `fnmusic-settings`），
//    与 `prefs.json` 构成「双真相源」——Task 17 已把 `theme` / `setTheme`
//    与 `partialize` 白名单里的 `theme` 一并删除，
//    主题改由 Task 18 通过 `prefs:*` 读写。
// ---------------------------------------------------------------------------

export interface SettingsStore {
  /** 上次使用的服务器地址（非敏感）。 */
  lastServer: string
  /** 记录上次使用的服务器地址。 */
  setLastServer: (server: string) => void
}

/**
 * 旧版本（Task 17 之前）持久化到 localStorage 的形状里带 `theme`。
 *
 * ⚠️ store **已经不再持有**主题字段，但既有调用点仍可能带着这个键调用 `setState`。
 *    这里只给 `setState` 留一个**只写不读**的兼容入口：
 *    - 该键**不会被读取**（没有任何代码从 store 读主题）；
 *    - 该键**不会被持久化**（`partialize` 白名单里没有它）。
 */
export type LegacySettingsPatch = { theme?: ThemeName }

const store = create<SettingsStore>()(
  persist(
    (set) => ({
      lastServer: '',
      setLastServer: (lastServer) => set({ lastServer }),
    }),
    {
      name: 'fnmusic-settings',
      // 持久化白名单：**只有**服务器地址落盘，setter 之类的函数不落盘。
      // ⚠️ **主题名不在白名单里**——主题的真相源是主进程 `prefs.json`。
      partialize: (state) => ({ lastServer: state.lastServer }),
    },
  ),
)

/**
 * 偏好 store（生产用）。
 *
 * ⚠️ `setState` 的入参放宽到 `Partial<SettingsStore> & LegacySettingsPatch`：
 *    `SettingsStore` **没有** `theme` 字段，但既有调用点仍可能带着这个遗留键
 *    （旧版本 localStorage 的形状），这里保留一个**只写不读**的兼容入口，
 *    免得删字段时把调用方一起改坏。
 */
export const useSettingsStore = store as typeof store & {
  setState: (
    partial: Partial<SettingsStore> & LegacySettingsPatch,
    replace?: boolean,
  ) => void
}
