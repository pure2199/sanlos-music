// ---------------------------------------------------------------------------
// T54：音质偏好的**界面**与**播放源准备**（渲染层）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - 播放条：标准音质**准备中**的提示、标准音质**不可用**时的灰字说明、优先级；
// - 设置页「解码」分类：两档单选、默认选中原始音质、切档写回主进程、
//   写回失败回滚；
// - 播放源准备：本地曲目 / 本地副本**不转码**，NAS 曲目才走服务端转码。
//
// ⚠️ 全部数据都是**虚构占位**，不含真实 FN ID / 账号 / 密码 / 歌曲名。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import type { AppPrefs, PlayerBridge } from '../shared/playerBridge'
import type { Song } from '../shared/types'
import { PlayerBar, type PlayerStoreLike } from '../src/components/PlayerBar'
import { SettingsPanel } from '../src/components/SettingsPanel'
import { useAppPrefsStore, DEFAULT_CLOSE_BEHAVIOR } from '../src/state/appPrefsStore'
import { useDownloadStore } from '../src/state/downloadStore'
import type { PlayerStore } from '../src/state/playerStore'
import { STANDARD_QUALITY_PREPARING_MESSAGE } from '../src/player/format'
import { DEFAULT_STREAM_QUALITY } from '../src/player/transcode'

// ---------------------------------------------------------------------------
// 转码模块（打桩：界面用例不关心协议细节）
// ---------------------------------------------------------------------------

const prepareTranscode = vi.fn(async (_songId: string, _quality: string) => ({
  downloadId: '0123456789abcdef0123456789abcdef',
  url: 'fnm://srv/download/track/transcode/file?downloadId=0123456789abcdef0123456789abcdef',
  dispose: async () => undefined,
}))

vi.mock('../src/player/transcode', async () => {
  const actual = await vi.importActual<typeof import('../src/player/transcode')>(
    '../src/player/transcode',
  )
  return {
    ...actual,
    prepareTranscode: (songId: string, quality: string) => prepareTranscode(songId, quality),
  }
})

// ---------------------------------------------------------------------------
// 占位数据
// ---------------------------------------------------------------------------

