// ---------------------------------------------------------------------------
// Task 10b：登录界面与连接链路指示器
//
// 覆盖简报「追加要求 J」点名的 9 条（每条都有断言，不是「渲染不崩」）：
// 1. 两种模式都能渲染、且能互相切换；
// 2. 地址模式提交后调用了 `serverInfo` 且**参数正确**；
// 3. `serverInfo` 失败时错误信息出现在界面上；
// 4. FN ID 模式提交后调用了 `probe` 且**参数正确**；候选列表被渲染出来；
// 5. 选中一个候选后，登录调用里的 `server` 等于该候选的 `address`；
// 6. 密码模式登录成功 → 进入已连接状态；失败 → 错误可见；
// 7. NAS 模式 → 捕获「尚未安装 NAS 账号登录处理器」并显示可读提示（**不是**原始错误串）；
// 8. **密码不进 store**（断言 store 与 localStorage 里都没有任何密码字段/值）；
// 9. ConnectionBadge：`kind` 为 `relay` 时展示中继带宽提示；非中继时不展示。
//
// 另外覆盖简报 Step 4 / 追加要求 D / E / F / H：
// - 候选的「不可达」与「可达但有备注」必须区分（D）；
// - 密码只存在于组件本地 state（E）；
// - `restore()` 启动时只调一次（F）；
// - Badge 展开后展示最近一次 `probe()` 的全部候选（H）。
//
// ⚠️ 测试里一律使用占位符（example-fn-id / demo / pw），**不写真实 FN ID / 账号 / 口令**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { LoginPage } from '../src/pages/LoginPage'
import { ConnectionBadge } from '../src/components/ConnectionBadge'
import { useSessionStore } from '../src/state/sessionStore'
import { useSettingsStore } from '../src/state/settingsStore'
import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT } from '../shared/constants'
import type { AuthSessionInfo, CandidateInfo, ServerInfo } from '../shared/bridge'
import type { ConnectionInfo } from '../shared/types'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** `window.fn` 的七个方法的替身。 */
const bridge = {
  serverInfo: vi.fn(),
  login: vi.fn(),
  restore: vi.fn(),
  logout: vi.fn(),
  relogin: vi.fn(),
  probe: vi.fn(),
  connectionInfo: vi.fn(),
}

/** 未登录时的脱敏会话形态。 */
const DISCONNECTED: AuthSessionInfo = {
  connected: false,
  mode: null,
  username: null,
  serverLabel: null,
  isRelay: false,
}

/** 一条内网候选（可达）。 */
const LAN_CANDIDATE: CandidateInfo = {
  address: 'http://192.168.1.20:5666',
  label: '内网 IPv4',
  kind: 'lan',
  isRelay: false,
  ok: true,
}

/** 一条中继候选（不可达 + 失败原因）。 */
const RELAY_CANDIDATE: CandidateInfo = {
  address: 'https://example-fn-id.fnos.net',
  label: 'FN 中继',
  kind: 'relay',
  isRelay: true,
  ok: false,
  error: '连接超时',
}

/** 递归收集对象里的所有键名（用于「store 里没有密码字段」这条断言）。 */
function collectKeys(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value !== 'object' || value === null) return []
  if (seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectKeys(item, seen))
  }
  const record = value as Record<string, unknown>
  return Object.keys(record).flatMap((key) => [key, ...collectKeys(record[key], seen)])
}

beforeEach(() => {
  vi.clearAllMocks()
  // ⚠️ T38：会话恢复收敛进 `sessionStore` → `restored` 是**模块级**状态，
  //    每个用例开头必须复位，否则第二个用例起 `restore()` 会被直接跳过
  //    （断言「只调用一次」会变成假绿）。
  useSessionStore.setState({
    session: DISCONNECTED,
    connection: null,
    candidates: [],
    restored: false,
  })
  Object.assign(window, { fn: bridge, fnmusic: { platform: 'win32' } })

  bridge.restore.mockResolvedValue(DISCONNECTED)
  bridge.serverInfo.mockResolvedValue({
    serverName: null,
    serverVersion: null,
    supportsNasLogin: false,
  } satisfies ServerInfo)
  bridge.login.mockResolvedValue({
    connected: true,
    mode: 'password',
    username: 'demo',
    serverLabel: '192.168.1.20:5666',
    isRelay: false,
  } satisfies AuthSessionInfo)
  bridge.logout.mockResolvedValue(DISCONNECTED)
  bridge.relogin.mockResolvedValue(true)
  bridge.probe.mockResolvedValue([] satisfies CandidateInfo[])
  bridge.connectionInfo.mockResolvedValue(null satisfies ConnectionInfo | null)

  useSessionStore.getState().reset()
  useSettingsStore.setState({ lastServer: '', theme: 'apple' })
  window.localStorage.clear()
})

