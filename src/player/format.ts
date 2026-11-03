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
