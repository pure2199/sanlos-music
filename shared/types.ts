// 跨进程共享类型：主进程（Electron）与渲染进程（React）同时使用。
// 本文件只能是纯类型，不得引入 Electron API、Node 内置模块或 DOM 类型。

/** 界面主题名。 */
export type ThemeName = 'apple' | 'fluent'

/** 播放模式。 */
export type PlayMode = 'sequence' | 'shuffle' | 'loop-one' | 'loop-list'

/**
 * 音质档位（T54）。
 *
 * - `original`：**原始音质**——直拉 NAS 上的原文件（FLAC / MP3 …），**既有行为**；
 * - `standard`：**标准音质**——让 NAS 服务端转码（官方旧下载协议里 = MP3 320k），
 *   流量小得多。
 *
 * ⚠️ **缺省 = `original`** → 老用户升级后行为**一字不变**。
 * ⚠️ 服务端**只认这两个值**（`higher` / `exhigh` 会被拒：`code=100002`），
 *    也没有 192k 那一档。
 */
export type StreamQuality = 'original' | 'standard'

/** 链路类型：内网直连 / 公网直连 / FN 中继。 */
export type ConnectionKind = 'lan' | 'public' | 'relay'

/** 一条预置 EQ 曲线。 */
export interface EqPreset {
  /** 界面展示名。 */
  label: string
  /** 10 段预置增益（dB），与 `EQ_BANDS_10` 一一对应。 */
  gains: number[]
  /**
   * 15 段预置增益（dB），与 `EQ_BANDS_15` 一一对应。
   *
   * 取用规则（Task 21）：段数为 10 时取 `gains`，段数为 15 时取 `gains15`；
   * 两套频点不同（`EQ_BANDS_10` / `EQ_BANDS_15`），不可互相切片。
   */
  gains15: number[]
}

/** 音频规格（服务端 `audioSpec` 原始字段，稀疏且可能缺项）。 */
export interface AudioSpec {
  /** 位深（bit）。 */
  bitDepth: number | null
  /** 采样率（Hz）。 */
  sampleRate: number | null
  /** 声道数。 */
  channel: number | null
  /** 比特率（**比特/秒 bps**，实测）。 */
  bitrate: number | null
  /** 编码格式，如 `flac` / `mp3` / `alac`。 */
  codec: string | null
  /** 容器格式，如 `flac` / `mp3`。 */
  container: string | null
  /** 时长（毫秒，服务端原始值；注意与 `Song.duration` 的「秒」不同）。 */
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
  /** 封面 id（实测 `genre/list` 返回 coverId 为 null；无封面为 `null`，与 `Song.coverId` 用空串 `''` 的约定不同）。 */
  coverId: string | null
  /** 该风格下的歌曲数。 */
  trackCount: number
}

/**
 * 歌曲。
 *
 * **实测（2026-11-02，真实 NAS）**：服务端歌曲对象为
 * `{ guid, title, coverId, year, discNo, trackNo, isrc, duration, isCue, createdAt, updatedAt, album: { guid, name, coverId, releaseDate, barcode, createdAt, updatedAt }, artists: [{ guid, name, coverId, createdAt, updatedAt }], genres: [], audioSpec: {...}, isFavorite }`。
 * 关键点：`duration` 毫秒；`coverId` 形如 `track_<hex>` / `album_<hex>` / `artist_<hex>`（或 `null`）；`createdAt` / `updatedAt` 是 **Unix 秒**；`isFavorite` 是服务端给出的收藏态。
 */
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
  /** 封面 id；无封面时置空串 `''`（领域模型统一用空串，不用 null）。 */
  coverId: string
  /**
   * 时长，单位**秒**。
   *
   * 服务端原始值为毫秒（实测），由 Task 6 的 `mapSong` 做毫秒 → 秒转换后写入本字段；
   * `PlayerState.duration` / `position` 同为秒。本字段不是原始毫秒值，切勿直接当毫秒使用。
   */
  duration: number
  /** 是否已收藏（来自服务端 `isFavorite` 字段，实测存在）。 */
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

/**
 * 专辑。
 *
 * **实测（2026-11-02，真实 NAS）**：服务端专辑对象为
 * `{ guid, name, coverId, releaseDate, barcode, createdAt, updatedAt, artists: [{ guid, name, coverId, createdAt, updatedAt }], trackCount }`。
 * 注意两点：
 * 1. **没有 `year` 字段** —— 只有 `releaseDate`（形如 `"2005-04-01"`，或 `null`）。本字段由 Task 6 的 `mapAlbum` 从 `releaseDate` 的前 4 位派生，缺失时为 `null`。
 * 2. `createdAt` / `updatedAt` 是 **Unix 秒**（如 `1792563278`），不是 ISO 字符串。
 */
