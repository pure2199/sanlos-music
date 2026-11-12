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
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'

import { SettingsPanel } from '../src/components/SettingsPanel'
import { useAppPrefsStore, DEFAULT_CLOSE_BEHAVIOR } from '../src/state/appPrefsStore'
import { useUpdateStore } from '../src/state/updateStore'
import type { UpdateCheckResult, UpdateDownloadResult } from '../shared/update'
import { APP_INFO } from '../shared/appInfo'

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

// ---------------------------------------------------------------------------
// T82：版本号 / 项目地址 / 自动更新从项目拉取
// ---------------------------------------------------------------------------

describe('设置页：版本号 / 项目地址 / 更新源（T82）', () => {
  /** 装一个假的播放器桥（版本号 + 外部链接 + 偏好读写）。 */
  function stubBridge(): {
    openExternal: ReturnType<typeof vi.fn>
    getAppVersion: ReturnType<typeof vi.fn>
    setPrefs: ReturnType<typeof vi.fn>
  } {
    const openExternal = vi.fn().mockResolvedValue(true)
    const getAppVersion = vi.fn().mockResolvedValue('0.2.1')
    const setPrefs = vi.fn().mockResolvedValue({})
    ;(globalThis as unknown as { fnPlayer?: unknown }).fnPlayer = {
      openExternal,
      getAppVersion,
      getPrefs: vi.fn().mockResolvedValue({}),
      setPrefs,
    }
    return { openExternal, getAppVersion, setPrefs }
  }

  afterEach(() => {
    delete (globalThis as unknown as { fnPlayer?: unknown }).fnPlayer
  })

  it('「关于」→ 显示**版本号**（主进程给的）', async () => {
    stubBridge()
    render(<SettingsPanel />)

    pickCategory('关于')

    await waitFor(() => {
      expect(screen.getByTestId('app-about-version').textContent).toBe('v0.2.1')
    })
  })

  it('「关于」→ 显示**项目地址**，点它请主进程用系统浏览器打开', async () => {
    const { openExternal } = stubBridge()
    render(<SettingsPanel />)

    pickCategory('关于')
    const link = screen.getByTestId('app-about-repository')
    expect(link.textContent).toBe(APP_INFO.repository)

    // ⚠️ 关键：链接**不许**把应用窗口导航走 → 必须 `preventDefault`。
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(APP_INFO.repository)
  })

  it('「更新」→ 显示**当前版本**与「用项目地址」按钮', async () => {
    stubBridge()
    render(<SettingsPanel />)

    pickCategory('更新')

    await waitFor(() => {
      expect(screen.getByTestId('update-current-version').textContent).toContain('v0.2.1')
    })
    expect(screen.getByTestId('update-use-project-source')).toBeTruthy()
  })

  it('「用项目地址」→ 把**项目地址**填进更新源并保存', async () => {
    const { setPrefs } = stubBridge()
    render(<SettingsPanel />)

    pickCategory('更新')
    fireEvent.click(screen.getByTestId('update-use-project-source'))

    await waitFor(() => {
      expect(setPrefs).toHaveBeenCalled()
    })
    expect(setPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ baseUrl: APP_INFO.updateBaseUrl }),
      }),
    )
  })

  it('「允许安装未签名的更新包」→ **默认不勾**（本项目暂未签名）', async () => {
    stubBridge()
    render(<SettingsPanel />)

    pickCategory('更新')

    await waitFor(() => {
      expect(screen.getByTestId('update-allow-unsigned')).toBeTruthy()
    })
    expect((screen.getByTestId('update-allow-unsigned') as HTMLInputElement).checked).toBe(false)
  })

  it('勾上「允许安装未签名的更新包」→ 写进偏好', async () => {
    const { setPrefs } = stubBridge()
    render(<SettingsPanel />)

    pickCategory('更新')
    fireEvent.click(screen.getByTestId('update-allow-unsigned'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(setPrefs).toHaveBeenCalled()
    })
    expect(setPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ allowUnsigned: true }),
      }),
    )
  })

  // -------------------------------------------------------------------------
  // T87.17：未签名产物的「怎么验证」说明
  // -------------------------------------------------------------------------
  //
  // ⚠️ **背景**：公开产物长期没有 Authenticode 签名（SignPath 申请已被拒）
  //    ⇒ 「发布者身份」改由 GitHub attestation（SLSA build provenance）承担
  //    ⇒ 客户端必须把「怎么验」讲清楚，而不是让用户面对一句「未知发布者」干瞪眼。
  //
  // ⚠️ **纪律**：既有断言一条不删、一条不削弱；本节只**追加**。

  describe('T87.17 —— 未签名产物的验证说明', () => {
    it('更新组说明「当前发布的安装包没有代码签名」', async () => {
      stubBridge()
      render(<SettingsPanel />)

      pickCategory('更新')

      await waitFor(() => {
        expect(screen.getByTestId('update-verify-hint')).toBeTruthy()
      })
      const hint = screen.getByTestId('update-verify-hint').textContent ?? ''
      expect(hint).toContain('没有代码签名')
      expect(hint).toContain('未知发布者')
    })

    it('给出**两种验证办法**（构建来源证明 + sha256）', async () => {
      stubBridge()
      render(<SettingsPanel />)

      pickCategory('更新')

      await waitFor(() => {
        expect(screen.getByTestId('update-verify-howto')).toBeTruthy()
      })
      const howto = screen.getByTestId('update-verify-howto').textContent ?? ''
      expect(howto).toContain('怎么验证这个安装包')
      expect(howto).toContain('gh attestation verify')
      expect(howto).toContain('sha256')
    })

    it('⚠️ **不写**「本项目暂未办理代码签名证书」这种**会过期**的项目状态', async () => {
      // ⚠️ 拿到公开证书后那句话就是假的 ⇒ 只描述**产物**的状态，不描述项目状态。
      stubBridge()
      render(<SettingsPanel />)

      pickCategory('更新')

      await waitFor(() => {
        expect(screen.getByTestId('update-verify-hint')).toBeTruthy()
      })
      const text = document.body.textContent ?? ''
      expect(text).not.toContain('本项目暂未办理代码签名证书')
    })
  })
})

