// ---------------------------------------------------------------------------
// 封面 URL 的**唯一**拼装点（Task 14 · 简报 C / 控制器追加要求 J）
//
// 渲染进程里封面的最终形状是：
//
//     fnm://srv/static/cover?coverId=<encoded>&size=<size>
//
// - `srv` 之后是**相对 API 基址**的路径，**不含** `/music/api/v1`
//   （主进程的协议代理会把它还原成 `<server>/music/api/v1/static/cover`）；
// - `static/cover` 在代理的二进制白名单里，走流式透传；
// - `coverId` 形如 `track_<hex>` / `album_<hex>` / `artist_<hex>`
//   （`src/api/client.ts` 的 `normalizeCoverId` 已经把不合法的过滤成空串 / null）。
//
// ⚠️ **全项目只有这一处**拼这个地址：复审会 grep，任何别处出现该字面量都算失败。
//    组件一律通过 `coverUrl()` 拿 URL，拿不到就渲染占位块（不渲染 `<img>`）。
// ---------------------------------------------------------------------------

/**
 * 封面默认尺寸（服务端 `size` 参数）。
 *
 * ⚠️ **真实 NAS 的 `size` 取值尚未校准**（联调清单 Step K 会补测），
 *    校准后**只改这一处**（`COVER_SIZE_DEFAULT`）即可——
 *    全项目没有第二处硬编码尺寸，封面 URL 也只有 `coverUrl()` 一个拼装点。
 */
export const COVER_SIZE_DEFAULT = 200

/**
 * 拼装封面 URL。
 *
 * @param coverId 封面 id；**空串**（`Song` 无封面）或 **`null`**（`Album` / `Artist` /
 *                `Genre` 无封面）都表示「没有封面」→ 返回 `null`，
 *                调用方据此**不渲染 `<img>`**，改渲染占位块。
 * @param size    传给服务端的尺寸；非法值回落到 `COVER_SIZE_DEFAULT`。
 *
 * @returns 封面 URL；没有封面时返回 `null`。
 */
export function coverUrl(
  coverId: string | null | undefined,
  size: number = COVER_SIZE_DEFAULT,
): string | null {
  if (typeof coverId !== 'string') return null
  const trimmed = coverId.trim()
  if (trimmed.length === 0) return null

  const normalizedSize =
    typeof size === 'number' && Number.isFinite(size) && size > 0
      ? Math.floor(size)
      : COVER_SIZE_DEFAULT

  return (
    `fnm://srv/static/cover?coverId=${encodeURIComponent(trimmed)}` +
    `&size=${encodeURIComponent(String(normalizedSize))}`
  )
}
