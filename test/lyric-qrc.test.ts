// ---------------------------------------------------------------------------
// T90-④：QQ 逐字歌词（QRC 解密 + 格式转换 + 取词链路）
// ---------------------------------------------------------------------------
//
// 覆盖三件事：
//
// 1. **3DES 核心**（纯 JS 移植）：round-trip + **S 盒差分**；
// 2. **上游差分锚点**：同一份「QRC 形状」的密文 ⇒ 本实现与**洛雪上游**
//    解出的明文**逐字节相同**（期望值由上游产出后固化在此）；
// 3. **QRC → 增强 LRC** 的转换（元信息行过滤 / 防误杀）与
//    `fetchQq` 的**逐字链路**（行级兜底、翻译、罗马音）。
//
// ⚠️ **为什么不能用 `node:crypto` 交叉验证**（本任务的核心风险）：
//    QRC 用的是**非标准 DES 变体** ⇒ OpenSSL 的标准 `des-ede3` **解不开**它；
//    实测把「洛雪注释里说的那两处」改回标准值后**仍与 `node:crypto` 对不上**，
//    穷举单点 / 双点修正**都无解** ⇒ 差异**不止那两处**
//    ⇒ 唯一可靠的外部锚点是**与洛雪上游逐字节差分**（见下面第 2 组）。
//
// ⚠️ 测试数据一律用**占位**（甲行 / 甲罗…），**不含真实歌曲歌词、不含真实密文**。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'

import type { ExternalLyricQuery } from '../shared/lyricProvider'
import { createLyricProvider } from '../electron/lyricProvider'
import {
  decrypt3des,
  encrypt3des,
  decodeQrc,
  QRC_KEY,
  QRC_SBOX,
  QRC_SBOX_WITH_STANDARD_VALUES,
} from '../electron/lyricCodecs/qrc'
import {
  isQrcCreditLine,
  isQrcMetaLine,
  isQrcTitleLine,
  qrcToEnhancedLrc,
  qrcToPlainLrc,
} from '../electron/lyricWordFormat'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 用**本实现**造一份「QRC 形状」的密文（占位内容）。
 *
 * ⚠️ 形状与 QQ 服务端一致：zlib deflate ⇒ **补齐到 8 的倍数** ⇒ 3DES-EDE3（ECB）。
 */
function makeQrcHex(plain: string): string {
  const compressed = deflateSync(Buffer.from(plain, 'utf8'))
  const padded = Buffer.alloc(Math.ceil(compressed.length / 8) * 8)
  compressed.copy(padded)
  return Buffer.from(encrypt3des(new Uint8Array(padded), QRC_KEY, QRC_SBOX)).toString('hex')
}

