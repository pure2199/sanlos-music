// ---------------------------------------------------------------------------
// FFmpeg 兜底解码的**真机验证探针**（Task 12）
// ---------------------------------------------------------------------------
//
// 跑法（需要 Node ≥ 22.6 —— 用的是 Node 原生的类型剥离，**不经打包器**）：
// ```bash
// node tools/ffmpeg-verify.mts
// ```
//
// 它做四件事：
// 1. 用**仓库里真正的** `detectFfmpeg()` 探测本机 FFmpeg；
// 2. 造一个 1 秒 PCM WAV，用**仓库里真正的** `transcodeToOpus()` 转成 Opus；
// 3. 回读校验产物（`Audio: opus, 48000 Hz, stereo`）；
// 4. 核对本机 FFmpeg 对「Chromium 不可解的 14 种格式」的**实际**覆盖度。
//
// ⚠️ 第 4 项必须按 **FFmpeg 的真实名字**查：`wma` 的容器叫 `asf`、`alac` 在
//    `mov/mp4` 里、`ra` 的容器叫 `rm`、`dvf` 走 `dv`……
//    **拿格式名直接 grep 清单会得出错误结论**。
//
// ⚠️ 不含任何凭证；只读本机 FFmpeg 与临时目录。
// ---------------------------------------------------------------------------

import { writeFileSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { detectFfmpeg, transcodeToOpus, readableFfmpegError } from '../electron/ffmpeg.ts'

const dir = join(tmpdir(), 'fnm-ffmpeg-verify')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const wav = join(dir, 'probe.wav')
const opus = join(dir, 'probe.opus')

// --- 造一个 1 秒 / 44.1kHz / 单声道 的 PCM WAV ---
const sampleRate = 44100
const samples = sampleRate
const dataSize = samples * 2
const buffer = Buffer.alloc(44 + dataSize)
buffer.write('RIFF', 0)
buffer.writeUInt32LE(36 + dataSize, 4)
buffer.write('WAVE', 8)
buffer.write('fmt ', 12)
buffer.writeUInt32LE(16, 16)
buffer.writeUInt16LE(1, 20)
buffer.writeUInt16LE(1, 22)
buffer.writeUInt32LE(sampleRate, 24)
buffer.writeUInt32LE(sampleRate * 2, 28)
buffer.writeUInt16LE(2, 32)
buffer.writeUInt16LE(16, 34)
buffer.write('data', 36)
buffer.writeUInt32LE(dataSize, 40)
for (let i = 0; i < samples; i += 1) {
  buffer.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 12000), 44 + i * 2)
}
writeFileSync(wav, buffer)

// --- 1. 探测 ---
const status = await detectFfmpeg()
console.log('STATUS', JSON.stringify(status))

// --- 2. 转码 ---
try {
  await transcodeToOpus(wav, opus, { binary: status.path })
  console.log('TRANSCODE_OK', statSync(opus).size)
} catch (err) {
  console.log('TRANSCODE_FAIL', readableFfmpegError(err instanceof Error ? err.message : String(err)))
}

// --- 3. 回读校验（产物能不能被 ffmpeg 自己读回来） ---
if (status.available) {
  const probe = spawnSync(status.path, ['-hide_banner', '-i', opus], { encoding: 'utf8' })
  const out = `${probe.stderr ?? ''}`
  const line = out.split('\n').find((l) => l.includes('Audio:')) ?? '(no audio line)'
  console.log('PROBE', line.trim())
}

// --- 4. 覆盖度核对（按 FFmpeg 的**真实**名字查） ---
if (status.available) {
  const demuxers = spawnSync(status.path, ['-hide_banner', '-demuxers'], { encoding: 'utf8' }).stdout ?? ''
  const codecs = spawnSync(status.path, ['-hide_banner', '-codecs'], { encoding: 'utf8' }).stdout ?? ''

  /** 格式 → [解封装器名, 解码器名（可空）]。 */
  const table: Array<[string, string, string]> = [
    ['ape', 'ape', 'ape'],
    ['alac', 'mov', 'alac'],
    ['dsf', 'dsf', ''],
    ['dff', 'dsdiff', ''],
    ['wma', 'asf', 'wmav2'],
    ['dts', 'dts', 'dca'],
    ['aiff', 'aiff', 'pcm_s16le'],
    ['ra', 'rm', 'ra_144'],
    ['au', 'au', 'pcm_s16le'],
    ['dvf', 'dv', 'pcm_s16le'],
    ['tta', 'tta', 'tta'],
    ['dss', 'dss', ''],
    ['mmf', 'mmf', ''],
  ]

  const hasDemuxer = (text: string, name: string): boolean =>
    new RegExp(`(^|\\s)${name}(\\s|$)`, 'im').test(text)
  const hasDecoder = (text: string, name: string): boolean => {
    if (name === '') return true
    // `-codecs` 的行形如 ` DE..D wmav2  WMA version 2`。
    return new RegExp(`\\b${name}\\b`, 'im').test(text)
  }

  console.log('--- COVERAGE ---')
  for (const [label, demux, dec] of table) {
    const ok = hasDemuxer(demuxers, demux) && hasDecoder(codecs, dec)
    console.log(`${label.padEnd(6)} demux=${demux.padEnd(7)} dec=${(dec || '-').padEnd(12)} ${ok ? 'OK' : 'MISS'}`)
  }
  // dsd（裸 DSD 流）：ffmpeg 没有独立的裸流 demuxer，归在 dsf / dsdiff 里。
  console.log(`dsd    (raw) 归 dsf/dsdiff 处理`)
}

rmSync(dir, { recursive: true, force: true })
