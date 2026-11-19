// ---------------------------------------------------------------------------
// T123：退出前补写一次「上次播放」的位置
// ---------------------------------------------------------------------------
//
// ⚠️ 钉住的行为：
// 1. `flushResume()` **强制**写一次（**不受 10 秒节流约束**）——
//    平时写盘是节流的（切歌 / 暂停 / 每 10 秒）⇒ 异常退出最多丢 10 秒进度；
// 2. **没有当前曲目** ⇒ **不写**（不制造「看起来存了、其实读不出来」的假状态）；
// 3. 退出钩子（`beforeunload` / `pagehide`）⇒ 会补写；卸载后不再补写；
// 4. ⚠️ 补写**抛异常也不许影响退出**（退出路径不能被记录拖垮）；
// 5. 「**关掉自动播放 ⇒ 不出声，但位置照记**」：
//    自动播放关着 ⇒ **不恢复、不出声**（`play` 不被调用），
//    且**已存的那条记录不被读走 / 不被覆盖**（位置照记 ⇒ 下次开自动播放仍从那儿续）。
//
// ⚠️ **第 5 条是既有行为**（T89-⑲ 起就是这样），本轮只是**补上钉子**
//    （台账里它一直挂着「**安装版实测**」⇒ 代码层面先钉死，真机项另列）。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { Song } from '../shared/types'
import { createPlayerStore, type PlayerEngineLike } from '../src/state/playerStore'
import { installResumeFlush } from '../src/player/resumeFlush'
import { restoreLastPlayback } from '../src/state/resumeFlow'
import type { ResumeRecord } from '../src/player/resume'

/** 一首最小的歌（`duration` 必须 > 0 ⇒ 否则记录**不写**）。 */
const SONG: Song = {
  id: 'song-1',
  title: '示例曲目',
  artist: '示例歌手',
  artistId: 'a-1',
  album: '示例专辑',
  albumId: 'al-1',
  coverId: '',
  duration: 185,
  favorite: false,
  codec: 'FLAC',
  bitrate: 900,
  sampleRate: 44100,
  bitDepth: 16,
  year: null,
  trackNo: null,
  discNo: null,
}

/** 假引擎（只满足 store 需要的最小面）。 */
const engine: PlayerEngineLike = {
  play: () => {},
  pause: () => {},
  resume: () => {},
  seek: () => {},
  setVolume: () => {},
  onStateChange: () => {},
  onEnded: () => {},
}

/** 造一个带**假 resume 端口**的 store。 */
function makeStore() {
  const save = vi.fn(async (_record: ResumeRecord): Promise<void> => undefined)
  const store = createPlayerStore(engine, {
    resume: {
      load: async () => null,
      save,
      clear: async () => undefined,
    },
  })
  return { store, save }
}

/** 让 `persistResume` 里的那个微任务跑完。 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('T123：退出前补写一次位置', () => {
  it('① `flushResume()` 强制写一次（不受 10 秒节流约束）', async () => {
    const { store, save } = makeStore()
    store.getState().playTrack(SONG, [SONG])
    await settle()
    // 切歌 ⇒ 写了一条「位置 0」。
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]?.[0]?.positionSec).toBe(0)

    // ⚠️ 拖到 42 秒 ⇒ **节流内** ⇒ 不写（这正是「异常退出最多丢 10 秒」的由来）。
    store.getState().seek(42)
    await settle()
    expect(save).toHaveBeenCalledTimes(1)

    // 退出前补写 ⇒ **立刻**写一条，位置就是当前的 42 秒。
    store.getState().flushResume()
    await settle()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0]?.positionSec).toBe(42)
    expect(save.mock.calls[1]?.[0]?.id).toBe(SONG.id)
    expect(save.mock.calls[1]?.[0]?.duration).toBe(185)
  })

  it('② 没有当前曲目 ⇒ `flushResume()` 不写', async () => {
    const { store, save } = makeStore()
    store.getState().flushResume()
    await settle()
    expect(save).not.toHaveBeenCalled()
  })

  it('③ 退出钩子：`beforeunload` / `pagehide` 都会补写；卸载后不再补写', () => {
    const flush = vi.fn()
    const uninstall = installResumeFlush(flush)

    window.dispatchEvent(new Event('beforeunload'))
    expect(flush).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(2)

    uninstall()
    window.dispatchEvent(new Event('beforeunload'))
    window.dispatchEvent(new Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('④ 补写抛异常 ⇒ **不许**影响退出（异常不冒泡）', () => {
    const flush = vi.fn(() => {
      throw new Error('写盘失败')
    })
    installResumeFlush(flush)
    expect(() => window.dispatchEvent(new Event('beforeunload'))).not.toThrow()
  })

  it('⑤ 关掉自动播放 ⇒ **不出声**（不恢复），但**位置照记**（记录不被读走/覆盖）', async () => {
    const play = vi.fn()
    const load = vi.fn(async (): Promise<ResumeRecord | null> => ({
      id: SONG.id,
      title: SONG.title,
      artist: SONG.artist,
      coverId: '',
      duration: 185,
      positionSec: 90,
      updatedAt: Date.now(),
    }))

    const outcome = await restoreLastPlayback({
      autoplayEnabled: () => false,
      load,
      findSong: async () => SONG,
      play,
    })

    // ⚠️ **不恢复** ⇒ 不出声。
    expect(outcome).toEqual({ restored: false, reason: 'disabled' })
    expect(play).not.toHaveBeenCalled()
    // ⚠️ **位置照记**：自动播放关着时**连记录都不读**（更不会覆盖它）
    //    ⇒ 下次开自动播放仍从 90 秒处续。
    expect(load).not.toHaveBeenCalled()
  })
})
