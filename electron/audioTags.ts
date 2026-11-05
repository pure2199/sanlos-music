// ---------------------------------------------------------------------------
// 音频标签解析（T39，**主进程**）
// ---------------------------------------------------------------------------
//
// 职责
// - 从本地音频文件里读出**内嵌标签**：歌名、歌手、专辑、时长；
// - 解析器是**纯函数**（输入字节 → 输出结构化标签），**不碰 fs、不碰 Electron**；
// - 「读文件」那一层由调用方注入（`TagFileSystem`）→ 单测喂内存字节，
//   **不碰真实磁盘**。
//
// 为什么手写
// - **不引新 npm 依赖**（硬约束）→ `music-metadata` / `node-id3` 之类一律不用；
// - 手写也让我们**只读需要的字节**（头 64 KB / 尾 64 KB），不去扫整个文件。
//
// 覆盖的容器
// - **ID3v2**（mp3）：`TIT2` / `TPE1` / `TALB`；时长走 `Xing` / `Info` 帧计数，
//   没有就按 CBR 估算；
// - **FLAC**：`STREAMINFO`（时长）+ `VORBIS_COMMENT`（歌名 / 歌手 / 专辑）；
// - **Ogg**（Vorbis / Opus）：识别头 + 注释头；时长走**末页 granule**。
//
// ⚠️ **不认识就返回 `null`**：调用方退回「文件名反推」，**绝不抛**。
//
// ⚠️ **模块顶层不得 import Electron**（同 `electron/localLibrary.ts` 的约束）→
//    单测能跑在普通 Node（Vitest）里。
// ---------------------------------------------------------------------------

import { parseTrackFileName } from '../shared/localMeta'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 解析出来的标签。
 *
 * ⚠️ **字段都可能缺**：文件里没有对应帧就是 `undefined`（不是空串）。
 */
export interface AudioTags {
  /** 歌名。 */
  title?: string
  /** 歌手名。 */
  artist?: string
  /** 专辑名。 */
  album?: string
  /** 时长（**秒**）。 */
  duration?: number
}

/**
 * 「读一段字节」的最小接口。
 *
 * ⚠️ `read()` 返回的缓冲区**可能比要求短**——到文件尾为止。
 */
export interface TagReader {
  /** 文件总字节数。 */
  readonly size: number
  /** 读一段字节（**绝对偏移**）。 */
  read(offset: number, length: number): Promise<Buffer>
}

/**
 * 文件系统的最小接口（**只读**，不写不删）。
 */
export interface TagFileSystem {
  /** 读一段字节。 */
  readBytes(path: string, offset: number, length: number): Promise<Buffer>
  /** 取文件大小；**不是文件 / 不存在**都返回 `null`。 */
  statSize(path: string): Promise<number | null>
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 文件头读取上限（字节）。 */
export const TAG_HEAD_BYTES = 64 * 1024

/** 文件尾读取上限（字节）——Ogg 的末页 granule 在这里。 */
export const TAG_TAIL_BYTES = 64 * 1024

/** 元数据块的续读上限（字节）——FLAC 的 `PICTURE` 块可能很大。 */
export const TAG_METADATA_MAX_BYTES = 2 * 1024 * 1024

/** ID3 标签体的读取上限（字节）。 */
export const TAG_ID3_MAX_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// 字节工具
// ---------------------------------------------------------------------------

/**
 * 取缓冲区第 `index` 个字节；**越界返回 0**。
 *
 * ⚠️ `noUncheckedIndexedAccess` 下 `buffer[i]` 是 `number | undefined` →
 *    全部走这个函数，省得到处写 `?? 0`。
 */
function byteAt(buffer: Buffer, index: number): number {
  const value = buffer[index]
  return typeof value === 'number' ? value : 0
}

/** 读 4 字节大端无符号整数。 */
function readUint32BE(buffer: Buffer, offset: number): number {
  return (
    byteAt(buffer, offset) * 0x1000000 +
    (byteAt(buffer, offset + 1) << 16) +
    (byteAt(buffer, offset + 2) << 8) +
    byteAt(buffer, offset + 3)
  ) >>> 0
}

/** 读 4 字节小端无符号整数。 */
function readUint32LE(buffer: Buffer, offset: number): number {
  return (
    byteAt(buffer, offset) +
    byteAt(buffer, offset + 1) * 0x100 +
    byteAt(buffer, offset + 2) * 0x10000 +
    byteAt(buffer, offset + 3) * 0x1000000
  ) >>> 0
}

/** 读 3 字节大端无符号整数。 */
function readUint24BE(buffer: Buffer, offset: number): number {
  return (
    (byteAt(buffer, offset) << 16) | (byteAt(buffer, offset + 1) << 8) | byteAt(buffer, offset + 2)
  )
}

/** 读 4 字节「同步安全」整数（每字节只用低 7 位，ID3 用）。 */
function readSynchsafe(buffer: Buffer, offset: number): number {
  return (
    (byteAt(buffer, offset) & 0x7f) * 0x200000 +
    (byteAt(buffer, offset + 1) & 0x7f) * 0x4000 +
    (byteAt(buffer, offset + 2) & 0x7f) * 0x80 +
    (byteAt(buffer, offset + 3) & 0x7f)
  )
}

/** 读 8 字节小端整数（Ogg 的 granule）。 */
function readUint64LE(buffer: Buffer, offset: number): number {
  let value = 0n
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(byteAt(buffer, offset + i))
  }
  // ⚠️ `0xFFFF_FFFF_FFFF_FFFF` = 「本页没有完整包」→ 未知。
  if (value === 0xffffffffffffffffn) return -1
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return -1
  return Number(value)
}

/** 把 UTF-16BE 的字节对调成 UTF-16LE（Node 只认 `utf16le`）。 */
function swapBytes16(bytes: Buffer): Buffer {
  const length = bytes.length - (bytes.length % 2)
  const out = Buffer.allocUnsafe(length)
  for (let i = 0; i + 1 < length; i += 2) {
    out[i] = byteAt(bytes, i + 1)
    out[i + 1] = byteAt(bytes, i)
  }
  return out
}

/** 去掉 ID3v2 的 unsynchronisation 填充（`FF 00` → `FF`）。 */
function deunsynchronise(data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length)
  let written = 0
  for (let i = 0; i < data.length; i++) {
    const value = byteAt(data, i)
    out[written] = value
    written += 1
    if (value === 0xff && byteAt(data, i + 1) === 0x00) i += 1
  }
  return out.subarray(0, written)
}

