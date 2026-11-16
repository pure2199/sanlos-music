// ---------------------------------------------------------------------------
// T96：榜单条目 ↔ 曲库的**匹配**（纯函数）回归测试
// ---------------------------------------------------------------------------
//
// 覆盖的是**判据**的每一环：
//
//   1. 归一化：NFKC / 去空白 / 去标点 / **保留括号内容** / 转小写
//   2. 歌手候选：单歌手 / `' / '` 多歌手 / **名字里本来带斜杠**（`AC/DC`）
//   3. 匹配判据：歌名全等 + 歌手相交 + **时长闸 ±3 秒**
//
// ⚠️ **总原则：宁可漏匹配，不可误匹配** ——
//    误匹配 = 用户看到「在库」点进去却播了**另一首歌**（比没匹配上严重得多）。
//    ⇒ 「时长全对不上 ⇒ 不匹配」「括号内容必须保留」这两条都有专门的用例钉住。
//
// ⚠️ 测试数据全是**占位数据**（假歌名 / 假歌手），不写真实曲库内容。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  artistCandidates,
  CHART_DURATION_TOLERANCE_SECONDS,
  matchChartEntry,
  normalizeText,
  type MatchableEntry,
  type MatchableSong,
} from '../shared/chartMatch'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造一首候选歌。 */
function song(
  id: string,
  title: string,
  artist: string,
  duration: number | null = 200,
): MatchableSong {
  return { id, title, artist, duration }
}

