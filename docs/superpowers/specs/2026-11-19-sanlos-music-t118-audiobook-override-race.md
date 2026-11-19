# T118 —— 「有声」页扫描落盘不得覆盖手工改判

> 起因：**「有声读物」页的全库扫描在落盘时用「扫描启动那一刻的 `overrides` 快照」**
> ⇒ 扫描进行中用户做的**手工改判**会被扫描的落盘**覆盖**。
>
> 规格日期：**2026-11-19**　｜　用户拍板：**「请立项修复「有声」页扫描落盘使用启动时 overrides 快照、可能覆盖手工改判的问题。」**

---

## 一、起因与根因（**逐行确认，不是推测**）

### 1. 用户能走到的现象

「有声读物」页进页面会**自动开扫**（实测 **87 页 / 6–47 分钟**）。
扫描期间用户可以：

| # | 操作 | 落点 | 写的是哪张表 |
|---|---|---|---|
| ① | 点秒搜结果里的作品 | `src/pages/AudiobooksPage.tsx:286` | `setOverride(albumId, 'audiobook')` |
| ② | 在专辑详情页点「这不是有声」 | `src/pages/DetailPage.tsx:338` | `setOverride(albumId, 'not-audiobook')` |
| ③ | 在专辑详情页点「这是有声读物」 | `src/pages/DetailPage.tsx:423` | `setOverride(albumId, 'audiobook')` |

这三种**都是**「用户的判断」⇒ 记在 `overrides` 这张表里（`src/state/audiobookStore.ts`）。

### 2. 根因：`scan()` 用**启动快照**写 `overrides`

`src/state/audiobookStore.ts` 的 `scan()`：

| 行 | 代码 | 问题 |
|---|---|---|
| `:739` | `const saved = port.load() ?? emptyPersisted()` | 读一次 ⇒ **快照**（此后不再更新） |
| `:794` | `overrides: { ...saved.overrides }`（**每页断点落盘**） | 写回**启动快照** ⇒ **覆盖**扫描期间的新改判 |
| `:814` | `overrides: { ...saved.overrides }`（**扫完落盘**） | 同上 ⇒ 再覆盖一次 |
| `:836` | `set({ overrides: persisted.overrides })` | **内存状态也回退** ⇒ 界面上刚点的「这不是有声」**当场消失** |

⇒ 扫描跨过任意一个页边界，用户刚做的改判就被**冲掉**；扫描结束时又冲一次。

⚠ **这条路径 100% 会走到**：87 页 ⇒ 每个页边界都落一次盘 ⇒ 用户只要在扫描期间改判，
**下一个页边界**（实测几秒～几十秒一次）就会把它盖掉。

### 3. 为什么**只有** `scan()` 有这个毛病

同一个文件里另外三处**都**是「**先读最新的，再只改自己那个字段**」：

```ts
// setOverride / setCover / setAlbumCover —— 共同形状
const saved = p.load()          // ← 读**最新**的
const overrides = { ...saved.overrides }
...                            // ← 只改自己那个字段
p.save({ ...saved, overrides }) // ← 别的字段用**最新的**
```

⇒ `scan()` 是**唯一**一处「拿启动快照去写别人也在改的字段」。

### 4. 机理一句话

**「谁最后写谁赢」的整对象落盘模型下，扫描这一路对 `overrides` 字段没有写权限，却仍然在写。**

---

## 二、修法（**单一根因、单一改动**）

### 1. 原则：**扫描不再拥有 `overrides` 的写权限**

扫描只写**自己**的字段（断点 `nextPage` / 进度 / `candidates` / `keyword` / `scannedAt`），
`overrides` **一律取 store 内存里的活值**。

### 2. 为什么取**内存活值**，而不是「再读一次磁盘」

| 判据 | 内存活值 `get().overrides` | 再读磁盘 `port.load()?.overrides` |
|---|---|---|
| 是不是**完整且最新** | ✅ 是（见下） | ⚠ 写盘失败时是**旧的** |
| 成本 | 零（已经在内存里） | 每页一次 `JSON.parse`（落盘可达 **500** 部作品） |
| 写盘失败（配额满） | ✅ 顺带把新改判**补写**成功 | ❌ 新改判**丢** |

