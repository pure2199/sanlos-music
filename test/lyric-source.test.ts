// ---------------------------------------------------------------------------
// T32 / T70：歌词来源合并（渲染层）回归测试
// ---------------------------------------------------------------------------
//
// 钉的是**优先级**与**如实汇报**：
//
//   1. **T70：线上优先**（缺省）—— 线上匹配上就用线上的；线上匹配不上 /
//      源不可用 / 超时 ⇒ **回落本地**；
//   2. **T70：本地优先**（`local-first`）—— Task 32 的老口径：
//      NAS 有歌词 → **完全不发外部请求**；
//   3. 外部拿到原文 + 翻译 → **两条**条目（顺序不能反）；
//   4. 都没有 → `origin: 'none'`，**原因如实带出来**；
//   5. 本地**读取失败** → 保留既有语义「歌词加载失败」。
//
// ⚠️ **前提被显式推翻的那条断言**：T32 的「NAS 有歌词 ⇒ 外部一次都没被调用」
//    在 T70 的**线上优先**下**不再成立**（用户明确要求「优先使用线上歌词，
//    线上匹配不上再使用本地歌词」）⇒ 已**改写为新行为断言**
//    （线上优先 ⇒ 用线上的；本地优先 ⇒ 仍**不碰**外部），
//    **断言强度不减**（仍是精确断言，不是放宽）。
//
// ⚠️ 测试数据全是占位数据，不写真实内网地址。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LYRIC_PRIORITY,
  normalizeLyricPriority,
  type ExternalLyricResult,
} from '../shared/lyricProvider'
import type { LyricEntry } from '../src/api/types'
import {
  loadLyricEntries,
  toExternalEntries,
  ONLINE_LYRIC_TIMEOUT_MS,
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

describe('loadLyricEntries：线上优先（T70 的缺省口径）', () => {
  it('线上有歌词 ⇒ **用线上的**，本地那份不用', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]线上原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
    })
    expect(result.origin).toBe('external')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]线上原文')
    // ⚠️ 线上优先 ⇒ **每首歌都查一次线上**（这是与 T32 的**行为差异**）。
    expect(external).toHaveBeenCalledTimes(1)
  })

  it('线上查询的**缺省上限** = 12 秒（T73：源链最多 4 个源 × 每个 3 秒）', () => {
    expect(ONLINE_LYRIC_TIMEOUT_MS).toBe(12000)
  })

  it('命中线上时**如实带出实际命中的那个源**（T73：源链依次试，未必是首选源）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'lrclib',
      original: '[00:01.00]线上原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
    })
    expect(result.origin).toBe('external')
    // ⚠️ **必须带出实际命中的源** ⇒ 界面才能如实显示（不装作是首选源）。
    expect(result.externalSource).toBe('lrclib')
  })

  it('用的是本地那份时 → **没有** externalSource（不是线上来的）', async () => {
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external: vi.fn<ExternalLyricFetcher>(async () => ({
        status: 'not-found',
      })),
      priority: 'local-first',
    })
    expect(result.origin).toBe('nas')
    expect(result.externalSource).toBeUndefined()
  })

  it('线上**匹配不上**（not-found）⇒ **回落到本地**', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({ status: 'not-found' }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
    })
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
    expect(result.reason).toBeNull()
  })

  it('线上**源不可用**（error）⇒ 仍然**回落到本地**（线上坏不该让你看不到已有歌词）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'error',
      message: '网易云返回 429',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
    })
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
    // ⚠️ **有歌词就别报错**。
    expect(result.reason).toBeNull()
  })

  it('线上**抛异常** ⇒ 仍然回落到本地（不炸）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => {
      throw new Error('IPC 断了')
    })
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
    })
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
  })

  it('线上**超时**（超过上限还没回）⇒ 回落到本地，且**确实在上限内**发生', async () => {
    const external = vi.fn<ExternalLyricFetcher>(
      () => new Promise<ExternalLyricResult>(() => {}) as Promise<ExternalLyricResult>,
    )
    const startedAt = Date.now()
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
      timeoutMs: 20,
    })
    const elapsed = Date.now() - startedAt
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
    // ⚠️ **时效断言**：没有它的话，把超时上限改成 100 倍这条用例**照样绿**
    //    （最终还是回落了本地）⇒ 超时逻辑就没有鉴别力。
    expect(elapsed).toBeLessThan(2000)
  })

  it('线上**报错** + 本地**读取失败** ⇒ 原因 = 「歌词加载失败」（本地失败优先）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'error',
      message: '网易云返回 429',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi(new Error('NAS 挂了')),
      external,
    })
    expect(result.origin).toBe('none')
    // ⚠️ 本地读取失败是**更硬**的事实 ⇒ 界面要说「歌词加载失败」。
    expect(result.reason).toBe('歌词加载失败')
  })

  it('线上 ok 但**原文与翻译都为空** ⇒ 视同**匹配不上** ⇒ 回落本地', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '   ',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
    })
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
  })

  it('**没有外部取法** ⇒ **零外部请求**，直接用本地', async () => {
    const external = vi.fn<ExternalLyricFetcher>()
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external: null,
    })
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
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

