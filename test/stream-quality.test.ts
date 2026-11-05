// ---------------------------------------------------------------------------
// T54：音质偏好（原始音质 / 标准音质）+ 服务端转码链路
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **偏好白名单**（主进程 `PrefsStore`）：只认 `original` / `standard`，
//   陌生值整段丢弃，缺省不写（老用户行为一字不变）；
// - **档位归一化**（渲染层）：陌生值压成缺省档；
// - **转码协议**（`src/player/transcode.ts`）：
//   prepare → status（**只信 percent**）→ 产物预检 → delete；
//   以及四类失败（拒绝 / 转码失败 / 产物不可读 / 超时）；
// - **引擎的标准音质路径**：转好了用产物起播；转码失败**自动回退原始音质**
//   并如实说明（**不崩、不黑屏**）；本地副本**不转码**。
//
// ⚠️ 协议形状来自 2026-11-05 对真实 NAS 的逐条实测（见 `docs/calibration.md`）。
// ⚠️ 测试数据一律用占位值，不写真实 guid / 歌名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Song } from '../shared/types'
import { PrefsStore } from '../electron/ipc'
import { PlayerEngine, type MediaElementLike } from '../src/player/engine'
import {
  DEFAULT_STREAM_QUALITY,
  STREAM_QUALITY_LABELS,
  TranscodeError,
  normalizeStreamQuality,
  prepareTranscode,
  probeServerTranscode,
  transcodeFileUrl,
} from '../src/player/transcode'
import { standardQualityUnavailableMessage } from '../src/player/format'

const SONG_ID = 'track_example01'
const DOWNLOAD_ID = '0123456789abcdef0123456789abcdef'

const SONG: Song = {
  id: SONG_ID,
  title: '示例歌名',
  artist: '示例歌手',
  artistId: '',
  album: '示例专辑',
  albumId: '',
  coverId: '',
  duration: 100,
  favorite: false,
  codec: 'FLAC',
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 1,
  discNo: 1,
}

