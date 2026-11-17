# T104 规格：修详情页曲目列表「滚不动」+ 补齐真机滚动到底验证

> 状态：规格先行（实现前定稿）
> 日期：2026-11-17
> 前置：T99（集号规则）、T100（归并口径）、T101（有声页形态）、T102（封面 id 统一）、T103（集号优先级）

---

## 一、问题

《极品家丁》1333 集的**详情页**里，曲目列表**滚不动** —— 用户只看得到**最前面十几行**，
下面是一大片空白画布。

真机实测（2026-11-17，本机 + 该账号，探针 `t103-03`；见 `docs/calibration.md`「七十九」）：

| 量 | 实测值 | 含义 |
|---|---|---|
| `.fnm-songlist__viewport` 的 `clientHeight` | **63984** | 视口**被内容顶高** |
| `.fnm-songlist__viewport` 的 `scrollHeight` | **63984** | ⇒ `clientHeight == scrollHeight` ⇒ **它根本不是滚动容器** |
| `document.scrollingElement` | 761 / **64429** | 真正在滚的是**整个文档** |
| `data-scroll-top` | 恒为 **0** | 虚拟窗口**永不前移** |

⇒ `SongList` 的虚拟裁剪靠**自己**的 `onScroll` → `setScrollTop` 更新；
那个事件**永远不来** ⇒ 只渲染**第一屏**的行 ⇒ 1333 集里 1320 集**够不着**。

⚠️ 这条缺陷**不是本次新引入的**，是 T103 真机复验**顺带抓到的**（T103 之前一直没人滚到底过）。

---

## 二、根因

详情页的 flex 链有一处**缺声明**：

```
.app-shell            height: 100vh            ← 确定高度
└ .app-shell__main    display:flex; flex:1; min-height:0
  └ .fnm-page         flex: 1 1 auto; min-height:0; height:100%
    └ .fnm-detail     display:flex; flex-direction:column   ← ❌ **缺 flex + min-height**
      └ .fnm-detail__section                                   ← ❌ **basis 随内容**
        └ .fnm-songlist        flex: 1 1 auto; min-height:0
          └ .fnm-songlist__viewport   flex: 1 1 auto; min-height:0; overflow-y:auto
```

`.fnm-detail` 是 `.fnm-page` 的 flex item，却**没有** `flex` 与 `min-height`：

- flex item 的**自动最小尺寸**默认是 `min-height: auto` = 内容的 min-content 高度；
- 里面的虚拟列表画布高度 = 曲目数 × 行高（1333 × 48 = **63984**）
  ⇒ `.fnm-detail` 被顶到 **63984** ⇒ 里面的视口**没有负余量可压缩**
  ⇒ 视口的 `clientHeight` ＝ 内容高度 ⇒ **不是滚动容器**。

同类页面（`.fnm-audiobooks` / `.fnm-discover` / `.fnm-settings`）**早就写对了**
（`flex: 1 1 auto` + `min-height: 0`）⇒ **详情页是漏了**。

⇒ 与 T22（`app-shell__main` 的 `min-height: 0`）**同源**，只是漏在**更下一层**。

---

## 三、方案（只改 `src/pages/detail-page.css` 的 6 条声明）

| 选择器 | 声明 | 为什么 |
|---|---|---|
| `.fnm-detail` | `flex: 1 1 auto` | 本层**长满**页面剩余高度 ⇒ 里面的区块才有「可分配的高度」可分（**承重**：去掉 ⇒ 区块拿到 0） |
| `.fnm-detail` | `min-height: 0` | 解除「自动最小尺寸 = 内容 min-content 高度」的默认下限（**兜底**：实测几何不变 ⇒ 留着只为与其它页**同一套写法**） |
| `.fnm-detail__section` | `flex: 1 1 0`（**basis = 0**） | 区块拿到的是「页面剩下的高度」这个**确定值**（**承重**：改回 `1 1 auto` ⇒ 视口被顶到内容高） |
| `.fnm-detail__head` | `flex: 0 0 auto` | 头部不参与伸缩（**观感**：窗口一矮就被压扁） |
| `.fnm-detail__section-title` | `flex: 0 0 auto` | 标题不参与伸缩 |
| `.fnm-detail__audiobook` | `flex: 0 0 auto` | 说明 / 按钮行不参与伸缩 |
| `.fnm-detail__audiobook-reasons` | `flex: 0 0 auto` | 理由行不参与伸缩 |

⚠️ 「**承重 / 兜底 / 观感**」这三种定性**不是猜的**，是**变异自证实测**出来的
（每条声明各改坏一次 ⇒ 看单测 / E2E 变没变红 ⇒ 见「验证」段）。

### 三.1 为什么区块必须是 `flex: 1 1 0`（而不是 `1 1 auto`）

- `flex: 1 1 auto` 的 **basis = 内容高度** ⇒ 多个区块会按内容高度**按比例**被压缩
  ⇒ 谁都拿不到能用的视口 ⇒ 列表**还是滚不动**（只是换一种塌法）；
- `flex: 0 0 auto` ⇒ 区块不伸缩 ⇒ 长列表把区块撑到内容高度 ⇒ 视口 = 内容高度 ⇒ 还是滚不动；
- ⇒ 只有 `flex: 1 1 0`（basis = 0）⇒ 空间按 `grow` **均分** ⇒ 每个区块拿到**确定高度**。

