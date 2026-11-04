// ---------------------------------------------------------------------------
// 播放模式偏好的持久化端口（**渲染进程**，生产用）
// ---------------------------------------------------------------------------
//
// T29：把播放模式接上主进程的 `prefs:get` / `prefs:set` 通道 ——
// 此前播放模式**只活在内存里**，重启应用就回到「顺序播放」。
//
// ---------------------------------------------------------------------------
// 为什么走 `window.fnPlayer`
// ---------------------------------------------------------------------------
// 偏好文件的**唯一真相源在主进程**（`prefs.json`）：
// - 读：`window.fnPlayer.getPrefs()` → `AppPrefs.playMode`；
// - 写：`window.fnPlayer.setPrefs({ playMode })` → 主进程白名单校验后原子落盘。
//
// ⚠️ 渲染进程**碰不到** `prefs.json` 本身，也不碰任何凭证——
//    这个端口传的只有一个模式名。
//
// ⚠️ **没有桥就降级**：浏览器里直接打开渲染层、或单元测试（jsdom）里
//    `window.fnPlayer` 不存在 → `load()` 返回 `null`、`save()` 静默 no-op。
//    播放模式在**本次运行内**照常可用，只是不落盘（**不崩、不静默写盘**）。
//
// ---------------------------------------------------------------------------

import type { PlayerBridge } from '../../shared/playerBridge'
import {
  createPlayModePrefsPort,
  normalizePlayMode,
  type PlayMode,
  type PlayModePrefsPort,
} from './playModePrefs'

/** 拿渲染进程里的播放器桥（没有就返回 `null`）。 */
function getPlayerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/**
 * 播放模式的持久化端口（生产用）。
 *
 * ⚠️ 这个模块**只导出一个常量**——端口必须在**模块加载时**造出来，
 *    因为 `createPlayerStore` 会在创建时立刻 `load()` 一次
 *    （重启后恢复播放模式靠的就是这一下）。
 */
export const playModePrefsPort: PlayModePrefsPort = createPlayModePrefsPort(
  async (): Promise<PlayMode | null> => {
    const bridge = getPlayerBridge()
    if (!bridge) return null
    const prefs = await bridge.getPrefs()
    // ⚠️ **没设置过** → `null`（让 store 保持默认的「顺序播放」）。
    // ⚠️ **设置了但是陌生值** → 归一化成「顺序播放」：
    //    `prefs.json` 是用户可编辑的文件，不能让它流到 store 里。
    if (prefs.playMode === undefined) return null
    return normalizePlayMode(prefs.playMode)
  },
  async (mode: PlayMode): Promise<void> => {
    const bridge = getPlayerBridge()
    if (!bridge) return
    await bridge.setPrefs({ playMode: mode })
  },
)
