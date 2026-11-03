// ---------------------------------------------------------------------------
// 曲库卡片（Task 14）
//
// 本文件提供三样东西：
// - `CoverImage`：封面图。**没有封面**（空串 / null）或**加载失败**时渲染占位块，
//   绝不出现浏览器默认的破图图标；
// - `AlbumCard` / `ArtistCard` / `GenreCard` / `PlaylistCard`：四种实体卡片；
// - `CardGrid`：**自研轻量虚拟网格**（固定行高 + 可视区裁剪），不引入第三方虚拟列表库。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），不得出现硬编码色值
//    （`#hex` / `rgb()` / `hsl()` 一律不行）——这样 Task 18/19 换主题时只换变量、
//    不重写组件。
//
// ⚠️ 本任务的「拥有文件」清单里**没有 .css 文件**，所以样式走**内联 style**，
//    且一律引用 `var(--token)`：效果与外部样式表等价（同样只依赖语义变量），
//    又不会和别的任务并行新建同名样式表冲突。
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type UIEvent,
} from 'react'

import type { Album, Artist, Genre, Playlist } from '../../shared/types'
import { coverUrl } from './coverUrl'

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

/**
 * 千分位（不依赖 locale，保证渲染结果稳定）。
 *
 * 形如 `173,669`——用于「已加载 200 / 173,669」这类状态文案。
 */
export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ---------------------------------------------------------------------------
// 封面
// ---------------------------------------------------------------------------

/** 封面盒子的默认边长（像素，正方形）。 */
export const CARD_COVER_SIZE = 160

/** 封面框（图片与占位块共用，保证切换时不跳动）。 */
const COVER_BOX: CSSProperties = {
  borderRadius: '8px',
  overflow: 'hidden',
  background: 'var(--surface-sunken)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

/** 封面图片。 */
const COVER_IMAGE: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
}

/** `CoverImage` 的属性。 */
export interface CoverImageProps {
  /** 封面 id：`Song` 无封面是空串，`Album` / `Artist` / `Genre` 无封面是 `null`。 */
  coverId: string | null | undefined
  /** 替代文本（装饰性封面传空串）。 */
  alt: string
  /**
   * CSS 盒子的边长（像素，正方形）。
   *
   * ⚠️ 这只是**显示尺寸**，与服务端 `size` 参数**无关**——
   *    服务端尺寸全项目只有一个取值点（`COVER_SIZE_DEFAULT`），校准时只改那一处。
   */
  boxSize?: number
  /** 附加类名。 */
  className?: string
}

/**
 * 封面图。
 *
 * - 没有封面（空串 / `null`）→ 渲染占位块，**不渲染 `<img>`**；
 * - 加载失败（404 / 解码失败）→ 切成占位块，**不留浏览器默认破图**；
 * - 封面地址**只**由 `coverUrl()` 拼（`./coverUrl.ts` 是全项目唯一的拼装点）。
 */
export function CoverImage({ coverId, alt, boxSize = CARD_COVER_SIZE, className }: CoverImageProps): ReactElement {
  const [failed, setFailed] = useState(false)
  const url = coverUrl(coverId)

  // 换了封面 id 就重置失败状态（上一张的失败不该连累下一张）。
  useEffect(() => {
    setFailed(false)
  }, [coverId])

  const classNames = className ? `${className} fnm-cover` : 'fnm-cover'

  if (!url || failed) {
    return (
      <div
        className={`${classNames} fnm-cover__placeholder`}
        data-testid="cover-placeholder"
        aria-hidden="true"
        style={{
          ...COVER_BOX,
          width: boxSize,
          height: boxSize,
          color: 'var(--text-secondary)',
          fontSize: '20px',
        }}
      >
        ♪
      </div>
    )
  }

  return (
    <img
      className={`${classNames} fnm-cover__image`}
      src={url}
      alt={alt}
      // ⚠️ 懒加载：不在视口里的卡片不发起封面请求（要求 A）。
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ ...COVER_IMAGE, width: boxSize, height: boxSize }}
    />
  )
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

/** 卡片外框。 */
const CARD: CSSProperties = {
  boxSizing: 'border-box',
  height: '100%',
}

/** 卡片按钮（整卡可点）。 */
const CARD_BUTTON: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  width: '100%',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  textAlign: 'left',
  cursor: 'pointer',
}

