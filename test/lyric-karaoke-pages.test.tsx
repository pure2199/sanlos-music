// ---------------------------------------------------------------------------
// T71：卡拉OK 渐进填色 + 行/字时间戳 —— 推广到所有歌词页面
// ---------------------------------------------------------------------------
//
// 用户指令：**「将灵动歌词的卡啦OK模式和行字时间戳功能拓展到所有歌词页面」**。
//
// ⚠️ 本文件钉两件事：
//
// 1. **产品行为**：三个歌词页面（灵动态词岛 / 经典悬浮窗 / 全屏歌词舞台）
//    **都**是卡拉OK 观感 —— 缺省即开（T71），不再只有词岛有。
//
// 2. **行/字时间戳的贯通**：词级时间戳要走
//    `yrcToEnhancedLrc` → `parseLyricEntries` → `sanitizeLyricMessage`（主进程清洗）
//    → `mergeLyricMessage`（渲染进程合并）→ `LyricView`。
//    中间**任何一环**把 `words[].start / end` 洗掉，界面就**静默退化成行级**
//    （卡拉OK 还在，但推进是「假」的）—— 肉眼极难发现 ⇒ 必须有回归钉子。
//
// ⚠️ 测试数据一律用占位值（「甲」「乙」「占位歌名」…），不写真实歌曲名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import { sanitizeLyricMessage } from '../electron/ipc'
import { yrcToEnhancedLrc } from '../electron/lyricProvider'
import { LyricOverlay } from '../src/ui/lyrics/LyricOverlay'
import { LyricView } from '../src/ui/lyrics/LyricView'
import { emptyOverlayState, mergeLyricMessage } from '../src/ui/lyrics/overlayState'
import { parseLyricEntries, type LyricLine } from '../src/ui/lyrics/parse'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/**
 * 按**实测结构**造的 yrc 样本（文本是占位）。
 *
 * 实测结构（2026-11-06，匿名请求）：
 *   `[行开始ms,行时长ms](词开始ms,词时长ms,0)词文本…`
 * - 词时间是**绝对毫秒**、跨行连续递增；
 * - 词元组**之间没有分隔符**；
 * - 词时长可以为 0（标点 / 停顿占位）。
 *
 * ⚠️ 刻意造出**不等长**的词（甲 1s / 乙 2s）⇒ 填色比例能被真逐字区分开：
 *    若哪天退化成「按词数均分」或「按音节推算」，比例就对不上 ⇒ 测试会红。
 */
const YRC_SAMPLE = [
  '[0,2000](0,1000,0)甲(1000,1000,0)乙',
  '[3000,2000](3000,1000,0)丙(4000,1000,0)丁',
].join('\n')

/** yrc → 增强 LRC → 解析成歌词行（**真逐字**：一行多个词，词级时间各不相同）。 */
function parseYrc(): LyricLine[] {
  const enhanced = yrcToEnhancedLrc(YRC_SAMPLE)
  return parseLyricEntries([
    {
      guid: 'external:song-1:original',
      source: 'netease',
      content: enhanced,
      createdAt: null,
      updatedAt: null,
      isLRC: true,
      offset: 0,
    },
  ])
}

/** 真逐字解析出来的歌词行（解析是纯函数，模块级算一次就够）。 */
const LINES = parseYrc()

