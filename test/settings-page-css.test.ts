// ---------------------------------------------------------------------------
// T35：设置页（整页）的 **CSS 契约**
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要单独钉 CSS**：这一版的视觉承诺（「整页、两栏、说明文字一行放得下、
//    输入框限宽、**不再绝对定位盖住顶栏**」）**全部写在 CSS 里** ——
//    jsdom 没有布局与样式（`getComputedStyle` 一律返回空）→ 单测**够不到**；
//    E2E 能验「最终长什么样」，但**说不清是哪条声明**坏的。
//    ⇒ 这里把**每条关键声明**钉死，坏哪条一目了然。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
//
// ⚠️ **不许出现硬编码色值**（项目约定：颜色只用 CSS 语义变量）→ 整份 CSS 扫一遍。
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

describe('设置页（整页）的 CSS 契约（T35）', () => {
  const css = readCss('src', 'components', 'settings-panel.css')

  it('根容器**撑满主区**（不是浮层 → 高度跟着主区走）', () => {
    const block = blockOf(css, '.fnm-settings')
    expect(block).toMatch(/flex:\s*1 1 auto/)
    expect(block).toMatch(/min-height:\s*0/)
    expect(block).toMatch(/height:\s*100%/)
  })

  it('**不再是绝对定位的浮层**（旧浮层会盖住顶栏）', () => {
    const block = blockOf(css, '.fnm-settings')
    expect(block).not.toMatch(/position:\s*absolute/)
    expect(block).not.toMatch(/position:\s*fixed/)
  })

  it('根容器是**横向两栏**（左导航 + 右内容，不是竖排）', () => {
    const block = blockOf(css, '.fnm-settings')
    expect(block).toMatch(/display:\s*flex/)
    // ⚠️ 竖排会把左导航压到内容上方 → 分类导航就废了。
    expect(block).not.toMatch(/flex-direction:\s*column/)
  })

  it('左侧分类导航是**固定宽度的一栏**', () => {
    const block = blockOf(css, '.fnm-settings__nav')
    expect(block).toMatch(/flex:\s*0 0 190px/)
    expect(block).toMatch(/display:\s*flex/)
    expect(block).toMatch(/flex-direction:\s*column/)
  })

  it('右侧内容区**自己滚动**，且不被内容顶高', () => {
    const block = blockOf(css, '.fnm-settings__content')
    expect(block).toMatch(/flex:\s*1 1 auto/)
    expect(block).toMatch(/min-width:\s*0/)
    expect(block).toMatch(/overflow-y:\s*auto/)
  })

  it('内容列**限宽 900px**（宽到说明文字一行放得下，又不无限拉长）', () => {
    expect(blockOf(css, '.fnm-settings__group')).toMatch(/max-width:\s*900px/)
    expect(blockOf(css, '.fnm-settings__hint')).toMatch(/max-width:\s*860px/)
  })

  it('输入框**限宽 560px**（旧浮层里示例 URL 被截断 → 现在不许再被截断）', () => {
    expect(blockOf(css, '.fnm-settings__option--stack')).toMatch(/max-width:\s*560px/)
  })

  it('组标题是**加粗小标题 + 下分隔线**（不再是灰色小字）', () => {
    const block = blockOf(css, '.fnm-settings__legend')
    expect(block).toMatch(/font-weight:\s*600/)
    expect(block).toMatch(/border-bottom:\s*1px solid var\(--border\)/)
  })

  it('当前分类有**独立的选中样式**（`aria-current`）', () => {
    const block = blockOf(css, ".fnm-settings__nav-item[aria-current='page']")
    expect(block).toMatch(/background:\s*var\(--accent\)/)
    expect(block).toMatch(/font-weight:\s*600/)
  })

  it('整份 CSS **没有硬编码色值**（颜色只用语义变量）', () => {
    // 剥完注释再扫（注释里可以写示例色值）。
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/rgba?\(/)
  })
})
