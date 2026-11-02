import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeBase,
  hostOf,
  buildCandidates,
  parseConnectionParams,
  fetchConnectionParams,
} from '../electron/connection'
import { FN_CON_API, FN_CON_PATH, FN_SIGN_KEY, SIGN_PREFIX } from '../shared/constants'
import { md5, pathnameOf } from '../electron/sign'

// ---------------------------------------------------------------------------
// 计划 Task 4 的测试用例（逐字保留）
//
// 唯一改动：M1 实测修正——中继回退域名是 `<fnId>.fnos.net`（原写 `.5ddd.com`）。
// `5ddd.com` 只是 FN 连接接口自身的服务域名，不是中继域名。
// ---------------------------------------------------------------------------

describe('normalizeBase', () => {
  it('缺协议补 http', () => {
    expect(normalizeBase('192.168.1.10:5666')).toBe('http://192.168.1.10:5666/music')
  })
  it('已有 /music 不重复追加', () => {
    expect(normalizeBase('http://nas.local:5666/music')).toBe('http://nas.local:5666/music')
  })
  it('去尾部斜杠', () => {
    expect(normalizeBase('https://nas.local/music/')).toBe('https://nas.local/music')
  })
  it('空输入返回空串', () => {
    expect(normalizeBase('')).toBe('')
  })
})

describe('parseConnectionParams', () => {
  it('解析接口返回', () => {
    const p = parseConnectionParams({
      ipv4: ['192.168.1.2'], publicIpv4: ['1.2.3.4'], publicIpv6: ['2409::1'],
      fn: ['abc.5ddd.com:443'], port: { httpPort: 5666, httpsPort: 5667 },
    })
    expect(p.internalIPv4s).toEqual(['192.168.1.2'])
    expect(p.publicIPv6s).toEqual(['2409::1'])
    expect(p.relayAddresses).toEqual(['abc.5ddd.com:443'])
    expect(p.httpsPort).toBe(5667)
  })
  it('缺 port 时使用默认 5666/5667', () => {
    const p = parseConnectionParams({})
    expect(p.httpPort).toBe(5666)
    expect(p.httpsPort).toBe(5667)
  })
})

