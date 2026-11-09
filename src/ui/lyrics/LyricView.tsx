// ---------------------------------------------------------------------------
// 歌词视图（Task 15）
// ---------------------------------------------------------------------------
//
// 三种模式：
// - `single`：**当前行居中放大**，逐行滚动（只渲染当前行附近的若干行）；
// - `double`：**两行同时在场** —— 上一行保持在原位走满（走满后停在全满态），
//   下一行在原位开始走，**整页走完才一起换行**；两行字号一致等粗；
// - `all`（**歌词舞台**，T34）：**所有歌词行都在场**，当前行放大并逐字高亮，
//   随播放**自动滚动跟随**。
//
// ---------------------------------------------------------------------------
// 分工（控制器追加要求 A）
// ---------------------------------------------------------------------------
// 双行的推进逻辑**全部**在 `src/ui/lyrics/doubleLine.ts`（纯函数）里；
// 本组件**只负责把它的结果渲染出来** —— Task 19（桌面悬浮歌词）复用同一个纯函数，
// 两处不会漂移。
//
// ---------------------------------------------------------------------------
// 样式约定（控制器裁定）
// ---------------------------------------------------------------------------
// 样式落在 `src/ui/lyrics/lyric-view.css`（**不是**内联 style）：
// - 内联 style 表达不了 `:hover` / `:active` / `:focus-visible` / 伪元素 / `@media`；
// - 仓库约定组件样式一律用 `var(--token)` 引用语义变量（`src/styles/tokens.css`）。
//
// 组件上发出稳定的 BEM 类名（`fnm-lyricview__*`），供样式表命中，
// 也方便 Task 18/19 做主题覆写。
//
// 真正动态、**CSS 表达不了**的少数几个值走 CSS 自定义属性（内联）：
// - `--fnm-lyricview__canvas-height`：画布总高度（随歌词行数变化）；
// - `--fnm-lyricview__line-top`：单行 / 全量模式下某一行的纵向位置（随行号变化）。
// ---------------------------------------------------------------------------

import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'

import { findActiveLine, type LyricLine } from './parse'
import { computeDoubleLineState, computeLineProgress, type LyricWordProgress } from './doubleLine'
import './lyric-view.css'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单行模式下普通歌词行的行高（像素，固定值——裁剪计算依赖它）。 */
export const LYRIC_LINE_HEIGHT = 34
/** 单行模式下当前行（放大）的高度（像素）。 */
export const LYRIC_ACTIVE_LINE_HEIGHT = 44
/** 单行模式下当前行上下各渲染几行（可视区 + 缓冲）。 */
export const LYRIC_WINDOW_RADIUS = 3
/** 量不到可视区高度时的兜底值（jsdom 里 `getBoundingClientRect()` 一律返回 0）。 */
export const LYRIC_FALLBACK_VIEWPORT_HEIGHT = 400

/**
 * 全量模式（`mode="all"`）下每行的**固定槽位高度**（像素）。
 *
 * ⚠️ **所有行等高**：当前行只是**字号更大**，**槽位不变**
 *    → 当前行往前推进时**整份列表不会上下跳**。
 *    （若当前行更高、后面的行就得下移 → 长歌每唱一句整屏都抖一下。）
 *
 * ⚠️ 这个值**必须与 `lyric-view.css` 里 `.fnm-lyricview--all` 的槽位一致**
 *    —— 与 `LYRIC_LINE_HEIGHT` / CSS 的 `line-height` 是同一套纪律。
 */
export const LYRIC_ALL_LINE_HEIGHT = 60

