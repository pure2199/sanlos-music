// ---------------------------------------------------------------------------
// 词岛左端的**专辑封面**（T76）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么左端不再是频谱柱**：用户指令（2026-11-09）——
//    「灵动歌词的左边音效动画换成专辑封面」。
//    ⇒ 左端 = 封面；**右端频谱柱保持不变**（指令只说「左边」）。
//
// ⚠️ **纯展示**：本组件不碰音频、不出网、不接触任何凭证——
//    它只把「封面 id」变成一个 `<img>`，地址由**全项目唯一的拼装点**
//    `src/components/coverUrl.ts` 的 `coverUrl()` 给出（主进程协议代理，
//    凭证由**主进程**附加 ⇒ 渲染层永远拿不到 token）。
//
// ⚠️ **没有封面 / 加载失败** ⇒ 渲染**占位块**，**不渲染 `<img>`**
//    （与 `src/components/Cards.tsx` 的 `CoverImage` 同一口径：
//    不留浏览器默认破图）。

import { useEffect, useState, type ReactElement } from 'react'

import { coverUrl } from '../components/coverUrl'

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

/**
 * 封面在**服务端**请求的边长（`size` 参数）。
 *
 * ⚠️ 与 `electron/tray.ts` 的 `TRAY_COVER_SIZE`（160）、
 *    `src/player/mediaSession.ts` 的 `MEDIA_ARTWORK_SIZE`（160）**保持一致**。
 * ⚠️ 真实 NAS 的 `size` 取值尚未校准（联调清单 Step K），
 *    校准后**只改这一处**即可。
 */
export const ISLAND_COVER_SIZE = 160

/**
 * 封面在词岛里的**显示**边长（像素）。
 *
 * ⚠️ 这只是**显示尺寸**，与**服务端** `size` 参数**无关**——
 *    显示尺寸写在 CSS 里（`.fnm-island__cover`）。
 */
export const ISLAND_COVER_BOX = 56

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/** `IslandCover` 的属性。 */
export interface IslandCoverProps {
  /** 封面 id；空串 / `undefined` / `null` 都表示「没有封面」。 */
  coverId: string | null | undefined
}

/**
 * 词岛左端的专辑封面。
 *
 * - 没有封面 → 渲染**占位块**（不渲染 `<img>`）；
 * - 加载失败（404 / 解码失败）→ 切成占位块；
 * - 换封面 id → **重置**失败状态（上一张的失败不该连累下一张）。
 */
export function IslandCover({ coverId }: IslandCoverProps): ReactElement {
  const [failed, setFailed] = useState(false)
  const url = coverUrl(coverId, ISLAND_COVER_SIZE)

  // 换了封面 id 就重置失败状态。
  useEffect(() => {
    setFailed(false)
  }, [coverId])

  if (!url || failed) {
    return (
      <div
        className="fnm-island__cover fnm-island__cover--placeholder"
        data-testid="fnm-island-cover-placeholder"
        aria-hidden="true"
      >
        ♪
      </div>
    )
  }

  return (
    <img
      className="fnm-island__cover"
      data-testid="fnm-island-cover"
      src={url}
      // ⚠️ 封面是**装饰性**的（曲名就在旁边）⇒ 空 alt（不给读屏器重复念一遍）。
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}
