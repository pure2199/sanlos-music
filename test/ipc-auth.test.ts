import { describe, it, expect, vi, afterEach } from 'vitest'

import { registerAuthIpc, type IpcMainLike } from '../electron/ipc'
import { TrustedHosts } from '../electron/cert'
import { createHttpStack, type ElectronSessionLike, type HttpStack } from '../electron/http'
import type { SessionManager, SessionState } from '../electron/session'

// ---------------------------------------------------------------------------
// Task 10：主进程认证 IPC
//
// 覆盖简报要求的全部行为：
// - 七个处理器的入参 / 出参 / 错误；
// - **桥接口绝不回传凭证**（token / 密码 / deviceId）；
// - 受信 host 的登记（`login` / `probe` 之后 `trusted.verify(host) === 0`，
//   未登记的 host 一律 `-3`）；
// - 拿不到 `ipcMain` 时抛可读错误。
//
// 依赖注入：所有外部依赖（`ipcMain` / `fetch` / `trusted` / NAS 登录处理器）
// 都从 `opts` 注入，测试里不碰 Electron。
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** IPC 处理器签名（与 `IpcMainLike.handle` 的 listener 一致）。 */
type Handler = (event: unknown, arg: unknown) => unknown

/** 假 `ipcMain`：把处理器收进 `Map`，测试直接调用即可模拟一次渲染进程调用。 */
function fakeIpcMain(): { ipcMain: IpcMainLike; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ipcMain: IpcMainLike = {
    handle(channel: string, listener: Handler) {
      handlers.set(channel, listener)
    },
  }
  return { ipcMain, handlers }
}

/** 调用一个已注册的通道（未注册直接抛错，避免测试静默通过）。 */
async function invoke(
  handlers: Map<string, Handler>,
  channel: string,
  arg?: unknown,
): Promise<any> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return handler(undefined, arg)
}

/** 空会话状态（登出后 `clear()` 的结果）。 */
function emptyState(): SessionState {
  return {
    base: '',
    mode: 'password',
    token: '',
    deviceId: '',
    username: '',
    password: '',
    isRelay: false,
  }
}

/**
 * 假会话：状态可定制，`load` / `save` / `clear` / `request` / `relogin` /
 * `passwordLogin` 都是 spy。
 */
function fakeSession(overrides: Partial<SessionState> = {}) {
  const holder: { state: SessionState } = {
    state: {
      base: 'http://nas.local:5666/music',
      mode: 'password',
      token: 'SECRET-TOKEN',
      deviceId: 'DEVICE',
      username: 'user',
      password: 'SECRET-PW',
      isRelay: false,
      ...overrides,
    },
  }
  return {
    get state(): SessionState {
      return holder.state
    },
    lastLoadError: null as unknown,
    lastSaveError: null as unknown,
    lastReloginError: null as unknown,
    load: vi.fn(() => true),
    save: vi.fn(),
    clear: vi.fn(() => {
      holder.state = emptyState()
    }),
    request: vi.fn(async (_path: string, _opts?: unknown) => ({
      status: 200,
      json: { code: 0, msg: '', data: {} },
    })),
    relogin: vi.fn(async () => true),
    passwordLogin: vi.fn(async (base: string, username: string, password: string) => {
      holder.state = {
        ...holder.state,
        base,
        mode: 'password',
        username,
        password,
        token: 'NEW-TOKEN',
      }
    }),
    nasLogin: vi.fn(async (_base: string, _deviceId: string) => {}),
  }
}

/** 注册并拿到通道表。 */
function setup(
  session: ReturnType<typeof fakeSession>,
  opts: {
    fetchImpl?: typeof fetch
    trusted?: TrustedHosts
    nasLoginHandler?: (args: { server: string; deviceId: string }) => Promise<void>
    http?: HttpStack
  } = {},
): { handlers: Map<string, Handler>; trusted: TrustedHosts } {
  const { ipcMain, handlers } = fakeIpcMain()
  const trusted = opts.trusted ?? new TrustedHosts()
  registerAuthIpc(session as unknown as SessionManager, {
    ipcMain,
    trusted,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.nasLoginHandler ? { nasLoginHandler: opts.nasLoginHandler } : {}),
    ...(opts.http ? { http: opts.http } : {}),
  })
  return { handlers, trusted }
}

