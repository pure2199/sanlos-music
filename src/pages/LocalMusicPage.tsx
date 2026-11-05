// ---------------------------------------------------------------------------
// 本地音乐页（T38）
// ---------------------------------------------------------------------------
//
// **没登录也能当播放器用**：这一页不碰 NAS，只用本机的东西。
//
// 两个分区：
// - **本地文件**：用户通过对话框加进来的本地音频（登记在主进程的
//   「本地曲目登记表」里）；
// - **已下载**：从 NAS 下载到本地的副本（下载索引）。
//
// ⚠️ **渲染进程不碰文件系统**：它只能让主进程弹对话框、把选中的路径交给
//    主进程登记、拿回登记好的清单。
//
// ⚠️ **标签解析（T39）在主进程**：歌名 / 歌手优先取**文件内嵌标签**，
//    读不到才按文件名反推（近似值）；时长来自标签，播放后仍以媒体元素实测为准。
//
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, type ReactElement } from 'react'

import type { Song } from '../../shared/types'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { SongList } from '../components/SongList'
import { downloadEntryToSong, useDownloadStore } from '../state/downloadStore'
import { localItemToSong, pendingTagCount, useLocalLibraryStore } from '../state/localLibraryStore'
import { useSessionStore } from '../state/sessionStore'
import './local-music-page.css'

/** `LocalMusicPage` 的属性。 */
export interface LocalMusicPageProps {
  /**
   * 双击歌曲时回调。
   *
   * ⚠️ 第三个参数 `list` 是「整队口径」——当前分区**已加载**的全部歌曲。
   */
  onPlay?: (song: Song, index: number, list: Song[]) => void
  /** 「去登录」按钮的回调（不传就不渲染这个按钮）。 */
  onGoToLogin?: () => void
}

/** 本地音乐页。 */
export function LocalMusicPage({ onPlay, onGoToLogin }: LocalMusicPageProps): ReactElement {
  const items = useLocalLibraryStore((s) => s.items)
  const loading = useLocalLibraryStore((s) => s.loading)
  const error = useLocalLibraryStore((s) => s.error)
  const load = useLocalLibraryStore((s) => s.load)
  const addFiles = useLocalLibraryStore((s) => s.addFiles)
  const addFolder = useLocalLibraryStore((s) => s.addFolder)
  const remove = useLocalLibraryStore((s) => s.remove)

  const entries = useDownloadStore((s) => s.entries)
  const connected = useSessionStore((s) => s.session.connected)

  useEffect(() => {
    void load()
  }, [load])

  const localSongs = useMemo(() => items.map(localItemToSong), [items])
  const downloadedSongs = useMemo(
    () => Object.values(entries).map(downloadEntryToSong),
    [entries],
  )
  /** 还有多少首**没读标签**（T39：主进程正在后台读）。 */
  const pending = useMemo(() => pendingTagCount(items), [items])

  /** 行内「移除」——**只从清单里去掉，不删磁盘上的文件**。 */
  const renderLocalRowActions = useCallback(
    (song: Song) => (
      <button
        type="button"
        className="fnm-localmusic__remove"
        aria-label={`移除 ${song.title}`}
        onClick={(event) => {
          event.stopPropagation()
          void remove(song.id)
        }}
      >
        移除
      </button>
    ),
    [remove],
  )

  return (
    <LibraryPageShell
      title="本地音乐"
      actionError={error}
      loading={loading}
      loadingText="正在扫描本地音乐…"
    >
      {!connected && (
        <p className="fnm-localmusic__notice" role="status">
          未登录：现在只能播放本地音乐和已下载的曲目。登录 NAS 后还能用曲库、收藏与歌单。
          {onGoToLogin && (
            <button type="button" className="fnm-localmusic__link" onClick={onGoToLogin}>
              去登录
            </button>
          )}
        </p>
      )}

      <div className="fnm-localmusic__toolbar">
        <button type="button" className="fnm-localmusic__button" onClick={() => void addFiles()}>
          添加文件
        </button>
        <button type="button" className="fnm-localmusic__button" onClick={() => void addFolder()}>
          添加文件夹
        </button>
        <span className="fnm-localmusic__hint">
          歌名与歌手优先读文件内标签，读不到才按文件名推断；移除只是从列表里去掉，不会删除磁盘上的文件。
        </span>
      </div>

      {pending > 0 && (
        // ⚠️ 用 `aria-live` 而不是 `role="status"`：页面里已经有另一个
        //    `status` 角色（未登录提示条）——**同页两个 status 会撞角色查询**。
        <p className="fnm-localmusic__pending" aria-live="polite">
          正在读取标签，还剩 {pending} 首…
        </p>
      )}

      <section className="fnm-localmusic__section" aria-label="本地文件">
        <h2 className="fnm-localmusic__section-title">本地文件</h2>
        <SongList
          songs={localSongs}
          onPlay={onPlay ?? (() => undefined)}
          total={localSongs.length}
          emptyLabel="还没有添加本地音乐"
          ariaLabel="本地文件列表"
          renderRowActions={renderLocalRowActions}
        />
      </section>

      <section className="fnm-localmusic__section" aria-label="已下载">
        <h2 className="fnm-localmusic__section-title">已下载</h2>
        <SongList
          songs={downloadedSongs}
          onPlay={onPlay ?? (() => undefined)}
          total={downloadedSongs.length}
          emptyLabel="还没有下载过曲目"
          ariaLabel="已下载列表"
        />
      </section>
    </LibraryPageShell>
  )
}
