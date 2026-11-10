// Mock server 的服务端**原始 JSON** fixtures。
//
// 重要：本文件里的对象是**飞牛音乐服务端返回的原始形状**，不是 `shared/types.ts` 的领域模型。
// 领域模型（`Song` / `Album` / …）由 Task 6 的 `mapSong` / `mapAlbum` 负责从这些原始字段转换而来，
// 因此这里的字段名用服务端的 `guid` / `name` / `coverId` / `audioSpec`，而不是领域模型的 `id` / `title`。
//
// ⚠️ **字段形状以规格 §15.7（2026-11-02 二次联调实测）为准**：
// - 歌曲 `{ guid, title, coverId, year, discNo, trackNo, isrc, duration, isCue,
//   createdAt, updatedAt, album{...}, artists[{...}], genres: [], audioSpec{...}, isFavorite }`；
// - 专辑 `{ guid, name, coverId, releaseDate, barcode, createdAt, updatedAt, artists[{...}], trackCount }`
//   —— **没有 `year`**，只有 `releaseDate`；
// - 歌手 `{ guid, name, coverId, createdAt, updatedAt, trackCount, albumCount }`；
// - 歌手条目（出现在 `album.artists` / `song.artists` 里）`{ guid, name, coverId, createdAt, updatedAt }`；
// - 收藏条目 / 播放历史条目 = **完整歌曲对象**（不是 `{ track: … }` 包装）；
// - 风格 `{ guid, name, coverId(null), trackCount }`；
// - `duration` 与 `audioSpec.duration` 的单位是**毫秒**；
// - `audioSpec.bitrate` 的单位是**比特/秒（bps）**（领域模型 `Song.bitrate` 是 kbps，映射时 ÷1000）；
// - `createdAt` / `updatedAt` 是 **Unix 秒**（不是 ISO 字符串）；
// - `coverId` 形如 `track_<hex>` / `album_<hex>` / `artist_<hex>`（无封面为 `null`）；
// - `audioSpec.container` 实测为空串 `""`；`audioSpec.path` 是 NAS 绝对路径。
//
// 保留的边界覆盖（Task 5 审查确认过的，不要丢）：
// - t2 / t4 无封面（coverId 为 `null`）；a2 无头像；
// - t2 / t6 的 year / trackNo / discNo 为 `null`；al3 的 releaseDate 为 `null`；
// - t2 / t4 为多歌手；
// - t3 缺 `bitrate` 与 `sampleRate`，t8 缺 `sampleRate`（稀疏 audioSpec）；
// - 风格名大小写重复（`Pop` 与 `POP`），故 guid 与 name 各自独立；
// - `isFavorite` 有 `true` 也有 `false` 两种样本。

/** 服务端原始命名引用（歌曲里的歌手、专辑对象里的歌手、歌曲内嵌的专辑）。 */
export interface RawRef {
  /** 唯一标识。 */
  guid: string
  /** 名称。 */
  name: string
  /** 头像 / 封面 id（无则 `null`）。 */
  coverId?: string | null
  /** 发行日期（内嵌专辑有）。 */
  releaseDate?: string | null
  /** 条码（内嵌专辑有）。 */
  barcode?: string | null
  /** 创建时间（Unix 秒）。 */
  createdAt?: number | null
  /** 更新时间（Unix 秒）。 */
  updatedAt?: number | null
}

/** 服务端原始音频规格（稀疏，字段可能缺失或为 null）。 */
export interface RawAudioSpec {
  /** 位深（bit）。 */
  bitDepth?: number | null
  /** 采样率（Hz）。 */
  sampleRate?: number | null
  /** 声道数。 */
  channel?: number | null
  /** 比特率（**bps**，比特/秒）。 */
  bitrate?: number | null
  /** 编码格式。 */
  codec?: string | null
  /** 容器格式（实测为空串）。 */
  container?: string | null
  /** 时长（毫秒）。 */
  duration?: number | null
  /** 容器 / 扩展名。 */
  format?: string | null
  /** NAS 上的文件路径（绝对路径）。 */
  path?: string | null
  /** 文件大小（字节）。 */
  size?: number | null
}

