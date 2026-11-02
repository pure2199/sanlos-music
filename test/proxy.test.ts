import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  buildUpstreamRequest,
  registerFnmSchemePrivileges,
  registerProxy,
  type ProtocolLike,
} from '../electron/proxy'
import { authx } from '../electron/sign'
import { SessionManager, SessionStateError, type SessionState } from '../electron/session'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 假 protocol：记录注册上来的 handler，直接调用它即可模拟渲染进程的一次请求。 */
interface FakeProtocol {
  proto: ProtocolLike
  /** `registerSchemesAsPrivileged` 收到的全部注册项。 */
  schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>
  /** 模拟渲染进程发起一次 `fnm://` 请求。 */
  call: (request: Request) => Promise<Response>
}

function fakeProtocol(): FakeProtocol {
  let handler: ((request: Request) => Promise<Response> | Response) | null = null
  const schemes: FakeProtocol['schemes'] = []
  const proto: ProtocolLike = {
    handle(scheme: string, h: (request: Request) => Promise<Response> | Response) {
      if (scheme === 'fnm') handler = h
    },
    registerSchemesAsPrivileged(list) {
      for (const item of list) {
        schemes.push({
          scheme: item.scheme,
          privileges: item.privileges as unknown as Record<string, boolean>,
        })
      }
    },
  }
  return {
    proto,
    schemes,
    call: (request: Request) => {
      if (!handler) throw new Error('协议 handler 未注册')
      return Promise.resolve(handler(request))
    },
  }
}

/** 代理调用 `session.request()` 时传入的可选参数。 */
interface ProxyRequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string>
}

/** 假会话：状态可定制，`request` / `relogin` 都是 spy。 */
function fakeSession(stateOverrides: Partial<SessionState> = {}): {
  session: SessionManager
  request: ReturnType<
    typeof vi.fn<
      (path: string, opts?: ProxyRequestOptions) => Promise<{ status: number; json: unknown }>
    >
  >
  relogin: ReturnType<typeof vi.fn<() => Promise<boolean>>>
} {
  const state: SessionState = {
    base: 'http://nas.local:5666/music',
    mode: 'password',
    token: 'TK-SECRET-TOKEN',
    deviceId: 'DEVICE',
    username: 'user',
    password: 'P@ssw0rd-SECRET',
    isRelay: false,
    ...stateOverrides,
  }
  const request = vi.fn(async (_path: string, _opts?: ProxyRequestOptions) => ({
    status: 200,
    json: { code: 0, msg: 'ok', data: { list: [] } },
  }))
  // 静默续期：默认成功并换一个新 token（与 Task 7 的真实行为一致）。
  const relogin = vi.fn(async () => {
    state.token = 'TK-RENEWED'
    return true
  })
  const session = { state, request, relogin } as unknown as SessionManager
  return { session, request, relogin }
}

/** 构造一条流式上游响应（用于验证代理是「流式转发」而不是整块读进内存）。 */
function streamResponse(body: Uint8Array, init: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body)
      controller.close()
    },
  })
  return new Response(stream, init)
}

/** 读取 JSON 响应体。 */
async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text())
}

/**
 * 构造一个**未经 URL 规范化**的请求对象。
 *
 * WHATWG 的 URL 解析器会在构造 `Request` 时把路径里的 `..` 规范化掉
 * （`fnm://srv/album/../user/list` → `fnm://srv/user/list`），
 * 所以护栏对「原始路径里带 `..`」的行为只能这样直接测。
 */
function rawRequest(url: string, init: { method?: string; headers?: HeadersInit } = {}): Request {
  return {
    url,
    method: init.method ?? 'GET',
    headers: new Headers(init.headers ?? {}),
  } as unknown as Request
}

