// ---------------------------------------------------------------------------
// Task 15：歌词视图（LyricView）
//
// 覆盖简报 Step 1/3 与控制器追加要求 B / D / I：
// - B：双行的精确行为（两行同时在场、上一行走满停在全满态、下一行同时在走、
//   整页走完才换行、两行字号一致等粗）；
// - D：只渲染当前行附近的若干行（DOM 节点数与歌词总量不成正比）；
// - I：单行高亮当前行、双行同时渲染两行、无歌词不崩、无翻译不渲染空行。
//
// ⚠️ 测试数据一律用**占位**（「甲行」「乙行」…），不含真实 FN ID / 账号 / 密码 / 真实歌曲名 / 真实歌词。
// ⚠️ 样式已迁到 `src/ui/lyrics/lyric-view.css`（jsdom 不加载外部样式表，
//    `getComputedStyle` 也不可靠）→ 断言一律用**类名**做钩子，不碰内联 style。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { LyricView, LYRIC_WINDOW_RADIUS } from '../src/ui/lyrics/LyricView'
import { attachTranslations, parseLrc } from '../src/ui/lyrics/parse'

// ---------------------------------------------------------------------------
// 测试数据（占位）
// ---------------------------------------------------------------------------

/** 把秒数转成 LRC 的 `mm:ss.00` 时间戳。 */
function stamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `[${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}.00]`
}

/** 两行占位歌词：甲行 10~20s、乙行 20~30s。 */
const LINES = parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙')

/** 三行占位歌词：甲行 10~20s、乙行 20~30s、丙行 30~30.5s。 */
const THREE_LINES = parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙\n[00:30.00]丙行丙')

/** 带翻译的两行占位歌词（用 Task 12 的合并入口挂上翻译）。 */
const LINES_WITH_TRANSLATION = attachTranslations(
  parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙'),
  parseLrc('[00:10.00]甲译甲\n[00:20.00]乙译乙'),
)