**「内存里永远是完整且最新」的依据**（逐个写者核对过）：

| 写者 | 写法 | 完整性 |
|---|---|---|
| `setOverride()` | `set({ overrides })`（`overrides` = 磁盘最新值 + 本次改动） | ✅ 整份 |
| `restore()` | `set({ overrides: { ...saved.overrides } })` | ✅ 整份 |
| `scan()` 起点 | `set({ overrides: { ...saved.overrides } })` | ✅ 整份 |
| `scan()` 终点 | `set({ overrides: persisted.overrides })` | ✅ 整份（**T118 后**取活值） |

⚠ **必须是「整份」而不是「补丁」** ⇒ 这也是**不能**写成
`{ ...saved.overrides, ...get().overrides }` 的原因：**那样会把「撤销改判」复活**
（启动快照里有 `A`，用户撤销后活值里没有 `A` ⇒ 合并结果里 `A` 又回来了）。
⇒ 只能**整体替换**。

### 3. 具体改动（**3 处，全在 `scan()` 里**）

```ts
// ① 每页断点落盘（:794）
overrides: { ...get().overrides },   // ← 原：{ ...saved.overrides }

// ② 扫完落盘（:814）
overrides: { ...get().overrides },   // ← 原：{ ...saved.overrides }

// ③ 扫完的内存 set（:836）—— 代码**不动**
set({ overrides: persisted.overrides })   // 现在 persisted.overrides 已是活值 ⇒ 不再回退
```

### 4. 明确**不动**的东西（边界）

| 不动 | 理由 |
|---|---|
| `STATE_VERSION`（仍是 **3**） | 落盘**形状**没变 ⇒ 旧落盘照读 ⇒ 用户的扫描结果**不失效**、不用重扫 |
| `setOverride` / `setCover` / `setAlbumCover` / `restore` | **一个字不改**（它们本来就是对的） |
| `scan()` 起点的 `set({ overrides: { ...saved.overrides } })`（`:765`） | 那里是「**扫描开始那一刻**的权威值」＝磁盘值。⚠ 若改成活值：**冷启动**（还没 `restore()`）时活值是空 ⇒ **反而把用户的改判清空** |
| `src/pages/AudiobooksPage.tsx` / `src/pages/DetailPage.tsx` | 页面侧没有 bug（改判**写对了**，是被落盘盖掉的） |
| 版本号 / 发版 | **本任务不发版**（v0.4.4 另起任务） |

---

## 三、钉子（**测试先写**）

新文件：`test/t118-audiobook-scan-override.test.tsx`

| # | 钉子 | 鉴别力 |
|---|---|---|
| ① | 扫描**第 1 页**回调里 `setOverride('al-x','audiobook')` ⇒ 扫完**落盘**里 `al-x` 仍是 `audiobook` | 钉 `:794` / `:814` |
| ② | 同上，但改判是 `not-audiobook` ⇒ 扫完落盘仍是 `not-audiobook` | 钉「反向判定不被吞」 |
| ③ | 启动时 `overrides = {A:'audiobook'}` ⇒ 扫描中 `setOverride('A', null)`（撤销）⇒ 扫完 `A` **仍然没有**（**不被复活**） | 钉「不能用 merge」 |
| ④ | 同 ①，但断言**内存** `getState().overrides['al-x']` ⇒ 扫完**不回退** | 钉 `:836` |
| ⑤ | **对照组**：扫描期间**不改判** ⇒ 启动时的 `overrides` 原样保留 | 钉「没把正常路径写坏」 |
| ⑥ | **页面级集成**：扫描**卡住**（`onPage` 后挂起）⇒ 点「搜作品」⇒ 点开结果（⇒ `setOverride`）⇒ 放行扫描 ⇒ 落盘里改判**还在** | 钉**用户真实路径**（秒搜点开） |
| ⑦ | **扫描进行中**：每页落盘**之后**看磁盘 ⇒ 改判**已经在** | 钉 `:794` 的**中途**覆盖 |
| ⑧ | **扫描中途出错**（网络断了 ⇒ 没有扫完那次落盘）⇒ 落盘里改判**还在** | 钉 `:794`（中断即丢） |

