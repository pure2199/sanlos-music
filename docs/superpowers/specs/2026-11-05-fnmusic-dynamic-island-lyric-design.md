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
| **T47** | 频谱波形：Analyser + 限频 IPC + 词岛**两端各 8 根镜像**波形柱 | 第 8 节（**取数路线已按探针修正**，见 8.1 / 8.2） |

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

## 7. T46 详细设计（词岛内容与动效）

### 7.1 探针先行（`release/verify/t46-mouse-probe.js`，Electron 32.3.3 实测）

词岛贴在**屏幕顶部** → 如果它吃掉鼠标事件，最大化应用的**标题栏中央就点不到**
→ 必须「点击穿透」。但「鼠标进入隐藏」又要求能知道鼠标移没移进来。

| 探针结果 | 含义 |
| --- | --- |
| `setIgnoreMouseEvents(true, { forward: true })` 后仍收到 **131 次 mousemove** | ✅ **点击可穿透** + 仍能感知鼠标 |
| `movesInsideWindow: 131`，`clientX 258→244`（窗口 x=1020，屏幕 1280 → 258 恰好对上） | ✅ 坐标能定位指针是否在词岛上 |
| ⚠️ 指针**移出后 0 个事件** | ⚠️ 渲染进程**收不到「离开」** → 恢复**不能**靠渲染层 |

⇒ 「移出后恢复显示」只能由**主进程轮询**指针位置（`screen.getCursorScreenPoint()`）。

### 7.2 关键决定

| 决定 | 理由 |
| --- | --- |
| 词岛开 `setIgnoreMouseEvents(true, { forward: true })` | 它在屏幕顶部，不穿透就**挡住**下面的应用 |
| 主进程 **10Hz 轮询**指针位置，变化时 `webContents.send('lyric:pointer', inside)` | 渲染进程收不到「离开」→ 恢复只能靠轮询 |
| ⚠️ **不新增 ipcMain 通道** | `lyric:pointer` 走 `webContents.send`（与 `lyric:state` 同款）→ **不动**既有的通道集合断言 |
| `LyricView` 加**可选** prop `activeWordClassName` | 缺省 = **不加任何类名** → 主界面歌词 / 全屏歌词舞台 / 经典悬浮窗的行为**一字不变** |
| 只给**正在被唱的那一个词**加钩子；该行已走满 → **不加** | 已走满 = 整行都是唱过的状态，没有「当前」可言 |
| 发光**只用 `text-shadow`** | 逐字着色层（overlay）与底层整行文本必须**字形严丝合缝** → `transform: scale` / 字重都会让两层**错位** |
| 淡出**只降不透明度**，不用 `display:none` / `visibility:hidden` | 状态由主进程轮询驱动，与渲染层自身无关 |
| 组件从入口里**拆出来**（`IslandApp.tsx`） | `main.tsx` 直接 `createRoot` → 测试没法 import；拆开后「指针进入 → 淡出」才**能测** |
| ⚠️ **词岛不再响应点击**（去掉 `onSeek`） | 物理上不可能兼得：穿透 = 点击落到**下面的应用** → 词岛点不到。**点歌跳转仍在经典悬浮窗**（Lyricify 的词岛同样不可点） |

### 7.3 影响文件

- **新增**：`src/island/IslandApp.tsx`（词岛根组件）、`test/lyric-island-pointer.test.ts`、
  `test/lyric-island-app.test.tsx`
- **改**：`shared/islandAnchor.ts`（+ `isPointInsideRect` 纯函数）、`shared/playerBridge.ts`
  （+ `onLyricPointer`）、`electron/preload.ts`（暴露桥方法）、`electron/main.ts`
  （穿透 + 指针轮询）、`src/ui/lyrics/LyricView.tsx`（+ 可选 prop `activeWordClassName`）、
  `src/island/main.tsx`（瘦身为入口）、`src/island/island-window.css`（发光 + 淡出）、
  `test/lyric-view.test.tsx`（新增 3 条）、`test/media-session.test.ts`（假桥补空实现）

### 7.4 验收点

1. `tsc --noEmit` exit **0**；
2. `vitest` 全绿且 **≥ 1726**（基线 1713 + 新增 13）；
3. `playwright` 既有 **24 条**全绿；
4. **变异自证** ≥ 4 处（先红后复原，哈希回基线）；
5. **复原校验**：变异跑一轮 apply+revert 后文件 sha256 与基线**完全一致**；
6. U+FFFD 0、无 BOM、行尾保持原样；
7. 真机：指针移到词岛上淡出、移开淡回、**点击真的穿透**到下面的应用（**用户复验**）。

