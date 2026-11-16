// ---------------------------------------------------------------------------
// T96：「发现」页的**定向查询 + 匹配 + 推荐**回归测试
// ---------------------------------------------------------------------------
//
// 覆盖三块：
//
//   1. **匹配**（`matchChartsToLibrary`）：定向查曲库 ⇒ 榜上条目标出「在不在库里」；
//      ⚠️ **曲库查不动 ≠ 都不在曲库**（两种状态必须分开）。
//   2. **分块打分**（`buildRecommendBlocks`，纯函数）：三块、跨块去重、排除、
//      理由文案、同分排序。
//   3. **取候选**（`gatherRecommendCandidates`）：按歌手 / 专辑**定向**扩展，
//      同一个歌手只查一次，查询失败要**如实记账**。
//
// ⚠️ **曲库是「当前用户自己的」**：这里用的全是**占位数据**（假歌名 / 假歌手），
//    不含任何真实曲库内容，也**不假设曲库规模**。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { ChartBoard } from '../shared/chartTypes'
import type { Artist, Song } from '../shared/types'
import {
  buildRecommendBlocks,
  gatherRecommendCandidates,
  matchChartsToLibrary,
  RECOMMEND_LIMIT_PER_BLOCK,
  type DiscoverDeps,
  type RecommendCandidate,
} from '../src/api/discover'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造一首歌（只填用得到的字段）。 */
function song(id: string, title: string, artist: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    title,
    artist,
    artistId: `${id}-artist`,
    album: `${title}专辑`,
    albumId: `${id}-album`,
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
    ...overrides,
  }
}

/** 造一个歌手。 */
function artist(id: string, name: string): Artist {
  return { id, name, coverId: null, albumCount: 1, trackCount: 1 }
}

/** 造一个榜单（一条目）。 */
function board(entries: ChartBoard['entries']): ChartBoard {
  return { id: 'qq-26', name: '巅峰榜·热歌', source: 'qq', entries }
}

/** 一条榜单条目。 */
function entry(
  rank: number,
  title: string,
  artist: string,
  duration: number | null = 200,
): ChartBoard['entries'][number] {
  return { rank, title, artist, album: '', duration }
}

