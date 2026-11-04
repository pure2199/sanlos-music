// ---------------------------------------------------------------------------
// 会话失效（token 续期失败）→ 回登录页（T19-3，规格 §5.4）
// ---------------------------------------------------------------------------
//
// 背景：主进程在收到业务码 **99999** 时会**先静默续期一次**再重试；
// 只有**续期也失败**（口令改了 / 中继不通）时，99999 才会**透到渲染进程**。
// 这时必须按规格 §5.4「派发 `auth-lost` 事件回到登录页」处理，
// 否则用户会卡在「已登录、但每个请求都失败」的死状态里，
// 而且只能自己点「连接 → 退出登录」才能脱身。
//
// ⚠️ 这条链路此前**整条都不存在**：全仓库只有规格文档里出现过 `auth-lost` 这个名字，
//    `src/` 与 `electron/` 里**没有任何**地方检查 99999，
//    `sessionStore.reset()` 也没有任何调用点。
//
// ---------------------------------------------------------------------------
// 覆盖
// ---------------------------------------------------------------------------
// 1. API 层：99999 → 通知「会话失效」；错误消息是**人话**而不是服务端的「INVALID TOKEN」；
// 2. API 层：**同一段**失效只通知一次（并发请求不会重复触发）；
// 3. API 层：一次**成功**之后重新武装（下一段失效照常通知）；
// 4. API 层：其它业务码**不**触发；
// 5. 外壳层：收到失效 → 清会话 + 调 `logout()` + 切回连接页 + 提示「登录已失效」。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

import App from '../src/App'
import { apiCall, onAuthLost } from '../src/api/client'
import { useSessionStore } from '../src/state/sessionStore'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 记录外壳调过哪些桥方法；`hang.logout` 让 logout 永远不返回（模拟中继不通）。 */
const { bridgeCalls, hang } = vi.hoisted(() => ({
  bridgeCalls: [] as string[],
  hang: { logout: false },
}))

vi.mock('../src/lib/bridge', () => ({
  getBridge: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop: string) => {
        // 订阅类方法要返回**退订函数**（React effect 的 cleanup）。
        if (prop.startsWith('on')) return () => undefined
        // ⚠️ `hang.logout` 时 logout **永远不 resolve**（模拟中继不通 / 服务端无响应）。
        if (prop === 'logout' && hang.logout) {
          return () => new Promise<void>(() => undefined)
        }
        return async () => {
          bridgeCalls.push(prop)
          return undefined
        }
      },
    }),
}))

// 叶子页面全部打桩（与 `test/app-routing.test.tsx` 同款）——
// 本文件只关心「外壳怎么响应会话失效」，不关心各页的数据加载。
vi.mock('../src/pages/LoginPage', () => ({
  LoginPage: ({ notice, sessionLost }: { notice?: string; sessionLost?: boolean }) => (
    <div
      data-testid="view-connect"
      data-notice={notice ?? ''}
      data-session-lost={sessionLost ? '1' : ''}
    >
      连接页
    </div>
  ),
}))
vi.mock('../src/pages/SearchPage', () => ({
  SearchPage: () => <div data-testid="view-search">搜索页</div>,
}))
vi.mock('../src/pages/SongsPage', () => ({
  SongsPage: () => <div data-testid="view-songs">歌曲页</div>,
}))
vi.mock('../src/pages/FavoritesPage', () => ({
  FavoritesPage: () => <div data-testid="view-favorites">收藏页</div>,
}))
vi.mock('../src/pages/PlaylistsPage', () => ({
  PlaylistsPage: () => <div data-testid="view-playlists">歌单页</div>,
}))
vi.mock('../src/pages/AlbumsPage', () => ({
  AlbumsPage: () => <div data-testid="view-albums">专辑页</div>,
}))
vi.mock('../src/pages/ArtistsPage', () => ({
  ArtistsPage: () => <div data-testid="view-artists">歌手页</div>,
}))
vi.mock('../src/pages/GenresPage', () => ({
  GenresPage: () => <div data-testid="view-genres">风格页</div>,
}))
vi.mock('../src/pages/HistoryPage', () => ({
  HistoryPage: () => <div data-testid="view-history">最近页</div>,
}))
vi.mock('../src/pages/DetailPage', () => ({
  DetailPage: () => <div data-testid="view-detail">详情页</div>,
}))
vi.mock('../src/pages/FullPlayerPage', () => ({
  FullPlayerPage: () => <div data-testid="view-full-player">全屏播放</div>,
}))

/** 让 `fetch` 返回一个业务信封。 */
function stubEnvelope(code: number, msg = ''): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ code, msg, data: {} }), { status: 200 })),
  )
}

// ---------------------------------------------------------------------------
// API 层
// ---------------------------------------------------------------------------

