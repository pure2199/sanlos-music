# T45–T47 设计规格：灵动态词岛（Lyricify Fusion 风格）

- 日期：2026-11-05
- 状态：**已获用户批准**（用户提问：「悬浮歌词能不能做成 Lyricify Fusion 的灵动歌词一样？」）
- 用户拍板：**与经典悬浮窗并存 + 设置里二选一** / **这一版一起做频谱** / **顶部居中固定、跨显示器跟随**
- 前置：T10（桌面悬浮歌词窗）、T26（逐字 LRC）、T31（全屏歌词舞台）

---

## 1. 参照物：Lyricify Fusion 的「灵动词岛」

Lyricify Fusion（原 Lyricify Lite）是基于 SMTC 的 Windows 桌面歌词工具，提供四种展示形态：
**灵动词岛** / 经典桌面悬浮歌词 / 任务栏歌词 / 全屏歌词舞台。

用户要的是**灵动词岛**：屏幕**顶部居中**一个圆角胶囊，显示当前歌词（逐字高亮），
两侧可放曲名 / 歌手，胶囊两端常驻频谱波形；另有「单词发光」动效、「鼠标进入隐藏」。

⚠️ 本项目**不**需要 SMTC（我们是自己播放器，歌词与进度本来就在主进程里），
**不**需要多源歌词检索（NAS + 外部源已实现）→ 只做**形态与动效**这一层。

---

## 2. 探针结论（`release/verify/t45-spectrum-probe.js`，Electron 32.3.3 实测）

### 2.1 频谱取数：**有一条不动现有音频链的路**

| 路径 | 实测结果 | 副作用 |
| --- | --- | --- |
| **`captureStream()` → `createMediaStreamSource` → `AnalyserNode`** | `capturePeak = 255`、128 bins、`ctxState = "running"` | ✅ **不劫持 `<audio>` 的输出路径**（Analyser 不连 destination） |
| `createMediaElementSource` → `AnalyserNode`（对照） | `mediaElementPeak = 246` | ❌ 音频改道 Web Audio |

⚠️ **为什么必须用第一条**：项目的 Web Audio 图**只在开 EQ 时才建**
（`src/player/engine.ts` 的 `ensureAudioChain`）。若为了频谱去
`createMediaElementSource`，就会**劫持 `<audio>` 的输出**（音频改道 Web Audio）
→ 重采样 / 延迟 / 甚至无声 → **影响所有用户**（哪怕他们没开 EQ、没开词岛）。

⇒ `captureStream()` 路线**与 EQ 链完全解耦**：EQ 关闭时词岛照样有频谱，
且**不碰**现有音频输出路径。

### 2.2 探针本身踩的坑（记下来，别重犯）

- ⚠️ **`about:blank` 页面里 `file://` 媒体加载失败** → `NotSupportedError` → 测到全 0
  （**假阴性**：会误判「captureStream 不可用」）。⇒ 改用 **data: URL 内联 WAV** 才测通。
- ⚠️ Electron 是 **GUI 程序** → `console.log` **不回传**控制台 ⇒ 探针必须
  **把结果写文件**再读。

---

## 3. 方案对比与选型

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A（选定）** | **新增独立「词岛窗口」**，与经典悬浮窗并存，设置里二选一 | ✅ 两种窗口的定位/尺寸/穿透/置顶语义完全不同 → 必须分开 |
| B | 同一个 `BrowserWindow` 切两套布局 | ❌ 一个窗口要同时满足「自由拖动的方框」与「顶部居中的扁胶囊」→ 脆、难测 |
| C | 词岛做在主窗口顶部 | ❌ 只在主窗口可见时存在 → 桌面播放时就没了，不满足「桌面灵动」 |

**代价**：多一个渲染进程（约 30–50MB）。接受。

---

## 4. 任务切分（按用户「一次一个编号任务」的规矩）

| 任务 | 范围 | 状态 |
| --- | --- | --- |
| **T45** | **词岛骨架**：顶部居中锚定 + 胶囊形态 + 设置里样式二选一（经典窗**一字未变**） | 本规格的详细设计在第 5 节 |
| **T46** | 词岛内容与动效：逐字发光 + 曲名/歌手 + 鼠标进入隐藏 | 第 7 节 |
| **T47** | 频谱波形：`captureStream` + Analyser + 限频 IPC + 词岛波形柱 | 第 8 节 |

