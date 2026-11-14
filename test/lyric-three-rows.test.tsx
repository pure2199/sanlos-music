// ---------------------------------------------------------------------------
// T90-③：歌词三行模型（原文 / 翻译 / 罗马音）
// ---------------------------------------------------------------------------
//
// 钉的是「**第三行**」这件事：
// - 条目层：`LyricEntry.role` 决定一条歌词是**原文 / 翻译 / 罗马音**；
// - 解析层：`parseLyricEntries` 按 role 归类 ⇒ 行上同时挂三种文本；
// - 渲染层：`LyricView` 渲染罗马音副行（**无值不渲染**）。
//
// ⚠️ **向后兼容是硬约束**：既有数据（NAS / 内嵌）**没有 role**
//    ⇒ 沿用旧的位置约定（第 1 条原文、其余翻译）
//    ⇒ **既有测试一条不改也必须绿**（本文件是**新增**的）。
//
// ⚠️ 测试数据一律用**占位**（甲行 / 甲译 / 甲罗…），不含真实歌曲歌词。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import { toExternalEntries } from '../src/player/lyricSource'
import { parseLyricEntries, type LyricLine } from '../src/ui/lyrics/parse'
import { LyricView } from '../src/ui/lyrics/LyricView'
import type { LyricEntry } from '../src/api/types'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 构造一个歌词条目（占位数据）。 */
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

