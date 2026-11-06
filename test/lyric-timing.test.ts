// ---------------------------------------------------------------------------
// T66：歌词对时 —— 输出延迟补偿
//
// 覆盖：
// - `src/ui/lyrics/timing.ts`：秒 → 毫秒换算（**读不到就回落 0，绝不猜**）、
//   施加到歌词行数组上（**正数 = 延后**）；
// - `src/player/engine.ts`：从 WebAudio 上下文 / 媒体元素读输出延迟（**取第一个非零的
//   可用值，绝不叠加**）；
// - `src/state/playerStore.ts`：引擎状态 → store 的延迟同步；
// - `src/player/lyricOverlay.ts`：换输出设备（延迟变了）→ **重推**（**不重新取歌词**）。
//
// ⚠️ 全部数据都是**虚构占位**（'song-1' / '占位歌词'…），不含任何真实 FN ID / 账号 / 口令。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'

import {
  applyAudibleLatency,
  audibleLatencyMs,
  MAX_AUDIBLE_LATENCY_MS,
} from '../src/ui/lyrics/timing'
import { parseLrc } from '../src/ui/lyrics/parse'
import {
  PlayerEngine,
  type AudioContextLike,
  type AudioNodeLike,
  type GainNodeLike,
  type MediaElementLike,
  type MediaElementSourceLike,
} from '../src/player/engine'
import { createPlayerStore } from '../src/state/playerStore'
import { installLyricOverlay } from '../src/player/lyricOverlay'
import type { LyricEntry } from '../src/api/types'
import type { LyricOverlayMessage } from '../shared/playerBridge'
import type { Song } from '../shared/types'

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

/** 占位歌曲。 */
const SONG: Song = {
  id: 'song-1',
  title: '占位歌名',
  artist: '占位歌手',
  artistId: '',
  album: '',
  albumId: '',
  coverId: '',
  duration: 100,
  favorite: false,
  codec: 'FLAC',
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 0,
  discNo: 0,
}

/** 一条占位歌词条目（行级 LRC，无真实内容）。 */
function entry(content: string, offset = 0): LyricEntry {
  return {
    guid: 'example-guid',
    source: 'local',
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset,
    content,
  }
}

/** 假媒体元素（**带** `outputLatency`，用于验证引擎取值优先级）。 */
class FakeElement implements MediaElementLike {
  src = ''
  preload = ''
  currentTime = 0
  duration = 0
  paused = true
  volume = 1
  muted = false
  /** 上报的输出延迟（秒）；`undefined` = 浏览器没这个值。 */
  outputLatency: number | undefined = undefined

  play(): Promise<void> | void {
    return undefined
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(): void {
    /* 不需要 */
  }
  removeEventListener(): void {
    /* 不需要 */
  }
}

/** 假 WebAudio 节点。 */
const fakeNode: AudioNodeLike = {
  connect: () => undefined,
  disconnect: () => undefined,
}

/** 假 AudioContext（带 `outputLatency` / `baseLatency`）。 */
class FakeContext implements AudioContextLike {
  state = 'running'
  destination = fakeNode
  /** 上报的设备输出延迟（秒）。 */
  outputLatency: number | undefined = undefined
  /** 上报的图处理延迟（秒）。 */
  baseLatency: number | undefined = undefined

  createGain(): GainNodeLike {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }
  }
  createMediaElementSource(): MediaElementSourceLike {
    return fakeNode
  }
}

/** 造一个引擎（元素与上下文都可控）。 */
function createEngine(element: FakeElement, context: FakeContext) {
  return new PlayerEngine({
    audio: element,
    createAudioContext: () => context,
    now: () => 0,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  })
}

