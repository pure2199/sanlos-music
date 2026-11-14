# T92 规格：启动自动播放的**音量淡入**（200–400 ms）

> 一句话：应用启动后**自动恢复上次播放**时，第一声不再「一步到位」地炸出来，而是从静音**线性爬升 300 ms**；
> 手动点歌**不淡入**；淡入结束后的输出与现状**逐值相同**。

---

## 一、任务与现状（**已证**的事实，带文件与行号）

### 1.1 需求

- 用户要求：**启动自动播放**时加 **200–400 ms** 的音量淡入，并补齐测试与台账。
- 触发场景只有一个：**T89-⑲ 的「启动时恢复上次播放」**（`src/App.tsx:252-259` 是 `restoreLastPlayback` 的**唯一**调用点 ⇒ `resumePlayback` 也只有这一条入口）。

### 1.2 现状：软件里**零淡入**（T91 真机复验）

被测对象 = 已安装的 v0.2.9（`D:\Sanlos Music\Sanlos Music.exe`）+ 真实 NAS；探针打在真实渲染进程里。

| 事实 | 证据 |
|---|---|
| 全程 **ramp 调用 = 0**（`linearRampToValueAtTime` / `exponentialRampToValueAtTime` / `setTargetAtTime` / `setValueCurveAtTime` 一次都没调） | `release/verify/t91-01-autoplay-abruptness.json` → `probe.rampCalls = []` |
| 第一声是**一步到位**：rms `0.0948` → `0.201`（34 ms 内拉满） | 同上 → `envelope` |
| 起播瞬间元素音量 = 1（没有预置的静音窗口） | 同上 → `probe.elementVolume = [{ t: 1248, v: 1 }]` |

⇒ **「突然」坐实**（零淡入 + 从上次位置直接出声）；「炸」不成立（实测最大 peak 0.634 < 1，不削波）。

### 1.3 ⚠️ 曾经的误判：**两个时钟混算**（本规格的锚点由它决定）

T91 / T92 两份探针分别用**页面 `performance.now()`** 与**宿主 `Date.now()`** 记时间
⇒ 「`playing` 比第一声早 595 ms」是**混算**出来的假象，**不能**作为设计依据。

**重测（T92-③，单时钟）**：媒体事件时间线与电平包络**都记在页面同一个 `performance.now()`** 上，
采样在**页面内**用 `setInterval(20 ms)`（无跨进程往返 ⇒ 时间戳不失真）：

| 事件 | 时刻（页面 `performance.now()`） |
|---|---|
| `waiting` / `loadstart` | +1565 / +1567 ms |
| `canplay` / **`playing`** | +2811 ms |
| **第一声**（rms > 2e-4） | **+2859 ms** |
| ⇒ **`playing` → 第一声** | **48 ms** |

⇒ 48 ms 就是**设备输出延迟**的量级 ⇒ **`playing` 事件是个足够准的锚点**。

### 1.4 第一声**自身**也有约 140 ms 的爬升（不是突变）

同一份数据的前 8 个非零样本（rms）：

```
+2859 0.00236 → +2879 0.01487 → +2898 0.02177 → +2919 0.02263
→ +2938 0.04731 → +2958 0.14111 → +2979 0.20922 → +2998 0.22800
```

⇒ 淡入不需要覆盖整段前奏，只要**盖住开头那一下**就够了。

### 1.5 ⚠️ 已实测但**本轮不改**的事实：输出 = `element.volume` × `gain`

T92-① 的静音实验：`element.volume` 置 0 ⇒ 输出 rms 从 `0.0289` 归 `0` ⇒ **元素音量参与输出**
⇒ 现状下滑块 50% 实际只有 25% 响度（v²）。

**本轮只记录、不修**：改它会让音量滑块的整体语义变化（属于另一件事）。
⚠️ 但它**不影响**本方案：淡入只改**增益的时间曲线**、**不改终点值** ⇒ 淡入结束的输出与现状**逐值相同**。

---

## 二、目标与**明确不做**的事

### 2.1 目标

1. 启动自动播放（恢复上次播放）的第一声做 **300 ms** 线性淡入（用户给的是 200–400 ms，取中值）；
2. 淡入结束后的输出与现状**逐值相同**（音量滑块不动、store 状态不变、界面**不闪**）；
3. 任何异常路径都**绝不留下永久静音**；
4. **手动点歌不淡入**（本轮只治「启动自动播放」）。

### 2.2 明确**不做**

