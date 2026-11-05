// ---------------------------------------------------------------------------
// T39 音频标签解析（主进程，纯函数）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **ID3v2.2 / 2.3 / 2.4**：文本帧（`TIT2` / `TPE1` / `TALB`）、UTF-8 与
//   UTF-16(BOM) 两种编码、整段 unsynchronisation（**放弃但仍给标签长度**）；
// - **mp3 时长**：`Xing` / `Info` 帧计数（精确）与 CBR 估算（近似）两条路径；
// - **FLAC**：`STREAMINFO`（精确时长）+ `VORBIS_COMMENT`；`PICTURE` 块很大时
//   要能**续读**再找到注释块；
// - **Ogg**（Vorbis / Opus）：识别头 + 注释头 + **末页 granule** 时长；
// - **合并规则**：标签优先、文件名兜底、`tagSource` 的判定；
// - **坏输入**：不抛、返回 `null` / 空标签。
//
// ⚠️ **不放二进制样本文件**：全部用代码**构造**字节流 → 仓库里没有二进制，
//    断言也写得出「为什么是这个值」。
// ⚠️ 测试数据一律用占位值（`示例歌名`），不写真实歌名 / 路径。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import {
  id3TagSize,
  isFlacMagic,
  isId3Magic,
  isOggMagic,
  lastOggGranule,
  mergeTrackTags,
  parseId3v2,
  parseMpegFrameHeader,
  parseOggTags,
  parseVorbisCommentBlock,
  readFileTags,
  readTagsFromReader,
  type TagFileSystem,
  type TagReader,
} from '../electron/audioTags'

// ---------------------------------------------------------------------------
// 造字节的工具
// ---------------------------------------------------------------------------

/** 4 字节「同步安全」整数（ID3 用）。 */
function synchsafe(value: number): Buffer {
  const out = Buffer.alloc(4)
  out[0] = (value >>> 21) & 0x7f
  out[1] = (value >>> 14) & 0x7f
  out[2] = (value >>> 7) & 0x7f
  out[3] = value & 0x7f
  return out
}

/** 4 字节大端整数。 */
function uint32BE(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value, 0)
  return out
}

/** 4 字节小端整数。 */
function uint32LE(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value, 0)
  return out
}

/** 3 字节大端整数（FLAC 块长度用）。 */
function uint24BE(value: number): Buffer {
  const out = Buffer.alloc(3)
  out[0] = (value >>> 16) & 0xff
  out[1] = (value >>> 8) & 0xff
  out[2] = value & 0xff
  return out
}

/**
 * 造一个 ID3v2 文本帧。
 *
 * @param id 帧 ID（v2.2 传 3 个字符，其余 4 个）。
 * @param text 文本。
 * @param major 主版本号（2 / 3 / 4）。
 * @param encoding 编码字节（`0` = latin1，`1` = UTF-16 带 BOM，`3` = UTF-8）。
 */
function id3TextFrame(id: string, text: string, major: number, encoding = 3): Buffer {
  let payload: Buffer
  if (encoding === 1) {
    payload = Buffer.concat([
      Buffer.from([0x01, 0xff, 0xfe]),
      Buffer.from(text, 'utf16le'),
    ])
  } else {
    payload = Buffer.concat([Buffer.from([encoding]), Buffer.from(text, 'utf8')])
  }
  if (major === 2) {
    return Buffer.concat([
      Buffer.from(id.slice(0, 3), 'latin1'),
      uint24BE(payload.length),
      payload,
    ])
  }
  const size = major === 4 ? synchsafe(payload.length) : uint32BE(payload.length)
  return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), payload])
}

/** 造一个完整的 ID3 标签。 */
function id3Tag(frames: Buffer[], major: number, flags = 0): Buffer {
  const body = Buffer.concat(frames)
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([major, 0, flags]),
    synchsafe(body.length),
    body,
  ])
}

/**
 * 造一个 MPEG-1 Layer III 音频帧（128 kbps / 44.1 kHz / 立体声）。
 *
 * @param xingFrames `Xing` 头里的帧数；`0` = 不放 `Xing` 头（走 CBR 估算）。
 */
