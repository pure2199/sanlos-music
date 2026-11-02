// ---------------------------------------------------------------------------
// Vitest 全局测试准备（Task 10b）
//
// - `@testing-library/jest-dom/vitest`：把 DOM 断言（toBeInTheDocument /
//   toHaveValue / toBeVisible …）挂到 Vitest 的 `expect` 上。
//   ⚠️ **必须用 `/vitest` 入口**：`/extend-expect` 是 Jest 的入口，
//   在 Vitest 里导入会拿不到 `expect` 的扩展。
// - `afterEach(cleanup)`：卸载已渲染的组件，避免 DOM 残留影响后续用例。
// - localStorage 垫片：本机 jsdom（30.x）**没有**提供 `localStorage`，
//   缺了它 zustand 的 persist 会静默失效、「凭证不得落盘」这类断言也变成空断言。
//   这里补一个**内存实现**（仅测试环境，不碰真实浏览器存储）。
// ---------------------------------------------------------------------------

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// --- localStorage 垫片（jsdom 未提供时补一个内存实现） ----------------------
const globalScope = globalThis as unknown as { localStorage?: Storage }
if (typeof globalScope.localStorage === 'undefined') {
  const memory = new Map<string, string>()
  const stub: Storage = {
    get length(): number {
      return memory.size
    },
    clear(): void {
      memory.clear()
    },
    getItem(key: string): string | null {
      return memory.has(key) ? (memory.get(key) as string) : null
    },
    key(index: number): string | null {
      return Array.from(memory.keys())[index] ?? null
    },
    removeItem(key: string): void {
      memory.delete(key)
    },
    setItem(key: string, value: string): void {
      memory.set(key, String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  })
  const win = (globalThis as unknown as { window?: { localStorage?: Storage } }).window
  if (win && (win as unknown) !== globalThis) {
    Object.defineProperty(win, 'localStorage', {
      value: stub,
      configurable: true,
      writable: true,
    })
  }
}

afterEach(() => {
  cleanup()
})
