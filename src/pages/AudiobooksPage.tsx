// ---------------------------------------------------------------------------
// 「有声读物」页（T98 · v3 改版）
//
// ---------------------------------------------------------------------------
// 这一页做什么（v3：**用户指位置**）
// ---------------------------------------------------------------------------
// - 入口一：**按作品名秒搜**（`/search/album`，实测 ~100 ms，**完全不扫曲库**）
//   ⇒ 搜到的专辑点开 ⇒ 按集序排 ⇒ 同时记成「有声」（随时可反悔）；
// - 入口二：**按目录找**（「那个文件夹」）—— 服务端**没有**目录浏览能力
//   （实测 20 个候选端点全 null）⇒ 只能扫一遍曲库，再按 `path` 的**目录段**挑；
// - 入口三：**手动改判**（「这不是有声」/「这是有声读物」）⇒ 本地记住，优先于一切。
//
// ⚠️ **三个判定别混成一个分数**（v3 的要害）：
// - 「是不是有声」= **用户指的位置**（搜索 / 目录 / 改判）；
// - 「能不能按集序排」= **形态一致性 ≥ 60%**（见 `src/api/audiobook.ts`）；
// - 「像不像有声」= 结构信号打分 ⇒ **只做参考信息**（照旧显示判定分与依据）。
//
// ⚠️ 页面**不假设**曲库里有什么：目录名是**用户输入的默认值**（可改），
//    **不**拿它去推断「是不是有声」⇒ 不把因人而异的目录名写死成判据。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Album } from '../../shared/types'
import {
  AUDIOBOOK_SCORE_THRESHOLD,
  DEFAULT_FOLDER_KEYWORD,
  REASON_LABELS,
} from '../api/audiobook'
import { searchApi } from '../api/search'
import { useAudiobookStore, type AudiobookHit } from '../state/audiobookStore'
import { LibraryPageShell } from '../components/LibraryPageShell'
import './audiobooks-page.css'

/** `AudiobooksPage` 的属性。 */
export interface AudiobooksPageProps {
  /** 点专辑卡片时回调（**沿用既有下钻路径**，不新增路由）。 */
  onOpenAlbum: (album: Album) => void
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

  // ⚠️ 进页面时**只读回落盘的结果**（`restore`），**不自动扫描**：
  //    扫描很贵（实测 17.3 万首 ⇒ 87 页 ⇒ 并发约 1 分钟）
  //    ⇒ 不能因为「看了一眼页面」就自动扫全库 ⇒ 由用户点按钮。
  useEffect(() => {
    restore()
  }, [restore])

  // ---- 入口一：作品名秒搜 -------------------------------------------------
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Album[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await searchApi.albums(q)
      setSearchResults(res.list)
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err))
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [query])

  /** 点开搜到的作品 ⇒ **用户指认**了它 ⇒ 记成「有声」+ 下钻。 */
  const handleOpenSearchResult = useCallback(
    (album: Album) => {
      setOverride(album.id, 'audiobook', undefined, album.title)
      onOpenAlbum(album)
    },
    [onOpenAlbum, setOverride],
  )

  // ---- 入口二：目录关键字（「那个文件夹」）---------------------------------
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

  return (
    <LibraryPageShell
      title="有声读物"
      status={status}
      error={error}
      loading={false}
      loadingText=""
    >
      <div className="fnm-audiobooks">
        {/* ---- 入口一：按作品名找（**不扫曲库**）---------------------------- */}
        <section className="fnm-audiobooks__panel">
          <h2 className="fnm-audiobooks__panel-title">按作品名找</h2>
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
            这条路不用扫曲库，搜到就出（实测约 0.1 秒）。点开一部作品就会按集序排，
            并记成「有声」（随时可以在详情页反悔）。
            搜索只能当线索，同名作品可能搜不全；找不全就用下面按目录找。
          </p>
          {searchError ? (
            <p className="fnm-audiobooks__error">搜索失败：{searchError}</p>
          ) : null}
          {searchResults.length > 0 ? (
            <ul className="fnm-audiobooks__results">
              {searchResults.map((album) => (
                <li key={album.id} className="fnm-audiobooks__result">
                  <button
                    type="button"
                    className="fnm-audiobooks__title"
                    onClick={() => handleOpenSearchResult(album)}
                  >
                    {album.title || '（未命名的专辑）'}
                  </button>
                  {album.trackCount > 0 ? (
                    <span className="fnm-audiobooks__result-meta">{album.trackCount} 集</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ---- 入口二：按目录找（「那个文件夹」）----------------------------- */}
        <section className="fnm-audiobooks__panel">
          <h2 className="fnm-audiobooks__panel-title">按目录找</h2>
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

        {/* ---- 列表 -------------------------------------------------------- */}
        {items.length === 0 ? (
          <p className="fnm-audiobooks__empty">
            {scannedAt
              ? '当前曲库里没有识别到有声读物：这个目录下面没有找到作品（换个目录名再扫一次，或用上面的「搜作品」直接找）。'
              : '点「扫描这个目录」开始，或者在上面直接搜作品名。'}
          </p>
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
                    {manual ? '你手动标记为有声' : `判定分 ${hit.score}`}
                    {hit.trackCount > 0 ? ` · ${hit.trackCount} 集` : ''}
                    {hit.avgDurationSec > 0 ? ` · 单集均长 ${formatMinutes(hit.avgDurationSec)}` : ''}
                    {!manual && hit.score > 0 && hit.score < AUDIOBOOK_SCORE_THRESHOLD
                      ? ' · 结构信号弱（可能不是有声）'
                      : ''}
                  </p>
                  <p className="fnm-audiobooks__reasons">
                    {hit.reasons
                      .map((reason) => REASON_LABELS[reason] ?? reason)
                      .join(' · ')}
                  </p>
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
      </div>
    </LibraryPageShell>
  )
}
