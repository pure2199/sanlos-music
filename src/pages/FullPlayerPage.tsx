// ---------------------------------------------------------------------------
// 全屏播放页（Task 15）
//
// 内容：封面取色背景、逐行歌词（双行模式）或队列面板、播放控制。
//
// ---------------------------------------------------------------------------
// 歌词数据（控制器追加要求 C / K）
// ---------------------------------------------------------------------------
// - `lyricApi.list(songId)` → `LyricEntry[]`；
//   实测同一首歌会返回**两条 `source` 不同**的记录（一条原文、一条翻译）。
// - 解析与合并**直接用 Task 12 的顶层便利函数 `parseLyricEntries(entries)`**：
//   它内部完成「挑原文/翻译 → 各自解析 → 各自 `offset` → 按时间戳对齐合并」。
//   本任务**不自己算偏移**（Task 12 已把语义定死：正 = 延后，负数钳到 0）。
// - 该歌**没有歌词**时 → 解析出空数组 → 歌词区显示「暂无歌词」（不白屏、不崩）。
//
// ---------------------------------------------------------------------------
// 封面取色（控制器追加要求 F / N）
// ---------------------------------------------------------------------------
// - 封面地址**只**由 `components/coverUrl.ts` 拼（全项目唯一的拼装点），本文件**不拼第二份**；
// - 取色用 **canvas 绘制封面并取像素**：封面走 `fnm://` 代理，与页面**跨源**
//   （`electron/proxy.ts` 的注释明写「渲染进程页面来自 `file://` / dev server，与 `fnm://` 跨源」）
//   → 图片必须带 `crossOrigin = 'anonymous'`，否则 canvas 被污染、取不到像素。
//   代理对所有响应都带了 `access-control-allow-origin: *` → 普通 GET 不触发预检 → 能读到像素。
//   CSP（`index.html`）已放行 `fnm:`（`img-src`）→ **取色不受 CSP 阻断**。
//   ⚠️ 本任务**不改 CSP**。
// - 取色**必须异步**、**不得阻塞**首屏渲染；
// - 取不到色（无封面 / 加载失败 / canvas 被污染）→ **回退到默认背景**（CSS 变量）；
// - 结果**按 `coverId` 缓存**，不每次切歌都重算。
//
// ---------------------------------------------------------------------------
// 样式约定（控制器裁定）
// ---------------------------------------------------------------------------
// 样式落在 `src/pages/full-player.css`；动态值（取到的封面色）走 CSS 自定义属性。
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react'

import type { LyricEntry } from '../api/types'
import { lyricApi } from '../api/lyric'
import { CoverImage } from '../components/Cards'
import { coverUrl } from '../components/coverUrl'
import type { PlayerStoreLike } from '../components/PlayerBar'
import { QUEUE_ONLY_ONE_HINT, removeSongFromQueue } from '../components/PlayerBar'
import { usePlayerStore } from '../state/playerStore'
import { LyricView } from '../ui/lyrics/LyricView'
import { parseLyricEntries, type LyricLine } from '../ui/lyrics/parse'
import './full-player.css'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 歌词接口的最小面（可注入，便于测试）。 */
export interface LyricApiLike {
  /** 全部歌词条目（同一首歌可能有多条来源不同的记录）。 */
  list(songId: string): Promise<LyricEntry[]>
}

/** `FullPlayerPage` 的属性。 */
export interface FullPlayerPageProps {
  /** 播放器 store（可注入；缺省用全局 store）。 */
  store?: PlayerStoreLike
  /** 歌词接口（可注入；缺省用真实的 `lyricApi`）。 */
  lyricApi?: LyricApiLike
  /** 关闭回调。 */
  onClose?: () => void
  /** 附加类名。 */
  className?: string
}

// ---------------------------------------------------------------------------
// 封面取色
// ---------------------------------------------------------------------------

/** 取色时把封面缩到多少像素见方（越小越快）。 */
export const COVER_SAMPLE_SIZE = 8

