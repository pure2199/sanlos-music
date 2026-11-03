// ---------------------------------------------------------------------------
// 本地媒体协议 `fnml://`（**主进程**，Task 11）
// ---------------------------------------------------------------------------
//
// 职责
// ---------------------------------------------------------------------------
// 把**已经下载到本地**的音频文件交给渲染进程的 `<audio>` 播放：
// `fnml://local/track/<songId>` → 主进程查本地索引 → 返回文件字节。
//
// ---------------------------------------------------------------------------
// 为什么不用 `file://`
// ---------------------------------------------------------------------------
// - **开发模式**下渲染进程的页面来自 `http://127.0.0.1:5173`，与 `file://` **跨源**，
//   Chromium 对 `file://` 页面的本地文件访问还有额外限制（`allow-file-access-from-files` 默认关）；
// - **生产模式**下页面本身是 `file://`，再拿 `file://` 的音频会撞上「不透明源」问题；
// - 自定义协议与既有的 `fnm://` **同构**（`standard` / `secure` / `stream` / `corsEnabled`），
//   行为可预期，也不用放宽任何 Web 安全设置。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - **只有 host `local` 合法**，路径必须**恰好两段**：`track` + 歌曲 guid；
// - 歌曲 guid **只当作索引键用**（去查本地索引），**绝不**参与拼路径；
//   最终路径**只**来自索引里已落盘的那条记录 → **路径穿越无从下手**；
// - 渲染进程**碰不到**任何凭证：这个协议**不出网**，只读本地磁盘；
// - 支持 `Range`（`<audio>` 拖动定位靠它），回 `206` + `Content-Range`。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测。
//   Electron 的 `protocol` 一律**惰性解析**（同 `electron/proxy.ts` 的写法）。
// - 文件读写**可注入**，单测用内存替身，**不碰真实磁盘**。

import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import { LOCAL_MEDIA_HOST, LOCAL_MEDIA_SCHEME, localMediaUrl } from '../shared/localMedia'
import {
  registerAppSchemes,
  resolveElectronProtocol,
  type ProtocolLike,
} from './schemes'

// ⚠️ 协议名 / 主机名 / URL 构造在 `shared/localMedia.ts`（渲染进程也要用同一份）。

export { LOCAL_MEDIA_HOST, LOCAL_MEDIA_SCHEME, localMediaUrl }

/** 扩展名 → MIME（未命中用 `application/octet-stream`）。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  ape: 'audio/x-ape',
  alac: 'audio/mp4',
  mka: 'audio/x-matroska',
  webm: 'audio/webm',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** `LocalMedia` 的依赖（可注入，便于单测）。 */
export interface LocalMediaDeps {
  /**
   * 歌曲 guid → 本地文件的**绝对路径**。
   *
   * ⚠️ **只查索引**（已落盘的记录），**绝不**用 guid 拼路径。
   */
  lookup: (songId: string) => string | null
  /** 取文件大小；文件不存在返回 `null`。 */
  statSize?: (path: string) => Promise<number | null>
  /** 读一段字节（**闭区间** `start..end`）。 */
  readRange?: (path: string, start: number, end: number) => Promise<BufferSource>
}

/** 解析出来的 `Range` 请求。 */
export interface ParsedRange {
  /** 起始字节（含）。 */
  start: number
  /** 结束字节（含）。 */
  end: number
}

/** `registerLocalMedia` 的可选参数。 */
export interface LocalMediaOptions {
  /** `protocol` 替身；缺省时惰性取 Electron 的 `protocol`。 */
  protocol?: ProtocolLike
}

// ---------------------------------------------------------------------------
// URL 构造
// ---------------------------------------------------------------------------

/**
 * 解析 `fnml://` 请求 → 歌曲 guid。
 *
 * @returns 歌曲 guid；地址不合法时返回 `null`（**必须**整条拒绝）。
 */
export function parseLocalMediaTarget(rawUrl: string): string | null {
  const schemeEnd = rawUrl.indexOf('://')
  if (schemeEnd < 0) return null
  if (rawUrl.slice(0, schemeEnd).toLowerCase() !== LOCAL_MEDIA_SCHEME) return null

  let after = rawUrl.slice(schemeEnd + 3)
  const hash = after.indexOf('#')
  if (hash >= 0) after = after.slice(0, hash)
  const question = after.indexOf('?')
  if (question >= 0) after = after.slice(0, question)

  const slash = after.indexOf('/')
  const host = (slash >= 0 ? after.slice(0, slash) : after).toLowerCase()
  if (host !== LOCAL_MEDIA_HOST) return null
  const rawPath = slash >= 0 ? after.slice(slash) : ''
  // ⚠️ 路径必须**恰好两段**：`track` + guid。
  const segments = rawPath.split('/').filter((segment) => segment.length > 0)
  if (segments.length !== 2) return null
  if (segments[0] !== 'track') return null
  const rawSongId = segments[1]
  if (rawSongId === undefined) return null
  let songId: string
  try {
    songId = decodeURIComponent(rawSongId)
  } catch {
    return null
  }
  if (songId.length === 0) return null
  return songId
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/**
 * 解析 `Range: bytes=…` 请求头。
 *
 * 支持 `bytes=0-99` / `bytes=100-` / `bytes=-100`（后缀）。
 *
 * @param header  请求头原文。
 * @param size    文件总大小。
 * @returns 合法区间；没有 Range 或不合法时返回 `null`（= 按整份返回）。
 */
export function parseRangeHeader(header: string | null, size: number): ParsedRange | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match) return null
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText.length === 0 && endText.length === 0) return null

  if (startText.length === 0) {
    // 后缀式：`bytes=-N` = 最后 N 字节。
    const suffix = Number(endText)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    const start = Math.max(0, size - suffix)
    return { start, end: Math.max(0, size - 1) }
  }

  const start = Number(startText)
  if (!Number.isFinite(start) || start < 0) return null
  if (start >= size) return null
  if (endText.length === 0) return { start, end: Math.max(0, size - 1) }
  const end = Number(endText)
  if (!Number.isFinite(end) || end < start) return null
  return { start, end: Math.min(end, Math.max(0, size - 1)) }
}