/** 服务端原始风格。 */
export interface RawGenre {
  /** 风格 guid。 */
  guid: string
  /** 风格原始名称（保留服务端大小写）。 */
  name: string
  /** 封面 id；实测为 null。 */
  coverId: string | null
  /** 该风格下的歌曲数。 */
  trackCount: number
}

/** 服务端原始歌曲。 */
export interface RawSong {
  /** 歌曲 guid。 */
  guid: string
  /** 歌曲名。 */
  title: string
  /** 时长（**毫秒**）。 */
  duration: number
  /** 封面 id；无封面为 null（形如 `track_<hex>`）。 */
  coverId: string | null
  /** 歌手列表（可能多歌手）。 */
  artists: RawRef[]
  /** 所属专辑（内嵌完整专辑对象）。 */
  album: RawRef
  /** 音频规格（稀疏）。 */
  audioSpec: RawAudioSpec
  /** 发行年份，可能为 null。 */
  year: number | null
  /** 碟内曲号，可能为 null。 */
  trackNo: number | null
  /** 碟号，可能为 null。 */
  discNo: number | null
  /** 国际标准录音码。 */
  isrc: string | null
  /** 是否为 cue 切片。 */
  isCue: boolean
  /** 创建时间（Unix 秒）。 */
  createdAt: number
  /** 更新时间（Unix 秒）。 */
  updatedAt: number
  /** 风格列表（实测恒为空数组）。 */
  genres: RawGenre[]
  /** **服务端给出的收藏态**（实测 true / false 都有）。 */
  isFavorite: boolean
}

/** 服务端原始专辑（**没有 `year` 字段**，只有 `releaseDate`）。 */
export interface RawAlbum {
  /** 专辑 guid。 */
  guid: string
  /** 专辑名。 */
  name: string
  /** 封面 id；无封面为 null（形如 `album_<hex>`）。 */
  coverId: string | null
  /** 发行日期，可能为 null。 */
  releaseDate: string | null
  /** 条码。 */
  barcode: string | null
  /** 创建时间（Unix 秒）。 */
  createdAt: number
  /** 更新时间（Unix 秒）。 */
  updatedAt: number
  /** 专辑歌手。 */
  artists: RawRef[]
  /** 歌曲数。 */
  trackCount: number
}

/** 服务端原始歌手。 */
export interface RawArtist {
  /** 歌手 guid。 */
  guid: string
  /** 歌手名。 */
  name: string
  /** 头像 id；无封面为 null（形如 `artist_<hex>`）。 */
  coverId: string | null
  /** 创建时间（Unix 秒）。 */
  createdAt: number
  /** 更新时间（Unix 秒）。 */
  updatedAt: number
  /** 专辑数。 */
  albumCount: number
  /** 歌曲数。 */
  trackCount: number
}

/** 服务端原始歌单（⚠️ 该账号 `playlist/list` 返回空列表，形状仍未实测）。 */
export interface RawPlaylist {
  /** 歌单 guid。 */
  guid: string
  /** 歌单名。 */
  name: string
  /** 封面 id；无封面为 null。 */
  coverId: string | null
  /** 歌曲数。 */
  trackCount: number
  /** 描述，可能为 null。 */
  description: string | null
  /** 创建时间（Unix 秒；形状未实测，故可空）。 */
  createdAt: number | null
  /** 更新时间（Unix 秒；形状未实测，故可空）。 */
  updatedAt: number | null
}

/** 服务端原始歌词条目。 */
export interface RawLyric {
  /** 歌词 guid。 */
  guid: string
  /** 来源（如 `local`）。 */
  source: string
  /** LRC 原文。 */
  content: string
  /** 创建时间（Unix 秒）。 */
  createdAt: number
  /** 更新时间（Unix 秒）。 */
  updatedAt: number
  /** 是否为 LRC 格式。 */
  isLRC: boolean
  /** 时间偏移（毫秒）。 */
  offset: number
}

// ---------------------------------------------------------------------------
// 时间戳常量（Unix 秒）
//
// 固定值而不是 `Date.now()`：fixtures 必须可复现，且能断言归一后的 ISO 串。
// ---------------------------------------------------------------------------