/** 造一条榜单条目。 */
function entry(
  title: string,
  artists: string[],
  duration: number | null = 200,
): MatchableEntry {
  return { title, artists, duration }
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

describe('T96 归一化（normalizeText）', () => {
  it('NFKC：全角 → 半角（「（」与「(」等价）', () => {
    expect(normalizeText('（青春）')).toBe(normalizeText('(青春)'))
  })

  it('去所有空白：本地多歌手用「\' / \'」连接、榜源用「/」⇒ 两边等价', () => {
    expect(normalizeText('云 旗')).toBe('云旗')
    expect(normalizeText('A / B')).toBe('a/b')
  })

  it('去标点：逗号 / 句号 / 顿号 / 连字符都去掉', () => {
    expect(normalizeText('稻香，周杰伦')).toBe('稻香周杰伦')
    expect(normalizeText('Hello, World.')).toBe('helloworld')
  })

  it('⚠️ **保留括号里的内容**（去掉括号会让 Live 版匹配到录音室版）', () => {
    // ⚠️ 规则是「**去括号本体、保留括号里的内容**」：
    //    「Song (Live)」→「songlive」⇒ 与「Song」→「song」**仍然不同** ⇒
    //    Live 版**不会**匹配到录音室版。
    expect(normalizeText('Song (Live)')).toBe('songlive')
    expect(normalizeText('Song (Live)')).not.toBe(normalizeText('Song'))
  })

  it('英文转小写', () => {
    expect(normalizeText('ABC')).toBe('abc')
  })

  it('空串 → 空串（不抛异常）', () => {
    expect(normalizeText('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 歌手候选
// ---------------------------------------------------------------------------

describe('T96 歌手候选（artistCandidates）', () => {
  it('单歌手 → 一个候选', () => {
    expect(artistCandidates('云旗')).toEqual(['云旗'])
  })

  it('「A / B」→ 拆成两个候选，**并补上整个原串**', () => {
    expect(artistCandidates('A / B')).toEqual(['A', 'B', 'A / B'])
  })

  it('⚠️ 名字里本来带斜杠（AC/DC）⇒ 拆开后**仍补上整个原串**（还能匹配上）', () => {
    expect(artistCandidates('AC/DC')).toEqual(['AC', 'DC', 'AC/DC'])
  })

  it('空串 → 空数组', () => {
    expect(artistCandidates('   ')).toEqual([])
  })

  it('重复候选只留一份', () => {
    expect(artistCandidates('A / A')).toEqual(['A', 'A / A'])
  })
})

// ---------------------------------------------------------------------------
// 匹配判据
// ---------------------------------------------------------------------------

describe('T96 匹配判据（matchChartEntry）', () => {
  it('歌名全等 + 歌手相交 + 时长符合 ⇒ 命中', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [
      song('s1', '晴天', '周杰伦', 200),
    ])
    expect(match.songId).toBe('s1')
    expect(match.song?.title).toBe('晴天')
  })

  it('歌名不等 ⇒ **不命中**（不做包含 / 前缀匹配 ⇒ 宁可漏）', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [
      song('s1', '晴天回忆', '周杰伦', 200),
    ])
    expect(match.songId).toBeNull()
    expect(match.song).toBeNull()
  })

  it('歌手不相交 ⇒ 不命中（同名不同人）', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [
      song('s1', '晴天', '林俊杰', 200),
    ])
    expect(match.songId).toBeNull()
  })

  it('本地多歌手「A / B」与榜源歌手「B」相交 ⇒ 命中', () => {
    const match = matchChartEntry(entry('合作曲', ['B'], 200), [
      song('s1', '合作曲', 'A / B', 200),
    ])
    expect(match.songId).toBe('s1')
  })

  it(`时长差 ≤ ${CHART_DURATION_TOLERANCE_SECONDS} 秒 ⇒ 命中`, () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [
      song('s1', '晴天', '周杰伦', 203),
    ])
    expect(match.songId).toBe('s1')
  })

  it('⚠️ 时长全对不上 ⇒ **不匹配**（并如实记下被否掉的候选数）', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [
      song('s1', '晴天', '周杰伦', 260),
    ])
    expect(match.songId).toBeNull()
    expect(match.song).toBeNull()
    expect(match.durationMismatch).toBe(1)
  })

  it('本地候选**都没有时长** ⇒ 时长闸用不上 ⇒ 按「歌名 + 歌手」命中', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [
      song('s1', '晴天', '周杰伦', null),
    ])
    expect(match.songId).toBe('s1')
  })

  it('条目**没有时长** ⇒ 取第一条候选', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], null), [
      song('s1', '晴天', '周杰伦', 260),
      song('s2', '晴天', '周杰伦', 300),
    ])
    expect(match.songId).toBe('s1')
  })

  it('多个候选都符合 ⇒ 取**时长差最小**的那条', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [
      song('s1', '晴天', '周杰伦', 202),
      song('s2', '晴天', '周杰伦', 200),
    ])
    expect(match.songId).toBe('s2')
  })

  it('⚠️ Live 版与录音室版：歌名不同 ⇒ **不会**互相匹配', () => {
    const match = matchChartEntry(entry('晴天 (Live)', ['周杰伦'], 200), [
      song('s1', '晴天', '周杰伦', 200),
    ])
    expect(match.songId).toBeNull()
  })

  it('条目没有歌名 ⇒ 不命中（不抛异常）', () => {
    const match = matchChartEntry(entry('', ['周杰伦'], 200), [
      song('s1', '晴天', '周杰伦', 200),
    ])
    expect(match.songId).toBeNull()
  })

  it('条目没有歌手 ⇒ 不命中（不抛异常）', () => {
    const match = matchChartEntry(entry('晴天', [], 200), [
      song('s1', '晴天', '周杰伦', 200),
    ])
    expect(match.songId).toBeNull()
  })

  it('候选为空 ⇒ 不命中', () => {
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [])
    expect(match.songId).toBeNull()
  })

  it('命中时**回传候选本身**（含完整字段，便于直接播）', () => {
    const candidate = song('s9', '晴天', '周杰伦', 200)
    const match = matchChartEntry(entry('晴天', ['周杰伦'], 200), [candidate])
    expect(match.song).toBe(candidate)
    expect(match.songId).toBe('s9')
  })
})
