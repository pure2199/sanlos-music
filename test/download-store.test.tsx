// ---------------------------------------------------------------------------
// T11 本地下载（渲染层）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **扩展名推导**（`downloadExtension`）：优先 `audioSpec.format`，退回 `codec`，都不合法 → `bin`；
// - **本地优先播放**（`resolvePlaybackSource`）：
//   命中本地且开关打开 → `fnml://local/track/<id>`；
//   没命中 / 开关关掉 → `fnm://srv/track/stream?guid=…`（**与之前完全一致**）；
// - **下载状态镜像**（`useDownloadStore`）：读索引、乐观开关 + 失败回滚；
// - **行内下载按钮**（`DownloadButton`）：各状态的文案与点击行为。
//
// ⚠️ 测试数据一律用占位值，不写真实歌曲名 / FN ID / 用户路径。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { Song } from '../shared/types'
import type { DownloadEntry, DownloadTask, PlayerBridge } from '../shared/playerBridge'
import { localMediaUrl } from '../shared/localMedia'
import {
  downloadExtension,
  resolvePlaybackSource,
  totalDownloadedBytes,
  useDownloadStore,
} from '../src/state/downloadStore'
import { DownloadButton } from '../src/components/DownloadButton'

const SONG_ID = 'track_example01'

const SONG: Song = {
  id: SONG_ID,
  title: '示例歌名',
  artist: '示例歌手',
  artistId: '',
  album: '示例专辑',
  albumId: '',
  coverId: '',
  duration: 100,
  favorite: false,
  codec: 'FLAC',
  bitrate: 0,
  sampleRate: 0,
  bitDepth: 0,
  year: 0,
  trackNo: 1,
  discNo: 1,
}

/** 已下载条目。 */
const ENTRY: DownloadEntry = {
  songId: SONG_ID,
  file: 'C:\\Music\\飞牛音乐\\示例歌手 - 示例歌名.flac',
  bytes: 2048,
  ext: 'flac',
  downloadedAt: '2026-01-01T00:00:00.000Z',
}

/** 假桥（记录下载调用）。 */
function fakeBridge(): {
  bridge: PlayerBridge
  started: string[]
  cleared: number
  cancelled: string[]
} {
  const started: string[] = []
  const cancelled: string[] = []
  let cleared = 0
  const bridge = {
    pushState: async () => undefined,
    sendCommand: async () => undefined,
    onCommand: () => () => undefined,
    getPrefs: async () => ({ localFirst: true }),
    setPrefs: async () => ({}),
    setTheme: async () => ({}),
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
    pushLyricState: () => undefined,
    onLyricState: () => () => undefined,
    onLyricVisibility: () => () => undefined,
    setLyricVisible: async () => undefined,
    listDownloads: async () => ({ entries: {}, tasks: [] as DownloadTask[], dir: '' }),
    startDownload: async (request: { songId: string }) => {
      started.push(request.songId)
    },
    cancelDownload: async (songId: string) => {
      cancelled.push(songId)
    },
    clearDownloads: async () => {
      cleared += 1
    },
    onDownloadChange: () => () => undefined,
  } as unknown as PlayerBridge
  return {
    bridge,
    started,
    get cleared() {
      return cleared
    },
    cancelled,
  }
}

