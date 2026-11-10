// ---------------------------------------------------------------------------
// 音频内嵌歌词（T83）—— **跨进程契约**
// ---------------------------------------------------------------------------
//
// ⚠️ **这个文件存在的唯一理由**：把主进程 IPC 的**载荷形状**
//    与渲染层桥的**契约形状**对齐 ——
//
// - 主进程 `lyric:embedded` 返回**对象** `{ content, layer }`（`layer` 命中哪一层，排查用）；
// - 渲染层桥 `readEmbeddedLyric(id)` 的契约是**字符串**（`Promise<string>`）。
//
// ⚠️ **两者必须在这里对齐**（实测踩过）：不对齐时渲染层拿到的是对象，
//    被 `typeof content === 'string'` 判成「**没有**内嵌歌词」
//    ⇒ **静默失效**（主进程明明取到了，界面却一直显示「暂无歌词」）。
//
// ⚠️ 参照 `shared/spectrum.ts`：**纯函数**模块（可被 preload / 渲染层 / 单测共用）。
// ---------------------------------------------------------------------------

/** 内嵌歌词**命中了哪一层**（排查用；`'none'` = 哪层都没有）。 */
export type EmbeddedLyricLayer = 'file' | 'stream' | 'none'

/** 主进程 → 渲染层的**载荷**（`lyric:embedded` 的返回值）。 */
export interface EmbeddedLyricPayload {
  /** LRC 文本；**空串 = 没有内嵌歌词**。 */
  content: string
  /** 命中了哪一层。 */
  layer: EmbeddedLyricLayer
}

/**
 * 把 IPC 的载荷**适配**成桥契约要求的字符串。
 *
 * ⚠️ **永不抛**：载荷不是预期形状 ⇒ 返回空串（当作「没有内嵌歌词」）。
 *    取歌词失败不该把整个取词流程炸掉（界面显示「暂无歌词」即可）。
 *
 * @param payload IPC 的返回值（**不信任**它的形状）。
 * @returns LRC 文本；没有 ⇒ 空串。
 */
export function toEmbeddedLyricText(payload: unknown): string {
  // ⚠️ 已经是字符串 ⇒ 原样（兼容「IPC 直接回文本」的形状）。
  if (typeof payload === 'string') return payload
  if (payload === null || typeof payload !== 'object') return ''
  const record = payload as { content?: unknown }
  return typeof record.content === 'string' ? record.content : ''
}
