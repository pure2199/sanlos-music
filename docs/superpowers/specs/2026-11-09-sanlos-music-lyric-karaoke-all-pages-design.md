# T71 规格：卡拉OK 渐进填色 + 行/字时间戳 —— 推广到所有歌词页面

> 日期：2026-11-09
> 前置：T66（歌词对时）→ T67（网易云 yrc 真逐字）→ T68（修「真逐字填充整行失效」）→ T69（灵动歌词可见性）→ T70（歌词来源优先级）
> 状态：规格先行，实现另起一个 commit
> ⚠️ **编号**：本任务是 **T71**；「手动歌词偏移滑块」= **T72**、「多源聚合 + 逐字择优」= **T73**（编号已顺延到位，本任务**不再**顺延）。

---

## ① 起因

用户指令：**「将灵动歌词的卡啦OK模式和行字时间戳功能拓展到所有歌词页面」**。

动机：灵动歌词（词岛）里当前词是**连续填色**、且能吃**真逐字**时间戳；
而经典悬浮窗与全屏歌词舞台还是**整词跳变**（词一到就整词变色 ⇒ 每个词边界都「闪一下」）
⇒ 同一个应用里三处歌词的观感与跟嘴程度**不一致**。

---

## ② 现状（已核实，非推测）

### 2.1 全仓库只有 **3 个**渲染歌词的地方

| 歌词页面 | 组件 | `LyricView` 模式 | 卡拉OK | 词级时间戳来源 |
| --- | --- | --- | --- | --- |
| 灵动态词岛 | `src/island/IslandApp.tsx` | `single` | ✅ **已开** | 主窗口经 IPC 推送 |
| 经典悬浮窗 | `src/ui/lyrics/LyricOverlay.tsx` | `double` | ❌ **没开** | 主窗口经 IPC 推送（同一份） |
| 全屏歌词舞台 | `src/pages/FullPlayerPage.tsx` | `all` | ❌ **没开** | 自己拉（同一个取词函数） |

- 主窗口播放条（`src/components/PlayerBar.tsx`）**不显示歌词** ⇒ 「所有歌词页面」= 上面三处。
- `grep` 依据：`LyricView` 的全部引用点只有 `IslandApp.tsx` / `LyricOverlay.tsx` / `FullPlayerPage.tsx`
  （其余命中全在 `test/`）。

### 2.2 卡拉OK：**组件层能力已具备，缺的是「开关没打开」**

- `LyricViewProps.karaoke`（`src/ui/lyrics/LyricView.tsx`）已经贯通三条渲染路径：
  `single`（`renderLine`）、`double`（`renderLine`）、`all`（`AllLyricLine` → `renderLine`）。
- CSS 规则 `.fnm-lyricview__word--karaoke` 在**全局样式表** `src/ui/lyrics/lyric-view.css`
  ⇒ 三个窗口都吃得到，**不需要新写样式**。
- 词岛是**唯一**传 `karaoke` 的调用点 ⇒ 另两处仍走「整词跳变」。

### 2.3 行/字时间戳：**已经全链路贯通**（逐段查证）

```
主窗口渲染进程
  installLyricOverlay (src/player/lyricOverlay.ts)
    └─ loadLyricEntries(…, { priority })          ← T70：线上优先 → 网易云 yrc 真逐字
         └─ parseLyricEntries(entries)           ← 产出 line.words[]（词级 start/end）
    └─ applyAudibleLatency(lines, latency)       ← src/ui/lyrics/timing.ts
         └─ applyOffset(...)                    ← src/ui/lyrics/parse.ts:504
              ⚠️ **同时**平移 line.time 与 word.start / word.end
    └─ pushLyricState({ kind: 'track', lines })  ← 推给主进程
主进程
  sanitizeLyricMessage (electron/ipc.ts:1655)
    ⚠️ **逐字保真**保留 words[].text / .start / .end（只丢非有限数）
  webContents.send('lyric:state', …)
悬浮窗 / 词岛渲染进程
  mergeLyricMessage (src/ui/lyrics/overlayState.ts)  ← 原样保留 message.lines
  └─ LyricView（mode = double / single）
全屏歌词舞台
  loadLyricEntries → parseLyricEntries → applyAudibleLatency → LyricView（mode = all）
```

⇒ **本任务不为「行/字时间戳」改代码**，只补**回归测试**
（钉住「词级时间戳过 IPC 清洗后仍然逐字保真」——这是最容易在后续改动里被悄悄洗掉的一环）。

---

## ③ 口径（定死）

### 3.1 卡拉OK 从「词岛专属」提升为「歌词视图的默认观感」

- `LyricViewProps.karaoke` 的**缺省值由 `false` 改为 `true`**；
- 显式传 `karaoke={false}` 仍可关闭（能力保留）；
- **三个调用点都不必再各自传** ⇒ **单一来源**：将来新增歌词页面自动就是卡拉OK，不会再漏一处。

### 3.2 为什么不是「每页各自传 `karaoke`」

| 方案 | 问题 |
| --- | --- |
| 缺省 `false` + 三个页面各自显式传 | ① 语义变成「按页 opt-in」，将来新增页面**必然漏**；② 同一件事写三遍（且三遍都成了**冗余代码**——改缺省不影响它们、删掉也不影响行为 ⇒ **不可测、变异抓不住**）。 |
| **缺省 `true`（本方案）** | 行为只由**一处**决定；「缺省就是卡拉OK」与「三个页面都有卡拉OK」两条断言各自可被变异打红。 |

### 3.3 行为细节（与 T48 一致，不新增语义）