每个任务 **2 个 commit**（规格 + 实现）；既有测试一条不许删、断言一条不许削弱。

---

## 5. T45 详细设计：词岛骨架 + 样式二选一

### 5.1 偏好模型

`shared/playerBridge.ts` 的 `AppPrefs.lyricOverlay` 加一个字段：

```ts
export type LyricOverlayMode = 'classic' | 'island'

lyricOverlay?: {
  visible: boolean
  /** 缺省 'classic' → 老用户升级后行为一字不变 */
  mode?: LyricOverlayMode
  bounds?: WindowBounds   // 只对 classic 有意义
}
```

- `visible` 仍是**总开关**（「显示桌面歌词」）；`mode` 决定**显示哪一种**。
- `electron/ipc.ts` 的 prefs 归一化：**只认 `'classic'` / `'island'`**，
  其它值一律**丢弃该字段**（落到缺省 `classic`）→ 不写半截进文件。
- `bounds` 只在 `classic` 模式有意义；`island` 的位置由锚定算出，**不落盘**。

### 5.2 锚定计算（**纯函数**，可单测）

新建 `src/ui/lyrics/island-anchor.ts`（**不 import Electron** → 单测不需要 Electron）：

```ts
export interface DisplayLike {
  workArea: { x: number; y: number; width: number; height: number }
}
export function islandBounds(
  display: DisplayLike,
  size: { width: number; height: number },
  margin = 8,
): { x: number; y: number; width: number; height: number }
// x = workArea.x + (workArea.width - width) / 2
// y = workArea.y + margin
```

⚠️ **必须用 `workArea` 而不是 `bounds`**：`bounds` 含任务栏，副屏在任务栏左侧时
`bounds.x` 与 `workArea.x` 不同 → 会算偏。

窗口尺寸常量（`electron/main.ts`）：`ISLAND_WINDOW_WIDTH = 520`、
`ISLAND_WINDOW_HEIGHT = 72`、`ISLAND_TOP_MARGIN = 8`。

### 5.3 显示器跟随

- 取 **主窗口所在显示器**：`screen.getDisplayMatching(mainWindow.getBounds())`
  （不用鼠标位置 → 拖鼠标不会让词岛乱跳）。
- 主窗口 `move` / `resize` → 若岛可见 → **重新锚定**（节流 200ms，避免拖动时狂设 bounds）。
- ⚠️ **不做挖孔（灵动岛）检测**：Chromium 拿不到刘海/挖孔几何
  → 胶囊可能被刘海遮住 → **如实标注为限制**，不假装处理了。

### 5.4 窗口生命周期（主进程 `electron/main.ts`）

`createIslandWindow()` 与既有 `createLyricWindow()` **同构但不同参数**：

| 参数 | classic | island |
| --- | --- | --- |
| 尺寸 | `LYRIC_WINDOW_WIDTH/HEIGHT` | `ISLAND_WINDOW_WIDTH/HEIGHT` |
| 定位 | 用户拖动的 `bounds`（落盘记忆） | `islandBounds()` 算出（**不落盘**） |
| 可拖动 | ✅（标题条 drag 区） | ❌（`resizable: false`，无标题条） |
| 置顶 | `alwaysOnTop('screen-saver')` | 同 |
| 全工作区可见 | ✅ | 同 |

- **主进程是唯一的歌词消息分发者**：现有 `onLyricState` 转发给 `lyricWindow`；
  词岛模式改成转发给 **当前激活的那个**窗口（`activeLyricWindow()`）。
  两种窗口**不会同时显示**（模式互斥）→ 不会重复消费。
- 切换模式时：隐藏旧窗口 → 显示新窗口 → **把缓存的 `lastLyricMessage` 补发给新窗口**
  （既有 `did-finish-load` 机制已有此能力）。
- 总开关 `visible = false` 时：**两个窗口都不显示**（但偏好里的 `mode` 保留）。

### 5.5 IPC 与桥

- 新增通道 **`lyric:set-mode`**（调用式）：参数是 `'classic' | 'island'`，
  形状不对一律按 `'classic'` 处理（与既有 `lyric:set-visible` 的容错风格一致）。
