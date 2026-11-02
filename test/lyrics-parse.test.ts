import { describe, it, expect } from 'vitest'
import {
  applyOffset,
  attachTranslations,
  findActiveLine,
  findActiveWord,
  parseEnhancedLrc,
  parseLrc,
  parseLyricEntries,
  splitIntoWords,
} from '../src/ui/lyrics/parse'
import type { LyricEntry } from '../src/api/types'

// ---------------------------------------------------------------------------
// Task 12：LRC 解析（行级 + 逐字）
//
// 歌词文本全部是**虚构占位**（甲/乙/丙/占位歌词…），不含任何真实歌曲歌词。
//
// 本文件覆盖：
// - 简报 Step 1 的原始用例（逐字保留其意图）；
// - 简报控制器追加要求 A（伪逐字兜底）/ B（翻译合并）/ C（offset）/ D（时间标签与边界）/ E（纯函数）；
// - 控制器追加要求 G（offset 方向）/ H（伪逐字切分粒度）/ I（parseEnhancedLrc 降级）
//   / J（LyricEntry 便利入口）/ K（纯度与边界）。
// ---------------------------------------------------------------------------

/** 构造一个歌词条目（占位数据，不含真实 FN ID / 账号）。 */
function entry(partial: Partial<LyricEntry> & { content: string }): LyricEntry {
  return {
    guid: 'example-guid',
    source: 'local',
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset: 0,
    ...partial,
  }
}

describe('parseLrc', () => {
  it('解析带时间标签的普通 LRC', () => {
    const lines = parseLrc('[00:12.00]第一句\n[00:15.30]第二句')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.time).toBe(12)
    expect(lines[1]!.text).toBe('第二句')
  })

  it('忽略元信息标签', () => {
    expect(parseLrc('[ti:歌名]\n[ar:歌手]\n[00:01.00]词')).toHaveLength(1)
  })

  it('兼容四种时间标签格式', () => {
    const lines = parseLrc('[00:12]甲\n[00:13.45]乙\n[00:14.678]丙\n[00:15:67]丁')
    expect(lines).toHaveLength(4)
    expect(lines[0]!.time).toBe(12)
    expect(lines[1]!.time).toBeCloseTo(13.45, 6)
    expect(lines[2]!.time).toBeCloseTo(14.678, 6)
    expect(lines[3]!.time).toBeCloseTo(15.67, 6)
  })

  it('分钟可以超过 59（长音频）', () => {
    const lines = parseLrc('[61:05.00]甲')
    expect(lines[0]!.time).toBe(3665)
  })

  it('一行多个时间标签展开成多行', () => {
    const lines = parseLrc('[00:10.00][00:20.00]同一句')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.time).toBe(10)
    expect(lines[1]!.time).toBe(20)
    expect(lines[0]!.text).toBe('同一句')
    expect(lines[1]!.text).toBe('同一句')
  })

  it('按时间升序排序（输入乱序）', () => {
    const lines = parseLrc('[00:30.00]后\n[00:10.00]前')
    expect(lines.map((l) => l.time)).toEqual([10, 30])
    expect(lines[0]!.text).toBe('前')
  })

  it('忽略没有时间标签的纯文本行与空行', () => {
    const lines = parseLrc('纯文本\n\n[00:01.00]甲\n\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toBe('甲')
  })

  it('空串 / null / undefined 输入返回空数组且不抛异常', () => {
    expect(parseLrc('')).toEqual([])
    expect(parseLrc(null as unknown as string)).toEqual([])
    expect(parseLrc(undefined as unknown as string)).toEqual([])
  })

  // --- 控制器追加要求 A：伪逐字兜底 ---------------------------------------

  it('伪逐字：非空、按行时长均匀切分、单调递增', () => {
    const lines = parseLrc('[00:10.00]占位歌词\n[00:20.00]下一句')
    expect(lines).toHaveLength(2)
    const words = lines[0]!.words
    expect(words.length).toBeGreaterThan(0)
    expect(words[0]!.start).toBe(lines[0]!.time)
    expect(words[words.length - 1]!.end).toBe(lines[1]!.time)
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.start).toBeGreaterThan(words[i - 1]!.start)
      expect(words[i]!.end).toBeGreaterThan(words[i - 1]!.end)
    }
    for (const word of words) {
      expect(word.start).toBeGreaterThanOrEqual(lines[0]!.time)
      expect(word.end).toBeLessThanOrEqual(lines[1]!.time)
      expect(word.end).toBeGreaterThan(word.start)
    }
  })

  it('伪逐字：最后一行 end = 自身 time + 0.5', () => {
    const lines = parseLrc('[00:10.00]甲乙')
    const words = lines[0]!.words
    expect(words[words.length - 1]!.end).toBeCloseTo(10.5, 6)
  })

  it('空文本行保留该行但 words 为空数组', () => {
    const lines = parseLrc('[00:10.00]\n[00:20.00]甲')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.text).toBe('')
    expect(lines[0]!.words).toEqual([])
  })

  // --- 简报 B：同一文件里相同时间戳的多行 --------------------------------

  it('相同时间戳多行：第一条作 text，其余作 translation（换行拼接）', () => {
    const lines = parseLrc('[00:10.00]甲\n[00:10.00]乙\n[00:10.00]丙')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toBe('甲')
    expect(lines[0]!.translation).toBe('乙\n丙')
  })
})

