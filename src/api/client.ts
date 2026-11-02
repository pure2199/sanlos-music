// 渲染进程的 API 客户端核心（**渲染进程里唯一一处出网代码**）。
//
// 安全边界（不可放宽）：
// - 本模块发出的请求一律指向 `fnm://srv/...` 自定义协议，主进程的协议代理负责把它还原成
//   `<server>/music/api/v1/...` 并统一附加签名与身份凭据；
// - 因此**渲染进程自己不带任何身份凭据**：本文件不会设置任何携带凭据的请求头，
//   也没有任何读取凭据的入口。凭据只在主进程内存里，渲染进程永远拿不到。
//
// 职责：
// - `apiCall`：统一信封解析（`{ code, msg, data }`）、错误语义与查询串拼接；
// - `mapSong` / `mapAlbum` / `mapArtist` / `mapPlaylist` / `mapGenre`：
//   把服务端原始 JSON 映射成 `shared/types.ts` 的领域模型（单位与空值语义在这里收敛）。
//
// 依赖约束：只用浏览器 API（`fetch` / `URLSearchParams` / `Response`），
// 不得引入 Node 内置模块或 Electron API（`src/` 会被打进渲染进程的 ESM bundle）。

import { CODE_OK } from '../../shared/constants'
import type { Album, Artist, AudioSpec, Genre, Playlist, Song } from '../../shared/types'
import type {
  Page,
  RawAlbum,
  RawArtist,
  RawAudioSpec,
  RawGenre,
  RawPlaylist,
  RawRef,
  RawSong,
} from './types'

/**
 * 渲染进程的 API 基址。
 *
 * `fnm://srv/<path>` 由主进程的协议代理还原成 `<server>/music/api/v1/<path>`。
 * 这里**写死**，不做「可覆盖的基址」开关——测试用 fetch 包装器解决，不在生产代码里留后门。
 */
const BASE = 'fnm://srv'

/**
 * 服务端单页上限（实测 2000）。
 *
 * 只给「体量小、允许一次取回」的接口用（收藏 / 歌单），
 * 曲库类接口一律走分页，绝不一次性拉全量。
 */
export const MAX_PAGE_SIZE = 2000

/**
 * 业务错误：服务端返回了 `code !== 0` 的信封。
 *
 * `code === 99999` 表示身份凭据已失效——**静默续期是主进程的职责**，
 * 渲染进程只负责把错误原样抛出去（消息里带服务端 `msg`，`code` 作为属性带出去）。
 */
export class ApiError extends Error {
  /** 服务端业务码（`0` 表示成功，故此处必为非 0）。 */
  readonly code: number

  constructor(msg: string, code: number) {
    super(msg)
    this.name = 'ApiError'
    this.code = code
  }
}

/** `apiCall` 的可选参数。 */
export interface ApiCallOptions {
  /** HTTP 方法，默认 `GET`。 */
  method?: string
  /** 请求体（会被序列化成 JSON）。 */
  body?: unknown
  /** 查询参数；`undefined` 的键会被跳过。 */
  query?: Record<string, string | number | undefined>
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 取字符串字段（不是字符串就当没有）。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 取有限数值字段，缺失 / 非法时返回 `fallback`。 */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 取可空数值字段，缺失 / 非法时返回 `null`（**不是 0**）。 */
function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 取可空字符串字段，缺失 / 非法时返回 `null`。 */
function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 是否是普通对象（数组与 null 都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 服务端响应信封（`data` 缺失也算合法）。 */
interface Envelope {
  code: number
  msg?: string
  data?: unknown
}

/** 是否是服务端信封（必须带数值型 `code`）。 */
function isEnvelope(value: unknown): value is Envelope {
  return isRecord(value) && typeof value['code'] === 'number'
}

/** 拼接查询串；`undefined` / `null` 的键跳过。 */
function buildQuery(query: Record<string, string | number | undefined> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.append(key, String(value))
  }
  const text = params.toString()
  return text.length > 0 ? `?${text}` : ''
}

/**
 * 封面 id 规范化。
 *
 * 只保留形如 `xxx_<十六进制>` 的值（前缀 + 下划线 + 十六进制），
 * 其余（无下划线的 `deadbeef`、`null`、空串）一律置空串 `''`。
 *
 * 领域模型约定：`Song.coverId` 无封面用**空串**（不是 `null`）。
 */
const COVER_ID_RE = /^[^_]+_[0-9a-fA-F]+$/

