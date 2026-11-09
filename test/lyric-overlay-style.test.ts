// ---------------------------------------------------------------------------
// T77：桌面歌词（经典悬浮窗）的**样式契约** —— 酷狗式：透明 + 白字 + 点穿透
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独钉 CSS**：透明背景、固定白字、深色描边、点穿透——
//    这些承诺**全在 CSS 与主进程里** → jsdom 量不到布局与样式 → 只能钉**声明**。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则会匹配到注释正文 = 空断言）。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（**不依赖 `process.cwd()`**）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读 CSS 并**剥掉注释**（剥完再匹配，否则会匹配到注释正文）。 */
function readCss(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取某条选择器的**块内声明**。 */
function blockOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('T77 桌面歌词：样式契约（透明 + 白字）', () => {
  const css = readCss('src', 'ui', 'lyrics', 'lyric-overlay.css')
  const root = blockOf(css, '.fnm-lyricoverlay')

  it('**没有底板**（背景透明；也没有边框与圆角）', () => {
    // ⚠️ 窗口**本来就是**透明窗口（`transparent: true`）——
    //    挡住桌面的是页面里这块 `--surface-raised` 面板 ⇒ 必须拿掉。
    expect(root).toMatch(/background:\s*transparent/)
    expect(root).not.toMatch(/background:\s*var\(--surface/)
    expect(root).not.toMatch(/border:/)
    expect(root).not.toMatch(/border-radius:/)
  })

  it('文字**固定白字**（不跟主题走：浮层压在任意壁纸上）', () => {
    expect(blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__line')).toMatch(
      /color:\s*var\(--lyric-float-text-dim\)/,
    )
    expect(blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__line--active')).toMatch(
      /color:\s*var\(--lyric-float-text\)/,
    )
    // ⚠️ **双行模式没有「当前行」类名**（`LyricView` 把两行都渲染成 `active: false`）
    //    ⇒ 「正在唱的那一行」只能靠**它身上的卡拉OK 词**认（`:has()`）。
    //    ⚠️ 这条是**鉴别力**所在：少了它 ⇒ 当前行与下一行**一样暗**（看不出来正在唱哪句）。
    expect(
      blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__line:has(.fnm-lyricview__word--karaoke)'),
    ).toMatch(/color:\s*var\(--lyric-float-text\)/)
  })

  it('有**深色描边/阴影**（白字压在任意壁纸上都看得清）', () => {
    const block = blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__line')
    expect(block).toMatch(/text-shadow:/)
    expect(block).toMatch(/var\(--lyric-float-shadow\)/)
  })

  it('着色层**不重复描边**（否则字发虚）', () => {
    expect(blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__overlay')).toMatch(
      /text-shadow:\s*none/,
    )
  })

  it('**不再有**标题条 / 播放控制的样式（纯歌词）', () => {
    expect(css).not.toMatch(/fnm-lyricoverlay__head/)
    expect(css).not.toMatch(/fnm-lyricoverlay__controls/)
    expect(css).not.toMatch(/fnm-lyricoverlay__button/)
  })

  it('**不再有**拖动区（点穿透 ⇒ 窗口收不到鼠标，拖了也没用）', () => {
    expect(css).not.toMatch(/-webkit-app-region:\s*drag/)
  })

  it('颜色**只用语义变量**（不许硬编码色值）', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(css).not.toMatch(/rgb\(|rgba\(|hsl\(/)
  })

  it('浮层文字令牌**两套主题同值**（不跟主题走 ⇒ 两边必须一样）', () => {
    const tokensCss = readCss('src', 'styles', 'tokens.css')
    const fluent = blockOf(tokensCss, "[data-theme='fluent']")
    for (const token of ['--lyric-float-text', '--lyric-float-text-dim', '--lyric-float-shadow']) {
      const apple = new RegExp(`${token}:\\s*([^;]+);`).exec(tokensCss)?.[1]?.trim()
      const win = new RegExp(`${token}:\\s*([^;]+);`).exec(fluent)?.[1]?.trim()
      expect(apple).toBeTruthy()
      expect(win).toBe(apple)
    }
  })

  // -------------------------------------------------------------------------
  // T78：卡拉OK 扫光色（**固定亮蓝**，不跟主题走）
  // -------------------------------------------------------------------------

  it('卡拉OK 扫光用**固定亮蓝**（真机上不该整行是主题蓝）', () => {
    // 已唱词：整词染色
    expect(blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__word--sung')).toMatch(
      /color:\s*var\(--lyric-float-accent\)/,
    )
    // 当前词：词内扫光渐变
    const karaoke = blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__word--karaoke')
    expect(karaoke).toMatch(/background-image:\s*linear-gradient\(/)
    expect(karaoke).toContain('var(--lyric-float-accent)')
    // ⚠️ **鉴别力**：不许回退到主题色（真机实测过：整行主题蓝、白字几乎看不见）
    expect(karaoke).not.toContain('var(--accent)')
    expect(blockOf(css, '.fnm-lyricoverlay .fnm-lyricview__word--sung')).not.toContain(
      'var(--accent)',
    )
  })

  it('**共享组件一字未改**（词岛 / 歌词舞台 / 主界面仍是主题色 —— T71「三处一致」）', () => {
    const shared = readCss('src', 'ui', 'lyrics', 'lyric-view.css')
    expect(blockOf(shared, '.fnm-lyricview__word--sung')).toMatch(/color:\s*var\(--accent\)/)
    expect(blockOf(shared, '.fnm-lyricview__word--karaoke')).toContain('var(--accent)')
  })

  it('扫光令牌**两套主题同值**（不跟主题走 ⇒ 两边必须一样）', () => {
    const tokensCss = readCss('src', 'styles', 'tokens.css')
    const fluent = blockOf(tokensCss, "[data-theme='fluent']")
    const apple = new RegExp(`--lyric-float-accent:\\s*([^;]+);`).exec(tokensCss)?.[1]?.trim()
    const win = new RegExp(`--lyric-float-accent:\\s*([^;]+);`).exec(fluent)?.[1]?.trim()
    expect(apple).toBeTruthy()
    expect(win).toBe(apple)
  })
})

// ---------------------------------------------------------------------------
// T77：主进程侧的护栏
// ---------------------------------------------------------------------------

describe('T77 桌面歌词：主进程护栏', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'electron', 'main.ts'), 'utf8')

  /** 经典悬浮窗的创建函数体（截到词岛窗口那一步为止）。 */
  const classicWindow = ((): string => {
    const start = source.indexOf('const createLyricWindow')
    const end = source.indexOf('const createIslandWindow')
    return source.slice(start, end > start ? end : start + 3000)
  })()

  it('经典悬浮窗必须**点穿透**（否则透明区域会挡住桌面点击）', () => {
    // ⚠️ 与词岛同款；⚠️ 代价（用户知情并接受）：不能拖、不能点。
    expect(classicWindow).toMatch(/setIgnoreMouseEvents\(true, \{ forward: true \}\)/)
  })

  it('**没有记忆位置时**默认落位（点穿透 ⇒ 不能拖，落点必须一次给对）', () => {
    expect(classicWindow).toMatch(/lyricFloatBounds\(lyricFloatDisplay\(\), size\)/)
    // ⚠️ **鉴别力**：光算出 `fallback` 不算数 —— 必须真的**用上去**。
    expect(classicWindow).toMatch(/x:\s*saved\?\.x \?\? fallback\.x/)
    expect(classicWindow).toMatch(/y:\s*saved\?\.y \?\? fallback\.y/)
  })

  it('默认高度**只放得下双行歌词**（纯歌词不需要 200px 高的面板）', () => {
    expect(source).toMatch(/const LYRIC_WINDOW_HEIGHT = 120/)
  })
})
