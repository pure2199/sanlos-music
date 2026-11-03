// ---------------------------------------------------------------------------
// 主进程的 FFmpeg 兜底（**探测 + 转码**，Task 12）
// ---------------------------------------------------------------------------
//
// 职责
// ---------------------------------------------------------------------------
// 1. **探测**本机有没有可用的 `ffmpeg`（PATH + 常见安装位置）；
// 2. **转码**：把本地音频文件转成 Chromium 能解的 **Opus**（Ogg 容器）。
//
// ---------------------------------------------------------------------------
// 为什么转码而不是「解码成 PCM 直喂 WebAudio」
// ---------------------------------------------------------------------------
// 用户已拍板：**转码到 Opus**。
// - 转码产物是**普通音频文件** → 复用现成的 `<audio>` 播放链路
//   （进度 / seek / EQ / 媒体会话 / 悬浮歌词**全都白拿**）；
// - 体积小（160 kbps ≈ 4 分钟 4.8 MB），IPC 与内存都轻；
// - 代价：**有损**（原始比特流被换成了 Opus）→ 界面必须**如实注明**。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - **不引新 npm 依赖**：只认系统里已装的 `ffmpeg`，**绝不**自动下载 / 安装；
// - **只处理本地文件**：输入路径来自下载索引（T11），**不由渲染进程指定**；
// - 渲染进程**碰不到**路径，也**碰不到**凭证（本模块不碰 NAS）；
// - 错误文案**不含** token / Cookie / authx（只取 ffmpeg 的 stderr 末行）。
//
// ---------------------------------------------------------------------------
// 模块约束
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**（本文件要能在 Vitest 里直接单测）；
// - 外部命令的执行**可注入**（`deps.run`）→ 单测不真的起进程。

import { spawn } from 'node:child_process'

import type { FfmpegStatus } from '../shared/ffmpeg'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 候选可执行文件（**按顺序**试，第一个能跑 `-version` 的就是它）。
 *
 * ⚠️ 第一项是裸命令名 `ffmpeg` → 走 PATH（winget / scoop / choco 都装在这）。
 */
export const DEFAULT_FFMPEG_CANDIDATES: readonly string[] = [
  'ffmpeg',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
]

/** 转码的比特率（Opus）。 */
export const FALLBACK_BITRATE = '160k'

/** 转码的目标采样率。 */
export const FALLBACK_SAMPLE_RATE = '48000'

/** 转码的目标声道数。 */
export const FALLBACK_CHANNELS = '2'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一次外部命令的执行结果。 */
export interface FfmpegRunResult {
  /** 退出码（`0` = 成功；信号终止 / 起不来 = 非 0）。 */
  code: number
  /** 标准输出。 */
  stdout: string
  /** 标准错误（ffmpeg 的日志都在这里）。 */
  stderr: string
}

/** `detectFfmpeg` / `transcodeToOpus` 的可选依赖（**可注入，便于单测**）。 */
export interface FfmpegDeps {
  /** 执行外部命令；缺省用 `child_process.spawn`。 */
  run?: (command: string, args: string[]) => Promise<FfmpegRunResult>
  /** 候选可执行文件；缺省用 `DEFAULT_FFMPEG_CANDIDATES`。 */
  candidates?: string[]
  /** 已知可执行文件路径（转码时用，省一次探测）。 */
  binary?: string
}

// ---------------------------------------------------------------------------
// 默认执行器
// ---------------------------------------------------------------------------

/**
 * 用 `spawn` 执行一次命令（**不经过 shell**，参数数组逐个传）。
 *
 * ⚠️ 不走 shell 是为了**杜绝命令注入**（路径与参数里有用户数据）。
 */
function defaultRun(command: string, args: string[]): Promise<FfmpegRunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: FfmpegRunResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = spawn(command, args, { windowsHide: true })
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk)
      })
      // ⚠️ `error` = **起不来**（文件不存在 / 不在 PATH）；`close` = 跑完了。
      child.on('error', (err: Error) => {
        finish({ code: -1, stdout, stderr: `${stderr}${err.message}` })
      })
      child.on('close', (code: number | null) => {
        finish({ code: code ?? -1, stdout, stderr })
      })
    } catch (err) {
      finish({ code: -1, stdout, stderr: err instanceof Error ? err.message : String(err) })
    }
  })
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/**
 * 探测本机有没有可用的 FFmpeg。
 *
 * - 逐个候选跑 `-version`；**第一个成功**的就是它；
 * - 全部失败 → `{ available: false }`（**不抛异常**：没装 FFmpeg 是正常状态）。
 */
export async function detectFfmpeg(deps: FfmpegDeps = {}): Promise<FfmpegStatus> {
  const run = deps.run ?? defaultRun
  const candidates = deps.candidates ?? DEFAULT_FFMPEG_CANDIDATES
  for (const candidate of candidates) {
    let result: FfmpegRunResult
    try {
      result = await run(candidate, ['-version'])
    } catch {
      continue
    }
    if (result.code !== 0) continue
    const firstLine = (result.stdout.split('\n')[0] ?? '').trim()
    return { available: true, path: candidate, version: firstLine }
  }
  return { available: false, path: '', version: '' }
}

// ---------------------------------------------------------------------------
// 错误文案
// ---------------------------------------------------------------------------

/**
 * 从 ffmpeg 的 stderr 里挑一句**人能看懂**的原因。
 *
 * - 取**最后一个**非空行（ffmpeg 的结论在最后）；
 * - 去掉 `ffmpeg` 前缀与路径噪声；
 * - 截断到 200 字（别把整屏日志甩给用户）。
 */
export function readableFfmpegError(stderr: string): string {
  const lines = (stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const last = lines.length > 0 ? (lines[lines.length - 1] as string) : ''
  if (last.length === 0) return '未知错误'
  const cleaned = last.replace(/^ffmpeg(\.exe)?:\s*/i, '').replace(/^Error\s+/i, '')
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

// ---------------------------------------------------------------------------
// 转码
// ---------------------------------------------------------------------------

/**
 * 把本地音频文件转成 **Opus**（Ogg 容器，Chromium 能解）。
 *
 * @param input  输入文件（**必须是本地路径**）。
 * @param output 输出文件（`.opus`）。
 * @param deps   可选依赖（`binary` 可省一次探测）。
 *
 * @throws 转码失败时抛出**可读**错误（不含凭证）。
 */
export async function transcodeToOpus(
  input: string,
  output: string,
  deps: FfmpegDeps = {},
): Promise<void> {
  const run = deps.run ?? defaultRun
  const binary = deps.binary ?? (await detectFfmpeg(deps)).path
  if (!binary) {
    throw new Error('未找到 FFmpeg 可执行文件')
  }

  const result = await run(binary, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    FALLBACK_BITRATE,
    '-ar',
    FALLBACK_SAMPLE_RATE,
    '-ac',
    FALLBACK_CHANNELS,
    '-f',
    'opus',
    output,
  ])

  if (result.code !== 0) {
    throw new Error(readableFfmpegError(result.stderr))
  }
}
