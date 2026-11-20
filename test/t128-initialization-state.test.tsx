// ---------------------------------------------------------------------------
// T128：服务端「初始化状态」端点 `/initialization/state`（组 C 第二项）
// ---------------------------------------------------------------------------
//
// 真机实测（2026-11-20，FN 中继 ＋ 真实 NAS，**只读 GET**）：
//   `GET /initialization/state` ⇒ `code=0`，`data = { initialized: true }`，
//   **data 只有这一个字段**，耗时 **174 ms**。
//   ⚠ **端点不存在时**（T119 记录的判据）HTTP 200 但 body = **`null`**
//      ⇒ `apiCall` 会因「响应不是预期信封」**抛错**（不是返回空对象）⇒ 必须**捕获**。
//
// ⭐ 语义证据（扒 NAS Web 前端包，**代码级证据**，非推测）：
//   - `entryRoute = initialized ? (currentUser ? '/' : '/login') : '/welcome'`
//     ⇒ **`initialized === false` ⇒ 路由到 `/welcome`（初始化引导页）**；
//   - 错误码表有 `AppNotInitialized`（「The app has not been initialized.」）、
//     `InitRequiresNASAdmin`（「初始化需要 NAS 管理员权限。」）。
//   ⇒ `initialized` ＝ **飞牛音乐这个「应用」有没有完成首次初始化**（扫库 / 建索引），
//      **不是**「NAS 有没有登录」⇒ 未初始化 ⇒ 搜索 / 建议 / 榜单全是空的。
//
// 本文件钉住 8 条：
//   ① API 打对端点、`true` 透传；
//   ② 响应里**没有** `initialized` ⇒ `null`（**不是 false**）；
//   ③ 端点抛错 ⇒ **不崩**，返回 `null`；
//   ④ store 的三态映射；
//   ⑤ 连接页：`false` ⇒ 显示「未初始化」提示 ＋ 事实项；
//   ⑥ 连接页：`true` ⇒ 显示「已初始化」，**不**显示未初始化提示；
//   ⑦ 搜索页空结果：`false` ⇒ 换文案；`true`/`null` ⇒ 仍是「没有找到」；
//   ⑧ **未知（`null`）⇒ 任何页面都不显示未初始化提示**。
//
// ⚠ 测试数据一律用占位值（「demo」「192.168.1.20:5666」…），不写真实 FN ID / 账号 / 口令。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Album, Artist, Playlist, Song } from '../shared/types'
import type { AuthSessionInfo } from '../shared/bridge'
import { initializationApi } from '../src/api/initialization'
import { LoginPage } from '../src/pages/LoginPage'
import { SearchPanel, type SearchPanelApi } from '../src/components/SearchPanel'
import { useSessionStore } from '../src/state/sessionStore'
import { useInitializationStore } from '../src/state/initializationStore'
import { createLibraryStore, type LibraryApi } from '../src/state/libraryStore'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** `window.sanlosAuth` 的替身（LoginPage 只需要 `restore` / `logout`）。 */
const bridge = {
  serverInfo: vi.fn(),
  login: vi.fn(),
  restore: vi.fn(),
  logout: vi.fn(),
  relogin: vi.fn(),
  probe: vi.fn(),
  connectionInfo: vi.fn(),
}

/** 已登录的脱敏会话。 */
const CONNECTED: AuthSessionInfo = {
  connected: true,
  mode: 'password',
  username: 'demo',
  serverLabel: '192.168.1.20:5666',
  isRelay: false,
}

/** 未登录的脱敏会话。 */
const DISCONNECTED: AuthSessionInfo = {
  connected: false,
  mode: null,
  username: null,
  serverLabel: null,
  isRelay: false,
}

/**
 * 装一个返回固定信封的 fetch 桩。
 *
 * ⚠ 端点不存在时服务端返回的是 **body = `null`**（不是空对象）⇒ 这里用
 *    `raw: 'null'` 模拟，**不能**用 `{ code: 0, data: {} }` 冒充。
 */
function stubEnvelopeFetch(raw: unknown): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    return new Response(text, { status: 200 })
  })
  return urls
}

/** 造一个假的曲库接口（组件只用到 `favorites`）。 */
function createFakeApi(): LibraryApi {
  return {
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as Artist[], total: 0 })),
    genres: vi.fn(async () => ({
      list: [] as { guid: string; name: string; coverId: string | null; trackCount: number }[],
      total: 0,
    })),
    favorites: vi.fn(async () => [] as Song[]),
    playlists: vi.fn(async () => [] as Playlist[]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    album: vi.fn(async () => null),
    albumSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    history: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
  }
}

/** 造一个空的搜索接口（结果全空 ⇒ 触发「没有找到」那条分支）。 */
function makeEmptySearchApi(): SearchPanelApi {
  return {
    query: vi.fn(async () => ({
      tracks: { list: [] as Song[], total: 0 },
      albums: { list: [] as Album[], total: 0 },
      artists: { list: [] as Artist[], total: 0 },
    })),
  }
}

/**
 * 在搜索框里打字。
 *
 * ⚠ 必须用 `fireEvent.change`（React **受控** input 直接赋值不会触发 `onChange`）。
 */