/** 基准时间戳（Unix 秒）：2026-10-21T08:54:38Z。 */
const T0 = 1792563278

// ---------------------------------------------------------------------------
// 系统配置（`GET /music/api/v1/sys/config`）
// ---------------------------------------------------------------------------

/**
 * `sys/config` 的返回内容（**服务端原始形状**）。
 *
 * ⚠️ **实测（规格 §15.8，2026-11-02 真实 NAS）**：
 * - 真实路径是 **`/music/api/v1/sys/config`**（在音乐 API 前缀下）；
 *   实测 `/sys/config` → **HTTP 404 + HTML**。
 * - 真实 `data` 形如
 *   `{ nasOAuth: { clientId: 'EDDLUH2WLY' }, serverGUID, serverName, serverVersion,
 *      mediasrvVersion, capabilities: { folderView, libraryReconnect } }`
 *   —— `nasOAuth` 里**没有** `url` 字段（授权地址由客户端自行拼装，Task 11）。
 *
 * `musicEnabled` / `musicVersion` / `supportRelay` 是早期 mock 自己加的字段：
 * 与真实响应不冲突，故保留（删掉只会让依赖它们的旧用例无谓地变红）。
 *
 * ⚠️ `nasOAuth.clientId` **必须存在**：客户端据此判断「是否支持 NAS 账号登录」，
 *    缺了这个字段 `supportsNasLogin` 永远是 `false`。
 */
export const SYS_CONFIG = {
  nasOAuth: { clientId: 'EDDLUH2WLY' },
  serverGUID: 'mock-server-guid',
  serverName: '纯音乐',
  serverVersion: '1.0.10',
  mediasrvVersion: '0.8.43',
  capabilities: { folderView: false, libraryReconnect: true },
  // 早期 mock 的自定义字段（保留，见上方说明）
  musicEnabled: true,
  musicVersion: '1.0.0',
  supportRelay: true,
}

// ---------------------------------------------------------------------------
// 专辑（3 张，al1–al3）
// ---------------------------------------------------------------------------