// ---------------------------------------------------------------------------
// T85：更新组的「启动安装」按钮 + 文案
// ---------------------------------------------------------------------------
//
// ⚠️ T85 的事故 = 渲染层那两道拦截（store 提前 return + 按钮 disabled）
//    把「允许安装未签名的更新包」**彻底堵死**，且**一条报错都没有**。
//    ⇒ 这里钉住：按钮的启用条件用**已保存**的授权（不是草稿），
//    判定与主进程**同一口径**；文案**不许**再自相矛盾。
// ---------------------------------------------------------------------------

describe('设置页：自动更新的签名闸（T85）', () => {
  /** 一份「检查到了新版本」的结果。 */
  const AVAILABLE: UpdateCheckResult = {
    status: 'available',
    current: '0.2.1',
    manifest: {
      version: '0.2.2',
      releasedAt: '2026-11-04T00:00:00.000Z',
      notes: '占位说明',
      files: [
        {
          name: 'FN-Music-Setup-0.2.2.exe',
          url: 'FN-Music-Setup-0.2.2.exe',
          sha512: 'a'.repeat(128),
          size: 1024,
        },
      ],
    },
    file: {
      name: 'FN-Music-Setup-0.2.2.exe',
      url: 'FN-Music-Setup-0.2.2.exe',
      sha512: 'a'.repeat(128),
      size: 1024,
    },
  }

  /** 一份「下载好了、且**没有**签名」的安装包。 */
  const UNSIGNED: UpdateDownloadResult = {
    status: 'ok',
    path: 'C:\\Temp\\FN-Music-Setup-0.2.2.exe',
    // ⚠️ **T87.12**：主进程连同落盘用的**文件名**一起给渲染层。
    name: 'FN-Music-Setup-0.2.2.exe',
    bytes: 1024,
    sha512Ok: true,
    signature: { ok: false, status: 'NotSigned', signer: null, reason: '安装包没有 Authenticode 签名' },
  }

  /** 摆好 store（检查结果 + 已下载的包）。 */
  function seedUpdateStore(download: UpdateDownloadResult | null): void {
    useUpdateStore.setState({
      result: AVAILABLE,
      download,
      status: 'checked',
      error: null,
      allowUnsigned: false,
      allowUnsignedDraft: false,
      expectedSigner: '',
      signerDraft: '',
    })
  }

  /** 假桥（`getPrefs` 按给定偏好返回）。 */
  function stubPrefs(allowUnsigned: boolean): void {
    ;(globalThis as unknown as { fnPlayer?: unknown }).fnPlayer = {
      getAppVersion: vi.fn().mockResolvedValue('0.2.1'),
      getPrefs: vi.fn().mockResolvedValue({ update: { allowUnsigned } }),
      setPrefs: vi.fn().mockResolvedValue({}),
    }
  }

  beforeEach(() => {
    useUpdateStore.setState({
      result: null,
      download: null,
      status: 'idle',
      error: null,
      allowUnsigned: false,
      allowUnsignedDraft: false,
    })
  })

  afterEach(() => {
    delete (globalThis as unknown as { fnPlayer?: unknown }).fnPlayer
  })

  it('未签名包 + **已保存**了授权 → 「启动安装」**可点**（T85 的核心）', async () => {
    stubPrefs(true)
    seedUpdateStore(UNSIGNED)
    render(<SettingsPanel />)

    pickCategory('更新')
    const button = await screen.findByRole('button', { name: '启动安装' })

    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('未签名包 + 只勾了**没保存** → 按钮**仍不可点**（并提示要先保存）', async () => {
    stubPrefs(false)
    seedUpdateStore(UNSIGNED)
    render(<SettingsPanel />)

    pickCategory('更新')
    const button = await screen.findByRole('button', { name: '启动安装' })
    // 等 `load()` 把「已保存 = false」灌进来。
    await waitFor(() => {
      expect((screen.getByTestId('update-allow-unsigned') as HTMLInputElement).checked).toBe(false)
    })
    fireEvent.click(screen.getByTestId('update-allow-unsigned'))

    // ⚠️ 草稿还没生效 ⇒ 主进程读到的还是「没授权」⇒ 按钮必须仍不可点。
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('update-unsaved-hint')).toBeTruthy()
  })

  it('未签名包 + **没授权** → 按钮不可点', async () => {
    stubPrefs(false)
    seedUpdateStore(UNSIGNED)
    render(<SettingsPanel />)

    pickCategory('更新')
    const button = await screen.findByRole('button', { name: '启动安装' })

    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it('文案**不再**自相矛盾（旧那句「未配置预期签名者时只允许下载」已删）', async () => {
    stubPrefs(false)
    render(<SettingsPanel />)

    pickCategory('更新')
    await waitFor(() => {
      expect(screen.getByTestId('update-allow-unsigned')).toBeTruthy()
    })

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('未配置预期签名者时只允许下载')
    expect(text).toContain('允许安装未签名的更新包')
    expect(text).toContain('没填预期签名者就一律拒绝')
  })

  it('T87：「预期的代码签名者」支持**多个候选**，并写明本项目的签发者', async () => {
    stubPrefs(false)
    render(<SettingsPanel />)

    pickCategory('更新')
    await waitFor(() => {
      expect(screen.getByTestId('update-allow-unsigned')).toBeTruthy()
    })

    const text = document.body.textContent ?? ''
    // ① 可填多个（换证书只改配置、不改客户端）
    expect(text).toContain('多个')
    expect(text).toContain('逗号')
    // ② 写明本项目公开产物的签发者（SignPath Foundation）
    expect(text).toContain('SignPath Foundation')
    // ⚠️ 旧文案「本项目暂未办理代码签名证书」在拿到公开证书后就是**错的** ⇒ 必须删掉
    expect(text).not.toContain('本项目暂未办理代码签名证书')
  })
})
