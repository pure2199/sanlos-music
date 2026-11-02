import { create } from 'zustand'

import type { AuthSessionInfo, CandidateInfo } from '../../shared/bridge'
import type { ConnectionInfo } from '../../shared/types'

// ---------------------------------------------------------------------------
// 会话状态（渲染进程）
//
// ⚠️ **这里只放脱敏数据**：
// - `session` 就是桥返回的 `AuthSessionInfo`（`connected` / `mode` / `username` /
//     `serverLabel` / `isRelay`）——**没有 token、没有口令、没有 deviceId**；
// - `connection` 是链路信息（基址 + 链路类型），不含凭证；
// - `candidates` 是最近一次 `probe()` 的候选列表（地址 / 展示名 / 可达性）。
//
// 口令只存在于 `LoginPage` 的组件本地 state，**永远不进这里**（追加要求 E）。
// ---------------------------------------------------------------------------

/** 未登录时的脱敏会话形态。 */
const DISCONNECTED: AuthSessionInfo = {
  connected: false,
  mode: null,
  username: null,
  serverLabel: null,
  isRelay: false,
}

export interface SessionStore {
  /** 脱敏的会话状态。 */
  session: AuthSessionInfo
  /** 当前链路信息（没有会话时为 `null`）。 */
  connection: ConnectionInfo | null
  /** 最近一次 `probe()` 的候选链路（不含凭证）。 */
  candidates: CandidateInfo[]
  /** 写入会话状态。 */
  setSession: (session: AuthSessionInfo) => void
  /** 写入当前链路信息。 */
  setConnection: (connection: ConnectionInfo | null) => void
  /** 缓存最近一次 `probe()` 的候选链路（供 ConnectionBadge 展开时展示）。 */
  setCandidates: (candidates: CandidateInfo[]) => void
  /** 清空全部会话状态（登出）。 */
  reset: () => void
}

export const useSessionStore = create<SessionStore>()((set) => ({
  session: DISCONNECTED,
  connection: null,
  candidates: [],
  setSession: (session) => set({ session }),
  setConnection: (connection) => set({ connection }),
  setCandidates: (candidates) => set({ candidates }),
  reset: () =>
    set({ session: DISCONNECTED, connection: null, candidates: [] }),
}))
