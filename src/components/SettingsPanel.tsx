// ---------------------------------------------------------------------------
// 设置面板（Task 8）
// ---------------------------------------------------------------------------
//
// 目前只有一项：**「关闭窗口时」的行为**。
//
// ⚠️ 这一项**此前没有 UI**（`prefs.closeBehavior` 早就写进 `prefs.json`、
//    主进程也早就消费它，但用户改不了）——审计报表 P1 的「偏好有键无 UI」。
//
// ⚠️ 偏好的**单一真相源 = 主进程 `prefs.json`**：本面板只经
//    `useAppPrefsStore` 读写，不碰偏好文件本身。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），
//    样式住在同目录的 `settings-panel.css`。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState, type ReactElement } from 'react'

import type { CloseBehavior } from '../../shared/playerBridge'
import type { FfmpegStatus } from '../../shared/ffmpeg'
import { useAppPrefsStore } from '../state/appPrefsStore'
import { totalDownloadedBytes, useDownloadStore } from '../state/downloadStore'
import { detectFfmpegStatus, hasFfmpegSupport } from '../player/fallback'
import { formatBytes } from './DownloadButton'
import './settings-panel.css'

/** `SettingsPanel` 的属性。 */
export interface SettingsPanelProps {
  /** 附加类名。 */
  className?: string
}

