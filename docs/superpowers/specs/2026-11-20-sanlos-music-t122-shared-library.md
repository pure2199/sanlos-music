# T122：接共享库（`/shared-library/*`）

> 日期：2026-11-20
> 状态：**实现完成**（回归全绿；真机复验待装版后做）
> 前置：T119（端点反解）→ T120（目录浏览）→ **T122（本任务）**

---

## 一、目标与范围

把服务端**共享库**（`/shared-library/*`）接进客户端：用户能看到「这台 NAS 共享了哪些音乐库」，
并**直接浏览、播放**共享库里的内容。

**范围**：

| 做 | 不做（并说明理由） |
|---|---|
| 列共享库（`GET /shared-library/list`） | `create` / `edit` / `delete` / `scan` / `scan-all` / `reconnect` / `reconnect/check` —— **全是 POST 写操作**；客户端是**播放端**，不是 NAS 管理端（管理操作飞牛自己的 Web 端有） |
| 按共享库的**物理路径**浏览内容（复用 T120 的 `/folder-view/list`） | 不做「按共享库 guid 过滤取曲目」—— **服务端根本没有这个接口**（见 §二.4） |
| 老服务端（端点不存在）⇒ 如实说明「不支持共享库」 | **不回落**全库扫描（共享库没接上 ≠ 曲库少了东西，回落只是白扫一遍） |

---

## 二、事实依据（**实测**，不是推测）

### 二.1 真机实测（2026-11-20，FN 中继，**只打 GET**）

| 端点 | 实测 |
|---|---|
| `GET /shared-library/list` | `code=0`；`data.list[]` = `{ guid, name, path, autoDownloadLyric, metadataPreference, contentLastChangedAt, accessStatus }`；本机 **2** 项 |
| `GET /shared-library/detail?guid=<guid>` | `code=0`，返回**同一个对象**（**无额外字段**）⇒ 不接 |
| `GET /shared-library/scan-all` / `reconnect-check` / `track/list` | HTTP 200 且 **body 是 `null`**（端点不存在或方法不对）⇒ 不接 |

### 二.2 ⭐ 关键事实：共享库**不是另一份曲库**

本机这 2 个共享库的 `path` **正好就是** `/app-center/authed-dir/list` 那 2 个授权目录
⇒ 共享库 = **同一个曲库的「共享视角」** ⇒ 浏览它**不需要新的取数路径**。

### 二.3 前端反解（2026-11-20，扒飞牛音乐 Web 前端包：主包 ＋ 46 个 chunk）

| 事实 | 依据 |
|---|---|
| **方法**：只有 `list` / `detail` 是 GET，其余 7 个**全是 POST** | 方法表 `yb`（chunk `5e884898…`） |
| 真实路径是 `/shared-library/reconnect/check`（**不是** `reconnect-check`） | 端点表 `q.sharedLibrary` ⇒ **T119 那张表在这里是错的** |
| `accessStatus`：**0 = 正常**、非 0 = **访问异常**（前端渲染「访问异常，前往处理 >>」） | `8a84e406…` 的三态徽标；⚠️ **库级数值含义前端包里没有枚举** ⇒ 客户端**不解释** |
| `metadataPreference` 枚举：`local_preferred` / `cloud_preferred` / `local_only` | `7dfb4cf…` 的枚举 `T` |
| `name` 为空时的兜底顺序：`name` → 语义路径末段 → 物理路径末段 → `guid`；**前端不额外调接口补名** | `qj`（`1bc04b52…`） |
| 共享库每 15 秒轮询一次；扫描进度从任务 `ext.libraryGUID`（**大写**）反推 | `7dfb4cf…` / `8a84e406…` |

### 二.4 ⭐「共享库的曲目从哪来」

**前端包里根本不存在「按共享库 guid 取曲目」的接口**（全包检索 `sharedLibraryGuid` / `library_guid` **0 命中**，
`libraryGuid` 仅 3 处且都是**本地 state key**，不是请求参数）：

- `/track/list` 全站**只被调用一次**，且**不带任何库筛选**（`getLibraryPageData` 连 `path` 都不转发）；
- 物理目录浏览是另一条线：`GET /folder-view/list?parentPath=&sort=`。

⇒ **共享库对象只提供「目录 ＋ 扫描策略 ＋ 访问状态」，不提供曲目清单。**
⇒ 本客户端**选后者**：对共享库的物理路径用 `/folder-view/list` 做目录浏览（只读、当场见效、不扫全库）。

---

