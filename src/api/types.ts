// 服务端**原始 JSON** 的类型定义。
//
// 本文件描述的是飞牛音乐服务端返回的字段名（`guid` / `name` / `coverId` / `audioSpec` …），
// **不是** `shared/types.ts` 的领域模型（`id` / `title` / `coverId: ''` …）。
// 两者的转换由 `src/api/client.ts` 的 `mapSong` / `mapAlbum` / … 负责。
//
// 为什么要单独一份原始类型：
// - 服务端字段**稀疏**（实测会缺 `bitrate` / `sampleRate` / `bitDepth`，也会给 `null`），
//   领域模型则要求这些字段是非空类型（缺省补 0）；
// - 服务端的单位与领域模型不同（时长毫秒 → 秒、比特率 bps → kbps），
//   把两者混在一份类型里会让「原始值」与「领域值」的单位约定无从分辨；
// - 直接用 `any` 接收服务端 JSON 会让映射规则失去类型约束，故这里给出**宽松但有名字**的原始形状。
//
// ⚠️ 原始类型的字段一律可选 / 可空：这描述的是「服务端可能不给你」，而不是「你必须提供」。
//    这样才能让真实响应（缺字段、给 null）与测试里的最小样本都用同一套类型。

/** 服务端原始命名引用（歌曲里的歌手、专辑对象里的歌手）。 */
export interface RawRef {
  /** 唯一标识。 */
  guid: string
  /** 名称。 */
  name: string
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
  /** 容器格式，如 `flac` / `mp3`。 */
  container?: string | null
  /** 时长（**毫秒**）。 */
  duration?: number | null
  /** 容器 / 扩展名，如 `flac`。 */
  format?: string | null
  /** NAS 上的文件路径。 */
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
  /** 封面 id；无封面为 `null`。 */
  coverId?: string | null
  /** 歌手列表（可能多歌手）。 */
  artists?: RawRef[]
  /** 所属专辑。 */
  album?: RawRef
  /** 音频规格（稀疏）。 */
  audioSpec?: RawAudioSpec
  /** 发行年份，可能为 `null`。 */
  year?: number | null
  /** 碟内曲号，可能为 `null`。 */
  trackNo?: number | null
  /** 碟号，可能为 `null`。 */
  discNo?: number | null
  /** 发行日期，可能为 `null`。 */
  releaseDate?: string | null
  /** 风格列表（实测歌曲对象内恒为空数组）。 */
  genres?: RawGenre[]
}

/** 服务端原始专辑。 */
export interface RawAlbum {
  /** 专辑 guid。 */
  guid: string
  /** 专辑名。 */
  name: string
  /** 封面 id；无封面为 `null`。 */
  coverId?: string | null
  /** 专辑歌手。 */
  artists?: RawRef[]
  /** 发行年份，可能为 `null`。 */
  year?: number | null
  /** 歌曲数。 */
  trackCount?: number
  /** 发行日期，可能为 `null`。 */
  releaseDate?: string | null
}

/** 服务端原始歌手。 */
export interface RawArtist {
  /** 歌手 guid。 */
  guid: string
  /** 歌手名。 */
  name: string
  /** 头像 id；无封面为 `null`。 */
  coverId?: string | null
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

/** 服务端原始歌单。 */
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
  /** 创建时间，可能为 `null`。 */
  createdAt?: string | null
  /** 更新时间，可能为 `null`。 */
  updatedAt?: string | null
}

/** 服务端原始歌词条目。 */
export interface RawLyric {
  /** 歌词 guid。 */
  guid: string
  /** 来源（如 `local`）。 */
  source: string
  /** LRC 原文。 */
  content: string
  /** 创建时间，可能为 `null`。 */
  createdAt?: string | null
  /** 更新时间，可能为 `null`。 */
  updatedAt?: string | null
  /** 是否为 LRC 格式。 */
  isLRC?: boolean
  /** 时间偏移（毫秒）。 */
  offset?: number
}

/**
 * 服务端原始播放历史条目。
 *
 * ⚠️ **占位形状**：真实 NAS 的播放历史条目字段**只实测到「端点存在、默认 50 条、total=414」**，
 *    具体字段形状尚未实测。本形状（`guid` + `playTime` + 内嵌 `track`）是按常见实现推导的，
 *    Task 16 必须按真实响应校准。
 */
export interface RawHistoryItem {
  /** 历史条目 guid。 */
  guid?: string
  /** 播放时间（原始值，真实形状待实测）。 */
  playTime?: number | string | null
  /** 对应的歌曲（服务端原始 JSON）。 */
  track?: RawSong | null
}

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
