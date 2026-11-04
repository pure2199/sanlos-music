// 飞牛音乐 API 的 mock server（无 NAS 开发前提）。
//
// 用途：Task 6+（API 客户端、登录界面、曲库浏览、播放、收藏、歌单、歌词）在没有真实 NAS 时
// 也能开发与测试。本 server 是 Task 6+ 的**唯一数据来源**。
//
// ⚠️ 安全边界：**该服务仅限本机开发使用，不得暴露到局域网。**
// 端口 0 由系统分配，而 `listen(0)` 不带 host 时 Node 会把 socket 绑定到所有网卡
// （带 host 会把绑定推迟到 nextTick，导致 `url` 无法同步返回，见 createMockServer 的说明），
// 因此 mock 在**请求侧**加了回环守卫：来源地址不是回环的请求一律拒绝
// （`{ code: 1, msg: '仅允许本机访问' }`）。
// 此外 mock 的口令是公开的字面量 `x`，任何能连到端口的人都能登录——不要把它开到局域网或公网。
//
// 已知取舍：`/album/list` 的 `sort=newTrackAddedAt,desc` **接受但忽略**——
// fixtures 里没有 `newTrackAddedAt` 字段，真实排序语义要等 Task 6 实测校准。
//
// 约定（与真实 NAS 保持一致，客户端靠业务码而不是 HTTP 状态码判断成败）：
// - 所有 JSON 响应统一信封 `{ code: 0, msg: '', data: ... }`；
//   出错时返回 `{ code: <非 0>, msg: '<可读中文>' }`，**HTTP 状态码仍是 200**；
// - 业务码 0 = 成功，99999 = token 失效（客户端据此走静默续期一次再重试）；
// - 所有列表型端点（含 detail 型）统一返回 `data: { list: [...], total: <全量条数> }`；
// - 所有列表型端点都支持服务端分页：`page`（1 起）+ `size`（默认 200，上限 2000）。
//
// 凭证：业务端点一律要求凭证，取值通道与真实 NAS 一致——**Cookie 头**里的 `music-token=<token>`
// （见 `electron/sign.ts` 的 `buildCookie()`；中继链路还在同一个 Cookie 头里带 `mode=relay`，mock 忽略它）。
// mock 额外容忍一个独立的 `music-token:` 请求头（仅调试便利），两者同时存在时以 Cookie 为准。
// 免凭证的端点只有 `/music/api/v1/health`、`/music/api/v1/sys/config`、`/music/api/v1/user/password-login`。
//
// 播放历史：`GET /music/api/v1/play-history/list`（实测确认端点存在、默认 50 条、total=414），
// 但**条目字段形状未实测**——mock 返回的是占位形状（`guid` + `playTime` + 内嵌 `track`），
// Task 16 需按真实响应校准。

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import {
  API_PREFIX,
  CODE_OK,
  CODE_TOKEN_EXPIRED,
  MUSIC_PATH,
  MUSIC_TOKEN_COOKIE,
} from '../shared/constants'
import {
  ALBUMS,
  ARTISTS,
  GENRES,
  INITIAL_PLAYLIST_TRACKS,
  LYRICS,
  PLAY_HISTORY,
  PLAYLISTS,
  SONGS,
  SYS_CONFIG,
  TRACK_GENRES,
  type RawAlbum,
  type RawArtist,
  type RawPlaylist,
  type RawSong,
} from './fixtures'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 音乐接口基址：`<server>/music/api/v1`。 */
const API_BASE = `${MUSIC_PATH}${API_PREFIX}`

/** 列表端点默认每页条数。 */
export const DEFAULT_PAGE_SIZE = 200

/** 列表端点每页条数上限（真实 NAS 同量级，防止一次性拉全量曲库）。 */
export const MAX_PAGE_SIZE = 2000

/** mock 的正确口令（明文）。 */
const VALID_PASSWORD = 'x'

// ---------------------------------------------------------------------------
// 自动更新（Task 23）
// ---------------------------------------------------------------------------
//
// ⚠️ **不走业务码信封**：更新清单**不是 NAS 接口**，而是一个普通的静态 JSON
//    （客户端按本项目自定义的形状解析，见 `electron/update.ts`）。
//
// ⚠️ 清单版本**故意比应用版本新**（`package.json` 的 `version` 现在是 0.1.0），
//    这样 E2E 才能断言「发现新版本」。

/** 清单里的版本号（占位）。 */
export const MOCK_UPDATE_VERSION = '9.9.9'

/** 清单里的假安装包文件名。 */
export const MOCK_UPDATE_INSTALLER_NAME = `FN-Music-Setup-${MOCK_UPDATE_VERSION}.exe`

/** 假安装包的字节内容（**不是真的 PE**——只够跑通「下载 + 哈希校验」）。 */
const MOCK_UPDATE_INSTALLER_BYTES = Buffer.from('MOCK-UPDATE-INSTALLER-PLACEHOLDER', 'utf8')

