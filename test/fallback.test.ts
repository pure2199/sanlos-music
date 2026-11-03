import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { FallbackTranscoder, fallbackFileName } from '../electron/fallbackTranscoder'
import {
  FALLBACK_LOSSY_NOTE,
  FALLBACK_PREPARING_MESSAGE,
  fallbackUnavailableMessage,
} from '../src/player/format'
import {
  PlayerEngine,
  type AudioContextLike,
  type AudioNodeLike,
  type MediaElementLike,
  type MediaElementSourceLike,
} from '../src/player/engine'
import {
  detectFfmpegStatus,
  hasFfmpegSupport,
  prepareFallbackSource,
} from '../src/player/fallback'
import type { PlayerBridge } from '../shared/playerBridge'
import type { Song } from '../shared/types'

// ---------------------------------------------------------------------------
// Task 12：客户端 FFmpeg 兜底解码
//
// 覆盖三条链路：
// 1. **主进程编排**（`FallbackTranscoder`）：能不能兜底 / 转码 / 单槽 / 复用 / 清理；
// 2. **引擎兜底**（`PlayerEngine`）：不可解格式 → 转码 → 起播；过时结果丢弃；暂停即取消；
// 3. **渲染层接线**（`src/player/fallback.ts`）：没桥降级、结果整形。
//
// ⚠️ **绝不真的起进程、不碰真实磁盘**——外部命令与文件系统一律注入替身。
// ⚠️ 全部数据都是**虚构占位**（'a' / 'b' / 'track_x'），不含真实 FN ID / 账号 / 密码。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 通用替身
// ---------------------------------------------------------------------------

/** 构造占位歌曲。 */
const song = (id: string, codec = 'FLAC'): Song => ({
  id,
  title: id,
  artist: 'a',
  artistId: '',
  album: '',
  albumId: '',
  coverId: '',
  duration: 100,
  favorite: false,
  codec,
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 0,
  discNo: 0,
})

/** 记录连线的假 WebAudio 节点。 */
class FakeNode implements AudioNodeLike {
  connect(): unknown {
    return undefined
  }
  disconnect(): void {
    // 忽略
  }
}

/** 假增益节点。 */
class FakeGainNode extends FakeNode {
  gain = { value: 1 }
}

/** 假 AudioContext。 */
class FakeAudioContext implements AudioContextLike {
  state = 'running'
  destination = new FakeNode()
  createGain(): FakeGainNode {
    return new FakeGainNode()
  }
  createMediaElementSource(): MediaElementSourceLike {
    return new FakeNode()
  }
}

/** 假媒体元素（不碰 jsdom 的 HTMLMediaElement 实现）。 */
class FakeAudioElement implements MediaElementLike {
  src = ''
  preload = ''
  currentTime = 0
  duration = 0
  paused = true
  volume = 1
  muted = false
  playCalls = 0
  pauseCalls = 0
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  play(): void {
    this.playCalls += 1
    this.paused = false
  }
  pause(): void {
    this.pauseCalls += 1
    this.paused = true
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
}

/** 可控的时钟 + 帧调度器。 */
function createClock() {
  let now = 0
  let nextId = 1
  const callbacks = new Map<number, (time: number) => void>()
  return {
    now: (): number => now,
    requestFrame: (cb: (time: number) => void): number => {
      const id = nextId
      nextId += 1
      callbacks.set(id, cb)
      return id
    },
    cancelFrame: (id: number): void => {
      callbacks.delete(id)
    },
  }
}

/** 造一个注入齐全的引擎。 */
function createEngine(overrides: {
  element?: FakeAudioElement
  prepareSource?: (song: Song, format: string) => Promise<{
    url: string | null
    reason?: 'no-ffmpeg' | 'no-local' | 'failed' | null
    detail?: string | null
  }>
} = {}) {
  const element = overrides.element ?? new FakeAudioElement()
  const context = new FakeAudioContext()
  const clock = createClock()
  const engine = new PlayerEngine({
    audio: element,
    createAudioContext: () => context,
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    ...(overrides.prepareSource ? { prepareSource: overrides.prepareSource } : {}),
  })
  return { engine, element, clock }
}

/** 造一个「可以手动兑现」的 Promise。 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 冲干净微任务队列（等 Promise 链跑完）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// 1. 主进程编排
// ---------------------------------------------------------------------------

describe('FallbackTranscoder', () => {
  /** 造一个转码器（文件系统与外部命令全部注入替身）。 */
  function createTranscoder(
    overrides: {
      lookupLocal?: (songId: string) => string | null
      detect?: () => Promise<{ available: boolean; path: string; version: string }>
      transcode?: (input: string, output: string, binary: string) => Promise<void>
    } = {},
  ) {
    const removedFiles: string[] = []
    const removedDirs: string[] = []
    const transcode = overrides.transcode ?? vi.fn(async () => undefined)
    const transcoder = new FallbackTranscoder({
      lookupLocal: overrides.lookupLocal ?? (() => 'C:\\Music\\a.ape'),
      tempDir: 'C:\\Temp\\fnm-fallback',
      detect: overrides.detect ?? (async () => ({ available: true, path: 'ffmpeg', version: '9.0.2' })),
      transcode,
      ensureDir: async () => undefined,
      removeFile: async (path) => {
        removedFiles.push(path)
      },
      removeDir: async (dir) => {
        removedDirs.push(dir)
      },
      fileExists: async () => true,
    })
    return { transcoder, removedFiles, removedDirs, transcode }
  }

