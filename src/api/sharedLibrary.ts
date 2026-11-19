// ---------------------------------------------------------------------------
// 共享库（T122）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这个文件**
// ---------------------------------------------------------------------------
// 2026-11-20 真机实测（FN 中继，**只打 GET**，不碰任何写操作）：
//
// - `GET /shared-library/list`
//   ⇒ `code=0`，`data.list[]` 每项：
//      `{ guid, name, path, autoDownloadLyric, metadataPreference,
//         contentLastChangedAt, accessStatus }`
//      本机实测 **2** 项；⚠️ `name` **是空串** ⇒ 展示名要靠 `path` 末段兜底。
// - `GET /shared-library/detail?guid=<guid>`
//   ⇒ `code=0`，返回**同一个对象**（**没有额外字段**）
//   ⇒ **不接**：拿不到任何新信息，多一个端点就多一个会坏的面。
// - `create` / `edit` / `delete` / `scan` / `scan-all` / `reconnect` / `reconnect-check`
//   ⇒ **写操作** ⇒ **一律不接**：客户端是**播放端**，不是 NAS 管理端。
//   （真机实测：这些路径用 GET 打过去 **body 是 `null`**。）
//
// ⚠️ **实测到的关键事实**：本机这 2 个共享库的 `path`
//    **正好就是** `/app-center/authed-dir/list` 那 2 个授权目录
//    ⇒ **共享库 = 同一个曲库的「共享视角」**，**不是**另一份曲库
//    ⇒ 浏览共享库**不需要**新的取数路径，复用 T120 的目录浏览即可。
//
// ⚠️ **2026-11-20 扒飞牛音乐 Web 前端包（46 个 chunk）后的补充结论**
// ---------------------------------------------------------------------------
// 1. **方法只有 2 个 GET、其余 8 个 POST**：`list` / `detail` 是 GET；
//    `create` / `edit` / `delete` / `scan` / `scan-all` / `reconnect` /
//    `reconnect/check` **全是 POST** ⇒ 本文件**只用 GET**（只读）。
//    ⚠️ 真实路径是 `/shared-library/reconnect/check`
//    （**不是** `/reconnect-check` —— T119 那张端点表在这里写错了）；
// 2. **`accessStatus`**：前端只判 `!==0` ⇒ **0 = 正常，非 0 = 访问异常**
//    （前端渲染「访问异常，前往处理 >>」按钮）。
//    ⚠️ **库级**的具体数值含义**前端包里没有枚举** ⇒ 客户端也**不解释**
//    （曲目级另有 1/3=文件不存在、2/4=权限不足，那是**另一个字段**，不能套用）；
// 3. **`metadataPreference`** 枚举共 3 值：`local_preferred` / `cloud_preferred`
//    / `local_only`（前端 UI 只提供后两个）；
// 4. **`name` 为空时的兜底顺序**（前端 `qj`）：`name` → **语义路径末段**
//    → **物理路径末段** → `guid`；前端**不额外调接口补名**；
// 5. ⭐ **「共享库的曲目从哪来」——前端包里根本不存在「按共享库取曲目」的接口**
//    ⇒ 共享库对象只提供「**目录 + 扫描策略 + 访问状态**」，**不提供曲目清单**；
//    曲目要么从全局 `/track/list` 取，要么对那个物理路径用 `/folder-view/list`
//    做目录浏览 ⇒ **本客户端选后者**（只读、当场见效、不扫全库）。
// --------------------------------------------------------------------------

import type { SharedLibrary } from '../../shared/types'
import { apiCall, unixSeconds } from './client'
import { listFolder, type RawFolderNode } from './folder'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 服务端返回的**原始**共享库形状（真机实测，2026-11-20）。 */
export interface RawSharedLibrary {
  guid?: string
  name?: string
  path?: string
  autoDownloadLyric?: boolean
  metadataPreference?: string
  contentLastChangedAt?: number | string | null
  accessStatus?: number
}

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------

