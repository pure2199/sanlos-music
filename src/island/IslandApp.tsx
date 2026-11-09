// ---------------------------------------------------------------------------
// 灵动态词岛的**根组件**（T46 从入口里拆出来）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么拆出来**：`src/island/main.tsx` 是**渲染入口**（直接 `createRoot`）
//    → 测试没法 import 它。拆成「组件 + 入口」后，
//    「指针进入 → 淡出」这条链路才能被单测覆盖（T46）。
//
// ⚠️ 本组件**只负责显示**：不碰音频、不出网、不接触任何凭证。

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import type { PlayerBridge } from '../../shared/playerBridge'
import { SPECTRUM_BIN_COUNT } from '../../shared/spectrum'
import { useAppPrefsStore } from '../state/appPrefsStore'
import { LyricView } from '../ui/lyrics/LyricView'
import { extrapolatePosition } from '../ui/lyrics/overlayClock'
import { emptyOverlayState, mergeLyricMessage } from '../ui/lyrics/overlayState'
import { SpectrumBars } from './SpectrumBars'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览里为 `null`）。 */
export function islandBridge(): PlayerBridge | null {
  const scope = globalThis as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 位置更新的最小步长（秒）：小于它就不重渲染（省掉无意义的 60fps 重绘）。 */
const POSITION_EPSILON = 0.03

/** 还没有频谱时的占位（全 0 → 柱子是最小高度的小点）。 */
const EMPTY_BINS: number[] = new Array<number>(SPECTRUM_BIN_COUNT).fill(0)

/** 词岛的根组件。 */
export function IslandApp(): ReactElement {
  const [state, setState] = useState(emptyOverlayState)
  const [position, setPosition] = useState(0)
  /**
   * 指针是否落在词岛上（T46）。
   *
   * ⚠️ 词岛是**点击穿透**的（不挡屏幕顶部的应用）→ 忽略鼠标事件后
   *    渲染进程收不到「鼠标离开」→ 由**主进程轮询**指针位置通知到这里。
   */
  const [pointerInside, setPointerInside] = useState(false)
  /**
   * 频谱数据（T47）：一条 **16 段**的频谱（0–255）。
   *
   * ⚠️ **主窗口渲染进程**取数 → 主进程转发 → 这里收到（~24fps）。
   */
  const [bins, setBins] = useState<number[]>(EMPTY_BINS)

  /** 最近一次进度采样（本地外推的基准；放在 ref 里避免每帧重建闭包）。 */
  const sampleRef = useRef(state.sample)
  /** 当前已渲染的位置（用来判断要不要重绘）。 */
  const positionRef = useRef(0)

  // --- 订阅主进程转发的歌词消息 --------------------------------------------
  useEffect(() => {
    const player = islandBridge()
    if (!player) return undefined
    return player.onLyricState((message) => {
      const now = Date.now()
      setState((prev) => {
        const next = mergeLyricMessage(prev, message, now)
        sampleRef.current = next.sample
        return next
      })
    })
  }, [])

  // --- 本地插值：按经过时间外推当前位置 ------------------------------------
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined
    let frame = 0
    const tick = (): void => {
      const next = extrapolatePosition(sampleRef.current, Date.now())
      if (Math.abs(next - positionRef.current) >= POSITION_EPSILON) {
        positionRef.current = next
        setPosition(next)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [])

  // --- 主题：读回主进程 `prefs.json` 的主题并应用 ----------------------------
  useEffect(() => {
    void useAppPrefsStore.getState().load()
  }, [])

  // --- T46：指针进入词岛 → 淡出；离开 → 淡回 -------------------------------
  useEffect(() => {
    const player = islandBridge()
    if (!player) return undefined
    return player.onLyricPointer((inside) => setPointerInside(inside))
  }, [])

  // --- T47：订阅频谱（~24fps；主窗口取数 → 主进程转发）---------------------
  useEffect(() => {
    const player = islandBridge()
    if (!player) return undefined
    return player.onSpectrum((next) => setBins(next))
  }, [])

  /**
   * 左端 8 根 = 频谱的**逆序**（高频 → 低频，DOM 顺序 = 由外缘向内）。
   *
   * ⚠️ **右组是左组的镜像** ⇒ 整条胶囊「高频 → 低频 | 低频 → 高频」，
   *    **左右永远对称**（真机截图证实：若左右显示不同频段，
   *    高频段能量天然偏低 → 右边几乎是空的 → 整条胶囊不对称）。
   * ⚠️ **必须用 `useMemo`**：根组件的进度插值是 60fps 重渲染的，
   *    而频谱只有 24fps → 数组引用不变，`memo` 出来的波形柱才不会白重画。
   */
  const leftBins = useMemo(() => bins.slice().reverse(), [bins])
  /**
   * 右端 8 根 = 频谱的**原序**（低频 → 高频，DOM 顺序 = 由内向外）。
   *
   * ⚠️ 与左端**互为镜像**（左端是逆序）。
   */
  const rightBins = useMemo(() => bins, [bins])

  const track = state.track
  const title = track?.title ?? ''
  const artist = track?.artist ?? ''

  return (
    <div
      className={`fnm-island${pointerInside ? ' fnm-island--pointer-inside' : ''}`}
      data-testid="fnm-island"
      data-pointer-inside={pointerInside ? 'true' : 'false'}
    >
      {/* ⚠️ T47：左端的频谱柱（**逆序**：高频 → 低频）。 */}
      <SpectrumBars side="left" values={leftBins} />
      <div className="fnm-island__meta">
        <span className="fnm-island__title">{title}</span>
        <span className="fnm-island__artist">{artist}</span>
      </div>
      <div className="fnm-island__lyrics">
        {/* ⚠️ **不给 `onSeek`**：词岛是**点击穿透**的（不挡屏幕顶部的应用）
            → 点了词岛也是点下面的应用 → 词岛**不做**点歌跳转（经典悬浮窗仍有）。 */}
        {/* ⚠️ **只显示当前一行**（T46 补丁）：`single` + `windowRadius={0}`。
            - `single` 本身是**窗口裁剪**（默认半径 3 → 渲染当前行上下共 7 行），
              半径压到 **0** 才是真·一行；
            - `single` 的当前行**照常逐字推进**（`progress: isActive ? computeLineProgress(...) : null`）
              → T48 的**卡拉OK 渐进填色**不受影响；
            - 经典悬浮窗**仍是 `double`** → 主界面 / 歌词舞台行为一字不变。 */}
        {/* ⚠️ T48：`karaoke` —— 当前词**不再**整词发光，而是**词内渐进填色**
            （整词跳变 → 每个词边界都闪一下 → 不顺滑）。
            ⚠️ 填色的**数据源**是现成的 `LyricWordProgress.wordProgress`（词内连续比例）。
            ⚠️ `activeWordClassName`（整词发光钩子）**保留不动**（通用钩子），
                但词岛**不再**用它 —— 发光与填色同时存在会让「填色边界」被光晕糊掉。 */}
        {/* ⚠️ T71：卡拉OK 已从「词岛专属」提升为「歌词视图的**默认观感**」
            ⇒ 这里的 `karaoke` 与**缺省**同值（显式写出来是为了让参考实现一眼可见）；
            经典悬浮窗 / 全屏歌词舞台**同样**是卡拉OK。 */}
        <LyricView
          lines={state.lines}
          currentTime={position}
          mode="single"
          windowRadius={0}
          emptyLabel="暂无歌词"
          karaoke
        />
      </div>
      {/* ⚠️ T47：右端的频谱柱（**原序**：低频 → 高频；与左端互为镜像）。 */}
      <SpectrumBars side="right" values={rightBins} />
    </div>
  )
}
