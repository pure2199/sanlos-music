import { describe, it, expect, vi, afterEach } from 'vitest'
import { TrustedHosts, normalizeHost } from '../electron/cert'
import { probeCandidates } from '../electron/probe'
import type { Candidate } from '../electron/connection'
import type { HttpStack, HttpStackInput } from '../electron/http'

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
// 裸 IPv6 兜底分支的输入校验（M4）
//
// 兜底分支只接受**真正能解析成 IPv6 字面量**的输入；畸形输入按无效处理
// （不登记 / 视为未命中），不能污染受信集合。
// ---------------------------------------------------------------------------

describe('normalizeHost 裸 IPv6 兜底分支', () => {
  it('合法的裸 IPv6 字面量被接受并归一成规范形式', () => {
    expect(normalizeHost('2409::1')).toBe('2409::1')
    expect(normalizeHost('2409:0:0:0:0:0:0:1')).toBe('2409::1')
    expect(normalizeHost('2409::1'.toUpperCase())).toBe('2409::1')
    expect(normalizeHost('::')).toBe('::')
  })

  it('畸形输入一律归一成空串（不登记）', () => {
    expect(normalizeHost('::::')).toBe('')
    expect(normalizeHost('nas.local:5666:extra')).toBe('')
    expect(normalizeHost('fe80::1%25eth0')).toBe('')
    expect(normalizeHost('2409::1]')).toBe('')
    expect(normalizeHost('1.2.3.4')).toBe('1.2.3.4') // 正常 IPv4 走 URL 分支
  })

  it('畸形输入既不登记也不命中', () => {
    const t = new TrustedHosts()
    t.add('::::')
    t.add('nas.local:5666:extra')
    t.add('fe80::1%25eth0')
    expect(t.verify('::::')).toBe(-3)
    expect(t.verify('nas.local:5666:extra')).toBe(-3)
    expect(t.verify('fe80::1%25eth0')).toBe(-3)
  })

  it('合法裸 IPv6 仍可登记并命中', () => {
    const t = new TrustedHosts()
    t.add('2409::1')
    expect(t.verify('2409::1')).toBe(0)
    expect(t.verify('2409:0:0:0:0:0:0:1')).toBe(0)
    expect(t.verify('evil.com')).toBe(-3)
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

  it('timeoutMs 为 0 视为未提供，回落到默认超时', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN, RELAY], { timeoutMs: 0 })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([3000, 10000])
  })

  it('timeoutMs 为负数 / 非有限数同样回落默认超时', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN], { timeoutMs: -5 })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([3000])
    spy.mockClear()
    await probeCandidates([LAN], { timeoutMs: Number.NaN })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([3000])
    spy.mockClear()
    await probeCandidates([LAN], { timeoutMs: Number.POSITIVE_INFINITY })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([3000])
  })

  it('timeoutMs 越界时被夹到 AbortSignal 的合法区间（不会抛 RangeError、fetch 仍会发出）', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    const results = await probeCandidates([LAN], { timeoutMs: 1e300 })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([4294967295])
    // 关键：请求**真的发出去了**（此前越界会抛 RangeError，fetch 根本没被调用）
    expect(calls).toHaveLength(1)
    expect(results[0]!.ok).toBe(true)
  })

  it('timeoutMs 小于 1 时夹到 1ms（不会退化成「立即中止」）', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN], { timeoutMs: 0.4 })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([1])
  })

  it('超时信号真的到达 fetch（init.signal 是 AbortSignal）', async () => {
    const calls = mockFetch(() => fakeResponse({ text: 'ok' }))
    await probeCandidates([LAN], { timeoutMs: 1234 })
    const signal = calls[0]!.init.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect((signal as AbortSignal).aborted).toBe(false)
  })

  it('超时真的会把请求中止（signal.aborted 变为 true，并归类为连接超时）', async () => {
    // 模拟一个「永远不返回」的请求：只有被中止才结束。
    let seen: AbortSignal | undefined
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('never aborted')), 5000)
        seen!.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        })
      })
    }) as unknown as typeof fetch

    const results = await probeCandidates([LAN], { timeoutMs: 30 })
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen!.aborted).toBe(true)
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('连接超时')
  })

  it('调用方传入的外部信号中止时，报「请求被取消」而不是「连接超时」', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch

    const pending = probeCandidates([LAN], { signal: controller.signal })
    controller.abort()
    const results = await pending
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('请求被取消')
    expect(results[0]!.error).not.toContain('连接超时')
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

  it('其它非 0 业务码 → 仍算可达（服务端明明有响应），只记服务端 msg', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 100001, msg: 'unknown error' } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error).toContain('unknown error')
  })

  it('非 0 业务码且无 msg 时记 code=<n>（仍算可达）', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 100001 } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
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

  it('已登录分支响应体缺少 code → 仍算可达（不判不可用）', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: {} }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error ?? '').not.toContain('不可用')
  })

  it('已登录分支 code=null → 仍算可达（不判不可用）', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: null } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error ?? '').not.toContain('不可用')
  })

  it('响应体是数组 → 仍算可达', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: [] }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(true)
  })

  it('可达性只看 HTTP 状态码：HTTP >= 400 一律不可用（无论业务码是什么）', async () => {
    mockFetch(() => fakeResponse({ status: 503, json: { code: 0 } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('503')
  })

  it('ok=true 时 error 只是备注，消费方不能把它读成「不可达」', async () => {
    mockFetch(() => fakeResponse({ status: 200, json: { code: 99999, msg: 'token expired' } }))
    const results = await probeCandidates([LAN], { token: 'tok' })
    // 可达 + 带备注：判可达只看 ok，error 非空不代表不可达。
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.error).toBeTruthy()
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
// Task 9b：切到 Chromium 分区栈之后的探测行为（复审回归网）
//
// 钉住三件最易回归的事：
// 1. `opts.http` 分支：注入出网通道时**走注入的通道**（不走全局 fetch）；
// 2. Chromium 的错误归类：Chromium 把 net 错误码放在 **message** 里
//    （`code` / `cause` 都是 undefined），证书类错误必须归为「TLS 握手失败」
//    并给出「可在设置里放行该主机」的**可操作提示**；
// 3. `fetchWithTimeout` 的兜底：底层 fetch **完全不理会 signal** 时，
//    定时器到点把请求收回来（**绝不挂死**），并归类为「连接超时」。
// ---------------------------------------------------------------------------

describe('probeCandidates 的 Chromium 分区栈（Task 9b）', () => {
  /** 构造一个出网通道替身（只实现探测用到的 `fetch`）。 */
  function stubHttpStack(
    impl: (url: string, init: RequestInit) => Response | Promise<Response>,
  ): { http: HttpStack; calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const http: HttpStack = {
      fetch: async (input: HttpStackInput, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} })
        return impl(String(input), init ?? {})
      },
      bumpTrustEpoch: () => {},
      partitionName: () => 'fn-nas-v0',
    }
    return { http, calls }
  }

  it('注入 http 时走注入的出网通道，不走全局 fetch', async () => {
    const globalMock = vi.fn(async () => fakeResponse({ status: 200, text: 'ok' }))
    globalThis.fetch = globalMock as unknown as typeof fetch
    const { http, calls } = stubHttpStack(() => fakeResponse({ status: 200, text: 'ok' }))

    const results = await probeCandidates([LAN], { http })

    expect(results[0]!.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://192.168.1.2:5666/music/api/v1/health')
    // 请求头照旧带 authx（上游语义），signal 也照旧传下去。
    expect(headerOf(calls[0]!.init, 'authx')).toMatch(/^nonce=/)
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    expect(globalMock).not.toHaveBeenCalled()
  })

  it('注入的 http 通道抛 Chromium 的证书错误时归类为 TLS 握手失败（给出放行提示）', async () => {
    const { http } = stubHttpStack(() => {
      // Chromium 的真实形态：只有 message，`code` / `cause` 都是 undefined。
      throw new Error('net::ERR_CERT_AUTHORITY_INVALID')
    })

    const results = await probeCandidates([LAN], { http })

    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('证书不受信')
    expect(results[0]!.error).toContain('放行')
  })
})

describe('Chromium 的 net 错误码归类（错误码只在 message 里）', () => {
  it('net::ERR_CERT_AUTHORITY_INVALID（自签 / 未知 CA）→ TLS 握手失败', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net::ERR_CERT_AUTHORITY_INVALID')
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('证书不受信')
    expect(results[0]!.error).toContain('放行')
  })

  it('net::ERR_CERT_COMMON_NAME_INVALID（域名不匹配）→ 也是证书类错误', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net::ERR_CERT_COMMON_NAME_INVALID')
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('证书不受信')
  })

  it('Chromium 的错误形态（无 code / 无 cause）也能被识别', async () => {
    // 实测形态：name='Error'、message='net::ERR_CERT_AUTHORITY_INVALID'、code/cause 均 undefined。
    const err = new Error('net::ERR_CERT_AUTHORITY_INVALID')
    expect((err as { code?: unknown }).code).toBeUndefined()
    expect((err as { cause?: unknown }).cause).toBeUndefined()
    globalThis.fetch = vi.fn(async () => {
      throw err
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.error).toContain('证书不受信')
  })

  it('非证书类的 net 错误**不**算 TLS（不放宽成「凡 ERR_ 都算 TLS」）', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED')
    }) as unknown as typeof fetch
    const results = await probeCandidates([LAN], {})
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).not.toContain('证书不受信')
  })
})

describe('探测的超时兜底（底层 fetch 不理会 signal 也不返回）', () => {
  it('定时器到点把请求收回来（不会挂死），并归类为连接超时', async () => {
    // 这个 fetch **完全无视** `init.signal`：既不响应 abort，也**永远不返回**。
    // 既有用例（mock 响应 abort）走的是 signal 路径，覆盖不到这条兜底路径。
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch

    const results = await probeCandidates([LAN], { timeoutMs: 30 })

    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('连接超时')
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