### 7.5 已知限制（如实标注）

- ⚠️ **词岛不可点**（点击穿透的代价）→ 点歌跳转只在**经典悬浮窗**有；
- ⚠️ **浅色胶囊**（沿用 `--surface-raised`）：在浅色壁纸上存在感偏弱 → 若用户反馈太淡，
  再给 `tokens.css` 加一组「词岛」专属语义变量（**本轮没做**，避免擅自扩范围）。
- ⚠️ 窗口**不穿透鼠标**（要能点、能隐藏）→ 词岛区域会挡一点屏幕 → 位置在顶部，遮挡面积极小。

### 7.6 T46 补丁：词岛歌词**只显示当前一行**

> 用户反馈：「灵动歌词一行就够」。这是 T46 验收后的**呈现修正**，属 T46 范围内的补丁。

#### 为什么

词岛是**贴在屏幕顶部**的一条窄胶囊（96px 高）→ 双行歌词会把整条胶囊撑满，
当前词被挤在中间，**扫一眼看不出「正在唱哪个词」**。
一行 = 当前行**放大居中**（正是 Lyricify「灵动歌词」的观感）。

#### 实现路径：`mode="single"` + `windowRadius={0}`

| 候选 | 结论 |
| --- | --- |
| `mode="double"`（现状） | ❌ 两行同时在场 → 不满足「一行就够」 |
| `mode="single"`（**缺省**） | ❌ `single` 是**窗口裁剪**，默认半径 `LYRIC_WINDOW_RADIUS = 3` → 渲染当前行上下**共 7 行** |
| `mode="single"` + `windowRadius={0}` | ✅ **只渲染当前行**；且当前行**照常逐字推进**（`progress: isActive ? computeLineProgress(line, time) : null`）→ T46 的**逐字发光**不受影响 |

⚠️ **高度不动**（`ISLAND_WINDOW_HEIGHT = 96`）：当前行 44px，胶囊内容区 76px
→ 滚动定位（`scrollTop = 行位置 + 行高/2 − 可视区/2`）让当前行**正好垂直居中**；
左侧曲名/歌手两行仍占位 → 胶囊不显得空。
⚠️ 改高度会牵动 `shared/islandAnchor.ts` 的常量与锚定单测 → **本轮不做**（等看到真机效果再定）。

⚠️ **经典悬浮窗不动**（仍 `double`）→ 主界面 / 歌词舞台 / 经典悬浮窗的行为**一字不变**。

#### 影响文件

- **改**：`src/island/IslandApp.tsx`（`mode` + `windowRadius`）
- **改**：`test/lyric-island-app.test.tsx`（新增 4 条；假桥补 `emitLyricState`）

#### 验收点

1. 词岛 DOM 里歌词行**恰好 1 个**；
2. 那一行 = **播放位置所在行**（`data-index` 命中）；
3. 当前行**仍带** `fnm-lyricview__word--active`（逐字发光钩子没丢）；
4. 播放位置跨行 → 显示的行跟着换（仍只一行）；
5. 淡出 / 淡回 / 点击穿透 / 曲名歌手 —— **一字不变**；
6. `tsc` 0、`vitest` 全绿（既有测试**一条不许红**）、`playwright` 24、`build` 0；
7. 真机截图：单行居中 + 发光。

#### 补丁②：「一行**居中**」（用户复验后修）

> 用户反馈：「灵动歌词显示不对，应该是一行居中」。这是补丁① 引入的**真缺陷**（不是需求变更）。

**根因（两层，缺一不可）**：

1. **CSS 层**：单行模式下 `LyricView` 的**画布高度 = 整份歌词的总高**（行数 × 34px）→
   歌词区若按内容取高 → 被撑到几千 px → 胶囊（96px）裁剪后露出的是
   「**歌词表的垂直中点**」，而不是当前行；
2. **组件层**：量视口的 `useEffect` 依赖写死 `[]` → 挂载那一刻歌词还是**空的**
   （走**空态分支**，**没有视口节点**）→ effect 拿不到节点就走了 → **歌词到达后不会重跑**
   → `viewportHeight` 永远停在 0 → 居中一律按**兜底高度 400** 算。

⚠️ **双行模式完全不受影响**（滚动位置恒为 0，用不到视口高度）→ 这个缺陷在双行下**看不出来**。

**修法**：

