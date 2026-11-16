// ---------------------------------------------------------------------------
// 「有声读物」页（T100 · v4 改版）
//
// 这一页做什么（v4：**那个文件夹里的都是有声小说**）
// ---------------------------------------------------------------------------
// - **主入口**：进页面**第一屏就是列表** —— 「那个文件夹」里的作品，**一本小说一条**
//   （服务端把一部作品拆成几张同名专辑时**归并成一条**）；
//   没扫过就**自动开扫**（用户**不用点**任何按钮；扫完落盘 ⇒ 之后**秒开**）；
// - **加速器**：「搜作品」按作品名**秒搜**（实测约 0.1 秒）⇒ 搜到的结果**也按
//   「一本小说」归并**（同名 + 同作品目录 ⇒ 一条）⇒ 点开就是**全书**；
// - **兜底**：「按目录找」改目录名 / 从头重扫。
//
// ⚠️ **三个判定别混成一个分数**（v3 的要害，v4 继续）：
// - 「是不是有声」= **用户指的位置**（目录 / 秒搜 / 手动改判）
//   ⇒ **那个文件夹里的全都是有声小说**（v4 口径）⇒ **列表里不再显示「判定分」**
//     （那与「位置即判定」自相矛盾 ⇒ 已去掉）；
// - 「能不能按集序排」= **形态一致性 ≥ 60%**（见 `src/api/audiobook.ts`）；
// - 「像不像有声」= 结构信号打分 ⇒ 只做**参考信息**（仍保留在「为什么」里）。
//
// ⚠️ 页面**不假设**曲库里有什么：目录名是**用户输入的默认值**（可改），
//    **不**拿它去推断「是不是有声」⇒ 不把因人而异的目录名写死成判据。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Album } from '../../shared/types'
import {
  DEFAULT_FOLDER_KEYWORD,
  REASON_LABELS,
  workGroupKey,
} from '../api/audiobook'
import { libraryApi } from '../api/library'
import { searchApi } from '../api/search'
import { useAudiobookStore, type AudiobookHit } from '../state/audiobookStore'
import { LibraryPageShell } from '../components/LibraryPageShell'
import './audiobooks-page.css'

/** `AudiobooksPage` 的属性。 */
export interface AudiobooksPageProps {
  /** 点专辑卡片时回调（**沿用既有下钻路径**，不新增路由）。 */
  onOpenAlbum: (album: Album) => void
}

/**
 * 秒搜结果**归并后的一条**（T100：= **一本小说**）。
 *
 * ⚠️ 服务端可能把一部作品拆成**几张同名专辑**（实测《让青春继续第一季》被拆成
 *    31 集 + 1 集）⇒ 不归并的话用户看到**两条同名**，点进去还**少一集**。
 */
interface SearchGroup {
  /** 主专辑 id（集数最多的那个）—— 下钻用它。 */
  albumId: string
  /** 组内全部专辑 id（主专辑第一）。 */
  albumIds: string[]
  /** 专辑名（= 作品名）。 */
  title: string
  /** 集数（**组合计**）。 */
  trackCount: number
}

/** 把秒数写成「32 分」这种人类看得懂的形态。 */
function formatMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}

/** 把命中的专辑拼成既有下钻需要的 `Album` 形状。 */
function toAlbum(hit: AudiobookHit): Album {
  return {
    id: hit.albumId,
    title: hit.albumTitle,
    artist: '',
    artistId: '',
    coverId: null,
    year: null,
    trackCount: hit.trackCount,
  }
}

/** 秒搜归并组 ⇒ 下钻用的 `Album` 形状。 */
function groupToAlbum(group: SearchGroup): Album {
  return {
    id: group.albumId,
    title: group.title,
    artist: '',
    artistId: '',
    coverId: null,
    year: null,
    trackCount: group.trackCount,
  }
}

/**
 * 把秒搜到的专辑**归并成「一本小说一条」**（T100）。
 *
 * ⚠️ **归并键 = 专辑名 + 唯一作品目录**（与扫描路径**共用** `workGroupKey`）
 *    ⇒ 两条路径的口径**完全一致**。
 * ⚠️ **作品目录怎么拿**：专辑对象**没有 path**（实测 `/album/list` 与 `/album/detail`
 *    都不返）⇒ 每个候选**补拉 1 首**曲目（`size=1`）⇒ 目录在曲目的 path 里
 *    ⇒ **每个候选 1 个请求**（不拉全量曲目）。
 * ⚠️ **拿不到目录 ⇒ 不归并**（`workGroupKey` 会退化成「按专辑单独成组」）⇒
 *    宁可分开，也不要误合。
 */
