# T81 设计规格：真逐字才卡拉OK，否则整行显示

> **一句话**：歌词行**带真逐字时间戳**（源给的）才走卡拉OK 填色；只有行级时间戳的，
> **不假装逐字** —— 当前行**整行**用强调色显示。

---

## 一、为什么做这个（问题）

### 1.1 用户报障

2026-11-10 用户报「歌词时间戳又不对了」。完整诊断结论（见台账「歌词『行/字时间戳不对』：根因诊断」）：

- 三处歌词页面的「当前行」判定已统一为 `findActiveLine`（T79 已修）；
- 可听延迟实测只有 **10ms**（`outputLatency=0`、`baseLatency=0.01`）⇒ 与「差几秒」无关；
- 外部源自带的 `[offset:±N]` 没丢；
- **真正的根因**：用户当前用的是 **QQ 源**，而 QQ 端点**只能给明文行级 LRC**
  （逐字 qrc 是密文，免凭据拿不到）⇒ 全走 `src/ui/lyrics/parse.ts` 的**伪逐字**
  （`pseudoWords()`）⇒ **字级时间戳是按音节权重插值编造的**。

### 1.2 为什么「伪逐字」是错的（不是不够好，是不该有）

伪逐字让界面**看起来**在做逐字卡拉OK，但它推进的边界是**猜**的：

| | 真逐字 | 伪逐字 |
|---|---|---|
| 词边界来源 | **源给的** `<mm:ss.xx>` 标签 | 按音节权重**插值** |
| 词边界是否落在真实音节上 | 是 | **否**（几乎必然对不上） |
| 扫光边界与人声的关系 | 跟嘴 | **随机漂移** |

⇒ 用户看到的现象就是「扫光在动，但就是不对」。

**这比不做更糟**：一个诚实的「整行高亮」不会被误读成「时间戳不准」；
一个假的扫光会让用户以为「歌词源不准」，从而去找根本不存在的词源问题。

### 1.3 用户决策（2026-11-10，原话）

> 「你可以做一个判断，满足行字时间戳的歌词就用卡啦OK模式，不满足的就正常整行显示就好」

⇒ **本任务只做这个判断与它的呈现**，**不追新词源**。

---

## 二、决策

### 2.1 判定口径

**逐行**判定：这一行的**词级时间戳是不是源给的**。

| 情况 | 判定 | 呈现 |
|---|---|---|
| 该行有显式逐字标签（`<mm:ss.xx>`） | **真逐字** | 现有卡拉OK 填色（一字不变） |
| 该行只有行级标签（`[mm:ss.xx]`） | **伪逐字** | **不画逐字着色层**；当前行**整行**强调色 |

⚠️ **逐行**而不是逐文件：真实文件里两种行可以混存
（外部源的增强 LRC 里，逐字标签只覆盖部分行是常见形态）。

### 2.2 「整行显示」的具体观感（用户已拍板）

- **当前行**：整行用 `var(--accent)`（强调色）；
- **其余行**：默认色。

⚠️ 这与真逐字下「已唱过的词是强调色」**语义一致** —— 只是粒度从**词**退化成**行**：

```
真逐字：  这 一 句  ← 词级填色，边界随人声走
伪逐字：  这 一 句  ← 整行一个色，不假装有边界
```

### 2.3 判定的落点

判定必须发生在**伪逐字被创造出来的那一刻**，也就是 `parse.ts` 的 `assemble()`。
渲染层拿到的 `LyricLine` 自带这个事实，**不需要重新推断**。

---

## 三、数据模型

### 3.1 `LyricLine`（`src/ui/lyrics/parse.ts`）

```ts
export type LyricLine = {
  time: number
  text: string
  words: LyricWord[]
  translation: string
  /**
   * 这一行的**词级时间戳是不是源给的**（真逐字）。
   *
   * - `true`：有显式逐字标签 ⇒ **真逐字** ⇒ 卡拉OK 填色；
   * - `false`：只有行级标签 ⇒ **伪逐字**（词级时间是插值编造的）⇒ 整行显示。
   *
   * ⚠️ **可选字段、缺省视为 `true`**：既有代码与测试里手写的 `LyricLine`
   *    （以及外部构造的）都不带这个键 ⇒ 一律按「有逐字」处理 ⇒
   *    **既有行为一条不变**。
   */
  wordTimed?: boolean
}
```

### 3.2 `LyricOverlayLine`（`shared/playerBridge.ts`）

⚠️ `shared/` **不许**依赖 `src/` ⇒ 这里**独立声明**同名字段
（与该文件既有约定一致：`LyricOverlayLine` 与 `LyricLine` 结构完全相同，可直接赋值）。

### 3.3 `assemble()` 的标记（`src/ui/lyrics/parse.ts`）

```
current.words 来自 parseWordSegments（真逐字）  ⇒ wordTimed: true
current.words 来自 pseudoWords（插值编造）      ⇒ wordTimed: false
```

⚠️ **伪逐字的数据本身保留**（`words` 仍然算出来）：双行推进、`computeLineProgress`
等纯函数照旧工作 —— 本任务只改**呈现**，不改**数据管线**。

---

## 四、数据流（跨进程边界）

```
parse.ts  parseLyricEntries
   └─ LyricLine { wordTimed }
        │
        ├─ 主窗口渲染进程：LyricView（全屏歌词舞台）
        │
        └─ 主进程  sanitizeLyricMessage（IPC 边界）★必须透传★
                 └─ LyricOverlayLine { wordTimed }
                      ├─ 经典悬浮窗渲染进程：LyricOverlay → LyricView
                      └─ 灵动态词岛渲染进程：IslandApp → LyricView
```

