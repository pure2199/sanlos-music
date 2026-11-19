// ---------------------------------------------------------------------------
// T122：「共享库」页的组件级测试
// ---------------------------------------------------------------------------
//
// ⚠️ 钉住的行为（**每一条都对应一个真机实测出来的事实**）：
// 1. **展示名兜底**：服务端给的 `name` **实测是空串**（2026-11-20 真机）
//    ⇒ 界面必须用 `path` 末段兜底，否则列表上一片空白。
// 2. **老服务端不崩**：没有 `/shared-library/list` 这个端点时，响应 body 是 `null`
//    ⇒ 客户端抛错 ⇒ 页面要**如实说明「服务端不支持共享库」**，不是白屏、也不是崩。
// 3. **浏览复用目录浏览**：共享库的 `path` 就是曲库根 ⇒ 内容用目录浏览取
//    ⇒ 子目录可下钻、曲目能播。
// 4. **播放口径一致**：目录浏览的曲目（毫秒）⇒ 映射成领域模型（秒）
//    ⇒ 与曲库里的歌是**同一套字段**（`duration` 是秒，不是毫秒）。
// 5. **整队口径**：`onPlay` 的第三个参数是**当前目录已加载的全部曲目**。
//
// ⚠️ **老结论不许回退**：页面源码里不许再出现「服务端不能浏览目录」那类说法
//    （T119 的纪律：过时结论不许从新页面里长出来）。
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { mapSharedLibrary } from '../src/api/sharedLibrary'
import type { RawFolderNode } from '../src/api/folder'
import { SharedLibrariesPage } from '../src/pages/SharedLibrariesPage'
import type { SharedLibrary, Song } from '../shared/types'

/** 两个共享库（**`name` 都是空串** —— 与真机实测一致）。 */
const LIBRARIES: SharedLibrary[] = [
  {
    id: 'sl-1',
    name: '',
    path: '/vol02/1000-0-3d135437',
    displayName: '1000-0-3d135437',
    autoDownloadLyric: true,
    metadataPreference: 'cloud_preferred',
    contentLastChangedAt: 1793956656,
    accessStatus: 0,
  },
  {
    id: 'sl-2',
    name: '',
    path: '/vol1/1000/music/music',
    displayName: 'music',
    autoDownloadLyric: true,
    metadataPreference: 'cloud_preferred',
    contentLastChangedAt: 1793952254,
    accessStatus: 0,
  },
]

/** 一个目录节点的形状（**裁剪过的** —— 与真实服务端一致）。 */
const ROOT_NODE: RawFolderNode = {
  name: '3d135437',
  path: '/vol02/1000-0-3d135437',
  itemCount: 2,
  folders: [
    {
      name: '有声小说',
      path: '/vol02/1000-0-3d135437/有声小说',
      itemCount: 1,
      folders: [],
      tracks: [],
    },
  ],
  tracks: [
    {
      guid: 't-1',
      title: '第一首',
      // ⚠️ **毫秒**（真实服务端口径）⇒ 映射后应是 185 秒。
      duration: 185000,
      coverId: 'track_0123456789abcdef',
      album: { guid: 'al-1', name: '专辑一' },
      artists: [{ guid: 'ar-1', name: '歌手一' }],
      audioSpec: { format: 'flac', path: '/vol02/1000-0-3d135437/a.flac', size: 1024 },
    },
  ],
}

/** 子目录节点（点进去之后）。 */
const CHILD_NODE: RawFolderNode = {
  name: '有声小说',
  path: '/vol02/1000-0-3d135437/有声小说',
  itemCount: 1,
  folders: [],
  tracks: [
    {
      guid: 't-2',
      title: '第二首',
      duration: 100000,
      coverId: null,
      album: { guid: 'al-2', name: '专辑二' },
      artists: [{ guid: 'ar-2', name: '歌手二' }],
      audioSpec: { format: 'flac', path: '/vol02/1000-0-3d135437/有声小说/b.flac', size: 2048 },
    },
  ],
}

/** 造一个可注入的假接口。 */
function makeApi(overrides?: {
  list?: () => Promise<SharedLibrary[]>
  browse?: (path: string) => Promise<RawFolderNode>
}) {
  return {
    list: vi.fn(overrides?.list ?? (async () => LIBRARIES)),
    browse: vi.fn(overrides?.browse ?? (async () => ROOT_NODE)),
  }
}

