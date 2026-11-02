import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  buildAuthorizeUrl,
  createNasOAuthHandlers,
  exchangeAuthCode,
  extractCode,
  fetchNasClientId,
  oauthPartitionName,
  redirectUriOf,
  runOAuthWindow,
  runOAuthWindowWith,
  serverRootOf,
  type BrowserWindowCtorLike,
  type BrowserWindowLike,
  type OAuthWindowOptions,
  type OAuthWindowRunner,
} from '../electron/oauthWindow'
import { SessionManager } from '../electron/session'
import { TrustedHosts } from '../electron/cert'
import type { ElectronSessionLike, HttpStack } from '../electron/http'

// ---------------------------------------------------------------------------
// Task 11：NAS 账号 OAuth 授权登录
//
// 覆盖控制器追加要求的每一条（每条都有断言）：
// - A：授权 URL 自行拼装（`nasOAuth.url` 不存在）、中文与 redirect_uri 都要 URL 编码；
// - B：`sys/config` 真实路径在音乐 API 前缀下；clientId 缺失 → 可读错误；
// - C：`auth-login` 从 `data.userToken` 取值；保留自己生成的 deviceId；
// - D：`NasLoginHandler` 返回前三件事都做到（mode / token / deviceId）；
// - E：`setNasRelogin` 成功返回非空 token、失败返回空串；
// - F：出网通道是注入进来的**同一个** `HttpStack`；
// - G：授权窗口用独立分区 + 同一个 trusted 集合的证书校验回调（命中 0 / 未命中 -3）；
// - H：模块顶层不 import Electron；错误消息不泄露 code / userToken。
//
// 依赖注入：授权窗口用 `openWindow` 替身，出网用假 `HttpStack`，全程不碰 Electron。
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 测试常量（**只用占位符**：真实 FN ID / 账号 / 口令 / token / deviceId 一律不出现）
// ---------------------------------------------------------------------------

/** 音乐根（`normalizeBase` 之后的形态）。 */
const BASE = 'https://nas.local:5667/music'

/** 服务端公开的 OAuth clientId（不是凭证，可写进测试）。 */
const CLIENT_ID = 'EDDLUH2WLY'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** JSON 响应。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** 一次 fetch 调用的可读形式。 */
interface FetchCall {
  url: string
  init: RequestInit
}

/** 记录请求的假 `HttpStack`（**就是主进程那一个实例的替身**）。 */
function fakeHttp(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { http: HttpStack; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const http: HttpStack = {
    async fetch(input, init) {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      return await handler(url, init)
    },
    bumpTrustEpoch(): void {},
    partitionName: () => 'fn-nas-v0',
  }
  return { http, calls }
}

/** `sys/config` + `auth-login` 的标准路由。 */
function nasRoutes(opts: { userToken?: string | null } = {}): (url: string) => Response {
  return (url: string) => {
    if (url.endsWith('/api/v1/sys/config')) {
      return jsonResponse({
        code: 0,
        msg: '',
        data: { nasOAuth: { clientId: CLIENT_ID }, serverName: '示例 NAS', serverVersion: '1.0.10' },
      })
    }
    if (url.endsWith('/api/v1/user/auth-login')) {
      const data: Record<string, unknown> = { user: { guid: 'U-1', name: 'demo' } }
      if (opts.userToken !== null) data['userToken'] = opts.userToken ?? 'TK-NAS'
      return jsonResponse({ code: 0, msg: '', data })
    }
    return jsonResponse({ code: 404, msg: 'not found' }, 404)
  }
}

/** 取请求体并解析成 JSON。 */
function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body ?? '{}')) as Record<string, unknown>
}

/** 取请求头（大小写不敏感）。 */
function headerOf(call: FetchCall, name: string): string | undefined {
  const headers = call.init.headers as Record<string, string> | undefined
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : headers[key]
}

/** 假 `SessionManager` 的会话状态（NAS 模式）。 */
function nasState(base = BASE, deviceId = 'DEV-1'): SessionManager['state'] {
  return {
    base,
    mode: 'nas',
    token: 'TK-OLD',
    deviceId,
    username: '',
    password: '',
    isRelay: false,
  }
}

// ---------------------------------------------------------------------------
// extractCode
// ---------------------------------------------------------------------------