/** mock 的正确口令（SHA-256 小写十六进制），供发送摘要的客户端使用。 */
const VALID_PASSWORD_SHA256 =
  '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'

/**
 * WHATWG fetch 的**禁用端口**清单（`fetch` 规范附录 B）。
 *
 * 这些端口有协议语义（FTP/SMTP/IMAP/…），规范禁止脚本用 `fetch` 访问它们：
 * 打过去会直接抛 `TypeError: fetch failed` / `Error: bad port`，**请求根本不会发出**。
 *
 * 为什么 mock 要专门避开：本机用 `listen(0)` 让系统分配端口，而 Windows 的动态端口范围
 * 默认从 **1024** 起（`netsh int ipv4 show dynamicport tcp`），系统又是**顺序往上**分配的——
 * 一次测试跑出四十来个 mock server，就很容易从 9xxx 一路分配到 **10080**（本清单内），
 * 于是那个 server 变成「谁都连不上」，表现为随机飘红的 `bad port`。
 * 显式避开即可根除（而不是让测试去重试）。
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 564, 567, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4160, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6697, 10080,
])

/** 分配端口的最大尝试次数（落在禁用端口上就换一个）。 */
const MAX_PORT_ATTEMPTS = 10

/**
 * 关闭一个 server 并等它真正关闭（'close' 事件）。
 *
 * `server.close()` 会**同步**关掉监听句柄（端口即刻释放、新连接被拒），
 * 但 'close' 事件要等所有连接结束后才触发——这里等的就是这个「真正关闭」。
 * 服务未监听时 `close()` 会抛 `ERR_SERVER_NOT_RUNNING`，当作已关闭处理。
 */
function closeServerAsync(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/** mock 的可变状态；测试与后续任务可直接读写。 */
export interface MockState {
  /** 已收藏的曲目 guid。 */
  favorites: Set<string>
  /** 歌单：guid → 名称与曲目 guid 列表。 */
  playlists: Map<string, { guid: string; name: string; tracks: string[] }>
}

/** `createMockServer()` 的返回值。 */
export interface MockServer {
  /** 基址，形如 `http://127.0.0.1:<端口>`。 */
  url: string
  /**
   * 关闭服务并释放端口（可重复调用）。
   *
   * 返回的 Promise 在服务**真正关闭**（'close' 事件触发）后 resolve；
   * 不 await 也能用——监听句柄在调用瞬间就已释放（新连接会被拒）。
   */
  close: () => Promise<void>
  /** 可直接读写的状态。 */
  state: MockState
}

/** 成功信封。 */
interface OkEnvelope<T> {
  code: number
  msg: string
  data: T
}

/** 失败信封（HTTP 状态码仍是 200）。 */
interface ErrEnvelope {
  code: number
  msg: string
}

/** 路由处理上下文。 */
interface RouteCtx {
  /** 响应对象。 */
  res: ServerResponse
  /** 查询参数。 */
  query: URLSearchParams
  /** 请求体（POST 时为解析后的 JSON 对象）。 */
  body: Record<string, unknown>
  /** 本次请求携带的 token（已通过校验）。 */
  token: string
  /**
   * 本次请求的**原始请求头**（小写键名）。
   *
   * ⚠️ 加它是为了让 `track/stream` 能读 `Range` 头（拖动定位靠分段请求）。
   *    其余端点不读它。
   */
  headers: IncomingHttpHeaders
}

/** 路由处理函数。 */
type RouteHandler = (ctx: RouteCtx) => void

/**
 * 歌单元数据（**不含 `name`**）。
 *
 * 歌单名称以 `MockState.playlists` 为唯一真相源，元数据里再存一份就是会漂移的死字段。
 */
type PlaylistMeta = Omit<RawPlaylist, 'name'>

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 成功信封。 */
const ok = <T>(data: T): OkEnvelope<T> => ({ code: CODE_OK, msg: '', data })

/** 失败信封：业务码非 0，HTTP 状态码仍是 200。 */
const err = (code: number, msg: string): ErrEnvelope => ({ code, msg })

/**
 * 页码解析规则（导出以便单测钉住兜底行为）。
 *
 * 非法值（缺省 / 0 / 负数 / 非数字）一律回落 1。
 */
export function resolvePage(raw: string | null | undefined): number {
  const value = Number(raw ?? '1')
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.floor(value)
}

/**
 * 每页条数解析规则（导出以便单测钉住**上限**与兜底行为）。
 *
 * 非法值（缺省 / 0 / 负数 / 非数字）回落 `DEFAULT_PAGE_SIZE`；
 * 超过 `MAX_PAGE_SIZE` 一律截断到上限（真实 NAS 曲库 17.3 万首，不能一次性拉全量）。
 */
export function resolvePageSize(raw: string | null | undefined): number {
  const value = Number(raw ?? String(DEFAULT_PAGE_SIZE))
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE
  return Math.min(Math.floor(value), MAX_PAGE_SIZE)
}

/** 服务端分页：返回该页切片与全量 total。 */
function paginate<T>(items: T[], query: URLSearchParams): { list: T[]; total: number } {
  const page = resolvePage(query.get('page'))
  const size = resolvePageSize(query.get('size'))
  const start = (page - 1) * size
  return { list: items.slice(start, start + size), total: items.length }
}

/** 读取请求体文本。 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析 JSON 请求体；非对象或非法 JSON 返回 null。 */
function parseJsonBody(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** 读取请求体里的字符串字段。 */
function strField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

/** 读取请求体里的字符串数组字段。 */
function strArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 从 `Cookie` 头里取指定键的值。
 *
 * 真实 NAS 的凭证就是 Cookie（见 `electron/sign.ts` 的 `buildCookie()`：
 * `music-token=<token>; mode=relay`），因此 **Cookie 是 token 的唯一真实读取通道**。
 * `mode=relay`（中继模式）不是凭证键，这里只按名字取 `music-token`，中继标记自然被忽略。
 */
function readCookie(req: IncomingMessage, key: string): string | undefined {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== key) continue
    const value = part.slice(separator + 1).trim()
    if (!value) continue
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

/**
 * 读取请求携带的 token。
 *
 * 主通道是 **Cookie**：`Cookie: music-token=<token>`（真实 NAS 就是这么传的；
 * 中继链路还会在同一个 Cookie 头里附加 `mode=relay`，mock 不因此拒绝）。
 * 额外容忍一个独立的 `music-token:` 请求头（仅方便调试）；两者同时存在时**以 Cookie 为准**。
 */
function readToken(req: IncomingMessage): string | undefined {
  const fromCookie = readCookie(req, MUSIC_TOKEN_COOKIE)
  if (fromCookie) return fromCookie
  const raw = req.headers[MUSIC_TOKEN_COOKIE]
  const fromHeader = Array.isArray(raw) ? raw[0] : raw
  return fromHeader && fromHeader.length > 0 ? fromHeader : undefined
}

/**
 * 判断来源地址是否属于本机回环（导出以便单测）。
 *
 * Node 在双栈 socket 上把 IPv4 来源记成 IPv4-mapped IPv6（`::ffff:127.0.0.1`），
 * 因此这一形式也要判为回环。
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  const address = remoteAddress.trim().toLowerCase()
  if (!address) return false
  if (address === '::1') return true
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return mapped === '127.0.0.1' || mapped.startsWith('127.')
}

/** 发送 JSON 响应。 */
function sendJson(res: ServerResponse, payload: OkEnvelope<unknown> | ErrEnvelope): void {
  if (res.headersSent) return
  const text = JSON.stringify(payload)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
  })
  res.end(text)
}