  it('没有本地副本 → 理由是 no-local（**不转码**）', async () => {
    const { transcoder, transcode } = createTranscoder({ lookupLocal: () => null })
    const result = await transcoder.prepare('track_a')
    expect(result.reason).toBe('no-local')
    expect(result.url).toBe('')
    expect(transcode).not.toHaveBeenCalled()
  })

  it('没装 FFmpeg → 理由是 no-ffmpeg（**不转码**）', async () => {
    const { transcoder, transcode } = createTranscoder({
      detect: async () => ({ available: false, path: '', version: '' }),
    })
    const result = await transcoder.prepare('track_a')
    expect(result.reason).toBe('no-ffmpeg')
    expect(transcode).not.toHaveBeenCalled()
  })

  it('成功 → 给出 fnml:// 地址，产物落在临时目录里', async () => {
    const { transcoder, transcode } = createTranscoder()
    const result = await transcoder.prepare('track_a')
    expect(result.reason).toBeNull()
    expect(result.url).toBe('fnml://local/track/track_a')
    expect(transcode).toHaveBeenCalledTimes(1)
    const [input, output, binary] = (transcode as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
    ]
    expect(input).toBe('C:\\Music\\a.ape')
    expect(output.startsWith('C:\\Temp\\fnm-fallback')).toBe(true)
    expect(output.endsWith('.opus')).toBe(true)
    expect(binary).toBe('ffmpeg')
  })

  it('lookup 只认当前槽位（别的歌查不到）', async () => {
    const { transcoder } = createTranscoder()
    await transcoder.prepare('track_a')
    expect(transcoder.lookup('track_a')).toBeTruthy()
    expect(transcoder.lookup('track_b')).toBeNull()
  })

  it('单槽：换歌时删掉上一个产物（临时目录不许无限膨胀）', async () => {
    const { transcoder, removedFiles } = createTranscoder()
    await transcoder.prepare('track_a')
    const first = transcoder.lookup('track_a')
    await transcoder.prepare('track_b')
    expect(removedFiles).toContain(first)
    expect(transcoder.lookup('track_a')).toBeNull()
    expect(transcoder.lookup('track_b')).toBeTruthy()
  })

  it('同一首歌重复请求 → 复用产物（**不转第二次**）', async () => {
    const { transcoder, transcode } = createTranscoder()
    await transcoder.prepare('track_a')
    await transcoder.prepare('track_a')
    expect(transcode).toHaveBeenCalledTimes(1)
  })

  it('并发请求同一首歌 → 只转一次（复用同一个 Promise）', async () => {
    const { transcoder, transcode } = createTranscoder()
    await Promise.all([transcoder.prepare('track_a'), transcoder.prepare('track_a')])
    expect(transcode).toHaveBeenCalledTimes(1)
  })

