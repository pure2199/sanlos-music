// ---------------------------------------------------------------------------
// T126：MP4 / M4A 的 `moov` **读不全 / 在文件尾** ⇒ 内嵌歌词（`©lyr`）读不到
// ---------------------------------------------------------------------------
//
// 背景（**真机实测**，2026-11-20，本机 ＋ FN 中继 ＋ 真实 NAS，**只读 GET**）：
// - 服务端**支持尾读**：`Range: bytes=-65536` ⇒ **206** ＋
//   `content-range: bytes 43314305-43379840/43379841`（**确实是文件尾**），
//   `accept-ranges: bytes`，`bytes=0-0` 还能拿到**总长度**；
// - ⚠ 这台 NAS 的 **14 首 m4a 全部是 faststart**（`moov` 在**文件头**），
//   且 `ilst` 都在**头 64 KB 内** ⇒ 现有流式层**已经能解析**；
//   同时 **14/14 都没有 `©lyr`**。
//
// ⇒ 真正的缺口是「**头读窗口不够**」的两种：
//   - **G1**：`moov` 在**文件尾**（ffmpeg 默认产物）⇒ 头里**根本没有** `moov`；
//   - **G2**：`moov` 在头但**超过 64 KB 窗口**（实测那首的 `moov` 有 **212 KB**）
//     ⇒ `udta/ilst` 落在窗口外。
//
// 本文件钉五件事：
// ① 尾段里能定位 `moov`（含「完整 / 被截断」两种）；
// ② 头里能定位 `moov` 的**绝对偏移 + 大小**（供「续读」用）；
// ③ **对照组**：尾段里没有 `moov` / 有个**假的** `moov` 签名 ⇒ 不许当成真的；
// ④ 流式层：G1（尾读）能拿到歌词；
// ⑤ 流式层：G2（按绝对偏移续读）能拿到歌词；
// ⑥ **非 MP4 不补读**（不白花请求）。
//
// ⚠ 测试数据**全部是合成字节流**（仓库里**没有**二进制样本文件）——
//    真机上这台 NAS **没有**「moov 在尾」的 m4a ⇒ 机制用合成样本证，**如实标注**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'

import {
  findMp4AtomInBuffer,
  findMp4MoovInTail,
  isMp4Container,
  parseMp4MoovContent,
} from '../electron/audioTags'
import { readEmbeddedLyric } from '../electron/embeddedLyric'

// ---------------------------------------------------------------------------
// 合成 MP4 字节流
// ---------------------------------------------------------------------------

/** 造一个 MP4 原子（`size` + `type` + 载荷）。 */
function atom(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

/**
 * 造一个 iTunes 标签条目（`©nam` / `©lyr`）。
 *
 * ⚠ `data` 原子的载荷前有 **8 字节**（4 字节类型指示 ＋ 4 字节 locale）—— 真文件核对过。
 */
function ilstItem(code: string, text: string): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from(text, 'utf8'),
  ])
  return atom(code, atom('data', body))
}

/** 造 `moov → udta → meta → ilst`。 */
function buildUdta(title: string, lyrics: string | null): Buffer {
  const items = [ilstItem('©nam', title)]
  if (lyrics !== null) items.push(ilstItem('©lyr', lyrics))
  const meta = atom('meta', Buffer.concat([Buffer.from([0, 0, 0, 0]), atom('hdlr', Buffer.alloc(12)), atom('ilst', Buffer.concat(items))]))
  return atom('udta', meta)
}

/** 造 `moov → mvhd`（v0：timescale 在 +12、duration 在 +16）。 */
function buildMvhd(durationSec = 100): Buffer {
  const payload = Buffer.alloc(100)
  payload.writeUInt8(0, 0)
  payload.writeUInt32BE(1000, 12)
  payload.writeUInt32BE(durationSec * 1000, 16)
  return atom('mvhd', payload)
}

/** 造 `ftyp`。 */
function buildFtyp(): Buffer {
  return atom('ftyp', Buffer.concat([Buffer.from('M4A '), Buffer.from([0, 0, 0, 0]), Buffer.from('M4A isom')]))
}

/**
 * 造一个 **`moov` 在文件尾**的 MP4（G1）。
 *
 * @param mdatBytes `mdat` 载荷长度（模拟音频数据）。
 * @param lyrics 内嵌歌词；`null` = 不放 `©lyr`。
 */
function buildMp4TailMoov(mdatBytes: number, lyrics: string | null, title = '尾读样本'): Buffer {
  const mdat = atom('mdat', Buffer.alloc(mdatBytes, 0x5a))
  const moov = atom('moov', Buffer.concat([buildMvhd(), atom('trak', Buffer.alloc(64)), buildUdta(title, lyrics)]))
  return Buffer.concat([buildFtyp(), mdat, moov])
}

/**
 * 造一个 **`moov` 在头、但 `ilst` 在 64 KB 窗口之外**的 MP4（G2）。
 *
 * @param fillerBytes `trak` 的填充长度（把 `udta` 推到窗口外）。
 */
function buildMp4BigMoov(fillerBytes: number, lyrics: string | null, title = '续读样本'): Buffer {
  const trak = atom('trak', Buffer.alloc(fillerBytes, 0x11))
  const moov = atom('moov', Buffer.concat([buildMvhd(), trak, buildUdta(title, lyrics)]))
  return Buffer.concat([buildFtyp(), moov, atom('mdat', Buffer.alloc(1024, 0x5a))])
}