/**
 * 取色失败后**重试**的次数上限（真机踩过的坑，2026-11-04）。
 *
 * ⚠️ 封面刚切过来时可能**还没加载好**（中继慢 / 代理首次建连）→ 第一次取色失败
 *    → 若把失败**缓存**下来，这一首歌**到重启为止都不再取色** → 背景永远是兜底色。
 * ⇒ 失败**不缓存**，并**有限次重试**。
 */
export const MAX_TINT_ATTEMPTS = 3

/** 取色失败后的重试间隔（毫秒）。 */
export const TINT_RETRY_DELAY_MS = 1500

/**
 * 按 `coverId` 缓存的取色结果。
 *
 * ⚠️ **只缓存成功的结果**（`string`）：失败**不缓存** → 允许重试
 *    （见 `MAX_TINT_ATTEMPTS`）。
 */
const coverColorCache = new Map<string, string | null>()

/**
 * 取色缓存（**按 coverId**）。
 *
 * @param coverId 封面 id。
 * @returns 已缓存的颜色；`undefined` = 从没取过（还没取或上次失败了）。
 */
export function getCachedCoverColor(coverId: string): string | null | undefined {
  return coverColorCache.get(coverId)
}

/** 清空取色缓存（测试用）。 */
export function clearCoverColorCache(): void {
  coverColorCache.clear()
}

/**
 * 把 RGB 三个分量拼成十六进制颜色串。
 *
 * ⚠️ 这里**不写死任何颜色**——分量来自 canvas 取到的像素。
 */
function toHex(r: number, g: number, b: number): string {
  const part = (value: number): string =>
    Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * 用 canvas 绘制封面并取像素，算出一个代表色。
 *
 * - **异步**：返回 Promise，**不阻塞**首屏渲染；
 * - 失败（图片加载失败 / canvas 被污染 / 取不到 2D 上下文）→ 解析成 `null`（回退默认背景）；
 * - ⚠️ **必须设 `crossOrigin = 'anonymous'`**（且**在设 `src` 之前**）：
 *    封面走 `fnm://` 代理，而渲染进程页面来自 `file://` / dev server → 与封面**跨源**
 *    （`electron/proxy.ts` 自己的注释就是这么写的）。不设 `crossOrigin` 时图片以
 *    no-cors 方式载入 → canvas 被污染 → `getImageData` 抛 SecurityError → **永远取不到色**。
 *    代理对所有响应都带了 `access-control-allow-origin: *`，普通 GET 不触发预检 →
 *    设上 `anonymous` 就能读到像素。
 *    ⚠️ 这条**只针对封面图片**（要喂给 canvas 取色）；媒体元素 `<audio src="fnm://...">`
 *    **不要**设 `crossOrigin`（Task 13 的要求 H）。
 *
 * @param url 封面地址（由 `coverUrl()` 拼）。
 */
export function extractCoverColor(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null)
      return
    }
    const image = new Image()
    // ⚠️ **在设 `src` 之前**设置（顺序有意义：先设 crossOrigin，再让图片开始加载）。
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = COVER_SAMPLE_SIZE
        canvas.height = COVER_SAMPLE_SIZE
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(null)
          return
        }
        context.drawImage(image, 0, 0, COVER_SAMPLE_SIZE, COVER_SAMPLE_SIZE)
        const data = context.getImageData(0, 0, COVER_SAMPLE_SIZE, COVER_SAMPLE_SIZE).data
        if (!data || data.length < 4) {
          resolve(null)
          return
        }
        let r = 0
        let g = 0
        let b = 0
        const count = data.length / 4
        for (let i = 0; i < data.length; i += 4) {
          r += data[i] ?? 0
          g += data[i + 1] ?? 0
          b += data[i + 2] ?? 0
        }
        resolve(toHex(r / count, g / count, b / count))
      } catch {
        // canvas 被污染（`getImageData` 抛安全错误）→ 取不到色，回退默认背景。
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = url
  })
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/** 歌词加载状态。 */
type LyricStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 允许写 CSS 自定义属性的 style 对象。 */
type CssVars = CSSProperties & Record<`--${string}`, string | number | undefined>