/**
 * 按 ID3v2 的编码字节解码文本。
 *
 * - `0` = ISO-8859-1；`1` = UTF-16（**带 BOM**）；`2` = UTF-16BE；`3` = UTF-8。
 */
function decodeText(bytes: Buffer, encoding: number): string {
  switch (encoding) {
    case 0:
      return bytes.toString('latin1')
    case 1: {
      if (bytes.length >= 2) {
        const b0 = byteAt(bytes, 0)
        const b1 = byteAt(bytes, 1)
        if (b0 === 0xff && b1 === 0xfe) return bytes.subarray(2).toString('utf16le')
        if (b0 === 0xfe && b1 === 0xff) return swapBytes16(bytes.subarray(2)).toString('utf16le')
      }
      return bytes.toString('utf16le')
    }
    case 2:
      return swapBytes16(bytes).toString('utf16le')
    default:
      return bytes.toString('utf8')
  }
}

/**
 * 解一个 ID3v2 文本帧。
 *
 * ⚠️ 一个帧里可能有多个值（用 `\0` 分隔）→ **取第一个非空**。
 */
function decodeTextFrame(data: Buffer): string {
  if (data.length === 0) return ''
  const body = data.subarray(1)
  const text = decodeText(body, byteAt(data, 0))
  for (const part of text.split('\u0000')) {
    const trimmed = part.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

// ---------------------------------------------------------------------------
// ID3v2
// ---------------------------------------------------------------------------

/** ID3v2 解析结果。 */
export interface Id3v2Result extends AudioTags {
  /** 标签总长度（**含 10 字节头**）；没有标签时为 `0`。 */
  tagSize: number
}

/** 判断缓冲区是不是以 `ID3` 开头。 */
export function isId3Magic(buffer: Buffer): boolean {
  return byteAt(buffer, 0) === 0x49 && byteAt(buffer, 1) === 0x44 && byteAt(buffer, 2) === 0x33
}

/**
 * ID3 标签的总长度（**含 10 字节头**）。
 *
 * ⚠️ 不是 ID3 / 头不完整 → `0`。
 */
export function id3TagSize(buffer: Buffer): number {
  if (buffer.length < 10 || !isId3Magic(buffer)) return 0
  const flags = byteAt(buffer, 5)
  return 10 + readSynchsafe(buffer, 6) + ((flags & 0x10) !== 0 ? 10 : 0)
}

/**
 * 解析 ID3v2 标签（**纯函数**：只吃字节）。
 *
 * ⚠️ 支持 v2.2（3 字符帧 ID）/ v2.3 / v2.4。
 * ⚠️ **整段 unsynchronisation（头标志 `0x80`）不做反同步** → 直接放弃
 *    （帧边界不可靠，猜出来的歌名比文件名更糟）。
 *
 * @param buffer 文件头（**至少要含完整的 10 字节标签头**）。
 */
export function parseId3v2(buffer: Buffer): Id3v2Result {
  const empty: Id3v2Result = { tagSize: 0 }
  if (buffer.length < 10) return empty
  if (!isId3Magic(buffer)) return empty

  const major = byteAt(buffer, 3)
  if (major < 2 || major > 4) return empty
  const flags = byteAt(buffer, 5)
  const bodySize = readSynchsafe(buffer, 6)
  const tagSize = 10 + bodySize + ((flags & 0x10) !== 0 ? 10 : 0)
  // ⚠️ 整段 unsynchronisation → **放弃读标签**，但**标签长度仍然要给**：
  //    音频数据的起点靠它算，不然时长会算到标签头上（出来一个离谱的值）。
  if ((flags & 0x80) !== 0) return { tagSize }

  const tags: AudioTags = {}

  let offset = 10
  // 扩展头：v2.3 的长度**含**自身那 4 字节；v2.4 的**不含**。
  if ((flags & 0x40) !== 0) {
    if (major === 4) {
      offset += 4 + readSynchsafe(buffer, offset)
    } else {
      offset += readUint32BE(buffer, offset)
    }
  }

  const idLength = major === 2 ? 3 : 4
  const sizeLength = major === 2 ? 3 : 4
  const flagLength = major === 2 ? 0 : 2
  const frameHeaderLength = idLength + sizeLength + flagLength
  const limit = Math.min(buffer.length, tagSize)

  while (offset + frameHeaderLength <= limit) {
    const id = buffer.subarray(offset, offset + idLength).toString('latin1')
    // 填充区 / 坏数据 → 停。
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break

    let size = 0
    if (major === 2) {
      size = readUint24BE(buffer, offset + idLength)
    } else if (major === 4) {
      size = readSynchsafe(buffer, offset + idLength)
    } else {
      size = readUint32BE(buffer, offset + idLength)
    }

    const dataStart = offset + frameHeaderLength
    if (size <= 0 || dataStart + size > limit) break

    let data = buffer.subarray(dataStart, dataStart + size)
    if (major === 4) {
      const frameFlags =
        (byteAt(buffer, offset + idLength + sizeLength) << 8) |
        byteAt(buffer, offset + idLength + sizeLength + 1)
      const compression = (frameFlags & 0x0008) !== 0
      const encryption = (frameFlags & 0x0004) !== 0
      const unsynchronisation = (frameFlags & 0x0002) !== 0
      const dataLengthIndicator = (frameFlags & 0x0001) !== 0
      // 压缩 / 加密的帧解不开 → 跳过这一帧（长度已知，能正确跳到下一帧）。
      if (compression || encryption) {
        offset = dataStart + size
        continue
      }
      if (unsynchronisation) data = deunsynchronise(data)
      // 数据长度指示符占帧数据开头的 4 字节。
      if (dataLengthIndicator && data.length >= 4) data = data.subarray(4)
    } else if (major === 3) {
      const frameFlags = byteAt(buffer, offset + idLength + sizeLength)
      const compression = (frameFlags & 0x0080) !== 0
      const encryption = (frameFlags & 0x0040) !== 0
      if (compression || encryption) {
        offset = dataStart + size
        continue
      }
    }

    if (id === 'TIT2' || id === 'TT2') {
      if (!tags.title) tags.title = decodeTextFrame(data)
    } else if (id === 'TPE1' || id === 'TP1' || id === 'TPE2' || id === 'TP2') {
      if (!tags.artist) tags.artist = decodeTextFrame(data)
    } else if (id === 'TALB' || id === 'TAL') {
      if (!tags.album) tags.album = decodeTextFrame(data)
    }

    offset = dataStart + size
  }

  return { title: tags.title, artist: tags.artist, album: tags.album, tagSize }
}

// ---------------------------------------------------------------------------
// MPEG 音频帧（mp3 时长）
// ---------------------------------------------------------------------------

/** MPEG 各层的比特率表（kbps）。索引 0 与 15 表示「无效」。 */
const BITRATE_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0]
const BITRATE_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0]
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATE_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0]
const BITRATE_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

