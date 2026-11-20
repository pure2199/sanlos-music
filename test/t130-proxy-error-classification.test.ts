// ---------------------------------------------------------------------------
// T130：代理层错误的**类别标记**（`proxy` 字段）＋ 渲染层的**分流**
// ---------------------------------------------------------------------------
//
// ⚠⚠ **缺陷背景**（按代码核实，不是按台账的转述）：
//    主进程原本把**所有**代理层故障统一转成 `502 + { code: -1, msg }`
//    （超时、网络不可达、未连接、未登录、路径非法、请求体非法 —— 全是同一个形状），
//    而 `code = -1` **与服务端真实业务码撞码**（实测：榜单端点 `page=list` 返回
//    `{ code: -1, subcode: 400 }`）⇒ 渲染层**无歧义地分不出**
//    「代理层故障（可重试）」与「服务端业务拒绝（按 code 处理）」
//    ⇒ 超时被当成**业务错误**抛成 `ApiError`，`ApiNetworkError` **永远收不到代理层故障**；
//    ⇒ 「会话失效」那条也收不到 `notifyAuthLost()` ⇒ 用户卡在
//    「已登录、但每个请求都失败」的死状态里（规格 §5.4 要避免的）。
//
// ⇒ 修法：**主进程在信封里多带一个类别标记 `proxy`**（**不占用 `code` 空间**
//    ⇒ 既不与服务端业务码撞码，也**不改动**既有的 `code: -1` 契约）
//    ⇒ **渲染层按它分流**：
//    - `network` ⇒ 抛 `ApiNetworkError`（可重试）；
//    - `auth` ⇒ 触发「会话失效」通知（回登录页）＋ 抛 `ApiError(code=99999)`；
//    - `request` ⇒ 仍是 `ApiError`（客户端错误，**不冒充**服务端拒绝）；
//    - **没有标记** ⇒ 语义**一点没变**（服务端真实业务码照旧抛 `ApiError`）。
//
// ⚠ **本文件是独立新增的**：`test/api-client.test.ts` 与 `test/proxy.test.ts`
//    **一个字节都没动**（既有断言一条不删、一条不弱化）。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'

import { ApiError, ApiNetworkError, apiCall, onAuthLost } from '../src/api/client'
import { registerProxy, type ProtocolLike } from '../electron/proxy'
import { SessionManager, SessionStateError, type SessionState } from '../electron/session'

// ---------------------------------------------------------------------------
// 渲染层：按「类别标记」分流
// ---------------------------------------------------------------------------

/** 装一个返回固定信封的 fetch 桩。 */
function stubEnvelopeFetch(envelope: unknown, status = 200): void {
  vi.stubGlobal('fetch', async () => {
    const text = typeof envelope === 'string' ? envelope : JSON.stringify(envelope)
    return new Response(text, { status })
  })
}

describe('T130 · 渲染层：代理层错误按类别分流', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('proxy=network ⇒ 抛 ApiNetworkError（可重试），**不是**业务错误', async () => {
    stubEnvelopeFetch(
      { code: -1, msg: '无法连接音乐服务（响应超时：30 秒内没有响应）', proxy: 'network' },
      502,
    )
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiNetworkError)
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as ApiNetworkError).message).toContain('无法连接音乐服务')
    expect((error as ApiNetworkError).message).toContain('超时')
  })

  it('proxy=auth ⇒ 触发「会话失效」通知，并抛 ApiError(code=99999)', async () => {
    // ⚠ 先发一个**成功**请求，把「同一段失效只通知一次」的闸门重新武装
    //    （否则同文件里上一条用例触发过失效后，这一条就收不到通知了）。
    stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    await apiCall('/album/list')

    const seen: number[] = []
    const off = onAuthLost(() => seen.push(1))
    stubEnvelopeFetch({ code: -1, msg: '未登录：缺少身份凭据，请重新登录', proxy: 'auth' }, 502)
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    off()

    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(ApiNetworkError)
    // ⚠ 与「上游 99999」那条**完全一致**：同一句话、同一个业务码。
    expect((error as ApiError).code).toBe(99999)
    expect((error as ApiError).message).toBe('登录已失效，请重新登录')
    // ⚠ 必须通知「会话失效」→ 外壳回登录页（规格 §5.4），否则用户卡在死状态。
    expect(seen).toHaveLength(1)
  })

  it('proxy=request ⇒ 抛 ApiError（客户端错误），业务码原样带出去', async () => {
    stubEnvelopeFetch(
      { code: -1, msg: '非法的 API 路径：只允许形如 segment/segment 的 ASCII 路径', proxy: 'request' },
      502,
    )
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(ApiNetworkError)
    expect((error as ApiError).code).toBe(-1)
    expect((error as ApiError).message).toContain('非法的 API 路径')
  })

  it('⚠ 没有 proxy 标记的 code=-1 ⇒ **仍是** ApiError（服务端真实业务码不能被代理层标记抢走）', async () => {
    stubEnvelopeFetch({ code: -1, msg: 'invalid arguments' })
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(ApiNetworkError)
    expect((error as ApiError).code).toBe(-1)
    expect((error as ApiError).message).toContain('invalid arguments')
  })

  it('⚠ 普通业务码 ⇒ 语义一点没变（仍是 ApiError，code 原样带出去）', async () => {
    stubEnvelopeFetch({ code: 100002, msg: 'invalid arguments' })
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(ApiNetworkError)
    expect((error as ApiError).code).toBe(100002)
  })

  it('响应不是 JSON ⇒ 归 ApiNetworkError（消息逐字不变）', async () => {
    stubEnvelopeFetch('<html>gateway error</html>', 502)
    const error = await apiCall('/album/list').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiNetworkError)
    expect((error as ApiNetworkError).message).toContain('服务器响应异常（HTTP 502）')
  })
})