### 三.2 连带影响（**如实记录，不回避**）

歌手详情页有**两个**区块（「专辑网格」+「曲目」）⇒ 修好后：

- 两区块**各占一半**、**各自内部滚动**（专辑网格本来就有自己的滚动容器 `.fnm-cardgrid`）；
- 专辑页只有「曲目」一个区块 ⇒ 它拿到**全部**剩余高度。

⇒ 这是**同一根因的连带修复**（此前两区块都按内容高度撑开、页面整体滚）。

### 三.3 不动的东西

- **不动** `SongList` 的虚拟裁剪逻辑、**不动** `viewport.ts` 的钳位、**不动** `STATE_VERSION`；
- **不引**新 npm 依赖；**不改**服务端行为。

---

## 四、验证口径（三层，缺一层都算没验）

| 层 | 文件 | 钉的是什么 |
|---|---|---|
| ① CSS 契约 | `test/detail-page-css.test.ts`（新） | **哪条声明**在不在（jsdom 量不到布局 ⇒ 只能钉声明） |
| ② E2E（真实 Electron + mock） | `e2e/t104-detail-scroll.spec.ts`（新） | **量出来的几何**：视口 `clientHeight < scrollHeight`、滚到底后**末行在场**、`data-scroll-top` 从 0 变 > 0 |
| ③ 真机（真实 NAS + 真实账号） | 探针 `t104-01` | 真数据（1333 集）下的几何与末行 |

⚠️ ② **必须重新 build**（E2E 跑的是构建产物）。

---

## 五、既有 E2E 断言的改写（前提被这次修复**显式推翻**）

⚠️ 有声系列的 E2E 里有 6 处 `await expect(rows).toHaveCount(N)`（`.fnm-songlist__row` 的**DOM 行数**）。
**修好之后这些断言会假红** —— 原因不是「行少了」，而是**它们验的是缺陷的副产品**：

- 旧状态下列表**滚不动** ⇒ 视口 = 内容高度 ⇒ **全部行都在 DOM 里** ⇒ `toHaveCount(12)` 成立；
- 修好后虚拟裁剪真正生效 ⇒ DOM 里只有「可视区那一屏 + 缓冲行」
  ⇒ `toHaveCount(12)` **必然不成立**（而且**随导航路径变化**：有时 10 行、有时 12 行）。

⇒ 改写为**更强**的新断言（**不是弱化**）：

| 旧断言 | 新断言 |
|---|---|
| `expect(rows).toHaveCount(12)`（DOM 行数） | `expect(all).toHaveLength(12)`，其中 `all` = **把整张列表滚一遍**按 `data-index` 去重收齐的行 |
| `expect(rows.nth(11).locator(...)).toHaveText('12- 第12集')` | `expect(all[11]?.title).toBe('12- 第12集')` |
| `episodes` 数组全等 | `all.map(r => r.episode)` 全等（**同一性质**，收集方式改成抗虚拟滚动） |

⇒ **收齐 N 行本身就是「能滚到底」的证明**（收不齐 = 滚不到）⇒ 断言比原来**更强**：
它同时验了「数据齐」+「**能滚**」两件事。

共享辅助放在 `e2e/helpers/song-list.ts`（`collectSongListRows` / `scrollSongListToBottom` / `scrollSongListToTop`）。
**既有测试一条没删、断言一条没弱化**（只把「验 DOM 行数」换成「验数据 + 验行为」）。

---

## 六、遗留缺陷（本任务**不**修，另开编号）

### T105 候选：`SongList` 的「可视区高度」在**列表初始为空**时量不到

`src/components/SongList.tsx:387`：**列表为空时根本不渲染视口**（空态是另一个分支）
⇒ 挂载时 `viewportRef.current` 为 `null` ⇒ 量高 effect **直接 return**
⇒ 而 effect 依赖是 `[]` ⇒ **列表后来有数据了也不会再量**
⇒ `measuredHeight` 恒为 0 ⇒ 一路用兜底常量 `SONG_LIST_FALLBACK_VIEWPORT_HEIGHT = 600`。

后果（实测）：DOM 行数在「初始为空 ⇒ 兜底 600（18 行）」与「初始有数据 ⇒ 实测高度（约 10 行）」之间**摇摆**
⇒ 这就是 §五 里那些 `toHaveCount` 断言**随导航路径变红**的原因。

⚠️ 本任务**不改**它：它**不影响**「能滚到底」（虚拟窗口只多渲染几行，位置仍由 `data-index` 决定），
但它确实让「渲染了几行」变得不可预测 ⇒ 单独开一个编号任务修（改法：量高 effect 依赖「视口是否已渲染」）。

---

## 七、验收点

1. `tsc --noEmit` **0 error**；`vitest run` 全绿（新增 CSS 契约用例 **5** 条）；
2. `playwright test` 全绿（新增 T104 **3** 条 E2E；有声系列改写后仍全绿）；
3. **变异自证** **6 条全部被证明**（含 1 条「**单测绿 / E2E 红**」的 E2E 独有覆盖）；
4. **真机**（真实 NAS + 真实账号，1333 集）：视口 `clientHeight` **239** < `scrollHeight` **63984**、
   文档 **761 / 761**（页面不再被顶开）、`data-scroll-top` 滚到底 = **63745**、
   **末行 = 第 1332 集**、**第 219 集在场**（T103 补正过的两项）⇒ **8 项全过**。
