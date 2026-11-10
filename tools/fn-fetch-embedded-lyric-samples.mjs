#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 下载「音频内嵌歌词」的**真实**测试样本（T84）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么样本不进仓库**：这批 `SYLT` 语料是 **CC BY-SA 4.0**
//    （录音 tim.kahn，改编 Christian Weiske）⇒ 进库要带署名 + 相同方式共享
//    ⇒ 用户 2026-11-10 拍板：**只留本脚本 + 下载 URL**，样本只在本机复验。
//    CI 用**自造夹具**钉行为（`test/embedded-lyric-tags.test.ts`），
//    真文件由本脚本拉下来后由 `test/embedded-lyric-real-samples.test.ts` 验。
//
// 用法：
//   node tools/fn-fetch-embedded-lyric-samples.mjs
//   → 样本落在 `release/samples/embedded-lyric/`（**gitignored**，不进版本库）
//
// ⚠️ **只读**：本脚本**只下载**到临时目录，**不碰**用户的任何音乐文件。
// ---------------------------------------------------------------------------

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(REPO, 'release', 'samples', 'embedded-lyric')

/** 样本清单（来源与许可都写在这里，别丢）。 */
const SAMPLES = [
  {
    file: 'karaoke.mp3',
    url: 'https://raw.githubusercontent.com/Fat-Zer/lollypop-SYLT-tests/master/tests/karaoke.mp3',
    expect: '**真逐字**（每个词各带时间戳）⇒ 进卡拉OK',
  },
  {
    file: 'utf8-desc.mp3',
    url: 'https://raw.githubusercontent.com/Fat-Zer/lollypop-SYLT-tests/master/tests/utf8-desc.mp3',
    expect: '**行级**（UTF-8 + 带内容描述符）⇒ 整行显示',
  },
  {
    file: 'countdown.mp3',
    url: 'https://raw.githubusercontent.com/Fat-Zer/lollypop-SYLT-tests/master/tests/countdown.mp3',
    expect: '**没有任何歌词标签** ⇒ 行为与今天一致（回落 NAS / 「暂无歌词」）',
  },
]

const LICENSE = 'CC BY-SA 4.0（录音 tim.kahn，改编 Christian Weiske）'

/** 下载一个文件（**跟随重定向**）。 */
async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status} ${url}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
  return statSync(target).size
}

/** 造一个带 `LYRICS` 注释的**真 FLAC**（用 ffmpeg —— 第三方实现，不是我们自己写的）。 */
function makeFlacWithLyrics(target) {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    console.warn('⚠️ 本机没有 ffmpeg ⇒ 跳过 FLAC 样本。')
    console.warn('   手工命令：')
    console.warn(
      `   ffmpeg -f lavfi -i "sine=frequency=440:duration=12" -c:a flac -metadata "LYRICS=${LRC}" "${target}"`,
    )
    return false
  }
  const lrc = '[00:01.00]第一行歌词\\n[00:05.50]第二行歌词\\n[00:09.25]第三行歌词'
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:a', 'flac',
      '-metadata', `LYRICS=${lrc}`,
      target,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    console.warn('⚠️ ffmpeg 造 FLAC 失败：', (result.stderr ?? '').trim())
    return false
  }
  return true
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('[samples] 目标目录 =', OUT_DIR)
  console.log('[samples] 许可 =', LICENSE)
  console.log('')

  for (const sample of SAMPLES) {
    const target = join(OUT_DIR, sample.file)
    if (existsSync(target)) {
      console.log(`[samples] ${sample.file} 已存在（${statSync(target).size} B）⇒ 跳过`)
    } else {
      const size = await download(sample.url, target)
      console.log(`[samples] ${sample.file} ← ${sample.url}（${size} B）`)
    }
    console.log(`           期望：${sample.expect}`)
  }

  const flac = join(OUT_DIR, 'flac-lyrics.flac')
  if (!existsSync(flac)) {
    if (makeFlacWithLyrics(flac)) {
      console.log(`[samples] flac-lyrics.flac（ffmpeg 写入 LYRICS 注释，${statSync(flac).size} B）`)
      console.log('           期望：**行级**（Vorbis 注释的 LYRICS）⇒ 整行显示')
    }
  } else {
    console.log(`[samples] flac-lyrics.flac 已存在 ⇒ 跳过`)
  }

  console.log('')
  console.log('[samples] 下一步：')
  console.log('  1) 跑真文件回归：node node_modules/vitest/vitest.mjs run test/embedded-lyric-real-samples.test.ts')
  console.log('  2) 或用探针看细节：node release/verify/t83-real-probe.mjs karaoke.mp3 utf8-desc.mp3 countdown.mp3')
}

main().catch((error) => {
  console.error('[samples] 失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
