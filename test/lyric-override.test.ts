import { describe, expect, it } from 'vitest'

import {
  LYRIC_OVERRIDE_LIMIT,
  clearLyricOverride,
  getLyricOverride,
  normalizeLyricOverride,
  normalizeLyricOverrides,
  pruneLyricOverrides,
  setLyricOverride,
  type LyricOverrideMap,
} from '../src/player/lyricOverride'
import {
  LYRIC_OVERRIDE_STORAGE_KEY,
  createLyricOverridePort,
  createLyricOverrideStore,
  type LyricOverrideStorageLike,
} from '../src/state/lyricOverrideStore'

// ---------------------------------------------------------------------------
// T107：「按歌指定歌词源」的**纯函数** ＋ **store**
// ---------------------------------------------------------------------------
//
// ⚠️ 这一层**没有窗口、没有网络** ⇒ 全部可单测。
//    「指定源真的生效」那条链（渲染层 → IPC → 主进程）由 E2E 钉住。
// ---------------------------------------------------------------------------

/** 造一份假存储（记下写进去的内容）。 */
function fakeStorage(initial: Record<string, string> = {}): LyricOverrideStorageLike & {
  data: Record<string, string>
  failOnWrite: boolean
} {
  const data = { ...initial }
  const storage = {
    data,
    failOnWrite: false,
    getItem(key: string): string | null {
      return data[key] ?? null
    },
    setItem(key: string, value: string): void {
      if (storage.failOnWrite) throw new Error('配额满')
      data[key] = value
    },
    removeItem(key: string): void {
      delete data[key]
    },
  }
  return storage
}

describe('normalizeLyricOverride：一条指定的规格化', () => {
  it('合法的源 + 合法的时间 ⇒ 原样返回', () => {
    expect(normalizeLyricOverride({ source: 'kugou', updatedAt: 1000 })).toEqual({
      source: 'kugou',
      updatedAt: 1000,
    })
  })

  it('**陌生源名** ⇒ 整条丢弃（本地存储是用户可编辑的）', () => {
    expect(normalizeLyricOverride({ source: '不存在的源', updatedAt: 1000 })).toBeNull()
  })

  it('`off`（不用外部）⇒ 丢弃（那是**全局**档位，不是「换一个源」）', () => {
    expect(normalizeLyricOverride({ source: 'off', updatedAt: 1000 })).toBeNull()
  })

  it('时间不是数字 / 是负数 / 是 NaN ⇒ 整条丢弃', () => {
    expect(normalizeLyricOverride({ source: 'qq', updatedAt: 'x' })).toBeNull()
    expect(normalizeLyricOverride({ source: 'qq', updatedAt: -1 })).toBeNull()
    expect(normalizeLyricOverride({ source: 'qq', updatedAt: Number.NaN })).toBeNull()
  })

  it('根本不是对象 ⇒ 丢弃（不抛）', () => {
    expect(normalizeLyricOverride(null)).toBeNull()
    expect(normalizeLyricOverride('kugou')).toBeNull()
    expect(normalizeLyricOverride(undefined)).toBeNull()
  })
})

describe('normalizeLyricOverrides：整张表的规格化', () => {
  it('丢非法项、丢空白的键，留住合法的', () => {
    const out = normalizeLyricOverrides({
      good: { source: 'qq', updatedAt: 5 },
      bad: { source: '不存在', updatedAt: 5 },
      '': { source: 'qq', updatedAt: 5 },
      '   ': { source: 'qq', updatedAt: 5 },
    })
    expect(Object.keys(out)).toEqual(['good'])
  })

  it('不是对象 ⇒ 空表（不抛）', () => {
    expect(normalizeLyricOverrides(null)).toEqual({})
    expect(normalizeLyricOverrides('x')).toEqual({})
    expect(normalizeLyricOverrides([1, 2])).toEqual({})
  })

  it('**超出上限** ⇒ 淘汰**最旧**的那几条', () => {
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < LYRIC_OVERRIDE_LIMIT + 5; i += 1) {
      raw[`s${i}`] = { source: 'qq', updatedAt: i }
    }
    const out = normalizeLyricOverrides(raw)
    expect(Object.keys(out)).toHaveLength(LYRIC_OVERRIDE_LIMIT)
    // 最旧的那 5 条被淘汰，最新的留着。
    expect(out['s0']).toBeUndefined()
    expect(out['s4']).toBeUndefined()
    expect(out['s5']).toBeDefined()
    expect(out[`s${LYRIC_OVERRIDE_LIMIT + 4}`]).toBeDefined()
  })
})

describe('pruneLyricOverrides', () => {
  it('没超上限 ⇒ 原样返回（同一个对象）', () => {
    const entries: LyricOverrideMap = { a: { source: 'qq', updatedAt: 1 } }
    expect(pruneLyricOverrides(entries)).toBe(entries)
  })

  it('超上限 ⇒ 留最新的那些', () => {
    const entries: LyricOverrideMap = {}
    for (let i = 0; i < LYRIC_OVERRIDE_LIMIT + 1; i += 1) {
      entries[`s${i}`] = { source: 'qq', updatedAt: i }
    }
    const out = pruneLyricOverrides(entries)
    expect(Object.keys(out)).toHaveLength(LYRIC_OVERRIDE_LIMIT)
    expect(out['s0']).toBeUndefined()
    expect(out[`s${LYRIC_OVERRIDE_LIMIT}`]).toBeDefined()
  })
})

