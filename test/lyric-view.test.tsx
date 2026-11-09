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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReactElement } from 'react'

import {
  LyricView,
  LYRIC_ACTIVE_LINE_HEIGHT,
  LYRIC_LINE_HEIGHT,
  LYRIC_WINDOW_RADIUS,
} from '../src/ui/lyrics/LyricView'
import { attachTranslations, parseLrc, type LyricLine } from '../src/ui/lyrics/parse'
import { PlayerBar, resolveQuality, LOSSLESS_CODECS } from '../src/components/PlayerBar'
import {
  FullPlayerPage,
  clearCoverColorCache,
  extractCoverColor,
  getCachedCoverColor,
} from '../src/pages/FullPlayerPage'
import { createPlayerStore } from '../src/state/playerStore'
import type { PlayerEngineLike } from '../src/player/engine'
import type { PlayerState, PlayMode, Song } from '../shared/types'
import type { LyricEntry } from '../src/api/types'

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

/**
 * 三行**真逐字**歌词（T81 的测试数据）。
 *
 * ⚠️ **为什么要另造一份**：`THREE_LINES` 是**行级** LRC ⇒ 走**伪逐字**
 *    ⇒ T81 起**不渲染词级元素** ⇒ 词级断言（`--sung` / 词级钩子）在它上面
 *    **测不到东西**（会「空过」）⇒ 凡是断言**词级**行为的用例，一律改用这一份。
 *
 * 词时间：甲行 10/15/18s、乙行 20/25/28s、丙行 30/30.5s。
 */
const WORD_TIMED_THREE_LINES = parseLrc(
  [
    '[00:10.00]<00:10.00>甲<00:15.00>行<00:18.00>甲',
    '[00:20.00]<00:20.00>乙<00:25.00>行<00:28.00>乙',
    '[00:30.00]<00:30.00>丙<00:30.50>丙',
  ].join('\n'),
)

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

/** 仓库根目录（源码断言用）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 歌词视图的源码路径（F15-04 的「key 写在元素上」护栏用）。 */
const LYRIC_VIEW_SOURCE = resolve(REPO_ROOT, 'src/ui/lyrics/LyricView.tsx')

// ---------------------------------------------------------------------------
// F15-04：每一个「数组子节点」都要有**稳定的 key**
// ---------------------------------------------------------------------------

/**
 * 取 DOM 节点对应的 React fiber 的 `key`（`null` = 没有 key）。
 *
 * ⚠️ **为什么不用「捕获 React 告警」当唯一护栏**：
 *    React 18.3 的 key 告警是**按「声明处」去重**的
 *    （`ownerHasKeyUseWarning[声明错误信息]`，见 `react-jsx-dev-runtime` 的
 *    `getDeclarationErrorAddendum` —— 键里含**组件名 + 源码位置**）
 *    → 同一份模块实例里**只报一次** → 排在后面的用例会被「去重成 0 条告警」→ **空过**。
 *    `vi.resetModules()` 也救不了：react / react-dom 是 **externalized** 依赖，
 *    Node 的模块缓存不会被动（实测：resetModules 之后第二次渲染仍然 0 条告警）；
 *    而且去重键含**源码位置**，就算换了模块实例，键也还是同一个。
 *    → fiber 上的 `key` 是**结构性事实**：与告警去重、与用例顺序都**无关**。
 */
function reactKeyOf(element: Element | null): unknown {
  if (!element) return undefined
  const propName = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  if (!propName) return undefined
  const fiber = (element as unknown as Record<string, { key: unknown }>)[propName]
  return fiber?.key
}

/**
 * 探针组件：**故意**渲染一个缺 `key` 的数组。
 *
 * 用途只是**自证「React 的 key 告警机制在本进程里确实在工作」**（否则「没有告警」
 * 也可能是因为告警被整体关掉了）。
 *
 * ⚠️ 它**不能**证明「被测组件的那一格去重表是干净的」：React 18.3 的去重键是
 *    **声明处的错误信息**（组件名 + 源码位置，见 `react-jsx-dev-runtime` 的
 *    `getDeclarationErrorAddendum`）→ 探针与被测组件的键**必然不同**。
 *    → 下面真正**确定性**的护栏是**结构断言**（fiber 上的 key）与**源码断言**。
 */
function MissingKeyProbe(): ReactElement {
  return (
    <div>
      {[<span key="probe-ok">ok</span>, <span>缺 key</span>]}
    </div>
  )
}

