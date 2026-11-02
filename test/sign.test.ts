import { describe, it, expect } from 'vitest'
import { authx, buildCookie, signPayload, md5, sha256, pathnameOf } from '../electron/sign'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIGN_PREFIX, SIGN_KEY, FN_SIGN_KEY, FN_CON_PATH } from '../shared/constants'

describe('authx', () => {
  it('GET 签名对查询参数按名排序', () => {
    expect(signPayload('GET', 'http://n/music/api/v1/album/list?size=10&page=1')).toBe(
      signPayload('GET', 'http://n/music/api/v1/album/list?page=1&size=10'),
    )
  })
  it('GET 签名保留空值参数（上游语义，实测修正 M9）', () => {
    // 简报原文此处断言 `?q=a&z=` ≡ `?q=a`，与上游参考实现（tools/fn-probe.mjs:43 保留空值）
    // 矛盾，判为**用例写错**：上游只丢弃字面量 'undefined' / 'null'，空值参数必须保留。
    const a = signPayload('GET', 'http://n/music/api/v1/x?q=a&z=')
    const b = signPayload('GET', 'http://n/music/api/v1/x?q=a')
    expect(a).not.toBe(b)
  })
  it('GET 签名忽略 undefined/null 参数值', () => {
    expect(signPayload('GET', 'http://n/music/api/v1/x?q=a&z=undefined')).toBe(
      signPayload('GET', 'http://n/music/api/v1/x?q=a'),
    )
    expect(signPayload('GET', 'http://n/music/api/v1/x?q=a&z=null')).toBe(
      signPayload('GET', 'http://n/music/api/v1/x?q=a'),
    )
  })
  it('非 GET 对请求体签名', () => {
    expect(signPayload('POST', 'http://n/music/api/v1/playlist/create', '{"name":"x"}')).toBe(
      signPayload('POST', 'http://n/music/api/v1/playlist/create', '{"name":"x"}'),
    )
    expect(signPayload('POST', 'http://n/x', '{"name":"a"}')).not.toBe(
      signPayload('POST', 'http://n/x', '{"name":"b"}'),
    )
  })
  it('authx 输出格式为 nonce=..&timestamp=..&sign=..', () => {
    const h = authx('GET', 'http://n/music/api/v1/track/list', undefined, { nonce: '123456', ts: '1700000000000' })
    expect(h).toMatch(/^nonce=123456&timestamp=1700000000000&sign=[0-9a-f]{32}$/)
  })
  it('中继 cookie 与 token 合并在同一个头', () => {
    expect(buildCookie('T', true)).toBe('music-token=T; mode=relay')
    expect(buildCookie('T', false)).toBe('music-token=T')
  })
})

// ---------------------------------------------------------------------------
// 与实测探针交叉验证
//
// tools/fn-probe.mjs 里的 authx / pathnameOf 已在真实 fnOS NAS 上跑通登录与全部只读接口，
// 是当前唯一经过实测的签名实现。此处直接加载该文件的源码做交叉验证，
// 保证客户端与探针工具在相同输入下产出逐字节相同的 authx 字符串。
// ---------------------------------------------------------------------------

/** 探针中 authx / pathnameOf 的签名（注意探针把 key、nonce、ts 作为位置参数）。 */
type ProbeApi = {
  authx: (
    method: string,
    url: string,
    body: string | undefined,
    key: string,
    nonce: string,
    ts: string,
  ) => string
  pathnameOf: (url: string) => string
}

/**
 * 从 tools/fn-probe.mjs 源码中切出算法部分并执行。
 *
 * 探针文件顶层会直接跑 main()，因此只取「文件开头 ~ 读取命令行参数之前」这一段，
 * 其中包含 md5 / sha256 / nonce / ts / pathnameOf / authx 的真实源码。
 * 若探针文件结构变化导致定位失败，直接报错而不是悄悄跳过交叉验证。
 */
