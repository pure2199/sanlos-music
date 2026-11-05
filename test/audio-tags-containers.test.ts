// ---------------------------------------------------------------------------
// T42 本地音乐标签：更多容器（MP4 / M4A、WAV、AIFF）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **MP4 / M4A**：`moov` 常在**文件尾**（真实 m4a 就是这样）→ 必须**按偏移走
//   顶层原子表**（只读文件头会漏）；`moov.mvhd` 出时长；`moov.udta.meta.ilst`
//   出标签（`©nam` / `©ART` / `©alb`）；`data` 原子的载荷前有 **8 字节**
//   （4 字节类型指示 + 4 字节 locale）→ 偏移错了会把控制字符带进歌名；
// - **WAV**：`fmt ` 的字节率 + `data` 的长度 → **精确**时长；`LIST INFO` 里的
//   `INAM` / `IART` / `IPRD`；文本块按 C 字符串写 → **结尾有 NUL**；
//   老工具写的 **GBK** 标签 → UTF-8 严格模式解不出来 → 要退 GBK；
// - **AIFF / AIFC**：`COMM` 的 **80 位扩展精度**采样率 → **精确**时长；
//   `ID3 ` 块 → **复用**已有的 ID3v2 解析器；
// - **坏输入**：不认识 / 头不完整 → `null`，**不抛**。
//
// ⚠️ **不放二进制样本文件**：全部用代码**构造**字节流 → 仓库里没有二进制，
//    断言也写得出「为什么是这个值」。
// ⚠️ **字节布局以真实文件核对过**（ffmpeg 9.0.2 造的 m4a / wav / aiff），
//    样本留在仓库外的 `release/t42-samples/`，**不入库**。
// ⚠️ 几个造字节的小工具与 `test/audio-tags.test.ts` 重复 —— **故意不抽公共
//    文件**：两个测试文件各自自洽，改一边不会连累另一边。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import {
  parseAiffTags,
  parseMp4Tags,
  parseWavTags,
  readTagsFromReader,
  type TagReader,
} from '../electron/audioTags'

// ---------------------------------------------------------------------------
// 造字节的工具
// ---------------------------------------------------------------------------

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

/** 4 字节「同步安全」整数（ID3 用）。 */
function synchsafe(value: number): Buffer {
  const out = Buffer.alloc(4)
  out[0] = (value >>> 21) & 0x7f
  out[1] = (value >>> 14) & 0x7f
  out[2] = (value >>> 7) & 0x7f
  out[3] = value & 0x7f
  return out
}

/** 造一个 ID3v2 文本帧（UTF-8 编码）。 */
function id3TextFrame(id: string, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')])
  return Buffer.concat([
    Buffer.from(id, 'latin1'),
    uint32BE(payload.length),
    Buffer.from([0, 0]),
    payload,
  ])
}

/** 造一个完整的 ID3v2 标签（v2.3）。 */
function id3Tag(frames: Buffer[]): Buffer {
  const body = Buffer.concat(frames)
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0]),
    synchsafe(body.length),
    body,
  ])
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
// MP4 / M4A
// ---------------------------------------------------------------------------

/** 造一个 MP4 原子（4 字节长度 + 4 字节类型 + 内容）。 */
function mp4Atom(type: string, content: Buffer): Buffer {
  return Buffer.concat([uint32BE(content.length + 8), Buffer.from(type, 'latin1'), content])
}

/**
 * 造一个 `data` 原子（`ilst` 条目的值）。
 *
 * ⚠️ **载荷前有 8 字节**：4 字节类型指示（`00 00 00 01` = UTF-8）+ 4 字节 locale。
 *
 * @param locale locale 字段（ISO-639-2 语言码；`0` = 未指定）。
 */
function mp4Data(value: Buffer, locale = 0): Buffer {
  return mp4Atom('data', Buffer.concat([uint32BE(1), uint32BE(locale), value]))
}

/** 造一个 `ilst` 条目（`©nam` + `data`）。 */
function mp4Item(type: string, value: Buffer, locale = 0): Buffer {
  return mp4Atom(type, mp4Data(value, locale))
}

/**
 * 造一个 `mvhd` 原子。
 *
 * @param version `0` = 32 位时长；`1` = 64 位时长。
 */