/** 允许写 CSS 自定义属性的 style 对象。 */
type CssVars = CSSProperties & Record<`--${string}`, string | number | undefined>

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** `LyricView` 的属性。 */
export interface LyricViewProps {
  /** 歌词行（Task 12 的 `parseLrc` / `parseLyricEntries` 的产物）。 */
  lines: LyricLine[]
  /** 当前播放位置（**秒**）。 */
  currentTime: number
  /** 点击某一行时回调（秒）—— 给了才会让歌词行可点。 */
  onSeek?: (t: number) => void
  /**
   * 呈现模式：
   * - `single`：单行（当前行居中放大，**窗口裁剪**——只渲染当前行附近若干行）；
   * - `double`：双行（两行同时在场；**上一行 / 下一行**，换行按**行末时间**）；
   * - `current`：**当前句 + 下一句**（T79：当前句 = **行首时间戳**，
   *   与 `all` 模式**同一个判定源** ⇒ 与全屏歌词舞台**同一时刻同一行**）；
   * - `all`：全量（**歌词舞台**——所有歌词行都在场，当前行放大并逐字高亮，随播放滚动跟随）。
   */
  mode: 'single' | 'double' | 'current' | 'all'
  /** 单行模式下当前行上下各渲染几行（缺省 `LYRIC_WINDOW_RADIUS`）。 */
  windowRadius?: number
  /** 没有歌词时的文案。 */
  emptyLabel?: string
  /** 附加类名。 */
  className?: string
  /**
   * 「当前正在唱的词」要额外挂上的类名（T46：灵动态词岛的逐字发光）。
   *
   * ⚠️ **缺省 = 不加任何类名** → 既有用法（主界面歌词 / 全屏歌词舞台 /
   *    经典悬浮窗）的行为**一字不变**。
   * ⚠️ 只给**正在被唱的那一个词**加；该行已走满 → **不加**（整行都是唱过的状态）。
   */
  activeWordClassName?: string
  /**
   * 「**卡拉OK模式**」：当前词**渐进填色**（T48 引入；T71 起为**默认观感**）。
   *
   * ⚠️ **缺省 = `true`**（T71）：卡拉OK 从「**词岛专属**」提升为
   *    「**歌词视图的默认观感**」⇒ 灵动态词岛 / 经典悬浮窗 / 全屏歌词舞台
   *    **三处一致**；行为只由**这一处**决定 ⇒ 将来新增歌词页面自动就是卡拉OK
   *    （不会漏一处）。要回到「整词跳变」的旧观感 ⇒ 显式传 `karaoke={false}`。
   * ⚠️ **为什么需要它**：词级高亮是**整词跳变**——词一到就整词变色 →
   *    每个词的边界都在「闪一下」。卡拉OK 是**颜色边界连续推进**
   *    （已唱部分染色、未唱部分留白），用词内的**连续比例**
   *    （`LyricWordProgress.wordProgress`）驱动 → 才顺滑。
   * ⚠️ 与 `activeWordClassName`（整词发光）是**两套机制**：开了卡拉OK 之后，
   *    当前词**不再**按「已唱到」整词上色（否则整词已是强调色，填色看不见了）。
   */
  karaoke?: boolean
}

// ---------------------------------------------------------------------------
// 逐字片段
// ---------------------------------------------------------------------------

/** 歌词行被切出来的一个片段。 */
interface WordSegment {
  /** 是不是一个「词」（`false` 是空白）。 */
  isWord: boolean
  /** 片段文本。 */
  text: string
  /** 词的序号（空白片段为 `-1`）。 */
  wordIndex: number
}

/**
 * 把一行歌词切成「词 + 空白」片段。
 *
 * ⚠️ **必须保留原文的空白**：Task 12 的伪逐字会**丢掉空白**（`splitIntoWords` 把空白当边界），
 *    所以这里按「去掉空白后的字符序列 ↔ 词的字符序列」对齐，把空白**还原**到词之间，
 *    否则拉丁文会被显示成 `helloworld`。
 *
 * 对不上（`words` 与 `text` 不匹配）时返回空数组 → 该行退化成整段纯文本（不崩）。
 */
