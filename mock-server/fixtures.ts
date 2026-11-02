// Mock server 的服务端**原始 JSON** fixtures。
//
// 重要：本文件里的对象是**飞牛音乐服务端返回的原始形状**，不是 `shared/types.ts` 的领域模型。
// 领域模型（`Song` / `Album` / …）由 Task 6 的 `mapSong` / `mapAlbum` 负责从这些原始字段转换而来，
// 因此这里的字段名用服务端的 `guid` / `name` / `coverId` / `audioSpec`，而不是领域模型的 `id` / `title`。
//
// 实测要点（与真实 NAS 保持一致）：
// - `duration` 与 `audioSpec.duration` 的单位是**毫秒**；
// - `audioSpec.bitrate` 的单位是**比特/秒（bps）**（领域模型 `Song.bitrate` 是 kbps，映射时 ÷1000）；
// - `coverId` 形如 `cover_<16 位小写十六进制>`，无封面时为 `null`；
// - `year` / `trackNo` / `discNo` / `releaseDate` 可能为 `null`（不是 0）；
// - 歌曲对象内的 `genres` 恒为空数组，风格需单独查询；
// - 风格名存在大小写重复（如 `Pop` 与 `POP`），故 guid 与 name 各自独立。

/** 服务端原始命名引用（歌曲里的歌手、专辑对象里的歌手）。 */
export interface RawRef {
  /** 唯一标识。 */
  guid: string
  /** 名称。 */
  name: string
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
  /** 容器格式。 */
  container?: string | null
  /** 时长（毫秒）。 */
  duration?: number | null
  /** 容器 / 扩展名。 */
  format?: string | null
  /** NAS 上的文件路径。 */
  path?: string | null
  /** 文件大小（字节）。 */
  size?: number | null
}

/** 服务端原始风格。 */
export interface RawGenre {
  /** 风格唯一标识。 */
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
  /** 封面 id；无封面为 null。 */
  coverId: string | null
  /** 歌手列表（可能多歌手）。 */
  artists: RawRef[]
  /** 所属专辑。 */
  album: RawRef
  /** 音频规格（稀疏）。 */
  audioSpec: RawAudioSpec
  /** 发行年份，可能为 null。 */
  year: number | null
  /** 碟内曲号，可能为 null。 */
  trackNo: number | null
  /** 碟号，可能为 null。 */
  discNo: number | null
  /** 发行日期，可能为 null。 */
  releaseDate: string | null
  /** 风格列表（实测恒为空数组）。 */
  genres: RawGenre[]
}

/** 服务端原始专辑。 */
export interface RawAlbum {
  /** 专辑 guid。 */
  guid: string
  /** 专辑名。 */
  name: string
  /** 封面 id；无封面为 null。 */
  coverId: string | null
  /** 专辑歌手。 */
  artists: RawRef[]
  /** 发行年份，可能为 null。 */
  year: number | null
  /** 歌曲数。 */
  trackCount: number
  /** 发行日期，可能为 null。 */
  releaseDate: string | null
}

/** 服务端原始歌手。 */
export interface RawArtist {
  /** 歌手 guid。 */
  guid: string
  /** 歌手名。 */
  name: string
  /** 头像 id；实测为 null。 */
  coverId: string | null
  /** 专辑数。 */
  albumCount: number
  /** 歌曲数。 */
  trackCount: number
}

/** 服务端原始歌单。 */
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
  /** 创建时间（ISO 字符串）。 */
  createdAt: string | null
  /** 更新时间（ISO 字符串）。 */
  updatedAt: string | null
}

/** 服务端原始歌词条目。 */
export interface RawLyric {
  /** 歌词 guid。 */
  guid: string
  /** 来源（如 `local`）。 */
  source: string
  /** LRC 原文。 */
  content: string
  /** 创建时间。 */
  createdAt: string | null
  /** 更新时间。 */
  updatedAt: string | null
  /** 是否为 LRC 格式。 */
  isLRC: boolean
  /** 时间偏移（毫秒）。 */
  offset: number
}

/**
 * 服务端原始播放历史条目。
 *
 * ⚠️ **占位形状**：真实 NAS 的播放历史条目字段**只实测到「端点存在、默认 50 条、total=414」**，
 *    具体字段形状未实测。本形状（`guid` + `playTime` + 内嵌 `track`）是按常见实现推导的，
 *    Task 16 必须按真实响应校准。
 */
export interface RawHistoryItem {
  /** 条目 guid。 */
  guid: string
  /** 播放时间。 */
  playTime: string
  /** 对应的歌曲（服务端原始 JSON）。 */
  track: RawSong
}

