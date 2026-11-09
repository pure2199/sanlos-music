// ---------------------------------------------------------------------------
// 应用偏好的**渲染层镜像**（Task 6 / Task 8）
// ---------------------------------------------------------------------------
//
// ⚠️ **偏好的单一真相源 = 主进程的 `prefs.json`**（`AppPrefs`）。
//    本 store 只是**镜像**：读一次、写入回，不另立门户。
//
//    早先渲染层用 localStorage 存过主题名（`settingsStore` 的 `theme` 字段），
//    那与 `prefs.json` 构成「双真相源」，Task 17 已把它删干净。
//
// ⚠️ 这里**只有非敏感偏好**（主题名 / 关闭窗口的行为）——
//    **凭证（token / 口令 / deviceId）一律不许出现在这里**，那是 `session.bin` 的职责。
//
// ---------------------------------------------------------------------------
// 写回语义
// ---------------------------------------------------------------------------
// - **乐观应用**：界面立刻变（切换主题 / 改设置不能有延迟感）；
// - 写回失败 → **回滚**到原值并给出提示
//   （界面不能停在一个「没被记住」的状态上）。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { StreamQuality, ThemeName } from '../../shared/types'
import { DEFAULT_THEME, resolveThemeName } from '../../shared/themes'
import {
  DEFAULT_LYRIC_PRIORITY,
  DEFAULT_LYRIC_SOURCE,
  normalizeLyricPriority,
  normalizeLyricSource,
  normalizeLyricTemplate,
  type LyricPriority,
  type LyricSource,
} from '../../shared/lyricProvider'
import type { CloseBehavior, LyricOverlayMode, PlayerBridge } from '../../shared/playerBridge'
import { applyTheme } from '../theme'
import { DEFAULT_STREAM_QUALITY, normalizeStreamQuality } from '../player/transcode'

/** 默认的「关闭窗口」行为（隐藏，播放继续）。 */
export const DEFAULT_CLOSE_BEHAVIOR: CloseBehavior = 'hide'

/**
 * 默认的桌面歌词样式（T45）：**经典悬浮窗**。
 *
 * ⚠️ 老用户升级后行为必须**一字不变** → 缺省就是 `classic`。
 */
export const DEFAULT_LYRIC_OVERLAY_MODE: LyricOverlayMode = 'classic'

/** 把任意输入压成合法的桌面歌词样式（陌生值 → `classic`）。 */
export function normalizeLyricOverlayMode(value: unknown): LyricOverlayMode {
  return value === 'island' ? 'island' : DEFAULT_LYRIC_OVERLAY_MODE
}

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 应用偏好镜像 store 的形状。 */
export interface AppPrefsStore {
  /** 当前主题。 */
  theme: ThemeName
  /** 「关闭窗口」的行为。 */
  closeBehavior: CloseBehavior
  /** 上一次操作的错误（`null` = 没有）。 */
  error: string | null
  /** 从主进程读一次偏好并应用（**启动时调用一次**）。 */
  load: () => Promise<void>
  /** 切换主题（乐观应用 + 写回主进程；失败则回滚）。 */
  setTheme: (theme: ThemeName) => Promise<void>
  /** 改「关闭窗口」的行为（乐观应用 + 写回主进程；失败则回滚）。 */
  setCloseBehavior: (behavior: CloseBehavior) => Promise<void>
  /** 桌面悬浮歌词当前是否显示（Task 10）。 */
  lyricOverlayVisible: boolean
  /** 显示 / 隐藏桌面悬浮歌词（乐观应用 + 写回主进程；失败则回滚）。 */
  setLyricOverlayVisible: (visible: boolean) => Promise<void>
  /**
   * 桌面歌词的**样式**（T45）：经典悬浮窗 / 灵动态词岛。
   *
   * ⚠️ 缺省 = `'classic'` → 老用户升级后行为**一字不变**。
   */
  lyricOverlayMode: LyricOverlayMode
  /** 切换桌面歌词样式（乐观应用 + 写回主进程；失败则回滚）。 */
  setLyricOverlayMode: (mode: LyricOverlayMode) => Promise<void>
  /**
   * 外部歌词源（Task 32）：用哪个源。
   *
   * ⚠️ `off` = **只用 NAS 自带的歌词**，不查外部。
   */
  lyricSource: LyricSource
  /**
   * 自定义歌词 API 的 **URL 模板**（`source = 'custom'` 时才用）。
   *
   * ⚠️ 占位符：`{title}` `{artist}` `{album}` `{duration}`；
   *    响应体必须是**纯文本 LRC**。
   */
  lyricTemplate: string
  /** 改外部歌词源（乐观应用 + 写回主进程；失败则回滚）。 */
  setLyricSource: (source: LyricSource, template?: string) => Promise<void>
  /**
   * 歌词来源的**优先级**（T70）：`online-first`（线上优先）/ `local-first`（本地优先）。
   *
   * ⚠️ 缺省 = `'online-first'`（线上优先）。
   */
  lyricPriority: LyricPriority
  /** 切换歌词来源优先级（乐观应用 + 写回主进程；失败则回滚）。 */
  setLyricPriority: (priority: LyricPriority) => Promise<void>
  /**
   * 音质偏好（T54）：`original`（原始音质）/ `standard`（标准音质，服务端转码）。
   *
   * ⚠️ **缺省 = `original`** → 老用户升级后行为**一字不变**。
   */
  streamQuality: StreamQuality
  /** 切换音质偏好（乐观应用 + 写回主进程；失败则回滚）。 */
  setStreamQuality: (quality: StreamQuality) => Promise<void>
}