/** 让异步流程走完（微任务 + 宏任务）。 */
async function tick(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 假播放器 store（可手动推进状态）。 */
function fakeStore(initial: {
  current: Song | null
  position: number
  isPlaying: boolean
  outputLatencySec?: number
}) {
  let state = initial
  const listeners = new Set<(s: typeof state, p: typeof state) => void>()
  return {
    getState: () => state,
    subscribe(listener: (s: typeof state, p: typeof state) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: Partial<typeof state>): void {
      const prev = state
      state = { ...state, ...next }
      for (const listener of listeners) listener(state, prev)
    },
  }
}

/** 假桥（记录消息；可手动触发可见性变化）。 */
function fakeBridge() {
  const messages: LyricOverlayMessage[] = []
  let visibility: ((visible: boolean) => void) | null = null
  return {
    messages,
    bridge: {
      pushLyricState: (message: LyricOverlayMessage) => {
        messages.push(message)
      },
      onLyricVisibility: (handler: (visible: boolean) => void) => {
        visibility = handler
        return () => {
          visibility = null
        }
      },
      getPrefs: async () => ({ lyricOverlay: { visible: false } }),
    },
    setVisible(visible: boolean): void {
      visibility?.(visible)
    },
  }
}

// ---------------------------------------------------------------------------
// 延迟换算
// ---------------------------------------------------------------------------

describe('可听延迟换算（audibleLatencyMs）', () => {
  it('缺失 / 非法 / ≤ 0 → **回落 0**（绝不猜）', () => {
    expect(audibleLatencyMs(undefined)).toBe(0)
    expect(audibleLatencyMs(null)).toBe(0)
    expect(audibleLatencyMs(Number.NaN)).toBe(0)
    expect(audibleLatencyMs(Number.POSITIVE_INFINITY)).toBe(0)
    expect(audibleLatencyMs(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(audibleLatencyMs(-0.1)).toBe(0)
    expect(audibleLatencyMs(0)).toBe(0)
  })

  it('秒 → 毫秒（按毫秒取整）', () => {
    expect(audibleLatencyMs(0.2)).toBe(200)
    expect(audibleLatencyMs(0.1234)).toBe(123)
    expect(audibleLatencyMs(0.0004)).toBe(0)
  })

  it('离谱值钳到上限（宁可不补偿也不把歌词推飞）', () => {
    expect(MAX_AUDIBLE_LATENCY_MS).toBe(1000)
    expect(audibleLatencyMs(5)).toBe(1000)
    expect(audibleLatencyMs(100)).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// 施加到歌词行
// ---------------------------------------------------------------------------

describe('歌词行的可听延迟补偿（applyAudibleLatency）', () => {
  it('延迟 0 → 时间戳**一字不变**', () => {
    const lines = parseLrc('[00:10.00]甲乙\n[00:20.00]丙')
    const shifted = applyAudibleLatency(lines, 0)
    expect(shifted.map((line) => line.time)).toEqual(lines.map((line) => line.time))
    expect(shifted[0]!.words.map((word) => word.start)).toEqual(
      lines[0]!.words.map((word) => word.start),
    )
    expect(shifted[0]!.words.map((word) => word.end)).toEqual(
      lines[0]!.words.map((word) => word.end),
    )
  })

  it('延迟 200ms → 整份歌词**延后**（行与词同步）', () => {
    const lines = parseLrc('[00:10.00]甲乙\n[00:20.00]丙')
    const shifted = applyAudibleLatency(lines, 0.2)
    expect(shifted[0]!.time).toBeCloseTo(10.2, 6)
    expect(shifted[0]!.words[0]!.start).toBeCloseTo(10.2, 6)
    expect(shifted[1]!.time).toBeCloseTo(20.2, 6)
  })

  it('**负延迟 → 回落 0**（输出延迟不可能为负；「提前」由 LRC 的 `[offset:-N]` 负责）', () => {
    const lines = parseLrc('[00:10.00]甲')
    const shifted = applyAudibleLatency(lines, -0.5)
    expect(shifted[0]!.time).toBeCloseTo(10, 6)
  })

  it('补偿后仍**严格单调递增**（行与词）', () => {
    const lines = parseLrc('[00:10.00]甲乙丙\n[00:20.00]丁')
    const shifted = applyAudibleLatency(lines, 0.2)
    expect(shifted[1]!.time).toBeGreaterThan(shifted[0]!.time)
    for (const line of shifted) {
      for (let i = 1; i < line.words.length; i++) {
        expect(line.words[i]!.start).toBeGreaterThan(line.words[i - 1]!.start)
        expect(line.words[i]!.end).toBeGreaterThan(line.words[i - 1]!.end)
      }
      for (const word of line.words) {
        expect(word.end).toBeGreaterThan(word.start)
      }
    }
  })

  it('离谱的大延迟 → **钳到上限**且仍严格单调（不会把歌词推飞）', () => {
    const lines = parseLrc('[00:05.00]甲乙\n[00:06.00]丙')
    const shifted = applyAudibleLatency(lines, 10)
    expect(shifted[0]!.time).toBeCloseTo(6, 6)
    expect(shifted[1]!.time).toBeGreaterThan(shifted[0]!.time)
    for (const word of shifted[0]!.words) {
      expect(word.end).toBeGreaterThan(word.start)
    }
  })

  it('空数组 → 空数组', () => {
    expect(applyAudibleLatency([], 0.2)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 引擎取值
// ---------------------------------------------------------------------------

describe('引擎：读输出延迟', () => {
  it('**WebAudio 上下文优先**：设备延迟 + 图处理延迟', () => {
    const element = new FakeElement()
    const context = new FakeContext()
    context.outputLatency = 0.12
    context.baseLatency = 0.01
    element.outputLatency = 0.05
    const engine = createEngine(element, context)
    engine.play(SONG)
    expect(engine.state.outputLatencySec).toBeCloseTo(0.13, 6)
  })

  it('上下文**没有**延迟 → 回落媒体元素的延迟', () => {
    const element = new FakeElement()
    const context = new FakeContext()
    element.outputLatency = 0.05
    const engine = createEngine(element, context)
    engine.play(SONG)
    expect(engine.state.outputLatencySec).toBeCloseTo(0.05, 6)
  })

  it('两边都拿不到 → **0**（不猜）', () => {
    const engine = createEngine(new FakeElement(), new FakeContext())
    engine.play(SONG)
    expect(engine.state.outputLatencySec).toBe(0)
  })

  it('**只取一个来源**（绝不叠加：上下文的延迟已含元素侧）', () => {
    const element = new FakeElement()
    const context = new FakeContext()
    context.outputLatency = 0.1
    context.baseLatency = 0
    element.outputLatency = 0.08
    const engine = createEngine(element, context)
    engine.play(SONG)
    // 0.1（不是 0.1 + 0.08）
    expect(engine.state.outputLatencySec).toBeCloseTo(0.1, 6)
  })
})

describe('store：同步输出延迟', () => {
  it('引擎状态变化 → store 拿到延迟（界面据此补偿歌词）', () => {
    const element = new FakeElement()
    const context = new FakeContext()
    context.outputLatency = 0.12
    context.baseLatency = 0.01
    const engine = createEngine(element, context)
    const store = createPlayerStore(engine)
    engine.play(SONG)
    expect(store.getState().outputLatencySec).toBeCloseTo(0.13, 6)
  })
})

// ---------------------------------------------------------------------------
// 悬浮窗：换输出设备后重推
// ---------------------------------------------------------------------------

describe('悬浮歌词：换输出设备 → 重推（不重新取歌词）', () => {
  it('延迟变了 → 重推 track 消息（行时间随之后移），**不重新拉 NAS**', async () => {
    const api = { list: vi.fn(async () => [entry('[00:10.00]占位歌词\n[00:20.00]下一句')]) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    await tick()

    expect(api.list).toHaveBeenCalledTimes(1)
    const first = messages.find((message) => message.kind === 'track')
    expect(first?.kind).toBe('track')
    if (first?.kind === 'track') {
      expect(first.lines[0]!.time).toBeCloseTo(10, 6)
    }

    // 换输出设备 → 延迟变了。
    store.set({ outputLatencySec: 0.2 })
    await tick()

    const tracks = messages.filter(
      (message): message is Extract<LyricOverlayMessage, { kind: 'track' }> => message.kind === 'track',
    )
    expect(tracks.length).toBeGreaterThanOrEqual(2)
    const last = tracks[tracks.length - 1]!
    expect(last.lines[0]!.time).toBeCloseTo(10.2, 6)
    // ⚠️ **不重新拉 NAS**（换设备不该再打一次服务端）。
    expect(api.list).toHaveBeenCalledTimes(1)
    handle?.dispose()
  })

  it('延迟没变 → **不重推**（不制造无谓的消息）', async () => {
    const api = { list: vi.fn(async () => [entry('[00:10.00]占位歌词')]) }
    const store = fakeStore({ current: SONG, position: 0, isPlaying: false })
    const { bridge, setVisible, messages } = fakeBridge()

    const handle = installLyricOverlay({ bridge, api, store: store as never })
    setVisible(true)
    await tick()
    await tick()

    const before = messages.filter((message) => message.kind === 'track').length
    store.set({ position: 3 })
    await tick()
    const after = messages.filter((message) => message.kind === 'track').length
    expect(after).toBe(before)
    handle?.dispose()
  })
})
