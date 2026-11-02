import { describe, it, expect, vi, afterEach, beforeAll, beforeEach, afterAll } from 'vitest'
import { ApiError, apiCall, mapAlbum, mapArtist, mapPlaylist, mapSong } from '../src/api/client'
import { libraryApi } from '../src/api/library'
import { favoriteApi } from '../src/api/favorite'
import { playlistApi } from '../src/api/playlist'
import { searchApi } from '../src/api/search'
import { lyricApi } from '../src/api/lyric'
import { historyApi } from '../src/api/history'
import { createMockServer, type MockServer } from '../mock-server/server'

// ---------------------------------------------------------------------------
// Task 6：渲染进程 API 客户端与数据映射
//
// 简报 Step 1 的四条用例**逐字保留其测试意图**（解析信封 / 业务码抛错 / 协议前缀 / mapSong 映射）；
// 唯一改动：`f.mock.calls[0][0]` 改成 `f.mock.calls[0]?.[0]`——
// `noUncheckedIndexedAccess` 下 `calls[0]` 可能为 `undefined`，不写可选链过不了 `tsc --noEmit`。
// 断言的行为本身没变。
//
// 本文件分两段：
// - 单元段：桩掉 `fetch`，钉死「URL / 方法 / 请求体 / 响应解析 / 映射规则」；
// - 集成段：真的起一个 mock server，用 fetch 包装器把 `fnm://srv/...` 翻译成
//   `<mock>/music/api/v1/...` 并补上服务端要求的凭据，走真实 HTTP。
// ---------------------------------------------------------------------------

/** 一次 fetch 调用的快照。 */
interface FetchCall {
  /** 请求 URL。 */
  url: string
  /** HTTP 方法。 */
  method: string
  /** 请求头（拍平成普通对象，便于断言）。 */
  headers: Record<string, string>
  /** 请求体（字符串形态）。 */
  body: string | undefined
}

/** 把 `RequestInit` 拍平成可断言的快照。 */
function snapshot(init: RequestInit | undefined): Omit<FetchCall, 'url'> {
  const headers: Record<string, string> = {}
  const raw = init?.headers
  if (raw) {
    if (raw instanceof Headers) {
      raw.forEach((value, name) => {
        headers[name] = value
      })
    } else if (Array.isArray(raw)) {
      for (const entry of raw) {
        const name = entry[0]
        const value = entry[1]
        if (name !== undefined && value !== undefined) headers[name] = value
      }
    } else {
      Object.assign(headers, raw)
    }
  }
  return {
    method: init?.method ?? 'GET',
    headers,
    body: typeof init?.body === 'string' ? init.body : undefined,
  }
}

/**
 * 装一个返回固定信封的 fetch 桩，并记录调用。
 *
 * @param envelope 直接作为响应体（传字符串可以模拟「不是 JSON」的响应）
 */
function stubEnvelopeFetch(envelope: unknown, status = 200): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, ...snapshot(init) })
    const text = typeof envelope === 'string' ? envelope : JSON.stringify(envelope)
    return new Response(text, { status })
  })
  return calls
}

/** 未被桩掉的原生 fetch（模块加载时捕获，之后 stub 也改不动它）。 */
const realFetch = globalThis.fetch.bind(globalThis) as typeof fetch

/**
 * 集成段的 fetch 包装器：把 `fnm://srv<rest>` 翻译成 `<mock>/music/api/v1<rest>`，
 * 并补上服务端要求的凭据头（**模拟主进程协议代理的职责**）。
 *
 * 包装器**只记录客户端自己发出的请求头**（补凭据之前的那一份），
 * 这样才能断言「渲染进程自己不带凭据」。
 */
function installBridge(mockUrl: string, credential: string, seen: FetchCall[]): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const snap = snapshot(init)
    seen.push({ url, ...snap })
    if (!url.startsWith('fnm://srv')) return realFetch(input, init)
    const rest = url.slice('fnm://srv'.length)
    const headers = new Headers(snap.headers)
    headers.set('cookie', `music-token=${credential}`)
    return realFetch(`${mockUrl}/music/api/v1${rest}`, { ...init, headers })
  })
}