describe('extractCode', () => {
  it('从重定向 URL 提取 code', () => {
    expect(extractCode('http://n/music/oauth/result?code=abc')).toBe('abc')
  })

  it('error 参数优先返回错误', () => {
    expect(extractCode('http://n/music/oauth/result?error=denied')).toBeNull()
    expect(extractCode('http://n/music/oauth/result')).toBeNull()
  })

  it('error 与 code 同时存在时 error 优先', () => {
    expect(extractCode('http://n/music/oauth/result?code=abc&error=denied')).toBeNull()
    expect(extractCode('http://n/music/oauth/result?error=denied&code=abc')).toBeNull()
  })

  it('两者都没有时返回 null', () => {
    expect(extractCode('http://n/music/oauth/result?state=x')).toBeNull()
  })

  it('code 为空串时返回 null', () => {
    expect(extractCode('http://n/music/oauth/result?code=')).toBeNull()
  })

  it('空串与非 URL 输入不抛', () => {
    expect(extractCode('')).toBeNull()
    expect(extractCode('not a url')).toBeNull()
    expect(extractCode('://///')).toBeNull()
  })

  it('URL 编码过的 code 会被解码', () => {
    expect(extractCode('http://n/music/oauth/result?code=a%2Bb')).toBe('a+b')
  })
})

// ---------------------------------------------------------------------------
// 授权 URL 拼装（追加要求 A：nasOAuth.url 不存在，必须自行拼装）
// ---------------------------------------------------------------------------

describe('授权 URL 拼装', () => {
  it('拼出 <服务器根>/signin?client_id=…&redirect_uri=…&app_name=…', () => {
    const url = buildAuthorizeUrl({ base: BASE, clientId: CLIENT_ID })
    const u = new URL(url)
    expect(u.origin).toBe('https://nas.local:5667')
    expect(u.pathname).toBe('/signin')
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(u.searchParams.get('redirect_uri')).toBe('https://nas.local:5667/music/oauth/result')
    expect(u.searchParams.get('app_name')).toBe('飞牛音乐')
  })

  it('app_name 里的中文被 URL 编码', () => {
    const url = buildAuthorizeUrl({ base: BASE, clientId: CLIENT_ID })
    expect(url).toContain('app_name=%E9%A3%9E%E7%89%9B%E9%9F%B3%E4%B9%90')
    expect(url).not.toContain('飞牛音乐')
  })

  it('redirect_uri 本身被 URL 编码（它是 query 的值）', () => {
    const url = buildAuthorizeUrl({ base: BASE, clientId: CLIENT_ID })
    expect(url).toContain(
      'redirect_uri=https%3A%2F%2Fnas.local%3A5667%2Fmusic%2Foauth%2Fresult',
    )
  })

  it('clientId 缺失时抛可读错误（绝不拼 client_id=undefined）', () => {
    expect(() => buildAuthorizeUrl({ base: BASE, clientId: '' })).toThrow(/不支持 NAS 账号登录/)
    expect(() => buildAuthorizeUrl({ base: BASE, clientId: '   ' })).toThrow(/不支持 NAS 账号登录/)
    expect(() => buildAuthorizeUrl({ base: BASE, clientId: '' })).not.toThrow(/undefined/)
  })

  it('服务器根去掉 /music；带路径前缀时按 normalizeBase 规则推导', () => {
    expect(serverRootOf(BASE)).toBe('https://nas.local:5667')
    expect(serverRootOf('https://nas.local:5667')).toBe('https://nas.local:5667')
    expect(serverRootOf('https://host/nas')).toBe('https://host/nas')
  })

  it('回调地址是 <音乐根>/oauth/result', () => {
    expect(redirectUriOf(BASE)).toBe('https://nas.local:5667/music/oauth/result')
    expect(redirectUriOf('https://host/nas')).toBe('https://host/nas/music/oauth/result')
  })
})

// ---------------------------------------------------------------------------
// sys/config → clientId（追加要求 B）
// ---------------------------------------------------------------------------

describe('fetchNasClientId', () => {
  it('从 <base>/api/v1/sys/config 取 nasOAuth.clientId', async () => {
    const { http, calls } = fakeHttp(nasRoutes())
    await expect(fetchNasClientId(BASE, http)).resolves.toBe(CLIENT_ID)
    expect(calls[0]!.url).toBe('https://nas.local:5667/music/api/v1/sys/config')
  })

  it('请求带 authx 签名头', async () => {
    const { http, calls } = fakeHttp(nasRoutes())
    await fetchNasClientId(BASE, http)
    expect(headerOf(calls[0]!, 'authx')).toMatch(/^nonce=\d+&timestamp=\d+&sign=[0-9a-f]{32}$/)
  })

  it('clientId 缺失时抛「该服务器不支持 NAS 账号登录」', async () => {
    const { http } = fakeHttp(() =>
      jsonResponse({ code: 0, msg: '', data: { nasOAuth: {}, serverName: '示例' } }),
    )
    await expect(fetchNasClientId(BASE, http)).rejects.toThrow(/不支持 NAS 账号登录/)
  })

  it('HTTP 4xx / 5xx 判为失败（哪怕 body 是合法信封）', async () => {
    const { http } = fakeHttp(() => jsonResponse({ code: 0, msg: '', data: { nasOAuth: { clientId: CLIENT_ID } } }, 500))
    await expect(fetchNasClientId(BASE, http)).rejects.toThrow(/HTTP 500/)
  })
})

