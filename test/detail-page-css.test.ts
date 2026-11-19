// ---------------------------------------------------------------------------
// T104：详情页曲目列表「滚不动」的 **CSS 契约**
// ---------------------------------------------------------------------------
//
// ⚠ **为什么要单独钉 CSS**：这个缺陷**全部写在 CSS 里** ——
//    jsdom 没有布局与样式（`getComputedStyle` 一律返回空）⇒ 单测**够不到**；
//    E2E 能验「最终长什么样」，但**说不清是哪条声明**坏的。
//    ⇒ 这里把**每条关键声明**钉死，坏哪条一目了然。
//
// ⚠ **背景**（真机实测 2026-11-17，本机 + 该账号）：
//    《极品家丁》1333 集的详情页里，`.sanlos-songlist__viewport` 的
//    `clientHeight` ＝ `scrollHeight` ＝ **63984** ⇒ 它**根本不是滚动容器**
//    ⇒ 真正在滚的是**整个文档** ⇒ `SongList` 的虚拟窗口
//    （靠**自己**的 `onScroll` → `setScrollTop`）**永不前移**
//    ⇒ 用户只看得到**最前面十几行**。
//
// ⚠ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
// ⚠ **不许出现硬编码色值**（项目约定：颜色只用 CSS 语义变量）→ 整份 CSS 扫一遍。
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

describe('详情页的 CSS 契约（T104：列表能滚到底）', () => {
  const css = readCss('src', 'pages', 'detail-page.css')
  const songListCss = readCss('src', 'components', 'song-list.css')

  it('详情页根 `.sanlos-detail` **有确定的高度**（`flex: 1 1 auto` + `min-height: 0`）', () => {
    // ⚠ 少了 `min-height: 0` ⇒ flex item 的自动最小尺寸 = 内容高度
    //    ⇒ 被 1333 集的画布顶到 6 万多像素 ⇒ 里面的列表**没有负余量可压缩**。
    const block = blockOf(css, '.sanlos-detail')
    expect(block).toMatch(/flex:\s*1 1 auto/)
    expect(block).toMatch(/min-height:\s*0/)
  })

  it('区块 `.sanlos-detail__section` 拿到的是**确定高度**（`flex: 1 1 0` ⇒ basis = 0）', () => {
    // ⚠ `flex: 1 1 auto` 的 basis = **内容高度** ⇒ 多个区块会按内容高度**按比例**被压缩
    //    ⇒ 谁都拿不到能用的视口；`0 0 auto` ⇒ 区块被内容撑高 ⇒ 视口 = 内容高度。
    //    ⇒ 只有 `1 1 0`（basis = 0）⇒ 空间按 grow 均分 ⇒ 每个区块拿到**确定高度**。
    const block = blockOf(css, '.sanlos-detail__section')
    expect(block).toMatch(/flex:\s*1 1 0/)
    expect(block).toMatch(/min-height:\s*0/)
  })

  it('头部 / 标题 / 说明行**不参与伸缩**（`flex: 0 0 auto`）', () => {
    for (const selector of [
      '.sanlos-detail__head',
      '.sanlos-detail__section-title',
      '.sanlos-detail__audiobook',
      '.sanlos-detail__audiobook-reasons',
    ]) {
      expect(blockOf(css, selector)).toMatch(/flex:\s*0 0 auto/)
    }
  })

  it('列表的滚动容器 `.sanlos-songlist__viewport` **自己能滚**（`overflow-y: auto`）', () => {
    // ⚠ 这一条是契约的另一半：视口是滚动容器，虚拟窗口才收得到 scroll 事件。
    const block = blockOf(songListCss, '.sanlos-songlist__viewport')
    expect(block).toMatch(/overflow-y:\s*auto/)
    expect(block).toMatch(/min-height:\s*0/)
  })

  it('⛔ 详情页样式里**不许**出现硬编码色值（只用语义变量）', () => {
    // ⚠ 颜色只许用 `var(--…)`（项目约定）⇒ 扫一遍 rgb/#/hsl。
    const raw = readFileSync(join(__dirname, '..', 'src', 'pages', 'detail-page.css'), 'utf8')
    const body = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(body).not.toMatch(/\brgba?\(/)
    expect(body).not.toMatch(/\bhsla?\(/)
  })
})
