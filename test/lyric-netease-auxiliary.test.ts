// ---------------------------------------------------------------------------
// T90-⑧：网易云「副行」（翻译 / 罗马音）以原文行为锚的重新定时
// ---------------------------------------------------------------------------
//
// 钉的是这几条：
// - ⚠️ **副行与逐字原文不在同一条时间轴上**：网易云的 `tlyric` / `romalrc`
//   与 `lrc`（行级原文）**精确同刻**，而 `yrc`（逐字原文）是**另一条轴**
//   （实测行间差最大 1899 ms）⇒ 副行原样直挂时渲染层的「精确匹配」**必然落空**
//   ⇒ 退到「≤ 0.5 s 就近」⇒ 实测丢 14%–72% 的行（详见规格 §16.2）；
// - **输出标签必须复用「原文行的原标签」**（逐字符一致）
//   ⇒ 渲染层 `attachAuxiliary` 的「时间戳精确匹配」分支**必然命中** ⇒ 零错行；
// - **文本桥**是副行与原文之间唯一可靠的桥（纯文本相同 + **顺序单调**）
//   ⇒ 副歌重复行不会逆序；
// - **宁缺勿错**：配不上的副行**直接丢弃**（不猜、不就近）。
//
// ⚠️ **样本是自编的假歌词**（不是任何真实歌曲）—— 与 `test/lyric-migu.test.ts` 同款纪律。
//
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { alignNeteaseAuxiliary } from '../electron/lyricAuxiliary'
import { attachRomanizations, parseEnhancedLrc } from '../src/ui/lyrics/parse'

// ---------------------------------------------------------------------------
// 样本
// ---------------------------------------------------------------------------

/**
 * 原文（**逐字**，即 `yrc` 转换后的增强 LRC）—— 行标签是**毫秒**精度。
 *
 * ⚠️ 它的行时间与 `LRC` **故意对不上**（`12.345` vs `12.34`、
 * `30.000` vs `30.00`、且多一行）⇒ 复刻实测到的「两条轴」。
 */
const ORIGINAL = ['[00:12.345]<00:12.345>甲<00:12.500>乙行', '[00:30.000]丙行'].join('\n')

/** 网易云**行级**原文（厘秒精度）—— 与副行精确同刻。 */
const LRC = ['[00:12.34]甲乙行', '[00:20.10]另一句', '[00:30.00]丙行'].join('\n')

/** 副行（罗马音）—— 与 `LRC` 精确同刻。 */
const ROMALRC = ['[00:12.34]jia yi hang', '[00:20.10]ling yi ju', '[00:30.00]bing hang'].join('\n')

// ---------------------------------------------------------------------------

