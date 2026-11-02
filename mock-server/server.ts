// 飞牛音乐 API 的 mock server（无 NAS 开发前提）。
//
// 用途：Task 6+（API 客户端、登录界面、曲库浏览、播放、收藏、歌单、歌词）在没有真实 NAS 时
// 也能开发与测试。本 server 是 Task 6+ 的**唯一数据来源**。
//
// 约定（与真实 NAS 保持一致，客户端靠业务码而不是 HTTP 状态码判断成败）：
// - 所有 JSON 响应统一信封 `{ code: 0, msg: '', data: ... }`；
//   出错时返回 `{ code: <非 0>, msg: '<可读中文>' }`，**HTTP 状态码仍是 200**；
// - 业务码 0 = 成功，99999 = token 失效（客户端据此走静默续期一次再重试）；
// - 所有列表型端点（含 detail 型）统一返回 `data: { list: [...], total: <全量条数> }`；
// - 所有列表型端点都支持服务端分页：`page`（1 起）+ `size`（默认 200，上限 2000）。
//
// token：业务端点一律要求 `music-token` 头（值必须是本 mock 签发的 token）；
// 免 token 的端点只有 `/music/api/v1/health`、`/sys/config`、`/music/api/v1/user/password-login`。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
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
  PLAYLISTS,
  SONGS,
  TRACK_GENRES,
  type RawPlaylist,
  type RawSong,
} from './fixtures'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 音乐接口基址：`<server>/music/api/v1`。 */
const API_BASE = `${MUSIC_PATH}${API_PREFIX}`

/** 列表端点默认每页条数。 */
const DEFAULT_PAGE_SIZE = 200

/** 列表端点每页条数上限（真实 NAS 同量级，防止一次性拉全量曲库）。 */
const MAX_PAGE_SIZE = 2000

/** mock 的正确口令（明文）。 */
const VALID_PASSWORD = 'x'

/** mock 的正确口令（SHA-256 小写十六进制），供发送摘要的客户端使用。 */
const VALID_PASSWORD_SHA256 =
  '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'

/** `/sys/config` 的返回内容。 */
const SYS_CONFIG = {
  musicEnabled: true,
  musicVersion: '1.0.0',
  supportRelay: true,
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
  /** 关闭服务并释放端口（可重复调用）。 */
  close: () => void
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
}

/** 路由处理函数。 */
type RouteHandler = (ctx: RouteCtx) => void

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 成功信封。 */
const ok = <T>(data: T): OkEnvelope<T> => ({ code: CODE_OK, msg: '', data })

/** 失败信封：业务码非 0，HTTP 状态码仍是 200。 */
const err = (code: number, msg: string): ErrEnvelope => ({ code, msg })

/** 读取正整数分页参数；非法值回落默认值。 */
function readPage(query: URLSearchParams): number {
  const raw = Number(query.get('page') ?? '1')
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.floor(raw)
}

/** 读取每页条数；非法值回落默认值，超过上限则截断。 */
function readSize(query: URLSearchParams): number {
  const raw = Number(query.get('size') ?? String(DEFAULT_PAGE_SIZE))
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PAGE_SIZE
  return Math.min(Math.floor(raw), MAX_PAGE_SIZE)
}

