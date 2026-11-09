// ---------------------------------------------------------------------------
// T81：真逐字才卡拉OK，否则整行显示
// ---------------------------------------------------------------------------
//
// 用户报障「歌词时间戳又不对了」的根因（见台账「根因诊断」）：
// 当前用的 QQ 源**只能给明文行级 LRC** ⇒ 全走**伪逐字**
// ⇒ **字级时间戳是按音节权重插值编造的** ⇒ 卡拉OK 扫光「动得很认真但就是不对」。
//
// 用户决策（2026-11-10 原话）：
// 「你可以做一个判断，满足行字时间戳的歌词就用卡啦OK模式，不满足的就正常整行显示就好」
//
// ⚠️ 本文件钉四件事：
//
// 1. **判定**：解析器按「词级时间戳是不是**源给的**」给每一行打标（`wordTimed`）；
// 2. **跨进程**：这个标记必须**活着穿过 IPC 边界**
//    （`sanitizeLyricMessage` 是白名单式重建 ⇒ 不显式透传就会被洗掉
//      ⇒ 悬浮窗 / 词岛把伪逐字误判成真逐字 ⇒ **假扫光复活**）；
// 3. **呈现分流**：伪逐字 ⇒ **零**词级元素（不假装逐字）；真逐字 ⇒ 卡拉OK **一字不变**；
// 4. **三个页面一致**：词岛 / 经典浮窗 / 全屏舞台 走的是**同一个** `LyricView`。
//
// ⚠️ 测试数据一律用占位值（「甲」「乙」「占位歌名」…），不写真实歌曲名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import { sanitizeLyricMessage } from '../electron/ipc'
import { LyricOverlay } from '../src/ui/lyrics/LyricOverlay'
import { LyricView } from '../src/ui/lyrics/LyricView'
import { emptyOverlayState, mergeLyricMessage } from '../src/ui/lyrics/overlayState'
import { parseLrc, type LyricLine } from '../src/ui/lyrics/parse'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** **行级** LRC ⇒ 走伪逐字。 */
const PLAIN_LINES = parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙')

/** **真逐字** LRC（有 `<mm:ss.xx>` 标签）⇒ 走真逐字。 */
const WORD_TIMED_LINES = parseLrc(
  [
    '[00:10.00]<00:10.00>甲<00:15.00>行<00:18.00>甲',
    '[00:20.00]<00:20.00>乙<00:25.00>行<00:28.00>乙',
  ].join('\n'),
)