// ---------------------------------------------------------------------------
// 渲染与模式切换
// ---------------------------------------------------------------------------

describe('LoginPage 渲染与模式切换', () => {
  it('渲染地址输入与两种登录方式', () => {
    render(<LoginPage />)
    expect(screen.getByPlaceholderText(/NAS 地址|FN ID/)).toBeTruthy()
    expect(screen.getByText(/独立账号/)).toBeTruthy()
    expect(screen.getByText(/NAS 账号/)).toBeTruthy()
  })

  it('地址输入框的默认值带协议与默认端口（端口取自共享常量）', () => {
    render(<LoginPage />)
    const input = screen.getByPlaceholderText(/NAS 地址/) as HTMLInputElement
    expect(input.value).toBe(`http://192.168.1.2:${DEFAULT_HTTP_PORT}`)
    expect(input.value).toContain('http://')
  })

  it('可以在直接地址与 FN ID 两种模式之间互相切换', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.click(screen.getByRole('button', { name: 'FN ID' }))
    expect(screen.getByPlaceholderText(/FN ID/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/NAS 地址/)).toBeNull()

    await user.click(screen.getByRole('button', { name: '直接地址' }))
    expect(screen.getByPlaceholderText(/NAS 地址/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/FN ID/)).toBeNull()
  })

  it('两种登录方式（独立账号 / NAS 账号）可以互相切换', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    // 独立账号：显示账号与密码输入框
    expect(screen.getByLabelText('账号')).toBeTruthy()
    expect(screen.getByLabelText('密码')).toBeTruthy()

    // NAS 账号：走 OAuth，不需要账号口令
    await user.click(screen.getByRole('radio', { name: 'NAS 账号' }))
    expect(screen.queryByLabelText('账号')).toBeNull()
    expect(screen.queryByLabelText('密码')).toBeNull()

    await user.click(screen.getByRole('radio', { name: '独立账号' }))
    expect(screen.getByLabelText('账号')).toBeTruthy()
    expect(screen.getByLabelText('密码')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 地址模式
// ---------------------------------------------------------------------------

describe('LoginPage 地址模式', () => {
  it('提交后调用 serverInfo 且参数正确', async () => {
    const user = userEvent.setup()
    bridge.serverInfo.mockResolvedValue({
      serverName: '纯音乐',
      serverVersion: '1.0.10',
      supportsNasLogin: true,
    } satisfies ServerInfo)

    render(<LoginPage />)
    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, 'http://192.168.1.10:5666')
    await user.click(screen.getByRole('button', { name: '检测服务器' }))

    await waitFor(() => expect(bridge.serverInfo).toHaveBeenCalledTimes(1))
    expect(bridge.serverInfo).toHaveBeenCalledWith('http://192.168.1.10:5666')
  })

  it('检测成功后展示服务器名称、版本与 NAS 账号登录支持情况', async () => {
    const user = userEvent.setup()
    bridge.serverInfo.mockResolvedValue({
      serverName: '纯音乐',
      serverVersion: '1.0.10',
      supportsNasLogin: true,
    } satisfies ServerInfo)

    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: '检测服务器' }))

    expect(await screen.findByText('纯音乐')).toBeTruthy()
    expect(screen.getByText('1.0.10')).toBeTruthy()
    expect(screen.getByText('支持')).toBeTruthy()
    expect(screen.queryByText('不支持')).toBeNull()
  })

  it('serverInfo 失败时错误信息出现在界面上', async () => {
    const user = userEvent.setup()
    // ⚠️ 用**真实的 IPC 形状**：`ipcRenderer.invoke` 拒绝时的 message 形如
    //    `Error invoking remote method 'auth:server-info': Error: 服务器响应异常（HTTP 500）`。
    //    界面应该显示**剥掉技术前缀后**的可读文案。
    bridge.serverInfo.mockRejectedValue(
      new Error(
        "Error invoking remote method 'auth:server-info': Error: 服务器响应异常（HTTP 500）",
      ),
    )

    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: '检测服务器' }))

    expect(await screen.findByText('服务器响应异常（HTTP 500）')).toBeTruthy()
    // Electron 的技术前缀不该出现在界面上
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 默认端口补全（简报 I.6 · 控制器 2026-11-03 更正）
//
// `normalizeBase`（`electron/connection.ts`）**只补协议与 `/music` 路径，不补端口**——
// 用户只填 `192.168.1.10` 时请求会打到 80 端口，而 fnOS 音乐服务在 5666 / 5667。
// 渲染进程侧必须在交给 `serverInfo()` / `login()` 之前补默认端口；
// **显式写了端口的地址必须原样保留**。
// ---------------------------------------------------------------------------

