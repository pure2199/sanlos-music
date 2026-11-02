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
// - `mapSong` / `mapAlbum` / `mapArtist` / `mapPlaylist` / `mapGenre` / `mapLyric`：
//   把服务端原始 JSON 映射成 `shared/types.ts` 的领域模型（单位与空值语义在这里收敛）。
//
// 依赖约束：只用浏览器 API（`fetch` / `URLSearchParams` / `Response`），
// 不得引入 Node 内置模块或 Electron API（`src/` 会被打进渲染进程的 ESM bundle）。

import { CODE_OK } from '../../shared/constants'
import type { Album, Artist, AudioSpec, Genre, Playlist, Song } from '../../shared/types'
import type {
  LyricEntry,
  Page,
  RawAlbum,
  RawArtist,
  RawAudioSpec,
  RawGenre,
  RawLyric,
  RawPage,
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
 * 列表型接口的默认每页条数。
 *
 * 单点定义（业务模块统一从这里引用，不要各写一份）。
 */
export const DEFAULT_PAGE_SIZE = 50

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

/**
 * 网络 / 代理层故障：`fetch` 自身抛出的异常（代理不可达、连接中断、DNS 失败……）。
 *
 * 与 `ApiError`（服务端业务错误）分开，渲染层才能区分
 * 「网络或主进程代理故障（可提示重试）」与「服务端业务错误（按 `code` 处理）」。
 * 原始异常挂在 `cause` 上，便于排障。
 */
export class ApiNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ApiNetworkError'
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
// 分页参数归一
// ---------------------------------------------------------------------------

/**
 * 页码归一：非整数 / 非法值 / 小于 1 一律落到 1。
 *
 * 业务模块在入口统一调它，避免把 `page=0` / `page=NaN` 这类值发到服务端。
 */
export function normalizePageNumber(page: number): number {
  if (!Number.isFinite(page)) return 1
  const floored = Math.floor(page)
  return floored >= 1 ? floored : 1
}

/**
 * 每页条数归一：非法值回落默认条数，超上限截断到上限。
 *
 * 服务端单页上限实测 2000；超限值由服务端截断，这里先夹住，避免发出无意义的参数。
 */
export function normalizePageSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_PAGE_SIZE
  const floored = Math.floor(size)
  if (floored < 1) return DEFAULT_PAGE_SIZE
  return Math.min(floored, MAX_PAGE_SIZE)
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

/**
 * 时间字段归一：Unix 秒 → ISO 8601 字符串；已经是字符串就原样保留；缺失 → `null`。
 *
 * 实测服务端给的是 **Unix 秒**（如 `1792563278`），而领域模型的时间字段约定是
 * `string | null`（ISO 串）——归一由客户端负责。
 */
export function toIsoTimestamp(value: number | string | null | undefined): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const date = new Date(value * 1000)
    const iso = date.toISOString()
    return Number.isNaN(date.getTime()) ? null : iso
  }
  if (typeof value === 'string' && value.length > 0) return value
  return null
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
 * 实测（§15.7）：真实封面 id 形如 `track_<hex>` / `album_<hex>` / `artist_<hex>`，
 * 10/10 样本匹配本规则；`null` 表示无封面。
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
 * - 业务错误（`code !== 0`）→ 抛 `ApiError(msg, code)`（消息含服务端 `msg`）；
 * - 网络 / 代理故障 → 抛 `ApiNetworkError`（原始异常挂 `cause`）；
 * - 响应不是 JSON → 抛「服务器响应异常（HTTP n）」；
 * - 响应是 JSON 但不是信封 → 抛「响应不是预期信封」。
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

  let res: Response
  try {
    res = await fetch(url, { method, headers, body })
  } catch (cause) {
    // 代理不可达 / 连接中断 / DNS 失败：与业务错误区分开，渲染层才能提示「重试」而不是「服务端拒绝」。
    throw new ApiNetworkError('无法连接音乐服务（网络或主进程代理不可达）', { cause })
  }

  const text = await res.text()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`服务器响应异常（HTTP ${res.status}）`)
  }
  if (!isEnvelope(parsed)) {
    // 是 JSON 但没有信封结构：说「不是预期信封」，别报 HTTP 异常（HTTP 200 报 HTTP 异常会误导排障）。
    throw new Error('响应不是预期信封')
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

/**
 * **分页循环取全**（只给「体量小」的集合用：收藏 / 歌单）。
 *
 * ⚠️ **禁止用于曲库类端点**：真实 NAS 曲库 17.3 万首，一次性取全会拖垮客户端；
 *    曲库类接口必须走分页（`libraryApi.songs` 等），见 §「分页规则」。
 *
 * 终止条件：取满 `total`，或某一页返回空，或达到安全页数上限。
 */
export async function fetchAllByPaging<T, U>(
  path: string,
  map: (item: T) => U,
  options?: { pageSize?: number; maxPages?: number },
): Promise<U[]> {
  const pageSize = normalizePageSize(options?.pageSize ?? DEFAULT_PAGE_SIZE)
  const maxPages = Math.max(1, Math.floor(options?.maxPages ?? 50))
  const items: U[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await apiCall<RawPage<T>>(path, { query: { page, size: pageSize } })
    const chunk = normalizePage<T>(data)
    for (const item of chunk.list) items.push(map(item))
    if (chunk.list.length === 0) break
    if (items.length >= chunk.total) break
  }
  return items
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
 * - `favorite`：**取服务端 `isFavorite`**（实测真实歌曲带该字段），字段缺失时按未收藏处理；
 * - `audioSpec`：**值原样透传**（其中 `duration` 仍是毫秒、`bitrate` 仍是 bps）。
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
    favorite: json.isFavorite === true,
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
 * 与 `Song` 的三处差异：
 * - `coverId` 无封面是 **`null`**（不是空串）；
 * - `name` → `title`（领域模型叫 title）；
 * - **没有 `year` 字段**（实测）：领域模型的 `year` 由 `releaseDate` 前 4 位派生，
 *   `releaseDate` 缺失或不是 `YYYY-…` 形态时为 `null`。
 */
export function mapAlbum(json: RawAlbum): Album {
  return {
    id: str(json.guid) ?? '',
    title: str(json.name) ?? '',
    artist: joinArtistNames(json.artists),
    artistId: firstArtistId(json.artists),
    coverId: nullableStr(json.coverId),
    year: deriveYear(json.releaseDate),
    trackCount: num(json.trackCount, 0),
    releaseDate: nullableStr(json.releaseDate),
  }
}

/**
 * 从发行日期派生年份：匹配 `YYYY-…` 取前 4 位，否则 `null`。
 *
 * 实测服务端专辑对象**没有 `year` 字段**，只有 `releaseDate`（形如 `"2005-04-01"`，或 `null`）。
 */
export function deriveYear(releaseDate: string | null | undefined): number | null {
  const text = str(releaseDate)
  if (!text) return null
  const matched = /^(\d{4})/.exec(text)
  if (!matched) return null
  const year = Number(matched[1])
  return Number.isFinite(year) ? year : null
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

/** 原始歌单 → 领域模型 `Playlist`（`coverId` 无封面为 `null`，时间字段归一为 ISO 串）。 */
export function mapPlaylist(json: RawPlaylist): Playlist {
  return {
    id: str(json.guid) ?? '',
    name: str(json.name) ?? '',
    coverId: nullableStr(json.coverId),
    trackCount: num(json.trackCount, 0),
    description: nullableStr(json.description),
    createdAt: toIsoTimestamp(json.createdAt),
    updatedAt: toIsoTimestamp(json.updatedAt),
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

/** 原始歌词条目 → 领域层歌词条目（时间字段归一为 ISO 8601 字符串）。 */
export function mapLyric(json: RawLyric): LyricEntry {
  return {
    guid: str(json.guid) ?? '',
    source: str(json.source) ?? '',
    content: str(json.content) ?? '',
    createdAt: toIsoTimestamp(json.createdAt),
    updatedAt: toIsoTimestamp(json.updatedAt),
    isLRC: json.isLRC === true,
    offset: num(json.offset, 0),
  }
}