/** 取第 index 行歌词行元素。 */
function lineAt(container: HTMLElement, index: number): HTMLElement {
  const element = container.querySelector(`[data-index="${index}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

/** 取一行里**带 data-testid 的子节点**的 testid 顺序（用来钉副行的先后）。 */
function childTestIds(line: HTMLElement): string[] {
  return Array.from(line.children)
    .map((child) => child.getAttribute('data-testid'))
    .filter((id): id is string => id !== null)
}

// ---------------------------------------------------------------------------
// 条目层：toExternalEntries
// ---------------------------------------------------------------------------

describe('toExternalEntries：三行（原文 / 翻译 / 罗马音）', () => {
  it('三条各带自己的 role（原文 / 翻译 / 罗马音）', () => {
    const entries = toExternalEntries('song-1', {
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]原文',
      translation: '[00:01.00]翻译',
      romanization: '[00:01.00]罗马音',
    })

    expect(entries).toHaveLength(3)
    expect(entries.map((item) => item.role)).toEqual(['original', 'translation', 'romanization'])
    // ⚠️ guid 互不相同（否则后一条会覆盖前一条）。
    expect(new Set(entries.map((item) => item.guid)).size).toBe(3)
  })

  it('**罗马音为空** → 只产两条（不产第三条：没有罗马音就不占位）', () => {
    const entries = toExternalEntries('song-1', {
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]原文',
      translation: '[00:01.00]翻译',
      romanization: '',
    })

    expect(entries).toHaveLength(2)
    expect(entries.map((item) => item.role)).toEqual(['original', 'translation'])
  })

  it('**罗马音字段缺省**（老调用点）→ 同样只产两条（字段是可选的）', () => {
    const entries = toExternalEntries('song-1', {
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]原文',
      translation: '[00:01.00]翻译',
    })

    expect(entries).toHaveLength(2)
  })

  it('只有原文 + 罗马音（**没有翻译**）→ 两条，顺序仍是原文在前', () => {
    const entries = toExternalEntries('song-1', {
      status: 'ok',
      source: 'qq',
      original: '[00:01.00]原文',
      translation: '',
      romanization: '[00:01.00]罗马音',
    })

    expect(entries).toHaveLength(2)
    expect(entries.map((item) => item.role)).toEqual(['original', 'romanization'])
  })
})

// ---------------------------------------------------------------------------
// 解析层：parseLyricEntries
// ---------------------------------------------------------------------------

describe('parseLyricEntries：按 role 归类三行', () => {
  it('三条带 role 的条目 → 行上同时挂原文 / 翻译 / 罗马音', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲译甲', role: 'translation' }),
      entry({ guid: 'g-3', content: '[00:10.00]甲罗甲', role: 'romanization' }),
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toBe('甲行甲')
    expect(lines[0]!.translation).toBe('甲译甲')
    expect(lines[0]!.romanization).toBe('甲罗甲')
  })

  it('⚠️ **没有 role 的旧数据** → 沿用旧的位置约定（第 1 条原文、其余翻译），**没有罗马音**', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲译甲' }),
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toBe('甲行甲')
    expect(lines[0]!.translation).toBe('甲译甲')
    // ⚠️ 鉴别力：旧数据**绝不能**凭空长出罗马音（那是新行为 ⇒ 会污染既有界面）。
    expect(lines[0]!.romanization ?? '').toBe('')
  })

  it('**没有 role 的第三条** → 仍是**翻译**（旧约定：第 1 条原文、其余全当翻译）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲译甲' }),
      entry({ guid: 'g-3', content: '[00:10.00]甲罗甲' }),
    ])

    // ⚠️ **同时间戳时只有第一条翻译能挂上**（既有 `attachTranslations` 的行为，一字不改）。
    expect(lines[0]!.translation).toBe('甲译甲')
    // ⚠️ 鉴别力：无 `role` 的条目**永远不当罗马音**（罗马音只认显式的 role）。
    expect(lines[0]!.romanization ?? '').toBe('')
  })

  it('只有原文 + 罗马音（**没有翻译**）→ 翻译留空、罗马音照挂', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲罗甲', role: 'romanization' }),
    ])

    expect(lines[0]!.text).toBe('甲行甲')
    expect(lines[0]!.translation).toBe('')
    expect(lines[0]!.romanization).toBe('甲罗甲')
  })

  it('罗马音与原文**内容实质相同** → 不挂（不显示两遍一样的行）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲行甲', role: 'romanization' }),
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0]!.romanization ?? '').toBe('')
  })

  it('`role: "translation"` 且内容与原文**实质相同** → 仍是**副本**（丢弃，不显示两遍）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00] 甲行甲 ', role: 'translation' }),
    ])

    expect(lines[0]!.translation).toBe('')
  })

  it('罗马音**时间戳**与原文不同 → 按时间戳就近对齐（容差 0.5s）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.30]甲罗甲', role: 'romanization' }),
    ])

    expect(lines[0]!.romanization).toBe('甲罗甲')
  })

  it('罗马音**时间戳对不上**（差 2s）→ 不挂（宁可没有，不挂错行）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:12.00]甲罗甲', role: 'romanization' }),
    ])

    expect(lines[0]!.romanization ?? '').toBe('')
  })

  it('**多行**时每行各挂自己的罗马音（不是整份只有一条）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲\n[00:20.00]乙行乙', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲罗甲\n[00:20.00]乙罗乙', role: 'romanization' }),
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0]!.romanization).toBe('甲罗甲')
    expect(lines[1]!.romanization).toBe('乙罗乙')
  })
})

// ---------------------------------------------------------------------------
// 渲染层：LyricView
// ---------------------------------------------------------------------------

describe('LyricView：罗马音第三行', () => {
  /** 三行数据（原文 / 翻译 / 罗马音各一条，时间戳相同）。 */
  function threeRows(): LyricLine[] {
    return parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲译甲', role: 'translation' }),
      entry({ guid: 'g-3', content: '[00:10.00]甲罗甲', role: 'romanization' }),
    ])
  }

  it('有罗马音 → 渲染第三行（原文 → 翻译 → 罗马音）', () => {
    const { container } = render(<LyricView lines={threeRows()} currentTime={12} mode="single" />)

    const romanizations = container.querySelectorAll('[data-testid="lyric-romanization"]')
    expect(romanizations).toHaveLength(1)
    expect(romanizations[0]!.textContent).toBe('甲罗甲')

    // ⚠️ 鉴别力：副行**顺序**错位（罗马音排在翻译前面）时这里会红。
    expect(childTestIds(lineAt(container, 0))).toEqual(['lyric-translation', 'lyric-romanization'])
  })

  it('**没有罗马音** → 不渲染空的第三行（不占位）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲译甲', role: 'translation' }),
    ])

    const { container } = render(<LyricView lines={lines} currentTime={12} mode="single" />)

    expect(container.querySelectorAll('[data-testid="lyric-romanization"]')).toHaveLength(0)
  })

  it('**既有的手写 LyricLine**（不带 romanization 键）→ 照常渲染（向后兼容）', () => {
    // ⚠️ 这条**编译期**也钉住：`romanization` 必须是**可选**字段，
    //    否则既有代码与测试里手写的 LyricLine 会编译不过。
    const handWritten: LyricLine = {
      time: 10,
      text: '甲行甲',
      words: [{ text: '甲行甲', start: 10, end: 20 }],
      translation: '甲译甲',
    }

    const { container } = render(<LyricView lines={[handWritten]} currentTime={12} mode="single" />)

    expect(container.querySelectorAll('[data-testid="lyric-romanization"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="lyric-translation"]')).toHaveLength(1)
  })

  it('全量模式：罗马音**只给当前行**（与翻译同规则 → 槽位等高的前提不破）', () => {
    const lines = parseLyricEntries([
      entry({ guid: 'g-1', content: '[00:10.00]甲行甲\n[00:20.00]乙行乙', role: 'original' }),
      entry({ guid: 'g-2', content: '[00:10.00]甲译甲\n[00:20.00]乙译乙', role: 'translation' }),
      entry({ guid: 'g-3', content: '[00:10.00]甲罗甲\n[00:20.00]乙罗乙', role: 'romanization' }),
    ])

    const { container } = render(<LyricView lines={lines} currentTime={12} mode="all" />)

    const romanizations = container.querySelectorAll('[data-testid="lyric-romanization"]')
    expect(romanizations).toHaveLength(1)
    expect(romanizations[0]!.textContent).toBe('甲罗甲')
  })
})