/** 卡片主标题。 */
const CARD_TITLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** 卡片副标题。 */
const CARD_SUBTITLE: CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** `AlbumCard` 的属性。 */
export interface AlbumCardProps {
  /** 专辑。 */
  album: Album
  /** 点击卡片时回调。 */
  onOpen?: (album: Album) => void
}

/** 专辑卡片。 */
export function AlbumCard({ album, onOpen }: AlbumCardProps): ReactElement {
  return (
    <article className="fnm-card" data-testid="fnm-card" style={CARD}>
      <button
        type="button"
        className="fnm-card__button"
        onClick={() => onOpen?.(album)}
        style={CARD_BUTTON}
      >
        <CoverImage coverId={album.coverId} alt={album.title} />
        <span className="fnm-card__title" style={CARD_TITLE}>
          {album.title}
        </span>
        <span className="fnm-card__subtitle" style={CARD_SUBTITLE}>
          {album.artist}
        </span>
      </button>
    </article>
  )
}

/** `ArtistCard` 的属性。 */
export interface ArtistCardProps {
  /** 歌手。 */
  artist: Artist
  /** 点击卡片时回调。 */
  onOpen?: (artist: Artist) => void
}

/** 歌手卡片。 */
export function ArtistCard({ artist, onOpen }: ArtistCardProps): ReactElement {
  return (
    <article className="fnm-card" data-testid="fnm-card" style={CARD}>
      <button
        type="button"
        className="fnm-card__button"
        onClick={() => onOpen?.(artist)}
        style={CARD_BUTTON}
      >
        <CoverImage coverId={artist.coverId} alt={artist.name} />
        <span className="fnm-card__title" style={CARD_TITLE}>
          {artist.name}
        </span>
        <span className="fnm-card__subtitle" style={CARD_SUBTITLE}>
          {`${artist.albumCount} 张专辑 · ${artist.trackCount} 首`}
        </span>
      </button>
    </article>
  )
}

/** `GenreCard` 的属性。 */
export interface GenreCardProps {
  /** 风格。 */
  genre: Genre
  /** 点击卡片时回调。 */
  onOpen?: (genre: Genre) => void
}

/** 风格卡片。 */
export function GenreCard({ genre, onOpen }: GenreCardProps): ReactElement {
  return (
    <article className="fnm-card" data-testid="fnm-card" style={CARD}>
      <button
        type="button"
        className="fnm-card__button"
        onClick={() => onOpen?.(genre)}
        style={CARD_BUTTON}
      >
        <CoverImage coverId={genre.coverId} alt={genre.name} />
        <span className="fnm-card__title" style={CARD_TITLE}>
          {genre.name}
        </span>
        <span className="fnm-card__subtitle" style={CARD_SUBTITLE}>
          {`${genre.trackCount} 首`}
        </span>
      </button>
    </article>
  )
}

/** `PlaylistCard` 的属性。 */
export interface PlaylistCardProps {
  /** 歌单。 */
  playlist: Playlist
  /** 点击卡片时回调。 */
  onOpen?: (playlist: Playlist) => void
}

/** 歌单卡片。 */
export function PlaylistCard({ playlist, onOpen }: PlaylistCardProps): ReactElement {
  return (
    <article className="fnm-card" data-testid="fnm-card" style={CARD}>
      <button
        type="button"
        className="fnm-card__button"
        onClick={() => onOpen?.(playlist)}
        style={CARD_BUTTON}
      >
        <CoverImage coverId={playlist.coverId} alt={playlist.name} />
        <span className="fnm-card__title" style={CARD_TITLE}>
          {playlist.name}
        </span>
        <span className="fnm-card__subtitle" style={CARD_SUBTITLE}>
          {`${playlist.trackCount} 首`}
        </span>
      </button>
    </article>
  )
}

// ---------------------------------------------------------------------------
// 虚拟网格
// ---------------------------------------------------------------------------

/** 网格的行高（像素，固定值——裁剪计算依赖它）。 */
export const CARD_GRID_ROW_HEIGHT = 224
/** 网格上下各缓冲的行数（防止快速滚动露白）。 */
export const CARD_GRID_BUFFER_ROWS = 2
/** 一列的最小宽度（用来算列数）。 */
export const CARD_GRID_MIN_COLUMN_WIDTH = 180
/** 量不到宽度时的兜底列数。 */
export const CARD_GRID_FALLBACK_COLUMNS = 4
/** 量不到高度时的兜底可视区高度。 */
export const CARD_GRID_FALLBACK_VIEWPORT_HEIGHT = 600

