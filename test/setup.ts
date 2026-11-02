// ---------------------------------------------------------------------------
// Vitest 全局测试准备（Task 10b）
//
// - `@testing-library/jest-dom/vitest`：把 DOM 断言（toBeInTheDocument /
//   toHaveValue / toBeVisible …）挂到 Vitest 的 `expect` 上。
//   ⚠️ **必须用 `/vitest` 入口**：`/extend-expect` 是 Jest 的入口，
//   在 Vitest 里导入会拿不到 `expect` 的扩展。
// - `afterEach(cleanup)`：卸载已渲染的组件，避免 DOM 残留影响后续用例。
// - localStorage 垫片（见下面的长注释）——**必须与 jsdom 的 Storage 行为对齐**，
//   否则「凭证不落盘」这类断言会变成**空洞断言**（复审轮已踩过一次）。
// ---------------------------------------------------------------------------

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// --- localStorage 垫片 --------------------------------------------------------
//
// ⚠️ 为什么需要垫片（**不是**「jsdom 没有 localStorage」——那是旧报告里的错述）：
//    - jsdom 30.1.3 **本身提供可用的 `window.localStorage`**
//      （实测：`Object.keys(localStorage)` 列出已存的键，`JSON.stringify(localStorage)`
//      能看到值）；
//    - 但本机 **Node 26.13.0 在 `globalThis` 上自带一个 `localStorage` 访问器**
//      （未加 `--localstorage-file` 时返回 `undefined`，并抛 ExperimentalWarning）；
//    - vitest 的 `populateGlobal` / `getWindowKeys`
//      （`node_modules/vitest/dist/chunks/index.K90BXFOx.js:249-263`，jsdom 环境在
//      `:537` 调用它）只搬运**白名单**里的键：白名单不含 `localStorage`，
//      而该键又「已存在于 global」→ **jsdom 的 Storage 装不上**。
//    - 结果：测试环境里没有可用的 localStorage，zustand 的 persist 会静默失效，
//      「凭证不得落盘」这类断言会变成空断言。
//
// ⚠️ 垫片必须**与 jsdom 的 Storage 行为对齐**（复审轮踩过的坑）：
//    普通对象字面量的 `JSON.stringify(localStorage)` 只得到 `{"length":N}`——
//    **不含任何存储的值**，于是 `expect(dump).not.toContain(secret)` 永远不可能失败。
//    jsdom 的 Storage 是「命名属性」实现：`Object.keys(localStorage)` 列出**已存的键**，
//    `JSON.stringify(localStorage)` 能看到**值**。下面用 Proxy 复刻这一行为。
// ---------------------------------------------------------------------------

const globalScope = globalThis as unknown as { localStorage?: Storage }
if (typeof globalScope.localStorage === 'undefined') {
  const memory = new Map<string, string>()

  /** 方法挂在原型上（与 jsdom 一致：own keys 只包含**存进去的键**）。 */
  class MemoryStorage {
    get length(): number {
      return memory.size
    }
    clear(): void {
      memory.clear()
    }
    getItem(key: string): string | null {
      return memory.has(key) ? (memory.get(key) as string) : null
    }
    key(index: number): string | null {
      return Array.from(memory.keys())[index] ?? null
    }
    removeItem(key: string): void {
      memory.delete(key)
    }
    setItem(key: string, value: string): void {
      memory.set(key, String(value))
    }
  }

  const storage = new Proxy(new MemoryStorage(), {
    // 已存的键作为**可枚举的命名属性**暴露 —— 与 jsdom Storage 一致。
    ownKeys: () => [...memory.keys()],
    getOwnPropertyDescriptor: (target, prop) => {
      if (typeof prop === 'string' && memory.has(prop)) {
        return {
          value: memory.get(prop),
          enumerable: true,
          configurable: true,
          writable: true,
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
    get: (target, prop, receiver) => {
      if (typeof prop === 'string' && memory.has(prop)) return memory.get(prop)
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (typeof prop === 'string' && !(prop in target)) {
        memory.set(prop, String(value))
        return true
      }
      return Reflect.set(target, prop, value, receiver)
    },
  })

  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  const win = (globalThis as unknown as { window?: { localStorage?: Storage } }).window
  if (win && (win as unknown) !== globalThis) {
    Object.defineProperty(win, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    })
  }
}

afterEach(() => {
  cleanup()
})