// ---------------------------------------------------------------------------
// Electron 惰性解析
// ---------------------------------------------------------------------------

// ⚠️ `resolveElectronProtocol` 住在 `electron/schemes.ts`——
//    `fnm` 与 `fnml` **共用**同一个「惰性取 protocol」的实现（见该文件的说明：
//    两个 scheme 必须**一次**注册，第二个会把第一个覆盖掉）。

/**
 * 跨源放行头。
 *
 * ⚠️ **必须带**：`fnml` 注册时开了 `corsEnabled`（见 `electron/schemes.ts`），
 *    Chromium 会对该 scheme 施加 CORS 校验 → 响应不带
 *    `Access-Control-Allow-Origin` 就会被**浏览器直接拒掉**。
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, accept, if-none-match, if-modified-since',
  'access-control-max-age': '600',
}

// ---------------------------------------------------------------------------
// 默认文件系统实现
// ---------------------------------------------------------------------------

/** 默认：取文件大小。 */
async function defaultStatSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** 默认：读一段字节。 */
async function defaultReadRange(
  path: string,
  start: number,
  end: number,
): Promise<BufferSource> {
  const handle = await open(path, 'r')
  try {
    const length = Math.max(0, end - start + 1)
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    // ⚠️ 用 `slice`（**新的一份**）而不是 `subarray`（共享 buffer）：
    //    `subarray` 的类型是 `Uint8Array<ArrayBufferLike>`，不能直接当 `BodyInit`。
    return buffer.slice(0, bytesRead)
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------

/** 按扩展名取 MIME。 */
export function mimeTypeForPath(path: string): string {
  const ext = extname(path).replace(/^\./, '').toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 构造错误响应（404 / 416 / 400）。 */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ code: -1, msg: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  })
}

// ---------------------------------------------------------------------------
// 处理
// ---------------------------------------------------------------------------

/**
 * 处理一次 `fnml://` 请求（**导出以便单测**）。
 *
 * @returns 200（整份）/ 206（分段）/ 4xx（地址非法、文件不存在、范围不合法）。
 */
export async function handleLocalMediaRequest(
  request: Request,
  deps: LocalMediaDeps,
): Promise<Response> {
  const songId = parseLocalMediaTarget(request.url)
  if (!songId) return errorResponse(400, '非法的本地媒体地址')

  const path = deps.lookup(songId)
  if (!path) return errorResponse(404, '本地没有这首歌的文件')

  const statSize = deps.statSize ?? defaultStatSize
  const size = await statSize(path)
  if (size === null || size <= 0) return errorResponse(404, '本地文件不存在')

  const headers = new Headers({
    'content-type': mimeTypeForPath(path),
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  })
  // ⚠️ `fnml` 开了 `corsEnabled` → 响应**必须**带跨源放行头，否则浏览器直接拒收。
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)

  const range = parseRangeHeader(request.headers.get('range'), size)
  if (!range) {
    headers.set('content-length', String(size))
    const body = await (deps.readRange ?? defaultReadRange)(path, 0, size - 1)
    return new Response(body, { status: 200, headers })
  }

  const length = range.end - range.start + 1
  headers.set('content-length', String(length))
  headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`)
  const body = await (deps.readRange ?? defaultReadRange)(path, range.start, range.end)
  return new Response(body, { status: 206, headers })
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

// ⚠️ 这里**不再**提供「只注册 `fnml`」的入口——Electron 的
//    `registerSchemesAsPrivileged()` 整个进程只能调用一次，
//    单 scheme 注册会**覆盖掉**另一个 scheme 的特权（这正是本项目踩过的坑：
//    `fnm` 被 `fnml` 覆盖掉 → 渲染进程里 `fnm://` 完全不可用）。
//    → 正确的入口只有 `electron/schemes.ts` 的 `registerAppSchemes()`。

/**
 * 注册 `fnml://` 协议处理器（**必须在 app ready 之后调用**）。
 *
 * @param deps  依赖（查本地索引 + 读文件）。
 * @param opts  可选参数（`protocol` 替身）。
 */
export function registerLocalMedia(deps: LocalMediaDeps, opts: LocalMediaOptions = {}): void {
  const protocol = opts.protocol ?? resolveElectronProtocol()
  if (!protocol) {
    throw new Error('fnml:// 协议注册失败：当前进程没有可用的 Electron protocol 模块')
  }

  try {
    // ⚠️ **防御性调用**：ready 之后调 `registerSchemesAsPrivileged()` 会抛错，
    //    包在 try/catch 里忽略（正常流程由主进程入口在 ready 前调一次）。
    // ⚠️ 必须是 `registerAppSchemes()`（**两个 scheme 一起**）——
    //    `registerSchemesAsPrivileged()` 整个进程**只能调用一次**。
    registerAppSchemes(protocol)
  } catch {
    // 忽略：ready 之后调 registerSchemesAsPrivileged 会抛错（正常流程由主进程提前调过）。
  }

  protocol.handle(LOCAL_MEDIA_SCHEME, (request) => handleLocalMediaRequest(request, deps))
}
