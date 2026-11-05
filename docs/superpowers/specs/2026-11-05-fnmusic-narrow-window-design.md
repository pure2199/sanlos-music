# T40 设计规格：窄窗口 UI 适配（窗口最小尺寸 + 顶栏换行）

- 日期：2026-11-05
- 状态：已获用户批准（问卷：范围 = **只做 ①②**）
- 前置：T38（顶栏多了「本地」按钮）、Task 8（窗口位置尺寸记忆）

---

## 1. 背景与动机

T38 给顶栏加了一颗「本地」按钮 → 已登录态顶栏变成 **10 颗按钮**（连接 / 本地 / 搜索 + 曲库 7 颗）。
用户问「加了本地按键之后，整体 UI 大小需要重新适配吗」→ 答：**需要，而且先要把「能缩多窄」的底线定下来**。

### 1.1 现状（实测，非推断）

实测方式：**真实 Electron 进程 + mock NAS**，登录到已登录态后用主进程 `win.setBounds()` 逐档设**外框**宽度，
渲染层量 `scrollWidth` / `clientWidth` / `getBoundingClientRect()`。

| 观测项 | 实测值 |
| --- | --- |
| 外框比内容宽 | **16px**（外框 1400 → 内容 1384） |
| 纵向外框比内容高 | **39px**（外框 800 → 内容 761） |
| 顶栏横向溢出起点 | 外框 **600**（`scrollWidth` 594 > `clientWidth` 567） |
| 品牌名被压扁 | 外框 ≤640 时宽 **15px**、高 **84px**（「飞牛音乐」4 字竖排 4 行） |
| 品牌名自然宽 | **60px**（外框 ≥1000 时不再被挤） |
| 播放条所需宽 | **717px**（`.fnm-playerbar` 的 `scrollWidth` 恒为 717） |
| 文档横向溢出起点 | 外框 **720**（`documentElement.scrollWidth` 717 > `clientWidth`） |
| 播放条高 | **64px** |
| 顶栏高（宽窗口） | **57px** |

⚠️ 文档横向溢出的元凶是**播放条**（717px），**与登录状态、与「本地」按钮完全无关**（T11 老问题）
→ 本轮**不修**（用户拍板 ③ 不做），但**最小宽度必须绕开它**，否则窗口一缩窄就出横向滚动条。

### 1.2 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 范围 | **只做 ①②**：① 窗口最小尺寸；② 顶栏换行 + 品牌名不压扁 |
| ③ 播放条窄屏折叠 | **不做**（T11 老问题，另议） |

---

## 2. 设计

### 2.1 ① 窗口最小尺寸（两层保险）

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 运行时 | `new BrowserWindow({ minWidth, minHeight })` | 用户**拖不到**比下限更小 |
| 建窗时 | `resolveWindowBounds()` 里夹紧 | 旧版本存下来的、**比下限还小**的尺寸，恢复时**直接抬到下限**（不依赖 Chromium 的隐式 clamp） |

⚠️ Electron 的 `width` / `height` 是**外框**尺寸（不含内容区）；Windows 上外框比内容宽 16px、高 39px（本机实测）。

取值与依据：

| 常量 | 值 | 依据 |
| --- | --- | --- |
| `MIN_WINDOW_WIDTH` | **800** | 内容宽 784 > 播放条所需 717（余 67px；即使主区再吃掉一条竖滚动条 17px 仍够）；且远高于顶栏横向溢出门槛（外框 640） |
| `MIN_WINDOW_HEIGHT` | **520** | 内容高 481 → 主区 ≈ **358px**（顶栏换行到 2 行时 ≈ 319px），够看列表 + 播放条 |

⚠️ 夹紧只作用于**尺寸**，**不动位置**（`x` / `y` 照旧：没存就不给，存了就用）。

### 2.2 ② 顶栏换行 + 品牌名不压扁

- `.app-shell__topbar` 加 `flex-wrap: wrap`
  → 右侧控件（主题 / 设置 / 连接徽标）放不下时**换行**，而不是把顶栏顶出横向滚动条；
- `.app-shell__brand` 加 `flex: 0 0 auto` + `white-space: nowrap`
  → **品牌名永不被压扁**：宁可让导航换行，也不把「飞牛音乐」挤成竖排。

⚠️ 曲库导航组 `.fnm-app__nav--library` 自身 `nowrap`（组内不换行），组与组之间换行 —— 这个**既有行为不动**。

### 2.3 不做什么

- 不改播放条（③，用户拍板不做）；
- 不动主题 / 令牌 / 任何组件的尺寸；
- 不改 `prefs.json` 的结构（`windowBounds` 结构不变、不迁移）；
- 不改 `resolveWindowBounds` 的**位置**语义（缺位置就不给位置）。

---

## 3. 影响文件清单

| 文件 | 改动 |
| --- | --- |
| `electron/windowBounds.ts` | 新增 `MIN_WINDOW_WIDTH` / `MIN_WINDOW_HEIGHT`；`resolveWindowBounds()` 把尺寸**夹紧**到下限 |
| `electron/main.ts` | `new BrowserWindow({...})` 加 `minWidth` / `minHeight` |
| `src/styles/app-shell.css` | `.app-shell__topbar` 加 `flex-wrap: wrap`；`.app-shell__brand` 加 `flex: 0 0 auto` + `white-space: nowrap` |
| `test/window-bounds.test.ts` | 扩：夹紧行为（**只加断言**，既有断言一条不动） |
| `test/app-shell-css.test.ts` | **新**：顶栏 CSS 契约（先剥注释再匹配 + 禁硬编码色值） |
| `e2e/narrow-window.spec.ts` | **新**：窄窗口 E2E（缩不到下限 / 最小宽度下顶栏不溢出、品牌单行、无横向滚动条） |
| `docs/superpowers/specs/2026-11-05-fnmusic-narrow-window-design.md` | 本文件 |
| `README.md` / `docs/changelog.md` / `docs/calibration.md` | 文档同步 |

---

## 4. 验收点

1. `tsc --noEmit` exit 0；
2. `vitest` 全绿且**总数 ≥ 1644**（既有测试一条不许删、断言一条不许削弱）；
3. Playwright 既有 **21** 条 + 新增用例全绿；
4. **变异自证**（先红后复原）：
   - 去掉 `resolveWindowBounds()` 的夹紧 → `test/window-bounds.test.ts` 红；
   - 去掉 `.app-shell__brand` 的 `flex: 0 0 auto` → `test/app-shell-css.test.ts` 红；
   - 去掉 `.app-shell__topbar` 的 `flex-wrap: wrap` → 同上红；
5. E2E 实测：窗口拖到最小 → 外框 **800 × 520**；最小宽度下顶栏 `scrollWidth ≤ clientWidth`、
   品牌**单行**（高 < 30px）、文档**无横向滚动条**；
6. U+FFFD 扫描 0、无 BOM、行尾与基线一致（`docs/calibration.md` 保持 CRLF）。

---

## 5. 风险与待校准

- ⚠️ **外框 16px / 纵 39px 的窗口边框是本机实测值**（Windows + 当前缩放 100%）。
  换机器 / 换缩放比例时「内容宽 = 外框宽 − 边框」会变 → 最小宽度取 800（而不是贴着 733 的下限）
  就是为了给这个浮动留余量。
- ⚠️ 播放条的 717px 是**当前组件**的实测需求；将来改了播放条布局，这个下限可以再收窄。
- ⚠️ 未登录态顶栏只有 2 颗按钮 → 本规格的约束**以已登录态（10 颗）为准**，未登录态天然更宽松。
