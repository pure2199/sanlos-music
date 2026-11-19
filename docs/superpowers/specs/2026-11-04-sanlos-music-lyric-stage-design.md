# T34 设计规格：全屏歌词「歌词舞台」（显示所有歌词）

- 日期：2026-11-04
- 状态：已获用户批准
- 前置：T15（歌词视图三档模式）、T32 / T33（外部歌词源）

---

## 1. 背景与动机

用户诉求：**「全屏歌词应该显示所有歌词」**。

### 1.1 既有三档都满足不了

| 模式 | 场上的歌词行数 | 为什么满足不了 |
| --- | --- | --- |
| `single` | 当前行 ±3 行（最多 7 行） | **窗口裁剪**——真实歌词动辄成百上千行，DOM 里根本没有全部 |
| `double` | **恰好 2 行** | 「双行推进」是 Task 15 的既定交互（上一行走满 + 下一行开走，整页走完才换行） |
| `all`（本任务） | **全部** | —— |

⇒ 本任务给 `LyricView` 加**第三档** `mode="all"`，并把**全屏播放页**切到这一档。

### 1.2 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 形态 | **歌词舞台式**：全量渲染所有行 + 当前行放大并逐字高亮 + 自动滚动跟随 |
| 影响范围 | **只有全屏播放页**；桌面悬浮歌词（Task 19）**保持 `double` 不变** |
| 既有模式 | `single` / `double` 的行为**一字不改** |

---

## 2. 结构

### 2.1 组件

`src/ui/lyrics/LyricView.tsx` 保持单组件多模式：

```
LyricView
├─ mode="single"  → 窗口裁剪（既有，一字未改）
├─ mode="double"  → 双行（既有，一字未改）
└─ mode="all"     → 歌词舞台（本任务新增）
```

新增导出常量：

```ts
export const LYRIC_ALL_LINE_HEIGHT = 60   // 所有行的**固定槽位**高度（px）
```

### 2.2 DOM

```html
<div class="fnm-lyricview fnm-lyricview--all"
     data-testid="lyric-view"
     data-active-index="23"          <!-- 当前行下标；没有活跃行时是 -1 -->
     data-scroll-top="1210"          <!-- 滚动目标（jsdom 里 scrollTop 是空操作） -->
     role="list" aria-label="歌词">
  <div class="fnm-lyricview__canvas"
       style="--fnm-lyricview__canvas-height: 1800px">
    <div class="fnm-lyricview__line" data-index="0"
         style="--fnm-lyricview__line-top: 0px">…</div>
    <div class="fnm-lyricview__line fnm-lyricview__line--active" data-index="23"
         style="--fnm-lyricview__line-top: 1380px">…</div>
    …
  </div>
</div>
```

- **绝对定位 + `--fnm-lyricview__line-top`**：与 `single` 模式同一套机制（纵向位置由组件用 CSS 变量给）。
- **画布高度** = 行数 × 槽位 → 舞台内容可滚。

---

## 3. 三个设计决策

### 3.1 所有行**等高槽位**（当前行只放大字号，不改槽位）

- 普通行：`height: 60px; line-height: 40px; font-size: 15px`
- 当前行：`height: 60px; line-height: 40px; font-size: 20px`（**槽位不变**）

**为什么**：若当前行更高 → 后面的行要下移 → 长歌**每唱一句整屏抖一下**。
等高槽位让「当前行往前推进」只改变**同一位置的字号** → 列表**纹丝不动**。

**代价**：超长的一行歌词若折行，会与下一行轻微重叠（与 `single` 模式同源，属既有取舍）。

### 3.2 翻译**只给当前行看**

每行都挂翻译 → 每行都被撑高 → **槽位等高的前提就破了**（而且翻译会叠字）。

⇒ `renderLine` 新增 `showTranslation?: boolean`（**缺省 `true`** → `single` / `double` 的既有行为**一字不改**）；
`all` 模式只给当前行传 `true`。

**例外（踩坑后补的）**：播放位置**还在第一句歌词之前**时，`findActiveLine` 返回 `-1`
→ 没有活跃行 → 若翻译只跟活跃行走，**整屏一条翻译都不显示**（用户看到「只有原文」的半成品）。
⇒ 翻译**回落到第一行**（还没唱到的那句）。全程始终**只有一行**带翻译 → 槽位等高依然成立。

### 3.3 `memo` 化每一行