/**
 * 假 Electron `session` 模块（Task 9b 的 Chromium 分区栈替身）。
 *
 * 记录每次请求落在**哪个分区**上，以及**发请求的那一刻**该 host 在信任集合里的状态
 * （`trustedAtRequest`）——后者用来证明「登记发生在请求之前」。
 */
function fakeElectronSession(trusted: TrustedHosts): {
  mod: ElectronSessionLike
  requests: Array<{ partition: string; url: string; trustedAtRequest: number }>
} {
  const requests: Array<{ partition: string; url: string; trustedAtRequest: number }> = []
  const mod: ElectronSessionLike = {
    fromPartition(name) {
      return {
        fetch: async (input: unknown) => {
          const url = String(input)
          let host = ''
          try {
            host = new URL(url).hostname
          } catch {
            host = ''
          }
          requests.push({ partition: name, url, trustedAtRequest: trusted.verify(host) })
          return jsonResponse({ code: 0, msg: '', data: {} })
        },
        setCertificateVerifyProc: () => {},
      }
    },
  }
  return { mod, requests }
}

/** 造一个 `fetch` 替身：按 URL 前缀路由。 */
function stubFetch(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input)
    for (const [prefix, respond] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return respond()
    }
    throw new Error(`未预期的请求：${url}`)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** JSON 响应。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

// ---------------------------------------------------------------------------
// 简报 Step 1 的用例（逐字保留）
// ---------------------------------------------------------------------------

describe('auth IPC', () => {
  it('restore 只回传脱敏状态，不含 token 与密码', async () => {
    const handlers = new Map<string, (arg: unknown) => unknown>()
    const ipcMain = { handle: (ch: string, fn: (arg: unknown) => unknown) => { handlers.set(ch, fn) } }
    const session = { state: { base: 'https://n/music', mode: 'password', token: 'SECRET-TOKEN', deviceId: 'd', username: 'u', password: 'SECRET-PW', isRelay: false }, load: () => true, save: () => {}, clear: () => {}, request: vi.fn(), relogin: vi.fn(), passwordLogin: vi.fn(), nasLogin: vi.fn() }
    registerAuthIpc(session as never, { ipcMain: ipcMain as never })
    const r = await handlers.get('auth:restore')!(undefined)
    expect(JSON.stringify(r)).not.toContain('SECRET-TOKEN')
    expect(JSON.stringify(r)).not.toContain('SECRET-PW')
  })
})

// ---------------------------------------------------------------------------
// auth:restore
// ---------------------------------------------------------------------------

describe('auth:restore', () => {
  it('已登录时返回脱敏状态（connected / mode / username / serverLabel / isRelay）', async () => {
    const session = fakeSession()
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:restore')
    expect(info).toEqual({
      connected: true,
      mode: 'password',
      username: 'user',
      serverLabel: 'nas.local:5666',
      isRelay: false,
    })
    expect(session.load).toHaveBeenCalled()
  })

  it('load() 失败且内存里也没有凭据时返回未登录形态，且不泄露原始异常', async () => {
    const session = fakeSession({ token: '' })
    session.load.mockReturnValue(false)
    session.lastLoadError = new Error('会话解密失败：DPAPI 密钥不可用')
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:restore')
    expect(info).toEqual({
      connected: false,
      mode: null,
      username: null,
      serverLabel: null,
      isRelay: false,
    })
    expect(JSON.stringify(info)).not.toContain('DPAPI')
  })

  it('load() 失败但内存里的会话仍有效时，仍返回已连接（审查 M3）', async () => {
    // 落盘失败 / 文件损坏，但内存里的会话还带着有效 token：
    // 界面报「未登录」会与仍在工作的 fnm:// 代理对不上，故按内存状态如实上报。
    const session = fakeSession()
    session.load.mockReturnValue(false)
    session.lastLoadError = new Error('会话解密失败：DPAPI 密钥不可用')
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:restore')
    expect(info.connected).toBe(true)
    expect(info.username).toBe('user')
    expect(JSON.stringify(info)).not.toContain('SECRET-TOKEN')
  })

  it('返回值里没有任何凭证字段', async () => {
    const session = fakeSession()
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:restore')
    expect(Object.keys(info).sort()).toEqual([
      'connected',
      'isRelay',
      'mode',
      'serverLabel',
      'username',
    ])
    const text = JSON.stringify(info)
    expect(text).not.toContain('SECRET-TOKEN')
    expect(text).not.toContain('SECRET-PW')
    expect(text).not.toContain('DEVICE')
  })
})

