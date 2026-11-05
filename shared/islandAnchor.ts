// ---------------------------------------------------------------------------
// T45：灵动态词岛的**锚定计算**（纯函数，渲染层与主进程共用）
// ---------------------------------------------------------------------------
//
// 词岛的位置**不能**由用户拖动（它就该待在屏幕顶部），而是要按
// 「主窗口所在显示器的 workArea」算出来 —— 所以这段逻辑必须**可单测**：
// 算错了只有真机上才看得出来（而且很难复现）。
//
// ⚠️ **为什么在 `shared/`**：主进程要拿它算窗口位置（`electron/main.ts`），
//    单测要拿它断言几何 → 两边共用一份 → 放 `shared/`（**不许**让
//    `electron/` 反向依赖 `src/`，层次会反）。
//
// ⚠️ **为什么用 `workArea` 而不是 `bounds`**：
//    `bounds` 是整块屏幕（含任务栏），`workArea` 是**去掉任务栏**的工作区。
//    副屏的任务栏在**左侧**时两者不同 → 用 `bounds` 会把词岛算偏。
//
// ⚠️ **本模块不 import Electron** → 单测不需要 Electron 运行时。
// ---------------------------------------------------------------------------

/** 显示器（只要用得到的那几个字段；不依赖 Electron 的 `Display` 类型）。 */
export interface IslandDisplayLike {
  workArea: { x: number; y: number; width: number; height: number }
}

/** 词岛窗口的尺寸。 */
export interface IslandSize {
  width: number
  height: number
}

/** 算出来的窗口位置与尺寸。 */
export interface IslandBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 词岛默认的宽度（像素）。 */
export const ISLAND_WINDOW_WIDTH = 520
/**
 * 词岛默认的高度（像素）。
 *
 * ⚠️ 96 = 上下留白 10×2 + 双行歌词（34 + 44）+ 一点余量。
 */
export const ISLAND_WINDOW_HEIGHT = 96
/** 词岛与工作区上沿的间距（像素）。 */
export const ISLAND_TOP_MARGIN = 8

/**
 * 算出词岛窗口该待在哪儿。
 *
 * - 水平：**居中**于工作区；
 * - 垂直：贴着工作区**上沿**（往下 `margin` 像素）。
 *
 * ⚠️ 工作区比窗口还窄时，水平方向**贴左边**（`Math.max(0, …)`）
 *    —— 不能算出负数，否则窗口会跑到屏幕外。
 * ⚠️ 返回的坐标是**整数**：Electron 的 `setBounds` 只收整数。
 */
export function islandBounds(
  display: IslandDisplayLike,
  size: IslandSize,
  margin: number = ISLAND_TOP_MARGIN,
): IslandBounds {
  const area = display.workArea
  const x = Math.round(area.x + Math.max(0, (area.width - size.width) / 2))
  const y = Math.round(area.y + margin)
  return { x, y, width: size.width, height: size.height }
}
