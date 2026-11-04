// ---------------------------------------------------------------------------
// T20：`fnm://` 代理 × 真实 mock 的 Range / 206 端到端
// ---------------------------------------------------------------------------
//
// ⚠️ 为什么这一组**不能**省（审计 P3-9 的真正含义）：
//    代理层的 Range 透传与「206 原样带回」在 `test/proxy.test.ts` 里已经用
//    **假上游**测过了（上游是手搓的 `Response`）——但那是「代理对着自己编的东西」，
//    **从来没有真的打过一个会分段应答的服务器**。
//    这一组让代理**真的**打 mock server：
//      渲染进程的 `fnm://` 请求（带 Range）
//        → 代理构造上游请求（Range 头透传 + 签名 + Cookie）
//          → 真实 HTTP 打到 mock（mock 真的按 Range 分段应答 206）
//            → 代理把 206 / content-range / accept-ranges 原样带回
//              → **body 的字节真的等于整段音频对应的切片**
//
// ⚠️ 最后那一步是这条用例的**鉴别力所在**：只断言「状态码是 206」的话，
//    代理把**整段**音频原样透传（206 + 错的 body）也能绿——
//    那样「拖动定位」会静默拿到错误数据。字节比对抓的就是这个。
//
// ⚠️ 为什么**不**在浏览器里验这段（分层理由）：
//    mock 的音频是 WAV，WAV 从中间字节开始返回时**没有文件头**，
//    Chromium 的 WAV 解码器解不了 → 浏览器层面的「拖动定位」验证
//    改由 `e2e/smoke.spec.ts` 用 `currentTime` setter 劫持做（验客户端契约），
//    「上游到底支不支持 Range」由真机探针 `tools/fn-range-probe.mjs` 回答。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { registerProxy, type ProtocolLike } from '../electron/proxy'
import { SessionManager, type SessionState } from '../electron/session'
import { createMockServer, type MockServer } from '../mock-server/server'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 假 protocol：记录注册上来的 handler，直接调用它即可模拟渲染进程的一次请求。 */
function fakeProtocol(): { proto: ProtocolLike; call: (request: Request) => Promise<Response> } {
  let handler: ((request: Request) => Promise<Response> | Response) | null = null
  const proto: ProtocolLike = {
    handle(scheme: string, h: (request: Request) => Promise<Response> | Response) {
      if (scheme === 'fnm') handler = h
    },
    registerSchemesAsPrivileged() {
      // 本组用例不关心 scheme 特权。
    },
  }
  return {
    proto,
    call: (request: Request) => {
      if (!handler) throw new Error('协议 handler 未注册')
      return Promise.resolve(handler(request))
    },
  }
}

/** 登录 mock，拿回一个**真的**有效 token。 */
async function loginMock(s: MockServer): Promise<string> {
  const r = await fetch(`${s.url}/music/api/v1/user/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'x', deviceId: 'd' }),
  })
  const body = (await r.json()) as { code: number; data?: { userToken?: string } }
  const token = body.data?.userToken
  if (body.code !== 0 || !token) throw new Error('mock 登录失败')
  return token
}

/** 造一个指向 mock 的真会话（base 指向 mock 的 `/music` 挂载点）。 */
function sessionFor(s: MockServer, token: string): SessionManager {
  const state: SessionState = {
    base: `${s.url}/music`,
    mode: 'password',
    token,
    deviceId: 'DEVICE',
    username: 'demo',
    password: 'x',
    isRelay: false,
  }
  return { state, request: async () => ({ status: 200, json: { code: 0 } }), relogin: async () => true } as unknown as SessionManager
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('fnm:// 代理 × 真实 mock：Range / 206 端到端', () => {
  it('带 Range → 上游 206，content-range 原样带回，**body 字节就是对应的切片**', async () => {
    const mock = createMockServer()
    const token = await loginMock(mock)
    const fake = fakeProtocol()
    registerProxy(sessionFor(mock, token), { protocol: fake.proto })

    // 基准：整段音频（直接打 mock，绕过代理）。
    const wholeRes = await fetch(`${mock.url}/music/api/v1/track/stream?guid=t1`, {
      headers: { cookie: `music-token=${token}` },
    })
    const whole = Buffer.from(await wholeRes.arrayBuffer())
    expect(whole.length).toBeGreaterThan(1000)

    // 走代理：渲染进程发起带 Range 的 `fnm://` 请求。
    const res = await fake.call(
      new Request('fnm://srv/track/stream?guid=t1', { headers: { range: 'bytes=1000-1999' } }),
    )

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 1000-1999/${whole.length}`)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('1000')

    // ⚠️ **鉴别力**：body 必须是**那一段**字节，不能是整段（代理把整段透传也能骗过状态码断言）。
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length).toBe(1000)
    expect(body.equals(whole.subarray(1000, 2000))).toBe(true)
    // ⚠️ 并且**确实不是**整段（防「代理忽略了 Range 头」这种退化）。
    expect(body.equals(whole)).toBe(false)

    mock.close()
  })

  it('不带 Range → 上游 200 整段，accept-ranges 也要带回', async () => {
    const mock = createMockServer()
    const token = await loginMock(mock)
    const fake = fakeProtocol()
    registerProxy(sessionFor(mock, token), { protocol: fake.proto })

    const res = await fake.call(new Request('fnm://srv/track/stream?guid=t1'))

    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length).toBeGreaterThan(1000)
    expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF')

    mock.close()
  })

  it('上游 416（Range 越界）→ 状态码与 content-range 原样带回', async () => {
    const mock = createMockServer()
    const token = await loginMock(mock)
    const fake = fakeProtocol()
    registerProxy(sessionFor(mock, token), { protocol: fake.proto })

    const wholeRes = await fetch(`${mock.url}/music/api/v1/track/stream?guid=t1`, {
      headers: { cookie: `music-token=${token}` },
    })
    const whole = Buffer.from(await wholeRes.arrayBuffer())

    const res = await fake.call(
      new Request('fnm://srv/track/stream?guid=t1', {
        headers: { range: `bytes=${whole.length + 10}-` },
      }),
    )

    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${whole.length}`)
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(0)

    mock.close()
  })
})