- CSS：`.fnm-island__lyrics { align-self: stretch; }` → 歌词区高度 = 胶囊内容区（≈74px），
  **不跟歌词总高走**；
- 组件：`LyricView` 量视口的 effect 依赖加 `safeLines.length` → 歌词到达后**重新量**。

**验收点**：

1. 真机（**200 行歌词**，真实数据量）：歌词视口高度 = 74px（**不是** 6810px）；
2. 当前行**在视野内**（`insideView = true`）、相对视口**正中**（`viewCenterOffset = 0`）；
3. 相对**胶囊**也正中（`islandCenterOffset = 0`）、落在 96px 胶囊内；
4. **CSS 契约测试**钉住 `align-self: stretch`（jsdom 量不到布局 → 只能钉声明）；
5. **组件单测**钉住「歌词从空到有时会重新量视口」（jsdom 里 mock `getBoundingClientRect` 返回 74px，
   以此区分「量到真实视口」与「还在用兜底 400」）。

---

## 8. T47 详细设计：频谱波形

### 8.1 取数路线的**修正**（规格第 2.1 节的判断依据已过时）

规格第 2.1 节写的是「项目的 Web Audio 图**只在开 EQ 时才建**（`ensureAudioChain`）」，
因此选了 `captureStream()` 路线，理由是「别为了频谱去 `createMediaElementSource`，
那会劫持 `<audio>` 的输出」。

⚠️ **该前提与当前代码不符**：`src/player/engine.ts` 的 `ensureAudioGraph()` 在
**每一次首次播放**时**无条件**建图（`createMediaElementSource` → `gain` → `destination`），
**与 EQ 开没开无关** ⇒ **所有用户的音频本来就走 Web Audio**。

⇒ 复用现有音频图挂 `AnalyserNode` **不新增任何劫持**（不新建 `AudioContext`、
不新建解码路径），而且反映的是 **EQ + 音量之后**的信号 = 用户真正听到的。

### 8.2 探针结论（`release/verify/t47-spectrum-probe.js`，Electron 32.3.3 实测）

| 路线 | 做法 | 实测 |
| --- | --- | --- |
| **A（本方案）** | `source → gain → destination`，**额外** `gain → analyser`（analyser **不连** destination） | `peak = 249`；`stillPlaying = true`（挂 analyser **不影响**音频继续播） |
| B（规格原文） | `captureStream()` → 独立 `AudioContext` → `createMediaStreamSource` → analyser | `peak = 249`，且与路线 A **逐 bin 相同**（**元素被 Web Audio 接管后照样拿得到声音**） |
| C（对照） | `source → analyser`（不连 destination） | `peak = 236` |

- 实测环境：`sampleRate = 48000`、`fftSize = 2048` → `frequencyBinCount = 1024`；
- ⚠️ **T45 探针的 `captureStream` 是在 `createMediaElementSource` 之前测的**；
  T47 探针改成**接管之后**再测 → 结论变了（**没有静音**）。

⇒ 两条路都可用；**选 A**（零新增上下文 / 反映 EQ 后信号 / 不依赖 `captureStream`）。
路线 B 留作「将来 `createMediaElementSource` 不可用」时的备选，**本任务不实现**。

### 8.3 采样

- **24fps**（每 42ms 一帧）读一次 `getByteFrequencyData` → 切成 **16 个对数分布 bin**（80Hz–8kHz，
  每个 bin 取区间**最大值**）→ IPC `lyric:spectrum`（载荷 `number[]`，长度 16，值 0–255）。
- ⚠️ **只在「桌面歌词可见 **且** 形态 = `island`」时采样**；不满足就**完全不采样**
  → 不给「顿卡」添新堵点。
  - 可见性 ← `lyric:visibility` 事件 + 启动时 `getPrefs()` 兜底（与 `lyricOverlay.ts` 同一套路）；
  - 形态 ← 主窗口的 `useAppPrefsStore.lyricOverlayMode`（形态**只在设置页**改 → 那里就是主窗口）。
- 采样源：`PlayerEngine.getAudioNodes()` → `{ context, source, gain, eq, analyser }`。
  - `analyser` 建在 **`gain` 之后**（EQ + 音量之后 = 听到的信号），**不连 destination**；
  - ⚠️ **建 analyser 失败不许影响播放**：老 Chromium / 测试替身没有 `createAnalyser` → `analyser = null`
    → **没有频谱**（词岛照常显示歌词，**不崩**）。

### 8.4 IPC 与桥

