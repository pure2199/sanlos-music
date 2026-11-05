import { type ReactElement } from 'react'

import { RELAY_BANDWIDTH_HINT } from '../lib/connection'
import { useSessionStore } from '../state/sessionStore'
import './connection-badge.css'

// ---------------------------------------------------------------------------
// 中继带宽提示（T51）。
//
// ⚠️ **为什么从顶栏挪到页面内容区**：
//    它原本是连接徽标（`ConnectionBadge`）的一部分 —— 徽标是纵向 flex，
//    提示把徽标撑到 **320px 宽** → 顶栏第一行放不下
//    → **整个顶栏被撑成两行**（58px → 141px，真机实测），
//      提示文字还自己折成两行，橙字夹在 13px 的导航按钮中间，非常突兀。
//    ⇒ 现在它是主区顶部的一条**独立提示**：一行 12px 灰字，顶栏恢复单行。
//
// ⚠️ **显示条件不变**：只有链路是 `relay` 才显示；
//    文案仍然是「主进程给的 `bandwidthHint` 优先，没有才用兜底文案」（追加要求 H）。
// ---------------------------------------------------------------------------

export function RelayHint(): ReactElement | null {
  const connection = useSessionStore((s) => s.connection)
  const kind = connection?.kind ?? null
  if (kind !== 'relay') return null

  // ⚠️ 主进程给了值就用它的，没给才用兜底文案（追加要求 H）。
  const hint = connection?.bandwidthHint?.trim() || RELAY_BANDWIDTH_HINT

  return (
    <p className="fnm-relayhint" role="status">
      {hint}
    </p>
  )
}