/** MPEG 帧头解析结果。 */
interface MpegFrame {
  /** 版本：`1` / `2` / `2.5`。 */
  version: number
  /** 层：`1` / `2` / `3`。 */
  layer: number
  /** 比特率（kbps）。 */
  bitrate: number
  /** 采样率（Hz）。 */
  sampleRate: number
  /** 声道数。 */
  channels: number
  /** 每帧采样数。 */
  samplesPerFrame: number
  /** 边信息长度（`Xing` 头的位置靠它算）。 */
  sideInfoLength: number
}

/**
 * 解析一个 MPEG 音频帧头。
 *
 * @param buffer 缓冲区。
 * @param offset 帧头位置。
 * @returns 帧信息；位置不对 / 不是有效帧头 → `null`。
 */
export function parseMpegFrameHeader(buffer: Buffer, offset: number): MpegFrame | null {
  if (offset + 4 > buffer.length) return null
  if (byteAt(buffer, offset) !== 0xff) return null
  const b1 = byteAt(buffer, offset + 1)
  if ((b1 & 0xe0) !== 0xe0) return null

  const versionBits = (b1 >> 3) & 0x03
  if (versionBits === 1) return null
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5

  const layerBits = (b1 >> 1) & 0x03
  if (layerBits === 0) return null
  const layer = 4 - layerBits

  const b2 = byteAt(buffer, offset + 2)
  const bitrateIndex = (b2 >> 4) & 0x0f
  const sampleRateIndex = (b2 >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null

  const b3 = byteAt(buffer, offset + 3)
  const channels = ((b3 >> 6) & 0x03) === 3 ? 1 : 2

  const table =
    version === 1
      ? layer === 1
        ? BITRATE_V1_L1
        : layer === 2
          ? BITRATE_V1_L2
          : BITRATE_V1_L3
      : layer === 1
        ? BITRATE_V2_L1
        : BITRATE_V2_L23
  const bitrate = table[bitrateIndex] ?? 0

  const sampleRates =
    version === 1 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000]
  const sampleRate = sampleRates[sampleRateIndex] ?? 0
  if (bitrate <= 0 || sampleRate <= 0) return null

  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576
  const sideInfoLength = version === 1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17

  return { version, layer, bitrate, sampleRate, channels, samplesPerFrame, sideInfoLength }
}

/** 在缓冲区里找第一个有效的 MPEG 帧头。 */
function findMpegFrame(buffer: Buffer): MpegFrame | null {
  const limit = Math.min(buffer.length - 4, 4096)
  for (let i = 0; i <= limit; i++) {
    const frame = parseMpegFrameHeader(buffer, i)
    if (frame) return frame
  }
  return null
}

/**
 * 读 MPEG 音频的时长（**秒**）。
 *
 * - 有 `Xing` / `Info` 头 → 用帧数算（**精确**）；
 * - 没有 → 按 CBR 估算（**近似**，±1 秒）。
 *
 * @param reader 读取器。
 * @param audioOffset 音频数据起点（= 标签长度）。
 * @param fileSize 文件总字节数。
 */
export async function readMpegDuration(
  reader: TagReader,
  audioOffset: number,
  fileSize: number,
): Promise<number | undefined> {
  const chunk = await reader.read(audioOffset, 8192)
  const frame = findMpegFrame(chunk)
  if (!frame) return undefined

  // `Xing` / `Info` 头：帧头（4 字节）+ 边信息。
  const markerOffset = 4 + frame.sideInfoLength
  const marker = chunk.subarray(markerOffset, markerOffset + 4).toString('latin1')
  if (marker === 'Xing' || marker === 'Info') {
    const flags = readUint32BE(chunk, markerOffset + 4)
    if ((flags & 0x0001) !== 0) {
      const frames = readUint32BE(chunk, markerOffset + 8)
      if (frames > 0) return (frames * frame.samplesPerFrame) / frame.sampleRate
    }
  }

  // CBR 估算：字节数 × 8 ÷ 比特率。
  const bytes = fileSize - audioOffset
  if (bytes > 0 && frame.bitrate > 0) return (bytes * 8) / (frame.bitrate * 1000)
  return undefined
}

// ---------------------------------------------------------------------------
// Vorbis Comment（FLAC 与 Ogg 共用）
// ---------------------------------------------------------------------------

/**
 * 解析 Vorbis Comment 块。
 *
 * @param data 注释块**本体**（不含 FLAC 的块头，也不含 Ogg 的包头）。
 * @returns 键（大写）→ 值；同一个键只取**第一个**。
 */
export function parseVorbisCommentBlock(data: Buffer): Map<string, string> {
  const result = new Map<string, string>()
  if (data.length < 8) return result

  let offset = 0
  const vendorLength = readUint32LE(data, offset)
  offset += 4 + vendorLength
  if (offset + 4 > data.length) return result

  const count = readUint32LE(data, offset)
  offset += 4
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.length) break
    const length = readUint32LE(data, offset)
    offset += 4
    if (length <= 0 || offset + length > data.length) break
    const comment = data.subarray(offset, offset + length).toString('utf8')
    offset += length
    const eq = comment.indexOf('=')
    if (eq <= 0) continue
    const key = comment.slice(0, eq).trim().toUpperCase()
    const value = comment.slice(eq + 1).trim()
    if (key.length === 0 || value.length === 0) continue
    if (!result.has(key)) result.set(key, value)
  }
  return result
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

/** 判断缓冲区是不是以 `fLaC` 开头。 */
export function isFlacMagic(buffer: Buffer): boolean {
  return (
    byteAt(buffer, 0) === 0x66 &&
    byteAt(buffer, 1) === 0x4c &&
    byteAt(buffer, 2) === 0x61 &&
    byteAt(buffer, 3) === 0x43
  )
}

