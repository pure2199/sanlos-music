// ---------------------------------------------------------------------------
// T83 内嵌歌词标签解析（主进程，纯函数）
// ---------------------------------------------------------------------------
//
// 覆盖（**六种帧格式** + 端到端断言）：
// - **ID3v2 `USLT`**：UTF-8 / UTF-16(BOM) 两种编码、带内容描述符；
// - **ID3v2 `SYLT`**：词模式（转成增强 LRC，**空白要保留**）/ 行模式 /
////   MPEG 帧号时间戳（**放弃**）；
// - **Vorbis 注释** `LYRICS` / `UNSYNCEDLYRICS`（前者优先、空则回落后者）；
// - **MP4 `©lyr`**；
// - **AIFF 的 `ID3 ` 块**（复用 ID3v2 解析器 ⇒ 白捡）；
// - **端到端**：解析出来的 LRC 交给**渲染层现有解析器**
//   （`src/ui/lyrics/parse.ts` 的 `parseEnhancedLrc`）⇒
////   真逐字 ⇒ `wordTimed === true`；行级 ⇒ `wordTimed === false`。
//
// ⚠️ **不放二进制样本文件**：全部用代码**构造**字节流。
// ⚠️ 测试数据一律用占位值（`示例歌词`），不写真实歌名。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { parseId3v2, parseUsltFrame, parseSylltFrame, readTagsFromReader, type TagReader } from '../electron/audioTags'
import { parseEnhancedLrc } from '../src/ui/lyrics/parse'

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

/**
 * 造一个 ID3v2 **原始帧**（帧体是已编码好的字节）。
 *
 * @param id 帧 ID（v2.3 用 4 个字符）。
 * @param payload 帧体。
 */
function id3RawFrame(id: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id, 'latin1'), uint32BE(payload.length), Buffer.from([0, 0]), payload])
}

/** 造一个完整的 ID3v2.3 标签。 */
function id3Tag(frames: Buffer[]): Buffer {
  const body = Buffer.concat(frames)
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0]),
    synchsafe(body.length),
    body,
  ])
}

/**
 * 造一个 `USLT` 帧体。
 *
 * @param text 歌词文本。
 * @param encoding 编码字节（`3` = UTF-8，`1` = UTF-16 带 BOM）。
 * @param descriptor 内容描述符。
 */
function usltFrame(text: string, encoding = 3, descriptor = ''): Buffer {
  const encode = (value: string): Buffer =>
    encoding === 1
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])
      : Buffer.from(value, 'utf8')
  return Buffer.concat([
    Buffer.from([encoding]),
    Buffer.from('chi', 'latin1'),
    encode(descriptor),
    encoding === 1 ? Buffer.from([0x00, 0x00]) : Buffer.from([0x00]),
    encode(text),
    encoding === 1 ? Buffer.from([0x00, 0x00]) : Buffer.from([0x00]),
  ])
}

/**
 * 造一个 `SYLT` 帧体。
 *
 * @param entries 条目（文本 + 时间戳毫秒）。
 * @param timeFormat 时间戳格式（`1` = 绝对毫秒，`2` = MPEG 帧号）。
 */
function sylltFrame(entries: { text: string; timeMs: number }[], timeFormat = 1): Buffer {
  const parts: Buffer[] = [
    Buffer.from([3]), // 编码 = UTF-8
    Buffer.from('chi', 'latin1'),
    Buffer.from([timeFormat]),
    Buffer.from([1]), // 内容类型 = lyrics
    Buffer.from([0x00]), // 描述符（空）
  ]
  for (const entry of entries) {
    parts.push(Buffer.from(entry.text, 'utf8'), Buffer.from([0x00]), uint32BE(entry.timeMs))
  }
  return Buffer.concat(parts)
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

/** 造一个 FLAC 文件（`fLaC` + STREAMINFO + VORBIS_COMMENT）。 */
function flacFile(comments: Record<string, string>): Buffer {
  const info = Buffer.alloc(34)
  info.writeUInt16BE(4096, 0)
  info.writeUInt16BE(4096, 2)
  info[10] = (44100 >>> 12) & 0xff
  info[11] = (44100 >>> 4) & 0xff
  info[12] = ((44100 & 0x0f) << 4) | 0x05
  info[13] = 0x0f
  info[17] = 44100 * 100
  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    flacBlock(0, info, false),
    flacBlock(4, vorbisCommentBody(comments), true),
  ])
}