beforeEach(() => {
  delete (globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer
  useDownloadStore.setState({
    entries: {},
    tasks: {},
    localFirst: true,
    dir: '',
    error: null,
  })
})

// ---------------------------------------------------------------------------
// 扩展名推导
// ---------------------------------------------------------------------------

describe('下载：扩展名推导', () => {
  it('优先用 audioSpec.format（实测服务端给的就是容器名）', () => {
    expect(downloadExtension({ codec: 'FLAC', audioSpec: { format: 'flac' } })).toBe('flac')
  })

  it('没有 format 时退回 codec', () => {
    expect(downloadExtension({ codec: 'MP3', audioSpec: undefined })).toBe('mp3')
  })

  it('都不合法 → bin（不瞎猜 mp3）', () => {
    expect(downloadExtension({ codec: 'DTS-HD', audioSpec: undefined })).toBe('bin')
    expect(downloadExtension({ codec: '', audioSpec: undefined })).toBe('bin')
  })
})

// ---------------------------------------------------------------------------
// 本地优先播放
// ---------------------------------------------------------------------------

describe('下载：本地优先播放', () => {
  it('本地有副本且开关打开 → 用 fnml://（不再走 NAS）', () => {
    useDownloadStore.setState({ entries: { [SONG_ID]: ENTRY }, localFirst: true })
    expect(resolvePlaybackSource(SONG)).toBe(localMediaUrl(SONG_ID))
  })

  it('本地没副本 → 照旧走 fnm:// 流式地址', () => {
    useDownloadStore.setState({ entries: {}, localFirst: true })
    expect(resolvePlaybackSource(SONG)).toBe(`fnm://srv/track/stream?guid=${SONG_ID}`)
  })

  it('开关关掉 → 即使本地有副本也走流式地址', () => {
    useDownloadStore.setState({ entries: { [SONG_ID]: ENTRY }, localFirst: false })
    expect(resolvePlaybackSource(SONG)).toBe(`fnm://srv/track/stream?guid=${SONG_ID}`)
  })

  it('正在下载的**半成品不算**（entries 里没有 → 走流式）', () => {
    useDownloadStore.setState({
      entries: {},
      tasks: {
        [SONG_ID]: {
          songId: SONG_ID,
          title: '示例歌名',
          artist: '示例歌手',
          status: 'running',
          received: 10,
          total: 100,
          error: null,
          file: null,
        },
      },
      localFirst: true,
    })
    expect(resolvePlaybackSource(SONG)).toBe(`fnm://srv/track/stream?guid=${SONG_ID}`)
  })
})

// ---------------------------------------------------------------------------
// 状态镜像
// ---------------------------------------------------------------------------

describe('下载：状态镜像', () => {
  it('load：读回索引、任务、目录与「本地优先」开关', async () => {
    const task: DownloadTask = {
      songId: SONG_ID,
      title: '示例歌名',
      artist: '示例歌手',
      status: 'running',
      received: 5,
      total: 10,
      error: null,
      file: null,
    }
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = {
      ...fakeBridge().bridge,
      listDownloads: async () => ({ entries: { [SONG_ID]: ENTRY }, tasks: [task], dir: 'C:\\Music' }),
      getPrefs: async () => ({ localFirst: false }),
    } as unknown as PlayerBridge

    await useDownloadStore.getState().load()

    const state = useDownloadStore.getState()
    expect(state.entries[SONG_ID]?.file).toBe(ENTRY.file)
    expect(state.tasks[SONG_ID]?.status).toBe('running')
    expect(state.dir).toBe('C:\\Music')
    expect(state.localFirst).toBe(false)
  })

  it('没有桥（浏览器预览）→ 不崩、状态保持默认值', async () => {
    await useDownloadStore.getState().load()
    expect(useDownloadStore.getState().entries).toEqual({})
    expect(useDownloadStore.getState().localFirst).toBe(true)
  })

  it('「本地优先」是乐观应用；写回失败 → 回滚到原值', async () => {
    // ⚠️ 用**数组**持有 rejecter：变量在回调里赋值、在外层调用时，
    //    TypeScript 的控制流分析会把 `let` 收窄成初始值（这里会收窄成 `null`）。
    const rejectors: Array<(err: unknown) => void> = []
    const setPrefs = vi.fn(
      () =>
        new Promise<Record<string, never>>((_resolve, reject) => {
          rejectors.push(reject)
        }),
    )
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = {
      ...fakeBridge().bridge,
      setPrefs,
    } as unknown as PlayerBridge

    const pending = useDownloadStore.getState().setLocalFirst(false)
    // ⚠️ 乐观应用：请求还没回来，界面**已经**变了。
    expect(useDownloadStore.getState().localFirst).toBe(false)

    rejectors.forEach((reject) => reject(new Error('写回失败')))
    await pending

    // 写回失败 → 回滚到**原值**（`true`），并给出提示。
    expect(useDownloadStore.getState().localFirst).toBe(true)
    expect(useDownloadStore.getState().error).toBeTruthy()
  })

  it('「本地优先」写回成功 → 保持新值且无错误', async () => {
    const setPrefs = vi.fn(async () => ({}))
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = {
      ...fakeBridge().bridge,
      setPrefs,
    } as unknown as PlayerBridge

    await useDownloadStore.getState().setLocalFirst(false)

    expect(setPrefs).toHaveBeenCalledWith({ localFirst: false })
    expect(useDownloadStore.getState().localFirst).toBe(false)
    expect(useDownloadStore.getState().error).toBeNull()
  })

  it('统计已下载占用空间（按索引求和，不遍历磁盘）', () => {
    expect(totalDownloadedBytes({})).toBe(0)
    expect(totalDownloadedBytes({ [SONG_ID]: ENTRY })).toBe(2048)
  })
})

// ---------------------------------------------------------------------------
// 行内下载按钮
// ---------------------------------------------------------------------------

describe('下载：行内按钮', () => {
  it('未下载 → 显示「下载」，点击发起下载', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge

    render(<DownloadButton song={SONG} />)
    const button = screen.getByTestId('fnm-download-button')
    expect(button.textContent).toBe('下载')
    expect(button.getAttribute('data-status')).toBe('idle')

    fireEvent.click(button)
    expect(fake.started).toEqual([SONG_ID])
  })

  it('已下载 → 显示「本地」且不可点', () => {
    useDownloadStore.setState({ entries: { [SONG_ID]: ENTRY } })
    render(<DownloadButton song={SONG} />)

    const button = screen.getByTestId('fnm-download-button')
    expect(button.textContent).toBe('本地')
    expect(button.getAttribute('data-status')).toBe('done')
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('下载中 → 显示百分比，点击取消', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge
    useDownloadStore.setState({
      tasks: {
        [SONG_ID]: {
          songId: SONG_ID,
          title: '示例歌名',
          artist: '示例歌手',
          status: 'running',
          received: 25,
          total: 100,
          error: null,
          file: null,
        },
      },
    })

    render(<DownloadButton song={SONG} />)
    const button = screen.getByTestId('fnm-download-button')
    expect(button.textContent).toBe('25%')

    fireEvent.click(button)
    expect(fake.cancelled).toEqual([SONG_ID])
    expect(fake.started).toEqual([])
  })

  it('失败 → 显示「重试」，点击重新下载', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge
    useDownloadStore.setState({
      tasks: {
        [SONG_ID]: {
          songId: SONG_ID,
          title: '示例歌名',
          artist: '示例歌手',
          status: 'error',
          received: 0,
          total: 0,
          error: '下载失败：无法连接音乐服务',
          file: null,
        },
      },
    })

    render(<DownloadButton song={SONG} />)
    const button = screen.getByTestId('fnm-download-button')
    expect(button.textContent).toBe('重试')
    expect(button.getAttribute('title')).toContain('无法连接音乐服务')

    fireEvent.click(button)
    expect(fake.started).toEqual([SONG_ID])
  })

  it('点击**不冒泡**到行上（行单击是「选中」）', () => {
    const fake = fakeBridge()
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = fake.bridge
    const onRowClick = vi.fn()

    render(
      <div onClick={onRowClick}>
        <DownloadButton song={SONG} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('fnm-download-button'))

    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('样式走类名（不在内联 style 里写死几何）', () => {
    render(<DownloadButton song={SONG} />)
    const button = screen.getByTestId('fnm-download-button')
    expect(button.className).toContain('fnm-download')
    expect(button.getAttribute('style')).toBeNull()
  })

  it('没有桥时点击不崩（浏览器预览）', async () => {
    render(<DownloadButton song={SONG} />)
    fireEvent.click(screen.getByTestId('fnm-download-button'))
    await waitFor(() => {
      expect(useDownloadStore.getState().error).toBe('当前环境不支持下载')
    })
  })
})
