// ---------------------------------------------------------------------------
// 播放条（Task 15）
//
// 内容：封面、歌名歌手、上一首 / 播放暂停 / 下一首、进度条、音量、
//       队列入口、EQ 入口（占位）、音质标识（无损 / Hi-Res）。
//
// ---------------------------------------------------------------------------
// 只经 playerStore 驱动（控制器追加要求 O）
// ---------------------------------------------------------------------------
// 本组件**不直接碰** `PlayerEngine`：所有动作都走 `playerStore` 的 action。
//
// ⚠️ **「上一首」必须走 `playerStore.prev()`**（控制器追加要求 L）：
//    `Queue.prev(positionSec)` 多了一个可选的进度参数 ——「播放进度 > 3 秒 → 回到本曲开头」
//    这条规则**没有进度就判断不了**。`playerStore.prev()` 已经把 `get().position` 传了进去
//    （`src/state/playerStore.ts`），直接调 `queue.prev()` 会永远按「上一首」处理。
//
// ---------------------------------------------------------------------------
// 音质标识（控制器追加要求 E，规则定死）
// ---------------------------------------------------------------------------
// - **无损**：`codec` 属于无损集合（见 `LOSSLESS_CODECS`）；
// - **Hi-Res**：在无损基础上，`sampleRate > 44100` **或** `bitDepth > 16`；
// - 其余 → 不显示任何标识（不显示「320K」这类有争议的标签）。
//
// ⚠️ `bitrate` 是 **kbps**（领域层已从服务端的 bps 换算过），本判定**用不到它**，别当 bps 用。
//
// ---------------------------------------------------------------------------
// 样式约定（控制器裁定）
// ---------------------------------------------------------------------------
// 样式落在 `src/components/player-bar.css`（**不是**内联 style）：
// 内联 style 表达不了 `:hover` / `:active` / `:focus-visible` / 伪元素；
// 仓库约定组件样式一律用 `var(--token)` 引用语义变量。
//
// ---------------------------------------------------------------------------

import {
  useCallback,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactElement,
} from 'react'

import type { Song } from '../../shared/types'
import { usePlayerStore, type PlayerStore } from '../state/playerStore'
import { CoverImage } from './Cards'
import './player-bar.css'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 播放器 store 的最小面（可注入，便于测试）。
 *
 * `usePlayerStore`（zustand 的 `create` 产物）与它结构兼容。
 */
export interface PlayerStoreLike {
  /** 取当前状态快照。 */
  getState(): PlayerStore
  /** 订阅状态变化（返回退订函数）。 */
  subscribe(listener: (state: PlayerStore, previousState: PlayerStore) => void): () => void
}

/** `PlayerBar` 的属性。 */
export interface PlayerBarProps {
  /** 播放器 store（可注入；缺省用全局 store）。 */
  store?: PlayerStoreLike
  /** 打开全屏播放页的回调。 */
  onOpenFullPlayer?: () => void
  /** 附加类名。 */
  className?: string
}

// ---------------------------------------------------------------------------
// 音质判定
// ---------------------------------------------------------------------------

/**
 * 无损编码集合（判定「无损」）。
 *
 * FLAC / APE / WAV / ALAC / DSD 系列 / WavPack / WV / TTA / AIFF / MPC / SHN / TAK。
 * 比较时统一转成**大写**再查表（服务端给的大小写不固定）。
 */
export const LOSSLESS_CODECS: ReadonlySet<string> = new Set([
  'FLAC',
  'APE',
  'WAV',
  'ALAC',
  'DSD',
  'DSF',
  'DFF',
  'WV',
  'WAVPACK',
  'TTA',
  'AIFF',
  'MPC',
  'SHN',
  'TAK',
])

/** 音质标识的取值。 */
export type AudioQuality = 'hires' | 'lossless' | null

/**
 * 判定一首歌的音质标识。
 *
 * @param song 歌曲（`null` → 没有标识）。
 * @returns `'hires'`（Hi-Res）/ `'lossless'`（无损）/ `null`（无标识）。
 */
export function resolveQuality(song: Song | null | undefined): AudioQuality {
  if (!song) return null
  const codec = typeof song.codec === 'string' ? song.codec.trim().toUpperCase() : ''
  if (!codec || !LOSSLESS_CODECS.has(codec)) return null

  const sampleRate = typeof song.sampleRate === 'number' ? song.sampleRate : 0
  const bitDepth = typeof song.bitDepth === 'number' ? song.bitDepth : 0
  if (sampleRate > 44100 || bitDepth > 16) return 'hires'
  return 'lossless'
}