function mpegFrame(xingFrames: number): Buffer {
  const frame = Buffer.alloc(417)
  frame[0] = 0xff
  frame[1] = 0xfb // MPEG1 / Layer III / 无 CRC
  frame[2] = 0x90 // 128 kbps / 44.1 kHz
  frame[3] = 0x00 // 立体声
  if (xingFrames > 0) {
    // ⚠️ `Xing` 头的位置 = 帧头（4 字节）+ 边信息（MPEG1 立体声 32 字节）。
    frame.write('Xing', 36, 'latin1')
    frame.writeUInt32BE(0x0001, 40) // 只有帧数字段
    frame.writeUInt32BE(xingFrames, 44)
  }
  return frame
}

/** 造 Vorbis 注释块本体（vendor + 注释列表）。 */
function vorbisCommentBody(comments: Record<string, string>): Buffer {
  const vendor = Buffer.from('测试标签器', 'utf8')
  const entries = Object.entries(comments).map(([key, value]) =>
    Buffer.from(`${key}=${value}`, 'utf8'),
  )
  return Buffer.concat([
    uint32LE(vendor.length),
    vendor,
    uint32LE(entries.length),
    ...entries.map((entry) => Buffer.concat([uint32LE(entry.length), entry])),
  ])
}

/** 造一个 FLAC 元数据块（块头 + 块体）。 */
function flacBlock(type: number, body: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4)
  header[0] = (last ? 0x80 : 0x00) | (type & 0x7f)
  header.writeUIntBE(body.length, 1, 3)
  return Buffer.concat([header, body])
}

/**
 * 造一个 FLAC 文件（`fLaC` + STREAMINFO + VORBIS_COMMENT）。
 *
 * @param pictureBytes 插在注释块**前面**的 `PICTURE` 块大小（测续读）。
 */
function flacFile(
  comments: Record<string, string>,
  sampleRate: number,
  totalSamples: number,
  pictureBytes = 0,
): Buffer {
  const info = Buffer.alloc(34)
  info.writeUInt16BE(4096, 0) // 最小块长
  info.writeUInt16BE(4096, 2) // 最大块长
  const channels = 2
  const bitsPerSample = 16
  info[10] = (sampleRate >>> 12) & 0xff
  info[11] = (sampleRate >>> 4) & 0xff
  info[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bitsPerSample - 1) >>> 4) & 0x01)
  info[13] = (((bitsPerSample - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 4294967296) & 0x0f)
  info[14] = (totalSamples >>> 24) & 0xff
  info[15] = (totalSamples >>> 16) & 0xff
  info[16] = (totalSamples >>> 8) & 0xff
  info[17] = totalSamples & 0xff

  const blocks = [flacBlock(0, info, false)]
  if (pictureBytes > 0) {
    blocks.push(flacBlock(6, Buffer.alloc(pictureBytes), false))
  }
  blocks.push(flacBlock(4, vorbisCommentBody(comments), true))

  return Buffer.concat([Buffer.from('fLaC', 'latin1'), ...blocks])
}

/** 造一个 Ogg 页。 */
function oggPage(
  headerType: number,
  granule: number,
  sequence: number,
  segments: Buffer[],
): Buffer {
  const table = Buffer.from(segments.map((part) => part.length))
  const body = Buffer.concat(segments)
  const head = Buffer.alloc(27)
  head.write('OggS', 0, 'latin1')
  head[4] = 0
  head[5] = headerType
  head.writeBigUInt64LE(BigInt(granule), 6)
  head.writeUInt32LE(1, 14) // 串号
  head.writeUInt32LE(sequence, 18)
  head.writeUInt32LE(0, 22) // 校验和（解析器不校验）
  head[26] = table.length
  return Buffer.concat([head, table, body])
}

/** Vorbis 的识别头包。 */
function vorbisIdent(sampleRate: number): Buffer {
  const packet = Buffer.alloc(30)
  packet[0] = 0x01
  packet.write('vorbis', 1, 'latin1')
  packet.writeUInt32LE(0, 7) // 版本
  packet[11] = 2 // 声道
  packet.writeUInt32LE(sampleRate, 12)
  packet[29] = 1 // framing
  return packet
}

/** Vorbis 的注释包。 */
function vorbisCommentPacket(comments: Record<string, string>): Buffer {
  const body = vorbisCommentBody(comments)
  const head = Buffer.alloc(7)
  head[0] = 0x03
  head.write('vorbis', 1, 'latin1')
  return Buffer.concat([head, body])
}

/** Opus 的识别头包。 */
function opusIdent(preSkip: number): Buffer {
  const packet = Buffer.alloc(19)
  packet.write('OpusHead', 0, 'latin1')
  packet[8] = 1 // 版本
  packet[9] = 2 // 声道
  packet.writeUInt16LE(preSkip, 10)
  packet.writeUInt32LE(48000, 12)
  packet[18] = 0 // mapping family
  return packet
}

