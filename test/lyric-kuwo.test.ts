// ---------------------------------------------------------------------------
// T90-⑥：酷我 lrcx（真逐字）的解密与转换
// ---------------------------------------------------------------------------
//
// 钉的是这几条：
// - **解密**：`tp=content` → 跳 `\r\n\r\n` → zlib inflate → base64 → 循环 XOR ⇒ 明文；
//   头不对 / 载荷不是 zlib / 解出来没有时间戳 ⇒ **抛错**（如实报，不静默吞掉）；
// - ⚠️ **`<a,b>` 不是「开始毫秒 + 时长毫秒」** —— 必须用 `[kuwo:八进制]` 的偏移参数：
//       相对开始 = trunc(|a+b| / (offset×2))、相对时长 = trunc(|a-b| / (offset2×2))
//   ⇒ 同一份歌词换个 `[kuwo:…]` 参数 ⇒ **时间轴完全不同**（本文件有专门的用例钉住）；
// - **词时间 = 行首 + 相对毫秒**（酷我的词时间是**相对行开始**的）；
// - **翻译行**（同时间戳、排在原文行之前、词标签**全为 `<0,0>`**）
//   ⇒ 不进原文，只进 `kuwoToPlainLrc`；
// - **元信息行**（制作信息 `词：X` / 标题行）被丢掉；
// - ⚠️ **纯空格的词元组必须保留**（渲染层会 trim 掉它，
//   但行文本仍保留那个空格 ⇒ 丢了它英文歌词会显示成 `CountingStars`）。
//
// ⚠️ **真实密文不入库**：酷我的 XOR 密钥是**公开**的
//    ⇒ 真实密文入库 = 把歌词放进公开仓库。
//    ⇒ 这里用**自己合成**的密文，而且**独立手写**一份 XOR（不 import 生产代码的密钥）
//    ⇒ 生产代码的密钥写错时，**这些用例会红**。
//
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'

import { decodeKuwoLrcxPayload } from '../electron/lyricCodecs/kuwo'
import { kuwoToEnhancedLrc, kuwoToPlainLrc } from '../electron/lyricWordFormat'
import { looksLikeLrc } from '../electron/lyricProvider'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 酷我的 XOR 密钥（**独立手写**的一份 —— 故意**不** import 生产代码的常量）。
 *
 * ⚠️ 这样才有鉴别力：生产代码的密钥写错 ⇒ 解出来是乱码 ⇒ 用例红。
 */
const KEY_LITERAL: readonly number[] = [121, 101, 101, 108, 105, 111, 110] // "yeelion"

/**
 * 造一份**合成的**酷我 lrcx 载荷（**原始字节**）。
 *
 * ⚠️ **顺序必须与生产解码链严格相反**：
 *   生产：header → inflate ⇒ **base64 文本** → base64 解码 → **XOR** ⇒ UTF-8 明文
 *   ⇒ 合成：UTF-8 明文 → **XOR** → base64 编码 → deflate → 拼 header
 */
function makeKuwoPayload(plain: string): Uint8Array {
  const inner = Buffer.from(plain, 'utf8')
  for (let i = 0; i < inner.length; i += 1) {
    inner[i] = inner[i]! ^ KEY_LITERAL[i % KEY_LITERAL.length]!
  }
  const base64 = Buffer.from(inner.toString('base64'), 'utf8')
  const deflated = deflateSync(base64)
  const head = Buffer.from('TP=content\r\nlrcx=1\r\n\r\n', 'latin1')
  return new Uint8Array(Buffer.concat([head, deflated]))
}

/**
 * 造一个「相对开始 = S、相对时长 = D」的词标签。
 *
 * ⚠️ **手算推导**（`offset=2` / `offset2=8`，即 `[kuwo:034]`）：
 *   相对开始 = trunc(|a+b| / 4) = S ⇒ a+b = 4S
 *   相对时长 = trunc(|a-b| / 16) = D ⇒ a-b = 16D
 *   ⇒ a = 2S + 8D、b = 2S - 8D
 */
function tag(start: number, dur: number): string {
  const a = 2 * start + 8 * dur
  const b = 2 * start - 8 * dur
  return `<${a},${b}>`
}

/**
 * 给一行 lrcx 加上 `[kuwo:034]` 偏移参数。
 *
 * ⚠️ **必须加**：没有这个标签 ⇒ 走**缺省 1/1** ⇒ 词时间完全不同
 *    （缺省口径另有一条用例专门钉）。
 */
const WITH_SCALE = (line: string): string => `[kuwo:034]\n${line}`