/**
 * 解析 FLAC 元数据。
 *
 * ⚠️ `STREAMINFO` 给**精确**时长（总采样数 ÷ 采样率）。
 * ⚠️ `VORBIS_COMMENT` 给歌名 / 歌手 / 专辑。
 * ⚠️ `PICTURE` 块可能很大 → 读不够就**续读**（上限 `TAG_METADATA_MAX_BYTES`）。
 *
 * @param reader 读取器。
 * @param head 已经读好的文件头。
 */
export async function parseFlacTags(reader: TagReader, head: Buffer): Promise<AudioTags | null> {
  if (!isFlacMagic(head)) return null

  let buffer = head
  let offset = 4
  let sampleRate = 0
  let totalSamples = 0
  let comments: Map<string, string> | null = null

  for (let guard = 0; guard < 256; guard++) {
    if (offset + 4 > buffer.length) {
      const next = await readMore(reader, buffer)
      if (!next) break
      buffer = next
      continue
    }
    const header = byteAt(buffer, offset)
    const isLast = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = readUint24BE(buffer, offset + 1)
    const bodyStart = offset + 4

    if (bodyStart + length > buffer.length) {
      const next = await readMore(reader, buffer)
      if (!next) break
      buffer = next
      continue
    }

    if (type === 0) {
      // STREAMINFO：采样率（20 位）+ 总采样数（36 位）。
      sampleRate =
        (byteAt(buffer, bodyStart + 10) << 12) |
        (byteAt(buffer, bodyStart + 11) << 4) |
        (byteAt(buffer, bodyStart + 12) >> 4)
      totalSamples =
        (byteAt(buffer, bodyStart + 13) & 0x0f) * 4294967296 +
        byteAt(buffer, bodyStart + 14) * 0x1000000 +
        (byteAt(buffer, bodyStart + 15) << 16) +
        (byteAt(buffer, bodyStart + 16) << 8) +
        byteAt(buffer, bodyStart + 17)
    } else if (type === 4) {
      comments = parseVorbisCommentBlock(buffer.subarray(bodyStart, bodyStart + length))
    }

    offset = bodyStart + length
    if (isLast) break
  }

  const tags: AudioTags = {}
  if (comments) {
    const title = comments.get('TITLE')
    const artist = comments.get('ARTIST')
    const album = comments.get('ALBUM')
    if (title) tags.title = title
    if (artist) tags.artist = artist
    if (album) tags.album = album
  }
  if (sampleRate > 0 && totalSamples > 0) {
    tags.duration = totalSamples / sampleRate
  }
  return tags
}

/**
 * 续读一段字节并**追加**到已有缓冲区。
 *
 * ⚠️ **返回新缓冲区**（不是就地改）——调用方必须把返回值赋回去。
 *
 * @returns 追加后的缓冲区；读不到 / 超上限 → `null`。
 */
async function readMore(reader: TagReader, buffer: Buffer): Promise<Buffer | null> {
  if (buffer.length >= TAG_METADATA_MAX_BYTES) return null
  const more = await reader.read(buffer.length, TAG_HEAD_BYTES)
  if (more.length === 0) return null
  return Buffer.concat([buffer, more])
}

// ---------------------------------------------------------------------------
// Ogg（Vorbis / Opus）
// ---------------------------------------------------------------------------

/** 判断缓冲区是不是以 `OggS` 开头。 */
export function isOggMagic(buffer: Buffer): boolean {
  return (
    byteAt(buffer, 0) === 0x4f &&
    byteAt(buffer, 1) === 0x67 &&
    byteAt(buffer, 2) === 0x67 &&
    byteAt(buffer, 3) === 0x53
  )
}

/** 判断是不是 Opus 的识别头（`OpusHead`）。 */
export function isOpusHead(packet: Buffer): boolean {
  return packet.subarray(0, 8).toString('latin1') === 'OpusHead'
}

/** 判断是不是 Opus 的注释包头（`OpusTags`）。 */
export function isOpusTags(packet: Buffer): boolean {
  return packet.subarray(0, 8).toString('latin1') === 'OpusTags'
}

/** 判断是不是 Vorbis 的识别头（`0x01` + `vorbis`）。 */
export function isVorbisIdent(packet: Buffer): boolean {
  return byteAt(packet, 0) === 0x01 && packet.subarray(1, 7).toString('latin1') === 'vorbis'
}

/** 判断是不是 Vorbis 的注释包头（`0x03` + `vorbis`）。 */
export function isVorbisComment(packet: Buffer): boolean {
  return byteAt(packet, 0) === 0x03 && packet.subarray(1, 7).toString('latin1') === 'vorbis'
}

/**
 * 从 Ogg 页序列里取出前几个**完整的包**。
 *
 * ⚠️ 一个包可以跨页（分段表里长度 255 表示「还在继续」）→ 这里按 Ogg 的
 *    分段规则把包重新拼起来。
 */
export async function readOggPackets(
  reader: TagReader,
  head: Buffer,
  maxPackets: number,
): Promise<Buffer[]> {
  let buffer = head
  const packets: Buffer[] = []
  let offset = 0
  let current: Buffer[] = []

  for (let guard = 0; guard < 512; guard++) {
    if (offset + 27 > buffer.length) {
      const next = await readMore(reader, buffer)
      if (!next) break
      buffer = next
      continue
    }
    if (!isOggMagic(buffer.subarray(offset, offset + 4))) break
    if (byteAt(buffer, offset + 4) !== 0) break

    const segmentCount = byteAt(buffer, offset + 26)
    const tableStart = offset + 27
    const dataStart = tableStart + segmentCount
    if (dataStart > buffer.length) {
      const next = await readMore(reader, buffer)
      if (!next) break
      buffer = next
      continue
    }

    // ⚠️ **先算这一页总共多少数据**，不够就**先续读**再切分——
    //    否则会把不完整的数据当成完整的一段切出去（包就废了）。
    let dataLength = 0
    for (let i = 0; i < segmentCount; i++) {
      dataLength += byteAt(buffer, tableStart + i)
    }
    if (dataStart + dataLength > buffer.length) {
      const next = await readMore(reader, buffer)
      if (!next) break
      buffer = next
      continue
    }

    let dataOffset = dataStart
    for (let i = 0; i < segmentCount; i++) {
      const segmentLength = byteAt(buffer, tableStart + i)
      current.push(buffer.subarray(dataOffset, dataOffset + segmentLength))
      dataOffset += segmentLength
      if (segmentLength < 255) {
        packets.push(Buffer.concat(current))
        current = []
        if (packets.length >= maxPackets) return packets
      }
    }
    offset = dataOffset
  }
  return packets
}

