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
  return `榜上 ${board.total} 首，你的曲库里有 ${board.matched} 首`
}

/** 「发现」页。 */
export function DiscoverPage({ onPlay }: DiscoverPageProps): ReactElement {
  const boards = useDiscoverStore((s) => s.boards)
  const chartsLoading = useDiscoverStore((s) => s.chartsLoading)
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

  const status = totalCount > 0 ? `共 ${totalCount} 条，你的曲库里有 ${matchedCount} 条` : undefined

  return (
    <section className="fnm-page fnm-discover">
      <header className="fnm-page__header">
        <h1 className="fnm-page__title">发现</h1>
        {status && <p className="fnm-page__status">{status}</p>}
      </header>

      <div className="fnm-discover__tabs" role="tablist" aria-label="发现页分类">
        <button
          type="button"
          role="tab"
          id="fnm-discover-tab-chart"
          aria-selected={tab === 'chart'}
          aria-controls="fnm-discover-panel-chart"
          className="fnm-discover__tab"
          onClick={() => handleTab('chart')}
        >
          榜单
        </button>
        <button
          type="button"
          role="tab"
          id="fnm-discover-tab-recommend"
          aria-selected={tab === 'recommend'}
          aria-controls="fnm-discover-panel-recommend"
          className="fnm-discover__tab"
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
        <p className="fnm-discover__hint" role="status">
          还没连接 NAS：榜单能看，但暂时没法匹配你的曲库，也没有推荐。
        </p>
      )}

      {tab === 'chart' ? (
        <div
          className="fnm-discover__panel"
          id="fnm-discover-panel-chart"
          role="tabpanel"
          aria-labelledby="fnm-discover-tab-chart"
        >
          {chartsError && (
            <p className="fnm-discover__error" role="alert">
              {`榜单加载失败：${chartsError}`}
            </p>
          )}
          {chartsNotice && <p className="fnm-discover__notice">{chartsNotice}</p>}
          {matchError && (
            <p className="fnm-discover__error" role="alert">
              {`${matchError}`}
            </p>
          )}
          {chartsError && (
            <button type="button" className="fnm-discover__retry" onClick={() => void loadCharts()}>
              重试
            </button>
          )}

          {chartsLoading && (
            <p className="fnm-page__loading" role="status">
              正在加载榜单…
            </p>
          )}

          {!chartsLoading && !chartsError && !matchError && boards.length === 0 && (
            <p className="fnm-discover__empty">暂时没有可显示的榜单。</p>
          )}

          {boards.length > 0 && (
            <div className="fnm-discover__boards">
              <nav className="fnm-discover__boardlist" aria-label="榜单列表">
                {boards.map((board) => (
                  <button
                    key={board.id}
                    type="button"
                    className="fnm-discover__board"
                    aria-current={board.id === activeBoard?.id}
                    onClick={() => setActiveBoardId(board.id)}
                  >
                    <span className="fnm-discover__boardname">{board.name}</span>
                    <span className="fnm-discover__boardcount">
                      {`${board.matched}/${board.total}`}
                    </span>
                  </button>
                ))}
              </nav>

              <div className="fnm-discover__entries">
                {activeBoard && (
                  <p className="fnm-discover__hitrate">{hitRateText(activeBoard)}</p>
                )}
                {(activeBoard?.entries ?? []).map((entry) => (
                  <div
                    key={`${entry.rank}-${entry.title}`}
                    className="fnm-discover__entry"
                    data-in-library={entry.inLibrary ? 'true' : 'false'}
                  >
                    <span className="fnm-discover__rank">{entry.rank}</span>
                    <span className="fnm-discover__entrytitle">{entry.title}</span>
                    <span className="fnm-discover__artist">{entry.artist}</span>
                    <span className="fnm-discover__duration">{formatDuration(entry.duration)}</span>
                    {entry.song ? (
                      <button
                        type="button"
                        className="fnm-discover__play"
                        aria-label={`播放 ${entry.title}`}
                        onClick={() => handleChartPlay(entry.song as Song)}
                      >
                        播放
                      </button>
                    ) : (
                      <span className="fnm-discover__badge">不在曲库</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          className="fnm-discover__panel"
          id="fnm-discover-panel-recommend"
          role="tabpanel"
          aria-labelledby="fnm-discover-tab-recommend"
        >
          {recommendError && (
            <p className="fnm-discover__error" role="alert">
              {`推荐加载失败：${recommendError}`}
            </p>
          )}
          {recommendError && (
            <button
              type="button"
              className="fnm-discover__retry"
              onClick={() => void loadRecommendations()}
            >
              重试
            </button>
          )}
          {recommendPartial && (
            <p className="fnm-discover__notice">部分曲目没查到，结果可能不完整。</p>
          )}
          {recommendLoading && (
            <p className="fnm-page__loading" role="status">
              正在为你挑选…
            </p>
          )}
          {!recommendLoading && !recommendError && blocks.length === 0 && (
            <p className="fnm-discover__empty">
              还没有可推荐的曲目（收藏几首、听几首就会出现）。
            </p>
          )}
          {blocks.map((block) => (
            <section key={block.id} className="fnm-discover__block">
              <h2 className="fnm-discover__blocktitle">{block.title}</h2>
              {block.items.map((item) => (
                <div key={item.song.id} className="fnm-discover__entry">
                  <span className="fnm-discover__entrytitle">{item.song.title}</span>
                  <span className="fnm-discover__artist">{item.song.artist}</span>
                  <span className="fnm-discover__reason">{item.reason}</span>
                  <button
                    type="button"
                    className="fnm-discover__play"
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