| 不做 | 理由 |
|---|---|
| 手动点歌也淡入 | 用户是**看着自己点**的，本来就有心理准备；本轮只治启动自动播放这一种「吓一跳」场景 |
| 修「输出 = v²」 | 见 §1.5：属于另一件事，本轮只记录 |
| 淡入曲线改成指数 | `exponentialRampToValueAtTime` **不能从 0 起** ⇒ 必须线性 |
| 加设置项 / 改音量滑块 UI | 淡入是**内部实现**，不该给用户多一个开关 |
| 淡入锚点改成「电平检测」 | 见 §3.2：代价（改音频图拓扑）大于收益（48 ms 已够准） |

---

## 三、设计

### 3.1 淡入的落点：**引擎的主增益节点**（`gain.gain`）

音频图现状（`src/player/engine.ts:1108-1156`）：

```
source ──▶ [EQ 链] ──▶ gain（音量） ──▶ destination
                              └──▶ analyser（频谱旁路，不连 destination）
```

淡入就是**主增益 `gain.gain` 的一条时间曲线**：`0 → 目标音量`，300 ms 线性。

⚠️ **为什么不新增节点**：新增节点会改**音频图拓扑** ⇒ 波及既有的图结构断言与 EQ 幂等逻辑（`applyEqChain` 的
「断旧链 → 断源节点全部出边 → 接新链」依赖 `source → gain` 这条固定路径）⇒ 收益不抵风险。

### 3.2 锚点为什么选 **`playing` 事件**

| 候选锚点 | 结论 |
|---|---|
| **建图**时刻（+1317 ms） | ❌ 第一声在 +2859 ms ⇒ 差 1542 ms ⇒ ramp 在声音出来**之前**就结束了 ⇒ **等于没淡入** |
| **电平检测**（AnalyserNode） | ❌ 要在**静音状态下**仍能听到信号 ⇒ 检测点必须在淡入点**上游** ⇒ 要么在音频图里**新增一个节点**（改拓扑）⇒ 要么在 `source` 上挂旁路（会被 EQ 重装时的 `source.disconnect()` 抹掉，见 `engine.ts:385`）。代价 > 收益 |
| **`playing` 事件** | ✅ 实测只差 **48 ms**（§1.3）⇒ 300 ms 的 ramp 正好盖住第一声之后的约 **250 ms** ⇒ 听感是「渐强」 |

⚠️ **只用 `playing`，不用 `canplay`**：`canplay` 只表示「数据到了」，可能**早于**真正出声 ⇒
用它当锚点会让 ramp 提前结束（退回「没淡入」）。引擎现有绑定里两者都指向 `handleResumed`（`engine.ts:1221-1222`），
本任务**只给 `playing` 单独挂一个处理器**，`canplay` 的行为**一字不变**。

### 3.3 时序（启动自动播放）

```
startPlayback()                      ← 起播：把 gain 置 0（上膛＝静音）
   │                                   （此时还没有声音，静音不损失任何东西）
   │  …建图 / 设 src / play()…
   ├─ 约 1.5 s 后────────────────────▶  `playing` 事件
   │                                   cancelScheduledValues(now)
   │                                   setValueAtTime(0, now)
   │                                   linearRampToValueAtTime(目标音量, now + 0.3)
   │                                        ▲
   │                                        └── 目标 = **当前音量**（启动时通常 1）
   └─ 300 ms 后：gain = 目标音量 ⇒ 输出与现状**逐值相同**
```

### 3.4 接口

```ts
/** 起播选项（**全部可选** ⇒ 既有实现与测试替身不受影响）。 */
export interface PlayOptions {
  /**
   * 起播时做一次**音量淡入**（毫秒）。
   *
   * ⚠️ 不给 / ≤ 0 = **不淡入**（既有行为一字不变）。
   */
  fadeInMs?: number
}
```

- `PlayerEngineLike.play(song: Song, options?: PlayOptions): void`
  ⇒ 既有替身（`play(songToPlay: Song): void`）**照旧可用**（少参实现可赋值给多参签名）。
- `PlayerEngine.play` → `playResolved` → `playViaFallback` / `playViaStandardQuality` → `startPlayback`
  ⇒ **透传**同一个 `options`（兜底转码那条异步路径也要带上）。
- `playerStore.playTrack(song, list?, options?)` ⇒ `resumePlayback` 传 `{ fadeInMs: 300 }`。
- `AUTOPLAY_FADE_IN_MS = 300` 放在 `src/player/engine.ts`（引擎拥有「怎么淡入」，store 只决定「要不要淡入」）。

### 3.5 ⚠️ 兜底：**绝不留下永久静音**

淡入上膛期间增益是 0 ⇒ 任何「没能爬坡」的路径都会变成**永久静音**（比突兀更糟）。因此：

