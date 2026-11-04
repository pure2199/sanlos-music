// ---------------------------------------------------------------------------
// 播放模式的持久化端口（T29）
// ---------------------------------------------------------------------------
//
// 干什么
// ---------------------------------------------------------------------------
// T24 把「播放模式」接到了播放条上，但那个状态**只活在内存里**：
// 切歌不丢，**重启应用就回到「顺序播放」**。
//
// 本模块把播放模式接进偏好的**单一真相源**（主进程的 `prefs.json`），
// 范式与 EQ 的持久化**完全一致**（`src/player/eq.ts` + `eqPrefsBridge.ts`）：
// 端口是**可注入**的 → 单元测试能塞假实现，生产用真实现。
//
// ---------------------------------------------------------------------------
// 为什么端口要「可注入」
// ---------------------------------------------------------------------------
// ⚠️ `playerStore` **不自己造 IPC 通道**（那是主进程的职责）：
//    渲染层只通过注入的端口读写偏好 → 单测里换掉端口即可，
//    不必去 mock `window.fnPlayer`（jsdom 里根本没有它）。
//
// ⚠️ **没有桥就降级**：浏览器里直接打开渲染层、或单元测试里，
//    `load()` 返回 `null`、`save()` 静默 no-op ——
//    播放模式在**本次运行内**照常可用，只是不落盘（**不崩、不静默写盘**）。
//
// ---------------------------------------------------------------------------
// 外部数据一律当不可信输入
// ---------------------------------------------------------------------------
// `prefs.json` 是**用户可编辑的文件** → 里面写的 `playMode` 可能是任意字符串。
// ⇒ `normalizePlayMode()` 只认四个合法值，其余（含 `undefined`）→ `'sequence'`。
//
// ---------------------------------------------------------------------------

import type { PlayMode } from '../../shared/types'

export type { PlayMode } from '../../shared/types'

/** 四种合法播放模式（**顺序固定**：与 `playMode.ts` 的按钮循环顺序一致）。 */
export const PLAY_MODES: readonly PlayMode[] = ['sequence', 'shuffle', 'loop-one', 'loop-list']

/**
 * 把任意输入压成**合法的播放模式**。
 *
 * ⚠️ `prefs.json` 是**用户可编辑的文件** → 外部数据一律当不可信输入处理：
 *    只认四个已知值，其余（陌生字符串 / `undefined` / 非字符串）→ `'sequence'`。
 *
 * @param value 任意输入。
 * @returns 合法的播放模式。
 */
export function normalizePlayMode(value: unknown): PlayMode {
  if (typeof value === 'string' && (PLAY_MODES as readonly string[]).includes(value)) {
    return value as PlayMode
  }
  return 'sequence'
}

/**
 * 播放模式的持久化端口（**可注入**）。
 */
export interface PlayModePrefsPort {
  /** 读取偏好（没有 / 读失败 → 返回 `null`）。 */
  load(): Promise<PlayMode | null>
  /** 写入偏好。 */
  save(mode: PlayMode): Promise<void>
}

/**
 * 由两个函数造一个持久化端口。
 *
 * @param load 读取（主进程的 `prefs:get`）。
 * @param save 写入（主进程的 `prefs:set`）。
 */
export function createPlayModePrefsPort(
  load: () => Promise<PlayMode | null>,
  save: (mode: PlayMode) => Promise<void>,
): PlayModePrefsPort {
  return { load, save }
}
