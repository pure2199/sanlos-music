// ---------------------------------------------------------------------------
// T38 播放源解析与曲目映射（渲染层）
// ---------------------------------------------------------------------------
//
// 覆盖：
// - **本地曲目**（`local:` 前缀）→ 直接 `fnml://`（**不走 NAS**，与「本地优先」开关无关）；
// - **NAS 曲目** → 既有行为**一字不变**（命中下载索引且开关打开 → `fnml://`，
//   否则 → `fnm://srv/track/stream?guid=…`）；
// - **`downloadEntryToSong`**：新条目用**快照**（精确），老条目回落**文件名反推**（近似）；
// - **`localItemToSong`**：形状正确（无封面、时长 0、扩展名进 `codec`）。
//
// ⚠️ 测试数据一律用占位值，不写真实路径 / 歌名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest'

import type { Song } from '../shared/types'
import type { DownloadEntry, LocalLibraryItem } from '../shared/playerBridge'
import { localMediaUrl } from '../shared/localMedia'
import {
  downloadEntryToSong,
  resolvePlaybackSource,
  useDownloadStore,
} from '../src/state/downloadStore'
import { localItemToSong } from '../src/state/localLibraryStore'

const NAS_SONG_ID = 'track_example01'
const LOCAL_ID = 'local:0123456789abcdef'

const NAS_SONG: Song = {
  id: NAS_SONG_ID,
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

/** 已下载条目（**老条目**：没有 title / artist 快照）。 */
const LEGACY_ENTRY: DownloadEntry = {
  songId: NAS_SONG_ID,
  file: 'C:\\Music\\飞牛音乐\\示例歌手 - 示例歌名.flac',
  bytes: 2048,
  ext: 'flac',
  downloadedAt: '2026-01-01T00:00:00.000Z',
}

/** 已下载条目（**新条目**：带 title / artist 快照）。 */
const SNAPSHOT_ENTRY: DownloadEntry = {
  ...LEGACY_ENTRY,
  title: '快照歌名',
  artist: '快照歌手',
}

/** 本地曲目登记项。 */
const LOCAL_ITEM: LocalLibraryItem = {
  id: LOCAL_ID,
  path: 'D:\\Music\\本地歌手 - 本地歌名.flac',
  title: '本地歌名',
  artist: '本地歌手',
  size: 4096,
  ext: 'flac',
  addedAt: '2026-01-01T00:00:00.000Z',
}

beforeEach(() => {
  useDownloadStore.setState({ entries: {}, localFirst: true, tasks: {}, error: null })
})

describe('T38 播放源解析', () => {
  it('本地曲目 → 直接 `fnml://`（**不走 NAS**）', () => {
    const song: Song = { ...NAS_SONG, id: LOCAL_ID }
    expect(resolvePlaybackSource(song)).toBe(localMediaUrl(LOCAL_ID))
  })

  it('本地曲目 → **与「本地优先」开关无关**（关掉了也照样本地播）', () => {
    useDownloadStore.setState({ localFirst: false })
    const song: Song = { ...NAS_SONG, id: LOCAL_ID }
    expect(resolvePlaybackSource(song)).toBe(localMediaUrl(LOCAL_ID))
  })

  it('NAS 曲目：本地有副本且开关打开 → `fnml://`（**既有行为不变**）', () => {
    useDownloadStore.setState({ entries: { [NAS_SONG_ID]: LEGACY_ENTRY }, localFirst: true })
    expect(resolvePlaybackSource(NAS_SONG)).toBe(localMediaUrl(NAS_SONG_ID))
  })

  it('NAS 曲目：没有本地副本 → 照旧走 `fnm://` 流式地址（**既有行为不变**）', () => {
    useDownloadStore.setState({ entries: {}, localFirst: true })
    expect(resolvePlaybackSource(NAS_SONG)).toBe(`fnm://srv/track/stream?guid=${NAS_SONG_ID}`)
  })

  it('NAS 曲目：开关关掉 → 照旧走 `fnm://`（**既有行为不变**）', () => {
    useDownloadStore.setState({ entries: { [NAS_SONG_ID]: LEGACY_ENTRY }, localFirst: false })
    expect(resolvePlaybackSource(NAS_SONG)).toBe(`fnm://srv/track/stream?guid=${NAS_SONG_ID}`)
  })
})

describe('T38 已下载条目 → Song', () => {
  it('**新条目**用快照（歌名 / 歌手精确）', () => {
    const song = downloadEntryToSong(SNAPSHOT_ENTRY)
    expect(song.title).toBe('快照歌名')
    expect(song.artist).toBe('快照歌手')
    expect(song.id).toBe(NAS_SONG_ID)
  })

  it('**老条目**（没有快照）→ 用文件名反推兜底（近似值）', () => {
    const song = downloadEntryToSong(LEGACY_ENTRY)
    expect(song.title).toBe('示例歌名')
    expect(song.artist).toBe('示例歌手')
  })

  it('没有封面、时长 0（本地文件没解析标签）', () => {
    const song = downloadEntryToSong(LEGACY_ENTRY)
    expect(song.coverId).toBe('')
    expect(song.duration).toBe(0)
  })

  it('扩展名进 `codec` 与 `audioSpec.format`（Chromium 播不了的格式能走 FFmpeg 兜底）', () => {
    const song = downloadEntryToSong(LEGACY_ENTRY)
    expect(song.codec).toBe('flac')
    expect(song.audioSpec?.format).toBe('flac')
  })
})

describe('T38 本地曲目 → Song', () => {
  it('形状正确：id / 歌名 / 歌手来自登记项', () => {
    const song = localItemToSong(LOCAL_ITEM)
    expect(song.id).toBe(LOCAL_ID)
    expect(song.title).toBe('本地歌名')
    expect(song.artist).toBe('本地歌手')
  })

  it('没有封面、时长 0、专辑空', () => {
    const song = localItemToSong(LOCAL_ITEM)
    expect(song.coverId).toBe('')
    expect(song.duration).toBe(0)
    expect(song.album).toBe('')
  })

  it('扩展名进 `codec` 与 `audioSpec.format`', () => {
    const song = localItemToSong(LOCAL_ITEM)
    expect(song.codec).toBe('flac')
    expect(song.audioSpec?.format).toBe('flac')
    expect(song.audioSpec?.path).toBe(LOCAL_ITEM.path)
  })
})