/** 取某个词元素（`data-word` = 该行内的词下标）。 */
function wordAt(container: HTMLElement, wordIndex: number): HTMLElement {
  const element = container.querySelector(`[data-word="${wordIndex}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

/** 造一条「曲目 + 歌词」消息（走主进程清洗的那条路）。 */
function trackMessage(): ReturnType<typeof sanitizeLyricMessage> {
  return sanitizeLyricMessage({
    kind: 'track',
    track: { id: 'song-1', title: '占位歌名', artist: '占位歌手' },
    lines: LINES,
  })
}

// ---------------------------------------------------------------------------
// 一、三个歌词页面都是卡拉OK
// ---------------------------------------------------------------------------

describe('T71：卡拉OK —— 所有歌词页面一致', () => {
  it('灵动态词岛（single）：当前词是**卡拉OK 填色**', () => {
    // ⚠️ 词岛的真实渲染在 `src/island/IslandApp.tsx`
    //    （`<LyricView mode="single" windowRadius={0} karaoke />`），
    //    由 `test/lyric-island-app.test.tsx` 覆盖；
    //    这里用**同样的用法**复刻 ⇒ 证明「同一个组件 + 同一个缺省」⇒ 三处行为必然一致。
    const { container } = render(
      <LyricView lines={LINES} currentTime={1.5} mode="single" windowRadius={0} />,
    )

    const karaoke = container.querySelector('.fnm-lyricview__word--karaoke')
    expect(karaoke?.textContent).toBe('乙')
    expect(karaoke?.className).not.toContain('fnm-lyricview__word--sung')
    // 乙 = 1~3s ⇒ t=1.5 ⇒ (1.5-1)/(3-1) = 25%
    expect(karaoke?.getAttribute('data-karaoke-progress')).toBe('25.0')
  })

  it('经典悬浮窗（double）：当前词是**卡拉OK 填色**', () => {
    const { container } = render(
      <LyricOverlay
        track={{ id: 'song-1', title: '占位歌名', artist: '占位歌手' }}
        lines={LINES}
        position={1.5}
      />,
    )

    const karaoke = container.querySelector('.fnm-lyricview__word--karaoke')
    expect(karaoke?.textContent).toBe('乙')
    expect(karaoke?.className).not.toContain('fnm-lyricview__word--sung')
    expect(karaoke?.getAttribute('data-karaoke-progress')).toBe('25.0')
  })

  it('全屏歌词舞台（all）：**当前行**当前词是卡拉OK；**非**当前行没有', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={1.5} mode="all" />)

    const active = container.querySelector('[data-index="0"]')
    expect(active?.querySelector('.fnm-lyricview__word--karaoke')?.textContent).toBe('乙')

    // ⚠️ 非当前行**没有**当前词 ⇒ 既没有卡拉OK，也没有整词上色。
    const other = container.querySelector('[data-index="1"]')
    expect(other?.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
    expect(other?.querySelector('.fnm-lyricview__word--sung')).toBeNull()
  })

  it('**已唱过的词**照旧整词上色（卡拉OK 只取代「当前词」那一个）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={1.5} mode="double" />)

    // ⚠️ 双行模式第 0 页 = 第 0 行（正在唱）+ 第 1 行（还没唱）。
    //    第 0 行里「甲」(0~1s) 已唱完 ⇒ `--sung`；「乙」正在唱 ⇒ `--karaoke`。
    const sung = container.querySelector('.fnm-lyricview__word--sung')
    expect(sung?.textContent).toBe('甲')
    expect(wordAt(container, 1).className).toContain('fnm-lyricview__word--karaoke')
  })
})

// ---------------------------------------------------------------------------
// 二、行/字时间戳的贯通（真逐字一路活到渲染）
// ---------------------------------------------------------------------------

describe('T71：行/字时间戳贯通', () => {
  it('yrc → 解析：得到的是**真逐字**（一行多个词、词级时间各不相同）', () => {
    expect(LINES[0]?.words.map((word) => word.text)).toEqual(['甲', '乙'])
    expect(LINES[0]?.words.map((word) => word.start)).toEqual([0, 1])
    // ⚠️ 词尾 = **下一个词的起点**（`assemble` 的语义）⇒ 乙 = 1~3s
    expect(LINES[0]?.words[1]?.end).toBe(3)
  })

  it('主进程清洗（IPC 边界）后，词级时间**逐字保真**', () => {
    const message = trackMessage()
    expect(message).not.toBeNull()
    if (!message || message.kind !== 'track') return

    expect(message.lines[0]?.words).toEqual(LINES[0]?.words)
    expect(message.lines[0]?.words.map((word) => word.start)).toEqual([0, 1])
    expect(message.lines[0]?.words.map((word) => word.end)).toEqual([1, 3])
  })

  it('渲染进程合并后仍带着词级时间', () => {
    const message = trackMessage()
    expect(message).not.toBeNull()
    if (!message || message.kind !== 'track') return

    const state = mergeLyricMessage(emptyOverlayState(), message, 0)
    expect(state.lines[0]?.words.map((word) => word.start)).toEqual([0, 1])
    expect(state.lines[0]?.words[1]?.end).toBe(3)
  })

  it('卡拉OK 的填色比例由**真实词级时间**决定（不是按词数均分）', () => {
    const message = trackMessage()
    expect(message).not.toBeNull()
    if (!message || message.kind !== 'track') return

    const state = mergeLyricMessage(emptyOverlayState(), message, 0)
    const { container } = render(
      <LyricView lines={state.lines} currentTime={1.5} mode="double" />,
    )

    const karaoke = container.querySelector('.fnm-lyricview__word--karaoke')
    expect(karaoke?.textContent).toBe('乙')
    // 乙 = 1~3s ⇒ t=1.5 ⇒ (1.5-1)/(3-1) = 25%
    // ⚠️ **鉴别力**：若按「词数均分」（2 个词 → 每词 1.5s），
    //    比例会是 (1.5-1)/1.5 = 33.3% ⇒ 本断言会红。
    expect(karaoke?.getAttribute('data-karaoke-progress')).toBe('25.0')
  })

  // ⚠️ **前提已被推翻**（T81：伪逐字**不**渲染词级元素）→ 本断言改写为**新行为**。
  //    旧断言是「伪逐字下也有 karaoke 填色、比例 75%」（拿它当「反向钉子」）。
  //    新行为：伪逐字 ⇒ **没有** karaoke 词、**没有**词元素、**没有**着色层
  //    ⇒ **假扫光不可能出现**；当前行改为**整行**强调色。
  //
  //    ⚠️ 「推进由**真实词级时间**决定」的鉴别力**没丢**：上一条用例
  //    （真逐字 ⇒ 25% vs 均分 33.3%）仍然在钉它。
  it('反向钉子：**伪逐字**下**没有**卡拉OK 填色（不假装逐字）', () => {
    // 只给行时间、不给词时间 ⇒ 解析器走**伪逐字**兜底（按行时长均分）。
    const noWords = parseLyricEntries([
      {
        guid: 'external:song-1:original',
        source: 'netease',
        content: '[00:00.00]甲乙\n[00:04.00]丙丁',
        createdAt: null,
        updatedAt: null,
        isLRC: true,
        offset: 0,
      },
    ])
    // ⚠️ 伪逐字的**数据**仍在（双行推进等纯函数还要用）。
    expect(noWords[0]?.words.length).toBeGreaterThan(0)
    // ⚠️ 但它被**标记**成伪逐字 ⇒ 渲染层据此分流。
    expect(noWords[0]?.wordTimed).toBe(false)

    const { container } = render(
      <LyricView lines={noWords} currentTime={1.5} mode="single" windowRadius={0} />,
    )
    // ⚠️ **鉴别力**：DOM 里**一个词元素都没有** ⇒ 卡拉OK 不可能出现在伪逐字上。
    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
    expect(container.querySelector('.fnm-lyricview__overlay')).toBeNull()
    // ⚠️ **鉴别力**：当前行**整行**是强调色（不假装逐字）。
    expect(container.querySelector('[data-index="0"]')?.className).toContain(
      'fnm-lyricview__line--whole',
    )
  })
})
