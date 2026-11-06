// ---------------------------------------------------------------------------
// T66：可听延迟补偿（输出延迟 → 歌词整体延后）
// ---------------------------------------------------------------------------
//
// 起因
// ---------------------------------------------------------------------------
// 媒体时间 T 的声音要经过一段物理延迟（声卡缓冲 / WASAPI 共享模式 / 蓝牙耳机
// 的编解码往返）才到用户耳朵里，而歌词是按**媒体时间**渲染的 ⇒ 整份歌词
// **统一偏晚**。飞牛官方 APP `v1.37.0` 已加「音频输出延迟补偿」，我们此前没有。
//
// 方向（**定死，勿翻**）
// ---------------------------------------------------------------------------
// 媒体位置 T 对应的声音在 `T + L` 才到耳朵 ⇒ 歌词必须等到 `T + L` 才显示
// ⇒ **歌词时间戳整体延后 L** ⇒ `applyOffset(lines, +L)`。
// 这与 `applyOffset` 的既定语义（**正数 = 延后**）一致，
// 也等价于「用 `mediaPos - L` 去查歌词」，但前者**一处生效、三处受益**
// （全屏歌词舞台 / 经典悬浮窗 / 灵动态词岛共用同一份 lines）。
//
// ⚠️ **进度条不受影响**：进度条用媒体真实位置（`store.position`），与 lines 无关。
//
// 模块约束
// ---------------------------------------------------------------------------
// - **纯函数**：不 import Node 内置模块、不 import Electron API；
// - **不引新依赖**；
// - **读不到就回落 0，绝不猜**（见 `audibleLatencyMs`）。
// ---------------------------------------------------------------------------

import { applyOffset, type LyricLine } from './parse'

/**
 * 可听延迟的**上限**（毫秒）。
 *
 * ⚠️ 浏览器上报的延迟**可能是离谱值**（设备切换瞬间的抖动、驱动 bug）。
 *    ⇒ 钳到 1 秒：**宁可少补偿，也不把整份歌词推飞**。
 */
export const MAX_AUDIBLE_LATENCY_MS = 1000

/**
 * 把「输出延迟（秒）」换算成「补偿毫秒」。
 *
 * **回落规则（定死）**：缺失 / 非法 / 非有限 / ≤ 0 ⇒ **0**（= 不补偿）。
 * ⇒ 读不到延迟时，歌词行为与本任务之前**一字不差**（不回归、不谎称已补偿）。
 *
 * @param outputLatencySec 输出延迟（秒）；`null` / `undefined` = 读不到。
 * @returns 补偿毫秒（`0` ~ `MAX_AUDIBLE_LATENCY_MS`）。
 */
export function audibleLatencyMs(outputLatencySec: number | null | undefined): number {
  if (typeof outputLatencySec !== 'number') return 0
  if (!Number.isFinite(outputLatencySec)) return 0
  if (outputLatencySec <= 0) return 0
  const ms = Math.round(outputLatencySec * 1000)
  if (ms <= 0) return 0
  return Math.min(ms, MAX_AUDIBLE_LATENCY_MS)
}

/**
 * 给整份歌词行施加**可听延迟补偿**。
 *
 * - **正数 = 延后**（与 `applyOffset` 一致）：声音到得晚，歌词也要晚显示；
 * - 延迟为 0 → 返回一份**内容相同的新数组**（不修改入参）；
 * - 补偿后仍**严格单调递增**、**时间非负**（这些由 `applyOffset` 保证）。
 *
 * @param lines 原始歌词行。
 * @param outputLatencySec 输出延迟（秒）。
 * @returns 新的数组（不修改入参）。
 */
export function applyAudibleLatency(
  lines: LyricLine[],
  outputLatencySec: number | null | undefined,
): LyricLine[] {
  return applyOffset(lines, audibleLatencyMs(outputLatencySec))
}
