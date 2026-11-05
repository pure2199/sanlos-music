// ---------------------------------------------------------------------------
// 服务端转码（**标准音质**）的渲染层接线（T54；T55 修正就绪判定）
// ---------------------------------------------------------------------------
//
// 协议（官方旧下载协议；2026-11-05 在真实 NAS 上逐条实测，官方服务端）：
//
//   POST download/track/transcode/prepare  { trackGUID, quality }
//        → { code: 0, data: { status: 'success', errno: '', errmsg: '', downloadId } }
//   GET  download/track/transcode/status?downloadId=
//        → { code: 0, data: { status, errno, errmsg, downloadId, percent } }
//   GET  download/track/transcode/file?downloadId=      ← **二进制**（代理走流式透传，支持 Range）
//   POST download/track/transcode/delete { downloadId }
//        → { code: 0, data: { downloadId, deleted: true } }
//
// ⚠️ **服务端只认两个 quality 值**：`standard` 与 `original`。
//    `higher` / `exhigh` → `code=100002 invalid arguments`（实测）。
//    官方旧下载协议里 `standard` = **MP3 320k**；服务端**没有** 192k 那一档。
//    ⚠️ **T55 更正**：T54 曾写「服务端**没有** 192K 档」，实测**成立**；
//       但 T54 当时把「服务端转码引擎不可用」也写成了结论 —— **那是误判**（见下）。
//
// ⚠️ **`status` 的 status 词不可信**：实测第一次查询就报 `ready`，
//    随后又变回 `transcoding / percent=N`。
//    ⇒ **真正可信的进度是 `percent`**；本模块一律按 `percent >= 100` 判定「可以试产物」。
//
// ⚠️ **T55：服务端转码一直是好的**（推翻 T54 的结论）。
//    2026-11-05 的探针组实测（真实 NAS + 真实账号）：
//    - 抽样 **14 首：14/14 成功**，平均就绪 **988 ms**（最慢 2 646 ms）；
//    - 产物 = **MP3 320k**（7 005 165 B / 175 s），比原始 FLAC（62 228 801 B）**省 88.8 % 流量**；
//    - 用户自建反代即可完成（比官方中继**快 11 倍**：7 MB / 1 154 ms vs 12 930 ms）。
//    T54 当时判「转码不可用」的**真凶是客户端的就绪判定**：
//    `percent>=100` → **单次**产物预检 → 预检不过就**立刻**判死。
//    而 `percent>=100` 与「产物真能读」之间**有窗口期**
//    （服务端在产物未就绪时回的是 `{"code":100002}`，**不是**挂死 —— T54 当时
//    把「203 ms 就回来的业务错误信封」误读成了「45 秒拿不到响应头」）。
//    ⇒ **本模块（T55）：预检失败不判死，与轮询交替重试。**
//
// ⚠️ **服务端引擎对个别曲目真的失败**：实测《占位曲目二》《占位曲目三》6/6 失败，
//    `errno=68157441 / errmsg='transcoding error'`（崩在转码进度 79 %~93 %）。
//    那是 **NAS 侧**的缺陷 → 客户端**如实上报**并回退原始音质，**不许**假装成功。
//
// 只用浏览器 API（`fetch` + `AbortController`），不 import Node 内置模块或 Electron API。

import type { StreamQuality } from '../../shared/types'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 档位标签（设置面板与提示文案共用一份）。 */
export const STREAM_QUALITY_LABELS: Readonly<Record<StreamQuality, string>> = {
  original: '原始音质',
  standard: '标准音质',
}

/** 缺省的音质档位（原始音质 = 既有行为一字不变）。 */
export const DEFAULT_STREAM_QUALITY: StreamQuality = 'original'

/** 服务端转码的四个端点（相对 API 基址，**不含** `/music/api/v1`）。 */
const PREPARE_PATH = 'download/track/transcode/prepare'
const STATUS_PATH = 'download/track/transcode/status'
const FILE_PATH = 'download/track/transcode/file'
const DELETE_PATH = 'download/track/transcode/delete'

/** 单次 JSON 请求的默认时限（毫秒）。 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * 转码轮询的默认间隔（毫秒）。
 *
 * ⚠️ **T55 由 1500 改成 500**：实测平均就绪 **988 ms** ⇒ 轮询粗一点就要多等半秒。
 * 轮询很便宜（一次小 JSON），500 ms 间隔对 NAS 无压力。
 */
