// ---------------------------------------------------------------------------
// T107：「按歌指定歌词源」的 store ＋ `localStorage` 端口（渲染层）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么不住 `prefs.json`**：见 `src/player/lyricOverride.ts` 顶部 ——
//    「这首歌用哪个源」是**运行状态**，与「上次播到哪」同族。
//
// ⚠️ **写不进去怎么办**（配额满 / 隐私模式 / 没有 `localStorage`）：
//    - **本次运行内仍然有效**（内存里的表照样用）；
//    - ⚠️ **要让用户看得见** ⇒ `save()` **返回成功与否** ⇒ 失败时 store 记下
//      `error`（界面会显示「没保存住」）—— **不许静默假装成功**。
//
// ⚠️ **端口形态**（与 `src/player/resumeBridge.ts` 同一套纪律）：
//    单测注入假存储，生产用 `localStorage`；没有 `localStorage` 的环境
//    （浏览器预览 / 单测）自动降级为 no-op。
//
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import {
  clearLyricOverride,
  normalizeLyricOverrides,
  setLyricOverride,
  type LyricOverrideMap,
} from '../player/lyricOverride'
import type { LyricSource } from '../../shared/lyricProvider'

// ---------------------------------------------------------------------------
// 存储端口
// ---------------------------------------------------------------------------

/** `localStorage` 的键（与 `fnmusic-resume` / `fnmusic-local-history` 同族命名）。 */
export const LYRIC_OVERRIDE_STORAGE_KEY = 'fnmusic-lyric-overrides'

/**
 * 最小化的存储接口（**便于单测注入**）。
 *
 * ⚠️ 只取用到的三个方法 ⇒ 单测可以塞一个纯对象，不用真的 `localStorage`。
 */
export interface LyricOverrideStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 存储端口。 */
export interface LyricOverridePort {
  /** 读回本地存的指定（损坏 / 没有 ⇒ 空表）。 */
  load(): LyricOverrideMap
  /**
   * 写回本地。
   *
   * @returns **成功与否** —— 失败（配额满 / 隐私模式）时界面要**看得见**。
   */
  save(entries: LyricOverrideMap): boolean
}

/**
 * 取默认存储；**取不到就返回 `null`**（不抛）。
 *
 * ⚠️ 访问 `globalThis.localStorage` 本身**可能抛**（隐私模式 / 被禁用）⇒ 必须包 try。
 */
function defaultStorage(): LyricOverrideStorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * 造一个端口。
 *
 * @param storage 存储实现；给 `null` ⇒ **no-op 端口**（读回空表、写一律失败）。
 */
export function createLyricOverridePort(storage: LyricOverrideStorageLike | null): LyricOverridePort {
  return {
    load: (): LyricOverrideMap => {
      if (!storage) return {}
      try {
        const raw = storage.getItem(LYRIC_OVERRIDE_STORAGE_KEY)
        if (!raw) return {}
        // ⚠️ 损坏的 JSON / 陌生形状 ⇒ **整条丢弃**（不抛、不返回半截数据）。
        return normalizeLyricOverrides(JSON.parse(raw))
      } catch {
        return {}
      }
    },

    save: (entries: LyricOverrideMap): boolean => {
      if (!storage) return false
      try {
        storage.setItem(LYRIC_OVERRIDE_STORAGE_KEY, JSON.stringify(entries))
        return true
      } catch {
        // ⚠️ 写不进去（配额满 / 隐私模式）⇒ 静默降级（本次运行内仍有效）。
        return false
      }
    },
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/** 「按歌指定歌词源」store 的形状。 */
export interface LyricOverrideStore {
  /** 全部的指定（按曲目 guid 索引）。 */
  overrides: LyricOverrideMap
  /** 上一次操作的错误（`null` = 没有）。 */
  error: string | null
  /** 从本地读回一次（**启动时调用一次**）。 */
  load: () => void
  /** 给这首歌指定源。 */
  setOverride: (songId: string, source: LyricSource) => void
  /** 清掉这首歌的指定（「恢复自动」）。 */
  clearOverride: (songId: string) => void
}

/**
 * 造一个 store（**可注入端口** ⇒ 单测不碰真的 `localStorage`）。
 */
export function createLyricOverrideStore(port: LyricOverridePort) {
  return create<LyricOverrideStore>()((set, get) => ({
    overrides: {},
    error: null,

    load: (): void => {
      set({ overrides: port.load(), error: null })
    },

    setOverride: (songId: string, source: LyricSource): void => {
      const next = setLyricOverride(get().overrides, songId, source, Date.now())
      set({ overrides: next, error: null })
      // ⚠️ 写不进去 ⇒ **要让用户看得见**（界面会显示「没保存住」）。
      if (!port.save(next)) {
        set({ error: '歌词源指定没保存住（本次运行内有效）' })
      }
    },

    clearOverride: (songId: string): void => {
      const next = clearLyricOverride(get().overrides, songId)
      set({ overrides: next, error: null })
      if (!port.save(next)) {
        set({ error: '歌词源指定没保存住（本次运行内有效）' })
      }
    },
  }))
}

/**
 * 生产用的端口。
 *
 * ⚠️ **端口必须在模块加载时造出来**（与 `resumeBridge.ts` 同一纪律）。
 */
export const lyricOverridePort: LyricOverridePort = createLyricOverridePort(defaultStorage())

/** 生产用的 store。 */
export const useLyricOverrideStore = createLyricOverrideStore(lyricOverridePort)
