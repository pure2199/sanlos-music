# T96 规格：「发现」页 —— 音乐榜单 + 为你推荐

> 一句话：给客户端加一个**「发现」页**，两块内容——
> **音乐榜单**（QQ 音乐公开榜单，条目**匹配回你的曲库**，命中的才能播）与
> **为你推荐**（基于你已有的本地 / 服务端记录**自算**，**每条都在库、都能播**）。

---

## 一、拍板结果（用户 2026-11-16 拍板）

| 决策 | 取值 | 理由 |
|---|---|---|
| **D1 范围** | **榜单 + 推荐一起做**（一个编号任务 T96） | 用户原话「推荐和榜单一起做」 |
| **D2 榜单源** | **只接 QQ 音乐**（实测 200 可用），但按**多源适配器**写 | 加源不改上层；其余源实测不可用（见 §二） |
| **D3 页面落点** | **顶栏主导航新增「发现」**，页内两个 Tab | 与「搜索」并列，入口醒目 |
| **D4 榜单展示** | **全部显示 + 未命中标灰「不在曲库」+ 显示命中率** | 保留全网榜原貌且如实标注 |
| **D5 推荐数据源** | **本地历史 + 服务端历史 + 收藏** | 三者互补 |

---

## 二、事实基线（**本轮实测**，不是推测）

### 2.1 外部榜单接口探测（`release/verify/t96-01-probe-chart-endpoints.mjs`）

| 源 | 实测 |
|---|---|
| **QQ 音乐** | ✅ **200 + 真实榜单条目** |
| 网易云 | ❌ `music.163.com/api/top/list` 等 → body `{"code":404,"message":"接口未找到！"}` ⇒ **web 端点已下线**（其**歌词**端点仍好） |
| 酷狗 | ⚠️ `/api/v5/rank/top` → 404；`/api/v3/rank/song` → 「参数不合法」⇒ **参数名待探** |
| 酷我 | ⚠️ `www.kuwo.cn/api/www/chart/kuwo` → 「The request is illegal!」⇒ **缺 `kw_token`** |
| 咪咕 | ❌ 本机 node/curl **TLS 握手失败** ⇒ 需在应用内 Chromium 栈复验 |

### 2.2 QQ 榜单的**真实形状**（`release/verify/t96-02-probe-qq-chart-shape.mjs` / `t96-03-probe-qq-boards.mjs`）

- 端点：`https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=<id>&format=json&page=detail&type=top&song_begin=0&song_num=<n>`
- 必须带头：**UA** + **`Referer: https://y.qq.com/`**（实测带了就通）
- 响应是**扁平**结构（**不在 `data` 下**）：`{ code, songlist, topinfo, total_song_num, … }`
- `code=0` 表示成功；`topinfo.ListName` = 榜单名（**自描述**）
- `songlist[]` 每条 = **榜单专属字段 + `data`（真正的歌）**：
  `data` 的字段名是 **`songname`**（不是 `title`/`name`）、**`singer: [{ id, mid, name }]`**、**`albumname`**、**`interval`（秒）**、`songid`、`songmid`
  ⇒ ⚠️ **写 `title` / `name` 会静默拿到 `undefined`**（第一版探针就踩了）
- ⚠️ **没有「榜单列表」接口**（`page=list` → `code=-1, subcode=400`）⇒ **榜单目录必须在客户端写死**
- 实测出的 `topid ↔ 榜单名`（37 个）见 §四；本轮默认取 4 个：**热歌(26) / 飙升(62) / 新歌(27) / 内地(5)**

### 2.3 数据的真实形状（**直接决定推荐算法**）

| 数据 | 形状 | 结论 |
|---|---|---|
| 服务端 `play-history/list` | total 实测 **414~426**；条目 = 完整歌曲对象；**没有播放时间字段**；**返回顺序不是按时间戳**；**不随本机播放增长**（服务端无「上报播放」端点） | 只能当**曲目池** |
| 本地 `localStorage` 历史 | 上限 **100** 条，最新在前，同一首**不重复占位**，**无时间戳** | 只能当「最近听过的 100 首」；**没有播放次数** |
| 收藏 `favorite-track/list` | **全量** | 强信号 |
| 曲库 `track/list` | 分页；渲染层 `libraryStore` 明确「**没有取全量的入口**」 | 需要**主进程建全量索引** |
| `SessionManager.request(path, …)` | 主进程**通用**带凭证请求 | 主进程可拉全量曲库 ✓ |

