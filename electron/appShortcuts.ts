// ---------------------------------------------------------------------------
// 应用快捷键（去掉默认菜单栏的代价）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么需要这个模块**：T36 把 Windows 上的默认菜单栏去掉了
//    （`Menu.setApplicationMenu(null)`）——但 **Electron 的默认菜单同时绑着
//    一批快捷键**：编辑（Ctrl+C / Ctrl+V）与**开发者工具**（Ctrl+Shift+I / F12）。
//    菜单一去掉，它们**全部消失** →
//    - 登录框、搜索框、设置页的「自定义歌词 API 模板」全都**粘不了**；
//    - 调试时**打不开开发者工具**。
//    ⇒ 这里把常用的几个**手工接回来**。
//
// ⚠️ **只接 C / V / 开发者工具，不接 X / A / Z**：
//    - Ctrl+X（剪切）、Ctrl+A（全选）、Ctrl+Z（撤销）是 **Blink 自己的编辑命令**
//      → 不依赖菜单 accelerator → 不拦，交给渲染进程；
//    - ⚠️ **尤其不能拦 Ctrl+A**：Electron 的 `webContents.selectAll()` 是
//      「选中**整个页面**」→ 拦了会让输入框里的 Ctrl+A 变成"选中整页"，
//      **比不处理更糟**。
//
// ⚠️ **本模块不 import electron**（与 `electron/tray.ts` 同一条纪律）→ 可直接单测，
//    也便于在 Vitest / 普通 Node 里跑。
// ---------------------------------------------------------------------------

/** `before-input-event` 传进来的输入形状（最小子集）。 */
export interface ShortcutInput {
  /** 输入类型（`keyDown` / `keyUp` / `char`）。 */
  type: string
  /** 按下的键（如 `c` / `v` / `F12`；带 Shift 时字母是大写）。 */
  key: string
  /** Ctrl 是否按下。 */
  control: boolean
  /** Shift 是否按下。 */
  shift: boolean
  /** Alt 是否按下。 */
  alt: boolean
  /** Meta（Win / Command）是否按下。 */
  meta: boolean
}

/** 能被接管的快捷键动作。 */
export type ShortcutAction = 'copy' | 'paste' | 'devtools'

/** `before-input-event` 的事件形状（最小子集）。 */
export interface BeforeInputEventLike {
  /** 阻止默认处理（那一套菜单 accelerator）。 */
  preventDefault(): void
}

/** 接线目标（`webContents` 的最小子集）。 */
export interface ShortcutTarget {
  /** 订阅 `before-input-event`。 */
  on(
    event: 'before-input-event',
    listener: (event: BeforeInputEventLike, input: ShortcutInput) => void,
  ): void
  /**
   * 复制当前选区。
   *
   * ⚠️ **可选**：有些 `webContents` 替身（单测里的假对象）没有这些方法 →
   *    缺了就**不接管**该动作，而不是抛错。
   */
  copy?(): void
  /**
   * 把剪贴板内容粘到聚焦元素。
   *
   * ⚠️ **可选**：同上。
   */
  paste?(): void
  /**
   * 打开开发者工具（菜单去掉前，这是 View 菜单里的 accelerator）。
   *
   * ⚠️ **可选**：同上。
   */
  openDevTools?(): void
}

/**
 * 识别要接管的快捷键；不认得就返回 `null`。
 *
 * @param input `before-input-event` 给的输入。
 * @returns 要执行的动作，或 `null`（不拦、交给默认行为）。
 */
export function resolveShortcut(input: ShortcutInput): ShortcutAction | null {
  // ⚠️ **只认 `keyDown`**：`keyUp` / `char` 也触发 → 处理两遍 = **粘贴两次**。
  if (input.type !== 'keyDown') return null

  // --- 开发者工具：F12 或 Ctrl+Shift+I -----------------------------------
  //
  // ⚠️ 这两个**原本就是默认菜单的 accelerator**（View → Toggle Developer Tools）
  //    → 去掉菜单就得自己接回来，否则调试时连控制台都打不开。
  if (!input.alt && !input.meta) {
    if (input.key === 'F12' && !input.control && !input.shift) return 'devtools'
    if (input.control && input.shift && input.key.toLowerCase() === 'i') return 'devtools'
  }

  // --- 复制 / 粘贴 --------------------------------------------------------
  //
  // ⚠️ **必须带 Ctrl**；Alt / Meta（macOS 的 Cmd）不抢 → 交给默认行为。
  if (!input.control || input.alt || input.meta) return null
  // ⚠️ **Shift 组合不抢**（Ctrl+Shift+V =「粘贴为纯文本」）。
  if (input.shift) return null
  const key = input.key.toLowerCase()
  if (key === 'c') return 'copy'
  if (key === 'v') return 'paste'
  return null
}

/**
 * 把「复制 / 粘贴 / 开发者工具」快捷键接到某个 `webContents` 上。
 *
 * ⚠️ **必须在去掉应用菜单之后调用**：菜单还在时两者会**同时生效** → 粘贴两次。
 *
 * @param target 目标（`webContents`）。
 */
export function attachAppShortcuts(target: ShortcutTarget): void {
  target.on('before-input-event', (event, input) => {
    const action = resolveShortcut(input)
    if (!action) return
    // ⚠️ **必须 `preventDefault()`**：不拦的话 Blink 还会再处理一遍 → 粘两次。
    event.preventDefault()
    if (action === 'copy') target.copy?.()
    else if (action === 'paste') target.paste?.()
    else target.openDevTools?.()
  })
}

/**
 * 把「宽松」的 `webContents` 适配成本模块要的精确签名。
 *
 * ⚠️ **为什么需要**：有些模块的 `webContents` 接缝写的是
 *    `on(channel: string, listener: (...args: unknown[]) => void)`
 *    （事件名与参数都是宽松的）→ 与本模块的精确签名**对不上**。
 *    ⇒ 在**这一处**收窄，不去改别人的接口、也不在调用点撒类型断言。
 *
 * @param loose 宽松形状的 `webContents`。
 * @returns 可直接传给 `attachAppShortcuts()` 的目标。
 */
export function adaptLooseWebContents(loose: {
  on(channel: string, listener: (...args: unknown[]) => void): void
  copy?(): void
  paste?(): void
  openDevTools?(): void
}): ShortcutTarget {
  return {
    on: (_event, listener) => {
      loose.on('before-input-event', (...args: unknown[]) => {
        const [event, input] = args as [BeforeInputEventLike, ShortcutInput]
        listener(event, input)
      })
    },
    copy: () => loose.copy?.(),
    paste: () => loose.paste?.(),
    openDevTools: () => loose.openDevTools?.(),
  }
}
