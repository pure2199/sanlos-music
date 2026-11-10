// ---------------------------------------------------------------------------
// T36：应用快捷键（去掉默认菜单栏的代价）
// ---------------------------------------------------------------------------
//
// ⚠️ **钉的是什么**：T36 去掉了 Windows 上的默认菜单栏（File / Edit / View /
//    Window / Help），但 **Electron 的默认菜单同时绑着一批快捷键** → 菜单一去掉，
//    **Ctrl+V 粘贴就没了**（登录框粘不了口令、设置页粘不了 URL 模板）。
//    ⇒ 这里钉住「手工接回来的那套快捷键」的行为。
//
// ⚠️ **特别要钉住「不拦 Ctrl+A」**：Electron 的 `webContents.selectAll()` 是
//    「选中**整个页面**」→ 一旦拦了，输入框里的 Ctrl+A 会变成"选中整页"，
//    **比不处理更糟**。所以本模块只接 C / V（+ T82 起的「吞键」）。
//
// ⚠️ **T82：开发者工具那一路已拆掉**（用户要求「去掉 F12 调出功能」）：
//    F12 / Ctrl+Shift+I 现在走 **`'swallow'`**（拦下默认行为、**零动作**）。
//    ⇒ 下面两条断言的**前提被本任务推翻**，已**改写为新行为断言**：
//      - 「认得 F12 / Ctrl+Shift+I」→ 改成「认得，但只**吞掉**」；
//      - 「接线后 F12 → 调 openDevTools」→ 改成「接线后 F12 → **零动作**」。
//    原鉴别力（「F12 不会被误认成别的动作」）**保留在改写后的断言里**。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import {
  attachAppShortcuts,
  resolveShortcut,
  type BeforeInputEventLike,
  type ShortcutInput,
} from '../electron/appShortcuts'

/** 造一个 `before-input-event` 的输入。 */
function input(overrides: Partial<ShortcutInput> = {}): ShortcutInput {
  return {
    type: 'keyDown',
    key: 'v',
    control: true,
    shift: false,
    alt: false,
    meta: false,
    ...overrides,
  }
}

/** 假目标：记录「拦了几次默认行为 / 调了几次 copy / paste / openDevTools」。 */
function fakeTarget(): {
  target: Parameters<typeof attachAppShortcuts>[0]
  calls: { prevented: number; copied: number; pasted: number; devtools: number }
  fire: (inp: ShortcutInput) => void
} {
  const calls = { prevented: 0, copied: 0, pasted: 0, devtools: 0 }
  let listener: ((event: BeforeInputEventLike, input: ShortcutInput) => void) | null = null
  const target = {
    on(
      _event: 'before-input-event',
      fn: (event: BeforeInputEventLike, inp: ShortcutInput) => void,
    ): void {
      listener = fn
    },
    copy(): void {
      calls.copied += 1
    },
    paste(): void {
      calls.pasted += 1
    },
    openDevTools(): void {
      calls.devtools += 1
    },
  }
  const fire = (inp: ShortcutInput): void => {
    const event: BeforeInputEventLike = {
      preventDefault(): void {
        calls.prevented += 1
      },
    }
    listener?.(event, inp)
  }
  return { target, calls, fire }
}

