// ---------------------------------------------------------------------------
// 批量下载工具条（T27）
// ---------------------------------------------------------------------------
//
// 干什么
// ---------------------------------------------------------------------------
// 用户在列表里多选（Ctrl / Shift 点选）若干首 → 顶部出现一条工具条：
//
//   已选 12 首   [下载所选]   [取消选择]
//                已排队下载 12 首
//
// 点「下载所选」→ 把这 12 首**依次排进**下载队列。
//
// ⚠️ **不会并发下载**：主进程的 `DownloadManager` 本身就是**串行队列**
//    （一次只下一个，中继带宽有限）→ 批量只是「排队」，不是「同时下」。
//
// ⚠️ **如实汇报**：已经下好的、已经在队列里的会被**跳过**，
//    提示里会写清楚「排队几首 / 跳过几首 / 失败几首」——
//    不把「跳过」说成「排队成功」。
//
// ---------------------------------------------------------------------------
// 与既有组件的关系
// ---------------------------------------------------------------------------
// - 选中态由 `useBatchSelection`（`batchSelection.ts`）持有；
// - 本组件**只管显示与发起**，不持有选中态 → 页面把选中的歌曲传进来即可；
// - 样式住在 `batch-download-bar.css`（组件样式独立成文件，仓库约定），
//   颜色**只用语义变量**（`src/styles/tokens.css`）。
//
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement, type ReactNode } from 'react'

import type { Song } from '../../shared/types'
import { useDownloadStore, type BatchDownloadResult } from '../state/downloadStore'
import './batch-download-bar.css'

/** `BatchDownloadBar` 的属性。 */
export interface BatchDownloadBarProps {
  /** 选中的歌曲（由 `useBatchSelection` 给出）。 */
  songs: Song[]
  /** 清空选中（可选）。 */
  onClear?: () => void
  /**
   * 额外的批量操作（**可选插槽**，T28 的「加入歌单」走这里）。
   *
   * ⚠️ **纯增量**：不传 → DOM 一字不变（既有页面的渲染结果不变）。
   */
  extra?: ReactNode
}

/**
 * 把批量下载的结果写成一句人话。
 *
 * ⚠️ **如实汇报**：「跳过」与「失败」都**不能**说成「排队成功」。
 *
 * @param result 批量下载的结果。
 * @param error  失败时的具体原因（可空）。
 */
export function describeBatchResult(
  result: BatchDownloadResult,
  error?: string | null,
): string {
  const { queued, skipped, failed } = result
  if (queued === 0 && skipped === 0) {
    if (failed > 0) {
      // ⚠️ **带上原因**（如「当前环境不支持下载」）——只说「失败了」等于没说。
      const reason = error ? `：${error}` : ''
      return `没有歌曲被排队（${failed} 首启动失败${reason}）`
    }
    return '没有可下载的歌曲'
  }
  const parts: string[] = []
  if (queued > 0) parts.push(`已排队下载 ${queued} 首`)
  if (skipped > 0) parts.push(`跳过 ${skipped} 首（已在本地或队列中）`)
  if (failed > 0) parts.push(`${failed} 首启动失败`)
  const text = parts.join('，')
  return failed > 0 && error ? `${text}：${error}` : text
}

/**
 * 批量下载工具条。
 *
 * ⚠️ **常驻渲染，且高度恒定**（没选中时显示一行提示）。
 *
 * ⚠️ 为什么**不能**「没选中就不渲染」——那是本任务踩过的**真缺陷**：
 *    工具条一旦在**第一次单击**时冒出来，整个列表就被**往下推**了 30 多像素
 *    → 用户（和 E2E）的**第二击落在别的行上** → 浏览器不再派发 `dblclick`
 *    → **双击播放直接失效**（E2E 里表现为「播放条一直显示『未在播放』」）。
 *    ⇒ 工具条**一直在那儿**、**高度恒定**，列表顶部的位置才不会变。
 *    顺带还有个好处：**多选这件事变得可发现**（提示语告诉用户怎么多选）。
 */
export function BatchDownloadBar({
  songs,
  onClear,
  extra,
}: BatchDownloadBarProps): ReactElement {
  const startMany = useDownloadStore((state) => state.startMany)
  /** 在途（按钮禁用，防重复点击）。 */
  const [busy, setBusy] = useState(false)
  /** 结果提示（`null` = 还没点过）。 */
  const [message, setMessage] = useState<string | null>(null)

  const handleDownload = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await startMany(songs)
      // ⚠️ 读**一次**store 快照拿失败原因（`startMany` 内部刚写过）。
      //    不用订阅 → 不会把**别的**组件留下的旧错误显示到这里。
      const error = useDownloadStore.getState().error
      setMessage(describeBatchResult(result, error))
    } finally {
      setBusy(false)
    }
  }, [songs, startMany])

  const count = songs.length

  return (
    <div className="fnm-batchdownload" data-testid="fnm-batch-download-bar">
      {count > 0 ? (
        <span className="fnm-batchdownload__count">已选 {count} 首</span>
      ) : (
        // ⚠️ 提示语里**不能**出现「已选 N 首」——否则 E2E / 单测会把它当成计数。
        <span className="fnm-batchdownload__hint">Ctrl / Shift 多选后可批量下载</span>
      )}
      {/*
       * ⚠️ **额外的批量操作（可选插槽）必须挂在「已选 / 提示」之外**：
       *    插槽里的控件（T28 的「加入歌单」）在**写回成功后会清空选中**
       *    —— 若插槽跟着「已选 N 首」那个分支一起被卸载，
       *    组件的内部状态（含**成功提示**）就一起没了
       *    （E2E 实测：写回成功了，提示却一闪而过 → 断言「已把 N 首加入歌单」找不到）。
       */}
      {extra}
      {count > 0 && (
        <>
          <button
            type="button"
            className="fnm-batchdownload__action"
            data-testid="fnm-batch-download-button"
            aria-label={`下载所选 ${count} 首`}
            disabled={busy}
            onClick={() => void handleDownload()}
          >
            下载所选
          </button>
          {onClear && (
            <button
              type="button"
              className="fnm-batchdownload__clear"
              onClick={onClear}
              disabled={busy}
            >
              取消选择
            </button>
          )}
        </>
      )}
      {message && (
        <p className="fnm-batchdownload__message" role="status">
          {message}
        </p>
      )}
    </div>
  )
}
