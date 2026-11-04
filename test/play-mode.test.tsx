// ---------------------------------------------------------------------------
// 播放模式（Task 24）
// ---------------------------------------------------------------------------
//
// 覆盖的是一个**真实缺口**：四种播放模式的**语义**早就实现完整
// （`src/player/queue.ts` + `test/queue.test.ts` 都有），
// `playerStore.setMode()` 也写好了、引擎也认 ——
// 但**播放条上没有任何按钮能点到它**，于是这个能力对用户**等于不存在**。
//
// 本文件钉三件事：
// 1. **纯逻辑**：四个模式的名字与「循环顺序」（脱离渲染直接测）；
// 2. **UI**：按钮存在、点一下切到下一个模式、四个模式都能轮到；
// 3. **真的生效**（不只是 UI 变了）：`store.mode` 真变、**引擎也收到**、
//    切歌后模式不丢、随机模式下「下一首」确实不是按顺序 +1。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { PlayerBar } from '../src/components/PlayerBar'
import {
  PLAY_MODE_CYCLE,
  PLAY_MODE_LABELS,
  nextPlayMode,
  playModeLabel,
} from '../src/components/playMode'
import { createPlayerStore } from '../src/state/playerStore'
import type { PlayerEngineLike } from '../src/player/engine'
import type { PlayMode, Song } from '../shared/types'

// ---------------------------------------------------------------------------
// 假数据
// ---------------------------------------------------------------------------

/** 构造占位歌曲。 */
function song(id: string): Song {
  return {
    id,
    title: `歌 ${id}`,
    artist: '示例歌手',
    artistId: '',
    album: '',
    albumId: '',
    coverId: '',
    duration: 100,
    favorite: false,
    codec: 'MP3',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: 0,
    trackNo: 0,
    discNo: 0,
  }
}

/** 记录「引擎收到过什么」的假引擎。 */
interface FakeEngine extends PlayerEngineLike {
  /** 引擎收到过的播放模式。 */
  modes: PlayMode[]
  /** 引擎起播过的曲目 id（按顺序）。 */
  played: string[]
}

/** 造一个假引擎。 */
function fakeEngine(): FakeEngine {
  const modes: PlayMode[] = []
  const played: string[] = []
  return {
    modes,
    played,
    play: (item: Song): void => {
      played.push(item.id)
    },
    pause: (): void => undefined,
    resume: (): void => undefined,
    seek: (): void => undefined,
    setVolume: (): void => undefined,
    setMode: (mode: PlayMode): void => {
      modes.push(mode)
    },
    onStateChange: (): void => undefined,
    onEnded: (): void => undefined,
  }
}

// ---------------------------------------------------------------------------
// 一、纯逻辑
// ---------------------------------------------------------------------------

describe('播放模式 · 纯逻辑', () => {
  it('四个模式都有**互不相同**的中文名', () => {
    const names = PLAY_MODE_CYCLE.map((mode) => PLAY_MODE_LABELS[mode])
    expect(names.every((name) => typeof name === 'string' && name.length > 0)).toBe(true)
    expect(new Set(names).size).toBe(PLAY_MODE_CYCLE.length)
  })

  it('循环顺序固定：顺序 → 随机 → 单曲循环 → 列表循环 → 顺序', () => {
    expect(nextPlayMode('sequence')).toBe('shuffle')
    expect(nextPlayMode('shuffle')).toBe('loop-one')
    expect(nextPlayMode('loop-one')).toBe('loop-list')
    expect(nextPlayMode('loop-list')).toBe('sequence')
  })

  it('非法模式兜底成「顺序播放」，**不抛错**', () => {
    expect(nextPlayMode('nope' as PlayMode)).toBe('sequence')
    expect(playModeLabel(undefined)).toBe(PLAY_MODE_LABELS.sequence)
    expect(playModeLabel(null)).toBe(PLAY_MODE_LABELS.sequence)
  })
})

// ---------------------------------------------------------------------------
// 二、播放条上的模式按钮
// ---------------------------------------------------------------------------

describe('播放条 · 模式按钮', () => {
  it('默认显示「顺序播放」，并带 data-mode', () => {
    const engine = fakeEngine()
    const store = createPlayerStore(engine)
    render(<PlayerBar store={store} />)

    const button = screen.getByTestId('play-mode-button')
    expect(button.textContent).toBe('顺序播放')
    expect(button.getAttribute('data-mode')).toBe('sequence')
    expect(store.getState().mode).toBe('sequence')
  })

  it('点一次切到「随机播放」，四个模式依次轮转，一圈后回到「顺序播放」', () => {
    const engine = fakeEngine()
    const store = createPlayerStore(engine)
    render(<PlayerBar store={store} />)

    const button = screen.getByTestId('play-mode-button')
    const expected = ['随机播放', '单曲循环', '列表循环', '顺序播放']
    for (const label of expected) {
      fireEvent.click(button)
      expect(button.textContent).toBe(label)
      expect(button.getAttribute('data-mode')).toBe(
        PLAY_MODE_CYCLE.find((mode) => PLAY_MODE_LABELS[mode] === label),
      )
    }
    // 一圈之后回到起点。
    expect(store.getState().mode).toBe('sequence')
  })

  it('按钮的无障碍标签里带**当前模式**（读屏用户能知道现在是什么模式）', () => {
    const engine = fakeEngine()
    const store = createPlayerStore(engine)
    render(<PlayerBar store={store} />)

    const button = screen.getByTestId('play-mode-button')
    expect(button.getAttribute('aria-label')).toContain('顺序播放')
    fireEvent.click(button)
    expect(button.getAttribute('aria-label')).toContain('随机播放')
  })
})

// ---------------------------------------------------------------------------
// 三、模式真的生效（不只是 UI 变了）
// ---------------------------------------------------------------------------

describe('播放模式 · 真的生效', () => {
  it('点按钮 → store 的 mode 变了，**引擎也收到了**', () => {
    const engine = fakeEngine()
    const store = createPlayerStore(engine)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByTestId('play-mode-button'))

    expect(store.getState().mode).toBe('shuffle')
    expect(engine.modes).toEqual(['shuffle'])
  })

  it('切歌后模式不丢（换歌 ≠ 换模式）', () => {
    const engine = fakeEngine()
    const store = createPlayerStore(engine)
    store.getState().setMode('shuffle')

    const list = [song('a'), song('b'), song('c')]
    store.getState().playTrack(list[0] as Song, list)

    expect(store.getState().mode).toBe('shuffle')
  })

  it('随机模式下「下一首」**不是**按顺序 +1（否则随机播放等于顺序播放）', () => {
    const engine = fakeEngine()
    const store = createPlayerStore(engine)

    const list = [song('a'), song('b'), song('c'), song('d'), song('e')]
    store.getState().playTrack(list[0] as Song, list)
    store.getState().setMode('shuffle')

    const order = list.map((item) => item.id)
    engine.played.length = 0
    for (let i = 0; i < 40; i += 1) store.getState().next()

    // 每次都应落在队列里；且**不可能 40 次全是「顺序 +1」**
    // （随机取的是「除当前曲以外」的 4 首之一，全中的概率是 (1/4)^40）。
    const indices = engine.played.map((id) => order.indexOf(id))
    expect(indices.every((index) => index >= 0)).toBe(true)
    const allSequential = indices.every((index, position) => {
      if (position === 0) return true
      const previous = indices[position - 1] as number
      return index === (previous + 1) % order.length
    })
    expect(allSequential).toBe(false)
  })
})