  it('转码失败 → 理由是 failed，且半成品被删掉', async () => {
    const { transcoder, removedFiles } = createTranscoder({
      transcode: async () => {
        throw new Error('ffmpeg: Invalid data found when processing input')
      },
    })
    const result = await transcoder.prepare('track_a')
    expect(result.reason).toBe('failed')
    expect(result.detail).toContain('Invalid data')
    expect(result.url).toBe('')
    expect(removedFiles.some((p) => p.endsWith('.opus'))).toBe(true)
    // 失败**不进**槽位。
    expect(transcoder.lookup('track_a')).toBeNull()
  })

  it('产物名由 guid 派生（**不含用户数据**，同名 songId 结果稳定）', () => {
    expect(fallbackFileName('track_a')).toBe(fallbackFileName('track_a'))
    expect(fallbackFileName('track_a')).not.toBe(fallbackFileName('track_b'))
    expect(fallbackFileName('track_a').endsWith('.opus')).toBe(true)
    expect(fallbackFileName('../../etc/passwd')).not.toContain('/')
  })

  it('dispose 清掉槽位与临时目录（**只删自己建的目录**）', async () => {
    const { transcoder, removedFiles, removedDirs } = createTranscoder()
    await transcoder.prepare('track_a')
    await transcoder.dispose()
    expect(removedFiles.length).toBeGreaterThan(0)
    expect(removedDirs).toEqual(['C:\\Temp\\fnm-fallback'])
  })
})

// ---------------------------------------------------------------------------
// 2. 引擎兜底
// ---------------------------------------------------------------------------