/** 取 fetch mock 的第一次调用参数。 */
function firstFetchCall(mock: ReturnType<typeof vi.fn>): Request {
  const call = mock.mock.calls[0]
  if (!call) throw new Error('fetch 未被调用')
  return call[0] as Request
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// buildUpstreamRequest
// ---------------------------------------------------------------------------

describe('buildUpstreamRequest', () => {
  it('附加 authx 与 token cookie', () => {
    const r = buildUpstreamRequest(
      { method: 'GET', url: 'http://n/music/api/v1/track/list', headers: new Headers() },
      'TK',
      false,
    )
    expect(r.headers.get('authx')).toMatch(/^nonce=/)
    expect(r.headers.get('cookie')).toBe('music-token=TK')
  })

  it('中继模式追加 mode=relay', () => {
    const r = buildUpstreamRequest(
      { method: 'GET', url: 'http://n/x', headers: new Headers() },
      'TK',
      true,
    )
    expect(r.headers.get('cookie')).toBe('music-token=TK; mode=relay')
  })

  it('透传 range 头', () => {
    const h = new Headers({ range: 'bytes=0-1023' })
    const r = buildUpstreamRequest({ method: 'GET', url: 'http://n/x', headers: h }, 'TK', false)
    expect(r.headers.get('range')).toBe('bytes=0-1023')
  })

  it('只透传白名单内的请求头，其余（含 cookie / authorization）一律丢弃', () => {
    const h = new Headers({
      range: 'bytes=0-1023',
      'content-type': 'application/json',
      accept: 'application/json',
      'if-none-match': 'ETAG',
      'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT',
      cookie: 'renderer-cookie=EVIL',
      authorization: 'Bearer EVIL',
      'x-forwarded-host': 'evil.example',
    })
    const r = buildUpstreamRequest({ method: 'GET', url: 'http://n/x', headers: h }, 'TK', false)

    expect(r.headers.get('range')).toBe('bytes=0-1023')
    expect(r.headers.get('content-type')).toBe('application/json')
    expect(r.headers.get('accept')).toBe('application/json')
    expect(r.headers.get('if-none-match')).toBe('ETAG')
    expect(r.headers.get('if-modified-since')).toBe('Mon, 01 Jan 2024 00:00:00 GMT')

    // 渲染进程带来的凭证类头绝不能出现在上游请求里。
    expect(r.headers.get('cookie')).toBe('music-token=TK')
    expect(r.headers.get('authorization')).toBeNull()
    expect(r.headers.get('x-forwarded-host')).toBeNull()
  })

  it('构造出的请求方法与 URL 与入参一致', () => {
    const r = buildUpstreamRequest(
      { method: 'get', url: 'http://n/music/api/v1/track/stream?guid=g1', headers: new Headers() },
      'TK',
      false,
    )
    expect(r.method).toBe('GET')
    expect(r.url).toBe('http://n/music/api/v1/track/stream?guid=g1')
  })
})

// ---------------------------------------------------------------------------
// scheme 特权注册
// ---------------------------------------------------------------------------

describe('registerFnmSchemePrivileges', () => {
  it('按规格注册 fnm 的特权', () => {
    const fake = fakeProtocol()
    registerFnmSchemePrivileges(fake.proto)
    expect(fake.schemes).toHaveLength(1)
    expect(fake.schemes[0]?.scheme).toBe('fnm')
    expect(fake.schemes[0]?.privileges).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    })
  })
})

// ---------------------------------------------------------------------------
// registerProxy：路径与目标护栏
// ---------------------------------------------------------------------------

