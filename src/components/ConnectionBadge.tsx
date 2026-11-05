import { useEffect, useState, type ReactElement } from 'react'

import { getBridge } from '../lib/bridge'
import { KIND_LABELS } from '../lib/connection'
import { useSessionStore } from '../state/sessionStore'
import './connection-badge.css'

// ---------------------------------------------------------------------------
// 连接链路指示器（Task 10b）
//
// - 当前链路来自 `window.fn.connectionInfo()`（`ConnectionInfo | null`）；
// - 展示文案按 `kind` 分三种：内网直连 / 公网直连 / 中继；
// - 点击展开最近一次 `probe()` 的全部候选（缓存在 `sessionStore.candidates`）。
//
// ⚠️ **T51：中继的带宽提示已经挪走**（→ `RelayHint` 组件）。
//    它原本是这个徽标的一部分：徽标是纵向 flex，提示把徽标撑到 **320px 宽**
//    → 顶栏第一行放不下 → **整个顶栏被撑成两行**（58px → 141px），
//    提示文字还自己折行，橙字夹在 13px 的导航按钮中间，非常突兀。
//    ⇒ 现在徽标只留一个触发器（~62px），提示独立渲染在**页面内容区顶部**。
// ---------------------------------------------------------------------------

export function ConnectionBadge(): ReactElement {
  const connection = useSessionStore((s) => s.connection)
  const candidates = useSessionStore((s) => s.candidates)
  const setConnection = useSessionStore((s) => s.setConnection)
  const [expanded, setExpanded] = useState(false)

  // 读取当前链路（只在挂载时读一次；没有会话时主进程返回 null）。
  // ⚠️ 写的是全局 store，卸载后写入是安全的——不用 `cancelled` 标志丢弃结果
  //    （StrictMode 下 effect 会跑两遍，丢第一次的结果会让链路指示器一直停在「未连接」）。
  useEffect(() => {
    const bridge = getBridge()
    if (!bridge) return
    void (async () => {
      try {
        const info = await bridge.connectionInfo()
        setConnection(info)
      } catch {
        // 没有会话 / 服务器不可达：保持「未连接」。
      }
    })()
  }, [setConnection])

  const kind = connection?.kind ?? null
  const kindLabel = kind === null ? '未连接' : KIND_LABELS[kind]

  return (
    <div className="fnm-badge">
      <button
        type="button"
        className="fnm-badge__trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="fnm-badge__kind">{kindLabel}</span>
        <span className="fnm-badge__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {expanded && (
        <div className="fnm-badge__panel">
          {connection && <p className="fnm-badge__url">{connection.url}</p>}
          {candidates.length === 0 ? (
            <p className="fnm-badge__empty">暂无候选链路探测结果</p>
          ) : (
            <ul className="fnm-badge__candidates">
              {candidates.map((candidate) => (
                <li
                  key={candidate.address}
                  className="fnm-badge__candidate"
                  data-status={
                    !candidate.ok ? 'unreachable' : candidate.error ? 'note' : 'ok'
                  }
                >
                  <span className="fnm-badge__candidate-label">{candidate.label}</span>
                  <span className="fnm-badge__candidate-kind">
                    {KIND_LABELS[candidate.kind]}
                  </span>
                  <span className="fnm-badge__candidate-address">{candidate.address}</span>
                  <span className="fnm-badge__candidate-status">
                    {candidate.ok ? '可达' : '不可达'}
                  </span>
                  {candidate.error && (
                    <span className="fnm-badge__candidate-note">{candidate.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
