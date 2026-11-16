// ---------------------------------------------------------------------------
// 「有声读物」页（T98）
//
// ---------------------------------------------------------------------------
// 这一页做什么
// ---------------------------------------------------------------------------
// - 列出**被判定为「有声读物」**的专辑（判定 = 结构信号打分，规则见
//   `src/api/audiobook.ts`）；
// - 每条都**显示判定依据**（可解释，不是黑箱）+ 判定分；
// - 用户可以**一键改判**（「不是有声」）⇒ 本地记住，优先于自动判定；
// - 「扫描曲库」：首次要扫全库（实测 17.3 万首 ⇒ 87 页，中继链路 6–47 分钟），
//   **可中断、可续跑**（断点落在 `localStorage`）。
//
// ⚠️ 页面**不假设**曲库里有什么：判定只用**结构信号**（时长 / 集数 / 标题形态 /
//    目录聚集），**不引用任何专辑名或目录名**（名字误报极高、目录名因人而异）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, type ReactElement } from 'react'
import { useStore } from 'zustand'

import type { Album } from '../../shared/types'
import { REASON_LABELS } from '../api/audiobook'
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
  const scanning = useStore(useAudiobookStore, (s) => s.scanning)
  const progress = useStore(useAudiobookStore, (s) => s.progress)
  const error = useStore(useAudiobookStore, (s) => s.error)
  const scannedAt = useStore(useAudiobookStore, (s) => s.scannedAt)
  const scan = useStore(useAudiobookStore, (s) => s.scan)
  const restore = useStore(useAudiobookStore, (s) => s.restore)
  const setOverride = useStore(useAudiobookStore, (s) => s.setOverride)

  // ⚠️ 进页面时**只读回落盘的结果**（`restore`），**不自动扫描**：
  //    扫描很贵（实测 17.3 万首 ⇒ 87 页，中继链路 6–47 分钟）
  //    ⇒ 不能因为「看了一眼页面」就自动扫全库 ⇒ 由用户点按钮。
  useEffect(() => {
    restore()
  }, [restore])

  /** 列表 = 自动命中 + 用户手动判为有声的（去掉被用户排除的）。 */
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
    void scan()
  }, [scan])

  /** 「从头重扫」：清掉断点与旧聚合，整库重来（曲目被删过时要重扫）。 */
  const handleFullScan = useCallback(() => {
    void scan({ full: true })
  }, [scan])

  const handleMarkNotAudiobook = useCallback(
    (albumId: string, albumTitle: string) => {
      setOverride(albumId, 'not-audiobook', undefined, albumTitle)
    },
    [setOverride],
  )

  const status = scanning
    ? `正在扫描…第 ${progress?.page ?? 0} 页 / 共 ${progress?.pages ?? 0} 页（已扫 ${progress?.scanned ?? 0} 首）`
    : scannedAt
      ? `上次扫描：${new Date(scannedAt).toLocaleString()} · 命中 ${items.length} 部`
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
        <div className="fnm-audiobooks__toolbar">
          <button
            type="button"
            className="fnm-audiobooks__scan"
            onClick={handleScan}
            disabled={scanning}
          >
            {scanning ? '正在扫描…' : '扫描曲库'}
          </button>
          <button
            type="button"
            className="fnm-audiobooks__scan fnm-audiobooks__scan--secondary"
            onClick={handleFullScan}
            disabled={scanning}
          >
            从头重扫
          </button>
          <p className="fnm-audiobooks__hint">
            首次扫描要过一遍整个曲库（实测 17.3 万首 ⇒ 87 页；中继链路可能要几分钟到几十分钟）。
            识别只看结构（单集时长 / 集数 / 标题形态 / 目录聚集），不靠名字猜。
          </p>
        </div>

        {items.length === 0 ? (
          <p className="fnm-audiobooks__empty">
            {scannedAt
              ? '当前曲库里没有识别到有声读物。若你刚在 NAS 上加了新文件，点「扫描曲库」重新判定一次。'
              : '点「扫描曲库」开始识别。识别结果会显示判定依据，随时可以改判。'}
          </p>
        ) : (
          <ul className="fnm-audiobooks__list">
            {items.map((hit) => (
              <li key={hit.albumId} className="fnm-audiobooks__item">
                <button
                  type="button"
                  className="fnm-audiobooks__title"
                  onClick={() => onOpenAlbum(toAlbum(hit))}
                >
                  {hit.albumTitle || '（未命名的专辑）'}
                </button>
                <p className="fnm-audiobooks__meta">
                  {hit.reasons.includes('user') ? '你手动标记为有声' : `判定分 ${hit.score}`}
                  {hit.trackCount > 0 ? ` · ${hit.trackCount} 集` : ''}
                  {hit.avgDurationSec > 0 ? ` · 单集均长 ${formatMinutes(hit.avgDurationSec)}` : ''}
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
            ))}
          </ul>
        )}
      </div>
    </LibraryPageShell>
  )
}