describe('registerProxy 的路径护栏', () => {
  it('注册 fnm 协议并防御性地注册 scheme 特权', () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })
    expect(fake.schemes.some((s) => s.scheme === 'fnm')).toBe(true)
  })

  it('host 不是 srv 时拒绝', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://evil.example/album/list'))
    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(typeof json.msg).toBe('string')
    expect(request).not.toHaveBeenCalled()
  })

  it('路径含 .. 时拒绝', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(rawRequest('fnm://srv/album/../user/password-login'))
    expect(res.status).toBe(502)
    expect((await readJson(res)).code).toBe(-1)
    expect(request).not.toHaveBeenCalled()
  })

  it('URL 解析器规范化掉 .. 之后，有效路径仍留在 API 前缀内（逃不出去）', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    // `new Request()` 会把路径里的 `..` 规范化掉（`/album/../user/list` → `/user/list`），
    // 因此渲染进程**无法**借 `..` 逃出 API 前缀：有效路径仍是一个普通的相对路径。
    const res = await fake.call(new Request('fnm://srv/album/../user/password-login'))
    expect(res.status).toBe(200)
    expect(request.mock.calls[0]?.[0]).toBe('user/password-login')
  })

  it('路径含百分号编码的路径分隔符时拒绝', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/album%2f..%2fuser/list'))
    expect(res.status).toBe(502)
    expect((await readJson(res)).code).toBe(-1)
    expect(request).not.toHaveBeenCalled()
  })

  it('路径含非 ASCII 字符时拒绝', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    // 原始路径（非 ASCII）与规范化后的路径（百分号编码）两种形态都要被拒绝。
    expect((await fake.call(rawRequest('fnm://srv/album/列表'))).status).toBe(502)
    expect((await fake.call(new Request('fnm://srv/album/列表'))).status).toBe(502)
    expect(request).not.toHaveBeenCalled()
  })

  it('路径含空段或反斜杠时拒绝', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    expect((await fake.call(new Request('fnm://srv/album//list'))).status).toBe(502)
    expect((await fake.call(new Request('fnm://srv/album\\list'))).status).toBe(502)
    expect((await fake.call(new Request('fnm://srv/'))).status).toBe(502)
  })

  it('渲染进程无法指定上游主机：目标地址只来自会话基址', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    await fake.call(new Request('fnm://srv/album/list'))
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe('album/list')
  })
})

// ---------------------------------------------------------------------------
// registerProxy：JSON 路径
// ---------------------------------------------------------------------------

describe('registerProxy 的 JSON 路径', () => {
  it('把请求交给 session.request 并原样序列化 { status, json }', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    request.mockResolvedValue({ status: 200, json: { code: 0, msg: 'ok', data: { total: 3 } } })
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/album/list?page=1&size=50'))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await readJson(res)).toEqual({ code: 0, msg: 'ok', data: { total: 3 } })

    expect(request).toHaveBeenCalledTimes(1)
    const call = request.mock.calls[0]
    expect(call?.[0]).toBe('album/list')
    expect(call?.[1]?.method).toBe('GET')
    expect(call?.[1]?.query).toEqual({ page: '1', size: '50' })
  })

  it('保留上游的 HTTP 状态码', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    request.mockResolvedValue({ status: 404, json: { code: 404, msg: '不存在' } })
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/album/detail'))
    expect(res.status).toBe(404)
    expect((await readJson(res)).msg).toBe('不存在')
  })

  it('POST 请求体按 JSON 透传给会话层', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const req = new Request('fnm://srv/playlist/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '我的歌单' }),
    })
    const res = await fake.call(req)

    expect(res.status).toBe(200)
    const call = request.mock.calls[0]
    expect(call?.[1]?.method).toBe('POST')
    expect(call?.[1]?.body).toEqual({ name: '我的歌单' })
  })

  it('多段路径（track/album-detail/list）被放行', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/track/album-detail/list?albumGUID=a1'))
    expect(res.status).toBe(200)
    expect(request.mock.calls[0]?.[0]).toBe('track/album-detail/list')
  })
})

// ---------------------------------------------------------------------------
// registerProxy：二进制（流式）路径
// ---------------------------------------------------------------------------