/** 每次用例一个独立的偏好文件（系统临时目录，不入库）。 */
function tempFile(): string {
  return join(tmpdir(), `fnm-t54-prefs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

// ---------------------------------------------------------------------------
// 1. 偏好白名单（主进程）
// ---------------------------------------------------------------------------

describe('T54 音质偏好（主进程白名单）', () => {
  it("streamQuality: 'standard' → 原样保留", () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ streamQuality: 'standard' })
    expect(prefs.read().streamQuality).toBe('standard')
  })

  it("streamQuality: 'original' → 原样保留", () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ streamQuality: 'original' })
    expect(prefs.read().streamQuality).toBe('original')
  })

  it('非法值 → **丢弃该字段**（不写半截进偏好）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ streamQuality: 'higher' as never })
    expect(prefs.read().streamQuality).toBeUndefined()
  })

  it('缺省 → 不写（老用户升级后行为不变）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ theme: 'fluent' })
    expect(prefs.read().streamQuality).toBeUndefined()
    // 其余字段**不受影响**
    expect(prefs.read().theme).toBe('fluent')
  })
})

// ---------------------------------------------------------------------------
// 2. 档位归一化（渲染层）
// ---------------------------------------------------------------------------

describe('T54 音质档位归一化', () => {
  it("'standard' → 'standard'", () => {
    expect(normalizeStreamQuality('standard')).toBe('standard')
  })

  it("'original' → 'original'", () => {
    expect(normalizeStreamQuality('original')).toBe('original')
  })

  it('陌生值 → 缺省档（原始音质）', () => {
    expect(normalizeStreamQuality('higher')).toBe(DEFAULT_STREAM_QUALITY)
    expect(normalizeStreamQuality(undefined)).toBe(DEFAULT_STREAM_QUALITY)
    expect(normalizeStreamQuality(null)).toBe(DEFAULT_STREAM_QUALITY)
  })

  it('缺省档就是「原始音质」', () => {
    expect(DEFAULT_STREAM_QUALITY).toBe('original')
  })

  it('两档都有中文标签', () => {
    expect(STREAM_QUALITY_LABELS.original).toBe('原始音质')
    expect(STREAM_QUALITY_LABELS.standard).toBe('标准音质')
  })
})

// ---------------------------------------------------------------------------
// 3. 转码协议
// ---------------------------------------------------------------------------

/** 记录所有 fetch 调用（按顺序）。 */
interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []

/** 造一个 JSON 信封响应。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** 造一个音频字节响应（模拟二进制透传）。 */
function audioResponse(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), {
    status: 206,
    headers: { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' },
  })
}

/**
 * 装一个假的 `fetch`。
 *
 * @param prepare   prepare 的应答体。
 * @param statuses  status 的应答体队列（按顺序取；用完最后一个就重复最后一个）。
 * @param file      文件端点的应答（`null` = 永远挂住/失败）。
 */
function stubFetch(
  prepare: unknown,
  statuses: unknown[],
  file: Response | null = audioResponse([0x49, 0x44, 0x33]),
  files?: (Response | null)[],
): void {
  let statusIndex = 0
  let fileIndex = 0
  const mock = async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET'
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ url: input, method, body })

    if (input.includes('/transcode/prepare')) return jsonResponse(prepare)
    if (input.includes('/transcode/status')) {
      const index = Math.min(statusIndex, statuses.length - 1)
      statusIndex += 1
      return jsonResponse(statuses[index] ?? {})
    }
    if (input.includes('/transcode/file')) {
      // ⚠️ T55：`files` 队列用来模拟「产物还没好 → 预检失败 → 过一会儿才好」。
      //    用完最后一个就重复最后一个（与 `statuses` 同一套语义）。
      const picked = files ? (files[Math.min(fileIndex, files.length - 1)] ?? null) : file
      fileIndex += 1
      if (!picked) throw new Error('服务端没响应')
      return picked
    }
    if (input.includes('/transcode/delete')) {
      return jsonResponse({ code: 0, msg: '', data: { downloadId: DOWNLOAD_ID, deleted: true } })
    }
    return jsonResponse({ code: 404, msg: 'not found', data: null })
  }
  vi.stubGlobal('fetch', mock)
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('T54 服务端转码协议', () => {
  it('产物地址是 `fnm://` 代理地址（**不含凭证**）', () => {
    const url = transcodeFileUrl(DOWNLOAD_ID)
    expect(url).toBe(`fnm://srv/download/track/transcode/file?downloadId=${DOWNLOAD_ID}`)
    expect(url).not.toContain('token')
    expect(url).not.toContain('Cookie')
  })

  it('prepare → status → 产物预检 → 返回可播地址', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'transcoding', percent: 40 } }, { code: 0, data: { status: 'ready', percent: 100 } }],
    )
    const session = await prepareTranscode(SONG_ID, 'standard', { pollIntervalMs: 1 })
    expect(session.url).toBe(transcodeFileUrl(DOWNLOAD_ID))
    expect(session.downloadId).toBe(DOWNLOAD_ID)
    // prepare 用的是 `trackGUID` + `quality`
    const prepareCall = calls.find((c) => c.url.includes('/transcode/prepare'))
    expect(prepareCall?.method).toBe('POST')
    expect(prepareCall?.body).toEqual({ trackGUID: SONG_ID, quality: 'standard' })
    // 产物预检真的发了一次 Range 请求
    expect(calls.some((c) => c.url.includes('/transcode/file'))).toBe(true)
  })

  it('**只信 percent**：status 词先报 ready、percent 还没满 → 继续等', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [
        { code: 0, data: { status: 'ready', percent: 30 } },
        { code: 0, data: { status: 'transcoding', percent: 100 } },
      ],
    )
    const progresses: number[] = []
    const session = await prepareTranscode(SONG_ID, 'standard', {
      pollIntervalMs: 1,
      onProgress: (percent) => progresses.push(percent),
    })
    expect(session.downloadId).toBe(DOWNLOAD_ID)
    // 进度回调收到过真实百分比
    expect(progresses.length).toBeGreaterThan(0)
  })

  it('服务端拒绝 → `prepare-rejected`', async () => {
    stubFetch({ code: 100002, msg: 'invalid arguments', data: null }, [])
    await expect(prepareTranscode(SONG_ID, 'standard', { pollIntervalMs: 1 })).rejects.toMatchObject({
      reason: 'prepare-rejected',
    })
  })

  it('转码失败（服务端 errno/errmsg）→ `transcode-failed`（**如实带上原因**）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'failed', errno: '68157441', errmsg: 'transcoding error', percent: 0 } }],
    )
    const error = await prepareTranscode(SONG_ID, 'standard', { pollIntervalMs: 1 }).catch((e) => e)
    expect(error).toBeInstanceOf(TranscodeError)
    expect((error as TranscodeError).reason).toBe('transcode-failed')
    expect((error as TranscodeError).detail).toBe('68157441')
    expect((error as TranscodeError).message).toContain('transcoding error')
  })

  // ⚠️ T55：标题里原来写的「文件端点挂死」是**误读**——实测服务端回的是
  //    **业务错误信封**（HTTP 200 + JSON），203 ms 就到，**不是**挂起。
  //    T55 的语义：产物读不到 → **重试**；重试到总时限仍读不到 → `unavailable`。
  //    ⚠️ **断言一字未改**；只把客户端的等待预算从 5 000 ms 收到 200 ms
  //    （新语义下客户端会一直重试到总时限，5 000 ms 会撞上 vitest 的 5 秒用例超时）。
  it('产物读不出来（文件端点回业务错误）→ `unavailable`（**不许**把没验证过的地址交给播放器）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'ready', percent: 100 } }],
      null,
    )
    await expect(
      prepareTranscode(SONG_ID, 'standard', {
        pollIntervalMs: 1,
        probeRetryIntervalMs: 1,
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('轮询超时 → `timeout`（并顺手删掉还在跑的服务端任务）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'transcoding', percent: 5 } }],
    )
    await expect(
      prepareTranscode(SONG_ID, 'standard', { pollIntervalMs: 1, timeoutMs: 0 }),
    ).rejects.toMatchObject({ reason: 'timeout' })
    expect(calls.some((c) => c.url.includes('/transcode/delete'))).toBe(true)
  })

  it('能力探测：成功 → supported；失败 → 带上真实原因', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'ready', percent: 100 } }],
    )
    const ok = await probeServerTranscode(SONG_ID, { pollIntervalMs: 1 })
    expect(ok.supported).toBe(true)
    expect(ok.detail).toBeNull()

    stubFetch({ code: 100002, msg: 'invalid arguments', data: null }, [])
    const bad = await probeServerTranscode(SONG_ID, { pollIntervalMs: 1 })
    expect(bad.supported).toBe(false)
    expect(bad.detail).toContain('服务端拒绝了转码请求')
  })
})