async function mergeSearchResults(list: readonly Album[]): Promise<SearchGroup[]> {
  const withDir = await Promise.all(
    list.map(async (album) => {
      let dir: string | null = null
      try {
        dir = await libraryApi.albumWorkDir(album.id)
      } catch {
        // ⚠️ 拿不到目录 ⇒ 不归并（信息不足 ⇒ 宁可分开）。
        dir = null
      }
      return { album, dir }
    }),
  )

  const buckets = new Map<string, { album: Album; dir: string | null }[]>()
  for (const item of withDir) {
    const key = workGroupKey(item.album.title, item.dir, item.album.id)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }

  const groups: SearchGroup[] = []
  for (const bucket of buckets.values()) {
    // 主专辑 = 集数最多的那个（并列时按 id 定序 ⇒ 结果稳定）。
    const members = [...bucket].sort(
      (a, b) =>
        b.album.trackCount - a.album.trackCount || a.album.id.localeCompare(b.album.id),
    )
    const main = members[0]
    if (!main) continue
    groups.push({
      albumId: main.album.id,
      albumIds: members.map((m) => m.album.id),
      title: main.album.title || '（未命名的专辑）',
      trackCount: members.reduce((sum, m) => sum + (m.album.trackCount || 0), 0),
    })
  }
  return groups
}

