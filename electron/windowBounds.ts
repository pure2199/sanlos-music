// ---------------------------------------------------------------------------
// 窗口位置与尺寸记忆（Task 8）
// ---------------------------------------------------------------------------
//
// ⚠️ 审计报表 G-1：`AppPrefs.windowBounds` 早就有了，主进程却**从不消费**
//    → 窗口尺寸记忆形同虚设。这里补上，并把逻辑从 `electron/main.ts` 里
//    **抽成可注入的模块**（主进程本身要 Electron 运行时，没法单测）。
//
// ---------------------------------------------------------------------------
// 语义
// ---------------------------------------------------------------------------
// - **恢复**：建窗时按偏好给尺寸与位置（没有偏好就用默认尺寸、居中由系统决定）；
// - **保存**：移动 / 缩放后**去抖**写回偏好（写盘是同步的，
//   不去抖的话拖动窗口时每帧都在写文件）；
// - **关闭前**也存一次（用户可能刚拖动完就关）。
//
// ⚠️ 偏好文件里**只有**位置尺寸，没有任何凭证。
// ---------------------------------------------------------------------------

import type { WindowBounds } from '../shared/playerBridge'

/** 窗口当前的位置与尺寸（与 Electron 的 `getBounds()` 同形）。 */
export interface WindowBoundsSnapshot {
  x: number
  y: number
  width: number
  height: number
}

/** 建窗时用的参数。 */
export interface WindowBoundsOptions {
  /** 宽度（像素）。 */
  width: number
  /** 高度（像素）。 */
  height: number
  /** 左上角横坐标（缺省 = 不指定）。 */
  x?: number
  /** 左上角纵坐标（缺省 = 不指定）。 */
  y?: number
}

/**
 * 由「已保存的偏好 + 默认尺寸」算出建窗参数。
 *
 * ⚠️ **缺位置就不给位置**：只存了尺寸时**不要**硬塞一个 `x/y`
 *    （否则窗口会跑到某个历史坐标上，而不是用户当前期望的位置）。
 */
export function resolveWindowBounds(
  saved: WindowBounds | undefined,
  fallback: { width: number; height: number },
): WindowBoundsOptions {
  if (!saved || saved.width <= 0 || saved.height <= 0) {
    return { width: fallback.width, height: fallback.height }
  }
  const options: WindowBoundsOptions = { width: saved.width, height: saved.height }
  if (typeof saved.x === 'number' && Number.isFinite(saved.x)) options.x = Math.floor(saved.x)
  if (typeof saved.y === 'number' && Number.isFinite(saved.y)) options.y = Math.floor(saved.y)
  return options
}

/** 「去抖保存」器的依赖。 */
export interface BoundsSaverParams {
  /** 取当前窗口位置尺寸（返回 `null` = 拿不到，别写）。 */
  getBounds: () => WindowBoundsSnapshot | null
  /** 写回偏好。 */
  save: (bounds: WindowBoundsSnapshot) => void
  /** 去抖间隔（毫秒，默认 500）。 */
  delayMs?: number
}

/** 「去抖保存」器。 */
export interface BoundsSaver {
  /** 请求保存（**去抖**：连续调用只会真正写一次）。 */
  schedule: () => void
  /** 立刻保存（忽略去抖）。 */
  saveNow: () => void
  /** 取消挂起的保存（窗口销毁时用）。 */
  dispose: () => void
}

/**
 * 造一个「去抖保存」器。
 *
 * ⚠️ 写盘是**同步**的（`PrefsStore.write` 直接写文件）→ 必须去抖。
 */
export function createBoundsSaver(params: BoundsSaverParams): BoundsSaver {
  const { getBounds, save, delayMs = 500 } = params
  let timer: ReturnType<typeof setTimeout> | null = null

  const saveNow = (): void => {
    const bounds = getBounds()
    if (!bounds) return
    save({
      x: Math.floor(bounds.x),
      y: Math.floor(bounds.y),
      width: Math.floor(bounds.width),
      height: Math.floor(bounds.height),
    })
  }

  return {
    saveNow,
    schedule: (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        saveNow()
      }, delayMs)
    },
    dispose: (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
