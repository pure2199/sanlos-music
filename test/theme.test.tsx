// ---------------------------------------------------------------------------
// Task 6（新版清单）：双主题落地
//
// 覆盖：
// - **渲染层**：`applyTheme` 写 `<html data-theme>`；store 从主进程读回、切换、写回、失败回滚；
// - **切换 UI**：`ThemeSwitcher` 点一下切到下一套主题；
// - **主进程**：`theme:set` 落盘后回调 `onTheme`（主进程据此换窗口底色）；
// - **样式表**：两套主题的变量覆盖**都在** `tokens.css` 里（防止有人删掉 Fluent 那份）。
//
// ⚠️ 测试里一律用占位数据，不写真实 FN ID / 账号 / 口令。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { DEFAULT_THEME, THEMES, resolveThemeName, themeSpec } from '../shared/themes'
import type { AppPrefs, PlayerBridge } from '../shared/playerBridge'
import { applyTheme, readAppliedTheme } from '../src/theme'
import { useAppPrefsStore } from '../src/state/appPrefsStore'
import { ThemeSwitcher } from '../src/components/ThemeSwitcher'
import { PrefsStore, registerPlayerIpc, type IpcMainEventsLike } from '../electron/ipc'

// ---------------------------------------------------------------------------
// 假桥
// ---------------------------------------------------------------------------

