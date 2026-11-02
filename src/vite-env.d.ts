/// <reference types="vite/client" />

// ---------------------------------------------------------------------------
// 渲染进程的全局类型声明（Task 10b）。
//
// `electron/preload.ts` 通过 `contextBridge` 暴露了**两个**全局：
// - `window.fn`：认证桥（七个方法，**永远不返回 token / 口令**）；
// - `window.fnmusic`：只读的平台信息。
//
// ⚠️ `FnBridge` 用 **type-only import** 从 `shared/bridge.ts` 引入——
//    那个文件是纯类型文件（只有 interface / type），编译后不留任何运行时代码，
//    不会把主进程逻辑打进渲染进程 bundle。
// ---------------------------------------------------------------------------

import type { FnBridge } from '../shared/bridge'

declare global {
  interface Window {
    /** 认证桥：七个 `auth:*` 对应的方法。 */
    fn: FnBridge
    /** 只读的平台信息（`process.platform`）。 */
    fnmusic: { platform: string }
  }
}

export {}
