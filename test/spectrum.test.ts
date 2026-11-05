// ---------------------------------------------------------------------------
// T47：频谱采样 —— bin 映射 / 采样器 / 启停 / 载荷校验
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这些必须能测**：词岛两端的波形柱完全由这里的产出驱动——
//    bin 映射错了（线性而不是对数、取平均而不是取最大值），
//    肉眼看只是「柱子不太对」，**没有任何运行时症状**能暴露它。
//
// ⚠️ 本文件**绝不** `new AudioContext()`：分析节点是**假实现**。
//
// ⚠️ 全部数据都是**虚构占位**，不含任何真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createSpectrumSampler,
  installSpectrum,
  toLogBins,
  type SpectrumSource,
  type SpectrumWatch,
} from '../src/player/spectrum'
import type { AnalyserNodeLike } from '../src/player/engine'
import { sanitizeSpectrumBins, SPECTRUM_BIN_COUNT } from '../shared/spectrum'

// ---------------------------------------------------------------------------
// 假实现
// ---------------------------------------------------------------------------

/** 假分析节点：频谱数据是**给定的**数组。 */
function fakeAnalyser(data: number[]): AnalyserNodeLike {
  return {
    fftSize: 2048,
    smoothingTimeConstant: 0.7,
    frequencyBinCount: data.length,
    getByteFrequencyData: (array: Uint8Array): void => {
      for (let i = 0; i < array.length; i += 1) array[i] = data[i] ?? 0
    },
    connect: (): unknown => undefined,
    disconnect: (): void => undefined,
  }
}

/** 假频谱源。 */
function fakeSource(data: number[], sampleRate = 48000): SpectrumSource {
  return { analyser: fakeAnalyser(data), sampleRate }
}

/** 假定时器：手动推进，不依赖真实时间。 */
function fakeTimers() {
  const scheduled: Array<() => void> = []
  const cancelled: number[] = []
  let nextId = 1
  return {
    createTimer: (fn: () => void): number => {
      scheduled.push(fn)
      return nextId++
    },
    cancelTimer: (handle: number): void => {
      cancelled.push(handle)
    },
    /** 触发**最后一次**排定的回调（模拟一帧）。 */
    fire: (): void => {
      scheduled[scheduled.length - 1]?.()
    },
    scheduled,
    cancelled,
  }
}

