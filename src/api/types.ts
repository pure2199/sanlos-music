// 服务端**原始 JSON** 的类型定义。
//
// 本文件描述的是飞牛音乐服务端返回的字段名（`guid` / `name` / `coverId` / `audioSpec` …），
// **不是** `shared/types.ts` 的领域模型（`id` / `title` / `coverId: ''` …）。
// 两者的转换由 `src/api/client.ts` 的 `mapSong` / `mapAlbum` / … 负责。
//
// 字段形状依据：**规格 §15.7（2026-11-02 二次联调实测，20 首样本 + 专辑/歌手/收藏/历史端点）**。
// 实测要点：
// - 歌曲 `{ guid, title, coverId, year, discNo, trackNo, isrc, duration, isCue,
//   createdAt, updatedAt, album{...}, artists[{...}], genres: [], audioSpec{...}, isFavorite }`；
// - 专辑 `{ guid, name, coverId, releaseDate, barcode, createdAt, updatedAt, artists[{...}], trackCount }`
//   （**没有 `year`**，只有 `releaseDate`）；
// - 歌手 `{ guid, name, coverId, createdAt, updatedAt, trackCount, albumCount }`；
// - 歌手条目（出现在 `album.artists` / `song.artists` 里）`{ guid, name, coverId, createdAt, updatedAt }`；
// - 收藏条目 / 播放历史条目 = **完整歌曲对象**（不是 `{ track: … }` 包装）；
// - 风格 `{ guid, name, coverId(null), trackCount }`；
// - `duration` / `audioSpec.duration` 单位是**毫秒**；`audioSpec.bitrate` 单位是 **bps**；
// - `createdAt` / `updatedAt` 是 **Unix 秒**（如 `1792563278`），不是 ISO 串。
//
// 为什么要单独一份原始类型：
// - 服务端字段**稀疏**（实测会缺 `bitrate` / `sampleRate` / `bitDepth`，也会给 `null`），
//   领域模型则要求这些字段是非空类型（缺省补 0）；
// - 服务端的单位与领域模型不同（时长毫秒 → 秒、比特率 bps → kbps、时间 Unix 秒 → ISO 串），
//   把两者混在一份类型里会让「原始值」与「领域值」的单位约定无从分辨；
// - 直接用 `any` 接收服务端 JSON 会让映射规则失去类型约束，故这里给出**宽松但有名字**的原始形状。
//
// ⚠️ 原始类型的字段一律可选 / 可空：这描述的是「服务端可能不给你」，而不是「你必须提供」。

/** 服务端原始命名引用（歌曲里的歌手、专辑对象里的歌手、歌曲内嵌的专辑）。 */
export interface RawRef {
  /** 唯一标识。 */
  guid: string
  /** 名称。 */
  name: string
  /** 头像 / 封面 id（无则 `null`）。 */
  coverId?: string | null
  /** 发行日期（内嵌专辑有；实测形如 `"2005-04-01"`）。 */
  releaseDate?: string | null
  /** 条码（内嵌专辑有）。 */
  barcode?: string | null
  /** 创建时间（Unix 秒或 ISO 串，兼容两种来源）。 */
  createdAt?: number | string | null
  /** 更新时间（Unix 秒或 ISO 串，兼容两种来源）。 */
  updatedAt?: number | string | null
}

/**
 * 服务端原始音频规格（稀疏，字段可能缺失或为 `null`）。
 *
 * 单位约定（**与领域模型不同，勿混用**）：
 * - `duration`：**毫秒**（领域模型 `Song.duration` 是秒）；
 * - `bitrate`：**比特/秒（bps）**（领域模型 `Song.bitrate` 是千比特/秒）。
 */