## 三、方案

### 三.1 取数

| 层 | 落点 |
|---|---|
| 端点 | `src/api/sharedLibrary.ts`（新建）：`listSharedLibraries()` / `mapSharedLibrary()` / `isUnsupportedError()` / `sharedLibraryApi` |
| 目录浏览 | **复用** `src/api/folder.ts` 的 `listFolder()`（T120 那套）⇒ 不新造取数路径 |
| 曲目 → 领域模型 | `src/api/folder.ts` 新导出 `folderTrackToSong()`：**复用 `client.ts` 的 `mapSong`** ⇒ 毫秒→秒、封面 id 归一、多歌手连接，与曲库**同一套字段** |

### 三.2 界面

新增「共享」页（曲库导航组，**需要 NAS** ⇒ 未登录不渲染）：

- **列表态**：共享库名（`name` 空 ⇒ 路径末段 ⇒ `guid` 兜底）、路径、内容更新时间（UTC）、`accessStatus ≠ 0` ⇒ 标「访问异常」；
- **浏览态**：面包屑 + 子目录（可下钻）+ 曲目（`SongList`，双击即播，**整队口径**）；
- **老服务端**：端点不存在 ⇒ 响应 body 是 `null` ⇒ `apiCall` 抛「响应不是预期信封」⇒ 页面显示「**服务端不支持共享库**」，**不崩、不回落**。

### 三.3 mock

`mock-server/server.ts` 加 `GET /shared-library/list`，**共享库的 `path` 从 `authedRoots` 推导**
⇒ 与 mock 曲库**永远对得上**（不可能「假绿」）。

---

## 四、钉子

| # | 钉子 | 位置 | 钉住什么 |
|---|---|---|---|
| ① | 列表渲染；`name` 空 ⇒ 展示名兜底（路径末段 ⇒ `guid`） | `test/t122-shared-library.test.tsx` | 不许出现空白项 |
| ② | 老服务端（抛「响应不是预期信封」）⇒ 显示「不支持共享库」，不崩 | 同上 | 不许白屏 / 不许假装有数据 |
| ③ | 点共享库 ⇒ 子目录可下钻、曲目列出来 | 同上 | 浏览链路通 |
| ④ | 双击曲目 ⇒ `onPlay(song, index, list)`；**时长是秒不是毫秒**；`list` = 整队 | 同上 | 播放口径与曲库一致 |
| ⑤ | 浏览失败 ⇒ 如实显示错误 | 同上 | 不许吞异常 |
| ⑥ | 映射：`displayName` 兜底链、`accessStatus` 原样、`contentLastChangedAt` 是 **Unix 秒**、`metadataPreference` 透传 | 同上 | 映射规则不回退 |
| ⑦ | 页面源码**不含**「服务端不能浏览目录」那类过时结论 | 同上 | T119 纪律延伸到新页面 |
| ⑧ | E2E：顶栏「共享」→ 列表 → 浏览 → 双击播放条出歌名 | `e2e/t122-shared-library.spec.ts` | 接线 + 真链路 |

---

## 五、验收

| 项 | 结果 |
|---|---|
| `tsc` | **0 错** |
| Vitest | **151 文件 / 3 061 条全绿**（原 150 / 3 054 ＋ 新增 1 文件 7 条；**既有测试一条没删、断言一条没弱化**） |
| Playwright | 见验收记录（新增 1 条 T122 用例） |
| `build` | exit 0 |
| 字节体检 ＋ 控制字符 | `bad=0` |
| 真机复验 | ⏳ **待装版后做**（本轮改动**未发版**） |

---

## 六、遗留

- ⏳ **共享库的管理操作**（添加文件夹 / 扫描 / 重建索引 / 重连）**一律不接**（写操作）⇒ 需要管理请用飞牛音乐 Web 端；
- ⏳ **库级 `accessStatus` 的数值含义**未确证（前端只判 `!==0`）⇒ 客户端只标「访问异常」，**不解释**；
- ⏳ `reconnect/check` / `reconnect` 的响应字段（`requiresConfirmation` / `matchAccepted` / `reconnected` / `scanStarted`）**未实测**；
- ⏳ **T119 那张端点表**里 `reconnect-check` 应为 `reconnect/check` ⇒ 已在 §二.3 标注，**待另立小任务**订正文档；
- ⏳ 共享库曲目**不走**全局 `/track/list` ⇒ 共享库里新增的曲目**要等服务端扫描完**才看得到（客户端不代劳扫描）。
