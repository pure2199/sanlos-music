# T127 —— 接服务端的「搜索建议」端点 `/search/suggest`（组 C 第一项）

> 起因：**ABCD 全做**里的 **C 组（接没用过的既有端点）**。
> T119 扒 NAS 自托管的 Web 前端时反解出 **19 组 / 92 条**端点，其中 4 条客户端一直没用：
> `/search/playlist`、`/search/suggest`、`/artist/list-all`、`/initialization/state`。
>
> 规格日期：**2026-11-20**　｜　用户拍板：**「先做 C 组（接 4 个端点）」** ⇒
> 实测后收窄为 **只做 T127 ＝ `/search/suggest`**（用户二次拍板：「只做 T127＝/search/suggest（推荐）」）。

---

## 一、实测依据（**2026-11-20 真机**，FN 中继 ＋ 真实 NAS，**只读 GET**）

探针：`release/verify/t127-01-probe-endpoints.mjs`、`release/verify/t127-02-probe-suggest.mjs`
（**gitignored**，不入库）；对照组用 `/album/list`（已知可用）证明探测链路本身通。

### 1. 四个端点的实测形状

| 端点 | 实测 | 结论 |
|---|---|---|
| `/artist/list-all` | `code=0`；**分页参数被忽略**（`?size=1&page=1` 仍回 **14 875 条全量**）；耗时 **15.3 s / 14.2 s**；字段只有 `guid/name/coverId/createdAt/updatedAt` | ❌ **不接** |
| `/search/suggest` | 参数名 **`q`**；返回四段 `{track, album, artist, playlist}`；每段 `{total, items}`；**带 `score`**；耗时 **1.39 / 1.65 / 1.42 s** | ✅ **本任务接它** |
| `/search/playlist` | `code=0` 恒 `total=0`；对照组 `/playlist/list` 也 `total=0` | ❌ **不接** |
| `/initialization/state` | `code=0`，`data = { initialized: true }`，**只此一个字段**，174 ms | ⏳ **留给 T128** |

### 2. `/search/suggest` 的六条行为事实（**逐条实测，不是推测**）

| # | 事实 | 实测 |
|---|---|---|
| ① | **参数名是 `q`** | `?q=音乐` ⇒ `code=0`；`?keyword=音乐` ⇒ **`code=100002 invalid arguments`** |
| ② | **空 `q` 会被服务端拒** | `?q=` ⇒ `code=100002`；`?q=%20%20%20`（纯空格）⇒ `code=0` 但四段全空 |
| ③ | **`size` 被忽略** | `size=1 / 3 / 20 / 100` ⇒ 每段都是 `total=5`、`itemsLen=5` |
| ④ | **`page` 被忽略** | `page=1` 与 `page=2` 的首条标题**逐字相同** ⇒ **固定 top-5** |
| ⑤ | **返回的是「四段 + 每段 `{total, items}`」**，**不是** `{list, total}` | `data = { track, album, artist, playlist }`，每段 `{ total, items }` |
| ⑥ | **服务端是模糊匹配** | `q=zzz不存在的词zzz` 仍回 5 首 ＋ 5 张专辑（「不存在的存在」「世界上不存在的歌」） |

### 3. ⭐ 白捡的发现：`score` 客户端一直丢掉了

`/search/track`（**客户端现在就在用**）的条目**本来就带 `score`**（实测 `2.195477722355097`）
⇒ 客户端的 `mapSong` 把它丢了。本轮顺手把它接住（可选字段）。

### 4. ⭐ 顺带发现的真缺陷（**不在本任务范围**，另立编号任务）

NAS 重启后首次请求撞上 **30 s 超时**时，主进程协议代理返回的是**业务信封**
`{ code: -1, msg: '无法连接音乐服务（网络不可达或服务未响应）' }`
⇒ `apiCall` 抛的是 **`ApiError`（业务错误）而不是 `ApiNetworkError`（网络错误）**
⇒ 渲染层按错误类型区分「可重试 / 服务端拒绝」会**误判**。
（本轮实测数据：`t127-02-suggest.json` 的 `size_1` / `size_3` 两次各 30 s 超时。）

---

## 二、范围（**做什么 / 不做什么 / 为什么**）

### 1. 做

**只接 `/search/suggest`**：搜索页新增一块「建议」区（歌曲 / 专辑 / 歌手各 ≤ 5 条）。

