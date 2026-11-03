// ---------------------------------------------------------------------------
// 兜底转码的**编排**（**主进程**，Task 12）
// ---------------------------------------------------------------------------
//
// 职责
// 1. 判断「这首歌能不能兜底」：有本地副本吗？本机有 FFmpeg 吗？
// 2. 把本地文件转成 **Opus**（Chromium 能解），产物放进**临时目录**；
// 3. 产物通过**既有的** `fnml://local/track/<songId>` 路由喂给渲染进程
//    （**不新增路由种类**——见 `electron/localMedia.ts`）。
//
// ---------------------------------------------------------------------------
// 为什么产物走 `fnml://local/track/<songId>`
// ---------------------------------------------------------------------------
// - 渲染进程的 `<audio>` **只认这一种本地媒体地址**，进度 / seek / EQ /
//   媒体会话 / 悬浮歌词全都白拿；
// - 主进程的 `lookup` 改成「**临时产物优先 → 下载索引**」即可，
//   `electron/localMedia.ts` 与 `test/local-media.test.ts` **一个字都不用改**。
//
// ---------------------------------------------------------------------------
// 边界（不可放宽）
// ---------------------------------------------------------------------------
// - **单槽缓存**：同一时刻只保留**一个**转码产物；换歌时删掉旧的
//   （避免临时目录无限膨胀）；
// - 产物**不进**下载索引（`downloads.json`）、**不污染**用户的下载目录；
// - 退出应用时**清掉**临时目录；
// - **只处理本地文件**：输入路径来自下载索引，**渲染进程碰不到路径**；
// - 失败原因用**可判别的码**（`no-ffmpeg` / `no-local` / `failed`），
//   文案**不含** token / Cookie / authx；
// - **不引新 npm 依赖**：只认系统里已装的 `ffmpeg`，**绝不**自动下载 / 安装。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**（本文件要能在 Vitest 里直接单测）；
// - 文件系统与外部命令**可注入**（`deps.*`）→ 单测不碰真实磁盘、不起真进程。

import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { FfmpegFallbackResult, FfmpegStatus } from '../shared/ffmpeg'
import { localMediaUrl } from '../shared/localMedia'
import { detectFfmpeg, readableFfmpegError, transcodeToOpus } from './ffmpeg'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** `FallbackTranscoder` 的依赖（**可注入**，便于单测）。 */
export interface FallbackTranscoderDeps {
  /**
   * 歌曲 guid → 本地文件的**绝对路径**（没有副本时返回 `null`）。
   *
   * ⚠️ 由主进程注入下载索引的查询（**渲染进程碰不到路径**）。
   */
  lookupLocal: (songId: string) => string | null
  /** 转码产物的**临时目录**（主进程给，一般在 `userData` 下）。 */
  tempDir: string
  /** FFmpeg 探测（可注入，便于单测）。 */
  detect?: () => Promise<FfmpegStatus>
  /** 转码（可注入，便于单测）：`(输入, 输出, ffmpeg 路径)`。 */
  transcode?: (input: string, output: string, binary: string) => Promise<void>
  /** 建目录（可注入）。 */
  ensureDir?: (dir: string) => Promise<void>
  /** 删文件（可注入）。 */
  removeFile?: (path: string) => Promise<void>
  /** 删目录（可注入；**只删自己建的临时目录**）。 */
  removeDir?: (dir: string) => Promise<void>
  /** 查文件是否存在（可注入）。 */
  fileExists?: (path: string) => Promise<boolean>
}

/** 转码产物的名字（由 guid 派生，**不含任何用户数据**）。 */
export function fallbackFileName(songId: string): string {
  const digest = createHash('sha1').update(songId, 'utf8').digest('hex').slice(0, 24)
  return `${digest}.opus`
}

// ---------------------------------------------------------------------------
// 默认实现
// ---------------------------------------------------------------------------

/** 默认：建目录（递归）。 */
async function defaultEnsureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** 默认：删文件（不存在也不报错）。 */
async function defaultRemoveFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** 默认：文件是否存在。 */
async function defaultFileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** 默认：删目录（递归）。 */
async function defaultRemoveDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 转码器
// ---------------------------------------------------------------------------

/**
 * 兜底转码器（**主进程**）。
 *
 * 典型用法：
 * ```ts
 * const transcoder = new FallbackTranscoder({
 *   lookupLocal: (id) => downloads.localPath(id),
 *   tempDir: path.join(app.getPath('userData'), 'fallback'),
 * })
 * // `fnml://` 的 lookup：临时产物优先 → 下载索引
 * registerLocalMedia({ lookup: (id) => transcoder.lookup(id) ?? downloads.localPath(id) })
 * ```
 */
export class FallbackTranscoder {
  private readonly deps: FallbackTranscoderDeps
  /** 当前保留的转码产物（**单槽**）。 */
  private slot: { songId: string; path: string } | null = null
  /** FFmpeg 探测结果缓存（**只探测一次**——`-version` 是同步起进程，很贵）。 */
  private statusCache: FfmpegStatus | null = null
  /** 正在进行的转码（同一首歌重复请求时复用，避免并发转两次）。 */
  private inflight: Map<string, Promise<FfmpegFallbackResult>> = new Map()