⚠ **⑦⑧ 是实施时补上的**（规格初稿只写了 6 条）：①② 只看「**扫完后的**磁盘」
⇒ **查不出页边界的中途覆盖**（最终落盘会把磁盘救回来）⇒ 必须钉「扫描进行中」
与「扫描中断后」两个**时点**。

⚠ ①–⑤ 用**内存端口**（`createMemoryAudiobookPort`）⇒ 不碰 `localStorage`；
⑥ 用真 `localStorage` 端口（走 `localStorageAudiobookPort`）⇒ 与真机同一条路。

---

## 四、变异自证（**证明钉子真的有鉴别力**）

脚本：`release/verify/t118-01-mutation-check.mjs`（本地，gitignored）

⚠ **脚本认的是「红了哪几条」**（不是「有没有红」）⇒ **每个变体必须由对应的那几条抓住**
（一个「粗用例」能同时抓住所有变体 ⇒ 矩阵就白做了）。

| 变异 | 改什么 | 预期变红的钉子 |
|---|---|---|
| **A** | 两处落盘都退回 `{ ...saved.overrides }`（= 复原原缺陷） | ①②③④⑥⑦⑧ |
| **B** | **只**把 `:794`（每页落盘）退回启动快照 | ⑦⑧ |
| **C** | 把 `:836` 的内存 `set` 退回启动快照 | ④⑥ |
| **D** | 改成 `{ ...saved.overrides, ...get().overrides }`（合并） | ③ |

⇒ 四种变异**各自**让**对应的**钉子变红 ⇒ 钉子不是「碰巧绿」。
⇒ 全部还原后：**全绿** ＋ **字节级一致**（sha256 相同）。

---

## 五、影响文件清单

| 文件 | 动作 | 提交 |
|---|---|---|
| `docs/superpowers/specs/2026-11-19-sanlos-music-t118-audiobook-override-race.md` | 新建（本文件） | commit 1 |
| `src/state/audiobookStore.ts` | 改：`scan()` 内 2 处落盘的数据来源 | commit 2 |
| `test/t118-audiobook-scan-override.test.tsx` | 新建：**8 条**钉子 | commit 2 |
| `docs/calibration.md` | 新增一节（第九十六节） | commit 3 |
| `docs/build-verification.md` | 顶部一条 | commit 3 |
| `release/verify/t118-01-mutation-check.mjs` | 新建（**gitignored**，不入库） | — |

---

## 六、验收点

- `tsc --noEmit` **0 错**
- `vitest` **全绿**（原 147 文件 / 3032 条 ＋ 新增 1 文件 / **8** 条 ⇒ **148 文件 / 3040 条**）
- `playwright` **72 条全绿**
- `npm run build` **exit 0**
- 字节体检 `release/verify/t115-10-bytes-check-all.mjs` **bad=0**
- 变异自证 **MUTATION_OK**（四变体各自红 ＋ 还原后全绿 ＋ 字节级一致）

---

## 七、风险与边界

| 风险 | 评估 |
|---|---|
| 旧落盘兼容性 | ✅ **零风险**（`STATE_VERSION` 不变 ⇒ 形状没变） |
| 用户已有改判 | ✅ **不会丢**（本次只改「谁写」，不改「写什么」） |
| 性能 | ✅ 更好（不再每页读一次磁盘做合并；`get()` 是 O(1)） |
| 扫描中**撤销**改判 | ✅ 保留（`overrides` 整体替换 ⇒ 删除不会被复活） |
| ⚠ **同类的另一个毛病（不在本任务范围）** | 扫描的落盘同样会覆盖**扫描期间补拉的封面**（`setCover` / `setAlbumCover` 写进 `candidates`，而扫描的 `candidates` 来自自己的聚合器 ⇒ 不含那些封面）。**机理同类、字段不同** ⇒ **本任务不动**，记为遗留待立项 |
| ⚠ **真机复验** | 扫描要 **6–47 分钟** ⇒ 真机上做才有意义 ⇒ **列为待真机项**（做法见 §八） |