const DEFAULT_POLL_INTERVAL_MS = 500

/** 转码轮询的默认总时限（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 90_000

/** 产物预检的默认时限（毫秒）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 12_000

/**
 * **产物预检失败后的重试间隔**（毫秒，T55 新增）。
 *
 * ⚠️ **为什么单独一个间隔**：轮询阶段按 `pollIntervalMs` 走；
 *    已经「服务端说完成、但产物还没可读」时，产物通常在**数百毫秒**内就可读
 *    ⇒ 用一个**更短**的间隔重试预检，不必等满整个轮询周期。
 */
const DEFAULT_PROBE_RETRY_INTERVAL_MS = 500

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 转码失败的**可判别**原因（不要靠文案匹配）。
 *
 * - `prepare-rejected`：服务端拒绝了转码请求（协议形状不对 / 不支持该档位）；
 * - `transcode-failed`：服务端**转码引擎**失败（带 `errno` / `errmsg`）；
 * - `timeout`：轮询超时（转码一直没完成）；
 * - `unavailable`：服务端说完成了，但**产物一直读不到**（预检始终失败）；
 * - `network`：网络不可达 / 请求失败。
 */
export type TranscodeFailureReason =
  | 'prepare-rejected'
  | 'transcode-failed'
  | 'timeout'
  | 'unavailable'
  | 'network'

/** 转码失败（**带可判别的原因**）。 */
export class TranscodeError extends Error {
  /** 失败原因（可判别）。 */
  readonly reason: TranscodeFailureReason
  /** 补充细节（服务端的 `errno` / `errmsg` 等，可为空）。 */
  readonly detail: string | null

  constructor(reason: TranscodeFailureReason, message: string, detail: string | null = null) {
    super(message)
    this.name = 'TranscodeError'
    this.reason = reason
    this.detail = detail
  }
}

/** 一次转码会话（产物地址 + 服务端任务 id）。 */
export interface TranscodeSession {
  /** 服务端任务 id（删除产物时要用）。 */
  readonly downloadId: string
  /** 产物地址（`fnm://srv/download/track/transcode/file?downloadId=…`）。 */
  readonly url: string
  /** 删掉服务端产物（切歌 / 播完后调用；**失败不抛**）。 */
  dispose(): Promise<void>
}

/** `prepareTranscode` 的可选参数。 */
export interface PrepareTranscodeOptions {
  /** 轮询间隔（毫秒）。 */
  readonly pollIntervalMs?: number
  /** 轮询总时限（毫秒）。 */
  readonly timeoutMs?: number
  /** **单次**产物预检的时限（毫秒，T55 新增）。 */
  readonly probeTimeoutMs?: number
  /** 产物预检失败后的重试间隔（毫秒，T55 新增）。 */
  readonly probeRetryIntervalMs?: number
  /** 进度回调（`percent` 为 0~100）。 */
  readonly onProgress?: (percent: number) => void
}

