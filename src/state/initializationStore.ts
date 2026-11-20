// ---------------------------------------------------------------------------
// 服务端「初始化状态」的状态（T128）
// ---------------------------------------------------------------------------
//
// ⚠ **为什么是独立 store**（不塞进 `sessionStore`）：
//    既有断言 `Object.keys(session).sort()` 是**精确数组**
//    （`test/login-page.test.tsx`）⇒ 往会话里加字段就**红** ⇒ 状态放独立 store。
//
// ⚠ **三态**：`true`（已初始化）／`false`（**未初始化**）／`null`（**未知**）。
//    ⚠ **「未知」绝不当成「未初始化」** ⇒ 老服务端上界面一个字都不显示。
//
// ⚠ **什么时候拉**：登录成功后（或会话恢复后）拉**一次** ⇒ 由 `src/App.tsx` 监听
//    `connected` 触发 ⇒ **覆盖「手动登录」＋「会话恢复」两条路**。
//    ⇒ 本 store **只缓存结果**，不轮询、不重复打 NAS。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import { initializationApi } from '../api/initialization'

/** 本 store 依赖的接口（`deps` 供测试注入）。 */
export interface InitializationDeps {
  /** 取服务端的初始化状态（三态）。 */
  state: () => Promise<boolean | null>
}

/** 生产用的依赖（走真实的 `initializationApi`）。 */
export const defaultInitializationDeps: InitializationDeps = {
  state: () => initializationApi.state(),
}

/** 「初始化状态」store 的形状。 */
export interface InitializationStore {
  /**
   * 服务端有没有完成首次初始化。
   *
   * ⚠ **三态**：`true`＝已初始化；`false`＝**未初始化**；**`null`＝未知**
   *    （老服务端没这端点 / 字段缺失 / 请求失败）⇒ 界面**不提示**。
   */
  initialized: boolean | null
  /** 是否至少查过一次（`false` ＝ 还没查 ⇒ 界面**不提示**）。 */
  loaded: boolean
  /** 最后一次错误（**只作诊断**，不弹给用户 ⇒ 未知即可）。 */
  error: string | null
  /** 查一次（`deps` 供测试注入）。 */
  load: (deps?: InitializationDeps) => Promise<void>
}

/** 把异常变成可读的文案。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '初始化状态查询失败'
}

/** 「初始化状态」store（生产用）。 */
export const useInitializationStore = create<InitializationStore>()((set) => ({
  // ⚠ **默认是「未知」** ⇒ 首屏（还没查）界面一个字都不显示。
  initialized: null,
  loaded: false,
  error: null,

  load: async (deps?: InitializationDeps): Promise<void> => {
    const resolved = deps ?? defaultInitializationDeps
    set({ loaded: false, error: null })
    try {
      const initialized = await resolved.state()
      set({ initialized, loaded: true, error: null })
    } catch (err) {
      // ⚠ 兜底：`initializationApi.state()` 本身已经把异常吞成 `null` 了
      //    ⇒ 走到这里说明是**依赖实现**抛的 ⇒ 仍然当「未知」，**不是**「未初始化」。
      set({ initialized: null, loaded: true, error: describeError(err) })
    }
  },
}))
