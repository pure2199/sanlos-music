// ---------------------------------------------------------------------------
// T40：窄窗口适配 —— 顶栏（外壳层）的 **CSS 契约**
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要单独钉 CSS**：这一版的视觉承诺（「窗口再窄，**品牌名也不被压扁**；
//    顶栏放不下就**换行**，而不是把页面顶出横向滚动条」）**全部写在 CSS 里** ——
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

describe('顶栏（外壳层）的 CSS 契约（T40）', () => {
  const css = readCss('src', 'styles', 'app-shell.css')

  it('顶栏**能换行**（放不下就换行，而不是把顶栏顶出横向滚动条）', () => {
    // ⚠️ 实测：外框窄到 600 时顶栏 `scrollWidth` 594 > `clientWidth` 567 → 顶栏自己溢出。
    expect(blockOf(css, '.app-shell__topbar')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('品牌名**永不被压扁**（不缩 + 文字不折行）', () => {
    // ⚠️ 实测：外框窄到 640 时品牌被挤成 15px 宽 / 84px 高（四个字竖排 4 行）。
    const block = blockOf(css, '.app-shell__brand')
    expect(block).toMatch(/flex:\s*0 0 auto/)
    expect(block).toMatch(/white-space:\s*nowrap/)
  })

  it('曲库导航容器**仍然能换行**（不能把既有换行能力弄丢）', () => {
    expect(blockOf(css, '.app-shell__navs')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('整份 CSS **没有硬编码色值**（颜色只用语义变量）', () => {
    // 剥完注释再扫（注释里可以写示例色值）。
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/rgba?\(/)
  })
})
