// ---------------------------------------------------------------------------
// 服务端目录浏览（T120）
// ---------------------------------------------------------------------------
//
// ⚠ **为什么要有这个文件**
// ---------------------------------------------------------------------------
// 2026-11-19 飞牛更新后，服务端**已支持按目录浏览**（真机实测，FN 中继，**只打 GET**）：
//
// - `GET /app-center/authed-dir/list`      ⇒ 授权目录（曲库根）
// - `GET /app-center/authed-dir/sub/list`   ⇒ 某个目录下的**子目录**
// - `GET /folder-view/list?parentPath=…`    ⇒ 某个目录的**视图**（子目录 ＋ 直接挂的曲目）
//
// ⇒ 「有声」页**不必**再把 17.3 万首曲目全扫一遍再按 path 关键字挑
// ⇒ 改成**按服务端目录浏览**（详见 `docs/superpowers/specs/2026-11-19-sanlos-music-t120-folder-scan.md`）。
//
// ⚠ **实测出来的三件事（写代码前先记住）**
// ---------------------------------------------------------------------------
// 1. **`tracks` 只在「直接含文件」的目录里才非空** —— 中间层（只有子目录）的 `tracks` 是 `[]`
//    （实测：`/有声小说` ⇒ `tracks=[]`；`/…/赶尸客栈/Disc 01` ⇒ `tracks=76`）
//    ⇒ **必须递归到文件层**；
// 2. **`duration` 是毫秒**（实测 `829492` ⇒ 829.5 秒）⇒ 与 `/track/list` 口径一致 ⇒ 同样 `÷1000`；
// 3. **端点不存在时 body 是 `null`**（不是 `code≠0`）⇒ 老服务端（没更新飞牛）会让调用**抛错**
//    ⇒ 调用方据此**回落**到旧的「全库扫描」。
//
// ⚠ **本文件只用 GET** —— 服务端另有 `POST /folder-view/playable-tracks`，
//    但实测它返回的曲目**字段更少**（没有 `album` / `duration` / `path`）
//    ⇒ 判不了、归并不了 ⇒ **不用它**（也少一个副作用面）。
// ---------------------------------------------------------------------------

import { apiCall, normalizeCoverId } from './client'
// ⚠ **只导类型**（编译后被擦除）⇒ 不会把 `library.ts` 拖进运行时依赖
//    ⇒ 既有测试对 `../src/api/library` 的 `vi.mock` 不受影响。
import type { ScanTrack } from './library'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 服务端目录浏览返回的**原始**曲目形状（真机实测，2026-11-19）。 */
export interface RawFolderTrack {
  guid?: string
  title?: string
  coverId?: string | null
  /** ⚠ **毫秒**。 */
  duration?: number
  isCue?: boolean
  isFavorite?: boolean
  isAdminDeleted?: boolean
  album?: { guid?: string; name?: string; coverId?: string | null } | null
  artists?: { guid?: string; name?: string }[]
  audioSpec?: { format?: string; path?: string; size?: number } | null
}

/** 服务端目录浏览返回的**原始**目录节点形状。 */
export interface RawFolderNode {
  name?: string
  path?: string
  /** 该目录下（含子目录）的曲目总数。 */
  itemCount?: number
  /** ⚠️ 管理员删掉的目录（要**跳过**）。 */
  isAdminDeleted?: boolean
  folders?: RawFolderNode[]
  tracks?: RawFolderTrack[]
}

/** 一个授权目录（曲库根）。 */
export interface AuthedDir {
  path: string
  permission?: string
  comment?: string
  username?: string
}

/** 一个被定位到的目录（「那个文件夹」）。 */
export interface LocatedFolder {
  /** 绝对路径（服务端给的）。 */
  path: string
  /** 目录名（**不含**路径）。 */
  name: string
}

/** 目录浏览的进度回调载荷。 */
export interface FolderScanProgress {
  /** 已访问的目录数。 */
  dirs: number
  /** 已取到的曲目数。 */
  tracks: number
  /** 总曲目数（服务端 `itemCount` 之和；`0` = 还不知道）。 */
  total: number
  /** 已定位到的目录（可能还没定位到 ⇒ 空数组）。 */
  folders: LocatedFolder[]
}

