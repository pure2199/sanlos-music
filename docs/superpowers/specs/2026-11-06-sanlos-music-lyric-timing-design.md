# T66 设计规格：歌词对时改进（输出延迟补偿 + 伪逐字音节加权 + LRC `[offset:]` 标签）

## 1. 起因

T31~T61 把「歌词能不能显示出来、显示几遍、来自哪个源」都收拾干净了，但**「显示得准不准」**
这一层一个字没动。真机侧暴露三个各自独立的问题：

### 1.1 现象一：整份歌词「整体偏晚」

真实 NAS 给的 LRC 只有**行级**时间戳（实测见 `docs/calibration.md`），行级时间戳本身是准的；
但**声音从「播放位置 T」到「用户耳朵里」之间有一段物理延迟**（声卡缓冲 / WASAPI 共享模式 /
蓝牙耳机的编解码往返），这段延迟在几十到几百毫秒量级。

歌词是按**媒体时间**渲染的 ⇒ 屏幕上第 N 行亮起时，用户耳朵里响的其实是第 N−1 行甚至更早 ⇒
**整份歌词统一偏晚**，而且**越到后面越觉得不对**（因为整首都在同一个恒定偏移上）。

**证据**：全仓库搜不到 `outputLatency` / `baseLatency` / 任何形式的延迟补偿 —— 我们**根本没有**
这个概念。飞牛官方 APP `v1.37.0` 的更新说明里明确写了「**新增音频输出延迟补偿**」
（见 `docs/calibration.md` 的官方更新调研一节）⇒ **这是官方已修、我们没修**的差距。

### 1.2 现象二：卡拉OK 逐字染色「整词跳变」

行级 LRC 没有词级时间戳 ⇒ 现有实现按**词数**在行时长内**均匀**切出伪逐字
（`src/ui/lyrics/parse.ts` 的 `pseudoWords`）。这对中文尚可（汉字基本一字一音节），
但对**英文歌**几乎全错：

- 连续拉丁串算**一个词**（`splitIntoWords` 的既定规则）⇒ 整词一起染色，词内没有任何渐进；
- 更糟的是**时长分配也错**：`"I" / "am" / "going" / "to" / "the" / "store"` 六个词被切成六等份，
  可实际演唱里 `going`（2 音节）占的时间和 `the`（1 音节）**差一倍**。

⇒ 英文歌的卡拉OK 观感是「**六个词轮流整块变色**」，既不跟嘴也看不出节奏。

### 1.3 现象三：LRC 的 `[offset:±N]` 标签被整条丢弃

LRC 格式规范里有同步校正标签：

```
[offset:+500]    →  所有时间戳整体加 500ms（歌词整体延后 0.5 秒）
[offset:-200]    →  所有时间戳整体减 200ms（歌词整体提前）
```

现有的 `TIME_TAG` 正则只认 `[mm:ss]`，不认 `[offset:…]`；而 `parseRawLines` 对**没有时间戳的行**
一律 `continue` ⇒ 这个标签**被当成元信息行静默丢掉**。

我们明明有「偏移校正」能力（服务端 `LyricEntry.offset` → `applyOffset`），却把**文件自己声明的
校正量**扔了 —— 白丢信息。

### 1.4 目标

- **① 输出延迟补偿**：让整份歌词与**用户真正听到的声音**对齐（修 1.1）；
- **② 伪逐字按音节加权**：按**音节数**而不是**词数**分配行时长（修 1.2，英文歌收益最大）；
- **③ LRC `[offset:±N]` 标签**：解析并生效（修 1.3）。

三件事**互相独立**，但都在「歌词对时」这一层，且都**不引新依赖**、都**不新增依赖网络/服务端的行为**。

### 1.5 不做什么（范围收窄）

- **不新增用户手动偏移控件**（设置里不加点位滑块）—— 那是产品决策，超出本轮；
- **不改进度条**：进度条继续显示**媒体真实位置**，不因为补偿而挪动；
- **不改服务端 `LyricEntry.offset` 的既有语义**（正 = 延后）：新标签与之**同向叠加**；
- **不改「卡拉OK 渐进填色」的作用范围**：填色本来只在**词岛**做，本轮只把**词内时间**分得更准，
  不去给经典悬浮窗 / 全屏歌词舞台新增填色；
- **不引新 npm 依赖**：音节估算是手写的启发式；
- **不写死任何设备延迟数值**：延迟**只从运行时读**，读不到就**回落 0**。

## 2. 设计

### 2.1 ① 输出延迟补偿

#### 2.1.1 延迟从哪来（取值规则）

两个可读来源，**取第一个非零的可用值**，**绝不叠加**、**绝不猜**：

