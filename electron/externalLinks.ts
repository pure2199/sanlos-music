// ---------------------------------------------------------------------------
// 外部链接（用系统浏览器打开）（T41）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独一个模块**：白名单判定与「真的去打开」要**能单测**
//    （主进程里 `shell.openExternal` 只有 Electron 进程里才有）→ 逻辑抽成
//    **纯函数 + 依赖注入**，`shell` 由调用方（`electron/ipc.ts`）注入。
//
// ⚠️ **白名单在主进程这一侧**：渲染层给什么 URL 都开不了别的站点；
//    渲染层**不能**自己 `window.open`（主窗口没配 `setWindowOpenHandler`
//    → 链接会把应用窗口整个导航走）。
// ---------------------------------------------------------------------------

import { isAllowedExternalUrl } from '../shared/appInfo'

/** `openExternalUrl` 的依赖。 */
export interface ExternalLinkDeps {
  /** 用系统默认浏览器打开（主进程注入 `shell.openExternal`）。 */
  open: (url: string) => Promise<void>
}

/**
 * 用系统默认浏览器打开一个**外部链接**。
 *
 * - **不在白名单**（协议不是 https / 主机名不匹配 / 带账号密码 / 非默认端口）→ **拒绝**，什么都不做；
 * - 系统浏览器打不开（抛错）→ 也**不算失败**（不弹错），只是没打开。
 *
 * @param raw 待打开的 URL。
 * @param deps 依赖（打开动作由调用方注入）。
 * @returns 是否真的打开了。
 */
export async function openExternalUrl(raw: string, deps: ExternalLinkDeps): Promise<boolean> {
  if (!isAllowedExternalUrl(raw)) return false
  try {
    await deps.open(raw.trim())
    return true
  } catch {
    // ⚠️ 打开失败**不抛**：这只是个「点了个链接」，不该把应用搞崩。
    return false
  }
}