describe('LyricView：渲染 key（F15-04）', () => {
  it('单行模式：每一行都有 key（结构性断言，与 React 告警去重无关）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={12} mode="single" />)

    const lines = Array.from(container.querySelectorAll('[data-index]'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // key = 歌词行的**绝对下标**（窗口滚动时行进出数组也不会错位）
      expect(reactKeyOf(line)).toBe(line.getAttribute('data-index'))
    }
  })

  it('带翻译：翻译副行节点也有 key（翻译也是「行」的数组子节点）', () => {
    const { container } = render(
      <LyricView lines={LINES_WITH_TRANSLATION} currentTime={12} mode="single" />,
    )

    const translation = container.querySelector('[data-testid="lyric-translation"]')
    expect(translation).not.toBeNull()
    // ⚠️ **鉴别力**：把翻译节点的 key 去掉 → 这里就是 null → 变红
    expect(reactKeyOf(translation)).not.toBeNull()
  })

  it('onSeek 按钮路径：key 直接写在元素上（不是塞进被展开的 props 对象）', () => {
    const { container } = render(
      <LyricView lines={LINES} currentTime={12} mode="single" onSeek={() => {}} />,
    )

    const button = container.querySelector('[data-index="0"]')
    expect(button?.tagName).toBe('BUTTON')
    expect(reactKeyOf(button)).not.toBeNull()

    // ⚠️ **顺序无关**的护栏：key 必须**直接写在元素上**，不能作为字段放进被 `{...}`
    //    展开的 props 对象（React 18.3 会对后者告警，但那条告警按「类型 + props 形状」
    //    去重 → 与用例顺序耦合 → 不能当唯一护栏）。
    const source = readFileSync(LYRIC_VIEW_SOURCE, 'utf8')
    expect(source).toMatch(/<div[^>]*\bkey=\{/)
    expect(source).toMatch(/<button[^>]*\bkey=\{/)
    expect(source).not.toMatch(/[{,]\s*key\s*:/)
  })

  it('渲染不刷 React 的 key 告警（烟幕断言：确定性护栏是上面的结构断言与源码断言）', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '))
    })
    try {
      // 探针先跑：证明「React 的 key 告警机制在本进程里确实在工作」
      render(<MissingKeyProbe />)
      expect(errors.filter((message) => message.includes('unique "key"')).length).toBeGreaterThan(0)

      errors.length = 0
      render(<LyricView lines={LINES_WITH_TRANSLATION} currentTime={12} mode="single" />)
      expect(errors.filter((message) => message.includes('unique "key"'))).toEqual([])
      expect(errors.filter((message) => message.includes('is being spread into JSX'))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

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
  // ⚠️ **前提已被推翻**（T81：伪逐字**不**渲染词级元素）→ 本断言改写为**新行为**。
  //    旧断言是「该行所有词都处于高亮态」（逐词 `--sung`）。
  //    新行为：伪逐字 ⇒ **零词元素** ⇒ 「已走满」表现为**整行**强调色（`--whole`）。
  //    ⚠️ 「真逐字下仍是逐词 `--sung`」的鉴别力由 `test/lyric-word-timed.test.ts` 补上。
  it('上一行走满后停在全满态（伪逐字 ⇒ **整行**强调色，不清空）', () => {
    // 三行歌词：甲行 10~20s、乙行 20~30s、丙行 30~30.5s
    // t=25 时甲行早已唱完（走满），乙行正在唱
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={25} mode="double" />)

    const previous = lineAt(container, 0)
    // ⚠️ 鉴别力：伪逐字 ⇒ **一个词元素都没有**（不假装逐字）。
    expect(previous.querySelectorAll('[data-word]')).toHaveLength(0)
    // ⚠️ 鉴别力：已走满的那一行**整行**是强调色。
    expect(previous.className).toContain('fnm-lyricview__line--whole')
  })

  // ⚠️ **前提已被推翻**（T81）→ 本断言改写为**新行为**。
  //    旧断言是「下一行里至少有一个词已唱到」（逐词 `--sung`）。
  //    新行为：伪逐字 ⇒ 没有词元素 ⇒ 「唱到没有」表现为**整行**有没有 `--whole`。
  it('下一行还没开始唱 → **不高亮**（伪逐字 ⇒ 整行没有 `--whole`）', () => {
    // ⚠️ 取 t=15：甲行（10~20s）正在唱，乙行（20~30s）**还没开始**。
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={15} mode="double" />)

    const previous = lineAt(container, 0)
    const next = lineAt(container, 1)
    // 正在唱的那一行：整行强调色
    expect(previous.className).toContain('fnm-lyricview__line--whole')
    // 还没唱的那一行：**没有** `--whole`
    expect(next.className).not.toContain('fnm-lyricview__line--whole')
    // ⚠️ 两行都**没有**词元素（不假装逐字）。
    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
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

  it('整页换行有**真信号**（跨越点上暴露页序号）：t=29.9 与 t=30 的页序号不同', () => {
    const { container: before } = render(
      <LyricView lines={THREE_LINES} currentTime={29.9} mode="double" />,
    )
    const { container: after } = render(
      <LyricView lines={THREE_LINES} currentTime={30} mode="double" />,
    )

    const pageIndexOf = (container: HTMLElement): string =>
      container.querySelector('[data-testid="lyric-view"]')?.getAttribute('data-page-index') ?? ''

    expect(pageIndexOf(before)).toBe('0')
    expect(pageIndexOf(after)).toBe('1')
    expect(pageIndexOf(before)).not.toBe(pageIndexOf(after))
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
// T46：当前词的额外类名（灵动态词岛的「逐字发光」用）
// ---------------------------------------------------------------------------

describe('LyricView：当前词高亮钩子（T46）', () => {
  // ⚠️ **前提已被推翻**（T81：伪逐字**不**渲染词级元素）→ 本断言改写为**新行为**。
  //    旧断言用的是**行级** LRC（`THREE_LINES` ⇒ 伪逐字）⇒ 现在那里**没有词元素**
  //    ⇒ 钩子无从挂起 ⇒ 改用**真逐字**数据（`WORD_TIMED_THREE_LINES`），
  //    断言的**原意**（「当前正在唱的词带上这个类」）**一字不减**。
  it('给了 activeWordClassName → **当前正在唱的词**带上这个类', () => {
    const { container } = render(
      <LyricView
        lines={WORD_TIMED_THREE_LINES}
        currentTime={25}
        mode="double"
        activeWordClassName="fnm-lyricview__word--active"
      />,
    )

    // t=25 时乙行（20~30s）正在唱 → 它的「当前词」该带钩子类名。
    const next = lineAt(container, 1)
    const words = Array.from(next.querySelectorAll('[data-word]'))
    const active = words.filter((word) => word.className.includes('fnm-lyricview__word--active'))
    expect(active).toHaveLength(1)
    // ⚠️ 鉴别力：当前词确实是**正在唱的那一个**（行@25s），不是别的词。
    expect(active[0]!.textContent).toBe('行')
  })

  it('不给 → **不加**任何额外类名（既有行为一字不变）', () => {
    const { container } = render(
      <LyricView lines={WORD_TIMED_THREE_LINES} currentTime={25} mode="double" />,
    )

    const next = lineAt(container, 1)
    const words = Array.from(next.querySelectorAll('[data-word]'))
    // ⚠️ 鉴别力：词元素**确实存在**（真逐字）⇒ 「没加钩子」不是因为「没东西可加」。
    expect(words.length).toBeGreaterThan(0)
    expect(words.some((word) => /fnm-lyricview__word--active/.test(word.className))).toBe(false)
  })

  it('该行已走满 → **不给**当前词加钩子（整行都是唱过的状态）', () => {
    const { container } = render(
      <LyricView
        lines={WORD_TIMED_THREE_LINES}
        currentTime={25}
        mode="double"
        activeWordClassName="fnm-lyricview__word--active"
      />,
    )

    // t=25 时甲行（10~20s）早已走满 → 它的词**全是** sung，不该再有「当前词」。
    const previous = lineAt(container, 0)
    const words = Array.from(previous.querySelectorAll('[data-word]'))
    // ⚠️ 鉴别力：词元素**确实存在**（真逐字）⇒ 「没加钩子」不是因为「没东西可加」。
    expect(words.length).toBeGreaterThan(0)
    expect(words.some((word) => /fnm-lyricview__word--active/.test(word.className))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T48：卡拉OK 渐进填色
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这一档**：词级高亮是**整词跳变**——词一到就整词变色 →
//    **每个词的边界都在「闪一下」** → 看起来不顺滑。
//    卡拉OK 是**颜色边界连续推进**（已唱部分染色、未唱部分留白）→ 才顺滑。
//
// ⚠️ **数据源是现成的**：`LyricWordProgress.wordProgress`（词内**连续**比例）。
//    本档只钉「谁挂什么类 / 比例是多少」，**不动**纯函数。
// ---------------------------------------------------------------------------

/** T48 专用：一条**逐字明确**的行（甲 0~2s、乙 2~4s、丙 4~6s）。 */
const KARAOKE_LINE: LyricLine = {
  time: 0,
  text: '甲乙丙',
  translation: '',
  words: [
    { text: '甲', start: 0, end: 2 },
    { text: '乙', start: 2, end: 4 },
    { text: '丙', start: 4, end: 6 },
  ],
}

/** 取某个词（`.fnm-lyricview__word`，带 `data-word`）。 */
function wordAt(container: HTMLElement, wordIndex: number): HTMLElement {
  const element = container.querySelector(`[data-word="${wordIndex}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

describe('LyricView：卡拉OK 渐进填色（T48）', () => {
  it('开了 karaoke → 当前词**不再整词上色**，改挂 `--karaoke`', () => {
    const { container } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={3} mode="single" karaoke />,
    )

    // t=3 → 当前词是「乙」（2~4s）
    const current = wordAt(container, 1)
    expect(current.textContent).toBe('乙')
    expect(current.className).toContain('fnm-lyricview__word--karaoke')
    // ⚠️ **不许**再整词上色：整词已是强调色 → 词内填色就看不见了。
    expect(current.className).not.toContain('fnm-lyricview__word--sung')
  })

  it('**已唱过的词照旧整词上色**，**没唱到的词不上色**', () => {
    const { container } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={3} mode="single" karaoke />,
    )

    expect(wordAt(container, 0).className).toContain('fnm-lyricview__word--sung')
    const after = wordAt(container, 2)
    expect(after.className).not.toContain('fnm-lyricview__word--sung')
    expect(after.className).not.toContain('fnm-lyricview__word--karaoke')
  })

  it('填充比例 = **词内连续比例**（t=3 时正好 50%）', () => {
    const { container } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={3} mode="single" karaoke />,
    )

    expect(wordAt(container, 1).getAttribute('data-karaoke-progress')).toBe('50.0')
  })

  it('比例随时间**连续推进**（不是整词跳变）', () => {
    const { container: early } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={2.5} mode="single" karaoke />,
    )
    expect(wordAt(early, 1).getAttribute('data-karaoke-progress')).toBe('25.0')

    const { container: middle } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={3} mode="single" karaoke />,
    )
    expect(wordAt(middle, 1).getAttribute('data-karaoke-progress')).toBe('50.0')

    const { container: late } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={3.5} mode="single" karaoke />,
    )
    expect(wordAt(late, 1).getAttribute('data-karaoke-progress')).toBe('75.0')
  })

  it('该行已走满 → **不再有**当前词（整行都是唱过的状态）', () => {
    const { container } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={8} mode="single" karaoke />,
    )

    const words = Array.from(container.querySelectorAll('[data-word]'))
    expect(words).toHaveLength(3)
    expect(words.some((word) => /fnm-lyricview__word--karaoke/.test(word.className))).toBe(false)
    expect(words.every((word) => /fnm-lyricview__word--sung/.test(word.className))).toBe(true)
  })

  it('**显式** `karaoke={false}` → 行为**一字不变**（当前词照旧整词上色，没有填色钩子）', () => {
    const { container } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={3} mode="single" karaoke={false} />,
    )

    const current = wordAt(container, 1)
    expect(current.className).toContain('fnm-lyricview__word--sung')
    expect(current.className).not.toContain('fnm-lyricview__word--karaoke')
    expect(current.getAttribute('data-karaoke-progress')).toBeNull()
  })

  // ⚠️ T71：卡拉OK 从「词岛专属」提升为「歌词视图的**默认观感**」
  //    ⇒ **缺省就是开的**（不再需要显式传 `karaoke`）。
  //    ⚠️ 「缺省」这条断言的鉴别力：把 `LyricView` 的缺省改回 `false` ⇒ 本条立刻红。
  it('**缺省**（不传 karaoke）就是卡拉OK（T71：推广到所有歌词页面）', () => {
    const { container } = render(
      <LyricView lines={[KARAOKE_LINE]} currentTime={3} mode="single" />,
    )

    const current = wordAt(container, 1)
    expect(current.className).toContain('fnm-lyricview__word--karaoke')
    expect(current.className).not.toContain('fnm-lyricview__word--sung')
    expect(current.getAttribute('data-karaoke-progress')).toBe('50.0')
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
// T46 补丁②：单行模式的**视口测量**
// ---------------------------------------------------------------------------
//
// ⚠️ **这个坑只在「歌词从空到有」时才会踩**：
//    挂载那一刻歌词还是空的 → 组件走**空态分支**（没有视口节点）→
//    量视口的 effect 拿不到节点就走了；而该 effect 的依赖若写死 `[]`，
//    **歌词到达后不会重跑** → `viewportHeight` 永远停在 0 →
//    单行模式的居中一律按**兜底高度 400** 算 → 当前行不在中间。
//
//    ⚠️ 双行模式**不受影响**（它的滚动位置恒为 0，用不到视口高度）→ 这个缺陷
//       在双行下**完全看不出来**，直到词岛改用单行模式才暴露。
//
// ⚠️ jsdom 的 `getBoundingClientRect()` 一律返回 0 → 这里**mock 成 74px**
//    才能区分「量到了真实视口」与「还在用兜底 400」。
// ---------------------------------------------------------------------------

describe('LyricView：单行模式的视口测量（T46 补丁②）', () => {
  it('歌词**从空到有**时会重新量视口（否则永远用兜底 400 → 当前行不在中间）', () => {
    const VIEWPORT_HEIGHT = 74
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: VIEWPORT_HEIGHT,
      width: 520,
      top: 0,
      left: 0,
      right: 520,
      bottom: VIEWPORT_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)

    const many = parseLrc(
      Array.from({ length: 20 }, (_, i) => `${stamp(i * 10)}占位行${i}`).join('\n'),
    )

    // 先挂载**空歌词**（此时组件走空态分支，还没有视口节点）。
    const { container, rerender } = render(<LyricView lines={[]} currentTime={0} mode="single" />)
    // 歌词到达 → 切到单行分支（此时才有视口节点，量视口的 effect 必须重跑）。
    rerender(<LyricView lines={many} currentTime={95} mode="single" />)

    const viewport = container.querySelector('[data-testid="lyric-view"]') as HTMLElement
    const scrollTop = Number(viewport.getAttribute('data-scroll-top'))

    // 第 10 行（行时间 90s，95s 落在它里面）→ 用**真实视口**算的居中位置。
    const expected =
      9 * LYRIC_LINE_HEIGHT + LYRIC_ACTIVE_LINE_HEIGHT / 2 - VIEWPORT_HEIGHT / 2
    expect(scrollTop).toBe(expected)
    // ⚠️ 用兜底 400 会算成 `9 * 34 + 22 - 200 = 128` → 两者**必须不同**。
    expect(scrollTop).not.toBe(9 * LYRIC_LINE_HEIGHT + LYRIC_ACTIVE_LINE_HEIGHT / 2 - 400 / 2)
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

// ---------------------------------------------------------------------------
// 播放条（要求 E / G / L / O）
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(index: number, overrides: Partial<Song> = {}): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
    artist: '甲',
    artistId: '',
    album: '示例专辑',
    albumId: '',
    coverId: '',
    duration: 200,
    favorite: false,
    codec: 'FLAC',
    bitrate: 900,
    sampleRate: 44100,
    bitDepth: 16,
    year: 0,
    trackNo: index,
    discNo: 1,
    ...overrides,
  }
}

/** 假引擎（只记录调用，不碰媒体栈）。 */
class FakeEngine implements PlayerEngineLike {
  state: PlayerState = {
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    error: null,
  }
  played: Song[] = []
  seeks: number[] = []
  volumes: number[] = []
  pauseCalls = 0
  resumeCalls = 0
  private stateListeners: ((state: PlayerState) => void)[] = []
  private endedListeners: ((song: Song | null) => void)[] = []

  play(song: Song): void {
    this.played.push(song)
    this.state = {
      ...this.state,
      current: song,
      isPlaying: true,
      position: 0,
      duration: song.duration,
      error: null,
    }
    this.emit()
  }

  pause(): void {
    this.pauseCalls += 1
    this.state = { ...this.state, isPlaying: false }
    this.emit()
  }

  resume(): void {
    this.resumeCalls += 1
    this.state = { ...this.state, isPlaying: true }
    this.emit()
  }

  seek(sec: number): void {
    this.seeks.push(sec)
    this.state = { ...this.state, position: sec }
    this.emit()
  }

  setVolume(v: number): void {
    this.volumes.push(v)
    this.state = { ...this.state, volume: v }
    this.emit()
  }

  setQueue(items: Song[]): void {
    this.state = { ...this.state, queue: [...items] }
  }

  setMode(mode: PlayMode): void {
    this.state = { ...this.state, mode }
  }

  onStateChange(cb: (state: PlayerState) => void): void {
    this.stateListeners.push(cb)
  }

  onEnded(cb: (song: Song | null) => void): void {
    this.endedListeners.push(cb)
  }

  emit(): void {
    for (const cb of this.stateListeners) cb(this.state)
  }
}

describe('PlayerBar：播放控制（要求 G / L）', () => {
  it('播放 / 暂停按钮反映 isPlaying，点击触发对应 action', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(makeSong(1))
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('暂停'))
    expect(engine.pauseCalls).toBe(1)

    fireEvent.click(screen.getByLabelText('播放'))
    expect(engine.resumeCalls).toBe(1)
  })

  it('下一首走 store 的 next()', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('下一首'))
    expect(store.getState().current?.title).toBe('歌2')
  })

  it('上一首走 playerStore.prev()：进度 > 3 秒 → 回到本曲开头（不是上一首）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    engine.seek(5) // 进度 > 3 秒
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('上一首'))

    // 仍然是本曲（重播 = 回到本曲开头），引擎被要求重播了一次
    expect(store.getState().current?.title).toBe('歌1')
    expect(engine.played).toHaveLength(2)
  })

  it('上一首：进度 ≤ 3 秒时才真的切到上一首', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[1]!, songs)
    engine.seek(1)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('上一首'))

    expect(store.getState().current?.title).toBe('歌1')
  })
})

describe('PlayerBar：进度条与音量（要求 G）', () => {
  it('拖动进度条：拖动中不 seek，松手才 seek（参数正确）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(makeSong(1))
    render(<PlayerBar store={store} />)

    const slider = screen.getByLabelText('播放进度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '42' } })

    // 拖动中：只显示预览时间，**不**发 seek
    expect(engine.seeks).toHaveLength(0)
    expect(screen.getByTestId('player-position').textContent).toBe('0:42')

    fireEvent.mouseUp(slider)

    expect(engine.seeks).toEqual([42])
  })

  it('松手一律提交预览位置（**含在滑块外松手**）→ 滑块外松手仍然 seek 到该位置', () => {
    // ⚠️ **口径（控制器裁定）**：松手**一律**提交预览位置，**含在滑块外松手**。
    //    这是主流播放器的行为（HTML5 range / YouTube / Spotify 都是「拖到哪松到哪」）；
    //    原始缺陷是「松手后 UI 停在预览值、实际播放位置却没变」→ 本用例钉住的是
    //    「**松手之后 UI 与播放位置一致**」，不是「滑块外松手不跳转」。
    //    ⚠️ **鉴别力**：去掉 window 级的松手监听 → `seeks` 为空 → 变红。
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(makeSong(1))
    render(<PlayerBar store={store} />)

    const slider = screen.getByLabelText('播放进度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '42' } })

    // 松手发生在滑块之外（例如用户把鼠标移出滑块再松开）→ 仍然提交 seek
    fireEvent.mouseUp(window)

    expect(engine.seeks).toEqual([42])
    // 预览态复位（不再是「预览中」的样式）
    expect(screen.getByTestId('player-position').className).not.toContain('preview')
  })

  it('音量变化触发 setVolume 且被钳制在 [0,1]', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    render(<PlayerBar store={store} />)

    const slider = screen.getByLabelText('音量') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.4' } })
    expect(engine.volumes).toContain(0.4)
    expect(store.getState().volume).toBe(0.4)

    fireEvent.change(slider, { target: { value: '9' } })
    expect(store.getState().volume).toBeLessThanOrEqual(1)
    expect(store.getState().volume).toBeGreaterThanOrEqual(0)
  })

  it('EQ 入口可点：点开就是均衡器面板（Task 5 起不再是禁用占位）', () => {
    const store = createPlayerStore(new FakeEngine())
    render(<PlayerBar store={store} />)

    const eq = screen.getByRole('button', { name: 'EQ' })
    // ⚠️ 这里原本断言的是「禁用 + 提示即将支持」——那是 Task 21 留下的**占位**行为，
    //    Task 5 把面板真正挂上之后，这条断言的前提已不成立 → 改成断言新行为。
    expect(eq.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('dialog', { name: '均衡器' })).toBeNull()

    fireEvent.click(eq)
    expect(screen.getByRole('dialog', { name: '均衡器' })).toBeTruthy()
    expect(screen.getByLabelText('预置曲线')).toBeTruthy()
  })
})

describe('PlayerBar：音质标识（要求 E）', () => {
  it('FLAC + 44.1kHz/16bit → 无损（非 Hi-Res）', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { codec: 'FLAC', sampleRate: 44100, bitDepth: 16 }))
    render(<PlayerBar store={store} />)

    expect(screen.getByTestId('player-quality').textContent).toBe('无损')
  })

  it('FLAC + 96kHz/24bit → Hi-Res', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { codec: 'FLAC', sampleRate: 96000, bitDepth: 24 }))
    render(<PlayerBar store={store} />)

    expect(screen.getByTestId('player-quality').textContent).toBe('Hi-Res')
  })

  it('MP3 → 无标识', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { codec: 'MP3', sampleRate: 44100, bitDepth: 16 }))
    render(<PlayerBar store={store} />)

    expect(screen.queryByTestId('player-quality')).toBeNull()
  })

  it('判定是纯函数（不依赖 DOM）：无损集合 + Hi-Res 规则', () => {
    expect(resolveQuality(null)).toBeNull()
    expect(resolveQuality(makeSong(1, { codec: 'MP3' }))).toBeNull()
    expect(resolveQuality(makeSong(1, { codec: 'flac' }))).toBe('lossless') // 大小写不敏感
    expect(resolveQuality(makeSong(1, { codec: 'FLAC', sampleRate: 48000 }))).toBe('hires')
    expect(resolveQuality(makeSong(1, { codec: 'FLAC', bitDepth: 24 }))).toBe('hires')
    expect(LOSSLESS_CODECS.has('FLAC')).toBe(true)
    expect(LOSSLESS_CODECS.has('MP3')).toBe(false)
  })
})

describe('PlayerBar：队列面板（要求 G）', () => {
  it('打开队列面板，显示当前队列，可切换曲目', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))

    expect(screen.getByText('歌1 · 甲')).toBeTruthy()
    fireEvent.click(screen.getByText('歌2 · 甲'))
    expect(store.getState().current?.title).toBe('歌2')
  })

  it('可以从队列里移除一首', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))
    fireEvent.click(screen.getByLabelText('从队列移除 歌1'))

    expect(store.getState().queue.map((song) => song.title)).toEqual(['歌2'])
  })

  it('移除**当前曲**时切到队列里的**下一首**（不是队列第一首）', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2), makeSong(3)]
    store.getState().playTrack(songs[1]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))
    fireEvent.click(screen.getByLabelText('从队列移除 歌2'))

    expect(store.getState().current?.title).toBe('歌3')
    expect(store.getState().queue.map((song) => song.title)).toEqual(['歌1', '歌3'])
  })

  it('移除当前曲（它在队尾）时回到队列第一首（下一首越界 → 回到开头）', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[1]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))
    fireEvent.click(screen.getByLabelText('从队列移除 歌2'))

    expect(store.getState().current?.title).toBe('歌1')
  })

  it('队列只剩一首歌时，移除按钮禁用并给出**可读提示**（不静默无反应）', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1), [makeSong(1)])
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))

    const remove = screen.getByLabelText('从队列移除 歌1')
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(remove.getAttribute('title')).toContain('只有一首歌')
    expect(screen.getByText('队列里只有一首歌，不能移除')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 全屏播放页（要求 C / F）
// ---------------------------------------------------------------------------

/** 造一条占位歌词条目。 */
function makeEntry(content: string, guid: string): LyricEntry {
  return {
    guid,
    source: 'local',
    content,
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset: 0,
  }
}

describe('FullPlayerPage：歌词（要求 C / K）', () => {
  it('没有歌词时显示「暂无歌词」（不白屏、不崩）', async () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    expect(await screen.findByText('暂无歌词')).toBeTruthy()
  })

  // ⚠️ T34：全屏页的歌词从「双行模式」改成了「**全量模式**（歌词舞台）」——
  //    前提被用户明确推翻（诉求是「全屏歌词显示**所有**歌词」）。
  //    ⚠️ **断言一字未改**（下面两行照旧），只把标题里的模式名改成事实。
  it('有歌词时用 Task 12 的 parseLyricEntries 解析并渲染（全量模式 / 歌词舞台）', async () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1))
    const api = {
      list: vi.fn(async () => [
        makeEntry('[00:10.00]甲行甲', 'g1'),
        makeEntry('[00:10.00]甲译甲', 'g2'),
      ]),
    }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    expect(await screen.findByText('甲行甲')).toBeTruthy()
    // 翻译挂在同一行下（Task 12 的合并结果）
    expect(screen.getByTestId('lyric-translation').textContent).toBe('甲译甲')
  })

  it('歌词接口失败时给出可读的错误提示（不崩）', async () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1))
    const api = {
      list: vi.fn(async () => {
        throw new Error('服务器响应异常（HTTP 500）')
      }),
    }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('FullPlayerPage：封面取色（要求 F / N）', () => {
  /** 记录被创建过的图片地址。 */
  let imageSources: string[] = []
  /** 记录设置 `src` **那一刻**的 `crossOrigin`（顺序敏感）。 */
  let crossOriginAtSrc: (string | null)[] = []
  let originalImage: typeof Image
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext

  /** 装上图片 / canvas 的替身。 */
  function stubImage(fail: boolean): void {
    class StubImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      crossOrigin: string | null = null
      set src(value: string) {
        imageSources.push(value)
        crossOriginAtSrc.push(this.crossOrigin)
        setTimeout(() => {
          if (fail) this.onerror?.()
          else this.onload?.()
        }, 0)
      }
      get src(): string {
        return ''
      }
    }
    window.Image = StubImage as unknown as typeof Image
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  }

  beforeEach(() => {
    imageSources = []
    crossOriginAtSrc = []
    originalImage = window.Image
    originalGetContext = HTMLCanvasElement.prototype.getContext
    clearCoverColorCache()
  })

  afterEach(() => {
    window.Image = originalImage
    HTMLCanvasElement.prototype.getContext = originalGetContext
    clearCoverColorCache()
  })

  it('取到色时把颜色写进 CSS 变量（背景由 CSS 变量驱动）', async () => {
    stubImage(false)
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { coverId: 'track_abc' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    await waitFor(() => {
      const style =
        document.querySelector('[data-testid="full-player"]')?.getAttribute('style') ?? ''
      expect(style).toContain('--fnm-fullplayer__tint')
    })
    expect(getCachedCoverColor('track_abc')).toBe('#0a141e')
  })

  it('取色结果按 coverId 缓存（换歌不重算）', async () => {
    stubImage(false)
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { coverId: 'track_abc' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)
    await waitFor(() => {
      expect(getCachedCoverColor('track_abc')).not.toBeUndefined()
    })

    // 换一首歌，但封面 id 不变 → 不再取色
    store.getState().playTrack(makeSong(2, { coverId: 'track_abc' }))
    await waitFor(() => {
      expect(store.getState().current?.title).toBe('歌2')
    })
    expect(imageSources).toHaveLength(1)
  })

  it('取不到色时回退到默认背景（不写 tint 变量，CSS 走语义变量）', async () => {
    stubImage(true)
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { coverId: 'track_abc' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    // ⚠️ **断言前提被推翻**（真机踩过的坑，2026-11-04）：
    //    原断言是「取色失败 → 缓存 `null`」。
    //    但那正是 bug：**一次失败就永久缓存** → 封面刚切过来还没加载好时，
    //    这首歌**到重启为止都不再取色** → 背景永远停在兜底色。
    //    ⇒ 新行为：失败**不缓存**（`undefined` = 没取成，可重试）。
    //
    // ⚠️ **不能直接断言 `toBeUndefined()`** —— 它一开始就是 undefined → 空断言。
    //    ⇒ 先等**重试真的发生**（第二次取色尝试）→ 证明第一次确实失败了，
    //    此时缓存里**仍不能**有值（失败不写缓存）。
    await waitFor(
      () => {
        expect(imageSources.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 6000 },
    )
    expect(getCachedCoverColor('track_abc')).toBeUndefined()
    const style =
      document.querySelector('[data-testid="full-player"]')?.getAttribute('style') ?? ''
    expect(style).not.toContain('--fnm-fullplayer__tint')
  })

  it('extractCoverColor：图片加载失败时解析成 null（回退默认背景）', async () => {
    stubImage(true)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBeNull()
  })

  it('extractCoverColor：取到像素时给出代表色', async () => {
    stubImage(false)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBe('#0a141e')
  })

  it('取色时给封面图片设 crossOrigin=anonymous（**在设 src 之前**）→ canvas 不会被污染', async () => {
    // 封面走 `fnm://` 代理，与页面**跨源** → 不设 crossOrigin 时 canvas 会被污染、
    // `getImageData` 抛安全错误 → 取色永远失败。
    stubImage(false)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBe('#0a141e')

    expect(crossOriginAtSrc).toEqual(['anonymous'])
  })

  it('取色失败时仍然**优雅降级**（解析成 null → 回退 CSS 变量兜底背景）', async () => {
    // 图片加载失败（onerror）→ null
    stubImage(true)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBeNull()
    // 依然带着 crossOrigin（说明失败不是「没设 crossOrigin」导致的）
    expect(crossOriginAtSrc).toEqual(['anonymous'])
  })
})

// ---------------------------------------------------------------------------
// 全屏播放页：队列移除（与播放条同一套语义）
// ---------------------------------------------------------------------------

describe('FullPlayerPage：队列移除', () => {
  it('移除**当前曲**时切到队列里的**下一首**（不是队列第一首）', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2), makeSong(3)]
    store.getState().playTrack(songs[1]!, songs)
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))
    fireEvent.click(screen.getByLabelText('从队列移除 歌2'))

    expect(store.getState().current?.title).toBe('歌3')
    expect(store.getState().queue.map((song) => song.title)).toEqual(['歌1', '歌3'])
  })

  it('队列只剩一首歌时，移除按钮禁用并给出**可读提示**（不静默无反应）', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1), [makeSong(1)])
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))

    const remove = screen.getByLabelText('从队列移除 歌1')
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(remove.getAttribute('title')).toContain('只有一首歌')
    expect(screen.getByText('队列里只有一首歌，不能移除')).toBeTruthy()
  })
})

// T68：真逐字填充的「词 / 行文本」对齐（buildSegments 语义一致性）
//
// 背景：T67 接进网易云 yrc（真逐字）后，词文本**可能含空格**
// （英文歌词间空格；整行只有**一个**词元组时那个「词」= 整行文本）。
// 修复前 `buildSegments` 的 `owner` 按「含空格长度」建、却拿它跟「去空白长度」比
// ⇒ 早退触发 ⇒ **整行退化成纯文本、完全不填色**。
//
// ⚠️ 一律用占位文本，不含真实歌词 / 真实歌曲名。
// ---------------------------------------------------------------------------

/**
 * 取行元素的**直接文本节点**（= 底层整行原文）。
 *
 * ⚠️ overlay 层（`.fnm-lyricview__overlay`）是 aria-hidden 的**着色副本**，
 *    空白在它内部是独立的 `.fnm-lyricview__space` 片段（**不带** `data-word`）
 *    ⇒ 只拼 `[data-word]` 的文本会**丢空格**，那不是缺陷、也不是回归。
 */
function baseText(container: HTMLElement): string {
  const line = container.querySelector('.fnm-lyricview__line')
  let text = ''
  for (const node of Array.from(line?.childNodes ?? [])) {
    if (node.nodeType === 3) text += node.textContent ?? ''
  }
  return text
}

/** 一个「整行只有一个词、且词文本含内部空格」的行（T68 的触发形态）。 */
const SPACED_WORD_LINE: LyricLine = {
  time: 0,
  text: 'Some text here',
  words: [{ text: 'Some text here', start: 0, end: 4 }],
  translation: '',
}

/** 两个词、词间有空格（yrc 形态：词文本各自 trim 过，行文本保留空格）。 */
const SPACED_TWO_WORDS_LINE: LyricLine = {
  time: 0,
  text: 'Hello world',
  words: [
    { text: 'Hello', start: 0, end: 1 },
    { text: 'world', start: 1, end: 2 },
  ],
  translation: '',
}

describe('LyricView：真逐字填充的词/文本对齐（T68）', () => {
  it('词文本含内部空格的行**照样逐字填充**（修复前整行不填色）', () => {
    const { container } = render(
      <LyricView lines={[SPACED_WORD_LINE]} currentTime={1} mode="single" karaoke />,
    )

    const words = Array.from(container.querySelectorAll('[data-word]'))
    // ⚠️ 修复前：`owner.length`(12) != 行文本去空白长度(10) ⇒ 早退 ⇒ **一个词元素都没有**
    expect(words.length).toBe(3)
    // 三个片段同属 yrc 的**同一个**词（wordIndex 0）⇒ 一起染色
    expect(words.map((w) => w.getAttribute('data-word'))).toEqual(['0', '0', '0'])
    // 空白被还原成独立片段（**不是**塞进词里）
    const spaces = Array.from(container.querySelectorAll('.fnm-lyricview__space'))
    expect(spaces.map((s) => s.textContent)).toEqual([' ', ' '])
    // 底层整行原文与 `line.text` 一致
    expect(baseText(container)).toBe('Some text here')
  })

  it('整行一个词时，填色比例按**真实词级时间戳**推进（1s / 4s = 25%）', () => {
    const { container } = render(
      <LyricView lines={[SPACED_WORD_LINE]} currentTime={1} mode="single" karaoke />,
    )

    const current = container.querySelector('[data-word="0"]')
    expect(current).not.toBeNull()
    expect(current!.getAttribute('data-karaoke-progress')).toBe('25.0')
  })

  it('词间的空格被还原成独立片段（拉丁文**不会**显示成「Helloworld」）', () => {
    const { container } = render(
      <LyricView lines={[SPACED_TWO_WORDS_LINE]} currentTime={0.5} mode="single" karaoke />,
    )

    const words = Array.from(container.querySelectorAll('[data-word]'))
    expect(words.length).toBe(2)
    expect(words.map((w) => w.getAttribute('data-word'))).toEqual(['0', '1'])
    const spaces = Array.from(container.querySelectorAll('.fnm-lyricview__space'))
    expect(spaces.map((s) => s.textContent)).toEqual([' '])
    expect(baseText(container)).toBe('Hello world')
  })

  it('词与行文本**确实对不上**时仍保守退化（整行纯文本，不崩、不乱填）', () => {
    const mismatched: LyricLine = {
      time: 0,
      text: 'ab',
      words: [{ text: 'xyz', start: 0, end: 1 }],
      translation: '',
    }
    const { container } = render(
      <LyricView lines={[mismatched]} currentTime={0.5} mode="single" karaoke />,
    )

    // 对不上 ⇒ 早退 ⇒ 不产生任何词元素（但整行文本照旧渲染，不白屏）
    expect(container.querySelectorAll('[data-word]').length).toBe(0)
    expect(container.textContent).toContain('ab')
  })

  // ⚠️ **前提已被推翻**（T81：伪逐字**不**渲染词级元素）→ 本断言改写为**新行为**。
  //    旧断言是「词元素 2 个 + 空格片段 1 个」（伪逐字照旧渲染词级元素）。
  //    新行为：伪逐字 ⇒ **零词元素、零空格片段**，但**行文本一字不少**（不白屏）。
  it('行级 LRC 的伪逐字路径 ⇒ **不渲染词级元素**（整行纯文本，行文本一字不少）', () => {
    const lines = parseLrc('[00:00.00]甲 乙')
    const { container } = render(<LyricView lines={lines} currentTime={0.5} mode="single" />)

    // ⚠️ 鉴别力：**零**词元素、零空格片段 ⇒ DOM 里根本没有词级钩子。
    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
    expect(container.querySelectorAll('.fnm-lyricview__space')).toHaveLength(0)
    // ⚠️ 鉴别力：**行文本照旧完整显示**（不白屏、不丢字）。
    expect(baseText(container)).toBe('甲 乙')
    // ⚠️ 当前行**整行**强调色（不假装逐字）。
    expect(lineAt(container, 0).className).toContain('fnm-lyricview__line--whole')
  })
})
