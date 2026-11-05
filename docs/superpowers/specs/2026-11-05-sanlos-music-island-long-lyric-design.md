# T53 设计规格：词岛的长歌词不再被裁掉

- 日期：2026-11-05
- 承接：T52（连接徽标的候选面板改为浮层）
- 状态：已实现并验证

---

## 1. 起因（用户原话）

> 「现在就是灵动歌词还有个BUG，长歌词显示不完整，他会变两行也看不到」

---

## 2. 实测根因

在**真实 userData 的词岛窗口**里灌进长短两句并量布局
（`release/verify/t53-island-long-lyric-probe.mjs`）：

| 量 | 短句（4 字） | 长句（22 字） |
| --- | --- | --- |
| 当前行 `.fnm-lyricview__line--active` 盒高 | 44px | **44px（定高，不会长）** |
| 同上 `scrollHeight`（真实内容高） | 44px | **88px** |
| 实际视觉行数 | 1 | **2** |
| 歌词可视区 `.fnm-island__lyrics` | 316 × **74px**，`overflow: hidden` | 同左 |

**三处叠加，缺一不可**：

1. `.fnm-lyricview__line--active` 是**定高 44px**（`height: 44px; line-height: 44px`），
   而 `white-space: pre-wrap` 允许换行 → 长句折 2 行 = 88px 内容**溢出定高盒**；
2. 词岛的 `.fnm-lyricview` 是 `overflow: hidden` → 溢出部分**被裁掉**；
3. 单行模式的滚动定位按**44px 行盒**居中 → 越往歌后面裁得越狠
   （第 0 行只切 6px，越靠后第二行大约 3/4 看不见）。

**折行阈值**：歌词内容宽 292px，汉字实测 20px → **一行最多 14 个汉字**，
超过 14 字就开始中招。

### 影响面（很小）

`mode="single"` 在生产代码里**只有词岛在用**
（经典悬浮窗 = `double`、全屏歌词舞台 = `all`）
→ 修 single 模式**只影响词岛**，主界面 / 经典悬浮窗 / 全屏歌词**一字不变**。

---

## 3. 方案（用户拍板：方案 B）

三个候选：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A | 胶囊加高到 132px + 当前行可长高 | 胶囊**永远**高 36px，短句时显得空 |
| **B（选中）** | **行高压到 32px + 当前行可长高，胶囊高度不变** | 当前行观感略紧凑 |
| C | 只在真折行时才降行高 | 换句时行高会跳一下，实现最复杂 |

### 做法（`src/island/island-window.css`，**只改词岛作用域**）

| 选择器 | 声明 | 作用 |
| --- | --- | --- |
| `.fnm-island__lyrics .fnm-lyricview` | `display: flex` + `align-items: center` | 视口自己**居中**当前行 → 不再靠 `LyricView` 的滚动定位 |
| `.fnm-island__lyrics .fnm-lyricview__canvas` | `height: auto` + `max-height: 100%` + `overflow: hidden` | 画布不再撑到「整份歌词的总高」 |
| `.fnm-island__lyrics .fnm-lyricview--single .fnm-lyricview__line` | `position: static` | 当前行不再被 `top` 顶到画布外 |
| `.fnm-island__lyrics .fnm-lyricview--single .fnm-lyricview__line--active` | `height: auto` + `line-height: 32px` | 当前行**可长高**；折 2 行 = **64px ≤ 74px** |

⚠️ **胶囊高度不变**（`ISLAND_WINDOW_HEIGHT` 仍是 96）。
⚠️ **词岛窗口宽度不变**（520）。
⚠️ **主进程 / `LyricView.tsx` 一行没改** → 共享组件零回归。

---

## 4. 防回潮的契约测试

`test/lyric-island-css.test.ts` 新增 `describe('词岛的 CSS 契约（T53：长歌词折行不被裁）')`，**6 条**：

1. 当前行**可以长高**（`height: auto`，不再是定高 44px）；
2. 当前行**行高 32px**；
3. 歌词视口改成 **flex 居中**；
4. 画布高度 **auto** + `max-height: 100%` + 溢出被裁；
5. 当前行**不再绝对定位**；
6. **跨文件不等式**：窗口高 − 上下留白 − 边框 ≥ 2 × 行高
   （用 `shared/islandAnchor.ts` 的 `ISLAND_WINDOW_HEIGHT`，不是写死的 96）。

---

## 5. 验证

- `tsc --noEmit` exit **0**；`vitest run` **1812 passed / 83 files**（基线 1806 / 83，**新增 6**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **真机**（真实 userData，灌长短两句后量）：

| 指标 | 改前（长句） | 改后（长句） |
| --- | --- | --- |
| 当前行盒高 / `scrollHeight` | 44px / **88px**（溢出） | **64px / 64px**（不溢出） |
| 视觉行数 | 2 | 2 |
| 文字实际占位 | 18..**91**（**超出可视区下沿 85**） | **17..78**（**完整在 11..85 内**） |
| 画布 | — | 64px，top 16 / bottom 80（74px 带里居中） |
| 卡拉OK 填色层高度 | — | **64px**（**盖住两行**） |
| 短句观感 | 当前行 44px 高 | 当前行 32px 高，仍居中 |

- **真屏截图**（`desktopCapturer` 抓真屏，520×96）：
  `release/verify/t53-island-long.png`、`t53-island-short.png`。

---

## 6. 已知限制（如实标注）

- ⚠️ **超过 3 行（>28 字）的极端长句仍会裁掉多出来的部分**
  （画布 `max-height: 100%` → 保住**上面**的行，底下多出来的看不见）；
- ⚠️ **单行歌词的当前行从 44px 行高变成 32px** —— 观感略紧凑（用户已知悉并选定）；
- ⚠️ **词岛窗口宽度 520px 没动** → 一行仍只放得下 14～15 个汉字。

---

## 7. 遗留 / 待办

- ⚠️ **待用户复验**：真实歌曲下的长句观感（是否还会觉得行高偏紧）；
- ⚠️ 仍待复验：T46、T47、T48；T49/T50 的覆盖安装；
- ⚠️ **待用户拍板**：词岛胶囊要不要收窄（当前 520×96）；Electron 默认图标要不要换。