// ---------------------------------------------------------------------------
// 主进程：代理层错误信封上的类别标记
// ---------------------------------------------------------------------------

interface FakeProtocol {
  proto: ProtocolLike
  call: (request: Request) => Promise<Response>
}

function fakeProtocol(): FakeProtocol {
  let handler: ((request: Request) => Promise<Response> | Response) | null = null
  const proto: ProtocolLike = {
    handle(scheme: string, h: (request: Request) => Promise<Response> | Response) {
      if (scheme === 'sanlos') handler = h
    },
    registerSchemesAsPrivileged() {
      /* 不需要 */
    },
  }
  return {
    proto,
    call: (request: Request) => {
      if (!handler) throw new Error('协议 handler 未注册')
      return Promise.resolve(handler(request))
    },
  }
}

/** 假会话：`request` / `relogin` 都是 spy。 */
function fakeSession(stateOverrides: Partial<SessionState> = {}): {
  session: SessionManager
  request: ReturnType<
    typeof vi.fn<
      (path: string, opts?: unknown) => Promise<{ status: number; json: unknown }>
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
  const request = vi.fn(async () => ({ status: 200, json: { code: 0, msg: '', data: {} } }))
  const relogin = vi.fn(async () => true)
  const session = { state, request, relogin } as unknown as SessionManager
  return { session, request, relogin }
}

/** 读 JSON 响应体（带类别标记）。 */
async function readJson(res: Response): Promise<{ code: number; msg: string; proxy?: string }> {
  return JSON.parse(await res.text()) as { code: number; msg: string; proxy?: string }
}

describe('T130 · 主进程：代理层错误信封上的类别标记', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('会话层抛普通异常（超时 / 网络不可达）⇒ 502 ＋ proxy=network，且 code 仍是 -1', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    request.mockRejectedValue(new Error('boom'))
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('sanlos://srv/album/list'))
    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(json.proxy).toBe('network')
  })

  it('会话层抛 SessionStateError（未登录 / 未连接）⇒ 502 ＋ proxy=auth', async () => {
    const fake = fakeProtocol()
    const { session, request } = fakeSession()
    request.mockRejectedValue(new SessionStateError('NO_CREDENTIAL', '尚未登录：缺少身份凭据'))
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('sanlos://srv/album/list'))
    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(json.proxy).toBe('auth')
  })

  it('二进制路径没有会话 ⇒ 502 ＋ proxy=auth', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession({ base: '', token: '' })
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('sanlos://srv/track/stream?guid=g1'))
    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(json.proxy).toBe('auth')
  })

  it('主机不支持 ⇒ 502 ＋ proxy=request', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('sanlos://evil.example/album/list'))
    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(json.proxy).toBe('request')
  })

  it('API 路径非法 ⇒ 502 ＋ proxy=request', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('sanlos://srv/album//list'))
    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(json.proxy).toBe('request')
  })

  it('请求体不是合法 JSON ⇒ 502 ＋ proxy=request', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(
      new Request('sanlos://srv/playlist/create', {
        method: 'POST',
        body: '{ 这不是 JSON',
      }),
    )
    expect(res.status).toBe(502)
    const json = await readJson(res)
    expect(json.code).toBe(-1)
    expect(json.proxy).toBe('request')
  })

  it('⚠ **成功的响应不受影响**（信封里没有 proxy 字段，code=0 原样透出）', async () => {
    const fake = fakeProtocol()
    const { session } = fakeSession()
    registerProxy(session, { protocol: fake.proto })

    const res = await fake.call(new Request('sanlos://srv/album/list'))
    expect(res.status).toBe(200)
    const json = await readJson(res)
    expect(json.code).toBe(0)
    expect(json.proxy).toBeUndefined()
  })
})
