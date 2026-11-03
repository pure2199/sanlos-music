import { describe, it, expect } from 'vitest'
import { Queue } from '../src/player/queue'
import type { Song } from '../shared/types'

// ---------------------------------------------------------------------------
// Task 13：播放队列
//
// 覆盖：
// - 简报 Step 1 的原始用例（逐字保留其意图）；
// - 控制器追加要求 F（next/prev/remove/add/shuffle/clear 的逐条语义）。
//
// ⚠️ 全部数据都是**虚构占位**（'a' / 'b' / 'c'），不含任何真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

/** 构造占位歌曲。 */
const song = (id: string): Song => ({
  id,
  title: id,
  artist: 'a',
  artistId: '',
  album: '',
  albumId: '',
  coverId: '',
  duration: 100,
  favorite: false,
  codec: 'FLAC',
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 0,
  discNo: 0,
})

/** 构造 n 首占位歌曲。 */
const songs = (...ids: string[]): Song[] => ids.map(song)

describe('Queue', () => {
  it('顺序模式播放到末尾返回 null', () => {
    const q = new Queue()
    q.add([song('a'), song('b')])
    q.index = 0
    expect(q.next()!.id).toBe('b')
    expect(q.next()).toBeNull()
  })

  it('单曲循环保持当前曲', () => {
    const q = new Queue()
    q.add([song('a'), song('b')])
    q.mode = 'loop-one'
    q.index = 0
    expect(q.next()!.id).toBe('a')
  })

  it('移除后索引不越界', () => {
    const q = new Queue()
    q.add([song('a'), song('b')])
    q.remove(1)
    expect(q.items).toHaveLength(1)
    expect(q.index).toBe(0)
  })

  // --- next() -------------------------------------------------------------

  it('空队列 next 返回 null', () => {
    expect(new Queue().next()).toBeNull()
  })

  it('顺序模式不自动回到第一首', () => {
    const q = new Queue()
    q.add(songs('a', 'b', 'c'))
    q.index = 2
    expect(q.next()).toBeNull()
    expect(q.index).toBe(2)
  })

  it('列表循环在最后一首回到第一首', () => {
    const q = new Queue()
    q.mode = 'loop-list'
    q.add(songs('a', 'b', 'c'))
    q.index = 2
    expect(q.next()!.id).toBe('a')
    expect(q.index).toBe(0)
  })

  it('随机模式不重复当前曲，且会推进索引', () => {
    const q = new Queue()
    q.mode = 'shuffle'
    q.add(songs('a', 'b', 'c'))
    q.index = 0
    const picked = q.next()!
    expect(picked.id).not.toBe('a')
    expect(q.index).toBe(q.items.findIndex((s) => s.id === picked.id))
  })

  it('随机模式下只有一首时返回当前曲', () => {
    const q = new Queue()
    q.mode = 'shuffle'
    q.add(songs('a'))
    q.index = 0
    expect(q.next()!.id).toBe('a')
  })

  it('随机模式在一千次抽样中不重复当前曲', () => {
    const q = new Queue()
    q.mode = 'shuffle'
    q.add(songs('a', 'b', 'c', 'd'))
    for (let i = 0; i < 1000; i += 1) {
      // 每次都把当前曲钉在 'c'：next() 不得重复**当前**曲
      // （next() 之后当前曲会变，所以不能断言 'c' 永远不出现）。
      q.index = 2
      expect(q.next()!.id).not.toBe('c')
    }
  })

  // --- prev() -------------------------------------------------------------

  it('播放进度超过 3 秒时回到本曲开头', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 1
    expect(q.prev(3.5)!.id).toBe('b')
    expect(q.index).toBe(1)
  })

  it('播放进度不超过 3 秒时回到上一首', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 1
    expect(q.prev(3)!.id).toBe('a')
    expect(q.index).toBe(0)
  })

  it('顺序模式在第一首 prev 返回 null', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 0
    expect(q.prev()).toBeNull()
    expect(q.index).toBe(0)
  })

  it('列表循环在第一首 prev 回到最后一首', () => {
    const q = new Queue()
    q.mode = 'loop-list'
    q.add(songs('a', 'b', 'c'))
    q.index = 0
    expect(q.prev()!.id).toBe('c')
    expect(q.index).toBe(2)
  })

  it('单曲循环 prev 返回当前曲', () => {
    const q = new Queue()
    q.mode = 'loop-one'
    q.add(songs('a', 'b'))
    q.index = 1
    expect(q.prev()!.id).toBe('b')
  })

  it('空队列 prev 返回 null', () => {
    expect(new Queue().prev()).toBeNull()
  })

  // --- remove() -----------------------------------------------------------

  it('删除当前曲之前的条目时索引减一', () => {
    const q = new Queue()
    q.add(songs('a', 'b', 'c'))
    q.index = 2
    q.remove(0)
    expect(q.index).toBe(1)
    expect(q.items.map((s) => s.id)).toEqual(['b', 'c'])
  })

  it('删除当前曲时索引保持不变（自然指向下一首）', () => {
    const q = new Queue()
    q.add(songs('a', 'b', 'c'))
    q.index = 1
    q.remove(1)
    expect(q.index).toBe(1)
    expect(q.items[q.index]!.id).toBe('c')
  })

  it('删除最后一首（当前曲）时索引减一', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 1
    q.remove(1)
    expect(q.index).toBe(0)
  })

  it('删除当前曲之后的条目时索引不变', () => {
    const q = new Queue()
    q.add(songs('a', 'b', 'c'))
    q.index = 0
    q.remove(2)
    expect(q.index).toBe(0)
  })

  it('越界索引被忽略（不抛错）', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 1
    q.remove(5)
    q.remove(-1)
    expect(q.items).toHaveLength(2)
    expect(q.index).toBe(1)
  })

  it('删空队列后索引归零且不为负', () => {
    const q = new Queue()
    q.add(songs('a'))
    q.index = 0
    q.remove(0)
    expect(q.items).toHaveLength(0)
    expect(q.index).toBe(0)
  })

  // --- add() --------------------------------------------------------------

  it('缺省追加到末尾', () => {
    const q = new Queue()
    q.add(songs('a'))
    q.add(songs('b'))
    expect(q.items.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('插入位置越界钳到末尾，负数视为 0', () => {
    const q = new Queue()
    q.add(songs('a'))
    q.add(songs('b'), 99)
    expect(q.items.map((s) => s.id)).toEqual(['a', 'b'])
    q.add(songs('c'), -5)
    expect(q.items.map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('插入到当前曲之前时索引后移，当前曲不被顶走', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 1
    q.add(songs('x'), 0)
    expect(q.index).toBe(2)
    expect(q.items[q.index]!.id).toBe('b')
  })

  it('插入到当前曲之后时索引不变', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 0
    q.add(songs('x'), 1)
    expect(q.index).toBe(0)
    expect(q.items[q.index]!.id).toBe('a')
  })

  // --- shuffle() / clear() ------------------------------------------------

  it('打乱顺序但不改变播放模式，当前曲仍是当前曲', () => {
    const q = new Queue()
    q.mode = 'loop-list'
    q.add(songs('a', 'b', 'c', 'd'))
    q.index = 2
    const current = q.items[q.index]!
    q.shuffle()
    expect(q.mode).toBe('loop-list')
    expect(q.items[q.index]!.id).toBe(current.id)
    expect(q.items).toHaveLength(4)
  })

  it('打乱后仍是同一批歌曲（不丢不重）', () => {
    const q = new Queue()
    q.add(songs('a', 'b', 'c', 'd', 'e'))
    q.shuffle()
    expect([...q.items].map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('清空队列后索引归零', () => {
    const q = new Queue()
    q.add(songs('a', 'b'))
    q.index = 1
    q.clear()
    expect(q.items).toHaveLength(0)
    expect(q.index).toBe(0)
  })
})