describe('registerProxy 的二进制路径', () => {
  it('透传 Range 头，并把上游的 206 / content-range / accept-ranges 原样带回', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const upstream = streamResponse(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': '3',
        'accept-ranges': 'bytes',
        'content-range': 'bytes 0-2/1024',
      },
    })
    const fetchMock = vi.fn(async () => upstream)
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(
      new Request('fnm://srv/track/stream?guid=g1', { headers: { range: 'bytes=0-2' } }),
    )

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-2/1024')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('audio/mpeg')

    // Range 必须真的发到了上游。
    const sent = firstFetchCall(fetchMock)
    expect(sent.headers.get('range')).toBe('bytes=0-2')
  })

  it('上游地址只由会话基址拼出，并附带签名与凭证 Cookie', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    const sent = firstFetchCall(fetchMock)
    expect(sent.url).toBe('http://nas.local:5666/music/api/v1/track/stream?guid=g1')
    expect(sent.headers.get('authx')).toMatch(/^nonce=/)
    expect(sent.headers.get('cookie')).toBe('music-token=TK-SECRET-TOKEN')
  })

  it('渲染进程带来的 cookie / authorization 不会被透传到上游', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fake.call(
      new Request('fnm://srv/track/stream?guid=g1', {
        headers: { cookie: 'music-token=RENDERER', authorization: 'Bearer RENDERER' },
      }),
    )

    const sent = firstFetchCall(fetchMock)
    expect(sent.headers.get('cookie')).toBe('music-token=TK-SECRET-TOKEN')
    expect(sent.headers.get('authorization')).toBeNull()
  })

  it('响应体是流式转发的（不是整块读进内存）', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const upstream = streamResponse(new Uint8Array([9, 9, 9]), { status: 200 })
    const fetchMock = vi.fn(async () => upstream)
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(new Request('fnm://srv/static/cover?coverId=c1&size=300'))

    // 响应体就是上游那条流：没有 arrayBuffer() 式的整块缓冲。
    expect(res.body).toBe(upstream.body)
  })

  it('二进制路径可用 binaryPaths 覆盖白名单', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto, binaryPaths: ['custom/blob'] })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(new Request('fnm://srv/custom/blob'))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// registerProxy：响应头与错误处理
// ---------------------------------------------------------------------------

