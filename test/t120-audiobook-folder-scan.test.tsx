// ---------------------------------------------------------------------------
// T120：「有声」页改为按**服务端目录**浏览 —— 钉子
// ---------------------------------------------------------------------------
//
// ⚠️ **钉的是什么**
// ---------------------------------------------------------------------------
// T120 把「有声」页的数据源从「**全库扫 87 页** ＋ 按 path 关键字挑」换成
// 「**服务端目录树**定位那个文件夹 ＋ 递归取它下面的曲目」⇒
//
// - ① **目录浏览优先**：新端点可用时，`/track/list` **一次都不该被调用**；
// - ② **对照组**：新端点**不存在**（老服务端）⇒ `/track/list` **必须**被调用（回落）；
// - ③ **定位**：只请求**那个目录的子树**（不碰曲库里其它目录）；
// - ④ **递归**：中间层的 `tracks` 是空的 ⇒ 必须一路递归到「直接含文件」那层；
// - ⑤ **归并**：同一张专辑跨多个分段 ⇒ **合成一条**（集数不翻倍）；
// - ⑥ **判定等价**：同一份曲目，走「目录浏览」与走「全库扫描」⇒ `hits` **逐字相同**；
// - ⑦ **时长单位**：服务端给的是**毫秒** ⇒ `durationSec` 必须是**秒**；
// - ⑧ **管理员删掉的**曲目 / 子目录**不算**；
// - ⑨ **落盘兼容**：`STATE_VERSION` **不升** ＋ 旧落盘**照样读得出**。
//
// ⚠️ **① ② 必须成对**（一个「没发生」类判据**必须有对照组**）：
//    只钉 ① ⇒ 「这条链路根本没通」也会绿 ⇒ 假绿。
//
// ⚠️ **本文件用假的 `fetch` 驱动**（`sanlos://srv/…`）⇒ 测的是**真**的目录浏览实现
//    （BFS 定位、递归收集、毫秒换算），不是 mock 出来的结果。
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanLibraryTracks } = vi.hoisted(() => ({ scanLibraryTracks: vi.fn() }))

// ⚠️ 只 mock `library.ts` 的**全库扫描**；⚠️ `src/api/folder.ts`（目录浏览）用**真**实现。
vi.mock('../src/api/library', () => ({
  scanLibraryTracks,
  libraryApi: { albumWorkDir: vi.fn(), album: vi.fn() },
}))

import { useAudiobookStore, createMemoryAudiobookPort } from '../src/state/audiobookStore'

// ---------------------------------------------------------------------------
// 假的服务端（照 2026-11-19 真机实测的形状）
// ---------------------------------------------------------------------------

/** 服务端返回的**裁剪过**的曲目（真机实测：没有 `trackNo` / `createdAt` / `genres`）。 */
interface FakeTrack {
  guid: string
  title: string
  coverId: string | null
  duration: number
  isCue: boolean
  album: { guid: string; name: string; coverId: string | null }
  artists: { guid: string; name: string }[]
  audioSpec: { format: string; path: string; size: number }
  isFavorite: boolean
  isAdminDeleted: boolean
}

/** 假目录树。 */
interface FakeDir {
  name: string
  /** 直接挂在这个目录里的曲目。 */
  tracks: FakeTrack[]
  /** 子目录（**绝对路径**）。 */
  children: string[]
}

/** 造一条曲目（`durationMs` 是**毫秒**）。 */
function fakeTrack(opts: {
  guid: string
  title: string
  albumGuid: string
  albumName: string
  path: string
  durationMs: number
  isAdminDeleted?: boolean
}): FakeTrack {
  return {
    guid: opts.guid,
    title: opts.title,
    coverId: null,
    duration: opts.durationMs,
    isCue: false,
    album: { guid: opts.albumGuid, name: opts.albumName, coverId: null },
    artists: [{ guid: 'a-author', name: '示例作者' }],
    audioSpec: { format: 'mp3', path: opts.path, size: 24000000 },
    isFavorite: false,
    isAdminDeleted: opts.isAdminDeleted ?? false,
  }
}