/**
 * 从文件尾里找**最后一个** Ogg 页的 granule 位置。
 *
 * ⚠️ granule 在页头的第 6~13 字节 → 只要页头在尾部缓冲区里就够了。
 *
 * @returns granule 位置；找不到 / 无效 → `-1`。
 */
export function lastOggGranule(buffer: Buffer): number {
  for (let i = buffer.length - 4; i >= 0; i--) {
    if (
      byteAt(buffer, i) === 0x4f &&
      byteAt(buffer, i + 1) === 0x67 &&
      byteAt(buffer, i + 2) === 0x67 &&
      byteAt(buffer, i + 3) === 0x53
    ) {
      // 版本字节必须是 0。
      if (byteAt(buffer, i + 4) !== 0) continue
      const granule = readUint64LE(buffer, i + 6)
      if (granule >= 0) return granule
    }
  }
  return -1
}

/**
 * 解析 Ogg（Vorbis / Opus）的标签。
 *
 * ⚠️ 时长走**末页 granule**：Vorbis 是采样数（÷ 采样率），Opus 是 48 kHz
 *    采样数（减掉 preSkip 后 ÷ 48000）。
 *
 * @param reader 读取器。
 * @param head 已经读好的文件头。
 */
export async function parseOggTags(reader: TagReader, head: Buffer): Promise<AudioTags | null> {
  if (!isOggMagic(head)) return null

  const packets = await readOggPackets(reader, head, 3)
  const ident = packets[0]
  const commentPacket = packets[1]
  if (!ident || !commentPacket) return null

  let sampleRate = 0
  let preSkip = 0
  let isOpus = false

  if (isOpusHead(ident)) {
    isOpus = true
    preSkip = byteAt(ident, 10) | (byteAt(ident, 11) << 8)
  } else if (isVorbisIdent(ident)) {
    sampleRate = readUint32LE(ident, 12)
  } else {
    return null
  }

  let comments: Map<string, string>
  if (isOpus) {
    if (!isOpusTags(commentPacket)) return null
    comments = parseVorbisCommentBlock(commentPacket.subarray(8))
  } else {
    if (!isVorbisComment(commentPacket)) return null
    comments = parseVorbisCommentBlock(commentPacket.subarray(7))
  }

  const tags: AudioTags = {}
  const title = comments.get('TITLE')
  const artist = comments.get('ARTIST')
  const album = comments.get('ALBUM')
  if (title) tags.title = title
  if (artist) tags.artist = artist
  if (album) tags.album = album

  // 时长：末页 granule。
  const tailStart = Math.max(0, reader.size - TAG_TAIL_BYTES)
  const tail = await reader.read(tailStart, TAG_TAIL_BYTES)
  const granule = lastOggGranule(tail)
  if (granule > 0) {
    if (isOpus) {
      const samples = Math.max(0, granule - preSkip)
      if (samples > 0) tags.duration = samples / 48000
    } else if (sampleRate > 0) {
      tags.duration = granule / sampleRate
    }
  }

  return tags
}

// ---------------------------------------------------------------------------
// 文本解码（MP4 / WAV / AIFF 共用）
// ---------------------------------------------------------------------------

/**
 * 解码一段文本（**UTF-8 优先**）。
 *
 * ⚠️ WAV 的 `LIST INFO` 与 MP4 的 `ilst` 里**中文字幕常见 GBK**（老工具写的）
 *    → UTF-8 解不出来（严格模式会抛）→ 退到 GBK，再退到 Latin-1（至少不炸）。
 */
function decodeContainerText(bytes: Buffer): string {
  if (bytes.length === 0) return ''
  // ⚠️ **UTF-16（带 BOM）**：Windows 的工具写 WAV `LIST INFO` 时常见。
  if (bytes.length >= 2) {
    const b0 = byteAt(bytes, 0)
    const b1 = byteAt(bytes, 1)
    if (b0 === 0xff && b1 === 0xfe) return cleanText(bytes.subarray(2).toString('utf16le'))
    if (b0 === 0xfe && b1 === 0xff) return cleanText(swapBytes16(bytes.subarray(2)).toString('utf16le'))
  }
  try {
    return cleanText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    try {
      return cleanText(new TextDecoder('gbk').decode(bytes))
    } catch {
      return cleanText(bytes.toString('latin1'))
    }
  }
}

/**
 * 清掉文本里的 **NUL 填充**，再 trim。
 *
 * ⚠️ WAV `LIST INFO` 的文本块长度常常**含结尾的 NUL**（按 C 字符串写的）
 *    → `String.trim()` **不删 NUL** → 必须先剔掉，否则歌名会带上看不见的 `\0`。
 */
function cleanText(value: string): string {
  return value.replace(/\u0000/g, '').trim()
}

// ---------------------------------------------------------------------------
// MP4 / M4A（ISO BMFF 容器）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独写**：M4A 是 iTunes 系的容器，标签在 `moov.udta.meta.ilst` 里，
//    字段名是**带 © 的四字节码**（`©nam` / `©ART` / `©alb`）→ 和 ID3 的 `TIT2`
//    完全不是一套，**复用不了** ID3 解析器。
//
// ⚠️ **`moov` 常在文件尾**：不流式写入的 mp4/m4a 会把索引放在末尾
//    → 只能**走顶层原子表按偏移找**（`reader.read(offset, len)`），只读文件头会漏。
//
// ⚠️ **字节预算**：元数据块续读沿用 `TAG_METADATA_MAX_BYTES`（2 MB）
//    → 超了只吃前面的部分（宁可少读，也不把内存吃穿）。

/** MP4 / M4A 的顶层原子类型（位于字节 4~8）。 */
function isMp4Magic(buffer: Buffer): boolean {
  if (buffer.length < 8) return false
  const type = buffer.subarray(4, 8).toString('latin1')
  return type === 'ftyp' || type === 'moov' || type === 'styp' || type === 'mdat'
}