function normalizeCoverId(value: unknown): string {
  const text = str(value)
  if (!text) return ''
  return COVER_ID_RE.test(text) ? text : ''
}

/** 毫秒 → 秒（四舍五入）。 */
function msToSeconds(value: unknown): number {
  return Math.round(num(value, 0) / 1000)
}

/** 比特/秒（bps）→ 千比特/秒（kbps），四舍五入为整数。 */
function bpsToKbps(value: unknown): number {
  return Math.round(num(value, 0) / 1000)
}

/** 取文件扩展名（不含点，小写原样返回；无扩展名返回空串）。 */
function extensionOf(path: string | undefined): string {
  if (!path) return ''
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1)
}

/**
 * 编码格式：优先 `audioSpec.codec`，缺失时用 `audioSpec.path` 的扩展名兜底，一律转大写。
 *
 * 领域模型 `Song.codec` 是非空字符串，两个来源都没有时置空串。
 */
function resolveCodec(spec: RawAudioSpec | undefined): string {
  const codec = str(spec?.codec)
  if (codec) return codec.toUpperCase()
  return extensionOf(str(spec?.path)).toUpperCase()
}

/** 多歌手名用 `' / '` 连接（空名跳过）。 */
function joinArtistNames(artists: RawRef[] | undefined): string {
  if (!Array.isArray(artists)) return ''
  return artists
    .map((artist) => str(artist?.name) ?? '')
    .filter((name) => name.length > 0)
    .join(' / ')
}

/** 首个歌手的 guid（无歌手时为空串）。 */
function firstArtistId(artists: RawRef[] | undefined): string {
  if (!Array.isArray(artists)) return ''
  const first = artists[0]
  return first ? (str(first.guid) ?? '') : ''
}

/**
 * 音频规格：**值原样透传**，只把缺失的键补成 `null`。
 *
 * ⚠️ 这里不做任何单位换算：`duration` 仍是毫秒、`bitrate` 仍是 bps
 *    （领域模型 `AudioSpec.duration` 的注释已写明毫秒语义）。
 */
function mapAudioSpec(spec: RawAudioSpec | undefined): AudioSpec | undefined {
  if (!spec) return undefined
  return {
    bitDepth: nullableNum(spec.bitDepth),
    sampleRate: nullableNum(spec.sampleRate),
    channel: nullableNum(spec.channel),
    bitrate: nullableNum(spec.bitrate),
    codec: nullableStr(spec.codec),
    container: nullableStr(spec.container),
    duration: nullableNum(spec.duration),
    format: nullableStr(spec.format),
    path: nullableStr(spec.path),
    size: nullableNum(spec.size),
  }
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 调用服务端接口。
 *
 * 流程：`fnm://srv/<path>` → 主进程代理转发 → 解析 `{ code, msg, data }` 信封。
 *
 * 错误语义：
 * - `code !== 0` → 抛 `ApiError(msg, code)`（消息含服务端 `msg`）；
 * - 响应不是 JSON / 不是信封 / HTTP 非 2xx → 抛「服务器响应异常（HTTP n）」。
 */
export async function apiCall<T>(path: string, opts: ApiCallOptions = {}): Promise<T> {
  const url = `${BASE}${path}${buildQuery(opts.query)}`
  const method = opts.method ?? 'GET'

  // 请求头只声明内容类型——**不带任何身份凭据**（那是主进程代理的职责）。
  const headers: Record<string, string> = {}
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const res = await fetch(url, { method, headers, body })
  const text = await res.text()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }
  if (!isEnvelope(parsed)) {
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }
  if (parsed.code !== CODE_OK) {
    const message = str(parsed.msg) ?? ''
    throw new ApiError(message.length > 0 ? message : `请求失败（code=${parsed.code}）`, parsed.code)
  }
  if (!res.ok) {
    // 业务码是 0 但 HTTP 非 2xx：信封不可信，按 HTTP 异常处理。
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }

  const data = parsed.data
  if (data === undefined || data === null) return {} as T
  return data as T
}

/**
 * 把服务端列表信封规整成 `Page<T>`。
 *
 * - `list` 缺失 / 不是数组 → 空数组；
 * - `total` 缺失 / 非法 → 回落 `list.length`（而不是 0，避免增量加载误判「没有更多」）。
 */
