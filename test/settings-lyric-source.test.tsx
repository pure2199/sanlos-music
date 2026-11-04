// ---------------------------------------------------------------------------
// T32：设置面板（「歌词来源」）
// ---------------------------------------------------------------------------
//
// 钉的是「用户能自己换歌词 API」这条用户诉求：
// - 面板按当前偏好**选中**对应源；
// - 选「自定义」→ **模板输入框可用**（否则选了也没地方填）；
// - 点「保存」→ 写回主进程（`prefs:set` 的 `lyric` 键）；
// - 写回失败 → **回滚**到原值并给出提示（与既有偏好同一套纪律）。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import type { AppPrefs, PlayerBridge } from '../shared/playerBridge'
import { DEFAULT_LYRIC_SOURCE } from '../shared/lyricProvider'
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

/** 取「外部歌词源」下拉框。 */
function sourceSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: '外部歌词源' }) as HTMLSelectElement
}

/** 取「自定义歌词 API 模板」输入框。 */
function templateInput(): HTMLInputElement {
  return screen.getByRole('textbox', { name: '自定义歌词 API 模板' }) as HTMLInputElement
}

/**
 * 取「歌词来源」这一组里的「保存歌词源」按钮。
 *
 * ⚠️ **必须限定作用域 + 用专属名字**：面板里还有「自动更新」那一组，
 *    它有一个也叫「保存」的按钮 → 不限定就会「找到多个元素」。
 */
function saveButton(): HTMLButtonElement {
  const group = screen.getByRole('group', { name: '歌词来源' })
  return within(group).getByRole('button', { name: '保存歌词源' }) as HTMLButtonElement
}

/**
 * 渲染设置页并**切到「歌词」分类**（T35）。
 *
 * ⚠️ 设置页改成了「左侧分类 + 右侧内容」（T35）→ 「歌词来源」那一组
 *    **默认不渲染**（默认停在「通用」）→ 用例要先点左侧的「歌词」。
 *    ⚠️ **断言一条没改**，只多这一步操作。
 */
function renderLyricSettings(): void {
  render(<SettingsPanel />)
  fireEvent.click(screen.getByRole('button', { name: '歌词' }))
}

beforeEach(() => {
  useAppPrefsStore.setState({
    theme: 'apple',
    closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
    lyricSource: DEFAULT_LYRIC_SOURCE,
    lyricTemplate: '',
    error: null,
  })
})

afterEach(() => {
  delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
})

describe('设置面板：歌词来源', () => {
  it('渲染出「歌词来源」这一组，且**默认选中内置源**', () => {
    installBridge()
    renderLyricSettings()

    expect(screen.getByText('歌词来源')).toBeTruthy()
    expect(sourceSelect().value).toBe(DEFAULT_LYRIC_SOURCE)
    expect(DEFAULT_LYRIC_SOURCE).toBe('netease')
  })

  // ⚠️ **前提已被推翻**（T33：用户批准新增「QQ 音乐」内置源）→ 本断言改写为**新行为**。
  //    旧断言是 `['netease', 'lrclib', 'custom', 'off']`（四个选项）。
  it('**五个**选项都在（网易云 / lrclib / **QQ 音乐** / 自定义 / 不用外部）', () => {
    installBridge()
    renderLyricSettings()

    const values = Array.from(sourceSelect().options).map((option) => option.value)
    expect(values).toEqual(['netease', 'lrclib', 'qq', 'custom', 'off'])
  })

  it('选「QQ 音乐」→ **模板输入框仍禁用**（只有自定义才要填模板）', () => {
    installBridge()
    renderLyricSettings()

    fireEvent.change(sourceSelect(), { target: { value: 'qq' } })

    expect(templateInput().disabled).toBe(true)
  })

  it('选「QQ 音乐」→ 保存 → 写回 `source: "qq"`', async () => {
    const { setPrefs } = installBridge()
    renderLyricSettings()

    fireEvent.change(sourceSelect(), { target: { value: 'qq' } })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(setPrefs).toHaveBeenCalledWith({ lyric: { source: 'qq', template: '' } }),
    )
    expect(useAppPrefsStore.getState().lyricSource).toBe('qq')
  })

  it('没选「自定义」时 → **模板输入框是禁用的**（选了也没地方填）', () => {
    installBridge()
    renderLyricSettings()

    expect(templateInput().disabled).toBe(true)
  })

  it('选「自定义」→ 模板输入框**可用**', () => {
    installBridge()
    renderLyricSettings()

    fireEvent.change(sourceSelect(), { target: { value: 'custom' } })

    expect(templateInput().disabled).toBe(false)
  })

  it('改源 + 填模板 → 点「保存」→ **写回主进程**（lyric 键）', async () => {
    const { setPrefs } = installBridge()
    renderLyricSettings()

    fireEvent.change(sourceSelect(), { target: { value: 'custom' } })
    fireEvent.change(templateInput(), {
      target: { value: 'https://example.com/lyric?title={title}&artist={artist}' },
    })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(setPrefs).toHaveBeenCalledWith({
        lyric: {
          source: 'custom',
          template: 'https://example.com/lyric?title={title}&artist={artist}',
        },
      }),
    )
    // 乐观应用：界面上的状态也变了。
    expect(useAppPrefsStore.getState().lyricSource).toBe('custom')
  })

  it('只换源、不填模板 → 也能保存（模板保持原值）', async () => {
    const { setPrefs } = installBridge()
    useAppPrefsStore.setState({ lyricTemplate: 'https://example.com/{title}' })
    renderLyricSettings()

    fireEvent.change(sourceSelect(), { target: { value: 'off' } })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(setPrefs).toHaveBeenCalledWith({
        lyric: { source: 'off', template: 'https://example.com/{title}' },
      }),
    )
  })

  it('写回失败 → **回滚**到原设置并给出提示', async () => {
    installBridge({
      setPrefs: vi.fn(async () => Promise.reject(new Error('写盘失败'))),
    })
    renderLyricSettings()

    fireEvent.change(sourceSelect(), { target: { value: 'off' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(useAppPrefsStore.getState().lyricSource).toBe(DEFAULT_LYRIC_SOURCE))
    expect(useAppPrefsStore.getState().error).toContain('歌词源设置保存失败')
    expect(screen.getByRole('alert').textContent).toContain('歌词源设置保存失败')
  })

  it('没有改动时「保存」按钮**禁用**（别让用户空点）', () => {
    installBridge()
    renderLyricSettings()

    expect((saveButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('没有桥时不崩：设置只在本地生效', async () => {
    renderLyricSettings()

    fireEvent.change(sourceSelect(), { target: { value: 'off' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(useAppPrefsStore.getState().lyricSource).toBe('off'))
  })
})