/** 一个 MP4 原子（盒子）。 */
interface Mp4Atom {
  /** 原子类型（4 字节 ASCII）。 */
  type: string
  /** 原子**内容**的起始偏移。 */
  contentOffset: number
  /** 原子内容长度（字节）。 */
  contentSize: number
}

/** 读一个大端 64 位整数（原子长度可能超过 32 位）。 */
function readUint64BE(buffer: Buffer, offset: number): number {
  return readUint32BE(buffer, offset) * 4294967296 + readUint32BE(buffer, offset + 4)
}

/** 读一个 MP4 原子的头（**在内存缓冲里**；偏移相对缓冲起点）。 */
function readMp4AtomIn(buffer: Buffer, offset: number): Mp4Atom | null {
  if (offset < 0 || offset + 8 > buffer.length) return null
  const size = readUint32BE(buffer, offset)
  const type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
  let headerSize = 8
  let contentSize = size
  if (size === 1) {
    // 64 位长度（largesize）。
    if (offset + 16 > buffer.length) return null
    contentSize = readUint64BE(buffer, offset + 8)
    headerSize = 16
  } else if (size === 0) {
    // 长度 0 = 延伸到文件尾。
    contentSize = buffer.length - offset
  }
  if (contentSize < headerSize) return null
  return { type, contentOffset: offset + headerSize, contentSize: contentSize - headerSize }
}

/** 在**内存缓冲**里找**第一个**指定类型的原子（**不递归**）。 */
function findMp4AtomIn(
  buffer: Buffer,
  start: number,
  end: number,
  type: string,
): Mp4Atom | null {
  let offset = start
  while (offset + 8 <= end) {
    const atom = readMp4AtomIn(buffer, offset)
    if (!atom) return null
    if (atom.type === type) return atom
    const next = atom.contentOffset + atom.contentSize
    // ⚠️ 防死循环（长度异常时 `next` 可能 ≤ `offset`）。
    if (next <= offset) return null
    offset = next
  }
  return null
}

/** 读一个 MP4 原子的头（**按文件偏移**，用读取器）。 */
async function readMp4Atom(reader: TagReader, offset: number): Promise<Mp4Atom | null> {
  if (offset < 0 || offset + 8 > reader.size) return null
  const header = await reader.read(offset, Math.min(16, reader.size - offset))
  if (header.length < 8) return null
  let size = readUint32BE(header, 0)
  const type = header.subarray(4, 8).toString('latin1')
  let headerSize = 8
  if (size === 1) {
    if (header.length < 16) return null
    size = readUint64BE(header, 8)
    headerSize = 16
  } else if (size === 0) {
    size = reader.size - offset
  }
  if (size < headerSize) return null
  return { type, contentOffset: offset + headerSize, contentSize: size - headerSize }
}

/** 按文件偏移在 `[start, end)` 区间里找**第一个**指定类型的原子（**不递归**）。 */
async function findMp4Atom(
  reader: TagReader,
  start: number,
  end: number,
  type: string,
): Promise<Mp4Atom | null> {
  let offset = start
  while (offset + 8 <= end) {
    const atom = await readMp4Atom(reader, offset)
    if (!atom) return null
    if (atom.type === type) return atom
    const next = atom.contentOffset + atom.contentSize
    if (next <= offset) return null
    offset = next
  }
  return null
}

/** MP4 的 iTunes 标签码（`©` 在 latin1 里是 0xA9）。 */
const MP4_TAG_TITLE = '\u00a9nam'
const MP4_TAG_ARTIST = '\u00a9ART'
const MP4_TAG_ALBUM = '\u00a9alb'

/** 解析 `ilst` 里的条目 → 标签码 → 文本值。 */
function parseMp4Ilst(buffer: Buffer, ilst: Mp4Atom): Map<string, string> {
  const result = new Map<string, string>()
  const end = ilst.contentOffset + ilst.contentSize
  let offset = ilst.contentOffset
  while (offset + 8 <= end) {
    const item = readMp4AtomIn(buffer, offset)
    if (!item) break
    // 条目里是 `data` 原子：size + 'data' + 4 字节（类型 + 语言） + 内容。
    const data = readMp4AtomIn(buffer, item.contentOffset)
    // ⚠️ `data` 的载荷前有 **8 字节**：4 字节类型指示（`00 00 00 01` = UTF-8）
    //    + 4 字节 locale → 载荷从 `contentOffset + 8` 开始（真实 m4a 字节核对过）。
    if (data && data.type === 'data' && data.contentSize > 8) {
      const value = decodeContainerText(
        buffer.subarray(data.contentOffset + 8, data.contentOffset + data.contentSize),
      )
      if (value.length > 0) result.set(item.type, value)
    }
    const next = item.contentOffset + item.contentSize
    if (next <= offset) break
    offset = next
  }
  return result
}

/**
 * 解析 MP4 / M4A 的标签。
 *
 * @param reader 读取器。
 * @param head 已经读好的文件头。
 */
export async function parseMp4Tags(reader: TagReader, head: Buffer): Promise<AudioTags | null> {
  if (!isMp4Magic(head)) return null

  // ⚠️ **`moov` 可能在文件尾** → 必须按偏移找，不能只看文件头。
  const moov = await findMp4Atom(reader, 0, reader.size, 'moov')
  if (!moov) return null
  const size = Math.min(moov.contentSize, TAG_METADATA_MAX_BYTES)
  const buffer = await reader.read(moov.contentOffset, size)
  if (buffer.length < 8) return null

  const tags: AudioTags = {}

  // --- 时长：moov → mvhd ---
  const mvhd = findMp4AtomIn(buffer, 0, buffer.length, 'mvhd')
  if (mvhd) {
    const c = mvhd.contentOffset
    const version = byteAt(buffer, c)
    // v0：timescale / duration 各 4 字节；v1：各 8 字节（时间戳也是 8 字节）。
    const timescale = version === 1 ? readUint32BE(buffer, c + 20) : readUint32BE(buffer, c + 12)
    const duration = version === 1 ? readUint64BE(buffer, c + 24) : readUint32BE(buffer, c + 16)
    if (timescale > 0 && duration > 0) tags.duration = duration / timescale
  }

  // --- 标签：moov → udta → meta → ilst ---
  const udta = findMp4AtomIn(buffer, 0, buffer.length, 'udta')
  if (udta) {
    const udtaEnd = udta.contentOffset + udta.contentSize
    const meta = findMp4AtomIn(buffer, udta.contentOffset, udtaEnd, 'meta')
    if (meta) {
      // ⚠️ `meta` 是 FullBox：头 4 字节是 version + flags → 子原子从 +4 开始。
      const metaStart = meta.contentOffset + 4
      const ilst = findMp4AtomIn(buffer, metaStart, meta.contentOffset + meta.contentSize, 'ilst')
      if (ilst) {
        const items = parseMp4Ilst(buffer, ilst)
        const title = items.get(MP4_TAG_TITLE)
        const artist = items.get(MP4_TAG_ARTIST)
        const album = items.get(MP4_TAG_ALBUM)
        if (title) tags.title = title
        if (artist) tags.artist = artist
        if (album) tags.album = album
      }
    }
  }

  return tags
}

