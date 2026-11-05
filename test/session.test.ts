import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager, SessionStateError, type SafeStorageLike, type SessionState } from '../electron/session'
import { CODE_TOKEN_EXPIRED } from '../shared/constants'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 假 `safeStorage`：用异或做「不可读的密文」，保证落盘文件里没有明文密码。 */
const XOR_KEY = 0x5a

function xorBytes(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i += 1) out[i] = buf[i]! ^ XOR_KEY
  return out
}

function fakeStorage(opts: { available?: boolean; failDecrypt?: boolean } = {}): SafeStorageLike {
  const available = opts.available ?? true
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => xorBytes(Buffer.from(plainText, 'utf8')),
    decryptString: (encrypted: Buffer) => {
      if (opts.failDecrypt) throw new Error('解密失败（测试注入）')
      return xorBytes(encrypted).toString('utf8')
    },
  }
}

/** 一次性临时目录。 */
const tempDirs: string[] = []

function tempFile(name = 'session.bin'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnmusic-session-'))
  tempDirs.push(dir)
  return join(dir, name)
}

/** 一次 fetch 调用的可读形式。 */
interface FetchCall {
  url: string
  init: RequestInit
}

/** 把 fetch mock 的调用记录转成可断言的形式。 */
function readCalls(mock: ReturnType<typeof vi.fn>): FetchCall[] {
  return mock.mock.calls.map((call) => ({
    url: String(call[0]),
    init: (call[1] ?? {}) as RequestInit,
  }))
}

/** 取请求头（大小写不敏感；没有则 `undefined`）。 */
function headerOf(call: FetchCall, name: string): string | undefined {
  const headers = call.init.headers as Record<string, string> | undefined
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : headers[key]
}

/** 取请求体字符串。 */
function bodyOf(call: FetchCall): string {
  return typeof call.init.body === 'string' ? call.init.body : String(call.init.body ?? '')
}

/** 读回落盘文件里的会话状态（用于断言「续期后的新 token 是否已落盘」）。 */
function readSavedState(filePath: string, storage: SafeStorageLike): SessionState | null {
  const raw = readFileSync(filePath)
  const header = raw.subarray(0, 2).toString('utf8')
  const body = raw.subarray(2)
  const text = header === 'E1' ? storage.decryptString(body) : body.toString('utf8')
  const parsed = JSON.parse(text) as { state?: SessionState }
  return parsed.state ?? null
}

/** 读回落盘载荷（用于断言 `savedAt` 等元信息）。 */
function readSavedPayload(filePath: string, storage: SafeStorageLike): Record<string, unknown> {
  const raw = readFileSync(filePath)
  const header = raw.subarray(0, 2).toString('utf8')
  const body = raw.subarray(2)
  const text = header === 'E1' ? storage.decryptString(body) : body.toString('utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * 手动闸门：让某一次请求挂起，用来构造「续期在飞行中」的竞态。
 *
 * `reached()` 在挂起的请求真正进入 fetch 之后才 resolve —— 断言因此是确定性的，
 * 不依赖任何定时器。
 */
function createGate(): {
  wait: () => Promise<void>
  reached: () => Promise<void>
  release: () => void
} {
  let release!: () => void
  let markReached!: () => void
  const waitPromise = new Promise<void>((resolve) => {
    release = resolve
  })
  const reachedPromise = new Promise<void>((resolve) => {
    markReached = resolve
  })
  return {
    wait: async () => {
      markReached()
      await waitPromise
    },
    reached: () => reachedPromise,
    release: () => release(),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 计划 Task 7 的测试用例（逐字保留）
//
// 两处**不改变断言行为**的调整：
// 1. `new SessionManager()` 不带参数——本模块**不在顶层 import Electron**，
//    单元测试不需要 Electron 运行时（依赖通过构造参数注入）。
// 2. fetch mock 补上 `(_url: string, _init: RequestInit)` 形参——
//    否则 `vi.fn(async () => …)` 的 `calls` 元组长度为 0，`calls[0][1]` 在
//    `strict` + `noUncheckedIndexedAccess` 下无法通过类型检查。
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  it('密码登录成功写入 token', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    expect(m.state.token).toBe('TK')
    expect(m.state.deviceId).toBe('D')
  })
  it('密码登录失败抛出可读错误', async () => {
    const m = new SessionManager()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1, msg: '账号或密码错误' }), { status: 200 })))
    await expect(m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'bad')).rejects.toThrow(/账号或密码错误/)
  })
  it('密码以 sha256 提交', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(body.password).toMatch(/^[0-9a-f]{64}$/)
    expect(body.password).not.toBe('pw')
  })
})

