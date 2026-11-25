// ---------------------------------------------------------------------------
// T138：「最近」页 **整页溢出 / 列表被播放条压住** 的 CSS 契约
// ---------------------------------------------------------------------------
//
// ⚠ **为什么要单独钉 CSS**：这个缺陷**全部写在 CSS 里** ——
//    jsdom 没有布局与样式（`getComputedStyle` 一律返回空）⇒ 单测**够不到**；
//    E2E 能验「最终长什么样」，但**说不清是哪条声明**坏的。
//    ⇒ 这里把**每条关键声明**钉死，坏哪条一目了然（同 T104 的做法）。
//
// ⚠ **背景**（真机实测 2026-11-26，本机 + 真实 NAS，已装版 v0.4.7）：
//    「最近」页的文档高度 = **1155**，窗口内高只有 **761** ⇒ 整页多出 394px 滚动；
//    `.sanlos-page` = 608 / **1067**；NAS 列表视口底边 **1101** ⇒
//    **伸到播放条（696..761）底下** ⇒ 末尾几行被压在播放器下面看不见。
//    对照「歌曲」页：文档 761/761、`.sanlos-page` 608/608、视口 186..654 ⇒ 正常。
//
// ⚠ **根因**：`.sanlos-history` 是 `.sanlos-page`（**纵向 flex** 容器）的 flex item，
//    却**一条 flex 声明都没有** ⇒ 默认 `flex: 0 1 auto`（basis = **内容高度**）
//    ＋ flex 项的「自动最小尺寸 = 内容高度」⇒ 被 14 行 NAS 列表顶到 1067px
//    ⇒ 撑破 `.sanlos-page`(608) ⇒ 真正在滚的是**整个文档**。
//
// ⚠ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
// ⚠ **不许出现硬编码色值**（项目约定：颜色只用 CSS 语义变量）⇒ 整份 CSS 扫一遍。
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

/**
 * 本机段的**高度上限**（px）。
 *
 * ⚠ 为什么**必须有上限**：本机播放记录最多 **100** 条（`LOCAL_HISTORY_LIMIT`），
 *    100 × 48px = **4800px** ⇒ 不封顶的话它会把 NAS 段**挤成 0 高**
 *    （NAS 列表直接消失）—— 契约里把这个数字钉死。
 */
const LOCAL_SECTION_MAX_HEIGHT = 240

/**
 * NAS 段的**高度下限**（px）。
 *
 * ⚠ 为什么**必须有下限**：窗口可以拖到最小（外框 520 ⇒ 主区只剩 ~330px），
 *    此时本机段 + 头部 + 批量条会把它挤没 ⇒ 列表**整段消失**（比溢出更糟）。
 */
const NAS_SECTION_MIN_HEIGHT = 120

describe('「最近」页的 CSS 契约（T138：整页不溢出、列表不被播放条压住）', () => {
  const css = readCss('src', 'pages', 'history-page.css')
  const songListCss = readCss('src', 'components', 'song-list.css')
  const pagingCss = readCss('src', 'components', 'paging-notice.css')

  it('页面主体 `.sanlos-history` **长满页面**（`flex: 1 1 auto` + `min-height: 0`）', () => {
    // ⚠ 少了 `min-height: 0` ⇒ flex item 的自动最小尺寸 = 内容高度
    //    ⇒ 被 NAS 列表顶到 1067px ⇒ 整页被撑开、滚动条跑到了错误的层上。
    const block = blockOf(css, '.sanlos-history')
    expect(block).toMatch(/flex:\s*1 1 auto/)
    expect(block).toMatch(/min-height:\s*0/)
  })

  it('本机段 `.sanlos-history__section--local` 按**内容高**且**有上限**（`flex: 0 0 auto` + `max-height`）', () => {
    // ⚠ `0 0 auto` = 不伸缩 ⇒ 它永远保持自己的自然高度（空时很矮、有内容时按上限）。
    // ⚠ `max-height` 是**承重**的那一半：没有它，100 条本机记录会把 NAS 段挤没。
    const block = blockOf(css, '.sanlos-history__section--local')
    expect(block).toMatch(/flex:\s*0 0 auto/)
    expect(block).toMatch(new RegExp(`max-height:\\s*${LOCAL_SECTION_MAX_HEIGHT}px`))
  })

  it('NAS 段 `.sanlos-history__section--nas` 吃**剩余高度**（`flex: 1 1 0`）且有**下限**（`min-height`）', () => {
    // ⚠ basis = 0 ⇒ 内容高度不再往上顶（否则又回到 1067px 的老样子）；
    // ⚠ `min-height` 是**下限**：窗口被拖到最矮时，列表不许整段消失。
    const block = blockOf(css, '.sanlos-history__section--nas')
    expect(block).toMatch(/flex:\s*1 1 0/)
    expect(block).toMatch(new RegExp(`min-height:\\s*${NAS_SECTION_MIN_HEIGHT}px`))
  })

  it('段标题 / 说明行 / 分页提示**不参与伸缩**（`flex: 0 0 auto`）', () => {
    // ⚠ 不钉住的话：空间一紧，标题和说明行先被压扁（文字被裁掉）。
    expect(blockOf(css, '.sanlos-history__section-title')).toMatch(/flex:\s*0 0 auto/)
    expect(blockOf(css, '.sanlos-history__hint')).toMatch(/flex:\s*0 0 auto/)
    expect(blockOf(pagingCss, '.sanlos-pagingnotice')).toMatch(/flex:\s*0 0 auto/)
  })

  it('列表的滚动容器 `.sanlos-songlist__viewport` **自己能滚**（`overflow-y: auto`）', () => {
    // ⚠ 这一条是契约的另一半：视口是滚动容器，虚拟窗口才收得到 scroll 事件。
    const block = blockOf(songListCss, '.sanlos-songlist__viewport')
    expect(block).toMatch(/overflow-y:\s*auto/)
    expect(block).toMatch(/min-height:\s*0/)
  })

  it('⛔ 「最近」页样式里**不许**出现硬编码色值（只用语义变量）', () => {
    // ⚠ 颜色只许用 `var(--…)`（项目约定）⇒ 扫一遍 rgb/#/hsl。
    for (const file of ['src/pages/history-page.css', 'src/components/paging-notice.css']) {
      const body = readFileSync(join(__dirname, '..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(body, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(body, file).not.toMatch(/\brgba?\(/)
      expect(body, file).not.toMatch(/\bhsla?\(/)
    }
  })
})