describe('parseEnhancedLrc', () => {
  it('解析逐字时间戳', () => {
    const lines = parseEnhancedLrc('[00:10.00]<00:10.00>你<00:10.50>好<00:11.00>世界')
    expect(lines[0]!.words).toHaveLength(3)
    expect(lines[0]!.words[0]!.text).toBe('你')
    expect(lines[0]!.words[2]!.start).toBe(11)
  })

  it('词尾时间取下一个词的开始时间，末词取下一行时间', () => {
    const lines = parseEnhancedLrc('[00:10.00]<00:10.00>甲<00:10.50>乙\n[00:20.00]<00:20.00>丙')
    expect(lines[0]!.words[0]!.end).toBeCloseTo(10.5, 6)
    expect(lines[0]!.words[1]!.end).toBe(20)
    expect(lines[0]!.text).toBe('甲乙')
  })

  it('末词没有下一行时 end = 自身 start + 0.5', () => {
    const lines = parseEnhancedLrc('[00:10.00]<00:10.00>甲')
    expect(lines[0]!.words[0]!.end).toBeCloseTo(10.5, 6)
  })

  // --- 控制器追加要求 I：真实数据只有行级 LRC，必须降级 --------------------

  it('没有逐字标签时降级成伪逐字，绝不返回空 words', () => {
    const raw = '[00:10.00]占位歌词\n[00:20.00]下一句'
    const lines = parseEnhancedLrc(raw)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words.length).toBeGreaterThan(0)
  })

  it('行级 LRC 输入上 parseLrc 与 parseEnhancedLrc 的 words 完全一致', () => {
    const raw = '[00:10.00]占位歌词\n[00:20.00]下一句'
    expect(parseEnhancedLrc(raw).map((l) => l.words)).toEqual(parseLrc(raw).map((l) => l.words))
  })

  it('空串 / null / undefined 输入返回空数组且不抛异常', () => {
    expect(parseEnhancedLrc('')).toEqual([])
    expect(parseEnhancedLrc(null as unknown as string)).toEqual([])
    expect(parseEnhancedLrc(undefined as unknown as string)).toEqual([])
  })
})

