// ---------------------------------------------------------------------------
// T97：「随机 20 首」的抽样算法（纯函数单测）
// ---------------------------------------------------------------------------
//
// 钉住的**每一条**都是踩过才知道的：
// 1. **页码必须 clamp 到 ≤ 2000**（服务端超了会**静默回绕到第 1 页**）
//    ⇒ 不 clamp 就会把同一页抽成 20 首（真机探针实测过这个坑）；
// 2. 选出的页**互不相同**；
// 3. 结果**无重复**；
// 4. `total = 0` ⇒ 空数组、不崩；
// 5. 库比要的数量小 ⇒ **如实少给**（不拿重复的凑数）；
// 6. 注入 `random` ⇒ 结果**可复现**；
// 7. 结果**分散在多个页**（不集中在同一页 ⇒ 不同质）。
//
// ⚠️ **曲库因人而异**：本文件用**造出来的**曲库，不依赖任何真实规模。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { Song } from '../shared/types'
import {
  pickDistinctPages,
  RANDOM_PLAYLIST_SIZE,
  RANDOM_SAMPLE_MAX_PAGES,
  RANDOM_SAMPLE_PAGE_SIZE,
  sampleRandomSongs,
  SERVER_MAX_PAGE,
  shuffle,
  type RandomSampleDeps,
} from '../src/api/randomPlaylist'

/** 造一首歌（只要 id / 歌名够用了）。 */
function song(id: string): Song {
  return {
    id,
    title: `曲目 ${id}`,
    artist: '歌手',
    artistId: 'a1',
    album: '专辑',
    albumId: 'al1',
    coverId: '',
    duration: 200,
    favorite: false,
    codec: 'FLAC',
    bitrate: 900,
    sampleRate: 44100,
    bitDepth: 16,
    year: null,
    trackNo: null,
    discNo: null,
    isrc: null,
    path: `/x/${id}.flac`,
  } as Song
}

/** 造一批歌（id 从 `from` 起连续）。 */
function songs(from: number, count: number): Song[] {
  return Array.from({ length: count }, (_, index) => song(`s${from + index}`))
}

/** 固定序列的随机源（⇒ 结果可复现）。 */
function fixedRandom(values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[index % values.length] ?? 0
    index += 1
    return value
  }
}

/**
 * 假依赖：按页给歌，并记录请求过哪些页。
 *
 * ⚠️ **页码是随机挑的** ⇒ 默认给**任何页**都返回一批歌（按页号错开 id），
 *    否则随机到没造数据的页就会拿到空数组（那是测试自己的坑，不是算法的坑）。
 */
function fakeDeps(
  total: number,
  pageFn?: (page: number) => Song[],
): RandomSampleDeps & { requested: number[] } {
  const requested: number[] = []
  return {
    requested,
    total: async () => total,
    page: async (page: number) => {
      requested.push(page)
      return pageFn ? pageFn(page) : songs(page * 1000, 200)
    },
  }
}

describe('pickDistinctPages', () => {
  it('挑出的页码**互不相同**，且都落在 [1, usablePages] 内', () => {
    const pages = pickDistinctPages(50, 4, fixedRandom([0.1, 0.9, 0.3, 0.7, 0.5]))
    expect(pages).toHaveLength(4)
    expect(new Set(pages).size).toBe(4)
    for (const page of pages) {
      expect(page).toBeGreaterThanOrEqual(1)
      expect(page).toBeLessThanOrEqual(50)
    }
  })

  it('要的数量超过可用页数 ⇒ **只给能给的**（不多不少）', () => {
    const pages = pickDistinctPages(2, 5, fixedRandom([0.1, 0.6]))
    expect(pages).toHaveLength(2)
    expect(new Set(pages).size).toBe(2)
  })

  it('可用页数为 0 ⇒ 空数组（不崩）', () => {
    expect(pickDistinctPages(0, 4, fixedRandom([0.5]))).toEqual([])
  })
})

describe('shuffle', () => {
  it('**不改原数组**（返回新数组）', () => {
    const original = [1, 2, 3, 4]
    const result = shuffle(original, fixedRandom([0.5, 0.1]))
    expect(result).not.toBe(original)
    expect(original).toEqual([1, 2, 3, 4])
  })

  it('元素集合不变（只是顺序变了）', () => {
    const original = [1, 2, 3, 4, 5]
    const result = shuffle(original, fixedRandom([0.9, 0.1, 0.5, 0.3]))
    expect([...result].sort()).toEqual([...original].sort())
  })
})