### 2. 不做（**已实测，不是「没测」**）

| 端点 | 不做的理由（**实测数字**） |
|---|---|
| `/artist/list-all` | 比现有 `/artist/list` **慢 9.5 倍**（15.3 s vs 1.6 s）、**字段更少**（没有 `trackCount` / `albumCount`）、**分页参数被忽略**（一次回 14 875 条全量）⇒ **零增量价值**，接了反而更慢 |
| `/search/playlist` | 这台机 **0 个歌单**（`/playlist/list` 对照组同样 `total=0`）⇒ 恒空列表；客户端已有 `/playlist/list` 全量接口 |
| `/initialization/state` | 有价值（连接自检），但**落点要另定**（连接页 / 登录后？）⇒ **留给 T128**（用户已拍板本轮只做一个编号任务） |

### 3. 明确不改的

- **既有三段搜索的行为**（`/search/track`、`/search/album`、`/search/artist`）：**一个字都不改**；
- **既有分页、排序、收藏、歌单写回**：不动；
- **既有测试**：**一条不删、一条不弱化**。

---

## 三、设计

### 1. 数据流

```
用户输入
  └─ 防抖 SEARCH_DEBOUNCE_MS(300) ─→ query
       ├─ 既有：loadPage(query, 1, 'all')  → 三段完整结果（歌曲/专辑/歌手，各 50 条，5.8 s）
       └─ 新增：loadSuggest(query)        → 建议区（四段各 top-5，1.4 s）
```

⚠ **两条链**共用**同一个代次 `generationRef`** ⇒ 过期响应一律丢弃（复用既有机制，不另造一套）。

### 2. API 层（`src/api/search.ts`）

新增 `searchApi.suggest(q)`：

- **只打** `GET /search/suggest?q=<关键字>`；
- ⚠ **不发** `page` / `size`（实测服务端**忽略**这两个参数 ⇒ 发它们只是噪音）；
- ⚠ **空 / 纯空格的 `q` ⇒ 客户端自己拦下，**一次请求都不发**（实测服务端回 `code=100002`）；
- 返回 `SuggestResult`：`{ tracks, albums, artists, playlists }`，每段是 `Page<T>`（`{list, total}`）；
- ⚠ **形状转换**：服务端给的是 `{total, items}` ⇒ 客户端转成 `{list, total}`（`items` → `list`）。

### 3. 领域模型：`score`（**条件透传，零破坏**）

- `RawSong` / `RawAlbum` / `RawArtist` 加 **`score?: number | null`**；
- `Song` / `Album` / `Artist` 加 **`score?: number | null`**（**可选**）；
- ⚠ **只在服务端给了 `score` 时才往领域对象上放这个键**（条件展开，不是无条件 `score: null`）
  ⇒ 既有测试若做整对象比较也**不受影响**（实测既有 `test/api-client.test.ts` 全是**逐字段**断言，
  但这条设计让它连「整对象」也不会被打破）。

### 4. 组件层：建议区（`src/components/SearchPanel.tsx`）

- **独立状态** `suggestState`（**不复用** `Section<T>`：建议**没有分页、没有「加载更多」**）；
- **独立错误**：建议失败**只**显示在建议区，**绝不影响**完整搜索结果的显示；
- ⚠ **不复用 `SongList`**（它带 `selectedIds` 选中态 ⇒ 建议的歌曲与完整结果的歌曲会**共享同一份选中态** ⇒ 语义混乱）
  ⇒ 建议区用**自己的轻量行渲染**；
- 点击：**歌曲** ⇒ `onPlay(song, index, 建议队列)`；**专辑 / 歌手** ⇒ 复用既有的 `onOpenAlbum` / `onOpenArtist`；
- ⚠ **不显示「命中 N」**（实测 suggest 的 `total` 恒为 5，是「给了几条」而**不是**「总命中数」）；
- ⚠ **不自己按 `score` 重排**（服务端已按相关性排序 ⇒ 保持服务端顺序）。

### 5. 错误处理

| 情况 | 行为 |
|---|---|
| suggest 请求失败 | 建议区显示错误提示；**完整搜索结果照常显示** |
| suggest 返回空四段 | 建议区**不渲染**（不留空壳） |
| 过期响应（用户已换关键字） | 直接丢弃（复用 `generationRef`） |
| 服务端 `code=100002`（空 `q`） | 客户端**根本不发**这种请求 ⇒ 不会出现 |