/** 造一份假的定向查询依赖（曲库 = 「歌手名 → 歌」）。 */
function depsOf(library: Record<string, Song[]>, opts: { fail?: boolean } = {}): DiscoverDeps {
  return {
    searchArtists: async (name) => {
      if (opts.fail) throw new Error('NAS 不可达')
      const hit = Object.keys(library).find((key) => key === name)
      return hit ? [artist(`artist-${hit}`, hit)] : []
    },
    artistSongs: async (artistId) => {
      if (opts.fail) throw new Error('NAS 不可达')
      const name = artistId.replace(/^artist-/, '')
      return library[name] ?? []
    },
    albumSongs: async () => [],
  }
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

describe('T96 榜单 ↔ 曲库匹配（matchChartsToLibrary）', () => {
  it('命中 ⇒ inLibrary = true 且带回**完整歌曲**（能直接播）', async () => {
    const local = song('s1', '晴天', '周杰伦')
    const result = await matchChartsToLibrary(
      [board([entry(1, '晴天', '周杰伦')])],
      depsOf({ 周杰伦: [local] }),
    )
    expect(result.status).toBe('ok')
    expect(result.boards[0]?.entries[0]?.inLibrary).toBe(true)
    expect(result.boards[0]?.entries[0]?.song?.id).toBe('s1')
    expect(result.matched).toBe(1)
    expect(result.total).toBe(1)
  })

  it('曲库里**没有这个歌手** ⇒ 不命中（标「不在曲库」）', async () => {
    const result = await matchChartsToLibrary(
      [board([entry(1, '晴天', '周杰伦')])],
      depsOf({ 林俊杰: [song('s2', '晴天', '林俊杰')] }),
    )
    expect(result.status).toBe('ok')
    expect(result.boards[0]?.entries[0]?.inLibrary).toBe(false)
    expect(result.boards[0]?.entries[0]?.song).toBeNull()
    expect(result.matched).toBe(0)
    expect(result.total).toBe(1)
  })

  it('⚠️ **曲库查不动 ⇒ status = unavailable**（**不是**「都不在曲库」）', async () => {
    const result = await matchChartsToLibrary(
      [board([entry(1, '晴天', '周杰伦')])],
      depsOf({}, { fail: true }),
    )
    expect(result.status).toBe('unavailable')
    expect(String(result.message)).toContain('暂时无法匹配曲库')
    // ⚠️ 查不动时**不许**给出「命中 0 首」这种像结论的数。
    expect(result.matched).toBe(0)
    expect(result.boards.length).toBe(0)
  })

  it('⚠️ **只认全等的歌手**（服务端是子串匹配 ⇒ 沾边的不算）', async () => {
    const result = await matchChartsToLibrary(
      [board([entry(1, '晴天', '周杰伦')])],
      depsOf({ 周杰: [song('s3', '晴天', '周杰')] }),
    )
    expect(result.boards[0]?.entries[0]?.inLibrary).toBe(false)
  })

  it('多歌手条目（榜单给「A / B」）⇒ 命中其中一个即可', async () => {
    const local = song('s4', '合作曲', '甲 / 乙')
    const result = await matchChartsToLibrary(
      [board([entry(1, '合作曲', '甲 / 乙')])],
      depsOf({ 甲: [local], 乙: [] }),
    )
    expect(result.boards[0]?.entries[0]?.inLibrary).toBe(true)
  })

  it('计数正确：命中数 / 总数分别统计', async () => {
    const result = await matchChartsToLibrary(
      [
        board([
          entry(1, '晴天', '周杰伦'),
          entry(2, '稻香', '周杰伦'),
          entry(3, '不存在', '路人'),
        ]),
      ],
      depsOf({ 周杰伦: [song('s1', '晴天', '周杰伦'), song('s2', '稻香', '周杰伦')] }),
    )
    expect(result.matched).toBe(2)
    expect(result.total).toBe(3)
    expect(result.boards[0]?.matched).toBe(2)
    expect(result.boards[0]?.total).toBe(3)
  })

  it('榜源的**名次与顺序原样保留**', async () => {
    const result = await matchChartsToLibrary(
      [board([entry(7, '晴天', '周杰伦'), entry(9, '稻香', '周杰伦')])],
      depsOf({}),
    )
    expect(result.boards[0]?.entries.map((item) => item.rank)).toEqual([7, 9])
  })

  it('空榜单 ⇒ 不报错、也没有任何条目', async () => {
    const result = await matchChartsToLibrary([], depsOf({}))
    expect(result.status).toBe('ok')
    expect(result.boards.length).toBe(0)
    expect(result.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 推荐：分块打分
// ---------------------------------------------------------------------------

describe('T96 推荐分块（buildRecommendBlocks）', () => {
  const candidate = (
    id: string,
    origin: RecommendCandidate['origin'],
    via: RecommendCandidate['via'],
    because = '云旗',
  ): RecommendCandidate => ({
    song: song(id, `歌${id}`, '云旗'),
    origin,
    via,
    because,
  })

  it('收藏派生的候选进「因为你收藏过」块', () => {
    const blocks = buildRecommendBlocks({
      candidates: [candidate('a', 'favorite', 'artist')],
      excludeSongIds: [],
    })
    expect(blocks[0]?.id).toBe('favorites')
    expect(blocks[0]?.items[0]?.song.id).toBe('a')
  })

  it('本地历史 / 服务端历史派生的候选进「因为你最近听过」块', () => {
    const blocks = buildRecommendBlocks({
      candidates: [
        candidate('b', 'local-history', 'artist'),
        candidate('c', 'server-history', 'album'),
      ],
      excludeSongIds: [],
    })
    expect(blocks.map((block) => block.id)).toEqual(['recent'])
    expect(blocks[0]?.items.length).toBe(2)
  })

  it('⚠️ **排除**指定的歌（本地历史里的歌不再推）', () => {
    const blocks = buildRecommendBlocks({
      candidates: [candidate('a', 'favorite', 'artist'), candidate('d', 'favorite', 'artist')],
      excludeSongIds: ['a'],
    })
    expect(blocks[0]?.items.map((item) => item.song.id)).toEqual(['d'])
  })

  it('⚠️ **跨块去重**（先到先得）', () => {
    const blocks = buildRecommendBlocks({
      candidates: [
        candidate('a', 'favorite', 'artist'),
        candidate('a', 'local-history', 'artist'),
      ],
      excludeSongIds: [],
    })
    const ids = blocks.flatMap((block) => block.items.map((item) => item.song.id))
    expect(ids).toEqual(['a'])
  })

  it('某块**没有内容就不显示**（不留空壳）', () => {
    const blocks = buildRecommendBlocks({
      candidates: [candidate('a', 'favorite', 'artist')],
      excludeSongIds: [],
    })
    expect(blocks.map((block) => block.id)).toEqual(['favorites'])
  })

  it('排序：收藏 × 歌手（3.0）> 本地历史 × 歌手（2.5）> 收藏 × 专辑（1.5）', () => {
    const blocks = buildRecommendBlocks({
      candidates: [
        candidate('album-fav', 'favorite', 'album'),
        candidate('local', 'local-history', 'artist'),
        candidate('artist-fav', 'favorite', 'artist'),
      ],
      excludeSongIds: [],
    })
    const items = blocks[0]?.items ?? []
    expect(items.map((item) => item.song.id)).toEqual(['artist-fav', 'album-fav'])
    expect(items[0]?.score).toBe(3)
    expect(items[1]?.score).toBe(1.5)
  })

  it('理由文案可读（带出「因为什么」）', () => {
    const blocks = buildRecommendBlocks({
      candidates: [candidate('a', 'favorite', 'artist', '云旗')],
      excludeSongIds: [],
    })
    expect(blocks[0]?.items[0]?.reason).toContain('云旗')
  })

  it('每块最多 `RECOMMEND_LIMIT_PER_BLOCK` 条', () => {
    const many: RecommendCandidate[] = []
    for (let index = 0; index < 25; index += 1) {
      many.push(candidate(`s${index}`, 'favorite', 'artist'))
    }
    const blocks = buildRecommendBlocks({ candidates: many, excludeSongIds: [] })
    expect(blocks[0]?.items.length).toBe(RECOMMEND_LIMIT_PER_BLOCK)
  })

  it('「同一位歌手的其他歌」块：因歌手扩展但前两块没展示完的剩余曲目', () => {
    const many: RecommendCandidate[] = []
    for (let index = 0; index < 15; index += 1) {
      many.push(candidate(`s${index}`, 'favorite', 'artist'))
    }
    const blocks = buildRecommendBlocks({ candidates: many, excludeSongIds: [] })
    expect(blocks.map((block) => block.id)).toEqual(['favorites', 'same-artist'])
    expect(blocks[1]?.items.length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 取候选：定向查询
// ---------------------------------------------------------------------------

describe('T96 取候选（gatherRecommendCandidates）', () => {
  it('按歌手**定向**扩展出候选，种子本身被排除', async () => {
    const seed = song('seed', '稻香', '周杰伦', { artistId: 'a1', albumId: 'al1' })
    const other = song('other', '晴天', '周杰伦', { artistId: 'a1', albumId: 'al2' })
    const deps: DiscoverDeps = {
      searchArtists: async () => [],
      artistSongs: async () => [seed, other],
      albumSongs: async () => [],
    }
    const gathered = await gatherRecommendCandidates({
      favorites: [seed],
      localHistory: [],
      serverHistory: [],
      deps,
    })
    expect(gathered.candidates.map((item) => item.song.id)).toEqual(['other'])
    expect(gathered.candidates[0]?.via).toBe('artist')
  })

  it('⚠️ **同一个歌手只查一次**（收藏里同歌手的歌只花一份代价）', async () => {
    const artistSongs = vi.fn(async () => [song('x', '别的歌', '云旗')])
    const deps: DiscoverDeps = {
      searchArtists: async () => [],
      artistSongs,
      albumSongs: async () => [],
    }
    const gathered = await gatherRecommendCandidates({
      favorites: [
        song('s1', '歌一', '云旗', { artistId: 'a1', albumId: '' }),
        song('s2', '歌二', '云旗', { artistId: 'a1', albumId: '' }),
      ],
      localHistory: [],
      serverHistory: [],
      deps,
    })
    expect(artistSongs).toHaveBeenCalledTimes(1)
    expect(gathered.candidates.length).toBeGreaterThan(0)
  })

  it('本地历史里的歌**进排除集**（刚听过的别再推）', async () => {
    const heard = song('heard', '听过的', '云旗', { artistId: 'a1', albumId: '' })
    const deps: DiscoverDeps = {
      searchArtists: async () => [],
      artistSongs: async () => [heard],
      albumSongs: async () => [],
    }
    const gathered = await gatherRecommendCandidates({
      favorites: [],
      localHistory: [heard],
      serverHistory: [],
      deps,
    })
    expect(gathered.excludeSongIds).toContain('heard')
  })

  it('⚠️ 定向查询失败 ⇒ **如实记账**（failures > 0），不装作完整', async () => {
    const deps: DiscoverDeps = {
      searchArtists: async () => [],
      artistSongs: async () => {
        throw new Error('NAS 不可达')
      },
      albumSongs: async () => [],
    }
    const gathered = await gatherRecommendCandidates({
      favorites: [song('s1', '歌一', '云旗', { artistId: 'a1', albumId: '' })],
      localHistory: [],
      serverHistory: [],
      deps,
    })
    expect(gathered.failures).toBeGreaterThan(0)
    expect(gathered.candidates.length).toBe(0)
  })

  it('按专辑扩展 ⇒ via = album，理由带专辑名', async () => {
    const seed = song('seed', '稻香', '周杰伦', { artistId: '', albumId: 'al1' })
    const deps: DiscoverDeps = {
      searchArtists: async () => [],
      artistSongs: async () => [],
      albumSongs: async () => [song('other', '七里香', '周杰伦')],
    }
    const gathered = await gatherRecommendCandidates({
      favorites: [seed],
      localHistory: [],
      serverHistory: [],
      deps,
    })
    expect(gathered.candidates[0]?.via).toBe('album')
    expect(gathered.candidates[0]?.because).toBe('稻香专辑')
  })

  it('没有种子 ⇒ 没有候选（不报错）', async () => {
    const deps: DiscoverDeps = {
      searchArtists: async () => [],
      artistSongs: async () => [],
      albumSongs: async () => [],
    }
    const gathered = await gatherRecommendCandidates({
      favorites: [],
      localHistory: [],
      serverHistory: [],
      deps,
    })
    expect(gathered.candidates.length).toBe(0)
    expect(gathered.failures).toBe(0)
  })
})
