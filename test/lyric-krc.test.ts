// ---------------------------------------------------------------------------
// T90-⑤：酷狗 KRC（真逐字）的解密与转换
// ---------------------------------------------------------------------------
//
// 钉的是这几条：
// - **解密**：base64 → 跳 `krc1` → 循环 XOR → zlib inflate ⇒ 明文；
//   头不对 / 载荷不是 zlib / 空载荷 ⇒ **抛错**（如实报，不静默吞掉）；
// - **词时间 = 行首 + 相对毫秒**（KRC 的词时间是**相对行开始**的）；
// - **元信息行**（制作信息 / 标题行）被丢掉 —— 包括酷狗**特有**的
//   「作词：」「作曲：」（QQ 的 QRC 写的是「词：」「曲：」）；
// - **词内含空白** ⇒ 拆成多个独立词（否则卡拉OK 填色会分段重置）；
// - **零时长词**并入前一个词；**空文本的词**不产出标签；
//
// ⚠️ **真实密文不入库**：KRC 的 XOR 密钥是**公开**的
//    ⇒ 真实密文入库 = 把歌词放进公开仓库。
//    ⇒ 这里用**自己合成**的密文，而且**独立手写**一份 XOR（不 import 生产代码的密钥）
//    ⇒ 生产代码的密钥写错时，**这些用例会红**。
//
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'

import { decodeKrcPayload, decodeKrcPlainPayload } from '../electron/lyricCodecs/krc'
import { krcToEnhancedLrc, isQrcCreditLine, isQrcMetaLine } from '../electron/lyricWordFormat'
import { looksLikeLrc } from '../electron/lyricProvider'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * KRC 的 XOR 密钥（**独立手写**的一份 —— 故意**不** import 生产代码的常量）。
 *
 * ⚠️ 这样才有鉴别力：生产代码的密钥写错 ⇒ 解出来是乱码 ⇒ 用例红。
 */
const KRC_KEY_LITERAL: readonly number[] = [
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
]

/** 造一份**合成的** KRC 密文（base64 文本）。 */
function makeKrcPayload(plain: string): string {
  const deflated = deflateSync(Buffer.from(plain, 'utf8'))
  const body = Buffer.from(deflated)
  for (let i = 0; i < body.length; i += 1) {
    body[i] = body[i]! ^ KRC_KEY_LITERAL[i % KRC_KEY_LITERAL.length]!
  }
  return Buffer.concat([Buffer.from('krc1', 'latin1'), body]).toString('base64')
}

/** 占位 KRC 明文（**自己编的歌词**，不是任何真实歌曲）。 */
const SAMPLE_KRC = [
  '[id:00000000]',
  '[ti:占位歌名]',
  '[ar:占位歌手]',
  // 第 1 条候选行：四个词（相对 0 / 500 / 1000 / 1500）
  '[0,2000]<0,500,0>占<500,500,0>位<1000,500,0>歌<1500,500,0>词',
  // 第 2 条候选行：词时间是**相对行开始**的（0 / 1000 ⇒ 绝对 2000 / 3000）
  '[2000,3000]<0,1000,0>这是<1000,1000,0>第二行',
  // 第 3 条候选行：零时长词（中间那个）要并入前一个词
  '[5000,1500]<0,500,0>前<500,0,0>标<500,500,0>点',
].join('\n')

// ---------------------------------------------------------------------------
// 解密
// ---------------------------------------------------------------------------

