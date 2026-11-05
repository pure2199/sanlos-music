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
