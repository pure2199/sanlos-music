# T125：页码上界 clamp（离谱页码兜底）

> 日期：2026-11-20
> 状态：**实现完成**（回归全绿）
> 承接：台账 / T123 / T124 遗留「曲库分页 / `normalizePageNumber()` 的**上界 clamp**
> （`size` 已 clamp ≤ 2000；**页码上界仍未夹** ⇒ 需先实测服务端对超大 `page` 的行为再定上界，**不猜**）」

---

## 一、起因

用户 2026-11-20 明确要求：「**先实测服务端对超大 page 的行为，再实现并验证页码上界 clamp**」。

⇒ 本轮**先把服务端行为测出来**（不猜），**再**定上界，**再**实现 ＋ 验证。

---

## 二、实测事实（**真机**，2026-11-20）

- 环境：本机 + **FN 中继**（`https://pure2199.fnos.net/music`）+ **真实 NAS**；
- 账号：**用户本人的真实账号**（只读 `GET`，不写任何数据）；
- 曲库：`total = 173 671` 首；
- 探针：`release/verify/t125-01-probe-big-page.mjs`（`release/verify/**` 是 gitignored ⇒ **不入库**）；
- 证据：`release/verify/t125-01-big-page-probe.json`（同不入库）。

| 请求 | 实测结果 | 耗时 |
|---|---|---|
| `page=1&size=50` | 50 条，首曲「茨厂街…」 | 5 186 ms（首请求含连接建立） |
| `page=1&size=2000` | **2000 条** | 1 120 ms |
| `page=1&size=2001` | **静默回落成 50 条**（服务端默认页长） | 309 ms |
| `page=1000&size=50` | 首曲「勇敢一点 - Live」⇒ **翻页正常** | — |
| `page=10000 / 100000 / 10000000 / 999999999999 / 0 / -5` | **全部** `code=0`、**50 条**、首曲 = **第一页那首** | 303 / 429 / 327 ms（重复 3 次，**不变慢**） |

⚠ **关键结论**：服务端对**越界 / 非法 page 一律静默回退第一页**——**不报错、不返回空**。
⇒ 客户端**猜不出**服务端到底回了第几页 ⇒ 客户端的义务不是「探测」，
而是**别把离谱的页码发出去**。

---

## 三、代码事实（不是推测）

| 事实 | 出处 |
|---|---|
| `normalizePageNumber()` **只夹下界**（≥ 1），**无上界** | `src/api/client.ts`（改前） |
| `normalizePageSize()` 已夹到 `MAX_PAGE_SIZE = 2000`（与服务端实测上限一致） | `src/api/client.ts` |
| 业务模块（`library` / `search` / `playlist` / `history`）的 `page` **都过** `normalizePageNumber()` | 各 `src/api/*.ts` |
| ⚠ **两个出口没归一**：`fetchAllByPaging()` 的循环页码、`fetchScanPage()` 的扫描页码 | `src/api/client.ts` / `src/api/library.ts`（改前） |
| 翻页护栏已有**两道**：按 `total` 判 `hasMore` ＋ `LIBRARY_MAX_NO_PROGRESS_PAGES = 3`「3 页无进展就停」 | `src/state/libraryStore.ts` |
| 合并按 **id 去重** ⇒ 服务端回第一页**不会**把重复条目灌进列表 | `src/state/libraryStore.ts` 的 `loadPage()` |

---

## 四、方案

| 落点 | 做法 |
|---|---|
| `src/api/client.ts` | ＋`MAX_PAGE_NUMBER = 1_000_000`；`normalizePageNumber()` **夹上界**；`fetchAllByPaging()` 的页码**也过归一**（并把 `maxPages` 一起夹住） |
| `src/api/library.ts` | `fetchScanPage()` 的页码**也过归一**；`scanLibraryTracks()` 的 `startPage` / `maxPages` **一起夹住** |
| `test/t125-page-number-clamp.test.ts` | **新建**：4 条钉子 |
| `docs/calibration.md` / `docs/changelog.md` | 「未发布」段 ＋ **第一百零四节** |