// ---------------------------------------------------------------------------
// 3b. T55 就绪判定（产物预检重试）
// ---------------------------------------------------------------------------

/**
 * 造一个「产物还没准备好」的业务错误信封。
 *
 * ⚠️ **这是服务端实测的真实现象**：产物未就绪时，文件端点回的是
 *    HTTP 200 + `{"code":100002,"msg":"invalid arguments"}`（**不是**挂死）。
 */
function notReadyResponse(): Response {
  return jsonResponse({ code: 100002, msg: 'invalid arguments', data: null })
}

describe('T55 就绪判定：产物预检失败**不判死**', () => {
  it('percent=100 但产物前两次读不到 → **重试后成功**（T54 在这里会误判失败）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'ready', percent: 100 } }],
      undefined,
      [notReadyResponse(), notReadyResponse(), audioResponse([0x49, 0x44, 0x33])],
    )
    const session = await prepareTranscode(SONG_ID, 'standard', {
      pollIntervalMs: 1,
      probeRetryIntervalMs: 1,
    })
    expect(session.url).toBe(transcodeFileUrl(DOWNLOAD_ID))
    expect(session.downloadId).toBe(DOWNLOAD_ID)
    // 预检至少打了三次（前两次失败、第三次成功）
    expect(calls.filter((c) => c.url.includes('/transcode/file')).length).toBeGreaterThanOrEqual(3)
  })

  it('percent=100 但产物**一直**读不到 → `unavailable`（**不是** timeout）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'ready', percent: 100 } }],
      undefined,
      [notReadyResponse()],
    )
    await expect(
      prepareTranscode(SONG_ID, 'standard', {
        pollIntervalMs: 1,
        probeRetryIntervalMs: 1,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('服务端说完成、产物随后又掉回转码中 → **继续等**，直到真能读', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [
        { code: 0, data: { status: 'ready', percent: 100 } },
        { code: 0, data: { status: 'transcoding', percent: 40 } },
        { code: 0, data: { status: 'ready', percent: 100 } },
      ],
      undefined,
      [notReadyResponse(), audioResponse([0x49, 0x44, 0x33])],
    )
    const session = await prepareTranscode(SONG_ID, 'standard', {
      pollIntervalMs: 1,
      probeRetryIntervalMs: 1,
    })
    expect(session.downloadId).toBe(DOWNLOAD_ID)
    // 至少预检了两次（第一次没读到 → 没有就此宣布成功）
    expect(calls.filter((c) => c.url.includes('/transcode/file')).length).toBeGreaterThanOrEqual(2)
  })

  it('服务端明确 failed → **立刻** `transcode-failed`（**不**去做产物预检）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'failed', errno: '68157441', errmsg: 'transcoding error', percent: 0 } }],
    )
    const error = await prepareTranscode(SONG_ID, 'standard', { pollIntervalMs: 1 }).catch((e) => e)
    expect(error).toBeInstanceOf(TranscodeError)
    expect((error as TranscodeError).reason).toBe('transcode-failed')
    expect((error as TranscodeError).detail).toBe('68157441')
    // 一次预检都不该打（服务端已经明说失败了）
    expect(calls.some((c) => c.url.includes('/transcode/file'))).toBe(false)
  })

  it('产物一直读不到 → 顺手**删掉**服务端任务（别白占 NAS 的 CPU）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'ready', percent: 100 } }],
      undefined,
      [notReadyResponse()],
    )
    await prepareTranscode(SONG_ID, 'standard', {
      pollIntervalMs: 1,
      probeRetryIntervalMs: 1,
      timeoutMs: 50,
    }).catch(() => undefined)
    expect(calls.some((c) => c.url.includes('/transcode/delete'))).toBe(true)
  })

  it('能力探测走**同一条**带重试的链路（产物晚一点好 → 也算「支持」）', async () => {
    stubFetch(
      { code: 0, msg: '', data: { status: 'success', errno: '', errmsg: '', downloadId: DOWNLOAD_ID } },
      [{ code: 0, data: { status: 'ready', percent: 100 } }],
      undefined,
      [notReadyResponse(), audioResponse([0x49, 0x44, 0x33])],
    )
    const capability = await probeServerTranscode(SONG_ID, {
      pollIntervalMs: 1,
      probeRetryIntervalMs: 1,
    })
    expect(capability.supported).toBe(true)
    expect(capability.detail).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. 引擎的标准音质路径
// ---------------------------------------------------------------------------

/** 假音频元素（只要能记 `src` 就够）。 */
class FakeElement implements MediaElementLike {
  src = ''
  preload = ''
  crossOrigin: string | null = null
  currentTime = 0
  duration = 0
  paused = true
  volume = 1
  muted = false
  play(): Promise<void> | void {
    this.paused = false
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

/** 假音频节点。 */
class FakeNode {
  connect(): void {
    /* 不需要 */
  }
  disconnect(): void {
    /* 不需要 */
  }
}

/** 假增益节点（引擎会写 `gain.value`）。 */
class FakeGainNode extends FakeNode {
  gain = { value: 1 }
}

/** 假 AudioContext（只求「音频图能建起来」）。 */
class FakeAudioContext {
  state = 'running'
  destination = new FakeNode()

  createGain(): FakeGainNode {
    return new FakeGainNode()
  }

  createMediaElementSource(): FakeNode {
    return new FakeNode()
  }
}

/** 造一个只记 `src` 的引擎。 */
function createEngine(options: {
  quality: 'original' | 'standard'
  prepare?: (song: Song) => Promise<string>
  resolve?: (song: Song) => string
}): { engine: PlayerEngine; element: FakeElement } {
  const element = new FakeElement()
  const engine = new PlayerEngine({
    audio: element,
    createAudioElement: () => element,
    createAudioContext: () => new FakeAudioContext() as never,
    now: () => 0,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    resolveSource: options.resolve ?? ((song) => `fnm://srv/track/stream?guid=${song.id}`),
    prepareStandardSource: options.prepare,
    streamQuality: () => options.quality,
  })
  return { engine, element }
}

/** 让引擎的 Promise 链跑完（微任务 + 一帧）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('T54 引擎的标准音质路径', () => {
  it('标准音质：转码成功 → **用产物地址起播**', async () => {
    const { engine, element } = createEngine({
      quality: 'standard',
      prepare: async () => transcodeFileUrl(DOWNLOAD_ID),
    })
    engine.play(SONG)
    await flush()
    expect(element.src).toBe(transcodeFileUrl(DOWNLOAD_ID))
    engine.dispose()
  })

  it('标准音质：转码失败 → **自动回退原始音质**，并且**如实说明原因**', async () => {
    const { engine, element } = createEngine({
      quality: 'standard',
      prepare: async () => {
        throw new TranscodeError('transcode-failed', '服务端转码失败（transcoding error）', '68157441')
      },
    })
    const states: Array<{ qualityNote?: string | null; error?: string | null }> = []
    engine.onStateChange((state) => states.push({ qualityNote: state.qualityNote, error: state.error }))
    engine.play(SONG)
    await flush()
    // 回落到了**既有**的流式地址（音乐照常播）
    expect(element.src).toBe(`fnm://srv/track/stream?guid=${SONG_ID}`)
    // 说明写进了状态（**不是**错误）
    const last = states[states.length - 1]
    expect(last?.qualityNote).toContain('标准音质不可用')
    expect(last?.qualityNote).toContain('transcoding error')
    expect(last?.error ?? null).toBeNull()
    engine.dispose()
  })

  it('标准音质：这一曲**不需要**转码（返回空串）→ 静默走既有地址，**不留说明**', async () => {
    const { engine, element } = createEngine({
      quality: 'standard',
      prepare: async () => '',
    })
    const states: Array<{ qualityNote?: string | null }> = []
    engine.onStateChange((state) => states.push({ qualityNote: state.qualityNote }))
    engine.play(SONG)
    await flush()
    expect(element.src).toBe(`fnm://srv/track/stream?guid=${SONG_ID}`)
    expect(states[states.length - 1]?.qualityNote ?? null).toBeNull()
    engine.dispose()
  })

  it('原始音质（缺省）：**既有行为一字不变**（不碰服务端转码接缝）', async () => {
    let called = false
    const { engine, element } = createEngine({
      quality: 'original',
      prepare: async () => {
        called = true
        return transcodeFileUrl(DOWNLOAD_ID)
      },
    })
    engine.play(SONG)
    await flush()
    expect(called).toBe(false)
    expect(element.src).toBe(`fnm://srv/track/stream?guid=${SONG_ID}`)
    engine.dispose()
  })

  it('切歌后回来的**过时**转码结果**不得**改状态', async () => {
    // ⚠️ 用**对象**装 resolver：局部变量会被 TS 收窄成 `null`（`never` 调用错误）。
    const holder: { release: ((url: string) => void) | null } = { release: null }
    const { engine, element } = createEngine({
      quality: 'standard',
      prepare: () =>
        new Promise<string>((resolve) => {
          holder.release = resolve
        }),
    })
    engine.play(SONG)
    await flush()
    // 用户切了下一首
    engine.play({ ...SONG, id: 'track_example02' })
    // 旧结果这时才回来
    holder.release?.(transcodeFileUrl(DOWNLOAD_ID))
    await flush()
    expect(element.src).not.toBe(transcodeFileUrl(DOWNLOAD_ID))
    engine.dispose()
  })

  it('说明文案：说清楚「不可用 + 已改用原始音质」', () => {
    expect(standardQualityUnavailableMessage('服务端转码失败')).toBe(
      '标准音质不可用：服务端转码失败，已改用原始音质播放',
    )
    expect(standardQualityUnavailableMessage(null)).toBe('标准音质不可用，已改用原始音质播放')
  })
})