/** 占位 lrcx 明文（**自己编的歌词**，不是任何真实歌曲）。 */
const SAMPLE_LRCX = [
  '[ml:1.0]',
  '[kuwo:034]',
  '[ver:v1.0]',
  '[ti:占位歌名]',
  '[ar:占位歌手]',
  '[offset:0]',
  // 标题行（含 ` - `）⇒ 必须被丢掉
  `[00:00.000]${tag(0, 500)}占位歌名${tag(500, 500)} - ${tag(1000, 500)}占位歌手`,
  // 制作信息行（`词：X`）⇒ 必须被丢掉
  `[00:07.433]${tag(0, 500)}词：${tag(500, 500)}占${tag(1000, 500)}位${tag(1500, 500)}人`,
  // 真正的歌词行
  `[00:08.222]${tag(0, 500)}这${tag(500, 500)}是${tag(1000, 500)}第一${tag(1500, 500)}行`,
  // 翻译行（同一时间戳、排在原文行**之前**、词标签**全为 <0,0>**）
  `[00:10.222]${tag(0, 0)}这${tag(0, 0)}是${tag(0, 0)}第${tag(0, 0)}二${tag(0, 0)}行`,
  `[00:10.222]${tag(0, 500)}这${tag(500, 500)}是${tag(1000, 500)}第${tag(1500, 500)}二${tag(2000, 500)}行`,
  `[00:13.222]${tag(0, 500)}第${tag(500, 500)}三${tag(1000, 500)}行`,
].join('\n')

// ---------------------------------------------------------------------------
// 解密
// ---------------------------------------------------------------------------

describe('T90-⑥ · 酷我 lrcx 解密', () => {
  it('`tp=content` → 跳分隔符 → zlib inflate → base64 → 循环 XOR ⇒ 明文', () => {
    const payload = makeKuwoPayload(SAMPLE_LRCX)
    expect(decodeKuwoLrcxPayload(payload)).toBe(SAMPLE_LRCX)
  })

  it('⚠️ **头不是 `tp=content` ⇒ 抛错**（如实报「源不可用」，不静默吞掉）', () => {
    const raw = Buffer.from('这不是酷我歌词', 'utf8')
    expect(() => decodeKuwoLrcxPayload(new Uint8Array(raw))).toThrow(/tp=content/)
  })

  it('⚠️ **空载荷 ⇒ 抛错**', () => {
    expect(() => decodeKuwoLrcxPayload(new Uint8Array(0))).toThrow()
  })

  it('⚠️ **头对但不是 zlib ⇒ 抛错**（解压失败）', () => {
    const head = Buffer.from('TP=content\r\nlrcx=1\r\n\r\n', 'latin1')
    const body = Buffer.from('这不是 zlib 流', 'utf8')
    expect(() => decodeKuwoLrcxPayload(new Uint8Array(Buffer.concat([head, body])))).toThrow()
  })

  it('⚠️ **缺少头部分隔符 ⇒ 抛错**', () => {
    const raw = Buffer.from('TP=content没有分隔符', 'utf8')
    expect(() => decodeKuwoLrcxPayload(new Uint8Array(raw))).toThrow(/分隔符/)
  })

  it('⚠️ **解出来没有时间戳 ⇒ 抛错**（密钥或格式变了 ⇒ 如实报错）', () => {
    const payload = makeKuwoPayload('这里没有任何时间戳')
    expect(() => decodeKuwoLrcxPayload(payload)).toThrow(/时间戳/)
  })
})

// ---------------------------------------------------------------------------
// 转换
// ---------------------------------------------------------------------------