describe('sampleRandomSongs', () => {
  it('⚠️ **页码必须 ≤ 2000**（服务端超了会回绕到第 1 页 ⇒ 抽出来全是同一批）', async () => {
    // 曲库大到 `ceil(total / pageSize) = 4000` 页（远超 2000 的上限）。
    const total = 4000 * RANDOM_SAMPLE_PAGE_SIZE
    const deps = fakeDeps(total)
    await sampleRandomSongs(deps, { count: 20, random: fixedRandom([0.9, 0.8, 0.7]) })
    expect(deps.requested.length).toBeGreaterThan(0)
    for (const page of deps.requested) {
      expect(page).toBeLessThanOrEqual(SERVER_MAX_PAGE)
    }
  })

  it('抽出的歌**分散在多个页**（不是集中在同一页 ⇒ 不同质）', async () => {
    const deps = fakeDeps(100 * RANDOM_SAMPLE_PAGE_SIZE)
    const picked = await sampleRandomSongs(deps, { count: 20, random: fixedRandom([0.05, 0.35, 0.65, 0.95]) })
    expect(picked).toHaveLength(20)
    // 4 个页都参与了（每页贡献 5 首）。
    expect(new Set(deps.requested).size).toBe(4)
  })

  it('结果**无重复**（各页故意有交集）', async () => {
    const shared = songs(1, 10)
    const deps = fakeDeps(100 * RANDOM_SAMPLE_PAGE_SIZE, () => shared)
    const picked = await sampleRandomSongs(deps, { count: 20, random: fixedRandom([0.1, 0.4, 0.7, 0.9]) })
    const ids = picked.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(picked.length).toBeLessThanOrEqual(shared.length)
  })

  it('`total = 0` ⇒ 空数组（**不崩、不假装有**）', async () => {
    const deps = fakeDeps(0)
    await expect(sampleRandomSongs(deps)).resolves.toEqual([])
    expect(deps.requested).toHaveLength(0)
  })

  it('库比要的数量小 ⇒ **如实少给**（不拿重复的凑数）', async () => {
    const deps = fakeDeps(8, () => songs(1, 8))
    const picked = await sampleRandomSongs(deps, { count: RANDOM_PLAYLIST_SIZE })
    expect(picked).toHaveLength(8)
    expect(new Set(picked.map((item) => item.id)).size).toBe(8)
  })

  it('注入同一个 `random` ⇒ **两次结果一致**（可复现）', async () => {
    const first = await sampleRandomSongs(fakeDeps(400), {
      count: 20,
      random: fixedRandom([0.11, 0.22, 0.33, 0.44]),
    })
    const second = await sampleRandomSongs(fakeDeps(400), {
      count: 20,
      random: fixedRandom([0.11, 0.22, 0.33, 0.44]),
    })
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id))
  })

  it('`count = 0` ⇒ 空数组，**一个请求都不发**', async () => {
    const deps = fakeDeps(1000)
    await expect(sampleRandomSongs(deps, { count: 0 })).resolves.toEqual([])
    expect(deps.requested).toHaveLength(0)
  })

  it('每页**最多**取 `ceil(count / 页数)` 首（不会把一页全塞进结果）', async () => {
    const deps = fakeDeps(100 * RANDOM_SAMPLE_PAGE_SIZE)
    const picked = await sampleRandomSongs(deps, { count: 20, random: fixedRandom([0.05, 0.3, 0.6, 0.9]) })
    expect(picked).toHaveLength(20)
    // 每页只贡献 5 首 ⇒ 4 页凑满 20。
    const perPage = Math.ceil(20 / RANDOM_SAMPLE_MAX_PAGES)
    expect(perPage).toBe(5)
    expect(deps.requested).toHaveLength(RANDOM_SAMPLE_MAX_PAGES)
  })

  it('每页放不下时要的量 ⇒ **加页**，而不是每页硬塞', async () => {
    // `count=500`、每页只能给 200 ⇒ 需要 3 页（ceil(500/200)）。
    const deps = fakeDeps(6 * 200, (page) => songs(page * 1000, 200))
    const picked = await sampleRandomSongs(deps, { count: 500, random: fixedRandom([0.2, 0.4, 0.6]) })
    expect(picked).toHaveLength(500)
    expect(deps.requested.length).toBeGreaterThanOrEqual(3)
  })
})
