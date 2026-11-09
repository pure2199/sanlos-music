// ---------------------------------------------------------------------------
// T79：桌面悬浮歌词的新档位 `mode="current"` —— **当前句 + 下一句**
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独一个文件**：`mode="current"` 是为了把桌面浮窗与**全屏歌词舞台**
//    （`mode="all"`）**对齐**而新开的档位 —— 两处必须**同一时刻同一行**在推进。
//    ⇒ 这里钉的每一条都是「对齐」的**鉴别力**，不是「存在性」。
//
// ---------------------------------------------------------------------------
// 为什么会有这档：两套判定口径不同（已查证）
// ---------------------------------------------------------------------------
//
// | 页面 | 模式 | 判「正在唱的那行」靠什么 |
// |---|---|---|
// | 全屏歌词舞台 | `all` | `findActiveLine()` ⇒ **行首时间戳** `line.time` |
// | 词岛 | `single` | 同上（行首时间戳） |
// | 旧桌面浮窗 | `double` | `computeDoubleLineState()` ⇒ **行末时间** `lineEndTime()` |
//
// ⇒ 只要「词级时间戳」与「行首时间戳」不是严格一致（真实歌词里很常见），
//    两处就会**错位**（实测：下一句提前开扫 / 落后 1.5 秒）。
//
// ⚠️ 测试数据一律用**占位**（「甲行」「乙行」…），不含真实 FN ID / 账号 / 真实歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LyricView } from '../src/ui/lyrics/LyricView'
import type { LyricLine } from '../src/ui/lyrics/parse'

// ---------------------------------------------------------------------------
// 测试数据（占位）
// ---------------------------------------------------------------------------

/**
 * 三行占位歌词，**故意让「词级时间戳」与「行首时间戳」不一致**。
 *
 * - 甲行：行首 **10s**，但末词拖到 **25s**（下一行乙行的行首是 20s）⇒
 *   **词级比行级晚** ⇒ 旧口径（按行末）会认为「甲行还没唱完」；
 * - 乙行：行首 **20s**，词 20~30s；
 * - 丙行：行首 **30s**，但它的词**从 15s 就开始**（**词级比行级早**）⇒
 *   若「下一句」也拿到 progress，它会在 15~30s 之间**提前开扫**
 *   （真实歌词里很常见：行首标签与词级标签来自不同来源）。
 *
 * ⚠️ 这正是真实歌词里常见的形态（行首标签与词级标签来自不同来源）。
 *
 * ⚠️ **每行只有一个词**：逐字片段是按「词文本拼起来 == 行文本去空白」对齐的
 *    （`buildSegments`）⇒ 词文本与行文本对不上时整行会退化成纯文本（不填色）。
 */
const LINES: LyricLine[] = [
  {
    time: 10,
    text: '甲',
    words: [{ text: '甲', start: 10, end: 25 }],
    translation: '',
  },
  {
    time: 20,
    text: '乙',
    words: [{ text: '乙', start: 20, end: 30 }],
    translation: '',
  },
  {
    time: 30,
    text: '丙',
    // ⚠️ **词级比行级早**（15s 就开始唱，行首标签却写 30s）⇒ 下一句会「提前开扫」。
    words: [{ text: '丙', start: 15, end: 35 }],
    translation: '',
  },
]

/** 取渲染出来的行元素（按行在 DOM 里的顺序）。 */
function renderedLines(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.fnm-lyricview__line')) as HTMLElement[]
}

/** 取某个歌词视图的「当前行下标」属性。 */
function currentIndexOf(container: HTMLElement, attribute: string): string {
  return container.querySelector('[data-testid="lyric-view"]')?.getAttribute(attribute) ?? ''
}