function buildSegments(line: LyricLine): WordSegment[] {
  const words = Array.isArray(line?.words) ? line.words : []
  const text = typeof line?.text === 'string' ? line.text : ''
  if (!words.length || !text) return []

  // 去掉空白后的每个字符属于哪个词。
  //
  // ⚠️ **必须按「去空白后」的字符数构建**（T68）：
  //    ① 下面的早退判据拿 `owner.length` 去比「行文本**去空白后**的长度」；
  //    ② 第二遍循环里空白字符 `continue`、**不消耗 cursor**
  //       ⇒ `owner` 的下标语义就是「**非空白字符序号**」。
  //    ⇒ 三处必须是**同一个语义**，否则：
  //    - 词文本**含空格**时（本项目 T67 接的网易云 yrc 就有：英文歌词间空格；
  //      整行只有**一个**词元组时那个「词」= 整行文本），
  //      `owner.length` 会**大于**行文本去空白后的长度 ⇒ **早退触发 ⇒ 整行不填色**；
  //    - 词文本不含空格时（行级 LRC 的伪逐字走 `splitIntoWords`，**永不含空格**）
  //      ⇒ 去空白前后长度相同 ⇒ `owner` 与修复前**逐位相同** ⇒ 行为一字不变。
  const owner: number[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    const chars = word.text.replace(/\s+/g, '')
    for (let i = 0; i < chars.length; i += 1) owner.push(index)
  }
  const stripped = text.replace(/\s+/g, '')
  if (owner.length !== stripped.length) return []

  const segments: WordSegment[] = []
  let cursor = 0
  let buffer = ''
  let bufferIndex = -1

  const flush = (): void => {
    if (!buffer) return
    segments.push({ isWord: true, text: buffer, wordIndex: bufferIndex })
    buffer = ''
  }

  for (const ch of text) {
    if (/\s/.test(ch)) {
      flush()
      segments.push({ isWord: false, text: ch, wordIndex: -1 })
      continue
    }
    const index = owner[cursor] ?? -1
    cursor += 1
    if (index !== bufferIndex) {
      flush()
      bufferIndex = index
    }
    buffer += ch
  }
  flush()
  return segments
}

