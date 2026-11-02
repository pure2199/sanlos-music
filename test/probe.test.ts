import { describe, it, expect, vi, afterEach } from 'vitest'
import { TrustedHosts } from '../electron/cert'
import { probeCandidates } from '../electron/probe'
import type { Candidate } from '../electron/connection'

// ---------------------------------------------------------------------------
// 计划 Task 9 的测试用例（逐字保留）
//
// 唯一语义补充（控制器裁定）：`verify` 的入参可能带端口或 IPv6 方括号，
// 比较前统一归一化（去端口、去方括号、小写）；命中返回 0，未命中返回 -3。
// ---------------------------------------------------------------------------

describe('TrustedHosts', () => {
  it('只信任登记过的 host', () => {
    const t = new TrustedHosts()
    t.add('https://nas.local:5666/music')
    expect(t.verify('nas.local')).toBe(0)
    expect(t.verify('evil.com')).toBe(-3)
  })
  it('大小写与 IPv6 方括号归一', () => {
    const t = new TrustedHosts()
    t.add('http://[2409::1]:5666/music')
    expect(t.verify('2409::1')).toBe(0)
    expect(t.verify('2409::1'.toUpperCase())).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TrustedHosts 的其余归一化规则（控制器裁定 §3.6）
//
// 归一化只做三件事：**去端口、去 IPv6 方括号、小写**。
// 匹配是**精确匹配**：没有通配符、没有后缀匹配——放行范围严格等于用户填写的那个 host。
// ---------------------------------------------------------------------------

describe('TrustedHosts 归一化与精确匹配', () => {
  it('可登记多个 host，互不干扰', () => {
    const t = new TrustedHosts()
    t.add('https://nas.local:5666/music')
    t.add('http://[2409::1]:5666/music')
    t.add('https://myfn.fnos.net')
    expect(t.verify('nas.local')).toBe(0)
    expect(t.verify('2409::1')).toBe(0)
    expect(t.verify('myfn.fnos.net')).toBe(0)
    expect(t.verify('other.host')).toBe(-3)
  })

  it('入参带端口时按同一 host 命中（端口不同也算命中）', () => {
    const t = new TrustedHosts()
    t.add('https://nas.local:5666/music')
    expect(t.verify('nas.local:5666')).toBe(0)
    expect(t.verify('nas.local:8443')).toBe(0)
    expect(t.verify('nas.local:')).toBe(0)
  })

  it('入参带 IPv6 方括号时命中', () => {
    const t = new TrustedHosts()
    t.add('http://[2409::1]:5666/music')
    expect(t.verify('[2409::1]')).toBe(0)
    expect(t.verify('[2409::1]:5666')).toBe(0)
  })

  it('比较大小写不敏感', () => {
    const t = new TrustedHosts()
    t.add('https://NAS.Local:5666/music')
    expect(t.verify('nas.local')).toBe(0)
    expect(t.verify('NAS.LOCAL')).toBe(0)
    expect(t.verify('Nas.Local')).toBe(0)
  })

  it('不做后缀匹配：子域与超域都不是同一个 host', () => {
    const t = new TrustedHosts()
    t.add('https://nas.local:5666/music')
    expect(t.verify('evil-nas.local')).toBe(-3)
    expect(t.verify('nas.local.evil.com')).toBe(-3)
    expect(t.verify('nas2.local')).toBe(-3)
  })

  it('不做通配符匹配', () => {
    const t = new TrustedHosts()
    t.add('https://*.nas.local:5666/music')
    expect(t.verify('a.nas.local')).toBe(-3)
  })

  it('未登记的 host 一律 -3，空输入也 -3', () => {
    const t = new TrustedHosts()
    expect(t.verify('nas.local')).toBe(-3)
    expect(t.verify('')).toBe(-3)
    expect(t.verify('   ')).toBe(-3)
  })

  it('登记 URL 时只取 host：路径、查询串、userinfo 都不影响', () => {
    const t = new TrustedHosts()
    t.add('https://user:pw@nas.local:5666/music?a=1#frag')
    expect(t.verify('nas.local')).toBe(0)
    expect(t.verify('user')).toBe(-3)
  })

  it('空串 / 非法输入不会污染集合', () => {
    const t = new TrustedHosts()
    t.add('')
    t.add('   ')
    t.add('http://')
    expect(t.verify('')).toBe(-3)
    expect(t.verify('http://')).toBe(-3)
  })
})

// ---------------------------------------------------------------------------
// probeCandidates 的测试夹具
// ---------------------------------------------------------------------------

/** 直连候选（内网）。 */
const LAN: Candidate = {
  address: 'http://192.168.1.2:5666',
  label: 'HTTP 内网 192.168.1.2',
  kind: 'lan',
  isRelay: false,
}

/** 第二个直连候选（公网 v6，带方括号）。 */
const PUBLIC_V6: Candidate = {
  address: 'https://[2409::1]:5667',
  label: 'HTTPS 公网v6 2409::1',
  kind: 'public',
  isRelay: false,
}

/** 中继候选。 */
const RELAY: Candidate = {
  address: 'https://myfn.fnos.net',
  label: 'HTTPS 中继 myfn.fnos.net',
  kind: 'relay',
  isRelay: true,
}

/** 假响应的构造参数。 */
interface FakeResponseOptions {
  status?: number
  /** JSON 响应体（与 `text` 二选一）。 */
  json?: unknown
  /** 非 JSON 响应体（模拟 `/health` 返回 HTML）。 */
  text?: string
}

/** 构造一个只提供探测所需字段的假 Response。 */
function fakeResponse(options: FakeResponseOptions = {}): Response {
  const status = options.status ?? 200
  const text = options.json !== undefined ? JSON.stringify(options.json) : (options.text ?? '')
  return {
    ok: status < 400,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response
}

/** 一次被记录下来的 fetch 调用。 */
interface FetchCall {
  url: string
  init: RequestInit
}

/**
 * 替换全局 fetch，并记录每次调用。
 *
 * @param impl 按 URL 分发响应 / 抛错的实现。
 */
function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return impl(String(url), init)
  }) as unknown as typeof fetch
  return calls
}

/** 取请求头（大小写不敏感）。 */
function headerOf(init: RequestInit, name: string): string {
  const headers = init.headers as Record<string, string> | undefined
  if (!headers) return ''
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return hit ? hit[1] : ''
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 探测 URL 与请求头
// ---------------------------------------------------------------------------

describe('probeCandidates 探测 URL 与请求头', () => {
  it('已登录时打 /music/api/v1/track/list（最小 size）', async () => {
    const calls = mockFetch(() => fakeResponse({ json: { code: 0 } }))
    await probeCandidates([LAN], { token: 'tok' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://192.168.1.2:5666/music/api/v1/track/list?size=1')
  })

  it('未登录时打 /music/api/v1/health', async () => {
    const calls = mockFetch(() => fakeResponse({ text: '<html>ok</html>' }))
    await probeCandidates([LAN], {})
    expect(calls[0]!.url).toBe('http://192.168.1.2:5666/music/api/v1/health')
  })

  it('候选地址不含 /music 时由探测自己拼上', async () => {
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([RELAY], {})
    expect(calls[0]!.url).toBe('https://myfn.fnos.net/music/api/v1/health')
  })

  it('已登录时 Cookie 带 music-token，直连不带 mode=relay', async () => {
    const calls = mockFetch(() => fakeResponse({ json: { code: 0 } }))
    await probeCandidates([LAN], { token: 'tok-123' })
    const cookie = headerOf(calls[0]!.init, 'cookie')
    expect(cookie).toContain('music-token=tok-123')
    expect(cookie).not.toContain('mode=relay')
  })

  it('中继候选带 Cookie: mode=relay（有 token 时与 music-token 合并在同一头）', async () => {
    const calls = mockFetch(() => fakeResponse({ json: { code: 0 } }))
    await probeCandidates([RELAY], { token: 'tok-123' })
    const cookie = headerOf(calls[0]!.init, 'cookie')
    expect(cookie).toContain('music-token=tok-123')
    expect(cookie).toContain('mode=relay')
  })

  it('中继候选无 token 时也必须带 mode=relay（否则中继不认请求）', async () => {
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([RELAY], {})
    const cookie = headerOf(calls[0]!.init, 'cookie')
    expect(cookie).toContain('mode=relay')
    expect(cookie).not.toContain('music-token')
  })

  it('直连候选无 token 时不带 Cookie', async () => {
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN], {})
    expect(headerOf(calls[0]!.init, 'cookie')).toBe('')
  })

  it('中继候选同样带 authx（按上游语义统一发送）', async () => {
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([RELAY], {})
    expect(headerOf(calls[0]!.init, 'authx')).toMatch(/^nonce=\d{6}&timestamp=\d+&sign=[0-9a-f]{32}$/)
  })
})

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

describe('probeCandidates 超时', () => {
  it('直连候选 3s、中继候选 10s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN, RELAY], {})
    const used = spy.mock.calls.map((c) => c[0])
    expect(used).toContain(3000)
    expect(used).toContain(10000)
  })

  it('opts.timeoutMs 覆盖直连与中继的默认超时', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN, RELAY], { timeoutMs: 1234 })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([1234, 1234])
  })

  it('opts.timeoutMs 存在即覆盖（含 0），不做「非法值才回落」的额外判断', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN, RELAY], { timeoutMs: 0 })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([0, 0])
  })
})