describe('T90-⑤ · KRC 解密', () => {
  it('base64 → 跳 `krc1` → 循环 XOR → zlib inflate ⇒ 明文', () => {
    const payload = makeKrcPayload(SAMPLE_KRC)
    expect(decodeKrcPayload(payload)).toBe(SAMPLE_KRC)
  })

  it('⚠️ **BOM 保留**（实测酷狗的明文可能带 UTF-8 BOM）', () => {
    const withBom = `\uFEFF${SAMPLE_KRC}`
    expect(decodeKrcPayload(makeKrcPayload(withBom))).toBe(withBom)
  })

  it('⚠️ **头不是 `krc1` ⇒ 抛错**（如实报「源不可用」，不静默吞掉）', () => {
    const raw = Buffer.from('这不是 KRC 密文', 'utf8')
    expect(() => decodeKrcPayload(raw.toString('base64'))).toThrow(/krc1/)
  })

  it('⚠️ **空载荷 ⇒ 抛错**', () => {
    expect(() => decodeKrcPayload('')).toThrow()
    expect(() => decodeKrcPayload('   ')).toThrow()
  })

  it('⚠️ **头对但不是 zlib ⇒ 抛错**（解压失败）', () => {
    const head = Buffer.from('krc1', 'latin1')
    const junk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    expect(() => decodeKrcPayload(Buffer.concat([head, junk]).toString('base64'))).toThrow(
      /解压失败/,
    )
  })

  it('**行级载荷**（`fmt=lrc`）只做 base64 解码，不解密', () => {
    const lrc = '[00:12.00]占位歌词'
    expect(decodeKrcPlainPayload(Buffer.from(lrc, 'utf8').toString('base64'))).toBe(lrc)
    expect(() => decodeKrcPlainPayload('')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// KRC → 增强 LRC
// ---------------------------------------------------------------------------

describe('T90-⑤ · KRC → 增强 LRC', () => {
  it('⚠️ **词时间 = 行首 + 相对毫秒**（KRC 的词时间是相对的！）', () => {
    const out = krcToEnhancedLrc(SAMPLE_KRC)
    const lines = out.split('\n')
    // 第 2 条候选行的首词：相对 0 ⇒ 绝对 = 行首 2000 ⇒ `00:02.00`
    expect(lines[1]).toBe('[00:02.00]<00:02.00>这是<00:03.00>第二行')
    // ⚠️ **不能**写成 `[00:00.00]<00:00.00>这是…`（那就是「忘了加行首」）
    expect(lines[1]).not.toContain('<00:00.00>')
  })

  it('**无行头的行**（`[id:]` / `[ti:]` / `[ar:]`）全部丢掉', () => {
    const out = krcToEnhancedLrc(SAMPLE_KRC)
    expect(out).not.toContain('占位歌名')
    expect(out).not.toContain('占位歌手')
    expect(out.split('\n')).toHaveLength(3)
  })

  it('**输出能被 `looksLikeLrc` 接受**', () => {
    expect(looksLikeLrc(krcToEnhancedLrc(SAMPLE_KRC))).toBe(true)
  })

  it('**零时长词并入前一个词**；空文本的词不产出标签', () => {
    const out = krcToEnhancedLrc(SAMPLE_KRC)
    const third = out.split('\n')[2]!
    // 「前」+ 零时长的「标」⇒ 合起来是「前标」；「点」是独立的一个词
    expect(third).toBe('[00:05.00]<00:05.00>前标<00:05.50>点')
  })

  it('⚠️ **词内含空白 ⇒ 拆成多个独立词**（否则渲染层会把填色分段重置）', () => {
    // ⚠️ 样本要有**下一行** —— 词尾（= 拆词的时间跨度）取「下一行的行时间」
    //    （与渲染层 `assemble` 同口径），不是源给的词时长。
    const krc = ['[0,2000]<0,1000,0>Hello World', '[2000,2000]<0,1000,0>下一行'].join('\n')
    const out = krcToEnhancedLrc(krc)
    // 拆成两个独立词 ⇒ **两个**逐字标签（而不是一个含空白的标签）
    //    （跨度 0→2000ms ⇒ 两个片段各占一半 ⇒ 第二个片段起点 1000ms）
    expect(out.split('\n')[0]).toBe('[00:00.00]<00:00.00>Hello <00:01.00>World')
    expect(out.match(/</g)).toHaveLength(3)
  })

  it('**不丢字**（转换前后的纯文字逐字相同）', () => {
    const out = krcToEnhancedLrc(SAMPLE_KRC)
    // ⚠️ **两种标签都要去掉**：行标签 `[00:00.00]` 与逐字标签 `<00:00.50>`。
    const plain = out.replace(/[\[<]\d{2}:\d{2}\.\d{2,3}[>\]]/g, '').replace(/\n/g, '')
    expect(plain).toBe('占位歌词这是第二行前标点')
  })

  it('**空串 / 非串 ⇒ 空串**（不抛异常）', () => {
    expect(krcToEnhancedLrc('')).toBe('')
    expect(krcToEnhancedLrc(undefined as unknown as string)).toBe('')
    expect(krcToEnhancedLrc('这一行没有行头')).toBe('')
  })

  it('⚠️ **BOM 的明文也能解析**（实测酷狗的明文可能带 BOM）', () => {
    const out = krcToEnhancedLrc(`\uFEFF${SAMPLE_KRC}`)
    expect(out.split('\n')).toHaveLength(3)
    expect(out.split('\n')[0]).toBe('[00:00.00]<00:00.00>占<00:00.50>位<00:01.00>歌<00:01.50>词')
  })
})

// ---------------------------------------------------------------------------
// 元信息行（酷狗特有角色词）
// ---------------------------------------------------------------------------

describe('T90-⑤ · 元信息行过滤（酷狗特有角色词）', () => {
  it('⚠️ **「作词：」「作曲：」必须判为制作信息**（酷狗实测有、QQ 白名单原本没有）', () => {
    expect(isQrcCreditLine('作词：占位词作者')).toBe(true)
    expect(isQrcCreditLine('作曲：占位曲作者')).toBe(true)
    // ⚠️ 复合形态（带修饰前缀）也要命中
    expect(isQrcCreditLine('联合作词：占位词作者')).toBe(true)
  })

  it('⚠️ **防误杀**：「词不达意：」这种歌词行**不能**被当成制作信息', () => {
    expect(isQrcCreditLine('词不达意：占位歌词')).toBe(false)
    expect(isQrcCreditLine('她说：不要走')).toBe(false)
  })

  it('**标题行**（带歌名提示 ⇒ 不论多长都认得出）', () => {
    const longTitle = '占位歌名 (《占位动画》主题曲 - 占位特别版) - 占位歌手 (Placeholder Artist)'
    expect(longTitle.length).toBeGreaterThan(30)
    // ⚠️ 没有提示 ⇒ 认不出（兜底启发式仍然生效）
    expect(isQrcMetaLine(longTitle, 0)).toBe(false)
    // ⚠️ 给了歌名 ⇒ 认得出
    expect(isQrcMetaLine(longTitle, 0, { title: '占位歌名' })).toBe(true)
  })

  it('⚠️ **KRC 里带标题行 ⇒ 那一行不进歌词**', () => {
    const krc = [
      '[0,2000]<0,1000,0>占位歌词',
      '[2000,3000]<0,1000,0>占位歌名 (《占位动画》主题曲) - 占位歌手',
    ].join('\n')
    const out = krcToEnhancedLrc(krc, { title: '占位歌名' })
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toContain('占位歌词')
    expect(out).not.toContain('占位歌手')
  })
})