// ---------------------------------------------------------------------------
// 钉子
// ---------------------------------------------------------------------------

describe('T126 MP4 尾读 / 续读', () => {
  it('① 尾段里能定位 moov（完整时内容齐全）', () => {
    const file = buildMp4TailMoov(4096, '[00:01.00]尾读拿到的歌词')
    const tail = file.subarray(file.length - 8192)
    const found = findMp4MoovInTail(tail)
    expect(found).not.toBeNull()
    expect(found?.complete).toBe(true)
    expect(found?.atomSize).toBeGreaterThan(0)
    const tags = parseMp4MoovContent(found?.content ?? Buffer.alloc(0))
    expect(tags.lyrics).toBe('[00:01.00]尾读拿到的歌词')
    expect(tags.title).toBe('尾读样本')
  })

  it('② 头里能定位 moov 的绝对偏移与大小（供续读用）', () => {
    const file = buildMp4BigMoov(70 * 1024, '[00:02.00]续读拿到的歌词')
    const head = file.subarray(0, 64 * 1024)
    expect(isMp4Container(head)).toBe(true)
    const moov = findMp4AtomInBuffer(head, 'moov')
    expect(moov).not.toBeNull()
    // 绝对偏移（头从文件 0 开始 ⇒ 缓冲偏移就是文件偏移）。
    expect(moov?.contentOffset).toBe(file.indexOf(Buffer.from('moov', 'latin1')) + 4)
    // 内容比 64 KB 窗口大 ⇒ 头里装不下。
    expect((moov?.contentOffset ?? 0) + (moov?.contentSize ?? 0)).toBeGreaterThan(head.length)
  })

  it('③ 对照组：没有 moov / 假 moov 签名都不许当成真的', () => {
    // ③-a 尾段里根本没有 moov。
    const noMoov = Buffer.concat([buildFtyp(), atom('mdat', Buffer.alloc(4096, 0x5a))])
    const tail = noMoov.subarray(noMoov.length - 2048)
    expect(findMp4MoovInTail(tail)).toBeNull()

    // ③-b 尾段里有个 'moov' 字样，但它**不是原子头**（前面的 size 离谱）⇒ 不许当成完整原子。
    const fake = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x02]), // 声称只有 2 字节 ⇒ 比头还小 ⇒ 非法
      Buffer.from('moov', 'latin1'),
      Buffer.alloc(64, 0x11),
    ])
    const found = findMp4MoovInTail(fake)
    expect(found?.complete ?? false).toBe(false)
  })

  it('④ 流式层：moov 在文件尾 ⇒ 尾读一次就能拿到歌词', async () => {
    // ⚠ `mdat` 要**大于 64 KB 头窗口** ⇒ 头里**只有** ftyp + mdat 的一部分 ⇒ 没有 moov。
    const file = buildMp4TailMoov(100 * 1024, '[00:03.00]流式尾读')
    const head = file.subarray(0, 64 * 1024)
    const fetchStreamRange = vi.fn(async (_guid: string, start: number, length: number) => {
      // 负数起点 = 尾读。
      const from = start < 0 ? file.length + start : start
      return { bytes: file.subarray(from, Math.min(file.length, from + length)), totalSize: file.length }
    })

    const result = await readEmbeddedLyric('0123456789abcdef0123456789abcdef', {
      resolveTrackPath: () => null,
      fetchStreamHead: async () => head,
      fetchStreamRange,
    })

    expect(result.content).toBe('[00:03.00]流式尾读')
    expect(result.layer).toBe('stream')
    expect(fetchStreamRange).toHaveBeenCalledTimes(1)
  })

  it('⑤ 流式层：moov 在头但超出窗口 ⇒ 按绝对偏移续读一次', async () => {
    const file = buildMp4BigMoov(70 * 1024, '[00:04.00]流式续读')
    const head = file.subarray(0, 64 * 1024)
    const fetchStreamRange = vi.fn(async (_guid: string, start: number, length: number) => {
      return { bytes: file.subarray(start, Math.min(file.length, start + length)), totalSize: file.length }
    })

    const result = await readEmbeddedLyric('0123456789abcdef0123456789abcdef', {
      resolveTrackPath: () => null,
      fetchStreamHead: async () => head,
      fetchStreamRange,
    })

    expect(result.content).toBe('[00:04.00]流式续读')
    expect(result.layer).toBe('stream')
    // 只发**一次**续读（不是从头到尾乱翻）。
    expect(fetchStreamRange).toHaveBeenCalledTimes(1)
  })

  it('⑥ 非 MP4（MP3 流）⇒ 不补读（不白花请求）', async () => {
    // 一个假的 MP3 头（`ID3` + 同步字）。
    const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(61, 0x11), Buffer.from([0xff, 0xfb])])
    const fetchStreamRange = vi.fn(async () => ({ bytes: Buffer.alloc(0), totalSize: mp3.length }))

    const result = await readEmbeddedLyric('0123456789abcdef0123456789abcdef', {
      resolveTrackPath: () => null,
      fetchStreamHead: async () => mp3,
      fetchStreamRange,
    })

    expect(result.content).toBe('')
    expect(result.layer).toBe('none')
    expect(fetchStreamRange).not.toHaveBeenCalled()
  })
})