// ---------------------------------------------------------------------------
// RIFF 家族（WAV / AIFF 共用的块结构）
// ---------------------------------------------------------------------------

/** 一个 RIFF 块（chunk）。 */
interface RiffChunk {
  /** 块标识（4 字节 ASCII）。 */
  id: string
  /** 块数据起始偏移。 */
  dataOffset: number
  /** 块数据长度。 */
  dataSize: number
}

/** 读一个 RIFF 块的头（**在内存缓冲里**）。 */
function readRiffChunkIn(buffer: Buffer, offset: number, littleEndian: boolean): RiffChunk | null {
  if (offset < 0 || offset + 8 > buffer.length) return null
  const id = buffer.subarray(offset, offset + 4).toString('latin1')
  const size = littleEndian ? readUint32LE(buffer, offset + 4) : readUint32BE(buffer, offset + 4)
  return { id, dataOffset: offset + 8, dataSize: size }
}

/** 读一个 RIFF 块的头（**按文件偏移**，用读取器）。 */
async function readRiffChunk(
  reader: TagReader,
  offset: number,
  end: number,
  littleEndian: boolean,
): Promise<RiffChunk | null> {
  if (offset + 8 > end || offset + 8 > reader.size) return null
  const header = await reader.read(offset, 8)
  if (header.length < 8) return null
  const id = header.subarray(0, 4).toString('latin1')
  const size = littleEndian ? readUint32LE(header, 4) : readUint32BE(header, 4)
  return { id, dataOffset: offset + 8, dataSize: size }
}

/**
 * 按文件偏移找**第一个**指定标识的 RIFF 块。
 *
 * ⚠️ 块数据按**偶数**字节补齐（RIFF 规范）→ 下一个块的位置要跳过补齐字节。
 */
async function findRiffChunk(
  reader: TagReader,
  start: number,
  end: number,
  id: string,
  littleEndian: boolean,
): Promise<RiffChunk | null> {
  let offset = start
  while (offset + 8 <= end) {
    const chunk = await readRiffChunk(reader, offset, end, littleEndian)
    if (!chunk) return null
    if (chunk.id === id) return chunk
    const next = chunk.dataOffset + chunk.dataSize + (chunk.dataSize % 2)
    if (next <= offset) return null
    offset = next
  }
  return null
}

// ---------------------------------------------------------------------------
// WAV（RIFF/WAVE）
// ---------------------------------------------------------------------------

/** 判断是不是 RIFF/WAVE。 */
function isRiffMagic(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WAVE'
  )
}

/**
 * 解析 WAV 的标签。
 *
 * - `fmt ` → 字节率（算时长用）；
 * - `data` → 数据长度 ÷ 字节率 = **精确**时长；
 * - `LIST INFO` → `INAM`（歌名）/ `IART`（歌手）/ `IPRD`（专辑）。
 */
export async function parseWavTags(reader: TagReader, head: Buffer): Promise<AudioTags | null> {
  if (!isRiffMagic(head)) return null

  const tags: AudioTags = {}

  // `fmt ` 块：channels(2) / sampleRate(4) / byteRate(4) / blockAlign(2) / bits(2)。
  const fmt = await findRiffChunk(reader, 12, reader.size, 'fmt ', true)
  let byteRate = 0
  if (fmt) {
    const body = await reader.read(fmt.dataOffset, Math.min(fmt.dataSize, 16))
    byteRate = readUint32LE(body, 8)
  }

  // `data` 块 → 时长。
  const data = await findRiffChunk(reader, 12, reader.size, 'data', true)
  if (data && byteRate > 0 && data.dataSize > 0) {
    tags.duration = data.dataSize / byteRate
  }

  // `LIST INFO` → 文本标签。
  const list = await findRiffChunk(reader, 12, reader.size, 'LIST', true)
  if (list && list.dataSize > 4) {
    const body = await reader.read(list.dataOffset, Math.min(list.dataSize, TAG_METADATA_MAX_BYTES))
    if (body.subarray(0, 4).toString('latin1') === 'INFO') {
      const end = body.length
      let offset = 4
      while (offset + 8 <= end) {
        const chunk = readRiffChunkIn(body, offset, true)
        if (!chunk) break
        const value = decodeContainerText(
          body.subarray(chunk.dataOffset, chunk.dataOffset + chunk.dataSize),
        )
        if (value.length > 0) {
          if (chunk.id === 'INAM') tags.title = value
          else if (chunk.id === 'IART') tags.artist = value
          else if (chunk.id === 'IPRD') tags.album = value
        }
        const next = chunk.dataOffset + chunk.dataSize + (chunk.dataSize % 2)
        if (next <= offset) break
        offset = next
      }
    }
  }

  return tags
}

// ---------------------------------------------------------------------------
// AIFF / AIFC
// ---------------------------------------------------------------------------

/** 判断是不是 AIFF / AIFC。 */
function isAiffMagic(buffer: Buffer): boolean {
  if (buffer.length < 12) return false
  if (buffer.subarray(0, 4).toString('latin1') !== 'FORM') return false
  const type = buffer.subarray(8, 12).toString('latin1')
  return type === 'AIFF' || type === 'AIFC'
}

