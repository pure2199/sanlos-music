import type { ConnectionKind } from '../../shared/types'

/** 链路类型 → 界面文案（内网直连 / 公网直连 / 中继）。 */
export const KIND_LABELS: Record<ConnectionKind, string> = {
  lan: '内网直连',
  public: '公网直连',
  relay: '中继',
}

/**
 * 中继链路的**兜底**带宽提示。
 *
 * ⚠️ 主进程的 `ConnectionInfo.bandwidthHint` 有值时**优先用主进程给的值**，
 *    只有它缺席时才用这句兜底文案（追加要求 H）。
 */
export const RELAY_BANDWIDTH_HINT =
  '中继带宽受限（约 0.5–4 Mbps），无损与下载建议在局域网内进行'