// ---------------------------------------------------------------------------
// auth:login
// ---------------------------------------------------------------------------

describe('auth:login', () => {
  it('密码模式：调用 passwordLogin + save，返回脱敏状态', async () => {
    const session = fakeSession()
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:login', {
      server: '192.168.1.2:5666',
      username: 'demo',
      password: 'pw-secret',
      mode: 'password',
    })

    expect(session.passwordLogin).toHaveBeenCalledWith(
      'http://192.168.1.2:5666/music',
      'demo',
      'pw-secret',
    )
    expect(session.save).toHaveBeenCalled()
    expect(info.connected).toBe(true)
    expect(info.username).toBe('demo')
    expect(info.serverLabel).toBe('192.168.1.2:5666')
    expect(JSON.stringify(info)).not.toContain('pw-secret')
    expect(JSON.stringify(info)).not.toContain('NEW-TOKEN')
  })

  it('NAS 模式且未安装处理器时抛出可读错误', async () => {
    const session = fakeSession()
    const { handlers } = setup(session)

    await expect(
      invoke(handlers, 'auth:login', {
        server: 'http://nas.local:5666',
        username: '',
        password: '',
        mode: 'nas',
      }),
    ).rejects.toThrow(/尚未安装 NAS 账号登录处理器/)
    expect(session.passwordLogin).not.toHaveBeenCalled()
  })

  it('NAS 模式且已安装处理器时调用处理器（传入归一化后的基址）', async () => {
    const session = fakeSession()
    const nasLoginHandler = vi.fn(async (_args: { server: string; deviceId: string }) => {})
    const { handlers } = setup(session, { nasLoginHandler })

    await invoke(handlers, 'auth:login', {
      server: 'nas.local:5666',
      username: '',
      password: '',
      mode: 'nas',
    })

    expect(nasLoginHandler).toHaveBeenCalledTimes(1)
    expect(nasLoginHandler.mock.calls[0]![0]).toEqual({
      server: 'http://nas.local:5666/music',
      deviceId: 'DEVICE',
    })
  })

  it('地址非法时抛出可读错误，且不调用 passwordLogin', async () => {
    const session = fakeSession()
    const { handlers } = setup(session)

    await expect(
      invoke(handlers, 'auth:login', {
        server: 'ftp://nas.local',
        username: 'demo',
        password: 'pw',
        mode: 'password',
      }),
    ).rejects.toThrow(/服务器地址无效/)
    expect(session.passwordLogin).not.toHaveBeenCalled()
  })

  it('登录失败时错误消息里不含口令', async () => {
    const session = fakeSession()
    session.passwordLogin.mockRejectedValue(new Error('登录失败：账号或密码错误'))
    const { handlers } = setup(session)

    const err = await invoke(handlers, 'auth:login', {
      server: 'http://nas.local:5666',
      username: 'demo',
      password: 'sup3rsecret',
      mode: 'password',
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/账号或密码错误/)
    expect((err as Error).message).not.toContain('sup3rsecret')
  })

  it('登录失败时 stack 与 cause 里也不含口令（审查 M4）', async () => {
    const session = fakeSession()
    // 模拟「服务端把口令回显在消息里」的 worst case：message / stack / cause 都带口令。
    const cause = new Error('底层异常：sup3rsecret')
    const err = new Error('登录失败：口令 sup3rsecret 不对', { cause })
    // ⚠️ 必须**先**物化 stack：V8 的 `stack` 是惰性物化的，
    //    若等到断言时再读，它会用**已经改写过**的 message 重新拼出首行——
    //    那样「只改 message」的写法也能通过断言，本用例就没有鉴别力了。
    //    先读一次把带口令的原始 stack 固化下来，之后只有**真的改写 stack** 才能通过。
    void err.stack
    session.passwordLogin.mockRejectedValue(err)
    const { handlers } = setup(session)

    const caught = await invoke(handlers, 'auth:login', {
      server: 'http://nas.local:5666',
      username: 'demo',
      password: 'sup3rsecret',
      mode: 'password',
    }).catch((e: unknown) => e)

    expect((caught as Error).message).not.toContain('sup3rsecret')
    // Electron 会把 message 与 stack 一起送到渲染进程，故 stack 也不能带口令。
    expect((caught as Error).stack ?? '').not.toContain('sup3rsecret')
    expect(((caught as Error).cause as Error | undefined)?.message ?? '').not.toContain('sup3rsecret')
  })
})

