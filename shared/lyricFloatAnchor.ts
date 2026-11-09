// ---------------------------------------------------------------------------
// 桌面歌词（经典悬浮窗）的**默认落位**（纯函数，T77）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么需要它**：T77 起，经典悬浮窗是**点穿透**的
//    （`setIgnoreMouseEvents(true, { forward: true })`，与词岛同款）——
//    代价是**不能再用鼠标拖动** ⇒ 「第一次打开时落在哪儿」必须给对，
//    否则用户会看到一个飘在屏幕角落、**又挪不动**的歌词窗。
//
// ⚠️ **为什么在 `shared/`**：主进程要拿它算窗口位置，单测要拿它断言几何
//    ⇒ 两边共用一份（与 `shared/islandAnchor.ts` 同一套路）。
//
// ⚠️ **本模块不 import Electron** → 单测不需要 Electron 运行时。
//
// ---------------------------------------------------------------------------
// 落位规则
// ---------------------------------------------------------------------------
//
// - 水平：**居中**于工作区（与词岛同一套观感）；
// - 垂直：**居中偏下**（比例 `LYRIC_FLOAT_VERTICAL_RATIO` = 0.62）
//   —— 贴着顶栏太挤、贴着任务栏又会被任务栏压住。
//
// ⚠️ 用 `workArea`（去掉任务栏的工作区）而不是 `bounds`（整块屏幕）：
//    副屏的任务栏在**左侧**时两者不同 → 用 `bounds` 会把歌词算偏。

/** 显示器（只要用得到的那个字段；不依赖 Electron 的 `Display` 类型）。 */
export interface LyricFloatDisplayLike {
  workArea: { x: number; y: number; width: number; height: number }
}

/** 窗口尺寸。 */
export interface LyricFloatSize {
  width: number
  height: number
}

/** 算出来的窗口位置与尺寸。 */
export interface LyricFloatBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 垂直位置的比例（0.62 ⇒ 居中偏下）。
 *
 * ⚠️ 这是**工作区可用高度**里的比例：0.5 = 正好居中，0.62 = 往下偏一点。
 */
export const LYRIC_FLOAT_VERTICAL_RATIO = 0.62

/**
 * 算出桌面歌词窗该待在哪儿。
 *
 * ⚠️ 工作区比窗口还窄 / 矮时**贴边**（`Math.max(0, …)`）——
 *    不能算出负数，否则窗口会跑到屏幕外。
 * ⚠️ 返回的坐标是**整数**：Electron 的 `setBounds` / `BrowserWindow` 只收整数。
 *
 * @param display 目标显示器（取它的 `workArea`）。
 * @param size    窗口尺寸。
 * @returns 窗口位置与尺寸。
 */
export function lyricFloatBounds(
  display: LyricFloatDisplayLike,
  size: LyricFloatSize,
): LyricFloatBounds {
  const area = display.workArea
  const x = Math.round(area.x + Math.max(0, (area.width - size.width) / 2))
  const y = Math.round(
    area.y + Math.max(0, (area.height - size.height) * LYRIC_FLOAT_VERTICAL_RATIO),
  )
  return { x, y, width: size.width, height: size.height }
}
