# T75 —— 应用图标资源 + 托盘「没播放就空白」修复（规格）

> 用户反馈（2026-11-09）：
> 「任务栏图标没播放时是空的，没播放时图标应该有」

---

## ① 现状（**已查证**，非推测）

### ①-A 现象落在哪里

三处「图标」候选，逐个查证：

| 位置 | 代码 | 结论 |
|---|---|---|
| **托盘（任务栏右下角通知区）** | `electron/tray.ts` | ✅ **就是这里** |
| 主窗口的任务栏按钮 | `electron/main.ts:306` `new BrowserWindow({...})` | **没有 `icon` 选项** ⇒ 用 Electron 默认图标（不是空白，但也不是应用图标） |
| 歌词悬浮窗 / 灵动态词岛 | `electron/main.ts:564` / `:636` | `skipTaskbar: true` ⇒ **不进任务栏**，与本现象无关 |

### ①-B 根因：**项目根本没有应用图标资源**

| 证据 | 事实 |
|---|---|
| 仓库 | **没有 `build/` 目录** ⇒ 没有 `build/icon.ico` / `icon.png` |
| `electron-builder.yml` | `directories.buildResources: build`，但**没有 `win.icon`** ⇒ 打包用 Electron 默认图标（changelog「已知限制」里已记着这一条） |
| `electron/tray.ts:36-38`（注释自己写了） | 「当前项目**没有打包应用图标**……所以默认图标用 **`nativeImage.createEmpty()`**」 |

### ①-C 「空图标」的三条具体路径（`electron/tray.ts`）

| 行 | 代码 | 触发时机 |
|---|---|---|
| `:416` | `createTrayImpl(nativeImage.createEmpty())` | **建托盘时** ⇒ 初始就是 0×0 空图 |
| `:478-481` | `if (coverId.length === 0) { tray.setImage(nativeImage.createEmpty()) }` | **没有当前曲目 / 没有封面（= 没在播放）** ⇒ 立刻变回空白 |
| `:495-498` | `if (image.isEmpty()) return` / `catch { /* 保持默认图标 */ }` | 封面取失败 / 字节不是合法图片 ⇒ 保持**空白** |

⇒ **播放中**：拿到封面 ⇒ 托盘显示专辑封面（可见）；
　**没播放**：没有封面 ⇒ 托盘显示 **0×0 空图** ⇒ 通知区里**什么都没有**。
　与用户现象**完全吻合**。

---

## ② 口径（用户已拍板）

1. **图标样式**：**深紫渐变圆角方块 + 白色音符**（用户 2026-11-09 选定）。
2. **托盘行为**：**播放中显示专辑封面；停下换回应用图标**（用户选定 ⇒ 保留现有「播放中显示封面」的行为，只补「停下时不是空白」这个缺口）。
3. **同一份图标**用于：托盘、主窗口 / 歌词窗 / 词岛窗的任务栏与标题栏图标、**打包产物的 exe 图标**。
4. **不引新 npm 依赖**：PNG 编码用手写实现（`node:zlib` + 自写 CRC32 + 自写 PNG 分块），
   图形用**超采样逐像素绘制**（4× 超采样后盒式降采样 ⇒ 抗锯齿干净）。
5. **渲染层不碰文件系统**：图标只被**主进程**读取（托盘 / 窗口 icon）。

---

## ③ 设计

### ③-A 图标资源（`scripts/make-app-icon.mjs` → `build/`）

- **生成脚本进版本库**（可复现、可再调），**产物也进版本库**（打包时要用，且离线可构建）；
- 产物两个：
  - `build/icon.png` —— **256×256**（窗口图标 / exe 图标源）；
  - `build/tray.png` —— **32×32**（托盘；Windows 100% DPI 缩到 16、200% DPI 原生用 32）。
- 画法：
  - 背景：**圆角方块**（圆角半径 = 边长 × 0.20），**对角线性渐变**
    `#5B21B6`（左上，深紫）→ `#A855F7`（右下，亮紫）；
  - 前景：**白色八分音符**（符头 = 旋转 −20° 的椭圆；符干 = 竖条；符尾 = 二次贝塞尔带状）；
  - 抗锯齿：**4× 超采样**（256 ⇒ 1024²）后**预乘 alpha 盒式降采样** ⇒ 边缘干净、无黑边。

### ③-B 图标路径解析（`electron/appIcon.ts`，**新**）

- **纯模块**（**不 import electron**）⇒ 可直接单测（与 `electron/tray.ts` 同一条纪律）；
- 解析顺序（**第一个存在的胜出**）：
  1. `<模块目录>/icon.png` —— 打包后是 `app.asar/dist-electron/icon.png`
     （`electron-builder.yml` 的 `files` 已含 `dist-electron/**/*` ⇒ 天然进包）；
  2. `<appRoot>/build/icon.png` —— 开发态仓库根（`app.getAppPath()` = 仓库根）；