### ⚠ 为什么上界是**绝对值**，不是按 `total` 推的合法上界

真正合法的上界 = `ceil(total / size)`，但它**依赖服务端返回的 `total`**（会随曲库变化）：

> 曲库**变大**时旧 `total` **偏小** ⇒ 若按它夹页码 ⇒ **静默截断新增曲目**（回归）。

⇒ 上界只能是**绝对常量**，且要**大到不截断真实曲库**：
100 万页 × 50 条/页 = **5000 万首** = 实测曲库（17.3 万首 = **3474 页**）的 **288 倍**。

⇒ 真正防越界的**不是**这个 clamp，而是客户端现有两道护栏（按 `total` 判 `hasMore` ＋ 3 页无进展护栏）。
**文档里必须写清这一点**，免得后人误以为「夹了上界就安全了」。

### ⚠ 为什么循环里的页码也过归一、还要把循环上限一起夹

若只夹「发出去的页码」而**不夹循环上限**：`page` 递增到上界后被夹成**同一个值**
⇒ **同一个请求被反复重发**（且永远取不到新数据）。
⇒ 凡是有「自增页码循环」的地方，**循环上限必须一起夹**。

---

## 五、钉子（**4 条**）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | `normalizePageNumber(1e12 / 1e300 / MAX_SAFE_INTEGER)` ⇒ `MAX_PAGE_NUMBER`；上界之内（3474 页）**原样通过** | 「有上界」＋「不截断真实曲库」 |
| ② | 既有归一语义**一条没变**：0 / -3 / NaN / Infinity ⇒ 1、2.9 ⇒ 2、5 ⇒ 5 | 「不许弱化既有断言」 |
| ③ | `libraryApi.songs(1e300, 50)` ⇒ 真的发出去的是 `page=1000000`（**十进制整数**，不是 `1e+300`） | 「夹在**出口**生效」 |
| ④ | 曲库**变大**（total 50 → 120）⇒ 页码一路 1 → 2 → 3，**新增曲目一条不少** | 「**不**按 `total` 夹页码」 |

### 变异自证（**4 个变异，各自只被对应钉子抓住**）

| 变异 | 红了 | 判据 |
|---|---|---|
| M1 去掉上界（回到「只夹下界」） | ① ③ | OK |
| M2 store 层改成「按 `total` 夹页码」 | ④ | OK |
| M3 小数不向下取整（`floor` → `ceil`） | ② | OK |
| M4 `libraryApi.songs` 出口漏掉归一 | ③ | OK |

---

## 六、验收

| 项 | 结果 |
|---|---|
| `tsc` | **0 错** |
| Vitest | **154 文件 / 3 075 条全绿**（原 153 / 3 071 ＋ 新增 1 文件 4 条；**既有测试一条没删、断言一条没弱化**） |
| Playwright | 见验收记录 |
| `build` | exit 0 |
| 字节体检 ＋ 控制字符 | `bad=0` |

### 待真机（**不假装验过**）

- ⏳ 「装版后」真机上翻到**曲库末尾**（第 3474 页）应**正常**（上界不参与）；
- ⚠ 服务端「越界静默回第一页」是**服务端行为**，客户端**改不了**（只能不越界请求）——**如实标注**。

---

## 七、遗留

- ⏳ 组 B 剩余：MP4/M4A **尾读 moov**（条目出处待定位）、歌单面板排序 / 分页（⚠ 台账 T42 已记真实账号 `playlist/list` 实测 `total=0` ⇒ **对用户无实际价值** ⇒ **建议跳过**，待用户拍板）；
- ⏳ 组 C：`/search/playlist`、`/search/suggest`、`/artist/list-all`、`/initialization/state`；
- ⏳ 组 D：`mock-server` 端口竞态、T118「扫描落盘覆盖补拉封面」、README `### Code signing policy` ＋ `.github/CODEOWNERS`、`scripts/pack.cjs` 跨卷 EXDEV（T62）；
- ⏳ T119 那张端点表里 `reconnect-check` 应为 `reconnect/check`（**历史段不篡改** ⇒ 另立小任务订正）。
