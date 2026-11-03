// ---------------------------------------------------------------------------
// 行内下载按钮（Task 11）
// ---------------------------------------------------------------------------
//
// 一首歌一个按钮，状态一目了然：
// - **未下载** → 「下载」；
// - **排队中 / 下载中** → 进度（百分比或字节）+ 点一下取消；
// - **失败** → 「重试」（带上失败原因做提示）；
// - **已下载** → 「本地」（不可点，提示本地路径）。
//
// ---------------------------------------------------------------------------
// 约定
// ---------------------------------------------------------------------------
// - 只发「我要下这首歌」的请求；**落盘路径、文件名、断点续传全在主进程**；
// - 渲染进程**碰不到**文件系统，也**碰不到**任何凭证；
// - 样式住在 `download-button.css`，颜色**只用语义变量**（`src/styles/tokens.css`）。
//
// ---------------------------------------------------------------------------
// 与 `SongList` 的关系
// ---------------------------------------------------------------------------
// `SongList` 早就有**可选**的 `renderRowActions` 接缝（Task 16 为收藏按钮加的）。
// 本组件**复用**它，**不改** `SongList` 的渲染结构
// → 既有页面不传这个 prop 时的 DOM **一字不变**。

import { useCallback, type ReactElement, type ReactNode } from 'react'

import type { Song } from '../../shared/types'
import { useDownloadStore } from '../state/downloadStore'
import './download-button.css'

/** `DownloadButton` 的属性。 */
export interface DownloadButtonProps {
  /** 要下载的歌曲。 */
  song: Song
}

/** 把字节数格式化成人类可读的文案（`12.3 MB`）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/**
 * 行内下载按钮。
 *
 * ⚠️ 点击**必须阻止冒泡**（行单击是「选中」）。
 */
export function DownloadButton({ song }: DownloadButtonProps): ReactElement {
  const task = useDownloadStore((state) => state.tasks[song.id])
  const entry = useDownloadStore((state) => state.entries[song.id])
  const start = useDownloadStore((state) => state.start)
  const cancel = useDownloadStore((state) => state.cancel)

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      // ⚠️ 别让点击冒泡到行上（行单击是「选中」）。
      event.stopPropagation()
      if (task && (task.status === 'running' || task.status === 'pending')) {
        void cancel(song.id)
        return
      }
      void start(song)
    },
    [cancel, song, start, task],
  )

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
  }, [])

  // 已下载 → 展示「本地」徽标（不可点，提示路径）。
  if (entry) {
    return (
      <button
        type="button"
        className="fnm-download fnm-download--done"
        data-testid="fnm-download-button"
        data-song-id={song.id}
        data-status="done"
        aria-label="已下载到本地"
        title={entry.file}
        disabled
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={handleDoubleClick}
      >
        本地
      </button>
    )
  }

  if (task && task.status === 'running') {
    const percent =
      task.total > 0 ? Math.min(100, Math.floor((task.received / task.total) * 100)) : null
    const label = percent === null ? formatBytes(task.received) : `${percent}%`
    return (
      <button
        type="button"
        className="fnm-download fnm-download--running"
        data-testid="fnm-download-button"
        data-song-id={song.id}
        data-status="running"
        aria-label={`下载中 ${label}，点击取消`}
        title="点击取消下载"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {label}
      </button>
    )
  }

  if (task && task.status === 'pending') {
    return (
      <button
        type="button"
        className="fnm-download fnm-download--pending"
        data-testid="fnm-download-button"
        data-song-id={song.id}
        data-status="pending"
        aria-label="排队中，点击取消"
        title="点击取消下载"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        排队中
      </button>
    )
  }

  if (task && task.status === 'error') {
    return (
      <button
        type="button"
        className="fnm-download fnm-download--error"
        data-testid="fnm-download-button"
        data-song-id={song.id}
        data-status="error"
        aria-label="下载失败，点击重试"
        title={task.error ?? '下载失败，点击重试'}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        重试
      </button>
    )
  }

  return (
    <button
      type="button"
      className="fnm-download"
      data-testid="fnm-download-button"
      data-song-id={song.id}
      data-status="idle"
      aria-label="下载到本地"
      title="下载到本地"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      下载
    </button>
  )
}

/**
 * 给 `SongList` 用的行内操作渲染器（**可选增量**）。
 *
 * ⚠️ 不传这个 prop 的页面，行内**不产生任何附加节点**（既有渲染结果一字不变）。
 */
export function useDownloadRowActions(): (song: Song, index: number) => ReactNode {
  return useCallback((song: Song): ReactNode => <DownloadButton song={song} />, [])
}
