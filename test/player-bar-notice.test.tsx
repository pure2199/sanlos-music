import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { PlayerBar, type PlayerStoreLike } from '../src/components/PlayerBar'
import type { PlayerStore } from '../src/state/playerStore'
import { FALLBACK_LOSSY_NOTE, FALLBACK_PREPARING_MESSAGE } from '../src/player/format'
import type { Song } from '../shared/types'

// ---------------------------------------------------------------------------
// Task 12：播放条的**提示行**
//
// 覆盖此前的一个真实缺口：**播放器错误此前根本没有被渲染**
// （`PlayerBar` 里没有任何 `error` 输出）——用户只看到「不播了」，看不到原因。
//
// 三种提示：
// - 正在兜底转码 → `role="status"` + 「正在转换…」；
// - 播放错误 → `role="alert"`（立刻播报）+ 错误文案；
// - 兜底产物在播 → `role="status"` + 「音质有损」的实话。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

/** 构造占位歌曲。 */
const song: Song = {
  id: 'track_a',
  title: '歌一',
  artist: '示例歌手',
  artistId: '',
  album: '',
  albumId: '',
  coverId: '',
  duration: 100,
  favorite: false,
  codec: 'APE',
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 0,
  discNo: 0,
}

/** 造一个只读的假 store（只提供 `PlayerBar` 用到的字段）。 */
function fakeStore(overrides: Partial<PlayerStore> = {}): PlayerStoreLike {
  const state = {
    current: song,
    queue: [song],
    isPlaying: false,
    position: 0,
    duration: 100,
    volume: 1,
    mode: 'sequence',
    muted: false,
    error: null,
    preparing: false,
    fallbackActive: false,
    ...overrides,
  } as unknown as PlayerStore
  return {
    getState: () => state,
    subscribe: () => () => undefined,
  }
}

describe('播放条提示行', () => {
  it('没有提示时**不渲染**提示行', () => {
    render(<PlayerBar store={fakeStore()} />)
    expect(screen.queryByTestId('player-notice')).toBeNull()
  })

  it('正在兜底转码 → 显示「正在转换…」（role=status）', () => {
    render(<PlayerBar store={fakeStore({ preparing: true })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe(FALLBACK_PREPARING_MESSAGE)
    expect(notice.getAttribute('role')).toBe('status')
  })

  it('播放错误 → 显示错误文案（role=alert，**不静默失败**）', () => {
    render(<PlayerBar store={fakeStore({ error: '该格式（APE）当前无法播放：还没有下载到本地。' })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toContain('APE')
    expect(notice.textContent).toContain('下载')
    expect(notice.getAttribute('role')).toBe('alert')
  })

  it('错误优先于「正在转换」（两者同时出现时显示错误）', () => {
    render(<PlayerBar store={fakeStore({ preparing: true, error: '出错了' })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe('出错了')
    expect(notice.getAttribute('role')).toBe('alert')
  })

  it('兜底产物在播 → 如实注明「音质有损」', () => {
    render(<PlayerBar store={fakeStore({ fallbackActive: true })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe(FALLBACK_LOSSY_NOTE)
    expect(notice.textContent).toContain('有损')
  })
})