/** 造一个 MP4 原子（4 字节长度 + 4 字节类型 + 内容）。 */
function mp4Atom(type: string, content: Buffer): Buffer {
  return Buffer.concat([uint32BE(content.length + 8), Buffer.from(type, 'latin1'), content])
}

/** 造一个 `data` 原子（`ilst` 条目的值）。 */
function mp4Data(value: Buffer): Buffer {
  return mp4Atom('data', Buffer.concat([uint32BE(1), uint32BE(0), value]))
}

/** 造一个 `ilst` 条目。 */
function mp4Item(type: string, value: Buffer): Buffer {
  return mp4Atom(type, mp4Data(value))
}

/** 造一个 MP4 / M4A 文件（`moov` 里带 `ilst`）。 */
function mp4File(items: Buffer[]): Buffer {
  const ilst = mp4Atom('ilst', Buffer.concat(items))
  const meta = mp4Atom('meta', Buffer.concat([Buffer.alloc(4), mp4Atom('hdlr', Buffer.alloc(21)), ilst]))
  const udta = mp4Atom('udta', meta)
  const moov = mp4Atom('moov', udta)
  const ftyp = mp4Atom(
    'ftyp',
    Buffer.concat([Buffer.from('M4A ', 'latin1'), uint32BE(0), Buffer.from('isomM4A', 'latin1')]),
  )
  return Buffer.concat([ftyp, moov, mp4Atom('mdat', Buffer.alloc(16))])
}

/** 造一个 AIFF 块（**大端**长度 + 数据，按偶数补齐）。 */
function aiffChunk(id: string, data: Buffer): Buffer {
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([Buffer.from(id, 'latin1'), uint32BE(data.length), data, pad])
}

/** 造一个带 `ID3 ` 块的 AIFF 文件。 */
function aiffFile(id3: Buffer): Buffer {
  const comm = Buffer.alloc(18)
  comm.writeUInt16BE(2, 0)
  const body = Buffer.concat([
    Buffer.from('FORM', 'latin1'),
    uint32BE(4 + 8 + 18 + 8 + 8 + 8 + id3.length),
    Buffer.from('AIFF', 'latin1'),
    aiffChunk('COMM', comm),
    aiffChunk('SSND', Buffer.alloc(8)),
    aiffChunk('ID3 ', id3),
  ])
  return body
}

/** 把一个缓冲区变成读取器。 */
function bufferReader(data: Buffer): TagReader {
  return {
    size: data.length,
    read: async (offset, length) =>
      data.subarray(Math.max(0, offset), Math.min(offset + length, data.length)),
  }
}

// ---------------------------------------------------------------------------
// ID3v2 —— USLT
// ---------------------------------------------------------------------------

