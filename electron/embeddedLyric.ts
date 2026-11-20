// ---------------------------------------------------------------------------
// T83 音频内嵌歌词（主进程）
// ---------------------------------------------------------------------------
//
// 职责：**一个曲目 id → 一段 LRC 文本（或空串）**。
//
// 三个来源层
// ---------------------------------------------------------------------------
// ① 本地导入（`local:<hash>`）→ 本地登记表里的绝对路径；
// ② 已下载的 NAS 曲目（guid）→ 下载索引里的绝对路径（**原文件**，标签最完整）；
// ③ NAS 在线播放（guid，没下载）→ `GET track/stream?guid=` + `Range: bytes=0-65535`
//    ⇒ 只读**文件头** ⇒ 头在文件头的容器（MP3 / FLAC / Ogg）**一次就读到**。
//    ⚠️ **T126**：MP4 / M4A 的 `moov`（标签所在）**可能不在头里** ——
//       - **G1**：`moov` 在**文件尾**（ffmpeg 默认产物）⇒ 头里**根本没有** `moov`；
//       - **G2**：`moov` 在头但**超过 64 KB 窗口**（实测那首的 `moov` 有 212 KB）
//         ⇒ `udta/ilst` 落在窗口外；
//    ⇒ 头读没拿到歌词时，**补读一次**（尾读文件尾 / 按绝对偏移续读 `moov`）。
//
// ---------------------------------------------------------------------------
// 纪律
// ---------------------------------------------------------------------------
// - ⚠️ **全程不抛**：读不到 / 没有 ⇒ 返回空串（调用方自己决定怎么回落）；
// - ⚠️ **依赖可注入** ⇒ 单测**不碰真实磁盘与真实网络**；
// - ⚠️ **只读**：不改用户的音乐文件（**不写回标签**）；
// - ⚠️ 输出**永远是标准 LRC 文本**（`SYLT` 的真逐字已转成 `<mm:ss.xxx>` 逐字标签）
//   ⇒ 渲染层的解析器**一行都不用改**。
// ---------------------------------------------------------------------------

import { LOCAL_TRACK_ID_PREFIX } from '../shared/localMedia'
import type { EmbeddedLyricPayload } from '../shared/embeddedLyric'
import {
  findMp4AtomInBuffer,
  findMp4MoovInTail,
  isMp4Container,
  parseMp4MoovContent,
  readTagsFromReader,
  type TagReader,
} from './audioTags'

/** 流式读取的**头部长度**（字节）——容器标签都在文件开头，64 KB 足够。 */
export const EMBEDDED_LYRIC_STREAM_BYTES = 64 * 1024

/**
 * 流式**尾读**的窗口长度（字节）——T126：`moov` 在文件尾时从这里找它。
 *
 * 取 **64 KB**（与头读同量级）：`moov` 原子通常几 KB；
 *    真机上若发现装不下 ⇒ `findMp4MoovInTail()` 会标 `complete: false`
 *    ⇒ 由调用方拿**总长度**换算绝对偏移后**整读**（不必加大窗口）。
 */
export const EMBEDDED_LYRIC_STREAM_TAIL_BYTES = 64 * 1024

/**
 * 从 `Content-Range` 头里取**资源总长度**（字节）。
 *
 * ⚠ 形如 `bytes 43314305-43379840/43379841` ⇒ 总长 = `43379841`；
 *    总长写成 `*`（未知）⇒ `null`；头整个没有 ⇒ `null`。
 *
 * ⚠ **为什么需要**：`moov` 在文件尾且**比尾读窗口还大**时，
 *    要靠总长度换算 `moov` 的**绝对偏移**才能整读（实测服务端会回这个头）。
 */
export function parseContentRangeTotal(header: string | null | undefined): number | null {
  if (!header) return null
  const match = /\/\s*(\d+)\s*$/.exec(header.trim())
  if (!match) return null
  const total = Number(match[1])
  return Number.isFinite(total) && total > 0 ? total : null
}

/** 从音频流里取到的一段字节。 */
export interface StreamSlice {
  /** 取到的字节。 */
  bytes: Buffer
  /**
   * 资源**总长度**（来自 `Content-Range` 的 `/total`）；取不到 ⇒ `null`。
   *
   * ⚠ **为什么需要**：`moov` 在文件尾且**比尾读窗口还大**时，
   *    要靠它换算 `moov` 的**绝对偏移**才能整读。
   */
  totalSize: number | null
}