// ---------------------------------------------------------------------------
// 登录：请求形状
// ---------------------------------------------------------------------------

describe('密码登录请求', () => {
  it('打到 <base>/api/v1/user/password-login 并带 authx', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')

    const call = readCalls(fetchMock)[0]!
    expect(call.url).toBe('http://127.0.0.1:5666/music/api/v1/user/password-login')
    expect(call.init.method).toBe('POST')
    expect(headerOf(call, 'authx')).toMatch(/^nonce=\d{6}&timestamp=\d+&sign=[0-9a-f]{32}$/)
    expect(headerOf(call, 'content-type')).toBe('application/json')

    const body = JSON.parse(bodyOf(call))
    expect(body.username).toBe('demo')
    expect(body.deviceId).toMatch(/^[0-9a-f]{32}$/)
    // 密码只以 sha256 出现，原文不出现在请求体里
    expect(body.password).not.toBe('pw')
  })

  it('中继登录带 Cookie: mode=relay（实测修正 M2）', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('https://example-fn-id.fnos.net/music', 'demo', 'pw')

    const call = readCalls(fetchMock)[0]!
    expect(headerOf(call, 'cookie')).toBe('mode=relay')
    expect(m.state.isRelay).toBe(true)
  })

  it('非中继登录不带 Cookie', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')

    const call = readCalls(fetchMock)[0]!
    expect(headerOf(call, 'cookie')).toBeUndefined()
    expect(m.state.isRelay).toBe(false)
  })

  it('isRelay 可显式指定，覆盖按域名推断的结果', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw', { isRelay: true })

    expect(headerOf(readCalls(fetchMock)[0]!, 'cookie')).toBe('mode=relay')
    expect(m.state.isRelay).toBe(true)
  })

  it('登录失败时错误消息含服务端 msg，且带业务码', async () => {
    const m = new SessionManager()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1, msg: '账号或密码错误' }), { status: 200 })))
    const err = await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'bad').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/账号或密码错误/)
    expect((err as { code?: number }).code).toBe(1)
  })

  it('登录失败不会写入 token，也不会把密码写进错误消息', async () => {
    const m = new SessionManager()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1, msg: '账号或密码错误' }), { status: 200 })))
    const err = await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'sup3rsecret').catch((e: unknown) => e)
    expect(m.state.token).toBe('')
    expect((err as Error).message).not.toContain('sup3rsecret')
  })

  it('服务器返回非 JSON 时抛出可读错误', async () => {
    const m = new SessionManager()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>error</html>', { status: 502 })))
    await expect(m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')).rejects.toThrow(/服务器响应异常/)
  })
})

// ---------------------------------------------------------------------------
// NAS 模式
// ---------------------------------------------------------------------------

describe('nasLogin', () => {
  it('只初始化状态，不获取 token、不发请求（OAuth 属 Task 11）', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(m.state.mode).toBe('nas')
    expect(m.state.base).toBe('http://127.0.0.1:5666/music')
    expect(m.state.deviceId).toBe('DEV1')
    expect(m.state.token).toBe('')
  })

  it('未安装续期处理器时 relogin 返回 false 且不伪造 token', async () => {
    const m = new SessionManager()
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')
    expect(await m.relogin()).toBe(false)
    expect(m.state.token).toBe('')
  })

  it('安装续期处理器后由处理器完成续期（handler 返回新 token）', async () => {
    const m = new SessionManager()
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')
    m.setNasRelogin(async () => 'TK-NAS')
    expect(await m.relogin()).toBe(true)
    expect(m.state.token).toBe('TK-NAS')
  })

  it('handler 返回空串表示续期失败（不伪造 token）', async () => {
    const m = new SessionManager()
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')
    m.setNasRelogin(async () => '')
    expect(await m.relogin()).toBe(false)
    expect(m.state.token).toBe('')
  })
})

// ---------------------------------------------------------------------------
// request()
//
// ---------------------------------------------------------------------------