/** 服务端转码能力的探测结果。 */
export interface TranscodeCapability {
  /** 服务端**能不能**转码（能准备出可播的产物）。 */
  readonly supported: boolean
  /** 说明（失败时给出真实原因；成功时为 `null`）。 */
  readonly detail: string | null
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 睡一会儿（轮询用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把任意值看成普通对象（非对象 → `null`）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 读字符串字段（不是字符串就当没有）。 */
function readString(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

/** 读数字字段（不是数字就当没有）。 */
function readNumber(source: Record<string, unknown> | null, key: string): number {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

/** 判断这次失败是不是「超时」。 */
function isAbort(err: unknown): boolean {
  return readString(asRecord(err), 'name') === 'AbortError'
}

/**
 * 发一个 JSON 请求并解析信封。
 *
 * ⚠️ **响应体不是 JSON 时返回 `null`**（不抛异常）：调用方要靠 `code` 判断成败，
 *    这里抛异常会把真实的状态掩盖掉。
 */
async function requestJson(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs)
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: init.method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  } catch (err) {
    if (isAbort(err)) {
      throw new TranscodeError('timeout', `请求超时（${init.timeoutMs} 毫秒内没有响应）`)
    }
    throw new TranscodeError('network', '无法连接音乐服务')
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 归一化音质档位：**陌生值一律压成缺省档位**（原始音质）。
 *
 * ⚠️ `prefs.json` 是用户可编辑的文件 → 读回来的值**不可信**。
 */
export function normalizeStreamQuality(value: unknown): StreamQuality {
  return value === 'standard' ? 'standard' : DEFAULT_STREAM_QUALITY
}

/** 构造转码产物的地址（`fnm://` 代理地址，**绝不**含凭证）。 */
export function transcodeFileUrl(downloadId: string): string {
  return `fnm://srv/${FILE_PATH}?downloadId=${encodeURIComponent(downloadId)}`
}

/**
 * 删掉服务端上的转码产物。
 *
 * ⚠️ **失败不抛**：清理是「尽力而为」，服务端自己也会回收。
 */
export async function deleteTranscode(downloadId: string): Promise<void> {
  if (downloadId.length === 0) return
  try {
    await requestJson(`fnm://srv/${DELETE_PATH}`, {
      method: 'POST',
      body: { downloadId },
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch {
    // 清理失败无所谓。
  }
}

/**
 * 预检转码产物**是不是真的能读**（取首字节）。
 *
 * ⚠️ **为什么必须预检**：起播前不验证产物，就可能把一个**读不出来**的地址塞给
 *    `<audio>` → 界面一直停在「缓冲中…」，用户以为卡死了。
 *    ⇒ 起播前先花一次 Range 请求确认产物可读。
 *
 * ⚠️ **T55 更正**：T54 在这里写的「任务标称 ready 时实测 `GET file` **45 秒拿不到
 *    响应头**」是**误读**。重跑同一探针：全部请求 **88 ~ 203 ms** 返回，**零挂起**；
 *    产物未就绪时服务端回的是**业务错误信封** `{"code":100002,"msg":"invalid arguments"}`
 *    （HTTP 200 + `application/json`）—— 是「**还没好**」，不是「没响应」。
 *    ⇒ 预检拿到 JSON 信封就判「暂时读不到」，**由调用方决定要不要重试**。
 *
 * @param url        产物地址（`transcodeFileUrl` 的结果）。
 * @param timeoutMs  时限（毫秒）。
 * @returns 能读到字节 → `true`；否则 `false`。
 */
export async function probeTranscodeOutput(
  url: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { range: 'bytes=0-1' },
      signal: controller.signal,
    })
    // ⚠️ 服务端的**业务错误信封**也是 JSON（`{"code":100002,…}`）→ 那是「还没好」。
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('json')) {
      await res.text().catch(() => '')
      return false
    }
    const reader = res.body?.getReader()
    if (!reader) return false
    const { value } = await reader.read()
    // ⚠️ **只读第一块就取消**：服务端可能无视 Range 直接把整首推过来，
    //    读完再取消就白流了一整首的带宽。
    await reader.cancel().catch(() => undefined)
    return (value?.byteLength ?? 0) > 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 让服务端把一首歌转成指定档位，等它转完，并返回**可播的产物地址**。
 *
 * ⚠️ **失败一律抛 `TranscodeError`**（带可判别原因）——
 *    上层据此回退原始音质并如实说明，**不许**静默吞掉。
 *
 * ⚠️ **T55 的核心修正（就绪判定）**：
 *    - **`percent >= 100` 只代表「可以试产物了」**，不代表「产物已经能读」；
 *    - **预检失败不判死** —— 继续轮询 + 重试预检，直到读通或超出总时限；
 *    - 理由（实测）：服务端在产物未就绪时回 `{"code":100002}`，
 *      而 `percent` 达到 100 与产物真正可读之间**有窗口期**。
 *      T54 用**单次**预检判死 → 窗口期一命中就误判成「服务端转码不可用」。
 *
 * @param songId   曲目的 guid（**不是**本地曲目 id）。
 * @param quality  目标档位（服务端只认 `standard` / `original`）。
 * @param options  轮询参数与进度回调。
 */
export async function prepareTranscode(
  songId: string,
  quality: StreamQuality,
  options: PrepareTranscodeOptions = {},
): Promise<TranscodeSession> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const probeRetryIntervalMs = options.probeRetryIntervalMs ?? DEFAULT_PROBE_RETRY_INTERVAL_MS
  const onProgress = options.onProgress

  // --- 1. 准备 --------------------------------------------------------------
  const prepared = asRecord(
    await requestJson(`fnm://srv/${PREPARE_PATH}`, {
      method: 'POST',
      body: { trackGUID: songId, quality },
      timeoutMs: REQUEST_TIMEOUT_MS,
    }),
  )
  const preparedData = asRecord(prepared?.['data'])
  const downloadId = readString(preparedData, 'downloadId')
  if (readNumber(prepared, 'code') !== 0 || downloadId.length === 0) {
    throw new TranscodeError(
      'prepare-rejected',
      '服务端拒绝了转码请求',
      readString(prepared, 'msg') || null,
    )
  }

  const url = transcodeFileUrl(downloadId)
  const deadline = Date.now() + timeoutMs
  let percent = 0
  /** 服务端是否报过「完成」（`percent >= 100`）—— 用来区分 timeout 与 unavailable。 */
  let sawComplete = false
  /** 预检失败次数（诊断用，进 `detail`）。 */
  let probeFailures = 0

  // --- 2. 等它转完（**percent >= 100 只代表「可以试产物」**） ------------------
  for (;;) {
    // ⚠️ **只看 `percent`**：`status` 词实测不可信（第一次就报 `ready`）。
    const statusEnvelope = asRecord(
      await requestJson(
        `fnm://srv/${STATUS_PATH}?downloadId=${encodeURIComponent(downloadId)}`,
        { method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS },
      ),
    )
    const statusData = asRecord(statusEnvelope?.['data'])
    const word = readString(statusData, 'status')
    const rawPercent = readNumber(statusData, 'percent')
    const errno = readString(statusData, 'errno')
    const errmsg = readString(statusData, 'errmsg')

    if (word === 'failed') {
      throw new TranscodeError(
        'transcode-failed',
        `服务端转码失败${errmsg.length > 0 ? `（${errmsg}）` : ''}`,
        errno.length > 0 ? errno : errmsg.length > 0 ? errmsg : null,
      )
    }

    if (Number.isFinite(rawPercent) && rawPercent > percent) {
      percent = rawPercent
      onProgress?.(percent)
    }

    if (percent >= 100) {
      sawComplete = true
      // ⚠️ **产物预检失败 ≠ 失败**（T55）：产物未就绪时服务端回的是
      //    `{"code":100002}` 业务错误信封（HTTP 200 + JSON）——
      //    这是「**还没好**」，等一会儿再试，**不判死**。
      if (await probeTranscodeOutput(url, probeTimeoutMs)) {
        return {
          downloadId,
          url,
          dispose: async () => {
            await deleteTranscode(downloadId)
          },
        }
      }
      probeFailures++
    }

    if (Date.now() >= deadline) {
      // ⚠️ 超时/读不到的任务可能**还在服务端跑着** → 顺手删掉，别白占 NAS 的 CPU。
      await deleteTranscode(downloadId)
      if (sawComplete) {
        // 服务端说完成了、但产物一直读不到 → 与「还没转完」是**两回事**，文案要分开。
        throw new TranscodeError(
          'unavailable',
          '服务端转码产物无法读取',
          `预检 ${probeFailures} 次未读到字节`,
        )
      }
      throw new TranscodeError('timeout', '服务端转码超时', `${percent}%`)
    }

    await sleep(sawComplete ? probeRetryIntervalMs : pollIntervalMs)
  }
}

/**
 * 探测服务端**到底能不能**转码（给设置面板用）。
 *
 * ⚠️ 探测会**真的建一个转码任务**（服务端转一遍）→ 所以只在用户点「检测」时才调，
 *    **不做启动时的自动探测**。
 *
 * ⚠️ **T55**：走的是与起播**同一条** `prepareTranscode`（含重试）→
 *    不会因为「产物刚说完成、实际还没可读」而误报「不支持」。
 *
 * @param songId 用来探测的曲目 guid（**必须是一首 NAS 曲目**）。
 */
export async function probeServerTranscode(
  songId: string,
  options: PrepareTranscodeOptions = {},
): Promise<TranscodeCapability> {
  try {
    const session = await prepareTranscode(songId, 'standard', options)
    await session.dispose()
    return { supported: true, detail: null }
  } catch (err) {
    const detail = err instanceof TranscodeError ? err.message : '未知原因'
    return { supported: false, detail }
  }
}