| 顺序 | 来源 | 含义 | 单位 |
|---|---|---|---|
| 1 | `AudioContext.outputLatency + AudioContext.baseLatency` | 音频走 WebAudio 图时的**设备级**延迟（图处理 + 输出设备） | 秒 |
| 2 | `HTMLMediaElement.outputLatency` | 媒体元素自身的输出延迟（**没有** WebAudio 上下文时的兜底） | 秒 |
| 3 | — | 都拿不到 / 非法 / ≤ 0 → **回落 0**（= 不补偿） | — |

**为什么是「取第一个非零」而不是「相加」**：Chromium 在元素被 `createMediaElementSource` 接管后，
`element.outputLatency` 与 `context.outputLatency` 的**包含关系随音频栈而变**（有的栈把设备延迟
也计进元素侧）。相加会**双重补偿**（歌词飘太晚），取其一最稳。哪个更准**待真机校准**（见 §5）。

**为什么「设备级优先」**：我们的引擎起播时**一定**建 WebAudio 图（`startPlayback` → `ensureAudioGraph`）
⇒ 声音真正经过的是「元素 → 图 → 设备」这条链 ⇒ **设备侧延迟（来源 1）才是这条链上的总延迟**。

#### 2.1.2 补偿施加在哪（关键决策）

**施加在「歌词行数组」上，而不是「播放位置」上**：

```
applyAudibleLatency(lines, latencySec)  ≡  applyOffset(lines, +latencyMs)
```

- **符号**：`applyOffset` 的既定语义是**正数 = 延后**（`parse.ts` 里已定死，Task 15/19 直接消费）。
  媒体位置 T 的声音在 `T + L` 才到耳朵 ⇒ 歌词必须等到 `T + L` 才显示 ⇒ **歌词时间戳整体延后 L**
  ⇒ `applyOffset(lines, +L)`。与 `lyricTime = mediaPos − L` **等价**，但前者**一处生效、三处受益**：

  | 消费方 | 怎么拿到 lines | 本轮要不要改 |
  |---|---|---|
  | 全屏歌词舞台（主窗口） | `FullPlayerPage` 自己 `parseLyricEntries(...)` | **要改**（构建点 ①） |
  | 经典悬浮窗（独立窗口） | 主进程转发 `kind:'track'` 里的 lines | **不要改**（吃推送） |
  | 灵动态词岛（独立窗口） | 主进程转发 `kind:'track'` 里的 lines | **不要改**（吃推送） |

  主窗口把**补偿后**的 lines 推给两个独立窗口 ⇒ **一处补偿，三处生效**。
- **进度条不受影响**：进度条用 `store.position`（媒体真实位置），与 lines 无关 ⇒ **一字不改**。

#### 2.1.3 换输出设备后怎么办（不能要用户切歌）

延迟**只在输出设备变化时**才会变（换耳机 / 换声卡 / 蓝牙连上）。如果只在「构建 lines 的那一刻」
读一次延迟，**换设备后必须切歌才生效** —— 不可接受。

⇒ **补偿值与 lines 分离**：

- **全屏歌词舞台**：存**原始** lines（`rawLines`），用 `useMemo` 按 `outputLatencySec` **派生**
  补偿后的 lines ⇒ 延迟一变，界面自动重算，**不重新拉歌词**；
- **悬浮窗 / 词岛**：主进程推送侧**缓存**原始 lines；store 里 `outputLatencySec` 变化时
  **重推一次** `kind:'track'`（**不重新取歌词**，不花 NAS 请求）⇒ 两个独立窗口同步换偏移。

#### 2.1.4 状态链路

```
HTMLMediaElement.outputLatency / AudioContext.outputLatency
   ↓（PlayerEngine 读，每次状态快照时读）
PlayerState.outputLatencySec?: number        ← shared/types.ts（秒）
   ↓（playerStore 的 onStateChange 逐字段抄）
PlayerStore.outputLatencySec?: number        ← src/state/playerStore.ts
   ↓
① FullPlayerPage: useMemo(rawLines, outputLatencySec) → applyAudibleLatency
② lyricOverlay:    缓存 rawLines + 延迟变了就重推
```

- `MediaElementLike` / `AudioContextLike` 的新成员一律**可选**（`outputLatency?` / `baseLatency?`）
  ⇒ 既有的单测替身**不需要改**（Task 13 的 `createBiquadFilter?` 就是这么做的）；
- 引擎里**只有一处**读延迟（`readOutputLatencySec()`），取值规则不许散落到别处。

#### 2.1.5 安全上限

浏览器上报的延迟**可能是离谱值**（设备切换瞬间的抖动、驱动 bug）。
⇒ 补偿毫秒数**钳到 1000ms**（`MAX_AUDIBLE_LATENCY_MS`）：宁可少补偿，也不把整份歌词推飞。

### 2.2 ② 伪逐字按音节加权

#### 2.2.1 权重怎么算