---

## 四、钉子（**7 条**，新文件 `test/t127-search-suggest.test.ts`）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | `suggest('音乐')` ⇒ 请求 URL **恰为** `/search/suggest?q=音乐`，**不含** `page=` / `size=` | 端点路径 ＋ 不发无意义参数 |
| ② | 空 `q` / 纯空格 `q` ⇒ **一次请求都不发**，四段全空 | 客户端自己拦空关键字（服务端会拒） |
| ③ | 服务端的 `{track:{total,items},…}` ⇒ 客户端拿到 `tracks.list` 等（**`items` → `list`**） | 形状转换 |
| ④ | `score` 被透传；**服务端没给 `score` 时领域对象里没有这个键** | 条件透传 ＋ 零破坏 |
| ⑤ | 组件：suggest 成功 ⇒ 渲染出建议行（歌曲 / 专辑 / 歌手三段） | 功能落地 |
| ⑥ | 组件：suggest **失败** ⇒ **完整搜索结果仍然正常显示** | 建议失败不污染搜索结果 |
| ⑦ | 组件：建议区**不出现**「命中 N」字样 | `total` 恒 5，不是命中总数 |

---

## 五、影响文件清单

| 文件 | 动作 | 行尾 |
|---|---|---|
| `docs/superpowers/specs/2026-11-20-sanlos-music-t127-search-suggest.md` | 新建（本文件） | LF |
| `src/api/types.ts` | `RawSong`/`RawAlbum`/`RawArtist` 加 `score`；新增「建议分段」类型 | LF |
| `src/api/client.ts` | `mapSong`/`mapAlbum`/`mapArtist` **条件**透传 `score` | LF |
| `src/api/search.ts` | 新增 `searchApi.suggest(q)` ＋ `SuggestResult` | LF |
| `shared/types.ts` | `Song`/`Album`/`Artist` 加**可选** `score` | LF |
| `src/components/SearchPanel.tsx` | 建议区（状态 ＋ 渲染 ＋ 独立错误） | ⚠ **CRLF** ⇒ **Node 脚本改** |
| `src/components/search-panel.css` | 建议区样式（只用 `var(--radius-*)` ＋ 语义色变量） | LF |
| `mock-server/server.ts` | 加 `/search/suggest` 路由（空 `q` ⇒ `code=100002`） | ⚠ **CRLF** ⇒ **Node 脚本改** |
| `mock-server/fixtures.ts` | 建议用的固定样本 | LF |
| `test/t127-search-suggest.test.ts` | 新建（**7 条**钉子） | LF |
| `e2e/t127-search-suggest.spec.ts` | 新建（真 Electron：建议区出现 ＋ 完整结果仍正常） | LF |
| `docs/calibration.md` | 新增**第一百零六节** | ⚠ **CRLF** ⇒ **Node 脚本改** |
| `docs/changelog.md` | 「未发布」段 | ⚠ **CRLF** ⇒ **Node 脚本改** |
| 台账（**仓库外** `progress-ledger.md`） | 新增 T127 段 | LF |

---

## 六、验收点

- `tsc --noEmit` **0 错**；
- `vitest` **全绿**（既有**一条不删、一条不弱化**；新增 1 文件 **7** 条）；
- `playwright` **全绿**（新增 1 条）；
- `npm run build` exit **0**；
- 字节体检 `release/verify/t115-10-bytes-check-all.mjs` **bad=0**；
- **变异自证 `MUTATION_OK`**：每个变体**认「红了哪几条」**（不只看「有没有红」）
  ＋ **每个变体之间还原基线**（否则第 N 个变体会继承前面所有坏改动 ⇒ 判据失真）。

---

## 七、遗留（**不在本任务范围**）

- ⏳ `/initialization/state`（`{initialized: true}`，174 ms）⇒ **T128**（连接自检；落点待定）；
- ⏳ **主进程协议代理 30 s 超时返回业务信封 `code=-1`** ⇒ `apiCall` 抛 `ApiError` 而非
  `ApiNetworkError` ⇒ 渲染层的「可重试 / 服务端拒绝」判断会**误判** ⇒ 建议另立编号任务；
- ⏳ `/artist/list-all`、`/search/playlist` ⇒ **已实测、不接**（理由见 §二.2）；
- ⏳ **v0.4.5 未发**（本轮只改实现 ⇒ 发版另立编号任务）。