/** `readEmbeddedLyric` 的依赖（全部可注入，便于单测）。 */
export interface EmbeddedLyricDeps {
  /**
   * 按曲目 id 查**本地文件的绝对路径**；查不到 ⇒ `null`。
   *
   * ⚠️ 调用方给的顺序是「下载索引 → 本地登记表」（与 `sanlos-media://` 的查找链一致）。
   */
  resolveTrackPath?: (id: string) => string | null
  /** 读文件的一段字节。 */
  readFileBytes?: (path: string, offset: number, length: number) => Promise<Buffer>
  /** 取文件大小；不是文件 / 不存在 ⇒ `null`。 */
  statSize?: (path: string) => Promise<number | null>
  /**
   * 取 NAS 音频流的**头若干字节**；取不到 ⇒ `null`。
   *
   * ⚠️ 实现方**必须**只取头部并立刻断开（不能把整首歌拉下来）。
   */
  fetchStreamHead?: (guid: string, byteLength: number) => Promise<Buffer | null>
  /**
   * 取 NAS 音频流的**一段字节**（T126：读文件尾 / 续读 `moov`）。
   *
   * @param start 起始偏移；**负数** = 从文件尾往回数（`-N` = 最后 N 字节）。
   * @param length 取多少字节。
   *
   * ⚠️ 实现方**必须**只取这一段并立刻断开（不能把整首歌拉下来）。
   */
  fetchStreamRange?: (guid: string, start: number, length: number) => Promise<StreamSlice | null>
}

/**
 * `readEmbeddedLyric` 的结果。
 *
 * ⚠️ **就是 IPC 的载荷形状**（`shared/embeddedLyric.ts` 里那一份）——
 *    别在这里另起一份定义：两处形状一旦漂移 ⇒ 渲染层静默拿不到歌词。
 */
export type EmbeddedLyricResult = EmbeddedLyricPayload