describe('set / clear / get', () => {
  it('set：写进去、读得出来，**且不改入参**', () => {
    const before: LyricOverrideMap = {}
    const after = setLyricOverride(before, 'song-1', 'kugou', 123)
    expect(getLyricOverride(after, 'song-1')).toBe('kugou')
    expect(before).toEqual({})
  })

  it('set：空白的 songId ⇒ 什么都不做', () => {
    const before: LyricOverrideMap = {}
    expect(setLyricOverride(before, '  ', 'kugou', 123)).toBe(before)
  })

  it('set：同一首歌再指定 ⇒ **覆盖**并更新时间', () => {
    const first = setLyricOverride({}, 'song-1', 'kugou', 1)
    const second = setLyricOverride(first, 'song-1', 'qq', 2)
    expect(getLyricOverride(second, 'song-1')).toBe('qq')
    expect(second['song-1']?.updatedAt).toBe(2)
  })

  it('clear：清掉这一条（「恢复自动」）', () => {
    const entries = setLyricOverride({}, 'song-1', 'kugou', 1)
    const cleared = clearLyricOverride(entries, 'song-1')
    expect(getLyricOverride(cleared, 'song-1')).toBeNull()
  })

  it('clear：本来就没有 ⇒ 原样返回', () => {
    const entries: LyricOverrideMap = {}
    expect(clearLyricOverride(entries, 'song-1')).toBe(entries)
  })

  it('get：没指定的歌 ⇒ null（= 自动）', () => {
    expect(getLyricOverride({}, 'song-1')).toBeNull()
  })
})

describe('存储端口（localStorage）', () => {
  it('写进去能读回来', () => {
    const storage = fakeStorage()
    const port = createLyricOverridePort(storage)
    const entries = setLyricOverride({}, 'song-1', 'migu', 7)
    expect(port.save(entries)).toBe(true)
    expect(storage.data[LYRIC_OVERRIDE_STORAGE_KEY]).toBeTruthy()
    expect(getLyricOverride(port.load(), 'song-1')).toBe('migu')
  })

  it('存的内容**损坏**（不是 JSON）⇒ 读回空表（不抛）', () => {
    const storage = fakeStorage({ [LYRIC_OVERRIDE_STORAGE_KEY]: '{坏掉的 JSON' })
    const port = createLyricOverridePort(storage)
    expect(port.load()).toEqual({})
  })

  it('存的内容是**陌生形状** ⇒ 读回空表（不返回半截数据）', () => {
    const storage = fakeStorage({ [LYRIC_OVERRIDE_STORAGE_KEY]: '"一个字符串"' })
    const port = createLyricOverridePort(storage)
    expect(port.load()).toEqual({})
  })

  it('**写不进去**（配额满）⇒ save 返回 false（**让用户看得见**）', () => {
    const storage = fakeStorage()
    storage.failOnWrite = true
    const port = createLyricOverridePort(storage)
    expect(port.save({ a: { source: 'qq', updatedAt: 1 } })).toBe(false)
  })

  it('没有存储（隐私模式 / 没有 localStorage）⇒ 读回空表、写返回 false', () => {
    const port = createLyricOverridePort(null)
    expect(port.load()).toEqual({})
    expect(port.save({ a: { source: 'qq', updatedAt: 1 } })).toBe(false)
  })
})

describe('store', () => {
  it('load：读回本地存的指定', () => {
    const storage = fakeStorage({
      [LYRIC_OVERRIDE_STORAGE_KEY]: JSON.stringify({ 'song-1': { source: 'kuwo', updatedAt: 3 } }),
    })
    const store = createLyricOverrideStore(createLyricOverridePort(storage))
    store.getState().load()
    expect(getLyricOverride(store.getState().overrides, 'song-1')).toBe('kuwo')
  })

  it('setOverride：写进去 + 落盘', () => {
    const storage = fakeStorage()
    const store = createLyricOverrideStore(createLyricOverridePort(storage))
    store.getState().setOverride('song-1', 'kugou')
    expect(getLyricOverride(store.getState().overrides, 'song-1')).toBe('kugou')
    expect(store.getState().error).toBeNull()
    expect(storage.data[LYRIC_OVERRIDE_STORAGE_KEY]).toContain('kugou')
  })

  it('**落盘失败** ⇒ error 有值（**不许静默假装成功**）；本次运行内仍有效', () => {
    const storage = fakeStorage()
    storage.failOnWrite = true
    const store = createLyricOverrideStore(createLyricOverridePort(storage))
    store.getState().setOverride('song-1', 'kugou')
    expect(store.getState().error).toContain('没保存住')
    // ⚠️ 本次运行内**仍然有效**（内存里的表照样用）。
    expect(getLyricOverride(store.getState().overrides, 'song-1')).toBe('kugou')
  })

  it('clearOverride：清掉这一条（「恢复自动」）', () => {
    const storage = fakeStorage()
    const store = createLyricOverrideStore(createLyricOverridePort(storage))
    store.getState().setOverride('song-1', 'kugou')
    store.getState().clearOverride('song-1')
    expect(getLyricOverride(store.getState().overrides, 'song-1')).toBeNull()
  })

  it('**不同歌**互不影响（指定只对这一首生效）', () => {
    const storage = fakeStorage()
    const store = createLyricOverrideStore(createLyricOverridePort(storage))
    store.getState().setOverride('song-1', 'kugou')
    expect(getLyricOverride(store.getState().overrides, 'song-2')).toBeNull()
  })
})
