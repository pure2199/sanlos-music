// ---------------------------------------------------------------------------
// T37：引擎状态 → store 的**传输层字段**同步
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这组测试**：此前**没有任何测试**覆盖
//    「引擎的状态变化 → store」这条同步（`error` / `preparing` / `fallbackActive`
//    都是**直接抄**进 store 的，抄错了没人拦）。
//    T37 加了 `buffering`（缓冲中）——正是这条链上的字段，
//    写错一个字母 → 播放条**永远不显示**「缓冲中…」，而**没有任何测试会红**。
//
// ⚠️ 这组测试盯的是**链路**，不是界面：界面那层在 `player-bar-notice.test.tsx`。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { createPlayerStore } from '../src/state/playerStore'
import type { PlayerEngineLike } from '../src/player/engine'
import type { PlayerState } from '../shared/types'

/** 假引擎：能**主动推**一份状态出来。 */
function fakeEngine(): {
  engine: PlayerEngineLike
  push: (patch: Partial<PlayerState>) => void
} {
  const listeners: ((state: PlayerState) => void)[] = []
  let state: PlayerState = {
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
  }
  return {
    engine: {
      play: (): void => undefined,
      pause: (): void => undefined,
      resume: (): void => undefined,
      seek: (): void => undefined,
      setVolume: (): void => undefined,
      setMode: (): void => undefined,
      onStateChange: (cb: (state: PlayerState) => void): void => {
        listeners.push(cb)
      },
      onEnded: (): void => undefined,
    },
    push: (patch: Partial<PlayerState>): void => {
      state = { ...state, ...patch }
      for (const cb of listeners) cb(state)
    },
  }
}

describe('引擎状态 → store 的同步（T37）', () => {
  it('**缓冲中**会同步进 store（界面才能显示「缓冲中…」）', () => {
    const { engine, push } = fakeEngine()
    const store = createPlayerStore(engine)

    push({ buffering: true })
    expect(store.getState().buffering).toBe(true)

    push({ buffering: false })
    expect(store.getState().buffering).toBe(false)
  })

  it('**没缓冲时**是 `false`（不是 `undefined`）——界面判断用 `=== true`', () => {
    const { engine } = fakeEngine()
    const store = createPlayerStore(engine)
    expect(store.getState().buffering).toBe(false)
  })

  it('**错误**也会同步进 store（既有链路不许被改坏）', () => {
    const { engine, push } = fakeEngine()
    const store = createPlayerStore(engine)

    push({ error: '出错了' })
    expect(store.getState().error).toBe('出错了')
  })

  it('**兜底转码 / 兜底产物**标志也会同步（既有链路不许被改坏）', () => {
    const { engine, push } = fakeEngine()
    const store = createPlayerStore(engine)

    push({ preparing: true, fallbackActive: true })
    expect(store.getState().preparing).toBe(true)
    expect(store.getState().fallbackActive).toBe(true)
  })
})
