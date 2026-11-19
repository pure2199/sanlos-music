// ---------------------------------------------------------------------------
// 共享库页（T122）
// ---------------------------------------------------------------------------
//
// ⚠️ **这一页解决什么**
// ---------------------------------------------------------------------------
// 服务端从飞牛更新后有了「共享库」（`/shared-library/*`）——**2026-11-20 真机实测**：
//
// - `GET /shared-library/list` ⇒ `code=0`，本机 **2** 个共享库；
// - 每个共享库的 `path` **正好就是** `/app-center/authed-dir/list` 的 2 个授权目录
//   ⇒ **共享库不是另一份曲库**，是**同一个曲库的「共享视角」**；
// - `name` **实测是空串** ⇒ 展示名用 `path` 末段兜底。
//
// ⇒ 所以本页**不新造一条取数路径**：共享库的内容**复用 T120 的目录浏览**
//    （`/folder-view/list`）—— 目录树 + 曲目，与「有声」页同一套口径。
//
// ⚠️ **只读**：服务端另有 `create` / `edit` / `delete` / `scan` / `scan-all` /
//    `reconnect`（**写操作**）⇒ **一律不接**——客户端是**播放端**，不是 NAS 管理端。
//
// ⚠️ **老服务端没有这个端点** ⇒ 响应 body 是 `null` ⇒ 调用抛错
//    ⇒ 本页显示「服务端不支持共享库」**如实说明**，**不回落**（曲库没少什么，
//    回落全库扫描只是白扫一遍）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState, type ReactElement } from 'react'

import type { SharedLibrary, Song } from '../../shared/types'
import { isUnsupportedError, sharedLibraryApi, type SharedLibraryApi } from '../api/sharedLibrary'
import { folderTrackToSong, type RawFolderNode } from '../api/folder'
import { formatCount } from '../components/Cards'
import { LibraryPageShell } from '../components/LibraryPageShell'
import { SongList } from '../components/SongList'
import './shared-libraries-page.css'

/** 把异常变成可读的文案。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '操作失败，请稍后重试'
}

/** 面包屑上的一节。 */
interface TrailItem {
  /** 目录路径。 */
  path: string
  /** 展示名。 */
  name: string
}

/** `SharedLibrariesPage` 的属性。 */
export interface SharedLibrariesPageProps {
  /** 注入的接口实现（测试用假实现；不传则走真实实现）。 */
  api?: SharedLibraryApi
  /**
   * 双击歌曲时回调。
   *
   * ⚠️ **第三个参数 `list` 是「整队口径」**：当前目录**已加载**的全部歌曲。
   *    消费方（`src/App.tsx`）用它调 `playerStore.playTrack(song, list)`。
   */
  onPlay?: (song: Song, index: number, list: Song[]) => void
}