/** 取路径末段（目录名）。 */
function lastSegment(path: string): string {
  const segs = path.split('/').filter(Boolean)
  return segs.length > 0 ? (segs[segs.length - 1] as string) : ''
}

/**
 * 展示名：`name` 非空就用它；**为空则依次兜底**。
 *
 * ⚠️ 实测 `name` **是空串** ⇒ 不兜底的话界面上一片空白。
 * ⚠️ **兜底顺序照飞牛音乐 Web 前端**（2026-11-20 扒前端包实测）：
 *    `name` → **路径末段** → `guid` ⇒ 客户端与服务端的显示口径一致。
 */
function displayNameOf(name: string, path: string, id: string): string {
  if (name.length > 0) return name
  const segment = lastSegment(path)
  if (segment.length > 0) return segment
  return id.length > 0 ? id : '共享库'
}

/**
 * 原始共享库 → 领域模型。
 *
 * ⚠️ `guid` 与 `path` **都为空** ⇒ 这一项没有意义 ⇒ 返回 `null`（调用方过滤掉）。
 */
export function mapSharedLibrary(raw: RawSharedLibrary): SharedLibrary | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.guid === 'string' ? raw.guid : ''
  const path = typeof raw.path === 'string' ? raw.path : ''
  if (id.length === 0 && path.length === 0) return null
  const name = typeof raw.name === 'string' ? raw.name : ''
  const accessStatus =
    typeof raw.accessStatus === 'number' && Number.isFinite(raw.accessStatus) ? raw.accessStatus : 0
  return {
    id,
    name,
    path,
    displayName: displayNameOf(name, path, id),
    autoDownloadLyric: raw.autoDownloadLyric === true,
    metadataPreference: typeof raw.metadataPreference === 'string' ? raw.metadataPreference : '',
    contentLastChangedAt: unixSeconds(raw.contentLastChangedAt),
    accessStatus,
  }
}

// ---------------------------------------------------------------------------
// 端点调用
// ---------------------------------------------------------------------------

/**
 * 列共享库。
 *
 * ⚠️ **老服务端没有这个端点** ⇒ 响应 body 是 `null` ⇒ `apiCall` 抛
 *    「响应不是预期信封」⇒ 调用方据此显示「服务端不支持共享库」。
 *    ⇒ **不回落**：共享库没接上**不代表**曲库少了什么（曲库照旧能播）。
 */
export async function listSharedLibraries(): Promise<SharedLibrary[]> {
  const data = await apiCall<{ list?: RawSharedLibrary[] }>('/shared-library/list')
  const list = Array.isArray(data?.list) ? data.list : []
  const mapped = list.map(mapSharedLibrary)
  return mapped.filter((item): item is SharedLibrary => item !== null)
}

/**
 * 端点**不存在**（老服务端）时 `apiCall` 抛的那个错。
 *
 * ⚠️ 判据：响应 body 是 `null`（HTTP 200）⇒ `JSON.parse` 得到 `null`
 *    ⇒ 不是信封 ⇒ `apiCall` 抛「响应不是预期信封」。
 *    ⚠️ 这条判据**不区分**「端点不存在」与「服务端返回了非信封的 JSON」
 *    —— 两者对客户端来说**后果相同**（这个共享库能力用不了）⇒ 一并当成「不支持」。
 */
export function isUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.message === '响应不是预期信封'
}

/** 共享库页要用的接口（测试可注入假实现）。 */
export interface SharedLibraryApi {
  /** 列共享库。 */
  list(): Promise<SharedLibrary[]>
  /** 浏览某个目录（**复用 T120 的目录浏览**）。 */
  browse(path: string): Promise<RawFolderNode>
}

/** 真实实现（页面默认用它）。 */
export const sharedLibraryApi: SharedLibraryApi = {
  list: listSharedLibraries,
  browse: (path: string) => listFolder(path),
}
