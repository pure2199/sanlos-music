// ---------------------------------------------------------------------------
// T29 播放模式持久化
// ---------------------------------------------------------------------------
//
// 补的是一处**真实缺口**：T24 把播放模式接到了播放条上，但那个状态
// **只活在内存里** —— 切歌不丢，**重启应用就回到「顺序播放」**。
//
// 本文件钉：
// 1. `setMode` 会**落盘**（端口的 `save` 被调用，值是新模式）；
// 2. 启动时**读回** → `state.mode` / `queue.mode` / **引擎**三处同步
//    （只改 `state.mode` = 「界面写着随机播放、实际按顺序播」的**假状态**）；
// 3. **非法值**（外部可编辑文件）→ 回落「顺序播放」；
// 4. **没有端口**（浏览器预览 / 单元测试）→ 不崩、静默 no-op；
// 5. **写盘失败 / 读盘失败** → 不影响播放；
// 6. **竞态**：启动瞬间 `load()` 未返回时用户已切过模式
//    → 读回的旧值**不得覆盖**用户刚选的那个。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'

import type { PlayMode, Song } from '../shared/types'
import { createPlayerStore, type PlayerEngineLike } from '../src/state/playerStore'
import {
  normalizePlayMode,
  type PlayModePrefsPort,
} from '../src/player/playModePrefs'

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(id: string): Song {
  return {
    id,
    title: '占位歌',
    artist: '占位歌手',
    artistId: '',
    album: '占位专辑',
    albumId: '',
    coverId: '',
    duration: 100,
    favorite: false,
    codec: 'FLAC',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: 0,
    trackNo: 1,
    discNo: 1,
  }
}

/** 假引擎（只记模式，不碰音频）。 */
class FakeEngine implements PlayerEngineLike {
  /** 收到过的模式。 */
  modes: PlayMode[] = []
  /** 队列（不需要真实现）。 */
  setQueue(): void {
    // 不需要。
  }
  play(): void {
    // 不需要。
  }
  pause(): void {
    // 不需要。
  }
  resume(): void {
    // 不需要。
  }
  seek(): void {
    // 不需要。
  }
  setVolume(): void {
    // 不需要。
  }
  setMode(mode: PlayMode): void {
    this.modes.push(mode)
  }
  onStateChange(): () => void {
    return () => undefined
  }
  onEnded(): void {
    // 不需要。
  }
}

/** 造一个假端口（记录调用）。 */
function makePort(
  load: () => Promise<PlayMode | null>,
  save: (mode: PlayMode) => Promise<void> = async () => undefined,
): PlayModePrefsPort & { saved: PlayMode[] } {
  const saved: PlayMode[] = []
  return {
    saved,
    load,
    save: async (mode: PlayMode) => {
      saved.push(mode)
      await save(mode)
    },
  }
}