/** 从一段字节里读标签里的歌词（**永不抛**）。 */
async function readLyricsFromBytes(data: Buffer): Promise<string> {
  try {
    if (!data || data.length < 8) return ''
    const reader: TagReader = {
      size: data.length,
      read: async (offset, length) =>
        data.subarray(Math.max(0, offset), Math.min(offset + length, data.length)),
    }
    const tags = await readTagsFromReader(reader)
    return tags?.lyrics?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 从本地文件读标签里的歌词（**永不抛**）。 */
async function readLyricsFromFile(
  filePath: string,
  deps: EmbeddedLyricDeps,
): Promise<string> {
  const statSize = deps.statSize
  const readFileBytes = deps.readFileBytes
  if (!statSize || !readFileBytes) return ''
  try {
    const size = await statSize(filePath)
    if (size === null || size <= 0) return ''
    const reader: TagReader = {
      size,
      read: async (offset, length) => {
        const start = Math.max(0, offset)
        const want = Math.max(0, Math.min(length, size - start))
        if (want <= 0) return Buffer.alloc(0)
        return await readFileBytes(filePath, start, want)
      },
    }
    const tags = await readTagsFromReader(reader)
    return tags?.lyrics?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * 从一个响应体里读**至多** `byteLength` 字节；**读满立刻断开**。
 *
 * ⚠️ **为什么必须断开**：音频流是**整首歌**（几十 MB）——
 *    不主动断开就会把整首歌拉下来（带宽 + 内存）。
 * ⚠️ **读满即 `cancel()`**（不是「等它自然结束」）⇒ 服务端那边也会立刻收手。
 * ⚠️ **服务端可能无视 Range**（回 200 整流）⇒ 那就只读我们要的那一段，
 *    剩下的**丢掉**。
 *
 * @param body 响应体（`ReadableStream`）。
 * @param byteLength 最多读多少字节。
 * @returns 读到的字节（**长度 ≤ `byteLength`**）。
 */
export async function readAtMostBytes(
  body: ReadableStream<Uint8Array>,
  byteLength: number,
): Promise<Buffer> {
  const limit = Math.max(0, byteLength)
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(Buffer.from(value))
      total += value.length
      // ⚠️ **读满就停**（这是「不把整首歌拉下来」的唯一保证）。
      if (total >= limit) break
    }
  } finally {
    // ⚠️ **读满就断开**：不能把整首歌拉下来。
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).subarray(0, limit)
}

/**
 * MP4 / M4A 的**补读**：头读没拿到歌词时，再读一次把 `moov` 找齐（**永不抛**）。
 *
 * ⚠ **什么时候才补读**：
 * - **不是 MP4** ⇒ 不补（别的容器头读就够了 ⇒ 不白花请求）；
 * - 是 MP4 且**头里已经有完整的 `moov`** ⇒ 不补（头读已经解析过 ⇒ 再读也没用）。
 *
 * ⚠ **两条补读路径**：
 * - **G2（续读）**：`moov` 在头，但内容**超出窗口** ⇒ 按**绝对偏移**续读它的内容；
 * - **G1（尾读）**：头里**根本没有** `moov` ⇒ **尾读文件尾**，在尾段里定位它；
 *   若它**比尾窗口还大**（`complete === false`）⇒ 用**总长度**换算绝对偏移后**整读**。
 *
 * @param guid 曲目 guid。
 * @param head 已经读到的文件头。
 * @param deps 依赖。
 * @returns LRC 文本；没有 ⇒ 空串。
 */
async function readMp4LyricsFromStream(
  guid: string,
  head: Buffer,
  deps: EmbeddedLyricDeps,
): Promise<string> {
  const fetchRange = deps.fetchStreamRange
  if (!fetchRange) return ''
  if (!isMp4Container(head)) return ''
  try {
    // ---- G2：`moov` 在头，但内容可能超出窗口 ⇒ 按绝对偏移续读 ----
    const moov = findMp4AtomInBuffer(head, 'moov')
    if (moov) {
      if (moov.contentOffset + moov.contentSize <= head.length) return ''
      const slice = await fetchRange(guid, moov.contentOffset, moov.contentSize)
      if (!slice?.bytes || slice.bytes.length < 8) return ''
      return parseMp4MoovContent(slice.bytes).lyrics?.trim() ?? ''
    }

    // ---- G1：头里没有 `moov` ⇒ 尾读文件尾 ----
    const tail = await fetchRange(guid, -EMBEDDED_LYRIC_STREAM_TAIL_BYTES, EMBEDDED_LYRIC_STREAM_TAIL_BYTES)
    if (!tail?.bytes || tail.bytes.length < 16) return ''
    const found = findMp4MoovInTail(tail.bytes)
    if (!found) return ''
    if (found.complete) {
      return parseMp4MoovContent(found.content).lyrics?.trim() ?? ''
    }
    // ⚠ `moov` 比尾窗口还大 ⇒ 用**总长度**换算绝对偏移后整读。
    const total = tail.totalSize
    if (total === null || total <= 0) return ''
    const absoluteStart = total - tail.bytes.length + found.atomStart
    if (absoluteStart < 0) return ''
    const full = await fetchRange(guid, absoluteStart, found.atomSize)
    if (!full?.bytes || full.bytes.length < 8) return ''
    return parseMp4MoovContent(full.bytes).lyrics?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * 读一个曲目的**内嵌歌词**。
 *
 * @param id 曲目 id（`local:<hash>` 或 NAS 的 32 位 guid）。
 * @param deps 依赖。
 * @returns LRC 文本；没有 ⇒ 空串（**永不抛**）。
 */
export async function readEmbeddedLyric(
  id: string,
  deps: EmbeddedLyricDeps,
): Promise<EmbeddedLyricResult> {
  const trackId = typeof id === 'string' ? id.trim() : ''
  if (!trackId) return { content: '', layer: 'none' }

  // ① / ②：本地有文件 ⇒ 直接读磁盘（**原文件**，标签最完整）。
  const filePath = deps.resolveTrackPath?.(trackId) ?? null
  if (filePath) {
    const content = await readLyricsFromFile(filePath, deps)
    if (content) return { content, layer: 'file' }
  }

  // ③：NAS 在线流（**本地没有文件**时）⇒ 先读文件头。
  //    ⚠️ 本地曲目（`local:`）没有 NAS guid ⇒ 走不了这条。
  if (deps.fetchStreamHead && !trackId.startsWith(LOCAL_TRACK_ID_PREFIX)) {
    const head = await deps.fetchStreamHead(trackId, EMBEDDED_LYRIC_STREAM_BYTES)
    if (head && head.length > 0) {
      const content = await readLyricsFromBytes(head)
      if (content) return { content, layer: 'stream' }
      // ⚠️ **T126**：MP4 / M4A 的 `moov` 可能不在头里（或超出窗口）⇒ 补读一次。
      const extra = await readMp4LyricsFromStream(trackId, head, deps)
      if (extra) return { content: extra, layer: 'stream' }
    }
  }

  return { content: '', layer: 'none' }
}