---

## 八、实施记录（**回填**）

### 8.1 实现（commit 2 —— `3f81b63`）

- `src/state/audiobookStore.ts`：`scan()` 的 `:794` / `:814` 两处 `overrides` 改取 `get().overrides`；`:836` 代码不动（数据源已是活值）⇒ 另加注释说明「为什么扫描不能拥有 `overrides` 的写权限」。
- **实现只有 3 行数据源变化**（其余全是注释）；`git diff --stat` = **13 插入 / 2 删除**（一个文件）。
- 提交：`aa9c703` 规格（commit 1）→ `3f81b63` 实现 ＋ 钉子（commit 2）⇒ 均已推送 `origin/sanlos-music`。

### 8.2 回归（**实测**）

- `tsc --noEmit`：**0 错**
- `vitest`：**148 文件 / 3 040 条全绿**（原 147 / 3 032 ＋ 新增 1 文件 **8 条**；**既有测试一条不删、断言一条不弱化**）
- `playwright`：**72 passed**（1.6 分钟）
- `npm run build`：exit **0**（由 `npm run e2e` 的前半段跑出）
- 字节体检 ＋ 控制字符：**bad=0**（`release/verify/t115-10-bytes-check-all.mjs`）

### 8.3 变异自证（**实测** —— `MUTATION_OK`）

| 变体 | 实际变红 | 期望 | 结论 |
|---|---|---|---|
| A 两处落盘都退回快照 | ①②③④⑥⑦⑧ | 同左 | ✅ |
| B 只退 `:794` | ⑦⑧ | 同左 | ✅ |
| C 退 `:836` 的内存 `set` | ④⑥ | 同左 | ✅ |
| D 改成 merge | ③ | 同左 | ✅ |

⇒ 还原后 **8/8 绿** ＋ **sha256 字节级一致**
（`047f03474ec4392e35c82bf02d3323210617802a0a36972e175ccfe0d75a7220`，43 741 B ⇒ 工作区未被污染）。

### 8.4 待真机项（**本轮未做，写清楚怎么验**）

1. 装上改后的版本 ⇒ 进「有声读物」页（让它自动开扫）。
2. 扫描**还在跑**时：用「搜作品」秒搜一部作品 ⇒ 点开它（⇒ 记成「有声」）。
3. 等扫描**结束**（状态行从「正在扫描…」变成「上次扫描：…」）。
4. **判据**：
   - 该作品的卡片**还在**列表里，且副标题来源是「**你指定的**」；
   - 重进页面后**仍在**（⇒ 落盘没被覆盖）；
   - 反向：在详情页点「这不是有声」⇒ 扫完后**它从列表里消失**且重进后**仍消失**。
5. ⚠ **对照组**：同一台机、同一份数据，用**修复前**的版本跑一遍 ⇒ 第 4 步的判据**必须不成立**（否则说明判据没鉴别力）。

---

## 九、遗留（**不在本任务范围，登记待立项**）

| # | 事项 | 机理 | 建议 |
|---|---|---|---|
| ① | 扫描落盘会覆盖**扫描期间补拉的封面** | `setCover` / `setAlbumCover` 写 `candidates`，而扫描的 `candidates` 来自自己的聚合器 ⇒ 不含那些封面 | 另立 T119：`candidates` 也要「只写自己那份」 |
| ② | `scan()` **不防重入** | 用户在扫描中又触发一次扫描 ⇒ 两个 `scan()` 交替落盘 | 另立：扫描加互斥（进行中直接忽略） |
| ③ | `restore()` 在扫描中会把 `hits` 回退到断点快照 | `restore()` 用落盘的 `candidates` 覆盖内存 `hits` | 另立：扫描中 `restore()` 应保留内存 `hits` |