/**
 * 发送**原始 JSON**（**不走业务码信封**）——自动更新清单用。
 *
 * ⚠️ 更新清单不是 NAS 接口：客户端按本项目自定义的形状解析
 *    （`electron/update.ts` 的 `parseUpdateManifest`），多包一层信封反而解析不了。
 */
function sendRawJson(res: ServerResponse, payload: unknown): void {
  if (res.headersSent) return
  const text = JSON.stringify(payload)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
  })
  res.end(text)
}

/** 发送二进制响应——自动更新的假安装包用。 */
function sendBinary(res: ServerResponse, bytes: Buffer, contentType = 'application/octet-stream'): void {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(bytes.byteLength),
  })
  res.end(bytes)
}

/**
 * 发送**纯文本**响应——外部歌词源用（T32）。
 *
 * ⚠️ 「自定义歌词 API」约定的是：响应体**就是纯文本 LRC**（不是 JSON、不是信封）。
 */
function sendText(res: ServerResponse, text: string, contentType = 'text/plain; charset=utf-8'): void {
  if (res.headersSent) return
  const bytes = Buffer.from(text, 'utf8')
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(bytes.byteLength),
  })
  res.end(bytes)
}

/**
 * 外部歌词源的**假 LRC**（T32）。
 *
 * ⚠️ 内容要**一眼能认出来** → E2E 才能断言「这行歌词确实来自外部源」。
 */
export const MOCK_EXTERNAL_LRC = '[00:01.00]外部歌词源第一行\n[00:02.00]外部歌词源第二行'

/** 造一份自动更新清单（哈希与假安装包一致 → 客户端的 SHA-512 校验能过）。 */
function buildUpdateManifest(): unknown {
  return {
    version: MOCK_UPDATE_VERSION,
    releasedAt: '2026-11-04T00:00:00.000Z',
    notes: '占位更新说明',
    files: [
      {
        name: MOCK_UPDATE_INSTALLER_NAME,
        url: MOCK_UPDATE_INSTALLER_NAME,
        sha512: createHash('sha512').update(MOCK_UPDATE_INSTALLER_BYTES).digest('hex'),
        size: MOCK_UPDATE_INSTALLER_BYTES.byteLength,
      },
    ],
  }
}