describe('SharedLibrariesPage（共享库页）', () => {
  it('① 列出共享库；`name` 为空时**用 path 末段兜底**显示', async () => {
    const api = makeApi()
    render(<SharedLibrariesPage api={api} />)

    await waitFor(() => expect(screen.getByText('1000-0-3d135437')).toBeTruthy())
    // ⚠️ 真机实测 `name` 是空串 ⇒ 兜底名必须出现（不然界面上是空白项）。
    expect(screen.getByText('music')).toBeTruthy()
    // 路径原样显示（用户要能看懂共享的是哪个目录）。
    expect(screen.getByText('/vol02/1000-0-3d135437')).toBeTruthy()
    // 状态行带计数（千分位口径）。
    expect(screen.getByText(/共享库 2 个/)).toBeTruthy()
  })

  it('② 老服务端（端点不存在）⇒ **如实说明「不支持共享库」**，不崩、不白屏', async () => {
    const api = makeApi({
      list: async () => {
        // ⚠️ 这正是 `apiCall` 在「响应 body 是 null」时抛的那个错。
        throw new Error('响应不是预期信封')
      },
    })
    render(<SharedLibrariesPage api={api} />)

    await waitFor(() => expect(screen.getByText(/不支持共享库/)).toBeTruthy())
    expect(screen.getByText(/没有共享库|不支持共享库/)).toBeTruthy()
  })

  it('③ 点共享库 ⇒ 按目录浏览：子目录能下钻、曲目列出来', async () => {
    const api = makeApi({
      browse: async (path) => (path.endsWith('有声小说') ? CHILD_NODE : ROOT_NODE),
    })
    render(<SharedLibrariesPage api={api} />)

    await waitFor(() => expect(screen.getByText('1000-0-3d135437')).toBeTruthy())
    fireEvent.click(screen.getByText('1000-0-3d135437'))

    await waitFor(() => expect(screen.getByText('第一首')).toBeTruthy())
    // 子目录（可下钻）
    expect(screen.getByText('有声小说')).toBeTruthy()
    // 状态行：目录 + 子目录数 + 曲目数
    expect(screen.getByText(/1 个子目录/)).toBeTruthy()
    expect(screen.getByText(/1 首/)).toBeTruthy()

    // 点子目录 ⇒ 换到子目录的内容
    fireEvent.click(screen.getByText('有声小说'))
    await waitFor(() => expect(screen.getByText('第二首')).toBeTruthy())
    expect(api.browse).toHaveBeenCalledWith('/vol02/1000-0-3d135437/有声小说')
  })

  it('④ 双击曲目 ⇒ 走 onPlay（整队口径；时长是**秒**不是毫秒）', async () => {
    const api = makeApi()
    const onPlay = vi.fn()
    render(<SharedLibrariesPage api={api} onPlay={onPlay} />)

    await waitFor(() => expect(screen.getByText('1000-0-3d135437')).toBeTruthy())
    fireEvent.click(screen.getByText('1000-0-3d135437'))
    await waitFor(() => expect(screen.getByText('第一首')).toBeTruthy())

    const row = screen.getByRole('option')
    fireEvent.doubleClick(row)

    expect(onPlay).toHaveBeenCalledTimes(1)
    const [song, index, list] = onPlay.mock.calls[0] as [Song, number, Song[]]
    expect(song.title).toBe('第一首')
    // ⚠️ 毫秒 → 秒（185000 ⇒ 185）；漏了这条 ⇒ 播放条上时长大 1000 倍。
    expect(song.duration).toBe(185)
    expect(song.artist).toBe('歌手一')
    expect(index).toBe(0)
    // ⚠️ 第三个参数 = **当前目录已加载的整队**。
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('第一首')
  })

  it('⑤ 浏览失败 ⇒ 如实显示错误（不吞）', async () => {
    const api = makeApi({
      browse: async () => {
        throw new Error('没有权限')
      },
    })
    render(<SharedLibrariesPage api={api} />)

    await waitFor(() => expect(screen.getByText('1000-0-3d135437')).toBeTruthy())
    fireEvent.click(screen.getByText('1000-0-3d135437'))
    await waitFor(() => expect(screen.getByText(/没有权限/)).toBeTruthy())
  })

  it('⑥ 映射：`name` 空 ⇒ 展示名用 path 末段；`accessStatus` 原样保留', () => {
    const mapped = mapSharedLibrary({
      guid: 'sl-1',
      name: '',
      path: '/vol02/1000-0-3d135437',
      autoDownloadLyric: true,
      metadataPreference: 'cloud_preferred',
      contentLastChangedAt: 1793956656,
      accessStatus: 3,
    })
    expect(mapped).not.toBeNull()
    expect(mapped?.displayName).toBe('1000-0-3d135437')
    expect(mapped?.accessStatus).toBe(3)
    // ⚠️ `contentLastChangedAt` 是 **Unix 秒**（不是 ISO 串）。
    expect(mapped?.contentLastChangedAt).toBe(1793956656)

    // `guid` 与 `path` 都空 ⇒ 这一项没有意义 ⇒ 丢掉。
    expect(mapSharedLibrary({})).toBeNull()

    // ⚠️ **兜底顺序照飞牛音乐 Web 前端**（2026-11-20 扒前端包实测）：
    //    `name` → 路径末段 → `guid`。
    expect(mapSharedLibrary({ guid: 'sl-x', path: '' })?.displayName).toBe('sl-x')
    expect(mapSharedLibrary({ guid: 'sl-y', name: '我的音乐', path: '/vol02/x' })?.displayName).toBe(
      '我的音乐',
    )
    // `metadataPreference` 原样透传（枚举：`local_preferred` / `cloud_preferred` / `local_only`）。
    expect(mapped?.metadataPreference).toBe('cloud_preferred')
  })

  it('⑦ 页面源码**不许**出现「服务端不能浏览目录」那类过时结论', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'pages', 'SharedLibrariesPage.tsx'),
      'utf8',
    )
    // ⚠️ 片段拼装 ⇒ **自己命中自己**（钉子里写着这句话 ⇒ 假红）。
    const forbidden = [['服务端', '不能', '浏览目录'].join(''), ['音乐服务', '没有', '浏览目录'].join('')]
    for (const phrase of forbidden) {
      expect(source.includes(phrase)).toBe(false)
    }
  })
})