function loadProbeApi(): ProbeApi {
  const here = dirname(fileURLToPath(import.meta.url))
  const probeFile = join(here, '..', 'tools', 'fn-probe.mjs')
  const src = readFileSync(probeFile, 'utf8')
  const marker = 'const args = process.argv.slice(2)'
  const cut = src.indexOf(marker)
  if (cut < 0) {
    throw new Error(
      `tools/fn-probe.mjs 结构已变化：找不到 "${marker}"，无法加载实测通过的 authx 做交叉验证`,
    )
  }
  // 去掉 ESM import 语句与 shebang，改为注入 createHash 参数后用 new Function 执行。
  const head = src
    .slice(0, cut)
    .replace(/^#![^\n]*\n/, '')
    .replace(/^import[^\n]*from\s+['"]node:crypto['"];?$/m, '')
  if (/^\s*import\s/m.test(head)) {
    throw new Error('tools/fn-probe.mjs 头部存在未处理的 import 语句，无法加载做交叉验证')
  }
  const factory = new Function(
    'createHash',
    `${head}\nreturn { authx, pathnameOf }`,
  ) as unknown as (h: typeof createHash) => ProbeApi
  return factory(createHash)
}

/** 交叉验证与 golden 向量共用的输入表。 */
const CROSS_CASES: Array<{
  name: string
  method: string
  url: string
  body?: string
  key: string
}> = [
  {
    name: '音乐接口 GET（带查询串）',
    method: 'GET',
    url: 'https://nas.example.com/music/api/v1/track/list?page=1&size=5',
    key: SIGN_KEY,
  },
  {
    name: '音乐接口 GET（无查询串）',
    method: 'GET',
    url: 'https://nas.example.com/music/api/v1/user/me',
    key: SIGN_KEY,
  },
  {
    name: '音乐接口 POST（带 body）',
    method: 'POST',
    url: 'https://nas.example.com/music/api/v1/user/password-login',
    body: JSON.stringify({ username: 'u', password: 'h', deviceId: 'd' }),
    key: SIGN_KEY,
  },
  {
    name: 'FN 连接接口 POST（纯路径）',
    method: 'POST',
    url: FN_CON_PATH,
    body: JSON.stringify({ fnId: 'fn123456' }),
    key: FN_SIGN_KEY,
  },
  {
    name: 'GET 含空值参数（上游语义）',
    method: 'GET',
    url: 'https://nas.example.com/music/api/v1/search/track?q=&page=1&size=5',
    key: SIGN_KEY,
  },
  {
    name: 'GET 值含空格 / 加号 / 非 ASCII',
    method: 'GET',
    url: 'https://nas.example.com/music/api/v1/search/track?q=a b&page=1',
    key: SIGN_KEY,
  },
]

describe('与实测探针 tools/fn-probe.mjs 交叉验证', () => {
  const probe = loadProbeApi()

  for (const c of CROSS_CASES) {
    it(`authx 与探针逐字节一致：${c.name}`, () => {
      const nonce = '123456'
      const ts = '1700000000000'
      expect(authx(c.method, c.url, c.body, { nonce, ts, key: c.key })).toBe(
        probe.authx(c.method, c.url, c.body, c.key, nonce, ts),
      )
    })
  }

  it('pathnameOf 与探针一致（完整 URL 与纯路径）', () => {
    expect(pathnameOf('https://nas.example.com/music/api/v1/track/list?page=1')).toBe(
      probe.pathnameOf('https://nas.example.com/music/api/v1/track/list?page=1'),
    )
    expect(pathnameOf(FN_CON_PATH)).toBe(probe.pathnameOf(FN_CON_PATH))
  })

  it('FN 连接接口用纯路径签名（实测修正 M4）', () => {
    expect(pathnameOf(FN_CON_PATH)).toBe('/api/v1/fn/con')
    expect(pathnameOf('https://5ddd.com/api/v1/fn/con')).toBe('/api/v1/fn/con')
  })
})

// ---------------------------------------------------------------------------
// golden 向量
//
// 期望值取自上游参考实现 tools/fn-probe.mjs 的实测跑通输出（nonce=123456、ts=1700000000000），
// 写死成字面量。这样即使 sign.ts 与探针被同时改坏，用例依然会红。
// ---------------------------------------------------------------------------

describe('golden 向量（钉死期望值）', () => {
  const opts = { nonce: '123456', ts: '1700000000000' }

  it('音乐接口 GET（带查询串）', () => {
    expect(
      authx('GET', 'https://nas.example.com/music/api/v1/track/list?page=1&size=5', undefined, {
        ...opts,
        key: SIGN_KEY,
      }),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=bb6c7e51141a3bdd7ede31d9baaa7dda')
  })

  it('音乐接口 GET（无查询串）', () => {
    expect(
      authx('GET', 'https://nas.example.com/music/api/v1/user/me', undefined, {
        ...opts,
        key: SIGN_KEY,
      }),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=b673b1e99a5f195908597579b284eb16')
  })

  it('音乐接口 POST（带 body）', () => {
    expect(
      authx(
        'POST',
        'https://nas.example.com/music/api/v1/user/password-login',
        JSON.stringify({ username: 'u', password: 'h', deviceId: 'd' }),
        { ...opts, key: SIGN_KEY },
      ),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=2c64cdd31c6c30d82e504b8101d4cca5')
  })

  it('FN 连接接口 POST（纯路径）', () => {
    expect(
      authx('POST', FN_CON_PATH, JSON.stringify({ fnId: 'fn123456' }), {
        ...opts,
        key: FN_SIGN_KEY,
      }),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=c9010004cd652621ab90055f30aec2b3')
  })

  it('GET 含空值参数（空值参与签名）', () => {
    expect(
      authx('GET', 'https://nas.example.com/music/api/v1/search/track?q=&page=1&size=5', undefined, {
        ...opts,
        key: SIGN_KEY,
      }),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=8f07f0f2af2e6e4396eb962cce1cc20b')
  })

  it('GET 值含空格 / 加号 / 非 ASCII', () => {
    // 空格与 '+' 解析后同义，规范串都是 'page=1&q=a b'；非 ASCII 解码后进规范串。
    expect(
      authx('GET', 'https://nas.example.com/music/api/v1/search/track?q=a b&page=1', undefined, {
        ...opts,
        key: SIGN_KEY,
      }),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=86e6493ebada36be2195917ae0c8ea0a')
    expect(
      authx('GET', 'https://nas.example.com/music/api/v1/search/track?q=a+b&page=1', undefined, {
        ...opts,
        key: SIGN_KEY,
      }),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=86e6493ebada36be2195917ae0c8ea0a')
    expect(
      authx('GET', 'https://nas.example.com/music/api/v1/search/track?q=中文&page=1', undefined, {
        ...opts,
        key: SIGN_KEY,
      }),
    ).toBe('nonce=123456&timestamp=1700000000000&sign=3ae386fc86224207dbc4134a1956a12e')
  })
})

// ---------------------------------------------------------------------------
// 实测修正 M3：nonce / timestamp 只生成一次，同时用于请求头与签名计算
// ---------------------------------------------------------------------------

describe('实测修正 M3：nonce 与 timestamp 只生成一次', () => {
  it('固定 nonce/ts 时返回头以 nonce=123456&timestamp=1700000000000&sign= 开头', () => {
    const h = authx(
      'GET',
      'https://nas.example.com/music/api/v1/track/list',
      undefined,
      { nonce: '123456', ts: '1700000000000' },
    )
    expect(h.startsWith('nonce=123456&timestamp=1700000000000&sign=')).toBe(true)
  })

  it('签名计算使用的 nonce/timestamp 与返回头中的完全一致', () => {
    const url = 'https://nas.example.com/music/api/v1/track/list?page=1&size=5'
    const h = authx('GET', url)
    const m = /^nonce=([^&]+)&timestamp=([^&]+)&sign=([0-9a-f]{32})$/.exec(h)
    expect(m).not.toBeNull()
    if (!m) throw new Error(`authx 输出格式不匹配: ${h}`)
    const n = m[1] as string
    const t = m[2] as string
    const sign = m[3] as string
    const expected = md5(
      [SIGN_PREFIX, pathnameOf(url), n, t, signPayload('GET', url), SIGN_KEY].join('_'),
    )
    expect(sign).toBe(expected)
  })

  it('未注入 nonce/ts 时也只生成一次（请求头里的 nonce 参与签名）', () => {
    const url = 'https://nas.example.com/music/api/v1/album/list?page=1&size=20'
    const h = authx('GET', url)
    const n = /nonce=([^&]+)&/.exec(h)?.[1]
    const t = /timestamp=([^&]+)&/.exec(h)?.[1]
    expect(n).toBeTruthy()
    expect(t).toBeTruthy()
    const expected = md5(
      [SIGN_PREFIX, pathnameOf(url), n as string, t as string, signPayload('GET', url), SIGN_KEY].join(
        '_',
      ),
    )
    expect(h.endsWith(`sign=${expected}`)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 规范串细节与边界
// ---------------------------------------------------------------------------

describe('sign 细节', () => {
  it('md5 / sha256 与标准向量一致', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('GET 规范串：参数名升序、空值保留', () => {
    expect(signPayload('GET', 'http://n/music/api/v1/x?b=2&a=1&c=')).toBe(md5('a=1&b=2&c='))
  })

  it('GET 规范串：空格与加号都归一为空格（+ → %20 → 解码）', () => {
    expect(signPayload('GET', 'http://n/music/api/v1/x?q=a b&page=1')).toBe(
      md5('page=1&q=a b'),
    )
    expect(signPayload('GET', 'http://n/music/api/v1/x?q=a+b&page=1')).toBe(
      md5('page=1&q=a b'),
    )
  })

  it('GET 规范串：非 ASCII 解码后进规范串', () => {
    expect(signPayload('GET', 'http://n/music/api/v1/x?q=中文&page=1')).toBe(
      md5('page=1&q=中文'),
    )
  })

  it('GET 无查询串时对空串签名', () => {
    expect(signPayload('GET', 'http://n/music/api/v1/x')).toBe(md5(''))
  })

  it('非 GET 无 body 时对空串签名', () => {
    expect(signPayload('POST', 'http://n/music/api/v1/x')).toBe(md5(''))
  })

  it('非 GET 的 body 为 null 时按空串签名', () => {
    expect(signPayload('POST', 'http://n/music/api/v1/x', null as unknown as string)).toBe(md5(''))
  })

  it('Uint8Array 请求体与同内容字符串结果一致', () => {
    expect(signPayload('POST', 'http://n/x', new TextEncoder().encode('{"a":1}'))).toBe(
      signPayload('POST', 'http://n/x', '{"a":1}'),
    )
  })

  it('音乐接口与 FN 连接接口的密钥不可混用', () => {
    const opts = { nonce: '123456', ts: '1700000000000' }
    expect(authx('POST', FN_CON_PATH, '{"fnId":"x"}', { ...opts, key: FN_SIGN_KEY })).not.toBe(
      authx('POST', FN_CON_PATH, '{"fnId":"x"}', { ...opts, key: SIGN_KEY }),
    )
  })

  it('默认使用音乐接口密钥 SIGN_KEY', () => {
    const opts = { nonce: '123456', ts: '1700000000000' }
    expect(authx('GET', 'http://n/music/api/v1/x', undefined, opts)).toBe(
      authx('GET', 'http://n/music/api/v1/x', undefined, { ...opts, key: SIGN_KEY }),
    )
  })

  it('空串密钥回退到 SIGN_KEY', () => {
    const opts = { nonce: '123456', ts: '1700000000000' }
    expect(authx('GET', 'http://n/music/api/v1/x', undefined, { ...opts, key: '' })).toBe(
      authx('GET', 'http://n/music/api/v1/x', undefined, { ...opts, key: SIGN_KEY }),
    )
  })
})