describe('PlayerEngine：兜底解码', () => {
  it('没有兜底接缝时：不可解格式仍然**不播放**并写可读错误（既有行为）', () => {
    const { engine, element } = createEngine()
    engine.play(song('a', 'APE'))
    expect(element.playCalls).toBe(0)
    expect(engine.state.error).toContain('APE')
    expect(engine.state.error).toContain('无法播放')
    expect(engine.state.preparing).toBe(false)
  })

  it('有兜底接缝时：转码期间 preparing=true，**不播放**', () => {
    const { engine, element } = createEngine({
      prepareSource: () => new Promise(() => undefined),
    })
    engine.play(song('a', 'APE'))
    expect(engine.state.preparing).toBe(true)
    expect(engine.state.error).toBeNull()
    expect(element.playCalls).toBe(0)
  })

  it('转码成功 → 用产物地址起播，并标记 fallbackActive（有损如实告知）', async () => {
    const { engine, element } = createEngine({
      prepareSource: async () => ({ url: 'fnml://local/track/a' }),
    })
    engine.play(song('a', 'APE'))
    await flush()
    expect(element.src).toBe('fnml://local/track/a')
    expect(element.playCalls).toBe(1)
    expect(engine.state.preparing).toBe(false)
    expect(engine.state.fallbackActive).toBe(true)
    expect(engine.state.isPlaying).toBe(true)
    expect(engine.state.error).toBeNull()
  })

  it('转码失败 → 写**友好提示**（说清楚缺什么、下一步做什么）', async () => {
    const { engine, element } = createEngine({
      prepareSource: async () => ({ url: null, reason: 'no-local' }),
    })
    engine.play(song('a', 'APE'))
    await flush()
    expect(element.playCalls).toBe(0)
    expect(engine.state.preparing).toBe(false)
    expect(engine.state.error).toContain('APE')
    expect(engine.state.error).toContain('下载')
    expect(engine.state.isPlaying).toBe(false)
  })

  it('兜底接缝抛异常 → 也不静默失败（写可读错误）', async () => {
    const { engine, element } = createEngine({
      prepareSource: async () => {
        throw new Error('boom')
      },
    })
    engine.play(song('a', 'APE'))
    await flush()
    expect(element.playCalls).toBe(0)
    expect(engine.state.error).toBeTruthy()
    expect(engine.state.preparing).toBe(false)
  })

  it('**过时结果丢弃**：兜底期间切歌，旧结果回来不得改状态', async () => {
    const gate = deferred<{ url: string | null }>()
    const { engine, element } = createEngine({
      prepareSource: () => gate.promise,
    })
    engine.play(song('a', 'APE'))
    await flush()
    expect(engine.state.preparing).toBe(true)

    // 用户改主意了 → 播另一首（可解格式）。
    engine.play(song('b', 'FLAC'))
    expect(element.src).toBe('fnm://srv/track/stream?guid=b')
    const srcAfterSwitch = element.src

    // A 的转码结果这时才回来 —— **必须被丢弃**。
    gate.resolve({ url: 'fnml://local/track/a' })
    await flush()

    expect(element.src).toBe(srcAfterSwitch)
    expect(engine.state.current?.id).toBe('b')
    expect(engine.state.preparing).toBe(false)
    expect(engine.state.fallbackActive).toBe(false)
  })

  it('转码期间按暂停 → **取消**这次兜底（结果回来也不播）', async () => {
    const gate = deferred<{ url: string | null }>()
    const { engine, element } = createEngine({
      prepareSource: () => gate.promise,
    })
    engine.play(song('a', 'APE'))
    await flush()
    engine.pause()
    expect(engine.state.preparing).toBe(false)

    gate.resolve({ url: 'fnml://local/track/a' })
    await flush()
    expect(element.playCalls).toBe(0)
    expect(engine.state.isPlaying).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. 渲染层接线
// ---------------------------------------------------------------------------

describe('兜底的渲染层接线', () => {
  beforeEach(() => {
    delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  })
  afterEach(() => {
    delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  })

  it('没有桥 → 降级为「兜底不可用」（**不崩**）', async () => {
    expect(hasFfmpegSupport()).toBe(false)
    const result = await prepareFallbackSource(song('a', 'APE'), 'APE')
    expect(result.url).toBeNull()
    expect(result.reason).toBe('no-ffmpeg')
    const status = await detectFfmpegStatus()
    expect(status.available).toBe(false)
  })

  it('有桥 → 请求兜底并把结果整形', async () => {
    const ffmpegFallback = vi.fn(async () => ({
      url: 'fnml://local/track/a',
      reason: null,
      detail: null,
    }))
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = {
      ffmpegStatus: async () => ({ available: true, path: 'ffmpeg', version: '9.0.2' }),
      ffmpegFallback,
    } as unknown as PlayerBridge

    expect(hasFfmpegSupport()).toBe(true)
    const result = await prepareFallbackSource(song('a', 'APE'), 'APE')
    expect(result.url).toBe('fnml://local/track/a')
    expect(ffmpegFallback).toHaveBeenCalledWith('a')
    const status = await detectFfmpegStatus()
    expect(status.available).toBe(true)
    expect(status.version).toBe('9.0.2')
  })

  it('桥抛异常 → 降级为失败（**不崩、不静默**）', async () => {
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = {
      ffmpegStatus: async () => ({ available: true, path: 'ffmpeg', version: '9.0.2' }),
      ffmpegFallback: async () => {
        throw new Error('boom')
      },
    } as unknown as PlayerBridge
    const result = await prepareFallbackSource(song('a', 'APE'), 'APE')
    expect(result.url).toBeNull()
    expect(result.reason).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// 4. 提示文案
// ---------------------------------------------------------------------------

describe('兜底提示文案', () => {
  it('no-ffmpeg：指向「装 FFmpeg」（**不要说「先下载到本地」**——那条路走不通）', () => {
    const text = fallbackUnavailableMessage('APE', 'no-ffmpeg')
    expect(text).toContain('APE')
    expect(text).toContain('FFmpeg')
    expect(text).not.toContain('下载')
  })

  it('no-local：指向「先下载到本地」', () => {
    const text = fallbackUnavailableMessage('APE', 'no-local')
    expect(text).toContain('APE')
    expect(text).toContain('下载')
  })

  it('failed：带上具体原因', () => {
    const text = fallbackUnavailableMessage('APE', 'failed', 'Invalid data')
    expect(text).toContain('APE')
    expect(text).toContain('Invalid data')
  })

  it('常量为非空（界面要如实显示「正在转换」与「音质有损」）', () => {
    expect(FALLBACK_PREPARING_MESSAGE.length).toBeGreaterThan(0)
    expect(FALLBACK_LOSSY_NOTE).toContain('有损')
  })
})