/** 共享库页。 */
export function SharedLibrariesPage({
  api = sharedLibraryApi,
  onPlay,
}: SharedLibrariesPageProps): ReactElement {
  // ---- 共享库列表 --------------------------------------------------------
  const [libraries, setLibraries] = useState<SharedLibrary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  // ---- 浏览状态（选中的共享库 + 当前目录）--------------------------------
  const [selected, setSelected] = useState<SharedLibrary | null>(null)
  const [node, setNode] = useState<RawFolderNode | null>(null)
  const [trail, setTrail] = useState<TrailItem[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)

  /** 列共享库（**只读**）。 */
  const loadLibraries = useCallback(async (): Promise<void> => {
    setLoading(true)
    setListError(null)
    try {
      setLibraries(await api.list())
    } catch (err) {
      setLibraries([])
      setListError(
        isUnsupportedError(err)
          ? '服务端不支持共享库（这台 NAS 的音乐服务没有这个接口）'
          : describeError(err),
      )
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void loadLibraries()
  }, [loadLibraries])

  /** 浏览某个目录（复用目录浏览）。 */
  const browse = useCallback(
    async (path: string, nextTrail: TrailItem[]): Promise<void> => {
      setBrowsing(true)
      setBrowseError(null)
      try {
        const listing = await api.browse(path)
        setNode(listing)
        setTrail(nextTrail)
      } catch (err) {
        setNode(null)
        setTrail(nextTrail)
        setBrowseError(
          isUnsupportedError(err)
            ? '服务端不支持按目录浏览（这台 NAS 的音乐服务没有这个接口）'
            : describeError(err),
        )
      } finally {
        setBrowsing(false)
      }
    },
    [api],
  )

  /** 点共享库 → 进它的根目录。 */
  const openLibrary = useCallback(
    (library: SharedLibrary): void => {
      setSelected(library)
      void browse(library.path, [{ path: library.path, name: library.displayName }])
    },
    [browse],
  )

  /** 点子目录 → 往下钻一层。 */
  const openFolder = useCallback(
    (path: string, name: string): void => {
      void browse(path, [...trail, { path, name }])
    },
    [browse, trail],
  )

  /** 返回上一层；已经到共享库根 ⇒ 回到共享库列表。 */
  const goBack = useCallback((): void => {
    if (trail.length <= 1) {
      setSelected(null)
      setNode(null)
      setTrail([])
      setBrowseError(null)
      return
    }
    const next = trail.slice(0, -1)
    const target = next[next.length - 1]
    if (target) void browse(target.path, next)
  }, [browse, trail])

  // ---- 派生数据 ----------------------------------------------------------
  /** 当前目录下的曲目（映射成领域模型 ⇒ 与曲库同一套字段）。 */
  const songs: Song[] = (node?.tracks ?? [])
    .filter((track) => track && track.isAdminDeleted !== true)
    .map(folderTrackToSong)
  /** 当前目录下的子目录（管理员删掉的跳过）。 */
  const folders = (node?.folders ?? []).filter(
    (folder): folder is RawFolderNode & { path: string } =>
      Boolean(folder) &&
      typeof folder.path === 'string' &&
      folder.path.length > 0 &&
      !folder.isAdminDeleted,
  )

  // ---- 状态行 ------------------------------------------------------------
  const status = selected
    ? `目录：${node?.path ?? selected.path} · ${formatCount(folders.length)} 个子目录 · ${formatCount(songs.length)} 首`
    : `共享库 ${formatCount(libraries.length)} 个`

  return (
    <LibraryPageShell
      title="共享库"
      status={status}
      error={listError ?? browseError}
      loading={loading || browsing}
      loadingText={selected ? '正在浏览共享库…' : '正在加载共享库…'}
    >
      {selected ? (
        <div className="sanlos-shared">
          <div className="sanlos-shared__toolbar">
            <button type="button" className="sanlos-shared__back" onClick={goBack}>
              {trail.length <= 1 ? '返回共享库列表' : '返回上一级'}
            </button>
            <span className="sanlos-shared__trail">
              {trail.map((item, index) => (
                <span key={`${item.path}-${index}`} className="sanlos-shared__crumb">
                  {index > 0 ? ' / ' : ''}
                  {item.name}
                </span>
              ))}
            </span>
          </div>

          {folders.length > 0 && (
            <ul className="sanlos-shared__folders">
              {folders.map((folder) => (
                <li key={folder.path}>
                  <button
                    type="button"
                    className="sanlos-shared__folder"
                    onClick={() => openFolder(folder.path, String(folder.name ?? folder.path))}
                  >
                    {String(folder.name ?? folder.path)}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <SongList
            songs={songs}
            total={songs.length}
            onPlay={(song, index, list) => onPlay?.(song, index, list)}
            emptyLabel="这个目录里没有曲目"
            ariaLabel="共享库曲目"
          />
        </div>
      ) : (
        <div className="sanlos-shared">
          {libraries.length === 0 && !loading && !listError ? (
            <p className="sanlos-shared__empty">这台 NAS 没有共享库</p>
          ) : (
            <ul className="sanlos-shared__list">
              {libraries.map((library) => (
                <li key={library.id || library.path}>
                  <button
                    type="button"
                    className="sanlos-shared__item"
                    onClick={() => openLibrary(library)}
                  >
                    <span className="sanlos-shared__name">{library.displayName}</span>
                    <span className="sanlos-shared__path">{library.path}</span>
                    <span className="sanlos-shared__meta">
                      {library.contentLastChangedAt !== null
                        ? `内容更新：${formatUnixSeconds(library.contentLastChangedAt)}（UTC）`
                        : '内容更新时间未知'}
                      {library.accessStatus !== 0 ? ' · 访问异常' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </LibraryPageShell>
  )
}

/**
 * Unix 秒 → `YYYY-MM-DD HH:mm`（**UTC**）。
 *
 * ⚠️ 用 UTC 而不是本地时区：**界面文案要可预期**（且测试能钉住），
 *    所以这里明确标注「UTC」，不假装是本地时间。
 */
function formatUnixSeconds(seconds: number): string {
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return '未知'
  return date.toISOString().slice(0, 16).replace('T', ' ')
}