- `shared/playerBridge.ts` 加：`setLyricMode(mode)`、`onLyricMode(handler)`。
- `electron/preload.ts` 暴露这两个方法。

⚠️ **既有断言会被推翻**：`test/tray-tooltip.test.ts` 的
「注册了全部通道」是**通道集合的精确断言** → 新增 `lyric:set-mode` 后必然不成立
→ **改写为新集合断言**（前提被显式推翻的典型场景，须说明）。

### 5.6 渲染层

- 新增 `island.html`（仓库根，与 `lyric.html` 同构）→ `vite.config.ts` 的
  `rollupOptions.input` 加 `island` 入口。
- 新增 `src/island/main.tsx`：**复用**既有 `src/lyric/main.tsx` 的订阅 + 60fps 外推逻辑
  （`mergeLyricMessage` / `extrapolatePosition`），但**布局**换成胶囊。
  ⇒ 数据流与既有悬浮窗**同一条**，T45 顺带证明「词岛拿得到歌词」。
- 新增 `src/island/island-window.css`：页面骨架（`background: transparent`）+
  胶囊外观（圆角、半透明底、模糊）。

⚠️ **T45 不做**：逐字发光动效（T46）、频谱（T47）、鼠标进入隐藏（T46）。

**T45 的词岛显示什么（写死，避免歧义）**：胶囊内 = **曲名 + 歌手（标题行）**
+ **双行逐字歌词**（直接复用既有 `LyricView`，**不加**发光动效）。
即「形态换了、内容通路打通了」，视觉打磨留给 T46。

### 5.7 设置页

「设置 → 歌词」里加一个**二选一**（经典悬浮 / 灵动词岛）：
- 用**两个 radio**（不是 `select`：只有两个选项、radio 一眼可见，
  也避开 Electron 原生下拉在暗色主题下的观感问题），**同一组 `name`**，
  每个 radio 带**显式 `aria-label`**（既有教训：`<label>` 包控件会带出额外文字，
  测试里 `getByRole` 要精确匹配）。
- 切换时立刻生效（主进程换窗口）→ 设置页改完立刻能看到形态变化。
- 若总开关是关的，切换只改偏好，**不弹窗**。

### 5.8 数据流（T45）

```
主窗口渲染进程                 主进程                     词岛渲染进程
  pushLyricState ──IPC──▶  lastLyricMessage ──IPC──▶  mergeLyricMessage
                            （只转发）                    + extrapolatePosition
                                                          → LyricView（双行逐字）
```

### 5.9 错误处理

| 情况 | 行为 |
| --- | --- |
| 词岛页面加载失败 | 主进程 `console.error` 记日志（与既有悬浮窗一致），**不弹窗** |
| `lyric:set-mode` 参数非法 | 按 `'classic'` 处理（不抛） |
| `prefs.json` 里 `mode` 是乱值 | 归一化时**丢弃该字段** → 落回 `classic` |
| 主窗口已销毁 | 锚定重算跳过（不崩） |

### 5.10 影响文件清单（T45）

**新增**
| 文件 | 内容 |
| --- | --- |
| `island.html` | 词岛渲染入口（与 `lyric.html` 同构） |
| `src/island/main.tsx` | 词岛渲染进程入口 |
| `src/island/island-window.css` | 页面骨架 + 胶囊样式 |
| `src/ui/lyrics/island-anchor.ts` | 锚定计算（纯函数） |
| `test/lyric-island-anchor.test.ts` | 锚定计算单测 |

**改**
| 文件 | 改动 |
| --- | --- |
| `shared/playerBridge.ts` | `LyricOverlayMode` 类型 + `lyricOverlay.mode?` + 桥方法 |
| `electron/preload.ts` | 暴露 `setLyricMode` / `onLyricMode` |
| `electron/ipc.ts` | prefs 归一化加 `mode`；新增 `lyric:set-mode` 通道 |
| `electron/main.ts` | 词岛窗口创建 / 锚定 / 模式切换 / 消息分发 |
| `src/state/appPrefsStore.ts` | `lyricOverlayMode` 状态 + setter |
| `src/components/SettingsPanel.tsx` | 样式二选一 |
| `vite.config.ts` | 新增 `island` 入口 |
| `test/tray-tooltip.test.ts` | **改写**通道集合断言（前提被推翻） |
| `test/settings-page.test.tsx` | 新增样式二选一断言 |
| `README.md` / `docs/changelog.md` / `docs/calibration.md` | 文档同步 |

