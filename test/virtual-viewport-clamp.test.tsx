// ---------------------------------------------------------------------------
// T22 回归：虚拟列表的「可视区高度」钳位
// ---------------------------------------------------------------------------
//
// 缺陷（真机实测，`tools/fn-cover-probe.mjs` 量到）
// ---------------------------------------------------------------------------
// 真实曲库有 34,071 张专辑。真机上曾经出现：
//
//   1. flex item 的**自动最小尺寸**默认是 `min-height: auto` = 内容的 min-content 高度；
//   2. 主区 `.app-shell__main` 里装着虚拟网格，网格**画布的高度 = 行数 × 行高**
//      → 主区的自动最小尺寸被顶到 41,316px（真机实测）；
//   3. 网格**没有负余量可压缩** → 量到的「可视区高度」= **全部内容的高度**
//      （真机实测 41,216px）；
//   4. 「可视区」= 全部内容 → **虚拟裁剪等于没裁剪** → 一次性挂载 **1,050 张卡片**
//      → 1,050 个封面请求把公共中继打到 502；
//   5. 同时，「内容填不满可视区就自动续一页」的副作用**永远成立**
//      （`contentHeight ≤ viewportHeight + rowHeight`）→ **无限翻页**。
//
// ---------------------------------------------------------------------------
// 这个测试防的是什么
// ---------------------------------------------------------------------------
// 钉两件事：
//
// - **行为层**：可视区高度**必须**被钳到窗口高度——
//   不管布局被顶成什么样，挂载量都只能是「一个窗口放得下」那么多，
//   并且**不会**因为「内容填不满可视区」而自动续页；
// - **契约层**：调用方**注入**的 `viewportHeight` 是显式契约，**不钳**
//   （单测靠它钉裁剪边界；钳了会破坏既有单测）。
//
// 另外钉一条 **CSS 根因契约**：主区的 `min-height: 0` 不能被删——
// TS 钳位只是兜底，删掉 CSS 根因会让「主区被内容顶开」这个坑重新长出来。
//
// ⚠️ 测试数据全是占位数据，不含真实 FN ID / 账号 / 口令 / 歌曲名。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ReactElement } from 'react'

import type { Song } from '../shared/types'
import {
  CARD_GRID_BUFFER_ROWS,
  CARD_GRID_MIN_COLUMN_WIDTH,
  CARD_GRID_ROW_HEIGHT,
  CardGrid,
} from '../src/components/Cards'
import { SONG_LIST_BUFFER_ROWS, SONG_ROW_HEIGHT, SongList } from '../src/components/SongList'

// ---------------------------------------------------------------------------
// 常量（与真机实测对齐）
// ---------------------------------------------------------------------------

/** 真机量到的「可视区高度」——主区被内容顶开时的值。 */
const MEASURED_HEIGHT = 41_216
/** 测量宽度：1,080px → 6 列（`CARD_GRID_MIN_COLUMN_WIDTH` = 180）。 */
const MEASURED_WIDTH = 1080
/** 真机窗口高度（`window.innerHeight`）。 */
const WINDOW_HEIGHT = 735

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 把 `getBoundingClientRect()` 伪造成「量到 41,216px 高」。
 *
 * ⚠️ jsdom **不实现布局**：`getBoundingClientRect()` 一律返回全 0，
 *    于是虚拟列表在单测里永远走兜底常量 → 真机上的这个缺陷**测不出来**。
 *    这里手工伪造出真机量到的那个值，才复现得出「可视区被顶爆」的场景。
 */
function mockMeasuredRect(): void {
  const rect = {
    width: MEASURED_WIDTH,
    height: MEASURED_HEIGHT,
    top: 0,
    left: 0,
    right: MEASURED_WIDTH,
    bottom: MEASURED_HEIGHT,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect)
}

/** 设置窗口高度（jsdom 默认 768，这里换成真机实测值）。 */
function setWindowHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  })
}

/** 按真机的测量宽度算出来的列数。 */
const COLUMNS = Math.floor(MEASURED_WIDTH / CARD_GRID_MIN_COLUMN_WIDTH)

