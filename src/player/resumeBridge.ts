// ---------------------------------------------------------------------------
// T89-⑲：「上次播放」记录的 **localStorage 实现**（生产用端口）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么用 `localStorage` 而不是主进程**：
// - 它是**运行状态**，不是偏好 ⇒ 不该进 `prefs.json`（见 `resume.ts` 的顶部说明）；
// - 它也**不是凭证** ⇒ 不该进 `session.bin`（那是 DPAPI 加密的凭证文件）；
// - 放主进程内存 ⇒ 主进程重启就没了，等于没实现。
// - ⇒ `localStorage` 与 `fnmusic-local-history`（「本机播放记录」）**同族同源**。
//
// ⚠️ **写不进去怎么办**：隐私模式 / 配额满 / 没有 `localStorage`
//   ⇒ **静默降级**为「只在本次运行内有效」，**不崩、不静默假装成功**。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。
// ---------------------------------------------------------------------------

import { normalizeResumeRecord, type ResumePort, type ResumeRecord } from './resume'

/** `localStorage` 的键（与 `fnmusic-local-history` 同族命名）。 */
export const RESUME_STORAGE_KEY = 'fnmusic-resume'

/**
 * 最小化的存储接口（**便于单测注入**）。
 *
 * ⚠️ 只取用到的三个方法 ⇒ 单测可以塞一个纯对象，不用真的 `localStorage`。
 */
export interface ResumeStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 取默认存储；**取不到就返回 `null`**（不抛）。
 *
 * ⚠️ 访问 `globalThis.localStorage` 本身**可能抛**（隐私模式 / 被禁用）⇒ 必须包 try。
 */
function defaultStorage(): ResumeStorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * 造一个端口。
 *
 * @param storage 存储实现；给 `null` ⇒ **no-op 端口**（读回 `null`、写与清都不做）。
 */
export function createResumePort(storage: ResumeStorageLike | null): ResumePort {
  return {
    load: async (): Promise<ResumeRecord | null> => {
      if (!storage) return null
      try {
        const raw = storage.getItem(RESUME_STORAGE_KEY)
        if (!raw) return null
        // ⚠️ 损坏的 JSON / 陌生形状 ⇒ **整条丢弃**（不抛、不返回半截数据）。
        return normalizeResumeRecord(JSON.parse(raw))
      } catch {
        return null
      }
    },

    save: async (record: ResumeRecord): Promise<void> => {
      if (!storage) return
      try {
        storage.setItem(RESUME_STORAGE_KEY, JSON.stringify(record))
      } catch {
        // ⚠️ 写不进去（配额满 / 隐私模式）⇒ 静默降级，**不影响播放**。
      }
    },

    clear: async (): Promise<void> => {
      if (!storage) return
      try {
        storage.removeItem(RESUME_STORAGE_KEY)
      } catch {
        // ⚠️ 清不掉 ⇒ 静默降级（下次启动可能还会恢复一次；不崩）。
      }
    },
  }
}

/**
 * 生产用的端口。
 *
 * ⚠️ **端口必须在模块加载时造出来**（与 `playModePrefsBridge.ts` 同一纪律）：
 *   `createPlayerStore` 在创建时就会用它。
 */
export const resumePort: ResumePort = createResumePort(defaultStorage())