function typeKeyword(value: string): void {
  fireEvent.change(screen.getByLabelText('搜索关键字'), { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({
    session: DISCONNECTED,
    connection: null,
    candidates: [],
    restored: false,
  })
  // ⚠ T128：初始化状态**默认是「未知」**（`null`）⇒ 界面一个字都不显示。
  useInitializationStore.setState({ initialized: null, loaded: false, error: null })
  Object.assign(window, { sanlosAuth: bridge, sanlos: { platform: 'win32' } })
  bridge.restore.mockResolvedValue(CONNECTED)
  bridge.logout.mockResolvedValue(DISCONNECTED)
  bridge.relogin.mockResolvedValue(true)
  bridge.probe.mockResolvedValue([])
  bridge.connectionInfo.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// ①②③ API 层
// ---------------------------------------------------------------------------

describe('T128 API：initializationApi.state', () => {
  it('① 打 /initialization/state，服务端说已初始化 ⇒ true', async () => {
    const urls = stubEnvelopeFetch({ code: 0, msg: '', data: { initialized: true } })
    const result = await initializationApi.state()
    expect(urls).toEqual(['sanlos://srv/initialization/state'])
    expect(result).toBe(true)
  })

  it('② 响应里**没有** initialized ⇒ null（**不是 false**：缺失 ≠ 未初始化）', async () => {
    stubEnvelopeFetch({ code: 0, msg: '', data: {} })
    const result = await initializationApi.state()
    expect(result).toBeNull()
  })

  it('③ 端点抛错（老服务端没有这个端点 ⇒ body 是 null）⇒ **不崩**，返回 null', async () => {
    // ⚠ 真服务端「端点不存在」的形状：HTTP 200 + body = `null`。
    stubEnvelopeFetch('null')
    const result = await initializationApi.state()
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ④ store 的三态映射
// ---------------------------------------------------------------------------

describe('T128 store：初始化状态的三态', () => {
  it('④ 端点给 false / true / null ⇒ store 里分别落 false / true / null', async () => {
    await useInitializationStore.getState().load({ state: async () => false })
    expect(useInitializationStore.getState().initialized).toBe(false)
    expect(useInitializationStore.getState().loaded).toBe(true)

    await useInitializationStore.getState().load({ state: async () => true })
    expect(useInitializationStore.getState().initialized).toBe(true)

    await useInitializationStore.getState().load({ state: async () => null })
    expect(useInitializationStore.getState().initialized).toBeNull()
    expect(useInitializationStore.getState().loaded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ⑤⑥ 连接页（落点 A）
// ---------------------------------------------------------------------------

describe('T128 界面：连接页的服务端初始化状态', () => {
  it('⑤ 未初始化 ⇒ 事实项显示「未初始化」 ＋ 给出可行动的提示', async () => {
    // ⚠ **走 store 的 `load()`**（不是直接 `setState`）⇒ 这样「store 把未知当未初始化」
    //    这类缺陷也会被这条抓到（直接 setState 会**绕过** store ⇒ 抓不到）。
    await useInitializationStore.getState().load({ state: async () => false })
    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText('未初始化')).toBeTruthy()
    })
    // ⚠ 提示必须告诉用户**下一步做什么**（去飞牛音乐网页端完成初始化）。
    expect(screen.getByText(/飞牛音乐网页端/)).toBeTruthy()
  })

  it('⑥ 已初始化 ⇒ 显示「已初始化」，**不**显示未初始化提示', async () => {
    await useInitializationStore.getState().load({ state: async () => true })
    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText('已初始化')).toBeTruthy()
    })
    expect(screen.queryByText('未初始化')).toBeNull()
    expect(screen.queryByText(/飞牛音乐网页端/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ⑦⑧ 搜索页空结果（落点 B）
// ---------------------------------------------------------------------------

describe('T128 界面：搜索空结果时的提示', () => {
  it('⑦ 未初始化 ⇒ 空结果文案改成「服务端尚未初始化…」', async () => {
    useInitializationStore.setState({ initialized: false, loaded: true, error: null })
    const store = createLibraryStore(createFakeApi())
    render(<SearchPanel api={makeEmptySearchApi()} store={store} debounceMs={0} />)

    typeKeyword('甲')
    await waitFor(() => {
      expect(screen.getByText(/尚未初始化/)).toBeTruthy()
    })
    // ⚠ 未初始化时**不该**再显示「没有找到」（那会把用户引向错误方向）。
    expect(screen.queryByText('没有找到')).toBeNull()
  })

  it('⑧ 未知（null）⇒ **仍是「没有找到」**，任何页面都不显示未初始化提示', async () => {
    useInitializationStore.setState({ initialized: null, loaded: true, error: null })
    const store = createLibraryStore(createFakeApi())
    render(<SearchPanel api={makeEmptySearchApi()} store={store} debounceMs={0} />)

    typeKeyword('甲')
    await waitFor(() => {
      expect(screen.getByText('没有找到')).toBeTruthy()
    })
    expect(screen.queryByText(/尚未初始化/)).toBeNull()

    // 连接页同样**不许**出现未初始化提示。
    // ⚠ 这里**必须走 store 的 `load()`**（不是直接 `setState`）——
    //    否则「store 把『未知』当『未初始化』」这类缺陷**抓不到**（`setState` 绕过了 store）。
    await useInitializationStore.getState().load({ state: async () => null })
    render(<LoginPage />)
    await waitFor(() => {
      expect(screen.getByText('已连接')).toBeTruthy()
    })
    expect(screen.queryByText('未初始化')).toBeNull()
    expect(screen.queryByText(/尚未初始化/)).toBeNull()
    expect(screen.queryByText(/飞牛音乐网页端/)).toBeNull()
  })
})