// ---------------------------------------------------------------------------
// 护栏（**别把服务端当不会炸**）
// ---------------------------------------------------------------------------

/** 定位目录的最大深度（0 = 只看授权目录本身）。 */
export const DEFAULT_LOCATE_MAX_DEPTH = 4
/** 定位目录时最多访问多少个目录。 */
export const DEFAULT_LOCATE_MAX_DIRS = 200
/** 收集曲目时最多访问多少个目录。 */
export const DEFAULT_COLLECT_MAX_DIRS = 500
/** 收集曲目时最多取多少首（护栏）。 */
export const DEFAULT_COLLECT_MAX_TRACKS = 50_000
/** 收集曲目时的并发数（与全库扫描同口径）。 */
export const DEFAULT_COLLECT_CONCURRENCY = 8

// ---------------------------------------------------------------------------
// 原始调用
// ---------------------------------------------------------------------------

/**
 * 列授权目录（曲库根）。
 *
 * ⚠ **老服务端没有这个端点** ⇒ body 是 `null` ⇒ `apiCall` 抛错
 *    ⇒ 调用方据此**回落**到旧的「全库扫描」。
 */
export async function listAuthedDirs(): Promise<AuthedDir[]> {
  const data = await apiCall<{ list?: AuthedDir[] }>('/app-center/authed-dir/list')
  const list = Array.isArray(data?.list) ? data.list : []
  return list.filter((d): d is AuthedDir => typeof d?.path === 'string' && d.path.length > 0)
}

/**
 * 列一个目录（`/folder-view/list`）。
 *
 * ⚠ `parentPath` **缺了服务端会返回 `code=100002 invalid arguments`**
 *    （端点存在，只是缺参）⇒ **别**把它当成「端点不存在」。
 *
 * ⚠⚠ **为什么自己拼查询串、不用 `buildQuery`**：通用的 `buildQuery` 用
 *    `URLSearchParams` ⇒ **空格会编码成 `+`**；而目录名里**确实有空格**
 *    （实测「Disc 01」「03 DJ集合」…）⇒ 若服务端不把 `+` 当空格，
 *    **带空格的目录全都查不到** ⇒ 这里**改用 `encodeURIComponent`**（空格 ⇒ `%20`，
 *    这是实测可用的一种）。
 */
export async function listFolder(
  parentPath: string,
  sort = 'title,asc',
): Promise<RawFolderNode> {
  const query = `parentPath=${encodeURIComponent(parentPath)}&sort=${encodeURIComponent(sort)}`
  const data = await apiCall<{ folder?: RawFolderNode; sort?: string }>(
    `/folder-view/list?${query}`,
  )
  return (
    data?.folder ?? {
      name: parentPath.split('/').filter(Boolean).slice(-1)[0] ?? '',
      path: parentPath,
      itemCount: 0,
      folders: [],
      tracks: [],
    }
  )
}

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------

/**
 * 把服务端目录浏览返回的曲目压成扫描用的形状（**与 `/track/list` 的口径完全一致**）。
 *
 * ⚠ 真机实测（2026-11-19）这个端点**不返** `trackNo` 与 `createdAt`
 *    ⇒ 分别是 `null` 与 `null`（真·有声本来 `trackNo` 就多是 `null`；
 *    `createdAt` 只影响全库扫描的「增量水位」，目录扫描用不到）。
 */
function toScanTrack(raw: RawFolderTrack): ScanTrack {
  const album = raw.album
  return {
    id: typeof raw.guid === 'string' ? raw.guid : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    albumId: album && typeof album.guid === 'string' ? album.guid : '',
    albumTitle: album && typeof album.name === 'string' ? album.name : '',
    // ⚠ **毫秒 ⇒ 秒**（漏了这条 ⇒ 均长会大 1000 倍 ⇒ 判定全错）。
    durationSec: Math.round(Number(raw.duration ?? 0) / 1000),
    trackNo: null,
    path: typeof raw.audioSpec?.path === 'string' ? raw.audioSpec.path : null,
    createdAt: null,
    coverId: normalizeCoverId(raw.coverId),
    albumCoverId: normalizeCoverId(album?.coverId),
  }
}