★ **关键风险点**：`electron/ipc.ts` 的 `sanitizeLyricMessage()` 是**白名单式重建**
（它只认 `time` / `text` / `words` / `translation`）⇒ **不显式透传 `wordTimed`，
它会在 IPC 边界被洗掉** ⇒ 悬浮窗与词岛会把伪逐字**误判成真逐字** ⇒ 假扫光复活。

⇒ 本任务必须在 `sanitizeLyricMessage()` 里补上这一行透传，并**为此写一条钉子测试**。

---

## 五、渲染规则（`src/ui/lyrics/LyricView.tsx`）

### 5.1 分流点：`renderLine()`

所有模式（`single` / `double` / `current` / `all`）的每一行最终都过 `renderLine()`
⇒ **改一处，三处页面（词岛 / 经典浮窗 / 全屏舞台）行为一致**，不会漏。

### 5.2 伪逐字分支

```
wordTimed === false
  ├─ **不渲染** `.fnm-lyricview__overlay`（逐字着色层）
  │    ⇒ DOM 里没有 `[data-word]` 元素 ⇒ 没有任何词级钩子
  ├─ 行元素加类 `fnm-lyricview__line--whole`
  │    ⇒ CSS：color: var(--accent)  ⇒ 整行强调色
  └─ 颜色由「该行是否已开始/已唱完」决定：
       progress !== null && (progress.completed || progress.wordIndex >= 0)
```

⚠️ **颜色判据用 `progress`**：这样 double 模式下「已唱完的那一行」也是整行强调色、
「还没唱的那一行」是默认色 —— 与真逐字下的观感**逐条对应**。

### 5.3 真逐字分支

**一字不改**：overlay 照旧渲染、`--sung` / `--karaoke` / `data-karaoke-progress`
全部照旧、`activeWordClassName` 钩子照旧。

### 5.4 CSS（`src/ui/lyrics/lyric-view.css`）

新增一条规则：

```css
/* 伪逐字（只有行级时间戳）：当前行**整行**强调色，不假装逐字。 */
.fnm-lyricview__line--whole {
  color: var(--accent);
}
```

⚠️ **颜色只用语义变量**（`--accent`）⇒ 两套主题自动一致；**不硬编码颜色**。

---

## 六、影响文件清单

| 文件 | 改动 |
|---|---|
| `src/ui/lyrics/parse.ts` | `LyricLine` 加 `wordTimed?: boolean`；`assemble()` 按来源打标 |
| `shared/playerBridge.ts` | `LyricOverlayLine` 加同名字段 |
| `electron/ipc.ts` | `sanitizeLyricMessage()` 透传 `wordTimed` |
| `src/ui/lyrics/LyricView.tsx` | `renderLine()` 分流：伪逐字不渲染 overlay + 加 `--whole` |
| `src/ui/lyrics/lyric-view.css` | 新增 `.fnm-lyricview__line--whole` |
| `test/lyric-word-timed.test.ts`（新） | 新行为钉子（解析 / 渲染 / IPC / 三个页面） |
| `test/lyric-karaoke-pages.test.tsx` | **改写** 1 条前提被推翻的断言 |
| `docs/changelog.md` / `docs/calibration.md` / `README.md` | 文档 |

---

## 七、验收点

1. `tsc --noEmit -p tsconfig.json` 通过；
2. `vitest run` **全绿**（既有测试**一条不删**；只**改写** 1 条前提被显式推翻的断言，
   改写后**仍保留鉴别力**）；
3. `npm run build` 通过；`npm run e2e:only` 通过；
4. **真机取证**：
   - 只有行级时间戳的歌 ⇒ 三处页面**都没有** `--karaoke` / `[data-word]` 元素，
     当前行**整行**是强调色；
   - 有真逐字的歌（网易云 yrc）⇒ 扫光**照旧**（词级填色 + `data-karaoke-progress`）；
5. **变异自证**（每条一条必红）：
   - 把 `wordTimed` 的判定反过来（真逐字也走整行）⇒ 卡拉OK 钉子红；
   - 去掉 IPC 的 `wordTimed` 透传 ⇒ 悬浮窗/词岛钉子红；
   - 把 `--whole` 的 CSS 改成别的色 ⇒ CSS 契约钉子红。

---

## 八、不做什么（out of scope）

- ❌ **不接新词源**（T74a「酷狗 KRC」已放弃并**整体回滚**，见台账）；
- ❌ **不改**逐字时间戳的**精度**（整体偏移仍是 T72 的手动滑块，未动）；
- ❌ **不删**伪逐字数据（`words` 仍算出来，只是不用于**呈现**）；
- ❌ **不加**「强制卡拉OK」开关（用户明确：伪逐字就整行显示）；
- ❌ **不改**三处页面的「当前行」判定（T79 已统一为 `findActiveLine`）。

---

## 九、对用户的可见后果（⚠️ 已知并接受）

用户当前用 **QQ 源**（只有行级 LRC）⇒ **本任务上线后，扫光会完全消失**，
变成「当前行整行强调色」。这是本方案的本意（不假装逐字），但用户会**明显感到变化**：

- 想看到卡拉OK ⇒ 需要切到**能给真逐字**的源（实测网易云 yrc 覆盖约 **27%** 的歌，
  且**大牌歌常常没有**）；
- 这也正是 T74a（酷狗 KRC，实测真逐字 **89%~100%**）原本要解决的问题 ——
  **但用户已选择「先修观感，不追词源」**，故 T74a 回滚。