- 新增推送通道 **`lyric:spectrum`**（`ipcRenderer.send` → `ipcMain.on` → `webContents.send`）。
  - ⚠️ **主进程只转发**给 `activeLyricWindow()`（与 `lyric:state` 同一风格）；
  - ⚠️ 形状校验（长度 16、每项 0–255 的整数）放在 `shared/spectrum.ts` 的
    `sanitizeSpectrumBins()`，**主进程与 preload 共用一份**；形状不对 → **丢弃**。
- 桥（`shared/playerBridge.ts` + `electron/preload.ts`）：
  - `pushSpectrum(bins: number[])`（**主窗口**渲染进程用）；
  - `onSpectrum(handler: (bins: number[]) => void)`（**词岛**渲染进程用）。

### 8.5 词岛渲染（**两端各 8 根，镜像**）

- 布局：`[左 8 根] [曲名/歌手] [歌词] [右 8 根]`。
- **镜像的定义**：整条频谱 = 16 段（低频 → 高频）；左端显示第 1–8 段、
  右端显示第 9–16 段；**两组都从「外缘向内」按频率递增** ⇒ 左右呈镜像。
  - 左组 DOM 顺序 = `bins[0..7]`；右组 DOM 顺序 = `bins[15..8]`（逆序）。
- 柱子的**高度**：`0` → 4%（留一个可见的小点），`255` → 100%；
  `align-items: center` ⇒ 柱子**从胶囊中线上下对称生长**（Dynamic Island 观感）。
- ⚠️ **纯 CSS 高度**（不引新依赖、不用 canvas）；`transition: height 80ms linear`
  —— 24fps 的数据配 80ms 过渡 → 平滑不抖。
- ⚠️ **经典悬浮窗一字不变**（不显示柱子、不订阅 `lyric:spectrum`）。

### 8.6 影响文件清单

| 文件 | 改动 |
| --- | --- |
| `shared/spectrum.ts`（新） | `SPECTRUM_BIN_COUNT` / `sanitizeSpectrumBins()`（纯逻辑，主进程与 preload 共用） |
| `shared/playerBridge.ts` | `pushSpectrum` / `onSpectrum` |
| `electron/preload.ts` | 暴露两个桥方法 |
| `electron/ipc.ts` | `lyric:spectrum` 通道 + 形状校验 + `onSpectrum` 选项 |
| `electron/main.ts` | 转发给 `activeLyricWindow()` |
| `src/player/engine.ts` | `AnalyserNodeLike` / `createAnalyser?()` / `getAudioNodes().analyser` |
| `src/player/spectrum.ts`（新） | `toLogBins()` + 采样器 + `installSpectrum()` |
| `src/state/playerStore.ts` | 导出引擎实例（采样器取分析节点） |
| `src/main.tsx` | `installSpectrum()` 装配 |
| `src/island/SpectrumBars.tsx`（新） | 波形柱组件 |
| `src/island/IslandApp.tsx` | 接入两端柱子 |
| `src/island/island-window.css` | 柱子样式（只用语义变量） |
| `test/spectrum.test.ts`（新） | bin 映射 / 采样器 / 启停 |
| `test/lyric-island-app.test.tsx` | 柱子渲染断言 |
| `test/lyric-island-css.test.ts` | CSS 契约 |
| `test/tray-tooltip.test.ts` | 通道集合断言**改写** + `lyric:spectrum` 转发用例 |
| `test/media-session.test.ts` | 假桥补两个方法 |

### 8.7 既有断言会被推翻的地方（**改写，不放宽**）

- `test/tray-tooltip.test.ts` 的「注册了全部通道」是**通道集合的精确断言**：
  `listeners` 由 `['lyric:state', 'player:command', 'player:state']` 变成
  `['lyric:spectrum', 'lyric:state', 'player:command', 'player:state']`
  → **改写为新的完整集合**（与 T41 / T45 的处理一致），**不删、不放宽**。

### 8.8 验收点

1. `tsc --noEmit` 0 错；vitest 全绿；playwright 24 绿；build 0；
2. **变异自证 ≥3 处**（采样器不启动 / bin 映射错 / 主进程不转发）→ 全红后复原（sha256 核对）；
3. **真机**：词岛两端柱子随音乐跳动；经典悬浮窗无柱子；关掉桌面歌词 → 采样停；
   Analyser 不可用 → 词岛照常显示歌词；
4. ⚠️ **待用户复验**：挂 analyser **不改变听感**（音量 / 延迟）——探针只验了「还在播」。

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
