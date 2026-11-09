// ---------------------------------------------------------------------------
// 应用图标资源（**纯模块**：不 import electron ⇒ 可直接单测）
// ---------------------------------------------------------------------------
//
// 为什么单独一个模块：`electron/tray.ts` 有一条纪律 —— **不 import electron**
// （Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串），
// 所以 Electron 相关对象一律**惰性解析**。本模块延续同一条纪律：
// 它只做**纯路径计算**（+ 可注入的存在性判断）⇒ 单测不碰文件系统也行。
//
// 图标从哪来（按优先级，第一个存在的胜出）：
// 1. `<主进程模块目录>/icon.png`
//    —— `scripts/build-electron.cjs` 会把 `build/icon.png` 复制进
//    `dist-electron/`，而 `electron-builder.yml` 的 `files` 含
//    `dist-electron/**/*` ⇒ 打包后位于 `app.asar/dist-electron/icon.png`；
// 2. `<appRoot>/build/icon.png`
//    —— 开发态 `app.getAppPath()` = 仓库根 ⇒ 命中仓库里那份**源**文件。
//
// ⚠️ 找不到 ⇒ 返回 `null` ⇒ 调用方按「**没有图标**」处理（不报错、不崩）。
// ---------------------------------------------------------------------------

import { statSync } from 'node:fs'
import path from 'node:path'

/** 图标文件名（构建时复制进 `dist-electron/` ⇒ 随包进 asar）。 */
export const APP_ICON_FILE = 'icon.png'

/** 解析图标需要的两个位置。 */
export interface AppIconLookup {
  /** 主进程模块所在目录（打包后 = `app.asar/dist-electron`）。 */
  moduleDir: string
  /** 应用根目录（`app.getAppPath()`；开发态 = 仓库根）。 */
  appRoot: string
}

/**
 * 图标候选路径（**按优先级排列**）。
 *
 * ⚠️ 单测可直接断言这个顺序（顺序变了 = 打包后找不到图标）。
 */
export function appIconCandidates(lookup: AppIconLookup): string[] {
  return [
    path.join(lookup.moduleDir, APP_ICON_FILE),
    path.join(lookup.appRoot, 'build', APP_ICON_FILE),
  ]
}

/**
 * 解析应用图标的绝对路径。
 *
 * @param lookup 两个位置（见 {@link AppIconLookup}）。
 * @param exists 存在性判断（**可注入** ⇒ 单测不必真的建文件）。
 * @returns 第一个存在的候选路径；都不存在 ⇒ `null`。
 */
export function resolveAppIconPath(
  lookup: AppIconLookup,
  exists: (candidate: string) => boolean = fileExists,
): string | null {
  for (const candidate of appIconCandidates(lookup)) {
    if (exists(candidate)) return candidate
  }
  return null
}

/** 默认的存在性判断（是**文件**才算）。 */
function fileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}