describe('T90-⑧ · 网易云副行重新定时', () => {
  it('副行的时间戳被改写成**原文行**的时间标签（**逐字符一致**）', () => {
    const out = alignNeteaseAuxiliary(ORIGINAL, LRC, ROMALRC)
    expect(out).toContain('[00:12.345]jia yi hang')
    expect(out).toContain('[00:30.000]bing hang')
    // ⚠️ **不能**保留副行原来的厘秒标签（否则渲染层精确匹配会落空）。
    expect(out).not.toContain('[00:12.34]')
  })

  it('副行文本**原样保留**（不 trim 掉词内空格以外的东西）', () => {
    const out = alignNeteaseAuxiliary(ORIGINAL, LRC, ROMALRC)
    expect(out.split('\n')[0]).toBe('[00:12.345]jia yi hang')
  })

  it('原文里**没有**对应行的副行 ⇒ **不产出**（宁缺勿错）', () => {
    const out = alignNeteaseAuxiliary(ORIGINAL, LRC, ROMALRC)
    // `另一句` 只在 lrc / 副行里有，原文没有 ⇒ 不该出现。
    expect(out).not.toContain('ling yi ju')
    expect(out.split('\n')).toHaveLength(2)
  })

  it('原文 == lrc（**没有逐字**）时是 **no-op**：内容与时间都不变', () => {
    const lrc = '[00:10.00]占位歌词第一行\n[00:20.00]占位歌词第二行'
    const out = alignNeteaseAuxiliary(lrc, lrc, '[00:10.00]占位翻译')
    expect(out).toBe('[00:10.00]占位翻译')
  })

  it('副行的时间戳与原文**差得很远**也能靠**文本桥**挂上（核心）', () => {
    // 副行在 10 秒、原文在 90 秒 —— 直挂必然挂不上，文本桥能挂上。
    const original = '[01:30.000]远行'
    const lrc = '[00:10.00]远行'
    const auxiliary = '[00:10.00]yuan xing'
    const out = alignNeteaseAuxiliary(original, lrc, auxiliary)
    expect(out).toBe('[01:30.000]yuan xing')
  })

  it('配不上的副行**直接丢弃**（文本对不上 ⇒ 不猜）', () => {
    const out = alignNeteaseAuxiliary('[00:30.000]原文甲', '[00:10.00]原文乙', '[00:10.00]副行乙')
    expect(out).toBe('')
  })

  it('副歌重复行按**顺序单调**配对（**不逆序**）', () => {
    const original = ['[00:10.00]副歌', '[00:20.00]正文', '[00:30.00]副歌'].join('\n')
    const lrc = ['[00:10.00]副歌', '[00:20.00]正文', '[00:30.00]副歌'].join('\n')
    const auxiliary = ['[00:10.00]fu ge', '[00:20.00]zheng wen', '[00:30.00]fu ge'].join('\n')
    const out = alignNeteaseAuxiliary(original, lrc, auxiliary)
    expect(out.split('\n')).toHaveLength(3)
    expect(out.split('\n')[0]).toBe('[00:10.00]fu ge')
    expect(out.split('\n')[2]).toBe('[00:30.00]fu ge')
  })

  it('副行文本为空 ⇒ **不产出**（渲染层挂上去也是空串）', () => {
    const out = alignNeteaseAuxiliary('[00:30.000]甲行', '[00:10.00]甲行', '[00:10.00]')
    expect(out).toBe('')
  })

  it('空输入（原文 / lrc / 副行 任一为空）⇒ 返回**空串**，不抛异常', () => {
    expect(alignNeteaseAuxiliary('', LRC, ROMALRC)).toBe('')
    expect(alignNeteaseAuxiliary(ORIGINAL, '', ROMALRC)).toBe('')
    expect(alignNeteaseAuxiliary(ORIGINAL, LRC, '')).toBe('')
  })

  it('非字符串输入 ⇒ 返回**空串**，不抛异常', () => {
    const weird = undefined as unknown as string
    expect(alignNeteaseAuxiliary(weird, LRC, ROMALRC)).toBe('')
    expect(alignNeteaseAuxiliary(ORIGINAL, weird, ROMALRC)).toBe('')
    expect(alignNeteaseAuxiliary(ORIGINAL, LRC, weird)).toBe('')
  })

  it('一行**多个**时间标签 ⇒ 展开成多行（与渲染层同口径）', () => {
    const out = alignNeteaseAuxiliary('[00:10.00][00:20.00]甲行', '[00:10.00]甲行', '[00:10.00]jia')
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toBe('[00:10.00]jia')
  })

  it('原文含**逐字标签** ⇒ 文本比对时**去掉**逐字标签', () => {
    // 原文的纯文本是「甲乙行」（不是 `<00:12.345>甲<00:12.500>乙行`）。
    const out = alignNeteaseAuxiliary(ORIGINAL, LRC, ROMALRC)
    expect(out.split('\n')[0]).toBe('[00:12.345]jia yi hang')
  })

  it('副行的**时间标签精度**（厘秒）与原文（毫秒）不同 ⇒ 仍精确挂上', () => {
    const out = alignNeteaseAuxiliary(ORIGINAL, LRC, ROMALRC)
    // 输出必须是**原文**的毫秒标签。
    const first = out.split('\n')[0] ?? ''
    expect(first.startsWith('[00:12.345]')).toBe(true)
  })

  it('**不修改入参**（纯函数）', () => {
    const original = ORIGINAL
    const lrc = LRC
    const auxiliary = ROMALRC
    alignNeteaseAuxiliary(original, lrc, auxiliary)
    expect(original).toBe(ORIGINAL)
    expect(lrc).toBe(LRC)
    expect(auxiliary).toBe(ROMALRC)
  })

  it('**端到端**：渲染层挂上去的罗马音**逐行**落在正确的原文行上', () => {
    const originalLines = parseEnhancedLrc(ORIGINAL)
    const romaLines = parseEnhancedLrc(alignNeteaseAuxiliary(ORIGINAL, LRC, ROMALRC))
    const attached = attachRomanizations(originalLines, romaLines)
    expect(attached.map((line) => line.romanization)).toEqual(['jia yi hang', 'bing hang'])
  })

  it('**端到端**：副行与原文行**精确同刻**（渲染层走的是「精确匹配」分支，不是「就近」）', () => {
    const originalLines = parseEnhancedLrc(ORIGINAL)
    const romaLines = parseEnhancedLrc(alignNeteaseAuxiliary(ORIGINAL, LRC, ROMALRC))
    const originalTimes = new Set(originalLines.map((line) => line.time))
    expect(romaLines.every((line) => originalTimes.has(line.time))).toBe(true)
  })

  it('翻译与罗马音**同一套口径**（同一个函数，两种副行）', () => {
    const translation = alignNeteaseAuxiliary(ORIGINAL, LRC, ['[00:12.34]jia yi', '[00:30.00]bing'].join('\n'))
    expect(translation.split('\n')[0]).toBe('[00:12.345]jia yi')
  })
})