describe('应用快捷键（T36）', () => {
  it('认得 **Ctrl+C**（复制）与 **Ctrl+V**（粘贴）', () => {
    expect(resolveShortcut(input({ key: 'c' }))).toBe('copy')
    expect(resolveShortcut(input({ key: 'v' }))).toBe('paste')
  })

  it('大写键名也认（带 Shift 的键名是大写）', () => {
    expect(resolveShortcut(input({ key: 'C' }))).toBe('copy')
    expect(resolveShortcut(input({ key: 'V' }))).toBe('paste')
  })

  it('**只认 Ctrl 组合**：光按 V / 光按 C → 不接管', () => {
    expect(resolveShortcut(input({ key: 'v', control: false }))).toBeNull()
    expect(resolveShortcut(input({ key: 'c', control: false }))).toBeNull()
  })

  it('**Shift / Alt / Meta 组合不抢**（Ctrl+Shift+V =「粘贴为纯文本」等）', () => {
    expect(resolveShortcut(input({ key: 'v', shift: true }))).toBeNull()
    expect(resolveShortcut(input({ key: 'v', alt: true }))).toBeNull()
    expect(resolveShortcut(input({ key: 'v', meta: true }))).toBeNull()
  })

  it('**只认 `keyDown`**：`keyUp` / `char` 不处理（否则会粘两次）', () => {
    expect(resolveShortcut(input({ type: 'keyUp' }))).toBeNull()
    expect(resolveShortcut(input({ type: 'char' }))).toBeNull()
  })

  it('别的一律不接管（Ctrl+R / Ctrl+A / Ctrl+Z …）', () => {
    for (const key of ['r', 'a', 'z', 'x', 's', '1']) {
      expect(resolveShortcut(input({ key }))).toBeNull()
    }
  })

  it('**F12** 与 **Ctrl+Shift+I** 被**吞掉**（T82：不再打开开发者工具）', () => {
    // ⚠️ **前提被 T82 推翻**：原来这两个键会调 `openDevTools`
    //    （菜单去掉前是 View 菜单的 accelerator）。
    //    ⇒ 改写为**新行为**断言：仍然**认得**这两个键，但只**吞掉**、什么都不做。
    expect(resolveShortcut(input({ key: 'F12', control: false }))).toBe('swallow')
    expect(resolveShortcut(input({ key: 'I', shift: true }))).toBe('swallow')
  })

  it('接线后：**Ctrl+V → 拦掉默认行为 + 调 paste**（不拦就会粘两次）', () => {
    const { target, calls, fire } = fakeTarget()
    attachAppShortcuts(target)

    fire(input({ key: 'v' }))

    expect(calls.prevented).toBe(1)
    expect(calls.pasted).toBe(1)
    expect(calls.copied).toBe(0)
  })

  it('接线后：**Ctrl+C → 拦掉默认行为 + 调 copy**', () => {
    const { target, calls, fire } = fakeTarget()
    attachAppShortcuts(target)

    fire(input({ key: 'c' }))

    expect(calls.prevented).toBe(1)
    expect(calls.copied).toBe(1)
    expect(calls.pasted).toBe(0)
  })

  it('接线后：**F12 → 拦下默认行为 + 零动作**（T82：按 F12 什么都不会发生）', () => {
    const { target, calls, fire } = fakeTarget()
    attachAppShortcuts(target)

    fire(input({ key: 'F12', control: false }))

    expect(calls.prevented).toBe(1)
    // ⚠️ **关键**：没有调 `openDevTools`（T82 之前的断言是 `toBe(1)`）。
    //    而且复制 / 粘贴也**一个都没动**（不是「调了别的」，是彻底没反应）。
    expect(calls.devtools).toBe(0)
    expect(calls.copied).toBe(0)
    expect(calls.pasted).toBe(0)
  })

  it('接线后：别按键**一律不拦、不动作**（不抢 Ctrl+A / Ctrl+R）', () => {
    const { target, calls, fire } = fakeTarget()
    attachAppShortcuts(target)

    fire(input({ key: 'a' }))
    fire(input({ key: 'r' }))
    fire(input({ key: 'v', shift: true }))

    expect(calls.prevented).toBe(0)
    expect(calls.copied).toBe(0)
    expect(calls.pasted).toBe(0)
  })

  it('接线后：`keyUp` 的 Ctrl+V **不粘**（防「按下 + 松开」粘两次）', () => {
    const { target, calls, fire } = fakeTarget()
    attachAppShortcuts(target)

    fire(input({ key: 'v', type: 'keyUp' }))

    expect(calls.prevented).toBe(0)
    expect(calls.pasted).toBe(0)
  })

  it('目标**没有** copy / paste（单测替身）→ 不抛错，只是没动作', () => {
    let listener: ((event: BeforeInputEventLike, input: ShortcutInput) => void) | null = null
    attachAppShortcuts({
      on(_event, fn) {
        listener = fn
      },
    })

    expect(() =>
      listener?.(
        {
          preventDefault(): void {
            /* 什么都不做 */
          },
        },
        input({ key: 'v' }),
      ),
    ).not.toThrow()
  })
})
