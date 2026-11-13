// ---------------------------------------------------------------------------
// T89-⑲：启动自动播放 + 记住播放位置续播
// ---------------------------------------------------------------------------
//
// 这组用例钉住四件事：
// 1. **记录归一化**：外部数据（`localStorage`，用户可编辑）不可信 ⇒ 陌生值整条丢弃；
// 2. **值得恢复的判定**：位置太靠前 / 距结尾太近 ⇒ 不恢复（从头播更自然）；
// 3. **恢复流程**：开关关 / 没记录 / 不值得 / 曲目没了 / 查库失败 ⇒ **都不恢复**，
//    且**每一种都要说得出原因**；
// 4. **store 的记录与恢复**：切歌换记录、暂停立刻写、**定位要延后到时长就绪之后**。
//
// ⚠️ **定位延后这一条最容易被写坏**：引擎的 `seek()` 直接写 `element.currentTime`，
//    元数据未就绪时写会**落空** ⇒ 必须在 `duration > 0` 之后才定位。
//
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrefsStore } from '../electron/ipc'
import {
  RESUME_MIN_POSITION_SEC,
  RESUME_TAIL_GUARD_SEC,
  normalizeResumeRecord,
  shouldResume,
  type ResumeRecord,
} from '../src/player/resume'
import { createResumePort, type ResumeStorageLike } from '../src/player/resumeBridge'
import { restoreLastPlayback } from '../src/state/resumeFlow'
import { createPlayerStore, type PlayerEngineLike } from '../src/state/playerStore'
import type { PlayMode, PlayerState, Song } from '../shared/types'

/** 造一首最小的曲目。 */
function song(id: string, duration = 240): Song {
  return {
    id,
    title: `歌 ${id}`,
    artist: '歌手',
    artistId: '',
    album: '专辑',
    albumId: '',
    coverId: '',
    duration,
    favorite: false,
    codec: 'FLAC',
    bitrate: 1000,
    sampleRate: 44100,
    bitDepth: 16,
    year: null,
    trackNo: null,
    discNo: null,
  }
}

