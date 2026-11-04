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

import { describe, it, expect, vi, beforeEach } from 'vitest'
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

  it('左侧有**五个**分类：通用 / 歌词 / 下载 / 解码 / 更新', () => {
    render(<SettingsPanel />)

    const labels = within(nav())
      .getAllByRole('button')
      .map((button) => button.textContent?.trim() ?? '')
    expect(labels).toEqual(['通用', '歌词', '下载', '解码', '更新'])
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