/**
 * 运行时合成 WAV（16-bit PCM、单声道、8000 Hz、**60 秒** 440Hz 正弦波）。
 *
 * WAV 头手工拼接（44 字节 canonical RIFF/WAVE + PCM data chunk），不引入第三方依赖。
 *
 * ⚠️ **时长为什么从 0.5 秒改成 60 秒**（T20）：
 *    曲库里的歌标称 165~240 秒，而真实音频只有 0.5 秒 → 媒体元素的 `durationchange`
 *    会把时长改成 0.5 秒 → 进度条的最大值也只有 0.5 秒 → **「拖动进度条定位」
 *    这条链路根本没机会被测**（拖一下歌就结束了）。
 *    60 秒足够把进度条拖到中段并观察定位结果。
 *
 * ⚠️ **结果要缓存**：60 秒 = 48 万个采样点，每次请求都重新合成会白白烧 CPU；
 *    缓存后只算一次，且 Range 切片有**稳定的字节基准**（测试要靠它比对切片是否正确）。
 */
function buildWav(): Buffer {
  if (cachedWav !== null) return cachedWav
  const sampleRate = 8000
  const seconds = 60
  const frequency = 440
  const samples = Math.round(sampleRate * seconds)
  const dataSize = samples * 2
  const buf = Buffer.alloc(44 + dataSize)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM 子块大小
  buf.writeUInt16LE(1, 20) // 音频格式：1 = PCM
  buf.writeUInt16LE(1, 22) // 声道数：单声道
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // 字节率
  buf.writeUInt16LE(2, 32) // 块对齐
  buf.writeUInt16LE(16, 34) // 位深
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate)
    // 幅度取 0.5，避免削顶失真。
    buf.writeInt16LE(Math.round(value * 32767 * 0.5), 44 + i * 2)
  }
  cachedWav = buf
  return buf
}

/**
 * 合成好的 WAV（**懒加载一次，之后复用**）。
 *
 * ⚠️ `null` = 还没合成过（模块级缓存；mock 的音频内容是固定的，不随状态变化）。
 */
let cachedWav: Buffer | null = null

/**
 * 解析 `Range: bytes=…` 请求头。
 *
 * ⚠️ **只支持单区间**（`bytes=N-M` / `bytes=N-` / `bytes=-N`）：
 *    多区间（`bytes=0-1,5-6`）是 multipart/byteranges，本 mock 不实现 → 当作不满足。
 *
 * @param header Range 头的原始值（`undefined` = 没有这个头）。
 * @param size 资源总字节数。
 * @returns
 * - `null`：没有 Range 头 → 按整段返回（HTTP 200）。
 * - `{ start, end }`：合法的**闭区间**（`end` 已钳到 `size - 1`）。
 * - `'unsatisfiable'`：范围不合法 / 起点越界 → 应答 HTTP 416。
 */
function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'unsatisfiable'
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'

  // 后缀形式 `bytes=-N`：最后 N 字节。
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  if (rawEnd === '') return { start, end: size - 1 }
  const end = Number(rawEnd)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

/**
 * 启动一个 mock server（监听系统分配的空闲端口）。
 *
 * 端口用 0 让系统分配；`listen(0)` 不带 host 时 **socket 绑定是同步的**，
 * 因此 `server.address()` 立刻能拿到真实端口，`url` 可以同步返回。
 * （带 host 时 Node 会把绑定推迟到 nextTick，`address()` 当时还是 null。）
 */