describe('T83 内嵌歌词 —— ID3v2 USLT', () => {
  it('读出 UTF-8 的 USLT 歌词', () => {
    const lrc = '[00:01.00]示例歌词\n[00:05.00]第二句'
    const parsed = parseId3v2(id3Tag([id3RawFrame('USLT', usltFrame(lrc))]))
    expect(parsed.lyrics).toBe(lrc)
  })

  it('读出 UTF-16(BOM) 的 USLT 歌词', () => {
    const lrc = '[00:01.00]示例歌词'
    const parsed = parseId3v2(id3Tag([id3RawFrame('USLT', usltFrame(lrc, 1))]))
    expect(parsed.lyrics).toBe(lrc)
  })

  it('带内容描述符也能读出来（描述符要被跳过）', () => {
    const parsed = parseId3v2(
      id3Tag([id3RawFrame('USLT', usltFrame('[00:02.00]示例歌词', 3, '描述文本'))]),
    )
    expect(parsed.lyrics).toBe('[00:02.00]示例歌词')
  })

  it('空歌词 ⇒ 没有 lyrics 字段', () => {
    const parsed = parseId3v2(id3Tag([id3RawFrame('USLT', usltFrame('   '))]))
    expect(parsed.lyrics).toBeUndefined()
  })

  it('帧体太短 ⇒ 不抛、返回 undefined', () => {
    expect(parseUsltFrame(Buffer.alloc(3))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ID3v2 —— SYLT（真逐字）
// ---------------------------------------------------------------------------

describe('T83 内嵌歌词 —— ID3v2 SYLT', () => {
  it('词模式：转成增强 LRC，逐字标签带上毫秒时间戳', () => {
    const frame = sylltFrame([
      { text: 'Hello ', timeMs: 1000 },
      { text: 'world', timeMs: 1500 },
      { text: '再见\n', timeMs: 2000 },
    ])
    const parsed = parseId3v2(id3Tag([id3RawFrame('SYLT', frame)]))
    // ⚠️ `\n` 是**行尾标记**：它结束的是**当前行** ⇒ `再见` 仍属于第一行。
    expect(parsed.lyrics).toBe(
      '[00:01.000]<00:01.000>Hello <00:01.500>world<00:02.000>再见',
    )
  })

  it('词模式：条目以换行开头 ⇒ 另起一行', () => {
    const frame = sylltFrame([
      { text: 'Hello ', timeMs: 1000 },
      { text: 'world', timeMs: 1500 },
      { text: '\n再见', timeMs: 2000 },
    ])
    const parsed = parseId3v2(id3Tag([id3RawFrame('SYLT', frame)]))
    expect(parsed.lyrics).toBe(
      '[00:01.000]<00:01.000>Hello <00:01.500>world\n[00:02.000]再见',
    )
  })

  it('词模式：词之间的空格必须保留（否则行文本会变成 Helloworld）', () => {
    const frame = sylltFrame([
      { text: 'Hello ', timeMs: 1000 },
      { text: 'world', timeMs: 1500 },
    ])
    const parsed = parseId3v2(id3Tag([id3RawFrame('SYLT', frame)]))
    const lines = parseEnhancedLrc(parsed.lyrics ?? '')
    expect(lines).toHaveLength(1)
    // ⚠️ 显示用文本要保留空格。
    expect(lines[0]?.text).toBe('Hello world')
    // ⚠️ 逐字填色的对齐口径：词的去空白字符数 = 行文本的去空白字符数。
    const words = lines[0]?.words ?? []
    expect(words.map((word) => word.text).join('')).toBe('Helloworld')
  })

  it('词模式：交给渲染层解析器 ⇒ 真逐字（wordTimed = true）', () => {
    const frame = sylltFrame([
      { text: 'Hello ', timeMs: 1000 },
      { text: 'world', timeMs: 1500 },
    ])
    const parsed = parseId3v2(id3Tag([id3RawFrame('SYLT', frame)]))
    const lines = parseEnhancedLrc(parsed.lyrics ?? '')
    expect(lines[0]?.wordTimed).toBe(true)
    expect(lines[0]?.words.map((word) => word.start)).toEqual([1, 1.5])
  })

  it('行模式：每个条目一行（行级时间戳）', () => {
    const frame = sylltFrame([
      { text: '这是第一行歌词的内容示例文本', timeMs: 1000 },
      { text: '这是第二行歌词的内容示例文本', timeMs: 5000 },
    ])
    const parsed = parseId3v2(id3Tag([id3RawFrame('SYLT', frame)]))
    expect(parsed.lyrics).toBe(
      '[00:01.000]这是第一行歌词的内容示例文本\n[00:05.000]这是第二行歌词的内容示例文本',
    )
  })

  it('行模式：交给渲染层解析器 ⇒ 行级（wordTimed = false ⇒ 整行显示）', () => {
    const frame = sylltFrame([
      { text: '这是第一行歌词的内容示例文本', timeMs: 1000 },
      { text: '这是第二行歌词的内容示例文本', timeMs: 5000 },
    ])
    const parsed = parseId3v2(id3Tag([id3RawFrame('SYLT', frame)]))
    const lines = parseEnhancedLrc(parsed.lyrics ?? '')
    expect(lines).toHaveLength(2)
    expect(lines[0]?.wordTimed).toBe(false)
  })

  it('时间戳格式 = 2（mutagen 系的**实际约定**，存的其实是毫秒）⇒ **按毫秒读**', () => {
    // ⚠️ **T84**：这条断言的前**前提被用户显式推翻**（原口径是「格式 2 ⇒ 整帧放弃」）。
    //    依据：真实文件实测（mutagen 写出的 `SYLT` 一律声明格式 2，存的却是毫秒）
    //    ⇒ 现实中最常见的 `SYLT` 文件全在这一档 ⇒ 放弃它们等于「功能没有」。
    const frame = sylltFrame(
      [
        { text: 'ten', timeMs: 0 },
        { text: ' nine', timeMs: 1000 },
      ],
      2,
    )
    const parsed = parseId3v2(id3Tag([id3RawFrame('SYLT', frame)]))
    // ⚠️ 断言**不弱于**原来那条：原来只钉「拿不到」，现在钉「拿到什么」+ 逐字标签。
    expect(parsed.lyrics).toBe('[00:00.000]<00:00.000>ten<00:01.000> nine')
    const lines = parseEnhancedLrc(parsed.lyrics ?? '')
    expect(lines[0]?.wordTimed).toBe(true)
  })

  it('时间戳格式 = 0 / 3+ ⇒ 整帧放弃（真不知道是啥 ⇒ **不猜**）', () => {
    // ⚠️ **保住「不猜」的鉴别力**：只有 **1 与 2** 按毫秒读；其它取值一律放弃。
    expect(parseSylltFrame(sylltFrame([{ text: '示例', timeMs: 1000 }], 0))).toBeUndefined()
    expect(parseSylltFrame(sylltFrame([{ text: '示例', timeMs: 1000 }], 3))).toBeUndefined()
  })

  it('USLT 与 SYLT 同时存在 ⇒ SYLT 赢（真逐字优先于行级）', () => {
    const tag = id3Tag([
      id3RawFrame('USLT', usltFrame('[00:09.00]行级歌词')),
      id3RawFrame(
        'SYLT',
        sylltFrame([
          { text: '示例', timeMs: 1000 },
          { text: '歌词', timeMs: 1200 },
        ]),
      ),
    ])
    const parsed = parseId3v2(tag)
    expect(parsed.lyrics).toContain('<00:01.000>')
  })

  it('SYLT 在前、USLT 在后 ⇒ 仍然是 SYLT 赢', () => {
    const tag = id3Tag([
      id3RawFrame(
        'SYLT',
        sylltFrame([
          { text: '示例', timeMs: 1000 },
          { text: '歌词', timeMs: 1200 },
        ]),
      ),
      id3RawFrame('USLT', usltFrame('[00:09.00]行级歌词')),
    ])
    const parsed = parseId3v2(tag)
    expect(parsed.lyrics).toContain('<00:01.000>')
  })

  it('帧体太短 ⇒ 不抛、返回 undefined', () => {
    expect(parseSylltFrame(Buffer.alloc(3))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Vorbis 注释（FLAC / Ogg）
// ---------------------------------------------------------------------------

describe('T83 内嵌歌词 —— Vorbis 注释', () => {
  it('FLAC 的 LYRICS 读得出来', async () => {
    const file = flacFile({ LYRICS: '[00:01.00]示例歌词' })
    const tags = await readTagsFromReader(bufferReader(file))
    expect(tags?.lyrics).toBe('[00:01.00]示例歌词')
  })

  it('只有 UNSYNCEDLYRICS 时也读得出来', async () => {
    const file = flacFile({ UNSYNCEDLYRICS: '[00:02.00]兜底歌词' })
    const tags = await readTagsFromReader(bufferReader(file))
    expect(tags?.lyrics).toBe('[00:02.00]兜底歌词')
  })

  it('LYRICS 为空 ⇒ 回落 UNSYNCEDLYRICS', async () => {
    const file = flacFile({ LYRICS: '', UNSYNCEDLYRICS: '[00:03.00]兜底歌词' })
    const tags = await readTagsFromReader(bufferReader(file))
    expect(tags?.lyrics).toBe('[00:03.00]兜底歌词')
  })

  it('没有歌词注释 ⇒ lyrics 字段不存在', async () => {
    const file = flacFile({ TITLE: '示例歌名' })
    const tags = await readTagsFromReader(bufferReader(file))
    expect(tags?.title).toBe('示例歌名')
    expect(tags?.lyrics).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

describe('T83 内嵌歌词 —— MP4 ©lyr', () => {
  it('读得出 ilst 里的 ©lyr', async () => {
    const file = mp4File([mp4Item('\u00a9lyr', Buffer.from('[00:01.00]示例歌词', 'utf8'))])
    const tags = await readTagsFromReader(bufferReader(file))
    expect(tags?.lyrics).toBe('[00:01.00]示例歌词')
  })

  it('没有 ©lyr ⇒ lyrics 字段不存在', async () => {
    const file = mp4File([mp4Item('\u00a9nam', Buffer.from('示例歌名', 'utf8'))])
    const tags = await readTagsFromReader(bufferReader(file))
    expect(tags?.title).toBe('示例歌名')
    expect(tags?.lyrics).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AIFF 的 ID3 块
// ---------------------------------------------------------------------------

describe('T83 内嵌歌词 —— AIFF 的 ID3 块', () => {
  it('ID3 块里的 USLT 读得出来', async () => {
    const lrc = '[00:01.00]示例歌词'
    const file = aiffFile(id3Tag([id3RawFrame('USLT', usltFrame(lrc))]))
    const tags = await readTagsFromReader(bufferReader(file))
    expect(tags?.lyrics).toBe(lrc)
  })
})