/** 订阅 store 状态。 */
function usePlayerState(store: PlayerStoreLike) {
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(() => onChange()),
    [store],
  )
  const getSnapshot = useCallback(() => store.getState(), [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 全屏播放页。
 *
 * - 背景：封面取色（异步、**按 coverId 缓存**、取不到就回退到 CSS 变量的默认背景）；
 * - 主体：逐行歌词（**双行模式**，推进逻辑复用 Task 15 的纯函数）或队列面板；
 * - 所有播放动作都走 `playerStore`（**不直接碰** `PlayerEngine`）。
 */
export function FullPlayerPage(props: FullPlayerPageProps): ReactElement {
  const {
    store = usePlayerStore,
    lyricApi: api = lyricApi,
    onClose,
    className,
  } = props

  const state = usePlayerState(store)
  const { current, isPlaying, position, queue } = state
  /** 队列只剩一首歌时**不能移除**（移除按钮禁用 + 提示，不静默无反应）。 */
  const canRemove = queue.length > 1

  const [tab, setTab] = useState<'lyrics' | 'queue'>('lyrics')
  const [lines, setLines] = useState<LyricLine[]>([])
  const [lyricStatus, setLyricStatus] = useState<LyricStatus>('idle')
  const [tint, setTint] = useState<string | null>(null)
  /** 取色重试次数（失败后延迟重试；见 `MAX_TINT_ATTEMPTS`）。 */
  const [tintAttempt, setTintAttempt] = useState(0)

  const songId = current?.id ?? ''
  const coverId = current?.coverId ?? ''

  // --- 歌词：拉取 + 用 Task 12 的入口解析合并 --------------------------------
  useEffect(() => {
    if (!songId) {
      setLines([])
      setLyricStatus('idle')
      return
    }
    let cancelled = false
    setLyricStatus('loading')
    setLines([])
    api
      .list(songId)
      .then((entries) => {
        if (cancelled) return
        // ⚠️ 直接用 Task 12 的便利入口（挑原文/翻译 → 各自 offset → 对齐合并）。
        setLines(parseLyricEntries(entries ?? []))
        setLyricStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setLines([])
        setLyricStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [api, songId])

  // --- 封面取色：异步、不阻塞首屏、按 coverId 缓存 ----------------------------
  useEffect(() => {
    if (!coverId) {
      setTint(null)
      return
    }
    const cached = coverColorCache.get(coverId)
    if (cached) {
      setTint(cached)
      return
    }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    // 先用默认背景（不写 --tint → CSS 回落到语义变量），取到色再换。
    setTint(null)
    const url = coverUrlFor(coverId)
    if (!url) return
    void extractCoverColor(url).then((color) => {
      if (cancelled) return
      if (color) {
        // ⚠️ **只缓存成功的结果**。
        coverColorCache.set(coverId, color)
        setTint(color)
        return
      }
      // ⚠️ **失败不缓存** → 否则一次失败 = 这首歌**到重启为止都不取色**
      //    （真机踩过：封面刚切过来还没加载好 → 背景就永远停在兜底色）。
      //    ⇒ 延迟重试（次数有限，别无限刷）。
      if (tintAttempt < MAX_TINT_ATTEMPTS) {
        retryTimer = setTimeout(() => {
          if (cancelled) return
          setTintAttempt((n) => n + 1)
        }, TINT_RETRY_DELAY_MS)
      }
    })
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [coverId, tintAttempt])

  // --- Esc 关闭 ------------------------------------------------------------
  useEffect(() => {
    if (!onClose) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const style: CssVars | undefined = tint ? { '--fnm-fullplayer__tint': tint } : undefined

  const classes = className ? `fnm-fullplayer ${className}` : 'fnm-fullplayer'

  const lyricBody = ((): ReactElement => {
    if (lyricStatus === 'loading') {
      return <p className="fnm-fullplayer__status">正在加载歌词…</p>
    }
    if (lyricStatus === 'error') {
      return (
        <p className="fnm-fullplayer__error" role="alert">
          歌词加载失败
        </p>
      )
    }
    return (
      <LyricView
        lines={lines}
        currentTime={position}
        mode="double"
        emptyLabel="暂无歌词"
      />
    )
  })()

  return (
    <div className={classes} data-testid="full-player" style={style} role="dialog" aria-label="全屏播放页">
      <header className="fnm-fullplayer__header">
        <button
          type="button"
          className="fnm-fullplayer__button"
          onClick={() => onClose?.()}
          aria-label="关闭全屏播放页"
        >
          ×
        </button>
      </header>

      <div className="fnm-fullplayer__body">
        <section className="fnm-fullplayer__cover">
          <CoverImage coverId={coverId} alt="" boxSize={280} />
        </section>

        <section className="fnm-fullplayer__panel">
          <h1 className="fnm-fullplayer__title">{current?.title ?? '未在播放'}</h1>
          <p className="fnm-fullplayer__artist">{current?.artist ?? ''}</p>

          <nav className="fnm-fullplayer__tabs">
            <button
              type="button"
              className={`fnm-fullplayer__tab${tab === 'lyrics' ? ' fnm-fullplayer__tab--active' : ''}`}
              onClick={() => setTab('lyrics')}
              aria-pressed={tab === 'lyrics'}
            >
              歌词
            </button>
            <button
              type="button"
              className={`fnm-fullplayer__tab${tab === 'queue' ? ' fnm-fullplayer__tab--active' : ''}`}
              onClick={() => setTab('queue')}
              aria-pressed={tab === 'queue'}
            >
              队列
            </button>
          </nav>

          {tab === 'lyrics' ? (
            lyricBody
          ) : (
            <ul className="fnm-fullplayer__queue">
              {queue.length === 0 ? (
                <li className="fnm-fullplayer__status">队列为空</li>
              ) : (
                <>
                  {/* 队列只剩一首歌 → 移除按钮禁用 + 给出可读提示（不静默无反应）。 */}
                  {queue.length === 1 && (
                    <li className="fnm-fullplayer__status">{QUEUE_ONLY_ONE_HINT}</li>
                  )}
                  {queue.map((song) => (
                    <li key={song.id} className="fnm-fullplayer__queue-row">
                      <button
                        type="button"
                        className={`fnm-fullplayer__queue-item${
                          song.id === current?.id ? ' fnm-fullplayer__queue-item--current' : ''
                        }`}
                        onClick={() => store.getState().playTrack(song, queue)}
                      >
                        <span className="fnm-fullplayer__queue-name">
                          {`${song.title} · ${song.artist}`}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="fnm-fullplayer__queue-remove"
                        aria-label={`从队列移除 ${song.title}`}
                        title={canRemove ? `从队列移除 ${song.title}` : QUEUE_ONLY_ONE_HINT}
                        disabled={!canRemove}
                        onClick={() => removeSongFromQueue(store, song.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </>
              )}
            </ul>
          )}
        </section>
      </div>

      <footer className="fnm-fullplayer__controls">
        <button
          type="button"
          className="fnm-fullplayer__button"
          onClick={() => store.getState().prev()}
          disabled={!current}
          aria-label="上一首"
        >
          ⏮
        </button>
        <button
          type="button"
          className="fnm-fullplayer__button fnm-fullplayer__button--primary"
          onClick={() => store.getState().togglePlay()}
          disabled={!current}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          className="fnm-fullplayer__button"
          onClick={() => store.getState().next()}
          disabled={!current}
          aria-label="下一首"
        >
          ⏭
        </button>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 取封面地址
// ---------------------------------------------------------------------------

/**
 * 取封面地址（**全项目唯一的拼装点**是 `components/coverUrl.ts`）。
 */
function coverUrlFor(coverId: string): string | null {
  return coverUrl(coverId)
}
