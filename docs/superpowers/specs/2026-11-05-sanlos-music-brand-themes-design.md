# T50 设计规格：品牌名「Sanlos Music」的两套主题适配

- 日期：2026-11-05
- 承接：T49（软件更名为「Sanlos music」）
- 状态：已实现并验证

---

## 1. 起因（用户原话）

> 「你两个UI都要适配过吧，不然不好看」

用户在 T49 的两套主题截图后发现：**品牌名换成拉丁文之后，两套主题下的排版完全一样**，
而「飞牛音乐」四个字在两套主题里本来就是不同的观感 → 改名后这套「按主题各调各的」断了。

---

## 2. 实测：问题到底在哪（不是猜的）

改名前用隔离实例量了两套主题下的品牌名计算样式（`release/verify/t50-brand-metrics.mjs`）：

| 指标 | Apple 风 | Fluent 风 | 结论 |
| --- | --- | --- | --- |
| `font-size` | 15px | 15px | **一模一样** |
| `font-weight` | 600 | 600 | **一模一样** |
| `font-family` | `Noto Sans SC` | `Noto Sans SC` | **一模一样** |
| 实际宽 × 高 | 96.6 × 21 px | 96.6 × 21 px | **一模一样** |

### 三个具体问题

1. **宽度暴涨 61%**：4 个汉字（60px）→ 12 个拉丁字符（96.6px）。
2. **拉丁字母被中文字体接管**：实测本机系统默认 sans-serif 就是 `Noto Sans SC`
   （中文字体的拉丁字腔偏宽、600 字重下 12 个字母连读偏重）→ 观感发糊。
3. **两套主题共用一套值**：Apple 风的圆润柔和 vs Fluent 风的方正克制，
   在品牌名上**完全体现不出来**（用户看到的两张截图差异只是表面色）。

### 但布局没有坏

宽/窄窗口下顶栏都是 `scrollWidth == clientWidth` → **没有溢出**，
所以这轮修的是**观感层级**，不是布局返工。

---

## 3. 决策

### 3.1 用户拍板的两项

| 决策 | 选择 |
| --- | --- |
| 大小写 | **「Sanlos Music」**（首字母大写）—— T49 定的「Sanlos music」偏弱 |
| 形态 | **纯文字**（不加图标/渐变），**两套主题各调各的排版** |

### 3.2 令牌化：排版值从组件里挪到主题层

新增 4 个令牌（`src/styles/tokens.css`）：

| 令牌 | Apple 风（`:root`） | Fluent 风（`[data-theme='fluent']`） |
| --- | --- | --- |
| `--brand-font-family` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif` | `'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei', 'Noto Sans SC', sans-serif` |
| `--brand-font-size` | `16px` | `15px` |
| `--brand-font-weight` | `600` | `500` |
| `--brand-letter-spacing` | `-0.3px` | `0px` |

**为什么这么分**：

- **Apple 风 → 圆润柔和**：系统 UI 字体优先；字号略大（16px）、字重 600、
  负字距（`-0.3px`，拉丁文收紧，避免连读松散）。
- **Fluent 风 → 方正克制**：**优先 `Segoe UI Variable Text`**（Win11 的新 UI 字体，
  才是 Fluent 语言的正脸；Win10 上没有它，回退 `Segoe UI`）；
  字号 15px、字重 500（Segoe UI 的 600 在 Fluent 的语言里偏重）、字距归零。

### 3.3 字体栈的顺序是硬要求

**拉丁字体在前、中文字体在后**：

```
-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif
```

否则 `Noto Sans SC` 会接管拉丁字母 → 回到「字腔宽 + 600 偏重」的老问题。

### 3.4 组件只消费令牌

`src/styles/app-shell.css` 的 `.app-shell__brand` 改成**只声明** `var(--brand-*)`，
**不再写死任何字号/字重/字距** → 换主题只改令牌，组件零分支。

⚠️ **T40 的护栏一个字不动**：`flex: 0 0 auto` + `white-space: nowrap`
（品牌名永不被压扁成竖排）—— 本轮只改**排版**，**不改布局**。

---

## 4. 品牌文案统一为「Sanlos Music」

T49 定的是「Sanlos music」，本轮统一成「Sanlos Music」。改动点：

| 文件 | 改动 |
| --- | --- |
| `src/App.tsx` | 顶栏品牌 → `Sanlos Music` |
| `shared/appInfo.ts` | `APP_INFO.name` → `Sanlos Music` |
| `shared/constants.ts` | `NAS_OAUTH_APP_NAME`（fnOS 授权页 `app_name`）→ `Sanlos Music` |
| `electron/tray.ts` | 托盘空闲提示 → `Sanlos Music` |
| `electron/oauthWindow.ts` | 授权窗标题 → `Sanlos Music` |
| `index.html` / `lyric.html` / `island.html` | `<title>` → `Sanlos Music`（词岛为 `Sanlos Music · 动态词岛`） |
| `electron-builder.yml` | `productName` → `Sanlos Music`（产物 `Sanlos Music.exe`） |
| `package.json` | `description` → `Sanlos Music` |
| `src/pages/LoginPage.tsx` | 桥不可用提示里的应用名 → `Sanlos Music` |

### 4.1 刻意**保持**「Sanlos music」（小写 m）的地方

| 位置 | 原因 |
| --- | --- |
| `electron/downloadManager.ts` → `DEFAULT_DOWNLOAD_SUBDIR` | **这是路径**，不是品牌文案 |
| `src/components/SettingsPanel.tsx` → 下载目录 placeholder | 同上 |
| `electron/main.ts` / `e2e/helpers/app.ts` 的注释 | 同上 |

理由：避免「界面叫 A、路径叫 B」的困惑 —— **路径是数据位置，品牌是名字**，
两者本来就该能区分开。老目录 `我的音乐\Sanlos music` 不删。

---

## 5. 验收点

### 5.1 自动化

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit` | exit **0** |
| `vitest run` | **1794 passed / 82 files**（基线 1790，+4 条新契约） |
| `npm run e2e` | **24 passed** |
| `npm run build` | exit **0** |

