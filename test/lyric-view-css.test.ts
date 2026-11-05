// ---------------------------------------------------------------------------
// T48：卡拉OK 渐进填色的 **CSS 契约**
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要单独钉 CSS**：卡拉OK 的**全部视觉承诺**都在这几条声明里——
//    「填充宽度随词内比例连续推进」「填充从左边缘开始」「不改字形」
//    —— 而 jsdom 没有布局与样式（`getComputedStyle` 一律返回空）→ 单测**够不到**。
//    E2E 能看「最终长什么样」，但**说不清是哪条声明**坏的。
//    ⇒ 这里把**每条关键声明**钉死，坏哪条一目了然。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
//
// ⚠️ **「不改字形」是硬约束**：逐字着色层（overlay）与底层整行原文必须
//    **字形严丝合缝** → 任何改变字宽/字重的声明（`transform` / `font-weight` /
//    `font-size`）都会让两层错位（T46 的纪律）。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 读 CSS 并**剥掉注释**（剥完再匹配，否则会匹配到注释正文）。 */
function readCss(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取某条选择器的**块内声明**。 */
function blockOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('卡拉OK 填色的 CSS 契约（T48）', () => {
  const css = readCss('src', 'ui', 'lyrics', 'lyric-view.css')
  const karaoke = blockOf(css, '.fnm-lyricview__word--karaoke')

  it('这条规则**存在**（否则卡拉OK 什么都不发生）', () => {
    expect(karaoke).not.toBe('')
  })

  it('填充宽度由**词内进度变量**驱动（`--fnm-lyricview__karaoke-progress`）', () => {
    // ⚠️ 必须是**变量**而不是写死的百分比：进度是运行时算出来的（逐帧变）。
    expect(karaoke).toMatch(/background-size:\s*var\(--fnm-lyricview__karaoke-progress/)
  })

  it('用 `background-clip: text`（**不改字形** → 与底层原文严丝合缝）', () => {
    // ⚠️ `-webkit-` 前缀是给旧内核兜底的；标准属性是 Chromium 120+ 的写法。
    expect(karaoke).toMatch(/background-clip:\s*text/)
    expect(karaoke).toMatch(/-webkit-background-clip:\s*text/)
  })

  it('字本身透明（没填到的那一段**透出底层原文** = 还没唱到的颜色）', () => {
    expect(karaoke).toMatch(/color:\s*transparent/)
  })

  it('渐变**从左到右**、且**只画一遍**（填充从词的左边缘开始推进）', () => {
    expect(karaoke).toMatch(/linear-gradient\(90deg/)
    expect(karaoke).toMatch(/background-repeat:\s*no-repeat/)
    expect(karaoke).toMatch(/background-position:\s*0 0/)
  })

  it('**不许**出现会改变字形的声明（scale / 字重 / 字号 / 光晕）', () => {
    // ⚠️ 这些都会让着色层与底层原文**错位** → 高亮块与文字对不上。
    expect(karaoke).not.toMatch(/transform:/)
    expect(karaoke).not.toMatch(/font-weight:/)
    expect(karaoke).not.toMatch(/font-size:/)
    // ⚠️ 光晕会把填色的**边界糊掉**（看到的还是一条模糊亮边，不是清晰的推进线）。
    expect(karaoke).not.toMatch(/text-shadow:/)
  })

  it('颜色**只用语义变量**（不许硬编码色值）', () => {
    expect(karaoke).toMatch(/var\(--accent\)/)
    expect(karaoke).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(karaoke).not.toMatch(/rgb\(|rgba\(|hsl\(/)
  })
})