// ---------------------------------------------------------------------------
// auth-login 换 token（追加要求 C）
// ---------------------------------------------------------------------------

describe('exchangeAuthCode', () => {
  it('打到 <base>/api/v1/user/auth-login，body 是 { code, deviceId }', async () => {
    const { http, calls } = fakeHttp(nasRoutes())
    await exchangeAuthCode({ base: BASE, code: 'CODE-1', deviceId: 'DEV-1', http })
    expect(calls[0]!.url).toBe('https://nas.local:5667/music/api/v1/user/auth-login')
    expect(calls[0]!.init.method).toBe('POST')
    expect(bodyOf(calls[0]!)).toEqual({ code: 'CODE-1', deviceId: 'DEV-1' })
  })

  it('从 data.userToken 取 token（不是 data.token）', async () => {
    const { http } = fakeHttp(() =>
      jsonResponse({ code: 0, msg: '', data: { userToken: 'TK-NAS', token: 'WRONG-TOKEN' } }),
    )
    await expect(
      exchangeAuthCode({ base: BASE, code: 'CODE-1', deviceId: 'DEV-1', http }),
    ).resolves.toBe('TK-NAS')
  })

  it('data 缺 userToken 时抛可读错误', async () => {
    const { http } = fakeHttp(() =>
      jsonResponse({ code: 0, msg: '', data: { token: 'WRONG-TOKEN' } }),
    )
    await expect(
      exchangeAuthCode({ base: BASE, code: 'CODE-1', deviceId: 'DEV-1', http }),
    ).rejects.toThrow(/未返回 token/)
  })

  it('响应里没有 deviceId 也不影响（保留自己生成的 deviceId）', async () => {
    const { http, calls } = fakeHttp(nasRoutes())
    const token = await exchangeAuthCode({ base: BASE, code: 'CODE-1', deviceId: 'DEV-1', http })
    expect(token).toBe('TK-NAS')
    expect(bodyOf(calls[0]!)['deviceId']).toBe('DEV-1')
  })

  it('中继链路带 Cookie: mode=relay', async () => {
    const { http, calls } = fakeHttp(nasRoutes())
    await exchangeAuthCode({
      base: 'https://example-fn-id.fnos.net/music',
      code: 'CODE-1',
      deviceId: 'DEV-1',
      http,
    })
    expect(headerOf(calls[0]!, 'cookie')).toBe('mode=relay')
  })
})

// ---------------------------------------------------------------------------
// NasLoginHandler（追加要求 D）
// ---------------------------------------------------------------------------