describe('findActiveLine', () => {
  it('返回当前时间所属行索引', () => {
    const lines = parseLrc('[00:10.00]A\n[00:20.00]B')
    expect(findActiveLine(lines, 5)).toBe(-1)
    expect(findActiveLine(lines, 12)).toBe(0)
    expect(findActiveLine(lines, 25)).toBe(1)
  })

  it('空数组返回 -1', () => {
    expect(findActiveLine([], 10)).toBe(-1)
  })

  it('左闭右开：t 等于行时间归属该行，t 等于下一行时间归属下一行', () => {
    const lines = parseLrc('[00:10.00]A\n[00:20.00]B')
    expect(findActiveLine(lines, 10)).toBe(0)
    expect(findActiveLine(lines, 20)).toBe(1)
  })
})

describe('findActiveWord', () => {
  const line = parseLrc('[00:10.00]甲乙丙\n[00:30.00]下一句')[0]!

  it('词区间左闭右开', () => {
    expect(findActiveWord(line, 10)).toBe(0)
    expect(findActiveWord(line, 12)).toBe(0)
    expect(findActiveWord(line, 20)).toBe(1)
    // t 恰好等于上一个词的 end → 归属下一个词（左闭右开）
    expect(findActiveWord(line, line.words[0]!.end)).toBe(1)
    expect(findActiveWord(line, line.words[1]!.start)).toBe(1)
  })

  it('早于第一个词返回 -1', () => {
    expect(findActiveWord(line, 9)).toBe(-1)
  })

  it('晚于最后一个词返回最后一个词索引', () => {
    expect(findActiveWord(line, 999)).toBe(line.words.length - 1)
  })

  it('words 为空返回 -1', () => {
    expect(findActiveWord({ time: 0, text: '', words: [], translation: '' }, 5)).toBe(-1)
  })
})

describe('attachTranslations', () => {
  it('时间戳精确匹配时挂上翻译', () => {
    const original = parseLrc('[00:10.00]甲\n[00:20.00]乙')
    const translation = parseLrc('[00:10.00]AAA\n[00:20.00]BBB')
    const merged = attachTranslations(original, translation)
    expect(merged[0]!.translation).toBe('AAA')
    expect(merged[1]!.translation).toBe('BBB')
  })

  it('时间戳有偏差时取最近的一行（容差 0.5s 内）', () => {
    const original = parseLrc('[00:10.00]甲\n[00:20.00]乙')
    const translation = parseLrc('[00:10.30]AAA\n[00:20.30]BBB')
    const merged = attachTranslations(original, translation)
    expect(merged[0]!.translation).toBe('AAA')
    expect(merged[1]!.translation).toBe('BBB')
  })

  it('超出容差（> 0.5s）留空串', () => {
    const original = parseLrc('[00:10.00]甲')
    const translation = parseLrc('[00:10.80]AAA')
    const merged = attachTranslations(original, translation)
    expect(merged[0]!.translation).toBe('')
  })

  it('合并不改变原文行的 time 与 words', () => {
    const original = parseLrc('[00:10.00]甲')
    const translation = parseLrc('[00:10.00]AAA')
    const merged = attachTranslations(original, translation)
    expect(merged[0]!.time).toBe(original[0]!.time)
    expect(merged[0]!.words).toEqual(original[0]!.words)
    expect(merged[0]!.text).toBe(original[0]!.text)
  })
})

describe('applyOffset', () => {
  it('正偏移 = 延后：时间戳加上偏移，词时间同步', () => {
    const lines = parseLrc('[00:10.00]甲乙\n[00:20.00]丙')
    const shifted = applyOffset(lines, 2000)
    expect(shifted[0]!.time).toBeCloseTo(12, 6)
    expect(shifted[0]!.words[0]!.start).toBeCloseTo(12, 6)
    expect(shifted[0]!.words[0]!.end).toBeCloseTo(12 + 5, 6)
  })

  it('负偏移 = 提前：时间戳减去偏移', () => {
    const lines = parseLrc('[00:10.00]甲')
    const shifted = applyOffset(lines, -3000)
    expect(shifted[0]!.time).toBeCloseTo(7, 6)
  })

  it('偏移后出现负数时间时钳到 0', () => {
    const lines = parseLrc('[00:05.00]甲')
    const shifted = applyOffset(lines, -10000)
    expect(shifted[0]!.time).toBe(0)
    expect(shifted[0]!.words[0]!.start).toBe(0)
    expect(shifted[0]!.words[0]!.end).toBe(0)
  })

  it('偏移后仍保持单调递增', () => {
    const lines = parseLrc('[00:10.00]甲乙丙\n[00:20.00]丁')
    const shifted = applyOffset(lines, 1500)
    for (const line of shifted) {
      for (let i = 1; i < line.words.length; i++) {
        expect(line.words[i]!.start).toBeGreaterThan(line.words[i - 1]!.start)
      }
    }
    expect(shifted[1]!.time).toBeGreaterThan(shifted[0]!.time)
  })
})