// ---------------------------------------------------------------------------
// 定位「那个文件夹」
// ---------------------------------------------------------------------------

/** 取路径最后一段（目录名）。 */
function lastSegment(path: string): string {
  const segs = path.split('/').filter(Boolean)
  return segs.length > 0 ? (segs[segs.length - 1] as string) : path
}

/**
 * 在服务端目录树里找「那个文件夹」（**按目录名**）。
 *
 * ⚠ **浅层优先**：一层里有命中就**只用这一层**的命中 ⇒ 不会把
 *    「`/有声小说`」和「`/有声小说/某作者/有声合集`」**同时**收下
 *    ⇒ 同一首曲目会被数两遍 ⇒ **集数翻倍**。
 *
 * @param keyword 目录关键字（如「有声小说」；**子串**匹配，与旧口径一致）
 * @returns 命中的目录（**可能多个**）；没找到 ⇒ `null`
 */
export async function locateFolder(
  keyword: string,
  options?: { maxDepth?: number; maxDirs?: number },
): Promise<LocatedFolder[] | null> {
  const key = String(keyword ?? '').trim().toLowerCase()
  if (!key) return null
  const maxDepth = Math.max(0, Math.floor(options?.maxDepth ?? DEFAULT_LOCATE_MAX_DEPTH))
  const maxDirs = Math.max(1, Math.floor(options?.maxDirs ?? DEFAULT_LOCATE_MAX_DIRS))

  const roots = await listAuthedDirs()
  // ⚠ **授权目录一个都没有** ⇒ 目录浏览没法用 ⇒ 抛错（让调用方**回落**）
  //    （正常服务端至少有 1 个；老服务端返回 `null` ⇒ `apiCall` 早就抛了）。
  if (roots.length === 0) throw new Error('服务端没有授权目录')

  let frontier: LocatedFolder[] = roots.map((r) => ({ path: r.path, name: lastSegment(r.path) }))
  let visited = 0

  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
    // ⚠️ **先看这一层有没有命中**（**一个请求都不用发**）⇒ 命中就**立刻**返回
    //    ⇒ 同级的其它目录**一次都不请求**
    //    （实测：「有声小说」在一级 ⇒ 同级的「其它」不该被碰）。
    const matched = frontier.filter((node) => node.name.toLowerCase().includes(key))
    if (matched.length > 0) return matched

    // 这一层没命中 ⇒ 把这一层**都列一遍**，收集下一层。
    const next: LocatedFolder[] = []
    for (const node of frontier) {
      if (visited >= maxDirs) break
      visited += 1
      let listing: RawFolderNode
      try {
        listing = await listFolder(node.path)
      } catch {
        // ⚠ 单个目录列不出来（可能没权限 / 已删）⇒ **跳过**，别让整次定位失败。
        continue
      }
      for (const child of listing.folders ?? []) {
        if (typeof child?.path !== 'string' || child.path.length === 0) continue
        if (child.isAdminDeleted) continue
        next.push({ path: child.path, name: String(child.name ?? lastSegment(child.path)) })
      }
    }
    frontier = next
  }
  return null
}

// ---------------------------------------------------------------------------
// 收集曲目
// ---------------------------------------------------------------------------

/**
 * 递归收集目录下的**全部**曲目（**递归到文件层**）。
 *
 * ⚠ 中间层的 `tracks` 是空的 ⇒ 必须一路递归到「直接含文件」的目录。
 */
