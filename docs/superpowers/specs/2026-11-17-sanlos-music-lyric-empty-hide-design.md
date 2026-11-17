# T106 规格：**没有歌词就不显示桌面歌词 / 灵动歌词**

> 状态：**规格先行**（实现前定稿）。
> 起草：2026-11-17。
> 起因：用户 2026-11-17 的两句话 ——
> ①「匹配不到歌词也没有内嵌歌词的情况下，**不要显示桌面歌词和灵动歌词**」；
> ②「有歌词匹配不准确的，应该可以**手动选择歌词**」（⇒ **另开任务 T107**，本轮不做）。

---

## 一、这一轮要解决什么（一句话）

**有歌、但这首歌没有歌词**（线上没匹配上 ＋ 音频内嵌也没有）⇒
经典悬浮窗与灵动态词岛**都不该出现**（现在会弹一个空窗 / 一个空胶囊，上面写着「暂无歌词」）。

---

## 二、代码事实（不是推测）

| 环节 | 事实 |
|---|---|
| 歌词从哪来 | 渲染层 `src/player/lyricSource.ts` 的 `loadLyricEntries()`：线上（外部源）→ 内嵌 → NAS；**取不到就返回 `entries: []`** |
| 谁推给窗口 | 渲染层 `src/player/lyricOverlay.ts` 把「曲目 ＋ 歌词」推给主进程（`kind: 'track'`） |
| 窗口归谁管 | **主进程**（`electron/main.ts`）：经典窗 `lyricWindow` / 词岛 `islandWindow` |
| 词岛显隐判定 | `electron/islandVisibility.ts` 的 `shouldShowIsland()`（纯函数，T69 抽出来的） |
| 经典窗显隐 | ⚠️ **此前没有任何判定** —— `setLyricVisible(true)` 直接 `createLyricWindow()?.show()` |
| 可见性能怎么验 | ⚠️ Playwright 的 `page.isVisible()` 是 **DOM 级**的（窗口 `hide()` 了 DOM 照样报「可见」）⇒ 必须问主进程 `BrowserWindow.isVisible()`（**OS 级**） |

---

## 三、方案

### ① 判定抽成纯函数（可单测）

**新增** `electron/lyricVisibility.ts`：

| 函数 | 作用 |
|---|---|
| `lyricTrackState(message)` | 把「最近一条曲目消息」翻译成 **3 种状态**：`unknown`（还没收到）/ `no-track`（没歌）/ `has-track`（有歌） |
| `shouldShowClassicLyric({visible, trackState, hasLyrics})` | 经典窗该不该显示 |

**改** `electron/islandVisibility.ts`：`shouldShowIsland()` **加一个条件** `hasLyrics`。

### ② 三种曲目状态（为什么不能只看「有没有歌词」）

| 状态 | 经典窗 | 词岛 |
|---|---|---|
| `unknown`（还没收到渲染层的消息） | **不显示** | 不显示 |
| `no-track`（没歌） | **显示**（「未在播放」＝**既有行为，一字不改**） | 不显示（本来就要 `playing`） |
| `has-track` ＋ 有歌词 | 显示 | 显示（另加 `playing`） |
| `has-track` ＋ **没歌词** | **不显示**（T106 的核心） | **不显示**（T106 的核心） |

⚠ **为什么要有 `unknown`**：用户「打开桌面歌词」时，主进程**不知道**当前这首有没有歌词
（歌词是渲染层去取的）⇒ 若按**旧状态**显示，会闪一下**上一首**的歌词
⇒ 打开时先**不显示**，等渲染层把当前曲目的歌词状态推过来（`kind: 'track'`）再决定
⇒ **宁可不显示，也不显示错的**。

### ③ 主进程接线（`electron/main.ts`）