⚠️ **两边都没有「播放次数」** ⇒ 本轮**不做**「按播放次数排的热歌榜」（那是待实测点，本轮不碰）。

---

## 三、数据模型（`shared/chartTypes.ts`）

```ts
/** 榜单里的一条。 */
export interface ChartEntry {
  rank: number          // 排名（1 起）
  title: string         // 歌名
  artist: string        // 歌手（多歌手用 ' / ' 连接，展示用）
  album: string         // 专辑（外部源不给 ⇒ ''）
  duration: number | null  // 时长（**秒**；外部源不给 ⇒ null）
  inLibrary: boolean    // 是否在本地曲库里
  songId: string | null // 命中时的本地歌曲 id（未命中 ⇒ null）
}

/** 一个榜单。 */
export interface ChartBoard {
  id: string            // 如 'qq-26'
  name: string          // 如 '巅峰榜·热歌'
  source: string        // 数据源 id（如 'qq'）
  entries: ChartEntry[]
}

/** 曲库索引状态（**不许把「索引失败」说成「都不在曲库」**）。 */
export type LibraryMatchStatus = 'ok' | 'unavailable'

/** 榜单拉取结果。 */
export interface ChartResult {
  status: 'ok' | 'error'
  message?: string        // 失败原因（可读中文，不含凭证）
  boards: ChartBoard[]
  libraryStatus: LibraryMatchStatus  // 'unavailable' ⇒ inLibrary 全部按 false 处理，但界面必须说「暂时无法匹配曲库」
  libraryMessage?: string
}
```

---

## 四、归一化与匹配（`shared/chartMatch.ts`，**纯函数**）

### 4.1 归一化规则（`normalizeText`）