describe('默认端口补全', () => {
  it('只填 host → 补 http 默认端口（DEFAULT_HTTP_PORT）', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, '192.168.1.10')
    await user.click(screen.getByRole('button', { name: '检测服务器' }))

    await waitFor(() => expect(bridge.serverInfo).toHaveBeenCalledTimes(1))
    expect(bridge.serverInfo).toHaveBeenCalledWith(`http://192.168.1.10:${DEFAULT_HTTP_PORT}`)
  })

  it('https 地址 → 补 https 默认端口（DEFAULT_HTTPS_PORT）', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, 'https://192.168.1.10')
    await user.click(screen.getByRole('button', { name: '检测服务器' }))

    await waitFor(() => expect(bridge.serverInfo).toHaveBeenCalledTimes(1))
    expect(bridge.serverInfo).toHaveBeenCalledWith(
      `https://192.168.1.10:${DEFAULT_HTTPS_PORT}`,
    )
  })

  it('显式端口原样保留（不改写成默认端口）', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, '192.168.1.10:1234')
    await user.click(screen.getByRole('button', { name: '检测服务器' }))

    await waitFor(() => expect(bridge.serverInfo).toHaveBeenCalledTimes(1))
    expect(bridge.serverInfo).toHaveBeenCalledWith('192.168.1.10:1234')
    expect(bridge.serverInfo).not.toHaveBeenCalledWith(
      `http://192.168.1.10:${DEFAULT_HTTP_PORT}`,
    )
  })

  it('显式 :80 原样保留（钉住「URL 会把默认端口规范化掉」的坑）', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, 'http://192.168.1.10:80')
    await user.click(screen.getByRole('button', { name: '检测服务器' }))

    await waitFor(() => expect(bridge.serverInfo).toHaveBeenCalledTimes(1))
    // ⚠️ 鉴别力：若实现改用 `new URL(x).port` 判断端口，`:80` 会被 URL 规范化成空串
    //    → 这里会被补成 5666，断言就会失败。
    expect(bridge.serverInfo).toHaveBeenCalledWith('http://192.168.1.10:80')
  })

  it('登录时也用补完端口的地址', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, '192.168.1.10')
    await user.type(screen.getByLabelText('账号'), 'demo')
    await user.type(screen.getByLabelText('密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1))
    expect(bridge.login).toHaveBeenCalledWith({
      server: `http://192.168.1.10:${DEFAULT_HTTP_PORT}`,
      username: 'demo',
      password: 'pw',
      mode: 'password',
    })
  })

  it('候选链路地址原样使用（不补默认端口）', async () => {
    const user = userEvent.setup()
    // 候选地址**没有端口**（中继走 443，补 5667 会打错端口）。
    const candidate: CandidateInfo = {
      address: 'https://example-fn-id.fnos.net',
      label: 'FN 中继',
      kind: 'relay',
      isRelay: true,
      ok: true,
    }
    bridge.probe.mockResolvedValue([candidate])

    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: 'FN ID' }))
    await user.type(screen.getByPlaceholderText(/FN ID/), 'example-fn-id')
    await user.click(screen.getByRole('button', { name: '探测链路' }))
    await user.click(await screen.findByRole('button', { name: /FN 中继/ }))

    await user.type(screen.getByLabelText('账号'), 'demo')
    await user.type(screen.getByLabelText('密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1))
    expect(bridge.login).toHaveBeenCalledWith({
      server: candidate.address,
      username: 'demo',
      password: 'pw',
      mode: 'password',
    })
  })
})

