// T69：灵动态词岛的**可见性判定**（纯函数，不依赖 Electron）。
//
// ⚠️ 为什么单独测：窗口显隐的 bug **只有真机上才看得见**（要真放一首歌、
//    真按暂停、真看胶囊在不在）⇒ 判定逻辑必须能单测钉死。
//
// ⚠️ 本文件钉的是**两条**底线：
//    ① 「没在播 ⇒ 词岛不显示」；
//    ② 「暂停隐藏**不能**用 `setLyricVisible(false)` 实现」——否则渲染层
//       `enabled = false` ⇒ 不再推 `lyric:state` ⇒ **恢复播放后词岛永不再现（死锁）**。

import { describe, expect, it } from 'vitest'

import { playingFromLyricMessage, shouldShowIsland } from '../electron/islandVisibility'
import type { LyricOverlayMessage } from '../shared/playerBridge'

/** 造一条「有歌」的 track 消息（只关心 kind / track 的形状）。 */
const trackMessage = (id: string): LyricOverlayMessage => ({
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

/** 造一条 progress 消息。 */
const progressMessage = (isPlaying: boolean): LyricOverlayMessage => ({
  kind: 'progress',
  position: 12.5,
  isPlaying,
})

describe('T69 词岛可见性判定 shouldShowIsland', () => {
  it('开着 + 词岛形态 + 正在播放 ⇒ 显示', () => {
    expect(shouldShowIsland({ visible: true, mode: 'island', playing: true })).toBe(true)
  })

  it('用户关了桌面歌词 ⇒ 不显示', () => {
    expect(shouldShowIsland({ visible: false, mode: 'island', playing: true })).toBe(false)
  })

  it('经典悬浮窗形态 ⇒ 不显示（经典窗的行为一字不变）', () => {
    expect(shouldShowIsland({ visible: true, mode: 'classic', playing: true })).toBe(false)
  })

  it('没在播放 ⇒ 不显示', () => {
    expect(shouldShowIsland({ visible: true, mode: 'island', playing: false })).toBe(false)
  })

  it('三个条件全不满足 ⇒ 不显示', () => {
    expect(shouldShowIsland({ visible: false, mode: 'classic', playing: false })).toBe(false)
  })

  it('真值表完整：只有 (true, island, true) 一种组合为真', () => {
    const combos: Array<[boolean, 'classic' | 'island', boolean]> = []
    for (const visible of [false, true]) {
      for (const mode of ['classic', 'island'] as const) {
        for (const playing of [false, true]) combos.push([visible, mode, playing])
      }
    }
    const truthy = combos.filter(([visible, mode, playing]) =>
      shouldShowIsland({ visible, mode, playing }),
    )
    expect(truthy).toEqual([[true, 'island', true]])
  })
})

describe('T69 从歌词消息推播放状态 playingFromLyricMessage', () => {
  it('progress(isPlaying=true) ⇒ 置为 true', () => {
    expect(playingFromLyricMessage(progressMessage(true), false)).toBe(true)
  })

  it('progress(isPlaying=false) ⇒ 置为 false', () => {
    expect(playingFromLyricMessage(progressMessage(false), true)).toBe(false)
  })

  it('track(track=null) ⇒ 置为 false（没有歌 ⇒ 不可能在播）', () => {
    expect(playingFromLyricMessage(noTrackMessage(), true)).toBe(false)
  })

  it('track(有歌) ⇒ 保持原值 true（切歌不代表播放状态变了）', () => {
    expect(playingFromLyricMessage(trackMessage('s1'), true)).toBe(true)
  })

  it('track(有歌) ⇒ 保持原值 false（切歌不代表开始播了）', () => {
    expect(playingFromLyricMessage(trackMessage('s1'), false)).toBe(false)
  })
})

describe('T69 主进程状态机（纯函数模拟）', () => {
  /**
   * 模拟主进程的「播放状态 + 可见性」推进。
   *
   * ⚠️ 这是本任务**最关键的一条**：暂停必须能收回来，
   *    而且**绝不能**因为暂停就把渲染层一起关掉（那就永远收不回来了）。
   */
  const step = (
    state: { playing: boolean; visible: boolean; mode: 'classic' | 'island' },
    message: LyricOverlayMessage,
  ): { playing: boolean; islandShown: boolean } => {
    const playing = playingFromLyricMessage(message, state.playing)
    return {
      playing,
      islandShown: shouldShowIsland({
        visible: state.visible,
        mode: state.mode,
        playing,
      }),
    }
  }

  it('暂停 ⇒ 词岛收起；恢复播放 ⇒ 词岛**重新出现**（无死锁）', () => {
    const base = { playing: false, visible: true, mode: 'island' as const }

    // 开始播放 ⇒ 出现
    let s = step(base, progressMessage(true))
    expect(s.islandShown).toBe(true)

    // 暂停 ⇒ 收起
    s = step({ ...base, playing: s.playing }, progressMessage(false))
    expect(s.islandShown).toBe(false)

    // 恢复播放 ⇒ **重新出现**（这一条是死锁的判据）
    s = step({ ...base, playing: s.playing }, progressMessage(true))
    expect(s.islandShown).toBe(true)
  })

  it('切歌（有歌、保持原值）不会让词岛凭空出现', () => {
    const s = step({ playing: false, visible: true, mode: 'island' }, trackMessage('s1'))
    expect(s.playing).toBe(false)
    expect(s.islandShown).toBe(false)
  })

  it('切到没歌 ⇒ 词岛收起（即便之前在播）', () => {
    const s = step({ playing: true, visible: true, mode: 'island' }, noTrackMessage())
    expect(s.playing).toBe(false)
    expect(s.islandShown).toBe(false)
  })

  it('经典形态：播放状态照常跟踪，但词岛永远不显示', () => {
    const s = step({ playing: false, visible: true, mode: 'classic' }, progressMessage(true))
    expect(s.playing).toBe(true)
    expect(s.islandShown).toBe(false)
  })
})