describe('request()', () => {
  /** 登录一次并返回 manager 与 fetch mock。 */
  async function loggedIn(): Promise<{ m: SessionManager; fetchMock: ReturnType<typeof vi.fn> }> {
    const m = new SessionManager()
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    return { m, fetchMock }
  }

  it('附加 authx 头与 Cookie: music-token=<token>', async () => {
    const { m, fetchMock } = await loggedIn()
    fetchMock.mockClear()

    await m.request('track/list', { query: { page: 1, size: 20, keyword: undefined } })

    const call = readCalls(fetchMock)[0]!
    expect(call.url).toBe('http://127.0.0.1:5666/music/api/v1/track/list?page=1&size=20')
    expect(headerOf(call, 'authx')).toMatch(/^nonce=\d{6}&timestamp=\d+&sign=[0-9a-f]{32}$/)
    expect(headerOf(call, 'cookie')).toBe('music-token=TK')
  })

  it('中继链路的 Cookie 为 music-token=<token>; mode=relay', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('https://example-fn-id.fnos.net/music', 'demo', 'pw', { isRelay: true })
    fetchMock.mockClear()

    await m.request('track/list')
    expect(headerOf(readCalls(fetchMock)[0]!, 'cookie')).toBe('music-token=TK; mode=relay')
  })

  // Task 8 修复轮次 1 · M1：request() 支持**可选**的 isRelay 覆盖。
  it('isRelay 覆盖生效：可把非中继会话按中继发（Task 8 代理用）', async () => {
    const { m, fetchMock } = await loggedIn()
    fetchMock.mockClear()

    // 会话状态是直连（isRelay=false），调用方显式覆盖为中继。
    await m.request('track/list', { isRelay: true })

    expect(headerOf(readCalls(fetchMock)[0]!, 'cookie')).toBe('music-token=TK; mode=relay')
  })

  it('isRelay 覆盖生效：也可把中继会话按直连发', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('https://example-fn-id.fnos.net/music', 'demo', 'pw', { isRelay: true })
    fetchMock.mockClear()

    await m.request('track/list', { isRelay: false })

    expect(headerOf(readCalls(fetchMock)[0]!, 'cookie')).toBe('music-token=TK')
  })

  it('不传 isRelay 时沿用会话状态（向后兼容）', async () => {
    const { m, fetchMock } = await loggedIn()
    fetchMock.mockClear()

    await m.request('track/list')

    expect(headerOf(readCalls(fetchMock)[0]!, 'cookie')).toBe('music-token=TK')
  })

  it('body 序列化为 JSON 并带 content-type', async () => {
    const { m, fetchMock } = await loggedIn()
    fetchMock.mockClear()

    await m.request('favorite-track/create', { method: 'POST', body: { guid: 'g1' } })

    const call = readCalls(fetchMock)[0]!
    expect(call.init.method).toBe('POST')
    expect(bodyOf(call)).toBe('{"guid":"g1"}')
    expect(headerOf(call, 'content-type')).toBe('application/json')
  })

  it('响应不是 JSON 时 json 为 null 且不抛异常', async () => {
    const { m, fetchMock } = await loggedIn()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async () => new Response('<html>err</html>', { status: 502 }))

    const res = await m.request('track/list')
    expect(res.status).toBe(502)
    expect(res.json).toBeNull()
  })

  it('网络异常抛出可读中文错误', async () => {
    const { m, fetchMock } = await loggedIn()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })

    await expect(m.request('track/list')).rejects.toThrow(/无法连接音乐服务/)
  })

  it('未登录时拒绝发起请求', async () => {
    const m = new SessionManager()
    // 有基址但没有 token（NAS 模式尚未完成 OAuth 授权）
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')
    await expect(m.request('track/list')).rejects.toThrow(/尚未登录/)
  })

  it('没有基址时拒绝发起请求', async () => {
    const m = new SessionManager()
    await expect(m.request('track/list')).rejects.toThrow(/尚未连接服务器/)
  })
})

// ---------------------------------------------------------------------------
// token 失效 → 续期 → 重试
// ---------------------------------------------------------------------------