| 步骤 | 做什么 | 为什么 |
|---|---|---|
| 1 | `String.prototype.normalize('NFKC')` | 全角 → 半角（「（」与「(」等价） |
| 2 | **去掉所有空白** | 本地多歌手用 `' / '` 连接、QQ 用 `/` ⇒ 去空白后两边一致 |
| 3 | 去掉常见标点（中英文逗号/句号/顿号/连字符/引号…） | 「歌曲名，歌手」与「歌曲名 歌手」等价 |
| 4 | 英文转小写 | 大小写差异 |
| 5 | **保留括号内的内容** | ⚠️ 去掉括号会让 Live 版匹配到录音室版 ⇒ **宁可漏匹配，不可误匹配** |

### 4.2 匹配键

```
key(song)     = norm(song.title) + '\u0001' + norm(每个歌手候选)
key(entry)    = norm(entry.title) + '\u0001' + norm(entry 的每个歌手候选)
```

- **歌手候选**：本地 `Song.artist` 按 `/` 切分（`mapSong` 用 `' / '` 连接多歌手）；外部条目取 `singer[].name` 的**每一项** ⇒ 任一候选命中即算命中。
- 索引：`Map<string, Song[]>`（同一键可能有多首歌 ⇒ Live 版 / 翻唱 / 不同专辑同名歌）。
- **时长闸**：两侧都有时长 ⇒ `|Δ| ≤ 3 秒`（沿用歌词源 `DURATION_TOLERANCE_SECONDS = 3` 的先例）⇒ 多个候选时取**时长差最小**的那个；都没有时长 ⇒ 取第一个（**如实**：命中与否仍如实显示，时长闸只是加分项）。

### 4.3 榜单目录（客户端写死，`topid ↔ 名称`）

实测 37 个，本轮**只用 4 个**（通用性最强）：

| topid | 榜单名 | total |
|---|---|---|
| 26 | 巅峰榜·热歌 | 300 |
| 62 | 飙升榜 | 100 |
| 27 | 巅峰榜·新歌 | 100 |
| 5 | 巅峰榜·内地 | 100 |

（其余实测到的 id 一并记在 `electron/chartProvider.ts` 的注释里，**加源/加榜不改结构**。）

---

## 五、主进程（`electron/`）

### 5.1 `electron/chartProvider.ts`

- `ChartSource` 接口：`{ id, name, boards: BoardDef[], fetchBoard(def, fetchImpl): Promise<ChartEntry[]> }`
- **QQ 适配器**：
  - URL 模板见 §二；头：UA + `Referer: https://y.qq.com/`
  - 超时 **8 秒**（`AbortController`）
  - 解析：`code !== 0` ⇒ 失败（附 `msg`）；`songlist[]` → 每条读 `data.songname` / `data.singer[].name` / `data.albumname` / `data.interval`
  - **缺字段不抛异常**：缺 `songname` 的条目**跳过并计数**（如实返回条数），不伪造
- 缓存：成功结果 **5 分钟**（与歌词源 `FAILURE_CACHE_TTL_MS` 同一量级）；失败**不缓存**（下次重试能立刻恢复）
- 返回 `ChartResult`（`status` / `message`），**失败也要给可读中文**

### 5.2 `electron/libraryIndex.ts`

- 用 `SessionManager.request('/track/list', { query: { page, size } })` **分页拉全量**曲库（实测千首量级 ⇒ size 取 200，逐页直到拿满 `total`）
- 建 `Map<string, Song[]>`（键按 §四）；**TTL 10 分钟**；拉取失败 ⇒ 抛可读错误（**不返回空索引** —— 空索引会被当成「一首都不在曲库」，那是假话）

### 5.3 IPC 契约

| 通道 | 方向 | 载荷 |
|---|---|---|
| `discover:charts` | 渲染 → 主（`invoke`） | 无入参 ⇒ 返回 `ChartResult` |

- 主进程负责：抓榜 + 拉全量曲库 + 匹配 ⇒ **一次 IPC 拿回「榜单 + 命中标记」**，渲染层零额外请求
- 渲染层**不许**指定要抓哪个地址（与歌词源 `lyric:fetch` 同一条纪律）

---

## 六、渲染层（`src/`）

### 6.1 `src/api/discover.ts`（推荐算法）

```
输入：
  library   = NAS 曲库全量（分页拉全）
  localHist = 本地历史（≤100，顺序 = 时间序）
  nasHist   = 服务端历史条目（顺序不可信，只当曲目池）
  favorites = 收藏（全量）

种子：seedArtist[artist] / seedAlbum[album]
      ← localHist ∪ nasHist ∪ favorites 的歌手与专辑（归一化后累加权重）

三块：
  块1「因为你收藏了 X」  = favorites 的歌手/专辑 → 曲库里的其他歌
                          分 = 3.0×歌手命中 + 1.5×专辑命中
  块2「因为你常听 X」    = localHist 的歌手/专辑 → 曲库里的其他歌
                          分 = 2.5×歌手命中 + 1.0×专辑命中
  块3「曲库里的新面孔」  = 不在任何种子里的曲库歌
                          分 = 1.0（随机打散，保证每次顺序不同）

全局过滤：
  − 排除 localHist 前 30 首（别推刚听过的）
  − 跨块去重（先到先得）
  − 排除已在 nasHist 前 30 首的歌（刚在 NAS 那边听过的也别推）

输出：每块 ≤ 10 条，共 ≤ 30 条
每条附 reason（如「因为你收藏了 云旗」）
```

- 某块**无内容 ⇒ 该块不显示**（不留空壳）
- 降级：localHist 为空 ⇒ 只用收藏 + 曲库冷启动（块 2 不显示）；曲库拉不到 ⇒ 整页报错

### 6.2 `src/pages/DiscoverPage.tsx`

- 两个 Tab：「榜单」/「为你推荐」
- 榜单 Tab：左侧榜单切换（4 个），右侧条目列表（排名 + 歌名 + 歌手 + 「在库/不在曲库」标记）
  - 命中条目 → 可点播放（用本地 `songId` 走既有 `playerStore` ⇒ NAS `track/stream`，**不新增播放路径**）
  - 未命中 → **不可播**、灰显 + 标「不在曲库」
  - 顶部显示命中率：「榜上 N 首，你的曲库里有 M 首」
- 推荐 Tab：三块，每块一个小标题 + 条目列表；每条带推荐理由
- 空态 / 错误态 / 重试按钮（照 `LibraryPageShell` 的既有形状）

### 6.3 `src/App.tsx`

- `MainView` 加 `'discover'`；顶栏主导航加「发现」按钮（与「搜索」并列）；`renderMainView` 加分支

---

## 七、降级矩阵（**失败不许白屏，也不许说假话**）

| 故障 | 榜单区 | 推荐区 |
|---|---|---|
| 外部源超时 / 失败 | 显示可读错误 + 「重试」 | **照常可用** |
| 曲库索引拉取失败 | 显示「暂时无法匹配曲库」（**不把全部标成「不在曲库」**） | 显示「暂时无法加载曲库」+ 重试 |
| NAS 不可达 | 同上 | 同上 |
| 本地历史为空 | 正常 | 只显示「收藏扩展」与「冷启动」，不报错 |
| 服务端历史为空 | 正常 | 正常（种子少 ⇒ 结果少，但**不报错**） |

---

## 八、影响文件清单

### 新增
| 文件 | 职责 |
|---|---|
| `shared/chartTypes.ts` | `ChartBoard` / `ChartEntry` / `ChartResult` 类型 |
| `shared/chartMatch.ts` | 归一化 + 匹配**纯函数**（主/渲染共用） |
| `electron/chartProvider.ts` | QQ 适配器 + `ChartSource` 接口 + 超时/缓存/失败语义 |
| `electron/libraryIndex.ts` | 主进程全量曲库索引（分页拉全 + TTL） |
| `src/api/discover.ts` | NAS 聚合 + 推荐算法 |
| `src/state/discoverStore.ts` | 榜单/推荐的加载状态与错误态 |
| `src/pages/DiscoverPage.tsx` | 新页 |
| `src/pages/discover-page.css` | 页面样式（跟随两套主题令牌） |
| `test/chart-match.test.ts` | 归一化 + 匹配单测 |
| `test/chart-provider.test.ts` | 榜单适配器 + 失败语义单测 |
| `test/discover-recommend.test.ts` | 推荐打分/分块/去重/排除单测 |

### 改动
`electron/ipc.ts`（+`discover:charts`）、`electron/preload.ts`（+通道）、`shared/playerBridge.ts`（+`fetchCharts`）、`src/App.tsx`、`src/styles/app-shell.css`、`mock-server/server.ts`（E2E 用的 mock 榜单）、`docs/changelog.md`、`docs/calibration.md`

---

## 九、验收点

**A 功能**：A1 榜单 ≥ 20 条且含排名/歌名/歌手；A2 命中条目**可播**（进度条走起来）、未命中不可播且标「不在曲库」；A3 显示命中率；A4 推荐每条都能播、不含本地历史前 30 首、跨块不重复；A5 三块各自成立、某块空则不显示；A6 每条带可读理由。

**B 降级**：B1 外部源失败 ⇒ 榜单区报错 + 重试，**推荐区照常**；B2 NAS 不可达 ⇒ 两块都报错不白屏；B3 索引失败 ⇒ 说「暂时无法匹配曲库」**而不是**「都不在曲库」；B4 本地历史为空 ⇒ 推荐降级不报错。

**C 测试**：C1 新增单测 ≥ 30 条（匹配 ≥ 12 / 适配器 ≥ 8 / 推荐 ≥ 12）；C2 既有 **2684** 条一条不删、断言一条不弱化；C3 `tsc --noEmit` 0 error；C4 vitest 全绿 + playwright 全绿（新增 1 条 E2E）；C5 字节体检 + 控制字符扫描 0 bad；C6 **变异自证**三条（匹配判据改回⇒红／去掉「排除最近 30 首」⇒红／还原⇒绿）。

**D 性能**：D1 榜单首载 ≤ 3 秒、缓存命中 ≤ 200 毫秒；D2 曲库索引构建 ≤ 5 秒（千首）、TTL 10 分钟；D3 来回切页不重复拉。

**E 记录**：E1 `docs/calibration.md` 记各源实测状态 + QQ 字段名 + topid↔榜单名 + 命中率；E2 台账回填 T96 段；E3 真机复验（隔离 userData + 真实 NAS + 真实 QQ 源）覆盖「榜单命中项可播」「推荐项可播」。

---

## 十、明确不做

- ❌ **不做**「按播放次数排的热歌榜」（服务端历史**没有**时间戳与次数 ⇒ 名不副实 ⇒ 本轮不做）
- ❌ **不做**「每日推荐 / 个性化推荐歌单」（需要用户账号 cookie ⇒ 不做；且与本地曲库重合度未知）
- ❌ **不接**除 QQ 外的外部榜源（实测不可用；架构留好接口，以后实测通了再加）
- ❌ **不改**「线上优先」等既有政策；**不新增**播放路径（命中项走既有 `playerStore`）
- ❌ **不引**新 npm 依赖

---

## 十一、实现第一步：第 0 步实测（**不通过就别往下做**）

1. **命中率**：QQ 热歌榜前 50 条里有多少首在你的曲库
   （用「**隔离 userData 副本 + 真实 NAS**」探针量 —— **不需要用户交口令**；同 T93 的做法）
2. **QQ 榜单条目是否带时长** ⇒ **已实测：带**（`data.interval`，秒）⇒ 时长闸可用 ✅
3. 服务端历史里有没有重复 guid ⇒ 决定以后能不能做「热歌榜」（本轮不做，但结论要记下）
4. fnOS 服务端是否另有**未使用的榜单/推荐端点**（扫客户端没用过的路径）
