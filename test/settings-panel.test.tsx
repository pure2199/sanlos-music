// ---------------------------------------------------------------------------
// Task 8（新版清单）：设置面板（「关闭窗口时」的行为）
//
// 覆盖审计报表指出的「偏好有键无 UI」：
// - 面板按当前偏好**选中**对应选项；
// - 改选项 → **乐观应用** + 写回主进程（`prefs:set`）；
// - 写回失败 → **回滚**到原值并给出提示。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { AppPrefs, PlayerBridge } from '../shared/playerBridge'
import { SettingsPanel } from '../src/components/SettingsPanel'
import { useAppPrefsStore, DEFAULT_CLOSE_BEHAVIOR } from '../src/state/appPrefsStore'

/** 装一个假的 `window.fnPlayer`。 */
function installBridge(overrides: Partial<PlayerBridge> = {}): {
  setPrefs: ReturnType<typeof vi.fn>
} {
  const setPrefs = vi.fn(async (_patch: Partial<AppPrefs>) => ({}))
  const bridge = {
    getPrefs: vi.fn(async (): Promise<AppPrefs> => ({})),
    setPrefs,
    setTheme: vi.fn(async (): Promise<AppPrefs> => ({})),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    pushState: vi.fn(),
    sendCommand: vi.fn(),
    onCommand: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as PlayerBridge
  ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
  return { setPrefs }
}

beforeEach(() => {
  useAppPrefsStore.setState({
    theme: 'apple',
    closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
    error: null,
  })
})

afterEach(() => {
  delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
})

describe('设置面板', () => {
  it('默认选中「隐藏窗口（播放继续）」', () => {
    installBridge()
    render(<SettingsPanel />)

    const hide = screen.getByRole('radio', { name: '隐藏窗口（播放继续）' }) as HTMLInputElement
    const quit = screen.getByRole('radio', { name: '直接退出应用' }) as HTMLInputElement
    expect(hide.checked).toBe(true)
    expect(quit.checked).toBe(false)
  })

  it('选「直接退出应用」→ 立即生效并写回主进程', async () => {
    const { setPrefs } = installBridge()
    render(<SettingsPanel />)

    fireEvent.click(screen.getByRole('radio', { name: '直接退出应用' }))

    // 乐观应用：界面立刻变。
    expect(useAppPrefsStore.getState().closeBehavior).toBe('quit')
    await waitFor(() => expect(setPrefs).toHaveBeenCalledWith({ closeBehavior: 'quit' }))
  })

  it('写回失败 → 回滚到原设置并给出提示', async () => {
    installBridge({
      setPrefs: vi.fn(async () => Promise.reject(new Error('写盘失败'))),
    })
    render(<SettingsPanel />)

    fireEvent.click(screen.getByRole('radio', { name: '直接退出应用' }))

    await waitFor(() => expect(useAppPrefsStore.getState().closeBehavior).toBe('hide'))
    expect(useAppPrefsStore.getState().error).toContain('设置保存失败')
    expect(screen.getByRole('alert').textContent).toContain('设置保存失败')
    const hide = screen.getByRole('radio', { name: '隐藏窗口（播放继续）' }) as HTMLInputElement
    expect(hide.checked).toBe(true)
  })

  it('没有桥时不崩：设置只在本地生效', async () => {
    render(<SettingsPanel />)

    fireEvent.click(screen.getByRole('radio', { name: '直接退出应用' }))

    await waitFor(() => expect(useAppPrefsStore.getState().closeBehavior).toBe('quit'))
  })
})
