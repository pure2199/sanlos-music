# T70 规格：歌词来源优先级 —— 线上优先，线上匹配不上再回落本地

> 日期：2026-11-09
> 前置：T66（歌词对时）→ T67（网易云 yrc 真逐字）→ T68（修「真逐字填充整行失效」）→ T69（灵动歌词可见性）
> 状态：规格先行，实现另起一个 commit
> ⚠️ **编号顺延**：原「T70 手动歌词偏移滑块」顺延为 **T71**；原「T71 多源聚合」顺延为 **T72**。

---

## ① 起因

用户指令：**「优先使用线上歌词，线上匹配不上再使用本地歌词」**。

动机：线上（网易云 yrc 等）能给出**真逐字**时间戳，本地（NAS 自带）多半只有行级 LRC
⇒ 线上优先 ⇒ 卡拉OK 填色更可能真的跟嘴。

用户同时拍板了三件事：

| 岔口 | 决定 |
| --- | --- |
| 线上那份**没有翻译**、本地那份**有翻译** | **直接用线上的**（逐字优先；不跨源接翻译） |
| 线上源**卡住 / 很慢** | **等 5 秒后回落本地** |
| 这个优先级要不要**做成设置项** | **做成设置项**（默认线上优先，可切回本地优先） |

---

## ② 现状（已核实）

| 事实 | 位置 |
| --- | --- |
| 取词入口：`loadLyricEntries(songId, target, deps)` | `src/player/lyricSource.ts` |
| **当前口径 = NAS 优先 → NAS 没有才查外部**（Task 32） | `src/player/lyricSource.ts` |
| 两个调用方：全屏播放页、桌面悬浮歌词（词岛 / 经典窗都走它） | `src/pages/FullPlayerPage.tsx`、`src/player/lyricOverlay.ts` |
| 线上源由偏好 `prefs.lyric.source` 决定（`off` / `netease` / `lrclib` / `qq` / `custom`，**缺省 `netease`**） | `shared/lyricProvider.ts`、`electron/ipc.ts` |
| 线上「匹配」由 `pickCandidate()` 判定：歌名完全相同 → 歌手相同 → 时长 ±3s；**时长对不上会退回「名字+歌手都对」的第一条** | `electron/lyricProvider.ts` |
| 线上结果三态：`ok` / `not-found`（确实没有）/ `error`（源不可用） | `shared/lyricProvider.ts` |
| `source = 'off'` ⇒ 主进程**一次网络请求都不发**，直接回 `not-found` | `electron/ipc.ts` |
| 主进程已有缓存：成功 LRU 64 条、失败 5 分钟 TTL | `electron/lyricProvider.ts` |
| 渲染层**永不碰网络**：外部源一律经 IPC 到主进程 | `src/player/lyricSource.ts` |
| `prefs.json` 的 `lyric` 组**整体替换**（`PrefsStore.write` 只在**顶层**合并） | `electron/ipc.ts` |

---

## ③ 口径（定死）

### 3.1 优先级 = **设置项**

- 新增偏好 `prefs.lyric.priority`：`'online-first'`（**缺省**）/ `'local-first'`；
- 缺省 = `online-first` ⇒ **老用户升级后行为会变**（这是用户显式要求的）；
- 设置页「歌词来源」那一组里加一个**二选一**（沿用「桌面歌词样式」那组的 radio 写法，
  带**专属 `aria-label`**，避免可访问名不稳）。

### 3.2 线上优先的判定与回落

```
线上匹配上（有可用原文）      ⇒ 用线上的（origin = 'external'）
线上匹配不上 / 源不可用 / 超时 ⇒ 回落到本地（origin = 'nas'）
```

「线上匹配不上」= 下列**任一**：

| 线上结果 | 判定 |
| --- | --- |
| `not-found` | 匹配不上 |
| `error` | 源不可用 ⇒ **同样回落本地**（线上坏不该让你看不到本地已有的歌词） |
| 抛异常 | 同 `error` |
| 超过 **5 秒**没回来 | 超时 ⇒ 回落本地 |
| `ok` 但原文与翻译**都为空** | 视同匹配不上 |

⚠️ **没有外部取法**（`external` 为 `null`）⇒ **零外部请求**，直接用本地。

### 3.3 「本地优先」= **老行为一字不变**

`priority = 'local-first'` ⇒ NAS 优先 → NAS 没有才查外部（Task 32 原逻辑，**代码路径保留**）。

### 3.4 原因语义（如实汇报）

| 情况 | `origin` | `reason` |
| --- | --- | --- |
| 线上 ok（有内容） | `external` | `null` |
| 线上匹配不上 / 报错 / 超时，**本地有** | `nas` | `null` |
| 线上匹配不上，**本地也没有** | `none` | `null`（界面显示「暂无歌词」，**不是**错误） |
| 线上**报错**，本地也没有 | `none` | 线上那条错误消息（如「网易云返回 429」） |
| 线上**超时**，本地也没有 | `none` | 「歌词源响应超时」 |
| **本地读取失败**（NAS 报错），本地也没有 | `none` | 「歌词加载失败」（**保既有语义**） |

