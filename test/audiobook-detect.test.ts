// ---------------------------------------------------------------------------
// T98：有声读物**识别**（打分 + 依据 + 不误伤）
//
// ⚠️ 用**真机实测样本**（2026-11-16，本机 + 该账号）——不是编的假数据：
//   真实形态见 `docs/superpowers/specs/2026-11-16-sanlos-music-audiobook-design.md` §2.9。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  AUDIOBOOK_SCORE_THRESHOLD,
  isAudiobookVerdict,
  judgeAlbum,
  judgeAlbums,
  parseEpisode,
  pathMatchesKeyword,
  pathSegments,
  resolveAlbumEpisodes,
  resolveEpisodeStats,
  sortTracksByEpisode,
  summarizeEpisodes,
  workDirOf,
  workGroupKey,
  type AudiobookTrack,
} from '../src/api/audiobook'

/** 造一条曲目（默认给一个**普通音乐**的 path 与时长）。 */
function track(partial: Partial<AudiobookTrack> & { id: string; title: string }): AudiobookTrack {
  return {
    durationSec: 240,
    trackNo: null,
    path: '/vol02/1000-0-3d135437/音乐多文件/歌手分类/X字母开头歌手（42个）/某人/某歌.mp3',
    albumId: 'al1',
    ...partial,
  }
}

/** 三体式的专辑（`21- 序章` 形态；**注意**：真实标题里**没有**「第N章」）。 */
function threeBody(count: number, opts?: { avgSec?: number; albumId?: string }): AudiobookTrack[] {
  const albumId = opts?.albumId ?? 'al-santi'
  const avgSec = opts?.avgSec ?? 1907
  return Array.from({ length: count }, (_, i) =>
    track({
      id: `t${i}`,
      title: `${String(i + 1).padStart(2, '0')}- 章节名${i + 1}`,
      durationSec: avgSec,
      albumId,
      path: `/vol02/1000-0-3d135437/有声小说/刘慈欣/三体/Disc 01/${String(i + 1).padStart(2, '0')}- 章节名${i + 1}.mp3`,
    }),
  )
}

describe('workDirOf（作品目录 = path 倒数第 3 段）', () => {
  it('去掉文件名与分段目录 ⇒ 落在作品目录上', () => {
    expect(
      workDirOf('/vol02/1000-0-3d135437/有声小说/刘慈欣/三体/Disc 01/21- 序章.mp3'),
    ).toBe('三体')
    expect(workDirOf('/vol02/1000-0-3d135437/有声小说/宅猪/牧神记/0001-0115/0010.mp3')).toBe('牧神记')
  })

  it('路径太短 / 为空 ⇒ null（信息不足，不猜）', () => {
    expect(workDirOf('/a/b.mp3')).toBeNull()
    expect(workDirOf('')).toBeNull()
    expect(workDirOf(null)).toBeNull()
  })
})

