// ---------------------------------------------------------------------------
// 单测用的**夹具工具**（不是测试文件本身）
// ---------------------------------------------------------------------------
//
// ⚠️ 这个文件**不在** vitest 的 `include` 里（只收 `*.test.ts` / `*.spec.ts`）
//    ⇒ 它只是被别的测试 import 的工具。
//
// 提供的都是**真东西**，不是照抄的算法：
// - mock 的登录 / 取流（走**真实 HTTP**）；
// - RIFF 块结构走查（按**规范**补齐奇数长度的块）。
// ---------------------------------------------------------------------------

import { createMockServer, type MockServer } from '../../mock-server/server'

/** mock 的接口基址。 */
export const MOCK_API = '/music/api/v1'

/** 起一个 mock server（测试自己负责 `close()`）。 */
export function startMock(): MockServer {
  return createMockServer()
}

/** 登录并取 token（mock 的口令就是明文 `x`）。 */
export async function loginMock(server: MockServer, password = 'x'): Promise<string> {
  const r = await fetch(`${server.url}${MOCK_API}/user/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password, deviceId: 'd' }),
  })
  const body = (await r.json()) as { code: number; data?: { userToken?: string } }
  const token = body.data?.userToken
  if (body.code !== 0 || !token) throw new Error('mock 登录失败')
  return token
}

/**
 * 取音频流。
 *
 * @param server mock server。
 * @param token 登录拿到的 token。
 * @param guid 曲目 guid。
 * @param headBytes 只要**前这么多字节**（省略 ⇒ 整段）。
 */
export async function fetchMockStream(
  server: MockServer,
  token: string,
  guid: string,
  headBytes?: number,
): Promise<Buffer> {
  const headers: Record<string, string> = { cookie: `music-token=${token}` }
  if (typeof headBytes === 'number' && headBytes > 0) {
    headers['range'] = `bytes=0-${headBytes - 1}`
  }
  const r = await fetch(`${server.url}${MOCK_API}/track/stream?guid=${guid}`, { headers })
  if (!r.ok) throw new Error(`取流失败：HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

/** 一个 RIFF 块。 */
export interface RiffChunk {
  /** 块标识（4 字节 ASCII）。 */
  id: string
  /** 块数据长度。 */
  size: number
  /** 块数据的起始偏移。 */
  dataOffset: number
}

/**
 * 按 **RIFF 规范**走一遍块结构。
 *
 * ⚠️ **奇数长度的块后面要跟一个补齐字节**（不计入块大小）——
 *    漏掉它 ⇒ 整条块链错位 ⇒ 后面的块**再也认不出来**
 *    （实测：Chromium 因此报「当前内核不支持该格式」）。
 */
export function walkRiff(buffer: Buffer): RiffChunk[] {
  const chunks: RiffChunk[] = []
  let offset = 12
  while (offset + 8 <= buffer.length && chunks.length < 32) {
    const id = buffer.subarray(offset, offset + 4).toString('latin1')
    const size = buffer.readUInt32LE(offset + 4)
    chunks.push({ id, size, dataOffset: offset + 8 })
    const next = offset + 8 + size + (size % 2)
    if (next <= offset) break
    offset = next
  }
  return chunks
}
