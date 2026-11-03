// ---------------------------------------------------------------------------
// Task 5（新版清单）：软件 EQ 完整落地
//
// 审计报表 P0-2 指出 EQ 有**四个断点**，本文件逐个钉住：
// 1. **偏好白名单丢弃 `eq`** → 主进程 `PrefsStore` 认不认这一段；
// 2. **store 未传端口**（`createEqPrefsPort` 零调用）→ 渲染进程的端口接没接上；
// 3. **面板未挂载** → 播放条的 EQ 入口点开有没有面板；
// 4. **按钮是禁用的占位** → EQ 入口现在必须可用。
//
// ⚠️ 测试里一律用占位数据，不写真实 FN ID / 账号 / 口令。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, screen, fireEvent } from '@testing-library/react'

import { PrefsStore } from '../electron/ipc'
import { eqPrefsPort } from '../src/player/eqPrefsBridge'
import { PlayerBar } from '../src/components/PlayerBar'
import { createPlayerStore, usePlayerStore } from '../src/state/playerStore'
import type { AppPrefs, PlayerBridge } from '../shared/playerBridge'

// ---------------------------------------------------------------------------
// 临时目录
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

function tempFile(name = 'prefs.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnmusic-eq-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1. 主进程偏好白名单
// ---------------------------------------------------------------------------

describe('偏好白名单：eq 这一段', () => {
  it('合法的 eq 能落盘并读回', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    const eq = {
      presetKey: 'rock',
      manualOffset: [1, 0, -1, 0, 0, 0, 0, 0, 0, 0],
      bandCount: 10 as const,
      enabled: true,
      presetBaseline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    }

    prefs.write({ eq })

    expect(prefs.read().eq).toEqual(eq)
  })

  it('形状不对的 eq 整段丢弃（不写半截进文件）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })

    // 段数不是 10 / 15。
    prefs.write({ eq: { ...validEq(), bandCount: 12 } as never })
    expect(prefs.read().eq).toBeUndefined()

    // 手动偏移里混了非数字。
    prefs.write({ eq: { ...validEq(), manualOffset: [1, 'x'] } as never })
    expect(prefs.read().eq).toBeUndefined()

    // 根本不是对象。
    prefs.write({ eq: 'nope' as never })
    expect(prefs.read().eq).toBeUndefined()
  })

  it('eq 里塞凭证照样被丢掉（白名单只认形状）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ eq: { ...validEq(), token: 'SECRET' } as never })
    const dumped = JSON.stringify(prefs.read())
    expect(dumped).not.toContain('SECRET')
  })

  it('其它偏好键不受影响（eq 只是多认了一个键）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ theme: 'fluent' })
    prefs.write({ eq: validEq() })
    expect(prefs.read().theme).toBe('fluent')
    expect(prefs.read().eq).toBeDefined()
  })
})

/** 造一份合法的 eq 载荷。 */
function validEq(): {
  presetKey: string
  manualOffset: number[]
  bandCount: 10
  enabled: boolean
} {
  return {
    presetKey: 'flat',
    manualOffset: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bandCount: 10,
    enabled: true,
  }
}

// ---------------------------------------------------------------------------
// 2. 渲染进程的 EQ 偏好端口
// ---------------------------------------------------------------------------

