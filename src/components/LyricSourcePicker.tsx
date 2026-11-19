// ---------------------------------------------------------------------------
// T107：「按歌指定歌词源」的**控件**（全屏播放页的歌词区）
// ---------------------------------------------------------------------------
//
// 用户痛点：「有歌词匹配不准确的，应该可以**手动选择歌词**」
// ⇒ 这里给一排**源按钮**：点一下 ⇒ **只影响这一首歌**。
//
// ⚠️ **为什么是「按钮」而不是 `<select>`**：
// - 源只有 6～7 个 ⇒ 一排按钮**一眼看全**，不用点开菜单再找；
// - 每个按钮的**可访问名就是源名** ⇒ 自动化测试能精确选中（不靠位置）。
//
// ⚠️ **如实显示**（T73 既有口径）：按钮高亮的是「**用户指定的**源」，
//    而界面另有一行显示「**实际命中的**源」—— 两者可能不同（链会兜底），
//    **不许**把两者混成一个。
//
// ---------------------------------------------------------------------------

import type { ReactElement } from 'react'

import type { LyricSource } from '../../shared/lyricProvider'

/**
 * 线上源的**可读名字**（T73 口径；T107 把它搬到这里，**全屏页与本控件共用**）。
 */
export const LYRIC_SOURCE_LABEL: Record<LyricSource, string> = {
  netease: '网易云音乐',
  lrclib: 'lrclib.net',
  qq: 'QQ 音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  custom: '自定义 API',
  off: '不用外部',
}

/**
 * 可以**按歌指定**的源。
 *
 * ⚠️ **不含 `off`**（不用外部）—— 那是**全局**档位（设置里），
 *    「按歌指定」的语义是「**换一个更准的源**」。
 */
export const PICKABLE_LYRIC_SOURCES: readonly LyricSource[] = [
  'netease',
  'lrclib',
  'qq',
  'kugou',
  'kuwo',
  'migu',
  'custom',
]

/** 控件的属性。 */
export interface LyricSourcePickerProps {
  /** 这首歌的指定源（`null` = 自动）。 */
  value: LyricSource | null
  /** 选一个源。 */
  onPick: (source: LyricSource) => void
  /** 「恢复自动」。 */
  onRestore: () => void
  /** 写回失败时的提示（`null` = 没有）。 */
  error?: string | null
  /**
   * 「自定义 API」能不能用（**没配模板时选它也没用** ⇒ 不给这个按钮）。
   */
  customAvailable?: boolean
}

/**
 * 「按歌指定歌词源」的控件。
 *
 * ⚠️ **不自己取数**：指定从哪来、怎么写回去，由调用方（store）负责 ——
 *    本组件只负责**显示与上报意图**。
 */
export function LyricSourcePicker(props: LyricSourcePickerProps): ReactElement {
  const { value, onPick, onRestore, error, customAvailable } = props
  const sources = PICKABLE_LYRIC_SOURCES.filter(
    (source) => source !== 'custom' || customAvailable !== false,
  )

  return (
    <div className="sanlos-lyric-source">
      <p className="sanlos-lyric-source__hint">歌词不准确？指定一个源（只影响这一首歌）</p>
      <div className="sanlos-lyric-source__row">
        {sources.map((source) => (
          <button
            key={source}
            type="button"
            className={`sanlos-lyric-source__btn${value === source ? ' sanlos-lyric-source__btn--active' : ''}`}
            aria-pressed={value === source}
            onClick={() => onPick(source)}
          >
            {LYRIC_SOURCE_LABEL[source]}
          </button>
        ))}
        {/* ⚠️ 「恢复自动」**只在有指定时出现**（没有指定时点它毫无意义）。 */}
        {value ? (
          <button type="button" className="sanlos-lyric-source__btn sanlos-lyric-source__btn--reset" onClick={onRestore}>
            恢复自动
          </button>
        ) : null}
      </div>
      {/* ⚠️ 写回失败要**看得见**（不许静默假装成功）。 */}
      {error ? <p className="sanlos-lyric-source__error">{error}</p> : null}
    </div>
  )
}