真实歌词可达上千行，而 `currentTime` **每帧都在变** → 不 memo 的话每次时间推进都要重建上千个元素
（长歌上就是明显卡顿）。memo 之后：**只有当前行**（`progress` 变）会重渲染，其余行直接跳过。

⚠️ **样式对象必须在 memo 组件内部现算**（不能作为 prop 传）——作为 prop 传 → 每次渲染都是
**新对象** → memo 的浅比较永远不相等 → 形同没 memo。

---

## 4. 滚动跟随

滚动目标**按行号线性计算**（不依赖 DOM 测量）：

```
center = activeIndex × 60 + 30 − 可视区高度 / 2
scrollTop = clamp(center, 0, 总高 − 可视区高度)
```

- **线性**的槽位 → 滚动量与行号一一对应 → **可单测**（jsdom 量不到布局，但能断言 `data-scroll-top`）；
- `single` 模式的老算法（非等高 → 后续行要下移）**一字未改**。

**短歌不孤零零挂顶上**：歌词比可视区矮时用 `justify-content: safe center` 居中；
比可视区高时贴顶（`safe` 关键字：普通 `center` 会让溢出内容的**顶部够不着**）。
不支持 `safe` 的引擎会整条丢弃这条声明 → 退回贴顶 → **仍然正确**。

---

## 5. CSS 契约

`src/ui/lyrics/lyric-view.css` 新增 `.fnm-lyricview--all` 规则块：

| 选择器 | 关键声明 |
| --- | --- |
| `.fnm-lyricview--all .fnm-lyricview__line` | `position: absolute; top: var(--fnm-lyricview__line-top); height: 60px; line-height: 40px; font-size: 15px` |
| `.fnm-lyricview--all .fnm-lyricview__line--active` | `height: 60px`（**槽位不变**）+ `font-size: 20px` |
| `.fnm-lyricview--all` | `display: flex; flex-direction: column; justify-content: safe center` |
| `.fnm-lyricview--all .fnm-lyricview__canvas` | `flex: 0 0 auto`（别让 flex 把画布压扁） |

⚠️ **槽位高度必须等于 TS 常量 `LYRIC_ALL_LINE_HEIGHT`** —— 否则「CSS 与代码各写一份 60」一旦漂移，
行与行会重叠或留缝，而**两侧的测试各自都会绿**。`test/lyric-view-all-css.test.ts` 专门钉这条。

---

## 6. 测试策略

| 层 | 文件 | 钉的是什么 |
| --- | --- | --- |
| 单测 | `test/lyric-view-all.test.tsx`（新增 8 条） | 所有行在场、当前行放大+逐字、翻译只给一行、槽位差恒为 60、滚动跟随、空态、onSeek、**无活跃行时翻译回落到第一行** |
| CSS 契约 | `test/lyric-view-all-css.test.ts`（新增 5 条） | 每条关键声明 + **槽位高度 == TS 常量** |
| E2E | `e2e/smoke.spec.ts`（新增 1 条） | **真实布局**：30 行全在场、相邻行 y 间距恒 60px、当前行字号更大、舞台能滚且**已滚到**当前行、当前行在视口内 |

⚠️ **既有测试一条不删、断言一条不削弱**：`test/lyric-view.test.tsx` 里那条
「有歌词时用 Task 12 的 parseLyricEntries 解析并渲染」的前提（「双行模式」）被用户明确推翻
（全屏页改成全量模式）→ **只改标题里的模式名，断言一字未改**。

⚠️ **mock 需要一条「长歌词」**：mock 原有的歌词只有 2~3 行 → 内容不够高 → 舞台**不会滚动**
→ 「滚动跟随」就是条**空断言**（假绿）。⇒ mock 新增 `/mock-lyric-long`（30 行，每 2 秒一句），
**原端点一字不改**（T32 的用例环境不受影响）。

---

## 7. 已知限制 / 待办

- **逐字高亮依赖数据源**：本档的逐字来自 NAS 的**增强型 LRC**（`<mm:ss.xx>` 词级标签）。
  QQ 源的 QRC 是**密文** → 外部源目前**只有行级** → 外部源的歌看不到逐字推进（留给后续任务）。
- **长行折行**会与下一行轻微重叠（等高槽位的代价，与 `single` 模式同源）。
- **全量渲染的规模**：真实歌词上千行 → DOM 里上千个行元素。
  已用 `memo` 把「每帧重渲染」压到「只重渲染当前行」，但 DOM 节点数本身仍是 O(行数)。
- 桌面悬浮歌词**仍是 `double`**（用户只要求全屏页）。