/** 装一个假的 `window.fnPlayer`。 */
function installBridge(overrides: Partial<PlayerBridge> = {}): {
  getPrefs: ReturnType<typeof vi.fn>
  setTheme: ReturnType<typeof vi.fn>
} {
  const getPrefs = vi.fn(async (): Promise<AppPrefs> => ({}))
  const setTheme = vi.fn(async (): Promise<AppPrefs> => ({}))
  const bridge = {
    getPrefs,
    setPrefs: vi.fn(async () => ({})),
    setTheme,
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    pushState: vi.fn(),
    sendCommand: vi.fn(),
    onCommand: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as PlayerBridge
  ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
  return { getPrefs, setTheme }
}

beforeEach(() => {
  useAppPrefsStore.setState({ theme: DEFAULT_THEME, error: null })
  delete document.documentElement.dataset['theme']
})

afterEach(() => {
  delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  delete document.documentElement.dataset['theme']
})

// ---------------------------------------------------------------------------
// 主题清单
// ---------------------------------------------------------------------------

describe('主题清单', () => {
  it('有两套主题：Apple 风与 Windows 11 风', () => {
    expect(THEMES.map((theme) => theme.name)).toEqual(['apple', 'fluent'])
  })

  it('不认识的主题名回落到默认主题', () => {
    expect(resolveThemeName('neon')).toBe(DEFAULT_THEME)
    expect(resolveThemeName(undefined)).toBe(DEFAULT_THEME)
    expect(themeSpec('neon').name).toBe(DEFAULT_THEME)
  })

  it('每套主题都有窗口底色（主进程用它避免白闪）', () => {
    for (const theme of THEMES) {
      expect(theme.windowBackground).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

// ---------------------------------------------------------------------------
// 渲染层应用
// ---------------------------------------------------------------------------

describe('主题在渲染层的应用', () => {
  it('applyTheme 写到 <html> 的 data-theme 上', () => {
    applyTheme('fluent')
    expect(document.documentElement.dataset['theme']).toBe('fluent')
  })

  it('非法主题名被归一成默认主题', () => {
    applyTheme('neon')
    expect(document.documentElement.dataset['theme']).toBe(DEFAULT_THEME)
  })

  it('readAppliedTheme 读回已应用的主题', () => {
    applyTheme('fluent')
    expect(readAppliedTheme()).toBe('fluent')
  })
})

// ---------------------------------------------------------------------------
// 主题 store
// ---------------------------------------------------------------------------

describe('主题 store（真相源在主进程）', () => {
  it('启动时从主进程读回主题并应用', async () => {
    installBridge({ getPrefs: vi.fn(async (): Promise<AppPrefs> => ({ theme: 'fluent' })) })

    await useAppPrefsStore.getState().load()

    expect(useAppPrefsStore.getState().theme).toBe('fluent')
    expect(document.documentElement.dataset['theme']).toBe('fluent')
  })

  it('主进程没存主题时用默认主题', async () => {
    installBridge({ getPrefs: vi.fn(async () => ({})) })

    await useAppPrefsStore.getState().load()

    expect(useAppPrefsStore.getState().theme).toBe(DEFAULT_THEME)
  })

  it('切换主题：立即应用并写回主进程', async () => {
    const { setTheme } = installBridge()

    await useAppPrefsStore.getState().setTheme('fluent')

    expect(document.documentElement.dataset['theme']).toBe('fluent')
    expect(useAppPrefsStore.getState().theme).toBe('fluent')
    expect(setTheme).toHaveBeenCalledWith('fluent')
  })

  it('写回失败 → 回滚到原主题并给出提示', async () => {
    installBridge({ setTheme: vi.fn(async () => Promise.reject(new Error('写盘失败'))) })
    await useAppPrefsStore.getState().setTheme('fluent')

    await useAppPrefsStore.getState().setTheme('apple')

    expect(useAppPrefsStore.getState().theme).toBe('apple')
    expect(document.documentElement.dataset['theme']).toBe('apple')
    expect(useAppPrefsStore.getState().error).toContain('主题保存失败')
  })

  it('没有桥时不崩：只在本地生效', async () => {
    await expect(useAppPrefsStore.getState().load()).resolves.toBeUndefined()
    await expect(useAppPrefsStore.getState().setTheme('fluent')).resolves.toBeUndefined()
    expect(document.documentElement.dataset['theme']).toBe('fluent')
  })
})

// ---------------------------------------------------------------------------
// 切换 UI
// ---------------------------------------------------------------------------

describe('ThemeSwitcher', () => {
  it('显示当前主题名，点一下切到下一套', async () => {
    const { setTheme } = installBridge()
    render(<ThemeSwitcher />)

    const button = screen.getByRole('button', { name: '切换主题' })
    expect(button.textContent).toBe(themeSpec(DEFAULT_THEME).label)

    fireEvent.click(button)

    await waitFor(() => expect(setTheme).toHaveBeenCalledWith('fluent'))
    await waitFor(() => expect(button.textContent).toBe(themeSpec('fluent').label))
  })
})

// ---------------------------------------------------------------------------
// 主进程：主题落盘后通知
// ---------------------------------------------------------------------------

describe('主进程：theme:set 落盘后回调 onTheme', () => {
  /** 造一个能记下 handler 的 `ipcMain` 替身。 */
  function fakeIpcMain(): {
    ipcMain: IpcMainEventsLike
    handlers: Map<string, (event: unknown, arg: unknown) => unknown>
  } {
    const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, arg: unknown) => unknown) => {
        handlers.set(channel, handler)
      },
      on: () => undefined,
    } as unknown as IpcMainEventsLike
    return { ipcMain, handlers }
  }

  it('切主题 → 回调收到新主题名', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const onTheme = vi.fn()
    // ⚠️ 偏好文件必须落在**临时目录**里——写进仓库会留下垃圾文件。
    const dir = mkdtempSync(join(tmpdir(), 'fnmusic-theme-'))
    const prefs = new PrefsStore({ filePath: join(dir, 'prefs.json') })
    try {
      registerPlayerIpc({ ipcMain, prefs, onTheme })

      await handlers.get('theme:set')?.(undefined, 'fluent')

      expect(onTheme).toHaveBeenCalledWith('fluent')
      expect(prefs.read().theme).toBe('fluent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 样式表：两套主题的变量覆盖都在
// ---------------------------------------------------------------------------

describe('样式表：双主题变量', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'tokens.css'), 'utf8')

  it('有 Fluent 的变量覆盖块', () => {
    expect(css).toContain("[data-theme='fluent']")
  })

  it('两套主题都定义了同一组语义变量（不多不少）', () => {
    // ⚠️ 按**规则选择器**定位（`:root {` / `[data-theme='fluent'] {`）——
    //    只找名字会命中文件头的注释块。
    const appleBlock = css.slice(css.indexOf(':root {'), css.indexOf("[data-theme='fluent'] {"))
    const fluentBlock = css.slice(css.indexOf("[data-theme='fluent'] {"))
    const names = (block: string): string[] =>
      [...block.matchAll(/--[a-z-]+(?=\s*:)/g)].map((match) => match[0]).sort()

    const apple = names(appleBlock)
    const fluent = names(fluentBlock)
    expect(apple.length).toBeGreaterThan(10)
    // 每一组变量都必须**两套都有**（否则某套主题下会漏掉某个语义变量）。
    expect(fluent).toEqual(apple)
  })

  it('圆角也走令牌（两套主题形状不同）', () => {
    expect(css).toContain('--radius-pill')
    expect(css).toContain('--radius-panel')
    expect(css).toContain('--radius-card')
  })
})
