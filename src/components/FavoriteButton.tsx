// ---------------------------------------------------------------------------
// 行内收藏按钮（Task 25）
// ---------------------------------------------------------------------------
//
// 一个歌曲行的「收藏 / 取消收藏」入口。
//
// ---------------------------------------------------------------------------
// 为什么要有这个组件
// ---------------------------------------------------------------------------
// Task 16 给**搜索页**做了行内收藏按钮，但那段 JSX 直接写在 `SearchPanel` 里 ——
// 于是**只有搜索页**能收藏：
//
// - 曲库「歌曲」页、收藏页、专辑 / 歌手 / 风格详情页、歌单详情页、最近播放页
//   —— 这些页面的歌曲行**一个收藏入口都没有**；
// - 用户看到的是「收藏页能收藏，但在别的地方收藏不了」这种割裂。
//
// T25 把这个按钮抽成**公共件**，铺到**所有**列歌曲的页面。
//
// ---------------------------------------------------------------------------
// 收藏态从哪来（单一真相源）
// ---------------------------------------------------------------------------
// - **已确认态**：`libraryStore.favoriteStates`（服务端收藏列表载入后登记，
//   写回成功后更新）—— 唯一真相源；
// - **兜底值**：歌曲自带的 `favorite` 字段（服务端 `isFavorite`，
//   **真机已实测该字段存在且可信**）；
// - **乐观态**：写回器（`createFavoriteWriteback`）的 `target`。
//
// 三者的合成顺序见 `rowActions.tsx` 的 `useLibraryRowActions()`。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
// - 样式落在**独立的 CSS 文件**（`favorite-button.css`）—— 仓库约定；
// - 颜色**只用 CSS 语义变量**（`var(--token)`），不出现硬编码色值；
// - **不用内联 style**（伪类只能靠样式表表达）；
// - 状态用属性选择器表达：`[aria-pressed='true']` = 已收藏，
//   `[data-pending='true']` = 写回在途。
//
// ---------------------------------------------------------------------------

import type { MouseEvent, ReactElement } from 'react'

import type { Song } from '../../shared/types'
import './favorite-button.css'

/** `FavoriteButton` 的属性。 */
export interface FavoriteButtonProps {
  /** 这首歌（用来取 id）。 */
  song: Song
  /** 当前是否已收藏（乐观态优先）。 */
  favorite: boolean
  /** 是否正在写回（在途 / 排队中）。 */
  pending?: boolean
  /** 点击回调（切换收藏态）。 */
  onToggle: () => void
  /**
   * 是否可写。
   *
   * ⚠️ 不支持写回的环境（只读）→ 按钮**禁用**（而不是点了报错）。
   */
  disabled?: boolean
  /**
   * 附加类名。
   *
   * ⚠️ 搜索页沿用它自己的样式钩子（`fnm-searchpanel__favorite`），
   *    其余页面用默认的 `fnm-favorite`。
   */
  className?: string
}

/**
 * 行内收藏按钮。
 *
 * ⚠️ 点击**必须阻止冒泡**（行单击是「选中」）；双击同理（双击是「播放」）。
 */
export function FavoriteButton({
  song,
  favorite,
  pending = false,
  onToggle,
  disabled = false,
  className,
}: FavoriteButtonProps): ReactElement {
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    // ⚠️ 别让收藏点击冒泡到行上（行单击是「选中」）。
    event.stopPropagation()
    onToggle()
  }

  const handleDoubleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
  }

  return (
    <button
      type="button"
      className={className ?? 'fnm-favorite'}
      data-testid="fnm-favorite-toggle"
      data-song-id={song.id}
      data-favorite={favorite ? 'true' : 'false'}
      data-pending={pending ? 'true' : 'false'}
      aria-pressed={favorite}
      aria-label={favorite ? '取消收藏' : '收藏'}
      disabled={disabled}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {favorite ? '已收藏' : '收藏'}
    </button>
  )
}
