import type { AuthBridge } from '../../shared/bridge'

/**
 * 取渲染进程的认证桥。
 *
 * - 桌面壳里（`electron/preload.ts`）恒定存在；
 * - 纯浏览器预览（`vite dev` 不带 Electron）时为 `null`——调用方自己决定怎么提示，
 *   这里**不**抛错，免得整个界面直接崩掉。
 *
 * ⚠️ 这里只做「取桥」，**不新造**任何桥接口：`AuthBridge` 就是 `shared/bridge.ts` 的那一份。
 */
export function getBridge(): AuthBridge | null {
  const scope = window as unknown as { sanlosAuth?: AuthBridge }
  return scope.sanlosAuth ?? null
}
