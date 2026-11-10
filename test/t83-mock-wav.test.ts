// ---------------------------------------------------------------------------
// T83：mock 夹具的「带 ID3 块的 WAV」必须**符合 RIFF 规范**
// ---------------------------------------------------------------------------
//
// ⚠️ **这条测试是踩过坑之后加的**：
//    夹具原先把 `ID3 ` 块**直接**塞进 `fmt ` 与 `data` 之间，且**没有**按 RIFF
//    规范给**奇数长度**的块补齐字节 ⇒ 按规范走块结构的解析器会**错位一字节**
//    ⇒ 读到的下一个块 id 变成 `ata.`（而不是 `data`）
//    ⇒ Chromium 直接报「当前内核不支持该格式」⇒ E2E 里那首歌**根本放不出来**。
//
// ⚠️ 这里走**真实 HTTP 路径**（起 mock → 登录 → 取流）⇒ 钉的是
//    「服务端真发出去的那份字节」，而不是某个内部函数的返回值。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { EMBEDDED_LYRIC_LRC, EMBEDDED_LYRIC_SONG_GUID } from '../mock-server/fixtures'
import { readTagsFromReader } from '../electron/audioTags'
import { fetchMockStream, loginMock, startMock, walkRiff } from './helpers/audio-fixtures'

describe('T83 mock 夹具：带 ID3 块的 WAV', () => {
  it('块顺序是 fmt → ID3 → data（补齐字节必须对，否则解析器认不出 data）', async () => {
    const mock = startMock()
    try {
      const token = await loginMock(mock)
      // ⚠️ 取**整段**（不是 Range 切片）⇒ RIFF 头里的总长字段才有得比。
      const wav = await fetchMockStream(mock, token, EMBEDDED_LYRIC_SONG_GUID)

      // ⚠️ RIFF 头：'RIFF' + 总长（= 文件长度 - 8）+ 'WAVE'。
      expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
      expect(wav.subarray(8, 12).toString('latin1')).toBe('WAVE')
      expect(wav.readUInt32LE(4)).toBe(wav.length - 8)

      // ⚠️ **按规范走** ⇒ `data` 必须能被认出来（补齐字节错了这里就会断链）。
      const ids = walkRiff(wav).map((chunk) => chunk.id)
      expect(ids).toContain('fmt ')
      expect(ids).toContain('ID3 ')
      expect(ids).toContain('data')
      // `ID3 ` 必须排在 `data` **前面** ⇒ 只读文件头 64 KB 就能拿到它。
      expect(ids.indexOf('ID3 ')).toBeLessThan(ids.indexOf('data'))
    } finally {
      await mock.close()
    }
  })

  it('ID3 块里的 USLT ⇒ 能解析出内嵌歌词', async () => {
    const mock = startMock()
    try {
      const token = await loginMock(mock)
      const wav = await fetchMockStream(mock, token, EMBEDDED_LYRIC_SONG_GUID)

      const reader = {
        size: wav.length,
        read: async (offset: number, length: number): Promise<Buffer> =>
          wav.subarray(Math.max(0, offset), Math.min(offset + length, wav.length)),
      }
      const tags = await readTagsFromReader(reader)
      expect(tags?.lyrics).toBe(EMBEDDED_LYRIC_LRC)
    } finally {
      await mock.close()
    }
  })

  it('对照组：没有 ID3 块的歌 ⇒ 块链是 fmt → data', async () => {
    const mock = startMock()
    try {
      const token = await loginMock(mock)
      const wav = await fetchMockStream(mock, token, 't1')
      const ids = walkRiff(wav).map((chunk) => chunk.id)
      expect(ids).toContain('fmt ')
      expect(ids).toContain('data')
      expect(ids).not.toContain('ID3 ')
    } finally {
      await mock.close()
    }
  })
})
