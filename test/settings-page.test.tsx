// ---------------------------------------------------------------------------
// T35：设置页 = **主区里的整页**（左侧分类 + 右侧内容）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这组测试**：T35 之前，设置是**顶栏下拉的 294px 浮层**：
//    说明文字折成 2～4 行、示例 URL 被截断、下半截掉到视口外、还盖住顶栏。
//    用户 2026-11-05 反馈「设置页做得不对」→ 改成了整页。
//    ⇒ 这里钉的是**改造后的结构契约**：分类导航、默认分类、一次只显示一类、
//    关闭回调、以及「偏好写回失败时错误横幅不许被藏起来」。
//
// ⚠️ **只钉结构，不钉数据**：偏好键、IPC、草稿/保存语义一字没动
//    （那部分由 `settings-panel.test.tsx` / `settings-lyric-source.test.tsx` 钉）。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import { SettingsPanel } from '../src/components/SettingsPanel'
import { useAppPrefsStore, DEFAULT_CLOSE_BEHAVIOR } from '../src/state/appPrefsStore'

beforeEach(() => {
  useAppPrefsStore.setState({
    theme: 'apple',
    closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
    lyricOverlayVisible: true,
    error: null,
  })
})

/** 左侧分类导航。 */
function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: '设置分类' })
}

/** 点左侧某个分类。 */
function pickCategory(label: string): void {
  fireEvent.click(within(nav()).getByRole('button', { name: label }))
}

describe('设置页：整页结构（T35）', () => {
  it('根节点是 **region**（不再是 dialog）且可访问名是「设置」', () => {
    render(<SettingsPanel />)

    // ⚠️ 旧浮层是 `role="dialog"` → 现在是主区里的一个**区域**。
    expect(screen.getByRole('region', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
  })

  it('左侧有**六个**分类：通用 / 歌词 / 下载 / 解码 / 更新 / 关于', () => {
    render(<SettingsPanel />)

    const labels = within(nav())
      .getAllByRole('button')
      .map((button) => button.textContent?.trim() ?? '')
    // ⚠️ T41：**前提被用户显式推翻**（要加软件信息）→ 分类从 5 个变 6 个，
    //    这条断言**改写为新行为**（仍逐项精确，不是放宽）。
    expect(labels).toEqual(['通用', '歌词', '下载', '解码', '更新', '关于'])
  })

  it('默认停在「通用」，且**只有当前分类**的内容在显示', () => {
    render(<SettingsPanel />)

    // 当前项用 `aria-current="page"` 标出（屏幕阅读器靠它播报）。
    const current = within(nav())
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]?.textContent?.trim()).toBe('通用')

    // 「关闭窗口时」在，「歌词来源」不在。
    expect(screen.getByRole('group', { name: '关闭窗口时' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: '歌词来源' })).toBeNull()
  })

  it('点「歌词」→ 只显示「歌词来源」那一组', () => {
    render(<SettingsPanel />)

    pickCategory('歌词')

    expect(screen.getByRole('group', { name: '歌词来源' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: '关闭窗口时' })).toBeNull()
  })

  it('点「下载」→ 只显示「本地下载」那一组', () => {
    render(<SettingsPanel />)

    pickCategory('下载')

    expect(screen.getByRole('group', { name: '本地下载' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: '歌词来源' })).toBeNull()
  })

  it('点「解码」→ 只显示「FFmpeg 兜底解码」那一组', () => {
    render(<SettingsPanel />)

    pickCategory('解码')

    expect(screen.getByRole('group', { name: 'FFmpeg 兜底解码' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: '自动更新' })).toBeNull()
  })

  it('点「更新」→ 只显示「自动更新」那一组', () => {
    render(<SettingsPanel />)

    pickCategory('更新')

    expect(screen.getByRole('group', { name: '自动更新' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: '关闭窗口时' })).toBeNull()
  })

  it('切分类**不会**把内容堆在一起（旧浮层是六组全在一屏里）', () => {
    render(<SettingsPanel />)

    pickCategory('歌词')
    pickCategory('下载')

    // 此刻只有「本地下载」这一组在场。
    expect(screen.getAllByRole('group')).toHaveLength(1)
  })

  it('传了 `onClose` → 有「关闭设置」按钮，点击会回调', () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)

    const close = within(nav()).getByRole('button', { name: '关闭设置' })
    fireEvent.click(close)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('没传 `onClose` → **没有**「关闭设置」按钮（单测里独立渲染时不留死按钮）', () => {
    render(<SettingsPanel />)

    expect(within(nav()).queryByRole('button', { name: '关闭设置' })).toBeNull()
  })

  it('偏好写回失败 → **错误横幅在任何分类下都看得见**（不许被分类藏起来）', () => {
    useAppPrefsStore.setState({ error: '设置保存失败：写盘失败' })
    render(<SettingsPanel />)

    expect(screen.getByRole('alert').textContent).toContain('写盘失败')

    // 切到别的分类 → 横幅**仍然**在（它渲染在内容区顶部，不属于任何一个分类）。
    pickCategory('歌词')
    expect(screen.getByRole('alert').textContent).toContain('写盘失败')
  })
})

