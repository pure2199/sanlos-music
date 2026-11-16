// ---------------------------------------------------------------------------
// T98：集号解析 + 按集序排序（**不乱**）
//
// ⚠️ 用**真机实测样本**（2026-11-16，本机 + 该账号）：
//   三体 `21- 序章` / 牧神记 `0010` / 赶尸客栈 `025- 第01季25` /
//   让青春继续 `让青春继续第一季 10` / 早前样本 `第410集_…`、`17.0315丨…`
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  compareEpisode,
  parseEpisode,
  resolveAlbumEpisodes,
  sortTracksByEpisode,
  trackNoQualityOk,
  type AudiobookTrack,
} from '../src/api/audiobook'

/** 造一条曲目。 */
function track(partial: Partial<AudiobookTrack> & { id: string; title: string }): AudiobookTrack {
  return {
    durationSec: 900,
    trackNo: null,
    path: '/vol02/1000-0-3d135437/有声小说/某人/某作品/某文件.mp3',
    albumId: 'al1',
    ...partial,
  }
}

describe('parseEpisode（单条集号解析）', () => {
  it('真实形态：`21- 序章` ⇒ 21', () => {
    expect(parseEpisode('21- 序章')).toEqual({ rule: 'dash-prefix', value: [21] })
    expect(parseEpisode('23- 防御')).toEqual({ rule: 'dash-prefix', value: [23] })
  })

  it('真实形态：`0010` ⇒ 10', () => {
    expect(parseEpisode('0010')).toEqual({ rule: 'digits-only', value: [10] })
    expect(parseEpisode('0003')).toEqual({ rule: 'digits-only', value: [3] })
  })

  it('真实形态：`025- 第01季25` ⇒ [1, 25]（季, 集）', () => {
    expect(parseEpisode('025- 第01季25')).toEqual({ rule: 'season-episode', value: [1, 25] })
    expect(parseEpisode('001- 第01季01')).toEqual({ rule: 'season-episode', value: [1, 1] })
  })

  it('真实形态：`让青春继续第一季 10` ⇒ [1, 10]', () => {
    expect(parseEpisode('让青春继续第一季 10')).toEqual({ rule: 'season-episode', value: [1, 10] })
  })

  it('真实形态：`第410集_瑾瑜的质问` ⇒ 410', () => {
    expect(parseEpisode('第410集_瑾瑜的质问')).toEqual({ rule: 'episode-cn', value: [410] })
  })

  it('真实形态：`17.0315丨…` ⇒ [17, 315]（段式）', () => {
    expect(parseEpisode('17.0315丨坚持这三步')).toEqual({ rule: 'dotted-prefix', value: [17, 315] })
  })

  it('中文数字：`第三回 相逢` ⇒ 3', () => {
    expect(parseEpisode('第三回 相逢')).toEqual({ rule: 'episode-cn', value: [3] })
  })

  it('⛔ 年份不误判：`2024年中央广播电视总台春节联欢晚会` ⇒ null', () => {
    expect(parseEpisode('2024年中央广播电视总台春节联欢晚会')).toBeNull()
  })

  it('⭐ **纯数字标题不做年份保护**（真机实测：《牧神记》集号会穿过 1900–2100）', () => {
    // ⚠️ 若按年份挡，2762 集里的 "1900"–"2100" 会解析不出 ⇒ 被排到末尾。
    expect(parseEpisode('1900')).toEqual({ rule: 'digits-only', value: [1900] })
    expect(parseEpisode('2100')).toEqual({ rule: 'digits-only', value: [2100] })
    expect(parseEpisode('2024')).toEqual({ rule: 'digits-only', value: [2024] })
  })

  it('⚠️ 带文字的年份仍然不当集号（`2024- 某某` 走 dash-prefix 的年份保护）', () => {
    expect(parseEpisode('2024- 某某')).toBeNull()
  })

  it('⛔ 普通歌名不误判', () => {
    for (const title of [
      '思凡',
      'Runaway Mama',
      'Untitled',
      '望星辰(Live)',
      '盗墓笔记 十五轮转 - 纯歌版',
      '让青春继续第一季',
      '唯一 - 告五人',
    ]) {
      expect(parseEpisode(title)).toBeNull()
    }
  })
})

