// 跨进程共享类型：主进程（Electron）与渲染进程（React）同时使用。
// 本文件只能是纯类型，不得引入 Electron API、Node 内置模块或 DOM 类型。

/** 界面主题名。 */
export type ThemeName = 'apple' | 'fluent'

/** 播放模式。 */
export type PlayMode = 'sequence' | 'shuffle' | 'loop-one' | 'loop-list'

/** 链路类型：内网直连 / 公网直连 / FN 中继。 */
export type ConnectionKind = 'lan' | 'public' | 'relay'

/** 一条预置 EQ 曲线。 */
export interface EqPreset {
  /** 界面展示名。 */
  label: string
  /** 10 段预置增益（dB），与 `EQ_BANDS_10` 一一对应。 */
  gains: number[]
  /** 15 段预置增益（dB），与 `EQ_BANDS_15` 一一对应。 */
  gains15?: number[]
}

/** 音频规格（服务端 `audioSpec` 原始字段，稀疏且可能缺项）。 */
export interface AudioSpec {
  /** 位深（bit）。 */
  bitDepth: number | null
  /** 采样率（Hz）。 */
  sampleRate: number | null
  /** 声道数。 */
  channel: number | null
  /** 比特率（kbps）。 */
  bitrate: number | null
  /** 编码格式，如 `flac` / `mp3` / `alac`。 */
  codec: string | null
  /** 容器格式，如 `flac` / `mp3`。 */
  container: string | null
  /** 时长（毫秒）。 */
  duration: number | null
  /** 容器/扩展名，如 `flac`。 */
  format: string | null
  /** NAS 上的文件路径。 */
  path: string | null
  /** 文件大小（字节）。 */
  size: number | null
}

/** 风格（实测：风格名存在大小写重复，如 `Pop` 与 `POP`，故 guid 与 name 各自独立）。 */
export interface Genre {
  /** 风格唯一标识，查询时使用。 */
  guid: string
  /** 风格原始名称（保留服务端大小写）。 */
  name: string
  /** 封面 id（实测可能为 null）。 */
  coverId: string | null
  /** 该风格下的歌曲数。 */
  trackCount: number
}

/** 歌曲。 */
export interface Song {
  /** 歌曲 guid。 */
  id: string
  /** 歌曲名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 歌手 guid。 */
  artistId: string
  /** 专辑名。 */
  album: string
  /** 专辑 guid。 */
  albumId: string
  /** 封面 id。 */
  coverId: string
  /** 时长，单位毫秒（实测）。 */
  duration: number
  /** 是否已收藏。 */
  favorite: boolean
  /** 编码格式，如 `FLAC`。 */
  codec: string
  /** 比特率（kbps）。 */
  bitrate: number
  /** 采样率（Hz）。 */
  sampleRate: number
  /** 位深（bit）。 */
  bitDepth: number
  /** 发行年份（实测可能为 null，不是 0）。 */
  year: number | null
  /** 碟内曲号（实测可能为 null）。 */
  trackNo: number | null
  /** 碟号（实测可能为 null）。 */
  discNo: number | null
  /** 发行日期（实测可能为 null）。 */
  releaseDate?: string | null
  /** 风格列表（实测歌曲对象内恒为空数组，风格需单独查询）。 */
  genres?: Genre[]
  /** 音频规格明细。 */
  audioSpec?: AudioSpec
}

/** 专辑。 */
export interface Album {
  /** 专辑 guid。 */
  id: string
  /** 专辑名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 歌手 guid。 */
  artistId: string
  /** 封面 id（实测可能为 null）。 */
  coverId: string | null
  /** 发行年份（实测可能为 null）。 */
  year: number | null
  /** 歌曲数。 */
  trackCount: number
  /** 发行日期（实测可能为 null）。 */
  releaseDate?: string | null
}

/** 歌手。 */
export interface Artist {
  /** 歌手 guid。 */
  id: string
  /** 歌手名。 */
  name: string
  /** 头像/封面 id（实测可能为 null）。 */
  coverId: string | null
  /** 专辑数。 */
  albumCount: number
  /** 歌曲数。 */
  trackCount: number
}

/** 歌单。 */
export interface Playlist {
  /** 歌单 guid。 */
  id: string
  /** 歌单名。 */
  name: string
  /** 封面 id（实测可能为 null）。 */
  coverId: string | null
  /** 歌曲数。 */
  trackCount: number
  /** 描述（实测可能为 null）。 */
  description?: string | null
  /** 创建时间。 */
  createdAt?: string | null
  /** 更新时间。 */
  updatedAt?: string | null
}

/** 当前生效的连接链路信息。 */
export interface ConnectionInfo {
  /** 链路类型。 */
  kind: ConnectionKind
  /** 基址，形如 `https://host:port/music`。 */
  url: string
  /** 界面展示名。 */
  label: string
  /** 是否走 FN 中继（中继请求需附 `mode=relay` Cookie）。 */
  isRelay: boolean
  /** 链路带宽提示（仅中继链路有值）。 */
  bandwidthHint?: string
}

/** 播放器状态（经 IPC 在主进程与渲染进程之间同步）。 */
export interface PlayerState {
  /** 当前曲目，未播放时为 null。 */
  current: Song | null
  /** 播放队列。 */
  queue: Song[]
  /** 是否正在播放。 */
  isPlaying: boolean
  /** 播放进度（秒）。 */
  position: number
  /** 当前曲目总时长（秒）。 */
  duration: number
  /** 音量（0~1）。 */
  volume: number
  /** 播放模式。 */
  mode: PlayMode
  /** 是否静音。 */
  muted?: boolean
  /** 播放错误信息。 */
  error?: string | null
}