export function createMockServer(): MockServer {
  // ---- 状态 ----
  const state: MockState = {
    favorites: new Set<string>(),
    playlists: new Map<string, { guid: string; name: string; tracks: string[] }>(),
  }
  for (const playlist of PLAYLISTS) {
    state.playlists.set(playlist.guid, {
      guid: playlist.guid,
      name: playlist.name,
      tracks: [...(INITIAL_PLAYLIST_TRACKS[playlist.guid] ?? [])],
    })
  }

  /** 本实例签发的 token（每个 mock 实例独立）。 */
  const tokens = new Set<string>()

  /**
   * 歌单元数据（封面 / 描述 / 时间戳），与 `state.playlists` 分开存放以保持 MockState 的既定形状。
   *
   * **不含 `name`**：歌单名称以 `state.playlists` 为唯一真相源，这里再存一份就是会漂移的死字段。
   */
  const playlistMeta = new Map<string, PlaylistMeta>()
  for (const playlist of PLAYLISTS) {
    playlistMeta.set(playlist.guid, {
      guid: playlist.guid,
      coverId: playlist.coverId,
      trackCount: playlist.trackCount,
      description: playlist.description,
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
    })
  }

  /**
   * 单调递增的 **Unix 秒**时间戳。
   *
   * 服务端实测给的时间字段是 **Unix 秒**（不是 ISO 串），mock 与之一致。
   * 同一秒内的两次写回要能被区分（`playlist/update` 必须刷新 `updatedAt`），
   * 因此这里保证返回值**严格递增**（落在同一秒时人为 +1 秒）。
   */
  let lastTimestampSec = 0
  const nextTimestamp = (): number => {
    const now = Math.floor(Date.now() / 1000)
    lastTimestampSec = now > lastTimestampSec ? now : lastTimestampSec + 1
    return lastTimestampSec
  }

  // ---- 工具（依赖上面的状态） ----

  const songByGuid = (guid: string): RawSong | undefined =>
    SONGS.find((song) => song.guid === guid)

  const playlistList = (): RawPlaylist[] =>
    [...state.playlists.values()].map((playlist) => {
      const meta = playlistMeta.get(playlist.guid)
      return {
        guid: playlist.guid,
        name: playlist.name,
        coverId: meta?.coverId ?? null,
        trackCount: playlist.tracks.length,
        description: meta?.description ?? null,
        createdAt: meta?.createdAt ?? null,
        updatedAt: meta?.updatedAt ?? null,
      }
    })

  const nextPlaylistGuid = (): string => {
    let max = 0
    for (const guid of state.playlists.keys()) {
      const matched = /^p(\d+)$/.exec(guid)
      if (matched) max = Math.max(max, Number(matched[1]))
    }
    return `p${max + 1}`
  }

  /**
   * 搜索关键字。
   *
   * 缺 `q` / `q` 去空白后为空 → 返回 `undefined`（**不是空串**）：
   * 空串会让 `includes('')` 对每条都为真，等于「成功返回全量」，
   * 正好把「一次性拉全量曲库」的客户端 bug 掩盖掉（真实 NAS 是 17.3 万首）。
   */
  const searchKeyword = (query: URLSearchParams): string | undefined => {
    const raw = query.get('q') ?? query.get('keyword')
    if (raw === null) return undefined
    const trimmed = raw.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : undefined
  }

  // ---- 路由表（业务端点，均要求 token） ----

  const getRoutes = new Map<string, RouteHandler>()
  const postRoutes = new Map<string, RouteHandler>()

  getRoutes.set(`${API_BASE}/user/me`, ({ res }) => {
    sendJson(res, ok({ username: 'demo', nickName: '演示用户', guid: 'u1' }))
  })

  postRoutes.set(`${API_BASE}/user/logout`, ({ res, token }) => {
    tokens.delete(token)
    sendJson(res, ok({}))
  })

  getRoutes.set(`${API_BASE}/album/list`, ({ res, query }) => {
    sendJson(res, ok(paginate(ALBUMS, query)))
  })

  // ⚠️ **与真实 NAS 对齐（T18-3 真机实测）**：
  //    - 参数名是 `guid`（真实服务端用 `albumGUID` 会返回 `code=100002` invalid arguments）；
  //    - 响应 `data` 是**专辑对象本身**，不是 `{ list, total }` 列表信封。
  //    mock 必须与真实服务端同形，否则 E2E 测不出取法错误。
  getRoutes.set(`${API_BASE}/album/detail`, ({ res, query }) => {
    const guid = query.get('guid') ?? ''
    const album = ALBUMS.find((a) => a.guid === guid)
    if (!album) {
      sendJson(res, err(100002, 'invalid arguments'))
      return
    }
    sendJson(res, ok(album))
  })

  getRoutes.set(`${API_BASE}/album/artist-detail/list`, ({ res, query }) => {
    const guid = query.get('artistGUID') ?? ''
    const albums = ALBUMS.filter((a) => a.artists.some((artist) => artist.guid === guid))
    sendJson(res, ok(paginate(albums, query)))
  })

  getRoutes.set(`${API_BASE}/track/list`, ({ res, query }) => {
    sendJson(res, ok(paginate(SONGS, query)))
  })

  getRoutes.set(`${API_BASE}/track/album-detail/list`, ({ res, query }) => {
    const guid = query.get('albumGUID') ?? ''
    const songs = SONGS.filter((song) => song.album.guid === guid)
    sendJson(res, ok(paginate(songs, query)))
  })

  getRoutes.set(`${API_BASE}/track/artist-detail/list`, ({ res, query }) => {
    const guid = query.get('artistGUID') ?? ''
    const songs = SONGS.filter((song) => song.artists.some((artist) => artist.guid === guid))
    sendJson(res, ok(paginate(songs, query)))
  })

  getRoutes.set(`${API_BASE}/track/genre-detail/list`, ({ res, query }) => {
    const guid = query.get('genreGUID') ?? ''
    const songs = SONGS.filter((song) => (TRACK_GENRES[song.guid] ?? []).includes(guid))
    sendJson(res, ok(paginate(songs, query)))
  })

  getRoutes.set(`${API_BASE}/track/playlist-detail/list`, ({ res, query }) => {
    const guid = query.get('playlistGUID') ?? ''
    const playlist = state.playlists.get(guid)
    const tracks = playlist
      ? playlist.tracks
          .map((trackGuid) => songByGuid(trackGuid))
          .filter((song): song is RawSong => song !== undefined)
      : []
    sendJson(res, ok(paginate(tracks, query)))
  })

  getRoutes.set(`${API_BASE}/track/stream`, ({ res, query, headers }) => {
    const guid = query.get('guid') ?? ''
    if (!songByGuid(guid)) {
      sendJson(res, err(1, '歌曲不存在'))
      return
    }
    const wav = buildWav()

    // ⚠️ **Range / 206**（T20）：拖动进度条定位靠分段请求。
    //    没有 Range 头 → 整段 200（但**必须**带 `accept-ranges: bytes`，
    //    否则客户端不知道这个资源可以分段请求）。
    const range = parseByteRange(headers.range, wav.length)
    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        'content-type': 'audio/wav',
        'content-length': '0',
        'accept-ranges': 'bytes',
        'content-range': `bytes */${wav.length}`,
      })
      res.end()
      return
    }
    if (range === null) {
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(wav.length),
        'accept-ranges': 'bytes',
      })
      res.end(wav)
      return
    }
    const slice = wav.subarray(range.start, range.end + 1)
    res.writeHead(206, {
      'content-type': 'audio/wav',
      'content-length': String(slice.length),
      'accept-ranges': 'bytes',
      'content-range': `bytes ${range.start}-${range.end}/${wav.length}`,
    })
    res.end(slice)
  })

  getRoutes.set(`${API_BASE}/favorite-track/list`, ({ res, query }) => {
    const songs = SONGS.filter((song) => state.favorites.has(song.guid))
    sendJson(res, ok(paginate(songs, query)))
  })

  postRoutes.set(`${API_BASE}/favorite-track/create`, ({ res, body }) => {
    const guid = strField(body, 'trackGUID')
    if (!guid || !songByGuid(guid)) {
      sendJson(res, err(1, '歌曲不存在'))
      return
    }
    state.favorites.add(guid)
    sendJson(res, ok({ trackGUID: guid }))
  })

  postRoutes.set(`${API_BASE}/favorite-track/delete`, ({ res, body }) => {
    const guid = strField(body, 'trackGUID')
    if (!guid || !songByGuid(guid)) {
      sendJson(res, err(1, '歌曲不存在'))
      return
    }
    state.favorites.delete(guid)
    sendJson(res, ok({ trackGUID: guid }))
  })

  getRoutes.set(`${API_BASE}/artist/list`, ({ res, query }) => {
    sendJson(res, ok(paginate(ARTISTS, query)))
  })

  getRoutes.set(`${API_BASE}/genre/list`, ({ res, query }) => {
    sendJson(res, ok(paginate(GENRES, query)))
  })

  getRoutes.set(`${API_BASE}/playlist/list`, ({ res, query }) => {
    sendJson(res, ok(paginate(playlistList(), query)))
  })

  postRoutes.set(`${API_BASE}/playlist/create`, ({ res, body }) => {
    const name = strField(body, 'name')
    if (!name) {
      sendJson(res, err(1, '歌单名称不能为空'))
      return
    }
    const guid = nextPlaylistGuid()
    const now = nextTimestamp()
    state.playlists.set(guid, { guid, name, tracks: [] })
    playlistMeta.set(guid, {
      guid,
      coverId: null,
      trackCount: 0,
      description: null,
      createdAt: now,
      updatedAt: now,
    })
    sendJson(res, ok({ guid }))
  })

  postRoutes.set(`${API_BASE}/playlist/update`, ({ res, body }) => {
    const guid = strField(body, 'guid')
    if (!guid) {
      sendJson(res, err(1, '歌单不存在'))
      return
    }
    const playlist = state.playlists.get(guid)
    if (!playlist) {
      sendJson(res, err(1, '歌单不存在'))
      return
    }
    const name = strField(body, 'name')
    if (!name) {
      sendJson(res, err(1, '歌单名称不能为空'))
      return
    }
    playlist.name = name
    // 改名要刷新 updatedAt（否则 /playlist/list 会一直返回旧时间戳）。
    const meta = playlistMeta.get(guid)
    if (meta) meta.updatedAt = nextTimestamp()
    sendJson(res, ok({ guid }))
  })

  postRoutes.set(`${API_BASE}/playlist/delete`, ({ res, body }) => {
    const guid = strField(body, 'guid')
    if (!guid || !state.playlists.has(guid)) {
      sendJson(res, err(1, '歌单不存在'))
      return
    }
    state.playlists.delete(guid)
    playlistMeta.delete(guid)
    sendJson(res, ok({ guid }))
  })

  postRoutes.set(`${API_BASE}/playlist/add-track`, ({ res, body }) => {
    const guid = strField(body, 'guid')
    if (!guid) {
      sendJson(res, err(1, '歌单不存在'))
      return
    }
    const playlist = state.playlists.get(guid)
    if (!playlist) {
      sendJson(res, err(1, '歌单不存在'))
      return
    }
    const trackGuids = strArrayField(body, 'trackGUIDs')
    // 逐个校验曲目存在性：不存在则整个请求失败（不部分写入），
    // 否则 /playlist/list 的 trackCount 会与 /track/playlist-detail/list 的 total 永久不一致。
    for (const trackGuid of trackGuids) {
      if (!songByGuid(trackGuid)) {
        sendJson(res, err(1, '歌曲不存在'))
        return
      }
    }
    for (const trackGuid of trackGuids) {
      if (!playlist.tracks.includes(trackGuid)) playlist.tracks.push(trackGuid)
    }
    sendJson(res, ok({ guid, trackCount: playlist.tracks.length }))
  })

  postRoutes.set(`${API_BASE}/playlist/remove-track`, ({ res, body }) => {
    const guid = strField(body, 'guid')
    if (!guid) {
      sendJson(res, err(1, '歌单不存在'))
      return
    }
    const playlist = state.playlists.get(guid)
    if (!playlist) {
      sendJson(res, err(1, '歌单不存在'))
      return
    }
    const removing = strArrayField(body, 'trackGUIDs')
    for (const trackGuid of removing) {
      if (!songByGuid(trackGuid)) {
        sendJson(res, err(1, '歌曲不存在'))
        return
      }
    }
    const removingSet = new Set(removing)
    playlist.tracks = playlist.tracks.filter((trackGuid) => !removingSet.has(trackGuid))
    sendJson(res, ok({ guid, trackCount: playlist.tracks.length }))
  })

  getRoutes.set(`${API_BASE}/search/track`, ({ res, query }) => {
    const keyword = searchKeyword(query)
    if (!keyword) {
      // 缺关键字 / 关键字为空 → 空列表（不返回全量）。
      sendJson(res, ok(paginate<RawSong>([], query)))
      return
    }
    const hits = SONGS.filter(
      (song) =>
        song.title.toLowerCase().includes(keyword) ||
        song.album.name.toLowerCase().includes(keyword) ||
        song.artists.some((artist) => artist.name.toLowerCase().includes(keyword)),
    )
    sendJson(res, ok(paginate(hits, query)))
  })

  getRoutes.set(`${API_BASE}/search/album`, ({ res, query }) => {
    const keyword = searchKeyword(query)
    if (!keyword) {
      sendJson(res, ok(paginate<RawAlbum>([], query)))
      return
    }
    const hits = ALBUMS.filter(
      (album) =>
        album.name.toLowerCase().includes(keyword) ||
        album.artists.some((artist) => artist.name.toLowerCase().includes(keyword)),
    )
    sendJson(res, ok(paginate(hits, query)))
  })

  getRoutes.set(`${API_BASE}/search/artist`, ({ res, query }) => {
    const keyword = searchKeyword(query)
    if (!keyword) {
      sendJson(res, ok(paginate<RawArtist>([], query)))
      return
    }
    const hits = ARTISTS.filter((artist) => artist.name.toLowerCase().includes(keyword))
    sendJson(res, ok(paginate(hits, query)))
  })

  getRoutes.set(`${API_BASE}/lyric/list`, ({ res, query }) => {
    const guid = query.get('trackGUID') ?? ''
    const lyric = LYRICS.get(guid)
    const list = lyric ? [lyric] : []
    sendJson(res, ok(paginate(list, query)))
  })

  // 播放历史（实测确认的端点；条目形状未实测，见 fixtures 的说明）。
  getRoutes.set(`${API_BASE}/play-history/list`, ({ res, query }) => {
    sendJson(res, ok(paginate(PLAY_HISTORY, query)))
  })

  // ---- 请求处理 ----

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()
    const query = url.searchParams

    // 回环守卫：socket 监听所有网卡（见文件头），非本机来源一律拒绝，
    // 避免这个「口令 x 即可登录」的 dev 服务被同网段机器访问。
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, err(1, '仅允许本机访问'))
      return
    }

    // 免 token 端点：health
    if (method === 'GET' && path === `${API_BASE}/health`) {
      sendJson(res, ok({ status: 'ok' }))
      return
    }

    // 免 token 端点：系统配置
    // ⚠️ 实测（规格 §15.8）：真实路径在**音乐 API 前缀**下 —— `/music/api/v1/sys/config`；
    // 旧的 `/sys/config` 实测是 404 + HTML。
    if (method === 'GET' && path === `${API_BASE}/sys/config`) {
      sendJson(res, ok(SYS_CONFIG))
      return
    }

    // 免 token 端点：密码登录
    if (method === 'POST' && path === `${API_BASE}/user/password-login`) {
      const parsed = parseJsonBody(await readBody(req))
      if (!parsed) {
        sendJson(res, err(1, '请求体不是合法的 JSON 对象'))
        return
      }
      const password = strField(parsed, 'password')
      if (password !== VALID_PASSWORD && password !== VALID_PASSWORD_SHA256) {
        sendJson(res, err(1, '账号或密码错误'))
        return
      }
      const token = `mock-token-${randomBytes(8).toString('hex')}`
      tokens.add(token)
      sendJson(res, ok({ userToken: token, deviceId: strField(parsed, 'deviceId') ?? '' }))
      return
    }

    // 免 token 端点：自动更新清单（Task 23）
    //
    // ⚠️ **免 token + 免业务码信封**：它不是 NAS 接口，
    //    而是一个普通的静态 JSON（客户端按本项目自定义的形状解析）。
    if (method === 'GET' && path === '/update/latest.json') {
      sendRawJson(res, buildUpdateManifest())
      return
    }
    // 免 token 端点：假安装包（**不是真的 PE**——只够跑通「下载 + 哈希校验」）。
    if (method === 'GET' && path === `/update/${MOCK_UPDATE_INSTALLER_NAME}`) {
      sendBinary(res, MOCK_UPDATE_INSTALLER_BYTES)
      return
    }

    // 免 token 端点：**外部歌词源**（T32）。
    //
    // ⚠️ 它**不是** NAS 接口：没有业务码信封、没有 token，
    //    响应体**就是纯文本 LRC**（与「自定义歌词 API」的约定一致）。
    // ⚠️ 用来验「NAS 没歌词 → 外部补齐」这条链路。
    if (method === 'GET' && path === '/mock-lyric') {
      sendText(res, MOCK_EXTERNAL_LRC)
      return
    }

    // 未知路径先判 404（业务码非 0），**再**走 token 闸门：
    // 否则客户端把路径写错时看到的是「token 失效」，会白白触发一次静默续期再重试。
    const known = getRoutes.has(path) || postRoutes.has(path)
    if (!known) {
      sendJson(res, err(404, '接口不存在'))
      return
    }

    // 其余端点一律要求凭证（真实 NAS 从 Cookie 头读 `music-token`）；
    // 缺失或不匹配 → 业务码 99999，HTTP 仍是 200。
    const token = readToken(req)
    if (!token || !tokens.has(token)) {
      sendJson(res, err(CODE_TOKEN_EXPIRED, 'invalid token'))
      return
    }

    let body: Record<string, unknown> = {}
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req))
      if (!parsed) {
        sendJson(res, err(1, '请求体不是合法的 JSON 对象'))
        return
      }
      body = parsed
    }

    const routes = method === 'GET' ? getRoutes : method === 'POST' ? postRoutes : undefined
    const handler = routes?.get(path)
    if (!handler) {
      sendJson(res, err(405, '请求方法不支持'))
      return
    }
    handler({ res, query, body, token, headers: req.headers })
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((cause: unknown) => {
      sendJson(
        res,
        err(1, `mock 内部错误：${cause instanceof Error ? cause.message : String(cause)}`),
      )
    })
  }

  // 端口 0 = 由系统分配；不带 host 时绑定是同步的，address() 立刻可用。
  // 落在 fetch 的「禁用端口」上就关掉重开（系统会分配下一个端口）——
  // 见 FETCH_BLOCKED_PORTS 的说明：这类端口 `fetch` 根本不让连。
  let server = createServer(requestHandler)
  let port = 0
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    server.listen(0)
    const address = server.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
    if (!FETCH_BLOCKED_PORTS.has(port)) break
    // 落在禁用端口上：这个 server 谁也连不上，直接弃用。
    // `close()` 会**同步**关掉监听句柄（端口即刻释放），'close' 事件在下一个 tick 触发；
    // 这里登记一下关闭收尾，避免留下未收尾的句柄。
    void closeServerAsync(server)
    server = createServer(requestHandler)
  }
  if (FETCH_BLOCKED_PORTS.has(port)) {
    // 重试耗尽还落在禁用端口上：直接抛错，别静默返回一个连不上的 server。
    void closeServerAsync(server)
    throw new Error(
      `mock server 连续 ${MAX_PORT_ATTEMPTS} 次都分到 fetch 的禁用端口（最后是 ${port}），无法启动`,
    )
  }

  let closed = false
  /** 关闭完成的信号（'close' 事件真正触发后才 resolve）。 */
  let closedPromise: Promise<void> | null = null

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => {
      if (closed) return closedPromise ?? Promise.resolve()
      closed = true
      // Node 的全局 fetch（undici）会保持 keep-alive 连接，必须显式销毁，
      // 否则 vitest 进程会一直挂住不退出。
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      // 等到 'close' 事件才算真正关闭（监听句柄此刻已同步释放，新连接会被拒）。
      closedPromise = closeServerAsync(server)
      return closedPromise
    },
  }
}
