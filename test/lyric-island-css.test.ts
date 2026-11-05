// ---------------------------------------------------------------------------
// T46 补丁②：词岛「**一行居中**」的 CSS 契约
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独钉 CSS**：单行模式（`mode="single"`）下，`LyricView` 的画布高度
//    = **整份歌词的总高**（行数 × 34px）—— 真实歌曲几百行 → 画布几千 px。
//    歌词区若按内容取高，就会被画布撑到几千 px → 胶囊（只有 96px）裁剪后
//    露出的是「**歌词表的垂直中点**」，而不是当前行；滚动定位也一并跑偏。
//
//    ⚠️ 这类缺陷 **jsdom 够不到**（没有布局，`getComputedStyle` 一律返回空），
//    单测只能钉**声明**；行为要靠**真机探针**（`t46p-center-probe.mjs`，200 行歌词）验。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// ⚠️ T53：跨文件不等式要用**词岛窗口的真实高度**（不是写死的 96）。
import { ISLAND_WINDOW_HEIGHT } from '../shared/islandAnchor'

/** 读 CSS 并**剥掉注释**（剥完再匹配，否则会匹配到注释正文）。 */
function readCss(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取某条选择器的**块内声明**。 */
function blockOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('词岛的 CSS 契约（T46 补丁②：单行居中）', () => {
  const css = readCss('src', 'island', 'island-window.css')

  it('歌词区高度**必须由胶囊给**，不能跟歌词总高走', () => {
    const block = blockOf(css, '.fnm-island__lyrics')
    // ⚠️ `align-self: stretch` 是关键：没有它，歌词区高度 = 画布高度（整份歌词的总高）
    //    → 胶囊里露出的是「歌词表的垂直中点」，当前行根本不在视野里。
    expect(block).toMatch(/align-self:\s*stretch/)
  })

  it('胶囊纵向用 `align-items: center`（曲名/歌手仍垂直居中）', () => {
    expect(blockOf(css, '.fnm-island')).toMatch(/align-items:\s*center/)
  })

  it('歌词视口**裁掉溢出的画布**（否则整份歌词会顶出胶囊）', () => {
    expect(blockOf(css, '.fnm-island__lyrics .fnm-lyricview')).toMatch(/overflow:\s*hidden/)
  })
})

// ---------------------------------------------------------------------------
// T47：频谱波形柱的 CSS 契约
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独钉 CSS**：柱子的**观感**全在 CSS 里——
//    `align-items: center` 决定「从中线上下对称生长」，
//    `transition: height` 决定「平滑不抖」。
//    这两样 jsdom **都量不到**（没有布局、没有动画）→ 只能钉**声明**。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
// ---------------------------------------------------------------------------

describe('词岛的 CSS 契约（T47：频谱波形柱）', () => {
  const css = readCss('src', 'island', 'island-window.css')

  it('柱子**垂直居中**（从胶囊中线上下对称生长，而不是贴着底边长）', () => {
    expect(blockOf(css, '.fnm-island__spectrum')).toMatch(/align-items:\s*center/)
  })

  it('柱子高度**不许被挤扁**（`flex: 0 0 auto`）', () => {
    expect(blockOf(css, '.fnm-island__spectrum')).toMatch(/flex:\s*0 0 auto/)
  })

  it('高度变化要有**过渡**（24fps 的数据裸奔会像在闪）', () => {
    expect(blockOf(css, '.fnm-island__bar')).toMatch(/transition:\s*height/)
  })

  it('柱子颜色**只用语义变量**（不许硬编码色值）', () => {
    const block = blockOf(css, '.fnm-island__bar')
    expect(block).toMatch(/background:\s*var\(--accent\)/)
    // ⚠️ `#hex` / `rgb()` / `hsl()` 一律不许（词岛窗支持明暗两套主题）。
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(block).not.toMatch(/rgb\(|rgba\(|hsl\(/)
  })

  it('柱子**不许**出现会改变字形/布局的动画（只过渡 height）', () => {
    const block = blockOf(css, '.fnm-island__bar')
    expect(block).not.toMatch(/transform:\s*scale/)
    expect(block).not.toMatch(/animation:/)
  })
})

// ---------------------------------------------------------------------------
// T48：词岛**不再**用整词发光（已被卡拉OK 渐进填色取代）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么必须钉**：T46 给词岛加的是「当前词整词发光」（`text-shadow`），
//    用户反馈「整词跳变不顺滑」→ 换成**卡拉OK 渐进填色**。
//    ⚠️ **两套机制不能共存**：光晕画在**字形轮廓**上 → 会把填色的边界糊掉，
//    看到的还是一条模糊的亮边（而不是清晰的推进线）。
//    ⚠️ 这类回归**没有任何运行时症状**（窗口照常显示、歌词照常滚）→ 只能钉声明。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
// ---------------------------------------------------------------------------

describe('词岛的 CSS 契约（T48：不再整词发光）', () => {
  const css = readCss('src', 'island', 'island-window.css')

  it('**不再有** `.fnm-lyricview__word--active` 的规则（发光已被卡拉OK 取代）', () => {
    expect(css).not.toMatch(/fnm-lyricview__word--active/)
  })

  it('词岛样式里**没有**任何 `text-shadow`（光晕会把填色边界糊掉）', () => {
    expect(css).not.toMatch(/text-shadow:/)
  })
})

// ---------------------------------------------------------------------------
// T53：词岛的**长歌词**（折成两行时第二行被裁掉）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么必须钉**：用户报障「长歌词显示不完整，他会变两行也看不到」。
//
// 根因（真机实测，22 字长句）：
// - `.fnm-lyricview__line--active` 是**定高 44px**，而 `white-space: pre-wrap`
//   允许换行 → 长句折 2 行 = **88px 内容溢出定高盒**；
// - 歌词视口 `overflow: hidden` → 溢出部分**被裁掉**；
// - 单行模式的滚动定位按**44px 行盒**居中 → 越往歌后面裁得越狠。
//
// 修法（只影响词岛）：当前行**可长高** + **行高 32px** + 视口 **flex 居中**
// → 折两行 = 64px ≤ 歌词带 74px → **两行都完整可见**。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
// ---------------------------------------------------------------------------

describe('词岛的 CSS 契约（T53：长歌词折行不被裁）', () => {
  const css = readCss('src', 'island', 'island-window.css')
  const activeBlock = blockOf(
    css,
    '.fnm-island__lyrics .fnm-lyricview--single .fnm-lyricview__line--active',
  )

  it('当前行**可以长高**（不能再是定高 44px → 否则长句折行会溢出盒子）', () => {
    expect(activeBlock).toMatch(/height:\s*auto/)
    expect(activeBlock).not.toMatch(/height:\s*44px/)
  })

  it('当前行**行高 32px**（折两行 = 64px，要塞进 74px 的歌词带）', () => {
    expect(activeBlock).toMatch(/line-height:\s*32px/)
  })

  it('歌词视口改成 **flex 居中**（当前行按自己的高度居中，不靠滚动定位）', () => {
    const block = blockOf(css, '.fnm-island__lyrics .fnm-lyricview')
    expect(block).toMatch(/display:\s*flex/)
    expect(block).toMatch(/align-items:\s*center/)
  })

  it('画布高度 **auto**（不撑到整份歌词的总高），超出的部分被裁', () => {
    const block = blockOf(css, '.fnm-island__lyrics .fnm-lyricview__canvas')
    expect(block).toMatch(/height:\s*auto/)
    expect(block).toMatch(/max-height:\s*100%/)
    expect(block).toMatch(/overflow:\s*hidden/)
  })

  it('当前行**不再绝对定位**（否则它的 `top` 会把它顶到画布外面去）', () => {
    const block = blockOf(css, '.fnm-island__lyrics .fnm-lyricview--single .fnm-lyricview__line')
    expect(block).toMatch(/position:\s*static/)
  })

  it('**两行必须塞得进胶囊**（跨文件不等式：窗口高 − 上下留白 − 边框 ≥ 2 × 行高）', () => {
    const island = blockOf(css, '.fnm-island')
    // ⚠️ `padding: 10px 18px` → 取**上下**的 10px；`border: 1px solid …` → 上下共 2px。
    const pad = Number(/padding:\s*(\d+)px/.exec(island)?.[1] ?? NaN)
    const border = Number(/border:\s*(\d+)px/.exec(island)?.[1] ?? NaN)
    expect(Number.isNaN(pad)).toBe(false)
    expect(Number.isNaN(border)).toBe(false)

    const band = ISLAND_WINDOW_HEIGHT - pad * 2 - border * 2
    const lineHeight = Number(/line-height:\s*(\d+)px/.exec(activeBlock)?.[1] ?? NaN)
    expect(Number.isNaN(lineHeight)).toBe(false)

    // 74px 的歌词带必须装得下**两行** 32px 的歌词（留 10px 余量）。
    expect(band).toBeGreaterThanOrEqual(lineHeight * 2)
  })
})