/** 一条合法的记录。 */
function record(overrides: Partial<ResumeRecord> = {}): ResumeRecord {
  return {
    id: 'song-1',
    title: '歌一',
    artist: '歌手',
    coverId: '',
    duration: 240,
    positionSec: 60,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** 假引擎（只记录调用，不碰媒体栈）。 */
class FakeEngine implements PlayerEngineLike {
  state: PlayerState = {
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    error: null,
  }
  played: Song[] = []
  seeks: number[] = []
  private stateListeners: ((state: PlayerState) => void)[] = []
  private endedListeners: ((song: Song | null) => void)[] = []

  play(songToPlay: Song): void {
    this.played.push(songToPlay)
    this.state = { ...this.state, current: songToPlay, isPlaying: true, error: null }
    this.emit()
  }

  pause(): void {
    this.state = { ...this.state, isPlaying: false }
    this.emit()
  }

  resume(): void {
    this.state = { ...this.state, isPlaying: true }
    this.emit()
  }

  seek(sec: number): void {
    this.seeks.push(sec)
    this.state = { ...this.state, position: sec }
    this.emit()
  }

  setVolume(v: number): void {
    this.state = { ...this.state, volume: v }
  }

  setQueue(songs: Song[]): void {
    this.state = { ...this.state, queue: songs }
  }

  setMode(mode: PlayMode): void {
    this.state = { ...this.state, mode }
  }

  onStateChange(cb: (state: PlayerState) => void): void {
    this.stateListeners.push(cb)
  }

  onEnded(cb: (song: Song | null) => void): void {
    this.endedListeners.push(cb)
  }

  emit(): void {
    for (const cb of this.stateListeners) cb(this.state)
  }
}

/** 假存储（可注入键值对；可模拟「写不进去」）。 */
function fakeStorage(initial: Record<string, string> = {}): ResumeStorageLike & {
  data: Record<string, string>
} {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    removeItem: (key: string) => {
      delete data[key]
    },
  }
}

// ---------------------------------------------------------------------------
// 1. 记录归一化（外部数据不可信）
// ---------------------------------------------------------------------------

describe('T89-⑲ 记录归一化', () => {
  it('合法的记录原样保留', () => {
    const raw = record()
    expect(normalizeResumeRecord(raw)).toEqual(raw)
  })

  it('位置是字符串 ⇒ 整条丢弃（不构造半截数据）', () => {
    expect(normalizeResumeRecord({ ...record(), positionSec: '60' })).toBeNull()
  })

  it('时间是 null ⇒ 整条丢弃', () => {
    expect(normalizeResumeRecord({ ...record(), updatedAt: null })).toBeNull()
  })

  it('id 是空串 ⇒ 整条丢弃', () => {
    expect(normalizeResumeRecord({ ...record(), id: '' })).toBeNull()
  })

  it('时长不是正数 ⇒ 整条丢弃', () => {
    expect(normalizeResumeRecord({ ...record(), duration: 0 })).toBeNull()
    expect(normalizeResumeRecord({ ...record(), duration: -1 })).toBeNull()
  })

  it('不是对象（数字 / 字符串 / null）⇒ 整条丢弃', () => {
    expect(normalizeResumeRecord(42)).toBeNull()
    expect(normalizeResumeRecord('x')).toBeNull()
    expect(normalizeResumeRecord(null)).toBeNull()
    expect(normalizeResumeRecord(undefined)).toBeNull()
  })

  it('数组 ⇒ 整条丢弃', () => {
    expect(normalizeResumeRecord([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. 值得恢复的判定
// ---------------------------------------------------------------------------

describe('T89-⑲ 值得恢复的判定', () => {
  it('位置刚好到门槛 ⇒ 值得恢复', () => {
    expect(shouldResume(record({ positionSec: RESUME_MIN_POSITION_SEC }))).toBe(true)
  })

  it('位置差一点 ⇒ 不值得恢复（从头播更自然）', () => {
    expect(shouldResume(record({ positionSec: RESUME_MIN_POSITION_SEC - 0.1 }))).toBe(false)
  })

  it('距结尾刚好到门槛 ⇒ 值得恢复', () => {
    expect(shouldResume(record({ positionSec: 240 - RESUME_TAIL_GUARD_SEC }))).toBe(true)
  })

  it('距结尾差一点点 ⇒ 不值得恢复（续过去等于直接结束）', () => {
    expect(shouldResume(record({ positionSec: 240 - RESUME_TAIL_GUARD_SEC + 0.1 }))).toBe(false)
  })

  it('没有记录 ⇒ 不值得恢复', () => {
    expect(shouldResume(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. localStorage 端口
// ---------------------------------------------------------------------------

describe('T89-⑲ localStorage 端口', () => {
  it('写入后能读回', async () => {
    const storage = fakeStorage()
    const port = createResumePort(storage)
    await port.save(record())
    expect(await port.load()).toEqual(record())
  })

  it('损坏的 JSON ⇒ 读回 null（不抛）', async () => {
    const storage = fakeStorage({ 'fnmusic-resume': '{ 这不是 JSON' })
    const port = createResumePort(storage)
    expect(await port.load()).toBeNull()
  })

  it('形状不对 ⇒ 读回 null（不返回半截数据）', async () => {
    const storage = fakeStorage({ 'fnmusic-resume': JSON.stringify({ id: 'x' }) })
    const port = createResumePort(storage)
    expect(await port.load()).toBeNull()
  })

  it('清除后读回 null', async () => {
    const storage = fakeStorage()
    const port = createResumePort(storage)
    await port.save(record())
    await port.clear()
    expect(await port.load()).toBeNull()
  })

  it('没有存储 ⇒ 降级为 no-op（读回 null，写与清都不抛）', async () => {
    const port = createResumePort(null)
    expect(await port.load()).toBeNull()
    await expect(port.save(record())).resolves.toBeUndefined()
    await expect(port.clear()).resolves.toBeUndefined()
  })

  it('写不进去（配额满 / 隐私模式）⇒ 静默降级，不抛', async () => {
    const storage: ResumeStorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const port = createResumePort(storage)
    await expect(port.save(record())).resolves.toBeUndefined()
    await expect(port.clear()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. 恢复流程（每一种「不恢复」都要说得出原因）
// ---------------------------------------------------------------------------

describe('T89-⑲ 恢复流程', () => {
  /** 造一组依赖（默认「一切正常」）。 */
  function deps(overrides: Partial<Parameters<typeof restoreLastPlayback>[0]> = {}) {
    const played: Array<{ song: Song; positionSec: number }> = []
    const base = {
      autoplayEnabled: () => true,
      load: async () => record(),
      findSong: async (id: string) => song(id),
      play: (target: Song, positionSec: number) => {
        played.push({ song: target, positionSec })
      },
    }
    return { played, deps: { ...base, ...overrides } }
  }

  it('开关关着 ⇒ 不恢复（原因：disabled）', async () => {
    const { played, deps: d } = deps({ autoplayEnabled: () => false })
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored).toBe(false)
    expect(outcome.restored === false && outcome.reason).toBe('disabled')
    expect(played).toHaveLength(0)
  })

  it('没有记录 ⇒ 不恢复（原因：no-record）', async () => {
    const { played, deps: d } = deps({ load: async () => null })
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored === false && outcome.reason).toBe('no-record')
    expect(played).toHaveLength(0)
  })

  it('读记录抛错 ⇒ 不恢复，也不崩', async () => {
    const { deps: d } = deps({
      load: async () => {
        throw new Error('读不出来')
      },
    })
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored === false && outcome.reason).toBe('no-record')
  })

  it('位置太靠前 ⇒ 不恢复（原因：not-worth）', async () => {
    const { played, deps: d } = deps({ load: async () => record({ positionSec: 5 }) })
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored === false && outcome.reason).toBe('not-worth')
    expect(played).toHaveLength(0)
  })

  it('这一首已不在曲库 ⇒ 不恢复（原因：song-gone）', async () => {
    const { played, deps: d } = deps({ findSong: async () => null })
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored === false && outcome.reason).toBe('song-gone')
    expect(played).toHaveLength(0)
  })

  it('查曲库失败（NAS 不通）⇒ 不恢复（原因：lookup-failed）', async () => {
    const { played, deps: d } = deps({
      findSong: async () => {
        throw new Error('网络不通')
      },
    })
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored === false && outcome.reason).toBe('lookup-failed')
    expect(played).toHaveLength(0)
  })

  it('等流程的工夫里**用户自己动手了** ⇒ 不抢（原因：superseded）', async () => {
    const { played, deps: d } = deps({ canPlay: () => false })
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored === false && outcome.reason).toBe('superseded')
    expect(played).toHaveLength(0)
  })

  it('一切正常 ⇒ 恢复，且起播的是**曲库里的那一首**、位置是记录里的位置', async () => {
    const { played, deps: d } = deps()
    const outcome = await restoreLastPlayback(d)
    expect(outcome.restored).toBe(true)
    expect(played).toHaveLength(1)
    expect(played[0]!.song.id).toBe('song-1')
    expect(played[0]!.positionSec).toBe(60)
  })
})

// ---------------------------------------------------------------------------
// 5. store 的记录与恢复
// ---------------------------------------------------------------------------

describe('T89-⑲ store 的记录与恢复', () => {
  /**
   * 等写盘完成。
   *
   * ⚠️ 写盘走的是 `Promise.resolve().then(...)`（**微任务**）⇒ 断言前必须让出一次。
   *    （真正的 `localStorage.setItem` 本身是**同步**的，只是被 Promise 包了一层。）
   */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  /** 造一个带假端口的 store。 */
  function setup() {
    const saved: ResumeRecord[] = []
    const engine = new FakeEngine()
    const store = createPlayerStore(engine, {
      resume: {
        load: async () => null,
        save: async (rec) => {
          saved.push(rec)
        },
        clear: async () => undefined,
      },
    })
    return { engine, store, saved }
  }

  it('切歌 ⇒ 记录换成**新曲**（位置从 0 起）', async () => {
    const { store, saved } = setup()
    store.getState().playTrack(song('a'))
    store.getState().playTrack(song('b'))
    await flush()
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[saved.length - 1]!.id).toBe('b')
    expect(saved[saved.length - 1]!.positionSec).toBe(0)
  })

  it('暂停 ⇒ **立刻**写一次（位置被保住）', async () => {
    const { engine, store, saved } = setup()
    store.getState().playTrack(song('a'))
    engine.state = { ...engine.state, position: 42, duration: 240 }
    engine.emit()
    engine.pause()
    await flush()
    expect(saved[saved.length - 1]!.positionSec).toBe(42)
  })

  it('恢复 ⇒ 起播那一首', () => {
    const { engine, store } = setup()
    store.getState().resumePlayback(song('a'), 42)
    expect(engine.played.map((s) => s.id)).toEqual(['a'])
  })

  it('恢复 ⇒ **时长未就绪时不定位**（seek 会落空）', () => {
    const { engine, store } = setup()
    store.getState().resumePlayback(song('a'), 42)
    expect(engine.seeks).toHaveLength(0)
  })

  it('恢复 ⇒ 时长就绪后定位到记录的位置', () => {
    const { engine, store } = setup()
    store.getState().resumePlayback(song('a'), 42)
    engine.state = { ...engine.state, duration: 240 }
    engine.emit()
    expect(engine.seeks).toContain(42)
    expect(store.getState().position).toBe(42)
  })

  it('恢复 ⇒ 记录里保留着**原位置**（恢复没成功也不会把记录弄丢）', async () => {
    const { store, saved } = setup()
    store.getState().resumePlayback(song('a'), 42)
    await flush()
    expect(saved[saved.length - 1]!.positionSec).toBe(42)
  })

  it('没有端口 ⇒ 不崩（降级为「不记录、不恢复」）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    expect(() => {
      store.getState().playTrack(song('a'))
      store.getState().resumePlayback(song('a'), 42)
    }).not.toThrow()
  })

  it('记录里绝不含凭证', async () => {
    const { store, saved } = setup()
    store.getState().playTrack(song('a'))
    await flush()
    const dump = JSON.stringify(saved).toLowerCase()
    expect(dump).not.toContain('token')
    expect(dump).not.toContain('password')
    expect(dump).not.toContain('cookie')
  })
})

// ---------------------------------------------------------------------------
// 6. 偏好开关（「启动时自动播放」住在 prefs.json）
// ---------------------------------------------------------------------------

describe('T89-⑲ 「启动时自动播放」偏好', () => {
  /** 每次用例一个独立的偏好文件（系统临时目录，不入库）。 */
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fnm-t89-19-'))
    return join(dir, 'prefs.json')
  }

  it('能落盘并读回', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ autoplay: false })
    expect(prefs.read().autoplay).toBe(false)
  })

  it('**只认布尔**（字符串 "true" 一律丢弃）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ autoplay: 'true' as never })
    expect(prefs.read().autoplay).toBeUndefined()
  })

  it('缺省不写（老用户升级后行为不变 ⇒ 按「开启」处理）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ theme: 'fluent' })
    expect(prefs.read().autoplay).toBeUndefined()
  })

  it('⚠️ 偏好文件里**不会**出现「上次播到哪」（运行状态不住这儿）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ autoplay: true })
    const dumped = JSON.stringify(prefs.read())
    expect(dumped).not.toContain('positionSec')
    expect(dumped).not.toContain('fnmusic-resume')
  })
})