// ---------------------------------------------------------------------------
// 曲目（8 首，t1–t8）
//
// 覆盖的边界：
// - t2 / t4 无封面（coverId 为 null）；
// - t2 / t6 的 year / trackNo / discNo / releaseDate 为 null；
// - t2 / t4 为多歌手；
// - t3 缺 `bitrate` 与 `sampleRate`，t8 缺 `sampleRate`（稀疏 audioSpec）；
// - t6 所在专辑 al3 的 year / releaseDate 为 null。
// ---------------------------------------------------------------------------

/** 示例曲目集合。 */
export const SONGS: RawSong[] = [
  {
    guid: 't1',
    title: '示例曲目 1',
    duration: 185000,
    coverId: 'cover_0123456789abcdef',
    artists: [{ guid: 'a1', name: '示例歌手甲' }],
    album: { guid: 'al1', name: '示例专辑一' },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 900000,
      codec: 'flac',
      container: 'flac',
      duration: 185000,
      format: 'flac',
      path: '/music/sample/t1.flac',
      size: 30000000,
    },
    year: 2003,
    trackNo: 3,
    discNo: 1,
    releaseDate: '2003-07-31',
    genres: [],
  },
  {
    guid: 't2',
    title: '示例曲目 2',
    duration: 212500,
    coverId: null,
    artists: [
      { guid: 'a1', name: '示例歌手甲' },
      { guid: 'a2', name: '示例歌手乙' },
    ],
    album: { guid: 'al1', name: '示例专辑一' },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 320000,
      codec: 'mp3',
      container: 'mp3',
      duration: 212500,
      format: 'mp3',
      path: '/music/sample/t2.mp3',
      size: 8500000,
    },
    year: null,
    trackNo: null,
    discNo: null,
    releaseDate: null,
    genres: [],
  },
  {
    guid: 't3',
    title: '示例曲目 3',
    duration: 198000,
    coverId: 'cover_fedcba9876543210',
    artists: [{ guid: 'a2', name: '示例歌手乙' }],
    album: { guid: 'al2', name: '示例专辑二' },
    // 稀疏 audioSpec：实测服务端会缺 bitrate / sampleRate。
    audioSpec: {
      bitDepth: null,
      channel: 2,
      codec: 'aac',
      container: 'm4a',
      duration: 198000,
      format: 'm4a',
      path: '/music/sample/t3.m4a',
      size: 4200000,
    },
    year: 2011,
    trackNo: 1,
    discNo: 1,
    releaseDate: '2011-05-20',
    genres: [],
  },
  {
    guid: 't4',
    title: '示例曲目 4',
    duration: 240000,
    coverId: null,
    artists: [
      { guid: 'a2', name: '示例歌手乙' },
      { guid: 'a1', name: '示例歌手甲' },
    ],
    album: { guid: 'al2', name: '示例专辑二' },
    audioSpec: {
      bitDepth: 24,
      sampleRate: 96000,
      channel: 2,
      bitrate: 1400000,
      codec: 'flac',
      container: 'flac',
      duration: 240000,
      format: 'flac',
      path: '/music/sample/t4.flac',
      size: 42000000,
    },
    year: 2011,
    trackNo: 2,
    discNo: 1,
    releaseDate: '2011-05-20',
    genres: [],
  },
  {
    guid: 't5',
    title: '示例曲目 5',
    duration: 176400,
    coverId: 'cover_1122334455667788',
    artists: [{ guid: 'a1', name: '示例歌手甲' }],
    album: { guid: 'al2', name: '示例专辑二' },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 900000,
      codec: 'flac',
      container: 'flac',
      duration: 176400,
      format: 'flac',
      path: '/music/sample/t5.flac',
      size: 29000000,
    },
    year: 2011,
    trackNo: 3,
    discNo: 1,
    releaseDate: '2011-05-20',
    genres: [],
  },
  {
    guid: 't6',
    title: '示例曲目 6',
    duration: 203000,
    coverId: 'cover_8899aabbccddeeff',
    artists: [{ guid: 'a2', name: '示例歌手乙' }],
    album: { guid: 'al3', name: '示例专辑三' },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 320000,
      codec: 'mp3',
      container: 'mp3',
      duration: 203000,
      format: 'mp3',
      path: '/music/sample/t6.mp3',
      size: 8100000,
    },
    year: null,
    trackNo: null,
    discNo: null,
    releaseDate: null,
    genres: [],
  },
  {
    guid: 't7',
    title: '示例曲目 7',
    duration: 221000,
    coverId: 'cover_0f1e2d3c4b5a6978',
    artists: [{ guid: 'a1', name: '示例歌手甲' }],
    album: { guid: 'al1', name: '示例专辑一' },
    audioSpec: {
      bitDepth: 16,
      sampleRate: 44100,
      channel: 2,
      bitrate: 900000,
      codec: 'flac',
      container: 'flac',
      duration: 221000,
      format: 'flac',
      path: '/music/sample/t7.flac',
      size: 36000000,
    },
    year: 2003,
    trackNo: 4,
    discNo: 1,
    releaseDate: '2003-07-31',
    genres: [],
  },
  {
    guid: 't8',
    title: '示例曲目 8',
    duration: 165000,
    coverId: 'cover_9988776655443322',
    artists: [{ guid: 'a1', name: '示例歌手甲' }],
    album: { guid: 'al1', name: '示例专辑一' },
    // 只缺 sampleRate。
    audioSpec: {
      bitDepth: 16,
      channel: 2,
      bitrate: 256000,
      codec: 'mp3',
      container: 'mp3',
      duration: 165000,
      format: 'mp3',
      path: '/music/sample/t8.mp3',
      size: 5300000,
    },
    year: 2003,
    trackNo: 1,
    discNo: 1,
    releaseDate: '2003-07-31',
    genres: [],
  },
]