/** 空态文案样式。 */
const EMPTY: CSSProperties = {
  margin: 0,
  padding: '24px 4px',
  fontSize: '13px',
  color: 'var(--text-secondary)',
}

/** `CardGrid` 的属性。 */
export interface CardGridProps<T> {
  /** 已加载的条目（**只渲染可视区附近的一部分**）。 */
  items: T[]
  /** 条目的 key。 */
  keyOf: (item: T, index: number) => string
  /** 渲染单个条目。 */
  renderItem: (item: T, index: number) => ReactElement
  /** 列数（不传则按容器宽度算）。 */
  columns?: number
  /** 行高（不传则用 `CARD_GRID_ROW_HEIGHT`）。 */
  rowHeight?: number
  /** 可视区高度（不传则量容器；量不到用兜底值）。 */
  viewportHeight?: number
  /** 上下各缓冲的行数。 */
  bufferRows?: number
  /** 是否还有更多（用于触发增量加载）。 */
  hasMore?: boolean
  /** 是否正在加载（**防止重复触发同一页**）。 */
  loading?: boolean
  /** 滚到底部时回调（增量加载一页）。 */
  onLoadMore?: () => void
  /** 空列表文案。 */
  emptyLabel?: string
  /** 无障碍标签。 */
  ariaLabel?: string
}

/**
 * 虚拟网格（固定行高 + 可视区裁剪）。
 *
 * **DOM 节点数上界**：`(可视区行数 + 2 × 缓冲行数) × 列数` 张卡片，
 * 与 `items.length`（乃至 `total`）**无关**——
 * 实测曲库 34,071 张专辑也不会铺出 34,071 个节点。
 *
 * 行高与可视区高度**可注入**（控制器追加要求 K），
 * 默认值走 `getBoundingClientRect()`（量不到时用兜底常量）。
 */