// ---------------------------------------------------------------------------
// FN ID 模式
// ---------------------------------------------------------------------------

describe('LoginPage FN ID 模式', () => {
  it('提交后调用 probe 且参数正确，并渲染候选列表', async () => {
    const user = userEvent.setup()
    bridge.probe.mockResolvedValue([LAN_CANDIDATE, RELAY_CANDIDATE])

    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: 'FN ID' }))
    await user.type(screen.getByPlaceholderText(/FN ID/), 'example-fn-id')
    await user.click(screen.getByRole('button', { name: '探测链路' }))

    await waitFor(() => expect(bridge.probe).toHaveBeenCalledTimes(1))
    expect(bridge.probe).toHaveBeenCalledWith('example-fn-id')

    // 候选的 label / kind / ok / error 都要在界面上
    expect(await screen.findByText('内网 IPv4')).toBeTruthy()
    expect(screen.getByText('FN 中继')).toBeTruthy()
    expect(screen.getByText('内网直连')).toBeTruthy()
    expect(screen.getByText('不可达')).toBeTruthy()
    expect(screen.getByText('连接超时')).toBeTruthy()
  })

  it('区分「不可达」与「可达但有备注」（追加要求 D）', async () => {
    const user = userEvent.setup()
    bridge.probe.mockResolvedValue([
      { ...LAN_CANDIDATE, ok: true, error: 'token 已失效' },
      { ...RELAY_CANDIDATE, ok: false, error: '连接超时' },
    ])

    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: 'FN ID' }))
    await user.type(screen.getByPlaceholderText(/FN ID/), 'example-fn-id')
    await user.click(screen.getByRole('button', { name: '探测链路' }))

    const note = await screen.findByText('token 已失效')
    expect(note.getAttribute('data-status')).toBe('note')

    const unreachable = screen.getByText('连接超时')
    expect(unreachable.getAttribute('data-status')).toBe('unreachable')

    // 可达的候选标注为「可达」，不可达的标注为「不可达」
    expect(screen.getByText('可达')).toBeTruthy()
    expect(screen.getByText('不可达')).toBeTruthy()
  })

  it('不可达的候选依然可以被选中', async () => {
    const user = userEvent.setup()
    bridge.probe.mockResolvedValue([RELAY_CANDIDATE])

    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: 'FN ID' }))
    await user.type(screen.getByPlaceholderText(/FN ID/), 'example-fn-id')
    await user.click(screen.getByRole('button', { name: '探测链路' }))

    const candidate = await screen.findByRole('button', { name: /FN 中继/ })
    await user.click(candidate)
    expect(candidate.getAttribute('aria-pressed')).toBe('true')
  })

  it('选中一个候选后，登录调用里的 server 等于该候选的 address', async () => {
    const user = userEvent.setup()
    bridge.probe.mockResolvedValue([LAN_CANDIDATE])

    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: 'FN ID' }))
    await user.type(screen.getByPlaceholderText(/FN ID/), 'example-fn-id')
    await user.click(screen.getByRole('button', { name: '探测链路' }))
    await user.click(await screen.findByRole('button', { name: /内网 IPv4/ }))

    await user.type(screen.getByLabelText('账号'), 'demo')
    await user.type(screen.getByLabelText('密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1))
    expect(bridge.login).toHaveBeenCalledWith({
      server: LAN_CANDIDATE.address,
      username: 'demo',
      password: 'pw',
      mode: 'password',
    })
  })
})

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

