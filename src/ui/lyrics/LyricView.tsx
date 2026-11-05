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
   * - `double`：双行（两行同时在场）；
   * - `all`：全量（**歌词舞台**——所有歌词行都在场，当前行放大并逐字高亮，随播放滚动跟随）。
   */
  mode: 'single' | 'double' | 'all'
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
  const owner: number[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    for (let i = 0; i < word.text.length; i += 1) owner.push(index)
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
  } = props

  const safeLines = Array.isArray(lines) ? lines : []
  const time = typeof currentTime === 'number' && Number.isFinite(currentTime) ? currentTime : 0

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)

  // 量可视区高度（浏览器里用 ResizeObserver；jsdom 里量不到 → 用兜底常量）。
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
  }, [])

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
  slot?: 'previous' | 'next'
  style?: CssVars
  /** 「当前词」要额外挂的类名（见 `LyricViewProps.activeWordClassName`）。 */
  activeWordClassName?: string
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

  const segments = buildSegments(line)

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
    const isActiveWord =
      Boolean(options.activeWordClassName) &&
      progress !== null &&
      !progress.completed &&
      progress.wordIndex >= 0 &&
      segment.wordIndex === progress.wordIndex
    const activeClass = isActiveWord ? ` ${options.activeWordClassName as string}` : ''
    overlayContent.push(
      <span
        key={`word-${position}`}
        className={`fnm-lyricview__word${sung ? ' fnm-lyricview__word--sung' : ''}${activeClass}`}
        data-word={segment.wordIndex}
      >
        {segment.text}
      </span>,
    )
  })

  const classNames = ['fnm-lyricview__line']
  if (active) classNames.push('fnm-lyricview__line--active')
  if (slot) classNames.push(`fnm-lyricview__line--${slot}`)
  if (onSeek) classNames.push('fnm-lyricview__line--clickable')

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
    <span key="overlay" className="fnm-lyricview__overlay" aria-hidden="true">
      <span className="fnm-lyricview__overlay-inner">{overlayContent}</span>
    </span>,
  ]
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
}): ReactElement {
  return renderLine({
    line: props.line,
    index: props.index,
    progress: props.progress,
    active: props.active,
    onSeek: props.onSeek,
    showTranslation: props.showTranslation,
    activeWordClassName: props.activeWordClassName,
    style: { '--fnm-lyricview__line-top': `${props.index * LYRIC_ALL_LINE_HEIGHT}px` },
  })
})