| 情形 | 行为 |
|---|---|
| 环境**没有** `linearRampToValueAtTime`（老 Chromium / 测试替身） | 直接把增益设成**目标音量**（= 不淡入，但**不是静音**） |
| 淡入**上膛**期间 `pause()`（用户暂停） | 恢复目标音量 |
| 淡入上膛期间媒体**报错 / 中止 / 播完** | 恢复目标音量 |
| 淡入上膛期间**换歌**（新的一曲没有淡入请求） | 恢复目标音量（并取消已排的 ramp） |
| 淡入**爬坡中**用户改音量 | 取消已排的 ramp，按既有语义**瞬时**生效（`setVolume` 仍是瞬时赋值） |

⚠️ **爬坡中**不取消 ramp：300 ms 后它自己到目标值（中途取消会把音量**冻在半路**）。

⚠️ `setVolume` 要先 `cancelScheduledValues(now)` 再赋值：否则按 Web Audio 规范，
「`setValueAtTime` + 后面的 `linearRamp`」会让 ramp 从**新值**再爬回**旧目标** ⇒ 用户拖音量会被拽回去。
（今天没有排程事件 ⇒ **既有行为一字不变**。）

### 3.6 `AudioParamLike` / `AudioContextLike` 的扩展（**全部可选**）

```ts
export interface AudioParamLike {
  value: number
  linearRampToValueAtTime?(value: number, endTime: number): void
  setValueAtTime?(value: number, startTime: number): void
  cancelScheduledValues?(cancelTime: number): void
}
export interface AudioContextLike {
  readonly currentTime?: number   // 新增（可选）
  // …其余成员不变
}
```

⚠️ **全部可选** ⇒ 既有的假实现（`FakeGainNode.gain = { value: 1 }`、`FakeAudioContext`）**照旧编译、照旧通过**。

---

## 四、测试（TDD：先写、看着它红、再实现）

### 4.1 `test/engine.test.ts`（新增一个 describe，**不动既有断言**）

| # | 用例 | 断言 |
|---|---|---|
| 1 | `play(song, { fadeInMs: 300 })` | 起播后 `gain.gain.value === 0`（上膛静音） |
| 2 | 上膛后收到 `playing` | 调用 `linearRampToValueAtTime(目标, now + 0.3)` |
| 3 | `play(song)`（**不带**选项） | 增益**不**被置 0，且**不**调用任何 ramp（既有行为不变） |
| 4 | 替身**没有** ramp API | 增益直接被设成目标音量（**不是**静音） |
| 5 | 上膛期间换歌（不带选项） | 增益恢复成当前音量 |
| 6 | 上膛期间 `pause()` | 增益恢复成当前音量 |
| 7 | 爬坡中 `setVolume(0.5)` | 调用了 `cancelScheduledValues`（旧 ramp 被取消） |
| 8 | 先 `setVolume(0.5)` 再淡入 | ramp 的**目标值是 0.5**（不是写死 1） |

### 4.2 `test/resume-playback.test.ts`（新增，**不动既有断言**）

| # | 用例 | 断言 |
|---|---|---|
| 9 | `resumePlayback(song, 42)` | `engine.play` 收到 `{ fadeInMs: 300 }` |
| 10 | 手动 `playTrack(song)` | `engine.play` **不**带淡入选项 |

### 4.3 既有测试

**一条不许删、一条不许弱化**；新增的可选成员（`currentTime` / ramp API）**不得**让既有替身编译失败。

---

## 五、验收

1. `tsc --noEmit` exit 0；`vitest run` 全绿（既有 124 文件 / 2616 条**全部保留**）；
   `npm run build` exit 0；CI 的 `playwright test` 34 passed。
2. 字节体检 + 控制字符扫描 0 bad（`release/verify/fnm-bytes-check.mjs` + `t89-19-scan-control.mjs`）。
3. **真机复验**：启动自动播放的电平包络**从 0 连续爬升**（不再一步到位），
   且淡入结束后的输出与现状**逐值相同**。
4. 手动点歌**不**淡入（真机或单测均可证）。

---

## 六、遗留（**本轮不做**）

| 遗留 | 说明 |
|---|---|
| 输出 = `element.volume` × `gain` = **v²** | 已实测（§1.5）⇒ 音量滑块 50% 只有 25% 响度。**另开一轮**修 |
| 「关掉自动播放 ⇒ 不出声但位置照记」未在安装版实测 | 要改用户 `prefs.json`，风险大 ⇒ 仍挂遗留 |
| 「退出前补写一次位置」未实现 | 续播位置可能丢最后几秒 |
| 蓝牙耳机等**大输出延迟**设备上，淡入可能被设备延迟吃掉 | 实测本机 48 ms；蓝牙可能 150–300 ms ⇒ 淡入窗口偏短。**待真机观察** |
