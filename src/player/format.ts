// 播放格式判定与音频流地址（**渲染进程**）。
//
// ---------------------------------------------------------------------------
// 职责
// ---------------------------------------------------------------------------
// - `isChromiumDecodable`：**播放前**判定 Chromium（Electron 内核）能不能解这个格式；
// - `undecodableFormat` / `formatUnsupportedMessage`：不可解时给出**可读**的错误文案
//   （Task 15 的 UI 直接显示），**不静默失败**；
// - `describeMediaError`：把 `<audio>` 的 `MediaError.code` 翻译成可读文案，
//   并区分「媒体错误」与「网络/加载错误」两类；
// - `streamUrl`：**本任务新建**（此前仓库里没有这个函数——简报把它写在 `Consumes`
//   里说来自 Task 6，但 Task 6 并没有实现）。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - `streamUrl` 只产出 `fnm://srv/...` 的**代理地址**：渲染进程**永不直连 NAS**，
//   也**永不**自己拼 `authx` / `Cookie`——那是主进程代理（`electron/proxy.ts`）的职责；
// - 本文件**不含任何凭证**，也不读取任何凭证；
// - 只用浏览器 API，不 import Node 内置模块或 Electron API。
// ---------------------------------------------------------------------------

import type { Song } from '../../shared/types'

// ---------------------------------------------------------------------------
// 不可解格式集合
// ---------------------------------------------------------------------------

/**
 * Chromium（Electron 内核）**不可解**的音频格式集合（扩展名 / codec 命中即不可解）。
 *
 * 依据：简报 Step 3 + 控制器追加要求 D。实测该 NAS 的曲库里 `alac` 46 首、`dsf` 等
 * 确实存在，且服务端转码不可用（`code=100001 unknown error`），所以这些格式**必须
 * 如实暴露为不可播放**，不能假装能播。
 *
 * 大小写不敏感；`codec` 形如 `DTS-HD` 时按 token 命中 `dts`。
 */
export const UNDECODABLE_FORMATS: readonly string[] = [
  'dsf',
  'dff',
  'dsd',
  'wma',
  'ape',
  'dts',
  'aiff',
  'ra',
  'au',
  'dvf',
  'tta',
  'dss',
  'mmf',
  'alac',
]

/** 不可解集合的查找表。 */
const UNDECODABLE_SET: ReadonlySet<string> = new Set(UNDECODABLE_FORMATS)

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 归一化：去空白、小写、去掉前导点（`.ape` → `ape`）。 */
function normalizeToken(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/^\.+/, '')
}

/** 按非字母数字拆分 token（`dts-hd` → `['dts', 'hd']`）。 */
function tokenize(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length > 0)
}

/**
 * 命中的不可解格式名（大写），没命中返回 `null`。
 *
 * 判定口径（控制器追加要求 D）：**扩展名或 codec 命中即不可解**；
 * `Song` 领域模型里**没有** `ext` 字段，所以调用方传的 `ext` 实际多半是空的——
 * 因此**不能**因为 `ext` 为空就跳过 codec 判定。
 */