`splitIntoWords` 的**切分规则一字不改**（CJK 逐字、拉丁整串、标点并入邻词），
只把「**按词数均分**」换成「**按音节权重分配**」：

```
tokenWeight(token):
  cjk = token 里的 CJK 字符数
  if cjk > 0            → cjk            // 汉字：1 字 = 1 音节
  latin = token 里的拉丁字母（小写）
  if latin 为空          → 1              // 纯数字 / 纯标点：1 份
  else                  → 音节估算(latin)
```

**音节估算**（手写启发式，不引依赖）：

```
syllables(w):
  w = 只保留 a-z 的小写串
  if w 为空        → 1
  if len(w) <= 3   → 1          // the / a / I / you 之类
  去掉词尾哑 e / es：/(?:[^laeiouy]es|[^laeiouy]e)$/     // make→mak, makes→mak
  去掉词首 y：/^y/                                        // yes→es
  数元音组：/[aeiouy]+/g 的匹配个数（连续元音算 1 个音节：ea / eau / io 各算 1）
  结果 < 1 → 1
```

典型结果（**英文歌受益最大**）：`hello`→2、`beautiful`→3、`make`→1、`table`→2、`the`→1。

⚠️ 这是**启发式**，不追求英语 phonology 精确：个别词会差 1 个音节（如 `away` 估成 3）。
**方向正确（长词占更长时间）比绝对精确更重要**。

#### 2.2.2 分配算法（毫秒整数，保证严格单调）

```
总毫秒 = round((行尾 - 行首) * 1000)
每个词的毫秒 = floor(总毫秒 * 权重 / 总权重)，余数按小数部分**从大到小**逐个补（平局靠前）
若 总毫秒 >= 词数 → 再保证每个词 ≥ 1ms（从最宽裕的词里扣回来）
边界 = 行首毫秒 + 累计毫秒 → 换回秒（round3）
```

由此得到三条**可断言**的不变式：

1. **总量严格等于行时长**（`末词.end − 首词.start === 行时长`）；
2. **词起点严格递增**、**词尾严格递增**、**每个词 `end > start`**；
3. **首词起点 === 行时间**、**末词终点 === 下一行时间**（末行则是 `行时间 + 0.5`）。

⚠️ **退化情形**：行时长不足「词数 × 1ms」时（现实中不可达：一行 20ms 内塞 20 个词），
无法同时满足「每词 ≥1ms」与「不越界」⇒ 退化成与旧实现同级的退化行为，**不保证严格递增**。
此时**如实退化，不假装**。

#### 2.2.3 对既有行为的影响

- **纯中文行**：每个汉字权重都是 1 ⇒ **分配结果与旧的「按词数均分」逐字相同** ⇒
  **既有用例一字不改、逐条照旧通过**（`test/lyrics-parse.test.ts` 的「各词时长均匀分配」仍然成立）；
- **含英文的行**：分配比例变了（这正是本轮要的效果）；
- **切分规则不变** ⇒ `splitIntoWords` 的既有断言全部不受影响。

### 2.3 ③ LRC `[offset:±N]` 标签

#### 2.3.1 解析

```
标签语法：/\[offset:\s*([+-]?\d+)\s*\]/i      // 值 = 毫秒整数，符号可选
位置：    扫描**整份原文**，取**第一个**出现（规范里它通常在文件头）
畸形：    [offset:abc] / [offset:] → 忽略（不报错、不产生歌词行）
```

#### 2.3.2 语义与叠加

- **正数 = 延后**（时间戳整体加 N 毫秒）—— 与 `applyOffset` 的既定方向**一致**，
  也与 LRC 规范「+ shifts time up（时间戳变大 → 歌词更晚出现）」一致；
- **负数 = 提前**；
- **与服务端 `LyricEntry.offset` 叠加**：文件内标签先施加，服务端条目偏移后施加
  ⇒ 总偏移 = `文件标签 + 服务端 offset`。
  （`parseLyricEntries` 里服务端偏移是**外层**调用，天然在后面。）
- **标签本身不产生歌词行**：它没有时间戳 ⇒ 仍被「无时间戳行忽略」的既有规则处理。

## 3. 影响文件清单

### 3.1 规格（本 commit）

| 文件 | 变更 |
|---|---|
| `docs/superpowers/specs/2026-11-06-sanlos-music-lyric-timing-design.md` | **新增**（本文件） |

### 3.2 实现（下一个 commit）