- 找不到 ⇒ 返回 `null` ⇒ **调用方按「没有图标」处理**（不报错、不崩）。

### ③-C 托盘（`electron/tray.ts`）

- `TrayDeps` 增加 **`appIcon?: NativeImageLike`**（**注入**，不自己找路径 ⇒ 仍是纯逻辑、可单测）；
- 三条「空图」路径全部替换为「**应用图标**」：
  - 建托盘时：`createTrayImpl(appIcon ?? nativeImage.createEmpty())`；
  - 没有封面：`tray.setImage(appIcon ?? nativeImage.createEmpty())`；
  - 封面取失败 / 字节非法：`tray.setImage(appIcon ?? …)`；
- **没有注入 `appIcon` 时行为与今天完全一致**（单测的老用法不受影响）。

### ③-D 窗口图标（`electron/main.ts`）

- 主窗口 / 歌词悬浮窗 / 灵动态词岛：`icon: <解析出的图标路径> ?? undefined`
  ⇒ 找不到资源时**不传**（Electron 用默认图标，与今天一致）。

### ③-E 打包（`scripts/build-electron.cjs` + `electron-builder.yml`）

- `scripts/build-electron.cjs`：esbuild 跑完后，**把 `build/icon.png` 复制进 `dist-electron/icon.png`**
  ⇒ 随 `dist-electron/**/*` 进 asar；
- `electron-builder.yml`：`win.icon: build/icon.png`
  ⇒ exe / 安装包 / 快捷方式 / 任务栏都换成应用图标
  ⇒ **顺带修掉** changelog「已知限制」里那条「默认 Electron 图标」。

---

## ④ 影响文件

- **新增** `scripts/make-app-icon.mjs`（PNG 编码 + 绘制，零依赖）；
- **新增** `build/icon.png`（256×256）、`build/tray.png`（32×32）；
- **新增** `electron/appIcon.ts`（纯路径解析）；
- **新增** `test/app-icon.test.ts`（路径解析 + 托盘回落行为）；
- `electron/tray.ts`（**行为改动**：空图 ⇒ 应用图标）；
- `electron/main.ts`（**行为改动**：三个窗口设 `icon`；托盘注入 `appIcon`）；
- `scripts/build-electron.cjs`（复制图标进 `dist-electron`）；
- `electron-builder.yml`（`win.icon`）；
- `test/tray-tooltip.test.ts`（**既有 2 条断言的前提被用户推翻 ⇒ 改写，不删**）；
- `docs/changelog.md`（修复表 + 「已知限制」里那条「默认 Electron 图标」）。

---

## ⑤ 既有断言的改写（**一条不删、强度只增**）

| 位置 | 原文（前提） | 改写为 |
|---|---|---|
| `test/tray-tooltip.test.ts:386` | 「封面还没到 → 只设过默认（**空**）图标」 | 「封面还没到 → 只设过**应用图标**（**非空**）」 |
| `test/tray-tooltip.test.ts:411` | 「取不到封面时降级为默认图标」 | 「取不到封面时降级为**应用图标**（**非空**，不是空白）」 |

⚠️ 这两条的**前提被用户指令显式推翻**（"没播放时图标应该有"）⇒ 按新行为改写并说明。

---

## ⑥ 验收点

- `tsc --noEmit` exit 0；
- `vitest run` 全绿（**既有测试一条不删**，改写的 2 条强度只增；新增用例若干条）；
- `npm run build` exit 0；
- **变异自证**：
  - M1 把「无封面 ⇒ 应用图标」改回「空图」 ⇒ 新用例**红**；
  - M2 把 `win.icon` 去掉 ⇒ 契约用例**红**（钉住「打包必须用应用图标」）；
- **真机截图取证**：
  - 托盘在**没播放**时**显示应用图标**（不再是空白）；
  - 播放时托盘变成**专辑封面**；
  - 主窗口任务栏按钮显示**应用图标**（不再是 Electron 默认）；
- **打包取证**：`npm run pack` 后用 `Icon.ExtractAssociatedIcon` 从 **exe** 提取图标
  ⇒ 与 `build/icon.png` 视觉一致（不再是 Electron 默认图标）。

---

## ⑦ 明确不做

- ❌ **代码签名**（需要证书，用户侧提供）—— 与本任务无关；
- ❌ **托盘改成「始终显示应用图标」** —— 用户明确选了「播放中显示封面」；
- ❌ **词岛胶囊宽度调整** / **Electron 默认图标**等其它待拍板项 —— 各自独立；
- ❌ **不在渲染层读图标**（渲染层永远不碰文件系统）。