describe('token 失效的续期与重试', () => {
  it('code 99999 时续期一次并重试成功', async () => {
    let loginCount = 0
    let businessCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      businessCount += 1
      const body =
        businessCount === 1
          ? { code: CODE_TOKEN_EXPIRED, msg: 'token expired' }
          : { code: 0, data: { list: [] } }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    expect(m.state.token).toBe('TK1')

    const res = await m.request('track/list')
    expect(res.status).toBe(200)
    expect((res.json as { code?: number }).code).toBe(0)
    // 续期只触发**一次**登录请求
    expect(loginCount).toBe(2)
    // 首发 + 重试 = 2 次业务请求
    expect(businessCount).toBe(2)
    expect(m.state.token).toBe('TK2')

    // 重试用的是续期后的 token
    const calls = readCalls(fetchMock)
    expect(headerOf(calls[calls.length - 1]!, 'cookie')).toBe('music-token=TK2')
  })

  // ⚠️ **下面两条钉的是「真服务端的真实形状」**（T19-1 用
  //    `tools/fn-token-expiry-probe.mjs` 在真实 NAS 上实测出来的）。
  //    原本的单测一律用「HTTP 200 + body 里的 99999」来模拟，
  //    于是**恰好漏掉了真实服务端的两面**：
  //      ① token 失效时服务端回的是 **HTTP 401**（不是 200）；
  //      ② 路径不存在时服务端回的是 **fnOS 的 SPA 兜底页（HTML）**，里面根本没有业务码。
  //    这两条一旦没钉住，日后有人加一句「`if (!res.ok) throw`」或
  //    「非 JSON 也当成失效」就会**静默弄坏**续期路径，而单测照样全绿。

  it('真服务端的形状（HTTP 401 + body 里的 99999）照样触发续期并重试', async () => {
    let loginCount = 0
    let businessCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      businessCount += 1
      const body =
        businessCount === 1
          ? { code: CODE_TOKEN_EXPIRED, msg: 'INVALID TOKEN' }
          : { code: 0, data: { list: [] } }
      // ⚠️ 实测：无效 token → **HTTP 401** + `{ code: 99999, msg: "INVALID TOKEN" }`。
      //    客户端**不按状态码判定**（`readJson` 不看 status），只读 body 里的业务码。
      return new Response(JSON.stringify(body), { status: businessCount === 1 ? 401 : 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    const res = await m.request('track/list')
    expect(res.status).toBe(200)
    expect((res.json as { code?: number }).code).toBe(0)
    // 续期一次 + 重试一次
    expect(loginCount).toBe(2)
    expect(businessCount).toBe(2)
    expect(m.state.token).toBe('TK2')
  })

  it('响应不是 JSON（fnOS 的 SPA 兜底页）时**不**触发续期', async () => {
    let loginCount = 0
    let businessCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      businessCount += 1
      // ⚠️ 实测：对**不存在的端点**，服务端回的是 fnOS 的 SPA 兜底页（HTML / 200），
      //    里面**没有**业务码 → 绝不能当成「token 失效」，
      //    否则会白白续期一次再重试一遍（用户看到的是莫名其妙的一次重新登录）。
      return new Response('<!doctype html><html><body>fnOS</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    const res = await m.request('track/list')
    expect(res.json).toBeNull()
    // ⚠️ **没有**触发续期：只有 body 里是 99999 才续期。
    expect(loginCount).toBe(1)
    expect(businessCount).toBe(1)
  })

  it('续期后仍是 99999 时只重试一次并原样返回（不无限重试）', async () => {
    let loginCount = 0
    let businessCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      businessCount += 1
      return new Response(JSON.stringify({ code: CODE_TOKEN_EXPIRED, msg: 'token expired' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')

    const res = await m.request('track/list')
    expect(res.status).toBe(200)
    expect((res.json as { code?: number }).code).toBe(CODE_TOKEN_EXPIRED)
    expect(businessCount).toBe(2)
    expect(loginCount).toBe(2)
  })

  it('并发调用 relogin() 只触发一次登录请求', async () => {
    let loginCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    fetchMock.mockClear()

    const p1 = m.relogin()
    const p2 = m.relogin()
    const p3 = m.relogin()
    // 并发调用共享同一个 in-flight Promise
    expect(p2).toBe(p1)
    expect(p3).toBe(p1)

    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual([true, true, true])
    expect(loginCount).toBe(2) // 初次登录 1 次 + 续期 1 次
  })

  it('续期失败（密码错误）时 relogin 返回 false 而不是抛异常', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) {
        return new Response(JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 1, msg: '账号或密码错误' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    expect(await m.relogin()).toBe(false)
    expect(m.lastReloginError).toBeInstanceOf(Error)
    expect((m.lastReloginError as Error).message).not.toContain('pw')
  })
})

// ---------------------------------------------------------------------------
// 凭证落盘
// ---------------------------------------------------------------------------

describe('save() / load() / clear()', () => {
  it('往返后状态完全还原', async () => {
    const filePath = tempFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }), { status: 200 })),
    )

    const m = new SessionManager({ storage: fakeStorage(), filePath, now: () => 1700000000000 })
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    m.save()

    const restored = new SessionManager({ storage: fakeStorage(), filePath })
    expect(restored.load()).toBe(true)
    expect(restored.state.base).toBe('http://127.0.0.1:5666/music')
    expect(restored.state.mode).toBe('password')
    expect(restored.state.token).toBe('TK')
    expect(restored.state.deviceId).toBe('D')
    expect(restored.state.username).toBe('demo')
    expect(restored.state.password).toBe('pw')
    expect(restored.state.isRelay).toBe(false)
  })

  it('往返保留中继标记', async () => {
    const filePath = tempFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }), { status: 200 })),
    )

    const m = new SessionManager({ storage: fakeStorage(), filePath })
    await m.passwordLogin('https://example-fn-id.fnos.net/music', 'demo', 'pw')
    m.save()

    const restored = new SessionManager({ storage: fakeStorage(), filePath })
    expect(restored.load()).toBe(true)
    expect(restored.state.isRelay).toBe(true)
    expect(restored.state.base).toBe('https://example-fn-id.fnos.net/music')
  })

  it('文件不存在时 load() 返回 false 且不抛异常', () => {
    const m = new SessionManager({ storage: fakeStorage(), filePath: tempFile() })
    expect(m.load()).toBe(false)
    expect(m.state.token).toBe('')
  })

  it('内容损坏时 load() 返回 false 且不抛异常', () => {
    const filePath = tempFile()
    writeFileSync(filePath, 'XX这不是会话文件')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = new SessionManager({ storage: fakeStorage(), filePath })
    expect(m.load()).toBe(false)
    expect(m.state.token).toBe('')
  })

  it('解密抛错时 load() 返回 false 且不抛异常', () => {
    const filePath = tempFile()
    writeFileSync(filePath, Buffer.concat([Buffer.from('E1', 'utf8'), Buffer.from('乱码', 'utf8')]))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = new SessionManager({ storage: fakeStorage({ failDecrypt: true }), filePath })
    expect(m.load()).toBe(false)
    expect(m.state.token).toBe('')
  })

  it('明文回退（DPAPI 不可用且显式 opt-in）时以 P0 开头落盘', () => {
    const filePath = tempFile()
    const m = new SessionManager({
      storage: fakeStorage({ available: false }),
      filePath,
      allowPlaintextFallback: true,
    })
    m.state = { base: 'http://127.0.0.1:5666/music', mode: 'password', token: 'TK', deviceId: 'D', username: 'demo', password: 'pw', isRelay: false }
    m.save()

    const raw = readFileSync(filePath)
    expect(raw.subarray(0, 2).toString('utf8')).toBe('P0')
    // 明文回退确实把口令写进了文件（这正是该降级路径降低安全性的地方）
    expect(raw.toString('utf8')).toContain('pw')
  })

  it('加密模式下落盘文件不含明文密码', () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage(), filePath, now: () => 1700000000000 })
    m.state = { base: 'http://127.0.0.1:5666/music', mode: 'password', token: 'TK', deviceId: 'D', username: 'demo', password: 'sup3rsecret', isRelay: false }
    m.save()

    const raw = readFileSync(filePath)
    expect(raw.subarray(0, 2).toString('utf8')).toBe('E1')
    expect(raw.includes(Buffer.from('sup3rsecret', 'utf8'))).toBe(false)
    expect(raw.includes(Buffer.from('pw', 'utf8'))).toBe(false)
  })

  it('clear() 删除文件并清空状态，之后 load() 返回 false', () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage(), filePath })
    m.state = { base: 'http://127.0.0.1:5666/music', mode: 'password', token: 'TK', deviceId: 'D', username: 'demo', password: 'pw', isRelay: false }
    m.save()
    expect(existsSync(filePath)).toBe(true)

    m.clear()
    expect(existsSync(filePath)).toBe(false)
    expect(m.state.token).toBe('')
    expect(m.state.password).toBe('')

    const restored = new SessionManager({ storage: fakeStorage(), filePath })
    expect(restored.load()).toBe(false)
  })

  it('文件路径不可用时 save() 抛可读错误（不把凭证写到别处）', () => {
    const m = new SessionManager({ storage: fakeStorage() })
    expect(() => m.save()).toThrow(/会话文件路径不可用/)
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1：M1 明文回退改为显式 opt-in
// ---------------------------------------------------------------------------

describe('明文回退必须显式开启（M1）', () => {
  const session = {
    base: 'http://127.0.0.1:5666/music',
    mode: 'password',
    token: 'TK',
    deviceId: 'D',
    username: 'demo',
    password: 'pw',
    isRelay: false,
  } as const

  it('没有可用加密且未开启 allowPlaintextFallback 时拒绝写盘', () => {
    const filePath = tempFile()
    const m = new SessionManager({ filePath }) // 既没有 storage，也没有 opt-in
    m.state = { ...session }
    expect(() => m.save()).toThrow(/拒绝以明文落盘/)
    expect(existsSync(filePath)).toBe(false)
  })

  it('DPAPI 不可用且未开启 opt-in 时同样拒绝写盘', () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage({ available: false }), filePath })
    m.state = { ...session }
    expect(() => m.save()).toThrow(/拒绝以明文落盘/)
    expect(existsSync(filePath)).toBe(false)
  })

  it('显式开启 allowPlaintextFallback 后才写 P0 明文', () => {
    const filePath = tempFile()
    const m = new SessionManager({
      storage: fakeStorage({ available: false }),
      filePath,
      allowPlaintextFallback: true,
    })
    m.state = { ...session }
    m.save()

    const raw = readFileSync(filePath)
    expect(raw.subarray(0, 2).toString('utf8')).toBe('P0')
    expect(raw.toString('utf8')).toContain('pw')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1：M2 类型化的会话状态错误
// ---------------------------------------------------------------------------

describe('SessionStateError（M2）', () => {
  it('未连接时抛 SessionStateError(code=NO_SESSION)', async () => {
    const m = new SessionManager()
    const err = await m.request('track/list').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionStateError)
    expect((err as SessionStateError).code).toBe('NO_SESSION')
  })

  it('未登录时抛 SessionStateError(code=NO_CREDENTIAL)', async () => {
    const m = new SessionManager()
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')
    const err = await m.request('track/list').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionStateError)
    expect((err as SessionStateError).code).toBe('NO_CREDENTIAL')
  })

  it('save() 的路径不可用错误也是 SessionStateError', () => {
    const m = new SessionManager({ storage: fakeStorage() })
    const err = (() => {
      try {
        m.save()
        return null
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(SessionStateError)
    expect((err as SessionStateError).code).toBe('NO_STORAGE')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1：M3 原子写
// ---------------------------------------------------------------------------

describe('原子写（M3）', () => {
  it('save() 之后不残留 .tmp 文件', () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage(), filePath })
    m.state = { base: 'http://127.0.0.1:5666/music', mode: 'password', token: 'TK', deviceId: 'D', username: 'demo', password: 'pw', isRelay: false }
    m.save()
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    expect(existsSync(filePath)).toBe(true)
  })

  it('写入失败时原会话文件保持完好（不会被写坏）', () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage(), filePath })
    m.state = { base: 'http://127.0.0.1:5666/music', mode: 'password', token: 'TK1', deviceId: 'D', username: 'demo', password: 'pw', isRelay: false }
    m.save()
    const before = readFileSync(filePath)

    // 把临时路径占成目录 → 写临时文件失败 → 覆盖步骤不会发生
    mkdirSync(`${filePath}.tmp`)
    m.state = { ...m.state, token: 'TK2' }
    expect(() => m.save()).toThrow(/会话保存失败/)

    // 原子写的关键：失败的保存**没有**破坏原有会话文件
    expect(readFileSync(filePath)).toEqual(before)
    const restored = new SessionManager({ storage: fakeStorage(), filePath })
    expect(restored.load()).toBe(true)
    expect(restored.state.token).toBe('TK1')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1：M4 安全分支的测试
// ---------------------------------------------------------------------------

describe('安全相关分支（M4）', () => {
  it('encryptString 抛错时 save() 抛错且不写任何文件（不降级成明文）', () => {
    const filePath = tempFile()
    const storage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('加密失败（测试注入）')
      },
      decryptString: () => '',
    }
    const m = new SessionManager({ storage, filePath })
    m.state = { base: 'http://127.0.0.1:5666/music', mode: 'password', token: 'TK', deviceId: 'D', username: 'demo', password: 'pw', isRelay: false }
    expect(() => m.save()).toThrow(/会话加密失败/)
    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })

  it('落盘载荷记录注入的 savedAt 与格式版本', () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage(), filePath, now: () => 1700000000000 })
    m.state = { base: 'http://127.0.0.1:5666/music', mode: 'password', token: 'TK', deviceId: 'D', username: 'demo', password: 'pw', isRelay: false }
    m.save()

    const payload = readSavedPayload(filePath, fakeStorage())
    expect(payload['savedAt']).toBe(1700000000000)
    expect(payload['version']).toBe(1)
  })

  it('nas 模式的会话也能 load 还原', async () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage(), filePath })
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')
    m.state = { ...m.state, token: 'TK-NAS' }
    m.save()

    const restored = new SessionManager({ storage: fakeStorage(), filePath })
    expect(restored.load()).toBe(true)
    expect(restored.state.mode).toBe('nas')
    expect(restored.state.base).toBe('http://127.0.0.1:5666/music')
    expect(restored.state.deviceId).toBe('DEV1')
    expect(restored.state.token).toBe('TK-NAS')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1：M5 device id 的作用域
// ---------------------------------------------------------------------------

describe('device id 的作用域（M5）', () => {
  it('换服务器时重新生成 device id，同服务器续期时沿用', async () => {
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body ?? ''))
      return new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    const first = JSON.parse(bodies[0]!).deviceId as string

    // 换一台服务器 → device id 必须重新生成（不能复用上一台服务器的）
    await m.passwordLogin('http://192.168.1.10:5666/music', 'demo', 'pw')
    const second = JSON.parse(bodies[1]!).deviceId as string
    expect(second).not.toBe(first)

    // 同一台服务器续期 → 沿用原 device id
    await m.relogin()
    const third = JSON.parse(bodies[2]!).deviceId as string
    expect(third).toBe(second)
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1：控制器裁定 —— load() 失败必须可观测
// ---------------------------------------------------------------------------

describe('load() 失败的痕迹（控制器裁定）', () => {
  it('文件不存在属于正常的「没登录」：lastLoadError 保持 null', () => {
    const m = new SessionManager({ storage: fakeStorage(), filePath: tempFile() })
    expect(m.load()).toBe(false)
    expect(m.lastLoadError).toBeNull()
  })

  it('解密失败时 lastLoadError 带可判别的 code，并打不含凭证的告警', () => {
    const filePath = tempFile()
    writeFileSync(filePath, Buffer.concat([Buffer.from('E1', 'utf8'), Buffer.from('乱码', 'utf8')]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const m = new SessionManager({ storage: fakeStorage({ failDecrypt: true }), filePath })
    expect(m.load()).toBe(false)
    expect(m.lastLoadError).toBeInstanceOf(SessionStateError)
    expect(m.lastLoadError?.code).toBe('LOAD_DECRYPT_FAILED')

    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toMatch(/会话加载失败/)
    expect(logged).not.toContain('乱码')
  })

  it('损坏文件的内容不会泄漏进告警日志', () => {
    const filePath = tempFile()
    // 截断 + 尾巴垃圾：JSON.parse 的报错信息里会带上文件内容片段
    writeFileSync(filePath, 'P0{"password":"TOPSECRET"} GARBAGE')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const m = new SessionManager({ storage: fakeStorage(), filePath })
    expect(m.load()).toBe(false)
    expect(m.lastLoadError?.code).toBe('LOAD_CORRUPTED')

    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toMatch(/会话加载失败/)
    expect(logged).not.toContain('TOPSECRET')
  })
})

// ---------------------------------------------------------------------------
// 修复轮次 1：I1 / I2 / I3 续期竞态
// ---------------------------------------------------------------------------

describe('续期竞态（I1 / I2 / I3）', () => {
  /** 构造「下一次登录请求挂起」的 fetch 替身。 */
  function renewalGate(): {
    fetchMock: ReturnType<typeof vi.fn>
    gateNext: () => void
    gate: ReturnType<typeof createGate>
  } {
    const gate = createGate()
    let gateNext = false
    let loginCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        if (gateNext) {
          gateNext = false
          await gate.wait()
        }
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    })
    return {
      fetchMock,
      gateNext: () => {
        gateNext = true
      },
      gate,
    }
  }

  it('过期续期不会清空更新的会话（I1）', async () => {
    const { fetchMock, gateNext, gate } = renewalGate()
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    expect(m.state.token).toBe('TK1')

    gateNext()
    const relogin = m.relogin()
    await gate.reached() // 续期请求已发出并挂起

    m.clear() // 登出
    await m.passwordLogin('http://127.0.0.1:5666/music', 'userB', 'pwB')
    expect(m.state.token).toBe('TK3')

    gate.release() // 放行过期的续期
    expect(await relogin).toBe(false)

    // 关键：新建立的会话**没有被销毁**
    expect(m.state.token).toBe('TK3')
    expect(m.state.username).toBe('userB')
    expect(m.state.base).toBe('http://127.0.0.1:5666/music')
    expect(m.state.mode).toBe('password')
  })

  it('过期续期不会覆盖更新的显式登录（I2）', async () => {
    const { fetchMock, gateNext, gate } = renewalGate()
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'userA', 'pwA')
    expect(m.state.username).toBe('userA')

    gateNext()
    const relogin = m.relogin()
    await gate.reached()

    await m.passwordLogin('http://127.0.0.1:5666/music', 'userB', 'pwB')
    expect(m.state.username).toBe('userB')

    gate.release()
    expect(await relogin).toBe(false)

    // 关键：状态没有被回退到 userA
    expect(m.state.username).toBe('userB')
    expect(m.state.token).toBe('TK3')
  })

  it('在飞行的密码续期不会把 NAS 会话覆写回 password 模式（I2 的 NAS 变体）', async () => {
    const { fetchMock, gateNext, gate } = renewalGate()
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'userA', 'pwA')

    gateNext()
    const relogin = m.relogin()
    await gate.reached()

    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV-NAS')
    expect(m.state.mode).toBe('nas')

    gate.release()
    expect(await relogin).toBe(false)

    // 关键：NAS 会话没有被覆写回 mode=password
    expect(m.state.mode).toBe('nas')
    expect(m.state.deviceId).toBe('DEV-NAS')
    expect(m.state.username).toBe('')
  })

  it('续期成功后新 token 会落盘（I3）', async () => {
    const filePath = tempFile()
    let loginCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager({ storage: fakeStorage(), filePath })
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    m.save()
    expect(readSavedState(filePath, fakeStorage())?.token).toBe('TK1')

    expect(await m.relogin()).toBe(true)
    expect(m.state.token).toBe('TK2')
    // 关键：文件里也是新 token（否则每次启动都要恢复一个已失效的 token）
    expect(readSavedState(filePath, fakeStorage())?.token).toBe('TK2')
  })

  it('续期落盘失败不影响续期本身（写盘失败只记录 lastSaveError）', async () => {
    let loginCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        loginCount += 1
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: `TK${loginCount}`, deviceId: 'D' } }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // 没有注入 filePath → 续期成功但落盘失败
    const m = new SessionManager({ storage: fakeStorage() })
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    expect(await m.relogin()).toBe(true)
    expect(m.state.token).toBe('TK2')
    expect(m.lastSaveError).toBeInstanceOf(SessionStateError)
    expect(m.lastSaveError?.code).toBe('NO_STORAGE')
  })
})