describe('parseLyricEntries', () => {
  it('两条记录（原文 + 翻译）：翻译挂到对应原文行', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'example-guid-1', content: '[00:10.00]甲\n[00:20.00]乙' }),
      entry({ guid: 'example-guid-2', content: '[00:10.00]AAA\n[00:20.00]BBB' }),
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]!.text).toBe('甲')
    expect(lines[0]!.translation).toBe('AAA')
    expect(lines[1]!.text).toBe('乙')
    expect(lines[1]!.translation).toBe('BBB')
  })

  it('只有一条记录时 translation 为空串', () => {
    const lines = parseLyricEntries([entry({ content: '[00:10.00]甲' })])
    expect(lines).toHaveLength(1)
    expect(lines[0]!.translation).toBe('')
  })

  it('空数组返回空数组', () => {
    expect(parseLyricEntries([])).toEqual([])
  })

  it('各自按自己的 offset 偏移后再对齐', () => {
    const lines = parseLyricEntries([
      entry({ content: '[00:10.00]甲\n[00:20.00]乙', offset: 1000 }),
      entry({ content: '[00:10.00]AAA\n[00:20.00]BBB', offset: 0 }),
    ])
    // 原文整体延后 1s
    expect(lines[0]!.time).toBeCloseTo(11, 6)
    // 翻译没偏移 → 与原文差 1s > 0.5s 容差 → 不挂上（证明翻译确实按自己的 offset 处理了）
    expect(lines[0]!.translation).toBe('')
  })

  it('翻译自身的 offset 生效且仍在容差内时能对齐', () => {
    const lines = parseLyricEntries([
      entry({ content: '[00:10.00]甲\n[00:20.00]乙', offset: 0 }),
      entry({ content: '[00:10.00]AAA\n[00:20.00]BBB', offset: 200 }),
    ])
    expect(lines[0]!.translation).toBe('AAA')
    expect(lines[1]!.translation).toBe('BBB')
  })
})

describe('splitIntoWords', () => {
  it('中文按字切分', () => {
    expect(splitIntoWords('占位歌词')).toEqual(['占', '位', '歌', '词'])
  })

  it('连续的拉丁字母 / 数字算一个词', () => {
    expect(splitIntoWords('hello')).toEqual(['hello'])
    expect(splitIntoWords('2024')).toEqual(['2024'])
    expect(splitIntoWords('hello2world')).toEqual(['hello2world'])
  })

  it('中英混排切分正确', () => {
    expect(splitIntoWords('占位hello2024歌词')).toEqual(['占', '位', 'hello2024', '歌', '词'])
  })

  it('标点不单独成词：并入前一个词，行首标点并入后一个词', () => {
    expect(splitIntoWords('占位，歌词')).toEqual(['占', '位，', '歌', '词'])
    expect(splitIntoWords('，占位')).toEqual(['，占', '位'])
  })

  it('拼回原文等于行文本去掉空白后的结果', () => {
    const samples = ['占位 hello 2024 歌词', 'hello, world!', '占位，歌词', '  纯空白  ']
    for (const sample of samples) {
      expect(splitIntoWords(sample).join('')).toBe(sample.replace(/\s+/g, ''))
    }
  })
})
