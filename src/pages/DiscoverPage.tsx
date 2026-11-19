// ---------------------------------------------------------------------------
// 「发现」页（T96）
// ---------------------------------------------------------------------------
//
// 两块内容：
// - **榜单**：外部公开榜源（QQ 音乐）⇒ 条目**匹配回你的 NAS 曲库**；
//   命中的**能播**，未命中的**灰显 + 标「不在曲库」**；
// - **为你推荐**：基于**你自己的**收藏 / 播放记录**自算**（每条都在库、都能播）。
//
// ⚠️ **曲库因人而异**：「在不在曲库」「榜上 N 首，你的曲库里有 M 首」
//    都是**按当前登录用户的 NAS 实时算**出来的 —— 换个人、换个 NAS，数字就不同。
//
// ⚠️ **两类失败分开说**：
// - 榜源挂了 ⇒ 榜单区报错 + 重试；
// - **曲库查不动** ⇒ 说「暂时无法匹配曲库」，**不说「都不在曲库」**。
//
// ⚠️ **播放走既有路径**：命中项直接用命中的本地歌曲走 `playerStore`
//    （⇒ NAS `track/stream`），**不新增任何播放路径**。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

import type { MatchedChartBoard } from '../../shared/chartTypes'
import type { Song } from '../../shared/types'
import { useDiscoverStore } from '../state/discoverStore'
import { useSessionStore } from '../state/sessionStore'
import './discover-page.css'

/** 页内的两个 Tab。 */
type DiscoverTab = 'chart' | 'recommend'

/** `DiscoverPage` 的属性。 */
export interface DiscoverPageProps {
  /**
   * 播放回调（与既有页面同一个口径：`(歌, 下标, 整队)`）。
   *
   * ⚠️ 整队 = **当前这一块里能播的歌** ⇒ 连播时不会跳过「不在曲库」的行。
   */
  onPlay: (song: Song, index: number, list: Song[]) => void
}

/** 时长格式化（秒 → `m:ss`）。 */
function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 命中率的文案（**你的**曲库命中数）。 */
function hitRateText(board: MatchedChartBoard): string {
  // ⚠️ T124：**还在匹配** ⇒ 命中数**还没有结论** ⇒ 不报「0 首」（那是在说假话）。
  const pending = board.entries.some((entry) => entry.pending)
  if (pending) return `榜上 ${board.total} 首，正在匹配你的曲库…`
  return `榜上 ${board.total} 首，你的曲库里有 ${board.matched} 首`
}

