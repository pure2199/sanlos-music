import { describe, it, expect, vi, afterEach } from 'vitest'
import { Readable } from 'node:stream'

import {
  createHttpStack,
  type ElectronNetClientRequestLike,
  type ElectronNetLike,
  type ElectronSessionLike,
} from '../electron/http'
import { TrustedHosts, VERIFY_ACCEPT, VERIFY_REJECT } from '../electron/cert'

// ---------------------------------------------------------------------------
// Task 9b：主进程 NAS 流量走 Chromium 分区栈
//
// 覆盖简报 Step 1 要求的全部行为：
// - 分区名随 `epoch` 变化；
// - `bumpTrustEpoch()` 后用新分区（绕开旧分区缓存的证书错误）；
// - Electron 不可用时回落到注入的 `fetchImpl`（单测不得依赖 Electron）；
// - verify proc 按 `trusted.verify(hostname)` 放行 / 拒绝（**绝不**全局 `callback(0)`）；
// - `TrustedHosts.add()` 的返回值语义。
//
// 依赖注入：Electron 的 `session` 模块用替身注入（`opts.session`），
// 故本文件**完全不碰 Electron 运行时**。
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** verify proc 的签名（Electron 的 `setCertificateVerifyProc` 回调）。 */
type VerifyProc = (request: { hostname: string }, callback: (result: number) => void) => void

/**
 * 假 Electron `session` 模块。
 *
 * 记录：创建过的分区（含选项）、每个分区上注册过的 verify proc、每次 fetch 的归属分区。
 */
function fakeElectronSession(): {
  mod: ElectronSessionLike
  partitions: Array<{ name: string; options: { cache?: boolean } | undefined }>
  procs: Map<string, VerifyProc>
  fetches: Array<{ partition: string; input: unknown; init: unknown }>
} {
  const partitions: Array<{ name: string; options: { cache?: boolean } | undefined }> = []
  const procs = new Map<string, VerifyProc>()
  const fetches: Array<{ partition: string; input: unknown; init: unknown }> = []

  const mod: ElectronSessionLike = {
    fromPartition(name, options) {
      partitions.push({ name, options })
      return {
        fetch: async (input: unknown, init: unknown) => {
          fetches.push({ partition: name, input, init })
          return new Response('ok', { status: 200 })
        },
        setCertificateVerifyProc(proc: VerifyProc) {
          procs.set(name, proc)
        },
      }
    },
  }

  return { mod, partitions, procs, fetches }
}

// ---------------------------------------------------------------------------
// 分区与 epoch
// ---------------------------------------------------------------------------

describe('HttpStack 的分区与信任版本', () => {
  it('分区名形如 fn-nas-v<epoch>，初始 epoch 为 0', () => {
    const { mod } = fakeElectronSession()
    const stack = createHttpStack({ session: mod })

    expect(stack.partitionName()).toBe('fn-nas-v0')
  })

  it('可以指定初始 epoch 与分区名前缀', () => {
    const { mod } = fakeElectronSession()
    const stack = createHttpStack({ session: mod, epoch: 7, partitionPrefix: 'fn-test' })

    expect(stack.partitionName()).toBe('fn-test-v7')
  })

  it('bumpTrustEpoch() 之后分区名跟着变（epoch + 1）', () => {
    const { mod } = fakeElectronSession()
    const stack = createHttpStack({ session: mod })

    stack.bumpTrustEpoch()

    expect(stack.partitionName()).toBe('fn-nas-v1')
  })

  it('bumpTrustEpoch() 之后用新分区发请求（旧分区不再被使用）', async () => {
    const { mod, partitions, fetches } = fakeElectronSession()
    const stack = createHttpStack({ session: mod })

    await stack.fetch('http://nas.local:5666/music/api/v1/health')
    stack.bumpTrustEpoch()
    await stack.fetch('http://nas.local:5666/music/api/v1/health')

    expect(partitions.map((p) => p.name)).toEqual(['fn-nas-v0', 'fn-nas-v1'])
    expect(fetches.map((f) => f.partition)).toEqual(['fn-nas-v0', 'fn-nas-v1'])
  })

  it('同一个分区只创建一次（不会重复注册 verify proc）', async () => {
    const { mod, partitions } = fakeElectronSession()
    const stack = createHttpStack({ session: mod })

    await stack.fetch('http://nas.local:5666/a')
    await stack.fetch('http://nas.local:5666/b')

    expect(partitions).toHaveLength(1)
  })

  it('新分区用 { cache: false } 创建', async () => {
    const { mod, partitions } = fakeElectronSession()
    const stack = createHttpStack({ session: mod })

    await stack.fetch('http://nas.local:5666/a')

    expect(partitions[0]?.options).toEqual({ cache: false })
  })
})

