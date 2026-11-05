// T46：灵动态词岛的根组件 —— 「指针进入 → 淡出 / 离开 → 淡回」。
//
// ⚠️ **为什么这条链路必须能测**：词岛是**点击穿透**的（`setIgnoreMouseEvents`）
//    → 忽略鼠标事件后渲染进程**收不到「鼠标离开」**（实测：移出后 0 个事件）
//    → 「移出后恢复显示」完全靠**主进程轮询**指针位置、经 `onLyricPointer`
//    通知到这里。⇒ 这条链路一旦断了，词岛就**永远淡出不再回来**。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IslandApp } from '../src/island/IslandApp'
import type { PlayerBridge } from '../shared/playerBridge'

/** 仓库根目录（源码断言用）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 假桥：只实现词岛用到的两个订阅方法。 */
interface FakeBridge {
  bridge: PlayerBridge
  emitPointer: (inside: boolean) => void
}

function fakeBridge(): FakeBridge {
  let pointerHandler: ((inside: boolean) => void) | null = null
  const bridge = {
    onLyricState: () => () => undefined,
    onLyricPointer: (handler: (inside: boolean) => void) => {
      pointerHandler = handler
      return () => {
        pointerHandler = null
      }
    },
  } as unknown as PlayerBridge
  return {
    bridge,
    emitPointer: (inside: boolean) => {
      pointerHandler?.(inside)
    },
  }
}

afterEach(() => {
  delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  vi.restoreAllMocks()
})

describe('T46 词岛：鼠标进入隐藏', () => {
  it('指针进入 → 根元素进入「淡出」态', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    render(<IslandApp />)
    const root = screen.getByTestId('fnm-island')
    expect(root.className).not.toMatch(/fnm-island--pointer-inside/)

    act(() => {
      fake.emitPointer(true)
    })

    expect(root.className).toMatch(/fnm-island--pointer-inside/)
    expect(root.getAttribute('data-pointer-inside')).toBe('true')
  })

  it('指针离开 → 恢复显示', () => {
    const fake = fakeBridge()
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    render(<IslandApp />)
    const root = screen.getByTestId('fnm-island')

    act(() => {
      fake.emitPointer(true)
    })
    expect(root.className).toMatch(/fnm-island--pointer-inside/)

    act(() => {
      fake.emitPointer(false)
    })
    expect(root.className).not.toMatch(/fnm-island--pointer-inside/)
    expect(root.getAttribute('data-pointer-inside')).toBe('false')
  })

  it('没有桥（浏览器预览 / 单测）→ 不崩，也不进入淡出态', () => {
    render(<IslandApp />)
    const root = screen.getByTestId('fnm-island')
    expect(root.getAttribute('data-pointer-inside')).toBe('false')
  })

  it('主进程必须给词岛开「点击穿透」（否则它挡住屏幕顶部的应用）', () => {
    // ⚠️ 源码断言（护栏）：这行配置一旦被静默删掉，词岛就会**吃掉**鼠标事件
    //    → 最大化应用的标题栏中央点不到 → 而这种回归**没有任何运行时症状**
    //    能暴露（窗口照常显示、歌词照常滚）。
    const source = readFileSync(resolve(REPO_ROOT, 'electron/main.ts'), 'utf8')
    expect(source).toMatch(/setIgnoreMouseEvents\(true, \{ forward: true \}\)/)
  })

  it('主进程必须轮询指针位置并通知词岛（否则移出后**永远淡出**不回来）', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'electron/main.ts'), 'utf8')
    expect(source).toMatch(/getCursorScreenPoint\(\)/)
    expect(source).toMatch(/send\('lyric:pointer', inside\)/)
  })
})
