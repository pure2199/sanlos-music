// ---------------------------------------------------------------------------
// 服务端的「初始化状态」（T128）
// ---------------------------------------------------------------------------
//
// ⭐ **这个端点回答的是「飞牛音乐这个『应用』有没有完成首次初始化」**
//    （扫库 / 建索引）—— **不是**「NAS 有没有登录」。
//
// 证据（实测 ＋ 扒 NAS 自托管的 Web 前端包，**代码级证据**，不是推测）：
// - 真机实测（2026-11-20，FN 中继 ＋ 真实 NAS，只读 GET）：
//   `GET /initialization/state` ⇒ `code=0`，`data = { initialized: true }`，
//   **data 只有这一个字段**，耗时 **174 ms**；
// - Web 包 `bdf49c3c…js`：
//   `entryRoute = initialized ? (currentUser ? '/' : '/login') : '/welcome'`
//   ⇒ **`initialized === false` ⇒ 路由到 `/welcome`（初始化引导页）**；
// - Web 包 `8a84e406…js`：`k = data?.initialized === false`（服务端的「未初始化」分支）；
// - 错误码表：`AppNotInitialized`（"The app has not been initialized."）、
//   `InitRequiresNASAdmin`（"Initialization requires NAS administrator permissions."）。
//
// ⇒ **未初始化 ⇒ 曲库索引没建好 ⇒ 搜索 / 建议 / 榜单全是空的**。
// ⇒ 客户端的价值：**如实告诉用户「不是没找到，是服务端还没初始化」**。
//
// ⚠ **绝不能碰写操作**：`/initialization/prepare`、`/initialization/confirm` 是 **POST**
//    且要 NAS 管理员权限 ⇒ 本客户端**只读**、不写。
//
// ⚠ **三态**：`true`（已初始化）／`false`（**未初始化**）／`null`（**未知**）。
//    ⚠ **「未知」绝不当成「未初始化」** ⇒ 老服务端上界面一个字都不显示。
// ---------------------------------------------------------------------------

import { apiCall } from './client'

/** 服务端返回的原始形状（**只有这一个字段**，实测）。 */
interface RawInitializationState {
  /** 服务端有没有完成首次初始化（扫库 / 建索引）。 */
  initialized?: boolean | null
}

/**
 * 取服务端的初始化状态。
 *
 * @returns
 * - `true` ＝ **已初始化**（曲库索引建好了）；
 * - `false` ＝ **未初始化**（曲库索引还没建 ⇒ 搜索 / 建议 / 榜单必然是空的）；
 * - `null` ＝ **未知**（老服务端没这个端点 / 字段缺失 / 请求失败）⇒ **界面不提示**。
 *
 * ⚠ **老服务端上端点不存在** ⇒ 服务端返回 HTTP 200 但 body = **`null`**
 *    ⇒ `apiCall` 会抛「响应不是预期信封」⇒ 这里**捕获** ⇒ 返回 `null`（**不崩**）。
 * ⚠ **「取不到」与「没初始化」是两件事** ⇒ 绝不能把异常当成 `false`。
 */
export async function state(): Promise<boolean | null> {
  try {
    const data = await apiCall<RawInitializationState>('/initialization/state')
    // ⚠ 只有**明确的布尔值**才算数 ⇒ `undefined` / `null` / 其它类型一律当「未知」。
    if (typeof data.initialized === 'boolean') return data.initialized
    return null
  } catch {
    // ⚠ 老服务端没这个端点（body = null ⇒ 「响应不是预期信封」）/ 网络故障
    //    ⇒ 一律当「**未知**」，**不是**「未初始化」。
    return null
  }
}

/** 服务端的初始化状态接口。 */
export const initializationApi = {
  /** 取初始化状态（三态，见 `state()`）。 */
  state,
}