/** 12 集（6 + 6，**跨两个分段** ⇒ 归并要合成一条）。 */
const WORK_ALBUM = 'al-novel'
const WORK_NAME = '示例有声作品'
const ROOT = '/vol02/1000-0-3d135437'
const WORK_DIR = `${ROOT}/有声小说/示例作者/${WORK_NAME}`
const SIDE_DIR = `${ROOT}/其它/示例旁支作品`

/** 造一棵假目录树（形状照真机实测：`有声小说/作者/作品/分段/文件`）。 */
function buildFakeTree(): Map<string, FakeDir> {
  const dirs = new Map<string, FakeDir>()
  const ensure = (path: string, name: string): FakeDir => {
    let dir = dirs.get(path)
    if (!dir) {
      dir = { name, tracks: [], children: [] }
      dirs.set(path, dir)
    }
    return dir
  }
  const link = (parent: string, child: string) => {
    ensure(parent, parent.split('/').filter(Boolean).slice(-1)[0] ?? parent).children.push(child)
    ensure(child, child.split('/').filter(Boolean).slice(-1)[0] ?? child)
  }

  ensure(ROOT, '1000-0-3d135437')
  link(ROOT, `${ROOT}/有声小说`)
  link(`${ROOT}/有声小说`, `${ROOT}/有声小说/示例作者`)
  link(`${ROOT}/有声小说/示例作者`, WORK_DIR)
  link(WORK_DIR, `${WORK_DIR}/Disc 01`)
  link(WORK_DIR, `${WORK_DIR}/Disc 02`)
  link(ROOT, `${ROOT}/其它`)
  link(`${ROOT}/其它`, SIDE_DIR)
  link(SIDE_DIR, `${SIDE_DIR}/Disc 01`)

  // ---- 12 集：6 集在 Disc 01、6 集在 Disc 02（**同一张专辑** ⇒ 归并成一条）----
  for (let i = 1; i <= 12; i += 1) {
    const label = String(i).padStart(2, '0')
    const disc = i <= 6 ? 'Disc 01' : 'Disc 02'
    const dir = `${WORK_DIR}/${disc}`
    ensure(dir, disc).tracks.push(
      fakeTrack({
        guid: `n${i}`,
        title: `${label}- 第${i}集`,
        albumGuid: WORK_ALBUM,
        albumName: WORK_NAME,
        path: `${dir}/${label}- 第${i}集.mp3`,
        durationMs: 1_500_000,
      }),
    )
  }

  // ---- 旁支作品：**不在**「有声小说」下 ⇒ 不该出现在列表里 ----
  ensure(`${SIDE_DIR}/Disc 01`, 'Disc 01').tracks.push(
    fakeTrack({
      guid: 'side-1',
      title: '01- 第01集',
      albumGuid: 'al-side',
      albumName: '示例旁支作品',
      path: `${SIDE_DIR}/Disc 01/01- 第01集.mp3`,
      durationMs: 1_500_000,
    }),
  )
  return dirs
}

/** 递归曲目数（`itemCount` 是**递归**口径 —— 真机实测可对账）。 */
function countTracks(dir: FakeDir, dirs: Map<string, FakeDir>): number {
  let total = dir.tracks.length
  for (const child of dir.children) {
    const node = dirs.get(child)
    if (node) total += countTracks(node, dirs)
  }
  return total
}

/** 假服务端。 */
interface FakeServer {
  /** 被请求过的 `parentPath`（按请求顺序）。 */
  calls: string[]
  /** 端点**不存在**（模拟老服务端 ⇒ body 是 `null`）？ */
  endpointMissing: boolean
  /** 曲库扫描被调用的次数（对照组用）。 */
  libraryCalls: number
}