function mp4Mvhd(timescale: number, duration: number, version = 0): Buffer {
  if (version === 1) {
    // version + flags(4) + 创建时间(8) + 修改时间(8) + timescale(4) + duration(8)
    const content = Buffer.alloc(32)
    content.writeUInt8(1, 0)
    content.writeUInt32BE(timescale, 20)
    content.writeBigUInt64BE(BigInt(duration), 24)
    return mp4Atom('mvhd', content)
  }
  // version + flags(4) + 创建时间(4) + 修改时间(4) + timescale(4) + duration(4)
  const content = Buffer.alloc(20)
  content.writeUInt8(0, 0)
  content.writeUInt32BE(timescale, 12)
  content.writeUInt32BE(duration, 16)
  return mp4Atom('mvhd', content)
}

/** MP4 的 iTunes 标签码（`©` 在 latin1 里是 `0xA9`）。 */
const MP4_TITLE = '\u00a9nam'
const MP4_ARTIST = '\u00a9ART'
const MP4_ALBUM = '\u00a9alb'

interface Mp4Options {
  title?: string
  artist?: string
  album?: string
  timescale?: number
  duration?: number
  mvhdVersion?: number
  /** `mdat` 的字节数 —— 调大就能把 `moov` 顶到 **64 KB 之外**。 */
  mdatSize?: number
  /** `moov` 放文件尾（**真实 m4a 就是这样**）。 */
  moovLast?: boolean
  /** `data` 原子的 locale 字段（`0` = 未指定，**真实文件都是 0**）。 */
  locale?: number
}

/** 造一个 MP4 / M4A 文件。 */
function mp4File(options: Mp4Options = {}): Buffer {
  const locale = options.locale ?? 0
  const items: Buffer[] = []
  if (options.title !== undefined) {
    items.push(mp4Item(MP4_TITLE, Buffer.from(options.title, 'utf8'), locale))
  }
  if (options.artist !== undefined) {
    items.push(mp4Item(MP4_ARTIST, Buffer.from(options.artist, 'utf8'), locale))
  }
  if (options.album !== undefined) {
    items.push(mp4Item(MP4_ALBUM, Buffer.from(options.album, 'utf8'), locale))
  }

  const ilst = mp4Atom('ilst', Buffer.concat(items))
  // ⚠️ `meta` 是 FullBox：头 4 字节是 version + flags → 子原子从 +4 开始。
  const meta = mp4Atom('meta', Buffer.concat([Buffer.alloc(4), mp4Atom('hdlr', Buffer.alloc(21)), ilst]))
  const udta = mp4Atom('udta', meta)
  const mvhd = mp4Mvhd(
    options.timescale ?? 44100,
    options.duration ?? 44100 * 180,
    options.mvhdVersion ?? 0,
  )
  const moov = mp4Atom('moov', Buffer.concat([mvhd, udta]))
  const ftyp = mp4Atom(
    'ftyp',
    Buffer.concat([Buffer.from('M4A ', 'latin1'), uint32BE(0), Buffer.from('isomM4A', 'latin1')]),
  )
  const mdat = mp4Atom('mdat', Buffer.alloc(options.mdatSize ?? 16))

  return options.moovLast === false
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov])
}

// ---------------------------------------------------------------------------
// RIFF 家族（WAV / AIFF 共用）
// ---------------------------------------------------------------------------

/**
 * 造一个 RIFF 块。
 *
 * ⚠️ 块数据按**偶数**字节补齐（RIFF 规范）→ 下一个块的位置要跳过补齐字节。
 */
function riffChunk(id: string, content: Buffer, littleEndian = true): Buffer {
  const size = littleEndian ? uint32LE(content.length) : uint32BE(content.length)
  const padding = content.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([Buffer.from(id, 'latin1'), size, content, padding])
}

/** 造 `LIST INFO` 的内容（`'INFO'` + 若干文本块）。 */
function riffInfo(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([
    Buffer.from('INFO', 'latin1'),
    ...entries.map(([id, value]) => riffChunk(id, value)),
  ])
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

interface WavOptions {
  title?: Buffer
  artist?: Buffer
  album?: Buffer
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  /** `data` 块的字节数。 */
  dataSize?: number
}

/** 造一个 WAV 文件（`data` 在 `LIST INFO` **之前** → 逼解析器按偏移跳块）。 */
function wavFile(options: WavOptions = {}): Buffer {
  const channels = options.channels ?? 1
  const sampleRate = options.sampleRate ?? 8000
  const bits = options.bitsPerSample ?? 16
  const blockAlign = (channels * bits) / 8
  const byteRate = sampleRate * blockAlign

  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(byteRate, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(bits, 14)

  const entries: Array<[string, Buffer]> = []
  if (options.title) entries.push(['INAM', options.title])
  if (options.artist) entries.push(['IART', options.artist])
  if (options.album) entries.push(['IPRD', options.album])

  const body = Buffer.concat([
    Buffer.from('WAVE', 'latin1'),
    riffChunk('fmt ', fmt),
    riffChunk('data', Buffer.alloc(options.dataSize ?? 16000)),
    ...(entries.length > 0 ? [riffChunk('LIST', riffInfo(entries))] : []),
  ])
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), uint32LE(body.length), body])
}

