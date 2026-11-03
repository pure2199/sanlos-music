// ---------------------------------------------------------------------------
// T11 本地媒体协议 `fnml://`（主进程）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **地址解析**：只有 host `local` + 恰好两段（`track` + guid）才合法；
// - **Range 解析**：`bytes=0-99` / `bytes=100-` / `bytes=-100`；
// - **响应**：整份 200、分段 206（带 `Content-Range`）、没下过 404、地址非法 400；
// - **路径穿越**：guid **只当索引键**，主进程**从不**用它拼路径。
//
// ⚠️ 文件读取**用内存替身**（不碰真实磁盘）。

import { describe, it, expect, vi } from 'vitest'

import {
  handleLocalMediaRequest,
  localMediaUrl,
  mimeTypeForPath,
  parseLocalMediaTarget,
  parseRangeHeader,
  type LocalMediaDeps,
} from '../electron/localMedia'

const SONG_ID = 'track_example01'

/** 内存里的一个「本地文件」。 */
function memoryFile(bytes: Uint8Array): {
  deps: LocalMediaDeps
  paths: string[]
} {
  const filePath = 'C:\\Music\\飞牛音乐\\示例歌手 - 示例歌名.flac'
  const paths: string[] = []
  const deps: LocalMediaDeps = {
    lookup: (songId: string) => {
      paths.push(songId)
      return songId === SONG_ID ? filePath : null
    },
    statSize: async (path: string) => (path === filePath ? bytes.byteLength : null),
    readRange: async (_path: string, start: number, end: number) =>
      bytes.slice(start, end + 1),
  }
  return { deps, paths }
}

// ---------------------------------------------------------------------------
// 地址解析
// ---------------------------------------------------------------------------

describe('本地媒体：地址解析', () => {
  it('构造的地址能被自己解析回来', () => {
    const url = localMediaUrl(SONG_ID)
    expect(url).toBe(`fnml://local/track/${SONG_ID}`)
    expect(parseLocalMediaTarget(url)).toBe(SONG_ID)
  })

  it('guid 里的特殊字符被编码后仍能还原', () => {
    const id = 'track a/b?c'
    expect(parseLocalMediaTarget(localMediaUrl(id))).toBe(id)
  })

  it('主机名不对 / 路径段数不对 / scheme 不对 → 一律拒绝', () => {
    expect(parseLocalMediaTarget('fnml://evil/track/x')).toBeNull()
    expect(parseLocalMediaTarget('fnml://local/track')).toBeNull()
    expect(parseLocalMediaTarget('fnml://local/track/a/b')).toBeNull()
    expect(parseLocalMediaTarget('fnml://local/other/x')).toBeNull()
    expect(parseLocalMediaTarget('http://local/track/x')).toBeNull()
    expect(parseLocalMediaTarget('fnml://local/track/')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

describe('本地媒体：Range 解析', () => {
  it('闭区间', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
  })

  it('省略结尾 → 到文件末尾', () => {
    expect(parseRangeHeader('bytes=100-', 1000)).toEqual({ start: 100, end: 999 })
  })

  it('后缀式（最后 N 字节）', () => {
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('不合法 / 没有 Range → null（按整份返回）', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull()
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=200-100', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=2000-', 1000)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

describe('本地媒体：MIME 判定', () => {
  it('按扩展名给类型', () => {
    expect(mimeTypeForPath('a.flac')).toBe('audio/flac')
    expect(mimeTypeForPath('a.MP3')).toBe('audio/mpeg')
  })

  it('认不出来的一律 octet-stream', () => {
    expect(mimeTypeForPath('a.bin')).toBe('application/octet-stream')
    expect(mimeTypeForPath('a')).toBe('application/octet-stream')
  })
})

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

describe('本地媒体：响应', () => {
  it('整份返回 200（带 content-length 与 accept-ranges）', async () => {
    const { deps } = memoryFile(new Uint8Array([1, 2, 3, 4, 5]))
    const response = await handleLocalMediaRequest(new Request(localMediaUrl(SONG_ID)), deps)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('5')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-type')).toBe('audio/flac')
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(5)
  })

  it('带 Range → 206（带 content-range，且只回那一段）', async () => {
    const { deps } = memoryFile(new Uint8Array([1, 2, 3, 4, 5]))
    const request = new Request(localMediaUrl(SONG_ID), { headers: { range: 'bytes=1-3' } })
    const response = await handleLocalMediaRequest(request, deps)

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(response.headers.get('content-length')).toBe('3')
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(3)
  })

  it('本地没有这首歌 → 404', async () => {
    const { deps } = memoryFile(new Uint8Array([1]))
    const response = await handleLocalMediaRequest(new Request(localMediaUrl('track_other')), deps)
    expect(response.status).toBe(404)
  })

  it('地址非法 → 400', async () => {
    const { deps } = memoryFile(new Uint8Array([1]))
    const response = await handleLocalMediaRequest(new Request('fnml://evil/track/x'), deps)
    expect(response.status).toBe(400)
  })

  it('文件不存在（索引有记录但磁盘上没了）→ 404', async () => {
    const deps: LocalMediaDeps = {
      lookup: () => 'C:\\Music\\飞牛音乐\\不存在.flac',
      statSize: async () => null,
      readRange: async () => new Uint8Array(0),
    }
    const response = await handleLocalMediaRequest(new Request(localMediaUrl(SONG_ID)), deps)
    expect(response.status).toBe(404)
  })

  it('路径穿越：guid 只当**索引键**，主进程从不拿它拼路径', async () => {
    const { deps, paths } = memoryFile(new Uint8Array([1]))
    const evil = '../../secret'
    const response = await handleLocalMediaRequest(new Request(localMediaUrl(evil)), deps)

    // 查索引用的就是原始 guid（**原样**），拼路径的活儿根本不归它管。
    expect(paths).toEqual([evil])
    // 索引里没有这一条 → 404（不是去读文件）。
    expect(response.status).toBe(404)
  })

  it('lookup 没被调用过就 404（不做任何猜测）', async () => {
    const lookup = vi.fn(() => null)
    const deps: LocalMediaDeps = {
      lookup,
      statSize: async () => 1,
      readRange: async () => new Uint8Array(1),
    }
    const response = await handleLocalMediaRequest(new Request(localMediaUrl(SONG_ID)), deps)
    expect(response.status).toBe(404)
    expect(lookup).toHaveBeenCalledWith(SONG_ID)
  })
})