/** 服务端分页：返回该页切片与全量 total。 */
function paginate<T>(items: T[], query: URLSearchParams): { list: T[]; total: number } {
  const page = readPage(query)
  const size = readSize(query)
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

/** 取请求头里的 token。 */
function readToken(req: IncomingMessage): string | undefined {
  const raw = req.headers[MUSIC_TOKEN_COOKIE]
  const token = Array.isArray(raw) ? raw[0] : raw
  return token && token.length > 0 ? token : undefined
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
 * 运行时合成 WAV（16-bit PCM、单声道、8000 Hz、0.5 秒 440Hz 正弦波）。
 *
 * WAV 头手工拼接（44 字节 canonical RIFF/WAVE + PCM data chunk），不引入第三方依赖。
 */
function buildWav(): Buffer {
  const sampleRate = 8000
  const seconds = 0.5
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
  return buf
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

  /** 歌单元数据（封面 / 描述 / 时间戳），与 `state.playlists` 分开存放以保持 MockState 的既定形状。 */
  const playlistMeta = new Map<string, RawPlaylist>()
  for (const playlist of PLAYLISTS) playlistMeta.set(playlist.guid, { ...playlist })

  // ---- 工具（依赖上面的状态） ----

  const songByGuid = (guid: string): RawSong | undefined =>
    SONGS.find((song) => song.guid === guid)

  const playlistList = (): RawPlaylist[] =>
    [...state.playlists.values()].map((playlist) => {
      const meta = playlistMeta.get(playlist.guid)
      const now = new Date().toISOString()
      return {
        guid: playlist.guid,
        name: playlist.name,
        coverId: meta?.coverId ?? null,
        trackCount: playlist.tracks.length,
        description: meta?.description ?? null,
        createdAt: meta?.createdAt ?? now,
        updatedAt: meta?.updatedAt ?? now,
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

  const searchKeyword = (query: URLSearchParams): string =>
    (query.get('q') ?? query.get('keyword') ?? '').trim().toLowerCase()

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

  getRoutes.set(`${API_BASE}/album/detail`, ({ res, query }) => {
    const guid = query.get('albumGUID') ?? ''
    sendJson(res, ok(paginate(ALBUMS.filter((a) => a.guid === guid), query)))
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

  getRoutes.set(`${API_BASE}/track/stream`, ({ res, query }) => {
    const guid = query.get('guid') ?? ''
    if (!songByGuid(guid)) {
      sendJson(res, err(1, '歌曲不存在'))
      return
    }
    // 本任务不实现 Range / 206（真实 NAS 支持，但属于播放任务的范围）；
    // 这里只返回整段 WAV，留好扩展位：将来加 Range 只需在此分支前处理 range 头。
    const wav = buildWav()
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(wav.length),
    })
    res.end(wav)
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
    const now = new Date().toISOString()
    state.playlists.set(guid, { guid, name, tracks: [] })
    playlistMeta.set(guid, {
      guid,
      name,
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
    const meta = playlistMeta.get(guid)
    if (meta) meta.name = name
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
    for (const trackGuid of strArrayField(body, 'trackGUIDs')) {
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
    const removing = new Set(strArrayField(body, 'trackGUIDs'))
    playlist.tracks = playlist.tracks.filter((trackGuid) => !removing.has(trackGuid))
    sendJson(res, ok({ guid, trackCount: playlist.tracks.length }))
  })

  getRoutes.set(`${API_BASE}/search/track`, ({ res, query }) => {
    const keyword = searchKeyword(query)
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
    const hits = ALBUMS.filter(
      (album) =>
        album.name.toLowerCase().includes(keyword) ||
        album.artists.some((artist) => artist.name.toLowerCase().includes(keyword)),
    )
    sendJson(res, ok(paginate(hits, query)))
  })

  getRoutes.set(`${API_BASE}/search/artist`, ({ res, query }) => {
    const keyword = searchKeyword(query)
    const hits = ARTISTS.filter((artist) => artist.name.toLowerCase().includes(keyword))
    sendJson(res, ok(paginate(hits, query)))
  })

  getRoutes.set(`${API_BASE}/lyric/list`, ({ res, query }) => {
    const guid = query.get('trackGUID') ?? ''
    const lyric = LYRICS.get(guid)
    const list = lyric ? [lyric] : []
    sendJson(res, ok(paginate(list, query)))
  })

  // ---- 请求处理 ----

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()
    const query = url.searchParams

    // 免 token 端点：health
    if (method === 'GET' && path === `${API_BASE}/health`) {
      sendJson(res, ok({ status: 'ok' }))
      return
    }

    // 免 token 端点：系统配置
    if (method === 'GET' && path === '/sys/config') {
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

    // 其余端点一律要求 music-token 头（缺失或不匹配 → 业务码 99999，HTTP 仍是 200）。
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
      const known = getRoutes.has(path) || postRoutes.has(path)
      sendJson(res, known ? err(405, '请求方法不支持') : err(404, '接口不存在'))
      return
    }
    handler({ res, query, body, token })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      sendJson(
        res,
        err(1, `mock 内部错误：${cause instanceof Error ? cause.message : String(cause)}`),
      )
    })
  })

  // 端口 0 = 由系统分配；不带 host 时绑定是同步的，address() 立刻可用。
  server.listen(0)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  let closed = false

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => {
      if (closed) return
      closed = true
      // Node 的全局 fetch（undici）会保持 keep-alive 连接，必须显式销毁，
      // 否则 vitest 进程会一直挂住不退出。
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      try {
        server.close()
      } catch {
        // 服务未监听时 close() 会抛 ERR_SERVER_NOT_RUNNING，忽略即可。
      }
    },
  }
}
