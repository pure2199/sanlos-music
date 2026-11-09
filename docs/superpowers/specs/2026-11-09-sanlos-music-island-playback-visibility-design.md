# T69 规格：灵动歌词栏 —— 没有播放 / 暂停时不显示

> 日期：2026-11-09
> 前置：T66（歌词对时）→ T67（网易云 yrc 真逐字）→ T68（修「真逐字填充整行失效」）
> 状态：规格先行，实现另起一个 commit
> ⚠️ **编号顺延**：原「T69 手动歌词偏移滑块」顺延为 **T70**；原「T70 多源聚合」顺延为 **T71**。

---

## ① 起因

用户要求：**「先改灵动歌词，歌曲没有播放时，暂停时，不显示灵动歌词栏」**。

现状：灵动态词岛是**常驻**窗口 —— 应用一启动就显示一个胶囊，哪怕**从来没播放过**任何歌；
暂停时它也一直挂在屏幕顶部（显示暂停时的那一行）。

---

## ② 现状（已核实）

| 事实 | 位置 |
| --- | --- |
| 词岛窗口由主进程 `createIslandWindow()` 创建（`show: false`，随后 `show()`） | `electron/main.ts` |
| 窗口显隐由 `setLyricVisible()` / `setLyricMode()` 控制 | `electron/main.ts` |
| `lyricVisible`（用户意图，**落盘**）与 `lyricMode` 是模块级状态 | `electron/main.ts` |
| **主进程已经拿得到播放状态**：`lyric:state` 的 `progress` 消息**本来就带** `isPlaying` | `shared/playerBridge.ts` |
| 「没有歌」也有信号：`publishTrack()` 在无歌时推 `{ kind: 'track', track: null }` | `src/player/lyricOverlay.ts` |
| 暂停 / 恢复**一定会**推一次 progress（`state.isPlaying !== previous.isPlaying`） | `src/player/lyricOverlay.ts` |
| 鼠标淡出是**词岛渲染层自己的 CSS**；主进程只轮询指针位置并发 `lyric:pointer` | `electron/main.ts` / `src/island/IslandApp.tsx` |
| `lyric:visibility` **只在 `setLyricVisible()` 里发** | `electron/main.ts` |

---

## ③ 根因 / 为什么不能「顺手复用现有开关」

`setLyricVisible(false)` 会做三件事：**hide 窗口** + **落盘** `visible: false` +
**发 `lyric:visibility(false)`**。

而渲染层收到 `lyric:visibility(false)` ⇒ `enabled = false` ⇒ **不再推任何 `lyric:state` 消息**
（`store.subscribe` 开头就 `if (!enabled) return`）。

⇒ **若把「暂停」实现成 `setLyricVisible(false)`**：
1. 渲染层停止推送 ⇒ 主进程**再也收不到** `isPlaying: true`；
2. 恢复播放后，词岛**永远不会再出现**（**死锁**）；
3. 用户的「桌面歌词开着」偏好被写成 `false` ⇒ 下次启动也不开。

⇒ **所以「暂停隐藏」必须是纯主进程内部的临时态**：
- **不动** `lyricVisible`（不落盘）；
- **不发** `lyric:visibility`（渲染层继续推 `isPlaying`，我们才能知道什么时候该回来）。

---

## ④ 口径（定死）

### 词岛窗口的**实际**可见性

```
shouldShow = 用户开着桌面歌词（lyricVisible）
          && 当前形态是词岛（lyricMode === 'island'）
          && 正在播放（lyricPlaying）
```

- `lyricVisible` / `lyricMode` —— 用户意图（落盘）；
- `lyricPlaying` —— 主进程从 `lyric:state` 得知的**临时态**（**不落盘**）。

### `lyricPlaying` 的更新规则

| 收到的消息 | `lyricPlaying` |
| --- | --- |
| `{ kind: 'progress', isPlaying }` | **直接置为** `isPlaying` |
| `{ kind: 'track', track: null }` | **置为 `false`**（没有歌 ⇒ 不可能在播） |
| `{ kind: 'track', track: {...} }` | **保持原值**（切歌不代表播放状态变了） |

⚠️ 初值 **`false`** ⇒ 启动时即使偏好是「开着 + 词岛形态」，**没有歌就不显示**（正是用户要的）。

### 改动点（主进程）

1. 新增模块级 `let lyricPlaying = false`；
2. 新增 `applyIslandVisibility()`：**只在「应显示」与「当前是否可见」不一致时**才动手
   （`progress` 是 ~4Hz 的高频消息 ⇒ 不加守卫就会反复 `show()`）；
3. `onLyricState` 里更新 `lyricPlaying` 后调 `applyIslandVisibility()`；
4. `setLyricVisible()` / `setLyricMode()` 的 **island 分支**改走 `applyIslandVisibility()`；
   **classic 分支一字不变**。

### 明确**不改**

- `src/island/IslandApp.tsx`（词岛渲染层）、`src/player/lyricOverlay.ts`（推送侧）、
  `src/ui/lyrics/*`、`electron/preload.ts`、`shared/playerBridge.ts`；
- **经典悬浮窗**（classic 形态）的显隐行为 —— **一字不变**；
- `lyricVisible` 的落盘语义、`lyric:visibility` 的发送时机。

---

## ⑤ 影响文件

| 文件 | 改动 |
| --- | --- |
| **新增** `electron/islandVisibility.ts` | 两个纯函数：`shouldShowIsland()`（可见性判定）、`playingFromLyricMessage()`（从消息推播放状态） |
| `electron/main.ts` | 新增 `lyricPlaying` 状态 + `applyIslandVisibility()`；`onLyricState` / `setLyricVisible` / `setLyricMode` 的 island 分支接入 |
| **新增** `test/island-visibility.test.ts` | 纯函数用例（判定真值表 + 消息 → 播放状态） |
| `docs/changelog.md`、`README.md` | 用户可见变化 |

---

## ⑥ 验收

- **纯函数单测**（新增）：`shouldShowIsland` 真值表（用户关 / 经典形态 / 没在播 ⇒ 都不显示）；
  `playingFromLyricMessage`（progress 更新、track(null) ⇒ false、track(非 null) ⇒ 保持）；
- `tsc --noEmit` **exit 0**；
- `vitest run`：**只增不减**；
- Playwright E2E：**24/24 全绿**；
- 字节级自检：无 U+FFFD、无 NUL、无 BOM，行尾保持原样；
- **用户侧复验**：
  ① 没歌时**看不到**词岛胶囊；
  ② 开始播放 ⇒ 胶囊出现；
  ③ 暂停 ⇒ 胶囊消失；
  ④ 恢复播放 ⇒ 胶囊**重新出现**（**无死锁** —— 这是本任务最关键的一条）；
  ⑤ 经典悬浮窗**仍按老行为**显示。

---

## ⑦ 遗留

- ⚠️ 「整体固定偏移」仍未修（⇒ **T70** 手动歌词偏移滑块）；
- ⚠️ 「更多歌有真逐字」仍未做（⇒ **T71** 多源聚合 + 逐字优先）；
- ⚠️ 本任务**不做**「暂停时保留歌词但不显示胶囊」以外的任何暂停态设计
  （例：暂停时在主窗口内显示歌词）—— 那是产品决策，另议。