| 改动 | 说明 |
|---|---|
| **新增** `let lyricHasLyrics = false` | **临时态，不落盘**（与 `lyricPlaying` 同款） |
| `onLyricState` | `kind: 'track'` 的消息 ⇒ 顺带更新 `lyricHasLyrics`（`lines.length > 0`）⇒ **先更新状态、再判定显隐、最后转发**（沿用 T69 的顺序） |
| **新增** `applyClassicLyricVisibility()` | 经典窗的显隐入口（对称于 `applyIslandVisibility()`） |
| `setLyricVisible` | classic 分支改走 `applyClassicLyricVisibility()`；**关掉时作废**缓存的曲目状态（`lastTrackMessage = null`）⇒ 下次打开先不显示 |
| `setLyricMode` | classic 分支同样改走判定 |

⚠ **死锁纪律**（T69 踩过）：「无歌词 ⇒ 收起」**只能**是**主进程内部的临时态** ——
**不落盘、不发 `lyric:visibility`** ⇒ 渲染层继续推送 ⇒ 主进程才知道
「下一首有歌词了」⇒ 窗口能自己回来。

---

## 四、改动清单

| 层 | 文件 | 改什么 |
|---|---|---|
| 领域 | `electron/lyricVisibility.ts`（**新**） | `lyricTrackState()` / `shouldShowClassicLyric()` |
| 领域 | `electron/islandVisibility.ts` | `shouldShowIsland()` 加 `hasLyrics` 条件 |
| 接线 | `electron/main.ts` | `lyricHasLyrics` 临时态 ＋ `applyClassicLyricVisibility()` ＋ 两处分支改走判定 ＋ 关掉时作废缓存 |
| 测试 | `test/lyric-visibility.test.ts`（**新**） | 经典窗判定的纯函数测试（含真值表） |
| 测试 | `test/island-visibility.test.ts` | 既有断言**各加一个输入**（`hasLyrics: true`）⇒ 结论一条不变；**新增**「没歌词 ⇒ 不显示」 |
| 测试 | `test/island-visibility-wiring.test.ts` | **改写 1 条**（经典分支「一字未改」—— 前提被用户的新要求推翻）＋ **新增 6 条**接线断言 |
| 测试 | `test/lyric-window-replay.test.ts` | 断言从「整行字面量」改成「**赋值在 track 分支里面**」⇒ 强度不减反增 |
| E2E | `e2e/t106-lyric-empty-hide.spec.ts`（**新**） | 真实 Electron：无歌词的歌 ⇒ **经典窗 / 词岛都不出现**；换成有歌词的歌 ⇒ **自己出现** |

---

## 五、验收点

1. **无歌词的歌** ⇒ 经典悬浮窗**不出现**、灵动态词岛**不出现**（真实 Electron，mock NAS）；
2. **有歌词的歌** ⇒ 两个窗口**自己出现**（**不依赖**用户再点一次开关）；
3. 窗口**没被干掉**（词岛仍在，只是隐藏）⇒ 不是「删窗口」而是「不显示」；
4. 「没歌 ⇒ 经典窗显示『未在播放』」这条**既有行为一字不改**；
5. **既有测试一条不许删、断言一条不许弱化**（改写的两处都**更强**）；
6. 变异自证：去掉 `hasLyrics` 条件（经典窗 / 词岛各一条）＋ 主进程不更新状态 ⇒ **E2E 必须变红**。

---

## 六、待校准 / 遗留

- ⚠ **T107**：「有歌词匹配不准确的，应该可以**手动选择歌词**」⇒ **本轮不做**，另开任务
  （按歌选源 / 恢复自动 / 候选挑选 ⇒ 交互形态待用户拍板）；
- ⚠ **桌面歌词仍会为有声读物（有声小说）去查歌词**（`src/player/lyricOverlay.ts` 不知道那是有声）
  ⇒ 本轮只是让它**不显示**（查的成本仍在）⇒ 可另开小任务；
- ⚠ 本轮**没有真机复验**（真实 NAS ＋ 真实账号）⇒ 界面效果**待用户在真机上确认**；
- ⚠ 真机实测数字一律**不写死**。