describe('会话失效通知（API 层）', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals()
    // 一次**成功**的请求 → 重新武装「会话失效」通知
    //（模块级状态跨用例保持，用公开行为复位，不开后门）。
    stubEnvelope(0)
    await apiCall('health')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('业务码 99999 → 通知「会话失效」，且错误消息是**人话**', async () => {
    const seen: number[] = []
    const off = onAuthLost(() => seen.push(1))

    stubEnvelope(99999, 'INVALID TOKEN')
    // ⚠️ 服务端给的是英文的「INVALID TOKEN」——渲染层要换成用户看得懂的话。
    await expect(apiCall('track/list')).rejects.toThrow('登录已失效，请重新登录')
    expect(seen).toHaveLength(1)

    off()
  })

  it('同一段失效**只通知一次**（并发请求不会重复触发）', async () => {
    const seen: number[] = []
    const off = onAuthLost(() => seen.push(1))

    stubEnvelope(99999, 'INVALID TOKEN')
    await Promise.all([
      apiCall('track/list').catch(() => undefined),
      apiCall('album/list').catch(() => undefined),
      apiCall('favorite-track/list').catch(() => undefined),
    ])

    // ⚠️ 失效期间往往有多个并发请求同时拿到 99999；
    //    逐个通知会让上层重复清会话、重复切页。
    expect(seen).toHaveLength(1)

    off()
  })

  it('一次**成功**之后 → 下一段失效会重新通知', async () => {
    const seen: number[] = []
    const off = onAuthLost(() => seen.push(1))

    stubEnvelope(99999, 'INVALID TOKEN')
    await apiCall('track/list').catch(() => undefined)
    expect(seen).toHaveLength(1)

    // 会话又可用了（成功一次）→ 重新武装
    stubEnvelope(0)
    await apiCall('track/list')

    stubEnvelope(99999, 'INVALID TOKEN')
    await apiCall('track/list').catch(() => undefined)
    expect(seen).toHaveLength(2)

    off()
  })

  it('其它业务码**不**触发', async () => {
    const seen: number[] = []
    const off = onAuthLost(() => seen.push(1))

    stubEnvelope(100002, 'invalid arguments')
    await expect(apiCall('track/list')).rejects.toThrow('invalid arguments')
    expect(seen).toHaveLength(0)

    off()
  })
})

// ---------------------------------------------------------------------------
// 外壳层
// ---------------------------------------------------------------------------

describe('会话失效 → 回登录页（外壳层）', () => {
  beforeEach(async () => {
    bridgeCalls.length = 0
    hang.logout = false
    useSessionStore.setState({
      session: {
        connected: true,
        mode: 'password',
        username: 'demo',
        serverLabel: 'example',
        isRelay: false,
      },
      connection: null,
      candidates: [],
    })
    // ⚠️ 「会话失效」的去重标志是**模块级**的（同一段失效只通知一次），
    //    跨用例保持 → 每个用例开头先来一次**成功**请求把它重新武装，
    //    否则第二个用例里的 99999 会被上一段失效「吃掉」，测试就成了假绿。
    stubEnvelope(0)
    await apiCall('health')
  })

  it('清会话 + 调 logout + 切回连接页 + 提示「登录已失效」', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('歌曲'))
    expect(screen.getByTestId('view-songs')).toBeTruthy()

    stubEnvelope(99999, 'INVALID TOKEN')
    await act(async () => {
      await apiCall('track/list').catch(() => undefined)
    })

    await waitFor(() => {
      expect(screen.getByTestId('view-connect')).toBeTruthy()
    })
    // ⚠️ 提示文案必须说清楚「发生了什么、下一步做什么」。
    expect(screen.getByTestId('view-connect').getAttribute('data-notice')).toBe('登录已失效，请重新登录。')
    // ⚠️ 登录页必须知道「会话已经死了」→ 跳过 restore()，
    //    否则会把 session.bin 里那个失效 token 读回来，界面又显示成「已连接」。
    expect(screen.getByTestId('view-connect').getAttribute('data-session-lost')).toBe('1')
    // ⚠️ 主进程里那个已经没用的 token 要清掉（否则下次启动又恢复成「已连接」）。
    //    ⚠️ 这一步是**后台**做的（不能挡住「立刻回登录页」），所以用 waitFor 等它落地。
    await waitFor(() => {
      expect(bridgeCalls).toContain('logout')
    })
    expect(useSessionStore.getState().session.connected).toBe(false)
  })

  it('「立刻回登录页」**不等** logout() 返回（网络挂住也不能卡住用户）', async () => {
    // ⚠️ 鉴别力：logout 永远不 resolve（模拟中继不通 / 服务端无响应）。
    //    若实现写成「先 await logout 再切视图」，这里就会**永远等不到**连接页 → 超时失败。
    hang.logout = true
    try {
      render(<App />)
      fireEvent.click(screen.getByText('歌曲'))
      expect(screen.getByTestId('view-songs')).toBeTruthy()

      stubEnvelope(99999, 'INVALID TOKEN')
      await act(async () => {
        await apiCall('track/list').catch(() => undefined)
      })

      // ⚠️ logout 还没返回（hang 住），但用户**已经**看到登录页了。
      await waitFor(() => {
        expect(screen.getByTestId('view-connect')).toBeTruthy()
      })
    } finally {
      hang.logout = false
    }
  })
})