// ---------------------------------------------------------------------------
// 专辑（3 张，al1–al3）
// ---------------------------------------------------------------------------

/** 示例专辑集合。 */
export const ALBUMS: RawAlbum[] = [
  {
    guid: 'al1',
    name: '示例专辑一',
    coverId: 'cover_0123456789abcdef',
    artists: [{ guid: 'a1', name: '示例歌手甲' }],
    year: 2003,
    trackCount: 4,
    releaseDate: '2003-07-31',
  },
  {
    guid: 'al2',
    name: '示例专辑二',
    coverId: 'cover_fedcba9876543210',
    artists: [{ guid: 'a2', name: '示例歌手乙' }],
    year: 2011,
    trackCount: 3,
    releaseDate: '2011-05-20',
  },
  {
    guid: 'al3',
    name: '示例专辑三',
    coverId: null,
    artists: [{ guid: 'a1', name: '示例歌手甲' }],
    year: null,
    trackCount: 1,
    releaseDate: null,
  },
]

// ---------------------------------------------------------------------------
// 歌手（2 个，a1–a2）
// ---------------------------------------------------------------------------

/** 示例歌手集合。 */
export const ARTISTS: RawArtist[] = [
  { guid: 'a1', name: '示例歌手甲', coverId: null, albumCount: 2, trackCount: 6 },
  { guid: 'a2', name: '示例歌手乙', coverId: null, albumCount: 1, trackCount: 4 },
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
// ---------------------------------------------------------------------------

/** 示例歌单集合（同时是 mock 初始 `state.playlists` 的元数据来源）。 */
export const PLAYLISTS: RawPlaylist[] = [
  {
    guid: 'p1',
    name: '示例歌单一',
    coverId: null,
    trackCount: 2,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    guid: 'p2',
    name: '示例歌单二',
    coverId: null,
    trackCount: 1,
    description: '演示用歌单',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
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
// ⚠️ **占位形状**：真实 NAS 的播放历史条目字段未实测（只确认了「端点存在、默认 50 条、total=414」），
//    这里按「条目内嵌一首原始歌曲」推导，Task 16 需按真实响应校准。
// ---------------------------------------------------------------------------

/** 按 guid 取原始歌曲（取不到直接抛错——fixtures 写错了要立刻暴露，不能静默产生空洞条目）。 */
function songByGuid(guid: string): RawSong {
  const song = SONGS.find((item) => item.guid === guid)
  if (!song) throw new Error(`fixtures 里没有 guid 为 ${guid} 的歌曲`)
  return song
}

/** 示例播放历史条目集合。 */
export const PLAY_HISTORY: RawHistoryItem[] = [
  { guid: 'h1', playTime: '2026-01-05T09:00:00.000Z', track: songByGuid('t1') },
  { guid: 'h2', playTime: '2026-01-05T09:30:00.000Z', track: songByGuid('t3') },
  { guid: 'h3', playTime: '2026-01-05T10:15:00.000Z', track: songByGuid('t5') },
  { guid: 'h4', playTime: '2026-01-05T11:45:00.000Z', track: songByGuid('t7') },
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
      createdAt: null,
      updatedAt: null,
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
      createdAt: null,
      updatedAt: null,
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
      createdAt: null,
      updatedAt: null,
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
      createdAt: null,
      updatedAt: null,
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
      createdAt: null,
      updatedAt: null,
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
      createdAt: null,
      updatedAt: null,
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
      createdAt: null,
      updatedAt: null,
      isLRC: true,
      offset: 0,
    },
  ],
])