// ---------------------------------------------------------------------------
// verify proc：只放行用户填过的 host
// ---------------------------------------------------------------------------

describe('HttpStack 的证书放行策略', () => {
  it('受信 host 放行（回调 0）', async () => {
    const { mod, procs } = fakeElectronSession()
    const trusted = new TrustedHosts()
    trusted.add('https://nas.local:5666/music')
    const stack = createHttpStack({ session: mod, trusted })

    await stack.fetch('https://nas.local:5666/music/api/v1/health')

    const proc = procs.get('fn-nas-v0')
    expect(proc).toBeTypeOf('function')
    let result = -1
    proc!({ hostname: 'nas.local' }, (r) => {
      result = r
    })
    expect(result).toBe(VERIFY_ACCEPT)
    expect(result).toBe(0)
  })

  it('未受信 host 交回 Chromium 默认校验（回调 -3，绝不全局放行）', async () => {
    const { mod, procs } = fakeElectronSession()
    const trusted = new TrustedHosts()
    trusted.add('https://nas.local:5666/music')
    const stack = createHttpStack({ session: mod, trusted })

    await stack.fetch('https://nas.local:5666/music/api/v1/health')

    const proc = procs.get('fn-nas-v0')
    let result = 0
    proc!({ hostname: 'evil.example' }, (r) => {
      result = r
    })
    expect(result).toBe(VERIFY_REJECT)
    expect(result).toBe(-3)
  })

  it('verify proc 读的是同一个 trusted 实例：后加的 host 立刻生效', async () => {
    const { mod, procs } = fakeElectronSession()
    const trusted = new TrustedHosts()
    const stack = createHttpStack({ session: mod, trusted })

    await stack.fetch('https://nas.local:5666/music/api/v1/health')

    const proc = procs.get('fn-nas-v0')!
    let result = 0
    proc({ hostname: 'later.local' }, (r) => {
      result = r
    })
    expect(result).toBe(-3)

    trusted.add('later.local')
    proc({ hostname: 'later.local' }, (r) => {
      result = r
    })
    expect(result).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Electron 不可用时的回落（单测环境）
// ---------------------------------------------------------------------------

describe('HttpStack 在没有 Electron 运行时时的回落', () => {
  it('回落到注入的 fetchImpl，并把 (url, init) 原样传下去', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('fallback', { status: 200 }),
    )
    const stack = createHttpStack({ fetchImpl: fetchImpl as unknown as typeof fetch })

    const res = await stack.fetch('http://nas.local:5666/music/api/v1/health', {
      method: 'GET',
      headers: { authx: 'nonce=1' },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('fallback')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://nas.local:5666/music/api/v1/health')
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ method: 'GET', headers: { authx: 'nonce=1' } })
  })

  it('没有注入 fetchImpl 时回落到全局 fetch', async () => {
    const globalMock = vi.fn(async () => new Response('global', { status: 200 }))
    vi.stubGlobal('fetch', globalMock)
    const stack = createHttpStack()

    const res = await stack.fetch('http://nas.local:5666/x')

    expect(await res.text()).toBe('global')
    expect(globalMock).toHaveBeenCalledTimes(1)
  })

  it('Electron 可用时请求走分区 session，而不是全局 fetch', async () => {
    const { mod, fetches } = fakeElectronSession()
    const globalMock = vi.fn(async () => new Response('global', { status: 200 }))
    vi.stubGlobal('fetch', globalMock)
    const stack = createHttpStack({ session: mod })

    const res = await stack.fetch('http://nas.local:5666/x')

    expect(await res.text()).toBe('ok')
    expect(globalMock).not.toHaveBeenCalled()
    expect(fetches).toHaveLength(1)
    expect(fetches[0]?.partition).toBe('fn-nas-v0')
  })

  it('bumpTrustEpoch() 在没有 Electron 时也不报错（信任集合变化仍要能记账）', () => {
    const stack = createHttpStack()
    expect(() => stack.bumpTrustEpoch()).not.toThrow()
    expect(stack.partitionName()).toBe('fn-nas-v1')
  })
})

// ---------------------------------------------------------------------------
// T56：流式取上游（`net.request` 路径）
//
// ⚠️ 这一组钉的是 T56 的**核心根因**：
//    `session.fetch` 会把上游响应头塞进 undici 的 `Headers` ⇒ **ByteString 校验**
//    （每个字符 ≤ 255）；而 Chromium 按 **UTF-8** 解码响应头 ⇒ 上游一旦回带中文的
//    头（实测 NAS 转码产物的 `Content-Disposition: attachment; filename="占位曲目一 - 占位歌手二.mp3"`），
//    就抛 `TypeError` 且**抛在事件回调里** ⇒ 主进程未捕获异常 + 那个请求**永不返回**。
//    ⇒ 二进制路径改走 `net.request`：它的响应头是**普通字符串记录**。
// ---------------------------------------------------------------------------

/** 假 Electron `net` 模块：记录请求参数，回放一条可读流响应。 */
function fakeElectronNet(response: {
  statusCode: number
  headers: Record<string, string | string[]>
  body?: string
}): {
  net: ElectronNetLike
  calls: Array<{
    url: string
    method: string
    headers: Record<string, string>
    session: unknown
    written: string
  }>
} {
  const calls: Array<{
    url: string
    method: string
    headers: Record<string, string>
    session: unknown
    written: string
  }> = []

  const net: ElectronNetLike = {
    request(options) {
      const call = {
        url: options.url,
        method: options.method,
        headers: options.headers,
        session: options.session,
        written: '',
      }
      calls.push(call)
      const handlers = new Map<string, Array<(arg: never) => void>>()
      const req = {
        on(event: string, listener: (arg: never) => void) {
          const list = handlers.get(event) ?? []
          list.push(listener)
          handlers.set(event, list)
        },
        write(chunk: string) {
          call.written += chunk
        },
        end() {
          const res = Object.assign(Readable.from([Buffer.from(response.body ?? 'ok')]), {
            statusCode: response.statusCode,
            headers: response.headers,
          })
          for (const listener of handlers.get('response') ?? []) {
            ;(listener as unknown as (r: unknown) => void)(res)
          }
        },
      }
      return req as unknown as ElectronNetClientRequestLike
    },
  }
  return { net, calls }
}

/** 假 session 模块：额外把**创建出来的分区对象**记下来（用来核对 `net.request` 拿到的是它）。 */
function fakeSessionModule(): { mod: ElectronSessionLike; created: unknown[] } {
  const created: unknown[] = []
  const mod: ElectronSessionLike = {
    fromPartition() {
      const ses = {
        fetch: async () => new Response('ok', { status: 200 }),
        setCertificateVerifyProc() {
          // 本组用例不关心证书放行。
        },
      }
      created.push(ses)
      return ses
    },
  }
  return { mod, created }
}

describe('HttpStack 的流式取上游（T56：net.request 路径）', () => {
  it('Electron 可用时走 net.request，并带上当前分区 session（证书放行语义不变）', async () => {
    const { mod, created } = fakeSessionModule()
    const { net, calls } = fakeElectronNet({
      statusCode: 206,
      headers: { 'content-range': 'bytes 0-1/1024', 'content-type': 'audio/mpeg' },
    })
    const stack = createHttpStack({ session: mod, net })

    const upstream = await stack.stream!(
      new Request('https://nas.local:5667/music/api/v1/track/stream?guid=g1', {
        headers: { range: 'bytes=0-1', authx: 'nonce=1', cookie: 'music-token=TK' },
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://nas.local:5667/music/api/v1/track/stream?guid=g1')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers['range']).toBe('bytes=0-1')
    expect(calls[0]?.headers['authx']).toBe('nonce=1')
    expect(calls[0]?.headers['cookie']).toBe('music-token=TK')
    // ⚠️ **必须**是当前分区：否则自签 NAS 的证书放行会失效。
    expect(calls[0]?.session).toBe(created[0])

    expect(upstream.status).toBe(206)
    expect(upstream.headers['content-range']).toBe('bytes 0-1/1024')
    expect(upstream.headers['content-type']).toBe('audio/mpeg')
  })

  it('上游响应头含中文时**不抛错**，且头原样保留（T56 的核心回归）', async () => {
    const { mod } = fakeSessionModule()
    const disposition = 'attachment; filename="占位曲目一 - 占位歌手二.mp3"'
    const { net } = fakeElectronNet({
      statusCode: 206,
      headers: { 'content-disposition': disposition, 'content-type': 'audio/mpeg' },
    })
    const stack = createHttpStack({ session: mod, net })

    const upstream = await stack.stream!(new Request('https://nas.local/x'))

    expect(upstream.status).toBe(206)
    expect(upstream.headers['content-disposition']).toBe(disposition)
    // ⚠️ **鉴别力**：这个值里真的有码位 > 255 的字符（`占` = U+5360 = 21344）。
    //    走 undici 的 `Headers` 就会抛 ByteString 错 ⇒ 这里必须**不是** Headers。
    expect([...(upstream.headers['content-disposition'] ?? '')].some((c) => (c.codePointAt(0) ?? 0) > 255)).toBe(
      true,
    )
  })

  it('响应头是**普通记录**（键统一小写），不是 undici 的 Headers', async () => {
    const { mod } = fakeSessionModule()
    const { net } = fakeElectronNet({
      statusCode: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '3' },
    })
    const stack = createHttpStack({ session: mod, net })

    const upstream = await stack.stream!(new Request('https://nas.local/x'))

    expect(upstream.headers['content-type']).toBe('audio/mpeg')
    expect(upstream.headers['content-length']).toBe('3')
    expect(upstream.headers instanceof Headers).toBe(false)
  })

  it('请求体被原样写给上游（POST）', async () => {
    const { mod } = fakeSessionModule()
    const { net, calls } = fakeElectronNet({ statusCode: 200, headers: {} })
    const stack = createHttpStack({ session: mod, net })

    await stack.stream!(
      new Request('https://nas.local/x', { method: 'POST', body: '{"trackGUID":"g1"}' }),
    )

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.written).toBe('{"trackGUID":"g1"}')
  })

  it('拿不到 net 模块时回落到 fetch（而不是崩）', async () => {
    const { mod } = fakeSessionModule()
    const globalMock = vi.fn(async () => new Response('fallback', { status: 200 }))
    vi.stubGlobal('fetch', globalMock)
    const stack = createHttpStack({ session: mod })

    const upstream = await stack.stream!(new Request('http://nas.local/x'))

    expect(globalMock).toHaveBeenCalledTimes(1)
    expect(upstream.status).toBe(200)
    expect(await new Response(upstream.body).text()).toBe('fallback')
  })

  it('没有 Electron 时回落到全局 fetch（单测环境，行为与改前一致）', async () => {
    const globalMock = vi.fn(
      async () => new Response('global', { status: 200, headers: { 'x-a': 'b' } }),
    )
    vi.stubGlobal('fetch', globalMock)
    const stack = createHttpStack()

    const upstream = await stack.stream!(new Request('http://nas.local/x'))

    expect(globalMock).toHaveBeenCalledTimes(1)
    expect(upstream.status).toBe(200)
    expect(upstream.headers['x-a']).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// TrustedHosts.add() 的返回值语义（追加要求 C）
// ---------------------------------------------------------------------------

describe('TrustedHosts.add() 的返回值', () => {
  it('新增一个 host 时返回 true', () => {
    const trusted = new TrustedHosts()
    expect(trusted.add('https://nas.local:5666/music')).toBe(true)
  })

  it('重复登记同一个 host 时返回 false（集合没变）', () => {
    const trusted = new TrustedHosts()
    trusted.add('https://nas.local:5666/music')
    expect(trusted.add('nas.local')).toBe(false)
    expect(trusted.add('NAS.local:8443')).toBe(false)
  })

  it('解析不出 host 的输入返回 false，且不进集合', () => {
    const trusted = new TrustedHosts()
    expect(trusted.add('')).toBe(false)
    expect(trusted.add('   ')).toBe(false)
    expect(trusted.verify('')).toBe(-3)
  })

  it('登记后 verify 放行，其它 host 仍然是 -3', () => {
    const trusted = new TrustedHosts()
    trusted.add('https://nas.local:5666/music')
    expect(trusted.verify('nas.local')).toBe(0)
    expect(trusted.verify('evil.example')).toBe(-3)
  })
})