/** 假「该不该采样」观察者。 */
function fakeWatch(initial: boolean) {
  let enabled = initial
  const handlers: Array<() => void> = []
  const watch: SpectrumWatch = {
    isEnabled: () => enabled,
    subscribe: (handler: () => void) => {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
  }
  return {
    watch,
    set: (next: boolean): void => {
      enabled = next
      for (const handler of handlers.slice()) handler()
    },
  }
}

// ---------------------------------------------------------------------------
// 纯逻辑：bin 映射
// ---------------------------------------------------------------------------

describe('T47 频谱：线性 bin → 16 段对数分布', () => {
  // 48kHz + fftSize 2048 → 1024 个频率 bin，每个 ≈ 23.4375Hz。
  const SAMPLE_RATE = 48000
  const BIN_COUNT = 1024

  it('一条频谱就是 **8 段**（左右各 8 根 = 右组是左组的镜像）', () => {
    const bins = toLogBins(new Uint8Array(BIN_COUNT), BIN_COUNT, SAMPLE_RATE)
    expect(bins).toHaveLength(SPECTRUM_BIN_COUNT)
    expect(SPECTRUM_BIN_COUNT).toBe(8)
  })

  it('440Hz 的峰落在**第 2 段**（对数分布：80Hz–8kHz 的第 3 段）', () => {
    const data = new Uint8Array(BIN_COUNT)
    // 440Hz / 23.4375Hz ≈ 第 18 个 bin。
    data[18] = 200

    const bins = toLogBins(data, BIN_COUNT, SAMPLE_RATE)

    expect(bins[2]).toBe(200)
    // ⚠️ 相邻段**不许**被同一个 bin 污染（否则频率定位就是错的）。
    expect(bins[1]).toBe(0)
    expect(bins[3]).toBe(0)
  })

  it('每段取**最大值**（不是平均值——平均会把瞬态峰值抹平）', () => {
    const data = new Uint8Array(BIN_COUNT)
    data[3] = 50
    data[4] = 100

    const bins = toLogBins(data, BIN_COUNT, SAMPLE_RATE)

    // 第 0 段覆盖 bin 3~6 → 最大值 100（平均会是 37.5）。
    expect(bins[0]).toBe(100)
  })

  it('高频（≈7kHz）落在**最后一段**', () => {
    const data = new Uint8Array(BIN_COUNT)
    // 第 300 个 bin ≈ 300 × 23.4375Hz ≈ 7031Hz ∈ [5999, 8000) → 最后一段。
    data[300] = 180

    const bins = toLogBins(data, BIN_COUNT, SAMPLE_RATE)

    expect(bins[SPECTRUM_BIN_COUNT - 1]).toBe(180)
  })

  it('**超过 8kHz 的频率不采**（频谱上限就是 8kHz）', () => {
    const data = new Uint8Array(BIN_COUNT)
    // 第 500 个 bin ≈ 11.7kHz → 在 8kHz 之上 → 任何一段都不该拿到它。
    data[500] = 180

    const bins = toLogBins(data, BIN_COUNT, SAMPLE_RATE)

    expect(bins.every((value) => value === 0)).toBe(true)
  })

  it('全静音 → 全 0', () => {
    const bins = toLogBins(new Uint8Array(BIN_COUNT), BIN_COUNT, SAMPLE_RATE)
    expect(bins.every((value) => value === 0)).toBe(true)
  })

  it('非法输入（bin 数 / 采样率为 0）→ 全 0，**不崩**', () => {
    expect(toLogBins(new Uint8Array(0), 0, 48000).every((v) => v === 0)).toBe(true)
    expect(toLogBins(new Uint8Array(BIN_COUNT), BIN_COUNT, 0).every((v) => v === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 采样器
// ---------------------------------------------------------------------------

describe('T47 频谱：采样器', () => {
  it('开始 → 排定定时器；停止 → 取消定时器', () => {
    const timers = fakeTimers()
    const sampler = createSpectrumSampler({
      getSource: () => fakeSource([1, 2, 3]),
      push: () => undefined,
      createTimer: timers.createTimer,
      cancelTimer: timers.cancelTimer,
    })

    expect(sampler.isRunning()).toBe(false)
    sampler.start()
    expect(sampler.isRunning()).toBe(true)
    expect(timers.scheduled).toHaveLength(1)

    sampler.stop()
    expect(sampler.isRunning()).toBe(false)
    expect(timers.cancelled).toHaveLength(1)
  })

  it('重复 start **不会**排两个定时器（幂等）', () => {
    const timers = fakeTimers()
    const sampler = createSpectrumSampler({
      getSource: () => fakeSource([1]),
      push: () => undefined,
      createTimer: timers.createTimer,
      cancelTimer: timers.cancelTimer,
    })

    sampler.start()
    sampler.start()
    expect(timers.scheduled).toHaveLength(1)
  })

  it('采样一帧 → 推一条 8 段的数据', () => {
    const pushed: number[][] = []
    const sampler = createSpectrumSampler({
      getSource: () => fakeSource([0, 0, 0, 200]),
      push: (bins) => pushed.push(bins),
    })

    const bins = sampler.sample()

    expect(bins).toHaveLength(SPECTRUM_BIN_COUNT)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toHaveLength(SPECTRUM_BIN_COUNT)
  })

  it('还没有频谱源（还没播 / 不支持）→ **不推数据**，也不崩', () => {
    const pushed: number[][] = []
    const sampler = createSpectrumSampler({
      getSource: () => null,
      push: (bins) => pushed.push(bins),
    })

    expect(sampler.sample()).toBeNull()
    expect(pushed).toHaveLength(0)
  })

  it('分析节点没有 bin（frequencyBinCount = 0）→ **不推数据**', () => {
    const pushed: number[][] = []
    const sampler = createSpectrumSampler({
      getSource: () => fakeSource([]),
      push: (bins) => pushed.push(bins),
    })

    expect(sampler.sample()).toBeNull()
    expect(pushed).toHaveLength(0)
  })

  it('定时器回调推进 → 每一帧推一条', () => {
    const timers = fakeTimers()
    const pushed: number[][] = []
    const sampler = createSpectrumSampler({
      getSource: () => fakeSource([0, 100]),
      push: (bins) => pushed.push(bins),
      createTimer: timers.createTimer,
      cancelTimer: timers.cancelTimer,
    })

    sampler.start()
    timers.fire()
    expect(pushed).toHaveLength(1)

    timers.fire()
    expect(pushed).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 装配：只在「该采样」时才采样
// ---------------------------------------------------------------------------

describe('T47 频谱：装配与启停', () => {
  it('不该采样时 → **连定时器都不排**', () => {
    const timers = fakeTimers()
    const pushed: number[][] = []
    const handle = installSpectrum({
      bridge: { pushSpectrum: (bins) => pushed.push(bins) },
      watch: fakeWatch(false).watch,
      getSource: () => fakeSource([0, 100]),
      createTimer: timers.createTimer,
      cancelTimer: timers.cancelTimer,
    })

    expect(handle?.isEnabled()).toBe(false)
    expect(timers.scheduled).toHaveLength(0)
    handle?.dispose()
  })

  it('该采样时 → 排定时器并推数据', () => {
    const timers = fakeTimers()
    const pushed: number[][] = []
    const handle = installSpectrum({
      bridge: { pushSpectrum: (bins) => pushed.push(bins) },
      watch: fakeWatch(true).watch,
      getSource: () => fakeSource([0, 100]),
      createTimer: timers.createTimer,
      cancelTimer: timers.cancelTimer,
    })

    expect(handle?.isEnabled()).toBe(true)
    expect(timers.scheduled).toHaveLength(1)
    timers.fire()
    expect(pushed).toHaveLength(1)
    handle?.dispose()
  })

  it('「该不该采样」变了 → 立刻启停（词岛关掉就**立刻停**）', () => {
    const timers = fakeTimers()
    const state = fakeWatch(true)
    const handle = installSpectrum({
      bridge: { pushSpectrum: () => undefined },
      watch: state.watch,
      getSource: () => fakeSource([0, 100]),
      createTimer: timers.createTimer,
      cancelTimer: timers.cancelTimer,
    })

    expect(timers.scheduled).toHaveLength(1)

    state.set(false)
    expect(timers.cancelled).toHaveLength(1)

    state.set(true)
    expect(timers.scheduled).toHaveLength(2)
    handle?.dispose()
  })

  it('退订之后 → 不再排定时器', () => {
    const timers = fakeTimers()
    const state = fakeWatch(true)
    const handle = installSpectrum({
      bridge: { pushSpectrum: () => undefined },
      watch: state.watch,
      getSource: () => fakeSource([0, 100]),
      createTimer: timers.createTimer,
      cancelTimer: timers.cancelTimer,
    })

    handle?.dispose()
    const before = timers.scheduled.length
    state.set(false)
    state.set(true)
    expect(timers.scheduled.length).toBe(before)
  })

  it('没有桥（浏览器预览 / 单测）→ **整个模块不装**，返回 null', () => {
    expect(installSpectrum({ bridge: null })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 载荷校验（主进程与 preload 共用）
// ---------------------------------------------------------------------------

describe('T47 频谱：载荷校验', () => {
  it('合法的 8 个数 → 原样返回', () => {
    const bins = new Array<number>(SPECTRUM_BIN_COUNT).fill(0).map((_, i) => i * 15)
    expect(sanitizeSpectrumBins(bins)).toEqual(bins)
  })

  it('长度不对 → **丢弃**', () => {
    expect(sanitizeSpectrumBins([1, 2, 3])).toBeNull()
    expect(sanitizeSpectrumBins(new Array<number>(SPECTRUM_BIN_COUNT + 1).fill(0))).toBeNull()
  })

  it('不是数组 / 元素不是数 → **丢弃**', () => {
    expect(sanitizeSpectrumBins(null)).toBeNull()
    expect(sanitizeSpectrumBins('x')).toBeNull()
    expect(sanitizeSpectrumBins(new Array<unknown>(SPECTRUM_BIN_COUNT).fill('a'))).toBeNull()
    expect(sanitizeSpectrumBins(new Array<number>(SPECTRUM_BIN_COUNT).fill(Number.NaN))).toBeNull()
  })

  it('超出 0–255 → **丢弃**', () => {
    const tooHigh = new Array<number>(SPECTRUM_BIN_COUNT).fill(0)
    tooHigh[3] = 256
    expect(sanitizeSpectrumBins(tooHigh)).toBeNull()

    const tooLow = new Array<number>(SPECTRUM_BIN_COUNT).fill(0)
    tooLow[3] = -1
    expect(sanitizeSpectrumBins(tooLow)).toBeNull()
  })

  it('小数 → 取整（不丢弃）', () => {
    const bins = new Array<number>(SPECTRUM_BIN_COUNT).fill(0)
    bins[0] = 12.6
    expect(sanitizeSpectrumBins(bins)?.[0]).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// 护栏：频谱**不许**影响播放
// ---------------------------------------------------------------------------

describe('T47 频谱：护栏', () => {
  it('主进程只**转发**频谱，不解析、不缓存', () => {
    const source = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf8')
    // ⚠️ 频谱是高频流式数据 → **不许**进 `lastLyricMessage` 那种缓存。
    expect(source).toMatch(/onSpectrum: \(bins\) =>/)
    expect(source).toMatch(/send\('lyric:spectrum', bins\)/)
    expect(source).not.toMatch(/lastSpectrum/)
  })

  it('频谱数据**不许**带凭证（只允许数字）', () => {
    const source = readFileSync(join(__dirname, '..', 'shared', 'spectrum.ts'), 'utf8')
    expect(source).not.toMatch(/token|password|deviceId/i)
  })
})