### 5.2 新增 CSS 契约测试（`test/app-shell-css.test.ts`，4 条）

1. `.app-shell__brand` 的字号/字重/字距**全部走 `var(--brand-*)`**（不再写死）；
2. **T40 的护栏没丢**（`flex: 0 0 auto` + `white-space: nowrap`）；
3. **两套主题的字号/字重真的不同**（不是同一套值抄两遍）；
4. **字体栈拉丁在前、中文在后**（`Segoe UI` 出现位置早于 `Noto Sans SC`）。

### 5.3 真机（隔离实例，Playwright 驱动 Electron）

| 场景 | Apple 风 | Fluent 风 |
| --- | --- | --- |
| `font-size` | **16px** | **15px** |
| `font-weight` | **600** | **500** |
| `letter-spacing` | **-0.3px** | **normal**（0） |
| `font-family` | 以 `-apple-system`/`Segoe UI` 起头 | 以 `Segoe UI Variable Text` 起头 |
| 品牌名宽 × 高 | **90.6 × 21 px** | **88.3 × 21 px** |
| 宽窗顶栏 `scrollWidth` vs `clientWidth` | 1184 == 1184（**不溢出**） | 1184 == 1184 |
| 窄窗（784）顶栏 `scrollWidth` vs `clientWidth` | 784 == 784（**不溢出**） | 784 == 784 |

对比改名前：**96.6px → 90.6 / 88.3 px**，两套主题**终于各有一套值**。

---

## 6. 已知限制（如实标注）

- ⚠️ **Electron 默认图标未处理**：标题栏左上角还是 Electron 的默认小圆球
  （仓库里没有 `build/icon.ico`）→ 两套主题都如此，本轮**不在范围内**。
- ⚠️ **未重新打包**：`Sanlos Music.exe` 的产物名变更（T50）**未真机验过**，
  与 T49 的覆盖安装风险叠加（见 §7）。
- ⚠️ **两套主题的品牌名观感需用户肉眼复验**：本轮只做了像素级量测（尺寸/字重/字体栈）
  与截图，没有做主观审美判断。
- ⚠️ **Apple 风的字体栈在 Windows 上落到 `Segoe UI`**：
  `-apple-system` / `BlinkMacSystemFont` 是 macOS 的别名，Windows 上不存在 →
  实际渲染是 `Segoe UI`。这是**正常且预期**的（跨平台字体栈），
  但意味着「Apple 风」在 Windows 上的品牌名观感 ≈ `Segoe UI` + 600 + `-0.3px`。

---

## 7. 遗留 / 待办

- ⚠️ **待真机验**：两套主题下品牌名的**肉眼观感**（用户复验）；
- ⚠️ **待真机验**：装完 `Sanlos Music.exe` 后的**覆盖安装**行为
  （旧的 `飞牛音乐.exe` / `Sanlos music.exe` 可能并存）；
- ⚠️ **待用户拍板**：Electron 默认图标要不要换成品牌图标（需 `build/icon.ico`）。