/** 造的 fetch 替身：按「URL 包含什么」返回对应响应。 */
function makeFetch(
  routes: { match: string; status?: number; body: string }[],
): { fetchImpl: (input: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input)
    const hit = routes.find((route) => input.includes(route.match))
    if (!hit) return new Response('not found', { status: 404 })
    return new Response(hit.body, {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

/** 造的查询条件。 */
const QUERY: ExternalLyricQuery = {
  title: '占位歌名',
  artist: '占位歌手',
  album: '占位专辑',
  duration: 200,
}

// ---------------------------------------------------------------------------
// ① 3DES 核心
// ---------------------------------------------------------------------------

describe('3DES 核心（QRC 的非标准 S 盒）', () => {
  it('round-trip：QRC 表加密 → QRC 表解密 ⇒ **原样回来**', () => {
    const plain = Buffer.from('占位明文占位明文占位明文占位明文', 'utf8')
    const encrypted = encrypt3des(new Uint8Array(plain), QRC_KEY, QRC_SBOX)
    const decrypted = decrypt3des(encrypted, QRC_KEY, QRC_SBOX)
    expect(Buffer.from(decrypted).equals(plain)).toBe(true)
  })

  it('round-trip：多分组（> 8 字节）也一致（ECB：逐分组独立）', () => {
    const plain = Buffer.from('占位明文占位明文占位明文占位明文占位明文占位明文', 'utf8')
    const encrypted = encrypt3des(new Uint8Array(plain), QRC_KEY, QRC_SBOX)
    expect(Buffer.from(decrypt3des(encrypted, QRC_KEY, QRC_SBOX)).equals(plain)).toBe(true)
  })

  it('⚠️ **S 盒补丁是两处**（S2[23]=15、S4[53]=10；标准是 14 / 1）', () => {
    expect(QRC_SBOX[1]![23]).toBe(15)
    expect(QRC_SBOX[3]![53]).toBe(10)
    expect(QRC_SBOX_WITH_STANDARD_VALUES[1]![23]).toBe(14)
    expect(QRC_SBOX_WITH_STANDARD_VALUES[3]![53]).toBe(1)
  })

  it('⚠️ **两张表只有那两处不同**（其余逐项一致）', () => {
    let diff = 0
    for (let table = 0; table < 8; table += 1) {
      for (let index = 0; index < 64; index += 1) {
        if (QRC_SBOX[table]![index] !== QRC_SBOX_WITH_STANDARD_VALUES[table]![index]) diff += 1
      }
    }
    expect(diff).toBe(2)
  })

  it('⚠️ **换表 ⇒ 解出的东西不一样**（证明那两处改动**真的在起作用**）', () => {
    const plain = Buffer.from('占位明文占位明文占位明文占位明文', 'utf8')
    const encrypted = encrypt3des(new Uint8Array(plain), QRC_KEY, QRC_SBOX)
    const withQrc = decrypt3des(encrypted, QRC_KEY, QRC_SBOX)
    const withStandard = decrypt3des(encrypted, QRC_KEY, QRC_SBOX_WITH_STANDARD_VALUES)
    expect(Buffer.from(withQrc).equals(plain)).toBe(true)
    expect(Buffer.from(withStandard).equals(plain)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ② 上游差分锚点（外部正确性的**唯一**保证）
// ---------------------------------------------------------------------------

describe('与洛雪上游的差分锚点', () => {
  /**
   * 这份密文由**洛雪上游**（Apache-2.0，`release/verify/lx-qrcDecode.mjs`，
   * **不入库**）解出下面这段明文 ⇒ 把它固化成**期望值**。
   *
   * ⚠️ **为什么是「占位歌词」而不是真实密文**：QRC 的密钥是**公开的**
   *    （洛雪的源码里就是字面量）⇒ 真实密文入库 = 等于把歌词放进公开仓库。
   */
  const FIXTURE_HEX =
    '92f516b702d52ca3d44d4b4a0cd6902cdd1c0aacd11497077298565c931bb9f61' +
    'f24c39ed13f0f3f5aaf6ecf6b1415ddac06179326e5ae850fa27117db558eaa784' +
    '5ac13dd6440e0c941a2ff83362f7352521dd23f513ab09f0a2991889e451e7ae8a4' +
    '2e9643bcc6d1da6ee88cfcf87c9db3ea9450cc0a5f5f102aed92e9e3774592c4b61' +
    'ac6dfedae97d9d8d5ae7489'

  /** 上游解出的明文（**逐字节**）。 */
  const FIXTURE_PLAIN =
    '[ti:占位歌名]\n[ar:占位歌手]\n[0,3000](0,500)甲(500,500)乙(1000,500)丙(1500,500)丁\n' +
    '[3000,2000](3000,1000)戊(4000,1000)己\n[5000,2000]占位副行\n[6000,1000]编曲：占位制作人'

  it('本实现解出的明文与**上游逐字节相同**', async () => {
    expect(await decodeQrc(FIXTURE_HEX)).toBe(FIXTURE_PLAIN)
  })

  it('同一份密文，**换 S 盒表**就解不出那个明文了（锚点对表敏感 ⇒ 有效）', async () => {
    const wrong = await decodeQrc(FIXTURE_HEX, QRC_SBOX_WITH_STANDARD_VALUES)
    expect(wrong).not.toBe(FIXTURE_PLAIN)
  })

  it('本实现造出的占位密文 ⇒ 能原样解回来（自造自解闭环）', async () => {
    const plain = '[0,1000](0,500)甲(500,500)乙'
    expect(await decodeQrc(makeQrcHex(plain))).toBe(plain)
  })
})

// ---------------------------------------------------------------------------
// ③ decodeQrc 的容错
// ---------------------------------------------------------------------------

describe('decodeQrc（失败一律返回空串，不抛异常）', () => {
  it('空串 / 奇数长度 hex → 空串', async () => {
    expect(await decodeQrc('')).toBe('')
    expect(await decodeQrc('abc')).toBe('')
  })

  it('非 hex 字符 → 空串', async () => {
    expect(await decodeQrc('zzzz')).toBe('')
  })

  it('解不开的密文（zlib 报错）→ 空串', async () => {
    const garbage = Buffer.from('这不是压缩数据', 'utf8').toString('hex')
    expect(await decodeQrc(garbage)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// ④ QRC → 增强 LRC
// ---------------------------------------------------------------------------

describe('qrcToEnhancedLrc（QRC → 增强 LRC）', () => {
  it('行头 `[起ms,时长]` → `[mm:ss.xx]`，词元组 → `<mm:ss.xx>` 逐字标签', () => {
    const qrc = '[10000,2000](10000,500)甲(10500,500)行'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00>甲<00:10.50>行')
  })

  it('**绝对毫秒**的词时间（与行首同量纲，实测 QQ 就是这样）→ 原样用', () => {
    const qrc = '[10000,2000](10500,500)甲'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.50>甲')
  })

  it('**相对行首**的词时间（比行首小）→ 加上行首（兜底判定）', () => {
    const qrc = '[10000,2000](500,500)甲'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.50>甲')
  })

  it('没有词元组的行 → **只有行级标签**（行级 LRC）', () => {
    const qrc = '[10000,2000]只有行级文本'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]只有行级文本')
  })

  it('元信息行（`[ti:]` 之类，**无行头**）→ 丢掉（不是歌词行）', () => {
    const qrc = '[ti:占位歌名]\n[ar:占位歌手]\n[10000,2000](10000,500)甲'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00>甲')
  })

  it('⚠️ **制作信息行**（`编曲：X` 这种**带行头**的）→ **丢掉**', () => {
    const qrc = '[10000,2000](10000,500)编曲：占位制作人\n[20000,2000](20000,500)甲'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:20.00]<00:20.00>甲')
  })

  it('⚠️ **防误杀**：以「曲」开头的**歌词行**（后面没有冒号）→ **保留**', () => {
    const qrc = '[10000,2000](10000,500)曲终人散'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00>曲终人散')
  })

  it('⚠️ **防误杀**：歌词里带冒号、但**角色词不在开头** → 保留', () => {
    const qrc = '[10000,2000](10000,500)她说：不要走'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00>她说：不要走')
  })

  it('**零时长词**（标点 / 停顿占位）→ 并入前一个词', () => {
    const qrc = '[10000,2000](10000,500)甲(10500,0)，(11000,500)乙'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00>甲，<00:11.00>乙')
  })

  it('⚠️ **空文本的词**（实测：QRC 每行末尾的终止标记）→ **不产出标签**', () => {
    // 第三个词元组**没有文字**（时长还不为零）⇒ 它不是词 ⇒ 不该出标签。
    const qrc = '[10000,2000](10000,500)甲(10500,500)乙(11000,100)'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00>甲<00:10.50>乙')
  })

  it('⚠️ **真机回归补的洞**：给了**歌名提示** ⇒ **长标题行**被丢掉', () => {
    // ⚠️ 实测《孤勇者》的 QRC 标题行 **45 字** ⇒ 「≤30 字」的启发式认不出 ⇒ 显示成歌词。
    const title = '占位歌名 (《占位动画剧集》中文主题曲) - 占位歌手 (Placeholder Name)'
    const qrc = `[0,5000](0,1000)${title}\n[10000,2000](10000,500)甲`
    // 没有提示 ⇒ **既有行为不变**（这条长标题行会被留下）。
    expect(qrcToEnhancedLrc(qrc)).toContain('占位歌名')
    // 给了歌名 ⇒ 标题行被丢掉（只留真正的歌词行）。
    expect(qrcToEnhancedLrc(qrc, { title: '占位歌名' })).toBe('[00:10.00]<00:10.00>甲')
  })

  it('⚠️ **词内含空白** ⇒ **拆成多个独立词**（否则填色会分段重置）', () => {
    // ⚠️ 实测：QQ 会把**整段英文**塞进**一个**词元组 ⇒ 渲染层会把它拆成多个 DOM 元素
    //    （共用同一个词号）⇒ 填色**每片段各自从 0 起算**。
    // ⇒ 转换层就拆成**独立词**：时间按字符数比例分配。
    //
    // ⚠️ **跨度口径 = 渲染层给的词尾**（这里是「行时间 + 0.5s」= 10500ms）⇒
    //    三个片段把 500ms **均匀**分成 3 份（4/4/4 个非空白字符）。
    //    ⚠️ 10167ms / 10333ms **不是 10 的倍数** ⇒ 标签用**毫秒**精度（3 位小数）。
    const qrc = '[10000,2000](10000,1000)Some text here'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00>Some <00:10.167>text <00:10.333>here')
  })

  it('⚠️ **拆词后文字一个不丢**（拼回去 === 原文）', () => {
    const qrc = '[10000,2000](10000,1000)Some text here'
    const out = qrcToEnhancedLrc(qrc)
    expect(out.replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '')).toBe('Some text here')
  })

  it('⚠️ **词首/词尾多出来的空格**不拆（渲染层 trim 后它们本就不算词）', () => {
    // 「 甲」这种**首尾**空白 ⇒ 渲染层 trim 掉 ⇒ 不会拆 ⇒ 转换层也不该拆。
    const qrc = '[10000,2000](10000,1000) 甲'
    expect(qrcToEnhancedLrc(qrc)).toBe('[00:10.00]<00:10.00> 甲')
  })

  it('空串 / 非串 → 空串（**不抛异常**）', () => {
    expect(qrcToEnhancedLrc('')).toBe('')
    expect(qrcToEnhancedLrc('不是歌词')).toBe('')
  })
})

describe('qrcToPlainLrc（翻译 / 罗马音 → 行级 LRC）', () => {
  it('行头 → `[mm:ss.xx]`，文本原样', () => {
    expect(qrcToPlainLrc('[10000,2000]占位翻译')).toBe('[00:10.00]占位翻译')
  })

  it('有词元组 → **只取文本**（副行没有逐字）', () => {
    expect(qrcToPlainLrc('[10000,2000](10000,500)占位(10500,500)翻译')).toBe(
      '[00:10.00]占位翻译',
    )
  })

  it('元信息行 → 丢掉；空串 → 空串', () => {
    expect(qrcToPlainLrc('[ti:占位歌名]\n[10000,2000]占位翻译')).toBe('[00:10.00]占位翻译')
    expect(qrcToPlainLrc('')).toBe('')
  })

  it('⚠️ **制作信息行**同样丢掉（与逐字那条**同一口径**）', () => {
    expect(qrcToPlainLrc('[10000,2000]制作人：占位')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// ⑤ 元信息行判定
// ---------------------------------------------------------------------------

describe('元信息行判定', () => {
  it('制作信息行：实测到的 **12 种**角色词形态**全部命中**', () => {
    const roles = [
      '词：占位',
      '曲：占位',
      '编曲：占位',
      '吉他：占位',
      '人声录音师：占位',
      '混音/母带：占位',
      '词版权管理方：占位',
      '曲版权管理方：占位',
      '录音作品及MV版权：占位',
      '出品监制：占位',
      '制作人：占位',
      '联合出品方：占位',
    ]
    for (const text of roles) {
      expect(isQrcCreditLine(text)).toBe(true)
    }
  })

  it('⚠️ **复合角色词**（带修饰前缀的）也能命中', () => {
    expect(isQrcCreditLine('联合制作人：占位')).toBe(true)
    expect(isQrcCreditLine('联合出品：占位')).toBe(true)
  })

  it('⚠️ **防误杀**：普通歌词**不算**制作信息', () => {
    const lyrics = ['曲终人散', '歌词滚烫', '鼓声渐渐远去', '封面是你', '直到天亮']
    for (const text of lyrics) {
      expect(isQrcCreditLine(text)).toBe(false)
    }
  })

  it('⚠️ **防误杀**：以「词」开头但**不是**角色词的歌词（`词不达意：…`）→ 不算', () => {
    expect(isQrcCreditLine('词不达意：占位')).toBe(false)
  })

  it('⚠️ **防误杀**：冒号在**角色词之前**（歌词自带的冒号）→ 不算', () => {
    expect(isQrcCreditLine('她说：不要走')).toBe(false)
  })

  it('⚠️ **真机回归补的洞**：QQ 实测到的两个角色词（`人声录音棚` / `Vocal edite`）', () => {
    // ⚠️ 这两个是 2026-11-14 真机回归**实测漏网**的（它们会**当成歌词显示出来**）。
    expect(isQrcCreditLine('人声录音棚：占位录音室')).toBe(true)
    expect(isQrcCreditLine('Vocal edite：占位人名')).toBe(true)
  })

  it('⚠️ **英文角色词**：**多词**形态才算（单个英文词不能误杀歌词）', () => {
    expect(isQrcCreditLine('Mixing Engineer：占位人名')).toBe(true)
    // ⚠️ **单个**英文词 ⇒ 不算（`Baby：Don't cry` 这种是歌词 ⇒ 不能误杀）。
    expect(isQrcCreditLine('Baby：占位歌词')).toBe(false)
    expect(isQrcCreditLine('Mixing：占位人名')).toBe(false)
  })

  it('标题行：**三个条件全满足**才判是（前 5 条候选行 + ≤30 字 + 含 ` - `）', () => {
    expect(isQrcTitleLine('占位歌名 - 占位歌手', 0)).toBe(true)
    // ① 不在前 5 条候选行内
    expect(isQrcTitleLine('占位歌名 - 占位歌手', 5)).toBe(false)
    // ② 超过 30 字
    expect(isQrcTitleLine(`${'长'.repeat(29)} - 占位歌手`, 0)).toBe(false)
    // ③ 没有 ` - `
    expect(isQrcTitleLine('占位歌名占位歌手', 0)).toBe(false)
  })

  it('⚠️ **真机回归补的洞**：长标题行靠**歌名提示**认（QQ 实测那条有 45 字）', () => {
    // ⚠️ 实测《孤勇者》的 QRC 标题行 45 字 ⇒ 「≤30 字」的启发式**认不出** ⇒ 整行显示成歌词。
    const longTitle = '占位歌名 (《占位动画剧集》中文主题曲) - 占位歌手 (Placeholder Name)'
    expect(longTitle.length).toBeGreaterThan(30)
    // 没有提示 ⇒ 认不出（兜底启发式仍然生效 ⇒ **既有行为不变**）。
    expect(isQrcTitleLine(longTitle, 0)).toBe(false)
    // 给了歌名 ⇒ 认得出（**不论多长、不论在第几条**）。
    expect(isQrcTitleLine(longTitle, 0, { title: '占位歌名' })).toBe(true)
    // ⚠️ 歌名带后缀（`占位歌名 (Live)`）⇒ 取「括号前」的那部分去比对。
    expect(isQrcTitleLine(longTitle, 0, { title: '占位歌名 (Live)' })).toBe(true)
    // ⚠️ **防误杀**：只是「包含」歌名不够 —— 必须是**开头**，且这一行得像标题。
    expect(isQrcTitleLine(`歌词里出现${longTitle}`, 0, { title: '占位歌名' })).toBe(false)
    expect(isQrcTitleLine('占位歌名占位歌手', 0, { title: '占位歌名' })).toBe(false)
  })

  it('isQrcMetaLine = 制作信息 **或** 标题行', () => {
    expect(isQrcMetaLine('编曲：占位', 0)).toBe(true)
    expect(isQrcMetaLine('占位歌名 - 占位歌手', 0)).toBe(true)
    expect(isQrcMetaLine('普通歌词', 0)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ⑥ fetchQq 的逐字链路
// ---------------------------------------------------------------------------

describe('fetchQq 的逐字链路', () => {
  /** 造的 QQ 搜索响应（带 `songid` —— 实测每条候选都有）。 */
  function searchBody(songs: unknown[]): string {
    return JSON.stringify({ code: 0, data: { song: { list: songs } } })
  }

  /** 造的 QQ 行级歌词响应。 */
  function lineBody(lyric: string, trans = ''): string {
    return JSON.stringify({ retcode: 0, code: 0, subcode: 0, lyric, trans })
  }

  /** 造的 `musicu.fcg` 逐字响应。 */
  function musicuBody(lyric: string, trans = '', roma = ''): string {
    return JSON.stringify({ code: 0, req: { code: 0, data: { lyric, trans, roma } } })
  }

  /** 搜索结果里带 `songid` 的那条候选。 */
  const SONGS = [
    { songmid: '002', songid: 123456, songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
  ]

  /** 占位逐字歌词（形状与真实 QRC 一致）。 */
  const WORD_QRC = [
    '[0,3000](0,500)甲(500,500)乙(1000,500)丙(1500,500)丁',
    '[3000,2000](3000,1000)戊(4000,1000)己',
    '[5000,2000]占位副行',
  ].join('\n')

  /** 上面那份逐字歌词转出来的**增强 LRC**。 */
  const WORD_ENHANCED_LRC = [
    '[00:00.00]<00:00.00>甲<00:00.50>乙<00:01.00>丙<00:01.50>丁',
    '[00:03.00]<00:03.00>戊<00:04.00>己',
    '[00:05.00]占位副行',
  ].join('\n')

  it('逐字成功 ⇒ **原文用逐字**，翻译仍用行级', async () => {
    const { fetchImpl, calls } = makeFetch([
      { match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp', body: searchBody(SONGS) },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lineBody('[00:10.00]占位行级原文', '[00:10.00]占位翻译'),
      },
      { match: 'u.y.qq.com/cgi-bin/musicu.fcg', body: musicuBody(makeQrcHex(WORD_QRC)) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe(WORD_ENHANCED_LRC)
    expect(result.translation).toBe('[00:10.00]占位翻译')
    // ⚠️ **行级仍然是第 2 个请求**（既有生产路径与既有断言都不变）。
    expect(calls[1]).toContain('fcg_query_lyric_new.fcg')
    expect(calls[1]).toContain('songmid=002')
  })

  it('逐字失败（接口 404）⇒ **回落行级**（能力只增不减）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp', body: searchBody(SONGS) },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lineBody('[00:10.00]占位行级原文'),
      },
      { match: 'u.y.qq.com/cgi-bin/musicu.fcg', status: 404, body: 'not found' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.original).toBe('[00:10.00]占位行级原文')
  })

  it('逐字带罗马音 ⇒ **第三行有值**（`romanization`）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp', body: searchBody(SONGS) },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lineBody('[00:10.00]占位行级原文'),
      },
      {
        match: 'u.y.qq.com/cgi-bin/musicu.fcg',
        body: musicuBody(makeQrcHex(WORD_QRC), '', makeQrcHex('[0,1000]a b c')),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.romanization).toBe('[00:00.00]a b c')
  })

  it('逐字没有罗马音 ⇒ **不带** `romanization` 键（缺省即「没有」）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp', body: searchBody(SONGS) },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lineBody('[00:10.00]占位行级原文'),
      },
      { match: 'u.y.qq.com/cgi-bin/musicu.fcg', body: musicuBody(makeQrcHex(WORD_QRC)) },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect('romanization' in result).toBe(false)
  })

  it('⚠️ **两路都失败 ⇒ 报行级的错误**（不是逐字的）', async () => {
    const { fetchImpl } = makeFetch([
      { match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp', body: searchBody(SONGS) },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        status: 404,
        body: 'not found',
      },
      { match: 'u.y.qq.com/cgi-bin/musicu.fcg', status: 500, body: 'boom' },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('404')
  })

  it('⚠️ 搜索结果里**没有** `songid` ⇒ **不再**发逐字请求（不出网）', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: 'c.y.qq.com/soso/fcgi-bin/client_search_cp',
        body: searchBody([
          { songmid: '002', songname: '占位歌名', interval: 200, singer: [{ name: '占位歌手' }] },
        ]),
      },
      {
        match: 'c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        body: lineBody('[00:10.00]占位行级原文'),
      },
    ])
    const provider = createLyricProvider({ fetchImpl })
    const result = await provider.fetchExternalLyric('qq', '', QUERY)
    expect(result.status).toBe('ok')
    expect(calls.some((url) => url.includes('musicu.fcg'))).toBe(false)
  })
})
