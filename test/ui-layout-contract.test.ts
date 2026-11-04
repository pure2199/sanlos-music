// ---------------------------------------------------------------------------
// T31：布局契约（真机踩过的坑，2026-11-04）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这个文件**：这几个缺陷全是**纯 CSS** 的，
//    单测（jsdom 没有布局）与旧 E2E（mock 只有 8 首歌，队列短到不会溢出）
//    **全都抓不到** —— 于是它们活到了真机才被用户发现：
//
// 1. `.fnm-playerbar` 缺 `position: relative`
//    → 均衡器面板 / 队列面板（`position:absolute; bottom:100%`）的定位祖先
//      一路向上找到**初始包含块（视口）** → 面板整个跑到**屏幕上方之外**
//      → **点了 EQ / 队列，屏幕上什么也不出现**（DOM 里却确实有面板）。
// 2. `.fnm-fullplayer__body` 用了 `align-items: center`
//    → 右侧面板高度 = 内容高度 → 队列一长就**上下溢出** body
//      → 队列行**盖住右上角的关闭按钮**与**底部播放控件**（× 点不到）。
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

describe('布局契约（T31）', () => {
  it('播放条是**定位锚点**（`position: relative`）—— 否则 EQ / 队列面板跑到屏幕外', () => {
    const css = readCss('src', 'components', 'player-bar.css')
    // ⚠️ 必须命中 `.fnm-playerbar { … }` 这个**块内部**，而不是文件里任意位置。
    expect(css).toMatch(/\.fnm-playerbar\s*\{[^}]*position:\s*relative/)
  })

  it('全屏页的 body **必须 stretch**（队列一长就溢出 → 盖住关闭按钮）', () => {
    const css = readCss('src', 'pages', 'full-player.css')
    const block = /\.fnm-fullplayer__body\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/align-items:\s*stretch/)
    // ⚠️ **不能**是 `center`（那正是「面板高度 = 内容高度」的成因）。
    expect(block).not.toMatch(/align-items:\s*center/)
  })

  it('EQ / 队列浮层都挂在播放条上（`bottom: 100%` + `position: absolute`）', () => {
    const css = readCss('src', 'components', 'player-bar.css')
    for (const cls of ['.fnm-playerbar__eq', '.fnm-playerbar__queue']) {
      const block = new RegExp(`${cls.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(block).toMatch(/position:\s*absolute/)
      expect(block).toMatch(/bottom:\s*100%/)
    }
  })

  it('全屏页的队列列表**自己滚动**（`overflow-y: auto` + `min-height: 0`）', () => {
    const css = readCss('src', 'pages', 'full-player.css')
    const block = /\.fnm-fullplayer__queue\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/overflow-y:\s*auto/)
    expect(block).toMatch(/min-height:\s*0/)
  })

  it('歌词视图在双行模式下**撑满面板**（`flex: 1 1 auto` + `min-height: 0`）', () => {
    const css = readCss('src', 'ui', 'lyrics', 'lyric-view.css')
    const block = /\.fnm-lyricview\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/flex:\s*1 1 auto/)
    expect(block).toMatch(/min-height:\s*0/)
  })
})
