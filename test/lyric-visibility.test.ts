// T106：桌面歌词窗（经典悬浮窗）的**可见性判定**（纯函数，不依赖 Electron）。
//
// ⚠️ 为什么单独测：窗口显隐的 bug **只有真机上才看得见**（要真放一首歌、
//    真看窗口在不在）⇒ 判定逻辑必须能单测钉死。
//
// ⚠️ 本文件钉的是**三条**底线：
//    ① 「**有歌但没歌词** ⇒ 经典悬浮窗不显示」（用户 2026-11-17 的原话：
//       「匹配不到歌词也没有内嵌歌词的情况下，不要显示桌面歌词和灵动歌词」）；
//    ② 「**没歌** ⇒ 仍显示『未在播放』」（既有行为，一字不改）；
//    ③ 「**不知道**（还没收到渲染层的消息）⇒ 先不显示」——
//       否则打开时会闪一下**上一首**的歌词。

import { describe, expect, it } from 'vitest'

import { lyricTrackState, shouldShowClassicLyric } from '../electron/lyricVisibility'
import type { LyricOverlayMessage } from '../shared/playerBridge'

/** 造一条「有歌 + 有歌词」的 track 消息。 */
const trackMessage = (id: string, lines: number = 3): LyricOverlayMessage => ({
  kind: 'track',
  track: { id, title: 't', artist: 'a' },
  lines: Array.from({ length: lines }, (_, i) => ({
    time: i,
    text: `第 ${i + 1} 行`,
    words: [],
    translation: '',
  })),
})

/** 造一条「有歌但**没有歌词**」的 track 消息。 */
const noLyricTrackMessage = (id: string): LyricOverlayMessage => ({
  kind: 'track',
  track: { id, title: 't', artist: 'a' },
  lines: [],
})

/** 造一条「没歌」的 track 消息。 */
const noTrackMessage = (): LyricOverlayMessage => ({
  kind: 'track',
  track: null,
  lines: [],
})

describe('T106 曲目状态 lyricTrackState', () => {
  it('还没收到消息（null）⇒ unknown（**不知道**，不是「没有」）', () => {
    expect(lyricTrackState(null)).toBe('unknown')
  })

  it('track(track=null) ⇒ no-track（没有歌）', () => {
    expect(lyricTrackState(noTrackMessage())).toBe('no-track')
  })

  it('track(有歌) ⇒ has-track', () => {
    expect(lyricTrackState(trackMessage('s1'))).toBe('has-track')
  })

  it('⚠️ 「有歌但没歌词」**仍然是** has-track（有没有歌词是另一个维度）', () => {
    expect(lyricTrackState(noLyricTrackMessage('s2'))).toBe('has-track')
  })
})

describe('T106 经典悬浮窗可见性判定 shouldShowClassicLyric', () => {
  it('用户关了桌面歌词 ⇒ 不显示', () => {
    expect(
      shouldShowClassicLyric({ visible: false, trackState: 'has-track', hasLyrics: true }),
    ).toBe(false)
  })

  it('T106 核心：有歌 + **没歌词** ⇒ **不显示**（不弹一个空窗）', () => {
    expect(
      shouldShowClassicLyric({ visible: true, trackState: 'has-track', hasLyrics: false }),
    ).toBe(false)
  })

  it('有歌 + 有歌词 ⇒ 显示', () => {
    expect(
      shouldShowClassicLyric({ visible: true, trackState: 'has-track', hasLyrics: true }),
    ).toBe(true)
  })

  it('没歌 ⇒ **仍然显示**（「未在播放」＝既有行为，一字不改）', () => {
    expect(
      shouldShowClassicLyric({ visible: true, trackState: 'no-track', hasLyrics: false }),
    ).toBe(true)
  })

  it('unknown（还没收到消息）⇒ 不显示（避免闪一下上一首的歌词）', () => {
    expect(
      shouldShowClassicLyric({ visible: true, trackState: 'unknown', hasLyrics: true }),
    ).toBe(false)
  })

  it('真值表完整：只有「开着 + 有歌 + 有歌词」与「开着 + 没歌」两种为真', () => {
    const combos: Array<[boolean, 'unknown' | 'no-track' | 'has-track', boolean]> = []
    for (const visible of [false, true]) {
      for (const trackState of ['unknown', 'no-track', 'has-track'] as const) {
        for (const hasLyrics of [false, true]) combos.push([visible, trackState, hasLyrics])
      }
    }
    const truthy = combos.filter(([visible, trackState, hasLyrics]) =>
      shouldShowClassicLyric({ visible, trackState, hasLyrics }),
    )
    expect(truthy).toEqual([
      [true, 'no-track', false],
      [true, 'no-track', true],
      [true, 'has-track', true],
    ])
  })
})

describe('T106 主进程状态机（纯函数模拟）', () => {
  /**
   * 模拟主进程：「收到 track 消息 ⇒ 更新状态 ⇒ 判定显隐」。
   *
   * ⚠️ 这里模拟的是**主进程**的视角：它只认渲染层推来的消息。
   */
  const step = (
    state: { visible: boolean; message: LyricOverlayMessage | null },
    message: LyricOverlayMessage | null,
  ): { shown: boolean; hasLyrics: boolean } => {
    const current = message ?? state.message
    const hasLyrics =
      current !== null && current.kind === 'track' && current.track !== null && current.lines.length > 0
    return {
      hasLyrics,
      shown: shouldShowClassicLyric({
        visible: state.visible,
        trackState: lyricTrackState(current),
        hasLyrics,
      }),
    }
  }

  it('无歌词的歌 ⇒ 不显示；换到有歌词的歌 ⇒ **自己回来**（不依赖用户再点一次）', () => {
    // 先放一首**没有歌词**的歌。
    let s = step({ visible: true, message: null }, noLyricTrackMessage('s1'))
    expect(s.hasLyrics).toBe(false)
    expect(s.shown).toBe(false)

    // 换到有歌词的那首 ⇒ 窗口自己回来。
    s = step({ visible: true, message: null }, trackMessage('s2'))
    expect(s.hasLyrics).toBe(true)
    expect(s.shown).toBe(true)
  })

  it('「关掉 ⇒ 重新打开」时状态是 unknown ⇒ 先不显示（不闪上一首的歌词）', () => {
    // 模拟：关掉时主进程把缓存**作废**了（`lastTrackMessage = null`）。
    const afterToggle = step({ visible: true, message: null }, null)
    expect(afterToggle.shown).toBe(false)
  })
})
