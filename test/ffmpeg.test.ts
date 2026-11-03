import { describe, it, expect, vi } from 'vitest'

import {
  DEFAULT_FFMPEG_CANDIDATES,
  FALLBACK_BITRATE,
  FALLBACK_CHANNELS,
  FALLBACK_SAMPLE_RATE,
  detectFfmpeg,
  readableFfmpegError,
  transcodeToOpus,
  type FfmpegRunResult,
} from '../electron/ffmpeg'

// ---------------------------------------------------------------------------
// Task 12：FFmpeg 探测与转码
//
// 覆盖：
// - 探测：第一个能跑 `-version` 的候选即命中；全失败 → 未安装（**不抛异常**）；
// - 转码：参数正确（libopus / 160k / 48000 / 2ch / `-f opus`）；失败 → 可读错误；
// - 错误文案：取 stderr **最后一行**、去掉 `ffmpeg:` 前缀、截断到 200 字。
//
// ⚠️ **绝不真的起进程**——外部命令一律注入替身。
// ⚠️ 全部数据都是**虚构占位**，不含任何真实 FN ID / 账号 / 密码 / 路径。
// ---------------------------------------------------------------------------

/** 造一个「执行结果」。 */
function result(partial: Partial<FfmpegRunResult> = {}): FfmpegRunResult {
  return { code: 0, stdout: '', stderr: '', ...partial }
}

describe('detectFfmpeg', () => {
  it('第一个能跑 -version 的候选即命中', async () => {
    const run = vi.fn(async (command: string) => {
      if (command === 'b') return result({ stdout: 'ffmpeg version 9.0.2\nbuilt with gcc\n' })
      return result({ code: 1, stderr: 'not found' })
    })
    const status = await detectFfmpeg({ run, candidates: ['a', 'b', 'c'] })
    expect(status.available).toBe(true)
    expect(status.path).toBe('b')
    expect(status.version).toBe('ffmpeg version 9.0.2')
    // 命中就**停**：后面的候选不再试。
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('全部失败 → 未安装（available=false，**不抛异常**）', async () => {
    const run = vi.fn(async () => result({ code: 1, stderr: 'nope' }))
    const status = await detectFfmpeg({ run, candidates: ['a', 'b'] })
    expect(status).toEqual({ available: false, path: '', version: '' })
  })

  it('候选执行抛异常 → 跳过该候选，继续试下一个', async () => {
    const run = vi.fn(async (command: string) => {
      if (command === 'a') throw new Error('spawn ENOENT')
      return result({ stdout: 'ffmpeg version 9.0.2\n' })
    })
    const status = await detectFfmpeg({ run, candidates: ['a', 'b'] })
    expect(status.available).toBe(true)
    expect(status.path).toBe('b')
  })

  it('默认候选第一个是裸命令名（走 PATH）', () => {
    expect(DEFAULT_FFMPEG_CANDIDATES[0]).toBe('ffmpeg')
    expect(DEFAULT_FFMPEG_CANDIDATES.length).toBeGreaterThan(1)
  })
})

describe('transcodeToOpus', () => {
  it('参数正确：libopus / 160k / 48000 / 2 声道 / `-f opus`', async () => {
    const run = vi.fn(async () => result())
    await transcodeToOpus('C:\\in.ape', 'C:\\out.opus', { run, binary: 'ffmpeg' })
    expect(run).toHaveBeenCalledTimes(1)
    const [command, args] = run.mock.calls[0] as unknown as [string, string[]]
    expect(command).toBe('ffmpeg')
    expect(args).toContain('-nostdin')
    expect(args).toContain('-y')
    expect(args).toContain('libopus')
    expect(args).toContain(FALLBACK_BITRATE)
    expect(args).toContain(FALLBACK_SAMPLE_RATE)
    expect(args).toContain(FALLBACK_CHANNELS)
    expect(args).toContain('opus')
    // 输入与输出路径都在参数里（**不经过 shell**）。
    expect(args).toContain('C:\\in.ape')
    expect(args).toContain('C:\\out.opus')
  })

  it('退出码非 0 → 抛可读错误（不含整屏日志）', async () => {
    const run = vi.fn(async () =>
      result({ code: 1, stderr: 'ffmpeg: Invalid data found when processing input\n' }),
    )
    await expect(
      transcodeToOpus('C:\\in.ape', 'C:\\out.opus', { run, binary: 'ffmpeg' }),
    ).rejects.toThrow('Invalid data found when processing input')
  })

  it('找不到可执行文件 → 抛「未找到 FFmpeg 可执行文件」', async () => {
    const run = vi.fn(async () => result({ code: 1 }))
    await expect(
      transcodeToOpus('C:\\in.ape', 'C:\\out.opus', { run, candidates: ['x'] }),
    ).rejects.toThrow('未找到 FFmpeg 可执行文件')
  })
})

describe('readableFfmpegError', () => {
  it('取最后一个非空行', () => {
    expect(readableFfmpegError('first\nsecond\nlast\n')).toBe('last')
  })

  it('去掉 ffmpeg: 前缀', () => {
    expect(readableFfmpegError('ffmpeg: boom')).toBe('boom')
    expect(readableFfmpegError('ffmpeg.exe: boom')).toBe('boom')
  })

  it('空 stderr → 未知错误', () => {
    expect(readableFfmpegError('')).toBe('未知错误')
    expect(readableFfmpegError('   \n  ')).toBe('未知错误')
  })

  it('过长时截断到 200 字（别把整屏日志甩给用户）', () => {
    const out = readableFfmpegError('x'.repeat(500))
    expect(out.length).toBeLessThanOrEqual(201)
    expect(out.endsWith('…')).toBe(true)
  })
})