// ---------------------------------------------------------------------------
// 本地优先（T70 的另一档 —— Task 32 的老口径，**代码路径一字不变**）
// ---------------------------------------------------------------------------

describe('loadLyricEntries：本地优先（local-first）', () => {
  it('NAS 有歌词 → 用 NAS 的，且**外部一次都没被调用**（T32 老口径，一字不变）', async () => {
    const external = vi.fn<ExternalLyricFetcher>()
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
      priority: 'local-first',
    })
    expect(result.origin).toBe('nas')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
    // ⚠️ **关键断言**：本地优先时 NAS 有歌词就**完全不碰外部源**。
    expect(external).not.toHaveBeenCalled()
  })

  it('NAS 为空 → 查外部 → 用外部的', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]外部原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([]),
      external,
      priority: 'local-first',
    })
    expect(result.origin).toBe('external')
    expect(result.entries[0]!.content).toBe('[00:01.00]外部原文')
    expect(external).toHaveBeenCalledTimes(1)
  })

  it('**优先级真的起作用**：线上有词时，本地优先**仍然用本地的**', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({
      status: 'ok',
      source: 'netease',
      original: '[00:01.00]线上原文',
      translation: '',
    }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
      priority: 'local-first',
    })
    expect(result.origin).toBe('nas')
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
  })

  it('本地优先 + 线上**匹配不上** → 用本地的（老口径同样回落）', async () => {
    const external = vi.fn<ExternalLyricFetcher>(async () => ({ status: 'not-found' }))
    const result = await loadLyricEntries('song-1', TARGET, {
      api: makeApi([nasEntry('[00:01.00]NAS 歌词')]),
      external,
      priority: 'local-first',
    })
    expect(result.origin).toBe('nas')
    expect(result.entries[0]!.content).toBe('[00:01.00]NAS 歌词')
  })
})

// ---------------------------------------------------------------------------
// 优先级的归一化（陌生值 ⇒ 缺省）
// ---------------------------------------------------------------------------

describe('normalizeLyricPriority', () => {
  it('两个合法值原样返回', () => {
    expect(normalizeLyricPriority('online-first')).toBe('online-first')
    expect(normalizeLyricPriority('local-first')).toBe('local-first')
  })

  it('陌生值 / 非字符串 ⇒ 一律压成**缺省**（线上优先）', () => {
    expect(normalizeLyricPriority('nonsense')).toBe(DEFAULT_LYRIC_PRIORITY)
    expect(normalizeLyricPriority(undefined)).toBe(DEFAULT_LYRIC_PRIORITY)
    expect(normalizeLyricPriority(null)).toBe(DEFAULT_LYRIC_PRIORITY)
    expect(normalizeLyricPriority(42)).toBe(DEFAULT_LYRIC_PRIORITY)
    expect(DEFAULT_LYRIC_PRIORITY).toBe('online-first')
  })
})