/** 设置面板。 */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { className } = props
  const closeBehavior = useAppPrefsStore((state) => state.closeBehavior)
  const setCloseBehavior = useAppPrefsStore((state) => state.setCloseBehavior)
  const lyricOverlayVisible = useAppPrefsStore((state) => state.lyricOverlayVisible)
  const setLyricOverlayVisible = useAppPrefsStore((state) => state.setLyricOverlayVisible)
  const error = useAppPrefsStore((state) => state.error)

  const handleChange = useCallback(
    (behavior: CloseBehavior) => {
      void setCloseBehavior(behavior)
    },
    [setCloseBehavior],
  )

  const handleToggleLyricOverlay = useCallback(
    (visible: boolean) => {
      void setLyricOverlayVisible(visible)
    },
    [setLyricOverlayVisible],
  )

  // --- 本地下载（Task 11）-------------------------------------------------
  const localFirst = useDownloadStore((state) => state.localFirst)
  const setLocalFirst = useDownloadStore((state) => state.setLocalFirst)
  const entries = useDownloadStore((state) => state.entries)
  const dir = useDownloadStore((state) => state.dir)
  const setDir = useDownloadStore((state) => state.setDir)
  const clearDownloads = useDownloadStore((state) => state.clear)
  const downloadError = useDownloadStore((state) => state.error)

  /** 下载目录的**输入草稿**（点「保存」才写回主进程偏好）。 */
  const [dirDraft, setDirDraft] = useState(dir)
  useEffect(() => {
    setDirDraft(dir)
  }, [dir])

  const handleToggleLocalFirst = useCallback(
    (enabled: boolean) => {
      void setLocalFirst(enabled)
    },
    [setLocalFirst],
  )

  const handleSaveDir = useCallback(() => {
    void setDir(dirDraft)
  }, [dirDraft, setDir])

  const handleClearDownloads = useCallback(() => {
    void clearDownloads()
  }, [clearDownloads])

  const downloadedCount = Object.keys(entries).length
  const downloadedBytes = totalDownloadedBytes(entries)

  // --- FFmpeg 兜底解码（Task 12）-------------------------------------------
  //
  // ⚠️ **只做检测与展示**：设置里**改不了** FFmpeg 的安装（客户端**绝不**
  //    自动下载 / 安装外部程序），只告诉用户装没装、怎么装。
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>({
    available: false,
    path: '',
    version: '',
  })
  const [ffmpegChecking, setFfmpegChecking] = useState(false)

  const refreshFfmpeg = useCallback((): void => {
    if (!hasFfmpegSupport()) {
      // 没有桥 → 同步置为「未检测到」，**不发起异步请求**。
      setFfmpeg({ available: false, path: '', version: '' })
      return
    }
    setFfmpegChecking(true)
    void detectFfmpegStatus()
      .then((next) => setFfmpeg(next))
      .finally(() => setFfmpegChecking(false))
  }, [])

  useEffect(() => {
    refreshFfmpeg()
  }, [refreshFfmpeg])

  const rootClass = className ? `fnm-settings ${className}` : 'fnm-settings'

  return (
    <section className={rootClass} role="dialog" aria-label="设置">
      <h2 className="fnm-settings__title">设置</h2>

      <fieldset className="fnm-settings__group">
        <legend className="fnm-settings__legend">关闭窗口时</legend>
        <label className="fnm-settings__option">
          <input
            type="radio"
            name="fnm-close-behavior"
            value="hide"
            checked={closeBehavior === 'hide'}
            onChange={() => handleChange('hide')}
          />
          <span>隐藏窗口（播放继续）</span>
        </label>
        <label className="fnm-settings__option">
          <input
            type="radio"
            name="fnm-close-behavior"
            value="quit"
            checked={closeBehavior === 'quit'}
            onChange={() => handleChange('quit')}
          />
          <span>直接退出应用</span>
        </label>
      </fieldset>

      <fieldset className="fnm-settings__group">
        <legend className="fnm-settings__legend">桌面悬浮歌词</legend>
        <label className="fnm-settings__option">
          <input
            type="checkbox"
            name="fnm-lyric-overlay"
            checked={lyricOverlayVisible}
            onChange={(event) => handleToggleLyricOverlay(event.target.checked)}
          />
          <span>显示悬浮歌词（双行逐字，可拖动 / 点歌跳转）</span>
        </label>
      </fieldset>

      <fieldset className="fnm-settings__group">
        <legend className="fnm-settings__legend">本地下载</legend>
        <label className="fnm-settings__option">
          <input
            type="checkbox"
            name="fnm-local-first"
            checked={localFirst}
            onChange={(event) => handleToggleLocalFirst(event.target.checked)}
          />
          <span>本地优先播放（本地有副本就播本地，不再走 NAS）</span>
        </label>
        <label className="fnm-settings__option fnm-settings__option--stack">
          <span>下载目录</span>
          <input
            type="text"
            className="fnm-settings__input"
            name="fnm-download-dir"
            value={dirDraft}
            placeholder="默认：我的音乐\飞牛音乐"
            onChange={(event) => setDirDraft(event.target.value)}
          />
        </label>
        <div className="fnm-settings__row">
          <button
            type="button"
            className="fnm-settings__button"
            onClick={handleSaveDir}
            disabled={dirDraft.trim() === dir.trim()}
          >
            保存目录
          </button>
          <button
            type="button"
            className="fnm-settings__button fnm-settings__button--danger"
            onClick={handleClearDownloads}
            disabled={downloadedCount === 0}
          >
            清空本地下载
          </button>
        </div>
        <p className="fnm-settings__hint">
          已下载 {downloadedCount} 首，占用 {formatBytes(downloadedBytes)}。
        </p>
        {downloadError && (
          <p className="fnm-settings__error" role="alert">
            {downloadError}
          </p>
        )}
      </fieldset>

      <fieldset className="fnm-settings__group">
        <legend className="fnm-settings__legend">FFmpeg 兜底解码</legend>
        <p className="fnm-settings__hint" data-testid="ffmpeg-status">
          {ffmpeg.available
            ? `已检测到 FFmpeg：${ffmpeg.version || ffmpeg.path}`
            : '未检测到 FFmpeg。'}
        </p>
        <p className="fnm-settings__hint">
          APE / ALAC / DSF 等格式 Chromium 解不了：把歌曲下载到本地后，客户端会用 FFmpeg
          转码成 Opus 播放（音质有损，原始文件不变）。
        </p>
        {!ffmpeg.available && (
          <p className="fnm-settings__hint">
            安装方式：<code>winget install Gyan.FFmpeg</code>，装完后点「重新检测」。
          </p>
        )}
        <div className="fnm-settings__row">
          <button
            type="button"
            className="fnm-settings__button"
            onClick={refreshFfmpeg}
            disabled={ffmpegChecking}
          >
            {ffmpegChecking ? '检测中…' : '重新检测'}
          </button>
        </div>
      </fieldset>

      <p className="fnm-settings__hint">窗口位置与尺寸会自动记住，下次启动时恢复。</p>

      {error && (
        <p className="fnm-settings__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