describe('resolveAlbumEpisodes（专辑级形态一致性）', () => {
  it('三体（`21-` 形态）⇒ 规则 dash-prefix，集号连续', () => {
    const titles = ['01- 科学边界', '02- 射手和农场主', '18- 智子工程', '21- 序章', '26- 面壁计划']
    const res = resolveAlbumEpisodes(titles)
    expect(res.rule).toBe('dash-prefix')
    expect(res.values.map((v) => v?.[0] ?? null)).toEqual([1, 2, 18, 21, 26])
  })

  it('赶尸客栈（`第01季` 形态）⇒ 规则 season-episode', () => {
    const titles = ['001- 第01季01', '017- 第01季17', '025- 第01季25']
    const res = resolveAlbumEpisodes(titles)
    expect(res.rule).toBe('season-episode')
    expect(res.values.map((v) => v?.join('.') ?? null)).toEqual(['1.1', '1.17', '1.25'])
  })

  it('牧神记（纯数字形态）⇒ 规则 digits-only', () => {
    const titles = ['0001', '0002', '0003', '0010', '0011']
    const res = resolveAlbumEpisodes(titles)
    expect(res.rule).toBe('digits-only')
    expect(res.values.map((v) => v?.[0] ?? null)).toEqual([1, 2, 3, 10, 11])
  })

  it('⛔ 形态不一致（50% < 60%）⇒ 整张专辑不按标题排序（保持原序）', () => {
    const titles = ['01- 科学边界', '02- 射手和农场主', '思凡', 'Runaway Mama', 'Untitled', '03- 叶文洁']
    const res = resolveAlbumEpisodes(titles)
    expect(res.rule).toBeNull()
    expect(res.values.every((v) => v === null)).toBe(true)
  })
})

describe('compareEpisode（段式数值比较）', () => {
  it('逐段比数字 ⇒ 字典序会错的场景都对', () => {
    expect(compareEpisode([2, 1], [9, 1])).toBeLessThan(0)
    expect(compareEpisode([9, 1], [10, 1])).toBeLessThan(0)
    expect(compareEpisode([10, 1], [17, 315])).toBeLessThan(0)
    expect(compareEpisode([17, 315], [17, 329])).toBeLessThan(0)
  })

  it('无集号的排后面', () => {
    expect(compareEpisode(null, [1])).toBeGreaterThan(0)
    expect(compareEpisode([1], null)).toBeLessThan(0)
    expect(compareEpisode(null, null)).toBe(0)
  })
})

describe('sortTracksByEpisode（按集序排，不乱）', () => {
  it('打乱的输入按集号排出来', () => {
    const tracks = [
      track({ id: 'c', title: '03- 叶文洁' }),
      track({ id: 'a', title: '01- 科学边界' }),
      track({ id: 'd', title: '08- 三体问题' }),
      track({ id: 'b', title: '02- 射手和农场主' }),
    ]
    expect(sortTracksByEpisode(tracks).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('段式数值：`第01季` 形态跨季按 (季, 集) 排', () => {
    const tracks = [
      track({ id: 's2', title: '001- 第02季01' }),
      track({ id: 's1', title: '025- 第01季25' }),
    ]
    expect(sortTracksByEpisode(tracks).map((t) => t.id)).toEqual(['s1', 's2'])
  })

  it('**不丢不重**（条目原样返回）', () => {
    const tracks = [
      track({ id: 'a', title: '02- x' }),
      track({ id: 'b', title: '01- y' }),
      track({ id: 'c', title: '03- z' }),
    ]
    const sorted = sortTracksByEpisode(tracks)
    expect(sorted).toHaveLength(3)
    expect(new Set(sorted.map((t) => t.id)).size).toBe(3)
  })

  it('同集号 ⇒ 保持原序（稳定）', () => {
    const tracks = [
      track({ id: 'first', title: '01- 甲' }),
      track({ id: 'second', title: '01- 乙' }),
    ]
    expect(sortTracksByEpisode(tracks).map((t) => t.id)).toEqual(['first', 'second'])
  })

  it('形态不一致 ⇒ 保持原序（不动）', () => {
    const tracks = [
      track({ id: 'a', title: '01- x' }),
      track({ id: 'b', title: '思凡' }),
      track({ id: 'c', title: 'Runaway Mama' }),
    ]
    expect(sortTracksByEpisode(tracks).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('trackNoQualityOk（兜底键的质量门槛）', () => {
  it('全部有值且基本不重复 ⇒ 合格', () => {
    const tracks = [
      track({ id: 'a', title: 'x', trackNo: 1 }),
      track({ id: 'b', title: 'y', trackNo: 2 }),
    ]
    expect(trackNoQualityOk(tracks)).toBe(true)
  })

  it('大多为 null ⇒ 不合格（实测有声内容就是这样）', () => {
    const tracks = [
      track({ id: 'a', title: 'x', trackNo: null }),
      track({ id: 'b', title: 'y', trackNo: null }),
    ]
    expect(trackNoQualityOk(tracks)).toBe(false)
  })
})
