// ---------------------------------------------------------------------------
// 歌曲列表（Task 14）
//
// 自研轻量虚拟滚动：**固定行高 + 可视区裁剪**，不引入第三方虚拟列表库。
// 真实曲库 17.3 万首——DOM 节点数必须与**可视区**成正比，而不是与数据总量成正比。
//
// ---------------------------------------------------------------------------
// 交互语义（控制器追加要求 D，逐条定死）
// ---------------------------------------------------------------------------
// - **单击**行 → 选中该行（焦点随之移动）；
// - **双击**行 → `onPlay(song, index)`，`index` 是该歌在 `songs` 数组里的**真实下标**
//   （虚拟滚动裁剪后仍然传真实下标，不是可见区内的相对下标）；
// - **Ctrl + 单击** → 切换该行的选中态（多选）；
// - **Shift + 单击** → 从上一次锚点连选到该行；
// - **↑ / ↓** → 移动选中行（到边界就停住，不越界），移动后滚动到可见区；
// - `onSelect?.(ids)` → 传出当前选中项的 id 数组，**顺序按 `songs` 的原始顺序**；
//   没有任何选中项时**不调用** `onSelect`（初始状态不调用；
//   用户把最后一项也取消掉时调用 `onSelect([])`——行为自洽，有测试钉住）。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值。
//    样式住在 `src/components/song-list.css`（组件有自己的 `.css`——仓库约定），
//    悬停 / 选中 / 焦点环这类**伪类**只能靠样式表表达，内联 style 做不到。
//
// ⚠️ 行高的**唯一真值**是 `SONG_ROW_HEIGHT`（TS 侧）；
//    CSS 里不写死 48，而是消费组件注入的 `--row-height` 变量。
//    内联 style 只保留 CSS 表达不了的东西：行的 `top`、画布的 `height`。
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type UIEvent,
} from 'react'

import type { Song } from '../../shared/types'
import { CoverImage, formatCount } from './Cards'
import './song-list.css'

/** 歌曲行的固定行高（像素）——裁剪计算依赖它。 */
export const SONG_ROW_HEIGHT = 48
/** 上下各缓冲的行数（防止快速滚动露白）。 */
export const SONG_LIST_BUFFER_ROWS = 5
/** 量不到可视区高度时的兜底值（jsdom 里 `getBoundingClientRect()` 一律返回 0）。 */
export const SONG_LIST_FALLBACK_VIEWPORT_HEIGHT = 600
/** 行内缩略图的边长（像素）。 */
const SONG_COVER_SIZE = 28

/** 支持 CSS 自定义属性（`--row-height` 这类）的内联样式。 */
type StyleVars = CSSProperties & Record<`--${string}`, string | number>

/** 时长格式化（秒 → `m:ss`）。 */
function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** `SongList` 的属性。 */
export interface SongListProps {
  /** 已加载的歌曲（**只渲染可视区附近的一部分**）。 */
  songs: Song[]
  /** 双击行时回调（`index` 是真实下标）。 */
  onPlay: (song: Song, index: number) => void
  /** 选中项变化时回调（id 数组，按 `songs` 原始顺序）。 */
  onSelect?: (ids: string[]) => void
  /** 总量（已知时用于展示「已加载 N / 总计 M」）。 */
  total?: number
  /** 滚到底部时回调（增量加载一页）。 */
  onLoadMore?: () => void
  /** 是否还有更多。 */
  hasMore?: boolean
  /** 是否正在加载（**防止重复触发同一页**）。 */
  loading?: boolean
  /** 行高（不传则用 `SONG_ROW_HEIGHT`）。 */
  rowHeight?: number
  /** 可视区高度（不传则量容器；量不到用兜底值）。 */
  viewportHeight?: number
  /** 上下各缓冲的行数。 */
  bufferRows?: number
  /** 空列表文案。 */
  emptyLabel?: string
  /** 无障碍标签。 */
  ariaLabel?: string
  /**
   * 行内附加操作（**可选**，Task 16 新增）。
   *
   * 由调用方决定在行里渲染什么（搜索页用它放「收藏」按钮）。
   *
   * ⚠️ **纯增量**：不传时行内**不渲染任何附加节点**——
   *    既有调用方（曲库 / 收藏 / 歌单页）的渲染结果与之前**完全一致**。
   */
  renderRowActions?: (song: Song, index: number) => ReactNode
}