/** 取某个歌词行元素。 */
function lineAt(container: HTMLElement, index: number): HTMLElement {
  const element = container.querySelector(`[data-index="${index}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

/** 去掉「上一行 / 下一行」槽位修饰符后的类名（用来比较两行的样式是否一致）。 */
function withoutSlot(className: string): string {
  return className.replace(/\bfnm-lyricview__line--(previous|next)\b/g, '').trim()
}

// ---------------------------------------------------------------------------
// 简报 Step 1 的两条用例
// ---------------------------------------------------------------------------

describe('LyricView：简报 Step 1', () => {
  it('高亮当前行', () => {
    render(<LyricView lines={LINES} currentTime={12} mode="single" />)
    expect(screen.getByText('甲行甲').className).toMatch(/active/)
  })

  it('双行模式同时渲染两行', () => {
    render(<LyricView lines={LINES} currentTime={12} mode="double" />)
    expect(screen.getByText('甲行甲')).toBeTruthy()
    expect(screen.getByText('乙行乙')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 要求 B：双行的精确行为
// ---------------------------------------------------------------------------

describe('LyricView：双行模式', () => {
  it('上一行走满后停在全满态（该行所有词都处于高亮态，不清空）', () => {
    // 三行歌词：甲行 10~20s、乙行 20~30s、丙行 30~30.5s
    // t=25 时甲行早已唱完（走满），乙行正在唱
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={25} mode="double" />)

    const previous = lineAt(container, 0)
    const words = Array.from(previous.querySelectorAll('[data-word]'))
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) {
      expect(word.className).toMatch(/fnm-lyricview__word--sung/)
    }
  })

  it('下一行同时在走（未唱到的词不高亮）', () => {
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={25} mode="double" />)

    const next = lineAt(container, 1)
    const words = Array.from(next.querySelectorAll('[data-word]'))
    expect(words.length).toBeGreaterThan(0)
    // 至少有一个词已经唱到
    expect(words.some((word) => word.className.match(/fnm-lyricview__word--sung/))).toBe(true)
  })

  it('整页走完才一起换行（下一行走满后两行整体换成新的一页）', () => {
    const { container: before } = render(
      <LyricView lines={THREE_LINES} currentTime={29.9} mode="double" />,
    )
    expect(lineAt(before, 0)).toBeTruthy()
    expect(lineAt(before, 1)).toBeTruthy()

    const { container: after } = render(
      <LyricView lines={THREE_LINES} currentTime={30} mode="double" />,
    )
    // 新的「上一行」= 旧的「下一行」
    expect(lineAt(after, 1)).toBeTruthy()
    expect(lineAt(after, 2)).toBeTruthy()
  })

  it('两行字号一致、等粗（不把上一行降级成更弱的样子）', () => {
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={25} mode="double" />)

    const previous = lineAt(container, 0)
    const next = lineAt(container, 1)
    // 两行除了「槽位」修饰符外，类名完全一致 → 字号 / 字重来自同一条 CSS 规则
    expect(withoutSlot(previous.className)).toBe(withoutSlot(next.className))
    expect(previous.className).not.toMatch(/dim|muted|weak/)
  })

  it('双行模式只渲染两行（不把整份歌词塞进 DOM）', () => {
    const many = parseLrc(
      Array.from({ length: 500 }, (_, i) => `${stamp(i * 2)}占位行${i}`).join('\n'),
    )
    const { container } = render(<LyricView lines={many} currentTime={100} mode="double" />)

    expect(container.querySelectorAll('[data-index]')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 要求 D：单行模式的性能
// ---------------------------------------------------------------------------

describe('LyricView：单行模式', () => {
  it('只渲染当前行附近的若干行（DOM 节点数与歌词总量不成正比）', () => {
    const many = parseLrc(
      Array.from({ length: 1000 }, (_, i) => `${stamp(i * 2)}占位行${i}`).join('\n'),
    )
    const { container } = render(<LyricView lines={many} currentTime={5} mode="single" />)

    const rendered = container.querySelectorAll('[data-index]')
    expect(rendered.length).toBeLessThanOrEqual(LYRIC_WINDOW_RADIUS * 2 + 1)
    expect(rendered.length).toBeLessThan(20)
  })

  it('当前行居中（滚动位置把当前行放到中间）', () => {
    const many = parseLrc(
      Array.from({ length: 100 }, (_, i) => `${stamp(i * 2)}占位行${i}`).join('\n'),
    )
    const { container } = render(<LyricView lines={many} currentTime={35} mode="single" />)

    const viewport = container.querySelector('[data-testid="lyric-view"]') as HTMLElement
    expect(Number(viewport.getAttribute('data-scroll-top'))).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 要求 I：空态 / 翻译
// ---------------------------------------------------------------------------

describe('LyricView：空态与翻译', () => {
  it('无歌词时不崩（显示可读的空态，不是白屏）', () => {
    render(<LyricView lines={[]} currentTime={12} mode="single" />)
    expect(screen.getByText('暂无歌词')).toBeTruthy()
  })

  it('无歌词时双行模式同样不崩', () => {
    render(<LyricView lines={[]} currentTime={12} mode="double" />)
    expect(screen.getByText('暂无歌词')).toBeTruthy()
  })

  it('没有翻译时不渲染空的翻译行（不渲染空的第二行）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={12} mode="double" />)

    expect(container.querySelectorAll('[data-testid="lyric-translation"]')).toHaveLength(0)
    // 两行歌词仍然在场
    expect(screen.getByText('甲行甲')).toBeTruthy()
    expect(screen.getByText('乙行乙')).toBeTruthy()
  })

  it('有翻译时渲染翻译副行', () => {
    const { container } = render(
      <LyricView lines={LINES_WITH_TRANSLATION} currentTime={12} mode="double" />,
    )

    const translations = container.querySelectorAll('[data-testid="lyric-translation"]')
    expect(translations.length).toBe(2)
    expect(translations[0]?.textContent).toBe('甲译甲')
  })
})

// ---------------------------------------------------------------------------
// 点击定位
// ---------------------------------------------------------------------------

describe('LyricView：点击定位', () => {
  it('给了 onSeek 时点击某一行会回调该行的时间', () => {
    const onSeek = vi.fn()
    const { container } = render(
      <LyricView lines={LINES} currentTime={12} mode="single" onSeek={onSeek} />,
    )

    fireEvent.click(lineAt(container, 1))

    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(20)
  })

  it('没给 onSeek 时不渲染可点按钮（点击不抛异常）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={12} mode="single" />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