// ---------------------------------------------------------------------------
// T41：「关于」分类（软件信息）
// ---------------------------------------------------------------------------

describe('设置页：「关于」分类（T41）', () => {
  /** 装一个假的播放器桥（只关心 `openExternal`）。 */
  function stubBridge(): { openExternal: ReturnType<typeof vi.fn> } {
    const openExternal = vi.fn().mockResolvedValue(true)
    ;(globalThis as unknown as { fnPlayer?: unknown }).fnPlayer = { openExternal }
    return { openExternal }
  }

  afterEach(() => {
    delete (globalThis as unknown as { fnPlayer?: unknown }).fnPlayer
  })

  it('点「关于」→ 显示开发者 / 公司 / 官网 / 备案号', () => {
    render(<SettingsPanel />)

    pickCategory('关于')

    expect(screen.getByRole('group', { name: '关于' })).toBeTruthy()
    expect(screen.getByTestId('app-about-developer').textContent).toBe('pure2199')
    expect(screen.getByTestId('app-about-company').textContent).toBe('广西闪链时空网络科技有限公司')
    expect(screen.getByTestId('app-about-icp').textContent).toBe('桂ICP备202507161号-1')
    // 官网：文字就是那个地址。
    expect(screen.getByRole('link', { name: 'https://www.sanlos.cn' })).toBeTruthy()
  })

  it('点官网 → **请主进程**用系统浏览器打开（不在应用内跳转）', () => {
    const { openExternal } = stubBridge()
    render(<SettingsPanel />)

    pickCategory('关于')
    const link = screen.getByRole('link', { name: 'https://www.sanlos.cn' })

    // ⚠️ 关键：链接**不许**真的把应用窗口导航走
    //    （主窗口没配 `setWindowOpenHandler`）→ 必须 `preventDefault`。
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://www.sanlos.cn')
  })

  it('没有桥（浏览器预览 / 单测）→ 点官网**不炸**，也不导航', () => {
    render(<SettingsPanel />)

    pickCategory('关于')
    const link = screen.getByRole('link', { name: 'https://www.sanlos.cn' })

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    expect(() => link.dispatchEvent(event)).not.toThrow()
    expect(event.defaultPrevented).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T45：桌面歌词**样式**二选一（经典悬浮窗 / 灵动态词岛）
// ---------------------------------------------------------------------------

describe('设置页：桌面歌词样式二选一（T45）', () => {
  /** 真实的 setter（用例会临时替换它，结束后必须复位）。 */
  const realSetMode = useAppPrefsStore.getState().setLyricOverlayMode

  beforeEach(() => {
    useAppPrefsStore.setState({
      lyricOverlayMode: 'classic',
      setLyricOverlayMode: realSetMode,
    })
  })

  afterEach(() => {
    useAppPrefsStore.setState({ setLyricOverlayMode: realSetMode })
  })

  it('「歌词」分类下有「桌面歌词样式」：两个单选（经典悬浮窗 / 灵动态词岛）', () => {
    render(<SettingsPanel />)
    pickCategory('歌词')

    const group = screen.getByRole('group', { name: '桌面歌词样式' })
    const classic = within(group).getByRole('radio', { name: '经典悬浮窗' })
    const island = within(group).getByRole('radio', { name: '灵动态词岛' })
    expect((classic as HTMLInputElement).checked).toBe(true)
    expect((island as HTMLInputElement).checked).toBe(false)
  })

  it('当前是词岛 → 选中项是「灵动态词岛」', () => {
    useAppPrefsStore.setState({ lyricOverlayMode: 'island' })
    render(<SettingsPanel />)
    pickCategory('歌词')

    const island = screen.getByRole('radio', { name: '灵动态词岛' }) as HTMLInputElement
    expect(island.checked).toBe(true)
  })

  it('选中「灵动态词岛」→ 交给 store 的 setter（主进程去换窗口）', () => {
    const setLyricOverlayMode = vi.fn()
    useAppPrefsStore.setState({ setLyricOverlayMode })
    render(<SettingsPanel />)
    pickCategory('歌词')

    fireEvent.click(screen.getByRole('radio', { name: '灵动态词岛' }))
    expect(setLyricOverlayMode).toHaveBeenCalledWith('island')
  })
})
