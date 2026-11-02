import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { ThemeName } from '../../shared/types'

// ---------------------------------------------------------------------------
// 偏好设置（渲染进程）
//
// ⚠️ 这里**只放非敏感偏好**：上次用的服务器地址、主题名。
//    **任何凭证类字段都不许进这个 store**，持久化到 localStorage 的也只允许是
//    上面的两类偏好（`partialize` 白名单）。
// ---------------------------------------------------------------------------

export interface SettingsStore {
  /** 上次使用的服务器地址（非敏感）。 */
  lastServer: string
  /** 主题名（Task 18/19 的双主题会用它）。 */
  theme: ThemeName
  /** 记录上次使用的服务器地址。 */
  setLastServer: (server: string) => void
  /** 设置主题名。 */
  setTheme: (theme: ThemeName) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      lastServer: '',
      theme: 'apple',
      setLastServer: (lastServer) => set({ lastServer }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'fnmusic-settings',
      // 持久化白名单：**只有**地址与主题名落盘，setter 之类的函数不落盘。
      partialize: (state) => ({ lastServer: state.lastServer, theme: state.theme }),
    },
  ),
)
