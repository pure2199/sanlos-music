// ---------------------------------------------------------------------------
// T34：全量模式（`mode="all"`）—— 歌词舞台
// ---------------------------------------------------------------------------
//
// 钉的是用户诉求「**全屏歌词应该显示所有歌词**」：
// - `single` 是**窗口裁剪**（只渲染当前行附近若干行）、`double` 只在场两行
//   → 两者都满足不了「全部可见」；
// - `all`：**整份歌词都在场**，当前行放大并逐字高亮，随播放**滚动跟随**；
// - **所有行等高槽位** → 当前行推进时**整份列表不跳动**（否则长歌每句都抖一下）。
//
// ⚠️ 既有 `test/lyric-view.test.tsx`（49 条）**一条不删、断言不削弱**
//    → 本文件是**新增**的；每条用例的注释里写清它的**鉴别力**（凭什么能抓住回归）。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { LyricView, LYRIC_ALL_LINE_HEIGHT } from '../src/ui/lyrics/LyricView'
import { attachTranslations, parseLrc } from '../src/ui/lyrics/parse'

/** 两行占位歌词：甲行 10~20s、乙行 20~30s。 */
const LINES = parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙')

/** 带翻译的两行占位歌词。 */
const LINES_WITH_TRANSLATION = attachTranslations(
  parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙'),
  parseLrc('[00:10.00]甲译甲\n[00:20.00]乙译乙'),
)

/** 生成 n 行占位歌词（第 i 行在 i×2 秒）。 */
function makeLines(count: number): ReturnType<typeof parseLrc> {
  const stamp = (seconds: number): string =>
    `[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.00]`
  return parseLrc(Array.from({ length: count }, (_, i) => `${stamp(i * 2)}占位行${i}`).join('\n'))
}

/** 取第 index 行歌词行元素。 */
function lineAt(container: HTMLElement, index: number): HTMLElement {
  const element = container.querySelector(`[data-index="${index}"]`)
  if (!element) throw new Error(`找不到第 ${index} 行`)
  return element as HTMLElement
}

/** 取容器上的滚动目标（jsdom 里 `scrollTop` 是空操作 → 用 data 属性暴露）。 */
function scrollTopOf(container: HTMLElement): number {
  const viewport = container.querySelector('[data-testid="lyric-view"]')
  return Number(viewport?.getAttribute('data-scroll-top'))
}

// ---------------------------------------------------------------------------
// 全量渲染
// ---------------------------------------------------------------------------

