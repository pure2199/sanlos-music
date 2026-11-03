// ---------------------------------------------------------------------------
// Task 8（新版清单）：窗口位置与尺寸记忆
//
// 覆盖审计报表 G-1（`AppPrefs.windowBounds` 早就有，主进程却**从不消费**）：
// - **恢复**：按偏好给建窗参数（缺位置就不给位置）；
// - **保存**：去抖（拖动时不每帧写盘）+ 关闭前立刻存一次。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'

import { createBoundsSaver, resolveWindowBounds } from '../electron/windowBounds'
import { PrefsStore } from '../electron/ipc'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnmusic-bounds-'))
  tempDirs.push(dir)
  return join(dir, 'prefs.json')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

describe('恢复窗口位置尺寸', () => {
  it('没有偏好时用默认尺寸（且不给位置）', () => {
    const options = resolveWindowBounds(undefined, { width: 1200, height: 800 })
    expect(options).toEqual({ width: 1200, height: 800 })
    expect(options.x).toBeUndefined()
    expect(options.y).toBeUndefined()
  })

  it('有偏好时用偏好的尺寸与位置', () => {
    const options = resolveWindowBounds({ width: 900, height: 600, x: 10, y: 20 }, {
      width: 1200,
      height: 800,
    })
    expect(options).toEqual({ width: 900, height: 600, x: 10, y: 20 })
  })

  it('只存了尺寸就不给位置（别把窗口甩到历史坐标上）', () => {
    const options = resolveWindowBounds({ width: 900, height: 600 }, { width: 1200, height: 800 })
    expect(options.width).toBe(900)
    expect(options.height).toBe(600)
    expect(options.x).toBeUndefined()
    expect(options.y).toBeUndefined()
  })

  it('尺寸不合法（<= 0）时回落到默认值', () => {
    const options = resolveWindowBounds({ width: 0, height: 0 }, { width: 1200, height: 800 })
    expect(options).toEqual({ width: 1200, height: 800 })
  })
})

describe('保存窗口位置尺寸', () => {
  it('连续 schedule 只真正写一次（去抖）', () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const saver = createBoundsSaver({
      getBounds: () => ({ x: 1, y: 2, width: 800, height: 600 }),
      save,
      delayMs: 500,
    })

    saver.schedule()
    saver.schedule()
    saver.schedule()
    expect(save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ x: 1, y: 2, width: 800, height: 600 })
  })

  it('saveNow 立刻写（不等去抖）', () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const saver = createBoundsSaver({
      getBounds: () => ({ x: 5, y: 6, width: 1024, height: 768 }),
      save,
    })

    saver.saveNow()
    expect(save).toHaveBeenCalledWith({ x: 5, y: 6, width: 1024, height: 768 })
  })

  it('拿不到窗口尺寸时不写（别把空值写进偏好）', () => {
    const save = vi.fn()
    const saver = createBoundsSaver({ getBounds: () => null, save })
    saver.saveNow()
    expect(save).not.toHaveBeenCalled()
  })

  it('写回偏好后能读回来（尺寸记忆真的生效）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    const saver = createBoundsSaver({
      getBounds: () => ({ x: 33, y: 44, width: 1024, height: 768 }),
      save: (bounds) => {
        prefs.write({ windowBounds: bounds })
      },
    })

    saver.saveNow()

    expect(prefs.read().windowBounds).toEqual({ x: 33, y: 44, width: 1024, height: 768 })
    // 下一次启动时按它摆窗口。
    expect(resolveWindowBounds(prefs.read().windowBounds, { width: 1200, height: 800 })).toEqual({
      width: 1024,
      height: 768,
      x: 33,
      y: 44,
    })
  })
})