export async function collectFolderTracks(
  folders: readonly LocatedFolder[],
  options?: {
    maxDirs?: number
    maxTracks?: number
    concurrency?: number
    onProgress?: (p: FolderScanProgress) => void
  },
): Promise<{ tracks: ScanTrack[]; dirs: number }> {
  const maxDirs = Math.max(1, Math.floor(options?.maxDirs ?? DEFAULT_COLLECT_MAX_DIRS))
  const maxTracks = Math.max(1, Math.floor(options?.maxTracks ?? DEFAULT_COLLECT_MAX_TRACKS))
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? DEFAULT_COLLECT_CONCURRENCY))

  const tracks: ScanTrack[] = []
  const visited = new Set<string>()
  let frontier = folders.map((f) => f.path)
  let dirs = 0

  while (frontier.length > 0 && dirs < maxDirs && tracks.length < maxTracks) {
    const batch = frontier.slice(0, concurrency)
    frontier = frontier.slice(concurrency)
    const listings = await Promise.all(
      batch.map(async (path) => {
        try {
          return { path, node: await listFolder(path) }
        } catch {
          // ⚠ 单个目录列不出来 ⇒ **跳过**（别让整次收集失败）。
          return { path, node: null as RawFolderNode | null }
        }
      }),
    )
    for (const { path, node } of listings) {
      if (visited.has(path)) continue
      visited.add(path)
      dirs += 1
      if (node) {
        for (const raw of node.tracks ?? []) {
          // ⚠ **管理员删掉的**不算（服务端标了 `isAdminDeleted`）。
          if (!raw || raw.isAdminDeleted) continue
          tracks.push(toScanTrack(raw))
          if (tracks.length >= maxTracks) break
        }
        for (const child of node.folders ?? []) {
          if (typeof child?.path !== 'string' || child.path.length === 0) continue
          if (child.isAdminDeleted) continue
          frontier.push(child.path)
        }
      }
      options?.onProgress?.({
        dirs,
        tracks: tracks.length,
        total: 0,
        folders: folders.map((f) => ({ path: f.path, name: f.name })),
      })
      if (dirs >= maxDirs || tracks.length >= maxTracks) break
    }
  }
  return { tracks, dirs }
}

// ---------------------------------------------------------------------------
// 顶层：按目录浏览扫一次
// ---------------------------------------------------------------------------

/** 按目录浏览的结果。 */
export interface FolderScanResult {
  /** 定位到的目录（**空数组** = 服务端支持，但**没找到**那个目录）。 */
  folders: LocatedFolder[]
  /** 该目录下的全部曲目（已映射成扫描用的形状）。 */
  tracks: ScanTrack[]
  /** 访问过的目录数。 */
  dirs: number
  /** 总曲目数（服务端 `itemCount` 之和；`0` = 服务端没给）。 */
  total: number
}

/**
 * 按服务端目录浏览扫一次（「那个文件夹」里的全部曲目）。
 *
 * ⚠ **抛错 ⇒ 调用方应回落**到旧的「全库扫描」
 *    （老服务端没有这些端点 ⇒ `apiCall` 抛「响应不是预期信封」）。
 * ⚠ **不抛错但 `folders` 为空** ⇒ 服务端支持目录浏览，只是**没找到**那个目录
 *    ⇒ **不该回落**（回落＝白扫一遍全库，还是找不到）。
 */
export async function scanFolderTracks(options?: {
  keyword: string
  maxDepth?: number
  maxDirs?: number
  maxTracks?: number
  concurrency?: number
  onProgress?: (p: FolderScanProgress) => void
}): Promise<FolderScanResult> {
  const located = await locateFolder(options?.keyword ?? '', {
    maxDepth: options?.maxDepth,
    maxDirs: options?.maxDirs,
  })
  if (!located || located.length === 0) {
    return { folders: [], tracks: [], dirs: 0, total: 0 }
  }

  // ⚠ 总曲目数用服务端的 `itemCount`（递归口径，实测可对账）。
  let total = 0
  for (const folder of located) {
    try {
      const node = await listFolder(folder.path)
      total += Number(node.itemCount ?? 0)
    } catch {
      /* 拿不到就算了 ⇒ 用实际取到的数量 */
    }
  }

  const collected = await collectFolderTracks(located, {
    maxDirs: options?.maxDirs,
    maxTracks: options?.maxTracks,
    concurrency: options?.concurrency,
    onProgress: (p) => options?.onProgress?.({ ...p, total }),
  })
  return { folders: located, tracks: collected.tracks, dirs: collected.dirs, total }
}