describe('LyricView：全量模式（歌词舞台）', () => {
  it('**所有**歌词行都在场（不是窗口裁剪，也不是只留两行）', () => {
    const { container } = render(<LyricView lines={makeLines(40)} currentTime={20} mode="all" />)

    // ⚠️ **鉴别力**：`single` 此刻最多渲染 `radius*2+1 = 7` 行、`double` 恰好 2 行
    //    → 「40 行全在」只有 `all` 模式做得到。
    expect(container.querySelectorAll('[data-index]')).toHaveLength(40)
  })

  it('当前行：放大 + 逐字高亮；**非**当前行没有逐字高亮', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={12} mode="all" />)

    const active = lineAt(container, 0)
    expect(active.className).toMatch(/active/)
    // ⚠️ 逐字高亮是**词**级别的：t=12 时甲行的**第一个词正在唱**。
    //
    // ⚠️ T71：卡拉OK 是**默认观感** ⇒ 当前词挂 `--karaoke`（**不再**整词上色），
    //    **已唱过的词**才挂 `--sung`。
    //    ⚠️ 本用例里 t=12 恰好落在**第一个词**上 ⇒ 「已唱过的词」为 0 个
    //    ⇒ 原断言「有 `--sung`」的前提被 T71 **显式推翻** ⇒ 拆成两条更强的事实：
    const karaoke = active.querySelectorAll('.fnm-lyricview__word--karaoke')
    expect(karaoke).toHaveLength(1)
    expect(karaoke[0]!.getAttribute('data-karaoke-progress')).toBe('60.0')

    const other = lineAt(container, 1)
    expect(other.className).not.toMatch(/active/)
    expect(other.querySelectorAll('.fnm-lyricview__word--sung')).toHaveLength(0)
    // ⚠️ **非**当前行**也没有**卡拉OK（只有当前行在推进）。
    expect(other.querySelectorAll('.fnm-lyricview__word--karaoke')).toHaveLength(0)
  })

  it('**翻译只给当前行看**（每行都挂翻译 → 槽位等高的前提就破了）', () => {
    const { container } = render(
      <LyricView lines={LINES_WITH_TRANSLATION} currentTime={12} mode="all" />,
    )

    const translations = container.querySelectorAll('[data-testid="lyric-translation"]')
    expect(translations).toHaveLength(1)
    expect(translations[0]!.textContent).toBe('甲译甲')
  })

  it('**还没唱到第一句**时（没有活跃行），翻译回落到第一行（不是整屏都没翻译）', () => {
    // ⚠️ **鉴别力**：`findActiveLine` 在 `t` 早于第一行时返回 `-1`。
    //    若翻译只跟活跃行走 → 这时**一条翻译都不渲染** → 用户看到「只有原文」的半成品。
    const { container } = render(
      <LyricView lines={LINES_WITH_TRANSLATION} currentTime={0} mode="all" />,
    )

    // 此刻确实**没有**活跃行。
    expect(
      container.querySelector('[data-testid="lyric-view"]')?.getAttribute('data-active-index'),
    ).toBe('-1')

    // 但翻译**仍然在场**（落在第一行上），且**仍然只有一行**带翻译。
    const translations = container.querySelectorAll('[data-testid="lyric-translation"]')
    expect(translations).toHaveLength(1)
    expect(translations[0]!.textContent).toBe('甲译甲')
  })

  it('**所有行等高槽位**（当前行只改字号 → 换行时列表不跳动）', () => {
    const { container } = render(<LyricView lines={makeLines(10)} currentTime={4} mode="all" />)

    const tops = Array.from(container.querySelectorAll('[data-index]')).map((element) =>
      Number(
        (element as HTMLElement).style.getPropertyValue('--fnm-lyricview__line-top').replace('px', ''),
      ),
    )
    expect(tops).toHaveLength(10)
    expect(tops[0]).toBe(0)
    // ⚠️ 相邻两行的槽位差**恒定** → 当前行换行时整份列表不会错位。
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]! - tops[i - 1]!).toBe(LYRIC_ALL_LINE_HEIGHT)
    }
  })

  it('滚动跟随当前行（`data-scroll-top` 随当前行往前而变大）', () => {
    const lines = makeLines(40)

    const before = render(<LyricView lines={lines} currentTime={6} mode="all" />)
    const beforeTop = scrollTopOf(before.container)

    const after = render(<LyricView lines={lines} currentTime={40} mode="all" />)
    const afterTop = scrollTopOf(after.container)

    // ⚠️ jsdom 量不到可视区高度 → 用兜底常量 400px 参与计算 → 数值可预期。
    expect(beforeTop).toBeGreaterThan(0)
    expect(afterTop).toBeGreaterThan(beforeTop)
  })

  it('无歌词时不崩（显示可读的空态，不是白屏）', () => {
    render(<LyricView lines={[]} currentTime={12} mode="all" />)
    expect(screen.getByText('暂无歌词')).toBeTruthy()
  })

  it('给了 onSeek 时点击某一行会回调该行的时间', () => {
    const onSeek = vi.fn()
    const { container } = render(
      <LyricView lines={LINES} currentTime={12} mode="all" onSeek={onSeek} />,
    )

    fireEvent.click(lineAt(container, 1))

    expect(onSeek).toHaveBeenCalledWith(20)
  })
})