⚠️ 优先级：本地读取失败 > 线上报错 > 线上超时 > 无。
⚠️ 线上报错但本地**有**歌词 ⇒ `reason = null`（有歌词就别报错）。

---

## ④ 影响文件

| 文件 | 改动 |
| --- | --- |
| `shared/lyricProvider.ts` | **新增** `LyricPriority` 类型、`LYRIC_PRIORITIES`、`DEFAULT_LYRIC_PRIORITY`、`normalizeLyricPriority()` |
| `shared/playerBridge.ts` | `AppPrefs.lyric` 加 `priority?: LyricPriority` |
| `electron/ipc.ts` | 偏好白名单认 `priority`（**只认两个合法值**，陌生值丢弃） |
| `src/state/appPrefsStore.ts` | 加 `lyricPriority` + `setLyricPriority`；⚠️ `setLyricSource` 必须**连同 priority 一起写**（否则会把 priority 抹掉） |
| `src/components/SettingsPanel.tsx` | 「歌词来源」组里加「歌词优先级」二选一 + 改提示文案 |
| `src/player/lyricSource.ts` | **核心**：优先级判定 + 回落 + 5 秒超时 + 原因语义 |
| `src/player/lyricOverlay.ts` | 取词时读 `useAppPrefsStore.getState().lyricPriority`（与 `spectrum.ts` 读 `lyricOverlayMode` 同一套路） |
| `src/pages/FullPlayerPage.tsx` | 从 `useAppPrefsStore` 读优先级并传进去（改了优先级 ⇒ 重新取词） |
| `test/lyric-source.test.ts` | 「NAS 优先」那组断言**改写**为新行为（前提被用户显式推翻）+ 新增回落 / 超时 / 本地优先用例 |
| `test/settings-lyric-source.test.tsx` | 新增优先级二选一的用例 |
| `e2e/helpers/app.ts` | 夹具预置 `prefs.lyric.source = 'off'` ⇒ **E2E 绝不碰真实外网**（否则每首歌都会去打网易云） |
| `e2e/smoke.spec.ts` | 只改注释（口径变了） |
| `docs/changelog.md`、`README.md` | 「NAS 优先」→「线上优先」+ 新增设置项说明 |

---

## ⑤ 验收

- **纯函数单测**：`loadLyricEntries` 的五种线上结果（ok / not-found / error / 抛异常 / 超时）
  各自的行为与 `origin` / `reason`；本地优先模式**行为与老口径一字一致**；
  无外部取法 ⇒ 零外部请求；
- `normalizeLyricPriority` 的真值表（陌生值 ⇒ 缺省）；
- `tsc --noEmit` **exit 0**；
- `vitest run`：**只增不减**（既有断言**一条不许删**；被显式推翻的那条**改写为新行为断言**并说明）；
- Playwright E2E：**24/24 全绿**（且**全程不碰真实外网**）；
- `npm run build` exit 0；
- 字节级自检：无 U+FFFD、无 NUL、无 BOM，行尾保持原样；
- **用户侧复验**：
  ① 同一首歌，线上有词时**显示的是线上那份**（可对比逐字填色）；
  ② 把优先级切回「本地优先」⇒ 立刻改用本地那份；
  ③ 外部源选「不用外部」⇒ 等于纯本地。

---

## ⑥ 已知代价（如实标注）

1. ⚠️ **每首歌都要等一次外网往返** —— 本地那份不再「秒出」（本地是内网，≈50ms；线上 200~800ms）；
2. ⚠️ **线上成功 ⇒ 不用本地那份** ⇒ 线上没翻译时，那首歌就**没有翻译**（用户已拍板接受）；
3. ⚠️ **网易云限流风险上升** —— 实测它连续探测后会降级（`lrc` 只回 27 行、`yrc` 直接为空）。
   主进程的缓存能挡重复查询（成功 LRU 64 / 失败 5 分钟 TTL），但**新歌仍会打一次**；
4. ⚠️ **老用户行为会变**（缺省从「本地优先」变成「线上优先」）—— 这是本次的**目的**，但确实是破坏性变更；
5. ⚠️ **不做跨源翻译合并** —— 要合并得先判「线上原文与本地原文是否同一版本」，
   判错会出现「原文被当翻译」的乱双语 ⇒ 留给 **T72 多源聚合**一并做。

---

## ⑦ 遗留

- ⚠️ **「整体固定偏移」仍在** ⇒ **T71 手动歌词偏移滑块**；
- ⚠️ **「更多歌有真逐字」** ⇒ **T72 多源聚合 + 逐字优先**（酷狗 KRC 待再验）；
- ⚠️ **跨源版本择优**（歌词时间轴与音频时长是否吻合）⇒ 随 **T72** 一起做。