  constructor(deps: FallbackTranscoderDeps) {
    this.deps = deps
  }

  /**
   * FFmpeg 探测结果（**带缓存**）。
   *
   * 没装 FFmpeg 是**正常状态**，**不抛异常**。
   */
  async status(): Promise<FfmpegStatus> {
    if (this.statusCache) return this.statusCache
    const detect = this.deps.detect ?? (() => detectFfmpeg())
    let result: FfmpegStatus
    try {
      result = await detect()
    } catch {
      result = { available: false, path: '', version: '' }
    }
    this.statusCache = {
      available: result?.available === true,
      path: typeof result?.path === 'string' ? result.path : '',
      version: typeof result?.version === 'string' ? result.version : '',
    }
    return this.statusCache
  }

  /**
   * 这首歌的**兜底产物**路径（没有 = `null`）。
   *
   * ⚠️ 这是 `fnml://` 的 `lookup` 用的——**临时产物优先**于下载索引。
   */
  lookup(songId: string): string | null {
    if (!this.slot) return null
    return this.slot.songId === songId ? this.slot.path : null
  }

  /**
   * 为一首歌准备兜底产物。
   *
   * @param songId 歌曲 guid（**只当索引键**，绝不参与拼路径）。
   * @returns 成功时 `{ url: 'fnml://local/track/<id>' }`；
   *          失败时带**可判别**的 `reason`（`no-ffmpeg` / `no-local` / `failed`）。
   */
  async prepare(songId: string): Promise<FfmpegFallbackResult> {
    const id = typeof songId === 'string' ? songId.trim() : ''
    if (id.length === 0) {
      return { url: '', reason: 'failed', detail: '歌曲标识无效' }
    }

    // 1) **已有产物** → 直接复用（不重复转码）。
    const cached = await this.cachedResult(id)
    if (cached) return cached

    // 2) **同一首歌的并发请求** → 复用同一个 Promise（别转两次）。
    const pending = this.inflight.get(id)
    if (pending) return pending

    const task = this.runPrepare(id).finally(() => {
      this.inflight.delete(id)
    })
    this.inflight.set(id, task)
    return task
  }

  /** 真正干活的实现（`prepare` 的去重外壳之内）。 */
  private async runPrepare(songId: string): Promise<FfmpegFallbackResult> {
    // 3) **本地副本**：兜底只吃本地文件（服务端转码不可用，没有别的来源）。
    const input = this.deps.lookupLocal(songId)
    if (!input || input.length === 0) {
      return { url: '', reason: 'no-local', detail: null }
    }

    // 4) **FFmpeg**：没装就**如实说**（不静默失败）。
    const status = await this.status()
    if (!status.available) {
      return { url: '', reason: 'no-ffmpeg', detail: null }
    }

    // 5) **转码**。
    const output = join(this.deps.tempDir, fallbackFileName(songId))
    const ensureDir = this.deps.ensureDir ?? defaultEnsureDir
    const removeFile = this.deps.removeFile ?? defaultRemoveFile
    const transcode =
      this.deps.transcode ??
      ((inputPath: string, outputPath: string, binary: string) =>
        transcodeToOpus(inputPath, outputPath, { binary }))

    try {
      await ensureDir(this.deps.tempDir)
      await transcode(input, output, status.path)
    } catch (err) {
      // 半成品绝不能留下（下次会被当成「已有产物」）。
      await removeFile(output).catch(() => undefined)
      const message = err instanceof Error ? err.message : String(err)
      return { url: '', reason: 'failed', detail: readableFfmpegError(message) }
    }

    // 6) **单槽**：换歌时把上一个产物删掉（临时目录不许无限膨胀）。
    await this.clearSlot(removeFile)
    this.slot = { songId, path: output }

    return { url: localMediaUrl(songId), reason: null, detail: null }
  }

  /** 已有产物就直接给结果（产物必须**真的还在**）。 */
  private async cachedResult(songId: string): Promise<FfmpegFallbackResult | null> {
    const path = this.lookup(songId)
    if (!path) return null
    const exists = this.deps.fileExists ?? defaultFileExists
    if (!(await exists(path))) {
      // 产物被外部删了 → 清掉槽位，重新转。
      this.slot = null
      return null
    }
    return { url: localMediaUrl(songId), reason: null, detail: null }
  }

  /** 删掉当前槽位的产物文件。 */
  private async clearSlot(removeFile?: (path: string) => Promise<void>): Promise<void> {
    const remove = removeFile ?? this.deps.removeFile ?? defaultRemoveFile
    const slot = this.slot
    this.slot = null
    if (!slot) return
    await remove(slot.path).catch(() => undefined)
  }

  /**
   * 清理（**退出应用时调用**）：删掉产物文件与整个临时目录。
   *
   * ⚠️ **只删自己建的临时目录**——绝不碰用户的下载目录。
   */
  async dispose(): Promise<void> {
    this.inflight.clear()
    await this.clearSlot()
    const dir = this.deps.tempDir
    if (!dir || dir.length === 0) return
    const removeDir = this.deps.removeDir ?? defaultRemoveDir
    try {
      await removeDir(dir)
    } catch {
      // 清理失败不阻塞退出。
    }
  }
}