/** 示例专辑集合。 */
export const ALBUMS: RawAlbum[] = [
  {
    guid: 'al1',
    name: '示例专辑一',
    coverId: 'album_0123456789abcdef',
    releaseDate: '2003-07-31',
    barcode: '6941234567890',
    createdAt: T0,
    updatedAt: T0,
    artists: [
      {
        guid: 'a1',
        name: '示例歌手甲',
        coverId: 'artist_0123456789abcdef',
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    trackCount: 4,
  },
  {
    guid: 'al2',
    name: '示例专辑二',
    coverId: 'album_fedcba9876543210',
    releaseDate: '2005-04-01',
    barcode: '6941234567891',
    createdAt: T0,
    updatedAt: T0,
    artists: [
      {
        guid: 'a2',
        name: '示例歌手乙',
        coverId: null,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    trackCount: 3,
  },
  {
    // 无封面、无发行日期 → 领域模型的 year 派生不出来，保持 null。
    guid: 'al3',
    name: '示例专辑三',
    coverId: null,
    releaseDate: null,
    barcode: null,
    createdAt: T0,
    updatedAt: T0,
    artists: [
      {
        guid: 'a1',
        name: '示例歌手甲',
        coverId: 'artist_0123456789abcdef',
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    trackCount: 1,
  },
]

// ---------------------------------------------------------------------------
// 歌手（2 个，a1–a2）
// ---------------------------------------------------------------------------

/** 示例歌手集合。 */
export const ARTISTS: RawArtist[] = [
  {
    guid: 'a1',
    name: '示例歌手甲',
    coverId: 'artist_0123456789abcdef',
    createdAt: T0,
    updatedAt: T0,
    albumCount: 2,
    trackCount: 6,
  },
  {
    // 无头像（封面为 null）。
    guid: 'a2',
    name: '示例歌手乙',
    coverId: null,
    createdAt: T0,
    updatedAt: T0,
    albumCount: 1,
    trackCount: 4,
  },
]

// ---------------------------------------------------------------------------
// 曲目（8 首，t1–t8）
//
// 覆盖的边界：
// - t2 / t4 无封面（coverId 为 null）；
// - t2 / t6 的 year / trackNo / discNo 为 null；
// - t2 / t4 为多歌手；
// - t3 缺 `bitrate` 与 `sampleRate`，t8 缺 `sampleRate`（稀疏 audioSpec）；
// - t1 / t4 的 `isFavorite` 为 true，其余为 false；
// - t6 所在专辑 al3 的 releaseDate 为 null。
// ---------------------------------------------------------------------------

/** 示例曲目集合。 */
export const SONGS: RawSong[] = [
  {
    guid: 't1',
    title: '示例曲目 1',
    duration: 185000,
    coverId: 'track_0123456789abcdef',
    artists: [
      { guid: 'a1', name: '示例歌手甲', coverId: 'artist_0123456789abcdef', createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al1',
      name: '示例专辑一',
      coverId: 'album_0123456789abcdef',
      releaseDate: '2003-07-31',
      barcode: '6941234567890',
      createdAt: T0,
      updatedAt: T0,
    },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 900000,
      codec: 'flac',
      container: '',
      duration: 185000,
      format: 'flac',
      path: '/vol02/1000-0-music/sample/t1.flac',
      size: 30000000,
    },
    year: 2003,
    trackNo: 3,
    discNo: 1,
    isrc: 'CNA120300001',
    isCue: false,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: true,
  },
  {
    guid: 't2',
    title: '示例曲目 2',
    duration: 212500,
    coverId: null,
    artists: [
      { guid: 'a1', name: '示例歌手甲', coverId: 'artist_0123456789abcdef', createdAt: T0, updatedAt: T0 },
      { guid: 'a2', name: '示例歌手乙', coverId: null, createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al1',
      name: '示例专辑一',
      coverId: 'album_0123456789abcdef',
      releaseDate: '2003-07-31',
      barcode: '6941234567890',
      createdAt: T0,
      updatedAt: T0,
    },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 320000,
      codec: 'mp3',
      container: '',
      duration: 212500,
      format: 'mp3',
      path: '/vol02/1000-0-music/sample/t2.mp3',
      size: 8500000,
    },
    year: null,
    trackNo: null,
    discNo: null,
    isrc: null,
    isCue: false,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: false,
  },
  {
    guid: 't3',
    title: '示例曲目 3',
    duration: 198000,
    coverId: 'track_fedcba9876543210',
    artists: [
      { guid: 'a2', name: '示例歌手乙', coverId: null, createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al2',
      name: '示例专辑二',
      coverId: 'album_fedcba9876543210',
      releaseDate: '2005-04-01',
      barcode: '6941234567891',
      createdAt: T0,
      updatedAt: T0,
    },
    // 稀疏 audioSpec：实测服务端会缺 bitrate / sampleRate。
    audioSpec: {
      bitDepth: null,
      channel: 2,
      codec: 'aac',
      container: '',
      duration: 198000,
      format: 'm4a',
      path: '/vol02/1000-0-music/sample/t3.m4a',
      size: 4200000,
    },
    year: 2005,
    trackNo: 1,
    discNo: 1,
    isrc: 'CNA120500003',
    isCue: false,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: false,
  },
  {
    guid: 't4',
    title: '示例曲目 4',
    duration: 240000,
    coverId: null,
    artists: [
      { guid: 'a2', name: '示例歌手乙', coverId: null, createdAt: T0, updatedAt: T0 },
      { guid: 'a1', name: '示例歌手甲', coverId: 'artist_0123456789abcdef', createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al2',
      name: '示例专辑二',
      coverId: 'album_fedcba9876543210',
      releaseDate: '2005-04-01',
      barcode: '6941234567891',
      createdAt: T0,
      updatedAt: T0,
    },
    audioSpec: {
      bitDepth: 24,
      sampleRate: 96000,
      channel: 2,
      bitrate: 1400000,
      codec: 'flac',
      container: '',
      duration: 240000,
      format: 'flac',
      path: '/vol02/1000-0-music/sample/t4.flac',
      size: 42000000,
    },
    year: 2005,
    trackNo: 2,
    discNo: 1,
    isrc: 'CNA120500004',
    isCue: false,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: true,
  },
  {
    guid: 't5',
    title: '示例曲目 5',
    duration: 176400,
    coverId: 'track_1122334455667788',
    artists: [
      { guid: 'a1', name: '示例歌手甲', coverId: 'artist_0123456789abcdef', createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al2',
      name: '示例专辑二',
      coverId: 'album_fedcba9876543210',
      releaseDate: '2005-04-01',
      barcode: '6941234567891',
      createdAt: T0,
      updatedAt: T0,
    },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 900000,
      codec: 'flac',
      container: '',
      duration: 176400,
      format: 'flac',
      path: '/vol02/1000-0-music/sample/t5.flac',
      size: 29000000,
    },
    year: 2005,
    trackNo: 3,
    discNo: 1,
    isrc: 'CNA120500005',
    isCue: false,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: false,
  },
  {
    guid: 't6',
    title: '示例曲目 6',
    duration: 203000,
    coverId: 'track_8899aabbccddeeff',
    artists: [
      { guid: 'a2', name: '示例歌手乙', coverId: null, createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al3',
      name: '示例专辑三',
      coverId: null,
      releaseDate: null,
      barcode: null,
      createdAt: T0,
      updatedAt: T0,
    },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 320000,
      codec: 'mp3',
      container: '',
      duration: 203000,
      format: 'mp3',
      path: '/vol02/1000-0-music/sample/t6.mp3',
      size: 8100000,
    },
    year: null,
    trackNo: null,
    discNo: null,
    isrc: null,
    isCue: false,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: false,
  },
  {
    guid: 't7',
    title: '示例曲目 7',
    duration: 221000,
    coverId: 'track_0f1e2d3c4b5a6978',
    artists: [
      { guid: 'a1', name: '示例歌手甲', coverId: 'artist_0123456789abcdef', createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al1',
      name: '示例专辑一',
      coverId: 'album_0123456789abcdef',
      releaseDate: '2003-07-31',
      barcode: '6941234567890',
      createdAt: T0,
      updatedAt: T0,
    },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 900000,
      codec: 'flac',
      container: '',
      duration: 221000,
      format: 'flac',
      path: '/vol02/1000-0-music/sample/t7.flac',
      size: 36000000,
    },
    year: 2003,
    trackNo: 4,
    discNo: 1,
    isrc: 'CNA120300007',
    isCue: false,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: false,
  },
  {
    guid: 't8',
    title: '示例曲目 8',
    duration: 165000,
    coverId: 'track_9988776655443322',
    artists: [
      { guid: 'a1', name: '示例歌手甲', coverId: 'artist_0123456789abcdef', createdAt: T0, updatedAt: T0 },
    ],
    album: {
      guid: 'al1',
      name: '示例专辑一',
      coverId: 'album_0123456789abcdef',
      releaseDate: '2003-07-31',
      barcode: '6941234567890',
      createdAt: T0,
      updatedAt: T0,
    },
    // 只缺 sampleRate。
    audioSpec: {
      bitDepth: 16,
      channel: 2,
      bitrate: 256000,
      codec: 'mp3',
      container: '',
      duration: 165000,
      format: 'mp3',
      path: '/vol02/1000-0-music/sample/t8.mp3',
      size: 5300000,
    },
    year: 2003,
    trackNo: 1,
    discNo: 1,
    isrc: 'CNA120300008',
    isCue: true,
    createdAt: T0,
    updatedAt: T0,
    genres: [],
    isFavorite: false,
  },
]

// ---------------------------------------------------------------------------
// 风格（2 个，g1–g2）
//
// g1 = `Pop`、g2 = `POP`：**同名不同大小写**，用于覆盖客户端的风格名归一化场景。
// ---------------------------------------------------------------------------

/** 示例风格集合。 */
export const GENRES: RawGenre[] = [
  { guid: 'g1', name: 'Pop', coverId: null, trackCount: 5 },
  { guid: 'g2', name: 'POP', coverId: null, trackCount: 2 },
]

/**
 * 曲目 → 风格 guid 的映射。
 *
 * 服务端歌曲对象里的 `genres` 恒为空数组（实测），风格归属只能靠单独查询得到；
 * mock 需要这份映射来支撑 `/track/genre-detail/list?genreGUID=`。
 */
export const TRACK_GENRES: Record<string, string[]> = {
  t1: ['g1'],
  t2: ['g1'],
  t3: ['g1'],
  t4: ['g1'],
  t5: ['g1'],
  t6: ['g2'],
  t7: ['g2'],
  t8: [],
}

// ---------------------------------------------------------------------------
// 歌单（2 个，p1–p2）
//
// ⚠️ 该账号的真实 `playlist/list` 返回**空列表**（实测），歌单字段形状仍未实测——
//    这里保留占位形状，待创建歌单后补测校准。
// ---------------------------------------------------------------------------

/** 示例歌单集合（同时是 mock 初始 `state.playlists` 的元数据来源）。 */
export const PLAYLISTS: RawPlaylist[] = [
  {
    guid: 'p1',
    name: '示例歌单一',
    coverId: null,
    trackCount: 2,
    description: null,
    createdAt: T0,
    updatedAt: T0,
  },
  {
    guid: 'p2',
    name: '示例歌单二',
    coverId: null,
    trackCount: 1,
    description: '演示用歌单',
    createdAt: T0 + 86400,
    updatedAt: T0 + 86400,
  },
]

/** mock 初始歌单的曲目（与 `PLAYLISTS` 的 trackCount 对应）。 */
export const INITIAL_PLAYLIST_TRACKS: Record<string, string[]> = {
  p1: ['t1', 't2'],
  p2: ['t6'],
}

// ---------------------------------------------------------------------------
// 播放历史（4 条）
//
// ⚠️ **条目本身就是完整的歌曲对象**（实测 §15.7 第 6 条），**不是** `{ track: … }` 包装——
//    mock 直接返回歌曲对象，客户端对条目调用 `mapSong`。
//    这里给每条不同的 `updatedAt`（Unix 秒），便于下游验证「最近播放」的排序。
// ---------------------------------------------------------------------------

/** 按 guid 取原始歌曲（取不到直接抛错——fixtures 写错了要立刻暴露，不能静默产生空洞条目）。 */
function songByGuid(guid: string): RawSong {
  const song = SONGS.find((item) => item.guid === guid)
  if (!song) throw new Error(`fixtures 里没有 guid 为 ${guid} 的歌曲`)
  return song
}

/** 示例播放历史条目集合（**条目即歌曲对象**）。 */
export const PLAY_HISTORY: RawSong[] = [
  { ...songByGuid('t1'), updatedAt: T0 + 3600 },
  { ...songByGuid('t3'), updatedAt: T0 + 7200 },
  { ...songByGuid('t5'), updatedAt: T0 + 10800 },
  { ...songByGuid('t7'), updatedAt: T0 + 14400 },
]

// ---------------------------------------------------------------------------
// 歌词
// ---------------------------------------------------------------------------

/**
 * 生成带酷狗来源元信息标签的 LRC 文本。
 *
 * `[ti:]` `[ar:]` `[al:]` `[by:]` `[ver:]` `[kuwo:014]` `[offset:]` 都是**元信息标签**，
 * 解析歌词时必须忽略（Task 12 的解析器要覆盖这条实测结论）。
 */
function buildLrc(meta: { ti: string; ar: string; al: string }, lines: string[]): string {
  return [
    `[ti:${meta.ti}]`,
    `[ar:${meta.ar}]`,
    `[al:${meta.al}]`,
    '[by:kuwo]',
    '[ver:014]',
    '[kuwo:014]',
    '[offset:0]',
    ...lines,
    '',
  ].join('\n')
}

/**
 * 增强型 LRC：行级时间标签 + **词级时间标签**（`<mm:ss.xx>`）。
 *
 * 例：`[00:05.00]<00:05.00>逐<00:05.50>字<00:06.00>歌<00:06.50>词`
 */
const ENHANCED_LRC_T1 = buildLrc(
  { ti: '示例曲目 1', ar: '示例歌手甲', al: '示例专辑一' },
  [
    '[00:00.00]<00:00.00>示<00:00.50>例<00:01.00>歌<00:01.50>词<00:02.00>一',
    '[00:05.00]<00:05.00>逐<00:05.50>字<00:06.00>歌<00:06.50>词',
    '[00:10.00]<00:10.00>普<00:10.50>通<00:11.00>行<00:11.50>结<00:12.00>束',
  ],
)

/** 普通行级 LRC。 */
function plainLrc(ti: string, ar: string, al: string): string {
  return buildLrc({ ti, ar, al }, [
    '[00:00.00]第一行歌词',
    '[00:05.00]第二行歌词',
    '[00:10.00]第三行歌词',
  ])
}

/**
 * 歌词条目表（键为曲目 guid）。
 *
 * `t2` 故意**没有歌词**（服务端返回空列表）；`t1` 为增强型 LRC，其余为普通行级 LRC。
 */
export const LYRICS: Map<string, RawLyric> = new Map<string, RawLyric>([
  [
    't1',
    {
      guid: 'ly1',
      source: 'local',
      content: ENHANCED_LRC_T1,
      createdAt: T0,
      updatedAt: T0,
      isLRC: true,
      offset: 0,
    },
  ],
  [
    't3',
    {
      guid: 'ly3',
      source: 'local',
      content: plainLrc('示例曲目 3', '示例歌手乙', '示例专辑二'),
      createdAt: T0,
      updatedAt: T0,
      isLRC: true,
      offset: 0,
    },
  ],
  [
    't4',
    {
      guid: 'ly4',
      source: 'local',
      content: plainLrc('示例曲目 4', '示例歌手乙', '示例专辑二'),
      createdAt: T0,
      updatedAt: T0,
      isLRC: true,
      offset: 0,
    },
  ],
  [
    't5',
    {
      guid: 'ly5',
      source: 'local',
      content: plainLrc('示例曲目 5', '示例歌手甲', '示例专辑二'),
      createdAt: T0,
      updatedAt: T0,
      isLRC: true,
      offset: 0,
    },
  ],
  [
    't6',
    {
      guid: 'ly6',
      source: 'local',
      content: plainLrc('示例曲目 6', '示例歌手乙', '示例专辑三'),
      createdAt: T0,
      updatedAt: T0,
      isLRC: true,
      offset: 0,
    },
  ],
  [
    't7',
    {
      guid: 'ly7',
      source: 'local',
      content: plainLrc('示例曲目 7', '示例歌手甲', '示例专辑一'),
      createdAt: T0,
      updatedAt: T0,
      isLRC: true,
      offset: 0,
    },
  ],
  [
    't8',
    {
      guid: 'ly8',
      source: 'local',
      content: plainLrc('示例曲目 8', '示例歌手甲', '示例专辑一'),
      createdAt: T0,
      updatedAt: T0,
      isLRC: true,
      offset: 0,
    },
  ],
])

// ---------------------------------------------------------------------------
// T83：音频内嵌歌词
// ---------------------------------------------------------------------------
//
// ⚠️ **「内嵌歌词」不在 NAS 的歌词表里** —— 它在**音频文件自己**的 `USLT` 帧里
//    （mock 的 `track/stream` 会给这首歌返回一个带 `ID3 ` 块的 WAV）。
//
// ⚠️ 这首歌（`t2`）在 `LYRICS` 里**故意没有**条目 ⇒ 客户端只能从内嵌歌词拿到它
//    ⇒ 「NAS 没有 → 回落内嵌」这条路径才真的被走到。

/** 带内嵌歌词的那首歌（NAS 歌词表里**没有**它）。 */
export const EMBEDDED_LYRIC_SONG_GUID = 't2'

/** 内嵌歌词的内容（写进 WAV 的 `ID3 ` 块里的 `USLT` 帧）。 */
export const EMBEDDED_LYRIC_LRC = '[00:01.00]内嵌歌词第一行\n[00:05.00]内嵌歌词第二行'