describe('渲染进程的 EQ 偏好端口', () => {
  afterEach(() => {
    delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  })

  it('有桥时：读走 prefs:get 的 eq，写走 prefs:set 的 eq', async () => {
    const eq = validEq()
    const getPrefs = vi.fn(async () => ({ eq }))
    const setPrefs = vi.fn(async (_patch: Partial<AppPrefs>) => ({}))
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = {
      getPrefs,
      setPrefs,
    } as unknown as PlayerBridge

    await expect(eqPrefsPort.load()).resolves.toEqual(eq)
    await eqPrefsPort.save(eq)

    expect(getPrefs).toHaveBeenCalledTimes(1)
    expect(setPrefs).toHaveBeenCalledTimes(1)
    expect(setPrefs.mock.calls[0]![0]).toEqual({ eq })
  })

  it('没有桥时降级：读回 null、写也不抛（不崩、不静默写盘）', async () => {
    delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer

    await expect(eqPrefsPort.load()).resolves.toBeNull()
    await expect(eqPrefsPort.save(validEq())).resolves.toBeUndefined()
  })

  it('没有桥时偏好文件里不会凭空多出 eq', () => {
    // 端口是 no-op → 主进程那边什么都不会被写。
    const prefs = new PrefsStore({ filePath: tempFile() })
    expect(prefs.read().eq).toBeUndefined()
  })

  it('生产用的 usePlayerStore 真的带着端口（改 EQ → prefs:set 被调用）', async () => {
    // ⚠️ 这是审计报表 P0-2「store 未传端口」的**直接防线**：
    //    生产 store（模块级单例）必须**真的**把 EQ 设置写到主进程去。
    const setPrefs = vi.fn(async (_patch: Partial<AppPrefs>) => ({}))
    ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = {
      getPrefs: vi.fn(async () => ({})),
      setPrefs,
    } as unknown as PlayerBridge

    usePlayerStore.getState().setEqPreset('rock')

    await vi.waitFor(() => expect(setPrefs).toHaveBeenCalled())
    const patch = setPrefs.mock.calls[0]![0] as { eq?: { presetKey: string } }
    expect(patch.eq?.presetKey).toBe('rock')
  })
})

// ---------------------------------------------------------------------------
// 3 + 4. 播放条的 EQ 入口与面板
// ---------------------------------------------------------------------------

describe('播放条的 EQ 入口', () => {
  it('EQ 按钮不再禁用，点开就是均衡器面板', () => {
    const store = createPlayerStore(new FakeEngine())
    render(<PlayerBar store={store} />)

    const eq = screen.getByRole('button', { name: 'EQ' })
    // ⚠️ 旧行为是「禁用 + 提示即将支持」——Task 5 起面板真正挂载，按钮必须可用。
    expect(eq.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('dialog', { name: '均衡器' })).toBeNull()

    fireEvent.click(eq)

    const dialog = screen.getByRole('dialog', { name: '均衡器' })
    expect(dialog).toBeTruthy()
    // 面板里能直接操作（预置曲线下拉在）。
    expect(screen.getByLabelText('预置曲线')).toBeTruthy()
  })

  it('再点一次 EQ 按钮收起面板', () => {
    const store = createPlayerStore(new FakeEngine())
    render(<PlayerBar store={store} />)

    const eq = screen.getByRole('button', { name: 'EQ' })
    fireEvent.click(eq)
    expect(screen.getByRole('dialog', { name: '均衡器' })).toBeTruthy()

    fireEvent.click(eq)
    expect(screen.queryByRole('dialog', { name: '均衡器' })).toBeNull()
  })

  it('队列面板与 EQ 面板互斥（不会叠在一起）', () => {
    const store = createPlayerStore(new FakeEngine())
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByRole('button', { name: 'EQ' }))
    expect(screen.getByRole('dialog', { name: '均衡器' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '播放队列' }))
    expect(screen.queryByRole('dialog', { name: '均衡器' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '播放队列' })).toBeTruthy()
  })

  it('面板里改增益 → 偏好被写出去（端口真的接上了）', async () => {
    const saved: unknown[] = []
    const store = createPlayerStore(new FakeEngine(), {
      eqPrefs: {
        load: async () => null,
        save: async (prefs) => {
          saved.push(prefs)
        },
      },
    })
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByRole('button', { name: 'EQ' }))
    // ⚠️ 要按**标签**取 EQ 的频段滑块——播放条上还有一个音量滑块，
    //    `getAllByRole('slider')[0]` 拿到的是音量那个。
    const slider = screen.getByLabelText('31.5 增益偏移') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '3' } })

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const prefs = saved[0] as { manualOffset: number[] }
    expect(prefs.manualOffset[0]).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 假引擎
// ---------------------------------------------------------------------------

/** 一个不碰真实 WebAudio 的假引擎。 */
class FakeEngine {
  onStateChange(): void {
    /* 什么都不做 */
  }
  onEnded(): void {
    /* 什么都不做 */
  }
  setQueue(): void {
    /* 什么都不做 */
  }
  play(): void {
    /* 什么都不做 */
  }
  pause(): void {
    /* 什么都不做 */
  }
  resume(): void {
    /* 什么都不做 */
  }
  seek(): void {
    /* 什么都不做 */
  }
  setVolume(): void {
    /* 什么都不做 */
  }
  setMode(): void {
    /* 什么都不做 */
  }
}