// ---------------------------------------------------------------------------
// apiCall
// ---------------------------------------------------------------------------

describe('apiCall', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('解析 { code, data } 包装', async () => {
    stubEnvelopeFetch({ code: 0, msg: '', data: { ok: 1 } })
    expect(await apiCall('/album/list')).toEqual({ ok: 1 })
  })

  it('code 非 0 抛出带 code 的错误', async () => {
    stubEnvelopeFetch({ code: 99999, msg: 'expired' })
    await expect(apiCall('/album/list')).rejects.toThrow(/expired/)
  })

  it('走 fnm:// 协议前缀', async () => {
    const calls = stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    await apiCall('/album/list')
    expect(String(calls[0]?.url)).toContain('fnm://srv')
  })

  it('业务错误抛的是 ApiError，带上服务端 msg 与 code', async () => {
    stubEnvelopeFetch({ code: 99999, msg: 'invalid token' })
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe(99999)
    expect((error as ApiError).message).toContain('invalid token')
  })

  it('业务码非 0 且服务端没给 msg 时消息里仍有 code', async () => {
    stubEnvelopeFetch({ code: 1 })
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe(1)
    expect((error as ApiError).message).toContain('1')
  })

  it('响应不是 JSON 时抛「服务器响应异常（HTTP n）」', async () => {
    stubEnvelopeFetch('<html>gateway error</html>', 502)
    await expect(apiCall('/album/list')).rejects.toThrow('服务器响应异常（HTTP 502）')
  })

  it('响应是 JSON 但不是信封时同样抛 HTTP 异常', async () => {
    stubEnvelopeFetch({ hello: 'world' }, 200)
    await expect(apiCall('/album/list')).rejects.toThrow('服务器响应异常（HTTP 200）')
  })

  it('data 缺失时返回空对象', async () => {
    stubEnvelopeFetch({ code: 0, msg: '' })
    expect(await apiCall('/album/list')).toEqual({})
  })

  it('data 为 null 时返回空对象', async () => {
    stubEnvelopeFetch({ code: 0, msg: '', data: null })
    expect(await apiCall('/album/list')).toEqual({})
  })

  it('查询串跳过 undefined 并保留数字', async () => {
    const calls = stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    await apiCall('/album/list', { query: { page: 2, size: 30, sort: undefined } })
    expect(calls[0]?.url).toBe('fnm://srv/album/list?page=2&size=30')
  })

  it('POST 时把 body 序列化成 JSON 并声明 content-type', async () => {
    const calls = stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    await apiCall('/playlist/create', { method: 'POST', body: { name: '歌单' } })
    const call = calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ name: '歌单' })
  })

  it('GET 请求不带 body 也不声明 content-type', async () => {
    const calls = stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    await apiCall('/album/list')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.body).toBeUndefined()
    expect(calls[0]?.headers['content-type']).toBeUndefined()
  })

  it('渲染进程不发送任何凭据类请求头', async () => {
    const calls = stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    await apiCall('/album/list', { method: 'POST', body: { name: 'x' } })
    const forbidden = /cookie|authx|authorization|music-token|token/i
    for (const call of calls) {
      for (const [name, value] of Object.entries(call.headers)) {
        expect(`${name}:${value}`).not.toMatch(forbidden)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 映射规则
// ---------------------------------------------------------------------------

describe('mapSong', () => {
  it('时长从毫秒转秒并丢弃非法封面', () => {
    const s = mapSong({
      guid: 'g',
      title: 'T',
      duration: 185000,
      coverId: 'deadbeef',
      artists: [{ name: 'A', guid: 'a1' }],
      album: { name: 'Al', guid: 'al1' },
      audioSpec: { path: '/x/y.flac', codec: 'flac', bitrate: 900000, sampleRate: 44100 },
    })
    expect(s.duration).toBe(185)
    expect(s.coverId).toBe('')
    expect(s.codec).toBe('FLAC')
    expect(s.bitrate).toBe(900)
  })

  it('合法封面（xxx_<hex>）原样保留，null 封面置空串', () => {
    expect(mapSong({ guid: 'g', title: 'T', coverId: 'cover_0123456789abcdef' }).coverId).toBe(
      'cover_0123456789abcdef',
    )
    expect(mapSong({ guid: 'g', title: 'T', coverId: null }).coverId).toBe('')
    expect(mapSong({ guid: 'g', title: 'T' }).coverId).toBe('')
    expect(mapSong({ guid: 'g', title: 'T', coverId: 'cover_zzz' }).coverId).toBe('')
  })

  it('codec 缺失时用 path 的扩展名兜底并转大写', () => {
    const s = mapSong({
      guid: 'g',
      title: 'T',
      audioSpec: { path: '/music/x/y.MP3' },
    })
    expect(s.codec).toBe('MP3')
  })

  it('codec 与扩展名都没有时置空串', () => {
    expect(mapSong({ guid: 'g', title: 'T', audioSpec: {} }).codec).toBe('')
    expect(mapSong({ guid: 'g', title: 'T' }).codec).toBe('')
  })

  it('缺失的 bitrate / sampleRate / bitDepth 兜底为 0', () => {
    const s = mapSong({ guid: 'g', title: 'T', audioSpec: { codec: 'flac' } })
    expect(s.bitrate).toBe(0)
    expect(s.sampleRate).toBe(0)
    expect(s.bitDepth).toBe(0)
  })

  it('多歌手用 " / " 连接，artistId 取首个歌手', () => {
    const s = mapSong({
      guid: 'g',
      title: 'T',
      artists: [
        { guid: 'a1', name: '甲' },
        { guid: 'a2', name: '乙' },
      ],
    })
    expect(s.artist).toBe('甲 / 乙')
    expect(s.artistId).toBe('a1')
  })

  it('year / trackNo / discNo 保留 null，不转 0', () => {
    const s = mapSong({
      guid: 'g',
      title: 'T',
      year: null,
      trackNo: null,
      discNo: null,
      releaseDate: null,
    })
    expect(s.year).toBeNull()
    expect(s.trackNo).toBeNull()
    expect(s.discNo).toBeNull()
    expect(s.releaseDate).toBeNull()
  })

  it('album / albumId 取自内嵌专辑对象', () => {
    const s = mapSong({ guid: 'g', title: 'T', album: { guid: 'al1', name: '专辑' } })
    expect(s.album).toBe('专辑')
    expect(s.albumId).toBe('al1')
  })

  it('favorite 恒为 false（收藏态由 favoriteApi 维护）', () => {
    expect(mapSong({ guid: 'g', title: 'T' }).favorite).toBe(false)
  })

  it('audioSpec 原样透传：duration 仍是毫秒、bitrate 仍是 bps', () => {
    const s = mapSong({
      guid: 'g',
      title: 'T',
      audioSpec: {
        bitDepth: 16,
        sampleRate: 44100,
        channel: 2,
        bitrate: 900000,
        codec: 'flac',
        container: 'flac',
        duration: 185000,
        format: 'flac',
        path: '/music/sample/t1.flac',
        size: 30000000,
      },
    })
    expect(s.audioSpec?.duration).toBe(185000)
    expect(s.audioSpec?.bitrate).toBe(900000)
    expect(s.audioSpec?.path).toBe('/music/sample/t1.flac')
  })

  it('audioSpec 缺失时该字段缺省', () => {
    expect(mapSong({ guid: 'g', title: 'T' }).audioSpec).toBeUndefined()
  })
})

describe('mapAlbum / mapArtist / mapPlaylist', () => {
  it('专辑：guid→id、name→title、coverId 无封面为 null、trackCount 缺失为 0', () => {
    const album = mapAlbum({ guid: 'al1', name: '专辑一' })
    expect(album.id).toBe('al1')
    expect(album.title).toBe('专辑一')
    expect(album.coverId).toBeNull()
    expect(album.trackCount).toBe(0)
    expect(album.year).toBeNull()
  })

  it('专辑：多歌手用 " / " 连接，artistId 取首个', () => {
    const album = mapAlbum({
      guid: 'al1',
      name: '专辑一',
      artists: [
        { guid: 'a1', name: '甲' },
        { guid: 'a2', name: '乙' },
      ],
    })
    expect(album.artist).toBe('甲 / 乙')
    expect(album.artistId).toBe('a1')
  })

  it('歌手：guid→id、name→name、coverId 无封面为 null、计数缺失为 0', () => {
    const artist = mapArtist({ guid: 'a1', name: '甲' })
    expect(artist.id).toBe('a1')
    expect(artist.name).toBe('甲')
    expect(artist.coverId).toBeNull()
    expect(artist.albumCount).toBe(0)
    expect(artist.trackCount).toBe(0)
  })

  it('歌单：guid→id、name→name、coverId 无封面为 null、trackCount 缺失为 0', () => {
    const playlist = mapPlaylist({ guid: 'p1', name: '歌单一' })
    expect(playlist.id).toBe('p1')
    expect(playlist.name).toBe('歌单一')
    expect(playlist.coverId).toBeNull()
    expect(playlist.trackCount).toBe(0)
    expect(playlist.description).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 端点映射（桩 fetch，逐条钉死 URL / 方法 / 请求体）
// ---------------------------------------------------------------------------

describe('各 API 方法的端点与参数', () => {
  afterEach(() => vi.unstubAllGlobals())

  const listPayload = { code: 0, msg: '', data: { list: [], total: 0 } }
  const okPayload = { code: 0, msg: '', data: {} }

  const cases: Array<{
    name: string
    call: () => Promise<unknown>
    urls: string[]
    method: string
    body?: unknown
  }> = [
    {
      name: 'libraryApi.albums',
      call: () => libraryApi.albums(2, 30, 'newTrackAddedAt,desc'),
      urls: ['fnm://srv/album/list?page=2&size=30&sort=newTrackAddedAt%2Cdesc'],
      method: 'GET',
    },
    {
      name: 'libraryApi.album',
      call: () => libraryApi.album('al1'),
      urls: ['fnm://srv/album/detail?albumGUID=al1'],
      method: 'GET',
    },
    {
      name: 'libraryApi.albumSongs',
      call: () => libraryApi.albumSongs('al1', 1, 20),
      urls: ['fnm://srv/track/album-detail/list?albumGUID=al1&page=1&size=20'],
      method: 'GET',
    },
    {
      name: 'libraryApi.artistAlbums',
      call: () => libraryApi.artistAlbums('a1', 1, 20),
      urls: ['fnm://srv/album/artist-detail/list?artistGUID=a1&page=1&size=20'],
      method: 'GET',
    },
    {
      name: 'libraryApi.songs',
      call: () => libraryApi.songs(3, 10),
      urls: ['fnm://srv/track/list?page=3&size=10'],
      method: 'GET',
    },
    {
      name: 'libraryApi.artistSongs',
      call: () => libraryApi.artistSongs('a1', 1, 10),
      urls: ['fnm://srv/track/artist-detail/list?artistGUID=a1&page=1&size=10'],
      method: 'GET',
    },
    {
      name: 'libraryApi.genreSongs',
      call: () => libraryApi.genreSongs('g1', 'Pop', 1, 10),
      urls: ['fnm://srv/track/genre-detail/list?genreGUID=g1&page=1&size=10'],
      method: 'GET',
    },
    {
      name: 'libraryApi.artists',
      call: () => libraryApi.artists(),
      urls: ['fnm://srv/artist/list?page=1&size=50'],
      method: 'GET',
    },
    {
      name: 'libraryApi.genres',
      call: () => libraryApi.genres(),
      urls: ['fnm://srv/genre/list?page=1&size=50'],
      method: 'GET',
    },
    {
      name: 'favoriteApi.list',
      call: () => favoriteApi.list(),
      urls: ['fnm://srv/favorite-track/list?size=2000'],
      method: 'GET',
    },
    {
      name: 'favoriteApi.set(true)',
      call: () => favoriteApi.set('t1', true),
      urls: ['fnm://srv/favorite-track/create'],
      method: 'POST',
      body: { trackGUID: 't1' },
    },
    {
      name: 'favoriteApi.set(false)',
      call: () => favoriteApi.set('t1', false),
      urls: ['fnm://srv/favorite-track/delete'],
      method: 'POST',
      body: { trackGUID: 't1' },
    },
    {
      name: 'playlistApi.list',
      call: () => playlistApi.list(),
      urls: ['fnm://srv/playlist/list?size=2000'],
      method: 'GET',
    },
    {
      name: 'playlistApi.songs',
      call: () => playlistApi.songs('p1', 1, 20),
      urls: ['fnm://srv/track/playlist-detail/list?playlistGUID=p1&page=1&size=20'],
      method: 'GET',
    },
    {
      name: 'playlistApi.create',
      call: () => playlistApi.create('歌单'),
      urls: ['fnm://srv/playlist/create'],
      method: 'POST',
      body: { name: '歌单' },
    },
    {
      name: 'playlistApi.rename',
      call: () => playlistApi.rename('p1', '新名'),
      urls: ['fnm://srv/playlist/update'],
      method: 'POST',
      body: { guid: 'p1', name: '新名' },
    },
    {
      name: 'playlistApi.remove',
      call: () => playlistApi.remove('p1'),
      urls: ['fnm://srv/playlist/delete'],
      method: 'POST',
      body: { guid: 'p1' },
    },
    {
      name: 'playlistApi.addTracks',
      call: () => playlistApi.addTracks('p1', ['t1', 't2']),
      urls: ['fnm://srv/playlist/add-track'],
      method: 'POST',
      body: { guid: 'p1', trackGUIDs: ['t1', 't2'] },
    },
    {
      name: 'playlistApi.removeTracks',
      call: () => playlistApi.removeTracks('p1', ['t1']),
      urls: ['fnm://srv/playlist/remove-track'],
      method: 'POST',
      body: { guid: 'p1', trackGUIDs: ['t1'] },
    },
    {
      name: 'lyricApi.raw',
      call: () => lyricApi.raw('t1'),
      urls: ['fnm://srv/lyric/list?trackGUID=t1'],
      method: 'GET',
    },
    {
      name: 'historyApi.list',
      call: () => historyApi.list(2, 5),
      urls: ['fnm://srv/play-history/list?page=2&size=5'],
      method: 'GET',
    },
  ]

  for (const item of cases) {
    it(`${item.name} → ${item.urls.join(' , ')}`, async () => {
      const calls = stubEnvelopeFetch(item.method === 'POST' ? okPayload : listPayload)
      await item.call()
      expect(calls.map((call) => call.url).sort()).toEqual([...item.urls].sort())
      expect(calls[0]?.method).toBe(item.method)
      if (item.body !== undefined) {
        expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(item.body)
      }
    })
  }

  it('searchApi.query 并发打三个搜索端点', async () => {
    const calls = stubEnvelopeFetch(listPayload)
    await searchApi.query('示例')
    expect(calls.map((call) => call.url).sort()).toEqual([
      'fnm://srv/search/album?q=%E7%A4%BA%E4%BE%8B',
      'fnm://srv/search/artist?q=%E7%A4%BA%E4%BE%8B',
      'fnm://srv/search/track?q=%E7%A4%BA%E4%BE%8B',
    ])
  })

  it('列表型方法把 { list, total } 一起返回', async () => {
    stubEnvelopeFetch({ code: 0, msg: '', data: { list: [{ guid: 'g', title: 'T' }], total: 42 } })
    const songs = await libraryApi.songs()
    expect(songs.total).toBe(42)
    expect(songs.list).toHaveLength(1)
    expect(songs.list[0]?.id).toBe('g')
  })

  it('服务端没给 list 时按空列表处理', async () => {
    stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    const songs = await libraryApi.songs()
    expect(songs.list).toEqual([])
    expect(songs.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 与 mock server 的集成（真实 HTTP）
// ---------------------------------------------------------------------------

describe('API 客户端与 mock server 集成', () => {
  let mock: MockServer
  let credential = ''
  const seen: FetchCall[] = []

  beforeAll(async () => {
    mock = createMockServer()
    const res = await realFetch(`${mock.url}/music/api/v1/user/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'x', deviceId: 'd' }),
    })
    const body = (await res.json()) as { code: number; data?: { userToken?: string } }
    expect(body.code).toBe(0)
    credential = body.data?.userToken ?? ''
    expect(credential).not.toBe('')
  })

  beforeEach(() => {
    seen.length = 0
    installBridge(mock.url, credential, seen)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  afterAll(() => {
    mock.close()
  })

  it('libraryApi.songs 返回领域模型与分页 total', async () => {
    const songs = await libraryApi.songs(1, 2)
    expect(songs.list).toHaveLength(2)
    expect(songs.total).toBe(8)

    const first = songs.list[0]
    expect(first?.id).toBe('t1')
    expect(first?.title).toBe('示例曲目 1')
    expect(first?.duration).toBe(185)
    expect(first?.coverId).toBe('cover_0123456789abcdef')
    expect(first?.artist).toBe('示例歌手甲')
    expect(first?.artistId).toBe('a1')
    expect(first?.album).toBe('示例专辑一')
    expect(first?.albumId).toBe('al1')
    expect(first?.codec).toBe('FLAC')
    expect(first?.bitrate).toBe(900)
    expect(first?.sampleRate).toBe(44100)
    expect(first?.bitDepth).toBe(16)
    expect(first?.year).toBe(2003)
    expect(first?.trackNo).toBe(3)
    expect(first?.discNo).toBe(1)
    expect(first?.favorite).toBe(false)
    // audioSpec 原样透传：duration 仍是毫秒，bitrate 仍是 bps。
    expect(first?.audioSpec?.duration).toBe(185000)
    expect(first?.audioSpec?.bitrate).toBe(900000)
  })

  it('多歌手与空封面、null 年份的歌曲映射正确', async () => {
    const songs = await libraryApi.songs(2, 1)
    const second = songs.list[0]
    expect(second?.id).toBe('t2')
    expect(second?.artist).toBe('示例歌手甲 / 示例歌手乙')
    expect(second?.artistId).toBe('a1')
    expect(second?.coverId).toBe('')
    expect(second?.year).toBeNull()
    expect(second?.trackNo).toBeNull()
    expect(second?.discNo).toBeNull()
    expect(second?.codec).toBe('MP3')
    expect(second?.bitrate).toBe(320)
  })

  it('专辑 / 歌手 / 风格 / 详情接口可用', async () => {
    const firstPage = await libraryApi.albums(1, 2)
    expect(firstPage.list).toHaveLength(2)
    expect(firstPage.total).toBe(3)
    expect(firstPage.list[0]?.title).toBe('示例专辑一')

    const albums = await libraryApi.albums(1, 3)
    expect(albums.list).toHaveLength(3)
    // al3 没有封面：专辑实体的 coverId 约定是 null（与 Song 的空串不同）。
    expect(albums.list[2]?.coverId).toBeNull()

    const album = await libraryApi.album('al1')
    expect(album?.title).toBe('示例专辑一')
    expect(album?.artist).toBe('示例歌手甲')

    const artists = await libraryApi.artists()
    expect(artists.list).toHaveLength(2)
    expect(artists.total).toBe(2)
    expect(artists.list[0]?.name).toBe('示例歌手甲')

    const genres = await libraryApi.genres()
    expect(genres.list).toHaveLength(2)
    expect(genres.total).toBe(2)
    expect(genres.list[0]?.name).toBe('Pop')
  })

  it('按专辑 / 歌手 / 风格筛选歌曲', async () => {
    expect((await libraryApi.albumSongs('al1')).total).toBe(4)
    expect((await libraryApi.artistAlbums('a1')).total).toBe(2)
    expect((await libraryApi.artistSongs('a1')).total).toBe(6)
    expect((await libraryApi.genreSongs('g1', 'Pop')).total).toBe(5)
  })

  it('收藏可写入并回读', async () => {
    await favoriteApi.set('t1', true)
    const favorites = await favoriteApi.list()
    expect(favorites.map((song) => song.id)).toEqual(['t1'])

    await favoriteApi.set('t1', false)
    expect(await favoriteApi.list()).toEqual([])
  })

  it('歌单可列出、建、改、删', async () => {
    const before = await playlistApi.list()
    expect(before).toHaveLength(2)
    expect(before[0]?.name).toBe('示例歌单一')

    const guid = await playlistApi.create('新建歌单')
    expect(guid).toBe('p3')
    expect(await playlistApi.list()).toHaveLength(3)

    await playlistApi.rename('p3', '改名后')
    const renamed = (await playlistApi.list()).find((item) => item.id === 'p3')
    expect(renamed?.name).toBe('改名后')

    await playlistApi.remove('p3')
    expect(await playlistApi.list()).toHaveLength(2)
  })

  it('歌单歌曲分页可读', async () => {
    const songs = await playlistApi.songs('p1', 1, 1)
    expect(songs.list).toHaveLength(1)
    expect(songs.total).toBe(2)
    expect(songs.list[0]?.id).toBe('t1')
  })

  it('搜索并发返回三类结果', async () => {
    const result = await searchApi.query('示例')
    expect(result.tracks.length).toBe(8)
    expect(result.albums.length).toBe(3)
    expect(result.artists.length).toBe(2)
    expect(result.tracks[0]?.id).toBe('t1')
  })

  it('搜索空关键字返回空结果（不返回全量）', async () => {
    const result = await searchApi.query('   ')
    expect(result.tracks).toEqual([])
    expect(result.albums).toEqual([])
    expect(result.artists).toEqual([])
  })

  it('歌词取第一条原文，无歌词返回空串', async () => {
    const raw = await lyricApi.raw('t1')
    expect(raw).toContain('[ti:示例曲目 1]')
    expect(raw).toContain('[00:00.00]')

    expect(await lyricApi.raw('t2')).toBe('')

    const list = await lyricApi.list('t1')
    expect(list).toHaveLength(1)
    expect(list[0]?.source).toBe('local')
  })

  it('播放历史分页可读且映射成领域歌曲', async () => {
    const history = await historyApi.list(1, 2)
    expect(history.list).toHaveLength(2)
    expect(history.total).toBe(4)
    expect(history.list[0]?.id).toBe('t1')
    expect(history.list[0]?.duration).toBe(185)

    const items = await historyApi.listItems(1, 4)
    expect(items.list).toHaveLength(4)
    expect(items.list[0]?.playTime).toBe('2026-01-05T09:00:00.000Z')
  })

  it('渲染进程发给主进程代理的请求不带任何凭据', async () => {
    await libraryApi.songs(1, 1)
    await favoriteApi.set('t1', true)
    const forbidden = /cookie|authx|authorization|music-token/i
    expect(seen.length).toBeGreaterThan(0)
    for (const call of seen) {
      for (const [name, value] of Object.entries(call.headers)) {
        expect(`${name}:${value}`).not.toMatch(forbidden)
      }
    }
  })
})
