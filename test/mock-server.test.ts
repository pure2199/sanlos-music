import { describe, it, expect } from 'vitest'
import { createMockServer, type MockServer } from '../mock-server/server'
import { sha256 } from '../electron/sign'

// ---------------------------------------------------------------------------
// Task 5：Mock server（无 NAS 开发前提）
//
// 简报 Step 1 的三条用例（health / 登录 / 收藏）**逐字保留其测试意图**；
// 唯一改动：业务端点要求 `music-token` 头，收藏用例改为「先登录拿 token 再带上头」，
// 理由见控制器裁定 §3.1（简报 Step 3 要求校验 token，与 Step 1 的收藏用例不带 token 冲突）。
// ---------------------------------------------------------------------------

const API = '/music/api/v1'

/** 登录并取回 token（口令既接受明文 'x'，也接受 sha256('x')）。 */
async function login(s: MockServer, password = 'x'): Promise<string> {
  const r = await fetch(`${s.url}${API}/user/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password, deviceId: 'd' }),
  })
  const body = (await r.json()) as { code: number; data?: { userToken?: string } }
  return body.data?.userToken ?? ''
}

/** 带 token 的 GET，返回业务信封。 */
async function getJson(
  s: MockServer,
  path: string,
  token?: string,
): Promise<{ status: number; code: number; msg: string; data: any }> {
  const r = await fetch(`${s.url}${path}`, {
    headers: token ? { 'music-token': token } : {},
  })
  const body = (await r.json()) as any
  return { status: r.status, code: body.code, msg: body.msg, data: body.data }
}

/** 带 token 的 POST，返回业务信封。 */
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
      ...(token ? { 'music-token': token } : {}),
    },
    body: JSON.stringify(body),
  })
  const bodyOut = (await r.json()) as any
  return { status: r.status, code: bodyOut.code, msg: bodyOut.msg, data: bodyOut.data }
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

  it('业务端点不带 token 时业务码为 99999（HTTP 仍为 200）', async () => {
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

  it('全部业务端点都要求 token（逐个端点核对）', async () => {
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
    ]
    for (const path of paths) {
      // token 校验发生在方法分发之前，因此 GET / POST 都应返回 99999。
      const viaGet = await getJson(s, `${API}${path}`)
      expect(viaGet.code, `GET ${path} 应当要求 token`).toBe(99999)
      const viaPost = await postJson(s, `${API}${path}`, {})
      expect(viaPost.code, `POST ${path} 应当要求 token`).toBe(99999)
    }
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

  it('size 上限 2000', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await getJson(s, `${API}/track/list?size=999999`, token)
    expect(r.code).toBe(0)
    expect(r.data.list.length).toBe(8)
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
      headers: { 'music-token': token },
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
// 端点清单核对
// ---------------------------------------------------------------------------

describe('mock server 端点清单', () => {
  it('简报点名的端点全部实现（不返回 404）', async () => {
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
      '/track/stream',
      '/favorite-track/list',
      '/artist/list',
      '/genre/list',
      '/playlist/list',
      '/search/track',
      '/search/album',
      '/search/artist',
      '/lyric/list',
    ]
    const postPaths = [
      '/user/logout',
      '/favorite-track/create',
      '/favorite-track/delete',
      '/playlist/create',
      '/playlist/update',
      '/playlist/delete',
      '/playlist/add-track',
      '/playlist/remove-track',
    ]
    for (const path of getPaths) {
      const r = await getJson(s, `${API}${path}`, token)
      expect(r.code, `GET ${path} 不应返回 404`).not.toBe(404)
    }
    for (const path of postPaths) {
      const r = await postJson(s, `${API}${path}`, {}, token)
      expect(r.code, `POST ${path} 不应返回 404`).not.toBe(404)
    }
    s.close()
  })

  it('未知路径返回非 0 业务码', async () => {
    const s = createMockServer()
    const token = await login(s)
    const r = await getJson(s, `${API}/not-exist`, token)
    expect(r.code).not.toBe(0)
    expect(r.code).toBe(404)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe('mock server 生命周期', () => {
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
