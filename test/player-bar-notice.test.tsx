import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { PlayerBar, type PlayerStoreLike } from '../src/components/PlayerBar'
import type { PlayerStore } from '../src/state/playerStore'
import {
  BUFFERING_MESSAGE,
  FALLBACK_LOSSY_NOTE,
  FALLBACK_PREPARING_MESSAGE,
} from '../src/player/format'
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
    buffering: false,
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

  // -------------------------------------------------------------------------
  // T37：缓冲中（**不是错误**）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 慢网 / 中继带宽有限时媒体元素会发 `stalled` / `waiting`——那是**瞬时提示**，
  //    音乐其实照放。早先把它当错误 → 界面挂**红字**（`role="alert"`）。
  //    ⇒ 现在是**灰字**（`role="status"`），数据到了自动消失。
  it('缓冲中 → 显示「缓冲中…」（role=status，**不**当错误报红）', () => {
    render(<PlayerBar store={fakeStore({ buffering: true })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe(BUFFERING_MESSAGE)
    // ⚠️ **不能**是 `alert`（`alert` = 红色 + 立刻播报）——那是给真错误用的。
    expect(notice.getAttribute('role')).toBe('status')
  })

  it('错误优先于「缓冲中」（真出错时只显示错误）', () => {
    render(<PlayerBar store={fakeStore({ buffering: true, error: '出错了' })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe('出错了')
    expect(notice.getAttribute('role')).toBe('alert')
  })

  it('「缓冲中」优先于「音质有损」（用户此刻在等数据，先说在等）', () => {
    render(<PlayerBar store={fakeStore({ buffering: true, fallbackActive: true })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe(BUFFERING_MESSAGE)
    expect(notice.getAttribute('role')).toBe('status')
  })

  it('「正在转换…」优先于「缓冲中」（两者同时出现时显示转换）', () => {
    render(<PlayerBar store={fakeStore({ buffering: true, preparing: true })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe(FALLBACK_PREPARING_MESSAGE)
  })
})