describe('T90-⑥ · 酷我 lrcx → 增强 LRC', () => {
  it('⚠️ **词时间是「行首 + 相对」**（行首 08.222 ⇒ 首词 08.222、次词 08.722）', () => {
    const out = kuwoToEnhancedLrc(SAMPLE_LRCX)
    expect(out.split('\n')[0]).toBe(
      '[00:08.222]<00:08.222>这<00:08.722>是<00:09.222>第一<00:09.722>行',
    )
  })

  it('⚠️ **元信息行被丢掉**（标题行 + 制作信息行）', () => {
    const out = kuwoToEnhancedLrc(SAMPLE_LRCX, { title: '占位歌名' })
    expect(out).not.toContain('占位歌手')
    expect(out).not.toContain('词：')
    expect(out.split('\n')).toHaveLength(3)
  })

  it('⚠️ **翻译行不进原文**（同时间戳、词标签全 `<0,0>`）', () => {
    const out = kuwoToEnhancedLrc(SAMPLE_LRCX)
    // 翻译行与原文行**同一时间戳** ⇒ 只该出现**一次**。
    expect(out.split('\n').filter((line) => line.startsWith('[00:10.222]'))).toHaveLength(1)
  })

  it('⚠️ **`[kuwo:…]` 参数真的被用上了**（换参数 ⇒ 时间轴完全不同）', () => {
    const variant = SAMPLE_LRCX.replace('[kuwo:034]', '[kuwo:140]')
    const out = kuwoToEnhancedLrc(variant)
    // ⚠️ `[kuwo:140]` ⇒ offset=9 / offset2=6 ⇒
    //   相对开始 = trunc(|a+b|/18)、相对时长 = trunc(|a-b|/12)
    //   ⇒ `<4000,-4000>` 起点 0 / 时长 666；`<5000,-3000>` 起点 111
    expect(out.split('\n')[0]).toBe('[00:08.222]<00:08.222>这<00:08.333>是<00:08.444>第一<00:08.555>行')
  })

  it('⚠️ **没有 `[kuwo:…]` ⇒ 缺省 1/1**（洛雪的缺省口径）', () => {
    const variant = SAMPLE_LRCX.replace('[kuwo:034]\n', '')
    const out = kuwoToEnhancedLrc(variant)
    // offset=1 / offset2=1 ⇒ 相对开始 = trunc(|a+b|/2)、相对时长 = trunc(|a-b|/2)
    //   `<4000,-4000>` 起点 0 / 时长 4000；`<5000,-3000>` 起点 1000
    expect(out.split('\n')[0]).toBe(
      '[00:08.222]<00:08.222>这<00:09.222>是<00:10.222>第一<00:11.222>行',
    )
  })

  it('⚠️ **`[kuwo:000]` ⇒ 抛错**（offset=0 ⇒ 除零 ⇒ 这份歌词的时间轴全错）', () => {
    const variant = SAMPLE_LRCX.replace('[kuwo:034]', '[kuwo:000]')
    expect(() => kuwoToEnhancedLrc(variant)).toThrow(/\[kuwo:\]/)
  })

  it('⚠️ **纯空格的词元组被保留**（丢了它英文歌词的空格就没了）', () => {
    const line = `[00:08.222]${tag(0, 500)}Hello${tag(500, 500)} ${tag(1000, 500)}World`
    const out = kuwoToEnhancedLrc(WITH_SCALE(line))
    expect(out).toBe('[00:08.222]<00:08.222>Hello<00:08.722> <00:09.222>World')
  })

  it('⚠️ **词内含空白 ⇒ 拆成多个独立词**（渲染层不会拆它 ⇒ 填色不会分段重置）', () => {
    const line = `[00:08.222]${tag(0, 500)}Hello World${tag(500, 500)}Next`
    const out = kuwoToEnhancedLrc(WITH_SCALE(line))
    // 「Hello World」按字符数比例拆成两个词：起点 8222 / 8472。
    expect(out).toBe('[00:08.222]<00:08.222>Hello <00:08.472>World<00:08.722>Next')
  })

  it('⚠️ **空文本的词不产出标签**（没有文字的「词」不是词）', () => {
    const line = `[00:08.222]${tag(0, 500)}有${tag(500, 500)}字${tag(1000, 500)}`
    const out = kuwoToEnhancedLrc(WITH_SCALE(line))
    expect(out).toBe('[00:08.222]<00:08.222>有<00:08.722>字')
  })

  it('⚠️ **零时长词并入前一个词**（不单独成词）', () => {
    const line = `[00:08.222]${tag(0, 500)}前${tag(500, 0)}标${tag(500, 500)}点`
    const out = kuwoToEnhancedLrc(WITH_SCALE(line))
    expect(out).toBe('[00:08.222]<00:08.222>前标<00:08.722>点')
  })

  it('⚠️ **没有行头的行（各种标签行）全部丢掉**', () => {
    const out = kuwoToEnhancedLrc(SAMPLE_LRCX)
    expect(out).not.toContain('占位歌名]')
    expect(out).not.toContain('[ti:')
    expect(out).not.toContain('[ml:')
  })

  it('**空串 / 非串 ⇒ 返回空串**（不抛异常）', () => {
    expect(kuwoToEnhancedLrc('')).toBe('')
    expect(kuwoToEnhancedLrc(undefined as unknown as string)).toBe('')
    expect(kuwoToPlainLrc('')).toBe('')
    expect(kuwoToPlainLrc(undefined as unknown as string)).toBe('')
  })

  it('**产出的确是 LRC**（渲染层的 `looksLikeLrc` 认）', () => {
    expect(looksLikeLrc(kuwoToEnhancedLrc(SAMPLE_LRCX))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 翻译
// ---------------------------------------------------------------------------

describe('T90-⑥ · 酷我 lrcx → 行级 LRC（翻译）', () => {
  it('⚠️ **翻译行只进行级 LRC**（词标签全 `<0,0>` ⇒ 没有逐字时间）', () => {
    expect(kuwoToPlainLrc(SAMPLE_LRCX)).toBe('[00:10.222]这是第二行')
  })

  it('⚠️ **原文行不进翻译**', () => {
    const plain = kuwoToPlainLrc(SAMPLE_LRCX)
    expect(plain).not.toContain('第一行')
    expect(plain).not.toContain('第三行')
  })

  it('⚠️ **翻译里的制作信息也丢掉**', () => {
    const line = `[00:08.222]${tag(0, 0)}词：${tag(0, 0)}占位人`
    expect(kuwoToPlainLrc(line)).toBe('')
  })
})