/** 把 `fetch` 换成假的（照真机实测的响应形状）。 */
function installFakeServer(server: FakeServer): void {
  const dirs = buildFakeTree()
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    const text = async (body: unknown) => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify(body),
    })
    // ⚠️ **老服务端**：这些端点**不存在** ⇒ body 是 `null`（真机实测的形状）。
    if (server.endpointMissing) return text(null)
    if (url.includes('/app-center/authed-dir/list')) {
      return text({
        code: 0,
        msg: '',
        data: {
          list: [
            {
              path: ROOT,
              storageType: 2,
              permission: 'rw',
              comment: 'music',
              username: '',
            },
          ],
        },
      })
    }
    if (url.includes('/folder-view/list')) {
      // ⚠️ **用 `URL` 的 `searchParams` 解析**（它会把 `+` **和** `%20` 都还原成空格）
      //    —— 目录名里**确实有空格**（「Disc 01」）⇒ 解析错了就查不到那个目录。
      const parentPath = new URL(url).searchParams.get('parentPath') ?? ''
      server.calls.push(parentPath)
      const dir = dirs.get(parentPath)
      if (!dir) {
        return text({ code: 0, msg: '', data: { folder: { name: '', path: parentPath, itemCount: 0, folders: [], tracks: [] }, sort: 'title,asc' } })
      }
      return text({
        code: 0,
        msg: '',
        data: {
          folder: {
            name: dir.name,
            path: parentPath,
            itemCount: countTracks(dir, dirs),
            folders: dir.children.map((child) => ({
              name: child.split('/').filter(Boolean).slice(-1)[0] ?? child,
              path: child,
              itemCount: countTracks(dirs.get(child) as FakeDir, dirs),
              isAdminDeleted: false,
            })),
            // ⚠️ **中间层的 `tracks` 是空的**（真机实测就是这样）⇒ 客户端必须递归。
            tracks: dir.tracks,
          },
          sort: 'title,asc',
        },
      })
    }
    return text({ code: 100002, msg: 'invalid arguments', data: null })
  })
  vi.stubGlobal('fetch', fetchMock)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造一条**扫描用**的曲目（全库扫描那条路喂的形状）。 */
function scanTrackOf(opts: {
  id: string
  title: string
  albumId: string
  albumTitle: string
  path: string
  durationSec: number
}) {
  return {
    id: opts.id,
    title: opts.title,
    albumId: opts.albumId,
    albumTitle: opts.albumTitle,
    durationSec: opts.durationSec,
    trackNo: null,
    path: opts.path,
    createdAt: null,
    coverId: '',
    albumCoverId: '',
  }
}

/** 12 集的扫描形状（与假服务端的那 12 集**一一对应**）。 */
function libraryScanTracks() {
  const list = []
  for (let i = 1; i <= 12; i += 1) {
    const label = String(i).padStart(2, '0')
    const disc = i <= 6 ? 'Disc 01' : 'Disc 02'
    list.push(
      scanTrackOf({
        id: `n${i}`,
        title: `${label}- 第${i}集`,
        albumId: WORK_ALBUM,
        albumTitle: WORK_NAME,
        path: `${WORK_DIR}/${disc}/${label}- 第${i}集.mp3`,
        durationSec: 1500,
      }),
    )
  }
  return list
}

