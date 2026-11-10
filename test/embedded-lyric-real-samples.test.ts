// ---------------------------------------------------------------------------
// T84：**真实文件**回归（音频内嵌歌词）
// ---------------------------------------------------------------------------
//
// ⚠️ **这组样本不在仓库里**（`SYLT` 语料是 CC BY-SA 4.0 ⇒ 进库要带署名 + 相同方式共享
//    ⇒ 用户 2026-11-10 拍板：**只留探针脚本 + 下载 URL**）。
//    ⇒ 样本**没下载**时**整组 skip**（CI 不依赖网络）。
//
// 拉样本：`node tools/fn-fetch-embedded-lyric-samples.mjs`
//        （落到 `release/samples/embedded-lyric/`，**gitignored**）
//
// ⚠️ **为什么非要真实文件**：自造夹具只能证明「我们读得懂自己写的东西」；
//    真实文件才能暴露**约定分歧**（T84 就是这么发现的：mutagen 写出的 `SYLT`
//    声明「时间戳格式 = 2」而存的**是毫秒** ⇒ 按 ID3 规范整帧放弃就等于功能没有）。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readFileTags, type TagFileSystem } from '../electron/audioTags'
import { parseEnhancedLrc } from '../src/ui/lyrics/parse'

/** 仓库根（不靠 cwd）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 真实样本目录（gitignored；没下载 ⇒ 整组 skip）。 */
const SAMPLE_DIR = join(REPO_ROOT, 'release', 'samples', 'embedded-lyric')

/** 样本是否已就位。 */
const HAVE_SAMPLES = existsSync(SAMPLE_DIR)

/** 真实的文件系统读取（**只读**）。 */
const fsImpl: TagFileSystem = {
  readBytes: async (path, offset, length) => {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, offset)
      return buffer.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  },
  statSize: async (path) => {
    try {
      const info = statSync(path)
      return info.isFile() ? info.size : null
    } catch {
      return null
    }
  },
}

/** 读一个样本的内嵌歌词（**没标签 ⇒ 空串**）。 */
async function readLyrics(file: string): Promise<string> {
  const path = join(SAMPLE_DIR, file)
  if (!existsSync(path)) throw new Error(`样本没下载：${file}（先跑 tools/fn-fetch-embedded-lyric-samples.mjs）`)
  const tags = await readFileTags(fsImpl, path)
  return tags?.lyrics ?? ''
}

describe.skipIf(!HAVE_SAMPLES)('T84 真实文件回归（音频内嵌歌词）', () => {
  it('karaoke.mp3（mutagen 写的 `SYLT`：声明格式 2、存的却是毫秒）⇒ **真逐字**', async () => {
    const lyrics = await readLyrics('karaoke.mp3')
    expect(lyrics.length).toBeGreaterThan(0)
    const lines = parseEnhancedLrc(lyrics)
    const wordTimed = lines.filter((line) => line.wordTimed)
    // ⚠️ **鉴别力**：必须是**逐字**（每个词各带时间戳）⇒ 卡拉OK 才成立。
    expect(wordTimed.length).toBeGreaterThan(0)
    const first = wordTimed[0]
    expect((first?.words ?? []).length).toBeGreaterThan(1)
    // ⚠️ 词与词之间的**空格**必须保留（否则行文本会变成「Helloworld」）。
    expect(first?.text).toContain(' ')
  })

  it('utf8-desc.mp3（UTF-8 + 带内容描述符）⇒ **行级**（整行显示，不假装逐字）', async () => {
    const lyrics = await readLyrics('utf8-desc.mp3')
    expect(lyrics.length).toBeGreaterThan(0)
    const lines = parseEnhancedLrc(lyrics)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter((line) => line.wordTimed)).toHaveLength(0)
  })

  it('countdown.mp3（**没有任何**歌词标签）⇒ 没有内嵌歌词（行为与今天一致）', async () => {
    const lyrics = await readLyrics('countdown.mp3')
    expect(lyrics).toBe('')
  })

  it('flac-lyrics.flac（Vorbis 注释的 `LYRICS`）⇒ 读出行级歌词', async () => {
    const lyrics = await readLyrics('flac-lyrics.flac')
    expect(lyrics.length).toBeGreaterThan(0)
    const lines = parseEnhancedLrc(lyrics)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter((line) => line.wordTimed)).toHaveLength(0)
  })
})