// ---------------------------------------------------------------------------
// AIFF
// ---------------------------------------------------------------------------

/**
 * 造 10 字节的 **80 位 IEEE 扩展精度**浮点（AIFF 的采样率用它）。
 *
 * ⚠️ 这里用**整数**采样率 → 尾数就是它本身，指数取 `16383 + 63`。
 */
function extended80(value: number): Buffer {
  const out = Buffer.alloc(10)
  out.writeUInt8(0x40, 0) // 符号位 0（正）+ 指数高位
  out.writeUInt8(0x3e, 1) // 指数 = 0x403E = 16446 = 16383 + 63
  out.writeBigUInt64BE(BigInt(Math.round(value)), 2)
  return out
}

interface AiffOptions {
  title?: string
  artist?: string
  album?: string
  sampleRate?: number
  frames?: number
  /** 要不要写 `ID3 ` 块。 */
  withId3?: boolean
  /** `SSND` 块的字节数 —— 调大就能把 `ID3 ` 顶到 **64 KB 之外**。 */
  ssndSize?: number
}

/** 造一个 AIFF 文件（`ID3 ` 在 `SSND` **之后** → 逼解析器按偏移跳块）。 */
function aiffFile(options: AiffOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 44100
  const frames = options.frames ?? 44100 * 180

  const comm = Buffer.alloc(18)
  comm.writeUInt16BE(2, 0) // 声道
  comm.writeUInt32BE(frames, 2)
  comm.writeUInt16BE(16, 6) // 采样位宽
  extended80(sampleRate).copy(comm, 8)

  const id3Frames: Buffer[] = []
  if (options.title !== undefined) id3Frames.push(id3TextFrame('TIT2', options.title))
  if (options.artist !== undefined) id3Frames.push(id3TextFrame('TPE1', options.artist))
  if (options.album !== undefined) id3Frames.push(id3TextFrame('TALB', options.album))

  const chunks = [
    riffChunk('COMM', comm, false),
    riffChunk('SSND', Buffer.alloc(options.ssndSize ?? 16), false),
  ]
  if (options.withId3 !== false && id3Frames.length > 0) {
    chunks.push(riffChunk('ID3 ', id3Tag(id3Frames), false))
  }

  const body = Buffer.concat([Buffer.from('AIFF', 'latin1'), ...chunks])
  return Buffer.concat([Buffer.from('FORM', 'latin1'), uint32BE(body.length), body])
}

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