export function CardGrid<T>(props: CardGridProps<T>): ReactElement {
  const {
    items,
    keyOf,
    renderItem,
    columns: columnsProp,
    rowHeight = CARD_GRID_ROW_HEIGHT,
    viewportHeight: viewportHeightProp,
    bufferRows = CARD_GRID_BUFFER_ROWS,
    hasMore = false,
    loading = false,
    onLoadMore,
    emptyLabel = '暂无内容',
    ariaLabel = '卡片列表',
  } = props

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [measured, setMeasured] = useState({ width: 0, height: 0 })

  // 量容器尺寸（浏览器里用 ResizeObserver；jsdom 里量不到 → 用兜底常量）。
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      const width = rect?.width ?? 0
      const height = rect?.height ?? 0
      setMeasured((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const viewportHeight =
    viewportHeightProp ?? (measured.height > 0 ? measured.height : CARD_GRID_FALLBACK_VIEWPORT_HEIGHT)
  const columns =
    columnsProp ??
    (measured.width > 0
      ? Math.max(1, Math.floor(measured.width / CARD_GRID_MIN_COLUMN_WIDTH))
      : CARD_GRID_FALLBACK_COLUMNS)

  const rowCount = Math.ceil(items.length / columns)
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight))
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight))
  const startRow = Math.max(0, firstRow - bufferRows)
  const endRow = Math.min(rowCount, firstRow + visibleRows + bufferRows)
  const startIndex = startRow * columns
  const endIndex = Math.min(items.length, endRow * columns)

  const visibleItems = useMemo(
    () => items.slice(startIndex, endIndex),
    [items, startIndex, endIndex],
  )

  const requestMore = useCallback((): void => {
    if (!onLoadMore || !hasMore || loading) return
    onLoadMore()
  }, [hasMore, loading, onLoadMore])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>): void => {
      const top = event.currentTarget.scrollTop
      setScrollTop(top)
      if (!onLoadMore || !hasMore || loading) return
      const contentHeight = rowCount * rowHeight
      if (top + viewportHeight >= contentHeight - rowHeight) onLoadMore()
    },
    [hasMore, loading, onLoadMore, rowCount, rowHeight, viewportHeight],
  )

  // 内容还填不满可视区时自动续一页（否则用户没有滚动条可滚，永远加载不到下一页）。
  useEffect(() => {
    if (!hasMore || loading) return
    if (items.length === 0) return
    const contentHeight = rowCount * rowHeight
    if (contentHeight <= viewportHeight + rowHeight) requestMore()
  }, [items.length, rowCount, hasMore, loading, requestMore, rowHeight, viewportHeight])

  return (
    <div
      className="fnm-cardgrid"
      role="list"
      aria-label={ariaLabel}
      ref={viewportRef}
      data-scroll-top={scrollTop}
      onScroll={handleScroll}
      style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
    >
      {items.length === 0 ? (
        loading ? null : (
          <p className="fnm-cardgrid__empty" style={EMPTY}>
            {emptyLabel}
          </p>
        )
      ) : (
        <div
          className="fnm-cardgrid__canvas"
          style={{ position: 'relative', height: rowCount * rowHeight }}
        >
          {visibleItems.map((item, offset) => {
            const index = startIndex + offset
            const column = index % columns
            const row = Math.floor(index / columns)
            return (
              <div
                key={keyOf(item, index)}
                className="fnm-cardgrid__cell"
                role="listitem"
                data-index={index}
                style={{
                  position: 'absolute',
                  top: row * rowHeight,
                  left: `calc(${(column * 100) / columns}% / ${columns})`,
                  width: `calc(100% / ${columns})`,
                  height: rowHeight,
                  padding: '8px',
                  boxSizing: 'border-box',
                }}
              >
                {renderItem(item, index)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 页面外壳
//
// ⚠️ 为什么页面外壳放在这里：本任务的「拥有文件」清单里只有
//    `Cards.tsx` / `SongList.tsx` / `coverUrl.ts` 三个组件文件，
//    没有单独的「页面外壳」文件。六个曲库页面共用同一套外壳，
//    放在这里比在六个页面里各抄一遍样式好。
// ---------------------------------------------------------------------------

/** 页面根容器。 */
const PAGE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  height: '100%',
  gap: '8px',
  padding: '12px 16px',
  color: 'var(--text-primary)',
}

/** 页面头部。 */
const PAGE_HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '12px',
  flex: '0 0 auto',
}

/** 页面标题。 */
const PAGE_TITLE: CSSProperties = {
  margin: 0,
  fontSize: '18px',
  fontWeight: 600,
  color: 'var(--text-primary)',
}

/** 页面状态文案。 */
const PAGE_STATUS: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  color: 'var(--text-secondary)',
}

/** 页面错误文案。 */
const PAGE_ERROR: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  border: '1px solid var(--danger)',
  borderRadius: '8px',
  background: 'var(--danger-surface)',
  color: 'var(--danger)',
  fontSize: '13px',
}

/** `LibraryPageShell` 的属性。 */
export interface LibraryPageShellProps {
  /** 页面标题。 */
  title: string
  /** 右上角状态文案（例如「已加载 200 / 173,669」）。 */
  status?: string
  /** 错误信息（有则显示一条错误条）。 */
  error?: string | null
  /** 是否正在加载。 */
  loading?: boolean
  /** 加载中的提示文案。 */
  loadingText: string
  /** 主体。 */
  children: ReactNode
}

/**
 * 曲库页面的外壳。
 *
 * 统一给出**加载中 / 加载失败 / 空列表**三种状态的可读呈现——
 * 三种状态都不该是白屏（控制器追加要求 M）。
 */
export function LibraryPageShell(props: LibraryPageShellProps): ReactElement {
  const { title, status, error, loading = false, loadingText, children } = props
  return (
    <section className="fnm-page" style={PAGE}>
      <header className="fnm-page__header" style={PAGE_HEADER}>
        <h1 className="fnm-page__title" style={PAGE_TITLE}>
          {title}
        </h1>
        {status && (
          <p className="fnm-page__status" style={PAGE_STATUS}>
            {status}
          </p>
        )}
      </header>

      {error && (
        <p className="fnm-page__error" role="alert" style={PAGE_ERROR}>
          {`加载失败：${error}`}
        </p>
      )}

      {loading && (
        <p className="fnm-page__loading" role="status" style={PAGE_STATUS}>
          {loadingText}
        </p>
      )}

      {children}
    </section>
  )
}