function matchUndecodable(value: string | null | undefined): string | null {
  const normalized = normalizeToken(value)
  if (normalized.length === 0) return null
  if (UNDECODABLE_SET.has(normalized)) return normalized.toUpperCase()
  for (const token of tokenize(normalized)) {
    if (UNDECODABLE_SET.has(token)) return token.toUpperCase()
  }
  return null
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * Chromium 能不能解这个格式。
 *
 * @param codec 编码格式（领域模型 `Song.codec`，大写，如 `FLAC` / `APE`）。
 * @param ext   扩展名 / 容器名（可为空——`Song` 没有 `ext` 字段）。
 */
export function isChromiumDecodable(codec: string, ext: string): boolean {
  return matchUndecodable(codec) === null && matchUndecodable(ext) === null
}

/**
 * 返回命中的不可解格式名（大写），没命中返回 `null`。
 *
 * 用于生成可读错误文案（例如 `APE`）。
 */
export function undecodableFormat(codec: string, ext: string): string | null {
  return matchUndecodable(codec) ?? matchUndecodable(ext)
}

/**
 * 不可解格式的错误文案。
 *
 * ⚠️ 文案里**不得**出现 token / 密码 / Cookie 等任何凭证。
 */
export function formatUnsupportedMessage(label: string): string {
  return `该格式（${label}）当前无法播放`
}

// ---------------------------------------------------------------------------
// 兜底解码的友好提示（Task 12）
// ---------------------------------------------------------------------------

/**
 * 兜底解码失败的原因（**可判别**，不要靠文案匹配）。
 *
 * - `no-ffmpeg`：本机没装 FFmpeg；
 * - `no-local`：这首歌没有本地副本（兜底只支持本地文件）；
 * - `failed`：转码失败（`detail` 里有具体原因）。
 */
export type FallbackFailure = 'no-ffmpeg' | 'no-local' | 'failed'

/**
 * 兜底解码的**友好提示**。
 *
 * ⚠️ **给用户看的是「怎么办」，不是「报错」**——
 *    说清楚缺什么、下一步做什么，别只丢一句「无法播放」。
 */
export function fallbackUnavailableMessage(
  label: string,
  reason: FallbackFailure,
  detail?: string | null,
): string {
  if (reason === 'no-ffmpeg') {
    // ⚠️ **不能说「先下载到本地」**——没装 FFmpeg 时本地文件同样解不了，
    //    那条建议会把用户引到一条走不通的路上。
    return `该格式（${label}）当前无法播放：未检测到 FFmpeg。安装 FFmpeg 后即可通过转码播放。`
  }
  if (reason === 'no-local') {
    // ⚠️ 兜底转码只吃**本地文件**（服务端转码不可用，没有别的来源）。
    return `该格式（${label}）当前无法播放：还没有下载到本地。兜底转码需要本地文件，请先下载这首歌。`
  }
  const suffix = detail && detail.length > 0 ? `：${detail}` : ''
  return `该格式（${label}）解码失败${suffix}`
}

/** 兜底转码进行中的提示（界面显示「正在转换…」）。 */
export const FALLBACK_PREPARING_MESSAGE = '正在转换音频（首次播放需要几秒）…'

/** 兜底转码是**有损**的实话（界面要如实注明）。 */
export const FALLBACK_LOSSY_NOTE = '兜底播放使用 Opus 转码（音质有损，原始文件不变）'

// ---------------------------------------------------------------------------
// 标准音质（T54：服务端转码）
// ---------------------------------------------------------------------------

/**
 * 标准音质**准备中**的提示（T54）。
 *
 * ⚠️ 与 `FALLBACK_PREPARING_MESSAGE`（客户端兜底转码）**分开**：
 *    那个转的是**本地文件**，这个转的是**服务端产物**（省流量）——
 *    用户要知道自己等的是哪一种。
 */
export const STANDARD_QUALITY_PREPARING_MESSAGE = '正在准备标准音质…（NAS 正在转码，需要几秒）'

/**
 * 标准音质**不可用**、已回退原始音质时的说明（T54）。
 *
 * ⚠️ **这不是错误**：标准音质失败时**自动回退原始音质**、音乐照常播放——
 *    这里只**如实说明为什么没走标准音质**，界面显示**灰字**（不是红字）。
 *
 * @param detail 失败原因（可为空；为空时只说「不可用」）。
 */
export function standardQualityUnavailableMessage(detail: string | null): string {
  const suffix = detail && detail.length > 0 ? `：${detail}` : ''
  return `标准音质不可用${suffix}，已改用原始音质播放`
}

/**
 * **缓冲中**的提示（T37）。
 *
 * ⚠️ **这不是错误**：媒体元素的 `stalled` / `waiting` 只是「数据一时没到」的**瞬时提示**
 *    ——播放通常会**自行恢复**。早先把它当错误上报 → 界面挂一条**红字**，
 *    而**音乐其实照放**（慢网时几乎每首歌开头都会中一次）。
 *    ⇒ 现在它是一条 `role="status"` 的**灰字**，数据到了自动消失。
 */
export const BUFFERING_MESSAGE = '缓冲中…（网络较慢，正在等待数据）'

/**
 * 从歌曲里取扩展名 / 容器名。
 *
 * `Song` 没有 `ext` 字段；能拿到的只有 `audioSpec.format`（实测服务端给的是
 * 容器 / 扩展名，如 `flac`）。拿不到就返回空串——**不影响** codec 判定。
 */
export function songFormatExtension(song: Pick<Song, 'audioSpec'>): string {
  return song.audioSpec?.format ?? ''
}

/** 媒体错误 / 网络错误的分类。 */
export type MediaErrorKind = 'media' | 'network'

/** 可读的媒体错误描述。 */
export interface MediaErrorInfo {
  /** 失败类别：媒体（解码 / 不支持）或网络（加载 / 中断）。 */
  kind: MediaErrorKind
  /** 给用户看的文案（**不含任何凭证**）。 */
  message: string
}

/**
 * 把 `<audio>` 的 `MediaError.code` 翻译成可读文案。
 *
 * `MediaError` 的 code 取值：`1` ABORTED / `2` NETWORK / `3` DECODE / `4` SRC_NOT_SUPPORTED。
 * 未知 code 归到「媒体错误」，文案保持通用。
 */
export function describeMediaError(code: number | null | undefined): MediaErrorInfo {
  switch (code) {
    case 1:
      return { kind: 'network', message: '音频加载被中止' }
    case 2:
      return { kind: 'network', message: '音频加载失败：网络错误或连接中断' }
    case 3:
      return { kind: 'media', message: '音频解码失败：文件可能已损坏' }
    case 4:
      return { kind: 'media', message: '该音频无法播放：当前内核不支持该格式' }
    default:
      return { kind: 'media', message: '音频播放失败' }
  }
}

// ---------------------------------------------------------------------------
// 音频流地址
// ---------------------------------------------------------------------------

/**
 * 构造当前这一曲的音频流地址。
 *
 * 形状：`fnm://srv/track/stream?guid=<songGuid>`。
 *
 * - `srv` 之后是**相对 API 基址**的路径，**不含** `/music/api/v1`（Task 8 定下的口径）；
 * - guid 用 `encodeURIComponent` 编码（真实 guid 形如 `track_<hex>`，但别假设只有 hex）；
 * - **绝不**在 URL 里拼 `authx` 或 `Cookie`——主进程代理会自己补，
 *   渲染进程既不需要也不能拼。
 */
export function streamUrl(songId: string): string {
  return `fnm://srv/track/stream?guid=${encodeURIComponent(songId)}`
}