/**
 * 等**微任务全部排空**（一个宏任务边界）。
 *
 * ⚠️ **为什么必须等**：读回流程是 `await port.load()` 之后的**微任务**。
 *    而 `vi.waitFor(() => expect(mode).toBe('shuffle'))` 的**第一次**检查
 *    很可能跑在覆盖逻辑**之前** → 看到「还没被覆盖的旧值」→ **立刻通过**
 *    ⇒ 这样的断言**没有鉴别力**（去掉防护它照样绿）。
 *    ⇒ 断言「不该被覆盖」之前，必须先等流程**确实跑完**。
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------

describe('播放模式持久化（T29）', () => {
  it('setMode 会**落盘**（值 = 新模式）', async () => {
    const port = makePort(async () => null)
    const store = createPlayerStore(new FakeEngine(), { playModePrefs: port })

    store.getState().setMode('shuffle')

    await vi.waitFor(() => expect(port.saved).toEqual(['shuffle']))
    expect(store.getState().mode).toBe('shuffle')
  })

  it('启动时**读回**上次用的模式 → state / queue / 引擎**三处同步**', async () => {
    const engine = new FakeEngine()
    const port = makePort(async () => 'loop-list')
    const store = createPlayerStore(engine, { playModePrefs: port })

    await vi.waitFor(() => expect(store.getState().mode).toBe('loop-list'))
    // ⚠️ **引擎也要知道**：否则「下一首怎么走」还是旧规则。
    expect(engine.modes).toContain('loop-list')
  })

  it('读回后**下一首真的按那个模式走**（队列语义生效，不是只改界面）', async () => {
    const engine = new FakeEngine()
    const port = makePort(async () => 'loop-list')
    const store = createPlayerStore(engine, { playModePrefs: port })
    await vi.waitFor(() => expect(store.getState().mode).toBe('loop-list'))

    // 顺序模式下播到队尾会停；列表循环模式应回到第一首。
    store.getState().playTrack(makeSong('a'), [makeSong('a'), makeSong('b')])
    store.getState().next()
    expect(store.getState().current?.id).toBe('b')
    store.getState().next()
    // ⚠️ 列表循环 → 回到第一首（顺序模式下这里会是 null / 停）。
    expect(store.getState().current?.id).toBe('a')
  })

  it('**非法值**（外部可编辑文件）→ 回落「顺序播放」，不崩', async () => {
    const engine = new FakeEngine()
    const port = makePort(async () => '不存在的模式' as PlayMode)
    const store = createPlayerStore(engine, { playModePrefs: port })

    // ⚠️ **等流程跑完**再断言（否则读到的是「还没被处理」的初始值 → 假通过）。
    await flush()
    expect(store.getState().mode).toBe('sequence')
    // ⚠️ **脏值不许进引擎**（引擎据此决定「下一首怎么走」）。
    expect(engine.modes).not.toContain('不存在的模式')
  })

  it('**没设置过**（load 返回 null）→ 保持「顺序播放」', async () => {
    const port = makePort(async () => null)
    const store = createPlayerStore(new FakeEngine(), { playModePrefs: port })

    await flush()
    expect(store.getState().mode).toBe('sequence')
  })

  it('**没有端口**（浏览器预览 / 单测）→ 不崩、不静默写盘', async () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)

    store.getState().setMode('shuffle')
    expect(store.getState().mode).toBe('shuffle')
    // 没有端口 → 引擎照常收到（降级只影响落盘，不影响播放）。
    expect(engine.modes).toContain('shuffle')
  })

  it('**写盘失败** → 不影响播放（模式照样切了）', async () => {
    const port = makePort(
      async () => null,
      async () => {
        throw new Error('磁盘满了')
      },
    )
    const store = createPlayerStore(new FakeEngine(), { playModePrefs: port })

    store.getState().setMode('loop-one')
    await vi.waitFor(() => expect(port.saved).toEqual(['loop-one']))
    expect(store.getState().mode).toBe('loop-one')
  })

  it('**读盘失败** → 保持「顺序播放」，不崩', async () => {
    const port = makePort(async () => {
      throw new Error('偏好文件坏了')
    })
    const store = createPlayerStore(new FakeEngine(), { playModePrefs: port })

    await flush()
    expect(store.getState().mode).toBe('sequence')
  })

  it('**竞态**：用户已切过模式 → 迟到的读回**不得覆盖**用户的选择', async () => {
    let release: (value: PlayMode | null) => void = () => undefined
    const port = makePort(
      () =>
        new Promise<PlayMode | null>((resolve) => {
          release = resolve
        }),
    )
    const engine = new FakeEngine()
    const store = createPlayerStore(engine, { playModePrefs: port })

    // ⚠️ 用户在 `load()` 回来**之前**就切了模式。
    store.getState().setMode('shuffle')
    // 偏好文件里存的是旧模式 → 这时读回来**不能覆盖**用户刚选的。
    release('loop-one')

    // ⚠️ **必须等流程跑完**再断言：否则第一次检查抢跑 → 看到还没被覆盖的
    //    'shuffle' → **立刻通过** → 去掉防护这条测试照样绿（没有鉴别力）。
    await flush()
    expect(store.getState().mode).toBe('shuffle')
    // ⚠️ **引擎也不该被旧值污染**。
    expect(engine.modes).not.toContain('loop-one')
  })

  it('setMode 传入**非法值** → 压成「顺序播放」（不把脏值写进偏好）', () => {
    const port = makePort(async () => null)
    const store = createPlayerStore(new FakeEngine(), { playModePrefs: port })

    store.getState().setMode('胡说八道' as PlayMode)

    expect(store.getState().mode).toBe('sequence')
  })

  it('normalizePlayMode 只认四个合法值', () => {
    expect(normalizePlayMode('sequence')).toBe('sequence')
    expect(normalizePlayMode('shuffle')).toBe('shuffle')
    expect(normalizePlayMode('loop-one')).toBe('loop-one')
    expect(normalizePlayMode('loop-list')).toBe('loop-list')
    expect(normalizePlayMode('nope')).toBe('sequence')
    expect(normalizePlayMode(undefined)).toBe('sequence')
    expect(normalizePlayMode(123)).toBe('sequence')
    expect(normalizePlayMode(null)).toBe('sequence')
  })
})