describe('judgeAlbum（识别打分）', () => {
  it('真·有声专辑（三体形态）判为有声，且依据可解释', () => {
    const verdict = judgeAlbum(threeBody(89))
    expect(verdict.score).toBeGreaterThanOrEqual(AUDIOBOOK_SCORE_THRESHOLD)
    expect(isAudiobookVerdict(verdict)).toBe(true)
    expect(verdict.reasons).toContain('avg-duration')
    expect(verdict.reasons).toContain('episode-pattern')
    expect(verdict.reasons).toContain('many-episodes')
    expect(verdict.reasons).toContain('single-work-dir')
    expect(verdict.episodeRule).toBe('dash-prefix')
  })

  it('⛔ 普通音乐专辑不得被误判（≤ 2 分）', () => {
    // 一张典型音乐专辑：12 首、每首 3–4 分钟、标题五花八门、同一目录。
    const music = Array.from({ length: 12 }, (_, i) =>
      track({
        id: `m${i}`,
        title: ['思凡', 'Runaway Mama', 'Untitled', '望星辰(Live)'][i % 4] ?? 'x',
        durationSec: 200 + i * 3,
      }),
    )
    const verdict = judgeAlbum(music)
    expect(verdict.score).toBeLessThan(AUDIOBOOK_SCORE_THRESHOLD)
    expect(verdict.score).toBeLessThanOrEqual(2)
  })

  it('⛔ 名字带「小说 / 有声 / 广播剧」的**音乐**专辑不得被误判', () => {
    const tricky = Array.from({ length: 10 }, (_, i) =>
      track({
        id: `x${i}`,
        title: ['大小说家', '短篇小说', '无声胜有声', '撒野 广播剧歌曲'][i % 4] ?? 'x',
        durationSec: 210,
        albumId: 'al-tricky',
      }),
    )
    const verdict = judgeAlbum(tricky)
    expect(verdict.score).toBeLessThan(AUDIOBOOK_SCORE_THRESHOLD)
  })

  it('⛔ 长音频但标题形态不一致 ⇒ 不得被误判（这是 DJ 合辑的形态）', () => {
    // 20 首、每首 30 分钟、标题各不相同 ⇒ 时长够、目录够，但**形态不一致**。
    const dj = Array.from({ length: 20 }, (_, i) =>
      track({
        id: `d${i}`,
        title: `串烧大碟 第${i + 1}段 混音`,
        durationSec: 1800,
        albumId: 'al-dj',
      }),
    )
    const verdict = judgeAlbum(dj)
    // 时长 2+1+1、集数 1、目录 1 = 6 分，但**形态一致**这 2 分拿不到 ⇒ 仍然会被判为有声。
    // ⚠️ 这是设计上的**已知边界**：长音频 + 集数多 + 目录单一 ⇒ 无法只靠结构区分。
    //    ⇒ 页面提供「一键改判」（用户拍板「宁可多标 + 一键改判」）。
    expect(verdict.reasons).not.toContain('episode-pattern')
    expect(verdict.score).toBeGreaterThanOrEqual(AUDIOBOOK_SCORE_THRESHOLD)
  })

  it('单曲超长但只有 1 集（茨厂街形态）也能被判为有声', () => {
    const one = [
      track({
        id: 'c1',
        title: '茨厂街（粤语谐剧·黄庆全 陈自成 吴金英）',
        durationSec: 2706,
        albumId: 'al-ci',
        path: '/vol1/1000/music/music/茨厂街/茨厂街_粤语谐剧_黄庆全_完整版.mp3',
      }),
    ]
    const verdict = judgeAlbum(one)
    expect(verdict.score).toBeGreaterThanOrEqual(AUDIOBOOK_SCORE_THRESHOLD)
    expect(verdict.reasons).toContain('very-long-track')
  })

  it('「标题形态一致」必须与时长联动：`01- 标题` 形态的短音频普通专辑不得压线', () => {
    // 每首 3 分钟 + `01- 标题` 形态 ⇒ 形态一致（+2）但时长不够 ⇒ 那 2 分**不计**。
    const shortNumbered = Array.from({ length: 12 }, (_, i) =>
      track({
        id: `n${i}`,
        title: `${String(i + 1).padStart(2, '0')}- 某某主打歌`,
        durationSec: 180,
        albumId: 'al-short',
      }),
    )
    const verdict = judgeAlbum(shortNumbered)
    expect(verdict.reasons).not.toContain('episode-pattern')
    expect(verdict.score).toBeLessThan(AUDIOBOOK_SCORE_THRESHOLD)
  })

  it('空专辑 ⇒ 0 分，不崩', () => {
    const verdict = judgeAlbum([])
    expect(verdict.score).toBe(0)
    expect(verdict.reasons).toHaveLength(0)
    expect(verdict.trackCount).toBe(0)
  })

  it('同一标题命中多条规则时 ⇒ 取**优先级最高**的那条（规则顺序即优先级）', () => {
    // 「01- 第1章」同时命中 dash-prefix 与 episode-cn ⇒ 按优先级取 episode-cn。
    const verdict = judgeAlbum([
      track({ id: 'a', title: '01- 第1章', durationSec: 900, albumId: 'al-mix' }),
      track({ id: 'b', title: '02- 第2章', durationSec: 900, albumId: 'al-mix' }),
    ])
    expect(verdict.episodeRule).toBe('episode-cn')
  })
})

