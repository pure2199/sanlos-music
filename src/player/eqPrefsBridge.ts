// ---------------------------------------------------------------------------
// EQ 偏好的持久化端口（**渲染进程**）
// ---------------------------------------------------------------------------
//
// Task 5：把 `createEqPrefsPort`（`src/player/eq.ts`）真正接上主进程的
// `prefs:get` / `prefs:set` 通道 —— 此前它**零调用**，EQ 设置重启即丢
// （审计报表 P0-2「store 未传端口」）。
//
// ---------------------------------------------------------------------------
// 为什么走 `window.fnPlayer`
// ---------------------------------------------------------------------------
// 偏好文件的**唯一真相源在主进程**（`prefs.json`）：
// - 读：`window.fnPlayer.getPrefs()` → `AppPrefs.eq`；
// - 写：`window.fnPlayer.setPrefs({ eq })` → 主进程白名单校验后原子落盘。
//
// ⚠️ 渲染进程**碰不到** `prefs.json` 本身，也不碰任何凭证——
//    这个端口传的只有曲线参数。
//
// ⚠️ **没有桥就降级**：浏览器里直接打开渲染层、或单元测试（jsdom）里
//    `window.fnPlayer` 不存在 → `load()` 返回 `null`、`save()` 静默 no-op。
//    EQ 在**本次运行内**照常可用，只是不落盘（**不崩、不静默写盘**）。
// ---------------------------------------------------------------------------

import type { PlayerBridge } from '../../shared/playerBridge'
import { createEqPrefsPort, type EqPrefs, type EqPrefsPort } from './eq'

/** 拿渲染进程里的播放器桥（没有就返回 `null`）。 */
function getPlayerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/**
 * EQ 偏好的持久化端口（生产用）。
 *
 * ⚠️ 这个模块**只导出一个常量**——端口必须在**模块加载时**造出来，
 *    因为 `createPlayerStore` 会在创建时立刻 `load()` 一次
 *    （重启后恢复 EQ 设置靠的就是这一下）。
 */
export const eqPrefsPort: EqPrefsPort = createEqPrefsPort(
  async (): Promise<EqPrefs | null> => {
    const bridge = getPlayerBridge()
    if (!bridge) return null
    const prefs = await bridge.getPrefs()
    return prefs.eq ?? null
  },
  async (eq: EqPrefs): Promise<void> => {
    const bridge = getPlayerBridge()
    if (!bridge) return
    await bridge.setPrefs({ eq })
  },
)