describe('T42 MP4 / M4A', () => {
  it('`moov` 在**文件尾**（> 64 KB 之外）也能读到标签', async () => {
    const file = mp4File({
      title: '示例歌名',
      artist: '示例歌手',
      album: '示例专辑',
      mdatSize: 70000,
      moovLast: true,
    })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.artist).toBe('示例歌手')
    expect(tags?.album).toBe('示例专辑')
  })

  it('歌名**不带控制字符**（`data` 的类型指示 / locale 不能混进文本）', async () => {
    const file = mp4File({ title: '示例歌名' })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.title?.charCodeAt(0)).toBe('示'.charCodeAt(0))
  })

  it('`data` 的 locale 非 0 → **载荷偏移**被钉死（不会把 locale 带进歌名）', async () => {
    // ⚠️ 真实文件（ffmpeg / iTunes）的 locale **恒为 0** → 偏移错了也看不出来
    //    （那 4 个 NUL 会被剔掉）→ 这条**故意用非 0 的 locale** 把偏移钉死。
    const file = mp4File({ title: '示例歌名', locale: 0x41424344 })

    const tags = await readTagsFromReader(bufferReader(file))

    // ⚠️ 载荷偏移错成 +4 → 歌名会变成 `"ABCD示例歌名"`。
    expect(tags?.title).toBe('示例歌名')
  })

  it('`mvhd` → **精确**时长（44100 Hz × 180 秒）', async () => {
    const file = mp4File({ timescale: 44100, duration: 44100 * 180 })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.duration).toBeCloseTo(180, 6)
  })

  it('`mvhd` v1（**64 位**时长）也认', async () => {
    const file = mp4File({ timescale: 48000, duration: 48000 * 90, mvhdVersion: 1 })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.duration).toBeCloseTo(90, 6)
  })

  it('没有 `ilst` → 只有时长，没有歌名', async () => {
    const file = mp4File({ timescale: 44100, duration: 44100 * 10 })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBeUndefined()
    expect(tags?.duration).toBeCloseTo(10, 6)
  })

  it('不是 MP4 → `parseMp4Tags` 返回 `null`（**不抛**）', async () => {
    const file = Buffer.from('RIFF____WAVE', 'latin1')

    expect(await parseMp4Tags(bufferReader(file), file)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

describe('T42 WAV', () => {
  it('`fmt ` + `data` → **精确**时长；`LIST INFO` → 标签', async () => {
    const file = wavFile({
      title: Buffer.from('示例歌名', 'utf8'),
      artist: Buffer.from('示例歌手', 'utf8'),
      album: Buffer.from('示例专辑', 'utf8'),
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
      dataSize: 16000,
    })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.artist).toBe('示例歌手')
    expect(tags?.album).toBe('示例专辑')
    // 16000 字节 ÷ 16000 字节/秒 = 1 秒
    expect(tags?.duration).toBeCloseTo(1, 6)
  })

  it('`LIST INFO` 在 **64 KB 之外**（`data` 撑开）→ 照样读得到', async () => {
    const file = wavFile({
      title: Buffer.from('示例歌名', 'utf8'),
      sampleRate: 8000,
      dataSize: 70000,
    })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.duration).toBeCloseTo(70000 / 16000, 6)
  })

  it('文本块按 C 字符串写 → **结尾的 NUL 要剔掉**', async () => {
    const file = wavFile({ title: Buffer.concat([Buffer.from('示例歌名', 'utf8'), Buffer.from([0])]) })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
  })

  it('老工具写的 **GBK** 标签 → UTF-8 解不出来要退 GBK', async () => {
    // 「中文」的 GBK 字节：D6 D0 CE C4（**不是**合法 UTF-8）。
    const file = wavFile({ title: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('中文')
  })

  it('**UTF-16（带 BOM）** 的 `LIST INFO` 也认', async () => {
    const file = wavFile({
      title: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('示例歌名', 'utf16le'),
      ]),
    })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
  })

  it('没有 `LIST INFO` → 只有时长，没有歌名', async () => {
    const file = wavFile({ sampleRate: 8000, dataSize: 8000 })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBeUndefined()
    expect(tags?.duration).toBeCloseTo(0.5, 6)
  })

  it('不是 WAV → `parseWavTags` 返回 `null`（**不抛**）', async () => {
    const file = Buffer.from('FORM____AIFF', 'latin1')

    expect(await parseWavTags(bufferReader(file), file)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AIFF / AIFC
// ---------------------------------------------------------------------------

describe('T42 AIFF', () => {
  it('`COMM` → **精确**时长（80 位扩展精度采样率）', async () => {
    const file = aiffFile({ sampleRate: 44100, frames: 132300 })

    const tags = await readTagsFromReader(bufferReader(file))

    // 132300 帧 ÷ 44100 Hz = 3 秒
    expect(tags?.duration).toBeCloseTo(3, 6)
  })

  it('`ID3 ` 块 → **复用** ID3v2 解析器出标签', async () => {
    const file = aiffFile({
      title: '示例歌名',
      artist: '示例歌手',
      album: '示例专辑',
      sampleRate: 44100,
      frames: 132300,
    })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
    expect(tags?.artist).toBe('示例歌手')
    expect(tags?.album).toBe('示例专辑')
    expect(tags?.duration).toBeCloseTo(3, 6)
  })

  it('`ID3 ` 在 **64 KB 之外**（`SSND` 撑开）→ 照样读得到', async () => {
    const file = aiffFile({
      title: '示例歌名',
      sampleRate: 44100,
      frames: 132300,
      ssndSize: 70000,
    })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBe('示例歌名')
  })

  it('没有 `ID3 ` 块 → 只有时长，没有歌名', async () => {
    const file = aiffFile({ sampleRate: 44100, frames: 44100, withId3: false })

    const tags = await readTagsFromReader(bufferReader(file))

    expect(tags?.title).toBeUndefined()
    expect(tags?.duration).toBeCloseTo(1, 6)
  })

  it('不是 AIFF → `parseAiffTags` 返回 `null`（**不抛**）', async () => {
    const file = Buffer.from('RIFF____WAVE', 'latin1')

    expect(await parseAiffTags(bufferReader(file), file)).toBeNull()
  })
})
