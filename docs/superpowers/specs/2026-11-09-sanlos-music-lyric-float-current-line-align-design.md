# T79 —— 桌面浮窗与全屏歌词舞台「同一时刻同一行」（规格）

> 起因（2026-11-09，用户提问）：
> 「为什么有时候全屏歌词的卡拉OK模式的行字时间戳对得上，而桌面的两个歌词行字时间戳对不上？」
>
> 用户拍板（同轮问卷）：「**修，彻底对齐** —— 浮窗改成「当前句在上 + 下一句在下」，
> 换行也按**行首时间戳** ⇒ 两处**同一时刻同一行**在推进」。

---

## ① 根因（**已查证**，用仓库真实逻辑跑过对照）

| 页面 | 模式 | 判「正在唱的那行」靠什么 | 屏幕排的是 |
|---|---|---|---|
| 全屏歌词舞台 | `mode="all"` | `findActiveLine(lines, t)` ⇒ **行首时间戳** `line.time`（左闭右开） | 全部行在场，**当前行高亮放大** |
| 词岛 | `mode="single"` | 同上（行首时间戳） | 只有当前行 |
| **桌面经典浮窗** | `mode="double"` | `computeDoubleLineState(lines, t)` ⇒ **行末时间** `lineEndTime(line)`（最后一个词的 end） | **[上一句, 正在唱的句]** |

三个后果：

1. **排布相反**：浮窗上面那行是**已经唱完的**（全蓝），正在唱的在**下面**；全屏里正在唱的那句是高亮放大的当前行 ⇒ 同一时刻两处不是同一行。
2. **扫光上下跳**：`phase='before'` 时推进的是**上一行**（上面），`phase='after'` 变成**下一行**（下面）⇒ 每唱完一句扫光从上面跳到下面。
3. **「有时候对得上」的来源**：解析器 `assemble`（`src/ui/lyrics/parse.ts`）把**行级 LRC 的末词 end 取成「下一行的行首时间」** ⇒ 纯行级歌词（伪逐字；QQ / NAS 普通 LRC 走这条）时两种口径**恰好相等** ⇒ 对得上；**真实词级时间戳**（增强 LRC / yrc）时末词 end 被取成 `min(next.time, …)` 或 `word.start + 0.5` ⇒ 与行首时间戳**不再重合** ⇒ **错位**（可提前开扫，也可落后数秒）。

**实测对照**（`release/verify/t79-timing-compare.ts`，用仓库真实函数并排跑）：

- 纯行级 LRC：t=0→4.9 两处都推 L0、t=5.1 起都推 L1 ⇒ **一致**；唯一例外是**最后一句卡住**（末词 end = 行首 + 0.5 ⇒ 被判为已走满 ⇒ 只剩一行、扫光停住）。
- 词级时间戳比行首早（t=4.2）：桌面浮窗 **L0 与 L1 同时扫光**（下一句提前开扫），全屏只有一行动。
- 词级时间戳比行首晚（t=5.1 / 6.2）：**桌面浮窗还在推 L0，全屏已切到 L1** ⇒ 错 1.5 秒。

---

## ② 口径（用户已拍板）

1. 浮窗排布 = **[当前句, 下一句]**（**当前句在上** ⇒ 与酷狗桌面歌词一致）；
2. 「当前句」判定 = **行首时间戳**（`findActiveLine`）⇒ 与全屏舞台 **同一个判定源**；
3. **只有当前句扫光**（下一句不给 progress）⇒ 任何时刻只有一行在动；
4. 换行时机 = **当前句的行首时间戳到了就换**（不再等「整页走完」）；
5. **零外溢**：`mode="double"` 与 `doubleLine.ts` **一字不动、既有测试一条不改**。

---

## ③ 设计

### ③-A 新模式 `mode="current"`（`src/ui/lyrics/LyricView.tsx`）

沿用 **T34 的老套路**（给 `LyricView` 加第三档 `mode="all"`、把全屏播放页切过去）：

- 当前行 = `findActiveLine(safeLines, time)`（**行首时间戳**）；
- 渲染两行：**[当前行, 当前行 + 1]**；
- `progress` **只给当前行**（`computeLineProgress(currentLine, time)`），下一行 `progress: null`；
- 当前行 `active: true`（挂 `fnm-lyricview__line--active`）⇒ 浮窗里它是**纯白**，
  下一行是暗白 0.66（T77 的 `--lyric-float-*` 令牌照旧生效）；
- 换行信号：暴露 `data-current-index`（**当前行下标变化** = 换行）；
- `slot` 用 `current` / `next`（类名 `fnm-lyricview__line--current` / `--next`）。

⚠️ **为什么不给下一行 progress**：给了它，若下一行的**词级时间戳早于它自己的行首**
（真实歌词常见），下一句会**提前开扫** ⇒ 桌面上**两行同时在动**（实测案例 2）。

### ③-B 样式（`src/ui/lyrics/lyric-view.css`）

`.fnm-lyricview--current` 与 `.fnm-lyricview--double` **同款排版**：
容器（flex 列 / gap 18px / 居中）+ 行（`height:auto` / 20px / 32px / 600）
⇒ 两行**字号一致**（与既有两行等粗的观感一致）。

### ③-C 消费方（`src/ui/lyrics/LyricOverlay.tsx`）

`mode="double"` → `mode="current"`（**只有经典浮窗**在用）。

### ③-D 既有断言（**一条不删**）

| 位置 | 前提 | 处理 |
|---|---|---|
| `test/lyric-overlay.test.tsx:118` | 浮窗用 `fnm-lyricview--double` | **改写**为 `fnm-lyricview--current`（前提被用户指令显式推翻） |
| `e2e/t71-karaoke.spec.ts:358` | 同上（定位器） | **改写**为 `.fnm-lyricview--current`（**断言强度不变**：仍验「卡拉OK 真跟音频走」） |
| `test/lyric-view.test.tsx` 的 double 段（6 条） | double 模式语义 | **一字不改**（double 模式语义没变，只是不再被生产代码使用） |
| `test/lyric-karaoke-pages.test.tsx` | 直接用 `mode="double"` | **一字不改** |

### ③-E 注释（`src/ui/lyrics/doubleLine.ts`）

注明「T79 起**生产代码不再使用**它（经典浮窗改用 `mode="current"`），
本模块的语义与测试**原样保留**」⇒ 不删代码、不删测试。

---

## ④ 验收

- `tsc --noEmit` exit 0；
- `vitest run`：**条数只增不减**（基线 96 文件 / 2045 条）；
- `npm run build` exit 0；
- Playwright E2E：**27/27**（不增不减）；
- **新增** `test/lyric-view-current.test.tsx`：当前句在上 / 只有当前句扫光 /
  **与 `mode="all"` 判出的当前行同一下标**（=「对齐全屏」的钉子）/ 行首时间一到就换行 /
  t 早于第一行时的退化 / 只渲染两行；
- **变异自证** ≥3 条全红；
- **真机复验**：桌面浮窗 = **当前句在上 + 下一句在下**、**只有当前句扫光**。