/** 读 10 字节的 **80 位 IEEE 扩展精度**浮点（AIFF 的采样率用它）。 */
function readExtended80(buffer: Buffer, offset: number): number {
  const sign = (byteAt(buffer, offset) & 0x80) === 0 ? 1 : -1
  const exponent = ((byteAt(buffer, offset) & 0x7f) << 8) | byteAt(buffer, offset + 1)
  let mantissa = 0
  for (let i = 0; i < 8; i += 1) mantissa = mantissa * 256 + byteAt(buffer, offset + 2 + i)
  // 指数 0 且尾数 0 = 0；指数全 1 = Inf / NaN → 都当「没有采样率」。
  if (exponent === 0 || exponent === 0x7fff) return 0
  return sign * mantissa * Math.pow(2, exponent - 16383 - 63)
}

/**
 * 解析 AIFF / AIFC 的标签。
 *
 * - `COMM` → 采样帧数 ÷ 采样率 = **精确**时长（采样率是 80 位扩展精度）；
 * - `ID3 ` 块 → **复用已有的 ID3v2 解析器**（AIFF 里的 ID3 块就是 ID3v2）。
 */
export async function parseAiffTags(reader: TagReader, head: Buffer): Promise<AudioTags | null> {
  if (!isAiffMagic(head)) return null

  const tags: AudioTags = {}

  // `COMM` 块：channels(2) / numSampleFrames(4) / sampleSize(2) / sampleRate(10)。
  const comm = await findRiffChunk(reader, 12, reader.size, 'COMM', false)
  if (comm && comm.dataSize >= 18) {
    const body = await reader.read(comm.dataOffset, 18)
    const frames = readUint32BE(body, 2)
    const sampleRate = readExtended80(body, 8)
    if (frames > 0 && sampleRate > 0) tags.duration = frames / sampleRate
  }

  // `ID3 ` 块 → 复用 ID3v2 解析器。
  const id3 = await findRiffChunk(reader, 12, reader.size, 'ID3 ', false)
  if (id3 && id3.dataSize > 10) {
    const body = await reader.read(id3.dataOffset, Math.min(id3.dataSize, TAG_METADATA_MAX_BYTES))
    const parsed = parseId3v2(body)
    if (parsed.title) tags.title = parsed.title
    if (parsed.artist) tags.artist = parsed.artist
    if (parsed.album) tags.album = parsed.album
  }

  return tags
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 从字节流里解析标签（**按文件头嗅探**，不靠扩展名猜）。
 *
 * @param reader 读取器。
 * @returns 标签；不认识 / 读不到 → `null`。
 */
export async function readTagsFromReader(reader: TagReader): Promise<AudioTags | null> {
  const head = await reader.read(0, Math.min(TAG_HEAD_BYTES, reader.size))
  if (head.length < 8) return null

  if (isFlacMagic(head)) return await parseFlacTags(reader, head)

  if (isId3Magic(head)) {
    // 标签体比文件头大 → 补读（超上限就只吃前面的部分）。
    const tagSize = id3TagSize(head)
    let tagBuffer = head
    if (tagSize > head.length && tagSize <= TAG_ID3_MAX_BYTES) {
      tagBuffer = await reader.read(0, tagSize)
    }
    const parsed = parseId3v2(tagBuffer)
    const tags: AudioTags = {}
    if (parsed.title) tags.title = parsed.title
    if (parsed.artist) tags.artist = parsed.artist
    if (parsed.album) tags.album = parsed.album
    const duration = await readMpegDuration(reader, parsed.tagSize, reader.size)
    if (duration !== undefined && duration > 0) tags.duration = duration
    return tags
  }

  if (isOggMagic(head)) return await parseOggTags(reader, head)

  // ⚠️ T42：ISO 家族容器（**按文件头嗅探**，不靠扩展名猜）。
  if (isMp4Magic(head)) return await parseMp4Tags(reader, head)
  if (isRiffMagic(head)) return await parseWavTags(reader, head)
  if (isAiffMagic(head)) return await parseAiffTags(reader, head)

  // 没有 ID3 头的裸 MPEG 音频。
  const mpeg = parseMpegFrameHeader(head, 0)
  if (mpeg) {
    const duration = await readMpegDuration(reader, 0, reader.size)
    if (duration !== undefined && duration > 0) return { duration }
  }
  return null
}

/**
 * 读一个文件的标签（**入口**）。
 *
 * ⚠️ **全程不抛**：读不到 / 不认识 → `null`。
 *
 * @param fs 文件系统（由调用方注入）。
 * @param path 文件绝对路径。
 */
export async function readFileTags(fs: TagFileSystem, path: string): Promise<AudioTags | null> {
  try {
    const size = await fs.statSize(path)
    if (size === null || size <= 0) return null
    const reader: TagReader = {
      size,
      read: async (offset, length) => {
        const start = Math.max(0, offset)
        const want = Math.max(0, Math.min(length, size - start))
        if (want <= 0) return Buffer.alloc(0)
        return await fs.readBytes(path, start, want)
      },
    }
    return await readTagsFromReader(reader)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 合并规则
// ---------------------------------------------------------------------------

/** 合并后的曲目元数据。 */
export interface MergedTrackMeta {
  /** 歌名。 */
  title: string
  /** 歌手名（**可能为空串**）。 */
  artist: string
  /** 专辑名（**可能为空串**）。 */
  album: string
  /** 时长（秒；`0` = 未知）。 */
  duration: number
  /** 歌名 / 歌手的来源。 */
  tagSource: 'tag' | 'name'
}

/** 取非空字符串；没有就 `null`。 */
function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * 把**标签**与**文件名反推值**合并（**标签优先、文件名兜底**）。
 *
 * @param fileName 文件名（可以带路径）。
 * @param tags 标签；没有就传 `null`。
 */
export function mergeTrackTags(fileName: string, tags: AudioTags | null): MergedTrackMeta {
  const fallback = parseTrackFileName(fileName)
  const tagTitle = nonEmpty(tags?.title)
  const tagArtist = nonEmpty(tags?.artist)
  const tagAlbum = nonEmpty(tags?.album)
  const duration =
    typeof tags?.duration === 'number' && Number.isFinite(tags.duration) && tags.duration > 0
      ? tags.duration
      : 0

  const fromTag = tagTitle !== null || tagArtist !== null || tagAlbum !== null || duration > 0

  return {
    title: tagTitle ?? fallback.title,
    artist: tagArtist ?? fallback.artist,
    album: tagAlbum ?? '',
    duration,
    tagSource: fromTag ? 'tag' : 'name',
  }
}