export interface RawAudioSpec {
  /** 位深（bit）。 */
  bitDepth?: number | null
  /** 采样率（Hz）。 */
  sampleRate?: number | null
  /** 声道数。 */
  channel?: number | null
  /** 比特率（**bps**，比特/秒）。 */
  bitrate?: number | null
  /** 编码格式，如 `flac` / `mp3`。 */
  codec?: string | null
  /** 容器格式（**实测为空串 `""`**）。 */
  container?: string | null
  /** 时长（**毫秒**）。 */
  duration?: number | null
  /** 容器 / 扩展名，如 `flac`。 */
  format?: string | null
  /** NAS 上的文件路径（实测是 NAS 绝对路径，如 `/vol02/1000-0-…/xxx.flac`）。 */
  path?: string | null
  /** 文件大小（字节）。 */
  size?: number | null
}

/** 服务端原始歌曲。 */
export interface RawSong {
  /** 歌曲 guid。 */
  guid: string
  /** 歌曲名。 */
  title: string
  /** 时长（**毫秒**）。 */
  duration?: number | null
  /** 封面 id；无封面为 `null`（实测形如 `track_<hex>`）。 */
  coverId?: string | null
  /** 歌手列表（可能多歌手）。 */
  artists?: RawRef[]
  /** 所属专辑（内嵌完整专辑对象）。 */
  album?: RawRef
  /** 音频规格（稀疏）。 */
  audioSpec?: RawAudioSpec
  /** 发行年份，可能为 `null`。 */
  year?: number | null
  /** 碟内曲号，可能为 `null`。 */
  trackNo?: number | null
  /** 碟号，可能为 `null`。 */
  discNo?: number | null
  /** 发行日期（实测形状里歌曲没有这个字段，保留可选以兼容）。 */
  releaseDate?: string | null
  /** 国际标准录音码（实测存在）。 */
  isrc?: string | null
  /** 是否为 cue 切片（实测存在）。 */
  isCue?: boolean | null
  /** 创建时间（Unix 秒或 ISO 串）。 */
  createdAt?: number | string | null
  /** 更新时间（Unix 秒或 ISO 串）。 */
  updatedAt?: number | string | null
  /** 风格列表（实测歌曲对象内恒为空数组）。 */
  genres?: RawGenre[]
  /** **服务端给出的收藏态**（实测 true / false 都有；缺失时按未收藏处理）。 */
  isFavorite?: boolean | null
}

/**
 * 服务端原始专辑。
 *
 * ⚠️ **没有 `year` 字段**（实测）：只有 `releaseDate`（形如 `"2005-04-01"`，或 `null`）。
 *    领域模型的 `Album.year` 由客户端从 `releaseDate` 前 4 位派生。
 */
export interface RawAlbum {
  /** 专辑 guid。 */
  guid: string
  /** 专辑名。 */
  name: string
  /** 封面 id；无封面为 `null`（实测形如 `album_<hex>`）。 */
  coverId?: string | null
  /** 专辑歌手。 */
  artists?: RawRef[]
  /** 发行日期（可能是 `null`）。 */
  releaseDate?: string | null
  /** 条码。 */
  barcode?: string | null
  /** 创建时间（Unix 秒或 ISO 串）。 */
  createdAt?: number | string | null
  /** 更新时间（Unix 秒或 ISO 串）。 */
  updatedAt?: number | string | null
  /** 歌曲数。 */
  trackCount?: number
}

/** 服务端原始歌手。 */
export interface RawArtist {
  /** 歌手 guid。 */
  guid: string
  /** 歌手名。 */
  name: string
  /** 头像 id；无封面为 `null`（实测形如 `artist_<hex>`，也可能是 `track_<hex>`）。 */
  coverId?: string | null
  /** 创建时间（Unix 秒或 ISO 串）。 */
  createdAt?: number | string | null
  /** 更新时间（Unix 秒或 ISO 串）。 */
  updatedAt?: number | string | null
  /** 专辑数。 */
  albumCount?: number
  /** 歌曲数。 */
  trackCount?: number
}

/** 服务端原始风格。 */
export interface RawGenre {
  /** 风格 guid。 */
  guid: string
  /** 风格原始名称（保留服务端大小写）。 */
  name: string
  /** 封面 id；实测为 `null`。 */
  coverId?: string | null
  /** 该风格下的歌曲数。 */
  trackCount?: number
}