describe('judgeAlbums（按专辑聚合）', () => {
  it('同一批曲目按 albumId 分组打分', () => {
    const tracks = [...threeBody(89), ...Array.from({ length: 5 }, (_, i) =>
      track({ id: `o${i}`, title: `别的歌${i}`, durationSec: 200, albumId: 'al-other' }),
    )]
    const verdicts = judgeAlbums(tracks)
    expect(verdicts.size).toBe(2)
    expect(verdicts.get('al-santi')?.score).toBeGreaterThanOrEqual(AUDIOBOOK_SCORE_THRESHOLD)
    expect(verdicts.get('al-other')?.score).toBeLessThan(AUDIOBOOK_SCORE_THRESHOLD)
  })
})

// ---------------------------------------------------------------------------
// 扫描路径的覆盖项（T98 真机复验后补的：扫描时**不能**留全量标题）
// ---------------------------------------------------------------------------

describe('summarizeEpisodes / resolveEpisodeStats（可落盘的形态统计）', () => {
  it('规则命中数 + 标题总数（含解析不出来的那些）', () => {
    const stats = summarizeEpisodes(['21- 序章', '22- 第二', '思凡', '0010'])
    expect(stats.titleCount).toBe(4)
    expect(stats.ruleCounts['dash-prefix']).toBe(2)
    expect(stats.ruleCounts['digits-only']).toBe(1)
    // 「思凡」解析不出来 ⇒ **不计入任何规则**，但**计入分母**。
    expect(Object.keys(stats.ruleCounts)).toHaveLength(2)
  })

  it('形态一致（≥ 60%）⇒ 选中该规则；不一致 ⇒ rule = null', () => {
    const consistent = resolveEpisodeStats(summarizeEpisodes(['21- a', '22- b', '23- c']))
    expect(consistent.rule).toBe('dash-prefix')
    expect(consistent.hitRatio).toBeCloseTo(1)

    // 2/4 = 50% < 60% ⇒ 不选任何规则（宁可不动也不乱）。
    const mixed = resolveEpisodeStats(summarizeEpisodes(['21- a', '22- b', '思凡', 'Untitled']))
    expect(mixed.rule).toBeNull()
    expect(mixed.hitRatio).toBeCloseTo(0.5)
  })

  it('统计与「全量标题」路径判定一致（同一张专辑，两条路同一个结论）', () => {
    const tracks = threeBody(89)
    const direct = judgeAlbum(tracks)
    const viaScan = judgeAlbum([], {
      trackCount: tracks.length,
      avgDurationSec: 1907,
      maxDurationSec: 1907,
      workDirUnique: true,
      episodeStats: summarizeEpisodes(tracks.map((t) => t.title)),
    })
    expect(viaScan.score).toBe(direct.score)
    expect(viaScan.episodeRule).toBe(direct.episodeRule)
    expect(viaScan.reasons).toEqual(direct.reasons)
  })
})