// ---------------------------------------------------------------------------
// auth:server-info
// ---------------------------------------------------------------------------

describe('auth:server-info', () => {
  it('解析出 serverName / serverVersion / supportsNasLogin，且只回这三个字段', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        code: 0,
        msg: '',
        data: {
          nasOAuth: { clientId: 'EDDLUH2WLY' },
          serverGUID: 'should-not-leak',
          serverName: '纯音乐',
          serverVersion: '1.0.10',
          mediasrvVersion: '0.8.43',
          capabilities: { folderView: false, libraryReconnect: true },
        },
      }),
    )
    const session = fakeSession()
    const { handlers } = setup(session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    const info = await invoke(handlers, 'auth:server-info', 'http://192.168.1.2:5666')

    expect(info).toEqual({
      serverName: '纯音乐',
      serverVersion: '1.0.10',
      supportsNasLogin: true,
    })
    expect(Object.keys(info)).toHaveLength(3)
    expect(JSON.stringify(info)).not.toContain('should-not-leak')
  })

  it('请求路径在音乐 API 前缀下（实测 §15.8）', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ code: 0, msg: '', data: {} }))
    const session = fakeSession()
    const { handlers } = setup(session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    await invoke(handlers, 'auth:server-info', 'http://192.168.1.2:5666')

    expect(fetchImpl.mock.calls[0]![0]).toBe('http://192.168.1.2:5666/music/api/v1/sys/config')
  })

  it('没有 nasOAuth.clientId 时 supportsNasLogin 为 false', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ code: 0, msg: '', data: { serverName: '纯音乐', serverVersion: '1.0.10' } }),
    )
    const session = fakeSession()
    const { handlers } = setup(session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    const info = await invoke(handlers, 'auth:server-info', 'http://192.168.1.2:5666')
    expect(info.supportsNasLogin).toBe(false)
  })

  it('服务端业务码非 0 时抛出带 msg 的可读错误', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ code: 1, msg: '系统繁忙' }))
    const session = fakeSession()
    const { handlers } = setup(session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(
      invoke(handlers, 'auth:server-info', 'http://192.168.1.2:5666'),
    ).rejects.toThrow(/系统繁忙/)
  })

  it('响应不是 JSON 时抛出「服务器响应异常（HTTP n）」', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('<html>404</html>', { status: 404 }))
    const session = fakeSession()
    const { handlers } = setup(session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(
      invoke(handlers, 'auth:server-info', 'http://192.168.1.2:5666'),
    ).rejects.toThrow(/服务器响应异常（HTTP 404）/)
  })

  it('HTTP 5xx 即使 body 是合法信封也判为失败（审查 M6）', async () => {
    // 反向代理 / 网关的错误页偶尔带着 `{"code":0}`，只看 body 会把失败当成功。
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ code: 0, msg: '', data: { serverName: '纯音乐' } }, 500),
    )
    const session = fakeSession()
    const { handlers } = setup(session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(
      invoke(handlers, 'auth:server-info', 'http://192.168.1.2:5666'),
    ).rejects.toThrow(/服务器响应异常（HTTP 500）/)
  })

  it('地址非法时抛出可读错误', async () => {
    const session = fakeSession()
    const { handlers } = setup(session)

    await expect(
      invoke(handlers, 'auth:server-info', 'ftp://nas.local'),
    ).rejects.toThrow(/服务器地址无效/)
  })
})

