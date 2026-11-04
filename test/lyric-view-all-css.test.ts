// ---------------------------------------------------------------------------
// T34：全量模式（`mode="all"`）的 **CSS 契约**
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要单独钉 CSS**：这一档的视觉承诺（「所有行等高槽位」「当前行只放大、
//    不改槽位」「短歌居中、长歌贴顶」）**全部写在 CSS 里** ——
//    jsdom 没有布局与样式（`getComputedStyle` 一律返回空）→ 单测**够不到**；
//    E2E 能验「最终长什么样」，但**说不清是哪条声明**坏的。
//    ⇒ 这里把**每条关键声明**钉死，坏哪条一目了然。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
//
// ⚠️ **槽位高度必须等于 TS 里的常量** —— 这是「CSS 与代码各写一份 60」的防线：
//    两边一旦漂移（CSS 改了、TS 没改）→ 行与行会重叠或留缝，
//    而**两侧的测试各自都会绿**（单测只认 TS 常量，契约测试只认 CSS）。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { LYRIC_ALL_LINE_HEIGHT } from '../src/ui/lyrics/LyricView'

/** 读 CSS 并**剥掉注释**（剥完再匹配，否则会匹配到注释正文）。 */
function readCss(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取某条选择器的**块内声明**。 */
function blockOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('全量模式（歌词舞台）的 CSS 契约（T34）', () => {
  const css = readCss('src', 'ui', 'lyrics', 'lyric-view.css')

  it('所有行**绝对定位**在固定槽位上（否则行会叠在一起）', () => {
    const block = blockOf(css, '.fnm-lyricview--all .fnm-lyricview__line')
    expect(block).toMatch(/position:\s*absolute/)
    // 纵向位置由组件用 CSS 变量给（`--fnm-lyricview__line-top`）。
    expect(block).toMatch(/top:\s*var\(--fnm-lyricview__line-top/)
    expect(block).toMatch(/left:\s*0/)
    expect(block).toMatch(/right:\s*0/)
  })

  it('槽位高度**等于 TS 常量**（CSS 与代码不许各写一份数字）', () => {
    const block = blockOf(css, '.fnm-lyricview--all .fnm-lyricview__line')
    expect(block).toMatch(new RegExp(`height:\\s*${LYRIC_ALL_LINE_HEIGHT}px`))
  })

  it('当前行**只放大字号、不改槽位**（否则换行时整份列表上下跳）', () => {
    const block = blockOf(css, '.fnm-lyricview--all .fnm-lyricview__line--active')
    // ⚠️ 槽位**必须与普通行一致** —— 这是「列表不跳动」的前提。
    expect(block).toMatch(new RegExp(`height:\\s*${LYRIC_ALL_LINE_HEIGHT}px`))
    // 变的是字号。
    expect(block).toMatch(/font-size:\s*20px/)
  })

  it('歌词比可视区矮时**居中**、比可视区高时**贴顶**（`safe center`）', () => {
    const block = blockOf(css, '.fnm-lyricview--all')
    expect(block).toMatch(/display:\s*flex/)
    expect(block).toMatch(/flex-direction:\s*column/)
    // ⚠️ **必须是 `safe center`**：普通 `center` 在内容溢出时会让**顶部够不着**
    //    （被推到可视区上方）→ 歌词滚不到第一句。
    expect(block).toMatch(/justify-content:\s*safe center/)
  })

  it('画布**不被 flex 压扁**（`flex: 0 0 auto`）', () => {
    const block = blockOf(css, '.fnm-lyricview--all .fnm-lyricview__canvas')
    expect(block).toMatch(/flex:\s*0 0 auto/)
  })
})