// ---------------------------------------------------------------------------
// 请求超时（T44）
// ---------------------------------------------------------------------------
//
// ⚠️ **背景**：会话层的每一次 HTTP 请求原先**都没有超时**（`send()` 不传 `signal`）
//    → 网络一抖动就挂到 TCP 超时（可达 21 秒+）→ 界面「顿住」；
//    且 token 失效时 `relogin()` 失败**仍会重试** → 每个请求变成 3 个网络往返。
//
// ⚠️ 这里用**极小的超时**（80ms）而不是等真实的 30 秒 —— 单测要快。
// ---------------------------------------------------------------------------

describe('请求超时（T44）', () => {
  it('服务端不响应 → 请求在**超时**内失败（不无限挂住）', async () => {
    let hang = false
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }),
          { status: 200 },
        )
      }
      // ⚠️ 业务接口**永不响应**（模拟 NAS 挂住 / 网络不通 / 对端不回包）。
      if (hang) return new Promise<Response>(() => {})
      return new Response(JSON.stringify({ code: 0, data: { list: [] } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager({ requestTimeoutMs: 80 })
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    hang = true

    // ⚠️ 没有超时的话，这条会**永远挂住** → 单测超时失败。
    await expect(m.request('track/list')).rejects.toThrow(/无法连接音乐服务/)
  })

  it('超时与「连不上」是**两句话**（用户能分清是哪种）', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        return new Response(
          JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }),
          { status: 200 },
        )
      }
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager({ requestTimeoutMs: 80 })
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')

    await expect(m.request('track/list')).rejects.toThrow(/响应超时/)
  })

  it('续期失败时**不再重试**（不多花一个网络往返，直接把 99999 交回去）', async () => {
    let businessCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/user/password-login')) {
        // ⚠️ 首次登录成功；**续期**时网络不通 → 登录失败。
        if (businessCount === 0) {
          return new Response(
            JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }),
            { status: 200 },
          )
        }
        throw new Error('ECONNREFUSED')
      }
      businessCount += 1
      return new Response(
        JSON.stringify({ code: CODE_TOKEN_EXPIRED, msg: 'INVALID TOKEN' }),
        { status: 401 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const m = new SessionManager()
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    const res = await m.request('track/list')

    expect((res.json as { code?: number }).code).toBe(CODE_TOKEN_EXPIRED)
    // ⚠️ 续期失败 → **不该**再发第二次业务请求（那会再挂一个网络往返）。
    expect(businessCount).toBe(1)
  })
})
