// ---------------------------------------------------------------------------
// T39 本地曲目清单（渲染层镜像）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - `localItemToSong()`：**标签**带来的专辑 / 时长映射到 `Song`；
// - `pendingTagCount()`：数一数还有多少首**没读标签**（`tagSource` 缺省）；
// - `installLocalLibraryStore()`：订阅主进程推来的清单变化 → **按 id 合并**。
//
// ⚠️ **不碰文件系统**：渲染层只认 `globalThis.fnPlayer` 这一个入口。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitFor } from '@testing-library/react'

import type { LocalLibraryItem, PlayerBridge } from '../shared/playerBridge'
import {
  installLocalLibraryStore,
  localItemToSong,
  pendingTagCount,
  useLocalLibraryStore,
} from '../src/state/localLibraryStore'

const LOCAL_ID = 'local:0123456789abcdef'

/** 登记项（占位值）。 */
const ITEM: LocalLibraryItem = {
  id: LOCAL_ID,
  path: 'D:\\Music\\本地歌手 - 本地歌名.flac',
  title: '本地歌名',
  artist: '本地歌手',
  size: 4096,
  ext: 'flac',
  addedAt: '2026-01-01T00:00:00.000Z',
}

/** 主进程推来的变化（测试里手动触发）。 */
let changedHandler: ((items: LocalLibraryItem[]) => void) | null = null

/** 挂一个假桥。 */
function installBridge(overrides: Partial<PlayerBridge> = {}): void {
  const bridge = {
    listLocalTracks: vi.fn(async () => []),
    onLocalChanged: vi.fn((handler: (items: LocalLibraryItem[]) => void) => {
      changedHandler = handler
      return () => {
        changedHandler = null
      }
    }),
    ...overrides,
  } as unknown as PlayerBridge
  ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
}

beforeEach(() => {
  changedHandler = null
  useLocalLibraryStore.setState({ items: [], loading: false, error: null })
})

afterEach(() => {
  delete (globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer
})

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------

describe('T39 本地曲目映射', () => {
  it('标签带来的**专辑 / 时长**要映射进 `Song`', () => {
    const song = localItemToSong({
      ...ITEM,
      album: '示例专辑',
      duration: 180,
      tagSource: 'tag',
    })

    expect(song.album).toBe('示例专辑')
    expect(song.duration).toBe(180)
    expect(song.audioSpec?.duration).toBe(180)
  })

  it('没有标签 → 专辑空串、时长 0（**未知**）', () => {
    const song = localItemToSong(ITEM)

    expect(song.album).toBe('')
    expect(song.duration).toBe(0)
    expect(song.audioSpec?.duration).toBeNull()
  })

  it('时长是 0 / 非法数 → 当作**未知**', () => {
    expect(localItemToSong({ ...ITEM, duration: 0 }).duration).toBe(0)
    expect(localItemToSong({ ...ITEM, duration: Number.NaN }).duration).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 解析进度
// ---------------------------------------------------------------------------

describe('T39 解析进度', () => {
  it('`tagSource` 缺省 = **还没解析过** → 要计数', () => {
    expect(
      pendingTagCount([
        ITEM,
        { ...ITEM, id: 'local:other', tagSource: 'tag' },
        { ...ITEM, id: 'local:third', tagSource: 'name' },
      ]),
    ).toBe(1)
  })

  it('都解析完了 → 计数为 0', () => {
    expect(pendingTagCount([{ ...ITEM, tagSource: 'tag' }])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 清单变化合并
// ---------------------------------------------------------------------------

describe('T39 清单变化合并', () => {
  it('主进程推来的变化 → **按 id 合并**（已有的替换、新的追加、**别的条目不受影响**）', async () => {
    const other = { ...ITEM, id: 'local:otherone', path: 'D:\\Music\\b.mp3', title: '另一首' }
    installBridge({
      listLocalTracks: vi.fn(async () => [{ ...ITEM, title: '旧歌名' }, other]),
    })
    installLocalLibraryStore()

    await waitFor(() => expect(useLocalLibraryStore.getState().items).toHaveLength(2))
    expect(useLocalLibraryStore.getState().items[0]?.title).toBe('旧歌名')

    // ⚠️ **只推一条**（子集）——合并与「整份替换」在这里才分得清。
    changedHandler?.([{ ...ITEM, title: '新歌名', tagSource: 'tag', duration: 180 }])

    const items = useLocalLibraryStore.getState().items
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.id === LOCAL_ID)?.title).toBe('新歌名')
    expect(items.find((item) => item.id === LOCAL_ID)?.duration).toBe(180)
    // ⚠️ **没被推的那一条不能被冲掉**。
    expect(items.find((item) => item.id === 'local:otherone')?.title).toBe('另一首')

    // ⚠️ 新的条目 → **追加**。
    changedHandler?.([
      { ...ITEM, id: 'local:newone', path: 'D:\\Music\\c.mp3', title: '新的一首', tagSource: 'tag' },
    ])
    expect(useLocalLibraryStore.getState().items).toHaveLength(3)
  })

  it('推来的条目形状不对（**没有 id**）→ **忽略**', async () => {
    installBridge({
      listLocalTracks: vi.fn(async () => [{ ...ITEM }]),
    })
    installLocalLibraryStore()

    await waitFor(() => expect(useLocalLibraryStore.getState().items).toHaveLength(1))

    changedHandler?.([{ ...ITEM, id: '' }])

    expect(useLocalLibraryStore.getState().items).toHaveLength(1)
  })

  it('没有桥（浏览器预览 / 单测）→ **不报错**', () => {
    const uninstall = installLocalLibraryStore()
    expect(typeof uninstall).toBe('function')
    uninstall()
  })
})