describe('registerProxy 的响应头处理', () => {
  it('删除 content-encoding 并补 access-control-allow-origin', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const upstream = new Response('{}', {
      status: 200,
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => upstream))

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('JSON 路径也带 access-control-allow-origin', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/album/list'))
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  it('CORS 预检（OPTIONS）直接应答，不打到上游', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/playlist/create', { method: 'OPTIONS' }))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('registerProxy 的错误处理', () => {
  it('上游异常返回 502 与 { code: -1, msg }，且不泄露 token / 密码', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:5666')
      }),
    )

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(res.status).toBe(502)
    const text = await res.text()
    const json = JSON.parse(text) as { code: number; msg: string }
    expect(json.code).toBe(-1)
    expect(typeof json.msg).toBe('string')
    expect(json.msg.length).toBeGreaterThan(0)
    expect(text).not.toContain('TK-SECRET-TOKEN')
    expect(text).not.toContain('P@ssw0rd-SECRET')
    expect(text).not.toContain('ECONNREFUSED')
  })

  it('会话层抛错时返回 502 与 { code: -1, msg }，不泄露凭证', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    request.mockRejectedValue(new Error('boom'))
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/album/list'))

    expect(res.status).toBe(502)
    const text = await res.text()
    expect((JSON.parse(text) as { code: number }).code).toBe(-1)
    expect(text).not.toContain('TK-SECRET-TOKEN')
    expect(text).not.toContain('P@ssw0rd-SECRET')
  })

  it('未连接服务器（NO_SESSION）与未登录（NO_CREDENTIAL）给出可区分的提示', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    request.mockRejectedValue(new SessionStateError('NO_SESSION', '尚未连接服务器'))
    registerProxy(session, { protocol: fake.proto })

    const noSession = await readJson(await fake.call(new Request('fnm://srv/album/list')))
    expect(noSession.code).toBe(-1)

    request.mockRejectedValue(new SessionStateError('NO_CREDENTIAL', '尚未登录'))
    const noCredential = await readJson(await fake.call(new Request('fnm://srv/album/list')))
    expect(noCredential.code).toBe(-1)

    // 两条提示必须能区分（UI 要给不同引导），但都不含凭证。
    expect(noSession.msg).not.toBe(noCredential.msg)
    expect(String(noSession.msg)).not.toContain('TK-SECRET-TOKEN')
    expect(String(noCredential.msg)).not.toContain('TK-SECRET-TOKEN')
  })

  it('二进制路径没有会话时同样返回 502 与可区分的提示', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession({ base: '', token: '' })
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))
    expect(res.status).toBe(502)
    expect((await readJson(res)).code).toBe(-1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 中继判定
// ---------------------------------------------------------------------------

describe('registerProxy 的中继判定', () => {
  it('isRelay 覆盖钩子优先于会话状态', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession({ isRelay: false })
    registerProxy(session, { protocol: fake.proto, isRelay: () => true })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(firstFetchCall(fetchMock).headers.get('cookie')).toBe(
      'music-token=TK-SECRET-TOKEN; mode=relay',
    )
  })

  it('没有覆盖钩子时按会话状态判定', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession({ isRelay: true })
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(firstFetchCall(fetchMock).headers.get('cookie')).toBe(
      'music-token=TK-SECRET-TOKEN; mode=relay',
    )
  })

  it('JSON 路径同样遵循 isRelay 覆盖钩子（两条路径的链路模式必须一致）', async () => {
    const fake = fakeProtocol()
    // 用**真的** SessionManager：JSON 路径的 Cookie 由会话层拼，覆盖钩子要能传下去。
    const session = new SessionManager()
    session.state = {
      base: 'http://nas.local:5666/music',
      mode: 'password',
      token: 'TK',
      deviceId: 'DEVICE',
      username: 'user',
      password: '',
      isRelay: false,
    }
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    registerProxy(session, { protocol: fake.proto, isRelay: () => true })

    const res = await fake.call(new Request('fnm://srv/album/list'))

    expect(res.status).toBe(200)
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['cookie']).toBe('music-token=TK; mode=relay')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1 · I1：content-length 与 content-encoding 同生共死
// ---------------------------------------------------------------------------

describe('修复轮次 1 · I1：压缩响应的长度语义', () => {
  it('上游带 content-encoding 时一并删掉 content-length', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    // 实测：undici 解压 body 的同时**保留压缩态的 content-length**
    // （gzip 响应 content-length: 24，而解压后 body 100 字节）。
    const upstream = streamResponse(new Uint8Array(100), {
      status: 200,
      headers: {
        'content-encoding': 'gzip',
        'content-length': '24',
        'content-type': 'audio/mpeg',
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => upstream))

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    // 只删 content-encoding 会让渲染进程拿到「声明 24 字节、实际 100 字节」的响应
    // → Chromium ERR_CONTENT_LENGTH_MISMATCH / 截断。
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
  })

  it('上游不带 content-encoding 时照常透传 content-length', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const upstream = streamResponse(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': '3', 'content-type': 'audio/mpeg' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => upstream))

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(res.headers.get('content-length')).toBe('3')
    expect(res.headers.get('content-encoding')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1 · I2：流式路径的 token 失效续期
// ---------------------------------------------------------------------------

describe('修复轮次 1 · I2：流式路径的静默续期', () => {
  it('上游 401 时静默续期一次并重发一次（重发时带上新 token）', async () => {
    const fake = fakeProtocol()
    const { session, relogin } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        streamResponse(new Uint8Array([1, 2]), {
          status: 206,
          headers: { 'content-range': 'bytes 0-1/2', 'accept-ranges': 'bytes' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(relogin).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-1/2')
    // 重发时必须用续期后的新 token。
    const retried = fetchMock.mock.calls[1]![0] as Request
    expect(retried.headers.get('cookie')).toBe('music-token=TK-RENEWED')
  })

  it('上游 403 同样触发续期', async () => {
    const fake = fakeProtocol()
    const { session, relogin } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(relogin).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
  })

  it('续期失败时返回 502，不把上游的 401 原样透给渲染进程', async () => {
    const fake = fakeProtocol()
    const { session, relogin } = fakeSession()
    relogin.mockResolvedValue(false)
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(String(json.msg).length).toBeGreaterThan(0)
    // 失败后不重发。
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('续期抛错时同样按上游异常处理（502）', async () => {
    const fake = fakeProtocol()
    const { session, relogin } = fakeSession()
    relogin.mockRejectedValue(new Error('boom'))
    registerProxy(session, { protocol: fake.proto })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(res.status).toBe(502)
    expect((await readJson(res)).code).toBe(-1)
  })

  it('续期后仍是 401 时只重试一次（透传 401，不再续期）', async () => {
    const fake = fakeProtocol()
    const { session, relogin } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    expect(relogin).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1 · I3：%2e%2e 的真实行为
// ---------------------------------------------------------------------------

describe('修复轮次 1 · I3：%2e%2e 的真实行为', () => {
  it('%2e%2e 被 URL 解析器规范化：落在 API 前缀内的普通路径（不是 502）', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    // 实测：new Request('fnm://srv/album/%2e%2e/user/list').url → 'fnm://srv/user/list'
    // （WHATWG 解析器把 %2e%2e 解码成 .. 并弹栈，Chromium 同规范）。
    const res = await fake.call(new Request('fnm://srv/album/%2e%2e/user/list'))

    // 护栏看到的是**规范化后**的路径：它是一个普通相对路径，仍在 API 前缀内 → 不会逃逸。
    expect(res.status).toBe(200)
    expect(request.mock.calls[0]?.[0]).toBe('user/list')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1 · M2：查询参数表
// ---------------------------------------------------------------------------

describe('修复轮次 1 · M2：查询参数表', () => {
  it('查询参数表无原型：constructor / toString / __proto__ 不会被吞掉', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    await fake.call(
      new Request('fnm://srv/track/list?constructor=a&toString=b&__proto__=c'),
    )

    const query = request.mock.calls[0]?.[1]?.query as Record<string, string>
    expect(query['constructor']).toBe('a')
    expect(query['toString']).toBe('b')
    expect(Object.prototype.hasOwnProperty.call(query, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(query)).toBeNull()
  })

  it('重复键保留第一个（与 URLSearchParams.get() 一致）', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    await fake.call(new Request('fnm://srv/track/list?tag=a&tag=b'))

    const query = request.mock.calls[0]?.[1]?.query as Record<string, string>
    expect(query['tag']).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1 · M3：二进制路径的请求体
// ---------------------------------------------------------------------------

describe('修复轮次 1 · M3：二进制路径的请求体', () => {
  it('二进制路径把渲染进程的请求体透传给上游', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const body = JSON.stringify({ trackGUID: 'g1' })
    const res = await fake.call(
      new Request('fnm://srv/track/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    )

    expect(res.status).toBe(200)
    const sent = firstFetchCall(fetchMock)
    expect(sent.method).toBe('POST')
    expect(await sent.text()).toBe(body)
    expect(sent.headers.get('content-type')).toBe('application/json')
  })

  it('authx 按请求体参与签名（不是按空体）', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const body = JSON.stringify({ trackGUID: 'g1' })
    await fake.call(
      new Request('fnm://srv/track/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    )

    const sent = firstFetchCall(fetchMock)
    const header = sent.headers.get('authx') ?? ''
    const nonce = /nonce=(\d+)/.exec(header)?.[1] ?? ''
    const ts = /timestamp=(\d+)/.exec(header)?.[1] ?? ''
    const url = 'http://nas.local:5666/music/api/v1/track/stream'

    expect(header).toBe(authx('POST', url, body, { nonce, ts }))
    // 与「按空体签名」的结果不同（否则签名与实际请求体不符）。
    expect(header).not.toBe(authx('POST', url, undefined, { nonce, ts }))
  })

  it('GET 请求不携带请求体', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const fetchMock = vi.fn(async () => streamResponse(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fake.call(new Request('fnm://srv/track/stream?guid=g1'))

    const sent = firstFetchCall(fetchMock)
    expect(sent.method).toBe('GET')
    expect(await sent.text()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1 · M4：拿不到 protocol 时的失败路径
// ---------------------------------------------------------------------------

describe('修复轮次 1 · M4：拿不到 protocol 时抛错', () => {
  it('registerProxy 在没有 Electron 运行时且未注入 protocol 时抛错', () => {
    const { session } = fakeSession()
    expect(() => registerProxy(session)).toThrow(/protocol/)
  })

  it('registerFnmSchemePrivileges 在同样条件下抛错', () => {
    expect(() => registerFnmSchemePrivileges()).toThrow(/protocol/)
  })
})