export function normalizePage<T>(payload: unknown): Page<T> {
  if (!isRecord(payload)) return { list: [], total: 0 }
  const list = Array.isArray(payload['list']) ? (payload['list'] as T[]) : []
  const total = num(payload['total'], list.length)
  return { list, total }
}

// ---------------------------------------------------------------------------
// 数据映射
// ---------------------------------------------------------------------------

/**
 * 原始歌曲 → 领域模型 `Song`。
 *
 * 单位与空值约定（**逐条钉死**）：
 * - `duration`：毫秒 → 秒（`185000` → `185`）；
 * - `bitrate`：bps → kbps（`900000` → `900`）；缺失 / 非法 → `0`；
 * - `sampleRate` / `bitDepth`：缺失 / 非法 → `0`；
 * - `coverId`：只保留 `xxx_<hex>`，否则**空串 `''`**；
 * - `codec`：大写；`audioSpec.codec` 缺失时用 `audioSpec.path` 的扩展名兜底；
 * - `artist`：多歌手用 `' / '` 连接；`artistId` 取首个歌手；
 * - `year` / `trackNo` / `discNo` / `releaseDate`：**保留 `null`**，不转 0；
 * - `favorite`：恒 `false`（收藏态由 `favoriteApi` 单独维护，映射阶段不猜）；
 * - `audioSpec`：**值原样透传**（其中 `duration` 仍是毫秒）。
 */
export function mapSong(json: RawSong): Song {
  const spec = json.audioSpec
  return {
    id: str(json.guid) ?? '',
    title: str(json.title) ?? '',
    artist: joinArtistNames(json.artists),
    artistId: firstArtistId(json.artists),
    album: str(json.album?.name) ?? '',
    albumId: str(json.album?.guid) ?? '',
    coverId: normalizeCoverId(json.coverId),
    duration: msToSeconds(json.duration),
    favorite: false,
    codec: resolveCodec(spec),
    bitrate: bpsToKbps(spec?.bitrate),
    sampleRate: num(spec?.sampleRate, 0),
    bitDepth: num(spec?.bitDepth, 0),
    year: nullableNum(json.year),
    trackNo: nullableNum(json.trackNo),
    discNo: nullableNum(json.discNo),
    releaseDate: nullableStr(json.releaseDate),
    genres: mapGenres(json.genres),
    audioSpec: mapAudioSpec(spec),
  }
}

/**
 * 原始专辑 → 领域模型 `Album`。
 *
 * 与 `Song` 的两处差异：
 * - `coverId` 无封面是 **`null`**（不是空串）；
 * - `name` → `title`（领域模型叫 title）。
 */
export function mapAlbum(json: RawAlbum): Album {
  return {
    id: str(json.guid) ?? '',
    title: str(json.name) ?? '',
    artist: joinArtistNames(json.artists),
    artistId: firstArtistId(json.artists),
    coverId: nullableStr(json.coverId),
    year: nullableNum(json.year),
    trackCount: num(json.trackCount, 0),
    releaseDate: nullableStr(json.releaseDate),
  }
}

/** 原始歌手 → 领域模型 `Artist`（`coverId` 无封面为 `null`）。 */
export function mapArtist(json: RawArtist): Artist {
  return {
    id: str(json.guid) ?? '',
    name: str(json.name) ?? '',
    coverId: nullableStr(json.coverId),
    albumCount: num(json.albumCount, 0),
    trackCount: num(json.trackCount, 0),
  }
}

/** 原始歌单 → 领域模型 `Playlist`（`coverId` 无封面为 `null`）。 */
export function mapPlaylist(json: RawPlaylist): Playlist {
  return {
    id: str(json.guid) ?? '',
    name: str(json.name) ?? '',
    coverId: nullableStr(json.coverId),
    trackCount: num(json.trackCount, 0),
    description: nullableStr(json.description),
    createdAt: nullableStr(json.createdAt),
    updatedAt: nullableStr(json.updatedAt),
  }
}

/** 原始风格 → 领域模型 `Genre`（`coverId` 无封面为 `null`）。 */
export function mapGenre(json: RawGenre): Genre {
  return {
    guid: str(json.guid) ?? '',
    name: str(json.name) ?? '',
    coverId: nullableStr(json.coverId),
    trackCount: num(json.trackCount, 0),
  }
}

/** 原始风格数组 → 领域模型风格数组（缺省空数组）。 */
function mapGenres(raw: RawGenre[] | undefined): Genre[] {
  if (!Array.isArray(raw)) return []
  return raw.map((genre) => mapGenre(genre))
}
