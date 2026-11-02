import { describe, it, expect, vi, afterEach } from 'vitest'

import { createHttpStack, type ElectronSessionLike } from '../electron/http'
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