describe('LoginPage 登录', () => {
  it('密码模式登录成功 → 进入已连接状态', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.type(screen.getByLabelText('账号'), 'demo')
    await user.type(screen.getByLabelText('密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('已连接')).toBeTruthy()
    expect(screen.getByText('192.168.1.20:5666')).toBeTruthy()
    expect(screen.getByText('demo')).toBeTruthy()
    // 会话状态落到 store（脱敏，不含 token / 口令）
    expect(useSessionStore.getState().session.connected).toBe(true)
    expect(useSessionStore.getState().session.username).toBe('demo')
  })

  it('密码模式登录失败 → 错误可见', async () => {
    const user = userEvent.setup()
    bridge.login.mockRejectedValue(new Error('账号或密码不正确'))

    render(<LoginPage />)
    await user.type(screen.getByLabelText('账号'), 'demo')
    await user.type(screen.getByLabelText('密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('账号或密码不正确')).toBeTruthy()
    expect(screen.queryByText('已连接')).toBeNull()
  })

  it('NAS 模式登录用空账号口令，且 mode 为 nas', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.click(screen.getByRole('radio', { name: 'NAS 账号' }))
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1))
    expect(bridge.login).toHaveBeenCalledWith({
      server: `http://192.168.1.2:${DEFAULT_HTTP_PORT}`,
      username: '',
      password: '',
      mode: 'nas',
    })
  })

  it('NAS 模式捕获「尚未安装 NAS 账号登录处理器」并显示可读提示', async () => {
    const user = userEvent.setup()
    bridge.login.mockRejectedValue(
      new Error(
        "Error invoking remote method 'auth:login': Error: 尚未安装 NAS 账号登录处理器",
      ),
    )

    render(<LoginPage />)
    await user.click(screen.getByRole('radio', { name: 'NAS 账号' }))
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText(/NAS 账号授权登录将在下一版本开放/)).toBeTruthy()
    // **不是**原始技术错误串
    expect(screen.queryByText(/尚未安装 NAS 账号登录处理器/)).toBeNull()
    expect(screen.queryByText('已连接')).toBeNull()
  })

  it('登录成功后立刻清空密码框', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const password = screen.getByLabelText('密码') as HTMLInputElement
    await user.type(screen.getByLabelText('账号'), 'demo')
    await user.type(password, 'pw')
    expect(password.value).toBe('pw')

    await user.click(screen.getByRole('button', { name: '登录' }))
    await screen.findByText('已连接')

    expect(password.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 凭证边界（追加要求 E）
// ---------------------------------------------------------------------------

describe('凭证边界', () => {
  it('密码不进 store、不进 localStorage、不进 URL', async () => {
    const user = userEvent.setup()
    const secret = 'pw-should-never-persist'
    render(<LoginPage />)

    await user.type(screen.getByLabelText('账号'), 'demo')
    await user.type(screen.getByLabelText('密码'), secret)
    await user.click(screen.getByRole('button', { name: '登录' }))
    await screen.findByText('已连接')

    const sessionDump = JSON.stringify(useSessionStore.getState())
    const settingsDump = JSON.stringify(useSettingsStore.getState())

    expect(sessionDump).not.toContain(secret)
    expect(settingsDump).not.toContain(secret)
    expect(window.location.href).not.toContain(secret)

    // ⚠️ 断言必须打在**真实内容**上（复审 I-2）：
    //    垫片与 jsdom 对齐后 `localStorage.getItem()` 拿到的是**真存进去的字符串**；
    //    并且要先断言「偏好确实落盘了」——否则 `not.toContain` 是**空洞断言**
    //    （旧版垫片是普通对象字面量，JSON.stringify 只得到 {"length":N}）。
    const persisted = window.localStorage.getItem('fnmusic-settings')
    expect(persisted).not.toBeNull()
    expect(persisted).toContain('lastServer')
    expect(persisted).not.toContain(secret)
    // 整包序列化也必须看不到口令（垫片与 jsdom 一样暴露命名属性）
    const storageDump = JSON.stringify(window.localStorage)
    expect(storageDump).toContain('fnmusic-settings')
    expect(storageDump).not.toContain(secret)

    // store 里**没有任何**凭证类字段名
    const sensitive = /pass|pwd|secret|token|credential|cookie/i
    expect(collectKeys(useSessionStore.getState()).filter((k) => sensitive.test(k))).toEqual([])
    expect(collectKeys(useSettingsStore.getState()).filter((k) => sensitive.test(k))).toEqual([])

    // session store 里只有脱敏的会话字段
    expect(Object.keys(useSessionStore.getState().session).sort()).toEqual([
      'connected',
      'isRelay',
      'mode',
      'serverLabel',
      'username',
    ])
  })

  it('写进偏好存储的地址会去掉 userinfo（不把口令落盘）', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, 'http://demo:pw@192.168.1.10:5666')
    await user.click(screen.getByRole('button', { name: '检测服务器' }))
    await waitFor(() => expect(bridge.serverInfo).toHaveBeenCalledTimes(1))

    // 传给主进程的仍是用户原样填的地址（主进程自己的 normalizeBase 会丢弃 userinfo）
    expect(bridge.serverInfo).toHaveBeenCalledWith('http://demo:pw@192.168.1.10:5666')
    // 但**落盘**的偏好里不能带 userinfo
    expect(useSettingsStore.getState().lastServer).toBe('http://192.168.1.10:5666')
    const persisted = window.localStorage.getItem('fnmusic-settings')
    expect(persisted).not.toBeNull()
    expect(persisted).not.toContain('pw@')
  })

  it('「无协议 + 显式端口」的地址同样剥掉 userinfo（复审 I-1）', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    // ⚠️ 复审实测的漏点：userinfo 与**有没有协议无关**。
    //    只锚定 `scheme://` 的剥除写法在这里会漏，口令会原样进 localStorage。
    const input = screen.getByPlaceholderText(/NAS 地址/)
    await user.clear(input)
    await user.type(input, 'demo:pw@192.168.1.10:5666')
    await user.click(screen.getByRole('button', { name: '检测服务器' }))
    await waitFor(() => expect(bridge.serverInfo).toHaveBeenCalledTimes(1))

    // 传给主进程的仍是用户原样填的地址
    expect(bridge.serverInfo).toHaveBeenCalledWith('demo:pw@192.168.1.10:5666')
    // 但**落盘**的偏好里绝不能带 userinfo
    expect(useSettingsStore.getState().lastServer).toBe('192.168.1.10:5666')
    const persisted = window.localStorage.getItem('fnmusic-settings')
    expect(persisted).not.toBeNull()
    expect(persisted).toContain('192.168.1.10:5666')
    expect(persisted).not.toContain('pw')
    expect(persisted).not.toContain('@')
    // 整包序列化必须能看到**真实内容**（垫片与 jsdom 对齐）——
    // 否则上面那些 not.toContain 就是空洞断言（复审 I-2 的老坑）。
    const dump = JSON.stringify(window.localStorage)
    expect(dump).toContain('fnmusic-settings')
    expect(dump).not.toContain('pw@')
  })
})

