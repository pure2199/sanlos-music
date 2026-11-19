// ---------------------------------------------------------------------------
// T117：第四个旧 `localStorage` 键（**有声读物的扫描结果**）的「旧键回落」
// ---------------------------------------------------------------------------
//
// 这个测试防的是什么
// ---------------------------------------------------------------------------
// T115 把里层代号全改了，`localStorage` 的键也跟着改了四个：
// `fnmusic-local-history` / `fnmusic-resume` / `fnmusic-lyric-overrides`
// ＋ **`fnmusic-audiobook-state`**（有声读物的扫描结果 ＋ 用户的手工改判）。
//
// ⚠️ 前三个都做了「**新键没有才回落读旧键**」，**第四个漏了** ⇒
//   用户升级后那份落盘**读不到** ⇒
//   ① 有声读物的**自动判定失效**（`hits` 为空 ⇒ `isAudiobook()` 返回 false）
//      ⇒ **T112 修的「有声读物被误配桌面歌词」那条缺陷又回来了**；
//   ② **手工改判丢失**；
//   ③ 「有声」页下次进入**自动全库重扫**（实测 87 页 / 6–47 分钟）。
//
// ⇒ 本测试把「回落 + 迁移 + 不复活」钉死（**8 条**）。
//
// ⚠️ **既有测试一条不许删、断言一条不许弱化**：本文件是**新增**的钉子。
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { LEGACY_AUDIOBOOK_STATE_KEY } from '../shared/legacyStorageKeys'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * **新键**的键名（**刻意写字面量**）。
 *
 * ⚠️ 为什么不从实现里 import：这个测试要钉的就是「磁盘上那个键叫什么」
 *    ⇒ 从实现里 import 的话，实现改了键名测试也会跟着改 ⇒ **钉不住**。
 */
const NEW_KEY = 'sanlos-audiobook-state'

/** 落盘里的 `scannedAt`（**扫描完成的时间戳** ⇒ 有它 ⇒ 不用重扫）。 */
const SCANNED_AT = 1_763_000_000_000

/** 一份合法的 v3 落盘（形状照 `AudiobookPersisted`）。 */
function legacyPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    nextPage: 0,
    scannedCount: 173671,
    total: 173671,
    candidates: {
      'album-1': {
        albumId: 'album-1',
        albumTitle: '牧神记',
        trackCount: 27,
        totalDurationSec: 145,
        maxDurationSec: 289,
        episodeStats: { ruleCounts: { 'digits-only': 27 }, titleCount: 27 },
        dirs: ['有声小说/牧神记'],
        coverId: '',
        albumCoverId: null,
      },
    },
    overrides: {
      'album-2': { value: 'audiobook', albumTitle: '另一部作品' },
    },
    keyword: '有声小说',
    scannedAt: SCANNED_AT,
    ...over,
  })
}

