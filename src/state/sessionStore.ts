import { create } from 'zustand'

import type { AuthSessionInfo, CandidateInfo } from '../../shared/bridge'
import type { ConnectionInfo } from '../../shared/types'
import { getBridge } from '../lib/bridge'

// ---------------------------------------------------------------------------
// 会话状态（渲染进程）
// ---------------------------------------------------------------------------
//
// ⚠️ **这里只放脱敏数据**：
// - `session` 就是桥返回的 `AuthSessionInfo`（`connected` / `mode` / `username` /
//     `serverLabel` / `isRelay`）——**没有 token、没有口令、没有 deviceId**；
// - `connection` 是链路信息（基址 + 链路类型），不含凭证；
// - `candidates` 是最近一次 `probe()` 的候选列表（地址 / 展示名 / 可达性）。
//
// 口令只存在于 `LoginPage` 的组件本地 state，**永远不进这里**（追加要求 E）。
//
// ---------------------------------------------------------------------------
// T38：会话恢复收敛到这个 store
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么不再放在 `LoginPage` 里**：未登录时主区默认是「本地音乐」页
//    → 登录页**根本没挂载** → `restore()` 没人调 → 应用就不知道自己登录了没有
//    （顶栏导航的可见性、默认进哪个页，全都要靠这个状态）。
//    ⇒ 恢复动作必须**从 App 出发**，与当前视图无关。
//
// ⚠️ `restore()` 会让主进程的会话世代号 +1，从而作废正在飞行的静默续期
//    → **只调一次**：并发调用共享同一个 Promise（`restoreInFlight`），
//    恢复完成后 `restored` 置位 → 之后的调用直接返回。
// ---------------------------------------------------------------------------

/** 未登录时的脱敏会话形态。 */
const DISCONNECTED: AuthSessionInfo = {
  connected: false,
  mode: null,
  username: null,
  serverLabel: null,
  isRelay: false,
}

/** 正在飞的恢复 Promise（**并发调用共享同一份**）。 */
let restoreInFlight: Promise<void> | null = null

export interface SessionStore {
  /** 脱敏的会话状态。 */
  session: AuthSessionInfo
  /** 当前链路信息（没有会话时为 `null`）。 */
  connection: ConnectionInfo | null
  /** 最近一次 `probe()` 的候选链路（不含凭证）。 */
  candidates: CandidateInfo[]
  /**
   * 是否**已经尝试过**恢复会话（成功或失败都算）。
   *
   * ⚠️ 用它做「只恢复一次」的闸门——`restore()` 有副作用
   *    （主进程会话世代号 +1），**不能**反复调。
   */
  restored: boolean
  /** 写入会话状态。 */
  setSession: (session: AuthSessionInfo) => void
  /** 写入当前链路信息。 */
  setConnection: (connection: ConnectionInfo | null) => void
  /** 缓存最近一次 `probe()` 的候选链路（供 ConnectionBadge 展开时展示）。 */
  setCandidates: (candidates: CandidateInfo[]) => void
  /**
   * 恢复会话（**只恢复一次**；并发调用共享同一个 Promise）。
   *
   * ⚠️ 恢复失败按「未登录」处理：**不抛**、不阻断界面。
   */
  restore: () => Promise<void>
  /** 清空全部会话状态（登出）。 */
  reset: () => void
}

export const useSessionStore = create<SessionStore>()((set, get) => ({
  session: DISCONNECTED,
  connection: null,
  candidates: [],
  restored: false,
  setSession: (session) => set({ session }),
  setConnection: (connection) => set({ connection }),
  setCandidates: (candidates) => set({ candidates }),
  restore: async (): Promise<void> => {
    // ⚠️ 已经恢复过 → 直接返回（**绝不再调**主进程的 `restore()`）。
    if (get().restored) return
    // ⚠️ 正在飞 → **共享**同一个 Promise（StrictMode 的双 effect 也走这条）。
    if (restoreInFlight) {
      await restoreInFlight
      return
    }
    const run = (async (): Promise<void> => {
      const bridge = getBridge()
      if (!bridge) {
        set({ restored: true })
        return
      }
      try {
        const info = (await bridge.restore()) as AuthSessionInfo | undefined
        // ⚠️ **主进程回了个不像样的东西** → 按「未登录」处理，
        //    **不要**把 `session` 写成 `undefined`（那会让消费方炸掉）。
        if (!info || typeof info !== 'object') {
          set({ restored: true })
          return
        }
        set({ session: info, restored: true })
        if (info.connected) {
          const connection = (await bridge.connectionInfo()) as ConnectionInfo | undefined
          set({ connection: connection && typeof connection === 'object' ? connection : null })
        }
      } catch {
        // 恢复失败按「未登录」处理：不阻断界面。
        set({ restored: true })
      }
    })()
    restoreInFlight = run
    try {
      await run
    } finally {
      restoreInFlight = null
    }
  },
  reset: () =>
    // ⚠️ **`restored` 保持不变**：会话失效后**不能再恢复**——
    //    否则会把 `session.bin` 里那个死 token 读回来，界面又显示成「已连接」。
    set({ session: DISCONNECTED, connection: null, candidates: [] }),
}))