/** 「发现」页。 */
export function DiscoverPage({ onPlay }: DiscoverPageProps): ReactElement {
  const boards = useDiscoverStore((s) => s.boards)
  const chartsLoading = useDiscoverStore((s) => s.chartsLoading)
  const matching = useDiscoverStore((s) => s.matching)
  const chartsError = useDiscoverStore((s) => s.chartsError)
  const chartsNotice = useDiscoverStore((s) => s.chartsNotice)
  const matchError = useDiscoverStore((s) => s.matchError)
  const matchedCount = useDiscoverStore((s) => s.matchedCount)
  const totalCount = useDiscoverStore((s) => s.totalCount)
  const blocks = useDiscoverStore((s) => s.blocks)
  const recommendLoading = useDiscoverStore((s) => s.recommendLoading)
  const recommendError = useDiscoverStore((s) => s.recommendError)
  const recommendPartial = useDiscoverStore((s) => s.recommendPartial)
  const loadCharts = useDiscoverStore((s) => s.loadCharts)
  const loadRecommendations = useDiscoverStore((s) => s.loadRecommendations)

  /** 是否已连上 NAS（**没有 NAS 就匹配不了曲库**）。 */
  const connected = useSessionStore((s) => s.session.connected)

  const [tab, setTab] = useState<DiscoverTab>('chart')
  const [activeBoardId, setActiveBoardId] = useState<string>('')
  /** 推荐**只算一次**（切来切去不重复打 NAS）。 */
  const [recommendRequested, setRecommendRequested] = useState(false)

  useEffect(() => {
    void loadCharts()
  }, [loadCharts])

  const handleTab = useCallback(
    (next: DiscoverTab): void => {
      setTab(next)
      if (next === 'recommend' && !recommendRequested) {
        setRecommendRequested(true)
        void loadRecommendations()
      }
    },
    [loadRecommendations, recommendRequested],
  )

  /** 当前显示的榜单（没选就第一个）。 */
  const activeBoard = useMemo(() => {
    if (boards.length === 0) return null
    return boards.find((board) => board.id === activeBoardId) ?? boards[0] ?? null
  }, [activeBoardId, boards])

  /** 当前榜单里**能播**的歌（整队口径）。 */
  const playableSongs = useMemo(
    () =>
      (activeBoard?.entries ?? [])
        .map((entry) => entry.song)
        .filter((song): song is Song => song !== null),
    [activeBoard],
  )

  const handleChartPlay = useCallback(
    (song: Song): void => {
      const index = playableSongs.findIndex((item) => item.id === song.id)
      onPlay(song, index >= 0 ? index : 0, playableSongs)
    },
    [onPlay, playableSongs],
  )

  const status = matching
    ? `共 ${totalCount} 条，正在匹配你的曲库…`
    : totalCount > 0
      ? `共 ${totalCount} 条，你的曲库里有 ${matchedCount} 条`
      : undefined

  return (
    <section className="sanlos-page sanlos-discover">
      <header className="sanlos-page__header">
        <h1 className="sanlos-page__title">发现</h1>
        {status && <p className="sanlos-page__status">{status}</p>}
      </header>

      <div className="sanlos-discover__tabs" role="tablist" aria-label="发现页分类">
        <button
          type="button"
          role="tab"
          id="sanlos-discover-tab-chart"
          aria-selected={tab === 'chart'}
          aria-controls="sanlos-discover-panel-chart"
          className="sanlos-discover__tab"
          onClick={() => handleTab('chart')}
        >
          榜单
        </button>
        <button
          type="button"
          role="tab"
          id="sanlos-discover-tab-recommend"
          aria-selected={tab === 'recommend'}
          aria-controls="sanlos-discover-panel-recommend"
          className="sanlos-discover__tab"
          onClick={() => handleTab('recommend')}
        >
          为你推荐
        </button>
      </div>

      {/*
       * ⚠️ **未连接 NAS**：榜单本身**能看**（它是公开榜源），
       *    但「在不在你的曲库里」**匹配不了** ⇒ 如实说明，不假装。
       */}
      {!connected && (
        <p className="sanlos-discover__hint" role="status">
          还没连接 NAS：榜单能看，但暂时没法匹配你的曲库，也没有推荐。
        </p>
      )}

      {tab === 'chart' ? (
        <div
          className="sanlos-discover__panel"
          id="sanlos-discover-panel-chart"
          role="tabpanel"
          aria-labelledby="sanlos-discover-tab-chart"
        >
          {chartsError && (
            <p className="sanlos-discover__error" role="alert">
              {`榜单加载失败：${chartsError}`}
            </p>
          )}
          {chartsNotice && <p className="sanlos-discover__notice">{chartsNotice}</p>}
          {matchError && (
            <p className="sanlos-discover__error" role="alert">
              {`${matchError}`}
            </p>
          )}
          {chartsError && (
            <button type="button" className="sanlos-discover__retry" onClick={() => void loadCharts()}>
              重试
            </button>
          )}

          {chartsLoading && (
            <p className="sanlos-page__loading" role="status">
              正在加载榜单…
            </p>
          )}

          {!chartsLoading && !chartsError && !matchError && boards.length === 0 && (
            <p className="sanlos-discover__empty">暂时没有可显示的榜单。</p>
          )}

          {boards.length > 0 && (
            <div className="sanlos-discover__boards">
              <nav className="sanlos-discover__boardlist" aria-label="榜单列表">
                {boards.map((board) => (
                  <button
                    key={board.id}
                    type="button"
                    className="sanlos-discover__board"
                    aria-current={board.id === activeBoard?.id}
                    onClick={() => setActiveBoardId(board.id)}
                  >
                    <span className="sanlos-discover__boardname">{board.name}</span>
                    <span className="sanlos-discover__boardcount">
                      {`${board.matched}/${board.total}`}
                    </span>
                  </button>
                ))}
              </nav>

              <div className="sanlos-discover__entries">
                {activeBoard && (
                  <p className="sanlos-discover__hitrate">{hitRateText(activeBoard)}</p>
                )}
                {(activeBoard?.entries ?? []).map((entry) => (
                  <div
                    key={`${entry.rank}-${entry.title}`}
                    className="sanlos-discover__entry"
                    data-in-library={entry.inLibrary ? 'true' : 'false'}
                  >
                    <span className="sanlos-discover__rank">{entry.rank}</span>
                    <span className="sanlos-discover__entrytitle">{entry.title}</span>
                    <span className="sanlos-discover__artist">{entry.artist}</span>
                    <span className="sanlos-discover__duration">{formatDuration(entry.duration)}</span>
                    {entry.song ? (
                      <button
                        type="button"
                        className="sanlos-discover__play"
                        aria-label={`播放 ${entry.title}`}
                        onClick={() => handleChartPlay(entry.song as Song)}
                      >
                        播放
                      </button>
                    ) : entry.pending ? (
                      // ⚠️ T124：**还没查完** ≠ 「不在曲库」⇒ 显示「匹配中…」。
                      <span className="sanlos-discover__badge">匹配中…</span>
                    ) : (
                      <span className="sanlos-discover__badge">不在曲库</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          className="sanlos-discover__panel"
          id="sanlos-discover-panel-recommend"
          role="tabpanel"
          aria-labelledby="sanlos-discover-tab-recommend"
        >
          {recommendError && (
            <p className="sanlos-discover__error" role="alert">
              {`推荐加载失败：${recommendError}`}
            </p>
          )}
          {recommendError && (
            <button
              type="button"
              className="sanlos-discover__retry"
              onClick={() => void loadRecommendations()}
            >
              重试
            </button>
          )}
          {recommendPartial && (
            <p className="sanlos-discover__notice">部分曲目没查到，结果可能不完整。</p>
          )}
          {recommendLoading && (
            <p className="sanlos-page__loading" role="status">
              正在为你挑选…
            </p>
          )}
          {!recommendLoading && !recommendError && blocks.length === 0 && (
            <p className="sanlos-discover__empty">
              还没有可推荐的曲目（收藏几首、听几首就会出现）。
            </p>
          )}
          {blocks.map((block) => (
            <section key={block.id} className="sanlos-discover__block">
              <h2 className="sanlos-discover__blocktitle">{block.title}</h2>
              {block.items.map((item) => (
                <div key={item.song.id} className="sanlos-discover__entry">
                  <span className="sanlos-discover__entrytitle">{item.song.title}</span>
                  <span className="sanlos-discover__artist">{item.song.artist}</span>
                  <span className="sanlos-discover__reason">{item.reason}</span>
                  <button
                    type="button"
                    className="sanlos-discover__play"
                    aria-label={`播放 ${item.song.title}`}
                    onClick={() =>
                      onPlay(
                        item.song,
                        block.items.findIndex((row) => row.song.id === item.song.id),
                        block.items.map((row) => row.song),
                      )
                    }
                  >
                    播放
                  </button>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