/** 读一个仓库文件（相对本测试文件）。 */
function readRepoFile(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

// ---------------------------------------------------------------------------
// ① 旧键字面量
// ---------------------------------------------------------------------------

describe('T117 · 第四个旧键的字面量', () => {
  it('旧键 = `fnmusic-audiobook-state`，且**住在白名单文件**里（旧名不许散落）', () => {
    expect(LEGACY_AUDIOBOOK_STATE_KEY).toBe('fnmusic-audiobook-state')
    const src = readRepoFile('../shared/legacyStorageKeys.ts')
    expect(src).toContain("'fnmusic-audiobook-state'")
    // ⚠ 旧键**只该**出现在这一个文件里（⇒ 别的文件不许硬写这个字面量）。
    expect(readRepoFile('../src/state/audiobookStore.ts')).not.toContain("'fnmusic-audiobook-state'")
  })
})

// ---------------------------------------------------------------------------
// ②–⑦ 回落 / 优先 / 只读 / 迁移 / 不复活
// ---------------------------------------------------------------------------

describe('T117 · 有声扫描结果的旧键回落', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('② 旧键有值、新键没有 ⇒ 回落读得到（`scannedAt` ＋ 手工改判）', async () => {
    window.localStorage.setItem(LEGACY_AUDIOBOOK_STATE_KEY, legacyPayload())
    const mod = await import('../src/state/audiobookStore')
    mod.useAudiobookStore.getState().restore()
    const state = mod.useAudiobookStore.getState()
    // ⚠ `scannedAt` 有值 ⇒ 「有声」页**不会**自动全库重扫（87 页 / 6–47 分钟）。
    expect(state.scannedAt).toBe(SCANNED_AT)
    expect(state.overrides['album-2']?.value).toBe('audiobook')
  })

  it('③ 旧键里的候选能还原成命中列表 ⇒ **自动判定**还在（T112 的地基）', async () => {
    window.localStorage.setItem(LEGACY_AUDIOBOOK_STATE_KEY, legacyPayload())
    const mod = await import('../src/state/audiobookStore')
    mod.useAudiobookStore.getState().restore()
    const state = mod.useAudiobookStore.getState()
    expect(state.hits.map((hit) => hit.albumId)).toContain('album-1')
    // ⭐ 这就是「自动判定」本身：桌面歌词取词前先问它。
    expect(state.isAudiobook('album-1')).toBe(true)
  })

  it('④ 新键**优先**于旧键（不能被旧数据顶掉）', async () => {
    window.localStorage.setItem(LEGACY_AUDIOBOOK_STATE_KEY, legacyPayload({ scannedAt: 111 }))
    window.localStorage.setItem(NEW_KEY, legacyPayload({ scannedAt: 222 }))
    const mod = await import('../src/state/audiobookStore')
    mod.useAudiobookStore.getState().restore()
    expect(mod.useAudiobookStore.getState().scannedAt).toBe(222)
  })

  it('⑤ 回落**只读**：旧键不会被删（迁移的路不能被堵死）', async () => {
    window.localStorage.setItem(LEGACY_AUDIOBOOK_STATE_KEY, legacyPayload())
    const mod = await import('../src/state/audiobookStore')
    mod.useAudiobookStore.getState().restore()
    expect(window.localStorage.getItem(LEGACY_AUDIOBOOK_STATE_KEY)).not.toBeNull()
  })

  it('⑥ 写一次之后落**新键**，且旧键里的候选与改判**都带过去**（一次性迁移）', async () => {
    window.localStorage.setItem(LEGACY_AUDIOBOOK_STATE_KEY, legacyPayload())
    const mod = await import('../src/state/audiobookStore')
    mod.useAudiobookStore.getState().setOverride('album-3', 'audiobook', undefined, '第三部作品')
    const raw = window.localStorage.getItem(NEW_KEY)
    expect(raw).not.toBeNull()
    const saved = JSON.parse(raw as string) as {
      candidates: Record<string, unknown>
      overrides: Record<string, { value: string }>
    }
    // ⚠ 旧数据**没丢**（这才是「迁移」而不是「覆盖」）。
    expect(saved.candidates['album-1']).toBeDefined()
    expect(saved.overrides['album-2']?.value).toBe('audiobook')
    expect(saved.overrides['album-3']?.value).toBe('audiobook')
    // ⚠ 旧键**只读不删**。
    expect(window.localStorage.getItem(LEGACY_AUDIOBOOK_STATE_KEY)).not.toBeNull()
  })

  it('⑦ 撤销改判**不会**让旧数据复活（新键仍在 ⇒ 旧键不被读回）', async () => {
    window.localStorage.setItem(LEGACY_AUDIOBOOK_STATE_KEY, legacyPayload())
    const mod = await import('../src/state/audiobookStore')
    const store = mod.useAudiobookStore
    // 撤销「album-2」的手工改判 ⇒ 只改**新键**。
    store.getState().setOverride('album-2', null)
    store.getState().restore()
    // ⚠ 若实现「删了新键就回落读旧键」⇒ 这里会把 album-2 复活 ⇒ 用例变红。
    expect(store.getState().overrides['album-2']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ⑧ 落盘版本：**不许**升（升了旧数据直接作废）
// ---------------------------------------------------------------------------

describe('T117 · 落盘版本不许升', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('⑧ `STATE_VERSION` 仍是 3；`version` 不符的落盘**丢弃**（坏数据不进内存）', async () => {
    const src = readRepoFile('../src/state/audiobookStore.ts')
    expect(src).toMatch(/const STATE_VERSION = 3\b/)
    // ⚠ 升版本 ⇒ 旧数据直接作废 ⇒ **正是要避免的事** ⇒ 形状不符必须**丢弃**。
    window.localStorage.setItem(LEGACY_AUDIOBOOK_STATE_KEY, legacyPayload({ version: 4 }))
    const mod = await import('../src/state/audiobookStore')
    mod.useAudiobookStore.getState().restore()
    const state = mod.useAudiobookStore.getState()
    expect(state.scannedAt).toBeNull()
    expect(state.hits).toHaveLength(0)
    expect(state.overrides).toEqual({})
  })
})