/** 「有声读物」页。 */
export function AudiobooksPage(props: AudiobooksPageProps): ReactElement {
  const { onOpenAlbum } = props

  const hits = useStore(useAudiobookStore, (s) => s.hits)
  const overrides = useStore(useAudiobookStore, (s) => s.overrides)
  const keyword = useStore(useAudiobookStore, (s) => s.keyword)
  const scanning = useStore(useAudiobookStore, (s) => s.scanning)
  const progress = useStore(useAudiobookStore, (s) => s.progress)
  const error = useStore(useAudiobookStore, (s) => s.error)
  const scannedAt = useStore(useAudiobookStore, (s) => s.scannedAt)
  const scan = useStore(useAudiobookStore, (s) => s.scan)
  const restore = useStore(useAudiobookStore, (s) => s.restore)
  const setOverride = useStore(useAudiobookStore, (s) => s.setOverride)
  const registerGroup = useStore(useAudiobookStore, (s) => s.registerGroup)

  // ⚠️ T100：进页面**只做两件事** —— ① 读回落盘的结果；② **没扫过就自动开扫**
  //    （用户**不用点**任何按钮）。
  //    ⚠️ 扫描很贵（实测 87 页 / 52 秒）⇒ 所以**只自动扫一次**：扫完落盘，
  //    下次进来 `scannedAt` 有值 ⇒ 不再扫 ⇒ **秒开**。
  //    ⚠️ `restore()` 是**同步**的（读 localStorage）⇒ 判据要取 restore **之后**的状态。
  useEffect(() => {
    restore()
    const state = useAudiobookStore.getState()
    if (state.scannedAt !== null || state.scanning) return
    void scan({ keyword: state.keyword })
  }, [restore, scan])

  // ---- 加速器：按作品名秒搜 ------------------------------------------------
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchGroup[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await searchApi.albums(q)
      // ⚠️ T100：**一本小说 = 一条** ⇒ 搜到的专辑要按「同名 + 同作品目录」归并。
      setSearchResults(await mergeSearchResults(res.list))
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err))
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [query])

  /** 点开搜到的作品 ⇒ **用户指认**了它 ⇒ 记成「有声」+ 下钻（**整组**）。 */
  const handleOpenSearchResult = useCallback(
    (group: SearchGroup) => {
      // ⚠️ T100：登记**整组** ⇒ 详情页按组拉全量 ⇒ 《让青春继续第一季》的
      //    **第 02 集不再丢**（搜索结果不在扫描结果里 ⇒ 以前会退化成单张专辑）。
      registerGroup(group.albumIds)
      setOverride(group.albumId, 'audiobook', undefined, group.title)
      onOpenAlbum(groupToAlbum(group))
    },
    [onOpenAlbum, registerGroup, setOverride],
  )

  // ---- 兜底：按目录找（「那个文件夹」）--------------------------------------
  const [keywordInput, setKeywordInput] = useState('')
  /** 真正用来扫的目录关键字：输入框优先；空了就用上次的；再空用默认值。 */
  const effectiveKeyword = useMemo(
    () => keywordInput.trim() || keyword.trim() || DEFAULT_FOLDER_KEYWORD,
    [keyword, keywordInput],
  )

  /** 列表 = 目录命中的 + 用户手动判为有声的（去掉被用户排除的）。 */
  const items = useMemo(() => {
    const manual = Object.entries(overrides)
      .filter(([, record]) => record.value === 'audiobook')
      .map(([albumId, record]) => ({
        albumId,
        albumIds: [albumId],
        albumTitle: record.albumTitle,
        score: 0,
        reasons: ['user'],
        trackCount: 0,
        avgDurationSec: 0,
        maxDurationSec: 0,
        episodeRule: null,
      }))
    const merged = new Map<string, AudiobookHit>()
    for (const hit of hits) merged.set(hit.albumId, hit)
    for (const item of manual) if (!merged.has(item.albumId)) merged.set(item.albumId, item)
    return [...merged.values()]
      .filter((hit) => overrides[hit.albumId]?.value !== 'not-audiobook')
      .sort((a, b) => b.score - a.score || b.trackCount - a.trackCount || a.albumTitle.localeCompare(b.albumTitle))
  }, [hits, overrides])

  const handleScan = useCallback(() => {
    void scan({ keyword: effectiveKeyword })
  }, [effectiveKeyword, scan])

  /** 「从头重扫」：清掉断点与旧聚合，整库重来（曲目被删过、或换了目录名时要重扫）。 */
  const handleFullScan = useCallback(() => {
    void scan({ full: true, keyword: effectiveKeyword })
  }, [effectiveKeyword, scan])

  const handleMarkNotAudiobook = useCallback(
    (albumId: string, albumTitle: string) => {
      setOverride(albumId, 'not-audiobook', undefined, albumTitle)
    },
    [setOverride],
  )

  const status = scanning
    ? `正在扫描…第 ${progress?.page ?? 0} 页 / 共 ${progress?.pages ?? 0} 页（已扫 ${progress?.scanned ?? 0} 首）`
    : scannedAt
      ? `上次扫描：${new Date(scannedAt).toLocaleString()} · 目录「${keyword}」· ${items.length} 部`
      : '还没扫描过'

  /**
   * 列表区在「还没有作品」时给用户的话（**如实说明**正在发生什么）。
   *
   * ⚠️ 非扫描态的文案**沿用旧版**（T98 的 E2E 断言了它 ⇒ 不改）。
   */
  const emptyText = scanning
    ? `正在扫描「${keyword}」文件夹里的作品…实测约 1 分钟；扫完会记在本机，下次进来直接看。`
    : '当前曲库里没有识别到有声读物：这个目录下面没有找到作品（换个目录名再扫一次，或用上面的「搜作品」直接找）。'

  return (
    <LibraryPageShell
      title="有声读物"
      status={status}
      error={error}
      loading={false}
      loadingText=""
    >
      <div className="fnm-audiobooks">
        {/* ---- 主入口：那个文件夹里的作品（**第一屏**，一本一条）---------------- */}
        <section className="fnm-audiobooks__panel">
          <h2 className="fnm-audiobooks__panel-title">那个文件夹里的作品</h2>
          <p className="fnm-audiobooks__hint">
            「{keyword}」文件夹里的全都是有声小说，这里一本小说一条。
            点开就是全书（按集序排；服务端把一部作品拆成几张专辑时会自动合并）。
          </p>
          {items.length === 0 ? (
            <p className="fnm-audiobooks__empty">{emptyText}</p>
          ) : (
            <ul className="fnm-audiobooks__list">
              {items.map((hit) => {
                const manual = hit.reasons.includes('user')
                return (
                  <li key={hit.albumId} className="fnm-audiobooks__item">
                    <button
                      type="button"
                      className="fnm-audiobooks__title"
                      onClick={() => onOpenAlbum(toAlbum(hit))}
                    >
                      {hit.albumTitle || '（未命名的专辑）'}
                    </button>
                    <p className="fnm-audiobooks__source">
                      {manual ? '你指定的' : `在「${keyword}」目录下`}
                    </p>
                    <p className="fnm-audiobooks__meta">
                      {/* ⚠️ T100：**不再显示「判定分」** —— 位置已定（那个文件夹里的都是有声），
                          分数当主信息会与口径自相矛盾；只留对用户有用的量。 */}
                      {hit.trackCount > 0 ? `${hit.trackCount} 集` : ''}
                      {hit.avgDurationSec > 0 ? ` · 单集均长 ${formatMinutes(hit.avgDurationSec)}` : ''}
                      {/* ⚠️ T99：服务端把一部作品拆成几张同名专辑时，这里如实说明合并了几张。 */}
                      {hit.albumIds.length > 1 ? ` · 合并了 ${hit.albumIds.length} 张专辑` : ''}
                    </p>
                    {hit.reasons.length > 0 ? (
                      <p className="fnm-audiobooks__reasons">
                        {hit.reasons
                          .map((reason) => REASON_LABELS[reason] ?? reason)
                          .join(' · ')}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="fnm-audiobooks__exclude"
                      onClick={() => handleMarkNotAudiobook(hit.albumId, hit.albumTitle)}
                    >
                      不是有声
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* ---- 加速器：按作品名秒搜（**不是**前置步骤）-------------------------- */}
        <section className="fnm-audiobooks__panel">
          <h2 className="fnm-audiobooks__panel-title">直接找一部作品</h2>
          <div className="fnm-audiobooks__row">
            <input
              className="fnm-audiobooks__input"
              type="text"
              value={query}
              placeholder="输入作品名，例如：牧神记"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch()
              }}
            />
            <button
              type="button"
              className="fnm-audiobooks__scan"
              onClick={() => void handleSearch()}
              disabled={searching}
            >
              {searching ? '正在搜…' : '搜作品'}
            </button>
          </div>
          <p className="fnm-audiobooks__hint">
            这条路不用扫曲库，搜到就出（实测约 0.1 秒）。搜到的结果一本小说一条
            （同名同目录的已合并）；点开就是全书，并记成「有声」（随时可以在详情页反悔）。
            搜索只能当线索，同名作品可能搜不全；找不全就用上面那个文件夹。
          </p>
          {searchError ? (
            <p className="fnm-audiobooks__error">搜索失败：{searchError}</p>
          ) : null}
          {searchResults.length > 0 ? (
            <ul className="fnm-audiobooks__results">
              {searchResults.map((group) => (
                <li key={group.albumId} className="fnm-audiobooks__result">
                  <button
                    type="button"
                    className="fnm-audiobooks__title"
                    onClick={() => handleOpenSearchResult(group)}
                  >
                    {group.title}
                  </button>
                  <span className="fnm-audiobooks__result-meta">
                    {group.trackCount > 0 ? `${group.trackCount} 集` : ''}
                    {group.albumIds.length > 1 ? ` · 合并了 ${group.albumIds.length} 张专辑` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ---- 兜底：换目录名 / 从头重扫 --------------------------------------- */}
        <section className="fnm-audiobooks__panel">
          <h2 className="fnm-audiobooks__panel-title">换一个文件夹</h2>
          <div className="fnm-audiobooks__row">
            <label className="fnm-audiobooks__label" htmlFor="fnm-audiobooks-keyword">
              目录名
            </label>
            <input
              id="fnm-audiobooks-keyword"
              className="fnm-audiobooks__input"
              type="text"
              value={keywordInput}
              placeholder={keyword || DEFAULT_FOLDER_KEYWORD}
              onChange={(e) => setKeywordInput(e.target.value)}
            />
            <button
              type="button"
              className="fnm-audiobooks__scan"
              onClick={handleScan}
              disabled={scanning}
            >
              {scanning ? '正在扫描…' : '扫描这个目录'}
            </button>
            <button
              type="button"
              className="fnm-audiobooks__scan fnm-audiobooks__scan--secondary"
              onClick={handleFullScan}
              disabled={scanning}
            >
              从头重扫
            </button>
          </div>
          <p className="fnm-audiobooks__hint">
            服务端没有浏览目录的能力（实测 20 个候选端点都不通），
            所以要先扫一遍曲库，再按目录名挑出这个文件夹里的作品。
            实测 17.3 万首要扫 87 页，并发扫大约 1 分钟；扫一次记在本机，下次进来直接看。
            换目录名要重新扫一次。
          </p>
        </section>
      </div>
    </LibraryPageShell>
  )
}