### 5.11 验收点（T45）

1. `tsc --noEmit` exit **0**；
2. `vitest` 全绿且总数 **≥ 1700**（基线 1697；新增 ≥3：锚定计算 ≥2 条
   + 设置页样式切换 ≥1 条；通道集合断言是**改写**不是新增）；
3. `playwright` 既有 **24 条**全绿（本任务不改播放流程 → 不新增 E2E）；
4. **变异自证**（先红后复原，哈希回基线）≥ 3 处：
   - 锚定算错（改成左上角）→ 锚定单测**红**；
   - `mode` 归一化不认 `'island'` → 偏好单测**红**；
   - 模式切换不换窗口 → 切换断言**红**；
5. **经典悬浮窗行为一字未变**（既有 `test/lyric-overlay.test.tsx` 一条没红）；
6. U+FFFD 0、无 BOM、行尾保持原样（`docs/calibration.md` 仍 CRLF）；
7. 真机：设置里切到「灵动词岛」→ 屏幕顶部出现胶囊；切回 → 经典悬浮窗原样恢复。

---

## 6. 通用约束（T45–T47 共同）

- **不引新 npm 依赖**（频谱用浏览器原生 Web Audio；动效用 CSS）。
- **既有测试一条不许删、断言一条不许削弱**；前提被显式推翻的 → **改写为新行为断言并说明**。
- 渲染层**永远不碰 token**；唯一出网走主进程代理（频谱是本地音频分析，**不出网**）。
- 词岛是**纯显示**窗口：不碰音频、不双解码（与既有悬浮窗同一原则）。

---

## 7. T46 概览（词岛内容与动效）

- 逐字发光：复用 `findActiveWord` 定位当前字 → 当前字加发光样式
  （`drop-shadow` + 轻微 scale），CSS 动画；**不逐帧改 DOM 结构**。
- 内容布局：`曲名 │ 逐字歌词 │ 歌手`（左右两侧可留空）。
- 鼠标进入隐藏：透明窗口能收 `mousemove` → 鼠标进入词岛区域时整体淡出。
- ⚠️ 窗口**不穿透鼠标**（要能点、能隐藏）→ 词岛区域会挡一点屏幕 → 位置在顶部，遮挡面积极小。

---

## 8. T47 概览（频谱波形）

- 主窗口：`<audio>.captureStream()` → **独立** `AudioContext` → `AnalyserNode`
  → 每 **24fps** 取 **16 个对数分布 bin**（80Hz–8kHz）→ IPC `lyric:spectrum`。
- ⚠️ **只在词岛可见时采样**；窗口隐藏立刻停 → 不给「顿卡」添新堵点。
- ⚠️ Analyser 的 `AudioContext` **不连 destination**（探针已验证 `ctxState = "running"`）。
- 主进程只转发（与 `lyric:state` 同一风格）；词岛窗渲染波形柱（纯 CSS 高度）。

---

## 9. 风险与待校准

- ⚠️ **挖孔屏遮挡**：Chromium 拿不到刘海/挖孔几何 → 胶囊可能被遮 → **已知限制**。
- ⚠️ **多显示器**：词岛跟随**主窗口**所在屏（不是鼠标）→ 用户把主窗口拖到副屏，词岛才过去。
- ⚠️ **`captureStream` 在某些 Electron/Chromium 版本可能不可用** → T47 必须**降级**：
  词岛照常显示歌词，只是**没有频谱**，**不能崩**。
- ⚠️ **频谱的音频路径**：已实测不劫持输出，但**真机听感**仍要用户复验（音质/延迟）。
- ⚠️ **窗口置于全屏游戏之上**：`alwaysOnTop('screen-saver')` 会压在全屏应用上
  （既有悬浮窗已是此行为）→ 词岛沿用；是否需要「全屏时自动隐藏」留待用户定。
- ⚠️ **词岛默认关闭还是开启**：默认沿用 `classic`（老用户行为不变）；
  想让新形态「更显眼」需用户在设置里切。