// ---------------------------------------------------------------------------
// auth:logout
// ---------------------------------------------------------------------------

describe('auth:logout', () => {
  it('服务端登出失败时仍然完成清理并返回脱敏状态', async () => {
    const session = fakeSession()
    session.request.mockRejectedValue(new Error('无法连接音乐服务（网络不可达或服务未响应）'))
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:logout')

    expect(session.request).toHaveBeenCalledWith('user/logout')
    expect(session.clear).toHaveBeenCalled()
    expect(info).toEqual({
      connected: false,
      mode: null,
      username: null,
      serverLabel: null,
      isRelay: false,
    })
  })

  it('服务端登出成功时同样清理本地会话', async () => {
    const session = fakeSession()
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:logout')
    expect(session.request).toHaveBeenCalledWith('user/logout')
    expect(session.clear).toHaveBeenCalled()
    expect(info.connected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// auth:relogin
// ---------------------------------------------------------------------------

describe('auth:relogin', () => {
  it('透传 relogin() 的布尔结果', async () => {
    const session = fakeSession()
    session.relogin.mockResolvedValue(false)
    const { handlers } = setup(session)

    expect(await invoke(handlers, 'auth:relogin')).toBe(false)
    expect(session.relogin).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// auth:probe
// ---------------------------------------------------------------------------

describe('auth:probe', () => {
  /** FN 连接接口 + 各候选的 health 端点。 */
  function probeRoutes(): Record<string, () => Response> {
    return {
      'https://5ddd.com/api/v1/fn/con': () =>
        jsonResponse({
          code: 0,
          msg: '',
          data: {
            ipv4: ['192.168.1.2'],
            publicIpv4: ['203.0.113.9'],
            publicIpv6: [],
            fn: ['demo.fnos.net:443'],
            port: { httpPort: 5666, httpsPort: 5667 },
          },
        }),
      'http://192.168.1.2:5666': () => jsonResponse({ code: 0, msg: '', data: { status: 'ok' } }),
      'https://192.168.1.2:5667': () => jsonResponse({ code: 0, msg: '', data: { status: 'ok' } }),
      'http://203.0.113.9:5666': () => jsonResponse({ code: 0, msg: '', data: { status: 'ok' } }),
      'https://203.0.113.9:5667': () => jsonResponse({ code: 0, msg: '', data: { status: 'ok' } }),
      'https://demo.fnos.net': () => jsonResponse({ code: 0, msg: '', data: { status: 'ok' } }),
    }
  }

  it('返回的候选每项都有 address / label / kind / isRelay / ok，且不含 token', async () => {
    stubFetch(probeRoutes())
    const session = fakeSession()
    const { handlers } = setup(session)

    const results = await invoke(handlers, 'auth:probe', 'demo')

    expect(results).toHaveLength(5)
    for (const item of results) {
      expect(typeof item.address).toBe('string')
      expect(typeof item.label).toBe('string')
      expect(['lan', 'public', 'relay']).toContain(item.kind)
      expect(typeof item.isRelay).toBe('boolean')
      expect(typeof item.ok).toBe('boolean')
      expect(item).not.toHaveProperty('token')
    }
    const text = JSON.stringify(results)
    expect(text).not.toContain('SECRET-TOKEN')
    expect(text).not.toContain('music-token')
  })

  it('候选顺序与类型符合 buildCandidates 的优先级（内网 → 公网 → 中继）', async () => {
    stubFetch(probeRoutes())
    const session = fakeSession()
    const { handlers } = setup(session)

    const results = await invoke(handlers, 'auth:probe', 'demo')
    expect(results.map((r: { kind: string }) => r.kind)).toEqual([
      'lan',
      'lan',
      'public',
      'public',
      'relay',
    ])
    expect(results[4].address).toBe('https://demo.fnos.net')
    expect(results[4].isRelay).toBe(true)
  })

  it('FN 连接接口不通时抛出可读错误', async () => {
    stubFetch({
      'https://5ddd.com/api/v1/fn/con': () => new Response('not json', { status: 502 }),
    })
    const session = fakeSession()
    const { handlers } = setup(session)

    await expect(invoke(handlers, 'auth:probe', 'demo')).rejects.toThrow(/探测失败/)
  })

  it('只把 FN ID 发给 FN 连接接口（请求体里没有账号口令）', async () => {
    const mock = stubFetch(probeRoutes())
    const session = fakeSession()
    const { handlers } = setup(session)

    await invoke(handlers, 'auth:probe', 'demo')

    const conCall = mock.mock.calls.find((call: unknown[]) =>
      String(call[0]).startsWith('https://5ddd.com/api/v1/fn/con'),
    )
    expect(conCall).toBeDefined()
    const body = String((conCall![1] as RequestInit | undefined)?.body ?? '')
    expect(body).toContain('demo')
    expect(body).not.toContain('SECRET-PW')
    expect(body).not.toContain('SECRET-TOKEN')
  })
})

// ---------------------------------------------------------------------------
// auth:connection-info
// ---------------------------------------------------------------------------

describe('auth:connection-info', () => {
  it('中继会话 → kind 为 relay', async () => {
    const session = fakeSession({
      base: 'https://example-fn-id.fnos.net/music',
      isRelay: true,
    })
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:connection-info')
    expect(info.kind).toBe('relay')
    expect(info.isRelay).toBe(true)
    expect(info.label).toBe('FN 中继')
    expect(info.url).toBe('https://example-fn-id.fnos.net/music')
    expect(info.bandwidthHint).toBe('带宽受限')
  })

  it('内网会话 → kind 为 lan', async () => {
    const session = fakeSession({ base: 'http://192.168.1.2:5666/music', isRelay: false })
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:connection-info')
    expect(info.kind).toBe('lan')
    expect(info.label).toBe('内网直连')
    expect(info.isRelay).toBe(false)
    expect(info.bandwidthHint).toBeUndefined()
  })

  it('.local 结尾的内网地址 → kind 为 lan', async () => {
    const session = fakeSession({ base: 'http://nas.local:5666/music', isRelay: false })
    const { handlers } = setup(session)

    expect((await invoke(handlers, 'auth:connection-info')).kind).toBe('lan')
  })

  it('172.16 – 172.31 判为内网，172.15 / 172.32 判为公网（审查 M7）', async () => {
    const cases: Array<[string, string]> = [
      ['http://172.16.0.1:5666/music', 'lan'],
      ['http://172.20.10.1:5666/music', 'lan'],
      ['http://172.31.255.1:5666/music', 'lan'],
      ['http://172.15.0.1:5666/music', 'public'],
      ['http://172.32.0.1:5666/music', 'public'],
    ]
    for (const [base, kind] of cases) {
      const session = fakeSession({ base, isRelay: false })
      const { handlers } = setup(session)
      expect((await invoke(handlers, 'auth:connection-info')).kind, base).toBe(kind)
    }
  })

  it('localhost 与 IPv6 私有段判为内网（审查 M5）', async () => {
    const cases: Array<[string, string]> = [
      ['http://localhost:5666/music', 'lan'],
      ['http://127.0.0.1:5666/music', 'lan'],
      ['http://[::1]:5666/music', 'lan'],
      ['http://[fd00::1]:5666/music', 'lan'],
      ['http://[fc00::1]:5666/music', 'lan'],
      ['http://[2001:db8::1]:5666/music', 'public'],
    ]
    for (const [base, kind] of cases) {
      const session = fakeSession({ base, isRelay: false })
      const { handlers } = setup(session)
      expect((await invoke(handlers, 'auth:connection-info')).kind, base).toBe(kind)
    }
  })

  it('公网会话 → kind 为 public', async () => {
    const session = fakeSession({ base: 'http://203.0.113.9:5666/music', isRelay: false })
    const { handlers } = setup(session)

    const info = await invoke(handlers, 'auth:connection-info')
    expect(info.kind).toBe('public')
    expect(info.label).toBe('公网直连')
  })

  it('没有会话时返回 null', async () => {
    const session = fakeSession({ base: '', token: '' })
    const { handlers } = setup(session)

    expect(await invoke(handlers, 'auth:connection-info')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 受信 host 的登记
// ---------------------------------------------------------------------------

describe('受信 host 登记', () => {
  it('login 之后该 host 被登记（未登记的 host 仍然 -3）', async () => {
    const session = fakeSession()
    const { handlers, trusted } = setup(session)

    await invoke(handlers, 'auth:login', {
      server: 'http://192.168.1.2:5666',
      username: 'demo',
      password: 'pw',
      mode: 'password',
    })

    expect(trusted.verify('192.168.1.2')).toBe(0)
    expect(trusted.verify('evil.com')).toBe(-3)
  })

  it('probe 只登记 FN ID 推导出的中继域名，候选 host 一律不登记（审查 I2）', async () => {
    stubFetch({
      'https://5ddd.com/api/v1/fn/con': () =>
        jsonResponse({
          code: 0,
          msg: '',
          data: {
            ipv4: ['192.168.1.2'],
            publicIpv4: ['203.0.113.9'],
            publicIpv6: [],
            fn: ['demo.fnos.net:443'],
            port: { httpPort: 5666, httpsPort: 5667 },
          },
        }),
      'http://192.168.1.2:5666': () => jsonResponse({ code: 0, msg: '', data: {} }),
      'https://192.168.1.2:5667': () => jsonResponse({ code: 0, msg: '', data: {} }),
      'http://203.0.113.9:5666': () => jsonResponse({ code: 0, msg: '', data: {} }),
      'https://203.0.113.9:5667': () => jsonResponse({ code: 0, msg: '', data: {} }),
      'https://demo.fnos.net': () => jsonResponse({ code: 0, msg: '', data: {} }),
    })
    const session = fakeSession()
    const { handlers, trusted } = setup(session)

    await invoke(handlers, 'auth:probe', 'demo')

    // (b) 用户自己的 FN ID 推导出的中继域名 → 登记
    expect(trusted.verify('demo.fnos.net')).toBe(0)
    // 候选里的内网 IP / 公网 IP：**不**登记（用户从未填写过它们）
    expect(trusted.verify('192.168.1.2')).toBe(-3)
    expect(trusted.verify('203.0.113.9')).toBe(-3)
    expect(trusted.verify('evil.com')).toBe(-3)
  })

  it('探测失败的候选同样不会进 trusted（审查 I2 / M7）', async () => {
    stubFetch({
      'https://5ddd.com/api/v1/fn/con': () =>
        jsonResponse({
          code: 0,
          msg: '',
          data: {
            ipv4: ['192.168.1.2'],
            publicIpv4: [],
            publicIpv6: [],
            fn: [],
            port: { httpPort: 5666, httpsPort: 5667 },
          },
        }),
      // 内网候选探测失败（HTTP 500）→ 该候选不可达
      'http://192.168.1.2:5666': () => new Response('boom', { status: 500 }),
      'https://192.168.1.2:5667': () => new Response('boom', { status: 500 }),
      'https://demo.fnos.net': () => jsonResponse({ code: 0, msg: '', data: {} }),
    })
    const session = fakeSession()
    const { handlers, trusted } = setup(session)

    const results = await invoke(handlers, 'auth:probe', 'demo')
    const failed = results.filter((r: { ok: boolean }) => !r.ok)
    expect(failed.length).toBeGreaterThan(0)
    // 失败候选的 host 也没有被登记
    expect(trusted.verify('192.168.1.2')).toBe(-3)
    // 只有 FN ID 推导出的中继域名被登记
    expect(trusted.verify('demo.fnos.net')).toBe(0)
  })

  it('FN ID 形态非法时直接拒绝（防止拼出别的主机名塞进信任集合）', async () => {
    const session = fakeSession()
    const { handlers, trusted } = setup(session)

    await expect(invoke(handlers, 'auth:probe', 'a/b')).rejects.toThrow(/FN ID 格式无效/)
    expect(trusted.verify('a')).toBe(-3)
  })
})

// ---------------------------------------------------------------------------
// Task 9b：信任登记与「换分区」的时机（追加要求 A / B）
// ---------------------------------------------------------------------------

describe('信任集合变化 → 换 Chromium 分区（追加要求 A / B）', () => {
  it('server-info 在**第一次请求之前**就登记用户填写的 host（请求那一刻它已受信）', async () => {
    const trusted = new TrustedHosts()
    const fake = fakeElectronSession(trusted)
    const http = createHttpStack({ session: fake.mod })
    const session = fakeSession()
    const { handlers } = setup(session, { trusted, http })

    await invoke(handlers, 'auth:server-info', 'https://192.168.1.2:5667')

    expect(trusted.verify('192.168.1.2')).toBe(0)
    expect(fake.requests).toHaveLength(1)
    // 发请求的那一刻，这个 host **已经**在信任集合里
    // （否则第一次握手就会失败，而 Chromium 会把证书错误按 host:port 缓存住）。
    expect(fake.requests[0]?.trustedAtRequest).toBe(0)
    // 顺序：登记 → bump epoch → 请求 → 请求落在**新**分区上。
    expect(fake.requests[0]?.partition).toBe('fn-nas-v1')
  })

  it('信任集合没变时不换分区（不白白丢掉 Chromium 的连接池）', async () => {
    const trusted = new TrustedHosts()
    const fake = fakeElectronSession(trusted)
    const http = createHttpStack({ session: fake.mod })
    const session = fakeSession()
    const { handlers } = setup(session, { trusted, http })

    await invoke(handlers, 'auth:server-info', 'https://192.168.1.2:5667')
    await invoke(handlers, 'auth:server-info', 'https://192.168.1.2:5667')

    expect(fake.requests.map((r) => r.partition)).toEqual(['fn-nas-v1', 'fn-nas-v1'])
    expect(http.partitionName()).toBe('fn-nas-v1')
  })

  it('login 也在登录请求之前登记 host（集合变化才换分区）', async () => {
    const trusted = new TrustedHosts()
    const fake = fakeElectronSession(trusted)
    const http = createHttpStack({ session: fake.mod })
    const session = fakeSession()
    const { handlers } = setup(session, { trusted, http })

    await invoke(handlers, 'auth:login', {
      server: 'https://192.168.1.2:5667',
      username: 'demo',
      password: 'pw',
      mode: 'password',
    })

    // 登录请求走会话层（不在本替身里），但**登记**必须已经发生。
    expect(trusted.verify('192.168.1.2')).toBe(0)
    expect(http.partitionName()).toBe('fn-nas-v1')
  })

  it('probe 登记 FN ID 推导出的中继域名并换分区；候选 host 一个都不登记', async () => {
    stubFetch({
      'https://5ddd.com/api/v1/fn/con': () =>
        jsonResponse({
          code: 0,
          msg: '',
          data: {
            ipv4: ['192.168.1.2'],
            publicIpv4: [],
            publicIpv6: [],
            fn: [],
            port: { httpPort: 5666, httpsPort: 5667 },
          },
        }),
    })
    const trusted = new TrustedHosts()
    const fake = fakeElectronSession(trusted)
    const http = createHttpStack({ session: fake.mod })
    const session = fakeSession()
    const { handlers } = setup(session, { trusted, http })

    await invoke(handlers, 'auth:probe', 'demo')

    expect(trusted.verify('demo.fnos.net')).toBe(0)
    expect(http.partitionName()).toBe('fn-nas-v1')
    // 候选 host 在被探测时**未受信**（审查 I2：候选一律不预登记）。
    expect(fake.requests.length).toBeGreaterThan(0)
    expect(fake.requests.every((r) => r.trustedAtRequest === -3)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 注册本身
// ---------------------------------------------------------------------------

describe('registerAuthIpc', () => {
  it('拿不到 ipcMain 时抛出可读错误', () => {
    const session = fakeSession()
    expect(() => registerAuthIpc(session as unknown as SessionManager)).toThrow(/ipcMain/)
  })

  it('注册了七个 auth:* 通道', () => {
    const session = fakeSession()
    const { handlers } = setup(session)
    expect([...handlers.keys()].sort()).toEqual([
      'auth:connection-info',
      'auth:login',
      'auth:logout',
      'auth:probe',
      'auth:relogin',
      'auth:restore',
      'auth:server-info',
    ])
  })
})