// ---------------------------------------------------------------------------
// restore 少调（追加要求 F）
// ---------------------------------------------------------------------------

describe('会话恢复', () => {
  it('启动时只调用一次 restore()', async () => {
    // ⚠️ 必须带 StrictMode：真实应用走 `src/main.tsx` 的 `<StrictMode>`，
    //    React 18 会把 effect 跑两遍 —— `restoreStarted` ref 守卫就是靠它承重的
    //    （不守卫 → restore() 调 2 次 → 世代号 +2 → 作废在飞行的静默续期，
    //    正是追加要求 F 要防的坑）。
    //    不带 StrictMode 的话，删掉守卫这条用例仍然会绿 → 零鉴别力。
    render(
      <StrictMode>
        <LoginPage />
      </StrictMode>,
    )
    await waitFor(() => expect(bridge.restore).toHaveBeenCalled())
    expect(bridge.restore).toHaveBeenCalledTimes(1)
  })

  it('restore 出来的是已登录会话时进入已连接状态', async () => {
    bridge.restore.mockResolvedValue({
      connected: true,
      mode: 'password',
      username: 'demo',
      serverLabel: '192.168.1.20:5666',
      isRelay: false,
    } satisfies AuthSessionInfo)

    render(<LoginPage />)
    expect(await screen.findByText('已连接')).toBeTruthy()
    expect(bridge.login).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ConnectionBadge（追加要求 H / J）
// ---------------------------------------------------------------------------

describe('ConnectionBadge', () => {
  it('中继链路展示主进程给的带宽提示（不展示兜底长句）', async () => {
    bridge.connectionInfo.mockResolvedValue({
      kind: 'relay',
      url: 'https://example-fn-id.fnos.net/music',
      label: 'FN 中继',
      isRelay: true,
      // 用一个与兜底文案**不同**的探针值：本用例要证明的是
      // 「主进程给的值优先，兜底文案不出现」，而不是碰巧文案相同。
      bandwidthHint: '主进程自定义带宽提示',
    } satisfies ConnectionInfo)

    render(<ConnectionBadge />)

    expect(await screen.findByText('主进程自定义带宽提示')).toBeTruthy()
    expect(screen.queryByText(/0.5–4 Mbps/)).toBeNull()
  })

  it('主进程给的中继带宽提示按原文展示（与 electron/ipc.ts 的文案一致）', async () => {
    bridge.connectionInfo.mockResolvedValue({
      kind: 'relay',
      url: 'https://example-fn-id.fnos.net/music',
      label: 'FN 中继',
      isRelay: true,
      bandwidthHint:
        '中继带宽受限（约 0.5–4 Mbps），无损与下载建议在局域网内进行',
    } satisfies ConnectionInfo)

    render(<ConnectionBadge />)

    expect(await screen.findByText(/中继带宽受限（约 0\.5–4 Mbps）/)).toBeTruthy()
  })

  it('中继链路没有带宽提示时展示兜底文案', async () => {
    bridge.connectionInfo.mockResolvedValue({
      kind: 'relay',
      url: 'https://example-fn-id.fnos.net/music',
      label: 'FN 中继',
      isRelay: true,
    } satisfies ConnectionInfo)

    render(<ConnectionBadge />)

    expect(await screen.findByText(/0.5–4 Mbps/)).toBeTruthy()
  })

  it('非中继链路展示链路类型且不展示带宽提示', async () => {
    bridge.connectionInfo.mockResolvedValue({
      kind: 'lan',
      url: 'http://192.168.1.20:5666/music',
      label: '内网直连',
      isRelay: false,
    } satisfies ConnectionInfo)

    render(<ConnectionBadge />)

    expect(await screen.findByText('内网直连')).toBeTruthy()
    expect(screen.queryByText(/0.5–4 Mbps/)).toBeNull()
    expect(screen.queryByText('带宽受限')).toBeNull()
  })

  it('点击展开最近一次 probe 的全部候选', async () => {
    useSessionStore.getState().setCandidates([LAN_CANDIDATE, RELAY_CANDIDATE])

    const user = userEvent.setup()
    render(<ConnectionBadge />)

    await user.click(screen.getByRole('button', { name: '未连接' }))

    expect(await screen.findByText('内网 IPv4')).toBeTruthy()
    expect(screen.getByText('FN 中继')).toBeTruthy()
    expect(screen.getByText('http://192.168.1.20:5666')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 会话失效的说明（T19-3）
// ---------------------------------------------------------------------------

describe('LoginPage 会话失效说明', () => {
  it('notice 属性 → 显示说明（role=status）', async () => {
    render(<LoginPage notice="登录已失效，请重新登录。" />)

    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain('登录已失效，请重新登录。')
    // ⚠️ 说明**不是**错误：不该同时冒出 role="alert" 的错误位。
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('没有 notice 时不渲染说明位', async () => {
    render(<LoginPage />)
    await screen.findByRole('button', { name: '登录' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('sessionLost → **不调 restore()**（不把死 token 读回来又显示「已连接」）', async () => {
    // ⚠️ 鉴别力：restore() 恢复出一个**已连接**会话 → 若实现仍然 restore，
    //    界面会显示「已连接」，用户根本看不到登录表单。
    bridge.restore.mockResolvedValue({
      connected: true,
      mode: 'password',
      username: 'demo',
      serverLabel: '192.168.1.20:5666',
      isRelay: false,
    } satisfies AuthSessionInfo)

    render(<LoginPage notice="登录已失效，请重新登录。" sessionLost />)

    // 登录表单必须在
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy()
    expect(screen.queryByText('已连接')).toBeNull()
    // ⚠️ 而且**根本没去恢复**那个已经失效的会话
    expect(bridge.restore).not.toHaveBeenCalled()
  })
})