const SONG: Song = {
  id: 'track_example01',
  title: '示例歌名',
  artist: '示例歌手',
  artistId: '',
  album: '',
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

/** 造一个只读的假 store（只提供 `PlayerBar` 用到的字段）。 */
function fakeStore(overrides: Partial<PlayerStore> = {}): PlayerStoreLike {
  const state = {
    current: SONG,
    queue: [SONG],
    isPlaying: false,
    position: 0,
    duration: 100,
    volume: 1,
    mode: 'sequence',
    muted: false,
    error: null,
    buffering: false,
    preparing: false,
    fallbackActive: false,
    ...overrides,
  } as unknown as PlayerStore
  return {
    getState: () => state,
    subscribe: () => () => undefined,
  }
}

/** 装一个假的 `globalThis.fnPlayer`。 */
function installBridge(overrides: Partial<PlayerBridge> = {}): {
  setPrefs: ReturnType<typeof vi.fn>
} {
  const setPrefs = vi.fn(async (_patch: Partial<AppPrefs>) => ({}))
  const bridge = {
    getPrefs: vi.fn(async (): Promise<AppPrefs> => ({})),
    setPrefs,
    setTheme: vi.fn(async (): Promise<AppPrefs> => ({})),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    pushState: vi.fn(),
    sendCommand: vi.fn(),
    onCommand: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as PlayerBridge
  ;(globalThis as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
  return { setPrefs }
}

beforeEach(() => {
  prepareTranscode.mockClear()
  useAppPrefsStore.setState({
    theme: 'apple',
    closeBehavior: DEFAULT_CLOSE_BEHAVIOR,
    streamQuality: DEFAULT_STREAM_QUALITY,
    error: null,
  })
  useDownloadStore.setState({ entries: {}, localFirst: true, tasks: {}, error: null })
})

afterEach(() => {
  delete (globalThis as { fnPlayer?: PlayerBridge }).fnPlayer
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 播放条
// ---------------------------------------------------------------------------

describe('T54 播放条：标准音质提示', () => {
  it('标准音质准备中 → 显示「正在准备标准音质…」（role=status）', () => {
    render(<PlayerBar store={fakeStore({ qualityPreparing: true })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe(STANDARD_QUALITY_PREPARING_MESSAGE)
    expect(notice.getAttribute('role')).toBe('status')
  })

  it('标准音质不可用 → 显示**灰字**说明（**不是**错误，不报红）', () => {
    render(
      <PlayerBar store={fakeStore({ qualityNote: '标准音质不可用：服务端转码失败，已改用原始音质播放' })} />,
    )
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toContain('标准音质不可用')
    expect(notice.textContent).toContain('已改用原始音质播放')
    expect(notice.getAttribute('role')).toBe('status')
  })

  it('错误优先于标准音质说明（真出错时只显示错误）', () => {
    render(<PlayerBar store={fakeStore({ qualityNote: '标准音质不可用', error: '出错了' })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).toBe('出错了')
    expect(notice.getAttribute('role')).toBe('alert')
  })

  it('「缓冲中」优先于标准音质说明（用户此刻在等数据，先说在等）', () => {
    render(<PlayerBar store={fakeStore({ buffering: true, qualityNote: '标准音质不可用' })} />)
    const notice = screen.getByTestId('player-notice')
    expect(notice.textContent).not.toContain('标准音质不可用')
    expect(notice.getAttribute('role')).toBe('status')
  })
})

// ---------------------------------------------------------------------------
// 设置页
// ---------------------------------------------------------------------------

/** 渲染设置页并**切到「解码」分类**。 */
function renderDecoderSettings(): void {
  render(<SettingsPanel />)
  fireEvent.click(screen.getByRole('button', { name: '解码' }))
}

describe('T54 设置页：音质偏好', () => {
  it('「解码」分类里有「音质偏好」这一组，两档都在', () => {
    installBridge()
    renderDecoderSettings()
    const group = screen.getByRole('group', { name: '音质偏好' })
    expect(group).toBeTruthy()
    expect(screen.getByRole('radio', { name: '原始音质（直拉 NAS 上的原文件，FLAC 无损）' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '标准音质（由 NAS 服务端转码，流量小得多）' })).toBeTruthy()
  })

  it('**默认选中原始音质**（老用户升级后行为一字不变）', () => {
    installBridge()
    renderDecoderSettings()
    const original = screen.getByRole('radio', {
      name: '原始音质（直拉 NAS 上的原文件，FLAC 无损）',
    }) as HTMLInputElement
    const standard = screen.getByRole('radio', {
      name: '标准音质（由 NAS 服务端转码，流量小得多）',
    }) as HTMLInputElement
    expect(original.checked).toBe(true)
    expect(standard.checked).toBe(false)
  })

  it('切到标准音质 → **写回主进程**（`prefs:set` 的 `streamQuality` 键）', async () => {
    const { setPrefs } = installBridge()
    renderDecoderSettings()
    fireEvent.click(
      screen.getByRole('radio', { name: '标准音质（由 NAS 服务端转码，流量小得多）' }),
    )
    await waitFor(() => {
      expect(setPrefs).toHaveBeenCalledWith({ streamQuality: 'standard' })
    })
  })

  it('写回失败 → **回滚**到原值并给出提示', async () => {
    const setPrefs = vi.fn(async () => {
      throw new Error('写不进去')
    })
    installBridge({ setPrefs } as unknown as Partial<PlayerBridge>)
    renderDecoderSettings()
    fireEvent.click(
      screen.getByRole('radio', { name: '标准音质（由 NAS 服务端转码，流量小得多）' }),
    )
    await waitFor(() => {
      expect(useAppPrefsStore.getState().streamQuality).toBe(DEFAULT_STREAM_QUALITY)
    })
    expect(useAppPrefsStore.getState().error).toContain('音质偏好保存失败')
  })
})

// ---------------------------------------------------------------------------
// 播放源准备
// ---------------------------------------------------------------------------

describe('T54 播放源准备', () => {
  it('NAS 曲目 → 走服务端转码，返回产物地址', async () => {
    const { prepareStandardQualitySource } = await import('../src/state/downloadStore')
    const url = await prepareStandardQualitySource(SONG)
    expect(prepareTranscode).toHaveBeenCalledWith(SONG.id, 'standard')
    expect(url).toContain('fnm://srv/download/track/transcode/file')
  })

  it('本地曲目 → **不转码**（NAS 上根本没有这个文件）', async () => {
    const { prepareStandardQualitySource } = await import('../src/state/downloadStore')
    const url = await prepareStandardQualitySource({ ...SONG, id: 'local:0123456789abcdef' })
    expect(prepareTranscode).not.toHaveBeenCalled()
    expect(url).toBe('')
  })

  it('本地有副本且「本地优先」开着 → **不转码**（已经在本地了）', async () => {
    const { prepareStandardQualitySource } = await import('../src/state/downloadStore')
    useDownloadStore.setState({
      entries: {
        [SONG.id]: {
          songId: SONG.id,
          file: 'C:\\Music\\示例歌手 - 示例歌名.flac',
          bytes: 2048,
          ext: 'flac',
          downloadedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      localFirst: true,
    })
    const url = await prepareStandardQualitySource(SONG)
    expect(prepareTranscode).not.toHaveBeenCalled()
    expect(url).toBe('')
  })

  it('本地有副本但「本地优先」关着 → **照样转码**（走的是 NAS 流，流量要省）', async () => {
    const { prepareStandardQualitySource } = await import('../src/state/downloadStore')
    useDownloadStore.setState({
      entries: {
        [SONG.id]: {
          songId: SONG.id,
          file: 'C:\\Music\\示例歌手 - 示例歌名.flac',
          bytes: 2048,
          ext: 'flac',
          downloadedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      localFirst: false,
    })
    await prepareStandardQualitySource(SONG)
    expect(prepareTranscode).toHaveBeenCalledWith(SONG.id, 'standard')
  })
})