// ---------------------------------------------------------------------------
// 并行与顺序
// ---------------------------------------------------------------------------

describe('probeCandidates 并行与顺序', () => {
  it('所有候选并行发出请求（不是逐个等待前一个的结果）', async () => {
    const calls: FetchCall[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      await gate
      return fakeResponse({ text: 'ok' })
    }) as unknown as typeof fetch

    const pending = probeCandidates([LAN, PUBLIC_V6, RELAY], {})
    await new Promise((r) => setTimeout(r, 0))
    // 三条请求都已发出（串行实现此时只会有第一条）。
    expect(calls).toHaveLength(3)
    release()
    const results = await pending
    expect(results).toHaveLength(3)
  })

  it('返回顺序与输入候选顺序一致（与完成顺序无关）', async () => {
    const delayOf = (url: string): number => {
      if (url.includes('2409')) return 0
      if (url.includes('fnos.net')) return 5
      return 20
    }
    mockFetch(async (url) => {
      await new Promise((r) => setTimeout(r, delayOf(url)))
      return fakeResponse({ text: 'ok' })
    })
    const results = await probeCandidates([LAN, PUBLIC_V6, RELAY], {})
    expect(results.map((r) => r.candidate.label)).toEqual([LAN.label, PUBLIC_V6.label, RELAY.label])
  })

  it('每个候选最多只发一次请求', async () => {
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN, RELAY], {})
    expect(calls).toHaveLength(2)
  })

  it('空候选列表返回空数组', async () => {
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    expect(await probeCandidates([], {})).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 判定规则（控制器裁定 §3.1）
//
// 链路可达性**只看 HTTP 状态码**：`< 400` 即为可达。
// `/health` 的业务码实测不可信（`code=null`），故未登录分支不解析业务码。
// ---------------------------------------------------------------------------

describe('probeCandidates 判定规则', () => {
  it('HTTP 200 即可达', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 0 } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error).toBeUndefined()
  })

  it('code 99999 → 链路可达，但记「token 已失效」', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 99999, msg: 'token expired' } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error).toContain('token 已失效')
  })

  it('其它非 0 业务码 → 不可用，记服务端 msg', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 100001, msg: 'unknown error' } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('unknown error')
  })

  it('非 0 业务码且无 msg 时记 code=<n>', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 100001 } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('code=100001')
  })

  it('HTTP 500 → 不可用，记 HTTP 500', async () => {
    mockFetch(() => fakeResponse({ status: 500, text: 'boom' }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('500')
  })

  it('HTTP 404 → 不可用', async () => {
    mockFetch(() => fakeResponse({ status: 404, text: 'nope' }))
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('404')
  })

  it('/health 返回非 JSON 但状态 200 → 可达且不报错', async () => {
    mockFetch(() => fakeResponse({ status: 200, text: '<html>not json</html>' }))
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error).toBeUndefined()
  })

  it('未登录分支不解析业务码（health 的 code=null 仍算可达）', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: null } }))
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error).toBeUndefined()
  })

  it('已登录分支响应体非 JSON 且状态 200 → 可达且不报错', async () => {
    mockFetch(() => fakeResponse({ status: 200, text: '<html>not json</html>' }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 错误归类（控制器裁定 §3.5）
//
// Node 的 fetch 失败时抛 `TypeError: fetch failed`，真正的错误在 `cause` 上，
// 因此归类必须看 `cause.code` / `cause.message`，不靠匹配错误文案。
// ---------------------------------------------------------------------------

describe('probeCandidates 错误归类', () => {
  const CASES: Array<{ name: string; cause: Record<string, unknown>; expected: string }> = [
    { name: 'DNS 解析失败', cause: { code: 'ENOTFOUND' }, expected: '无法解析主机' },
    { name: 'DNS 临时失败', cause: { code: 'EAI_AGAIN' }, expected: '无法解析主机' },
    { name: '连接被拒绝', cause: { code: 'ECONNREFUSED' }, expected: '连接被拒绝' },
    { name: '连接超时', cause: { code: 'ETIMEDOUT' }, expected: '连接超时' },
    { name: 'undici 连接超时', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' }, expected: '连接超时' },
    { name: 'undici 响应头超时', cause: { code: 'UND_ERR_HEADERS_TIMEOUT' }, expected: '连接超时' },
    { name: '网络不可达', cause: { code: 'ENETUNREACH' }, expected: '网络不可达' },
    { name: '主机不可达', cause: { code: 'EHOSTUNREACH' }, expected: '网络不可达' },
    { name: '证书不受信', cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, expected: '证书不受信' },
    { name: '证书校验失败', cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, expected: '证书不受信' },
    { name: '证书过期', cause: { code: 'CERT_HAS_EXPIRED' }, expected: '证书不受信' },
  ]

  for (const c of CASES) {
    it(`${c.name} → ${c.expected}`, async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: c.cause })
      }) as unknown as typeof fetch
      const results = await probeCandidates([LAN], {})
      expect(results[0]!.ok).toBe(false)
      expect(results[0]!.error).toContain(c.expected)
    })
  }

  it('TLS 失败给出可操作的放行提示', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } })
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.error).toContain('放行')
    expect(results[0]!.error).toContain('证书不受信')
  })

  it('altname 不匹配（ERR_TLS_CERT_ALTNAME_INVALID）也算 TLS 握手失败', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: {
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
          message: "Hostname/IP does not match certificate's altnames",
        },
      })
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.error).toContain('证书不受信')
  })

  it('超时（DOMException 名含 Timeout）归类为连接超时', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('连接超时')
  })

  it('无法归类的错误给出兜底文案，且不泄露底层异常文本', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'EPROTO', message: 'weird tls state' } })
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toBeTruthy()
    expect(results[0]!.error).not.toContain('weird tls state')
  })

  it('一个候选失败不影响其它候选', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('192.168')) {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
      }
      return fakeResponse({ status: 200, text: 'ok' })
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN, RELAY], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('无法解析主机')
    expect(results[1]!.ok).toBe(true)
  })

  it('候选地址非法时不抛异常，转成失败结果', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      throw new TypeError(`Failed to parse URL from ${String(url)}`)
    }) as unknown as typeof fetch
    const bad: Candidate = {
      address: 'not a url',
      label: '坏地址',
      kind: 'lan',
      isRelay: false,
    }
    const results = await probeCandidates([bad], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 安全：token 不得出现在 error 文案里
// ---------------------------------------------------------------------------

describe('probeCandidates 不泄露 token', () => {
  it('失败时的 error 不含 token', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], { token: 'super-secret-token' })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).not.toContain('super-secret-token')
  })

  it('业务码错误时的 error 不含 token', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 100001, msg: 'unknown error' } }))
    const results = await probeCandidates([LAN], { token: 'super-secret-token' })
    expect(results[0]!.error).not.toContain('super-secret-token')
  })

  it('探测 URL 不含 token（token 只走 Cookie）', async () => {
    const calls = mockFetch(() => fakeResponse({ json: { code: 0 } }))
    await probeCandidates([LAN], { token: 'super-secret-token' })
    expect(calls[0]!.url).not.toContain('super-secret-token')
  })
})
