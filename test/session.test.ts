import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager, type SafeStorageLike } from '../electron/session'
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
    await m.passwordLogin('https://<FN-ID>.fnos.net/music', 'demo', 'pw')

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

  it('安装续期处理器后由处理器完成续期', async () => {
    const m = new SessionManager()
    await m.nasLogin('http://127.0.0.1:5666/music', 'DEV1')
    m.setNasRelogin(async () => {
      m.state.token = 'TK-NAS'
      return true
    })
    expect(await m.relogin()).toBe(true)
    expect(m.state.token).toBe('TK-NAS')
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
    await m.passwordLogin('https://<FN-ID>.fnos.net/music', 'demo', 'pw', { isRelay: true })
    fetchMock.mockClear()

    await m.request('track/list')
    expect(headerOf(readCalls(fetchMock)[0]!, 'cookie')).toBe('music-token=TK; mode=relay')
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
    expect(res.json.code).toBe(0)
    // 续期只触发**一次**登录请求
    expect(loginCount).toBe(2)
    // 首发 + 重试 = 2 次业务请求
    expect(businessCount).toBe(2)
    expect(m.state.token).toBe('TK2')

    // 重试用的是续期后的 token
    const calls = readCalls(fetchMock)
    expect(headerOf(calls[calls.length - 1]!, 'cookie')).toBe('music-token=TK2')
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
    expect(res.json.code).toBe(CODE_TOKEN_EXPIRED)
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
    await m.passwordLogin('https://<FN-ID>.fnos.net/music', 'demo', 'pw')
    m.save()

    const restored = new SessionManager({ storage: fakeStorage(), filePath })
    expect(restored.load()).toBe(true)
    expect(restored.state.isRelay).toBe(true)
    expect(restored.state.base).toBe('https://<FN-ID>.fnos.net/music')
  })

  it('文件不存在时 load() 返回 false 且不抛异常', () => {
    const m = new SessionManager({ storage: fakeStorage(), filePath: tempFile() })
    expect(m.load()).toBe(false)
    expect(m.state.token).toBe('')
  })

  it('内容损坏时 load() 返回 false 且不抛异常', () => {
    const filePath = tempFile()
    writeFileSync(filePath, 'XX这不是会话文件')
    const m = new SessionManager({ storage: fakeStorage(), filePath })
    expect(m.load()).toBe(false)
    expect(m.state.token).toBe('')
  })

  it('解密抛错时 load() 返回 false 且不抛异常', () => {
    const filePath = tempFile()
    writeFileSync(filePath, Buffer.concat([Buffer.from('E1', 'utf8'), Buffer.from('乱码', 'utf8')]))
    const m = new SessionManager({ storage: fakeStorage({ failDecrypt: true }), filePath })
    expect(m.load()).toBe(false)
    expect(m.state.token).toBe('')
  })

  it('明文回退（DPAPI 不可用）时以 P0 开头落盘', () => {
    const filePath = tempFile()
    const m = new SessionManager({ storage: fakeStorage({ available: false }), filePath })
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