/** 应用偏好镜像 store（生产用）。 */
export const useAppPrefsStore = create<AppPrefsStore>()((set, get) => ({
  theme: DEFAULT_THEME,
  closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
  lyricOverlayVisible: false,
  lyricOverlayMode: DEFAULT_LYRIC_OVERLAY_MODE,
  lyricSource: DEFAULT_LYRIC_SOURCE,
  lyricTemplate: '',
  lyricPriority: DEFAULT_LYRIC_PRIORITY,
  streamQuality: DEFAULT_STREAM_QUALITY,
  error: null,

  load: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      // 没有桥（浏览器预览 / 单测）→ 用默认值，不报错、不崩。
      set({
        theme: applyTheme(DEFAULT_THEME),
        closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
        lyricOverlayVisible: false,
        lyricOverlayMode: DEFAULT_LYRIC_OVERLAY_MODE,
        lyricSource: DEFAULT_LYRIC_SOURCE,
        lyricTemplate: '',
        lyricPriority: DEFAULT_LYRIC_PRIORITY,
        streamQuality: DEFAULT_STREAM_QUALITY,
        error: null,
      })
      return
    }
    try {
      const prefs = await bridge.getPrefs()
      set({
        theme: applyTheme(resolveThemeName(prefs.theme)),
        closeBehavior: prefs.closeBehavior === 'quit' ? 'quit' : DEFAULT_CLOSE_BEHAVIOR,
        lyricOverlayVisible: prefs.lyricOverlay?.visible === true,
        lyricOverlayMode: normalizeLyricOverlayMode(prefs.lyricOverlay?.mode),
        lyricSource: normalizeLyricSource(prefs.lyric?.source),
        lyricTemplate: normalizeLyricTemplate(prefs.lyric?.template),
        lyricPriority: normalizeLyricPriority(prefs.lyric?.priority),
        // ⚠️ 外部数据**不可信**：`prefs.json` 是用户可编辑的文件 → 陌生值压成缺省档。
        streamQuality: normalizeStreamQuality(prefs.streamQuality),
        error: null,
      })
    } catch {
      // 读失败 → 退回默认值（**不崩**，偏好丢了不该让应用起不来）。
      set({
        theme: applyTheme(DEFAULT_THEME),
        closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
        lyricOverlayVisible: false,
        lyricOverlayMode: DEFAULT_LYRIC_OVERLAY_MODE,
        lyricSource: DEFAULT_LYRIC_SOURCE,
        lyricTemplate: '',
        lyricPriority: DEFAULT_LYRIC_PRIORITY,
        streamQuality: DEFAULT_STREAM_QUALITY,
        error: null,
      })
    }
  },

  setTheme: async (next: ThemeName): Promise<void> => {
    const theme = resolveThemeName(next)
    const previous = get().theme
    // 乐观应用：切换主题**必须即时反馈**。
    set({ theme: applyTheme(theme), error: null })

    const bridge = playerBridge()
    // 没有桥 → 只在本地生效（浏览器预览；不崩、也不静默写盘）。
    if (!bridge) return

    try {
      await bridge.setTheme(theme)
    } catch {
      // 写回失败 → 回滚（界面不能停在一个「没被记住」的主题上）。
      set({ theme: applyTheme(previous), error: '主题保存失败，已恢复原主题' })
    }
  },

  setCloseBehavior: async (next: CloseBehavior): Promise<void> => {
    const behavior: CloseBehavior = next === 'quit' ? 'quit' : DEFAULT_CLOSE_BEHAVIOR
    const previous = get().closeBehavior
    set({ closeBehavior: behavior, error: null })

    const bridge = playerBridge()
    if (!bridge) return

    try {
      await bridge.setPrefs({ closeBehavior: behavior })
    } catch {
      set({ closeBehavior: previous, error: '设置保存失败，已恢复原设置' })
    }
  },

  setLyricOverlayVisible: async (visible: boolean): Promise<void> => {
    const previous = get().lyricOverlayVisible
    // 乐观应用：开关必须即时反馈（主进程那边还要建 / 藏窗口）。
    set({ lyricOverlayVisible: visible, error: null })

    const bridge = playerBridge()
    if (!bridge) return

    try {
      // ⚠️ 走**专用通道**：主进程要据此**创建 / 隐藏窗口**并落盘，
      //    光改偏好是不够的（窗口不会凭空出现）。
      await bridge.setLyricVisible(visible)
    } catch {
      set({ lyricOverlayVisible: previous, error: '悬浮歌词开关失败，已恢复原设置' })
    }
  },

  setLyricOverlayMode: async (mode: LyricOverlayMode): Promise<void> => {
    const next = normalizeLyricOverlayMode(mode)
    const previous = get().lyricOverlayMode
    // 乐观应用：换样式必须即时反馈（主进程那边还要**换窗口**）。
    set({ lyricOverlayMode: next, error: null })

    const bridge = playerBridge()
    if (!bridge) return

    try {
      // ⚠️ 走**专用通道**：主进程要据此**换成对应的窗口**并落盘，
      //    光改偏好是不够的（窗口不会凭空换形态）。
      await bridge.setLyricMode(next)
    } catch {
      set({ lyricOverlayMode: previous, error: '桌面歌词样式切换失败，已恢复原设置' })
    }
  },

  setLyricSource: async (source: LyricSource, template?: string): Promise<void> => {
    const nextSource = normalizeLyricSource(source)
    const nextTemplate = normalizeLyricTemplate(template ?? get().lyricTemplate)
    const previousSource = get().lyricSource
    const previousTemplate = get().lyricTemplate
    // 乐观应用：换歌词源必须**即时反馈**（下一首歌就用新源）。
    set({ lyricSource: nextSource, lyricTemplate: nextTemplate, error: null })

    const bridge = playerBridge()
    if (!bridge) return

    try {
      // ⚠️ T70：`prefs.json` 的 `lyric` 组是**整体替换**的（`PrefsStore.write`
      //    只在**顶层**合并）⇒ 这里必须把 `priority` **一起写**，
      //    否则改一次歌词源就会把用户的优先级选择**悄悄抹掉**。
      await bridge.setPrefs({
        lyric: { source: nextSource, template: nextTemplate, priority: get().lyricPriority },
      })
    } catch {
      // 写回失败 → 回滚（界面不能停在一个「没被记住」的歌词源上）。
      set({
        lyricSource: previousSource,
        lyricTemplate: previousTemplate,
        error: '歌词源设置保存失败，已恢复原设置',
      })
    }
  },

  setLyricPriority: async (priority: LyricPriority): Promise<void> => {
    const next = normalizeLyricPriority(priority)
    const previous = get().lyricPriority
    // 乐观应用：换优先级必须**即时反馈**（下一首歌就用新口径）。
    set({ lyricPriority: next, error: null })

    const bridge = playerBridge()
    if (!bridge) return

    try {
      // ⚠️ 同上：`lyric` 组**整体替换** ⇒ 源与模板也要**一起写**，否则会被抹掉。
      await bridge.setPrefs({
        lyric: {
          source: get().lyricSource,
          template: get().lyricTemplate,
          priority: next,
        },
      })
    } catch {
      // 写回失败 → 回滚（界面不能停在一个「没被记住」的优先级上）。
      set({ lyricPriority: previous, error: '歌词优先级保存失败，已恢复原设置' })
    }
  },

  setStreamQuality: async (quality: StreamQuality): Promise<void> => {
    const next = normalizeStreamQuality(quality)
    const previous = get().streamQuality
    // 乐观应用：切换音质**必须即时反馈**（下一首歌就用新档位）。
    set({ streamQuality: next, error: null })

    const bridge = playerBridge()
    if (!bridge) return

    try {
      await bridge.setPrefs({ streamQuality: next })
    } catch {
      // 写回失败 → 回滚（界面不能停在一个「没被记住」的音质档位上）。
      set({ streamQuality: previous, error: '音质偏好保存失败，已恢复原设置' })
    }
  },
}))