/** 这个词是否已经唱到（已唱完的词 + 当前正在唱的词）。 */
function isWordHighlighted(progress: LyricWordProgress | null, wordIndex: number): boolean {
  if (!progress) return false
  if (progress.completed) return true
  if (progress.wordIndex < 0) return false
  return wordIndex <= progress.wordIndex
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/**
 * 歌词视图。
 *
 * - `single`：当前行**居中放大**，逐行滚动；只渲染当前行附近的若干行
 *   （真实歌词动辄成百上千行，**绝不**把整份歌词塞进 DOM）；
 * - `double`：两行同时在场，推进逻辑来自 `computeDoubleLineState`（纯函数）；
 * - `all`：**整份歌词都在场**（歌词舞台），当前行放大并逐字高亮，随播放滚动跟随。
 *
 * 没有歌词时显示可读的空态（**不白屏、不崩**）。
 */
export function LyricView(props: LyricViewProps): ReactElement {
  const {
    lines,
    currentTime,
    onSeek,
    mode,
    windowRadius = LYRIC_WINDOW_RADIUS,
    emptyLabel = '暂无歌词',
    className,
    activeWordClassName,
    // ⚠️ T71：缺省 = **开**（卡拉OK 是歌词视图的**默认观感**，不再是词岛专属）。
    karaoke = true,
  } = props

  const safeLines = Array.isArray(lines) ? lines : []
  const time = typeof currentTime === 'number' && Number.isFinite(currentTime) ? currentTime : 0

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)

  // 量可视区高度（浏览器里用 ResizeObserver；jsdom 里量不到 → 用兜底常量）。
  //
  // ⚠️ **依赖里必须有 `safeLines.length`**（T46 补丁②）：
  //    挂载那一刻歌词往往还是**空的** → 组件走**空态分支**（**没有视口节点**）
  //    → 这个 effect 拿不到节点就直接走了。若依赖写死 `[]`，
  //    **歌词到达后不会重跑** → `viewportHeight` 永远停在 0 →
  //    单行模式的居中一律按**兜底高度 400** 算 → 当前行不在中间。
  //
  //    ⚠️ 双行模式**不受影响**（滚动位置恒为 0，用不到视口高度）
  //       → 这个缺陷在双行下**完全看不出来**。
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      const height = rect?.height ?? 0
      setViewportHeight((prev) => (prev === height ? prev : height))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(element)
    return () => observer.disconnect()
  }, [safeLines.length])

  // 当前行（单行 / 全量模式用；双行模式由纯函数给出「上一行 / 下一行」）。
  const activeIndex = useMemo(
    () => (safeLines.length ? findActiveLine(safeLines, time) : -1),
    [safeLines, time],
  )

  // 双行模式的推进状态（纯函数）。
  const doubleState = useMemo(
    () => (mode === 'double' ? computeDoubleLineState(safeLines, time) : null),
    [mode, safeLines, time],
  )

  const effectiveViewport = viewportHeight > 0 ? viewportHeight : LYRIC_FALLBACK_VIEWPORT_HEIGHT

  // 目标滚动位置：**当前行居中**。
  // - `single`：行高分两种（普通行 / 当前行更高 → 后续行要下移）；
  // - `all`：**所有行等高槽位**（当前行只改字号、不改槽位）→ 滚动量与行号线性对应。
  const targetScrollTop = useMemo(() => {
    if (activeIndex < 0) return 0
    if (mode === 'all') {
      const total = safeLines.length * LYRIC_ALL_LINE_HEIGHT
      const center = activeIndex * LYRIC_ALL_LINE_HEIGHT + LYRIC_ALL_LINE_HEIGHT / 2 - effectiveViewport / 2
      return Math.min(Math.max(center, 0), Math.max(0, total - effectiveViewport))
    }
    if (mode !== 'single') return 0
    const extra = LYRIC_ACTIVE_LINE_HEIGHT - LYRIC_LINE_HEIGHT
    const total = safeLines.length * LYRIC_LINE_HEIGHT + extra
    const center = activeIndex * LYRIC_LINE_HEIGHT + LYRIC_ACTIVE_LINE_HEIGHT / 2 - effectiveViewport / 2
    return Math.min(Math.max(center, 0), Math.max(0, total - effectiveViewport))
  }, [activeIndex, effectiveViewport, mode, safeLines.length])

  // 把当前行滚到中间（浏览器里生效；jsdom 的 scrollTop 是空操作，故另用 data 属性暴露）。
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    element.scrollTop = targetScrollTop
  }, [targetScrollTop])

  const classes = className ? `fnm-lyricview ${className}` : 'fnm-lyricview'

  if (safeLines.length === 0) {
    return (
      <div className={`${classes} fnm-lyricview--empty`} data-testid="lyric-view">
        <p className="fnm-lyricview__empty">{emptyLabel}</p>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // 单行模式
  // -----------------------------------------------------------------------
  if (mode === 'single') {
    const radius = Math.max(0, windowRadius)
    const center = activeIndex < 0 ? 0 : activeIndex
    const start = Math.max(0, center - radius)
    const end = Math.min(safeLines.length - 1, center + radius)
    const extra = LYRIC_ACTIVE_LINE_HEIGHT - LYRIC_LINE_HEIGHT
    const total = safeLines.length * LYRIC_LINE_HEIGHT + extra

    const windowLines: ReactElement[] = []
    for (let index = start; index <= end; index += 1) {
      const line = safeLines[index]
      if (!line) continue
      const isActive = index === activeIndex
      const top = index * LYRIC_LINE_HEIGHT + (index > activeIndex ? extra : 0)
      windowLines.push(
        renderLine({
          line,
          index,
          progress: isActive ? computeLineProgress(line, time) : null,
          active: isActive,
          onSeek,
          activeWordClassName,
          karaoke,
          style: { '--fnm-lyricview__line-top': `${top}px` },
        }),
      )
    }

    return (
      <div
        className={`${classes} fnm-lyricview--single`}
        data-testid="lyric-view"
        role="list"
        aria-label="歌词"
        ref={viewportRef}
        data-scroll-top={targetScrollTop}
      >
        <div
          className="fnm-lyricview__canvas"
          style={{ '--fnm-lyricview__canvas-height': `${total}px` } as CssVars}
        >
          {windowLines}
        </div>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // 全量模式（歌词舞台）
  // -----------------------------------------------------------------------
  //
  // ⚠️ **为什么要单独一档**：用户要「全屏歌词显示**所有**歌词」。
  //    `single` 是**窗口裁剪**（只渲染当前行附近若干行）、`double` 只在场两行
  //    → 两者都满足不了「全部可见」。
  //
  // ⚠️ **所有行等高槽位**（`LYRIC_ALL_LINE_HEIGHT`）：当前行只是**字号更大**，
  //    **槽位不变** → 当前行推进时**整份列表不跳动**。
  //
  // ⚠️ **翻译只给当前行看**：每行都挂翻译 → 每行都被撑高 / 叠字，
  //    且**槽位等高**的前提就破了。
  if (mode === 'all') {
    //
    // ⚠️ **没有活跃行**时的翻译落点：播放位置还在**第一句歌词之前**时
    //    `findActiveLine` 返回 `-1` → 若翻译只跟活跃行走，**整屏一条翻译都不显示**
    //    （用户看到的是「只有原文」的半成品）。
    //    → 翻译**回落到第一行**（还没唱到的那句），全程始终**只有一行**带翻译
    //    → 「槽位等高」的前提依然成立。
    const translationIndex = activeIndex >= 0 ? activeIndex : 0

    const rows: ReactElement[] = []
    for (let index = 0; index < safeLines.length; index += 1) {
      const line = safeLines[index]
      if (!line) continue
      const isActive = index === activeIndex
      rows.push(
        <AllLyricLine
          key={index}
          line={line}
          index={index}
          active={isActive}
          progress={isActive ? computeLineProgress(line, time) : null}
          onSeek={onSeek}
          showTranslation={index === translationIndex}
          activeWordClassName={activeWordClassName}
          karaoke={karaoke}
        />,
      )
    }

    return (
      <div
        className={`${classes} fnm-lyricview--all`}
        data-testid="lyric-view"
        data-active-index={activeIndex}
        role="list"
        aria-label="歌词"
        ref={viewportRef}
        data-scroll-top={targetScrollTop}
      >
        <div
          className="fnm-lyricview__canvas"
          style={
            {
              '--fnm-lyricview__canvas-height': `${safeLines.length * LYRIC_ALL_LINE_HEIGHT}px`,
            } as CssVars
          }
        >
          {rows}
        </div>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // 「当前句 + 下一句」模式（T79：桌面悬浮歌词）
  // -----------------------------------------------------------------------
  //
  // ⚠️ **为什么要新开一档**（而不是改 `double` 的语义）：
  //    `double` 判「正在唱的那行」靠**行末时间**（`computeDoubleLineState`），
  //    且它显示的是 **[上一句, 正在唱的句]** ⇒
  //    - 上面那行是**已经唱完**的（与全屏歌词舞台的「当前行高亮」不是同一行）；
  //    - 推进的行在 `phase='before'` / `'after'` 之间**换位** ⇒ 扫光每句上下跳；
  //    ⇒ 与全屏歌词舞台（`mode="all"`，按**行首时间戳** `findActiveLine`）
  //      **同一时刻对不上**（实测：提前开扫 / 落后 1.5 秒都出现过）。
  //
  // ⚠️ **本档与 `all` 模式同源**：当前句 = `findActiveLine(safeLines, time)`
  //    ⇒ **同一个函数、同一个结果** ⇒ 两处**同一时刻同一行**在推进。
  //
  // ⚠️ **`double` 一字未动**（沿用 T34「加新模式再切过去」的老套路）
  //    ⇒ 它的既有语义与既有测试**一条不改**；只是生产代码不再用它。
  if (mode === 'current') {
    // ⚠️ **当前句 = 行首时间戳**（与 `mode="all"` 完全同一个判定）。
    const currentIndex = activeIndex
    const currentLine = currentIndex >= 0 ? safeLines[currentIndex] : undefined
    const nextIndex = currentIndex + 1
    const nextLine = nextIndex < safeLines.length ? safeLines[nextIndex] : undefined

    return (
      <div
        className={`${classes} fnm-lyricview--current`}
        data-testid="lyric-view"
        // ⚠️ **换行信号**：当前句的下标变了 = 换行了（与 `all` 的 `data-active-index` 同源）。
        data-current-index={currentIndex}
        role="list"
        aria-label="歌词"
      >
        {currentLine &&
          renderLine({
            line: currentLine,
            index: currentIndex,
            // ⚠️ **只有当前句推进**。
            progress: computeLineProgress(currentLine, time),
            active: true,
            onSeek,
            activeWordClassName,
            karaoke,
            slot: 'current',
          })}

        {nextLine &&
          renderLine({
            line: nextLine,
            index: nextIndex,
            // ⚠️ **下一句不给 progress** —— 否则下一句的**词级时间戳**若早于它自己的
            //    行首（真实歌词常见），它会**提前开扫** ⇒ 桌面上**两行同时在动**。
            progress: null,
            active: false,
            onSeek,
            activeWordClassName,
            karaoke,
            slot: 'next',
          })}
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // 双行模式
  // -----------------------------------------------------------------------
  const state = doubleState!
  const previousLine = state.previousIndex >= 0 ? safeLines[state.previousIndex] : undefined
  const nextLine = state.nextIndex >= 0 ? safeLines[state.nextIndex] : undefined

  // ⭐ **整页换行的真信号**（复审 I-1）：
  //    `data-page-index` = 当前页序号（第 0 页 = lines[0]/lines[1]，即「上一行」的下标），
  //    跨过换行点时它**变化**；`data-swapped-at` = 本页成为当前页的时刻。
  //    ⚠️ `data-phase` 在跨越点上**不变**（它在「上一行走满」时就翻转了）→ **别用它判换行**。
  return (
    <div
      className={`${classes} fnm-lyricview--double`}
      data-testid="lyric-view"
      data-phase={state.phase}
      data-page-index={state.previousIndex}
      data-swapped-at={state.swappedAt ?? ''}
      role="list"
      aria-label="歌词"
    >
      {previousLine &&
        renderLine({
          line: previousLine,
          index: state.previousIndex,
          progress: state.previous,
          active: false,
          onSeek,
          activeWordClassName,
          karaoke,
          slot: 'previous',
        })}

      {nextLine &&
        renderLine({
          line: nextLine,
          index: state.nextIndex,
          progress: state.next,
          active: false,
          onSeek,
          activeWordClassName,
          karaoke,
          slot: 'next',
        })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 单行渲染
// ---------------------------------------------------------------------------

/** 渲染一行歌词的参数。 */
interface RenderLineOptions {
  line: LyricLine
  index: number
  progress: LyricWordProgress | null
  active: boolean
  onSeek?: (t: number) => void
  slot?: 'previous' | 'next' | 'current'
  style?: CssVars
  /** 「当前词」要额外挂的类名（见 `LyricViewProps.activeWordClassName`）。 */
  activeWordClassName?: string
  /**
   * 卡拉OK 模式（见 `LyricViewProps.karaoke`）。
   *
   * ⚠️ `LyricView` **总是**把它显式传下来（缺省 `true`，见 `LyricViewProps.karaoke`）
   *    ⇒ 这里读到的一定是 `true` / `false`，不会是 `undefined`。
   * ⚠️ 传 `false` ⇒ 当前词照旧走「整词上色」，行为与 T71 之前**一字不变**。
   */
  karaoke?: boolean
  /**
   * 要不要渲染翻译副行。
   *
   * ⚠️ 缺省 **true**（`single` / `double` 的既有行为**一字不改**）；
   *    全量模式只给**当前行**传 `true`（没有当前行时**回落到第一行**，见 `AllLyricLine`）。
   */
  showTranslation?: boolean
}

/**
 * 渲染一行歌词。
 *
 * DOM 结构（两层）：
 * - **底层**：整行原文，作为行元素的**直接文本节点**
 *   （整行文本只有一个来源，无障碍与测试都能直接取到整行）；
 * - **上层**（`.fnm-lyricview__overlay`，`aria-hidden`）：同一段文字的逐字着色副本，
 *   已唱到的词用 `.fnm-lyricview__word--sung`。
 *
 * 两层的字号字重完全一致 → 着色层与底层的字形严丝合缝。
 *
 * ⚠️ **翻译（`line.translation`）不是「第二行歌词」**（F15-10）：
 *    翻译只是一个**副行**（`string`，**没有逐字时间**）→ **不参与推进**。
 *    双行模式的「两行」永远是**两行歌词行**（`previous` / `next`，见 `doubleLine.ts`）。
 *    （简报 B 末句「没有翻译时双行模式退化为单行」**是误写**。）
 *
 * 翻译（`line.translation` 非空时）挂在下面当副行；**没有翻译时不渲染任何空的翻译节点**
 * （不渲染空的第二行）。
 */
function renderLine(options: RenderLineOptions): ReactElement {
  const { line, index, progress, active, onSeek, slot, style } = options

  // ⚠️ **T81：这一行的词级时间戳是「源给的」还是「我们插值编的」？**
  //    - `wordTimed !== false` ⇒ **真逐字** ⇒ 现有卡拉OK 填色**一字不变**；
  //    - `wordTimed === false` ⇒ **伪逐字**（`pseudoWords()` 编的）⇒
  //      **不假装逐字**：不渲染逐字着色层，当前行**整行**用强调色。
  //
  // ⚠️ **缺省视为真逐字**（`!== false`）⇒ 既有代码与测试里**手写**的 `LyricLine`
  //    （不带这个键）⇒ 行为**一条不变**。
  const wordTimed = line.wordTimed !== false
  // ⚠️ 伪逐字时整行强调色的判据 = 「该行**已经开始**或**已走满**」
  //    ⇒ 与真逐字下「已唱过的词是强调色」**语义一致**（只是粒度从词退化成行）。
  const wholeLine =
    !wordTimed && progress !== null && (progress.completed || progress.wordIndex >= 0)

  // ⚠️ 伪逐字 ⇒ **不切片段**（切了也只会造出假的词级钩子）。
  const segments = wordTimed ? buildSegments(line) : []

  const overlayContent: ReactElement[] = []
  segments.forEach((segment, position) => {
    if (!segment.isWord) {
      overlayContent.push(
        <span key={`space-${position}`} className="fnm-lyricview__space">
          {segment.text}
        </span>,
      )
      return
    }
    const sung = isWordHighlighted(progress, segment.wordIndex)
    // ⚠️ T46：「当前正在唱的词」= `progress.wordIndex` 指向的那**一个**词。
    //    该行已走满（`completed`）→ **不加**（整行都是唱过的状态，没有「当前」可言）。
    //
    // ⚠️ T48：这里把「**是不是当前词**」与「**要不要挂哪个类**」**拆开**了：
    //    「当前词」这个事实只算一次，两个机制（整词钩子 / 卡拉OK填色）各自取用。
    const isCurrentWord =
      progress !== null &&
      !progress.completed &&
      progress.wordIndex >= 0 &&
      segment.wordIndex === progress.wordIndex
    const activeClass =
      Boolean(options.activeWordClassName) && isCurrentWord ? ` ${options.activeWordClassName as string}` : ''
    // ⚠️ T48：卡拉OK 模式下，「当前词」**不**整词上色（`--sung`）——
    //    整词已经是强调色 → 词内填色就**看不见**了。
    //    当前词改挂 `--karaoke`：由**词内连续比例**（`wordProgress`）驱动渐变填色
    //    → 颜色边界**连续推进**（不是整词跳变）→ 才顺滑。
    const karaokeWord = Boolean(options.karaoke) && isCurrentWord
    const showSung = karaokeWord ? false : sung
    const karaokeClass = karaokeWord ? ' fnm-lyricview__word--karaoke' : ''
    // ⚠️ **同时给一份 `data-` 钩子**：jsdom 的 CSSOM 对**自定义属性**不可靠
    //    （`style.getPropertyValue('--x')` 未必读得到）→ 单测一律读 data 属性
    //    （与 `data-scroll-top` 同一套纪律）。
    const karaokePercent = karaokeWord ? ((progress?.wordProgress ?? 0) * 100).toFixed(1) : null
    const karaokeStyle =
      karaokePercent === null
        ? undefined
        : ({ '--fnm-lyricview__karaoke-progress': `${karaokePercent}%` } as CssVars)
    overlayContent.push(
      <span
        key={`word-${position}`}
        className={`fnm-lyricview__word${showSung ? ' fnm-lyricview__word--sung' : ''}${karaokeClass}${activeClass}`}
        data-word={segment.wordIndex}
        data-karaoke-progress={karaokePercent ?? undefined}
        style={karaokeStyle}
      >
        {segment.text}
      </span>,
    )
  })

  const classNames = ['fnm-lyricview__line']
  if (active) classNames.push('fnm-lyricview__line--active')
  if (slot) classNames.push(`fnm-lyricview__line--${slot}`)
  if (onSeek) classNames.push('fnm-lyricview__line--clickable')
  // ⚠️ **T81**：伪逐字 ⇒ 当前行 / 已唱行**整行**强调色（不假装逐字）。
  if (wholeLine) classNames.push('fnm-lyricview__line--whole')

  // 翻译：有才渲染（**不渲染空的第二行**）。
  const showTranslation = options.showTranslation ?? true
  const translation = typeof line.translation === 'string' ? line.translation.trim() : ''
  const translationNode = showTranslation && translation ? (
    // ⚠️ **必须有 `key`**（F15-04）：翻译节点是「行元素」的**数组子节点**，
    //    没有 key → React 报 "Each child in a list should have a unique key prop"。
    <span key="translation" className="fnm-lyricview__translation" data-testid="lyric-translation">
      {translation}
    </span>
  ) : null

  // ⚠️ **key 不放进这个对象**（F15-04）：它会被 `{...rest}` **展开**进 JSX，
  //    React 18.3 对「props 对象里带 key 再展开」会告警
  //    （"A props object containing a 'key' prop is being spread into JSX"），
  //    并且要求 key **直接写在元素上**（见下面两处 `<div key={index}>` / `<button key={index}>`）。
  const rest = {
    className: classNames.join(' '),
    'data-index': index,
    style,
  }

  const body: ReactNode[] = [
    // ⚠️ 整行原文必须是行元素的**直接文本节点**（不能包一层 span）：
    //    `getByText(整行文本)` 只看直接文本节点，包一层就取不到整行了。
    //    Fragment 不产生 DOM 节点 → 文本节点仍然是行元素的直接子节点。
    <Fragment key="base">{line.text}</Fragment>,
  ]
  // ⚠️ **T81**：伪逐字 ⇒ **不渲染**逐字着色层
  //    ⇒ DOM 里没有 `[data-word]` 元素 ⇒ 没有任何词级钩子 ⇒ **假扫光不可能出现**。
  if (wordTimed) {
    body.push(
      <span key="overlay" className="fnm-lyricview__overlay" aria-hidden="true">
        <span className="fnm-lyricview__overlay-inner">{overlayContent}</span>
      </span>,
    )
  }
  if (translationNode) body.push(translationNode)

  if (!onSeek) {
    return (
      // ⚠️ **key 直接写在元素上**（F15-04）：用**歌词行的绝对下标**——
      //    窗口滚动时行会进出数组，绝对下标是稳定的（不会因为窗口移动而错位）。
      <div key={index} {...rest} role="listitem">
        {body}
      </div>
    )
  }

  return (
    <button type="button" key={index} {...rest} onClick={() => onSeek(line.time)}>
      {body}
    </button>
  )
}

// ---------------------------------------------------------------------------
// 全量模式的一行（memo 化）
// ---------------------------------------------------------------------------

/**
 * 全量模式的一行歌词（**memo 化**）。
 *
 * ⚠️ **为什么要 memo**：全量模式把**整份歌词**（真实歌可达上千行）渲染进 DOM，
 *    而 `currentTime` **每帧都在变** → 不 memo 的话每次时间推进都要重建上千个元素
 *    （长歌上就是明显的卡顿）。
 *    memo 之后：**只有当前行**（`progress` 变）会重渲染，其余行直接跳过。
 *
 * ⚠️ **样式对象在这里现算**（不作为 prop 传进来）：作为 prop 传 → 每次渲染都是
 *    **新对象** → memo 的浅比较永远不相等 → 形同没 memo。
 */
const AllLyricLine = memo(function AllLyricLine(props: {
  line: LyricLine
  index: number
  active: boolean
  progress: LyricWordProgress | null
  onSeek?: (t: number) => void
  showTranslation: boolean
  activeWordClassName?: string
  karaoke?: boolean
}): ReactElement {
  return renderLine({
    line: props.line,
    index: props.index,
    progress: props.progress,
    active: props.active,
    onSeek: props.onSeek,
    showTranslation: props.showTranslation,
    activeWordClassName: props.activeWordClassName,
    karaoke: props.karaoke,
    style: { '--fnm-lyricview__line-top': `${props.index * LYRIC_ALL_LINE_HEIGHT}px` },
  })
})