- **当前词**（正在被唱的那一个词）：挂 `--karaoke`，由**词内连续比例**（`LyricWordProgress.wordProgress`）
  驱动渐变填色 ⇒ 颜色边界**连续推进**；
- **当前词不再**整词上色（`--sung`）——否则整词已是强调色，填色看不见了；
- **已唱过的词**照旧整词上色（`--sung`）；**没唱到的词**不上色；
- 该行**已走满** ⇒ 没有「当前词」⇒ 整行都是 `--sung`（不做填色）。

---

## ④ 影响文件

### 4.1 源文件

| 文件 | 改动 |
| --- | --- |
| `src/ui/lyrics/LyricView.tsx` | **行为改动**：`karaoke` 缺省 `false` → `true`；props 文档改写（「缺省 = 开；显式 `false` 才关」） |
| `src/ui/lyrics/LyricOverlay.tsx` | 注释：经典悬浮窗现在也是卡拉OK（由组件缺省带来） |
| `src/pages/FullPlayerPage.tsx` | 注释：歌词舞台现在也是卡拉OK |
| `src/island/IslandApp.tsx` | 注释同步（显式 `karaoke` 保留 —— 词岛是参考实现，一眼可见） |

### 4.2 测试

| 文件 | 改动 |
| --- | --- |
| `test/lyric-view.test.tsx` | **改写 1 条** + **新增 1 条**（见 ⑤） |
| `test/lyric-view-all.test.tsx` | **改写 1 条**（见 ⑤） |
| `test/lyric-overlay.test.tsx` | **新增**：经典悬浮窗出 `--karaoke`，且填色比例按**词级时间戳**推进 |
| `test/lyric-karaoke-pages.test.tsx`（**新增**） | ① 三个歌词页面**都**有卡拉OK；② **行/字时间戳贯通**回归：yrc 真逐字 → `sanitizeLyricMessage` → `mergeLyricMessage` → 渲染，词级 `start/end` **逐字保真**且填色按真实词时间推进 |

### 4.3 文档

| 文件 | 改动 |
| --- | --- |
| `docs/changelog.md` | T71 条目（⚠️ 该文件是 **CRLF**，改动须保持行尾） |
| `README.md` | T71 条目 |

---

## ⑤ 既有断言改写说明（前提被用户指令**显式推翻**，共 2 条）

| 位置 | 原断言 | 改写为 | 为什么前提被推翻 |
| --- | --- | --- | --- |
| `test/lyric-view.test.tsx:421` | 「**没开** karaoke → 行为一字不变」（不传 `karaoke` ⇒ 整词上色、无填色钩子） | 「**显式** `karaoke={false}` → 行为一字不变」（当前词 `--sung`、无 `--karaoke`、无 `data-karaoke-progress`）**并新增**「**缺省**就是卡拉OK」 | 「卡拉OK 只在显式开启时才有」这个前提，被「卡拉OK 推广到所有歌词页面」**显式推翻**：缺省即为开 |
| `test/lyric-view-all.test.tsx:69` | 当前行有**至少一个** `--sung` | 当前行：**已唱过的词**是 `--sung`（≥1）**且当前词**是 `--karaoke`（恰好 1 个） | 同上：当前词在卡拉OK 下**不再**整词上色 ⇒ 原断言的「有 `--sung`」依赖「当前词恰是已唱词」这一巧合（该用例 t=12 时当前词正是第一个词） |

⚠️ **一条用例都不删**；改写后**断言强度只增不减**（原「有 `--sung`」被拆成「已唱词 `--sung`」+「当前词 `--karaoke`」两条更强的事实）。

---

## ⑥ 验收点

1. `tsc --noEmit` **0 错误**；
2. `vitest` **全绿**，且用例**条数只增不减**（除 ⑤ 的 2 条改写）；
3. **变异自证 ≥ 6 点全红**（含：`LyricView` 缺省改回 `false` / 去掉 `--karaoke` 类 / 填色比例写死 / IPC 清洗丢掉 `words` / `mergeLyricMessage` 丢掉 `lines` / 某页面显式关掉卡拉OK）；
4. `npm run build` **0 错误**；
5. E2E **24/24**（不回归）；
6. **字节自检**：无 BOM / 无 U+FFFD / 无 NUL / 行尾与原文件一致 / 中文片段 `includes()` 命中；
7. **2 个 commit**（规格先行）→ push → **CI 绿**；
8. 台账补 T71 小节。

---

## ⑦ 本任务**不做**的事（避免扩范围）

- ❌ 卡拉OK 的**设置开关**（用户未要求；需要动 `prefs.json` 管线）——若要，另开任务；
- ❌ **手动歌词偏移滑块**（= T72）；
- ❌ **多源聚合 + 逐字择优**（= T73）；
- ❌ 改「整体固定偏移」的既有语义（= T72）。

---

## ⑧ 遗留 / 待真机项

- **真逐字仍取决于线上 yrc 命中**：NAS 本地只有行级 LRC ⇒ 填色按**伪逐字加权**推进（T66），
  跟嘴程度不如 yrc；这是**数据源**的局限，不是渲染的局限。
- **待真机确认**：三处页面的填色观感（当前词填色边界是否连续、已唱词是否仍是强调色）、
  经典悬浮窗的透明窗背景上 `--accent` 的对比度。
- `background-clip: text` 在三处窗口均为同一套 Chromium 栈 ⇒ 词岛已验证过的效果可外推；
  全屏舞台的 `--accent` 在**封面取色背景**上的对比度需真机看一眼。