/** Opus 的注释包。 */
function opusCommentPacket(comments: Record<string, string>): Buffer {
  const body = vorbisCommentBody(comments)
  return Buffer.concat([Buffer.from('OpusTags', 'latin1'), body])
}

/** 把一个缓冲区变成读取器。 */
function bufferReader(data: Buffer): TagReader {
  return {
    size: data.length,
    read: async (offset, length) =>
      data.subarray(Math.max(0, offset), Math.min(offset + length, data.length)),
  }
}

/** 内存文件系统（给 `readFileTags` 用）。 */
function memoryFs(files: Map<string, Buffer>): TagFileSystem {
  return {
    readBytes: async (path, offset, length) => {
      const data = files.get(path)
      if (!data) throw new Error(`没有这个文件: ${path}`)
      return data.subarray(offset, Math.min(offset + length, data.length))
    },
    statSize: async (path) => {
      const data = files.get(path)
      return data ? data.length : null
    },
  }
}

// ---------------------------------------------------------------------------
// 文件头嗅探
// ---------------------------------------------------------------------------

describe('T39 文件头嗅探', () => {
  it('认得 ID3 / fLaC / OggS', () => {
    expect(isId3Magic(Buffer.from('ID3 ', 'latin1'))).toBe(true)
    expect(isFlacMagic(Buffer.from('fLaC', 'latin1'))).toBe(true)
    expect(isOggMagic(Buffer.from('OggS', 'latin1'))).toBe(true)
    expect(isId3Magic(Buffer.from('RIFF', 'latin1'))).toBe(false)
    expect(isFlacMagic(Buffer.from('ID3', 'latin1'))).toBe(false)
    expect(isOggMagic(Buffer.alloc(0))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ID3v2
// ---------------------------------------------------------------------------

describe('T39 ID3v2', () => {
  it('v2.3 → 歌名 / 歌手 / 专辑', () => {
    const tag = id3Tag(
      [
        id3TextFrame('TIT2', '示例歌名', 3),
        id3TextFrame('TPE1', '示例歌手', 3),
        id3TextFrame('TALB', '示例专辑', 3),
      ],
      3,
    )

    const parsed = parseId3v2(tag)

    expect(parsed.title).toBe('示例歌名')
    expect(parsed.artist).toBe('示例歌手')
    expect(parsed.album).toBe('示例专辑')
    expect(parsed.tagSize).toBe(tag.length)
  })

  it('v2.4 → 一样能读（帧大小是同步安全的）', () => {
    const tag = id3Tag([id3TextFrame('TIT2', '示例歌名', 4)], 4)

    expect(parseId3v2(tag).title).toBe('示例歌名')
  })

  it('v2.2 → 3 字符帧 ID 也认', () => {
    const tag = id3Tag(
      [id3TextFrame('TT2', '示例歌名', 2), id3TextFrame('TP1', '示例歌手', 2)],
      2,
    )

    const parsed = parseId3v2(tag)
    expect(parsed.title).toBe('示例歌名')
    expect(parsed.artist).toBe('示例歌手')
  })

  it('UTF-16（带 BOM）也能解', () => {
    const tag = id3Tag([id3TextFrame('TIT2', '示例歌名', 3, 1)], 3)

    expect(parseId3v2(tag).title).toBe('示例歌名')
  })

  it('一帧里多个值 → 取第一个非空', () => {
    const payload = Buffer.concat([
      Buffer.from([0x03]),
      Buffer.from('第一个\0第二个', 'utf8'),
    ])
    const frame = Buffer.concat([
      Buffer.from('TIT2', 'latin1'),
      uint32BE(payload.length),
      Buffer.from([0, 0]),
      payload,
    ])
    const tag = id3Tag([frame], 3)

    expect(parseId3v2(tag).title).toBe('第一个')
  })

  it('**整段 unsynchronisation** → 不读标签，但**标签长度仍然要给**', () => {
    const body = id3TextFrame('TIT2', '示例歌名', 3)
    const tag = id3Tag([body], 3, 0x80)

    const parsed = parseId3v2(tag)
    expect(parsed.title).toBeUndefined()
    // ⚠️ 音频数据的起点靠它算 → 不能丢。
    expect(parsed.tagSize).toBe(tag.length)
    expect(id3TagSize(tag)).toBe(tag.length)
  })

  it('不是 ID3 / 头不完整 → 空结果，不抛', () => {
    expect(parseId3v2(Buffer.from('RIFF____', 'latin1')).title).toBeUndefined()
    expect(parseId3v2(Buffer.alloc(0)).tagSize).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// mp3 时长
// ---------------------------------------------------------------------------

describe('T39 mp3 时长', () => {
  it('MPEG1 Layer III 帧头 → 128 kbps / 44.1 kHz / 1152 采样每帧', () => {
    const frame = parseMpegFrameHeader(mpegFrame(0), 0)

    expect(frame).not.toBeNull()
    expect(frame?.bitrate).toBe(128)
    expect(frame?.sampleRate).toBe(44100)
    expect(frame?.samplesPerFrame).toBe(1152)
    expect(frame?.channels).toBe(2)
  })

  it('有 `Xing` 头 → 帧数换算成**精确**时长', async () => {
    const file = Buffer.concat([id3Tag([], 3), mpegFrame(100)])

    const tags = await readTagsFromReader(bufferReader(file))

    // 100 帧 × 1152 采样 ÷ 44100 Hz
    expect(tags?.duration).toBeCloseTo((100 * 1152) / 44100, 6)
  })

  it('没有 `Xing` 头 → 按 CBR 估算（**近似**）', async () => {
    const file = Buffer.concat([id3Tag([], 3), mpegFrame(0)])

    const tags = await readTagsFromReader(bufferReader(file))

    // 417 字节 × 8 ÷ 128 kbps
    expect(tags?.duration).toBeCloseTo((417 * 8) / 128000, 6)
  })
})

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

describe('T39 FLAC', () => {
  it('`STREAMINFO` + `VORBIS_COMMENT` → 标签与**精确**时长', async () => {
    const file = flacFile(
      { TITLE: '示例歌名', ARTIST: '示例歌手', ALBUM: '示例专辑' },
      44100,
      44100 * 180,
    )

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.artist).toBe('示例歌手')
    expect(tags?.album).toBe('示例专辑')
    expect(tags?.duration).toBeCloseTo(180, 6)
  })

  it('`PICTURE` 块很大（> 头块）→ **续读**后照样找得到注释块', async () => {
    const file = flacFile({ TITLE: '示例歌名' }, 44100, 44100 * 10, 100 * 1024)

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.duration).toBeCloseTo(10, 6)
  })

  it('没有 `VORBIS_COMMENT` → 只有时长，没有歌名', async () => {
    const info = Buffer.alloc(34)
    info[10] = (44100 >>> 12) & 0xff
    info[11] = (44100 >>> 4) & 0xff
    info[12] = ((44100 & 0x0f) << 4) | 0x02
    // ⚠️ **不能写 `totalSamples >>> 32`**：JS 的移位数会 **mod 32**，
    //    `>>> 32` 等于 `>>> 0` → 高 32 位会算错。
    info[13] = Math.floor((44100 * 10) / 4294967296) & 0x0f
    info[14] = ((44100 * 10) >>> 24) & 0xff
    info[15] = ((44100 * 10) >>> 16) & 0xff
    info[16] = ((44100 * 10) >>> 8) & 0xff
    info[17] = (44100 * 10) & 0xff
    const file = Buffer.concat([Buffer.from('fLaC', 'latin1'), flacBlock(0, info, true)])

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBeUndefined()
    expect(tags?.duration).toBeCloseTo(10, 6)
  })
})

// ---------------------------------------------------------------------------
// Ogg
// ---------------------------------------------------------------------------

describe('T39 Ogg', () => {
  it('Vorbis → 标签 + **末页 granule** 时长', async () => {
    const file = Buffer.concat([
      oggPage(0x02, 0, 0, [
        vorbisIdent(44100),
        vorbisCommentPacket({ TITLE: '示例歌名', ARTIST: '示例歌手' }),
      ]),
      oggPage(0x04, 44100 * 120, 1, [Buffer.alloc(16)]),
    ])

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.artist).toBe('示例歌手')
    expect(tags?.duration).toBeCloseTo(120, 6)
  })

  it('Opus → 时长要**减掉 preSkip**', async () => {
    const preSkip = 312
    const file = Buffer.concat([
      oggPage(0x02, 0, 0, [
        opusIdent(preSkip),
        opusCommentPacket({ TITLE: '示例歌名' }),
      ]),
      oggPage(0x04, preSkip + 48000 * 60, 1, [Buffer.alloc(16)]),
    ])

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.duration).toBeCloseTo(60, 6)
  })

  it('末页 granule：取**最后一个** `OggS`', () => {
    const buffer = Buffer.concat([
      oggPage(0x02, 111, 0, [Buffer.alloc(8)]),
      oggPage(0x04, 222, 1, [Buffer.alloc(8)]),
    ])

    expect(lastOggGranule(buffer)).toBe(222)
  })

  it('没有 granule → 时长缺省（**不猜**）', async () => {
    const file = Buffer.concat([
      oggPage(0x02, 0, 0, [
        vorbisIdent(44100),
        vorbisCommentPacket({ TITLE: '示例歌名' }),
      ]),
      oggPage(0x04, 0, 1, [Buffer.alloc(16)]),
    ])

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.duration).toBeUndefined()
  })

  it('`parseOggTags`：不是 Ogg → `null`', async () => {
    expect(await parseOggTags(bufferReader(Buffer.from('RIFF', 'latin1')), Buffer.from('RIFF'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Vorbis Comment 块
// ---------------------------------------------------------------------------

describe('T39 Vorbis 注释块', () => {
  it('键统一大写；重复的键只取第一个', () => {
    const body = vorbisCommentBody({ title: '示例歌名', TITLE: '第二个' })

    const comments = parseVorbisCommentBlock(body)

    expect(comments.get('TITLE')).toBe('示例歌名')
  })

  it('坏数据 → 空表，不抛', () => {
    expect(parseVorbisCommentBlock(Buffer.alloc(3)).size).toBe(0)
    expect(parseVorbisCommentBlock(Buffer.from([0xff, 0xff, 0xff, 0xff])).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 入口与坏输入
// ---------------------------------------------------------------------------

describe('T39 读文件标签', () => {
  it('内存文件系统 → 能读出标签', async () => {
    const file = flacFile({ TITLE: '示例歌名' }, 44100, 44100 * 30)
    const files = new Map<string, Buffer>([['D:\\Music\\a.flac', file]])

    const tags = await readFileTags(memoryFs(files), 'D:\\Music\\a.flac')

    expect(tags?.title).toBe('示例歌名')
  })

  it('文件不存在 → `null`（**不抛**）', async () => {
    expect(await readFileTags(memoryFs(new Map()), 'D:\\Music\\没有.flac')).toBeNull()
  })

  it('不认识的文件 → `null`（**不抛**）', async () => {
    const files = new Map<string, Buffer>([['D:\\Music\\a.txt', Buffer.from('就是文本', 'utf8')]])

    expect(await readFileTags(memoryFs(files), 'D:\\Music\\a.txt')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 合并规则
// ---------------------------------------------------------------------------

describe('T39 标签与文件名合并', () => {
  it('标签优先：歌名 / 歌手 / 专辑 / 时长都用标签的', () => {
    const merged = mergeTrackTags('文件名歌手 - 文件名歌名.flac', {
      title: '标签歌名',
      artist: '标签歌手',
      album: '标签专辑',
      duration: 123.5,
    })

    expect(merged.title).toBe('标签歌名')
    expect(merged.artist).toBe('标签歌手')
    expect(merged.album).toBe('标签专辑')
    expect(merged.duration).toBe(123.5)
    expect(merged.tagSource).toBe('tag')
  })

  it('标签缺字段 → **文件名兜底**', () => {
    const merged = mergeTrackTags('文件名歌手 - 文件名歌名.flac', { title: '标签歌名' })

    expect(merged.title).toBe('标签歌名')
    expect(merged.artist).toBe('文件名歌手')
    expect(merged.album).toBe('')
    expect(merged.duration).toBe(0)
  })

  it('**没有标签** → 全用文件名，来源标 `name`', () => {
    const merged = mergeTrackTags('文件名歌手 - 文件名歌名.flac', null)

    expect(merged.title).toBe('文件名歌名')
    expect(merged.artist).toBe('文件名歌手')
    expect(merged.tagSource).toBe('name')
  })

  it('空字符串的标签 → 当作没有（**兜底**）', () => {
    const merged = mergeTrackTags('文件名歌手 - 文件名歌名.flac', { title: '   ' })

    expect(merged.title).toBe('文件名歌名')
    expect(merged.tagSource).toBe('name')
  })

  it('时长为 0 / 非数 → 当作**未知**', () => {
    expect(mergeTrackTags('a.flac', { duration: 0 }).duration).toBe(0)
    expect(mergeTrackTags('a.flac', { duration: Number.NaN }).duration).toBe(0)
  })
})