/**
 * 歌曲列表（虚拟滚动 + 多选）。
 *
 * **DOM 节点数上界**：`(可视区行数 + 2 × 缓冲行数)` 行，
 * 与 `songs.length`（乃至 `total`）**无关**。
 */
export function SongList(props: SongListProps): ReactElement {
  const {
    songs,
    onPlay,
    onSelect,
    total,
    onLoadMore,
    hasMore = false,
    loading = false,
    rowHeight = SONG_ROW_HEIGHT,
    viewportHeight: viewportHeightProp,
    bufferRows = SONG_LIST_BUFFER_ROWS,
    emptyLabel = '暂无歌曲',
    ariaLabel = '歌曲列表',
    renderRowActions,
  } = props

  const viewportRef = useRef<HTMLDivElement | null>(null)
  /** 已挂载的行元素（用于把焦点移到选中行）。 */
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const [scrollTop, setScrollTop] = useState(0)
  const [measuredHeight, setMeasuredHeight] = useState(0)
  /** 选中的行下标（升序）。 */
  const [selected, setSelected] = useState<number[]>([])
  /** 当前行（键盘导航的落点）。 */
  const [currentIndex, setCurrentIndex] = useState(-1)
  /** 连选锚点（Shift 连选的起点）。 */
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)

  // 量可视区高度（浏览器里用 ResizeObserver；jsdom 里量不到 → 用兜底常量）。
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      const height = rect?.height ?? 0
      setMeasuredHeight((prev) => (prev === height ? prev : height))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const viewportHeight =
    viewportHeightProp ?? (measuredHeight > 0 ? measuredHeight : SONG_LIST_FALLBACK_VIEWPORT_HEIGHT)

  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight))
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight))
  const startIndex = Math.max(0, firstVisible - bufferRows)
  const endIndex = Math.min(songs.length, firstVisible + visibleCount + bufferRows)

  /** 把选中的下标转成 id 数组（按 `songs` 原始顺序）。 */
  const emitSelect = useCallback(
    (indices: number[]): void => {
      if (!onSelect) return
      const ids: string[] = []
      for (const index of indices) {
        const song = songs[index]
        if (song) ids.push(song.id)
      }
      onSelect(ids)
    },
    [onSelect, songs],
  )

  /** 把某一行滚进可视区。 */
  const scrollRowIntoView = useCallback(
    (index: number): void => {
      const rowTop = index * rowHeight
      const rowBottom = rowTop + rowHeight
      let next = scrollTop
      if (rowTop < scrollTop) next = rowTop
      else if (rowBottom > scrollTop + viewportHeight) next = rowBottom - viewportHeight
      const maxTop = Math.max(0, songs.length * rowHeight - viewportHeight)
      const clamped = Math.min(Math.max(next, 0), maxTop)
      setScrollTop(clamped)
      const element = viewportRef.current
      if (element) element.scrollTop = clamped
    },
    [rowHeight, scrollTop, songs.length, viewportHeight],
  )

  /** 单击行：按修饰键区分「选中 / 切换 / 连选」。 */
  const handleRowClick = useCallback(
    (index: number, event: MouseEvent<HTMLDivElement>): void => {
      if (event.ctrlKey || event.metaKey) {
        const next = selected.includes(index)
          ? selected.filter((item) => item !== index)
          : [...selected, index].sort((a, b) => a - b)
        setSelected(next)
        setCurrentIndex(index)
        setAnchorIndex(index)
        emitSelect(next)
        return
      }
      if (event.shiftKey) {
        const base = anchorIndex ?? currentIndex
        const from = base >= 0 ? Math.min(base, index) : index
        const to = base >= 0 ? Math.max(base, index) : index
        const next: number[] = []
        for (let i = from; i <= to; i += 1) next.push(i)
        setSelected(next)
        setCurrentIndex(index)
        emitSelect(next)
        return
      }
      setSelected([index])
      setCurrentIndex(index)
      setAnchorIndex(index)
      emitSelect([index])
    },
    [anchorIndex, currentIndex, emitSelect, selected],
  )

  /** 双击行：播放。 */
  const handleRowDoubleClick = useCallback(
    (index: number): void => {
      const song = songs[index]
      if (!song) return
      onPlay(song, index)
    },
    [onPlay, songs],
  )

  /** ↑ / ↓：移动选中行（到边界停住）。 */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      if (songs.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const base = currentIndex >= 0 ? currentIndex : -1
      const next = Math.min(Math.max(base + delta, 0), songs.length - 1)
      // 已经在边界上 → 停住，**不重复回调**。
      if (next === currentIndex) return
      setCurrentIndex(next)
      setAnchorIndex(next)
      setSelected([next])
      emitSelect([next])
      scrollRowIntoView(next)
    },
    [currentIndex, emitSelect, scrollRowIntoView, songs.length],
  )

  /** 滚动：更新窗口位置；接近底部时触发增量加载。 */
  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>): void => {
      const top = event.currentTarget.scrollTop
      setScrollTop(top)
      if (!onLoadMore || !hasMore || loading) return
      const contentHeight = songs.length * rowHeight
      if (top + viewportHeight >= contentHeight - rowHeight) onLoadMore()
    },
    [hasMore, loading, onLoadMore, rowHeight, songs.length, viewportHeight],
  )

  // 内容还填不满可视区时自动续一页（否则用户没有滚动条可滚，永远加载不到下一页）。
  useEffect(() => {
    if (!onLoadMore || !hasMore || loading) return
    if (songs.length === 0) return
    const contentHeight = songs.length * rowHeight
    if (contentHeight <= viewportHeight + rowHeight) onLoadMore()
  }, [hasMore, loading, onLoadMore, rowHeight, songs.length, viewportHeight])

  // 焦点跟随选中行（要求 D：「单击行 → 选中该行（并把焦点移过去）」）。
  useEffect(() => {
    if (currentIndex < 0) return
    const element = rowRefs.current.get(currentIndex)
    if (!element) return
    if (element.ownerDocument.activeElement !== element) element.focus()
  }, [currentIndex, endIndex, startIndex])

  const rows = songs.slice(startIndex, endIndex)
  const totalText = formatCount(total ?? songs.length)
  const statusText = `已加载 ${formatCount(songs.length)} / ${totalText}${loading ? '，加载中…' : ''}`

  // 行高：唯一真值在 TS 侧，这里以 CSS 变量桥接给样式表（CSS 里不重复写 48）。
  const rootStyle = { '--row-height': `${rowHeight}px` } as StyleVars

  // 空态**也要**渲染状态行：组件必须始终暴露「已加载 / 总共」（要求 E）。
  if (songs.length === 0) {
    return (
      <div className="fnm-songlist" style={rootStyle}>
        <p className="fnm-songlist__empty">{emptyLabel}</p>
        <p className="fnm-songlist__status">{statusText}</p>
      </div>
    )
  }

  return (
    <div className="fnm-songlist" style={rootStyle}>
      <div
        className="fnm-songlist__viewport"
        role="listbox"
        aria-label={ariaLabel}
        aria-multiselectable="true"
        tabIndex={0}
        ref={viewportRef}
        data-scroll-top={scrollTop}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >
        <div
          className="fnm-songlist__canvas"
          style={{ height: songs.length * rowHeight }}
        >
          {rows.map((song, offset) => {
            const index = startIndex + offset
            const isSelected = selected.includes(index)
            return (
              <div
                key={song.id}
                role="option"
                aria-selected={isSelected}
                data-index={index}
                data-selected={isSelected ? 'true' : 'false'}
                className="fnm-songlist__row"
                tabIndex={-1}
                ref={(element) => {
                  if (element) rowRefs.current.set(index, element)
                  else rowRefs.current.delete(index)
                }}
                onClick={(event) => handleRowClick(index, event)}
                onDoubleClick={() => handleRowDoubleClick(index)}
                style={{ top: index * rowHeight }}
              >
                <span className="fnm-songlist__cover">
                  <CoverImage coverId={song.coverId} alt="" boxSize={SONG_COVER_SIZE} />
                </span>
                <span className="fnm-songlist__title">{song.title}</span>
                <span className="fnm-songlist__artist">{song.artist}</span>
                <span className="fnm-songlist__album">{song.album}</span>
                {song.favorite && (
                  <span className="fnm-songlist__favorite" role="img" aria-label="已收藏">
                    ♥
                  </span>
                )}
                {/* ⚠️ 可选的行内操作（Task 16）：不传时**不产生任何 DOM 节点**。 */}
                {renderRowActions ? renderRowActions(song, index) : null}
                <span className="fnm-songlist__duration">{formatDuration(song.duration)}</span>
              </div>
            )
          })}
        </div>
      </div>

      <p className="fnm-songlist__status">{statusText}</p>
    </div>
  )
}