describe('buildCandidates', () => {
  it('按 内网→公网v6→公网v4→中继 排序且 IP 直连 http 优先', () => {
    const c = buildCandidates('myfn', parseConnectionParams({
      ipv4: ['192.168.1.2'], publicIpv4: ['1.2.3.4'], publicIpv6: ['2409::1'], fn: [],
    }))
    expect(c[0]!.address).toBe('http://192.168.1.2:5666')
    expect(c[1]!.address).toBe('https://192.168.1.2:5667')
    expect(c.map((x) => x.kind)).toEqual([
      'lan', 'lan', 'public', 'public', 'public', 'public', 'relay',
    ])
  })
  it('IPv6 地址加方括号', () => {
    const c = buildCandidates('myfn', parseConnectionParams({ publicIpv6: ['2409::1'] }))
    expect(c[0]!.address).toBe('http://[2409::1]:5666')
  })
  it('中继回退到 fnId.fnos.net 且仅 https', () => {
    const c = buildCandidates('myfn', parseConnectionParams({}))
    const relay = c.filter((x) => x.kind === 'relay')
    expect(relay).toHaveLength(1)
    expect(relay[0]!.address).toBe('https://myfn.fnos.net')
    expect(relay[0]!.isRelay).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeBase / hostOf 的边界
// ---------------------------------------------------------------------------

describe('normalizeBase 边界', () => {
  it('无端口时省略端口', () => {
    expect(normalizeBase('nas.local')).toBe('http://nas.local/music')
  })
  it('去掉首尾空白', () => {
    expect(normalizeBase('  http://nas.local:5666/music  ')).toBe('http://nas.local:5666/music')
  })
  it('缺协议且带路径时同样补 http', () => {
    expect(normalizeBase('192.168.1.10:5666/music')).toBe('http://192.168.1.10:5666/music')
  })
  it('非 /music 路径归一为 /music（基址形状固定为 <scheme>://<host>[:port]/music）', () => {
    expect(normalizeBase('http://nas.local:5666/')).toBe('http://nas.local:5666/music')
    expect(normalizeBase('http://nas.local:5666/api')).toBe('http://nas.local:5666/music')
  })
  it('以 /music 结尾的路径原样保留', () => {
    expect(normalizeBase('http://nas.local:5666/nas/music')).toBe('http://nas.local:5666/nas/music')
  })
  it('保留 https 与非默认端口', () => {
    expect(normalizeBase('https://nas.example.com:8443/music')).toBe('https://nas.example.com:8443/music')
  })
  it('非法输入返回空串', () => {
    expect(normalizeBase('http://')).toBe('')
  })
})

describe('hostOf', () => {
  it('取主机名，不含端口与路径', () => {
    expect(hostOf('http://nas.local:5666/music')).toBe('nas.local')
  })
  it('IPv6 去掉方括号', () => {
    expect(hostOf('http://[2409::1]:5666/music')).toBe('2409::1')
  })
  it('大小写归一为小写', () => {
    expect(hostOf('https://NAS.Local:5667/music')).toBe('nas.local')
  })
  it('缺协议时按 http 解析', () => {
    expect(hostOf('nas.local:5666')).toBe('nas.local')
  })
  it('空输入返回空串', () => {
    expect(hostOf('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// parseConnectionParams 的健壮性
// ---------------------------------------------------------------------------

describe('parseConnectionParams 健壮性', () => {
  it('兼容信封入参 { code, msg, data }', () => {
    const p = parseConnectionParams({
      code: 0,
      msg: '',
      data: { ipv4: ['10.0.0.9'], fn: ['abc.fnos.net:443'], port: { httpPort: 1234, httpsPort: 5678 } },
    })
    expect(p.internalIPv4s).toEqual(['10.0.0.9'])
    expect(p.relayAddresses).toEqual(['abc.fnos.net:443'])
    expect(p.httpPort).toBe(1234)
    expect(p.httpsPort).toBe(5678)
  })
  it('字段缺失或类型不对时回落为空数组与默认端口', () => {
    const p = parseConnectionParams({ ipv4: null, fn: 'oops', port: null })
    expect(p.internalIPv4s).toEqual([])
    expect(p.publicIPv4s).toEqual([])
    expect(p.publicIPv6s).toEqual([])
    expect(p.relayAddresses).toEqual([])
    expect(p.httpPort).toBe(5666)
    expect(p.httpsPort).toBe(5667)
  })
  it('非对象入参不抛异常', () => {
    expect(() => parseConnectionParams(null)).not.toThrow()
    expect(parseConnectionParams(null).httpsPort).toBe(5667)
  })
})

// ---------------------------------------------------------------------------
// buildCandidates 的中继语义（M1）
// ---------------------------------------------------------------------------

describe('buildCandidates 中继语义（实测修正 M1）', () => {
  it('fn 数组非空时优先使用接口返回值', () => {
    const c = buildCandidates('myfn', parseConnectionParams({ fn: ['abc.fnos.net:443'] }))
    const relay = c.filter((x) => x.kind === 'relay')
    expect(relay).toHaveLength(1)
    expect(relay[0]!.address).toBe('https://abc.fnos.net')
    expect(relay[0]!.isRelay).toBe(true)
  })
  it('fn 数组为空时才回退到 fnId.fnos.net', () => {
    const c = buildCandidates('myfn', parseConnectionParams({ fn: [] }))
    const relay = c.filter((x) => x.kind === 'relay')
    expect(relay).toHaveLength(1)
    expect(relay[0]!.address).toBe('https://myfn.fnos.net')
  })
  it('中继只生成 https，且去掉端口后缀', () => {
    const c = buildCandidates('myfn', parseConnectionParams({ fn: ['a.fnos.net:443', 'b.fnos.net:8443'] }))
    const relay = c.filter((x) => x.kind === 'relay')
    expect(relay.map((x) => x.address)).toEqual(['https://a.fnos.net', 'https://b.fnos.net'])
  })
  it('IP 直连同时生成 http 与 https 两条', () => {
    const c = buildCandidates('myfn', parseConnectionParams({ ipv4: ['1.2.3.4'] }))
    expect(c.map((x) => x.address)).toEqual([
      'http://1.2.3.4:5666',
      'https://1.2.3.4:5667',
      'https://myfn.fnos.net',
    ])
  })
  it('端口取自接口返回的 port', () => {
    const c = buildCandidates('myfn', parseConnectionParams({
      ipv4: ['1.2.3.4'], port: { httpPort: 1111, httpsPort: 2222 },
    }))
    expect(c.map((x) => x.address)).toEqual([
      'http://1.2.3.4:1111',
      'https://1.2.3.4:2222',
      'https://myfn.fnos.net',
    ])
  })
})

// ---------------------------------------------------------------------------
// 与上游参考实现 tools/fn-probe.mjs 的 buildCandidates 交叉验证
//
// 探针的 buildCandidates 已在真实 NAS 上跑通，是当前唯一经过实测的候选构造实现。
// 这里直接加载该文件源码做交叉验证，保证客户端与探针工具产出逐字节相同的候选列表。
// ---------------------------------------------------------------------------

/** 探针候选的形状（探针是 JS，无类型声明）。 */
type ProbeCandidate = { address: string; label: string; kind: string; isRelay: boolean }

/**
 * 从 tools/fn-probe.mjs 源码中切出 buildCandidates 并执行。
 *
 * 探针的 buildCandidates 依赖模块级的 `fnId`（来自命令行参数）作为中继回退值，
 * 因此这里把 `fnId` 作为工厂函数的参数注入。
 * 若探针文件结构变化导致定位失败，直接报错而不是悄悄跳过交叉验证。
 */
function loadProbeBuildCandidates(): (fnId: string, params: unknown) => ProbeCandidate[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const probeFile = join(here, '..', 'tools', 'fn-probe.mjs')
  const src = readFileSync(probeFile, 'utf8')
  const startMarker = 'function buildCandidates(params) {'
  const endMarker = 'async function probe(candidate)'
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      'tools/fn-probe.mjs 结构已变化：切不出 buildCandidates，无法与实测通过的探针做交叉验证',
    )
  }
  const factory = new Function(
    'fnId',
    'params',
    `${src.slice(start, end)}\nreturn buildCandidates(params)`,
  ) as unknown as (fnId: string, params: unknown) => ProbeCandidate[]
  return factory
}

describe('与实测探针 tools/fn-probe.mjs 交叉验证', () => {
  const probe = loadProbeBuildCandidates()

  const CASES: Array<{ name: string; fnId: string; payload: unknown }> = [
    {
      name: '完整载荷（含内网/公网 v4/公网 v6/中继）',
      fnId: 'myfn',
      payload: {
        ipv4: ['192.168.1.2'],
        publicIpv4: ['1.2.3.4'],
        publicIpv6: ['2409::1'],
        fn: ['abc.fnos.net:443'],
        port: { httpPort: 5666, httpsPort: 5667 },
      },
    },
    {
      name: '空载荷（中继回退）',
      fnId: 'myfn',
      payload: {},
    },
    {
      name: '仅中继且带自定义端口',
      fnId: 'myfn',
      payload: { fn: ['a.fnos.net:443'], port: { httpPort: 1234, httpsPort: 5678 } },
    },
    {
      name: '多个公网 IPv6 与多个中继',
      fnId: 'myfn',
      payload: {
        publicIpv6: ['2409::1', '2409::2'],
        fn: ['a.fnos.net:443', 'b.fnos.net:443'],
      },
    },
  ]

  for (const c of CASES) {
    it(`候选列表与探针逐字节一致：${c.name}`, () => {
      expect(buildCandidates(c.fnId, parseConnectionParams(c.payload))).toEqual(
        probe(c.fnId, c.payload),
      )
    })
  }
})

// ---------------------------------------------------------------------------
// fetchConnectionParams
// ---------------------------------------------------------------------------

describe('fetchConnectionParams', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('请求 FN 连接接口并解析参数', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          msg: '',
          data: {
            ipv4: ['192.168.1.2'],
            publicIpv4: [],
            publicIpv6: ['2409::1'],
            fn: ['abc.fnos.net:443'],
            port: { httpPort: 5666, httpsPort: 5667 },
          },
        }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const p = await fetchConnectionParams('myfn')
    expect(p.internalIPv4s).toEqual(['192.168.1.2'])
    expect(p.publicIPv6s).toEqual(['2409::1'])
    expect(p.relayAddresses).toEqual(['abc.fnos.net:443'])
    expect(p.httpPort).toBe(5666)
    expect(p.httpsPort).toBe(5667)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(FN_CON_API)
    expect(call.init.method).toBe('POST')
    expect(call.init.body).toBe('{"fnId":"myfn"}')
  })

  it('authx 头用 FN 连接接口专用密钥 FN_SIGN_KEY 签名纯路径', async () => {
    let authxHeader = ''
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      authxHeader = (init.headers as Record<string, string>)['authx'] ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: '', data: {} }),
      } as unknown as Response
    }) as unknown as typeof fetch

    await fetchConnectionParams('myfn')

    const m = /^nonce=([^&]+)&timestamp=([^&]+)&sign=([0-9a-f]{32})$/.exec(authxHeader)
    expect(m).not.toBeNull()
    if (!m) throw new Error(`authx 头格式不匹配: ${authxHeader}`)
    const nonce = m[1] as string
    const ts = m[2] as string
    const sign = m[3] as string
    const body = '{"fnId":"myfn"}'
    const expected = md5(
      [SIGN_PREFIX, pathnameOf(FN_CON_PATH), nonce, ts, md5(body), FN_SIGN_KEY].join('_'),
    )
    expect(sign).toBe(expected)
  })

  it('业务码非 0 时抛错', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 99999, msg: 'token expired' }),
    }) as unknown as Response) as unknown as typeof fetch

    await expect(fetchConnectionParams('myfn')).rejects.toThrow(/99999/)
  })

  it('返回非 JSON 时抛错', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    }) as unknown as Response) as unknown as typeof fetch

    await expect(fetchConnectionParams('myfn')).rejects.toThrow(/非 JSON/)
  })
})
