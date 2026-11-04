// ---------------------------------------------------------------------------
// 本地曲目的元数据推导（T38）
// ---------------------------------------------------------------------------
//
// ⚠️ **不解析音频标签**（ID3v2 / Vorbis Comment / FLAC metadata）——
//    那要手写三个解析器，范围与风险都太大，**单开任务**。
//    本文件只做**文件名反推**：下载的文件名与用户本地的音乐文件名
//    走的是同一个约定 —— `<歌手> - <歌名>.<ext>`。
//
// ⚠️ **反推值是近似值**：文件名被 `sanitizeFileName()` 清洗过
//    （Windows 非法字符 → `_`），所以反推出来的歌名 / 歌手可能带下划线。
//    界面上必须如实说明这一点，**不得**假装是精确的标签。
//
// ---------------------------------------------------------------------------

/**
 * 音频扩展名白名单。
 *
 * ⚠️ 与 `electron/localMedia.ts` 的 `MIME_BY_EXT` **保持一致**——
 *    能登记的扩展名，必须也是 `fnml://` 认得的容器。
 */
export const AUDIO_EXTENSIONS: readonly string[] = [
  'mp3',
  'flac',
  'm4a',
  'mp4',
  'aac',
  'ogg',
  'opus',
  'oga',
  'wav',
  'wma',
  'ape',
  'alac',
  'mka',
  'webm',
  'aiff',
  'aif',
]

/** 文件名里分隔歌手与歌名的标记。 */
const NAME_SEPARATOR = ' - '

/** 由文件名反推出的歌名 / 歌手。 */
export interface TrackFileName {
  /** 歌手名（**可能为空**——文件名里没有 ` - ` 时就是空串）。 */
  artist: string
  /** 歌名（**不会为空**——取不到就用整段文件名）。 */
  title: string
}

/**
 * 取文件名的扩展名（小写、不含点）。
 *
 * @param fileName 文件名（**可以带路径**）。
 * @returns 扩展名；没有扩展名时返回空串。
 */
export function fileExtension(fileName: string): string {
  const raw = (fileName ?? '').trim()
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  const base = slash >= 0 ? raw.slice(slash + 1) : raw
  const dot = base.lastIndexOf('.')
  // ⚠️ `dot <= 0`：`.mp3` 这种「点开头」的名字**不算**有扩展名。
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * 这个文件名是不是音频文件（按扩展名白名单判定）。
 *
 * ⚠️ **只看扩展名**：不读文件头——登记时不做内容嗅探（那要打开文件、慢）。
 *
 * @param fileName 文件名（可以带路径）。
 */
export function isAudioFileName(fileName: string): boolean {
  const ext = fileExtension(fileName)
  return ext.length > 0 && AUDIO_EXTENSIONS.includes(ext)
}

/**
 * 由文件名反推歌手与歌名。
 *
 * - `占位歌手三 - 占位曲目十三.flac` → `{ artist: '占位歌手三', title: '占位曲目十三' }`
 * - `占位曲目十三.flac` → `{ artist: '', title: '占位曲目十三' }`
 *
 * ⚠️ **只去「认得的音频扩展名」**：像 `Album 03. Intro` 这种名字里的
 *    `.` 不是扩展名 → **不去掉**，否则歌名会被砍掉一截。
 *
 * @param fileName 文件名（可以带路径）。
 */
export function parseTrackFileName(fileName: string): TrackFileName {
  const raw = fileName ?? ''
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  // ⚠️ **base 不 trim**：前导空格是「` - ` 分隔符」的一部分
  //    （` - 歌名.flac` → 歌手为空、歌名照常），trim 掉就找不到分隔符了。
  const base = slash >= 0 ? raw.slice(slash + 1) : raw
  if (base.trim().length === 0) return { artist: '', title: '' }

  const ext = fileExtension(base)
  // ⚠️ **只去「认得的音频扩展名」**：像 `Album 03. Intro` 这种名字里的
  //    `.` 不是扩展名 → **不去掉**，否则歌名会被砍掉一截。
  const stem =
    ext.length > 0 && AUDIO_EXTENSIONS.includes(ext)
      ? base.slice(0, base.length - ext.length - 1)
      : base

  const index = stem.indexOf(NAME_SEPARATOR)
  if (index < 0) return { artist: '', title: stem.trim() }
  const artist = stem.slice(0, index).trim()
  const title = stem.slice(index + NAME_SEPARATOR.length).trim()
  // ⚠️ 歌名空 → 整段当歌名；歌手空 → 歌名照常（别把整段名字当歌手）。
  if (title.length === 0) return { artist: '', title: stem.trim() }
  if (artist.length === 0) return { artist: '', title }
  return { artist, title }
}