/** 仓库根目录（源码断言用）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

describe('T79 `mode="current"`：当前句 + 下一句', () => {
  it('**当前句在上**、下一句在下（按**行首时间戳**判当前句）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={22} mode="current" />)

    const lines = renderedLines(container)
    expect(lines).toHaveLength(2)
    // ⚠️ t=22 ⇒ 行首 20s 的**乙行**才是当前句（不是「末词还没结束」的甲行）
    expect(lines[0]?.getAttribute('data-index')).toBe('1')
    expect(lines[1]?.getAttribute('data-index')).toBe('2')
  })

  it('与全屏歌词舞台（`mode="all"`）**判出同一个当前行**（= 对齐全屏的钉子）', () => {
    // ⚠️ **鉴别力**：同一份歌词、同一时刻 ⇒ 两处的当前行下标必须**相同**。
    //    （旧的 `double` 口径在 t=22 会认为「甲行还没唱完」⇒ 与 all 模式不同。）
    const { container: current } = render(
      <LyricView lines={LINES} currentTime={22} mode="current" />,
    )
    const { container: all } = render(<LyricView lines={LINES} currentTime={22} mode="all" />)

    expect(currentIndexOf(current, 'data-current-index')).toBe(
      currentIndexOf(all, 'data-active-index'),
    )
    expect(currentIndexOf(current, 'data-current-index')).toBe('1')
  })

  it('**对照**：旧口径（`mode="double"`）在同一个时刻**判错了行**（这正是要修的）', () => {
    // ⚠️ 这一条**不是**给 `double` 挑刺，而是**证明新口径确实修好了**：
    //    `double` 按**行末时间** ⇒ t=22 时甲行的末词（25s）还没结束 ⇒ 它认为甲行在唱；
    //    而全屏舞台（行首时间戳）认为乙行在唱 ⇒ 两处对不上。
    const { container: double } = render(<LyricView lines={LINES} currentTime={22} mode="double" />)
    const { container: all } = render(<LyricView lines={LINES} currentTime={22} mode="all" />)

    // `double` 的「推进中的行」= 上一行（甲行，data-index=0）
    expect(renderedLines(double)[0]?.getAttribute('data-index')).toBe('0')
    // `all` 的当前行 = 乙行
    expect(currentIndexOf(all, 'data-active-index')).toBe('1')
  })

  it('**只有当前句扫光**（下一句既没有 sung 也没有 karaoke）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={22} mode="current" />)

    const current = renderedLines(container)[0]
    const next = renderedLines(container)[1]
    // 当前句：正在唱 ⇒ 有卡拉OK 当前词
    expect(current?.querySelector('.fnm-lyricview__word--karaoke')?.textContent).toBe('乙')
    // ⚠️ **鉴别力**：下一句**不许**开扫（否则桌面上两行同时在动）
    expect(next?.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
    expect(next?.querySelector('.fnm-lyricview__word--sung')).toBeNull()
  })

  it('当前句挂 `--active`（浮窗里它是**纯白**，下一句是暗白）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={22} mode="current" />)

    expect(renderedLines(container)[0]?.className).toContain('fnm-lyricview__line--active')
    expect(renderedLines(container)[1]?.className).not.toContain('fnm-lyricview__line--active')
  })

  it('**行首时间一到就换行**（不再等「整页走完」）', () => {
    const { container: before } = render(
      <LyricView lines={LINES} currentTime={19.9} mode="current" />,
    )
    const { container: after } = render(
      <LyricView lines={LINES} currentTime={20} mode="current" />,
    )

    expect(currentIndexOf(before, 'data-current-index')).toBe('0')
    expect(currentIndexOf(after, 'data-current-index')).toBe('1')
  })

  it('播放位置还在**第一句之前** → 没有当前句，第一句作为「下一句」显示', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={0} mode="current" />)

    expect(currentIndexOf(container, 'data-current-index')).toBe('-1')
    const lines = renderedLines(container)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.getAttribute('data-index')).toBe('0')
    // 没有当前句 ⇒ 没有任何行在扫光
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
  })

  it('**只渲染两行**（不把整份歌词塞进 DOM）', () => {
    const many: LyricLine[] = Array.from({ length: 500 }, (_, index) => ({
      time: index * 2,
      text: `占位行${index}`,
      words: [{ text: '占', start: index * 2, end: index * 2 + 1.5 }],
      translation: '',
    }))
    const { container } = render(<LyricView lines={many} currentTime={100} mode="current" />)

    expect(container.querySelectorAll('[data-index]')).toHaveLength(2)
  })

  it('没有歌词时**不白屏**（显示空态文案）', () => {
    const { container } = render(
      <LyricView lines={[]} currentTime={5} mode="current" emptyLabel="暂无歌词" />,
    )

    expect(container.textContent).toContain('暂无歌词')
  })
})

// ---------------------------------------------------------------------------
// 样式契约（`--current` 与 `--double` 同款排版）
// ---------------------------------------------------------------------------

describe('T79 `mode="current"`：样式契约', () => {
  /** 读 CSS 并**剥掉注释**（剥完再匹配，否则会匹配到注释正文）。 */
  const css = readFileSync(resolve(REPO_ROOT, 'src/ui/lyrics/lyric-view.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )

  it('`--current` 与 `--double` **同款排版**（两行等大、等粗、间距一致）', () => {
    // 容器规则：两档写在**同一条**选择器里 ⇒ 样式天然一致
    expect(css).toMatch(/\.fnm-lyricview--double,\s*\.fnm-lyricview--current\s*\{/)
    // 行规则：两档同款（字号 / 行高 / 字重）
    expect(css).toMatch(
      /\.fnm-lyricview--double \.fnm-lyricview__line,\s*\.fnm-lyricview--current \.fnm-lyricview__line\s*\{/,
    )
    const block = /\.fnm-lyricview--current \.fnm-lyricview__line\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/font-size:\s*20px/)
    expect(block).toMatch(/line-height:\s*32px/)
    expect(block).toMatch(/font-weight:\s*600/)
  })

  it('共享组件里**不许**出现 `text-shadow`（T48 的教训：光晕会糊掉卡拉OK 填色边界）', () => {
    expect(css).not.toMatch(/text-shadow/)
  })
})
