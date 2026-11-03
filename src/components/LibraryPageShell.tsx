// ---------------------------------------------------------------------------
// 曲库页面外壳（Task 14）
//
// ⚠️ 为什么独立成文件：页面外壳是**页面级**的职责，
//    放在卡片模块（`Cards.tsx`）里不纯——
//    卡片模块只该管「封面 + 卡片 + 网格」，外壳管「标题 / 状态 / 错误 / 主体」。
//    六个曲库页面共用同一套外壳，独立成文件后职责边界更清楚。
//
// ⚠️ 样式住在**同目录**的 `library-page-shell.css`：
//    组件层不许反向 import 页面层（`../pages/…`）的东西——
//    那是页面层的依赖方向，组件只该依赖自己的样式表。
// ---------------------------------------------------------------------------

import type { ReactElement, ReactNode } from 'react'

import './library-page-shell.css'

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
    <section className="fnm-page">
      <header className="fnm-page__header">
        <h1 className="fnm-page__title">{title}</h1>
        {status && <p className="fnm-page__status">{status}</p>}
      </header>

      {error && (
        <p className="fnm-page__error" role="alert">
          {`加载失败：${error}`}
        </p>
      )}

      {loading && (
        <p className="fnm-page__loading" role="status">
          {loadingText}
        </p>
      )}

      {children}
    </section>
  )
}
