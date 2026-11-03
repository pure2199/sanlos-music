// ---------------------------------------------------------------------------
// 兜底解码的**渲染层接线**（Task 12）
// ---------------------------------------------------------------------------
//
// 职责
// 1. 把「这首歌 Chromium 解不了」翻译成一次**主进程转码请求**；
// 2. 把主进程返回的结果压成引擎要的 `FallbackPreparation`。
//
// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------
// - 渲染进程**只说「给 songId 兜底一下」**，**碰不到路径**、**碰不到凭证**；
// - 没有桥（浏览器预览 / 单元测试）→ **降级**为「兜底不可用」，
//   **不崩、不静默失败**（引擎会写可读错误）；
// - 失败原因用**可判别的码**（`reason`），**不靠文案匹配**。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。

import type { FfmpegFallbackResult, FfmpegStatus } from '../../shared/ffmpeg'
import type { PlayerBridge } from '../../shared/playerBridge'
import type { Song } from '../../shared/types'
import type { FallbackPreparation } from './engine'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 兜底不可用时的统一结果（**没有桥** / **请求失败**）。 */
function unavailable(reason: 'no-ffmpeg' | 'no-local' | 'failed', detail: string | null): FallbackPreparation {
  return { url: null, reason, detail }
}

/**
 * 把主进程返回的兜底结果压成引擎要的形状。
 *
 * ⚠️ **URL 为空串 = 失败**（引擎据此写友好提示）。
 */
function toPreparation(result: FfmpegFallbackResult | null | undefined): FallbackPreparation {
  const url = typeof result?.url === 'string' ? result.url : ''
  if (url.length > 0) return { url, reason: null, detail: null }
  const reason = result?.reason ?? 'failed'
  const detail = typeof result?.detail === 'string' ? result.detail : null
  return { url: null, reason, detail }
}

/**
 * 桥**是否支持** FFmpeg 兜底（**同步**判定）。
 *
 * ⚠️ 给设置面板用：没有桥时**不要发起异步请求**——
 *    异步 `setState` 会跑在 `act()` 之外（测试里会刷 act 警告），
 *    而且「根本没有桥」时压根不需要探测。
 */
export function hasFfmpegSupport(): boolean {
  const bridge = playerBridge()
  return typeof bridge?.ffmpegStatus === 'function'
}

/**
 * 探测本机的 FFmpeg（给设置面板用）。
 *
 * ⚠️ 没桥 / 请求失败 → `{ available: false }`（**不抛异常**：
 *    「没装 FFmpeg」是**正常状态**，不是错误）。
 */
export async function detectFfmpegStatus(): Promise<FfmpegStatus> {
  const bridge = playerBridge()
  if (!bridge) return { available: false, path: '', version: '' }
  try {
    const status = await bridge.ffmpegStatus()
    return {
      available: status?.available === true,
      path: typeof status?.path === 'string' ? status.path : '',
      version: typeof status?.version === 'string' ? status.version : '',
    }
  } catch {
    return { available: false, path: '', version: '' }
  }
}

/**
 * 为一首歌做兜底解码（引擎的 `prepareSource` 接缝）。
 *
 * @param song  要播的曲目（**只用它的 `id`**，其余字段不参与）。
 * @param _label 命中的格式名（大写，如 `APE`）——**本函数不用它**：
 *    提示文案由**引擎**用它自己那份 `label` 拼（`fallbackUnavailableMessage`）；
 *    这里保留该形参，只是为了与引擎的 `prepareSource` 接缝**保持同形**。
 *
 * @returns 成功时带可播放的**本地地址**；失败时带**可判别**的 `reason`。
 */
export async function prepareFallbackSource(
  song: Song,
  _label: string,
): Promise<FallbackPreparation> {
  const bridge = playerBridge()
  // ⚠️ 没有桥 → 引擎会写「兜底不可用」的可读错误（**不静默失败**）。
  if (!bridge) return unavailable('no-ffmpeg', null)
  try {
    const result = await bridge.ffmpegFallback(song.id)
    return toPreparation(result)
  } catch {
    return unavailable('failed', null)
  }
}
