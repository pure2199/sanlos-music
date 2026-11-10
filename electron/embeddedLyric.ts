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
//    ⇒ 只读**文件头** ⇒ **只支持「元数据在文件头」的容器**（MP3 / FLAC / Ogg）。
//    ⚠️ MP4 的 `moov` 原子常在**文件尾** ⇒ 这一层读不到 `©lyr`（**如实放弃**，不猜）。
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
import { readTagsFromReader, type TagReader } from './audioTags'

/** 流式读取的**头部长度**（字节）——容器标签都在文件开头，64 KB 足够。 */
export const EMBEDDED_LYRIC_STREAM_BYTES = 64 * 1024

/** `readEmbeddedLyric` 的依赖（全部可注入，便于单测）。 */
export interface EmbeddedLyricDeps {
  /**
   * 按曲目 id 查**本地文件的绝对路径**；查不到 ⇒ `null`。
   *
   * ⚠️ 调用方给的顺序是「下载索引 → 本地登记表」（与 `fnml://` 的查找链一致）。
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

  // ③：NAS 在线流（**本地没有文件**时）⇒ 只读文件头。
  //    ⚠️ 本地曲目（`local:`）没有 NAS guid ⇒ 走不了这条。
  if (deps.fetchStreamHead && !trackId.startsWith(LOCAL_TRACK_ID_PREFIX)) {
    const head = await deps.fetchStreamHead(trackId, EMBEDDED_LYRIC_STREAM_BYTES)
    if (head && head.length > 0) {
      const content = await readLyricsFromBytes(head)
      if (content) return { content, layer: 'stream' }
    }
  }

  return { content: '', layer: 'none' }
}
