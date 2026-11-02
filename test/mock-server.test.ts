import { describe, it, expect } from 'vitest'
import { networkInterfaces } from 'node:os'
import {
  createMockServer,
  FETCH_BLOCKED_PORTS,
  isLoopbackAddress,
  resolvePage,
  resolvePageSize,
  type MockServer,
} from '../mock-server/server'
import { sha256 } from '../electron/sign'

// ---------------------------------------------------------------------------
// Task 5：Mock server（无 NAS 开发前提）
//
// 简报 Step 1 的三条用例（health / 登录 / 收藏）**逐字保留其测试意图**；
// 唯一改动：业务端点要求凭证，收藏用例改为「先登录拿 token 再带上凭证」，
// 理由见控制器裁定 §3.1（简报 Step 3 要求校验凭证，与 Step 1 的收藏用例不带凭证冲突）。
//
// 凭证通道：**Cookie 头** `music-token=<token>`（真实 NAS 就是这么传的，
// 见 `electron/sign.ts` 的 `buildCookie()`；中继链路还在同一个 Cookie 头里带 `mode=relay`）。
// 测试 helper 默认走 Cookie，以免把「独立 music-token 请求头」这种调试便利当成正式契约。
// ---------------------------------------------------------------------------

const API = '/music/api/v1'