/** 造一首占位歌曲。 */
function makeSong(index: number): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
    artist: '甲',
    artistId: '',
    album: '示例专辑',
    albumId: '',
    coverId: '',
    duration: 100,
    favorite: false,
    codec: 'FLAC',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: 0,
    trackNo: index,
    discNo: 1,
  }
}

/**
 * 读 CSS 源文件（**先剥掉注释**）。
 *
 * ⚠️ **必须先剥掉注释**：这些规则的注释里**正文就写着**「`min-height: 0` 不能省」
 *    —— 不剥注释的话，断言会匹配到**注释里的那行字**，
 *    真正声明被改掉也照样绿 → **空断言**（这个坑踩过一次）。
 */
function readCssFile(relativePath: string): string {
  return readFileSync(resolve(findRepoRoot(), relativePath), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 从 CSS 源文件里取出某条规则的内容。
 *
 * ⚠️ 钉的是**不变量**（这条规则里必须有什么），不是整段字面量——
 *    注释怎么改、声明顺序怎么调都不该把测试带红。
 */
function readCssRule(relativePath: string, selector: string): string {
  const css = readCssFile(relativePath)
  const matched = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(
    css,
  )
  if (!matched?.[1]) throw new Error(`${relativePath} 里找不到规则 ${selector}`)
  return matched[1]
}

/**
 * 找仓库根（从当前工作目录向上找）。
 *
 * ⚠️ **不能用 `import.meta.url`**：Vitest 的 jsdom 环境里它不是 `file:` URL。
 *    故按「仓库根必须同时有这三个文件」来定位。
 */
function findRepoRoot(): string {
  let current = process.cwd()
  for (let depth = 0; depth < 10; depth += 1) {
    const ok = ['package.json', 'index.html', 'lyric.html'].every((name) =>
      existsSync(resolve(current, name)),
    )
    if (ok) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`从 ${process.cwd()} 向上找不到仓库根（package.json / index.html / lyric.html）`)
}

afterEach(() => {
  vi.restoreAllMocks()
  setWindowHeight(768)
})

// ---------------------------------------------------------------------------
// 行为层：钳位
// ---------------------------------------------------------------------------

describe('虚拟列表的可视区高度钳位（T22）', () => {
  it('量到 4 万像素高时，网格只挂载「一个窗口放得下」的卡片', () => {
    setWindowHeight(WINDOW_HEIGHT)
    mockMeasuredRect()

    const items = Array.from({ length: 1050 }, (_, index) => index)
    render(
      <CardGrid
        items={items}
        keyOf={(item) => `k-${item}`}
        renderItem={(item): ReactElement => <span>{item}</span>}
        rowHeight={CARD_GRID_ROW_HEIGHT}
      />,
    )

    const cells = screen.getAllByRole('listitem')
    // 上界 = （窗口能放下的行数 + 缓冲行数）× 列数。
    const maxRows = Math.ceil(WINDOW_HEIGHT / CARD_GRID_ROW_HEIGHT) + CARD_GRID_BUFFER_ROWS
    expect(cells.length).toBeLessThanOrEqual(maxRows * COLUMNS)
    // ⚠️ 关键鉴别力：不钳的话这里会是 **1,050**（= 全部条目）→ 封面请求风暴。
    expect(cells.length).toBeLessThan(items.length)
  })

  it('内容远超可视区时，不触发「自动续一页」（无限翻页的放大器）', () => {
    setWindowHeight(WINDOW_HEIGHT)
    mockMeasuredRect()

    const onLoadMore = vi.fn()
    const items = Array.from({ length: 1050 }, (_, index) => index)
    render(
      <CardGrid
        items={items}
        keyOf={(item) => `k-${item}`}
        renderItem={(item): ReactElement => <span>{item}</span>}
        rowHeight={CARD_GRID_ROW_HEIGHT}
        hasMore
        onLoadMore={onLoadMore}
      />,
    )

    // ⚠️ 不钳的话：`contentHeight(39,200) ≤ viewportHeight(41,216) + rowHeight` 成立
    //    → 每渲染一次就自动续一页 → 34,071 张专辑理论上会被全拉下来。
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('注入的 viewportHeight 不被钳（显式契约，单测靠它钉裁剪边界）', () => {
    setWindowHeight(WINDOW_HEIGHT)
    mockMeasuredRect()

    const items = Array.from({ length: 1050 }, (_, index) => index)
    render(
      <CardGrid
        items={items}
        keyOf={(item) => `k-${item}`}
        renderItem={(item): ReactElement => <span>{item}</span>}
        rowHeight={CARD_GRID_ROW_HEIGHT}
        // ⚠️ 2,240 > 窗口高度（735）——注入值**必须**原样生效。
        viewportHeight={CARD_GRID_ROW_HEIGHT * 10}
        bufferRows={0}
      />,
    )

    const cells = screen.getAllByRole('listitem')
    expect(cells.length).toBe(10 * COLUMNS)
  })

  it('歌曲列表同样被钳住（行内 28px 缩略图也是封面请求）', () => {
    setWindowHeight(WINDOW_HEIGHT)
    mockMeasuredRect()

    const songs = Array.from({ length: 500 }, (_, index) => makeSong(index + 1))
    render(<SongList songs={songs} onPlay={vi.fn()} />)

    const rows = screen.getAllByRole('option')
    const maxRows = Math.ceil(WINDOW_HEIGHT / SONG_ROW_HEIGHT) + SONG_LIST_BUFFER_ROWS
    expect(rows.length).toBeLessThanOrEqual(maxRows)
    expect(rows.length).toBeLessThan(songs.length)
  })

  it('歌曲列表内容远超可视区时，也不触发「自动续一页」', () => {
    setWindowHeight(WINDOW_HEIGHT)
    mockMeasuredRect()

    const onLoadMore = vi.fn()
    const songs = Array.from({ length: 500 }, (_, index) => makeSong(index + 1))
    render(<SongList songs={songs} onPlay={vi.fn()} onLoadMore={onLoadMore} hasMore />)

    expect(onLoadMore).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 契约层：CSS 根因不能被删
// ---------------------------------------------------------------------------

describe('CSS 根因契约（T22）', () => {
  it('外壳必须有**确定**的高度（否则 flex-basis: 0% 退化成「按内容算」）', () => {
    const rule = readCssRule('src/styles/app-shell.css', '.app-shell')
    // ⚠️ 钉的是「有确定高度」这件事：`height: 100vh`。
    //    只写 `min-height: 100vh` 的话，外壳高度是「不定」的 →
    //    flex 布局里**谁都没有负余量可压缩** → 主区被内容顶到 4 万像素。
    expect(rule).toMatch(/height:\s*100vh/)
  })

  it('主区必须是 flex 列容器（页面外壳才会被压到窗口高度）', () => {
    const rule = readCssRule('src/styles/app-shell.css', '.app-shell__main')
    expect(rule).toMatch(/display:\s*flex/)
    expect(rule).toMatch(/flex-direction:\s*column/)
    // ⚠️ `min-height: 0` 不能省（flex item 的自动最小尺寸 = 内容的 min-content 高度）。
    expect(rule).toMatch(/min-height:\s*0\b/)
  })

  it('全局重置必须去掉 body 的 UA 默认边距（否则播放条底边被裁 8px）', () => {
    const css = readCssFile('src/styles/global.css')
    expect(css).toMatch(/html\s*,\s*body\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/html\s*,\s*body\s*\{[^}]*margin:\s*0/)
  })

  it('搜索页与搜索面板必须各自有确定高度 + 滚动容器', () => {
    // 主区修好之后（高度固定），这两个块级盒子若还是 auto 高度 → 内容溢出到播放条上。
    const page = readCssRule('src/pages/search-page.css', '.fnm-searchpage')
    expect(page).toMatch(/height:\s*100%/)
    const panel = readCssRule('src/components/search-panel.css', '.fnm-searchpanel')
    expect(panel).toMatch(/overflow-y:\s*auto/)
  })

  it('登录页必须能滚动（矮窗口下表单不能被裁掉）', () => {
    const rule = readCssRule('src/pages/login-page.css', '.fnm-login')
    expect(rule).toMatch(/height:\s*100%/)
    expect(rule).toMatch(/overflow-y:\s*auto/)
  })
})