/** 服务端原始歌单（**字段形状仍未实测**：该账号的 `playlist/list` 返回空列表）。 */
export interface RawPlaylist {
  /** 歌单 guid。 */
  guid: string
  /** 歌单名。 */
  name: string
  /** 封面 id；无封面为 `null`。 */
  coverId?: string | null
  /** 歌曲数。 */
  trackCount?: number
  /** 描述，可能为 `null`。 */
  description?: string | null
  /** 创建时间（Unix 秒或 ISO 串，兼容两种来源）。 */
  createdAt?: number | string | null
  /** 更新时间（Unix 秒或 ISO 串，兼容两种来源）。 */
  updatedAt?: number | string | null
}

/** 服务端原始歌词条目。 */
export interface RawLyric {
  /** 歌词 guid。 */
  guid: string
  /** 来源（如 `local`）。 */
  source: string
  /** LRC 原文。 */
  content: string
  /** 创建时间（Unix 秒或 ISO 串，兼容两种来源）。 */
  createdAt?: number | string | null
  /** 更新时间（Unix 秒或 ISO 串，兼容两种来源）。 */
  updatedAt?: number | string | null
  /** 是否为 LRC 格式。 */
  isLRC?: boolean
  /** 时间偏移（毫秒）。 */
  offset?: number
}

/**
 * 服务端原始播放历史条目。
 *
 * ⚠️ **条目本身就是完整的歌曲对象**（实测 §15.7 第 6 条），**不是** `{ track: … }` 包装：
 *    条目含 `guid,title,coverId,duration,album,artists,audioSpec,isFavorite` 等字段。
 *    因此这里直接别名到 `RawSong`，客户端对条目调用 `mapSong` 即可。
 */
export type RawHistoryItem = RawSong

/**
 * 服务端列表信封（**宽松**形状：`list` / `total` 都可能缺失）。
 *
 * 服务端所有列表型端点统一返回 `{ list, total }`。
 */
export interface RawPage<T> {
  /** 当前页数据。 */
  list?: T[]
  /** 全量条数（与分页无关）。 */
  total?: number
}

/** 领域侧的列表信封（客户端对外承诺的形状）。 */
export interface Page<T> {
  /** 当前页数据。 */
  list: T[]
  /** 全量条数（供增量加载与虚拟滚动判断是否还有下一页）。 */
  total: number
}

/**
 * 歌词条目（领域层）。
 *
 * 与原始形状的差别只有一个：**时间字段已归一为 ISO 8601 字符串**
 * （实测服务端给的是 Unix 秒；`shared/types.ts` 的领域时间字段约定是 `string | null`，
 * 故由客户端负责归一，服务端给 ISO 串时原样保留）。
 */
export interface LyricEntry {
  /** 歌词 guid。 */
  guid: string
  /** 来源（如 `local`）。 */
  source: string
  /** LRC 原文。 */
  content: string
  /** 创建时间（ISO 8601 字符串；缺失为 `null`）。 */
  createdAt: string | null
  /** 更新时间（ISO 8601 字符串；缺失为 `null`）。 */
  updatedAt: string | null
  /** 是否为 LRC 格式。 */
  isLRC: boolean
  /** 时间偏移（毫秒）。 */
  offset: number
  /**
   * 这条歌词的**角色**（T90-③：原文 / 翻译 / 罗马音）。
   *
   * ⚠️ **可选字段、缺省按旧的位置约定**（第 1 条非空条目作原文、其余作翻译）
   *    ⇒ **既有数据（NAS / 内嵌）没有这个键** ⇒ 行为**一条不变**。
   * ⚠️ 必填会破坏「既有测试一条不许改」：既有代码与测试里**手写**的 `LyricEntry`
   *    都不带这个键 ⇒ 编译不过。
   */
  role?: 'original' | 'translation' | 'romanization'
}
