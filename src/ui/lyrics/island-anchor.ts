// ---------------------------------------------------------------------------
// T45：灵动态词岛的**锚定计算** —— 渲染层侧的转发
// ---------------------------------------------------------------------------
//
// ⚠️ **实现在 `shared/islandAnchor.ts`**（渲染层与主进程共用一份）。
//    本文件只是转发。
//
// ⚠️ 为什么不直接把实现放这儿：主进程（`electron/main.ts`）也要用它算
//    窗口位置，而 `electron/` **不该反向依赖 `src/`**（层次反了）
//    → 归属层只能是 `shared/`。
// ---------------------------------------------------------------------------

export {
  islandBounds,
  isPointInsideRect,
  ISLAND_TOP_MARGIN,
  ISLAND_WINDOW_HEIGHT,
  ISLAND_WINDOW_WIDTH,
  type IslandBounds,
  type IslandDisplayLike,
  type IslandSize,
  type PointLike,
} from '../../../shared/islandAnchor'