/** 音质标识的显示文案。 */
export const QUALITY_LABELS: Record<'hires' | 'lossless', string> = {
  hires: 'Hi-Res',
  lossless: '无损',
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 秒 → `m:ss`。 */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 订阅 store 状态。 */
function usePlayerState(store: PlayerStoreLike): PlayerStore {
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(() => onChange()),
    [store],
  )
  const getSnapshot = useCallback(() => store.getState(), [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/**
 * 播放条。
 *
 * - 进度条**可拖动 seek**：拖动时只更新本地预览时间，**松手**才真正 `seek`
 *   （边拖边 seek 会疯狂发请求）；
 * - 音量滑块范围 `[0, 1]`（与 `playerStore.volume` 一致），越界在组件里也钳一次；
 * - 静音是**独立**的 `muted` 标志，**不**与音量 0 混为一谈；
 * - 播放 / 暂停按钮反映 `playerStore.isPlaying`；
 * - **EQ 入口只留位置**（Task 21 才实现），按钮禁用并提示「即将支持」；
 * - **队列入口**打开队列面板（显示当前队列，可切换曲目、移除）。
 */
export function PlayerBar(props: PlayerBarProps): ReactElement {
  const { store = usePlayerStore, onOpenFullPlayer, className } = props

  const state = usePlayerState(store)
  const { current, isPlaying, position, duration, volume, muted, queue } = state

  /** 拖动进度条时的预览值（`null` = 没在拖动）。 */
  const [dragValue, setDragValue] = useState<number | null>(null)
  /** 队列面板是否展开。 */
  const [queueOpen, setQueueOpen] = useState(false)

  const total = duration > 0 ? duration : 0
  const max = total > 0 ? total : 1
  const shown = dragValue !== null ? dragValue : position
  const previewing = dragValue !== null
  const quality = resolveQuality(current)

  // --- 播放控制 ------------------------------------------------------------

  /**
   * 上一首。
   *
   * ⚠️ **必须走 `playerStore.prev()`**：它把播放进度传给了 `Queue.prev(positionSec)`，
   *    「进度 > 3 秒 → 回到本曲开头」这条规则才有意义（控制器追加要求 L）。
   */
  const handlePrev = useCallback((): void => {
    store.getState().prev()
  }, [store])

  const handleNext = useCallback((): void => {
    store.getState().next()
  }, [store])

  const handleTogglePlay = useCallback((): void => {
    store.getState().togglePlay()
  }, [store])

  // --- 进度条 --------------------------------------------------------------

  const handleProgressChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const value = Number(event.target.value)
    if (!Number.isFinite(value)) return
    // 只更新预览，**不**在这里 seek（边拖边 seek 会疯狂发请求）。
    setDragValue(Math.min(Math.max(value, 0), max))
  }, [max])

  /** 松手（或键盘操作结束）时才真正 seek。 */
  const commitSeek = useCallback((): void => {
    if (dragValue === null) return
    store.getState().seek(dragValue)
    setDragValue(null)
  }, [dragValue, store])

  // --- 音量 ----------------------------------------------------------------

  const handleVolumeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = Number(event.target.value)
      if (!Number.isFinite(value)) return
      // store 内部也会钳制，这里再钳一次，防御非法值。
      store.getState().setVolume(Math.min(Math.max(value, 0), 1))
    },
    [store],
  )

  // --- 队列 ----------------------------------------------------------------

  /**
   * 从队列里移除一首。
   *
   * ⚠️ **接口缺口**：Task 13 的 store **没有** `removeFromQueue` 动作
   *    （队列的可变对象在 store 内部闭包里），而本任务**不允许改** `playerStore.ts`。
   *    所以这里走「用剩余队列重新入队」这条路：
   *    - 移除的是**当前曲** → 切到队列里的下一首；
   *    - 移除的是**别的曲子** → 队列换新后**恢复原来的播放进度与暂停态**
   *      （`playTrack` 会把当前曲从头播一遍）。
   */
  const removeFromQueue = useCallback(
    (songId: string): void => {
      const snapshot = store.getState()
      const remaining = snapshot.queue.filter((item) => item.id !== songId)
      if (!remaining.length) return

      const currentStillThere = remaining.find((item) => item.id === snapshot.current?.id)
      const target = currentStillThere ?? remaining[0]!
      const wasPlaying = snapshot.isPlaying
      const keptPosition = snapshot.position

      snapshot.playTrack(target, remaining)

      if (currentStillThere) {
        // 队列换新会把当前曲从头播 → 把进度放回去；原来暂停的也恢复暂停。
        snapshot.seek(keptPosition)
        if (!wasPlaying) snapshot.togglePlay()
      }
    },
    [store],
  )

  const classes = className ? `fnm-playerbar ${className}` : 'fnm-playerbar'

  return (
    <div className={classes} role="region" aria-label="播放条">
      {/* --- 封面 / 歌名 / 歌手 / 音质 --- */}
      <div className="fnm-playerbar__info">
        <CoverImage coverId={current?.coverId ?? ''} alt="" boxSize={44} />
        <span className="fnm-playerbar__meta">
          <span className="fnm-playerbar__title">{current?.title ?? '未在播放'}</span>
          <span className="fnm-playerbar__artist">{current?.artist ?? ''}</span>
        </span>
        {quality && (
          <span
            className={`fnm-playerbar__quality fnm-playerbar__quality--${quality}`}
            data-testid="player-quality"
          >
            {QUALITY_LABELS[quality]}
          </span>
        )}
      </div>

      {/* --- 上一首 / 播放暂停 / 下一首 --- */}
      <div className="fnm-playerbar__controls">
        <button
          type="button"
          className="fnm-playerbar__button"
          onClick={handlePrev}
          disabled={!current}
          aria-label="上一首"
        >
          ⏮
        </button>
        <button
          type="button"
          className="fnm-playerbar__button fnm-playerbar__button--primary"
          onClick={handleTogglePlay}
          disabled={!current}
          aria-label={isPlaying ? '暂停' : '播放'}
          aria-pressed={isPlaying}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          className="fnm-playerbar__button"
          onClick={handleNext}
          disabled={!current}
          aria-label="下一首"
        >
          ⏭
        </button>
      </div>

      {/* --- 进度条 --- */}
      <div className="fnm-playerbar__progress">
        <span
          className={`fnm-playerbar__time${previewing ? ' fnm-playerbar__time--preview' : ''}`}
          data-testid="player-position"
        >
          {formatTime(shown)}
        </span>
        <input
          type="range"
          className="fnm-playerbar__slider"
          min={0}
          max={max}
          step={0.1}
          value={Math.min(Math.max(shown, 0), max)}
          disabled={!current || total <= 0}
          aria-label="播放进度"
          onChange={handleProgressChange}
          onMouseUp={commitSeek}
          onTouchEnd={commitSeek}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
        />
        <span className="fnm-playerbar__time">{formatTime(total)}</span>
      </div>

      {/* --- 音量 --- */}
      <div className="fnm-playerbar__volume">
        <button
          type="button"
          className="fnm-playerbar__button"
          disabled
          aria-label={muted ? '已静音' : '静音'}
          aria-pressed={Boolean(muted)}
          title="静音开关待 Task 13 补充 setMuted 动作（静音与音量 0 是两回事）"
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          className="fnm-playerbar__slider"
          min={0}
          max={1}
          step={0.01}
          value={Math.min(Math.max(volume, 0), 1)}
          aria-label="音量"
          onChange={handleVolumeChange}
        />
      </div>

      {/* --- 队列 / EQ / 全屏 --- */}
      <div className="fnm-playerbar__actions">
        <button
          type="button"
          className="fnm-playerbar__button"
          onClick={() => setQueueOpen((open) => !open)}
          aria-expanded={queueOpen}
          aria-label="播放队列"
        >
          队列
        </button>
        <button
          type="button"
          className="fnm-playerbar__button"
          disabled
          title="均衡器即将支持（Task 21）"
        >
          EQ
        </button>
        {onOpenFullPlayer && (
          <button
            type="button"
            className="fnm-playerbar__button"
            onClick={onOpenFullPlayer}
            aria-label="全屏播放页"
          >
            全屏
          </button>
        )}
      </div>

      {queueOpen && (
        <div className="fnm-playerbar__queue" role="dialog" aria-label="播放队列">
          <p className="fnm-playerbar__queue-title">{`队列（${queue.length} 首）`}</p>
          {queue.length === 0 ? (
            <p className="fnm-playerbar__queue-title">队列为空</p>
          ) : (
            queue.map((song) => (
              <div key={song.id} className="fnm-playerbar__queue-row">
                <button
                  type="button"
                  className={`fnm-playerbar__queue-item${
                    song.id === current?.id ? ' fnm-playerbar__queue-item--current' : ''
                  }`}
                  onClick={() => store.getState().playTrack(song, queue)}
                >
                  <span className="fnm-playerbar__queue-name">{`${song.title} · ${song.artist}`}</span>
                </button>
                <button
                  type="button"
                  className="fnm-playerbar__queue-remove"
                  aria-label={`从队列移除 ${song.title}`}
                  onClick={() => removeFromQueue(song.id)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