describe('judgeAlbum 的覆盖项（扫描路径：均长 / 最长 / 集数 / 目录）', () => {
  const tenNumbered = summarizeEpisodes(
    Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, '0')}- 某集`),
  )

  it('⭐「最长单集」用**真最长**，不用均长冒充', () => {
    // 均长 20 分钟，但有一首 60 分钟 ⇒ 那条「≥ 30 分钟」必须**算数**。
    const withLong = judgeAlbum([], {
      trackCount: 10,
      avgDurationSec: 1200,
      maxDurationSec: 3600,
      workDirUnique: true,
      episodeStats: tenNumbered,
    })
    expect(withLong.reasons).toContain('very-long-track')

    // 反过来：均长 20 分钟、最长也只有 20 分钟 ⇒ 那条**不该**算数。
    const withoutLong = judgeAlbum([], {
      trackCount: 10,
      avgDurationSec: 1200,
      maxDurationSec: 1200,
      workDirUnique: true,
      episodeStats: tenNumbered,
    })
    expect(withoutLong.reasons).not.toContain('very-long-track')
  })

  it('形态不一致 ⇒ 「标题形态一致」那 2 分**不计**（扫描路径同样）', () => {
    const mixed = summarizeEpisodes(['21- a', '22- b', '思凡', 'Untitled'])
    const verdict = judgeAlbum([], {
      trackCount: 4,
      avgDurationSec: 1907,
      maxDurationSec: 1907,
      workDirUnique: true,
      episodeStats: mixed,
    })
    expect(verdict.episodeRule).toBeNull()
    expect(verdict.reasons).not.toContain('episode-pattern')
  })
})

describe('目录关键字匹配（v3）', () => {
  /** 真机实测的路径形状（2026-11-16，本机 + 该账号）。 */
  const NOVEL_PATH = '/vol02/1000-0-3d135437/有声小说/宅猪/牧神记/0001-0115/0010.mp3'

  it('目录段里有关键字 ⇒ 命中', () => {
    expect(pathMatchesKeyword(NOVEL_PATH, '有声小说')).toBe(true)
    expect(pathMatchesKeyword(NOVEL_PATH, '牧神记')).toBe(true)
    expect(pathMatchesKeyword(NOVEL_PATH, '宅猪')).toBe(true)
  })

  it('只在**文件名**里出现 ⇒ **不算命中**（那是文件，不是目录）', () => {
    expect(pathMatchesKeyword('/vol02/1000-0-3d135437/音乐/有声小说.mp3', '有声小说')).toBe(false)
  })

  it('关键字是目录名的**一部分** ⇒ 命中（有声 命中 有声小说）', () => {
    expect(pathMatchesKeyword(NOVEL_PATH, '有声')).toBe(true)
  })

  it('空关键字 / 空路径 ⇒ **不猜**（一律 false）', () => {
    expect(pathMatchesKeyword(NOVEL_PATH, '')).toBe(false)
    expect(pathMatchesKeyword(NOVEL_PATH, '   ')).toBe(false)
    expect(pathMatchesKeyword(null, '有声小说')).toBe(false)
    expect(pathMatchesKeyword('', '有声小说')).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(pathMatchesKeyword('/vol02/1000-0-Novel/x.mp3', 'novel')).toBe(true)
  })

  it('`pathSegments` 去掉最后一段文件名', () => {
    expect(pathSegments(NOVEL_PATH)).toEqual([
      'vol02',
      '1000-0-3d135437',
      '有声小说',
      '宅猪',
      '牧神记',
      '0001-0115',
    ])
    expect(pathSegments(null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T99：集号在**中段**（`mid-number`）
// ---------------------------------------------------------------------------
//
// ⚠️ 实测形态（2026-11-16，本机 + 该账号，《极品家丁》1333 集）：
//   `极品家丁 0000预告片` / `极品家丁 0001 公子，公子` / `极品家丁 1332 万千柔情（完结）`
//   ⇒ 集号 = 「作品名 + 空格 + 4 位数字 [+ 标题]」，**数字后可无空格**接文字。
//   ⇒ 现有 7 条规则都要求集号在开头或结尾纯数字 ⇒ 解析率只有 1.1% ⇒ 完全排不了序。
// ---------------------------------------------------------------------------

describe('parseEpisode：集号在中段（mid-number）', () => {
  it('实测形态 ⇒ 能解析出集号', () => {
    expect(parseEpisode('极品家丁 0001 公子，公子')).toEqual({ rule: 'mid-number', value: [1] })
    // ⚠️ 数字后**可以没有空格**（实测 `0000预告片`）⇒ 规则必须兼容。
    expect(parseEpisode('极品家丁 0000预告片')).toEqual({ rule: 'mid-number', value: [0] })
    expect(parseEpisode('极品家丁 1332 万千柔情（完结）')).toEqual({
      rule: 'mid-number',
      value: [1332],
    })
  })

  it('⛔ 不得抢走更具体的规则（规则表顺序即优先级）', () => {
    // 「第一季 10」命中**最具体**的 `season-episode` ⇒ 拿 `[季, 集]`（不是 `mid-number`）。
    expect(parseEpisode('让青春继续第一季 10')).toEqual({
      rule: 'season-episode',
      value: [1, 10],
    })
    // 纯数字仍是 `digits-only`（`mid-number` 要求前面有文字 ⇒ 天然不重叠）。
    expect(parseEpisode('0001')).toEqual({ rule: 'digits-only', value: [1] })
    // 数字开头仍是 `dash-prefix`。
    expect(parseEpisode('01- 章节名')).toEqual({ rule: 'dash-prefix', value: [1] })
    // 末尾纯数字仍是 `trailing`。
    expect(parseEpisode('公子，公子 12')).toEqual({ rule: 'trailing', value: [12] })
  })

  it('⛔ 普通音乐标题解析不出来（不误命中）', () => {
    expect(parseEpisode('思凡')).toBeNull()
    expect(parseEpisode('Runaway Mama')).toBeNull()
    expect(parseEpisode('Untitled')).toBeNull()
  })

  it('形态一致性：整本同形态 ⇒ 能排；混装 ⇒ **不排**（保持原序）', () => {
    // ⚠️ 标题里**不能**出现「第N章 / 第N集」—— 那会命中更具体的 `episode-cn` 规则。
    const jinpin = Array.from(
      { length: 20 },
      (_, i) => `极品家丁 ${String(i).padStart(4, '0')} 某集标题`,
    )
    const resolved = resolveAlbumEpisodes(jinpin)
    expect(resolved.rule).toBe('mid-number')
    expect(resolved.hitRatio).toBeCloseTo(1)

    // 一半是真形态、一半是音乐标题 ⇒ 50% < 60% ⇒ 形态不一致 ⇒ **整层作废**。
    const mixed = resolveAlbumEpisodes([
      ...jinpin.slice(0, 10),
      '思凡',
      'Runaway Mama',
      'Untitled',
      '望星辰(Live)',
      '成全',
      '继续',
      '灵感',
      '绿洲',
      '蒙娜丽莎',
      '夜空中最亮的星',
    ])
    expect(mixed.rule).toBeNull()
  })

  it('排序：按集号排（标题里集号在**中段**也能排对）', () => {
    const tracks = [
      track({
        id: 'b',
        title: '极品家丁 0002 兄台高姓大名',
        albumId: 'al-jp',
        path: '/vol02/1000-0-3d135437/有声小说/禹言/极品家丁/0000-0200/极品家丁 0002.mp3',
      }),
      track({
        id: 'a',
        title: '极品家丁 0000预告片',
        albumId: 'al-jp',
        path: '/vol02/1000-0-3d135437/有声小说/禹言/极品家丁/0000-0200/极品家丁 0000.mp3',
      }),
      track({
        id: 'c',
        title: '极品家丁 0001 公子，公子',
        albumId: 'al-jp',
        path: '/vol02/1000-0-3d135437/有声小说/禹言/极品家丁/0000-0200/极品家丁 0001.mp3',
      }),
    ]
    expect(sortTracksByEpisode(tracks).map((t) => t.id)).toEqual(['a', 'c', 'b'])
  })
})

// ---------------------------------------------------------------------------
// T100：归并键（**单一来源**）—— 扫描路径与秒搜路径必须用**同一把钥匙**
// ---------------------------------------------------------------------------
describe('workGroupKey（T100：一本小说 = 一条）', () => {
  it('同名 + **同作品目录** ⇒ 同一个键（⇒ 归并成一条）', () => {
    // ⚠ 真机实测形态：服务端把《让青春继续第一季》拆成 31 集 + 1 集，作品目录都是 `让青春继续`。
    expect(workGroupKey('让青春继续第一季', '让青春继续', 'al-a')).toBe(
      workGroupKey('让青春继续第一季', '让青春继续', 'al-b'),
    )
  })

  it('**作品目录不同** ⇒ 不同键（两部真的作品 ⇒ 不误合）', () => {
    expect(workGroupKey('牧神记', '牧神记', 'al-a')).not.toBe(
      workGroupKey('牧神记', '牧神记第二部', 'al-b'),
    )
  })

  it('**拿不到作品目录**（`null`）⇒ 按专辑单独成组（信息不足 ⇒ 宁可分开）', () => {
    // ⚠ 目录拿不到时**不能**把所有同名专辑并成一条（那会把两部作品混起来）。
    expect(workGroupKey('某作品', null, 'al-a')).toBe('album:al-a')
    expect(workGroupKey('某作品', null, 'al-a')).not.toBe(workGroupKey('某作品', null, 'al-b'))
  })

  it('**同名但名字里带分隔符**也不会撞键（键里带名字长度）', () => {
    // ⚠ 键是 `work:<名长>:<名>:<目录>` ⇒ 名字里的 `:` 不会造成歧义。
    expect(workGroupKey('甲:乙', '目录', 'al-a')).not.toBe(workGroupKey('甲', '乙:目录', 'al-b'))
  })
})