/** 登录并取回 token（口令既接受明文 'x'，也接受 sha256('x')）；失败直接抛错，不返回空串。 */
async function login(s: MockServer, password = 'x'): Promise<string> {
  const r = await fetch(`${s.url}${API}/user/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password, deviceId: 'd' }),
  })
  const body = (await r.json()) as {
    code: number
    msg?: string
    data?: { userToken?: string }
  }
  const token = body.data?.userToken
  if (body.code !== 0 || !token) {
    throw new Error(`登录失败：code=${body.code} msg=${body.msg ?? ''}`)
  }
  return token
}

/** 带 Cookie 凭证的 GET，返回业务信封。 */
async function getJson(
  s: MockServer,
  path: string,
  token?: string,
): Promise<{ status: number; code: number; msg: string; data: any }> {
  const r = await fetch(`${s.url}${path}`, {
    headers: token ? { cookie: `music-token=${token}` } : {},
  })
  const body = (await r.json()) as any
  return { status: r.status, code: body.code, msg: body.msg, data: body.data }
}

/** 带 Cookie 凭证的 POST，返回业务信封。 */
async function postJson(
  s: MockServer,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; code: number; msg: string; data: any }> {
  const r = await fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `music-token=${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const bodyOut = (await r.json()) as any
  return { status: r.status, code: bodyOut.code, msg: bodyOut.msg, data: bodyOut.data }
}

/** 本机的非回环 IPv4（用于 M6 的「真实来源地址」用例）。 */
function findNonLoopbackIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return undefined
}

describe('mock server', () => {
  it('health 返回成功', async () => {
    const s = createMockServer()
    const r = await fetch(`${s.url}/music/api/v1/health`)
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).code).toBe(0)
    s.close()
  })

  it('密码登录返回 token，错误密码返回非 0', async () => {
    const s = createMockServer()
    const ok = await fetch(`${s.url}/music/api/v1/user/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'x', deviceId: 'd' }),
    })
    expect(((await ok.json()) as any).code).toBe(0)
    const bad = await fetch(`${s.url}/music/api/v1/user/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'wrong', deviceId: 'd' }),
    })
    expect(((await bad.json()) as any).code).not.toBe(0)
    s.close()
  })

  it('收藏可创建并出现在列表中', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await postJson(s, `${API}/favorite-track/create`, { trackGUID: 't1' }, token)
    expect(r.code).toBe(0)
    const list = await getJson(s, `${API}/favorite-track/list`, token)
    expect(list.data.list.length).toBe(1)
    expect(list.data.list[0].guid).toBe('t1')
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 登录与 token
// ---------------------------------------------------------------------------

describe('mock server 登录与 token', () => {
  it('登录返回 userToken 与 deviceId 回显', async () => {
    const s = createMockServer()
    const token = await login(s)
    expect(token).toMatch(/^mock-token-/)
    const me = await getJson(s, `${API}/user/me`, token)
    expect(me.data).toEqual({ username: 'demo', nickName: '演示用户', guid: 'u1' })
    s.close()
  })

  it('口令接受 sha256 小写十六进制', async () => {
    const s = createMockServer()
    const token = await login(s, sha256('x'))
    expect(token).toMatch(/^mock-token-/)
    s.close()
  })

  it('登录失败业务码非 0 且带可读文案', async () => {
    const s = createMockServer()
    const r = await postJson(s, `${API}/user/password-login`, {
      username: 'demo',
      password: 'nope',
      deviceId: 'd',
    })
    expect(r.code).not.toBe(0)
    expect(r.msg).toBe('账号或密码错误')
    s.close()
  })

  it('每个 mock 实例签发独立 token', async () => {
    const s1 = createMockServer()
    const s2 = createMockServer()
    const t1 = await login(s1)
    const t2 = await login(s2)
    expect(t1).not.toBe(t2)
    // s1 的 token 在 s2 上无效
    const cross = await getJson(s2, `${API}/user/me`, t1)
    expect(cross.code).toBe(99999)
    s1.close()
    s2.close()
  })

  it('业务端点不带凭证时业务码为 99999（HTTP 仍为 200）', async () => {
    const s = createMockServer()
    const r = await getJson(s, `${API}/track/list`)
    expect(r.status).toBe(200)
    expect(r.code).toBe(99999)
    expect(r.msg).toBe('invalid token')
    s.close()
  })

  it('带无效 token 时业务码为 99999', async () => {
    const s = createMockServer()
    const r = await getJson(s, `${API}/track/list`, 'mock-token-bogus')
    expect(r.code).toBe(99999)
    s.close()
  })

  it('登出后原 token 立即失效', async () => {
    const s = createMockServer()
    const token = await login(s)
    expect((await getJson(s, `${API}/user/me`, token)).code).toBe(0)
    expect((await postJson(s, `${API}/user/logout`, {}, token)).code).toBe(0)
    expect((await getJson(s, `${API}/user/me`, token)).code).toBe(99999)
    s.close()
  })

  it('免 token 端点：health / sys/config / password-login', async () => {
    const s = createMockServer()
    expect((await getJson(s, `${API}/health`)).code).toBe(0)
    expect((await getJson(s, '/sys/config')).code).toBe(0)
    expect(
      (await postJson(s, `${API}/user/password-login`, { username: 'demo', password: 'x' }))
        .code,
    ).toBe(0)
    s.close()
  })

  it('全部业务端点都要求凭证（逐个端点核对）', async () => {
    const s = createMockServer()
    const paths = [
      '/user/me',
      '/user/logout',
      '/album/list',
      '/album/detail',
      '/album/artist-detail/list',
      '/track/list',
      '/track/album-detail/list',
      '/track/artist-detail/list',
      '/track/genre-detail/list',
      '/track/playlist-detail/list',
      '/track/stream',
      '/favorite-track/list',
      '/favorite-track/create',
      '/favorite-track/delete',
      '/artist/list',
      '/genre/list',
      '/playlist/list',
      '/playlist/create',
      '/playlist/update',
      '/playlist/delete',
      '/playlist/add-track',
      '/playlist/remove-track',
      '/search/track',
      '/search/album',
      '/search/artist',
      '/lyric/list',
      '/play-history/list',
    ]
    for (const path of paths) {
      // 凭证闸门发生在方法分发之前，因此 GET / POST 都应返回 99999。
      const viaGet = await getJson(s, `${API}${path}`)
      expect(viaGet.code, `GET ${path} 应当要求凭证`).toBe(99999)
      const viaPost = await postJson(s, `${API}${path}`, {})
      expect(viaPost.code, `POST ${path} 应当要求凭证`).toBe(99999)
    }
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 凭证通道：Cookie（真实 NAS 的形状）
// ---------------------------------------------------------------------------

describe('mock server 从 Cookie 读取凭证', () => {
  it('Cookie: music-token=<token> 的业务请求返回 code 0', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await fetch(`${s.url}${API}/user/me`, {
      headers: { cookie: `music-token=${token}` },
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).code).toBe(0)
    s.close()
  })

  it('Cookie 里的 token 不匹配时返回 99999', async () => {
    const s = createMockServer()
    const r = await fetch(`${s.url}${API}/user/me`, {
      headers: { cookie: 'music-token=wrong' },
    })
    expect(((await r.json()) as any).code).toBe(99999)
    s.close()
  })

  it('Cookie 里同时带 mode=relay 仍可用（中继标记不是凭证）', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await fetch(`${s.url}${API}/track/list`, {
      headers: { cookie: `music-token=${token}; mode=relay` },
    })
    const body = (await r.json()) as any
    expect(body.code).toBe(0)
    expect(body.data.list.length).toBe(8)
    s.close()
  })

  it('Cookie 与独立 music-token 头同时存在时以 Cookie 为准', async () => {
    const s = createMockServer()
    const token = await login(s)
    const other = await login(s)
    const r = await fetch(`${s.url}${API}/user/me`, {
      headers: { cookie: `music-token=${token}`, 'music-token': other },
    })
    // Cookie 里的 token 有效 → 放行；随后用另一个 token 登出，验证退出的是 Cookie 里的那个。
    expect(((await r.json()) as any).code).toBe(0)
    await fetch(`${s.url}${API}/user/logout`, {
      method: 'POST',
      headers: { cookie: `music-token=${token}`, 'music-token': other },
      body: '{}',
    })
    const afterCookie = await fetch(`${s.url}${API}/user/me`, {
      headers: { cookie: `music-token=${token}` },
    })
    expect(((await afterCookie.json()) as any).code).toBe(99999)
    const afterHeader = await fetch(`${s.url}${API}/user/me`, {
      headers: { 'music-token': other },
    })
    expect(((await afterHeader.json()) as any).code).toBe(0)
    s.close()
  })

  it('独立的 music-token 请求头仍被容忍（仅调试便利）', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await fetch(`${s.url}${API}/user/me`, {
      headers: { 'music-token': token },
    })
    expect(((await r.json()) as any).code).toBe(0)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 列表信封与分页
// ---------------------------------------------------------------------------

describe('mock server 列表信封与分页', () => {
  it('列表端点统一返回 { list, total }', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await getJson(s, `${API}/track/list`, token)
    expect(r.code).toBe(0)
    expect(Array.isArray(r.data.list)).toBe(true)
    expect(r.data.total).toBe(8)
    s.close()
  })

  it('page / size 服务端分页，total 始终是全量', async () => {
    const s = createMockServer()
    const token = await login(s)
    const p1 = await getJson(s, `${API}/track/list?page=1&size=3`, token)
    const p2 = await getJson(s, `${API}/track/list?page=2&size=3`, token)
    const p3 = await getJson(s, `${API}/track/list?page=3&size=3`, token)
    expect(p1.data.list.length).toBe(3)
    expect(p2.data.list.length).toBe(3)
    expect(p3.data.list.length).toBe(2)
    expect(p1.data.total).toBe(8)
    expect(p1.data.list[0].guid).toBe('t1')
    expect(p2.data.list[0].guid).toBe('t4')
    expect(p3.data.list[0].guid).toBe('t7')
    s.close()
  })

  it('超出范围的页返回空列表，非法分页参数回落默认值', async () => {
    const s = createMockServer()
    const token = await login(s)
    const beyond = await getJson(s, `${API}/track/list?page=99&size=10`, token)
    expect(beyond.data.list).toEqual([])
    expect(beyond.data.total).toBe(8)
    const bad = await getJson(s, `${API}/track/list?page=0&size=abc`, token)
    expect(bad.data.list.length).toBe(8)
    expect(bad.code).toBe(0)
    s.close()
  })

  it('每页条数上限是 2000（纯函数钉住实现退化）', () => {
    // 这一组是「size 上限」这条硬约束的真正守卫：fixtures 只有 8 首，
    // 靠 HTTP 断言 list.length 无法区分 size=8 / 200 / 2000。
    expect(resolvePageSize('5000')).toBe(2000)
    expect(resolvePageSize('2001')).toBe(2000)
    expect(resolvePageSize('2000')).toBe(2000)
    expect(resolvePageSize('500')).toBe(500)
    expect(resolvePageSize('0')).toBe(200)
    expect(resolvePageSize('-1')).toBe(200)
    expect(resolvePageSize('abc')).toBe(200)
    expect(resolvePageSize('')).toBe(200)
    expect(resolvePageSize(null)).toBe(200)
    expect(resolvePageSize(undefined)).toBe(200)
  })

  it('页码解析：非法值回落 1', () => {
    expect(resolvePage('1')).toBe(1)
    expect(resolvePage('7')).toBe(7)
    expect(resolvePage('0')).toBe(1)
    expect(resolvePage('-3')).toBe(1)
    expect(resolvePage('abc')).toBe(1)
    expect(resolvePage(null)).toBe(1)
    expect(resolvePage(undefined)).toBe(1)
  })

  it('size 超过上限的请求不报错（上限本身由纯函数用例守住）', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await getJson(s, `${API}/track/list?size=5000`, token)
    expect(r.code).toBe(0)
    expect(r.data.list.length).toBe(8)
    expect(r.data.total).toBe(8)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 曲库 / 专辑 / 歌手 / 风格
// ---------------------------------------------------------------------------

describe('mock server 曲库查询', () => {
  it('/album/detail 返回单条列表，/track/album-detail/list 返回该专辑曲目', async () => {
    const s = createMockServer()
    const token = await login(s)
    const album = await getJson(s, `${API}/album/detail?albumGUID=al1`, token)
    expect(album.data.list.length).toBe(1)
    expect(album.data.list[0].guid).toBe('al1')
    const tracks = await getJson(s, `${API}/track/album-detail/list?albumGUID=al1`, token)
    expect(tracks.data.total).toBe(4)
    const missing = await getJson(s, `${API}/album/detail?albumGUID=nope`, token)
    expect(missing.data.list).toEqual([])
    s.close()
  })

  it('/album/artist-detail/list 与 /track/artist-detail/list 按歌手过滤', async () => {
    const s = createMockServer()
    const token = await login(s)
    const albums = await getJson(s, `${API}/album/artist-detail/list?artistGUID=a1`, token)
    expect(albums.data.total).toBe(2)
    const tracks = await getJson(s, `${API}/track/artist-detail/list?artistGUID=a2`, token)
    expect(tracks.data.total).toBe(4)
    s.close()
  })

  it('/track/genre-detail/list 按风格过滤，风格名保留原始大小写', async () => {
    const s = createMockServer()
    const token = await login(s)
    const tracks = await getJson(s, `${API}/track/genre-detail/list?genreGUID=g1`, token)
    expect(tracks.data.total).toBe(5)
    const genres = await getJson(s, `${API}/genre/list`, token)
    const names = genres.data.list.map((g: any) => g.name)
    expect(names).toContain('Pop')
    expect(names).toContain('POP')
    s.close()
  })

  it('/artist/list 返回 2 位歌手', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await getJson(s, `${API}/artist/list`, token)
    expect(r.data.total).toBe(2)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 收藏与歌单写回
// ---------------------------------------------------------------------------

describe('mock server 收藏与歌单写回', () => {
  it('收藏可删除，state.favorites 同步', async () => {
    const s = createMockServer()
    const token = await login(s)
    await postJson(s, `${API}/favorite-track/create`, { trackGUID: 't1' }, token)
    await postJson(s, `${API}/favorite-track/create`, { trackGUID: 't3' }, token)
    expect(s.state.favorites.size).toBe(2)
    expect((await postJson(s, `${API}/favorite-track/delete`, { trackGUID: 't1' }, token)).code).toBe(0)
    expect(s.state.favorites.has('t1')).toBe(false)
    const list = await getJson(s, `${API}/favorite-track/list`, token)
    expect(list.data.list.length).toBe(1)
    expect(list.data.list[0].guid).toBe('t3')
    s.close()
  })

  it('歌单可创建、改名、增删曲目、删除', async () => {
    const s = createMockServer()
    const token = await login(s)
    const created = await postJson(s, `${API}/playlist/create`, { name: '我的歌单' }, token)
    expect(created.code).toBe(0)
    const guid = created.data.guid as string
    expect(guid).toMatch(/^p\d+$/)
    expect(s.state.playlists.has(guid)).toBe(true)

    await postJson(s, `${API}/playlist/update`, { guid, name: '改名后的歌单' }, token)
    expect(s.state.playlists.get(guid)?.name).toBe('改名后的歌单')

    await postJson(s, `${API}/playlist/add-track`, { guid, trackGUIDs: ['t1', 't2'] }, token)
    expect(s.state.playlists.get(guid)?.tracks).toEqual(['t1', 't2'])

    await postJson(s, `${API}/playlist/remove-track`, { guid, trackGUIDs: ['t1'] }, token)
    expect(s.state.playlists.get(guid)?.tracks).toEqual(['t2'])

    const tracks = await getJson(s, `${API}/track/playlist-detail/list?playlistGUID=${guid}`, token)
    expect(tracks.data.total).toBe(1)
    expect(tracks.data.list[0].guid).toBe('t2')

    const list = await getJson(s, `${API}/playlist/list`, token)
    expect(list.data.list.some((p: any) => p.guid === guid)).toBe(true)

    expect((await postJson(s, `${API}/playlist/delete`, { guid }, token)).code).toBe(0)
    expect(s.state.playlists.has(guid)).toBe(false)
    s.close()
  })

  it('操作不存在的歌单返回非 0 业务码', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await postJson(s, `${API}/playlist/update`, { guid: 'p999', name: 'x' }, token)
    expect(r.code).not.toBe(0)
    expect(r.msg.length).toBeGreaterThan(0)
    s.close()
  })

  it('add-track 传入不存在的曲目返回非 0 且不部分写入', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await postJson(
      s,
      `${API}/playlist/add-track`,
      { guid: 'p1', trackGUIDs: ['t3', 'nope'] },
      token,
    )
    expect(r.code).toBe(1)
    expect(r.msg).toBe('歌曲不存在')
    // 不部分写入：t3 也不该被加进去
    expect(s.state.playlists.get('p1')?.tracks).toEqual(['t1', 't2'])
    s.close()
  })

  it('remove-track 传入不存在的曲目返回非 0 且不部分写入', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await postJson(
      s,
      `${API}/playlist/remove-track`,
      { guid: 'p1', trackGUIDs: ['t1', 'nope'] },
      token,
    )
    expect(r.code).toBe(1)
    expect(r.msg).toBe('歌曲不存在')
    expect(s.state.playlists.get('p1')?.tracks).toEqual(['t1', 't2'])
    s.close()
  })

  it('歌单改名后 updatedAt 刷新', async () => {
    const s = createMockServer()
    const token = await login(s)
    const created = await postJson(s, `${API}/playlist/create`, { name: '待改名' }, token)
    const guid = created.data.guid as string
    const before = await getJson(s, `${API}/playlist/list`, token)
    const target = before.data.list.find((p: any) => p.guid === guid)
    expect(target.createdAt).toBeTruthy()
    expect(target.updatedAt).toBe(target.createdAt)

    await postJson(s, `${API}/playlist/update`, { guid, name: '已改名' }, token)
    const after = await getJson(s, `${API}/playlist/list`, token)
    const updated = after.data.list.find((p: any) => p.guid === guid)
    expect(updated.name).toBe('已改名')
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(updated.createdAt).getTime(),
    )
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 搜索 / 歌词 / 音频流
// ---------------------------------------------------------------------------

describe('mock server 搜索、歌词与音频流', () => {
  it('搜索按关键字命中曲目、专辑与歌手', async () => {
    const s = createMockServer()
    const token = await login(s)
    const tracks = await getJson(s, `${API}/search/track?q=${encodeURIComponent('示例曲目 1')}`, token)
    expect(tracks.data.total).toBe(1)
    const albums = await getJson(s, `${API}/search/album?q=${encodeURIComponent('示例专辑')}`, token)
    expect(albums.data.total).toBe(3)
    const artists = await getJson(s, `${API}/search/artist?q=${encodeURIComponent('示例歌手甲')}`, token)
    expect(artists.data.total).toBe(1)
    s.close()
  })

  it('缺关键字的搜索返回空列表而不是全量', async () => {
    const s = createMockServer()
    const token = await login(s)
    for (const path of ['/search/track', '/search/album', '/search/artist']) {
      const missing = await getJson(s, `${API}${path}`, token)
      expect(missing.code, `${path} 缺关键字`).toBe(0)
      expect(missing.data.list, `${path} 缺关键字不应返回全量`).toEqual([])
      expect(missing.data.total, `${path} 缺关键字`).toBe(0)

      const blank = await getJson(s, `${API}${path}?q=%20%20`, token)
      expect(blank.code, `${path} 空白关键字`).toBe(0)
      expect(blank.data.list, `${path} 空白关键字不应返回全量`).toEqual([])
      expect(blank.data.total, `${path} 空白关键字`).toBe(0)
    }
    s.close()
  })

  it('t1 返回增强型 LRC（词级标签），t2 无歌词', async () => {
    const s = createMockServer()
    const token = await login(s)
    const t1 = await getJson(s, `${API}/lyric/list?trackGUID=t1`, token)
    expect(t1.data.list.length).toBe(1)
    const content = t1.data.list[0].content as string
    expect(content).toContain('<00:05.00>')
    expect(content).toContain('[kuwo:014]')
    expect(t1.data.list[0].isLRC).toBe(true)
    const t2 = await getJson(s, `${API}/lyric/list?trackGUID=t2`, token)
    expect(t2.data.list).toEqual([])
    s.close()
  })

  it('/track/stream 返回可播放的 WAV，未知 guid 返回非 0 业务码', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await fetch(`${s.url}${API}/track/stream?guid=t1`, {
      headers: { cookie: `music-token=${token}` },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('audio/wav')
    const buf = Buffer.from(await r.arrayBuffer())
    expect(buf.length).toBe(Number(r.headers.get('content-length')))
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8)
    expect(buf.readUInt16LE(22)).toBe(1)
    expect(buf.readUInt32LE(24)).toBe(8000)

    const bad = await getJson(s, `${API}/track/stream?guid=nope`, token)
    expect(bad.code).not.toBe(0)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 播放历史（Task 6 补齐的端点）
// ---------------------------------------------------------------------------

describe('mock server 播放历史', () => {
  it('播放历史端点返回 { list, total }，条目内嵌原始歌曲', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await getJson(s, `${API}/play-history/list`, token)
    expect(r.code).toBe(0)
    expect(Array.isArray(r.data.list)).toBe(true)
    expect(r.data.total).toBe(4)
    expect(r.data.list[0].guid).toBe('h1')
    // 条目内嵌的是服务端原始歌曲形状（guid / title / duration 毫秒），不是领域模型。
    expect(r.data.list[0].track.guid).toBe('t1')
    expect(r.data.list[0].track.title).toBe('示例曲目 1')
    expect(r.data.list[0].track.duration).toBe(185000)
    s.close()
  })

  it('播放历史支持服务端分页，total 始终是全量', async () => {
    const s = createMockServer()
    const token = await login(s)
    const p1 = await getJson(s, `${API}/play-history/list?page=1&size=2`, token)
    const p2 = await getJson(s, `${API}/play-history/list?page=2&size=2`, token)
    expect(p1.data.list.length).toBe(2)
    expect(p2.data.list.length).toBe(2)
    expect(p1.data.total).toBe(4)
    expect(p2.data.total).toBe(4)
    expect(p1.data.list[0].guid).toBe('h1')
    expect(p2.data.list[0].guid).toBe('h3')
    s.close()
  })

  it('播放历史端点需要凭证', async () => {
    const s = createMockServer()
    const r = await getJson(s, `${API}/play-history/list`)
    expect(r.code).toBe(99999)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 端点清单核对
// ---------------------------------------------------------------------------

describe('mock server 端点清单', () => {
  it('简报点名的 GET 端点全部可用（业务码为 0）', async () => {
    const s = createMockServer()
    const token = await login(s)
    const getPaths = [
      '/user/me',
      '/album/list',
      '/album/detail',
      '/album/artist-detail/list',
      '/track/list',
      '/track/album-detail/list',
      '/track/artist-detail/list',
      '/track/genre-detail/list',
      '/track/playlist-detail/list',
      '/favorite-track/list',
      '/artist/list',
      '/genre/list',
      '/playlist/list',
      '/search/track',
      '/search/album',
      '/search/artist',
      '/lyric/list',
      '/play-history/list',
    ]
    for (const path of getPaths) {
      const r = await getJson(s, `${API}${path}`, token)
      expect(r.code, `GET ${path} 应当成功`).toBe(0)
    }
    // /track/stream 返回二进制，单独断言。
    const stream = await fetch(`${s.url}${API}/track/stream?guid=t1`, {
      headers: { cookie: `music-token=${token}` },
    })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('audio/wav')
    s.close()
  })

  it('简报点名的 POST 端点全部可用（业务码为 0）', async () => {
    const s = createMockServer()
    const token = await login(s)
    const postCases: Array<[string, unknown]> = [
      ['/favorite-track/create', { trackGUID: 't1' }],
      ['/favorite-track/delete', { trackGUID: 't1' }],
      ['/playlist/create', { name: '清单用歌单' }],
      ['/playlist/update', { guid: 'p1', name: 'p1 改名' }],
      ['/playlist/delete', { guid: 'p2' }],
      ['/playlist/add-track', { guid: 'p1', trackGUIDs: ['t1'] }],
      ['/playlist/remove-track', { guid: 'p1', trackGUIDs: ['t1'] }],
    ]
    for (const [path, body] of postCases) {
      const r = await postJson(s, `${API}${path}`, body, token)
      expect(r.code, `POST ${path} 应当成功`).toBe(0)
    }
    // 登放最后：它会让当前 token 失效。
    const logout = await postJson(s, `${API}/user/logout`, {}, token)
    expect(logout.code).toBe(0)
    s.close()
  })

  it('未知路径返回 404（即使没有凭证，也不是 99999）', async () => {
    const s = createMockServer()
    const withToken = await getJson(s, `${API}/not-exist`, await login(s))
    expect(withToken.code).toBe(404)
    expect(withToken.msg).toBe('接口不存在')
    const withoutToken = await getJson(s, `${API}/not-exist`)
    expect(withoutToken.code).toBe(404)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 只允许本机访问
// ---------------------------------------------------------------------------

describe('mock server 只允许本机访问', () => {
  it('回环判定：回环地址放行，非回环地址拒绝', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.53')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.172')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.172')).toBe(false)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
    expect(isLoopbackAddress('fe80::1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
  })

  it('来自非回环地址的请求被拒绝（真实来源地址）', async () => {
    const lan = findNonLoopbackIPv4()
    const s = createMockServer()
    const port = new URL(s.url).port
    try {
      let response: { code: number; msg: string } | null = null
      let networkError: unknown = null
      if (lan) {
        try {
          const r = await fetch(`http://${lan}:${port}${API}/health`)
          response = (await r.json()) as { code: number; msg: string }
        } catch (cause) {
          networkError = cause
        }
      }
      if (response) {
        expect(response.code).toBe(1)
        expect(response.msg).toBe('仅允许本机访问')
      } else {
        // 环境不允许走 LAN 路径（没有非回环 IPv4，或被防火墙拦下）：
        // 退回到纯函数判定，断言的仍是同一条规则（非回环地址一律判为拒绝）。
        expect(networkError === null || networkError instanceof Error).toBe(true)
        expect(isLoopbackAddress(lan ?? '192.168.1.172')).toBe(false)
      }
    } finally {
      s.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe('mock server 生命周期', () => {
  it('端口不会落在 fetch 的禁用端口上（否则 fetch 直接报 bad port）', async () => {
    // 本机动态端口范围从 1024 起且顺序往上分配，一次测试跑出四十来个 mock server
    // 就可能路过 10080 这类禁用端口——落在上面时 fetch 根本不让连（随机飘红）。
    const s = createMockServer()
    const port = Number(new URL(s.url).port)
    expect(FETCH_BLOCKED_PORTS.has(port)).toBe(false)
    expect(port).toBeGreaterThan(0)
    // 该端口确实可用。
    expect((await getJson(s, `${API}/health`)).code).toBe(0)
    s.close()
  })

  it('close() 之后端口释放，请求不再可达', async () => {
    const s = createMockServer()
    const url = s.url
    await fetch(`${url}${API}/health`)
    s.close()
    await expect(fetch(`${url}${API}/health`)).rejects.toThrow()
  })

  it('close() 可重复调用且不抛异常', () => {
    const s = createMockServer()
    s.close()
    expect(() => s.close()).not.toThrow()
  })
})
