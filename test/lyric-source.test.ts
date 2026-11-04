// ---------------------------------------------------------------------------
// T32：歌词来源合并（渲染层）回归测试
// ---------------------------------------------------------------------------
//
// 钉的是**优先级**与**如实汇报**：
//
//   1. NAS 有歌词 → **完全不发外部请求**（外部源是补齐，不是抢活）
//   2. NAS 没歌词 → 查外部 → 原文 + 翻译**两条**条目（顺序不能反）
//   3. 外部也没有 → `origin: 'none'`，**原因如实带出来**
//   4. NAS **读取失败** → 保留既有语义「歌词加载失败」
//   5. NAS 读取失败但外部有 → 用外部的（外部可能是唯一有歌词的地方）
//
// ⚠️ 测试数据全是占位数据，不写真实内网地址。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { ExternalLyricResult } from '../shared/lyricProvider'
import type { LyricEntry } from '../src/api/types'
import {
  loadLyricEntries,
  toExternalEntries,
  type ExternalLyricFetcher,
  type NasLyricApi,
} from '../src/player/lyricSource'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造的 NAS 歌词条目。 */
function nasEntry(content: string, guid = 'nas-1'): LyricEntry {
  return {
    guid,
    source: 'local',
    content,
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset: 0,
  }
}

/** 造的查询条件。 */
const TARGET = { title: '占位歌名', artist: '占位歌手', album: '占位专辑', duration: 200 }

/** 造的 NAS 接口。 */
function makeApi(entries: LyricEntry[] | Error): NasLyricApi {
  return {
    list: async () => {
      if (entries instanceof Error) throw entries
      return entries
    },
  }
}

// ---------------------------------------------------------------------------
// 优先级
// ---------------------------------------------------------------------------

describe('loadLyricEntries：NAS 优先', () => {
  it('NAS 有歌词 → 用 NAS 的，且**外部一次都没被调用**', async () => {
    const external = vi.fn<ExternalLyricFetcher>()
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
    })
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
    // ⚠️ **关键断言**：NAS 有歌词时**完全不碰外部源**。
    expect(external).not.toHaveBeenCalled()
  })

  it('NAS 为空 → 查外部 → 用外部的', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]外部原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, { api: makeApi([]), external })
    expect(result.origin).toBe('external')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]外部原文')
    expect(external).toHaveBeenCalledTimes(1)
  })

  it('外部拿到原文 **+ 翻译** → 变成**两条**条目，且**原文在前**', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]原文',
      translation: '[00:01.00]翻译',
    }))
    const result = await loadLyricEntries('song-1', TARGET, { api: makeApi([]), external })
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.content).toBe('[00:01.00]原文')
    expect(result.entries[1]!.content).toBe('[00:01.00]翻译')
  })

  it('没有外部取法（可注入 `null`）→ 不查外部，直接「没有」', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([]),
      external: null,
    })
    expect(result.origin).toBe('none')
    expect(result.entries).toHaveLength(0)
    expect(result.reason).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 如实汇报
// ---------------------------------------------------------------------------

describe('loadLyricEntries：如实汇报', () => {
  it('外部源**确实没有** → origin 为 none，**没有原因**（不是错误）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({ status: 'not-found' }))
    const result = await loadLyricEntries('song-1', TARGET, { api: makeApi([]), external })
    expect(result.origin).toBe('none')
    expect(result.reason).toBeNull()
  })

  it('外部源**坏了** → origin 为 none + **原因带出来**（不静默）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'error',
      message: '连接歌词源失败：连不上',
    }))
    const result = await loadLyricEntries('song-1', TARGET, { api: makeApi([]), external })
    expect(result.origin).toBe('none')
    expect(result.reason).toContain('连不上')
  })

  it('外部取法**抛异常** → 不炸，原因带出来', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => {
      throw new Error('IPC 断了')
    })
    const result = await loadLyricEntries('song-1', TARGET, { api: makeApi([]), external })
    expect(result.origin).toBe('none')
    expect(result.reason).toContain('IPC 断了')
  })

  it('NAS **读取失败**且没有外部 → 原因 = 「歌词加载失败」（保住既有语义）', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi(new Error('NAS 挂了')),
      external: null,
    })
    expect(result.origin).toBe('none')
    expect(result.reason).toBe('歌词加载失败')
  })

  it('NAS **读取失败**但外部有 → 用外部的（外部可能是唯一有歌词的地方）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'lrclib',
      original: '[00:01.00]外部原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi(new Error('NAS 挂了')),
      external,
    })
    expect(result.origin).toBe('external')
    expect(result.entries).toHaveLength(1)
  })

  it('NAS 读到了但**本来就没歌词** → 原因 = `null`（界面显示「暂无歌词」，不是「失败」）', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([]),
      external: null,
    })
    expect(result.origin).toBe('none')
    expect(result.reason).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 条目构造
// ---------------------------------------------------------------------------

describe('toExternalEntries', () => {
  it('原文 + 翻译 → 两条，**guid 不与 NAS 的撞**', () => {
    const entries = toExternalEntries('song-1', {
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]原文',
      translation: '[00:01.00]翻译',
    })
    expect(entries).toHaveLength(2)
    expect(entries[0]!.guid).not.toBe(entries[1]!.guid)
    expect(entries[0]!.guid).toContain('song-1')
    expect(entries[0]!.isLRC).toBe(true)
    expect(entries[0]!.offset).toBe(0)
  })

  it('只有原文 → **一条**', () => {
    const entries = toExternalEntries('song-1', {
      status: 'ok',
      source: 'lrclib',
      original: '[00:01.00]原文',
      translation: '',
    })
    expect(entries).toHaveLength(1)
  })

  it('原文与翻译**都是空白** → 空数组（不给用户一个空条目）', () => {
    const entries = toExternalEntries('song-1', {
      status: 'ok',
      source: 'custom',
      original: '   ',
      translation: '\n',
    })
    expect(entries).toHaveLength(0)
  })

  it('不是 `ok` 状态 → 空数组', () => {
    const notFound: ExternalLyricResult = { status: 'not-found' }
    expect(toExternalEntries('song-1', notFound)).toHaveLength(0)
  })
})