describe('NasLoginHandler', () => {
  /** 装一套 handler + 假会话。 */
  function setup(overrides: { openWindow?: OAuthWindowRunner; userToken?: string | null } = {}) {
    const { http, calls } = fakeHttp(nasRoutes({ userToken: overrides.userToken }))
    const session = new SessionManager({ http })
    const trusted = new TrustedHosts()
    const openWindow = overrides.openWindow ?? (async () => 'CODE-1')
    const handlers = createNasOAuthHandlers({ session, http, trusted, openWindow })
    return { session, http, calls, trusted, handlers }
  }

  it('返回后 mode=nas、token 非空、device id 非空', async () => {
    const { session, handlers } = setup()
    await handlers.nasLoginHandler({ server: BASE, deviceId: '' })
    expect(session.state.mode).toBe('nas')
    expect(session.state.token).toBe('TK-NAS')
    expect(session.state.deviceId).not.toBe('')
  })

  it('授权成功之前不提交会话（nasLogin 在拿到 token 之后才调用）', async () => {
    const { session, http } = setup()
    const spy = vi.spyOn(session, 'nasLogin')
    const openWindow: OAuthWindowRunner = async () => {
      // 窗口还没返回授权码时，会话里**不许**已经提交了半成品。
      expect(spy).not.toHaveBeenCalled()
      return 'CODE-1'
    }
    const wired = createNasOAuthHandlers({
      session,
      http,
      trusted: new TrustedHosts(),
      openWindow,
    })
    await wired.nasLoginHandler({ server: BASE, deviceId: '' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('同一台服务器沿用已有 device id', async () => {
    const { session, handlers } = setup()
    session.state = nasState(BASE, 'DEV-OLD')
    await handlers.nasLoginHandler({ server: BASE, deviceId: 'DEV-OLD' })
    expect(session.state.deviceId).toBe('DEV-OLD')
  })

  it('换服务器时重新生成 device id', async () => {
    const { session, handlers } = setup()
    session.state = nasState('https://other.local:5667/music', 'DEV-OLD')
    await handlers.nasLoginHandler({ server: BASE, deviceId: 'DEV-OLD' })
    expect(session.state.deviceId).not.toBe('DEV-OLD')
    expect(session.state.deviceId).not.toBe('')
  })

  it('出网通道用的是注入进来的同一个 HttpStack（追加要求 F）', async () => {
    const { calls, handlers } = setup()
    await handlers.nasLoginHandler({ server: BASE, deviceId: '' })
    expect(calls.map((c) => c.url)).toEqual([
      'https://nas.local:5667/music/api/v1/sys/config',
      'https://nas.local:5667/music/api/v1/user/auth-login',
    ])
  })

  it('授权窗口收到自行拼装的授权地址与回调地址', async () => {
    const openWindow = vi.fn(async (_opts: OAuthWindowOptions) => 'CODE-1')
    const { session, http, handlers } = setup({ openWindow })
    await handlers.nasLoginHandler({ server: BASE, deviceId: '' })
    expect(openWindow).toHaveBeenCalledTimes(1)
    const arg = openWindow.mock.calls[0]![0]
    expect(arg.url).toContain('/signin?client_id=')
    expect(arg.url).toContain('app_name=%E9%A3%9E%E7%89%9B%E9%9F%B3%E4%B9%90')
    expect(arg.redirect).toBe('https://nas.local:5667/music/oauth/result')
    expect(arg.silent).toBe(false)
    expect(session.state.token).toBe('TK-NAS')
    expect(http).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// setNasRelogin（追加要求 E）
// ---------------------------------------------------------------------------

describe('NAS 账号静默续期处理器', () => {
  function setup(overrides: { openWindow?: OAuthWindowRunner } = {}) {
    const { http } = fakeHttp(nasRoutes())
    const session = new SessionManager({ http })
    session.state = nasState()
    const openWindow = overrides.openWindow ?? (async () => 'CODE-2')
    const handlers = createNasOAuthHandlers({
      session,
      http,
      trusted: new TrustedHosts(),
      openWindow,
    })
    return { session, http, handlers, openWindow }
  }

  it('成功时返回非空 token 字符串', async () => {
    const { handlers } = setup()
    const token = await handlers.nasReloginHandler()
    expect(typeof token).toBe('string')
    expect(token).not.toBe('')
    expect(token).toBe('TK-NAS')
  })

  it('静默模式打开授权窗口', async () => {
    const openWindow = vi.fn(async (_opts: OAuthWindowOptions) => 'CODE-2')
    const { handlers } = setup({ openWindow })
    await handlers.nasReloginHandler()
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow.mock.calls[0]![0].silent).toBe(true)
  })

  it('失败时返回空串（不是 false、不是 undefined）', async () => {
    const { handlers } = setup({
      openWindow: async () => {
        throw new Error('fnOS 登录已过期')
      },
    })
    const result = await handlers.nasReloginHandler()
    expect(result).toBe('')
    expect(typeof result).toBe('string')
  })

  it('服务器拒绝授权时同样返回空串而不是抛穿', async () => {
    const { http } = fakeHttp(() =>
      jsonResponse({ code: 1, msg: '授权被拒绝' }),
    )
    const session = new SessionManager({ http })
    session.state = nasState()
    const { nasReloginHandler } = createNasOAuthHandlers({
      session,
      http,
      trusted: new TrustedHosts(),
      openWindow: async () => 'CODE-2',
    })
    await expect(nasReloginHandler()).resolves.toBe('')
  })

  it('不直接改 state.token（由管理器在世代守卫下提交）', async () => {
    const { session, handlers } = setup()
    await handlers.nasReloginHandler()
    expect(session.state.token).toBe('TK-OLD')
  })

  it('失败原因透出到 session.lastReloginError（不是通用文案）', async () => {
    const { session, handlers } = setup({
      openWindow: async () => {
        throw new Error('fnOS 登录已过期')
      },
    })
    await handlers.nasReloginHandler()
    expect(session.lastReloginError).toBeInstanceOf(Error)
    expect((session.lastReloginError as Error).message).toContain('fnOS 登录已过期')
  })

  it('relogin() 失败时保留 handler 记下的具体原因（session.ts 不覆盖成通用文案）', async () => {
    const { session, handlers } = setup({
      openWindow: async () => {
        throw new Error('fnOS 登录已过期')
      },
    })
    session.setNasRelogin(handlers.nasReloginHandler)
    await expect(session.relogin()).resolves.toBe(false)
    expect((session.lastReloginError as Error).message).toContain('fnOS 登录已过期')
  })

  it('失败原因里不含授权 code', async () => {
    const { http } = fakeHttp((url) =>
      url.endsWith('/sys/config')
        ? jsonResponse({ code: 0, msg: '', data: { nasOAuth: { clientId: CLIENT_ID } } })
        : jsonResponse({ code: 1, msg: 'invalid code: CODE-SECRET' }),
    )
    const session = new SessionManager({ http })
    session.state = nasState()
    const { nasReloginHandler } = createNasOAuthHandlers({
      session,
      http,
      trusted: new TrustedHosts(),
      openWindow: async () => 'CODE-SECRET',
    })
    await nasReloginHandler()
    expect(session.lastReloginError).toBeInstanceOf(Error)
    expect((session.lastReloginError as Error).message).not.toContain('CODE-SECRET')
  })

  it('静默续期失败时**不写** device id（失败不留半截状态）', async () => {
    const { http } = fakeHttp((url) =>
      url.endsWith('/sys/config')
        ? jsonResponse({ code: 0, msg: '', data: { nasOAuth: { clientId: CLIENT_ID } } })
        : jsonResponse({ code: 1, msg: '授权被拒绝' }),
    )
    const session = new SessionManager({ http })
    session.state = nasState(BASE, '')
    const { nasReloginHandler } = createNasOAuthHandlers({
      session,
      http,
      trusted: new TrustedHosts(),
      openWindow: async () => 'CODE-2',
    })
    await nasReloginHandler()
    expect(session.state.deviceId).toBe('')
  })

  it('静默续期成功时才补上 device id', async () => {
    const { session, handlers } = setup()
    session.state = nasState(BASE, '')
    await handlers.nasReloginHandler()
    expect(session.state.deviceId).not.toBe('')
  })

  it('接进 SessionManager.setNasRelogin 后，relogin() 换上新 token', async () => {
    const { session, handlers } = setup()
    session.setNasRelogin(handlers.nasReloginHandler)
    await expect(session.relogin()).resolves.toBe(true)
    expect(session.state.token).toBe('TK-NAS')
  })

  it('续期失败时 relogin() 返回 false 且 token 不变', async () => {
    const { session, handlers } = setup({
      openWindow: async () => {
        throw new Error('fnOS 登录已过期')
      },
    })
    session.setNasRelogin(handlers.nasReloginHandler)
    await expect(session.relogin()).resolves.toBe(false)
    expect(session.state.token).toBe('TK-OLD')
  })
})

// ---------------------------------------------------------------------------
// 凭证不泄露（追加要求 H）
// ---------------------------------------------------------------------------

describe('凭证不泄露', () => {
  it('服务端 msg 里带授权 code 时，错误消息把它抹掉', async () => {
    const { http } = fakeHttp(() => jsonResponse({ code: 1, msg: 'invalid code: CODE-SECRET' }))
    const err = await exchangeAuthCode({
      base: BASE,
      code: 'CODE-SECRET',
      deviceId: 'DEV-1',
      http,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('CODE-SECRET')
    expect((err as Error).message).toMatch(/NAS 账号登录失败/)
  })

  it('授权失败的消息里不含授权 code', async () => {
    const { http } = fakeHttp((url) =>
      url.endsWith('/sys/config')
        ? jsonResponse({ code: 0, msg: '', data: { nasOAuth: { clientId: CLIENT_ID } } })
        : jsonResponse({ code: 1, msg: 'invalid code: CODE-SECRET' }),
    )
    const session = new SessionManager({ http })
    const { nasLoginHandler } = createNasOAuthHandlers({
      session,
      http,
      trusted: new TrustedHosts(),
      openWindow: async () => 'CODE-SECRET',
    })
    const err = await nasLoginHandler({ server: BASE, deviceId: '' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('CODE-SECRET')
  })

  it('错误消息里不含 userToken', async () => {
    const { http } = fakeHttp(() =>
      jsonResponse({ code: 1, msg: 'token TK-SECRET 已失效' }),
    )
    const err = await exchangeAuthCode({
      base: BASE,
      code: 'CODE-1',
      deviceId: 'DEV-1',
      http,
    }).catch((e: unknown) => e)
    expect((err as Error).message).not.toContain('TK-SECRET')
  })

  it('网络异常时错误与 cause 的 stack 里也不含授权 code（只脱敏 message 的回归会红）', async () => {
    const { http } = fakeHttp(() => {
      // 底层异常的 message 与 stack 首行都带着授权码。
      throw new Error('connect ECONNREFUSED for CODE-SECRET')
    })
    const err = await exchangeAuthCode({
      base: BASE,
      code: 'CODE-SECRET',
      deviceId: 'DEV-1',
      http,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('CODE-SECRET')
    expect((err as Error).stack ?? '').not.toContain('CODE-SECRET')
    const cause = (err as { cause?: unknown }).cause
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).not.toContain('CODE-SECRET')
    expect((cause as Error).stack ?? '').not.toContain('CODE-SECRET')
  })
})

// ---------------------------------------------------------------------------
// 授权窗口：地址白名单 / 分区隔离 / 证书信任 / 静默超时
// ---------------------------------------------------------------------------

describe('runOAuthWindow 的地址白名单', () => {
  it('拒绝 file:// 授权地址', async () => {
    await expect(
      runOAuthWindow({ url: 'file:///C:/evil.html', redirect: `${BASE}/oauth/result` }),
    ).rejects.toThrow(/只支持 http/)
  })

  it('拒绝 javascript: 授权地址', async () => {
    await expect(
      runOAuthWindow({ url: 'javascript:alert(1)', redirect: `${BASE}/oauth/result` }),
    ).rejects.toThrow(/只支持 http/)
  })

  it('拒绝非 http(s) 的回调地址', async () => {
    await expect(
      runOAuthWindow({ url: 'https://nas.local:5667/signin', redirect: 'file:///x' }),
    ).rejects.toThrow(/只支持 http/)
  })

  it('没有 Electron 运行时时抛可读错误', async () => {
    await expect(
      runOAuthWindow({ url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` }),
    ).rejects.toThrow(/Electron/)
  })
})

/** 假 Electron session 模块：记录分区与证书校验回调。 */
function fakeElectronSession() {
  const procs = new Map<
    string,
    (request: { hostname: string }, callback: (result: number) => void) => void
  >()
  const partitions: string[] = []
  const mod: ElectronSessionLike = {
    fromPartition(name) {
      partitions.push(name)
      return {
        async fetch() {
          return new Response('ok')
        },
        setCertificateVerifyProc(proc) {
          procs.set(name, proc)
        },
      }
    },
  }
  return { mod, procs, partitions }
}

/** 假 BrowserWindow：可手动触发导航事件与窗口级事件（`closed`）。 */
function fakeBrowserWindow() {
  const instances: FakeWindow[] = []

  class FakeWindow implements BrowserWindowLike {
    readonly webContents = {
      listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
      on(channel: string, listener: (...args: unknown[]) => void): void {
        const list = this.listeners.get(channel) ?? []
        list.push(listener)
        this.listeners.set(channel, list)
      },
      async loadURL(): Promise<void> {
        return
      },
      emit(channel: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(channel) ?? []) listener(...args)
      },
    }
    /** 窗口级事件监听（目前只有 `closed`）。 */
    readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    readonly options: Record<string, unknown>
    destroyed = false
    constructor(options: Record<string, unknown>) {
      this.options = options
      instances.push(this)
    }
    /** 窗口级事件注册（`closed` 等）。 */
    on(channel: string, listener: (...args: unknown[]) => void): void {
      const list = this.listeners.get(channel) ?? []
      list.push(listener)
      this.listeners.set(channel, list)
    }
    /** 触发窗口级事件（如用户点 X 关窗 → `closed`）。 */
    emit(channel: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(channel) ?? []) listener(...args)
    }
    destroy(): void {
      this.destroyed = true
    }
  }

  const Ctor = FakeWindow as unknown as BrowserWindowCtorLike
  return { Ctor, instances }
}

/** 用假 proc 判定某个 host 的证书校验结果。 */
function verifyWith(
  proc: (request: { hostname: string }, callback: (result: number) => void) => void,
  hostname: string,
): number {
  let result = 999
  proc({ hostname }, (r) => {
    result = r
  })
  return result
}

/**
 * 等到假窗口被创建。
 *
 * 直接调 `runOAuthWindowWith` 时窗口是**同步**创建的，但走 NAS 登录处理器时
 * 前面还有一次 `sys/config` 的 HTTP 请求，要先把微任务队列排空。
 */
async function waitForWindow(instances: unknown[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (instances.length > 0) return
    await Promise.resolve()
  }
  throw new Error('授权窗口没有被创建')
}

describe('授权窗口的分区与安全边界', () => {
  it('用独立分区 fn-oauth（不与 API 分区共用 cookie jar）', async () => {
    const { mod, partitions } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    expect(partitions.some((p) => p.startsWith('fn-oauth'))).toBe(true)
    expect(partitions).not.toContain('fn-nas-v0')
    const webPreferences = instances[0]!.options['webPreferences'] as { partition?: string }
    expect(webPreferences.partition).toMatch(/^fn-oauth/)
    instances[0]!.webContents.emit(
      'will-redirect',
      { preventDefault: () => {} },
      `${BASE}/oauth/result?code=CODE-1`,
    )
    await expect(promise).resolves.toBe('CODE-1')
  })

  it('授权分区跟随信任版本号换代（绕开旧分区里缓存的证书错误）', async () => {
    expect(oauthPartitionName()).toBe('fn-oauth')
    expect(oauthPartitionName(fakeHttp(() => new Response('ok')).http)).toBe('fn-oauth-v0')

    let epoch = 0
    const http: HttpStack = {
      async fetch() {
        return new Response('ok')
      },
      bumpTrustEpoch(): void {
        epoch += 1
      },
      partitionName: () => `fn-nas-v${epoch}`,
    }
    expect(oauthPartitionName(http)).toBe('fn-oauth-v0')
    http.bumpTrustEpoch()
    expect(oauthPartitionName(http)).toBe('fn-oauth-v1')
  })

  it('在授权分区上注册同一个 trusted 集合的证书校验回调（命中 0 / 未命中 -3）', async () => {
    const { mod, procs } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const trusted = new TrustedHosts()
    trusted.add(BASE)
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result`, trusted },
    )
    const proc = procs.get('fn-oauth')
    expect(proc).toBeDefined()
    expect(verifyWith(proc!, 'nas.local')).toBe(0)
    expect(verifyWith(proc!, 'evil.example')).toBe(-3)
    instances[0]!.webContents.emit(
      'will-redirect',
      { preventDefault: () => {} },
      `${BASE}/oauth/result?code=CODE-1`,
    )
    await expect(promise).resolves.toBe('CODE-1')
  })

  it('拦截到 redirect 后取到 code 并立即销毁窗口', async () => {
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    let prevented = false
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    await Promise.resolve()
    instances[0]!.webContents.emit(
      'will-redirect',
      { preventDefault: () => { prevented = true } },
      `${BASE}/oauth/result?code=CODE-9`,
    )
    await expect(promise).resolves.toBe('CODE-9')
    expect(prevented).toBe(true)
    expect(instances[0]!.destroyed).toBe(true)
  })

  it('redirect 带 error 参数时拒绝（消息里不含任何凭证）', async () => {
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    await Promise.resolve()
    instances[0]!.webContents.emit('will-redirect', { preventDefault: () => {} }, `${BASE}/oauth/result?error=denied`)
    await expect(promise).rejects.toThrow(/授权失败/)
  })

  it('静默模式：did-finish-load 后 6s 内没有跳转就抛「fnOS 登录已过期」', async () => {
    vi.useFakeTimers()
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      {
        url: 'https://nas.local:5667/signin',
        redirect: `${BASE}/oauth/result`,
        silent: true,
      },
    )
    const expectation = expect(promise).rejects.toThrow('fnOS 登录已过期')
    await Promise.resolve()
    instances[0]!.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(6000)
    await expectation
    expect(instances[0]!.options['show']).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 复审 I-1（必修）：用户手动关闭授权窗口 → 登录页锁死 5 分钟
  // -------------------------------------------------------------------------

  it('用户手动关掉授权窗口 → 立即 reject（不是等 5 分钟超时）', async () => {
    vi.useFakeTimers()
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    const expectation = expect(promise).rejects.toThrow(/授权窗口已关闭/)
    await Promise.resolve()
    instances[0]!.emit('closed')
    // ⚠️ **没有推进任何定时器**：说明是「关窗即结束」，
    //    而不是等 `DEFAULT_TIMEOUT_MS`（5 分钟）才超时。
    await expectation
  })

  it('关窗与超时是**两回事**（文案能区分）', async () => {
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    await Promise.resolve()
    instances[0]!.emit('closed')
    const err = await promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('授权窗口已关闭')
    expect(message).not.toContain('授权超时')
  })

  it('关窗后 NAS 登录处理器立即 reject，且不提交半成品会话', async () => {
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const electron = { BrowserWindow: Ctor, session: mod }
    const { http } = fakeHttp(nasRoutes())
    const session = new SessionManager({ http })
    const { nasLoginHandler } = createNasOAuthHandlers({
      session,
      http,
      trusted: new TrustedHosts(),
      // 走真实的窗口实现（注入假 Electron），这样 `closed` 的处理路径被真正跑到。
      openWindow: (opts) => runOAuthWindowWith(electron, opts),
    })
    const promise = nasLoginHandler({ server: BASE, deviceId: '' })
    const expectation = expect(promise).rejects.toThrow(/授权窗口已关闭/)
    await waitForWindow(instances)
    instances[0]!.emit('closed')
    await expectation
    // 授权没成功 → 会话里**不许**出现 mode/token。
    expect(session.state.token).toBe('')
    expect(session.state.mode).not.toBe('nas')
  })

  // -------------------------------------------------------------------------
  // 复审 Minor 3：did-fail-load 只认主框架
  // -------------------------------------------------------------------------

  it('子框架加载失败不打断授权（fnOS 登录页里的验证码 / 第三方挂件）', async () => {
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    await Promise.resolve()
    instances[0]!.webContents.emit(
      'did-fail-load',
      {},
      -2,
      'ERR_FAILED',
      'https://nas.local:5667/captcha-frame',
      false,
    )
    // 子框架失败**不该**结束授权：继续走到 redirect 仍能拿到 code。
    instances[0]!.webContents.emit(
      'will-redirect',
      { preventDefault: () => {} },
      `${BASE}/oauth/result?code=CODE-1`,
    )
    await expect(promise).resolves.toBe('CODE-1')
  })

  it('主框架加载失败才终止授权', async () => {
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    await Promise.resolve()
    instances[0]!.webContents.emit(
      'did-fail-load',
      {},
      -2,
      'ERR_FAILED',
      'https://nas.local:5667/signin',
      true,
    )
    await expect(promise).rejects.toThrow(/授权页面加载失败/)
  })

  // -------------------------------------------------------------------------
  // 复审 Minor 7：二次加载要重新计时（旧定时器必须清掉）
  // -------------------------------------------------------------------------

  it('页面二次加载时重新计时 6s（旧定时器被清掉，不会锚在第一次加载上）', async () => {
    vi.useFakeTimers()
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      {
        url: 'https://nas.local:5667/signin',
        redirect: `${BASE}/oauth/result`,
        silent: true,
      },
    )
    let rejected = false
    void promise.catch(() => {
      rejected = true
    })
    const expectation = expect(promise).rejects.toThrow('fnOS 登录已过期')
    await Promise.resolve()
    instances[0]!.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(3000)
    // 第二次加载 → 重新计时 6s。
    instances[0]!.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(3000)
    // 距**第一次**加载已 6s，但旧定时器已清 → 不该在这里结束。
    expect(rejected).toBe(false)
    // 再过 3s（距**第二次**加载满 6s）→ 结束。
    await vi.advanceTimersByTimeAsync(3000)
    await expectation
    expect(rejected).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 复审补测：窗口安全项
  // -------------------------------------------------------------------------

  it('窗口按安全默认值创建（contextIsolation / nodeIntegration / sandbox）', async () => {
    const { mod } = fakeElectronSession()
    const { Ctor, instances } = fakeBrowserWindow()
    const promise = runOAuthWindowWith(
      { BrowserWindow: Ctor, session: mod },
      { url: 'https://nas.local:5667/signin', redirect: `${BASE}/oauth/result` },
    )
    await Promise.resolve()
    const webPreferences = instances[0]!.options['webPreferences'] as {
      contextIsolation?: boolean
      nodeIntegration?: boolean
      sandbox?: boolean
    }
    expect(webPreferences.contextIsolation).toBe(true)
    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.sandbox).toBe(true)
    instances[0]!.webContents.emit(
      'will-redirect',
      { preventDefault: () => {} },
      `${BASE}/oauth/result?code=CODE-1`,
    )
    await expect(promise).resolves.toBe('CODE-1')
  })
})

// ---------------------------------------------------------------------------
// 辅助：假 BrowserWindow 的类型已在上面给出（`fakeBrowserWindow`）。
// ---------------------------------------------------------------------------
