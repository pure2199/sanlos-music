import { useEffect } from 'react'

import type { ThemeName } from '../../shared/types'
import {
  coverUrlFor,
  extractCoverDominantColor,
  getCachedDominantColor,
  setCachedDominantColor,
} from '../components/coverColor'
import { useAppPrefsStore } from '../state/appPrefsStore'
import { usePlayerStore } from '../state/playerStore'
import { toFluentAccent, type FluentAccent } from './accentColor'

// ---------------------------------------------------------------------------
// T89-④：Fluent 主题的强调色取自**当前播放歌曲的封面主色**
// ---------------------------------------------------------------------------
//
// ⚠️ **规格出处**：`docs/superpowers/specs/2026-11-02-fnmusic-desktop-design.md:281`
//    「Windows 11 Fluent 风：强调色 = 取自封面取色的 Fluent 强调色」。
//    ⇒ 这是双主题表里**唯一**还没落地的一条。
//
// ⚠️ **只覆盖既有令牌**（`--accent` / `--accent-hover` / `--focus-ring`）——
//    **不新增** CSS 变量：`tokens.css` 的变量集合有契约测试钉着
//    （两套主题的语义变量集合必须完全相同）⇒ 加新令牌会红。
//
// ⚠️ **内联样式优先级高于 `:root` 与 `[data-theme='fluent']`** ⇒ 覆盖有效；
//    移除内联属性 ⇒ 立刻回到 CSS 里的主题色（切回 Apple 风时走这条路）。
//
// ⚠️ **只在 Fluent 主题下生效**：规格把 Apple 风写成「单色高饱和点缀」= **固定色**
//    ⇒ Apple 风不该跟着封面变。
// ---------------------------------------------------------------------------

/** 被封面主色覆盖的 CSS 变量（**都是既有令牌**）。 */
export const COVER_ACCENT_VARS = ['--accent', '--accent-hover', '--focus-ring'] as const

/**
 * 把一套强调色写进（或从）文档根元素。
 *
 * ⚠️ `accent` 为 `null` ⇒ **移除覆盖** ⇒ 回到 `tokens.css` 的主题色。
 *
 * @param accent 强调色；`null` = 移除覆盖。
 * @param root 目标元素（缺省 `document.documentElement`）。
 */
export function applyCoverAccent(accent: FluentAccent | null, root?: HTMLElement): void {
  const element =
    root ?? (typeof document !== 'undefined' ? document.documentElement : undefined)
  if (!element) return

  if (!accent) {
    for (const name of COVER_ACCENT_VARS) element.style.removeProperty(name)
    return
  }

  element.style.setProperty('--accent', accent.accent)
  element.style.setProperty('--accent-hover', accent.hover)
  element.style.setProperty('--focus-ring', accent.focusRing)
}

/**
 * 让 Fluent 主题的强调色跟着**当前播放歌曲的封面主色**走。
 *
 * ⚠️ **取不到色就保持主题默认色**（无封面 / 加载失败 / 灰白封面没有色相）
 *    ⇒ 永远有一个「不难看」的兜底，不会出现脏色。
 *
 * @param options 可选覆盖（**测试用**；生产不传 ⇒ 走全局 store）。
 */
export function useCoverAccent(options?: {
  /** 主题名（覆盖 store 里的值）。 */
  theme?: ThemeName
  /** 封面 id（覆盖 store 里的值）。 */
  coverId?: string
  /** 取色实现（覆盖默认实现）。 */
  extract?: (url: string) => Promise<string | null>
}): void {
  const storeTheme = useAppPrefsStore((state) => state.theme)
  // ⚠️ **只取标量**：播放器每次推进进度都会推新状态，
  //    若把 `current` 对象本身放进依赖数组 ⇒ 效果每渲染都重跑。
  const storeCoverId = usePlayerStore((state) => state.current?.coverId ?? '')

  // ⚠️ **覆盖优先**（用 `??` 而不是 `||` ⇒ 空串也是有效覆盖）。
  const theme = options?.theme ?? storeTheme
  const coverId = options?.coverId ?? storeCoverId
  const extract = options?.extract ?? extractCoverDominantColor

  useEffect(() => {
    // ⚠️ Apple 风不参与（规格 §7.1）。
    if (theme !== 'fluent') {
      applyCoverAccent(null)
      return
    }
    if (!coverId) {
      applyCoverAccent(null)
      return
    }
    const url = coverUrlFor(coverId)
    if (!url) {
      applyCoverAccent(null)
      return
    }

    const cached = getCachedDominantColor(coverId)
    if (cached) {
      applyCoverAccent(toFluentAccent(cached))
      return
    }

    let cancelled = false
    void extract(url).then((hex) => {
      if (cancelled) return
      // ⚠️ **只缓存成功的结果**（失败不缓存 ⇒ 允许重试）。
      if (hex) setCachedDominantColor(coverId, hex)
      applyCoverAccent(hex ? toFluentAccent(hex) : null)
    })
    return () => {
      cancelled = true
    }
  }, [theme, coverId, extract])
}