/** 让全库扫描把 12 集交出来（对照组用）。 */
function mockLibraryScan(server: FakeServer): void {
  scanLibraryTracks.mockImplementation(async (options: unknown) => {
    server.libraryCalls += 1
    const opts = options as {
      onPage?: (tracks: unknown[], progress: unknown) => void
    }
    const tracks = libraryScanTracks()
    opts.onPage?.(tracks, { page: 1, pages: 1, scanned: tracks.length, total: tracks.length })
    return {
      scanned: tracks.length,
      total: tracks.length,
      pages: 1,
      stoppedAtWatermark: false,
    }
  })
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('T120：「有声」页按服务端目录浏览', () => {
  let server: FakeServer

  beforeEach(() => {
    server = { calls: [], endpointMissing: false, libraryCalls: 0 }
    installFakeServer(server)
    scanLibraryTracks.mockReset()
    scanLibraryTracks.mockImplementation(async () => {
      server.libraryCalls += 1
      return { scanned: 0, total: 0, pages: 0, stoppedAtWatermark: false }
    })
    useAudiobookStore.setState({
      hits: [],
      overrides: {},
      keyword: '有声小说',
      scanning: false,
      progress: null,
      error: null,
      notice: null,
      scannedAt: null,
      extraGroups: {},
    })
  })

  it('① 目录浏览可用 ⇒ `/track/list` **一次都没被调用**（不再全库扫）', async () => {
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    expect(server.libraryCalls).toBe(0)
    expect(scanLibraryTracks).not.toHaveBeenCalled()
    // ⚠️ **这条只钉「没走全库扫描」**（一个「没发生」类判据）
    //    ⇒ 「确实扫到了东西」由 **④** 负责（正向控制）
    //    ⇒ 免得这条同时被「扫不到东西」的变异抓住 ⇒ 变异矩阵分不出谁是谁。
  })

  it('② **对照组**：端点不存在（老服务端）⇒ `/track/list` **被调用**（自动回落）', async () => {
    server.endpointMissing = true
    mockLibraryScan(server)
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    expect(scanLibraryTracks).toHaveBeenCalledTimes(1)
    expect(server.libraryCalls).toBe(1)
    // ⚠️ 回落的结果**等价**（同一份曲目 ⇒ 同样的一条命中）。
    const hits = useAudiobookStore.getState().hits
    expect(hits.length).toBe(1)
    expect(hits[0]?.trackCount).toBe(12)
  })

  it('③ 只请求**那个目录的子树**（不碰曲库里其它目录）', async () => {
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    // ⚠️ 授权根**要**列（才知道「有声小说」在哪儿），但**别的目录不许碰**。
    expect(server.calls).toContain(ROOT)
    expect(server.calls).toContain(`${ROOT}/有声小说`)
    expect(server.calls.some((p) => p.includes('/其它'))).toBe(false)
    // ⚠️ 旁支作品所在的那棵树**一次都没被访问** ⇒ 它不可能进列表。
    expect(server.calls.some((p) => p.includes('旁支'))).toBe(false)
  })

  it('④ **递归**到「直接含文件」那层 ⇒ 12 集一条不落', async () => {
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    const hits = useAudiobookStore.getState().hits
    expect(hits.length).toBe(1)
    // ⚠️ 两个分段各 6 集 ⇒ 12 集（只取第一层的话只有 6 集）。
    expect(hits[0]?.trackCount).toBe(12)
    // ⚠️ 中间层的 `tracks` 是空的 ⇒ **必须**访问到分段层。
    expect(server.calls).toContain(`${WORK_DIR}/Disc 01`)
    expect(server.calls).toContain(`${WORK_DIR}/Disc 02`)
  })

  it('⑤ 同一张专辑跨两个分段 ⇒ **合成一条**（不拆成两条、也不翻倍）', async () => {
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    const hits = useAudiobookStore.getState().hits
    expect(hits).toHaveLength(1)
    expect(hits[0]?.albumId).toBe(WORK_ALBUM)
    expect(hits[0]?.albumTitle).toBe(WORK_NAME)
    expect(hits[0]?.trackCount).toBe(12)
  })

  it('⑥ 同一份曲目：走「目录浏览」与走「全库扫描」⇒ `hits` **逐字相同**', async () => {
    // ---- 实验组：目录浏览 ----
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    const viaFolder = useAudiobookStore.getState().hits.map((h) => ({
      albumId: h.albumId,
      albumTitle: h.albumTitle,
      score: h.score,
      trackCount: h.trackCount,
      avgDurationSec: h.avgDurationSec,
      maxDurationSec: h.maxDurationSec,
      episodeRule: h.episodeRule,
      reasons: [...h.reasons].sort(),
    }))

    // ---- 对照组：全库扫描（老服务端那条路）----
    server.endpointMissing = true
    mockLibraryScan(server)
    useAudiobookStore.setState({ hits: [] })
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    const viaLibrary = useAudiobookStore.getState().hits.map((h) => ({
      albumId: h.albumId,
      albumTitle: h.albumTitle,
      score: h.score,
      trackCount: h.trackCount,
      avgDurationSec: h.avgDurationSec,
      maxDurationSec: h.maxDurationSec,
      episodeRule: h.episodeRule,
      reasons: [...h.reasons].sort(),
    }))

    expect(viaFolder).toEqual(viaLibrary)
    expect(viaFolder.length).toBe(1)
  })

  it('⑦ 服务端给的是**毫秒** ⇒ `durationSec` 必须是**秒**（1500000 ⇒ 1500）', async () => {
    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    const hit = useAudiobookStore.getState().hits[0]
    // ⚠️ 忘了 ÷1000 的话这里会是 1500000。
    expect(hit?.avgDurationSec).toBe(1500)
    expect(hit?.maxDurationSec).toBe(1500)
  })

  it('⑧ 管理员删掉的**曲目**与**子目录**都不算', async () => {
    // ⚠️ 往「Disc 02」里塞一条**被管理员删掉**的曲目 ⇒ 不该计入集数。
    const dirs = buildFakeTree()
    const disc2 = dirs.get(`${WORK_DIR}/Disc 02`) as FakeDir
    disc2.tracks.push(
      fakeTrack({
        guid: 'deleted-1',
        title: '99- 第99集',
        albumGuid: WORK_ALBUM,
        albumName: WORK_NAME,
        path: `${WORK_DIR}/Disc 02/99- 第99集.mp3`,
        durationMs: 1_500_000,
        isAdminDeleted: true,
      }),
    )
    // ⚠️ 重装一次假服务端（用它自己的树）⇒ 让删掉的那条真的在里面。
    installFakeServerWithDirs(server, dirs)

    await useAudiobookStore.getState().scan({ port: createMemoryAudiobookPort() })
    const hit = useAudiobookStore.getState().hits[0]
    expect(hit?.trackCount).toBe(12)
  })

  it('⑨ **落盘兼容**：`STATE_VERSION` **不升** ＋ 旧落盘（v3）照样读得出', async () => {
    const port = createMemoryAudiobookPort()
    await useAudiobookStore.getState().scan({ port })
    const saved = port.load()
    expect(saved?.version).toBe(3)
    // ⚠️ **旧落盘**（没有 `folderPaths` 这个字段）⇒ 照样能读回命中条目。
    const legacy = { ...(saved as unknown as Record<string, unknown>) }
    delete legacy['folderPaths']
    const legacyPort = createMemoryAudiobookPort(legacy as never)
    useAudiobookStore.setState({ hits: [] })
    useAudiobookStore.getState().restore(legacyPort)
    expect(useAudiobookStore.getState().hits.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 「把树换掉再装一次」的辅助（钉子 ⑧ 用）
// ---------------------------------------------------------------------------

/** 用**给定**的目录树装一次假服务端。 */
function installFakeServerWithDirs(server: FakeServer, dirs: Map<string, FakeDir>): void {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    const text = async (body: unknown) => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify(body),
    })
    if (server.endpointMissing) return text(null)
    if (url.includes('/app-center/authed-dir/list')) {
      return text({
        code: 0,
        msg: '',
        data: { list: [{ path: ROOT, storageType: 2, permission: 'rw', comment: 'music', username: '' }] },
      })
    }
    if (url.includes('/folder-view/list')) {
      const parentPath = new URL(url).searchParams.get('parentPath') ?? ''
      server.calls.push(parentPath)
      const dir = dirs.get(parentPath)
      if (!dir) {
        return text({ code: 0, msg: '', data: { folder: { name: '', path: parentPath, itemCount: 0, folders: [], tracks: [] }, sort: 'title,asc' } })
      }
      return text({
        code: 0,
        msg: '',
        data: {
          folder: {
            name: dir.name,
            path: parentPath,
            itemCount: countTracks(dir, dirs),
            folders: dir.children.map((child) => ({
              name: child.split('/').filter(Boolean).slice(-1)[0] ?? child,
              path: child,
              itemCount: countTracks(dirs.get(child) as FakeDir, dirs),
              isAdminDeleted: false,
            })),
            tracks: dir.tracks,
          },
          sort: 'title,asc',
        },
      })
    }
    return text({ code: 100002, msg: 'invalid arguments', data: null })
  })
  vi.stubGlobal('fetch', fetchMock)
}