| 文件 | 变更 |
|---|---|
| `shared/types.ts` | `PlayerState` 加 `outputLatencySec?: number`（秒） |
| `src/player/engine.ts` | `MediaElementLike` 加 `outputLatency?: number`；`AudioContextLike` 加 `outputLatency?` / `baseLatency?`；新增 `readOutputLatencySec()`；状态快照加 `outputLatencySec` |
| `src/state/playerStore.ts` | `PlayerStore` 加 `outputLatencySec?: number`；`onStateChange` 同步该字段 |
| `src/ui/lyrics/timing.ts` | **新增**：`MAX_AUDIBLE_LATENCY_MS` / `audibleLatencyMs()` / `applyAudibleLatency()`（纯函数） |
| `src/ui/lyrics/parse.ts` | ①`pseudoWords` 改按音节权重分配（新增音节估算 + 毫秒整数分配）；②解析并应用 `[offset:±N]` 标签 |
| `src/player/lyricOverlay.ts` | 缓存原始 lines；延迟变化时**重推**（不重新取歌词） |
| `src/pages/FullPlayerPage.tsx` | 存原始 lines + `useMemo` 按延迟**派生**补偿后的 lines |
| `test/lyric-timing.test.ts` | **新增**：延迟换算 / 补偿语义 / 音节加权 / `[offset:]` 标签 |
| `docs/changelog.md` | 「歌词」行补记三项能力 |
| `README.md` | 「歌词」行补记三项能力 |

**明确不改**：`src/lyric/main.tsx`（经典悬浮窗）、`src/island/IslandApp.tsx`（词岛）、
`src/ui/lyrics/doubleLine.ts`（填色算法）、`src/components/PlayerBar.tsx`（进度条）、
`src/api/lyric.ts`（服务端取词）、`electron/**`（主进程不参与歌词渲染）。

## 4. 验收点

1. `tsc --noEmit` **exit 0**（strict + `noUnusedLocals` + `noUnusedParameters` + `noUncheckedIndexedAccess`）；
2. `vitest run` **全绿**，且**用例数只增不减**（基线 1862 条 / 85 个文件）；
   **既有断言一条不许删、一条不许削弱**；
3. **延迟读不到 / 非法 / ≤ 0 → 回落 0**：歌词时间戳**一字不变**（`applyAudibleLatency(lines, 0)`
   的结果与原 lines 逐字相等）；
4. **补偿方向正确**：延迟 200ms ⇒ 整份歌词时间戳 **+200ms**（延后），且**仍严格单调递增**；
5. **补偿后行高亮仍能选对行**：`findActiveLine` 在钳平边界上仍不跳末行；
6. **音节加权**：英文行里多音节词分到**更长时间**；**总量 === 行时长**；词起点**严格递增**；
   **纯中文行的分配与旧实现逐字相同**；
7. **`[offset:+N]` 延后 N 毫秒 / `[offset:-N]` 提前 N 毫秒**；与服务端 `offset` **叠加**；
   畸形标签**被忽略**且不产生歌词行；
8. **进度条行为一字不变**（`PlayerBar` 不改；`position` 语义不变）；
9. **服务端既有「偏移校正」行为一字不变**（`LyricEntry.offset` 的正负语义不变）；
10. **Playwright E2E 全绿**（`npm run e2e:only`）；
11. **字节级自检**：改动文件无 U+FFFD、无 NUL，行尾与原文件一致（LF），无 BOM。

## 5. 风险与待真机校准（本机无法验证）

| # | 风险 | 现状处理 | 待校准 |
|---|---|---|---|
| 1 | `outputLatency` 在 Windows/Electron 32 上可能**恒为 0** | 回落 0 ⇒ 行为与今天**完全一样**（不回归）；界面**不谎称**已补偿 | 用户侧实测：Windows 有声卡时该值是否非 0 |
| 2 | 来源 1 与来源 2 谁更准（元素侧是否已含设备延迟） | 取其一、不相加 | 真机对比两种取值 |
| 3 | **蓝牙耳机**的编解码往返延迟**在操作系统之外**，`outputLatency` **测不到** | 补偿仍然生效但**补不满** | 用户侧实测：蓝牙下是否仍偏晚、偏多少 |
| 4 | 换输出设备后延迟变化 → 本轮靠 store 状态变化触发重算 | 已实现（不需切歌） | 用户侧实测：换耳机后立刻生效 |
| 5 | 音节估算是启发式 | 方向正确优先；个别词差 1 音节 | 用户侧听感确认英文歌改善 |
| 6 | `[offset:]` 标签的真实来源极少（NAS / 外部源多不带） | 无标签时**行为一字不变** | — |

## 6. 与既有口径的一致性

- `applyOffset` 的方向（**正 = 延后**）**一字不改**，新标签与新补偿都**复用**它，不另立语义；
- 「歌词延后」与「服务端 offset 校正」**同向叠加**，不会互相抵消成怪结果；
- 「进度条 = 媒体真实位置」「卡拉OK 填色只在词岛」两条既有口径**不动**；
- 渲染层**不碰网络**、**不碰凭证**：本轮只读本地已有的延迟值，不新增任何出网通道。
