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
  useEffect,
  useRef,
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

/** 队列只剩一首歌时的提示文案（移除按钮禁用 + 面板里显示）。 */
export const QUEUE_ONLY_ONE_HINT = '队列里只有一首歌，不能移除'

/**
 * 从队列里移除一首（**播放条与全屏播放页共用这一份语义**）。
 *
 * ⚠️ **接口缺口**：Task 13 的 store **没有** `removeFromQueue` 动作
 *    （队列的可变对象在 store 内部闭包里），而本任务**不允许改** `playerStore.ts`。
 *    所以这里走「用剩余队列重新入队」这条路：
 *    - 移除的是**别的曲子** → 队列换新后**恢复原来的播放进度与暂停态**
 *      （`playTrack` 会把当前曲从头播一遍）；
 *    - 移除的是**当前曲** → 切到**队列里的下一首**（原队列中当前曲的**后面**那一首；
 *      当前曲已经是队列最后一首时 → **回到队列的第一首**）。
 *
 * @param store 播放器 store。
 * @param songId 要移除的曲目 id。
 */
export function removeSongFromQueue(store: PlayerStoreLike, songId: string): void {
  const snapshot = store.getState()
  const queue = snapshot.queue
  const removedIndex = queue.findIndex((item) => item.id === songId)
  const remaining = queue.filter((item) => item.id !== songId)
  // 移除后队列空了 → 没有可播的（UI 会禁用按钮并给出提示，不静默无反应）
  if (!remaining.length) return

  const currentStillThere = remaining.find((item) => item.id === snapshot.current?.id)
  const wasPlaying = snapshot.isPlaying
  const keptPosition = snapshot.position

  let target = currentStillThere ?? remaining[0]!
  if (!currentStillThere) {
    // 移除的是**当前曲** → 切到「队列里的下一首」（越界则回到队列第一首）。
    const nextInQueue = removedIndex >= 0 ? queue[removedIndex + 1] : undefined
    target =
      (nextInQueue ? remaining.find((item) => item.id === nextInQueue.id) : undefined) ??
      remaining[0]!
  }

  snapshot.playTrack(target, remaining)

  if (currentStillThere) {
    // 队列换新会把当前曲从头播 → 把进度放回去；原来暂停的也恢复暂停。
    snapshot.seek(keptPosition)
    if (!wasPlaying) snapshot.togglePlay()
  }
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
  /**
   * 拖动预览值的**同步副本**（F15-05）。
   *
   * 同一次松手可能同时触发「滑块上的 `mouseup`」与「window 上的 `mouseup`」
   * （用户在滑块外松手）→ 提交时用它做**幂等守卫**，保证只 seek 一次。
   */
  const pendingSeekRef = useRef<number | null>(null)
  /** 队列面板是否展开。 */
  const [queueOpen, setQueueOpen] = useState(false)

  const total = duration > 0 ? duration : 0
  const max = total > 0 ? total : 1
  const shown = dragValue !== null ? dragValue : position
  const previewing = dragValue !== null
  const quality = resolveQuality(current)
  /** 队列只剩一首歌时**不能移除**（移除按钮禁用 + 面板里给出提示，不静默无反应）。 */
  const canRemove = queue.length > 1

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
    const clamped = Math.min(Math.max(value, 0), max)
    pendingSeekRef.current = clamped
    setDragValue(clamped)
  }, [max])

  /**
   * 松手（或键盘操作结束）时才真正 seek。
   *
   * ⚠️ **口径（控制器裁定）**：松手**一律**提交预览位置，**含在滑块外松手**。
   *    这是主流播放器的行为（HTML5 `range` / YouTube / Spotify 都是「拖到哪松到哪」）；
   *    用户拖进度条的意图就是跳到该位置 → 在滑块外松手却不跳会让人困惑。
   *    本条要修的是**原始缺陷**：「松手后进度条停在预览值、实际播放位置却没变」
   *    （UI 与播放位置不一致）→ 提交后两者一致。
   *
   * ⚠️ **幂等**（F15-05）：同一次松手可能既触发滑块上的 `mouseup`、又触发
   *    window 上的 `mouseup` → 用 `pendingSeekRef` 保证**只提交一次**。
   */
  const commitSeek = useCallback((): void => {
    const pending = pendingSeekRef.current
    if (pending === null) return
    pendingSeekRef.current = null
    setDragValue(null)
    store.getState().seek(pending)
  }, [store])

  /**
   * 拖动期间监听 **window** 的松手事件（F15-05）。
   *
   * ⚠️ 只监听滑块自己的 `mouseup` 是不够的：用户把鼠标拖出滑块再松开时，
   *    松手事件落在滑块外 → 不会 seek、`dragValue` 卡住 → 预览态不复位、本次拖动不生效。
   *    监听到了之后，按上面的口径：**松手一律提交预览位置**（含滑块外）。
   */
  useEffect(() => {
    if (dragValue === null) return
    const handleRelease = (): void => commitSeek()
    window.addEventListener('mouseup', handleRelease)
    window.addEventListener('pointerup', handleRelease)
    window.addEventListener('touchend', handleRelease)
    return () => {
      window.removeEventListener('mouseup', handleRelease)
      window.removeEventListener('pointerup', handleRelease)
      window.removeEventListener('touchend', handleRelease)
    }
  }, [commitSeek, dragValue])

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
   * 从队列里移除一首（语义见 `removeSongFromQueue`）。
   */
  const removeFromQueue = useCallback(
    (songId: string): void => {
      removeSongFromQueue(store, songId)
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
            <>
              {/* 队列只剩一首歌 → 移除按钮禁用 + 给出可读提示（不静默无反应）。 */}
              {queue.length === 1 && (
                <p className="fnm-playerbar__queue-title">{QUEUE_ONLY_ONE_HINT}</p>
              )}
              {queue.map((song) => (
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
                    title={canRemove ? `从队列移除 ${song.title}` : QUEUE_ONLY_ONE_HINT}
                    disabled={!canRemove}
                    onClick={() => removeFromQueue(song.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