/** 某一行歌词的元素。 */
function lineAt(container: HTMLElement, index: number): HTMLElement {
  const element = container.querySelector(`[data-index="${index}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

// ---------------------------------------------------------------------------
// 一、解析层：判定标记
// ---------------------------------------------------------------------------

describe('T81：解析层 —— 「真逐字 / 伪逐字」的判定', () => {
  it('**行级** LRC（没有逐字标签）⇒ `wordTimed: false`（伪逐字）', () => {
    const lines = parseLrc('[00:00.00]甲乙')
    expect(lines[0]?.wordTimed).toBe(false)
    // ⚠️ 伪逐字的**数据**仍在（双行推进等纯函数还要用）—— 本任务只改**呈现**。
    expect(lines[0]?.words.length).toBeGreaterThan(0)
  })

  it('**带逐字标签**的 LRC ⇒ `wordTimed: true`（真逐字）', () => {
    const lines = parseLrc('[00:00.00]<00:00.00>甲<00:01.00>乙')
    expect(lines[0]?.wordTimed).toBe(true)
  })

  it('**逐行**判定（一份文件里两种行混存 ⇒ 各自打标）', () => {
    const lines = parseLrc('[00:00.00]<00:00.00>甲<00:01.00>乙\n[00:02.00]丙丁')
    expect(lines[0]?.wordTimed).toBe(true)
    expect(lines[1]?.wordTimed).toBe(false)
  })

  it('**缺省**（手写的 `LyricLine`、不带这个键）⇒ 按「有逐字」处理（既有行为不变）', () => {
    const handWritten: LyricLine = {
      time: 0,
      text: '甲',
      words: [{ text: '甲', start: 0, end: 1 }],
      translation: '',
    }
    expect(handWritten.wordTimed).toBeUndefined()

    const { container } = render(
      <LyricView lines={[handWritten]} currentTime={0.5} mode="single" karaoke />,
    )
    // ⚠️ 鉴别力：**照旧渲染词级元素** ⇒ 缺省没有被当成伪逐字。
    expect(container.querySelectorAll('[data-word]').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 二、跨进程：`wordTimed` 必须活着穿过 IPC 边界
// ---------------------------------------------------------------------------

describe('T81：跨进程 —— `wordTimed` 必须活着穿过 IPC 边界', () => {
  /** 造一条「track」消息。 */
  function trackMessage(wordTimed?: boolean): ReturnType<typeof sanitizeLyricMessage> {
    const line: Record<string, unknown> = {
      time: 0,
      text: '甲乙',
      words: [
        { text: '甲', start: 0, end: 1 },
        { text: '乙', start: 1, end: 2 },
      ],
      translation: '',
    }
    if (wordTimed !== undefined) line['wordTimed'] = wordTimed
    return sanitizeLyricMessage({
      kind: 'track',
      track: { id: 'song-1', title: '占位歌名', artist: '占位歌手' },
      lines: [line],
    })
  }

  it('`sanitizeLyricMessage` **保住** `wordTimed: false`（⚠️ 洗掉 ⇒ 假扫光复活）', () => {
    const message = trackMessage(false)
    expect(message).not.toBeNull()
    if (!message || message.kind !== 'track') return
    expect(message.lines[0]?.wordTimed).toBe(false)
  })

  it('`sanitizeLyricMessage` 保住 `wordTimed: true`', () => {
    const message = trackMessage(true)
    expect(message).not.toBeNull()
    if (!message || message.kind !== 'track') return
    expect(message.lines[0]?.wordTimed).toBe(true)
  })

  it('老消息（**没有**这个键）⇒ `undefined`（按「有逐字」处理，既有行为不变）', () => {
    const message = trackMessage()
    expect(message).not.toBeNull()
    if (!message || message.kind !== 'track') return
    expect(message.lines[0]?.wordTimed).toBeUndefined()
  })

  it('`mergeLyricMessage`（渲染进程合并）也**保住**', () => {
    const message = trackMessage(false)
    expect(message).not.toBeNull()
    if (!message || message.kind !== 'track') return

    const state = mergeLyricMessage(emptyOverlayState(), message, 0)
    expect(state.lines[0]?.wordTimed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 三、呈现分流
// ---------------------------------------------------------------------------

describe('T81：呈现分流 —— 伪逐字不假装逐字、真逐字一字不变', () => {
  it('伪逐字 ⇒ **零**词级元素、**零**着色层', () => {
    const { container } = render(<LyricView lines={PLAIN_LINES} currentTime={12} mode="single" />)

    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
    expect(container.querySelector('.fnm-lyricview__overlay')).toBeNull()
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
  })

  it('伪逐字 ⇒ 当前行**整行**强调色（`--whole`），其余行没有', () => {
    const { container } = render(<LyricView lines={PLAIN_LINES} currentTime={12} mode="all" />)

    expect(lineAt(container, 0).className).toContain('fnm-lyricview__line--whole')
    expect(lineAt(container, 1).className).not.toContain('fnm-lyricview__line--whole')
  })

  it('伪逐字 ⇒ 行文本**一字不少**（不白屏、不丢字）', () => {
    const { container } = render(<LyricView lines={PLAIN_LINES} currentTime={12} mode="all" />)
    expect(lineAt(container, 0).textContent).toContain('甲行甲')
  })

  it('真逐字 ⇒ 卡拉OK **一字不变**（有 `--karaoke`、有比例、**没有** `--whole`）', () => {
    const { container } = render(<LyricView lines={WORD_TIMED_LINES} currentTime={13} mode="all" />)

    const active = lineAt(container, 0)
    const karaoke = active.querySelectorAll('.fnm-lyricview__word--karaoke')
    expect(karaoke).toHaveLength(1)
    // (13-10)/(15-10) = 60%
    expect(karaoke[0]!.getAttribute('data-karaoke-progress')).toBe('60.0')
    // ⚠️ 真逐字**不走**整行强调色那条路（两套机制互斥）。
    expect(active.className).not.toContain('fnm-lyricview__line--whole')
  })
})

// ---------------------------------------------------------------------------
// 四、三个页面一致（同一个 `LyricView` ⇒ 不会漏一处）
// ---------------------------------------------------------------------------

describe('T81：三个页面一致', () => {
  it('经典悬浮窗（`LyricOverlay`）⇒ 伪逐字**没有**卡拉OK', () => {
    const { container } = render(
      <LyricOverlay
        track={{ id: 'song-1', title: '占位歌名', artist: '占位歌手' }}
        lines={PLAIN_LINES}
        position={12}
      />,
    )
    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
  })

  it('经典悬浮窗（`LyricOverlay`）⇒ 真逐字**照旧**有卡拉OK', () => {
    const { container } = render(
      <LyricOverlay
        track={{ id: 'song-1', title: '占位歌名', artist: '占位歌手' }}
        lines={WORD_TIMED_LINES}
        position={13}
      />,
    )
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).not.toBeNull()
  })

  it('全屏歌词舞台（`mode="all"`）⇒ 伪逐字**没有**卡拉OK', () => {
    const { container } = render(<LyricView lines={PLAIN_LINES} currentTime={12} mode="all" />)
    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
  })

  it('灵动态词岛（`mode="single"` + 半径 0，与 `IslandApp` 同款）⇒ 伪逐字**没有**卡拉OK', () => {
    const { container } = render(
      <LyricView lines={PLAIN_LINES} currentTime={12} mode="single" windowRadius={0} />,
    )
    expect(container.querySelectorAll('[data-word]')).toHaveLength(0)
    expect(container.querySelector('.fnm-lyricview__word--karaoke')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 五、真逐字下既有行为**一字不变**（保住被改写用例的原鉴别力）
// ---------------------------------------------------------------------------

describe('T81：真逐字下既有行为**一字不变**', () => {
  it('双行模式：上一行走满 ⇒ 该行所有词都 `--sung`（不清空）', () => {
    const { container } = render(
      <LyricView lines={WORD_TIMED_LINES} currentTime={26} mode="double" />,
    )

    // t=26：甲行（10~20s）已走满 ⇒ 它的词**全是**唱过的。
    const previous = lineAt(container, 0)
    const words = Array.from(previous.querySelectorAll('[data-word]'))
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) {
      expect(word.className).toMatch(/fnm-lyricview__word--sung/)
    }
  })

  it('双行模式：下一行同时在走 ⇒ 至少有一个词已唱到', () => {
    const { container } = render(
      <LyricView lines={WORD_TIMED_LINES} currentTime={26} mode="double" />,
    )

    // t=26：乙行（20~30s）正在唱 ⇒ 它的第一个词（20~25s）已唱完。
    const next = lineAt(container, 1)
    const words = Array.from(next.querySelectorAll('[data-word]'))
    expect(words.length).toBeGreaterThan(0)
    expect(words.some((word) => word.className.match(/fnm-lyricview__word--sung/))).toBe(true)
  })
})
