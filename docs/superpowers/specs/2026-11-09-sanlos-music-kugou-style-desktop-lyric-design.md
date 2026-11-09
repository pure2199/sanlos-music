# T77 —— 桌面歌词（经典悬浮窗）改成「酷狗桌面歌词」样式（规格）

> 用户指令（2026-11-09）：
> 「桌面歌词改成酷狗桌面歌词那样，背景透明，不是需要其他功能就是歌词功能，跟酷狗桌面歌词一样就行了」
>
> 追加确认（同一轮问卷）：
> 1. 功能范围：**纯歌词**（曲名/歌手、播放控制、点击跳转**全去掉**）；
> 2. 鼠标行为：**点穿透**（歌词不挡桌面；代价：不能拖、不能点 —— 已知并接受）；
> 3. 文字配色：**固定白字 + 深色描边/阴影**（不跟主题走，任何壁纸都看得清）。

---

## ① 现状（**已查证**，非推测）

经典悬浮窗（`prefs.lyricOverlay.mode = 'classic'`）的构成：

| 部位 | 代码 | 内容 |
|---|---|---|
| 窗口 | `electron/main.ts` `createLyricWindow()` | 560×200、`frame:false`、**`transparent:true`**、`alwaysOnTop`、`resizable:false`、**不点穿透** |
| 底板 | `src/ui/lyrics/lyric-overlay.css` `.fnm-lyricoverlay` | `background: var(--surface-raised)` + 1px 边框 + 圆角 ⇒ **不透明面板** |
| 标题条 | `LyricOverlay.tsx` `<header>` | 曲名 + 歌手（兼**拖动把手** `-webkit-app-region: drag`） |
| 播放控制 | `LyricOverlay.tsx` `.fnm-lyricoverlay__controls` | 上一首 / 播放暂停 / 下一首 |
| 歌词 | `LyricOverlay.tsx` `<LyricView mode="double">` | 双行逐字 + 卡拉OK（T71 已是卡拉OK） |
| 交互 | `LyricOverlay.tsx` `onSeek` | 点歌词行 → 跳转 |

⚠️ 窗口**已经是**透明窗口（`transparent: true`）⇒ 「背景透明」不需要动窗口层，
要动的是**页面里那块不透明底板**（`--surface-raised` + 边框）。

⚠️ **点穿透的后果**（用户已知并接受）：`setIgnoreMouseEvents(true, { forward: true })`
⇒ 窗口收不到点击 ⇒ **不能拖动、不能点击**（酷狗桌面歌词即如此）。
⇒ 因此**默认位置**必须给对（见 ③-D）。

---

## ② 口径（用户已拍板）

1. **纯歌词**：去掉曲名/歌手、播放控制、点击跳转；**只留歌词**（双行逐字 + 卡拉OK **不变**）。
2. **点穿透**：窗口不吃鼠标 ⇒ 不挡桌面。
3. **固定白字 + 深色描边/阴影**：**不跟主题走**（浮在任意壁纸上都看得清）。
4. 词岛（island）与全屏歌词舞台**一字不变**（本任务只管经典悬浮窗）。

---

## ③ 设计

### ③-A 内容组件（`src/ui/lyrics/LyricOverlay.tsx`）

- 删掉 `<header>`（曲名/歌手 + 拖动把手）与 `.fnm-lyricoverlay__controls`（三个按钮）；
- 删掉 `onSeek` / `onCommand` 两个 prop（**不再有**点击跳转与播放控制）；
- 只留 `<LyricView mode="double">`；
- 保留 `track` prop：**没有曲目时显示「未在播放」**（不白屏、不空窗）。

### ③-B 样式（`src/ui/lyrics/lyric-overlay.css`）

- `.fnm-lyricoverlay`：**去掉** `background` / `border` / `border-radius` ⇒ 真正透明；
- 删除 `__head` / `__title` / `__artist` / `__controls` / `__button` 规则；
- 删除 `-webkit-app-region: drag`（点穿透 ⇒ 没有拖动区，留着会误导）；
- **覆盖**共享组件的主题色（`lyric-view.css` 的 `--text-primary` / `--text-secondary`）：
  - 当前行 = `--lyric-float-text`（纯白）；
  - 非当前行 = `--lyric-float-text-dim`（稍暗的白）；
  - 空态文案同样走 dim 白；
- **深色描边/阴影**（Kugou 的做法）：`text-shadow` 四向 1px 描边 + 一点模糊
  ⇒ 任何壁纸上都看得清。
  ⚠️ 阴影放在**本窗的 CSS**里（不放共享的 `lyric-view.css`）：
  `test/lyric-view-css.test.ts` 钉着共享组件里**不许**出现 `text-shadow`
  （T48 的教训：光晕会把卡拉OK 填色边界糊掉）。
  ⚠️ 描边是**深色**（不是同色光晕）且画在**字形外侧** ⇒ 卡拉OK 的填色边界**仍然清晰**。

### ③-C 语义令牌（`src/styles/tokens.css`）

新增三个令牌（**两套主题同值** —— 不跟主题走）：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--lyric-float-text` | 纯白 | 当前行 |
| `--lyric-float-text-dim` | 暗一点的白 | 非当前行 / 空态 |
| `--lyric-float-shadow` | 深黑（半透明） | 描边 + 阴影 |

⚠️ `test/theme.test.tsx` 钉着「两套主题的语义变量集合**完全相同**（不多不少）」⇒
三个令牌**两套主题都要写**（值相同）。

### ③-D 窗口层（`electron/main.ts`）

- 经典窗加 `win.setIgnoreMouseEvents(true, { forward: true })`（点穿透，与词岛同款）；
- 默认高度 `200` → `120`（纯歌词用不了 200：双行歌词 82px + 上下留白 20px）；
- **默认位置**：没有记忆位置时，落在**工作区水平居中、垂直 62%** 处
  （纯函数 `shared/lyricFloatAnchor.ts` ⇒ 可单测；参照 `shared/islandAnchor.ts` 的做法）。

### ③-E 既有断言的改写（**一条不删、强度只增**）

`test/lyric-overlay.test.tsx` 有 3 条断言以「曲名/歌手/播放控制/点击跳转**存在**」为前提，
该前提被用户指令**显式推翻** ⇒ 改写为新行为断言：

| 原断言 | 改写后 |
|---|---|
| 「显示歌名与歌手」 | 「**不再显示**曲名/歌手（纯歌词）」 |
| 「播放控制按钮 → 回调播放命令」 | 「**不再有**播放控制按钮」 |
| 「点歌词行 → 回调跳转秒数」 | 「点歌词**不再**跳转（纯歌词；行不再是 `<button>`）」 |

---

## ④ 验收

- `tsc --noEmit` exit 0；
- `vitest run`：**条数只增不减**（基线 94 文件 / 2025 条）；
- `npm run build` exit 0；
- Playwright E2E：**27/27**（不增不减）；
- **变异自证**：至少 3 条（把底板加回来 / 把点穿透去掉 / 把白字改回主题色）**全红**；
- **真机取证**：截图显示**透明背景 + 白色歌词**（压在桌面上，背景可见）。