export interface Album {
  /** 专辑 guid。 */
  id: string
  /** 专辑名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 歌手 guid。 */
  artistId: string
  /** 封面 id；无封面为 `null`（与 `Song.coverId` 用空串 `''` 的约定不同）。 */
  coverId: string | null
  /** 发行年份；由 `releaseDate` 派生，缺失时为 `null`。 */
  year: number | null
  /** 歌曲数。 */
  trackCount: number
  /** 发行日期（实测原始字段，可能是 `null`）。 */
  releaseDate?: string | null
}

/**
 * 歌手。
 *
 * **实测（2026-11-02，真实 NAS）**：服务端歌手对象为
 * `{ guid, name, coverId, createdAt, updatedAt, trackCount, albumCount }`。
 * `coverId` 实测多为 `artist_<hex>` 或 `track_<hex>`（也可能是 `null`）；`createdAt` / `updatedAt` 是 **Unix 秒**。
 */
export interface Artist {
  /** 歌手 guid。 */
  id: string
  /** 歌手名。 */
  name: string
  /** 头像/封面 id；无封面为 `null`（与 `Song.coverId` 用空串 `''` 的约定不同）。 */
  coverId: string | null
  /** 专辑数。 */
  albumCount: number
  /** 歌曲数。 */
  trackCount: number
}

/**
 * 歌单。
 *
 * **实测（2026-11-02，真实 NAS）**：该账号的 `GET /playlist/list` 返回**空列表**，
 * 因此歌单的字段形状**仍未实测**，以下字段集按规格语义推导，待创建歌单后补测校准。
 *
 * 服务端使用 `guid` / `name` 字段，`guid → id`、`name → name` 的映射由 Task 6 负责。
 */
export interface Playlist {
  /** 歌单 guid（服务端字段为 `guid`，映射由 Task 6 负责）。 */
  id: string
  /** 歌单名（服务端字段为 `name`）。 */
  name: string
  /** 封面 id；无封面为 `null`（与 `Song.coverId` 用空串 `''` 的约定不同）。 */
  coverId: string | null
  /** 歌曲数。 */
  trackCount: number
  /** 描述（未实测，待创建歌单后校准）。 */
  description?: string | null
  /** 创建时间（未实测，待创建歌单后校准）。 */
  createdAt?: string | null
  /** 更新时间（未实测，待创建歌单后校准）。 */
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
  /** 播放进度（秒，与 `Song.duration` 同单位）。 */
  position: number
  /** 当前曲目总时长（秒，与 `Song.duration` 同单位）。 */
  duration: number
  /** 音量（0~1）。 */
  volume: number
  /** 播放模式。 */
  mode: PlayMode
  /** 是否静音。 */
  muted?: boolean
  /** 播放错误信息。 */
  error?: string | null
  /**
   * 是否**缓冲中**（T37）。
   *
   * ⚠️ **这不是错误**：媒体元素的 `stalled` / `waiting` 只是「数据一时没到」的
   *    **瞬时提示**——播放通常会自行恢复。界面据此显示**灰字**「缓冲中…」，
   *    数据到了自动消失；**不许**当成错误报红。
   *
   * ⚠️ **可选**：没在缓冲时是 `false` / `undefined`。
   */
  buffering?: boolean
  /**
   * 是否正在做**兜底转码**（Task 12）。
   *
   * ⚠️ **可选**：没走兜底时是 `false` / `undefined`。
   */
  preparing?: boolean
  /**
   * 当前这一曲是不是**兜底转码产物**在播（Task 12）。
   *
   * ⚠️ 界面据此如实注明「音质有损」——**不许**让用户以为在听原始无损文件。
   */
  fallbackActive?: boolean
  /**
   * 是否正在准备**标准音质**（T54：服务端转码中）。
   *
   * ⚠️ 与 `preparing`（客户端兜底转码）是**两件事**：那个转的是本地文件，
   *    这个转的是**服务端**产物（省流量）。
   * ⚠️ **可选**：没在准备时是 `false` / `undefined`。
   */
  qualityPreparing?: boolean
  /**
   * 「标准音质」**不可用**时的说明（T54）。
   *
   * ⚠️ 这**不是错误**：标准音质失败时**自动回退原始音质**、音乐照常播放，
   *    这里只是**如实说明为什么没走标准音质**（界面显示**灰字**，不是红字）。
   * ⚠️ **可选**：没有说明时是 `null` / `undefined`。
   */
  qualityNote?: string | null
  /**
   * **可听延迟**（秒）：媒体内容渲染完成 → 用户真正听到之间的延迟（T66）。
   *
   * ⚠️ 歌词据此**整体延后**（详见 `src/ui/lyrics/timing.ts`）。
   * ⚠️ **可选**：拿不到 / 未播放时是 `0` 或 `undefined` ⇒ **不补偿**。
   */
  outputLatencySec?: number
}
