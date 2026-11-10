# 真机联调校准记录

本文记录**哪些行为已经被验证过、用什么方式验证的**、**哪些还必须在真实 fnOS 上确认**，以及**联调需要用户配合什么**。

> 原则：**未实测的服务端字段与行为一律标为「待校准」**，不写死成契约。
> 探针脚本从环境变量读取凭证，**不打印、不落盘**。

---

## 一、当前状态总览

| 阶段 | 状态 |
|---|---|
| 单元测试 | ✅ 1228 条 / 44 个文件全绿 |
| E2E（真实 Electron + 内嵌 mock NAS） | ✅ 4 条全绿 |
| 打包 + 打包产物启动冒烟 | ✅ 通过（证据见 [`build-verification.md`](./build-verification.md)） |
| **真机联调（真实 fnOS）** | ✅ **已完成一轮** —— 真实 Electron 客户端 × 真实 NAS，**13/13 步全通**；过程中发现 3 个真实缺陷，已修复并复验（见第七节） |

---

## 二、已用探针实测确认的项

这些是开发期用 `tools/` 下的探针打真实 NAS 确认过的，联调时**只需复核一次**。

| 项 | 实测结论 | 来源 |
|---|---|---|
| **端口** | `port.httpPort = 5666`、`port.httpsPort = 5667` | `/sys/config` |
| **服务端转码** | 播放侧 `POST track/transcode` → `code=100001`（**16 种请求体形状全试过**）；**真正可用的是下载侧协议** `download/track/transcode/{prepare,status,file,delete}`（`prepare` / `status` / `delete` 全通）。⚠️ **T55 更正：服务端转码引擎其实是好的**（抽样 14 首 14/14 成功、平均就绪 988 ms）—— T54 当时的「引擎不可用」是**误判**，真凶是**客户端的就绪判定**（`percent>=100` 后单次预检）→ 详见「三十九、T54」与「四十、T55」 | `tools/fn-transcode-probe.mjs` + `release/verify/t54-*.mjs` |
| **兜底方案** | 改为**客户端 FFmpeg** 转 Opus（见 README 常见问题） | `tools/ffmpeg-verify.mts` |
| **本机 FFmpeg 覆盖度** | 9.0.2（Gyan full build）→ 支持 12 种容器：`ape`/`alac`/`dsf`/`wma`/`dts`/`aiff`/`ra`/`au`/`dvf`/`tta`/`dss`/`mmf`；**仅 `dff` 不支持**（无 `dsdiff` 解封装器） | `tools/ffmpeg-verify.mts` |
| **中继链路是硬性关卡** | 不带 `mode=relay` Cookie → 返回 HTML 错误页 | `tools/fn-httstack-verify.mjs` |
| **中继候选可达性** | `https://<fnId>.fnos.net` 命中；当前网络下内网/公网 v4/v6 不可达 | `tools/fn-probe.mjs` |
| **播放历史端点** | `GET /music/api/v1/play-history/list` → `total=414`，条目为**完整歌曲对象** | `tools/fn-history-probe.mjs` |
| **曲库编码分布** | 含 `alac` 46 首等 → **APE / ALAC 可以走兜底播放** | `tools/fn-codec-census.mjs` |
| **中继端口** | 中继**只监听标准 HTTPS 端口 443**，**不监听** 5666 / 5667 | `tools/fn-live-check.mjs`（不写端口登录失败 → 写 `:443` 成功） |
| **自建反代的端口** | 与官方中继一样**只监听标准 HTTPS 端口 443**（实测用户的 openresty 反代：5666 / 5667 都 ECONNREFUSED，443 通且 `/music/api/v1/sys/config` 返回 200）| `release/verify/t43-relay-probe.mjs` |
| **专辑详情取法** | `GET /album/detail?guid=<id>`；`data` 是**裸专辑对象**（不是 `{list,total}`）。用 `albumGUID` / `albumGuid` / `albumId` / `id` 一律 `code=100002` | `tools/fn-album-detail-probe.mjs` |
| **服务端不提供播放历史写入端点** | 17 个候选**历史**写端点全是 SPA 兜底 HTML；`stream` **不写**播放历史 → **NAS 历史只读**，客户端「本机记录 + NAS 只读」的设计正确。⚠️ **这条只针对「历史」**——收藏 / 歌单的写端点**是存在的**（见下一行） | `tools/fn-history-probe.mjs` + `tools/fn-writeback-probe.mjs` |
| **收藏 / 歌单写回可用** | `favorite-track/create` · `favorite-track/delete` → **`{ trackGUID }`**；`playlist/add-track` · `playlist/remove-track` → **`{ guid, trackGUIDs: [id] }`**；`playlist/create` → `{ name }`（**回显 guid**）；`playlist/delete` → `{ guid }`。四个端点**实测真生效**（收藏列表里出现 / 消失、歌单详情里出现 / 消失） | `tools/fn-writeback-probe.mjs` |
| **曲目对象带 `isFavorite`** | 真实曲目的 16 个字段里**有** `isFavorite`，且**取值可信**（实测：已收藏的 `true`、未收藏的 `false`）→ 行内收藏按钮的初始态可以直接取服务端字段 | `tools/fn-writeback-probe.mjs` |
| **历史排序依据不暴露** | 条目 `updatedAt` 与 `createdAt` **完全相同且非单调** → 服务端排序依据不可见 → 客户端**按返回顺序**展示 | `tools/fn-history-probe.mjs` |
| **搜索忽略分页** | `search/{track,album,artist}` **完全忽略** `page`/`size`（`size=5` 也返回全部：占位歌手三 500 首 / 37 专辑 / 2 歌手），第 1、2 页完全重叠 | `tools/fn-calibrate-probe.mjs` |
| **收藏取全** | `favorite-track/list`：`size=200` → 200 条，`size=500` / `size=2000` → 258 条，`total=258` → 客户端「size=200 分页循环」能取全 | `tools/fn-calibrate-probe.mjs` |
| **歌单总数** | `playlist/list` → `total=0`（该账号当前没有歌单） | `tools/fn-calibrate-probe.mjs` |
| **封面 `size` 白名单** | 只认 **200**（→ 200×200 JPEG，8.6 KB）与 **400**（→ 400×400 JPEG，26 KB）；其它值（含不传、100、300、640）都回落到**原始 640×640 WebP**（54.9 KB） | `tools/fn-cover-size-probe.mjs` |
| **同名专辑是多个实体** | 曲库里**存在同名但不同实体的专辑**：搜索「占位曲目一」会命中一个 4 首的「占位曲目一」，而曲目内嵌的 `album.guid` 指向的是另一个只有 1 首的「占位曲目一」。**专辑实体 id**（`/album/detail` / `/search/album` / `/album/list` 用它）与**曲目内嵌 `album.guid`** 是**两套 id** | `tools/fn-album-guid-probe.mjs` |
| **客户端取 id 的口径是对的** | 客户端用的是**专辑实体 id**（来自专辑列表 / 搜索结果）→ 专辑详情的曲目数与该实体一致；「按专辑名搜索」不可靠（会命中同名实体） | `tools/fn-album-guid-probe.mjs` + `tools/fn-live-check.mjs` |

---

## 三、待真机确认的清单（Step A–J）

标注 **[已实测]** 的项在开发期已确认，联调时复核即可。

| Step | 内容 | 状态 |
|---|---|---|
| **A** | FN ID 探测 —— 候选构造与并行探测命中预期链路 | **[已实测]** 中继命中；内网/公网在当前网络不可达 |
| **B** | 中继链路 —— `mode=relay` Cookie 生效、播放可用、界面显示限速提示 | **[已实测]** Cookie 是硬性关卡；**播放与限速提示已在真机复核**（真机播放「占位曲目一」成功，界面显示「中继带宽受限（约 0.5–4 Mbps）」） |
| **C** | token 续期 —— 触发 token 失效，确认静默续期路径生效 | **[已实测]** ① 显式 `relogin()` 返回 `true`，续期后曲库立刻可用（`tools/fn-session-renew-probe.mjs`）；② **服务端「token 失效」的真实形状已测出来**（`tools/fn-token-expiry-probe.mjs`）：无效 token → **HTTP 401** + `{ code: 99999, msg: "INVALID TOKEN" }` —— 业务码与 `CODE_TOKEN_EXPIRED` 一致 ⇒ **静默续期的触发条件成立**（客户端只读 body 里的业务码，不按状态码判定，401 照样能续期）。③ 二进制流路径（`track/stream`）按 401/403 静默续期一次并重发（`electron/proxy.ts`）。⚠️ 服务端**不提供**「作废当前 token」的接口，**99999 自动续期**那条路径仍无法在真机上自然触发 → 单测覆盖（已补「HTTP 401 + 99999」的真实形状）。⚠️ 规格 §5.4 的「续期失败 → 派发 `auth-lost` 回登录页」**尚未实现**（见第八节） |
| **D** | 转码兜底 —— 用一首 APE/ALAC 确认客户端 FFmpeg 兜底链路可用；确认系统无 ffmpeg 时的提示 | **[已实测]** 客户端 FFmpeg 兜底**全链路在真机跑通**：ALAC 曲（24.2 MB）下载 → 本地 → 播放时自动转成 **Opus**（3.43 MB）→ 经 `fnml://` 起播，**进度真的推进**（实测 `0:06`）、**0 条媒体错误**、提示显示「兜底播放使用 Opus 转码（音质有损…）」。⚠️ 过程中暴露并修掉了 **T18-6**（CSP 漏放 `fnml:` → 本地播放被 URL 安全检查拦死）。✅「系统无 ffmpeg 时的提示」也已实测（见第八节 T19-2）：「该格式（ALAC）当前无法播放：未检测到 FFmpeg。安装 FFmpeg 后即可通过转码播放。」 |
| **E** | 端口核对 | **[已实测]** 5666 / 5667；**中继只听 443** |
| **F** | 播放历史端点 —— 条目形状与规格 §15.7 一致；确认「最近播放」的排序依据（`updatedAt`？） | **[已实测]** 形状一致；**排序依据服务端不暴露**（`updatedAt`≡`createdAt` 且非单调）→ 客户端按返回顺序展示；**服务端无写接口** → NAS 历史只读 |
| **G** | 收藏 / 歌单**跨端同步** —— PC 端收藏后，用手机 App 确认可见 | ⏳ **待真机**（需手机端配合） |
| **H** | 搜索端点分页行为 —— `search/track` / `search/album` / `search/artist` 是否接受 `page`/`size`，`total` 是否准确 | **[已实测]** 服务端**完全忽略** `page`/`size`；客户端的「返回条数 > 页长 → 判定不支持分页 → 不再翻页」护栏**在真机上生效** |
| **I** | 收藏 / 歌单全量取回 —— `favorite-track/list` 与 `playlist/list` 的 `size` 上限（实测收藏 251 首 > 默认页长 200） | **[已实测]** 收藏 258 首可取全（`size=200` × 2 页）；**歌单 `total=0`**（该账号无歌单）→ 客户端的「`playlist/list` 实测 2 个」注释已过时 |
| **J** | 专辑详情与歌单创建返回形状 —— `/album/detail` 是否用列表信封返回；`/playlist/create` 是否回显 `guid` | **[已实测]** `/album/detail?guid=` → **裸专辑对象**（**不是**列表信封）；`/playlist/create` → **确实回显 `guid`** → 客户端两处假设都成立，但 `/album/detail` 的**参数名**取错了（已修，见第七节） |
| **K** | 封面 `size` 取值与取色 —— 封面 URL 的 `size` 参数语义；封面主色提取的采样策略 | **[已实测]** `size` 只认 **200 / 400**，其它值回落到原始 640×640；客户端现值 **200 正好命中白名单**（且卡片只有 160 px，200 足够）→ **取值不用改**。⚠️ 本版本**没有**主色提取实现，取色子项无代码可校准 |

---

## 四、联调需要用户配合什么

| 需要 | 用途 | 备注 |
|---|---|---|
| fnOS 的 **FN ID** | 外网中继链路探测 | 不写入仓库、不写入日志 |
| 飞牛音乐的**独立账号 + 口令** | password-login 联调 | 同上 |
| 客户端**能连到的网络环境** | 内网直连 / 中继两条链路都测 | 至少要能连中继 |
| **手机端 App**（可选） | Step G 跨端同步验证 | |
| 一首 **APE / ALAC** 曲目 | Step D 兜底解码全链路 | |

> ⚠️ 联调期间口令会出现在对话里，**联调结束后建议轮换该账号口令**。

---

## 五、探针工具

`tools/` 下的脚本都从**环境变量**读凭证，不打印、不落盘。

```powershell
$env:FN_USER = '<飞牛音乐账号>'
$env:FN_PASS = '<口令>'
node tools/fn-history-probe.mjs      # 例：播放历史
```

| 脚本 | 用途 |
|---|---|
| `tools/fn-probe.mjs` | FN ID 候选链路探测 |
| `tools/fn-con-smoke.mjs` | 连接链路冒烟 |
| `tools/fn-api-probe.mjs` | API 形状探测 |
| `tools/fn-history-probe.mjs` | 播放历史端点与条目形状 |
| `tools/fn-codec-census.mjs` | 曲库编码分布统计 |
| `tools/fn-transcode-probe.mjs` | 服务端转码可用性 |
| `tools/fn-empty-param-probe.mjs` | 空参数边界行为 |
| `tools/fn-flac-probe.js` | FLAC 相关形状 |
| `tools/fn-httstack-verify.mjs` | HttpStack / 中继 Cookie 行为 |
| `tools/ffmpeg-verify.mts` | 本机 FFmpeg 探测 + 转码 + 回读 + 覆盖度核对 |
| `tools/fn-calibrate-probe.mjs` | 搜索分页 / 收藏取全 / 专辑详情形状 / 歌单创建回显 |
| `tools/fn-album-detail-probe.mjs` | `/album/detail` 的路径与参数名变体扫描 |
| **`tools/fn-live-check.mjs`** | **真实 Electron 客户端 × 真实 NAS 的活体验检**（13 步主干路径） |
| `tools/fn-electron-net-probe.mjs` | Electron 出网栈对照诊断（Node / Chromium / net.fetch） |
| `tools/fn-partition-matrix.mjs` | 分区 × 证书校验回调的对照矩阵 |
| `tools/fn-login-shape-probe.mjs` | 登录请求「逐项减法」（定位失败要素） |
| `tools/fn-card-hit-probe.mjs` | 卡片命中检测（`elementFromPoint` + 截图） |
| `tools/fn-session-renew-probe.mjs` | Step C：静默续期 |
| `tools/fn-cover-size-probe.mjs` | Step K：封面 `size` 白名单 |
| `tools/fn-alac-fallback-probe.mjs` | Step D：客户端 FFmpeg 兜底全链路 |
| `tools/fn-first-paint-timing.mjs` | 各页首屏耗时测量 |

---

## 六、联调发现问题怎么办

联调中发现的每一个问题，都**另开一个小任务**修复（T18），并遵循：

1. 先复现（补测试或探针），再改；
2. 修复后补回归测试；
3. **不削弱**既有断言 —— 若前提被推翻，改写为**新行为**的断言并说明理由。

---

## 七、真机联调发现的问题与修复（T18）

本轮真机联调（真实 Electron 客户端 × 真实 NAS）发现 **6 个真实缺陷**，均已修复并**在真机复验通过**
（`tools/fn-live-check.mjs` 从修复前的 9/13 变为 **14/14** —— 新增的「本地播放」一步专门盯 `fnml://` 这条线）。

| 编号 | 缺陷 | 根因 | 修复 | 回归测试 |
|---|---|---|---|---|
| **T18-1** | **手动地址模式连不上中继**（登录必失败：`无法连接音乐服务（网络不可达或服务未响应）`） | `withDefaultPort()` 给「没写端口的地址」补默认端口，把中继域名 `https://<fnId>.fnos.net` 补成了 `:5667`；而中继**只监听 443**（FN ID 探测路径因为「候选地址原样使用」才是通的） | `src/lib/address.ts` 增加中继域名规则：**不补端口**，协议归一为 HTTPS | `test/address.test.ts`（9 条，新增） |
| **T18-2** | **卡片网格整体错乱** —— 专辑 / 歌手 / 风格 / 歌单 / 搜索结果五个页面的卡片**全叠在左侧 1/6**，互相遮挡、**点不中** | `CardGrid` 的 `left: calc(${(column * 100) / columns}% / ${columns})` —— 列数在 JS 里除了一次、CSS 里又除了一次，实际除以 `columns²`（6 列 → 36） | `src/components/Cards.tsx`：列号乘 100%，**只在 CSS 里除一次** | `test/card-grid-layout.test.tsx`（3 条，新增） |
| **T18-3** | **专辑详情页必然报错**（`加载失败：invalid arguments`） | `/album/detail` 的参数名是 `guid`（客户端用了 `albumGUID` → 服务端 `code=100002`），且响应 `data` 是**裸专辑对象**（客户端按 `{list,total}` 信封解析 → 空列表） | `src/api/library.ts`：改用 `guid`，并兼容「裸对象 / 列表信封」两种形状；`mock-server/server.ts` 同步改成与服务端同形 | `test/api-client.test.ts`（改写 URL 断言）、`test/mock-server.test.ts`（改写形状断言） |
| **T18-4** | **搜索结果里的专辑 / 歌手卡片点不动**（卡片渲染出来，却是死的） | `SearchPanel` 的 `renderItem` 没把 `onOpen` 传给 `AlbumCard` / `ArtistCard`；`SearchPanel` / `SearchPage` 连**属性**都没有 | `SearchPanel` + `SearchPage` 新增 `onOpenAlbum` / `onOpenArtist` 属性，`App.tsx` 接上既有的下钻出口 | `test/favorite-writeback.test.ts`（新增 1 条，**变异自证**：拆掉接线即失败） |
| **T18-5** | **下载完成后不刷新本地索引** —— 按钮不显示「本地」、**本地优先播放不生效** | 主进程的 `download:changed` 事件**只带 `tasks`**；渲染进程的 `entries`（「已下载」徽标与 `resolvePlaybackSource` 的**唯一依据**）压根没更新 | `src/state/downloadStore.ts`：任务变 `done` 时**重新 `load()` 拉一次索引**（**不改 IPC 契约**） | `test/download-store.test.tsx`（新增 2 条） |
| **T18-6** | **下载到本地 / 本地优先播放 / FFmpeg 兜底产物 —— 三条线全部播不了**，提示「该音频无法播放：当前内核不支持该格式」（**误导**：看着像格式问题） | 页面 CSP 的 `media-src` 只放行了 `fnm:`，**漏了 `fnml:`** → Chromium 的 URL 安全检查**直接拒绝** `<audio src="fnml://local/track/…">`（`MediaError` code 4「Media load rejected by URL safety check」） | `index.html` / `lyric.html`：`media-src` 加 `fnml:`（**不放宽 `connect-src`** —— 渲染层从不 fetch `fnml://`） | `test/csp-media-src.test.ts`（新增 10 条，**变异自证**：漏放即 3 条红） |

> ⚠️ **这几个缺陷为什么单测没抓到**：
> - T18-1 只影响**真实网络**（mock 的地址带显式端口）；
> - T18-2 只影响**布局**（jsdom 没有布局引擎，不产生可观测差异）——所以新测试断言的是**内联样式的百分比数值**；
> - T18-3 只影响**真实服务端**（mock 之前就是按错误契约实现的，等于在自证）。
> - T18-5 只影响**真机**（单测里 `download:changed` 是手工构造的，事件载荷与主进程一致）。
> - T18-6 **只有真机起 Electron 才暴露**：它既不在 HTTP 层（探针打不到），也不在 jsdom 里
>   （jsdom 没有 CSP、也没有媒体栈）。更麻烦的是它的**报错文案完全指错方向**
>   ——「当前内核不支持该格式」其实是「被 CSP 拦了」，线索只在**浏览器控制台**里：
>   `Refused to load media from 'fnml://…' because it violates … Content Security Policy`。
>
> 这几条共同的教训：**mock 必须与真实服务端同形**，否则 mock 只会把错误契约一起验证成「正确」。
>
> ⚠️ **还有一条更深的教训：活体验检自己也太弱。**
> 原来的「播放」一步**只验「播放条标题更新」** —— 于是「媒体根本没播起来」也会被判成通过，
> T18-6 正是这样漏过去的（它播的是 `fnm://`，而 `fnm:` 在 CSP 里是放行的）。
> 现已加严为「**进度必须真的推进**」，并新增「本地播放（下载后走 `fnml://` 且进度推进）」一步。

---

## 八、T19 校准补测：把「只来自规格」的假设换成实测

T18 收尾后，台账上还剩几项**只来自规格、从未在真服务端验证过**的假设。
T19 就是把它们逐条换成实测事实。

### T19-1：「token 失效」的真实形状（T17 Step C 补测）

**问题**：`shared/constants.ts` 的 `CODE_TOKEN_EXPIRED = 99999` 与「收到 99999 → 静默续期一次 → 重试」
这条路径，一直**只来自规格**（设计文档 §2.1）与 mock server。而 Step C 之所以一直标「真机无法验证」，
是因为服务端**不提供**「作废当前 token」的接口 —— 等不到 token 自然过期。

**换个角度就能测**：**故意带错的 token** 打受保护端点。服务端看来这就是「token 对不上」，
与「token 过期」是同一件事。新增 `tools/fn-token-expiry-probe.mjs`。

**实测结果（真实 NAS，中继链路）**：

| 用例 | HTTP | 响应 |
|---|---|---|
| 有效 token（基线） | 200 | `code=0` |
| 随机 32 位十六进制 token | **401** | `{ code: 99999, msg: "INVALID TOKEN" }` |
| 有效 token 改最后一个字符 | **401** | `{ code: 99999, msg: "INVALID TOKEN" }` |
| 空 token | **401** | `{ code: 99999, msg: "INVALID TOKEN" }` |
| 只有中继 Cookie（没有 `music-token`） | **401** | `{ code: 99999, msg: "INVALID TOKEN" }` |
| 有效 token + 不存在的端点（对照） | 200 | **HTML**（fnOS 的 SPA 兜底页，没有业务码） |
| 完全不带 Cookie 头（客户端到不了） | 200 | **HTML**（同上） |

**结论**：

1. ✅ **业务码 99999 与真服务端一致** → 静默续期的触发条件**成立**。
2. ✅ **token 失效时服务端用的是 HTTP 401**（不是 200）——
   客户端**不按状态码判定**（`readJson()` 不看 `status`，只解析 body），所以 401 照样能续期。
   二进制流路径（`track/stream`）更是**直接按 401/403** 静默续期一次并重发（`electron/proxy.ts`）。
3. ⚠️ **路径不存在时服务端回的是 SPA 兜底页（HTML）**，里面**没有**业务码 →
   **不能**把它当成「token 失效」（否则会白白续期一次再重试）。

**配套回归测试**（`test/session.test.ts` 新增 2 条）：原单测一律用「HTTP 200 + body 里的 99999」
模拟，恰好漏掉了真实服务端的两面（401 / HTML）。现在钉住了：

- 「真服务端的形状（HTTP 401 + body 里的 99999）照样触发续期并重试」
- 「响应不是 JSON（fnOS 的 SPA 兜底页）时**不**触发续期」

### T19-2：系统**没有** FFmpeg 时的提示（T17 Step D 补测）

**问题**：Step D 最后一个子项「确认系统无 ffmpeg 时的提示」一直没测 ——
因为本机装了 winget 版 ffmpeg 9.0.2，平时测到的永远是「有 ffmpeg」那条分支。

**做法**（新增 `tools/fn-no-ffmpeg-probe.mjs`）：**启动 Electron 时把 PATH 里的 ffmpeg 目录摘掉**，
让应用「以为」本机没有 ffmpeg（`detectFfmpeg()` 逐个候选试 `-version`；
摘掉 PATH 里那个之后，另外三个固定候选路径本机也不存在 → 必然探测不到），
然后播一首 **ALAC**（Chromium 解不了的格式），看界面提示。

> ⚠️ **为什么不给它一个真的 ALAC 文件**：兜底转码的判定顺序是
> 「有本地副本？→ 有 FFmpeg？→ 才转码」。只要索引里有**一个**指向本地文件的条目就够了，
> 压根走不到「读文件内容」那一步 —— 用一个几字节的占位文件即可，省掉 24 MB 的下载。

**实测结果**：

```
✓ 从 PATH 里摘掉 1 个含 ffmpeg.exe 的目录
✓ 目标：「红鞋女孩 - Live」｜ALAC｜24.2 MB
✓ 登录成功（本次启动的 PATH 里没有 ffmpeg）
【播放提示】该格式（ALAC）当前无法播放：未检测到 FFmpeg。安装 FFmpeg 后即可通过转码播放。
  ✓ 提示包含「未检测到 FFmpeg」→ 用户知道**下一步做什么**（装 FFmpeg）
```

**结论**：✅ 提示是**「说清楚缺什么、下一步做什么」**的人话，
不是「内核不支持该格式」那种把用户引到一条走不通路上的误导文案。
（`src/player/format.ts` 的 `fallbackUnavailableMessage('no-ffmpeg')` 分支真机复验通过。）

### T19-3：规格 §5.4 的「续期失败 → 回登录页」—— **已实施**（原为缺失）

规格 §5.4 写的是：「token 失效（99999）→ 静默续期一次；**失败则派发 `auth-lost` 事件回到登录页**」。

查完代码后的原始结论：

- ✅ 「静默续期一次」**已实现**（主进程 `electron/session.ts` 的 `request()`），且触发条件经 T19-1 实测成立；
- ❌ 「失败则派发 `auth-lost` 回到登录页」**整条链路都不存在**：
  全仓库只有规格文档里出现过 `auth-lost` 这个名字，
  `src/` 与 `electron/` 里**没有任何**地方检查 `99999`、也没有任何地方派发类似事件。
  `sessionStore.reset()`（登出）虽然存在，但**没有任何调用点**。

**后果（修复前）**：token 真的过期、且**续期也失败**时（例如用户改了 NAS 口令、
或续期那一刻中继不通），用户只会看到当前页面冒出一句 `INVALID TOKEN`，
而且**之后每个请求都会再失败一次**，界面停在「已登录」的死状态里；
只有自己点「连接 → 退出登录」才能脱身。

**已实施的修法**（用户拍板：**按规格**——任何 99999 到渲染层就清会话 + 回登录页 + 提示重新登录）：

| 落点 | 改动 |
|---|---|
| `src/api/client.ts` | 业务码 `99999` → 触发一次「会话失效」通知（`onAuthLost`），并把服务端那句英文的「INVALID TOKEN」换成**人话**「登录已失效，请重新登录」。**同一段失效只通知一次**（并发请求不会重复触发）；一次**成功**的请求即重新武装 |
| `src/App.tsx` | 收到通知 → **立刻** `sessionStore.reset()` + 切回「连接」页；主进程那个已经没用的 token 交给**后台**的 `logout()` 去清（**不等它返回**）。⚠️ 为什么不等：登出要先通知服务端，中继不通时可能挂住十几秒 —— 用户必须**马上**看到「登录已失效」。后台清理失败也无妨：下次启动第一个请求会再次触发这条路径，自愈 |
| `src/pages/LoginPage.tsx` + `login-page.css` | 新增两个可选属性：`notice`（顶部**说明**，`role="status"`，警告色，与表单错误 `role="alert"` 危险色**分开**）；`sessionLost`（会话已死 → **跳过启动时的 `restore()`**）。⚠️ 少了 `sessionLost` 这个开关，登录页挂载时会把 `session.bin` 里那个失效 token 恢复回来，界面又显示成「已连接」，用户根本看不到登录表单 |

**纯渲染层改动**：不碰凭证、不碰出网边界、不改 IPC 契约。

**配套回归测试**（新增 `test/auth-lost.test.tsx` 6 条 + `test/login-page.test.tsx` 3 条 + `test/api-client.test.ts` 改写 2 / 新增 1）：
99999 → 通知 / 同一段只通知一次 / 成功之后重新武装 / 其它码不通知 /
外壳层「清会话 + 调 logout + 切回连接页 + 提示文案」/ **「立刻回登录页」不等 `logout()` 返回** /
登录页说明位 / **`sessionLost` → 不调 `restore()`** /
api-client 原有两条把 99999 当**普通业务码**断言「msg 原样带出去」——本任务**明确改变了 99999 的行为**，
故按规矩**改写为普通业务码 100002 的新行为断言**（断言强度不变、语义更准），另**新增**一条专钉 99999 新行为。
**一条测试没删、断言没削弱。**

**变异自证**（本轮实际跑过）：
- 拆掉 `notifyAuthLost()` 调用 → `test/auth-lost.test.tsx` **4 条立刻红**；
- 把 App 改回「先 `await logout()` 再切视图」→ 「立刻回登录页」那条**立刻红**；
- 去掉 LoginPage 的 `sessionLost` 守卫 → 「不调 `restore()`」那条**立刻红**（界面显示成「已连接」）。

---

## 九、T20：拖动进度条定位（Range / 206）—— 从「假设」换成「实测」

### 背景：这条链路**整条都没被任何测试覆盖过**

「拖动进度条定位」由三段组成：

```
渲染进程（用户拖进度条）
  → `fnm://` 代理（透传 `Range` 头、原样带回 `206` / `content-range`）
    → NAS 的 `GET /music/api/v1/track/stream?guid=…`
```

逐段核对测试覆盖情况（改动前的真实状态）：

| 段 | 状态 |
|---|---|
| UI 拖动 → 预览 → 松手提交 | ✅ 有实现、有单测（`PlayerBar.tsx` 的 `pendingSeekRef` 幂等守卫） |
| `store.seek` → 引擎 `seek` → 写 `currentTime` | ✅ 有单测 |
| 代理透传 `Range` / 原样带回 `206` | ✅ 有单测，但上游是**手搓的假 `Response`** |
| **端到端（真打过一个会分段的服务器）** | ❌ **零覆盖** |
| **浏览器里真的拖一下** | ❌ **零覆盖** |
| **上游到底支不支持 Range** | ⚠️ **假设**（审计 P3-9 写的是「真实 NAS 支持」，无实测记录支撑） |

审计 P3-9 记的是「mock `track/stream` 不支持 Range/206」——那只是 mock 的缺陷，
**掩盖了更大的问题：整个「拖动定位」在集成层与真机层都没验过**。
而 T18 的教训正是「单测绿 ≠ 真能用」（当时只看播放条标题，就漏掉了「媒体根本没播起来」）。

### 修法：分三层，各用各的手段（**不混为一谈**）

| 层 | 手段 | 验什么 | 为什么不能挪到别的层 |
|---|---|---|---|
| ① HTTP 层 | mock 支持 `206`；Node 直打 | `Range` 头透传、`206` 原样带回、**字节切片真的对** | ⚠️ WAV 从中间字节开始返回时**没有文件头**，Chromium 的 WAV 解码器**解不了** → 浏览器层验不了字节正确性 |
| ② 客户端契约层 | E2E 拖进度条 + 劫持 `HTMLMediaElement.prototype.currentTime` 的 setter | 「用户拖了 → 媒体元素**真的**被 seek 到目标位置」 | 不断言「能否从新位置继续播」——那是**上游能力**，不该由 mock 决定 |
| ③ 上游能力层 | 真机探针 `tools/fn-range-probe.mjs` | **NAS 到底支不支持 Range、分段字节准不准** | mock 是假 NAS，**回答不了**上游能力 |

### 改动

**`mock-server/server.ts`**

- `track/stream` 支持 `Range`：`bytes=N-M` / `bytes=N-` / `bytes=-N`（后缀）→ **`206`** +
  `content-range: bytes N-M/总长` + `accept-ranges: bytes`；起点越界 → **`416`** + `content-range: bytes */总长`；
  无 `Range` → **`200`** 整段，但**必须**带 `accept-ranges: bytes`（否则客户端不知道这资源可分段）。
- WAV 音频从 **0.5 秒加长到 60 秒**并**缓存**：曲库里的歌标称 165~240 秒、而真实音频只有 0.5 秒 →
  媒体元素的 `durationchange` 会把时长改成 0.5 秒 → 进度条最大值只有 0.5 秒 → **「拖动定位」根本没机会被测**。
- `RouteCtx` 增加 `headers`（原本拿不到请求头）。

**测试**

| 文件 | 内容 |
|---|---|
| `test/mock-server.test.ts`（**+6 条**） | 无 `Range` → 200 + `accept-ranges`；`bytes=0-99` → 206 + `content-range` + **字节等于整段的前 100 字节**；`bytes=100-` → 起点真的是第 100 字节；`bytes=-100` → 取的是**最后** 100 字节；end 越界 → 钳到末尾（不是 416）；起点越界 → 416；多区间 / 空区间 → 416 |
| `test/proxy-range.test.ts`（**新，3 条**） | **代理 × 真实 mock 的端到端**：`fnm://` 带 `Range` → 上游真回 206 → 状态码 / `content-range` / `accept-ranges` 原样带回 → **body 字节等于整段音频对应的切片**（且**确实不是**整段） |
| `e2e/smoke.spec.ts`（**+1 条**） | 拖进度条 → 劫持 `currentTime` 的 setter → 断言**媒体元素真的被 seek 到目标位置**（不是只动滑块）；且那个写入值必须 **> 1 秒**（否则「只是重播了一下」也能满足） |
| `tools/fn-live-check.mjs`（**+1 步**，14 → 15） | 真机拖动定位：断言 ① 媒体被 seek 到目标位置；断言 ② **进度从新位置继续推进**（真机独有：mock 做不到）。**另加构建新鲜度闸门**（见下） |
| `tools/lib/fresh-build.mjs`（**新**） | 构建新鲜度闸门：产物（`dist/assets/main-*.js` + `dist-electron/main.js`）比源码（`src/` / `shared/` / `electron/`）旧就**硬失败**（退出码 3） |
| `tools/fn-seek-diag.mjs` / `tools/fn-seek-diag2.mjs`（**新**） | 真机 seek 链路诊断：v1 = 用户路径四个实验；v2 = 读 **React fiber** 的 hook 状态 + 直接调用 fiber 上的 React handler（把「事件没送到」与「handler 跑了但没送达」彻底分开） |
| `tools/fn-range-probe.mjs`（**新**） | 上游能力探针：NAS 支不支持 `Range`、分段字节准不准、越界行为 |

### 真机实测结论（`tools/fn-range-probe.mjs`，T20 新增）

对真实 NAS（中继 `https://<FN-ID>.fnos.net`）实测 `GET /music/api/v1/track/stream?guid=…`：

| 探针 | 实测结果 |
|---|---|
| 不带 `Range` | `200`｜`content-type: audio/mpeg`｜`accept-ranges: bytes`｜`content-length: 1981511` |
| `Range: bytes=0-1023` | **`206`**｜`content-range: bytes 0-1023/1981511`｜收到 1024 字节 |
| `Range: bytes=512-1535` | **`206`**｜`content-range: bytes 512-1535/1981511`｜收到 1024 字节 |
| **重叠区间字节比对**（审计与历史注释都**没有**过的判据） | `bytes=512-1535` 的前 512 字节 **==** `bytes=0-1023` 的后 512 字节 → **完全一致** ✓ |
| 起点越界（`bytes=1981521-`） | **`416`**｜`content-range: bytes */1981511` |

**结论**：✅ **NAS 支持 Range，且分段字节精确** —— 拖动定位的上游前提**成立**。
⇒ 客户端的 `fnm://` 代理透传 `Range` + 原样带回 `206`，拖动定位就能真正生效。
⇒ 顺带把 mock 的 `416` 语义**校准成与真机一致**（`content-range: bytes */总长`）。

⚠️ 此前 `src/api/history.ts` 的注释里有一行「实测：GET `/track/stream` 拿到 **206** 音频」——
只能证明「**拿到过 206**」，证明不了「**分段的字节是精确的**」；本轮补的就是后者。

### 真机拖动定位：踩到并修掉一个**流程缺陷**（**不是**产品缺陷）

第一次跑真机 15 步时，新增的「拖动进度条定位」那一步**红了**：
媒体元素的 `currentTime` **一次都没被写过**（劫持 `HTMLMediaElement.prototype.currentTime`
的 setter 记录写入值 → 写入列表为空），而界面上的预览值会动、也会复位。

排查用 `tools/fn-seek-diag.mjs`（用户路径四个实验）→ `tools/fn-seek-diag2.mjs`（读 React fiber），逐环排除：

| 环 | 怎么验的 | 结果 |
|---|---|---|
| ① `onChange` 跑了吗？ | 从 **React fiber** 里读 `PlayerBar` 的 hook 状态（`pendingSeekRef` 是 `useRef` → `memoizedState.current`） | ✅ 跑了：派发 `input/change` 后 `pendingSeekRef.current = 52.5` |
| ② `commitSeek` 跑了吗？ | 同上 | ✅ 跑了：派发 `mouseup` 后 `pendingSeekRef.current = null`、预览值复位 |
| ③ 中间抛异常了吗？ | 全程捕获渲染进程的 `pageerror` / `console:error` | ✅ **零**异常（只有 1200+ 条封面 scheme 的 warning） |
| ④ 组件被重新挂载了吗？ | 给滑块 DOM 节点打标记，看标记还在不在 | ✅ 节点没换 ⇒ 不是重挂载 |
| ⑤ 那到底是谁的问题？ | **去看产物**：`dist/assets/main-*.js` 里压缩后的 `commitSeek` | ❌ **没有** `getState().seek(...)` |

**真因**：真机跑的是**一份陈旧的 `dist/`** —— 那份产物里压缩后的 `commitSeek` 只有
`_.current !== null && (_.current = null, x(null))`（清预览值），**没有** `store.getState().seek(pending)`。
⇒ 「松手」永远只复位预览、**从不真的定位**，而且**全程没有任何报错**。

**为什么 E2E 是过的**：`npm run e2e` = `npm run build && playwright test` —— 它**每次都重建** `dist/`；
而真机活体验检**直接吃磁盘上那份 `dist/`**。
⇒ 同一个「拖动定位」，**E2E 测的是新代码、真机测的是旧代码**，两边结论天然对不上。

**修法（两条）**：

1. **重建产物**：`npm run build` 之后重跑真机 → 媒体的 `currentTime` 真的被写成目标值
   （探针实测 `writes: [52.5]`）并从新位置继续播，**零异常**；
2. **加闸门**：新增 `tools/lib/fresh-build.mjs`，真机脚本（`fn-live-check.mjs`、`fn-seek-diag2.mjs`）
   启动前一律检查「产物是否比源码新」，**旧了就以退出码 3 硬失败** ——
   宁可误报（多跑一次 build），不可漏报（静默测旧代码，正是 T20 踩的坑）。

⚠️ **这条教训比功能本身更值钱**：今后凡是「真机红 / E2E 绿」的矛盾，**先查产物是不是新的**。

### 变异自证（本轮实际跑过，全部红过再改回）

| 变异 | 结果 |
|---|---|
| mock 的 `track/stream` 不实现 `Range`（总是 200 整段） | `test/mock-server.test.ts` + `test/proxy-range.test.ts` **8 条立刻红** |
| 代理的 `FORWARD_REQUEST_HEADERS` 去掉 `range` | `test/proxy-range.test.ts` + `test/proxy.test.ts` **5 条立刻红** |
| `PlayerBar` 的 `commitSeek` 不再调 `store.getState().seek()` | E2E 的「拖动进度条」那条**立刻红**（滑块动了，媒体没被 seek） |

### 遗留 / 待办

- **真机端到端拖动定位**已进 `fn-live-check`（15 步），但它依赖「首个曲目」——真机曲库顺序会变，
  若哪天第一首换成**不可随机访问**的格式，该步会红（那是**上游事实**，不是回归）。
- mock 的音频是 WAV（不可随机访问）→ **E2E 永远只能验客户端契约**，验不了「从新位置继续播」；
  这条只有真机能验（已进活体验检）。
- 探针脚本 `tools/fn-range-probe.mjs` 只读，不写任何数据；凭证只从环境变量读，不打印、不落盘。
- ⚠️ **真机脚本现在会因「产物旧」而拒绝运行**（退出码 3）——这是**故意**的。
  跑真机前先 `npm run build`。
- ⚠️ **真机上封面刷出上千条 `MediaImage src can only be of http/https/data/blob scheme: fnm://…`
  warning**。
  ⚠️ **T21 复核后更正**：这条 warning **不是**「应用内封面不显示」——
  实测（`tools/fn-cover-probe.mjs`）应用内 `<img src="fnm://…">` **能正常解码**
  （第一张 `naturalWidth = 200`），因为 `<img>` 走的是**另一条**图片加载器。
  真正被拒的是 **`navigator.mediaSession.metadata.artwork`**（Windows 快速设置 / SMTC 的专辑图），
  Chromium 的**媒体会话**图片加载器只认 `http/https/data/blob`。
  ⇒ 详见第十节（T21）；T21 修完后这条 warning 已降到 **0 条**。




## 十、T21：Windows 媒体会话（SMTC）的专辑图 —— 从「看不见」到「有图」

### 背景：T20 留下的一条 warning，指向的**不是**它看起来指向的东西

T20 的真机活体验检刷出上千条：

```
MediaImage src can only be of http/https/data/blob scheme: fnm://srv/static/cover?coverId=album_…&size=160
```

当时记的是「封面没显示出来」。**这是误判** —— T21 用新探针 `tools/fn-cover-probe.mjs` 量过：

| 测什么 | 实测 |
|---|---|
| 应用内 `<img src="fnm://…">` | 942 个 `<img>`；第一张 `complete=true`、`naturalWidth=200` → **解码成功** ✓ |
| 渲染层 `fetch('fnm://…')` | `200`｜`image/jpeg`｜8684 字节 ✓ |
| 字节转 `blob:` 后解码 | 200×200 ✓ |
| 那批 warning 的来源 | **`navigator.mediaSession.metadata.artwork`**（`size=160`，与 `MEDIA_ARTWORK_SIZE` 一致） |

⇒ **`<img>` 与媒体会话 artwork 走的是两条不同的图片加载器**：

- `<img>` 能吃 `fnm://`（协议已注册 `standard + supportFetchAPI + corsEnabled`）→ **应用内封面是好的**；
- **媒体会话**的封面只认 `http/https/data/blob` → `fnm://` 被拒 → **Windows 快速设置 / SMTC / 锁屏的专辑图是空的**。

⚠️ 教训：「同一个 URL 在一个地方能用、在另一个地方不能用」时，**别把结论扩大到全部** ——
先量清楚「是哪一条加载器」再说。

### 修法（用户拍板：方案 A —— 渲染层自取字节转 `data:` URL）

```
渲染层 fetch('fnm://srv/static/cover?coverId=…&size=160')
  → bytes → base64 → data:image/jpeg;base64,…
    → navigator.mediaSession.metadata.artwork[0].src
```

- **不碰主进程、不加 IPC、不改协议注册** —— 渲染层本来就能 `fetch('fnm://')`（实测 200）；
- `data:` URL 在渲染进程与浏览器进程两侧都能解，**不需要**改 CSP（`img-src` 已放行 `data:`）；
- 封面字节走的仍是**同一条 `fnm://` 出网代理**，凭证边界不变。

### 改动

| 文件 | 内容 |
|---|---|
| `src/player/mediaSession.ts` | 新增 `bytesToDataUrl()` / `dataUrlMime()` / `fetchArtworkDataUrl()`（默认实现）；`MediaSessionDeps` 新增可注入端口 `fetchArtwork`；元数据改成**两段式**：先出标题等元数据（artwork 暂空），封面字节到了再补一次；带 LRU 缓存（16 条）+ **换歌令牌**守卫（旧的封面回来不许盖掉新歌） |
| `test/media-session.test.ts` | **改写 1 条**（旧断言钉的是「artwork 里塞 `fnm://`」—— 本任务明确推翻了该前提）+ **新增 9 条** |
| `tools/fn-cover-probe.mjs`（新） | 真机探针：量应用内封面实况、渲染层 fetch、blob 解码、媒体会话 artwork 的 scheme、那条 warning 的条数 |

### 真机实测（`tools/fn-cover-probe.mjs`，T21 新增）

| 探针 | 修复前 | 修复后 |
|---|---|---|
| 媒体会话 artwork 的 scheme | `fnm` | **`data`**（`data:image/jpeg;base64,/9j/4AAQS…`，`sizes=160x160`，`type=image/jpeg`） |
| `MediaImage src can only be …` 警告 | 上千条 | **0 条** |
| 应用内封面 | `naturalWidth=200`（本来就是好的） | `naturalWidth=200`（无回归） |

### 变异自证（本轮实际跑过，全部红过再改回）

| 变异 | 结果 |
|---|---|
| `fetchArtworkDataUrl` 不做 `data:` 转换（原样交出 `fnm://` = 旧行为） | 「默认实现」那条 **立刻红** |
| 去掉换歌守卫（旧的封面回来盖掉新歌） | 「换歌后：旧封面回来不能盖掉新歌」那条 **立刻红** |
| 去掉封面缓存（每次都重新取） | 「同一首歌反复推状态：封面只取一次」那条 **立刻红** |

### 遗留 / 待办

- Windows 侧「专辑图真的显示出来了」**只能由用户肉眼确认**（SMTC 在系统 UI 里，脚本够不着）；
  脚本能证明的是「artwork 是 Chromium 认得的 `data:` URL」+「那条警告为 0」。
- 封面字节现在**取两次**（托盘在主进程取一次、媒体会话在渲染层取一次，各约 9 KB）。
  用户拍板选了方案 A（不新增 IPC）；若日后在意流量，可改成「主进程把已缓存的字节给渲染层」。
- `MEDIA_ARTWORK_SIZE = 160` 的**真实 NAS 取值仍未校准**（审计 Step K）—— 与托盘一致，等联调校准。
- ⚠️ **新发现（T21 顺带查出，既有缺陷、非本轮回归）：曲库网格的「封面请求风暴」**。
  实测：打开专辑页会挂载约 **942** 张卡片 → 约 **942 个** `static/cover` 请求（约 8 MB）
  → 公共中继 `<FN-ID>.fnos.net` 扛不住时**大面积 502**，界面上大片封面空白。
  佐证：T21 前后各跑一次真机，一次 901 条 502、一次 0 条；502 全是 `size=200`（应用内卡片封面），
  发生在**播放之前**（专辑页第 5 步），与 T21 改的 `size=160`（媒体会话封面，第 12 步才发生）无关。
  ⇒ 待办（下一任务候选）：真正懒加载 / 限制并发 / 只请求可见区域的封面。
## 十一、T22：曲库网格撑破虚拟裁剪 —— 封面请求风暴 + 无限翻页

### 背景：那批「九百多条 502」不是中继的锅，是**布局**的锅

T21 复查时顺带发现：真机跑一轮会冒出**九百多条 502**。当时判成「公共中继带宽不够」——
**判错了**。继续挖才挖到真正的根因：根因在**客户端布局**，跟服务端没关系。

### 真机量到的证据（`tools/fn-cover-probe.mjs` 的 ① / ①-b / ①-c 段）

| 量 | 修复前 | 修复后 |
|---|---|---|
| `window.innerHeight` | 735 | 735 |
| `.app-shell` clientHeight | **41,477** | **735** |
| `.app-shell__main` clientHeight | **41,316** | **574** |
| `.app-shell__main` 的 `min-height` | `auto` ⚠️ | `0` |
| `.fnm-page` clientHeight | 41,316 | 574 |
| `.fnm-cardgrid` clientHeight / scrollHeight | **41,216 / 41,216**（**不滚动**） | **499 / 2,016**（自己滚动） |
| 网格里挂载的卡片数 | **1,050** | 一个窗口放得下那么多 |
| `document.documentElement.scrollHeight` | 41,477 | **735**（= 窗口高度，无幽灵滚动） |

⇒ 网格的「可视区」= **全部内容** → **虚拟裁剪等于没裁剪** → 1,050 个节点 → 1,050 个封面请求 → 中继被打爆；
同时「内容填不满可视区就自动续一页」的副作用**永远成立** → **无限翻页**（34,071 张专辑理论上会被全拉下来）。

### 根因链：**三层，缺一层都修不好**（本轮踩了两次「只修一层」的坑）

```
第 1 层：外壳高度「不定」
  .app-shell { min-height: 100vh }        ← 只有 min-height，高度是「不定」的
  ⇒ flex 布局里 `flex-basis: 0%`（百分比）**退化成「按内容算」**
     （CSS Flexbox：容器主尺寸不定时，百分比 flex-basis 按 content 处理）
  ⇒ **谁都没有负余量可压缩** → 主区被内容顶到 4 万多像素

第 2 层：主区的自动最小尺寸
  .app-shell__main（flex item）默认 `min-height: auto` = 内容的 min-content 高度
  ⇒ 主区的自动最小尺寸跟着画布高度暴涨 → 主区自己也被顶高
  ⇒ 只写 `min-height: 0` 能压住主区，但**页面外壳不会跟着缩**

第 3 层：页面外壳不是弹性项
  .app-shell__main 是**块级容器** → .fnm-page 是普通块级盒子
  ⇒ `height: 100%` 的百分比**解析不出来**（父级高度「不定」）→ 按 auto 处理
  ⇒ 页面外壳 = 内容多高就多高 → 网格也跟着撑到 4 万像素
```

**实测走过的两条弯路**（都只修了一层，E2E 直接打脸）：

1. 只加 `min-height: 0` → 主区仍 40,058px、网格仍 40,000px（页面外壳没缩）；
2. 再把主区改成 flex 列容器 → 外壳高度仍「不定」→ 主区仍 40,058px、网格仍 40,000px。

⇒ 最终修法是**把整条链打通**：`html/body` 有确定高度 → 外壳 `height: 100vh`（确定）
→ 主区 `display: flex; flex-direction: column; min-height: 0` → 页面外壳成为弹性项、
`flex: 1 1 auto` + `min-height: 0` 生效 → 网格才真的在自己内部滚动。

### 改动（**分三层**，CSS 根因 / TS 兜底 / 行为回归）

| 层 | 文件 | 动作 |
|---|---|---|
| CSS 根因 | `src/styles/global.css`（新） | `html, body { height: 100%; margin: 0 }` —— 去掉 UA 默认的 8px 边距（否则播放条底边被裁 8px，还多出一段 16px 幽灵滚动） |
| CSS 根因 | `src/styles/app-shell.css` | `.app-shell { height: 100vh }`（**确定**高度）、`.app-shell__main { display: flex; flex-direction: column; min-height: 0 }` |
| CSS 根因 | `src/pages/search-page.css` / `src/components/search-panel.css` / `src/pages/login-page.css` | 主区变矮之后，这三处必须有**自己的确定高度 + 滚动容器**，否则内容溢出到播放条上；登录卡另加 `align-items: flex-start`（原来靠 `stretch` 撑满，卡片一高就被裁） |
| TS 兜底 | `src/components/viewport.ts`（新） | `clampViewportHeight()`：把**量到的**可视区高度钳到 `window.innerHeight` —— 万一布局又被别的东西顶开，挂载量与翻页次数也不会失控 |
| TS 兜底 | `src/components/Cards.tsx` / `src/components/SongList.tsx` | 接入钳位（**注入的 `viewportHeight` 一律不钳** —— 那是调用方的显式契约，钳它会破坏既有单测） |
| 行为回归 | `test/virtual-viewport-clamp.test.tsx`（新） | 8 条：钳位行为 4 条 + CSS 根因契约 4 条 |
| 行为回归 | `e2e/smoke.spec.ts` | 新增 1 条 E2E：伪造「内容远超高」，断言网格**自己滚动**、主区不超窗口 |

### E2E 回归：怎么在 mock 上复现真机的失效条件

⚠️ mock 只有 **3 张专辑 / 8 首歌**（`test/mock-server.test.ts` 钉死了这些数量，
**不能**为了让缺陷显形而扩 mock 数据）→ 撑不出真机那个量级。
于是用 `!important` 把画布高度压到 40,000px —— **复现同一个失效条件**：
「内容远超高时，容器必须自己滚动，而不是被内容顶高」。

断言的是**几何关系**（`grid.clientHeight < grid.scrollHeight`），不是「画了多少个节点」
（mock 只有 3 张专辑，节点数恒等于 3，断言不了）。

### 变异自证（本轮实际跑过，全部红过再改回）

1. 把钳位短路成 `return height` → **4 条**行为测试立刻红（网格挂载 1,050 / 歌曲挂载 500 / 两个「自动续一页」被触发）；
2. 把 `.app-shell__main` 的 `min-height: 0` 改成 `auto` → CSS 契约测试**红**；
   ⚠️ 第一版契约测试是**空断言**——规则注释里正文就写着「`min-height: 0` 不能省」，
   断言匹配到了**注释里的那行字** → 改成「先剥注释再匹配」后才有鉴别力；
3. 把 `.app-shell` 的 `height: 100vh` 改成 `auto` → **E2E 红**（网格回到 40,000）。

### 真机复验（`tools/fn-live-check.mjs` + `tools/fn-cover-probe.mjs`）

| 测什么 | 修复前 | 修复后 |
|---|---|---|
| **专辑页挂载卡片数** | **1,050** | **30**（= 5 行 × 6 列：3 行可视 + 2 行缓冲）✓ |
| 专辑页**已加载条数** | 无限续页（一直往下拉） | **50**（= 1 页；画布 2,016px = 9 行 × 224）✓ |
| 歌手页 / 风格页挂载卡片数 | 同量级暴涨 | 各 **30** ✓ |
| 歌曲页挂载行数 | 暴涨 | **18** ✓ |
| `.app-shell` clientHeight | 41,477 | **735**（= 窗口高度）✓ |
| `.app-shell__main` clientHeight | 41,316 | **574** ✓ |
| `.fnm-cardgrid` clientHeight | 41,216 | **499** ✓ |
| `document.documentElement.scrollHeight` | 41,477 | **735**（无幽灵滚动）✓ |
| 播放条的位置 | 被顶到 4 万像素以下（**看不见**） | 贴在窗口底部 ✓ |
| 活体验检 | — | **15/15 成功** ✓ |

⚠️ **判读提醒**：真机偶发 **502** 是**公共中继**的老问题（连着跑几轮真机会话会把中继压爆），
与本次修复无关 —— 但**会干扰判读**。判读要以「高度链 + 挂载卡片数」为准，不要以「有没有 502」为准。

### 遗留 / 待办

- 真机复验时公共中继偶发 **502**（老问题：连着跑几轮真机会话会把中继压爆），
  与本次修复无关，但**会干扰判读** —— 判读要以「高度链 + 挂载卡片数」为准。
- 封面 `size` 的真实取值仍未校准（审计 Step K，现用 200 / 160）。
## 十二、T23：自动更新接线 —— 管道通了，**证书与服务器仍待你提供**

### 背景：审计 P2-5 是最后一项开着的代码功能

「代码签名 + 自动更新」是审计报表里**唯一还没动**的重功能。本轮把**管道**接通，
但**签名证书**与**更新服务器**都得**你**提供——这两样本项目**无法代劳**。

### 已在 mock 上实测跑通的整条链（E2E 覆盖）

| 环节 | 实测结果 |
|---|---|
| 渲染层 → 主进程 IPC | ✓（`update:check` / `update:download` / `update:install`）|
| 主进程拉清单（走 **Chromium 分区栈**）| ✓（mock 的 `/update/latest.json`，**不走业务码信封**）|
| 版本比对 | ✓（mock 清单 `9.9.9` > 应用 `0.1.0` → 「发现新版本」）|
| 下载 + **SHA-512 校验** | ✓（假安装包字节与清单哈希一致 → 校验通过、落盘）|
| **Authenticode 闸** | ✓（假包**没有签名** → 判为不通过 → 「启动安装」按钮**禁用**）|
| 真机（未配置地址时）| ✓（`fn-live-check` 新增第 16 步：**不联网**，直接回「还没填地址」）|

### 仍是「假设」的部分（**必须你提供材料才能实测**）

- **更新服务器**：本轮只在 mock 上跑过。真机需要一个 **https** 的静态目录
  （`latest.json` 与安装包**同源同目录**）；
- **代码签名证书**：本项目**不附带**任何证书。证书的**主体名**必须与应用里的
  「预期的代码签名者」一致，否则客户端**拒绝启动安装器**（这是**故意的**）；
- **判定口径**：我们只保证「这个文件确实由预期的人签的」；**信任链由 Windows 自己判断**
  （`Status` 字段如实反映 `Valid` / `NotSigned` / `UnknownError`）。
  另外 `CN` 本身**不是唯一标识**——真正的信任来自「HTTPS + 清单哈希」这条链。

### 六道闸（**每一条都缺一不可**）

| 闸 | 规则 | 挡住什么 |
|---|---|---|
| 地址 | 必须 `https://`（**回环**才允许 `http://`）；不许带凭证 / query | 明文传输、URL 里藏 token |
| 清单 | 逐项校验形状 | 畸形清单 |
| 同源 | 安装包必须与清单**同源** | 清单把安装包指到别处（= 远程代码执行）|
| 哈希 | SHA-512 必须与清单一致 | 下载被篡改 / 传输损坏 |
| 签名 | 必须带签名且**签名者 == 预期** | 装一个没签名的包 |
| 启动 | **没配预期签名者 → 一律不许启动** | 「自动更新 = 远程代码执行」|

### 遗留 / 待办

- **用户侧**：提供更新服务器地址与代码签名证书（怎么配见 `docs/packaging.md` 第七节）；
- 产物当前**未签名** → Windows SmartScreen 会提示「未知发布者」（既有已知限制）；
- 未实测：真实签名证书下的 `Status` 取值（自签证书可能是 `UnknownError` 而非 `Valid`，
  我们的判定**只看签名者主体**，所以不受影响——但**没有实测过**，标为假设）。

---

## 十三、T25：收藏 / 歌单**写回端点**的真机校准（T25 / T26 的前置）

### 为什么必须先测

`src/api/favorite.ts` 与 `src/api/playlist.ts` 里的写回调用，
**参数名是照官方 Web 端猜的**，而且**从来没有在真机上跑过**。
⇒ 客户端里那几个调用**可能是「看着能点、实际报错」的假功能**。

### 探针

新增 `tools/fn-writeback-probe.mjs`（**一次登录、四段结论**）：

| 段 | 回答什么 |
|---|---|
| **F** | `favorite-track/create` / `favorite-track/delete` 的参数名；收藏是否**真的生效** |
| **M** | 曲目对象里**有没有** `isFavorite` 字段（决定行内收藏按钮的初始态能否直接取服务端字段）|
| **P** | `playlist/add-track` / `playlist/remove-track` 的参数名；加歌 / 移歌是否**真的生效** |

⚠️ **副作用与自清理**：探针会**真的收藏一首歌**、**真的新建一个歌单**并加歌 ——
结论拿到后**立即取消收藏 / 删除歌单**；任何一步失败都会明确告知**需要手工清理的 id**。

### 实测结论（真机，真实 fnOS）

| 端点 | 请求体 | 实测 |
|---|---|---|
| `POST /favorite-track/create` | **`{ trackGUID }`** | ✅ `code=0`，收藏列表里**出现**该曲 |
| `POST /favorite-track/delete` | **`{ trackGUID }`** | ✅ `code=0`，收藏列表里**消失** |
| `POST /playlist/add-track` | **`{ guid, trackGUIDs: [id] }`** | ✅ `code=0`，歌单详情里**出现**该曲 |
| `POST /playlist/remove-track` | **`{ guid, trackGUIDs: [id] }`** | ✅ `code=0`，歌单详情里**消失** |
| `POST /playlist/create` | `{ name }` | ✅ **回显 `guid`**（T17 已验，本轮复验）|
| `POST /playlist/delete` | `{ guid }` | ✅ 删除成功，**无残留** |

⇒ **客户端现有的参数名假设全部成立**，一个都不用改。
   （`src/api/favorite.ts` 与 `src/api/playlist.ts` **本轮未改动**。）

**`isFavorite` 字段**：真实曲目对象的 16 个字段里**有** `isFavorite`，
且取值**可信**（实测：已收藏的 `true`、未收藏的 `false`；收藏列表里的曲目也是 `true`）
⇒ 行内收藏按钮的初始态**可以直接取服务端字段**，不必额外拉一次收藏列表。

### 顺带更正一条旧结论

旧表里那行「**服务端没有写接口**」**标题过宽** ——
它当时只针对「**播放历史**写入」（17 个候选历史写端点全是 SPA 兜底），
结论本身没错，但标题会被读成「服务端什么都不让写」。
⇒ 已把标题改成「服务端**不提供播放历史写入**端点」，并补上本节这两行。

### 遗留 / 待办

- **Step G**（收藏 / 歌单跨端同步）：仍需**手机端 App** 配合 → 用户侧。
- 本探针只验「端点可用 + 参数名」；**写回后服务端收藏列表的排序**未验（客户端不依赖它）。

## 十四、T31：真机 UI 缺陷 —— EQ / 队列面板、歌词重复、取色白底

### 背景：用户真机测试的四个反馈

用户在真机上装了 0.1.0，反馈四件事：**EQ 和队列显示不正常、歌词页不对、桌面歌词也不对**。
⇒ 合并成一项 T31（同一批 UI 缺陷，共用同一套取证手段；取色因根因独立且需改缓存语义，单列一处）。

### 取证方式：复制**真实 userData** 起 Playwright 实例

| 步骤 | 做法 |
|---|---|
| 1 | 把真实 userData 目录（`%APPDATA%\fnmusic-desktop`，**含 `session.bin`**）**复制**到临时目录 |
| 2 | **删掉副本里的 `lockfile`** —— 否则 Electron 认为「已有实例」→ 直接 quit |
| 3 | Playwright 起 Electron → **自动登录**（`session.bin` 还在）→ 播《占位曲目一》 |
| 4 | 截图 + **量几何**（`boundingBox()`）+ 取色诊断 + 拉原始歌词对比 |

⚠️ 副本与用户自己的实例**不同 userData → 不同单实例锁** → 不干扰用户正在跑的实例。

### 四个根因（逐个修）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | **点 EQ / 队列，屏幕上什么也没有** | `.fnm-playerbar` **没有 `position`** → 两个浮层（`position: absolute; bottom: 100%`）找不到定位祖先 → 一路向上找到**初始包含块（视口）** → 面板整个跑到**屏幕上方之外**。DOM 里确实有面板（`innerText` 读得到）→ 极易误判成「没渲染」 | 给播放条补 `position: relative` 作定位锚点 |
| 2 | **全屏页队列盖住 × 按钮 / 歌词挤在顶部** | `.fnm-fullplayer__body` 是 `align-items: center` → 右侧面板高度 = **内容高度** → 队列不受高度约束 → **上下溢出** body → 队列行**盖住右上角 × 按钮**（Playwright 报「queue-row 拦截指针事件」）与底部播放控件；歌词区也挤在顶部、右半屏大片留白 | 改 `align-items: stretch` → 面板撑满、队列自己滚动（`overflow-y: auto` + `min-height: 0`） |
| 3 | **同一句歌词显示两遍**（全屏页与桌面歌词都有） | 实测 NAS 对**同一首歌**返回**两条 `source` 不同（1 / 2）但内容逐字相同**的歌词记录 —— 是**同一份 LRC 的两份拷贝**，不是「原文 + 翻译」→ 第二条被当翻译挂上 → 每句显示一遍大字 + 一遍同内容小字 | **两层去重**：条目级（整篇实质相同且偏移相同 → 整条丢弃）+ 行级（实质相同 → 不挂翻译）。真翻译（内容不同）照常显示 |
| 4 | **全屏页背景白底** | 封面刚切过来时可能还没加载好 → 第一次取色失败 → **失败被缓存** → 这一首歌**到重启为止都不再取色** → 背景永远停在兜底色 | **只缓存成功结果** + 失败后**有限次重试**（3 次 / 间隔 1.5s） |

⚠️ 第 3 条的两个页面（`src/pages/FullPlayerPage.tsx` 与 `src/player/lyricOverlay.ts`）
   **共用同一个解析器** `src/ui/lyrics/parse.ts` → **一处修，两处生效**。

### 实测事实（写进代码注释，供后人免得再猜）

| 项 | 实测 |
|---|---|
| `/lyric/list?trackGUID=<guid>` | 返回 **2 条**，`source` = **1 / 2**（数字），`offset` 均 0，**内容逐字相同** → 冗余副本，不是翻译 |
| 封面地址 | `fnm://srv/static/cover?coverId=album_…&size=200`；代理返回 `access-control-allow-origin: *` → canvas 取色**可成功**（实测 `tintVar=#d0cbc7`） |
| 《占位曲目一》guid | `0123456789abcdef0123456789abcdef` |

### 变异自证（本轮实际跑过，全部红过再改回）

| 变异 | 结果 |
|---|---|
| 去掉 `.fnm-playerbar` 的 `position: relative` | CSS 契约测试 **红**（1 条）+ E2E「面板在视口内」**红**（1 条）→ **双保险** |
| `.fnm-fullplayer__body` 改回 `align-items: center` | CSS 契约测试 **红**（1 条） |
| 只去掉**条目级**去重 | **仍绿** —— 被行级去重兜住 |
| 只去掉**行级**去重 | **仍绿** —— 被条目级去重兜住 |
| **两层同时**去掉 | **红**（2 条）→ 症状复现，证明测试钉的是**用户可见行为** |
| 取色失败恢复成「缓存 `null` + 不重试」 | **红**（1 条，超时） |

⚠️ 「只去掉一层仍绿」**不是**测试没鉴别力 —— 是**两层防线互相兜住**（纵深防御的真实收益）。
   要复现症状必须**两层同时**去掉。

### 遗留 / 待办

- 纯 CSS 缺陷用**契约测试**（**剥掉注释后**匹配，否则会匹配到注释正文 = 空断言）+ **E2E 几何断言**（`toBeInViewport`）双保险。
- mock 只有 8 首歌 → **队列溢出类问题在 mock 下无鉴别力** → 必须靠契约测试兜。
- **真机肉眼复验**：仍需用户确认一次（EQ / 队列面板可见、歌词不重复、背景有主色）。
- `tools/fn-ui-repro.mjs`（本轮新增）保留为复现脚本：复制真实 userData → 起实例 → 截图 + 量几何。

## 十五、T32：外部歌词 API —— 选型实测与安全边界

### 背景：用户的诉求

> 「接入一个稳定的歌词 API，设置里也可自己手动设置歌词 API」

拆成两件事：

1. **默认**要有一个**稳定**的外部歌词源（NAS 自带的歌词不全，有些歌根本没有）；
2. 用户要能**自己指定**（换一家、或自建实例、或任意兼容接口）。

⚠️ 用户问了一句「**没有国内稳定的歌词 API 吗**」→ 于是先做了**国内源的实测**，
而不是直接拍一个外国源。

### 候选源实测（2026-11-04，本机真打）

| 源 | 搜索 | 歌词 | 稳定性 | 结论 |
|---|---|---|---|---|
| **网易云** `music.163.com` | 200，**18–235ms** | 200，**31–41ms**，带时间戳 | 歌词 10/10 全绿 | **默认**（国内最快、中文覆盖好）；⚠️ **非官方**公开接口 |
| **QQ 音乐** `c.y.qq.com` | 200，**2.2s** | 200，65ms，带时间戳 | 通 | 当时搜索太慢故不内置；同样非官方 → **T33 换了更快的搜索端点后已内置**（见第十六节） |
| **lrclib.net** | 200，366–1300ms | — | **偶发 503** | **内置备选**（开源、官方、免费；有中文但少） |
| vvhan / injahow / lolimi（第三方聚合） | **不通 / 404** | — | — | 那些公益聚合接口**现已不可用** |

⚠️ 网易云 / QQ 都是**非官方** Web 接口：没有 SLA、条款上属灰色、接口可能变更
⇒ **不押注一家**：默认网易云、内置 lrclib 可切、再留 URL 模板给自建实例。

### 实测到的形状（写进代码注释，供后人免得再猜）

- 网易云搜索：`GET /api/search/get/web?csrf_token=&s={歌名}+{歌手}&type=1&offset=0&total=true&limit=10`
  → `result.songs[]`：`{ id: **数字**, name, artists[0].name, duration: **毫秒** }`
- 网易云歌词：`GET /api/song/lyric?id=&lv=1&kv=1&tv=-1`
  → `{ lrc: { lyric }, tlyric: { lyric }, klyric: { lyric } }` —— **原文与翻译分两个字段**
- lrclib 精确：`GET /api/get?track_name=&artist_name=&duration=` → `{ syncedLyrics, plainLyrics }`
  ⚠️ 这两个是**同一首歌的两种格式**，**不是**原文与翻译 → 只能取其一
- lrclib 模糊：`GET /api/search?q=&track_name=&artist_name=` → 数组（最多 20 条）
- ⚠️ `id` 是**数字**不是字符串 → 读的时候两种都要认（这个坑真实放过一次红）

### 架构：NAS 优先 → 缺了才查外部（用户拍板）

```
渲染层 lyricApi.list(song.id) ──fnm:// 代理──▶ NAS
    ├─ 有内容 ──────────────────────────▶ 直接用（**完全不碰外网**）
    └─ 为空
         │  IPC `lyric:fetch`（songId + title + artist + album + duration）
         ▼
主进程  读 prefs.json 的 `lyric` 偏好 → 选适配器
         │  走 electron/http.ts 的 httpStack（Chromium 分区栈）
         ▼
外部 API ──▶ LRC ──▶ 包成 LyricEntry[]（原文一条 + 翻译一条）
         ▼
渲染层  复用现有 parseLyricEntries → 双语 / 逐字 / 去重 全白拿
```

⚠️ **外部源只负责取回 LRC 原文，解析逻辑一行不改** —— 现有解析器已处理
翻译合并、冗余副本去重、伪逐字降级。
⚠️ 网易云的 `lrc.lyric` + `tlyric.lyric` 正好对应**两条 `LyricEntry`** → 现有解析器自动出双语。

### 安全边界（不可放宽）

| 约束 | 做法 |
|---|---|
| 渲染层永不直接发网络请求 | 外部 fetch **全在主进程**（与自动更新 Task 23 同一套纪律） |
| 绝不带 NAS 凭证 | httpStack 的 fetch 是**干净分区栈**（不附 token / Cookie）→ 第三方看不到 NAS 凭证 |
| 证书校验 | 外部 host **不在** `TrustedHosts` → Chromium 默认校验 → **必须 https**（回环才 http） |
| 渲染进程是不可信输入 | 只接受**四个标量**（歌名/歌手/专辑/时长），**不接受任何地址** → 免得把主进程变成任意出网代理 |
| 偏好与凭证分离 | 落 `prefs.json` 的 `lyric` 键（源名 + 模板都不是凭证） |

### 匹配策略：先歌名、再歌手、最后时长

同名歌很多（实测《占位曲目一》有 4 个版本）→ 不比时长就会拿到**别的版本**的歌词。
顺序：① 歌名完全相同 → ② 歌手相同 → ③ 时长 ±3s。
⚠️ 时长全对不上时**不放弃** → 退回「名字+歌手都对」的第一条（各源时长口径不同，宁可给个大概也不给空）。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1456 passed / 59 files**；`playwright test` **17 passed**。
- 本轮改动文件 **U+FFFD = 0**、行尾保持原样（`mock-server/server.ts` 与 `test/media-session.test.ts` 仍是 CRLF，其余 LF）、无 BOM。
- **变异自证（八处全部先红后改回，四个文件逐一核对 sha256 回基线）**：
  1. 「NAS 优先」改成外部优先 → 「NAS 有歌词时外部一次都没被调用」那条 **红**；
  2. 去掉「http 非回环不合法」 → **3 条红**；
  3. 去掉占位符的 **URL 编码** → **红**（歌名里有 `&`、空格是常事）；
  4. IPC 采信**渲染层传来的模板** → 「渲染层传的地址被忽略」那条 **红**；
  5. 去掉候选的**时长筛** → 「同名歌很多时选中时长对得上的那条」**红**；
  6. 失败结果**不缓存** → 「失败结果也缓存」那条 **红**；
  7. 翻译放原文**前面** → 「原文在前」那条 **红**；
  8. 主进程**不查外部源** → **E2E 红**（这条只有 E2E 抓得到：那里才有真实 Electron 主进程 + Chromium 分区栈）。

### 遗留 / 待办

- 网易云 / QQ 是**非官方接口** → 变更风险。缓解：内置 lrclib 备选 + 自定义模板，一键切走；
- lrclib 偶发 503 → 当前**未加重试**（失败会缓存 5 分钟，用户可切源或等缓存过期）；
- 外部歌词通常**无逐字** → 自动降级伪逐字（现有能力）；
- 外部源不可用时**不影响 NAS 已有歌词**的显示（NAS 优先）；
- ⚠️ **真机活体验检未做**：本轮的外部源实测是**直接打 API**（node 探针），没有走完整的「客户端 → 主进程 → Chromium 分区栈 → 外网」链路。
  真实 NAS 上还要再验一次（中继带宽与外网可达性）。

## 十六、T33：QQ 音乐外部歌词源 —— Lyricify 同款免凭据词源

### 背景：用户的诉求

> 「能加入 lyricify fusion 的歌词 api 吗？全屏歌词应该显示所有歌词」

### 先纠正一个前提：Lyricify **没有**可供第三方调用的公开歌词 API

| 查证 | 结果 |
|---|---|
| Lyricify Fusion 的形态 | **Windows 桌面软件**（面向所有接入 SMTC 的播放器），**不是** API 服务 |
| 官方文档站 `docs.lyricify.app` | 只有使用指南，**没有** API 参考 |
| `https://api.lyricify.app/app/connection-test` | `OK`（主站可达） |
| 同站的 `openapi.json` / swagger | **没有** → 也**没有任何文档化的歌词查询端点** |
| Lyricify 账户 | 与 **Spotify 账号**关联（首次登录 Spotify 时自动注册）→ 属**凭证** |

⇒ 「直连 Lyricify 服务器取歌词」这条路需要：用户的 Spotify 账号 + 逆向一个**未公开的私有端点**
→ **不做**（稳定性与合规风险都太高）。

### 真正的抓手：Lyricify 官方开源库把「凭据」写清楚了

`WXRIW/Lyricify-Lyrics-Helper`（**Apache-2.0**，Lyricify 家族开源成员）的**访问凭据表**：

| 来源 | 配置要求 |
|---|---|
| QQ 音乐、网易云音乐、酷狗音乐、汽水音乐、LRCLIB | **无需配置** |
| Apple Music | 必须提供 Media User Token |
| Musixmatch | User Token（可自动获取） |
| Spotify | 必须提供 `sp_dc` Cookie |

⇒ Lyricify 的歌词能力**绝大部分建立在免凭据词源上** → 复刻其中一个（**QQ 音乐**）即可，
**不需要任何账号 / token / OAuth**，也不新增 npm 依赖。

### 端点实测（2026-11-04，本机真打）

| 端点 | 结果 |
|---|---|
| `c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=<词>&format=json` | **200 / 814ms**，`data.song.list[]` |
| `c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=<mid>&format=json&nobase64=1` | **200 / 70ms**，`lyric` = **明文 LRC**、`trans` = 翻译 LRC |
| `c.y.qq.com/soso/fcgi-bin/client_search_cv` / `song.fcg` / `search_client_cp` | **404 已下线** |
| `u.y.qq.com` 的 `music.search.SearchCgiService` | `code: 500001`（参数被拒） |
| `u.y.qq.com` 的 `DoSearchForQQMusicDesktop` | 200 但**列表为空** |

### 踩到的五个真实坑

1. **base64 不是加密**：QQ 的 `lyric` 带 base64 时也只是**传输编码**，解码后仍是明文 LRC
   → **零解密成本**；代码里仍留了一层 base64 兜底（万一哪天 `nobase64` 失效）。
2. **搜索结果带 `<em>` 高亮标签**（实测 `albumname_hilight` 是 `<em>占位曲目五</em>`）
   → 歌名不剥标签就**永远匹配不上**查询的歌名。
3. **`interval` 是「秒」**（实测《占位曲目五》= 256，对应 4:16）→ 与 `pickCandidate` 口径**一致**，
   **不用**除以 1000（网易云才是毫秒）。
4. **该歌词端点不返回 `qrc`** → **拿不到逐字**（逐字在 `u.y.qq.com` 的 `PlayLyricInfo`，
   `qrc` 是**密文**）→ 本轮**不做**（留给后续任务）。
5. ⚠️ **歌词端点强制要求 `Referer`**（**搜索端点不要求**）：
   - 带 `Referer` → `retcode=0`、歌词带时间戳（200 / 72ms）；
   - 只带 UA、**不带** `Referer` → **`retcode=-1310`**、歌词长度 0 → **静默失败**（HTTP 仍是 200）。

   ⇒ 那个 `referer` 头是**必需的**，且**绝不能**指望「少了也能用」。
   ⚠️ 已在**真实 Electron 主进程**里验过（`session.defaultSession.fetch`）：
   带 `referer` → `retcode=0` / `lyricLen=1743` / 带时间戳；
   不带 → `retcode=-1310` / `lyricLen=0`
   ⇒ Chromium 网络栈**不会**把它当「受限头」丢掉 → 主进程直连这条路走得通。

### 用户拍板的三个决策

| 决策点 | 结论 |
|---|---|
| 集成档位 | **接 Lyricify 同款免凭据词源**：新增「QQ 音乐」内置源（行级 LRC + 翻译） |
| 全屏歌词形态 | 歌词舞台式（全量渲染 + 当前行放大逐字高亮 + 自动滚动）→ **T34**，本轮不做 |
| 多源策略 | **保持单选**，行为与 T32 一致；**默认值仍是网易云**（QQ 搜索 814ms 明显更慢） |

### 改动

| 文件 | 内容 |
|---|---|
| `shared/lyricProvider.ts` | `LyricSource` 加 `'qq'`；`LYRIC_SOURCES` 白名单加 `'qq'`；默认值**不变** |
| `electron/lyricProvider.ts` | 加 `QQ_SEARCH_URL` / `QQ_LYRIC_URL`；加 `stripHighlightTags()` / `decodeMaybeBase64()`；加 `readQqCandidates()` + `fetchQq()`；dispatch 加 `qq` 分支 |
| `src/components/SettingsPanel.tsx` | 「外部歌词源」下拉加 `<option value="qq">QQ 音乐（Lyricify 同款词源）</option>` |
| `test/lyric-provider.test.ts` | 加 QQ 适配器用例（12 条）+ 两个新工具函数的用例 |
| `test/settings-lyric-source.test.tsx` | 既有「四个选项」断言**改写**为「五个选项」（前提被用户推翻）；加 2 条 QQ 用例 |

⚠️ `electron/ipc.ts` 的偏好白名单用的是 `LYRIC_SOURCES.includes(...)` → `'qq'` **自动放行**，
`normalizeLyricSource` 同理 → **零改动**。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1471 passed / 59 files**（基线 1456 → **+15**）；
  `playwright test` **17 passed**。
- 本轮改动文件 **U+FFFD = 0**；行尾保持原样（`docs/calibration.md` 仍是 CRLF，其余 LF）、无 BOM。
- **变异自证（四处全部先红后改回，sha256 回基线 `8870252230543182`）**：
  1. 去掉 `stripHighlightTags`（歌名带 `<em>` 不再剥）
     → 「歌名带 `<em>` 高亮标签 → **剥掉后**才匹配得上」**红**（选中 songmid 变成 004）；
  2. 把 QQ 的 `interval` 当**毫秒**（除以 1000）
     → 「QQ 的 `interval` 是**秒**」**红**（时长筛失效 → 退回第一条 songmid=001）；
  3. 去掉 QQ 的 `looksLikeLrc` 校验
     → 「歌词**不是 LRC**（纯文本）→ `not-found`」**红**（`ok` ≠ `not-found`）；
  4. 去掉 QQ 的 `retcode` 校验
     → 「歌词返回 `retcode` 非 0 → `error`」**红**（静默失败被当成「确实没有」）。

### 遗留 / 待办

- **逐字**：QQ 的 QRC 是**密文**（在 `u.y.qq.com` 的 `PlayLyricInfo`），要复刻 Lyricify 的
  「逐字 + 翻译」完整体验需实现解密 + 转 A2 增强 LRC（解析层已就绪：`parse.ts` 的
  `WORD_TAG` 已支持 `<mm:ss.xx>`）→ 留给后续任务；
- ⚠️ **真机活体验检未做**：本轮只直打 API 验证了端点与形态，**没有**走完整的
  「客户端 → 主进程 → Chromium 分区栈 → 外网」链路；
- QQ / 网易云都是**非官方**接口 → 变更风险。缓解：内置 lrclib + 自定义模板，一键切走；
- QQ 翻译覆盖不全（实测《占位曲目五》`trans` 为空）→ 空就是空，**不报错**、**不阻塞**。
## 十七、T34：全屏歌词「歌词舞台」（显示**所有**歌词）

- 日期：2026-11-04
- 状态：已完成
- 设计规格：`docs/superpowers/specs/2026-11-04-fnmusic-lyric-stage-design.md`

### 用户诉求与拍板

> 「全屏歌词应该显示所有歌词」

| 决策点 | 结论 |
|---|---|
| 形态 | **歌词舞台式**：全量渲染所有行 + 当前行放大并逐字高亮 + 自动滚动跟随 |
| 影响范围 | **只有全屏播放页**；桌面悬浮歌词**保持 `double` 不变** |
| 既有模式 | `single` / `double` 的行为**一字不改** |

### 为什么既有两档都满足不了

| 模式 | 场上的歌词行数 | 原因 |
|---|---|---|
| `single` | 当前行 ±3 行（最多 7 行） | **窗口裁剪** —— 真实歌词成百上千行，DOM 里根本没有全部 |
| `double` | **恰好 2 行** | 「双行推进」是 Task 15 的既定交互（上一行走满 + 下一行开走） |
| `all`（新增） | **全部** | —— |

### 三个设计决策

1. **所有行等高槽位**（`LYRIC_ALL_LINE_HEIGHT = 60`）：当前行只放大字号（15→20px）、**槽位不变**
   → 当前行推进时整份列表**不跳动**（否则长歌每唱一句整屏抖一下）。
2. **翻译只给当前行看**：每行都挂翻译 → 每行都被撑高 → **槽位等高的前提就破了**。
3. **`memo` 化每一行**：真实歌词上千行 + `currentTime` 每帧变 → 只有当前行会重渲染。
   ⚠️ **样式对象必须在 memo 组件内部现算**：作为 prop 传 → 每次都是新对象 →
   浅比较永不相等 → 形同没 memo。

滚动目标按「行号 × 固定槽位」**线性**计算（不依赖 DOM 测量）→ jsdom 里也能断言。

### 踩坑一：翻译在「还没唱到第一句」时整屏消失

`findActiveLine` 在 `t` 早于第一行时返回 `-1` → 没有活跃行 →
翻译若只跟活跃行走，**一条翻译都不显示**（用户看到「只有原文」的半成品）。

⇒ 翻译**回落到第一行**（还没唱到的那句）；全程始终**只有一行**带翻译 → 槽位等高依然成立。

### 踩坑二：主进程歌词缓存的键**不含模板**（真缺陷，本轮已修）

`electron/lyricProvider.ts` 的 `cacheKey()` = `源|歌名|歌手|专辑|时长`
→ **换了「自定义歌词 API 模板」后，旧结果仍从缓存命中**
→ 用户在设置里换了源，**看到的还是上一个源的歌词**。

⇒ 修法：`source === 'custom'` 时把**模板**也计入键（`electron/lyricProvider.ts`）
+ 单测「改了模板 → 不再命中旧缓存」（`test/lyric-provider.test.ts`）。

### 踩坑三：E2E 里「双击的歌曲」会变（**不是**产品缺陷，是测试写法）

⚠️ mock 的音频**只有 60 秒** → 整组 E2E 跑下来早就放完了 → 引擎收到 `ended`
→ **自动切队列里的下一首** → 断言时当前曲目已经变了
（实测：想播 t2，断言时当前曲目已是 t3 → 歌词变成 t3 的 NAS 歌词 → 「30 行」数到 3 行）。

⇒ 修法（**测试侧**）：
- **按歌名定位行**，不按行号（虚拟列表的行号会随窗口漂移）；
- **先播另一首**再播目标那首 → 目标一定是**一次全新加载**（位置归零，不会被自动切走）；
- 双击后**核对播放条** → 「点错歌」当场暴露，而不是 20 秒后才红。

### 改动

| 文件 | 内容 |
|---|---|
| `src/ui/lyrics/LyricView.tsx` | 加 `mode="all"`；导出 `LYRIC_ALL_LINE_HEIGHT = 60`；新增全量渲染分支；`renderLine` 加 `showTranslation`（缺省 true → 既有行为不变）；新增 `AllLyricLine`（memo） |
| `src/ui/lyrics/lyric-view.css` | 新增 `.fnm-lyricview--all` 规则块（等高槽位 / 当前行放大 / `safe center` / 画布不被 flex 压扁） |
| `src/pages/FullPlayerPage.tsx` | 全屏页的歌词从 `mode="double"` 改成 `mode="all"` |
| `electron/lyricProvider.ts` | **修**：自定义源的缓存键加上模板 |
| `mock-server/server.ts` | 新增 `/mock-lyric-long`（30 行长歌词）+ `MOCK_EXTERNAL_LRC_LONG`（原端点**一字不改**） |
| `test/lyric-view-all.test.tsx` | **新增** 8 条 |
| `test/lyric-view-all-css.test.ts` | **新增** 5 条（CSS 契约 + 「槽位高度 == TS 常量」） |
| `test/lyric-provider.test.ts` | 加 1 条（改了模板 → 不再命中旧缓存） |
| `test/lyric-view.test.tsx` | 既有那条用例的**标题**从「双行模式」改成「全量模式 / 歌词舞台」（前提被用户明确推翻）；**断言一字未改** |
| `e2e/smoke.spec.ts` | 新增 1 条（全屏页：所有行在场 + 当前行放大 + 滚动跟随） |

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1485 passed / 61 files**（基线 1471 → **+14**）；
  `playwright test` **18 passed**（基线 17 → **+1**）。
- 本轮改动文件 **U+FFFD = 0**；行尾保持原样（`docs/calibration.md` 与 `mock-server/server.ts`
  是 CRLF，其余 LF）、无 BOM。
- **变异自证（四处全部先红后复原，sha256 全部回基线）**：
  1. 把 `LYRIC_ALL_LINE_HEIGHT` 改成 61（槽位与 CSS 漂移）
     → CSS 契约测试**红**（槽位高度 == TS 常量）；
  2. 去掉「翻译回落到第一行」（`translationIndex` 恒取活跃行）
     → 「还没唱到第一句时翻译回落到第一行」**红**；
  3. 去掉「所有行都在场」的分支（退回窗口裁剪）
     → 「**所有**歌词行都在场」**红**；
  4. 把主进程缓存键的模板去掉
     → 「改了模板 → 不再命中旧缓存」**红**。

### 遗留 / 待办

- **逐字高亮依赖数据源**：本档的逐字来自 NAS 的**增强型 LRC**（`<mm:ss.xx>` 词级标签）；
  QQ 源的 QRC 是**密文** → 外部源目前**只有行级** → 外部源的歌看不到逐字推进（留给后续任务）；
- **长行折行**会与下一行轻微重叠（等高槽位的代价，与 `single` 模式同源）；
- **全量渲染的规模**：真实歌词上千行 → DOM 里上千个行元素
  （已用 memo 把「每帧重渲染」压到「只重渲染当前行」，但节点数本身仍是 O(行数)）；
- 桌面悬浮歌词**仍是 `double`**（用户只要求全屏页）。
## 十八、T35：设置页改成独立的整页（左侧分类 + 右侧内容）

- 日期：2026-11-05
- 状态：已完成
- 设计规格：`docs/superpowers/specs/2026-11-05-fnmusic-settings-page-design.md`

### 用户反馈与拍板

> 「设置页做得不对」

用真机探针（`release/verify/settings-shot.mjs`：复制真实 `userData` → 自动登录 → 打开设置
→ 截图 + 量几何）复现出来的**具体**症状：

| 症状 | 实测 |
|---|---|
| 面板宽度只有 **294px** | 主区宽约 1200px → 只占 1/4 |
| 说明文字被**折成 2～4 行** | 「占位符：…」那段折成 4 行 |
| 输入框里的**示例 URL 被截断** | 看不全后半段 |
| 下半截（FFmpeg / 自动更新）**掉到视口外** | 只能在小窄条里滚动 |
| 面板**盖住顶栏** | 开着时别的顶栏按钮**点不到** |

⇒ 根因不是某一处样式，而是**形态错了**：一个 294px 的浮层塞了 6 组设置。

| 决策点 | 结论 |
|---|---|
| 形态 | **改成独立的整页设置**（左侧分类 + 右侧内容） |
| 顶栏 | **保留且不被遮挡** |
| 分类 | 通用 / 歌词 / 下载 / 解码 / 更新（默认「通用」） |
| 数据模型 | **只改呈现，不改数据模型**（`prefs.json` 键、IPC、偏好白名单一字未动） |
| 主题开关 | **不在**设置页（顶栏已有，不重复加功能） |

### 做法

1. **设置页 = 主区里的一个视图**（`App.tsx` 的 `MainView` 新增 `'settings'`），
   不再是顶栏下拉的浮层 → 顶栏**不再被遮挡**。
2. **记住来时的视图**（`viewBeforeSettings`）：从「收藏」进去、关掉设置后回到**收藏**，
   而不是被丢回「连接」页。
3. `SettingsPanel` 左侧是分类导航（`nav[aria-label="设置分类"]`，当前项用
   `aria-current="page"` 标出），右侧只渲染**当前那一类**（旧浮层「一屏塞六组」的问题
   从结构上消失）。
4. 根节点 `role` 从 `dialog` 改成 `region`（它不再是模态浮层）。
5. **偏好写回失败的横幅永远在内容区顶部**（不属于任何分类）→ 停在别的分类上也能看见。
6. CSS 重写：根容器 `flex: 1 1 auto; min-height: 0; height: 100%` 撑满主区；
   左栏 `flex: 0 0 190px`；右栏 `flex: 1 1 auto; overflow-y: auto`；
   内容列 `max-width: 900px`、输入框 `max-width: 560px` → 说明文字一行放得下、示例 URL 不被截断。

### 踩坑一：设置页必须撑满主区，否则高度百分比解析不出来

`.app-shell__main` 是 **flex 列容器** → 设置页根容器若不写
`flex: 1 1 auto; min-height: 0; height: 100%`，`height: 100%` 的**百分比解析不出来**
（父级高度「不定」）→ 按 `auto` 处理 → 页面被内容顶高、右侧滚动条跑到视口外。
与曲库页面外壳 `.fnm-page` 同一套坑（T22 踩过）。

### 踩坑二：Playwright 的 `name` 是**子串**匹配 → 「设置」会命中「关闭设置」

`getByRole('button', { name: '设置' })` 会同时命中顶栏的「设置」和页内的「关闭设置」
→ 严格模式报「找到多个元素」。⇒ E2E 里一律写成 `{ name: '设置', exact: true }`。
（Vitest + testing-library 的 `getByRole(name)` 是**精确**匹配，没有这个坑。）

### 踩坑三：旧浮层的**绕行步骤**全部失效，必须改写成**新行为断言**

旧 E2E 里有多处「先关掉设置面板，否则它盖住顶栏、点不到播放条按钮」。
前提被 T35 推翻 ⇒ 这些步骤**不能直接删了算事**，改写成新行为：

- 「播放模式持久化」那条：**开着设置页**去点播放模式按钮（旧浮层在这里必红），
  顺带把「开着也点得到」钉死；
- 「自动更新」「歌词来源」两条：改成先切**左侧分类**（`设置 → 更新` / `设置 → 歌词`），
  并把 `getByRole('dialog')` 改成 `region`；
- 「复原设置面板开着」的收尾步骤**删掉**（不再有「后面那条用例假定它开着」这个依赖）。

### 改动

| 文件 | 内容 |
|---|---|
| `src/components/SettingsPanel.tsx` | 整体重写：新增 `SettingsCategory` 与五分类、左侧 `nav[aria-label="设置分类"]`、右侧按分类渲染、`role="region"`、新增 `onClose` prop、错误横幅常驻内容区顶部；**控件名 / 偏好键 / 草稿语义一字未改** |
| `src/components/settings-panel.css` | 整体重写：根容器撑满主区（横向两栏）、左栏 190px、右栏自滚、内容列 900px、输入框 560px、legend 变加粗小标题 |
| `src/App.tsx` | `MainView` 加 `'settings'`；`settingsOpen` → `viewBeforeSettings`；新增 `openSettings` / `closeSettings`；顶栏「设置」按钮改成「进入 / 退出设置页」（`aria-expanded`） |
| `src/styles/app-shell.css` | 删掉已失效的「绝对定位锚点」注释与 `position: relative`；新增 `[aria-expanded='true']` 高亮 |
| `test/settings-page.test.tsx` | **新增** 11 条（`role=region`、五个分类、默认「通用」、一次只显示一类、关闭回调、错误横幅不被分类藏起来） |
| `test/settings-page-css.test.ts` | **新增** 10 条（CSS 契约 + 没有绝对定位 + 没有硬编码色值） |
| `test/settings-lyric-source.test.tsx` | 既有 11 条**断言一字未改**，只加「先点左侧『歌词』分类」这一步 |
| `test/settings-panel.test.tsx` | 既有 4 条**一字未改**（默认分类就是「通用」） |
| `e2e/smoke.spec.ts` | `dialog` → `region`（四处）+ 补分类切换 + 旧绕行步骤改写成新行为断言 + **新增 1 条**（整页 / 不遮挡顶栏 / 关掉回到原视图） |
| `docs/superpowers/specs/2026-11-05-fnmusic-settings-page-design.md` | **新增**（设计规格） |
| `README.md` / `docs/changelog.md` | 设置页形态说明、路径改为「设置 → 歌词 → 歌词来源」等 |

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1506 passed / 63 files**（基线 1485 / 61 → **+21**）；
  `playwright test` **19 passed**（基线 18 → **+1**）。
- 本轮改动文件 **U+FFFD = 0**；行尾保持原样（`docs/calibration.md` 是 CRLF，其余 LF）、无 BOM。
- **真机肉眼复验尚未做**（本轮只做了自动化验证 + 改造前的缺陷复现截图）。

### 遗留 / 待办

- **分类状态不跨开关保留**：每次重新进入设置页都停在「通用」（要不要记住上一次那一档，留给用户反馈）；
- **窄窗口**：左栏固定 190px，窗口很窄时右栏会被挤窄（`min-width: 0` 保证不溢出）；
- **主题开关仍在顶栏**：没有搬进设置页（用户拍板：不重复加功能）；
- 真机肉眼复验（设置页的排版在真实窗口尺寸下的观感）**尚未做**。
## 十九、T36：去掉 Windows 上的默认菜单栏（File / Edit / View / Window / Help）

- 日期：2026-11-05
- 状态：已完成
- 设计规格：无（改动很小，直接在 `docs/calibration.md` 记录）

### 用户反馈

> 「可以去掉这些吗？像一个完整年软件」（配图：Electron 默认菜单栏）

⇒ 那是 **Electron 的默认应用菜单**：项目**从没配置过菜单**，Windows 上 Electron 就自动挂上
File / Edit / View / Window / Help —— 看着像"没做完的开发工具"，不像一个**完整软件**。

### 做法

1. **主进程 `Menu.setApplicationMenu(null)`**（`app.whenReady()` 之后、创建窗口之前）
   → **全局**生效：主窗口 / 桌面悬浮歌词窗 / NAS 授权窗一起没有菜单栏。
2. ⚠️ **代价**：Electron 的默认菜单**同时绑着一批快捷键** → 菜单一去掉，
   **Ctrl+V 粘贴**与 **Ctrl+Shift+I / F12 开发者工具**跟着消失
   → 新增 `electron/appShortcuts.ts`，用 `webContents.on('before-input-event')` **手工接回来**：
   - `Ctrl+C` → `webContents.copy()`
   - `Ctrl+V` → `webContents.paste()`
   - `F12` / `Ctrl+Shift+I` → `webContents.openDevTools()`
3. ⚠️ **只接这三个，别的一律不拦**：Ctrl+X / Ctrl+A / Ctrl+Z 是 **Blink 自己的编辑命令**
   （不依赖菜单 accelerator）→ 交给渲染进程。
   **尤其不能拦 Ctrl+A**：Electron 的 `webContents.selectAll()` 是「选中**整个页面**」
   → 拦了会让输入框里的 Ctrl+A 变成"选中整页"，**比不处理更糟**。
4. 托盘菜单**不受影响**（它是自己 `Menu.buildFromTemplate` 出来的上下文菜单，与应用菜单无关）。

### 踩坑一：菜单栏是**原生的**，Playwright 的 DOM 查询**测不到**

菜单栏不在 web contents 里 → `getByRole` / `locator` 一律查不到。
⇒ E2E 只能问**主进程**：`Menu.getApplicationMenu()`（默认菜单有 5 项）与
`win.isMenuBarVisible()`。前者顺带能**干净地红**（5 ≠ 0），后者是布尔断言。

### 踩坑二：E2E 里粘贴是**追加**，不是替换

登录页的地址框**预填**了默认地址 `http://192.168.1.2:5666`
→ 第一次跑 `toHaveValue('粘贴测试')` **红了**，但 DOM 里实际是
`http://192.168.1.2:5666粘贴测试` → **粘贴其实是成功的**，只是插在了光标处。
⇒ 用例改成：**先 `fill('')` 清空**，再按 Ctrl+V，再断言**恰好等于**粘贴内容。

### 踩坑三：授权窗的 `webContents` 接口是「宽松」的

`electron/oauthWindow.ts` 的接缝写的是
`on(channel: string, listener: (...args: unknown[]) => void)`
→ 与 `appShortcuts` 要求的精确签名**对不上**（TS 报 TS2345）。
⇒ 不去改别人的接口，而是在 `appShortcuts.ts` 里加一个
`adaptLooseWebContents()` **在收窄处一次**，调用点保持干净。

### 改动文件

| 文件 | 内容 |
|---|---|
| `electron/appShortcuts.ts` | **新增**：快捷键识别纯函数 + 接线函数 + 宽松 `webContents` 适配（**不 import electron** → 可直接单测） |
| `electron/main.ts` | `Menu.setApplicationMenu(null)`；主窗口 + 悬浮歌词窗接快捷键 |
| `electron/oauthWindow.ts` | 授权窗接快捷键；`WebContentsLike` 补 `copy?` / `paste?` / `openDevTools?`（**可选** → 不动既有测试替身） |
| `test/app-shortcuts.test.ts` | **新增** 13 条（识别 + 接线 + 不抢 Ctrl+A + 开发者工具） |
| `e2e/smoke.spec.ts` | **新增** 1 条（菜单没了 + **真实** Ctrl+V 粘贴），排在「登录」**之前**（要有一个可见输入框） |
| `docs/calibration.md` / `docs/changelog.md` / `README.md` | 同步 |

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1519 passed / 64 files**；`playwright test` **20 passed**。
- 本轮改动文件 **U+FFFD = 0**；行尾保持原样、无 BOM。
- **变异自证**（见台账）：去掉 `Menu.setApplicationMenu(null)` → E2E「菜单没了」**红**；
  让 `resolveShortcut` 不认 Ctrl+V → 单测 + E2E 粘贴**红**。

### 遗留 / 待办

- **默认 Electron 图标**仍未换（`build/icon.ico` 未提供）→ 任务栏 / 托盘还是 Electron 图标，
  这也是「像个完整软件」欠缺的一角；
- **快捷键里没有 Ctrl+Q（退出）**：托盘菜单里有「退出」，够用；发布版也没绑 F11 全屏
  （全屏播放页是应用内的「全屏」按钮）。
- ⚠️ **真机肉眼复验未做**：菜单栏消失、托盘菜单仍在、F12 能开控制台 —— 目前只有
  **主进程断言 + 真实粘贴**这两层自动化保证。
## 二十、T37：「音频加载停滞」**误报成红色错误**（真缺陷，已修）

- 日期：2026-11-05
- 状态：**完成**

### 用户提问

> 「音频加载停滞：网络较慢或连接中断」—— 这是 BUG 吗？

⇒ **是 BUG**，而且是**两个缺陷叠在一起**。

### 根因（一）：把 `stalled`（瞬时提示）当成了**错误**

HTML 规范里，`stalled` 的定义是：

> The user agent is **trying to fetch data** but the data is **not arriving for some period of time**.

它是「**正在取数据、数据一时没到**」的**瞬时提示**——**播放通常会自行恢复**。

而 `src/player/engine.ts` 原来这么写：

```ts
private handleStalled(): void {
  this.errorMessage = '音频加载停滞：网络较慢或连接中断'
  this.emit()
}
```

⇒ 播放条第三行变成**红字**（`role="alert"` = `var(--danger)`），
**而音乐其实照放**（`playing` 仍是 `true`）→ 用户以为坏了，其实没坏。

### 根因（二）：这个错误**没人清** → 一直挂着

媒体事件绑定表里**没有** `playing` / `canplay` / `waiting` 处理器，
`errorMessage` 只在**换歌**（`startPlayback`）时才会被清
→ 那条红字**一直挂到用户切歌**，哪怕网络早就恢复了、这歌正放得好好的。

### 为什么这台机器上**几乎每首歌开头都会中一次**

音频走 `fnm://` → 主进程代理 → NAS；**公网中继带宽实测只有约 230KB/s**，
首字节等待很容易超过 Chromium 的 `stalled` 阈值。

⚠️ **不是代理把流吃掉了**：代理是**流式**的（`upstream.body` 直接作为响应体，
`Range` / `206` 原样透传，`electron/proxy.ts` 的 `proxyBinary`）→ 慢是**链路**慢，不是实现错。

### 用户拍板

| 决策点 | 结论 |
|---|---|
| 卡顿时显示什么 | **灰字「缓冲中…」**，数据到了**自动消失**（`role="status"`，不播报、不报红） |
| 真错误 | 仍然**红字 + `role="alert"`**，且**优先于**缓冲提示 |

### 做法

1. **引擎**新增独立状态 `buffering`（**不是** `errorMessage`）：
   - `stalled` / `waiting` → `buffering = true`；
   - `playing` / `canplay` → `buffering = false`（**自动消失**的关键）；
   - `pause` / `ended` / `error` / `abort` / 换歌 / 新一轮加载 → 一律清掉。
2. **状态链路**：`PlayerState.buffering` → store → 播放条。
   ⚠️ **顺带补了一个覆盖缺口**：此前**没有任何测试**盯「引擎 → store」这条同步
   （`error` / `preparing` / `fallbackActive` 都是直接抄进 store 的，抄错了没人拦）
   → 新增 `test/player-store-state.test.tsx`。
3. **界面**：提示行优先级 **错误 > 正在转换 > 缓冲中 > 音质有损**。
   ⚠️ 「缓冲中」排在「音质有损」**前面**：用户此刻在等数据，先说「在等」更贴近当下
   （缓冲结束后有损说明会回来）。CSS **不用改**：`role="status"` 本来就是灰字，
   只有 `role="alert"` 才是红色。

### 踩坑一：既有那条断言的**前提被用户明确推翻** → 必须改写，不能删

`test/engine.test.ts` 里原有：

```ts
it('网络/加载错误：stalled 事件也写入可读错误', () => { ... expect(engine.state.error).toBeTruthy() })
```

它的**前提正是这次要修的错**（把 `stalled` 当错误）→ 按纪律**改写**为**新行为断言**，
并保留「原来那条也测过东西」的意图（网络类错误仍有文案）：

- 「**stalled 不是错误**：只标记「缓冲中」，**不写错误**（音乐照放，不该报红）」；
- 「缓冲中 → **playing 之后自动清除**（提示不许粘在界面上）」；
- 「缓冲中 → **canplay** 也清除」「`waiting` 同样不是错误」；
- 「缓冲中 → **真出错时错误优先**」「缓冲中 → **暂停**时提示收掉」。

（`error` 事件那条「错误码 2 写入网络类文案」**一字未改** → 真错误仍然有文案。）

### 踩坑二：`role="status"` 才是灰字

播放条提示行的 CSS 是 `.fnm-playerbar__notice { color: var(--text-secondary) }`
+ `[role='alert'] { color: var(--danger) }` → **只要不是 `alert`，就是灰的**，
CSS 一个字都不用改。⚠️ 但**别**为了「醒目」把缓冲提示也做成 `alert`——
那正是这次要消除的「误报成红色错误」。

### 改动文件

| 文件 | 内容 |
|---|---|
| `src/player/engine.ts` | 新增 `buffering` 状态；`stalled` / `waiting` → 缓冲中；`playing` / `canplay` → 自动清除；暂停 / 结束 / 出错 / 中止 / 换歌 / 新一轮加载 → 一律清掉 |
| `src/player/format.ts` | 新增 `BUFFERING_MESSAGE` |
| `shared/types.ts` | `PlayerState` 加 `buffering?: boolean` |
| `src/state/playerStore.ts` | store 加 `buffering`（初始 `false`）+ 引擎 → store 同步 |
| `src/components/PlayerBar.tsx` | 提示行优先级：错误 > 正在转换 > **缓冲中** > 音质有损 |
| `test/engine.test.ts` | 既有那条**前提被推翻** → **改写**为 6 条新行为断言 |
| `test/player-bar-notice.test.tsx` | **新增** 4 条（缓冲中显示灰字 / 错误优先 / 缓冲优先于有损 / 转换优先于缓冲） |
| `test/player-store-state.test.tsx` | **新增** 4 条（补上「引擎 → store」这条**一直没人盯**的链路） |
| `docs/calibration.md` / `docs/changelog.md` / `README.md` | 同步 |

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1532 passed / 65 files**；`playwright test` **20 passed**。
- 本轮改动文件 **U+FFFD = 0**；行尾保持原样、无 BOM。
- **变异自证（三处全部先红后复原，sha256 回基线）**：
  1. 让 `handleStalled` 写回 `errorMessage`（退回旧行为）
     → 「**stalled 不是错误**」**红**；
  2. 去掉 `playing` 监听（提示不自动消失）
     → 「缓冲中 → **playing 之后自动清除**」**红**；
  3. 去掉 store 同步里的 `buffering` → 「**缓冲中**会同步进 store」**红**。

### 遗留 / 待办

- ⚠️ **真机复验未做**：需要一条**真的慢**的链路才能看到「缓冲中…」——
  本机走的是 LAN（`192.168.1.2:5666`），不容易触发；**公网中继**下才会频繁出现。
  目前只有自动化三层（引擎 / store / 界面）保证；
- **中继带宽**（实测约 230KB/s）本身是**上游**问题，不是客户端缺陷；
- `waiting` / `stalled` 在**极端**情况下（连接真的断了）也会先给缓冲提示、
  稍后才由 `error` 事件报真错误 → 中间那几秒用户看到的是「缓冲中…」而不是红字，
  这是**正确**的（数据没来 ≠ 已经失败）。

---

## 二十一、T38：没登录也能当播放器（本地音乐 + 已下载）

- 日期：2026-11-05
- 状态：**完成**

### 用户诉求

> 「让软件没登陆的时候，也可以做为音乐播放器，能添加播放本地的音乐和已下载的音乐」

### 现状实测（动手前）

| 现状 | 证据 |
| --- | --- |
| 未登录时主区**只有**登录页 | `src/App.tsx` 的 `renderMainView` 默认分支返回 `<LoginPage>` |
| `fnml://` **只**认已下载索引里的路径 | `electron/localMedia.ts` 的 `lookup` 只查下载索引 |
| **没有任何文件选择对话框** | 全仓库 `showOpenDialog` 零命中 |
| `Song` **没有**「本地曲目」标记 | `shared/types.ts` 的 `Song` 无本地字段 |
| 下载索引**没有标题** | `DownloadEntry` = `songId` / `file` / `bytes` / `ext` / `downloadedAt` |

### 用户拍板（三项均取推荐项）

| 决策点 | 结论 |
| --- | --- |
| 导入方式 | **两个都要**：「添加文件」（多选）+「添加文件夹」（递归扫描） |
| 未登录界面 | 顶栏只留「连接」+「本地」，主区**默认**就是「本地」页；登录后恢复完整导航 |
| 已下载元数据 | 下载索引加 `title` / `artist` **快照**；老条目用**文件名反推**兜底（**不迁移**索引） |

### 核心思路：渲染层**永远不碰文件系统**

主进程维护一张「本地曲目登记表」，`fnml://` 的查找链扩成：

```
兜底转码产物  →  下载索引  →  本地曲目登记表
```

⇒ **`electron/localMedia.ts` 一个字都不用改**，只改 `electron/main.ts` 里 lookup 的**一行**链条。

⚠️ **不新增 URL 种类 = 不放宽任何安全边界**：渲染进程给不出路径，只能给 id；
lookup 只认登记表里的**精确路径** → 路径穿越依然无从下手。

### 数据模型

| 东西 | 形态 |
| --- | --- |
| 本地曲目 id | `local:<sha1(绝对路径) 前 16 位>`（主进程生成）→ 稳定、重复添加自动去重、与 NAS guid 不冲突 |
| 本地清单 | `<userData>/local-library.json`，`{ version: 1, items: [{id, path, title, artist, size, ext, addedAt}] }`，明文但**非敏感**（同 `prefs.json` 性质） |
| 已下载元数据 | `DownloadEntry` 加**可选** `title?` / `artist?`；新下载写精确值，**老条目**靠文件名反推；**索引版本不变**（不迁移、不动用户的 `downloads.json`） |

### 安全边界

- 渲染进程给的路径**只是候选**：主进程必须 **stat + 扩展名白名单 + 确认是普通文件** 才登记；
- 目录扫描**跳过符号链接 / reparse point**（junction 会成环），深度上限 8、文件数上限 20000；
- 移除操作**只改清单**，**绝不删用户的音乐文件**；
- 本地通路**不出网**、不碰 token；清单里只有路径与歌名。

### 已知限制（如实写进界面与文档）

1. **不解析音频标签**（ID3v2 / Vorbis / FLAC）→ 歌名 / 歌手来自**文件名反推**（**近似值**，
   文件名被 `sanitizeFileName()` 清洗过，非法字符成了下划线）；时长在**播放后**由媒体元素补
   （队列里其它曲目的时长仍显示 `--`）。要真标签得**单开任务**手写解析器（不引新依赖）。
2. **只支持本地盘符路径**：不支持 `\\server\share` 网络路径，不支持 `.lnk` 快捷方式。
3. Chromium 播不了的格式（**APE / ALAC / WMA** 等）→ 走**已有的 FFmpeg 兜底**，
   本地曲目也接进了那条路（`lookupLocal` = 下载索引 → 本地曲目登记表）。
   ⚠️ **2026-11-05 更正（T42）**：这一条原先写的是「FLAC / APE 等」→ **FLAC 那半句是错的**。
   实测（真 Electron 32 / Chromium 128）：`canPlayType('audio/flac') = "probably"`；
   16bit/44.1k 与 **24bit/96k** 的真 FLAC 字节进 Blob 都正常解出（`loadedmetadata`、duration 3 秒、零错误）；
   APE / ALAC / WMA 才是 `""`。且 FLAC **不在** `UNDECODABLE_FORMATS` 里 → **不进** FFmpeg 兜底。

### 顺带修掉的一个真缺陷

`shared/localMeta.ts` 的 `parseTrackFileName()` 第一版**只去掉任意扩展名**，
于是 `Album 03. Intro` 这种名字会被砍成 `Album 03`（**歌名丢一截**）。
⇒ 改成**只去「认得的音频扩展名」**；同时「` - ` 前导空格」不能被 trim 掉
（否则找不到分隔符）→ 歌手为空时**歌名照常**。

### 改写的既有测试（前提被用户**显式**推翻）

| 文件 | 改法 |
| --- | --- |
| `test/app-routing.test.tsx` | 「默认停在连接页」的前提被推翻 → 改写为「未登录时默认停在**本地音乐页**」；其余用例按**已登录**设置会话状态（曲库导航需要 NAS） |
| `test/favorite-writeback.test.ts` | 「点顶栏的『搜索』」需要已登录 → `beforeEach` 里设置会话状态（**断言一字未改**） |
| `test/login-page.test.tsx` | 会话恢复收敛进 `sessionStore` → `restored` 是**模块级**状态，`beforeEach` 必须复位（否则「只调用一次 restore()」变成假绿） |
| `e2e/smoke.spec.ts` | 「启动 → 渲染出登录页」的前提被推翻 → 改写为「启动 → 直接进本地音乐页」；粘贴用例**加一步「先点『连接』」**（**断言一字未改**）；新增 1 条本地页用例 |

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1593 passed / 69 files**；`playwright test` **21 passed**。
- 本轮改动文件 **U+FFFD = 0**；行尾保持原样（`test/media-session.test.ts` 原本是 **CRLF**，
  补内容时用脚本按 CRLF 写回，未被改成 LF）、无 BOM。
- **变异自证（六处全部先红后复原，sha256 回基线）**：
  1. 删掉 `resolvePlaybackSource` 里的本地 id 分流 → 「本地曲目 → 直接 `fnml://`」**红**；
  2. 曲库导航改成**无条件渲染** → 「未登录：顶栏只有『连接』+『本地』」**红**；
  3. 自动切页不避让用户操作 → 「用户已经点过导航 → 启动恢复不抢他的手」**红**；
  4. 下载索引不写 `title` / `artist` 快照 → 「索引里带快照（并落盘）」**红**；
  5. 登记时去掉同 id 去重 → 「同一个路径登记两次 → 只有一条（幂等）」**红**；
  6. 文件名不拆歌手 → 「`歌手 - 歌名.ext` → 歌手 + 歌名」等 **7 条红**。

### 遗留 / 待办

- ⚠️ **真机复验未做**：需要人工在「添加文件 / 添加文件夹」对话框里挑一个真实音频文件，
  确认它出现在「本地文件」分区、且**真的能播**（`fnml://` → 主进程登记表 → 字节）；
- ⚠️ **真标签解析**（ID3 / Vorbis / FLAC）**T39 已做** → 见「二十二、T39」；
  且**时长在播放前显示 `--`**；
- ⚠️ **老下载条目的歌名 / 歌手**是**文件名反推**的近似值（本次升级前下的），
  下过的条目要在**重新下载**之后才有精确快照；
- 「已下载」分区在**未登录**时读的是**本机下载索引**（不需要 NAS），
  但**下载本身**仍然需要登录 NAS。

---

## 二十二、T39：真标签解析（本地音乐的歌名 / 歌手 / 时长）

- 日期：2026-11-05
- 状态：**完成**

### 用户诉求（承接 T38 的遗留）

T38 留下的最大短板：本地曲目的歌名 / 歌手是**文件名反推的近似值**，
时长**播放前**一律显示 `--`。⇒ 要**手写**音频标签解析器（**不引新 npm 依赖**）。

### 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 覆盖范围 | **「本地文件」+「已下载」都做**：已下载也补时长，老条目一并回填 |
| 解析时机 | **后台渐进解析**：登记立刻完成，列表随后逐批变精确 |

### 核心思路

- **解析器是纯函数**：输入 `Buffer` → 输出结构化标签；**不碰 fs、不碰 Electron**
  → 单测直接喂**构造出来的字节流**（仓库里**没有二进制样本文件**）；
- **读文件的是主进程** → 渲染层的文件系统边界**一个字没松**；
- **标签优先、文件名兜底**：
  - 本地文件：标签 → 文件名反推；
  - 已下载：**NAS 快照** → 标签 → 文件名反推（服务端曲库才是权威）；
- **时长双源**：标签给**播放前**的初值；播放后仍以**媒体元素实测**为准（既有逻辑未改）。

### 覆盖的容器（手写三个解析器）

| 容器 | 取什么 | 时长来源 | 精度 |
| --- | --- | --- | --- |
| **ID3v2.2/2.3/2.4**（mp3） | `TIT2` / `TPE1` / `TALB` | `Xing` / `Info` 帧计数；无则 CBR 估算 | 精确 / 近似 |
| **FLAC**（flac） | `STREAMINFO` + `VORBIS_COMMENT` | 总采样数 ÷ 采样率 | **精确** |
| **Vorbis / Opus**（ogg/opus/oga） | 识别头 + 注释头 | 末页 granule（Opus 减 preSkip） | **精确** |

⚠️ **按文件头嗅探分派**（`fLaC` / `ID3` / `OggS` / MPEG 同步字），**不靠扩展名猜**。

### 数据模型（只加**可选**字段，版本不变、不迁移）

| 东西 | 变化 |
| --- | --- |
| `LocalLibraryItem` | 加 `album?` / `duration?` / `tagSource?`（`'tag'` / `'name'`；**缺省 = 还没解析**） |
| `DownloadEntry` | 加 `duration?` / `album?` |
| 清单 / 索引版本 | **都不变**（`LOCAL_LIBRARY_VERSION = 1`、`DOWNLOAD_INDEX_VERSION = 1`）→ 老文件读得动，**不迁移** |

### 后台渐进解析（用户拍板的时机）

```
登记（快） → 后台分批解析（每批 200 条）→ 落盘 → local:changed 推给渲染层 → 按 id 合并
```

- **渲染层不阻塞**：导入大目录时界面立刻可用，列表**逐批变精确**；
- 页面显示「正在读取标签，还剩 N 首…」（`tagSource` 缺省 = 还没解析）；
- **老清单 / 老下载条目**在启动后**自动回填**（下载侧由 `download:list` 等 `ensureTags()`，
  本地侧由启动时的 `parsePending()`）；
- ⚠️ 只推**变化的那几条**（不推整份清单 → 两万条清单不会把 IPC 打满）。

### 安全边界（一条没放宽）

- 解析**全在主进程**，渲染层仍只能给 id、拿清单；
- 读取**有字节预算**：文件头 64 KB / 文件尾 64 KB（Ogg）/ FLAC 元数据续读 ≤ 2 MB；
- 解析器**纯函数、不出网**、不碰 token；
- **全程不抛**：读不到 / 不认识 → 退回文件名反推，**不影响登记与播放**；
- 移除操作**只改清单**，**绝不删用户的音乐文件**。

### 踩到的一个真坑（写下来免得再踩）

**JS 的移位数会 mod 32**：`totalSamples >>> 32` 等于 `>>> 0` → FLAC 总采样数的**高 32 位会算错**
（本该 0 的地方算出 8 → 时长差了 8 倍）。
⇒ 高位要用 `Math.floor(totalSamples / 4294967296)` 取。
（第一版**测试辅助函数**就是这么写错的；解析器本身是对的。）

### 改写的既有测试（前提被用户**显式**推翻）

| 文件 | 改法 |
| --- | --- |
| `test/local-music-page.test.tsx` | 提示文案从「按文件名推断」改成「**优先读文件内标签，读不到才按文件名推断**」→ 断言**改写为新行为**（标签优先 + 文件名兜底 + 「移除不删文件」一字未改），并**新增** 3 条（解析进度提示 / 解析完不显示 / 时长显示得出） |

⚠️ 既有 Vitest / E2E **一条不删、断言一条不削弱**（`test/media-session.test.ts` 的假桥
只**加**了 `onLocalChanged` 空实现，原有断言未动）。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1644 passed / 71 files**（基线 1593 / 69）；
  `playwright test` **21 passed**；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`test/media-session.test.ts` 仍是 **CRLF**）；
- **变异自证（七处全部先红后复原，sha256 回基线）**：
  1. 合并规则忽略标签歌名 → 「标签优先」**红**；
  2. FLAC 时长不除采样率 → 「精确时长」**红**；
  3. `Xing` 帧数不换算 → 「精确时长」**红**；
  4. 不读文件尾 → Ogg「末页 granule 时长」**红**；
  5. 不回调 `onChanged` → 「分批推给渲染层」**红**；
  6. 下载条目不写 `duration` → 「索引条目带上时长 / 专辑」**红**；
  7. 渲染层不按 id 合并 → 「按 id 合并」**红**
     ⚠️ 这条**第一版没红**（推送集合恰好覆盖了合并与替换的差异 → 测试鉴别力不足），
     **把测试改强**（改成推**子集**、并断言「没被推的那一条不能被冲掉」）后才红。

### 遗留 / 待办

- ⚠️ **真机复验未做**：放一个带 ID3 标签的 mp3 + 一个带 Vorbis 注释的 flac，
  确认「本地音乐」页的歌名 / 歌手 / 时长**当场变精确**；
- ⚠️ **没覆盖的容器**：`m4a` / `mp4` / `wav` / `wma` / `ape` / `alac` / `aac` / `aiff`
  → 这些仍按文件名反推（**T40 候选**）；
- ⚠️ **内嵌封面不提取**（`APIC` / `PICTURE`）→ 本地曲目的封面仍是占位块；
- ⚠️ ID3v2 **整段 unsynchronisation**（头标志 `0x80`）**不做反同步** → 这类文件读不出标签；
- ⚠️ 裸 MPEG（无 ID3 头、无 `Xing`）的时长是 **CBR 估算值**，±1 秒。

---

## 二十三、T40：窄窗口 UI 适配（窗口最小尺寸 + 顶栏换行）

- 日期：2026-11-05
- 状态：**完成**

### 用户诉求

T38 给顶栏加了一颗「本地」按钮 → 已登录态顶栏变成 **10 颗按钮**（连接 / 本地 / 搜索 + 曲库 7 颗）。
用户问「加了本地按键之后，整体 UI 大小需要重新适配吗」→ 答：**需要**，
而且先得把「**能缩多窄**」的底线定下来。

### 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 范围 | **只做 ①②**：① 窗口最小尺寸；② 顶栏换行 + 品牌名不压扁 |
| ③ 播放条窄屏折叠 | **不做**（T11 老问题，另议） |

### 实测基线（本轮新测：真实 Electron + mock NAS，已登录态）

| 观测项 | 改前 | 改后 |
| --- | --- | --- |
| 窗口下限 | **无**（想多窄多窄） | **外框 800 × 520** |
| 外框比内容宽 / 高 | 16px / 39px | 16px / 39px（不变） |
| 品牌名（外框 800） | 45px 宽 / 42px 高（**2 行**） | **60px 宽 / 21px 高（单行）** |
| 品牌名（外框 ≤640） | **15px 宽 / 84px 高（4 行竖排）** | **缩不到**（被下限挡住） |
| 顶栏横向溢出 | 外框 **600** 起（`scrollWidth` 594 > `clientWidth` 567） | **不再发生**（两者恒相等） |
| 文档横向溢出 | 外框 **≤720** 起（717 > client） | **不再发生**（内容宽 784 ≥ 播放条所需 717） |
| 顶栏高度（外框 800） | 96px | 102px（右侧控件换到第二行） |

⚠️ **数值全部来自实测**（真实 Electron 进程 + mock NAS，主进程 `win.setBounds()` 逐档设外框宽度，
渲染层量 `scrollWidth` / `clientWidth` / `getBoundingClientRect()`），**不是拍脑袋**：

- Windows 上**外框比内容宽 16px**、高 39px；
- **播放条需要 717px**（`.fnm-playerbar` 的 `scrollWidth` 恒为 717）→ 整页横向溢出的**元凶**；
- 顶栏横向溢出的门槛是外框 **600**；
- 品牌名自然宽 **60px**（4 个汉字 × 15px）。

### 做法（四处，两层保险 + 两条 CSS）

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 运行时 | `new BrowserWindow({ minWidth, minHeight })` | 用户**拖不到**比下限更小 |
| 建窗时 | `resolveWindowBounds()` 里 `Math.max(...)` 夹紧 | 旧版本存下的**更小**尺寸，恢复时**抬到下限**（**不靠** Chromium 的隐式 clamp —— 那是隐式行为，不该当契约用） |
| 渲染层 | `.app-shell__topbar { flex-wrap: wrap }` | 放不下就换行，**不**把顶栏顶出横向滚动条 |
| 渲染层 | `.app-shell__brand { flex: 0 0 auto; white-space: nowrap }` | **品牌名永不被压扁**（宁可让导航换行） |

⚠️ **只夹尺寸，不动位置**（`x` / `y` 照旧：没存就不给，存了就用）；`prefs.json` 的结构**一字未改**。
⚠️ **不动播放条**（③，用户拍板不做）→ 整页横向溢出的元凶**仍在**，
只是**窗口缩不到那儿去了**。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1652 passed / 72 files**（基线 1644 / 71）；
  `playwright test` **23 passed**（基线 21 + 新增 2）；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`docs/calibration.md` 仍是 **CRLF**）；
- **变异自证（四处，全部先红后复原，sha256 回基线）**：
  1. 去掉 `resolveWindowBounds()` 的夹紧 → `test/window-bounds.test.ts` 红；
  2. 去掉 `.app-shell__brand` 的 `flex: 0 0 auto` → `test/app-shell-css.test.ts` 红；
  3. 去掉 `.app-shell__topbar` 的 `flex-wrap: wrap` → 同上红；
  4. 去掉 `BrowserWindow` 的 `minWidth` / `minHeight` → **E2E 红**（实测窗口缩到了 320）。

### 遗留 / 待办

- ⚠️ **播放条窄屏折叠未做**（用户拍板）→ 整页横向溢出的元凶还在，
  只是被窗口下限挡在外面；将来若要支持 < 800 的窗口，**得先动播放条**。
- ⚠️ **顶栏换行后**，右侧控件（主题 / 设置 / 连接徽标）会换到第二行，
  并被 `space-between` 拉开（主题靠左、徽标靠右）—— 能用，但不算精致。
  要更好看得给这三个控件包一层容器（`margin-left: auto`），**本轮没做**（超出拍板范围）。
- ⚠️ **窗口边框 16px / 39px 是本机实测值**（Windows + 100% 缩放）→ 换机器 / 换缩放比例时
  「内容宽 = 外框宽 − 边框」会变；最小宽度取 **800**（而不是贴着 733 的下限）就是给这个浮动留余量。
- ⚠️ **真机肉眼复验未做**：在真机上把窗口拖到最小，看顶栏换行后的观感。

---

## 二十四、T41：软件信息（关于页）

- 日期：2026-11-05
- 状态：**完成**
- 规格：`docs/superpowers/specs/2026-11-05-fnmusic-app-info-design.md`（提交 `54d6b0c`）

### 用户诉求

加入软件信息：开发者 `pure2199`、公司 广西闪链时空网络科技有限公司、
官网 https://www.sanlos.cn 、ICP 备案号 桂ICP备202507161号-1。

### 落点与做法

| 项 | 落点 |
| --- | --- |
| 显示 | 设置页新增「**关于**」分类（左侧导航第 6 项） |
| 单一真相源 | `shared/appInfo.ts`（设置页 / `package.json` / `electron-builder.yml` / README 同一份） |
| 打包元数据 | `electron-builder.yml` 的 `copyright`；`package.json` 的 `author` / `homepage` |
| 文档 | README 新增「九、软件信息」 |

### ⚠️ 本任务唯一的坑：官网**不能**直接用 `<a href>`

主窗口**没有**配 `setWindowOpenHandler` ⇒ 渲染层里的 `<a href="https://…">` 一旦被点，
**Chromium 会把应用窗口整个导航到那个网站** → 应用界面被替换掉，等于把软件弄坏。

⇒ 点击处理：① **先 `event.preventDefault()`**（拦住导航）；② 再请**主进程**用
`shell.openExternal` 打开（用**系统默认浏览器**，不在应用内跳转）。

### 白名单在**主进程**那一侧

| 规则 | 值 |
| --- | --- |
| 协议 | **只允许 `https:`**（`http` / `file` / `javascript` / `data` 一律拒绝） |
| 主机名 | **精确匹配** `sanlos.cn` / `www.sanlos.cn`（**不做后缀匹配** → `sanlos.cn.evil.example` 不放行） |
| 账号密码 / 端口 | 不许带 / 只允许默认 443 |

- 判断是**纯函数**（`shared/appInfo.ts` 的 `isAllowedExternalUrl`）→ 不用起 Electron 就能单测；
- 真正的「打开」抽到 `electron/externalLinks.ts`（**依赖注入**）→ 单测里喂替身，
  **不会在测试机上真的拉起浏览器**；
- `electron/ipc.ts` 的**模块顶层不得 import Electron**（它要能在 Vitest 里单测）
  → `shell` **惰性解析**（`resolveShell()`），与既有 `resolveIpcMain()` 同一套路；
- `registerPlayerIpc` 的参数**全部可注入** → 新增可选 `openExternal`（单测注入替身）。

### 改写的既有测试（前提被用户**显式**推翻）

| 文件 | 改法 |
| --- | --- |
| `test/settings-page.test.tsx` | 「左侧有**五个**分类」→ 改成**六个**（多了「关于」）→ **改写为新行为断言**（仍逐项精确，不是放宽） |
| `test/tray-tooltip.test.ts` | 「注册了全部通道」的期望集合**加** `app:open-external` → 继续改写为新的完整集合；另**新增** 2 条 `app:open-external` 行为断言 |
| `test/media-session.test.ts` | 假桥**只加** `openExternal` 空实现（CRLF → 用 `release/verify/patch-t41-crlf.mjs` 写回），既有断言**一条未动** |

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1669 passed / 74 files**（基线 1652 / 72）；
  `playwright test` **24 passed**（基线 23 + 新增 1）；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`docs/calibration.md` 与
  `test/media-session.test.ts` 仍是 **CRLF**）；
- **变异自证（三处全部先红后复原，sha256 回基线）**：
  1. 放宽协议（允许 `http`）→ 白名单单测**红**（2 条）；
  2. 去掉 `openExternalUrl()` 的白名单校验 → 外链单测**红**（2 条）；
  3. 去掉 `preventDefault()` → 设置页单测**红**（2 条）。

### 遗留 / 待办

- ⚠️ **版本号没显示**（「关于」页只有用户给的四项 + 应用名）→ 版本要走主进程
  `app.getVersion()`，需再加一条 IPC + 加载态 → 本轮**不扩范围**；
- ⚠️ **白名单是按当前官网定的**：以后要加别的官方链接（帮助文档 / 仓库等），
  得**显式**往 `EXTERNAL_LINK_ALLOWED_HOSTS` 里加（**不自动放宽**）；
- ⚠️ **真机肉眼复验未做**：点官网应**用系统浏览器打开**，**应用窗口不被导航走**。
---

## 二十五、T42：本地音乐标签再补三个容器（MP4/M4A、WAV、AIFF）

### 背景与选型

T39 已经手写了 **ID3v2 / FLAC / Ogg** 三个容器的标签解析器。T42 补上剩下三个最常见的：

| 容器 | 标签放哪 | 与既有解析器的关系 |
| --- | --- | --- |
| **MP4 / M4A** | `moov.udta.meta.ilst` | 字段名是**带 © 的四字节码**（`©nam` / `©ART` / `©alb`）→ **复用不了** ID3 |
| **WAV** | `LIST` → `INFO` → `INAM` / `IART` / `IPRD` | RIFF 家族，**块长小端** |
| **AIFF / AIFC** | `COMM` + `ID3 ` 块 | FORM 家族，**块长大端**；`ID3 ` 块**就是** ID3v2 → 可复用 |

⚠️ **选型理由**：台账里还留着「歌单面板排序 / 过滤」，但**真实账号 `playlist/list` 实测 `total=0`**
（一个歌单都没有）→ 对用户**没有实际价值** → 本轮选「更多容器标签」。

⚠️ **不引新 npm 依赖**：三个解析器全部手写（与 T39 一致）。

### 字节布局（以 ffmpeg 9.0.2 造的真实文件核对过）

样本留在仓库外的 `release/t42-samples/`，**不入库**。真实字节长这样：

#### MP4（`sample.m4a`，25 882 字节）

```
@0     ftyp size=28
@28    free size=8
@36    mdat size=24481
@24517 moov size=1365          ← ⚠️ moov 在文件尾！只读文件头会漏掉全部标签
        ├─ mvhd  version=0 timescale=44100 duration=132300 → 3 秒
        └─ udta
           └─ meta              ← ⚠️ FullBox：头 4 字节 version+flags → 子原子从 +4 开始
              ├─ hdlr
              └─ ilst
                 ├─ ©nam size=26
                 ├─ ©ART size=26
                 └─ ©alb size=27
```

⚠️ **`data` 原子的载荷前有 8 字节**（真实字节）：

```
00 00 00 12 64 61 74 61 | 00 00 00 01 | 00 00 00 00 | 54 31
└ size=18 ┘└─ 'data' ─┘  └ 类型指示 ┘  └ locale ┘   └ 载荷 'T1' ┘
```

#### WAV（`sample.wav`，264 714 字节）

```
chunk fmt  @12  size=16   → channels=1 rate=44100 byteRate=88200 blockAlign=2 bits=16
chunk LIST @36  size=62    → 'INFO' IART 'A1' INAM 'T1' IPRD 'AL1' ISFT 'Lavf…'
chunk data @106 size=264600
```

⚠️ **文本块按 C 字符串写** → 长度里**含结尾的 NUL**（`'A1'` + 1 个 NUL = 3 字节）→ **必须按偶数补齐**，
且 `String.trim()` **不删 NUL**。

#### AIFF（`sample.aiff`，264 760 字节）

```
chunk NAME @12      size=2
chunk COMM @22      size=18   → channels=1 frames=132300 sampleSize=16
                                采样率 = 80 位扩展精度：40 0e ac 44 00 00 00 00 00 00 → 44100
chunk SSND @48      size=264608
chunk ID3  @264664  size=87   ← ⚠️ ffmpeg 要加 -write_id3v2 1 才会写
```

⚠️ **80 位扩展精度浮点**：`value = 尾数 × 2^(指数 − 16383 − 63)`；符号位是第 1 字节最高位，
指数是 15 位（`0` = 0，`0x7FFF` = Inf/NaN → 当「没有采样率」）。

### 抓到的两个真缺陷（都是**真文件**逼出来的，单靠构造字节流发现不了）

1. **`data` 原子的载荷偏移是 +8 不是 +4**（4 字节类型指示 + 4 字节 locale）。
   最初写成 +4 → 载荷里混进了 locale 的 4 个 NUL。
   ⚠️ **但真实文件（ffmpeg / iTunes）的 locale 恒为 0** → 那 4 个 NUL 会被「剔 NUL」那层吸收
   → **只测真实文件发现不了**。⇒ 单测里**故意用非 0 的 locale**（`0x41424344`）把偏移**钉死**。
2. **文本结尾的 NUL 必须剔掉**：`String.trim()` 只删空白，**不删 NUL** → 歌名会带看不见的 `\0`。

### 关键实现决定

| 决定 | 理由 |
| --- | --- |
| 一律**按文件头嗅探**，不靠扩展名猜 | `readTagsFromReader` 是唯一入口；MP4 看第 4~8 字节，WAV 看 `RIFF`+`WAVE`，AIFF 看 `FORM`+`AIFF`/`AIFC` |
| MP4 **按偏移走顶层原子表** | `moov` 常在文件尾 → 只读文件头会漏掉全部标签 |
| 原子长度**三种写法**都认 | 32 位 / `size==1`（64 位 `largesize`）/ `size==0`（延伸到文件尾） |
| `meta` 是 FullBox → 子原子从 **+4** 开始 | 否则会把 `hdlr` 当成第一个子原子 |
| `mvhd` 的偏移**随版本变** | v0：`timescale@+12` / `duration@+16`；v1：`timescale@+20` / `duration@+24`（**8 字节**） |
| 文本解码 **UTF-8 → GBK → Latin-1** | 老工具写的 WAV `LIST INFO` 常见 GBK 中文；UTF-8 用**严格模式**（`fatal: true`）才判得出解不出来 |
| 80 位浮点**自己算** | Node 没有现成的 extended 格式 |
| 元数据块续读沿用 **2 MB** 预算 | 宁可少读，也不把内存吃穿 |
| 原子/块遍历**防死循环** | 下一个位置 ≤ 当前位置 → 立刻收手 |
| **全程不抛** | 不认识 / 头不完整 → `null` 或**空标签** |

### 明确不做（写进规格，免得被当漏做）

**APEv2**（另一种标签格式，用得少）、**WMA / ASF**（另一个容器家族）、
**裸 ADTS-AAC**（裸流没有容器头，元数据本来就无处安放）。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1688 passed / 75 files**（基线 1669 / 74，**新增 19**）；
  `playwright test` **24 passed**（本任务**不改 UI → 不新增 E2E**）；
- **真文件验证**（不入库样本）：ffmpeg 造的 m4a / wav / aiff → 真解析器读出
  歌名 / 歌手 / 专辑 / 时长**全部正确**；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`docs/calibration.md` 仍 **CRLF**）；
- **变异自证（六处全部先红后复原，sha256 回基线 `c1aab88f35040f1b`）**：
  1. MP4 `data` 载荷偏移 `+8` → `+4` → 「locale 非 0」那条**红**；
  2. MP4 找 `moov` 改成**只看文件头** → 「`moov` 在文件尾」那条**红**；
  3. 去掉**结尾 NUL 剔除** → 「结尾的 NUL 要剔掉」那条**红**；
  4. GBK 退路改成 Latin-1 → 「老工具写的 GBK 标签」那条**红**；
  5. 80 位浮点指数少减 63 → 三条 AIFF 时长**红**；
  6. WAV 字节率取错字段（`@+4` 采样率 instead of `@+8` 字节率）→ 三条 WAV 时长**红**。

### 顺带修掉的一个文档错句

「二十、T38」章节的「已知限制」第 3 条原写「Chromium 播不了的格式（**FLAC** / APE 等）」
→ **FLAC 那半句是错的**（Chromium **能**解 FLAC，实测 `canPlayType('audio/flac') = "probably"`，
16bit/44.1k 与 24bit/96k 的真 FLAC 字节进 Blob 都正常出 duration；且 FLAC **不在**
`UNDECODABLE_FORMATS` 里 → **不进** FFmpeg 兜底）→ 已改成「APE / ALAC / WMA 等」并补更正说明。

### 遗留 / 待办

- ⚠️ **真机肉眼复验未做**：本地音乐里放真实的 m4a / wav / aiff 文件（用户侧操作）；
- ⚠️ **iTunes 写的 m4a 没实测**（字节布局以 ffmpeg 的样本核对过）→ 单测用非 0 locale 把偏移钉死；
- ⚠️ **WAV 的 `LIST INFO` 若是 UTF-16（无 BOM）** → 解不出来（会走 GBK / Latin-1）→ 可能乱码。
  WAV 的历史遗留（无 BOM 无法判定），**不猜**；
- ⚠️ **AIFC 的压缩类型没读** → AIFC 压缩音频的时长仍按采样帧数算；
- ⚠️ **`ilst` 的自由格式条目**（`----` 开头）**不解析** → 只取 `©nam` / `©ART` / `©alb`。
---

## 二十六、T43：域名型 NAS 地址走标准端口（端口补全规则第五版）

### 背景：用户反馈「自建反代的域名地址登不上，端口被写死了」

用户自建反向代理（openresty + 自有泛域名证书），地址形如 `https://<用户私有域名>`。
客户端把它补成了 `https://<用户私有域名>:5667` → **ECONNREFUSED** → 登不上。

### 真机实测（探针脚本 `release/verify/t43-relay-probe.mjs`，**不带任何凭证**）

| 端口 | 结果 |
| --- | --- |
| **443** | **通** —— TLS 握手成功；证书 CN=`<用户私有域名>`，SAN 里**含**该域名；`server: openresty` |
| **5666** | **ECONNREFUSED** |
| **5667** | **ECONNREFUSED** ← **旧代码补出来的就是这个** |
| 80 | 通（openresty，301 跳 https） |

音乐接口本身**完全正常**（免凭证只读接口 `GET /music/api/v1/sys/config`）：

```
→ 200 application/json
  {"code":0,"data":{"nasOAuth":{"clientId":"…"},"serverName":"…","serverVersion":"1.0.10",
   "mediasrvVersion":"0.8.43","capabilities":{…}}}
```

⇒ **反代正常、服务器正常，唯一的问题是客户端把端口补错了。**

### 根因：旧的域名例外只认「官方中继」的后缀

旧规则只有一条域名例外 —— `RELAY_DOMAIN_SUFFIX = '.fnos.net'`，那是 fnOS **官方中继**
`<fnId>.fnos.net` 的形状（官方中继**也**只听 443，见上表「中继端口」行）。

自建反代的域名**完全不在白名单里** → 被当普通 NAS → 补 `:5667` → 必然连不上。

⚠️ **不能把用户的私有域名硬编码进白名单**（换域名、又换一套反代，就得再改一次代码）
→ **把判定维度换对**：不是「是不是官方中继」，而是「**是不是 IP 字面量**」。

### 规则表（T43 之后）

| 主机形态 | 真实含义 | 端口 |
| --- | --- | --- |
| **IP 字面量**（`192.168.1.2`） | 局域网直连 fnOS 音乐服务 | `5666` / `5667`（**既有行为不变**） |
| **域名**（自建反代 / 官方中继 / 局域网主机名） | 反向代理 / 公网入口 | **标准端口 `80` / `443`** |

`withDefaultPort()` 的判定顺序（**顺序有讲究**）：

1. 空串 → 原样；
2. 非 http/https 协议 → 原样；
3. **有显式端口** → **原样**（端口一个字符都不改，协议也不改）；
4. **`.fnos.net` 中继域名** → 不补端口 + **协议归一到 https**
   （官方中继只提供 HTTPS；**必须排在第 5 条前面** —— 它也是域名）；
5. **IP 字面量** → 按协议补 5666 / 5667；**其它域名 → 不补端口**。

`isIpLiteral()` 的判法：IPv4 = 四段十进制；IPv6 = **含冒号**（方括号已由
`hostOfAuthority()` 去掉 → 里面必有冒号）→ 复用同一套 host 语义，判定与拆解**口径一致**。

### 已知代价：局域网**用域名**直连要显式写端口

`nas.local`（局域网 NAS 的主机名）→ 现在走 80 → 连不上 → 要写成 `nas.local:5666`。

⇒ 必须给用户可读引导，否则这个变化会变成「新的坑」：

- 登录页地址框下方的提示文案改成写明新规则；
- **连不上时补一句**：「若地址走反向代理或端口非标准，请在地址里显式写出端口（如 `https://host:443`）」。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1693 passed / 75 files**（基线 1688 / 75，**新增 5**）；
  `playwright test` **24 passed**（登录页只改文案 → 不新增 E2E）；
- **端到端真机验证**：用**真实模块**（`withDefaultPort` → `normalizeBase`）处理真实域名 →
  基址 `https://<域名>/music` → 真请求 `/api/v1/sys/config` → **200**，
  `serverName` / `serverVersion` / `supportsNasLogin` 全部读得到；
  同时核对了 IP 地址与官方中继的补全结果**一字未变**；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`docs/calibration.md` 仍 **CRLF**）；
- **变异自证（四处全部先红后复原，sha256 回基线 `edde386477316296` / `1449adb4db20948a`）**：
  1. IPv4 判定失效 → 「IP 地址仍按协议补默认端口」**红**；
  2. 域名规则被删 → 「域名地址不补端口」**红**；
  3. IPv6 判定失效 → 「IPv6 字面量也算 IP」**红**；
  4. 登录页提示文案被删 → 「提示文案写明新规则」**红**。

⚠️ **变异脚本又踩了同一个坑**（T42 也踩过）：把 `return /^\d…/.test(host)` 换成 `return false`，
而文件里 `return false` 出现 **4 次** → **复原时锚点不唯一 → 复原没执行** →
后面几轮的失败列表全是叠加的（每轮都多红几条）。
⇒ 修法两条：① 复原时唯一性要查**被替换掉的那一侧**；② **变异后的文本必须唯一**
（改成 `return false /* MUTANT: ipv4 */`）。

### 改写的既有测试（前提被用户**显式**推翻）

| 文件 | 改法 |
| --- | --- |
| `test/address.test.ts`「直连 NAS 仍按协议补默认端口（既有行为不变）」 | 前提（「域名也补默认端口」）被用户显式推翻 → **改写**为「**IP 地址**仍按协议补默认端口」+ 新增「**域名地址**不补端口」；**IP 的三条断言一字未改**（只把主机从 `nas.local` 换成 `192.168.1.2`） |
| `test/address.test.ts`「路径与查询串在补端口时保持不变」 | 同上 → 改用 IP 主机保留原意图，**并追加**一条「域名不补端口时路径与查询串同样原样保留」 |

### 遗留 / 待办

- ⚠️ **真机未验**：用域名地址**真登录**（需要用户凭证 → 用户侧操作）；
- ⚠️ **`isRelayHost` 仍按 `.fnos.net` 后缀判定**（`src/lib/address.ts` 与 `electron/session.ts` 两处）
  → 自建反代**不算**官方中继 → 登录请求**不带** `Cookie: mode=relay`。
  官方中继缺这个 Cookie 会返回 HTML 错误页（实测踩到）；
  ⚠️ **自建反代是否需要该 Cookie 取决于它后面接的是什么**（直连本机 5666 → 不需要；
  转发到官方中继 → 需要）→ **本轮不自动判定**，如实标注为待校准；
- ⚠️ **IPv4 判定只认四段十进制**：`0x7f000001` 这类十六进制写法会被当域名 → 不补端口
  （极端边缘，且不是用户会填的写法）。
---

## 二十七、T44：会话层加请求超时 + 登出不阻塞

### 背景：用户同时报了两个症状

| 症状 | 原话 |
| --- | --- |
| 界面卡顿 | 「软件老是有顿卡」 |
| 登出无响应 | 「点退出登陆没反应」 |

⇒ 按**系统化调试**（Phase 1 证据链 → Phase 2 对照 → Phase 3 假设 → Phase 4 实现）走，不猜。

### 根因：主进程会话层的 HTTP 请求**没有超时**

`electron/session.ts` 的 `send()`：

```ts
return await this.http().fetch(url, { method, headers, body: bodyString })   // ⚠️ 不传 signal
```

`electron/http.ts` 的 `fetch(input, init)` **支持** `init.signal`（标准 `RequestInit`），
但会话层**从没传过** → 网络一抖动就挂到 **TCP 超时**（Windows 默认可达 21 秒+）。

**对照（Phase 2：找可用的参照）**：项目里**其它出网路径都有超时** ——
`electron/probe.ts` 有 `PROBE_ERROR_TIMEOUT` 与逐候选超时控制；
**唯独会话层没有** → 这就是差异点。

⚠️ **用户的环境放大了它**：用户的 NAS 走**公网反向代理**（T43 实测：`https://<域名>/music`
能通，链路是 openresty → 443）→ 延迟更高、抖动更多。

### 「点退出登录没反应」的完整链路（全部核对过）

```
渲染层 LoginPage.handleLogout()
  └─ await bridge.logout()                    ← 渲染层在等
       └─ IPC 'auth:logout'
            └─ handleLogout(session)
                 └─ await session.request('user/logout')   ← ⚠️ **先等网络**
                      └─ send() → http.fetch（无超时）
```

⇒ 网络不通 / 中继不通 / NAS 无响应 → 这一行**永久挂住** → 渲染层 `await` 不返回
→ `busy` 锁死、按钮 `disabled` → **界面看着就是「点了没反应」**。

⚠️ 更糟：token 已失效（`99999`）时，`session.request()` 会**先 `relogin()`**
（一次**完整的登录往返**）→ 再重试登出 → 等得更久。

⚠️ **`src/App.tsx` 里早就写着**同一设计（「立刻切视图，不等 `logout()`」，
并注明「登出要先通知服务端，网络不通时可能挂住十几秒」）——
**但 `handleLogout` 一直没做到**（外壳层做了，会话层没做）。

### 顿卡的第二个来源：token 失效时每个请求变成 3 个网络往返

`失败(99999)` → `relogin()`（完整登录往返）→ `重试`。
⚠️ 旧代码里 `relogin()` 失败时**返回 false**（不抛），**却照样重试**
→ 多花一个网络往返，而那个请求**同样会挂到超时** → 顿得更久。

### 决定性实验（两个探针脚本，`release/verify/` 下）

| 探针 | 结论 |
| --- | --- |
| `t44-abort-probe.js`（Electron 跑） | **Electron Chromium 分区 fetch 支持 `AbortSignal`** —— 实测 **1217ms** 就中断 ⇒ 可以**真取消**，不是只能干等 |
| `t44-safestorage-probe.js`（Electron 跑） | **`safeStorage`（DPAPI）可用** —— 加密 37 字节、可回读 ⇒ `session.bin` 能正常落盘 |

⚠️ **附带发现**：用户的 `%APPDATA%\fnmusic-desktop` 与 `%APPDATA%\Electron` 里
**都没有 `session.bin`**（DPAPI 本身正常）⇒ 说明用户**在这台机器上从未成功登录过**
（**不是落盘坏了**）。

### 关键实现决定

| 决定 | 理由 |
| --- | --- |
| 超时**双保险**：`signal`（真取消）+ `Promise.race`（只等这么久） | 单测里的假 fetch **不理 `signal`** → 不兜底则测试会永远挂着；两层都在才稳 |
| 超时后**必须 `clearTimeout`** | 否则请求提前返回后定时器仍会 reject → **无人处理的 rejection**（Node 打警告） |
| 超时值 **30 秒**（`DEFAULT_REQUEST_TIMEOUT_MS`） | 用户走公网中继（实测约 230KB/s），曲库分页 / 专辑详情这类 JSON 在慢网下要几秒 → 30 秒足够宽裕 |
| 超时值**可注入**（`SessionManagerOptions.requestTimeoutMs`） | 单测注入 **80ms**，不必真等 30 秒 |
| **绝不影响流式路径** | `track/stream`（音频）与 `static/cover`（封面）走 `electron/proxy.ts` 自己的 `fetch`（**不经过** `session.send()`）→ 不会被截断 |
| 续期失败 → **不再重试**，把第一次的 99999 原样交回 | 渲染层收到 99999 → **立刻切回登录页**（`src/App.tsx` 已有这条路径）→ 比干等好得多 |
| 登出顺序：**先启动通知 → 立刻 `clear()` → 立刻返回** | 通知必须在 `clear()` **之前**启动 —— `clear()` 会清掉 token，之后就发不出去了。`request()` 是 async 函数：调用它会**同步**跑到第一个 await（请求头已带凭证、请求已发出）→ 顺序安全 |
| 登出通知用 `Promise.resolve(...).catch(() => undefined)` 包一层 | 单测里的假 `session.request` 可能返回 `undefined` |
| 文案：超时与连不上**分两句**，但**都以「无法连接音乐服务」开头** | 既有断言（`/无法连接音乐服务/`、`toContain('无法连接音乐服务')`）**一条都不用改** → 「既有测试一条不许删、断言一条不许削弱」**天然满足** |

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1697 passed / 75 files**（基线 1693 / 75，**新增 4**）；
  `playwright test` **24 passed**（本任务**不改 UI → 不新增 E2E**）；`npm run build` exit 0；
- **4 条失败测试全部先红**（超时内失败 / 超时与连不上是两句话 / 续期失败不再重试 /
  服务端挂住时登出立刻完成）→ 实现后**全部转绿**；既有 **101 条**一条没红；
- ⚠️ 全量第一次跑出现 **1 条偶发失败**（`test/mock-server.test.ts`）：单独连跑 3 次全绿 +
  后续两次全量全绿 → 判定为**已知端口争抢偶发**，与本次改动无关；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`docs/calibration.md` 仍 **CRLF**）；
- **变异自证（四处全部先红后复原，sha256 回基线 `656c38173f1c204e` / `f2d3a51d8cec046e` /
  `94b8dd65682c3799` / `5bcec1cac3e2b845`）**：
  1. 去掉超时 → 「超时内失败」**红**；
  2. 续期失败仍重试 → 「续期失败不再重试」**红**；
  3. 登出改回等网络 → 「服务端挂住时登出立刻完成」**红**；
  4. 超时与连不上不再区分 → 「超时与连不上是两句话」**红**。

### 既有测试一条没改写

本次**没有改写任何既有断言** —— 超时文案刻意做成「无法连接音乐服务」的**超集**，
让既有的子串匹配继续成立。**新增** 4 条：

| 文件 | 新增 |
| --- | --- |
| `test/session.test.ts` | 「超时内失败」「超时与连不上是两句话」「续期失败不再重试」 |
| `test/ipc-auth.test.ts` | 「服务端挂住时登出也能立刻完成」 |

### 遗留 / 待办

- ⚠️ **「顿卡」可能不止这一个原因**：本轮定位并修掉了**一个高概率根因**
  （无超时 → 挂到 TCP 超时）。若用户复验后仍卡，需要**继续查**
  （下一步可用 Chromium DevTools 的 Performance 面板 + 主进程日志）；
- ⚠️ **30 秒超时可能仍偏长**：若用户觉得「还是顿」，把 `DEFAULT_REQUEST_TIMEOUT_MS`
  调小即可（改一个常量）。⚠️ 调太小会让慢网下的大列表请求**误判为失败**；
- ⚠️ **续期失败不再重试**的副作用：这类请求会**立刻**返回 99999 → 渲染层判定
  「会话失效」→ **切回登录页**。这是**期望行为**（旧行为只是白等一个网络往返，
  然后同样失败）；
- ⚠️ **真机未验**：登录后点「退出登录」是否立刻响应、公网链路抖动时界面是否不再顿
  （用户侧操作）。
---

## 二十八、T45：灵动态词岛（骨架 + 样式二选一）

用户提问：「悬浮歌词能不能做成 Lyricify Fusion 的灵动歌词一样？」
→ 按 **superpowers:brainstorming** 走（探索 → 提问 → 方案对比 → 设计 → 规格 → 实现）。

### 用户拍板（三项）

| 决策 | 选择 |
| --- | --- |
| 与现有悬浮窗的关系 | **并存**，设置里二选一（经典悬浮窗 / 灵动态词岛） |
| 频谱波形 | **这一版一起做**（本轮 T45 只做骨架，频谱在 T47） |
| 窗口位置 | **顶部居中固定**，跨显示器跟随 |

切分为三个编号任务：**T45 骨架**（本节）/ **T46 内容与动效**（逐字发光、鼠标进入隐藏）/
**T47 频谱波形**。本节只覆盖 T45。

### 参照物与边界

Lyricify Fusion 的**灵动词岛** = 屏幕顶部居中的圆角胶囊 + 逐字高亮歌词 + 两侧曲名/歌手
+ 两端频谱波形 + 单词发光 + 鼠标进入隐藏。

⚠️ 本项目**不需要** SMTC（歌词与进度本来就在主进程里），
**不需要**多源歌词检索（NAS + 外部源已实现）→ 只做**形态与动效**这一层。

### 方案对比

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A（选定）** | **新增独立「词岛窗口」**，与经典悬浮窗并存，设置里二选一 | ✅ 两种窗口的定位/尺寸/穿透/置顶语义完全不同 → 必须分开 |
| B | 同一个 `BrowserWindow` 切两套布局 | ❌ 一个窗口要同时满足「自由拖动的方框」与「顶部居中的扁胶囊」→ 脆、难测 |
| C | 词岛做在主窗口顶部 | ❌ 只在主窗口可见时存在 → 桌面播放时就没了 |

代价：多一个渲染进程（约 30–50MB）。接受。

### 关键设计

| 决定 | 理由 |
| --- | --- |
| 偏好加 `lyricOverlay.mode?: 'classic' \| 'island'`（**缺省 classic**） | 老用户升级后行为**一字不变**；`bounds` 只对 classic 有意义（词岛位置是**算**出来的，不落盘） |
| 归一化**只认两个合法值**，陌生值**丢弃该字段** | 偏好文件是用户手改也改得动的地方 → 不能写半截进文件 |
| 锚定计算是**纯函数**（`shared/islandAnchor.ts`） | 算错了只有真机上才看得出来（且难复现）→ 必须有单测钉死 |
| 锚定用 **`workArea`** 而不是 `bounds` | `bounds` 含任务栏；副屏任务栏在**左侧**时两者不同 → 用 bounds 会算偏 |
| 跟随**主窗口所在屏**（`screen.getDisplayMatching`），不是鼠标位置 | 拖鼠标不该让词岛乱跳 |
| 重新锚定**节流 200ms**，且节流窗口内的那次**补算** | 拖动时 `move` 事件连珠炮发；不补算的话词岛会停在旧位置 |
| 位置算**整数** | Electron 的 `setBounds` 只收整数 |
| 主进程是**唯一的歌词消息分发者** → 发给「当前形态的那个窗口」 | 两种形态互斥 → 不会重复消费 |
| 切换形态时**把缓存的 `lastLyricMessage` 补发给新窗口** | 否则新窗口要等到下一次切歌才有内容（既有 `did-finish-load` 机制已有此能力） |
| 设置页用**两个 radio**（不是 `select`）+ 显式 `aria-label` | 两个选项一眼可见；`<label>` 包控件会把说明文字带进可访问名 → 名字不稳定、没法精确选中 |
| 归属层只能是 `shared/` | 主进程要算窗口位置、`electron/` **不许反向依赖 `src/`**（层次反了） |

### 实现落点

- **新增**：`shared/islandAnchor.ts`（纯函数）、`island.html`、`src/island/main.tsx`、
  `src/island/island-window.css`、`test/lyric-island-anchor.test.ts`、
  `test/lyric-island-prefs.test.ts`
- **改**：`shared/playerBridge.ts`（`LyricOverlayMode` 类型 + 偏好字段 + 两个桥方法）、
  `electron/preload.ts`（暴露桥方法）、`electron/ipc.ts`（偏好归一化 + `lyric:set-mode` 通道）、
  `electron/main.ts`（词岛窗口 + 锚定 + 形态切换 + 分发目标）、
  `src/state/appPrefsStore.ts`（`lyricOverlayMode` + setter）、`src/components/SettingsPanel.tsx`（二选一）、
  `vite.config.ts`（新增 `island` 入口）
- **既有测试的改动**：
  - `test/tray-tooltip.test.ts`「注册了全部通道」是**通道集合的精确断言** →
    新增 `lyric:set-mode` 后前提被推翻 → **改写为新集合断言**（不是放宽）；
  - `test/media-session.test.ts` 的假桥是**完整对象字面量** → 桥接口加了两个方法后
    编译不过 → **只补两个空实现**（CRLF → 脚本写回），**一条断言没动**。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1713 passed / 77 files**（基线 1697 / 75，**新增 16**）；
  `playwright test` **24 passed**；`npm run build` exit 0（产物含 `dist/assets/island-*.js`）；
- **先红后绿**：4 个文件先红（8 条失败）→ 实现后**全部转绿**，既有测试**一条没红**；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`test/media-session.test.ts` 仍 **CRLF**，
  其余为 LF）；
- **变异自证（四处全部先红后复原，sha256 回基线）**：
  1. 锚定改成贴左边 → 锚定单测 **3 条红**；
  2. 偏好归一化不认 `'island'` → 偏好单测 **2 条红**；
  3. `lyric:set-mode` 永远传 `'classic'` → 通道测试 **1 条红**；
  4. 设置页选「灵动态词岛」不通知 store → 设置页测试 **1 条红**。

### 已知限制（如实标注）

- ⚠️ **挖孔屏遮挡**：Chromium 拿不到刘海/挖孔几何 → 胶囊可能被遮（**没做**检测）；
- ⚠️ **多显示器**：词岛跟随**主窗口**所在屏；主窗口不动 → 词岛也不换屏；
- ⚠️ **词岛压在全屏应用之上**：沿用既有悬浮窗的 `alwaysOnTop('screen-saver')` 行为；
- ⚠️ **本轮没有频谱、没有逐字发光、没有鼠标进入隐藏** → 分别是 T47 / T46 的活。

### 遗留 / 待办

- ⚠️ **真机未验**：切到「灵动态词岛」后胶囊是否真出现在屏幕顶部居中、
  多显示器切换是否跟随、歌词是否正常滚动（**用户侧操作**）；
- ⚠️ **T46**：逐字发光 + 曲名/歌手 + 鼠标进入隐藏；
- ⚠️ **T47**：频谱波形（`captureStream` + `AnalyserNode` + 限频 IPC）。
---

## 二十九、T46：灵动态词岛 —— 逐字发光 + 鼠标进入隐藏

承接 T45（词岛骨架 + 样式二选一）。本轮做**内容与动效**：当前词发光、指针进入隐藏、
以及为此必须解决的**点击穿透**问题。

### 探针先行（`release/verify/t46-mouse-probe.js`，Electron 32.3.3 实测）

词岛贴在**屏幕顶部** → 如果它吃掉鼠标事件，最大化应用的**标题栏中央就点不到** →
必须「点击穿透」。但「鼠标进入隐藏」又要求能知道鼠标移没移进来。

| 探针结果 | 含义 |
| --- | --- |
| `setIgnoreMouseEvents(true, { forward: true })` 后仍收到 **131 次 mousemove** | ✅ **点击可穿透** + 仍能感知鼠标 |
| `movesInsideWindow: 131`，`clientX 258→244`（窗口 x=1020，屏幕 1280 → 258 恰好对上） | ✅ 坐标能定位指针是否在词岛上 |
| ⚠️ 指针**移出后 0 个事件** | ⚠️ 渲染进程**收不到「离开」** → 恢复**不能**靠渲染层 |

⇒ 「移出后恢复显示」只能由**主进程轮询**指针位置（`screen.getCursorScreenPoint()`）。

### 关键设计

| 决定 | 理由 |
| --- | --- |
| 词岛开 `setIgnoreMouseEvents(true, { forward: true })` | 它在屏幕顶部，不穿透就**挡住**下面的应用 |
| 主进程 **10Hz 轮询**指针位置，变化时 `webContents.send('lyric:pointer', inside)` | 渲染进程收不到「离开」→ 恢复只能靠轮询 |
| ⚠️ **不新增 ipcMain 通道** | `lyric:pointer` 走 `webContents.send`（与 `lyric:state` 同款）→ **不动**既有的通道集合断言 |
| `LyricView` 加**可选** prop `activeWordClassName` | 缺省 = **不加任何类名** → 主界面歌词 / 全屏歌词舞台 / 经典悬浮窗的行为**一字不变** |
| 只给**正在被唱的那一个词**加钩子；该行已走满 → **不加** | 已走满 = 整行都是唱过的状态，没有「当前」可言 |
| 发光**只用 `text-shadow`** | 逐字着色层（overlay）与底层整行文本必须**字形严丝合缝** → `transform: scale` / 字重都会让两层**错位** |
| 淡出**只降不透明度**，不用 `display:none` / `visibility:hidden` | 状态由主进程轮询驱动，与渲染层自身无关 |
| 组件从入口里**拆出来**（`IslandApp.tsx`） | `main.tsx` 直接 `createRoot` → 测试没法 import；拆开后「指针进入 → 淡出」才**能测** |
| ⚠️ **词岛不再响应点击**（去掉 `onSeek`） | 物理上不可能兼得：穿透 = 点击落到**下面的应用** → 词岛点不到。**点歌跳转仍在经典悬浮窗**（Lyricify 的词岛同样不可点） |

### 影响文件

- **新增**：`src/island/IslandApp.tsx`（词岛根组件）、`test/lyric-island-pointer.test.ts`、
  `test/lyric-island-app.test.tsx`
- **改**：`shared/islandAnchor.ts`（+ `isPointInsideRect` 纯函数）、`shared/playerBridge.ts`
  （+ `onLyricPointer`）、`electron/preload.ts`（暴露桥方法）、`electron/main.ts`
  （穿透 + 指针轮询）、`src/ui/lyrics/LyricView.tsx`（+ 可选 prop `activeWordClassName`）、
  `src/island/main.tsx`（瘦身为入口）、`src/island/island-window.css`（发光 + 淡出）、
  `test/lyric-view.test.tsx`（新增 3 条）、`test/media-session.test.ts`（假桥补空实现）

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1726 passed / 79 files**（基线 1713 / 77，**新增 13**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **先红后绿**：2 个文件先红（6 条失败）→ 实现后**全部转绿**，既有测试**一条没红**；
- 本轮改动文件 **U+FFFD = 0**、无 BOM、行尾保持原样（`test/media-session.test.ts` 仍 **CRLF**）；
- **变异自证（四处全部先红后复原，sha256 回基线）**：
  1. 指针判定永远 false → 指针单测 **3 条红**；
  2. 当前词不再加钩子类名 → 歌词视图单测 **1 条红**；
  3. 词岛不订阅指针通知 → 组件单测 **2 条红**；
  4. 关掉点击穿透 → **源码护栏**单测 **1 条红**；
- **复原校验**：4 处变异跑一轮 apply+revert 后，四个文件 sha256 与基线**完全一致**
  （`bf383b7e3d09ca5f` / `ca33dbd3f875c095` / `c18019ca2747adcb` / `76d701c04a4c5e7c`）。

### 已知限制（如实标注）

- ⚠️ **词岛不可点**（点击穿透的代价）→ 点歌跳转只在**经典悬浮窗**有；
- ⚠️ **隐藏后不恢复**的极端情形：若主进程指针轮询因异常停摆，词岛会一直淡出
  （轮询本身只有 `getCursorScreenPoint()` 一个系统调用，极轻）；
- ⚠️ **浅色胶囊**（沿用 `--surface-raised`）：在浅色壁纸上存在感偏弱 → 若用户反馈太淡，
  再给 `tokens.css` 加一组「词岛」专属语义变量（**本轮没做**，避免擅自扩范围）。

### 真机验收（补测：`release/verify/t46-accept-probe.mjs` + `t46-click-probe.mjs`）

⚠️ **上一轮判「真机没淡出」是误判**：那批截图拍到的是一个**在 T46 构建完成（15:44:44）之前就启动**的旧实例
（该探针 userData 目录里 `Local State` 的最后写入时间是 **15:28:23**，早于构建时间）→ 它加载的是 **T45 产物**，
所以「主进程没有指针轮询」是**必然**的。**不是代码缺陷**。

重启到 T46 构建后，三项行为逐项实测通过（Electron 32.3.3 / 2560×1440 / `scaleFactor: 1`）：

| 行为 | 观测方式 | 实测结果 |
| --- | --- | --- |
| 逐字发光 | 合成一条逐字歌词 → 读当前词的 computed `text-shadow` | ✅ 正在唱的词 `Hello` = `rgb(10, 102, 255) 0px 0px 8px, rgb(10, 102, 255) 0px 0px 18px`；没唱到的 `World` = `none` |
| 鼠标进入隐藏 | 读 `.fnm-island` 的 class + computed `opacity`，并抓**真实屏幕截图** | ✅ 移开 `opacity: 1` → 移上 `class="fnm-island fnm-island--pointer-inside"`、`opacity: 0` → 移开恢复 `1` |
| 点击穿透 | 在词岛正中心做**真实系统级点击**（`mouse_event` 按下 + 抬起）→ 读下层窗口的点击计数 | ✅ 下层按钮计数 **0 → 1**；词岛渲染进程 `mousedown = 0` / `click = 0` |

主进程侧同时验证：轮询确实发出 `lyric:pointer`（`false → true → false → true`），
渲染进程确实收到（`data-pointer-inside` 随之翻转）→ **「轮询 → send → 订阅 → CSS」四段链路逐段打通**。

⚠️ **教训（真机验证的通用坑）**：改了 `electron/` 或 `src/` 之后，**旧实例仍然跑的是旧产物** →
看到旧行为 → 极易误判成缺陷。**真机验证前必须先确认目标实例是用当前构建启动的**
（构建产物 mtime 要早于实例启动时间）。

### 遗留 / 待办

- ⚠️ **T47**：频谱波形（`captureStream` + `AnalyserNode` + 限频 IPC）。
## 三十、T46 补丁：词岛歌词只显示当前一行

用户反馈：「灵动歌词一行就够」。这是 T46 验收后的**呈现修正**（属 T46 范围内的补丁）。

### 为什么

词岛是**贴在屏幕顶部**的一条窄胶囊（96px 高）→ 双行歌词会把整条胶囊撑满，
当前词被挤在中间，**扫一眼看不出「正在唱哪个词」**。一行 = 当前行**放大居中**
（正是 Lyricify「灵动歌词」的观感）。

### 实现路径：`mode="single"` + `windowRadius={0}`

| 候选 | 结论 |
| --- | --- |
| `mode="double"`（现状） | ❌ 两行同时在场 → 不满足「一行就够」 |
| `mode="single"`（**缺省**） | ❌ `single` 是**窗口裁剪**，默认半径 `LYRIC_WINDOW_RADIUS = 3` → 渲染当前行上下**共 7 行** |
| `mode="single"` + `windowRadius={0}` | ✅ **只渲染当前行**；当前行**照常逐字推进** → T46 的**逐字发光**不受影响 |

⚠️ **高度不动**（`ISLAND_WINDOW_HEIGHT = 96`）：当前行 44px，胶囊内容区 76px
→ 滚动定位（`scrollTop = 行位置 + 行高/2 − 可视区/2`）让当前行**正好垂直居中**；
左侧曲名/歌手两行仍占位 → 胶囊不显得空。
⚠️ 改高度会牵动 `shared/islandAnchor.ts` 的常量与锚定单测 → **本轮不做**。

⚠️ **经典悬浮窗不动**（仍 `double`）→ 主界面 / 歌词舞台 / 经典悬浮窗的行为**一字不变**。

### 影响文件

- **改**：`src/island/IslandApp.tsx`（`mode` + `windowRadius`）
- **改**：`test/lyric-island-app.test.tsx`（新增 4 条；假桥补 `emitLyricState`）

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1730 passed / 79 files**（基线 1726 / 79，**新增 4**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **先红后绿**：4 条新断言先红 → 实现后**全部转绿**，既有 5 条**一条没红**；
- ⚠️ **红的原因不是实现**：新断言最初用 `getByText('乙行乙')` → 逐字着色层（`aria-hidden`）
  会把同一行文字**再渲染一遍** → testing-library **同时命中两处** → `waitFor` 一直重试到超时。
  → 改成**读行节点的 `data-index` 与 `textContent`**（断言更精确，不放宽）。
- **变异自证（三处全部先红后复原，sha256 回基线）**：
  1. 退回 `mode="double"` → 「只渲染一行」等 **3 条红**；
  2. 不传 `windowRadius={0}`（半径回到 3 → 渲染 7 行）→ **3 条红**；
  3. 去掉 `activeWordClassName` → 「发光钩子」**1 条红**；
- **复原校验**：跑一轮 apply+revert 后两个文件 sha256 与基线**完全一致**
  （`cafd75cc7dc8d2ef` / `05f6e31cf095f07d`）。
- **真机**（`release/verify/t46p-single-probe.mjs`）：合成两行逐字歌词、推进到第二行
  → 词岛 DOM 里**歌词行恰好 1 个**、`data-index` 命中播放位置所在行、
  当前词带 `fnm-lyricview__word--active` 且 computed `text-shadow` 非 none。

### 遗留 / 待办

- ⚠️ **真机视觉**：单行在 96px 胶囊里的观感（是否偏空）→ 用户复验后决定要不要收窄高度；
- ⚠️ **T47**：频谱波形（`captureStream` + `AnalyserNode` + 限频 IPC）。
## 三十一、T46 补丁②：词岛的「一行**居中**」

用户反馈：「灵动歌词显示不对，应该是一行居中」。这是 T46 补丁①（词岛歌词改单行）引入的**真缺陷**。

### 根因（两层，缺一不可）

1. **CSS 层**：单行模式（`mode="single"`）下 `LyricView` 的**画布高度 = 整份歌词的总高**
   （行数 × 34px）→ 歌词区若按内容取高 → 被撑到几千 px → 胶囊（96px）裁剪后
   露出的是「**歌词表的垂直中点**」，而不是当前行；
2. **组件层**：量视口的 `useEffect` 依赖写死 `[]` → 挂载那一刻歌词还是**空的**
   （走**空态分支**，**没有视口节点**）→ effect 拿不到节点就走了 → **歌词到达后不会重跑**
   → `viewportHeight` 永远停在 0 → 居中一律按**兜底高度 400** 算。

⚠️ **双行模式完全不受影响**（滚动位置恒为 0，用不到视口高度）→ 这个缺陷在双行下**看不出来**，
直到词岛改用单行模式才暴露。

### 探针（`release/verify/t46p-center-probe.mjs`，**200 行**歌词）

⚠️ **数据量必须真实**：补丁① 的验收探针只有 2 行歌词（画布 78px）→ **恰好不暴露**这个缺陷。

| 观测 | 修复前 | 修复后 |
| --- | --- | --- |
| 歌词视口高度 | **6810**（被画布撑开） | **74** ✅ |
| `scrollTop` | 4446（按兜底 400 算） | **4609** ✅ |
| 当前行相对视口 | 4624px（**在视野外**） | **15px** ✅ |
| 当前行相对胶囊 | 1267px（**看不见**） | **26px** ✅（在 96px 胶囊内） |
| `insideView` | false | **true** ✅ |
| 相对视口中心偏差 | 1241px | **0** ✅ |
| 相对胶囊中心偏差 | 1241px | **0** ✅ |

### 修法

- **CSS**：`src/island/island-window.css` → `.fnm-island__lyrics { align-self: stretch; }`
  → 歌词区高度 = 胶囊内容区（≈74px），**不跟歌词总高走**；
- **组件**：`src/ui/lyrics/LyricView.tsx` → 量视口的 effect 依赖加 `safeLines.length`
  → 歌词到达后**重新量**视口。

⚠️ `mode="single"` 在 `src/` 里**只有词岛**在用 → 组件层修复对其它页面**零影响**。

### 影响文件

- **改**：`src/island/island-window.css`、`src/ui/lyrics/LyricView.tsx`
- **新增**：`test/lyric-island-css.test.ts`（3 条 CSS 契约）
- **改**：`test/lyric-view.test.tsx`（新增 1 条视口测量回归）

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1734 passed / 80 files**（基线 1730 / 79，**新增 4**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **先红后绿**：CSS 契约 1 条 + 视口测量 1 条先红 → 实现后**全部转绿**，既有测试**一条没红**；
  - ⚠️ 视口测量那条的**红**恰好是**兜底 400 算出的 128**（期望 291 = 真实视口 74 算出的值）；
- **变异自证（三处全部先红后复原，sha256 回基线）**：
  1. 删掉 `align-self: stretch` → CSS 契约 **1 条红**；
  2. `align-self` 写成 `center`（看起来对）→ CSS 契约 **1 条红**；
  3. 量视口的 effect 依赖改回 `[]` → 视口测量 **1 条红**；
- **复原校验**：apply+revert 一轮后四个文件 sha256 与基线**完全一致**
  （`24201986bd176074` / `d12d66fdb4748e72` / `0dd87b524d6163c0` / `32fb9cf45c877fc6`）。

### 已知限制（如实标注）

- ⚠️ **jsdom 量不到布局** → 「视口高度」这类量测**只能靠 CSS 契约 + 真机探针**双保险，
  单测只能钉**声明**；
- ⚠️ 本次缺陷能溜过去，是因为**验收探针的数据量太小**（2 行）→ **真机探针必须用真实数据量**。

### 遗留 / 待办

- ⚠️ **T47**：频谱波形（`captureStream` + `AnalyserNode` + 限频 IPC）。

---

## 三十二、T47：灵动态词岛的频谱波形（真实频谱 + 两端各 8 根镜像柱）

### 取数路线的**修正**（规格原文的前提已过时）

规格第 2.1 节写「项目的 Web Audio 图**只在开 EQ 时才建**（`ensureAudioChain`）」，
据此选了 `captureStream()` 路线（理由：别为了频谱去 `createMediaElementSource`，
那会劫持 `<audio>` 的输出）。

⚠️ **该前提与当前代码不符**：`src/player/engine.ts` 的 `ensureAudioGraph()` 在
**每一次首次播放**时**无条件**建图（`createMediaElementSource` → `gain` → `destination`），
**与 EQ 开没开无关** ⇒ **所有用户的音频本来就走 Web Audio**。

⇒ 复用现有音频图挂 `AnalyserNode` **不新增任何劫持**（不新建 `AudioContext`、
不新建解码路径），而且取到的是 **EQ + 音量之后**的信号 = 用户真正听到的。

### 探针结论（`release/verify/t47-spectrum-probe.js`，Electron 32.3.3 实测）

| 路线 | 做法 | 实测 |
| --- | --- | --- |
| **A（本方案）** | `source → gain → destination`，**额外** `gain → analyser`（不连 destination） | `peak = 249`；`stillPlaying = true` |
| B（规格原文） | `captureStream()` → 独立 AudioContext → analyser | `peak = 249`，与 A **逐 bin 相同** |
| C（对照） | `source → analyser`（不连 destination） | `peak = 236` |

- 实测环境：`sampleRate = 48000`、`fftSize = 2048` → `frequencyBinCount = 1024`；
- ⚠️ **T45 探针的 `captureStream` 是在 `createMediaElementSource` 之前测的**；
  T47 探针改成**接管之后**再测 → 结论变了（**没有静音**）。

⇒ 两条路都可用；**选 A**（零新增上下文 / 反映 EQ 后信号 / 不依赖 `captureStream`）。

### 实现要点

- **采样**：24fps（42ms/帧）读一次 `getByteFrequencyData` → 切成 **8 段对数分布**
  （80Hz–8kHz，每段取区间**最大值**）→ IPC `lyric:spectrum`（载荷 `number[]`，长度 8）；
- **只在「桌面歌词可见 **且** 形态 = `island`」时采样**（可见性走 `lyric:visibility` 事件 +
  启动时 `getPrefs()` 兜底；形态走偏好 store）→ 不给「顿卡」添新堵点；
- **分析节点挂在 `gain` 之后**（EQ + 音量之后），**不连 destination**；
  ⚠️ **建它失败不许影响播放**（`createAnalyser` 缺失 → `analyser = null` → 没有频谱，不崩）；
- **镜像**：左端 = 频谱**逆序**、右端 = 频谱**原序** ⇒ 整条胶囊「高频 → 低频 | 低频 → 高频」。

### 真机验收（`release/verify/t47-spectrum-probe.mjs`，用户**真实会话**）

- 播放真实歌曲「占位曲目一」→ 词岛两端柱子**随音乐跳动**；
- 两次采样（间隔 1.5s）柱子高度**明显不同**（例：左 `[4,13,21,29,45,35,47,28]`
  → `[4,11,25,32,42,36,36,39]`）；
- ⚠️ **左右严格镜像**：右组 = 左组的**逐根逆序**（`[28,47,35,45,29,21,13,4]`）；
- 截图 `release/verify/t47-spectrum-shot.png`。

### ⚠️ 一次**真机才发现**的返工：右边「几乎是空的」

初版按「16 段各分一半」（左 = 低频 8 段、右 = 高频 8 段）→ 真机截图显示
**右边几乎全是 4% 的小点**（高频段能量天然远低于低频段：低频柱 46%、高频柱 4%），
整条胶囊**左右不对称** ⇒ **不符合用户拍板的「镜像」**。

⇒ 改成「**同一组 8 段 + 右端取逆序**」→ 左右显示的是同一组频段 ⇒ **两边永远一样饱满**。

⚠️ **教训**：这类「视觉对称」的要求，**单测测不出来**（jsdom 没有布局），
必须靠**真机截图**才能发现 ⇒ 验收探针要**截图 + 读数值**两样都做。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1774 passed / 81 files**（基线 1734 / 80，**新增 40**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **变异自证（七处全部先红后复原，sha256 回基线）**：
  1. 采样器不启动 → **1 条红**；
  2. bin 取平均（不是最大值）→ **1 条红**；
  3. 主进程不转发频谱 → **1 条红**；
  4. 左端不逆序 → **1 条红**；
  5. 右端也逆序 → **1 条红**；
  6. 分析节点不挂 gain → **1 条红**；
  7. 载荷校验放行一切 → **2 条红**；
- **复原校验**：apply+revert 跑一轮后五个文件 sha256 与基线**完全一致**。

### 既有断言的处理（**改写，不放宽**）

- `test/tray-tooltip.test.ts` 的「注册了全部通道」是**通道集合的精确断言**
  → `listeners` 由 `['lyric:state','player:command','player:state']` 变成
  `['lyric:spectrum','lyric:state','player:command','player:state']`
  → **改写为新的完整集合**（与 T41 / T45 的处理一致）。

### 已知限制（如实标注）

- ⚠️ **挂 analyser 后听感是否变化**（音量 / 延迟）→ 探针只验了「音频还在播、currentTime 在走」，
  **听感仍待用户复验**；
- ⚠️ **jsdom 量不到布局** → 柱子的观感（居中 / 过渡 / 对称）只能靠
  **CSS 契约 + 真机截图**双保险；
- ⚠️ 采样器挂在 **EQ 之后** → 开 EQ 时柱子的形状会随 EQ 变化（这是**如实反映**，不是缺陷）。

### 遗留 / 待办

- ⚠️ **待用户复验**：① 挂 analyser 不改变听感；② 频谱柱在**真实场景**下的观感；
- ⚠️ **待用户复验 T46**：指针移上去淡出 / 移开淡回 / **点击穿透**到下面应用。

## 三十三、T48：灵动态词岛的卡拉OK 渐进填色（整词发光 → 词内连续填色）

### 起因（用户原话）

> 「灵动歌词的发光效果做成卡啦OK模式，那样看起来才顺滑」

**根因**：T46 的逐字发光是**整词跳变** —— 词一到就整词变色（`--sung` 整词上强调色
+ `text-shadow` 光晕）⇒ **每个词的边界都在「闪一下」**。

**关键发现**：工程里早就有「词内连续比例」—— `LyricWordProgress.wordProgress`
（`src/ui/lyrics/doubleLine.ts`），注释明写「词内的时间是连续的，所以这个值适合做
『平滑扫光』」—— 只是**一直没人用** ⇒ 本轮**不新算任何时间轴**。

### 实现（要点）

- `LyricView` 加**可选** prop `karaoke?: boolean`（缺省 `false`）
  → 主界面歌词 / 全屏歌词舞台 / 经典悬浮窗**一字不变**；
- 卡拉OK 模式下当前词**不再**整词上色（`--sung`）→ 改挂 `--karaoke`，
  填色比例 = `wordProgress × 100%`（走 CSS 变量 `--fnm-lyricview__karaoke-progress`，
  **同时**给 `data-karaoke-progress` 供单测读 —— jsdom 的 CSSOM 对自定义属性不可靠）；
- CSS 用 `background-clip: text` + 线性渐变（**不改字形** → 逐字着色层与底层原文依旧
  **严丝合缝**）；未填部分 `color: transparent` → **透出底层原文**（= 还没唱到的颜色）；
- ⚠️ **整词发光的光晕一并删掉**：光晕画在字形轮廓上 → 会把填色的**边界糊掉**
  （看到的还是一条模糊亮边，不是清晰的推进线）；
- `activeWordClassName`（整词发光钩子）**保留不动**（通用钩子），只是词岛不再用它。

### 真机像素级验证（`release/verify/t48-karaoke-probe.mjs`）

做法：隔离实例 + 合成一条**长词**（`KaraokeFill`，占 0~40s）→ 在 25% / 50% / 75%
三个时刻读 DOM + 计算样式 + **截那一行图扫像素**（量「填色边界」落在词的哪个百分比）。

| 时刻 | 期望比例 | `data-karaoke-progress` | 计算样式 `background-size` | **像素量出的边界** | 误差 |
| --- | --- | --- | --- | --- | --- |
| 10s | 25% | `25.0` | `25% 100%` | **24.6%** | 0.4 |
| 20s | 50% | `50.0` | `50% 100%` | **49.7%** | 0.3 |
| 30s | 75% | `75.0` | `75% 100%` | **73.9%** | 1.1 |

- 计算样式：`background-clip = text`、`color = rgba(0, 0, 0, 0)`（透明 → 未填部分透出底层原文）、
  `background-image = linear-gradient(90deg, rgb(10,102,255), rgb(10,102,255))`；
- ⚠️ **测的是「填色边界」，不是「有没有这个类」** —— 这才证明渐变真的**填进了字形**
  （jsdom 永远测不到这一层）；
- 截图：`release/verify/t48-karaoke-10s.png` / `-20s.png` / `-30s.png`（词那一行的裁剪）、
  `release/verify/t48-karaoke-island.png`（整条胶囊）；肉眼可见**左半蓝色 / 右半黑色**，
  边界正好在词的中点；
- ⚠️ 探针的 `app.close()` 在透明置顶窗口上可能挂住 → 已加 5 秒超时硬退
  （数据在写盘后才关窗，不受影响）。

### 既有断言的处理（**改写，不放宽**）

- `test/lyric-island-app.test.tsx` 的「当前行仍然逐字推进，并带 T46 的发光钩子」
  → 前提被用户**显式**推翻 ⇒ **改写为新行为断言**（当前词挂 `--karaoke`、
  `data-karaoke-progress = 50.0`、**不再**挂 `--sung`、**不再**有 `--active`）；
- `test/lyric-view.test.tsx` 的 T46 三条（`activeWordClassName` 钩子）**一条没动**；
- `test/lyric-island-css.test.ts` 的 T46 居中三条**一条没动**。

### 变异自证（6 处，全部先红后复原）

1. 卡拉OK 下当前词**仍然整词上色** → **2 条红**；
2. 填充比例**写死 100%** → **2 条红**；
3. CSS 去掉 `background-clip: text` → **1 条红**；
4. CSS 把填充宽度**写死** → **1 条红**；
5. CSS 取消 `color: transparent` → **1 条红**；
6. 词岛**退回整词发光** → **1 条红**。

**复原校验**：apply+revert 跑一轮后四个文件 sha256 与基线**完全一致**
（`b57d3cdab19f5c93` / `b85ea2eaffc72ba0` / `db243609abae8af2` / `bb205b5945a3d4f6`）。

### 已知限制（如实标注）

- ⚠️ **填色是「词内」的**：词很长时，填色要走**整个词的时间**才填满（卡拉OK 的定义）；
- ⚠️ **伪逐字**（NAS 没给逐字标签）：填色粒度 = 伪逐字的粒度；
- ⚠️ **只影响词岛**：经典悬浮窗 / 歌词舞台仍是**整词跳变**（用户只要求灵动歌词改）；
- ⚠️ **`background-clip: text` 的降级**：万一某内核不支持 → 最多是「当前词没有填色」
  （底层原文还在，**不会**变成「当前词看不见」）。

### 遗留 / 待办

- ⚠️ **待用户肉眼复验**：真实歌曲下的卡拉OK 观感（长句 / 短句 / 英文歌词）；
- ⚠️ **待用户复验 T46**：指针移上去淡出 / 移开淡回 / **点击穿透**；
- ⚠️ **待用户复验 T47**：挂 analyser 后听感是否变化。

## 三十四、T49：软件更名为「Sanlos music」

### 起因

用户要求：「软件名改成 Sanlos music」（并就两项有副作用的决策拍板：
**默认下载目录一起改** / **fnOS 授权页上的 `app_name` 也改**）。

### 关键判定：仓库里「飞牛音乐」有**两个完全不同的指代**

| 指代 | 是什么 | 处理 |
| --- | --- | --- |
| **A. 本软件的品牌名** | 这个 Windows 客户端自己叫什么 | ✅ **改**（14 处代码） |
| **B. NAS 上的服务端产品名** | fnOS 里那个音乐应用叫什么 | ❌ **一个字不改**（登录页大标题「**连接飞牛音乐**」/ `mock-server` / `src/api/types.ts` 注释） |
| **C. 内部标识符与历史文档** | `package.json` 的 `name` / `appId` / `fnm://` 协议名 / `docs/superpowers/` 下的历史规格 | ❌ **不动**（部分有破坏性，见下） |

⚠️ **不能全局替换**：把登录页标题改成「连接 Sanlos music」会让用户以为连的是别的服务。

### 明确不动的（理由）

- **`package.json` 的 `name: fnmusic-desktop`** → 它决定 **userData 目录**
  `%APPDATA%\fnmusic-desktop` → 改了 = **登录态（`session.bin`）与偏好全丢**；
- **`appId: com.fnmusic.desktop`** → 决定 **Windows 安装路径 / 注册表项 / 升级链**
  → 改了会被当成另一个应用；
- **`fnm://` / `fnml://` 协议名** → 对外契约。

### 下载目录改名：**老文件不受影响**（关键结论）

- 默认下载目录**只用于「新下载」落盘**；
- 已下载条目在索引 `downloads.json` 里存的是**绝对路径** → **老歌照样能播、照样在列表里**；
- 本地库登记的是「索引里的路径 + 用户手动添加的文件夹」，**不扫默认目录**
  → 不存在「老歌凭空消失」；
- 老目录 `我的音乐\飞牛音乐` **不删**（用户的数据，删不删由用户决定）。

### 真机验证（`release/verify/t49-brand-probe.mjs`，隔离实例）

| 读数 | 结果 |
| --- | --- |
| 主窗口 `document.title` | **`Sanlos music`** |
| 顶栏 `.app-shell__brand` | **`Sanlos music`** |
| 词岛窗口标题 | **`Sanlos music · 动态词岛`** |
| 默认下载目录（走真实 IPC `download:list`） | **`<我的音乐>\Sanlos music`**（= 本机「我的音乐」+ 新子目录名） |

⚠️ 另用 `EnumWindows` 复核了**主窗口标题**（`Get-Process | MainWindowTitle` 在 Electron
**多窗口**进程里只报得下一个窗口 → 会漏掉主窗口，**不能**据此说「主窗口没标题」）。

### 既有断言的处理（**改写，不放宽**，前提被用户显式推翻）

- `test/app-info.test.ts`（应用名）、`test/tray-tooltip.test.ts`（托盘提示）、
  `test/oauth-window.test.ts`（`app_name` ×2，含「URL 里不是明文」那半条）、
  `test/download-manager.test.ts`（`DEFAULT_DOWNLOAD_SUBDIR`）→ 全部**改写为新值**；
- ⚠️ **不动**：`test/favorite-writeback.test.ts` 的「连接飞牛音乐」（登录页标题）；
  窄窗口 E2E 的品牌宽度断言是**下限**（`≥55px`）→ 拉丁文更宽，**仍然成立**。

### 影响文件

- **改**：`shared/appInfo.ts`、`shared/constants.ts`、`src/App.tsx`、`src/pages/LoginPage.tsx`、
  `src/components/SettingsPanel.tsx`、`src/styles/app-shell.css`（注释）、
  `index.html`、`lyric.html`、`island.html`、`electron/tray.ts`、`electron/oauthWindow.ts`、
  `electron/downloadManager.ts`、`electron/main.ts`（注释）、`electron-builder.yml`、`package.json`；
- **改测试**：`test/app-info.test.ts`、`test/tray-tooltip.test.ts`、`test/oauth-window.test.ts`、
  `test/download-manager.test.ts`、`e2e/smoke.spec.ts`（套件名）、`e2e/narrow-window.spec.ts`（套件名）、
  `e2e/helpers/app.ts`（注释）；
- **文档**：`README.md`、`docs/changelog.md`、`docs/calibration.md`、`docs/packaging.md`、
  `docs/build-verification.md`（产物名同步 + 注明「历史实测数据不变」）、设计规格（新）。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1790 passed / 82 files**；`playwright test` **24 passed**；
  `npm run build` exit 0；
- ⚠️ **漏改的一条被测试逮住**：`test/oauth-window.test.ts` 里**另一处** URL 编码断言
  （`arg.url` 里的 `app_name=%E9%A3%9E…`）—— 第一次跑 vitest **红了 1 条** → 补改后转绿
  ⇒ 这条改名**确实被既有测试覆盖着**，不是「改完就没人管」。

### 已知限制（如实标注）

- ⚠️ **打包产物名变了**（`Sanlos music.exe`）→ **旧安装包与新产物同名冲突**时，
  electron-builder 的覆盖安装行为需要真机验一次（**尚未验**）；
- ⚠️ **用户数据目录名没变**（仍是 `fnmusic-desktop`）→ 老用户的登录态与偏好**继续有效**
  （这是有意为之，见上文理由）；
- ⚠️ **托盘 tooltip** 真机没法直接读（Electron 的 `Tray` 不暴露实例）→ 由单测覆盖。

### 遗留 / 待办

- ⚠️ **待用户复验**：改名后的观感（顶栏拉丁文品牌名的排版、开始菜单 / 任务栏显示）；
- ⚠️ **待真机验**：覆盖安装（装完 `Sanlos music.exe` 后再装一次）；
- ⚠️ 仍待复验：T46（点击穿透 / 淡出淡回）、T47（挂 analyser 后听感）、T48（卡拉OK 观感）。
## 三十五、T50：品牌名「Sanlos Music」的两套主题适配

### 起因（用户原话）

> 「你两个UI都要适配过吧，不然不好看」

用户在 T49 的两套主题截图后发现：品牌名换成拉丁文之后，**两套主题下的排版完全一样**，
而「飞牛音乐」四个字在两套主题里本来就是不同的观感 → 改名后这套「按主题各调各的」断了。

### 实测：问题到底在哪（不是猜的）

用隔离实例量了两套主题下的品牌名计算样式（`release/verify/t50-brand-metrics.mjs`）：

| 指标 | Apple 风 | Fluent 风 | 结论 |
| --- | --- | --- | --- |
| `font-size` | 15px | 15px | **一模一样** |
| `font-weight` | 600 | 600 | **一模一样** |
| `font-family` | `Noto Sans SC` | `Noto Sans SC` | **一模一样** |
| 实际宽 × 高 | 96.6 × 21 px | 96.6 × 21 px | **一模一样** |

三个具体问题：

1. **宽度暴涨 61%**：4 个汉字（60px）→ 12 个拉丁字符（96.6px）；
2. **拉丁字母被中文字体接管**：实测本机系统默认 sans-serif 就是 `Noto Sans SC`
   （中文字体的拉丁字腔偏宽、600 字重下 12 个字母连读偏重）→ 观感发糊；
3. **两套主题共用一套值**：Apple 风的圆润柔和 vs Fluent 风的方正克制完全体现不出来
   （用户看到的两张截图差异只是表面色）。

⚠️ **但布局没有坏**：宽/窄窗口下顶栏都是 `scrollWidth == clientWidth` → **没有溢出**。
所以这轮修的是**观感层级**，不是布局返工。

### 决策

**用户拍板**（ask_user）：

| 决策 | 选择 |
| --- | --- |
| 大小写 | **「Sanlos Music」**（首字母大写）—— T49 定的「Sanlos music」偏弱 |
| 形态 | **纯文字**（不加图标 / 渐变），**两套主题各调各的排版** |

**令牌化**：新增 4 个品牌令牌（`src/styles/tokens.css`），排版值从组件挪到主题层：

| 令牌 | Apple 风（`:root`） | Fluent 风（`[data-theme='fluent']`） |
| --- | --- | --- |
| `--brand-font-family` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif` | `'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei', 'Noto Sans SC', sans-serif` |
| `--brand-font-size` | `16px` | `15px` |
| `--brand-font-weight` | `600` | `500` |
| `--brand-letter-spacing` | `-0.3px` | `0px` |

- **Apple 风 → 圆润柔和**：系统 UI 字体优先；字号略大（16px）、字重 600、负字距（拉丁文收紧）；
- **Fluent 风 → 方正克制**：**优先 `Segoe UI Variable Text`**（Win11 的新 UI 字体，
  才是 Fluent 语言的正脸；Win10 回退 `Segoe UI`）；字号 15px、字重 500、字距归零。

⚠️ **字体栈顺序是硬要求**：**拉丁字体在前、中文字体在后** ——
否则 `Noto Sans SC` 会接管拉丁字母，回到「字腔宽 + 600 偏重」的老问题。

⚠️ **组件只消费令牌**：`.app-shell__brand` 不再写死任何字号 / 字重 / 字距
→ 换主题只改令牌，组件零分支。
⚠️ **T40 的护栏一个字不动**（`flex: 0 0 auto` + `white-space: nowrap`）——
本轮只改**排版**，**不改布局**。

### 品牌文案统一为「Sanlos Music」

`src/App.tsx`、`shared/appInfo.ts`、`shared/constants.ts`（OAuth `app_name`）、
`electron/tray.ts`、`electron/oauthWindow.ts`、三个 HTML `<title>`、
`electron-builder.yml`（`productName`）、`package.json`、`src/pages/LoginPage.tsx`。

⚠️ **刻意保持「Sanlos music」（小写 m）的地方**：`electron/downloadManager.ts` 的
`DEFAULT_DOWNLOAD_SUBDIR`、设置页的下载目录 placeholder、以及相关注释 ——
**那是路径，不是品牌文案**（避免「界面叫 A、路径叫 B」的困惑）。老目录不删。

### 影响文件

- **改**：`src/styles/tokens.css`、`src/styles/app-shell.css`、`src/App.tsx`、
  `shared/appInfo.ts`、`shared/constants.ts`、`electron/tray.ts`、`electron/oauthWindow.ts`、
  `electron/downloadManager.ts`（注释）、`index.html`、`lyric.html`、`island.html`、
  `electron-builder.yml`、`package.json`、`src/pages/LoginPage.tsx`；
- **改测试**：`test/app-info.test.ts`、`test/tray-tooltip.test.ts`、`test/oauth-window.test.ts`（3 处）、
  `test/app-shell-css.test.ts`（**新增 4 条品牌排版契约**）、
  `e2e/smoke.spec.ts`（套件名）、`e2e/narrow-window.spec.ts`（套件名）；
- **文档**：`README.md`、`docs/changelog.md`、`docs/calibration.md`、`docs/packaging.md`、
  `docs/build-verification.md`、设计规格（新）。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1794 passed / 82 files**（基线 1790，+4）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **真机**（隔离实例，Playwright 驱动 Electron，截图见 `release/verify/t50-brand-*.png`）：

| 场景 | Apple 风 | Fluent 风 |
| --- | --- | --- |
| `font-size` / `font-weight` / `letter-spacing` | **16px / 600 / -0.3px** | **15px / 500 / normal** |
| `font-family` | 以 `-apple-system` / `Segoe UI` 起头 | 以 `Segoe UI Variable Text` 起头 |
| 品牌名宽 × 高 | **90.6 × 21 px** | **88.3 × 21 px** |
| 宽窗顶栏 `scrollWidth` vs `clientWidth` | 1184 == 1184（**不溢出**） | 1184 == 1184 |
| 窄窗（784）顶栏 `scrollWidth` vs `clientWidth` | 784 == 784（**不溢出**） | 784 == 784 |

  对比改名前：**96.6px → 90.6 / 88.3 px**，两套主题**终于各有一套值**。

### 已知限制（如实标注）

- ⚠️ **Electron 默认图标未处理**：标题栏左上角还是 Electron 的默认小圆球
  （仓库里没有 `build/icon.ico`）→ 两套主题都如此，本轮**不在范围内**；
- ⚠️ **Apple 风的字体栈在 Windows 上落到 `Segoe UI`**：
  `-apple-system` / `BlinkMacSystemFont` 是 macOS 的别名，Windows 上不存在 →
  实际渲染是 `Segoe UI`。这是**正常且预期**的（跨平台字体栈），
  但意味着「Apple 风」在 Windows 上的品牌名观感 ≈ `Segoe UI` + 600 + `-0.3px`；
- ⚠️ **未重新打包**：`Sanlos Music.exe` 的产物名变更**未真机验过**，
  与 T49 的覆盖安装风险叠加。

### 遗留 / 待办

- ⚠️ **待用户复验**：两套主题下品牌名的**肉眼观感**（本轮只做了像素级量测与截图，
  没有做主观审美判断）；
- ⚠️ **待真机验**：装完 `Sanlos Music.exe` 后的**覆盖安装**行为
  （旧的 `飞牛音乐.exe` / `Sanlos music.exe` 可能并存）；
- ⚠️ **待用户拍板**：Electron 默认图标要不要换成品牌图标（需 `build/icon.ico`）；
- ⚠️ 仍待复验：T46（点击穿透 / 淡出淡回）、T47（挂 analyser 后听感）、T48（卡拉OK 观感）。
## 三十六、T51：两套主题的形状适配（圆角令牌化 + 中继提示挪位）

### 起因（用户原话）

> 「软件UI不对啊」

用户在 T50 之后打开软件，发现**界面整体不对劲**。本轮**先用真实实例量、后改**。

### 实测诊断（全部在**真实 userData 的实例**上量出来的）

| # | 问题 | 实测证据 |
| --- | --- | --- |
| **①** | **中继带宽提示把顶栏撑成两行** | `fnm-badge` 被提示撑到 **320px 宽** → 顶栏第一行放不下 → 徽标整块换行 → 顶栏高度 **58px → 141px**，提示文字还自己折成两行 |
| **②** | **行内「收藏 / 下载」按钮两套主题一模一样** | `.fnm-favorite` / `.fnm-download` 的 `border-radius` 实测：apple **6px** / fluent **6px**（写死的，跟主题无关） |
| **③** | **另有 5 处胶囊压根不跟主题走** | `border-radius: 999px` 硬编码在连接徽标、播放条主按钮、详情页返回、全屏页标签页 / 主按钮 → Windows 11 风下**依然是胶囊** |
| **④** | **词岛在 Windows 11 风下变成方块** | `.fnm-island` 写的是 `var(--radius-pill, 999px)`，而 `--radius-pill` 被主题化成 4px → **屏幕顶部一个白色大矩形**，完全没有「岛」的形状 |

⚠️ **①③ 与 T50 无关**（公网中继模式暴露出来的既有毛病），**④ 同理**（词岛自己加载
`tokens.css` 并跟随主题）。T50 只改了品牌名的字号 / 字重 / 字体栈。

⚠️ **但布局本身没坏**：宽 / 窄窗口下顶栏都是 `scrollWidth == clientWidth` → **没有溢出**。
这轮修的是**形状与观感**，不是布局返工。

### 决策（用户拍板）

- 中继提示 → **挪到页面内容区**：一行 12px **灰字**，顶栏恢复 58px 单行；
- 本轮范围 → **圆角统一 + 中继提示，一起修**（两套主题各自成套）。

### 做法

**① 中继提示挪出顶栏**

- **新增** `src/components/RelayHint.tsx`：链路是 `relay` 才渲染；文案仍是
  「主进程给的 `bandwidthHint` 优先，没有才用兜底文案」（追加要求 H）；
- `ConnectionBadge.tsx`：**只留触发器**（~69px），不再渲染提示；
- `App.tsx`：`<RelayHint />` 渲染在 `.app-shell__main` 顶部
  （`flex: 0 0 auto` + `nowrap` + `ellipsis` → **只占一行**）；
- 样式 `.fnm-relayhint`：12px、`--text-secondary`（灰）、不占顶栏。

**② 圆角全量令牌化（60 处）**

| 令牌 | Apple 风 | Fluent 风 | 用途 |
| --- | --- | --- | --- |
| `--radius-pill`（已有） | 999px | 4px | 胶囊 |
| `--radius-panel`（已有） | 10px | 6px | 面板 |
| `--radius-card`（已有） | 10px | 4px | 卡片 |
| `--radius-control`（**新增**） | 6px | 4px | 行内小按钮 |
| `--radius-field`（**新增**） | 8px | 4px | 输入框、提示条 |
| `--radius-sharp`（**新增**） | 4px | 2px | 极小方形图标控件 |

- ⚠️ **Apple 风的数值 = 原来的硬编码值** → Apple 侧**像素级不变**
  （唯一例外：登录页卡片 `12px → 10px`，2px 差，肉眼不可见）；
- ⚠️ **`--radius-island`**（新增）：词岛胶囊固定 **999px**，**两套主题同值**
  （它不是主题控件）；⚠️ 之所以在 Fluent 组里**也写一遍**，是因为项目既有约定
  「两套主题的语义变量集合必须完全相同」（`test/theme.test.tsx` 钉着，不多不少）。

**③ 防回潮的契约测试**（新增 `test/theme-radius-css.test.tsx`，8 条）

- `src/**/*.css` 里**不再有硬编码圆角**（剥注释后扫，只允许 `var(--radius-*)`）；
- 圆角令牌两套主题都齐全 / **两套主题的圆角真的不同**；
- **词岛胶囊两套主题都是 999px**（不许在 Fluent 组里写成 4px）；
- 徽标里不再有带宽提示 / 提示是主区顶部一条独立提示；
- **只有中继链路**才显示 / 主进程给了 `bandwidthHint` 就用它。

### 既有断言的处理（**改写，不放宽**）

- `test/login-page.test.tsx` 的 4 条 ConnectionBadge 用例**前提被本轮改动推翻**
  （提示换了归属组件）→ **改写为新行为断言**：改为**同时渲染徽标与提示组件**
  （= 真实界面的组合），**链路仍由 `bridge.connectionInfo()` 驱动**
  → 断言链**没有变弱**；
- ⚠️ `test/theme.test.tsx`「两套主题都定义了同一组语义变量（不多不少）」
  → **没有改**：让 `--radius-island` 在 Fluent 组里也定义（同值）来满足它。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1802 passed / 83 files**（基线 1794 / 82，**新增 8**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **真机**（隔离实例 + **真实 userData**）：

| 指标 | 改前 | 改后（Apple 风） | 改后（Fluent 风） |
| --- | --- | --- | --- |
| 顶栏高度（中继模式） | **141px**（两行） | **58px**（单行） | **58px**（单行） |
| 顶栏 `scrollWidth` vs `clientWidth` | 1168 == 1168 | 1168 == 1168 | 1168 == 1168 |
| `.fnm-favorite` / `.fnm-download` 圆角 | 6px / 6px | **6px / 6px**（不变） | **4px / 4px** |
| `.fnm-app__nav-button` 圆角 | 999px / 4px | 999px | 4px |
| `.fnm-badge__trigger` 圆角 | 999px | 999px | **4px** |
| 中继提示 | 顶栏内 320px 橙字 | **主区顶部一行 12px 灰字** | 同左 |
| 词岛 `.fnm-island` 圆角（fluent） | **4px（方块！）** | — | **999px（胶囊）** |
| 词岛 `.fnm-island` 圆角（apple） | 999px | 999px | — |

### 已知限制（如实标注）

- ⚠️ **登录页卡片**在 Apple 侧 `12px → 10px`（归 `--radius-card`）—— 2px 差，肉眼不可见；
- ⚠️ **词岛胶囊仍然偏宽**（~400px × 75px）—— 那是**词岛窗口的固定尺寸**，
  **本轮没有动**，要不要收窄待用户拍板；
- ⚠️ **Electron 默认图标**仍未处理（仓库无 `build/icon.ico`）；
- ⚠️ **未重新打包** → `Sanlos Music.exe` 的**覆盖安装**仍未真机验。

### 遗留 / 待办

- ⚠️ **待用户肉眼复验**：两套主题下界面观感；
- ⚠️ **待用户拍板**：词岛胶囊要不要收窄；
- ⚠️ **待真机验**：覆盖安装；
- ⚠️ 仍待复验：T46、T47、T48。
## 三十七、T52：连接徽标的候选面板改为浮层

### 起因（用户原话）

> 「一点中继按键，UI又不对称了」

### 实测根因（真实 userData 的实例，点开徽标后量布局）

| 指标 | 点开前 | 点开后（改前） |
| --- | --- | --- |
| 顶栏高度 | **58px** | **175px**（撑成三行） |
| `.fnm-badge` 宽度 / 位置 | 69px，右上角（1079..1148, top 12） | **306px**，**掉到第二行**（20..326, top 57） |
| `.fnm-badge__panel` 的 `position` | — | **`static`**（普通流内的块级元素） |
| 顶栏 `scrollWidth` vs `clientWidth` | 1168 == 1168 | 1168 == 1168（没溢出，但布局乱了） |

**根因**：`.fnm-badge` 是**纵向 flex**，而候选面板 `.fnm-badge__panel` **没有 `position: absolute`**
→ 它成了徽标的**第二个流内子元素**，把徽标从 69px 撑到 **306px 宽**
→ 顶栏第一行放不下 → 徽标**整块换行到第二行**，面板横在左侧盖住主区内容。

⇒ 这是一个**与主题无关、与 T51 无关的既有缺陷**：面板本来就该是浮层。

### 做法（`src/components/connection-badge.css`）

| 声明 | 改前 | 改后 | 作用 |
| --- | --- | --- | --- |
| `position` | （无） | **`absolute`** | 不再占布局 → 顶栏恒为 58px 单行 |
| `top` | （无） | `calc(100% + 8px)` | 浮在徽标**正下方** |
| `right` | （无） | `0` | **右对齐**（徽标在顶栏最右 → 面板不会出窗口） |
| `z-index` | （无） | `30` | 盖住下方主区内容 |
| `min-width` | `280px` | `width: 280px` + `box-sizing: border-box` | 280px **含** padding 与边框（原来实际 306px） |

⚠️ `.fnm-badge` 本来就是 `position: relative` → 是面板的定位参照系，**不用改**。

### 防回潮的契约测试

`test/app-shell-css.test.ts` 新增 `describe('连接徽标的候选面板是浮层（T52）')`，4 条：

1. 面板**绝对定位**（`position: absolute` + `top: calc(100% + Npx)` + `right: 0`）；
2. 面板**显式 z-index**（要盖住主区内容）；
3. 徽标本体是**定位参照系**（`position: relative`）；
4. 面板宽度**含 padding**（`box-sizing: border-box`）。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1806 passed / 83 files**（基线 1802 / 83，**新增 4**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **真机**（真实 userData，点开徽标后量）：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 顶栏高度（点开面板后） | **175px** | **58px**（不变） |
| `.fnm-badge` 位置 | 第二行（top 57） | **第一行原位**（1079..1148, top 12） |
| `.fnm-badge__panel` 的 `position` | `static` | **`absolute`**，`z-index: 30` |
| 面板矩形 | 20..326（顶栏左侧） | **868..1148**（徽标正下方、右对齐） |
| 面板宽度 | 306px | **280px**（含 padding） |

- **真实鼠标点击 + 屏幕截图**复核：顶栏单行不变，面板浮在「中继」正下方。

### 已知限制（如实标注）

- ⚠️ **点面板外面不会关闭**（既有行为：只有徽标按钮能收起）—— 本轮**没改**；
- ⚠️ 面板展开时**没有**「重新探测链路」按钮（既有行为）—— 本轮**没改**。

### 遗留 / 待办

- ⚠️ **待用户复验**：点开「中继」时顶栏是否还稳（这轮已实测 58px 不变）；
- ⚠️ 仍待复验：T46、T47、T48；T49/T50 的覆盖安装；
- ⚠️ **待用户拍板**：词岛胶囊要不要收窄；Electron 默认图标要不要换。
## 三十八、T53：词岛的长歌词不再被裁掉

### 起因（用户原话）

> 「现在就是灵动歌词还有个BUG，长歌词显示不完整，他会变两行也看不到」

### 实测根因（真实 userData 的词岛窗口，灌长短两句后量布局）

| 量 | 短句（4 字） | 长句（22 字） |
| --- | --- | --- |
| 当前行 `.fnm-lyricview__line--active` 盒高 | 44px | **44px（定高，不会长）** |
| 同上 `scrollHeight`（真实内容高） | 44px | **88px** |
| 实际视觉行数 | 1 | **2** |
| 歌词可视区 `.fnm-island__lyrics` | 316 × **74px**，`overflow: hidden` | 同左 |

**三处叠加，缺一不可**：

1. `.fnm-lyricview__line--active` 是**定高 44px**（`height: 44px; line-height: 44px`），
   而 `white-space: pre-wrap` 允许换行 → 长句折 2 行 = 88px 内容**溢出定高盒**；
2. 词岛的 `.fnm-lyricview` 是 `overflow: hidden` → 溢出部分**被裁掉**；
3. 单行模式的滚动定位按 **44px 行盒**居中 → 越往歌后面裁得越狠
   （第 0 行只切 6px；越靠后第二行大约 3/4 看不见）。

**折行阈值**：歌词内容宽 292px，汉字实测 20px → **一行最多 14 个汉字**，超过 14 字就中招。

### 影响面（很小）

`mode="single"` 在生产代码里**只有词岛在用**（经典悬浮窗 = `double`、全屏歌词舞台 = `all`）
→ 修 single 模式**只影响词岛**，主界面 / 经典悬浮窗 / 全屏歌词**一字不变**。

### 用户拍板（三个方案）

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A | 胶囊加高到 132px + 当前行可长高 | 胶囊**永远**高 36px，短句时显得空 |
| **B（选中）** | **行高压到 32px + 当前行可长高，胶囊高度不变** | 当前行观感略紧凑 |
| C | 只在真折行时才降行高 | 换句时行高会跳一下，实现最复杂 |

### 做法（`src/island/island-window.css`，**只改词岛作用域**）

| 选择器 | 声明 | 作用 |
| --- | --- | --- |
| `.fnm-island__lyrics .fnm-lyricview` | `display: flex` + `align-items: center` | 视口自己**居中**当前行 → 不再靠 `LyricView` 的滚动定位 |
| `.fnm-island__lyrics .fnm-lyricview__canvas` | `height: auto` + `max-height: 100%` + `overflow: hidden` | 画布不再撑到「整份歌词的总高」 |
| `.fnm-island__lyrics .fnm-lyricview--single .fnm-lyricview__line` | `position: static` | 当前行不再被 `top` 顶到画布外 |
| `.fnm-island__lyrics .fnm-lyricview--single .fnm-lyricview__line--active` | `height: auto` + `line-height: 32px` | 当前行**可长高**；折 2 行 = **64px ≤ 74px** |

⚠️ **胶囊高度不变**（`ISLAND_WINDOW_HEIGHT` 仍是 96），**窗口宽度不变**（520）。
⚠️ **主进程与 `LyricView.tsx` 一行没改** → 共享组件零回归。

### 防回潮的契约测试

`test/lyric-island-css.test.ts` 新增 `describe('词岛的 CSS 契约（T53：长歌词折行不被裁）')`，**6 条**：

1. 当前行**可以长高**（`height: auto`，不再是定高 44px）；
2. 当前行**行高 32px**；
3. 歌词视口改成 **flex 居中**；
4. 画布高度 **auto** + `max-height: 100%` + 溢出被裁；
5. 当前行**不再绝对定位**；
6. **跨文件不等式**：窗口高 − 上下留白 − 边框 ≥ 2 × 行高
   （用 `shared/islandAnchor.ts` 的 `ISLAND_WINDOW_HEIGHT`，不是写死的 96）。

### 验证

- `tsc --noEmit` exit **0**；`vitest run` **1812 passed / 83 files**（基线 1806 / 83，**新增 6**）；
  `playwright test` **24 passed**；`npm run build` exit 0；
- **真机**（真实 userData，灌长短两句后量）：

| 指标 | 改前（长句） | 改后（长句） |
| --- | --- | --- |
| 当前行盒高 / `scrollHeight` | 44px / **88px**（溢出） | **64px / 64px**（不溢出） |
| 视觉行数 | 2 | 2 |
| 文字实际占位 | 18..**91**（**超出可视区下沿 85**） | **17..78**（**完整在 11..85 内**） |
| 画布 | — | 64px，top 16 / bottom 80（74px 带里居中） |
| 卡拉OK 填色层高度 | — | **64px**（**盖住两行**） |
| 短句观感 | 当前行 44px 高 | 当前行 32px 高，仍居中 |

- **真屏截图**（`desktopCapturer` 抓真屏，520×96）：
  `release/verify/t53-island-long.png`、`t53-island-short.png`。

### 已知限制（如实标注）

- ⚠️ **超过 3 行（>28 字）的极端长句仍会裁掉多出来的部分**
  （画布 `max-height: 100%` → 保住**上面**的行，底下多出来的看不见）；
- ⚠️ **单行歌词的当前行从 44px 行高变成 32px** —— 观感略紧凑（用户已知悉并选定）；
- ⚠️ **词岛窗口宽度 520px 没动** → 一行仍只放得下 14～15 个汉字。

### 遗留 / 待办

- ⚠️ **待用户复验**：真实歌曲下的长句观感（是否还会觉得行高偏紧）；
- ⚠️ 仍待复验：T46、T47、T48；T49/T50 的覆盖安装；
- ⚠️ **待用户拍板**：词岛胶囊要不要收窄（当前 520×96）；Electron 默认图标要不要换。
## 三十九、T54：音质偏好（原始音质 / 标准音质）

> ⚠️ **T55 更正本节的两个结论**（2026-11-05 重新实测，详见「四十、T55」）：
>
> 1. **「本机 NAS 的转码引擎不可用」= 误判**。服务端转码**一直是好的**：
>    抽样 **14 首 14/14 成功**、平均就绪 **988 ms**（最慢 2 646 ms）、
>    产物 = **MP3 320k**（比原始 FLAC **省 88.8 % 流量**）。
>    T54 当时判失败的**真凶是客户端的就绪判定**：`percent>=100` → **单次**产物预检 →
>    预检不过就**立刻**判死；而 `percent>=100` 与「产物真能读」之间**有窗口期**
>    （服务端在产物未就绪时回的是业务错误信封 `{"code":100002}`，**不是**挂死）。
> 2. **「文件端点挂死、45 秒拿不到响应头」= 误读**。原样重跑同一探针：
>    全部请求 **88 ~ 203 ms** 返回、**零挂起**；未就绪时回的是
>    HTTP 200 + `{"code":100002,"msg":"invalid arguments"}` —— 是「**还没好**」。
> 3. 「少数曲目服务端真的失败」**这一条成立**（《占位曲目二》《占位曲目三》6/6，
>    `errno=68157441`，崩在转码进度 79 %~93 %）—— 但那是 **NAS 侧**的缺陷。

### 起因（用户原话）

> 加入音质偏好设置，原始音质和标准音质，标准音质好是192K飞牛音乐服务器支持的好像是这个

### 挖入口（9 轮探针，逐条实测真实 NAS + 用户公网反代）

用户拍板走「**服务端转码**」（只有服务端转码能在公网链路真正省带宽）。
于是把服务端能力**逐条打穿**，结论如下（**每一条都是实测**，不是推断）：

| 端点 | 实测结果 |
| --- | --- |
| `GET /music/api/v1/track/stream?guid=…`（+ 13 种音质参数） | ✅ 正常，但**不认任何音质参数** —— 响应**字节级完全相同**（恒为原始 FLAC：`audio/flac` + 魔数 `66 4c 61 43`） |
| `POST /music/api/v1/track/transcode`（**播放侧**） | ❌ **16 种**请求体形状（`{guid}` / `{trackGUID,quality}` / `{codec,bitrate}` / `{id}` / GET 变体 …）→ **全部** `code=100001 unknown error` |
| `GET /music/api/v1/track/hls/{guid}/preset.m3u8` | ⚠️ **路由存在**：对照组（3 / 4 / 5 段乱路径）一律回 `null`，它回 `100005 resource not found`；文件名只认 `preset.m3u8` / `init.mp4` / `*.m4s`（别的 → `100002 invalid arguments`）。**会话靠上面那个 POST 建** → POST 挂了就没有会话 |
| `POST /music/api/v1/download/track/transcode/prepare` `{trackGUID, quality}` | ✅ `code=0` → `data{status:'success', errno:'', errmsg:'', downloadId}` |
| `GET /music/api/v1/download/track/transcode/status?downloadId=` | ✅ 有**真实进度** `percent`；⚠️ **`status` 词不可信**（第一次查询就报 `ready`，随后又变回 `transcoding / percent=N`）→ **只信 percent** |
| `GET /music/api/v1/download/track/transcode/file?downloadId=` | ⚠️ 任务未完成 → 秒回 `100002`；任务标称 `ready` 时 → **45 秒连响应头都没有**（挂死） |
| `POST /music/api/v1/download/track/transcode/delete` `{downloadId}` | ✅ `data{downloadId, deleted:true}` |
| `GET /api/stream/hires?fileId=&quality=`（官方网页版 HiRes） | ❌ 在**根路径**（不在 `/music/` 下）→ 用户的反代只转发 `/music/*` → 落到 fnOS 的 SPA 兜底页 |
| `GET /music/api/v1/sys/config` | ✅ `capabilities={folderView:false, libraryReconnect:true}` —— **没有任何转码能力标志** |

⇒ **真正可用的服务端转码入口是「下载侧」那套协议**
（`download/track/transcode/{prepare,status,file,delete}`），**不是**官方 App 播放侧那套。

### 档位语义（实测服务端只认两个值）

| `quality` | 服务端反应 |
| --- | --- |
| `standard` | ✅ 接受 |
| `original` | ✅ 接受 |
| `higher` / `exhigh` | ❌ `code=100002 invalid arguments` |

- ⚠️ 官方旧下载协议里 `standard` = **MP3 320k**（此条来自「按真实抓包对齐」的第三方实现，
  **非我们实测的码率**—— 产物在本机根本取不出来）；
- ⚠️ **服务端没有 192k 那一档**（用户原话里的「192K」在服务端**不存在**）。

### 结论：本机 NAS 的**转码引擎不可用**

3 首 FLAC 实测：

| 曲目（占位） | 状态流转 | 取产物 |
| --- | --- | --- |
| 《占位曲目一》（96kHz / 24bit） | `ready / 100%` | **45 秒无响应头**（挂死） |
| 《占位曲目二》 | `transcoding 0% → 64%` → **`failed`** | `100005`（任务已被回收） |
| 《占位曲目三》 | `transcoding 0% → 85%` → **`failed`** | `100005` |

失败时服务端给的是 `errno=68157441` / `errmsg='transcoding error'`（**恒定不变**，
像「转码器不可用」而不是「这首曲子不行」）。

⇒ **服务端转码这条路在当前 NAS 上走不通**：协议入口找对了，**引擎是坏的**。
⇒ 但**客户端侧仍然把整条链路接上**（用户拍板「铺路」）：
NAS 一升级 / 开启转码组件就**自动生效**，客户端**不用再改**；
在此之前，标准音质**自动回退原始音质**并如实说明原因。

### 客户端实现（T54）

| 接缝 | 做法 |
| --- | --- |
| 偏好 | `AppPrefs.streamQuality?: 'original' \| 'standard'`（**非敏感**，落 `prefs.json`；主进程白名单**只认这两个值**，陌生值整段丢弃） |
| 代理 | `download/track/transcode/file` 加进 `DEFAULT_BINARY_PATHS` —— **必须走二进制透传**：JSON 路径会把字节丢掉（`JSON.parse` 失败 → `null`）、还有 30 秒超时且**不透传 `Range`**（拖进度条就没了） |
| 播放 | 引擎新增 `prepareStandardSource` / `streamQuality` 两个接缝；标准音质 → `prepare → 轮询 percent → 产物预检` → 用产物地址起播 |
| 预检 | 起播前先 Range 取首字节 —— 不预检就会界面一直停在「缓冲中…」；⚠️ **T55 更正**：T54 写的「标称 ready 但文件端点挂死」是**误读**（实测 88~203 ms 就返回业务错误信封），且**单次**预检会把「产物还没好」误判成「服务端转码不可用」→ T55 改为**预检失败重试** |
| 回退 | 任何失败 → **自动改用原始音质**（音乐照常播，不黑屏），播放条给一条**灰字**说明（`role="status"`，**不是**错误） |
| 不转码的曲子 | 本地曲目 / 本地有副本且「本地优先」开着 → **不转码**（已经在本地了，转码只是白费 NAS 的 CPU） |

### 验证

- `tsc --noEmit` 0 错；
- 单元测试 **1847 条 / 85 个文件**全绿（新增 `test/stream-quality.test.ts` 23 条 + `test/stream-quality-ui.test.tsx` 12 条）；
- Playwright E2E **24 条**全绿（真实 Electron + 内嵌 mock NAS）；
- 打包通过；
- **真机**（真实 NAS + 真实 userData，把偏好临时改成 `streamQuality:'standard'`）：
  媒体元素的 `src` **只被写了一次**，且就是 `fnm://srv/track/stream?guid=…`
  —— **转码产物地址从未被交给播放器**；播放条出现
  「标准音质不可用：服务端转码产物无法读取，已改用原始音质播放」（`role="status"`，**灰字**）；
  进度从 **0:11 走到 0:19** → **音乐照常播**。
  ⚠️ 测完已把 `prefs.json` **逐字节还原**。

### 已知限制（如实标注）

- ⚠️ **T55 更正：当前这台 NAS 上标准音质**不是**必然回退** —— 抽样 14 首 **14/14 成功**；
  只有个别曲目（`errno=68157441`）会回退（那是 NAS 侧的引擎缺陷）；
- ⚠️ 「标准音质」在服务端就是 **320k**，**没有 192k**；
- ⚠️ 服务端转码要在 NAS 上**占 CPU**，切歌时会有几秒等待（界面显示「正在准备标准音质…」）。

### 遗留 / 待办

- ⚠️ **待用户侧确认**：NAS 的 fnOS 版本（实测 `serverVersion=1.0.10` / `mediasrvVersion=0.8.43`）
  与应用中心里是否有「媒体转码」类组件需要启用；
- ⚠️ **待用户侧确认**：内网直连（`192.168.1.2:5666`）时官方 App 选「标准音质」能否正常播放
  （本机不在内网，连不上）；
- ⚠️ **待用户侧确认**：fnOS 的 nginx 访问日志里 `track/transcode` 那条请求的状态码。

---

## 四十、T55：标准音质的就绪判定（让服务端转码真能用起来）

### 起因

T54 交付后的真机结论是「服务端转码不可用 → 标准音质必然回退原始音质」。
用户反馈：**「用官方 APP，中继都可以选音质」** —— 与该结论冲突。
于是开了 T55-0 探针组（**未改任何产品代码**）把结论全部重新实测。

### 实测总表（真实 NAS / 真实账号；凭证只在探针进程内存里，不落盘）

| 链路 | prepare | status | 产物（Range） | 产物（全量 7 005 165 B） |
|---|---|---|---|---|
| 中继 `<FN-ID>.fnos.net` | ✅ | ready / 100 % | 206 ✅ | 200，**12 930 ms** |
| **用户反代 `user-proxy.invalid`** | ✅ | 0 %→98 %→ready | 206 ✅ | 200，**1 154 ms** ✅ |
| NAS 内网 `192.168.100.xxx:5666` | — | — | 本机不在该内网（超时） | — |
| NAS 公网 `<公网 IP>:5666` | — | — | 超时 | — |

⚠️ **用户的自建反代即可用，且比官方中继快 11 倍** → **不需要改反代、不需要走中继**。

### 「官方 HiRes」端点在本机不存在

官方网页版 bundle 里那套 `GET {origin}/api/stream/hires?fileId=&quality=`（**根路径**，播放走 HLS）：

- 中继：**404 + SPA 兜底页**（`auto`/`high`/`standard`/`lossless`/`hires`/`medium`/`320k` 七种 quality 全 404）；
- 反代：**404 + SPA 兜底页**（同样）。

⇒ 本机 fnOS **1.0.10 / mediasrv 0.8.43 没实现这个端点**
（官方网页版带的那套 HiRes 代码在此机上是空转）
⇒ **不需要根路径通道、不需要自研 fMP4 HLS 客户端（MSE）**。

### 抽样 14 首：14/14 成功

| 曲目 | 格式 | 就绪 |
|---|---|---|
| 占位曲目一 | flac 96000/24 | 2 570 ms |
| 占位曲目七 | flac 44100/16 | 2 646 ms |
| 占位曲目六 / 占位曲目八 / 占位曲目九 / 占位曲目十 / 占位曲目十一 / 占位曲目十二 / 曲目 1·2·7·8·9·15 | mp3 44100/32 | 130 ~ 812 ms |

**汇总**：14 成功 / 0 失败 / 0 超时；**平均就绪 988 ms，最慢 2 646 ms**。
产物 = **MP3 320k**（7 005 165 B / 175 s）⇒ 对比原始 FLAC 62 228 801 B，**省 88.8 % 流量**。

### 两首确定性失败（客户端救不了）

| 曲目 | 现象 |
|---|---|
| 占位曲目二 (变体一) | 转码到 **93 %** 才 `failed`，`errno=68157441 / errmsg='transcoding error'`（6/6） |
| 占位曲目三 (变体二) | 转码到 **79 %** 才 `failed`（6/6） |

⇒ **NAS 侧**的引擎缺陷 ⇒ 客户端**如实上报**并回退原始音质。

### 根因：T54 的「就绪判定」错了

三处独立证据：

1. **原样重跑 T54 当时的探针**：全部请求 **88 ~ 203 ms** 返回，**零挂起**；
2. 产物未就绪时文件端点回的是 `{"code":100002,"msg":"invalid arguments"}`（HTTP 200 + JSON）
   —— 是「**还没好**」，不是「没响应头」；
3. **Range 形态矩阵**全部 206 正常：`bytes=0-1` / `0-0` / `0-1023` / `100-200` / `-1024`（尾部）；
   不带 Range → 200 全量 7 005 165 B / 1 271 ms。

⇒ T54 的判定链：`percent >= 100` → **单次**预检 → 不过 → **立刻**判 `unavailable` → 回退。
⇒ **`percent >= 100` 与「产物真能读」之间有窗口期** → 单次预检一命中就误判。

### 做法（`src/player/transcode.ts`）

- **预检失败不判死**：与轮询交替重试，直到读通或超出总时限；
- **percent ≥ 100 只代表「可以试产物」**（**只信 percent**，status 词不作触发条件）；
- **轮询间隔 1500 → 500 ms**（实测平均就绪 988 ms ⇒ 少等一轮就少等 0.5 s）；
- 新增 `probeTimeoutMs` / `probeRetryIntervalMs` 两个可注入参数（便于单测）；
- **失败分类五类各自独立**：`prepare-rejected` / `transcode-failed` / `unavailable`（服务端说完成但产物读不到）
  / `timeout`（还没转完）/ `network`；
- **更正所有错误注释**（T54 写的「引擎不可用」「45 秒挂死」）。

### 验证

- `tsc --noEmit` exit 0；
- 单元测试 **1853 条 / 85 个文件**全绿（基线 1847 / 85，**新增 6**：`test/stream-quality.test.ts` 23 → 29）；
- **变异自证**：把「预检重试」改回 T54 的「单次预检」→ **4 条红**；复原后 sha256 回基线 `1f4202c52245e20f` → 全绿；
- Playwright E2E **24 条**全绿；打包通过；
- ⚠️ **真机结论（T56 复验后更正）**：转码链路**确实跑起来了**
  （`prepare` 1205 ms → `status` 89 ms → `file` …），**第一次产物预检确实失败**
  （就绪竞态在真机真实发生，被 T55 的重试救回）；
  但**产物请求最终没能返回**（根因见 T56：主进程在 `session.fetch` 里崩了）⇒
  `<audio>.src` **仍然是回退的** `fnm://srv/track/stream?guid=…`，
  播放条显示「标准音质不可用：请求超时（20000 毫秒内没有响应），已改用原始音质播放」，
  进度 0:04 → 0:12 在走（音乐照常播）。
  ⇒ **本节修的就绪判定是对的**（它确实救回了第一次预检失败），
  **但当时标准音质仍走回退** —— 根因与修复见 T56。
  ⚠️ 测完 `prefs.json` **逐字节还原**。

### 已知限制（如实标注）

- ⚠️ **服务端引擎对个别曲目确定性失败**（《占位曲目二》《占位曲目三》6/6，`errno=68157441`，崩在 79 %~93 %）
  → 客户端只能回退原始音质 + 灰字说明；
- ⚠️ 那两首为什么在 79 %~93 % 处崩**尚未查清**（引擎 / 编码器 / 时长 / 文件特征，未逐项排除）；
- ⚠️ 「标准音质」= **MP3 320k**，服务端**没有** 192k 档；
- ⚠️ 标准音质**首次起播要等 1~3 秒**（服务端转码时间），界面显示「正在准备标准音质…」；
- ⚠️ 本机 NAS 的**内网地址是 `192.168.100.xxx`**（此前记录的 `192.168.1.2` 有误），本机不在该内网。

### 遗留 / 待办

- ⚠️ 待复验：T31~T55（用户侧肉眼）；
- ⚠️ 待用户拍板：词岛胶囊要不要收窄（520×96）；Electron 默认图标要不要换；
- ⚠️ 用户侧待办：更新服务器地址（https 静态目录）+ 代码签名证书与主体名；
- ⚠️ **轮换 NAS 账号口令**（本轮探针用到的口令明文出现在会话记录里）。
---

## 四十一、T56：代理二进制路径改走 `net.request`（绕开 undici 的 ByteString 崩溃）

### 起因

T55 修完「就绪判定」后，真机复验**仍然拿不到转码产物**：产物请求挂住 **12 002 ms** 后被中止，
紧接着的 `status` 也挂 **20 014 ms**，主进程还弹
「**A JavaScript error occurred in the main process**」。
⇒ T55 下面还压着**另一个、更底层的缺陷**（与就绪判定无关）。

### 根因（字节级确认）

#### 触发链

1. NAS 转码产物端点的响应带：

   ```text
   Content-Disposition: attachment; filename="占位曲目一 - 占位歌手二.mp3"; filename*=UTF-8''%E5%8D%A0%E4%BD%8D%E6%9B%B2%E7%9B%AE%E4%B8%80%20-%20%E5%8D%A0%E4%BD%8D%E6%AD%8C%E6%89%8B%E4%BA%8C.mp3
   ```

   `filename="…"` 那一段是**原始 UTF-8 字节**（`filename*` 是 RFC 5987 的百分号编码版）。

2. 主进程出网走 **Chromium 分区栈**
   （`electron/http.ts` → `session.fromPartition('fn-nas-v<epoch>').fetch()`），
   Chromium 把响应头按 **UTF-8** 解码 ⇒ 上面那个头变成**真正的 CJK 字符**。

3. Electron 内部把上游响应头塞进 **undici 的 `Headers`** ⇒ `Headers.set` 要求 **ByteString**
   （每个字符 ≤ 255）⇒ 抛
   `TypeError: Cannot convert argument to a ByteString because the character at index 22 has a value of 21344 which is greater than 255.`

4. **`attachment; filename="` 恰好 22 个字符** ⇒ **index 22 就是文件名的第一个字符** `占`
   = **U+5360 = 21344** —— 与报错里的数值**完全吻合**。

5. 该抛出发生在 **undici 的事件回调里**（不在我们的 `await` 链上）⇒
   **主进程未捕获异常**（弹错误框），同时那个 `fetch` **永远不会 settle**
   ⇒ 代理的二进制路径挂死 ⇒ 标准音质永远回退原始音质。

#### 为什么别的路径没事

| 路径 | 上游是否带 `Content-Disposition` | 结果 |
|---|---|---|
| `download/track/transcode/file` | **带**（中文歌名） | 崩 + 挂死 |
| `track/stream` | 不带 | 正常（实测 99 ms / 206 / `audio/flac`） |
| `static/cover` | 不带 | 正常 |
| JSON 路径（`track/list` 等） | 不带 | 正常 |

#### 为什么 Node 直连没事

Node 自己的 undici 把响应头按 **latin1** 解码 ⇒ 中文变成乱码字节（每字节 ≤ 255）⇒ **不抛错**。
探针实测：同一端点、同一任务，Node 直连 **63 ms** 返回 206。
⇒ **同一台服务器、同一个端点，客户端栈不同 ⇒ 表现不同** —— 这就是「代理挂 / 直连秒回」的全部原因。

#### 服务端绕不过

实测 8 种查询参数（`inline=1` / `attachment=0` / `download=0` / `disposition=none` /
`contentDisposition=0` / `filename=0` / `noDisposition=1` / `type=stream`）**全部无效**，
`Content-Disposition` 照发 ⇒ **只能改客户端**。

### 做法（用户拍板：代理二进制路径改用 `net.request`）

- `electron/http.ts`：`HttpStack` 新增**可选**方法 `stream?()`；
  Electron 运行时走 **`net.request({ url, method, headers, session })`**：
  - **`session` 传当前分区 session**（`fn-nas-v<epoch>`）⇒ **证书放行语义一字不变**
    （自签 NAS 照常能用，`setCertificateVerifyProc` 照样生效）；
  - `net.request` 的响应头是 **`Record<string, string | string[]>`（普通字符串）**，
    **不经过 undici 的 `Headers`** ⇒ **不做 ByteString 校验** ⇒ 非 ASCII 头**不会崩**；
  - 无 Electron（单测）时回落到注入的 `fetchImpl` / 全局 `fetch`，**行为与改前完全一致**。
- `electron/proxy.ts`：`proxyBinary` 改用 `http.stream?.()`；
  上游响应头改用**普通记录**承载，**绝不**进 `Headers`；
  转发给渲染进程时**逐个做 ByteString 安全检查**（含 >255 字符的值一律**跳过**）。
- 行为保持不变：`Range` 透传、`206` / `content-range` / `accept-ranges` 原样带回、
  `content-encoding` 存在时照样删 `content-length`、`401/403` 静默续期一次再重发、
  响应体继续流式转发、渲染进程带来的 `cookie` / `authorization` 照样不透传。

### 验证

- `tsc --noEmit` exit 0；
- 单元测试 **1862 条 / 85 个文件**全绿（基线 1853 / 85，**新增 9**：
  `test/http-stack.test.ts` 17 → 23、`test/proxy.test.ts` 48 → 51）；
- **变异自证**：把「二进制路径走 `http.stream`」改回「走 `http.fetch`」→ **2 条红**；
  复原后 sha256 回基线 `446441275a63298a`；
- Playwright E2E **24 条**全绿；打包通过；
- **真机**（真实 NAS + 真实 userData，偏好临时改 `standard`，测完逐字节还原）：

  | 观测项 | T55（修复前） | **T56（修复后）** |
  |---|---|---|
  | 产物请求耗时 | **12 002 ms** → 中止 | **89 ms**（206 / `audio/mpeg` / `bytes 0-1/7005165`） |
  | 紧跟的 `status` | **20 014 ms** → 中止 | 89 ms（正常） |
  | `<audio>.src` | 回退的 `fnm://srv/track/stream?guid=…` | **转码产物地址** `fnm://srv/download/track/transcode/file?downloadId=…` |
  | 播放条提示 | 「标准音质不可用：请求超时（20000 毫秒内没有响应）…」（`role="status"`） | **没有提示**（`notice` 元素不存在） |
  | 进度 | 0:04 → 0:12（在走，回退那一路） | **0:05 → 0:13**（在走，**产物那一路**） |
  | 主进程未捕获异常 | 弹「A JavaScript error occurred in the main process」 | **0 条**（主进程 `uncaughtException` 钩子全程未触发） |

- **全面真机复验（双档位 + 能力检测，2026-11-06）**：同一台机器、真实 NAS、真实 userData，
  两轮各起一次应用（偏好临时改档位，测完**逐字节还原**）：

  | 观测项 | 原始音质 | 标准音质 |
  |---|---|---|
  | 链路 | **FN 中继**（`<FN-ID>.fnos.net`） | 同左 |
  | `<audio>.src` | `fnm://srv/track/stream?guid=…` | **`fnm://srv/download/track/transcode/file?downloadId=…`** |
  | 转码端点调用 | **无**（原始档本就不该有） | `prepare` 1204 ms → `status` 89 ms → **`file` 85 ms / 206** |
  | 播放条提示 | 无 | **无** |
  | 进度 | 0:05 → 0:11（在走） | **0:06 → 0:12**（在走） |
  | 主进程未捕获异常 | 0 | **0** |
  | stderr 里有错误框文本 | 否 | **否** |

  ⚠️ 顺带验到两件事：
  - **「检测服务端能力」按钮**（T54 加的）实测返回「**服务端转码可用：标准音质能正常生效。**」
    —— 这条能力探测此前**只在单测里验过**，本轮是第一次真机跑通；
  - ⚠️ **应用当前连的是「FN 中继」**，不是用户自建反代 `user-proxy.invalid`；
    而实测**自建反代比中继快 11 倍**（7 MB / 1 154 ms vs 12 930 ms）
    ⇒ **想要更快就改用「地址模式」手动填 `https://user-proxy.invalid/music`**
    （FN ID 模式只会给出中继域名与内网/公网 IP，给不出这个自建域名）。

### 已知限制（如实标注）

- ⚠️ **JSON 路径仍走 `session.fetch`**（本轮不动）：目前观测到的 JSON 端点都不带非 ASCII 响应头；
  若哪天某个 JSON 端点也开始带中文头，同一个崩溃会复现 —— **留作后续观察项**；
- ⚠️ `net.request` 是 Electron 的 legacy API：它与 `session.fetch` **共用同一个 Chromium 网络栈**
  （同一个 `URLLoader`），差别只在「响应头不经过 undici 的 ByteString 校验」；
- ⚠️ `net.request` 不支持 `AbortSignal`：上游请求的中止语义与 T56 之前一致
  （代理本来也没把渲染进程的取消信号透传给上游）；
- ⚠️ **服务端引擎对个别曲目确定性失败**（《占位曲目二》《占位曲目三》6/6，`errno=68157441`）
  → 与 T56 无关，这类曲目仍需回退原始音质；
- ⚠️ 标准音质**首次起播要等 1~3 秒**（服务端转码时间），界面显示「正在准备标准音质…」。

### 遗留 / 待办

- ⚠️ 待复验：T31~T58（用户侧肉眼）；
- ⚠️ 待用户拍板：词岛胶囊要不要收窄（520×96）；Electron 默认图标要不要换；
- ⚠️ 用户侧待办：更新服务器地址（https 静态目录）+ 代码签名证书与主体名；
- ⚠️ **轮换 NAS 账号口令**（本轮探针用到的口令明文出现在会话记录里）。


## 四十二、T58：抹除用户私有标识与凭证残留

### 起因

T57 轮全面复验后，仓库与工作区里散落着**用户私有的标识**与**一行明文口令**。
用户拍板：「**就这样，该抹除的抹除，不要留**」。

### 判定口径（抹 7 类 / 留 5 类）

**抹**：明文口令；用户自有反代域名与证书 CN；FN ID 中继域名；NAS 真实内网 IP；
真实公网 IP；本机真实路径；本机会话标识。

**留**：开发者署名（产品身份：关于页 + 安装包属性 + ICP 备案主体）；
公司名 / 官网 / ICP 备案号；RFC1918 示例 IP（含**产品默认预填地址** + 约 50 处断言）；
签名常量；代码里本就存在的通用占位域名。

### 前置核实（动手前先查清）

| 事实 | 结论 |
| --- | --- |
| 私有域名是否被**代码**硬编码？ | **没有** —— 代码里只有 `<fnId>.fnos.net` / `example-fn-id` / `myfn` / `abc` / `demo` 这类通用占位 |
| 私有域名出现在哪？ | **只在注释与文档里**（`src/lib/address.ts` 文件头注释 + 3 份设计文档 + 本文件） |
| 明文口令在不在版本库？ | **工作树与历史都 0 命中**（`git grep` + `git log -S`）—— 只在 gitignored 的 `.superpowers/` 里 |
| 别的凭证形态？ | `set-cookie` / `access_token` / `Authorization` 在已跟踪文件里 **0 命中**；`Bearer` 仅出现在 `test/proxy.test.ts` 的**假 token** |

⇒ **本轮全部改动都在注释、文档与探针脚本里 → 运行时行为零变化。**

### 改了什么（已跟踪文件 26 处）

| 文件 | 处数 | 改法 |
| --- | --- | --- |
| `src/lib/address.ts` | 2 | **仅注释**里的域名换占位 |
| `docs/calibration.md` | 11 | 同上 |
| `docs/superpowers/specs/2026-11-05-fnmusic-domain-port-design.md` | 6 | 同上；「不能把私有域名硬编码进白名单」那条论断改为不含原值的表述 |
| `docs/superpowers/specs/2026-11-05-sanlos-music-stream-quality-ready-design.md` | 5 | 同上 |
| `docs/superpowers/specs/2026-11-02-fnmusic-desktop-design.md` | 2 | IP 换占位；media 的 `src` 改仓库相对路径 |

替换词：`.invalid`（**RFC 2606 保留顶级域**，永不可解析）、`<FN-ID>.fnos.net`
（与代码里既有的 `<fnId>.fnos.net` 写法一致）、`192.168.100.xxx`（保留网段，只抹主机号）。

### 规格文档与 commit message 本身也不落原值

⚠️ **第一版规格文档把原值逐字抄了进去** —— 那等于**没抹**（`git grep` 照样命中）。
已重写为「只记类别与替换值」，并 `git commit --amend` + `git reflog expire` +
`git gc --prune=now` 把那个含原值的对象**真正清出 `.git`**。

⇒ 复核结果：**所有 commit message**（含正文）对 6 类私有值 **0 命中**；
`git log -S '<明文口令>'` **0 命中** ⇒ **口令从未进过历史**。

### 未跟踪 / 忽略区的清理

| 目标 | 动作 |
| --- | --- |
| `.superpowers/`（gitignored 的 agent scratch，**含明文口令**） | **删**（101 文件 / 3.9 MB） |
| `release/verify/**` | 批量泛化（首轮 **81 个文件 / 221 处**，后续补扫数轮） |
| `release/verify/tmp-build`、`tmp-build2` | **删**（构建临时目录） |
| `.pack-staging/`（11-04 旧暂存）、`release-probe/win-unpacked/`（11-04 旧免安装产物） | 可动的部分移出回收站（**398 MB**）；⚠️ 各剩一个被锁住的 `resources/app.asar`（见下） |
| 台账 `progress-ledger.md`（仓库外） | 泛化 **18 处** + 补扫（**含少 3 字符的会话 ID 变体**） |
| `release-probe/` | **保留**：安装包 + 便携版（11-06 当前版） |

### ⚠️ 已知限制：两处 `app.asar` 删不掉（被 MiniMax Code 自己锁住）

用 Restart Manager API 定位持有者：**pid 1272 = MiniMax Code 本体**
（工作区文件监听器以「可读写、但不允许删除共享」的方式持有 `app.asar`
→ Windows 拒绝删除/改名上层目录，EPERM / SHARING_VIOLATION）。

⚠️ 这与 `scripts/pack.cjs` 头部早就写明的现象**完全一致**（第 20–25 行）——
打包脚本已经为它设计好了兜底（产物 exe 用新文件名发布，`win-unpacked` 留在暂存目录）。

⇒ **两个残留**：

- `.pack-staging/win-unpacked/resources/app.asar`（463 221 B）
- `release-probe/win-unpacked/resources/app.asar`（463 221 B）

⇒ **退出 MiniMax Code 后**即可删（回收站可恢复删除）；在此之前**无法**删除。
⚠️ `release-probe/win-unpacked/` 现在**不是可运行的免安装版**了（只余一个 `app.asar`）——
当前版的免安装产物在 `.pack-staging-1793898142144/win-unpacked/`（**Sanlos Music.exe**）。

### 历史口径

⚠️ 域名 / IP 这类半敏感标识**从 T 阶段早期起就在 git 历史里**（本仓库**无 remote**，从未 push）。
本轮**不重写历史** —— 沿用用户自己在「清除仓库中的真实 FN ID」那次 commit 立下的口径
（**清当前版本，不改写历史**），避免 152 个 commit 的 sha 全变、台账的 sha 引用全断。
⇒ 历史里**只有域名 / IP / 路径**，**没有口令**。

### 验收

| 项 | 结果 |
| --- | --- |
| 全仓库（含 ignored）扫 6 类私有值 | **0 命中**（751 个文本文件） |
| 补扫后才揪出的 3 类漏网 | **真实 FN ID**（探针 JSON 的 `"fnId"` 字段）、**token 指纹**（`tokenHead`）、**会话 ID 变体**（少 3 字符的那种）—— 全部已抹 |
| 所有 commit message（含正文）扫 6 类私有值 | **0 命中** |
| `git log -S '<明文口令>'` | **0 命中** |
| `git grep '<开发者署名>'` | 只剩**开发者署名**那 8 处（K1） |
| `tsc --noEmit` | exit 0 |
| `vitest` | **1862 passed / 85 files**（不增不减） |
| `playwright` | **24 passed** |
| `build` | exit 0 |
| U+FFFD 扫描 | 0 命中；无 BOM；行尾保持（本文件仍 CRLF） |

### 口径自证（脱敏是零行为影响的）

把 `src/lib/address.ts` 的注释**改回旧文本** → **没有任何测试变红**
⇒ 私有域名只存在于**注释层**，纯文本脱敏不影响任何运行时行为。

### 遗留 / 待办

- ⚠️ **会话历史快照里的口令**：`.minimax/v2/sessions/**` 含明文口令（探针注入 + 报告引用）。
  那是运行时自己的日志，**本轮不动**（改写历史不安全）→ 有效收口是**轮换 NAS 账号口令**；
- ⚠️ **K1 的开发者署名仍是公开信息**（见判定口径）；
- ⚠️ 退出 MiniMax Code 后清理上面那两处 `app.asar` 残留。


## 四十三、T81：真逐字才卡拉OK，否则整行显示

### 起因

用户报障「怎么现在歌词时间戳又不对了？」（2026-11-10）。完整诊断见台账
「歌词『行/字时间戳不对』：根因诊断」，结论摘录：

| 怀疑项 | 实测 | 结论 |
|---|---|---|
| 跑的是旧包？ | 桌面 exe 哈希与 `release/` 逐字节一致 | **不是** |
| 跑的是旧实例？ | 进程启动 00:22:16 晚于产物 mtime 22:41 | **不是** |
| 三处判定源不一致？ | 已统一为 `findActiveLine`（T79 已修） | **不是** |
| 可听延迟没算？ | `outputLatency=0`、`baseLatency=0.01` ⇒ 只有 **10ms** | **不是**（差几秒不是它） |
| 外部源的 `offset` 丢了？ | `[offset:±N]` 被识别并叠加 | **不是** |
| **词源只有行级 LRC** | 当前 `lyric.source="qq"`；QQ 端点**只能给明文行级 LRC**（逐字 qrc 在 `u.y.qq.com` 且**是密文**） | ✅ **根因** |

⇒ 全部走 `src/ui/lyrics/parse.ts` 的**伪逐字**（`pseudoWords()`）
⇒ **字级时间戳是按音节权重插值编造的** ⇒ 卡拉OK 扫光「动得很认真，但就是不对」。

### 决策

用户拍板（2026-11-10 原话）：

> 「你可以做一个判断，满足行字时间戳的歌词就用卡啦OK模式，不满足的就正常整行显示就好」

⇒ **本任务只做这个判断与它的呈现，不追新词源**。

⚠️ **中途转向**：原计划的 T74a（「接酷狗 KRC 真逐字源」，规格 commit `bccffa0`）
已按用户决定**整体放弃并回滚**（删 4 个新文件 + 回退 6 个已改文件），
只在其规格文档顶部加了一行「**本规格未实施**」的指引。
实测结论（酷狗 KRC 真逐字覆盖率 89%~100%）仍然有效，留作日后参考。

### 实现口径

| 项 | 取值 |
|---|---|
| 判定点 | `parse.ts` 的 `assemble()`（伪逐字被**创造**的那一刻） |
| 标记 | `LyricLine.wordTimed?: boolean`（`true` = 词级时间是**源给的**） |
| 缺省 | **缺省视为 `true`** ⇒ 既有手写 `LyricLine` 与既有测试**一字不改** |
| 粒度 | **逐行**（真实文件里两种行可以混存） |
| 伪逐字呈现 | **不渲染**逐字着色层（DOM 里零 `[data-word]`）⇒ 假扫光**不可能**出现 |
| 整行强调色 | `.fnm-lyricview__line--whole { color: var(--accent) }`（只用**语义变量**） |
| 判据 | 该行**已经开始**（`wordIndex >= 0`）或**已走满**（`completed`） |

### ⚠️ 跨进程陷阱（本次最关键的一处）

`electron/ipc.ts` 的 `sanitizeLyricMessage()` 是**白名单式重建**
（只认 `time` / `text` / `words` / `translation`）
⇒ **不显式透传 `wordTimed`，它会在 IPC 边界被洗掉**
⇒ 悬浮窗与词岛会把伪逐字**误判成真逐字** ⇒ **假扫光复活**。

⇒ 本任务在 `sanitizeLyricMessage()` 里补了透传，并**专门写了一条钉子测试**；
变异自证里「去掉透传」⇒ 该测试**立刻变红**。

### 验收

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0 |
| `vitest` | **2080 passed / 98 files**（既有 2056 条**一条不删**；改写 **6** 条前提被显式推翻的断言） |
| `build` | exit 0 |
| `playwright` | **29 passed**（含 T81 新增 2 条**真实 Electron** 用例） |
| 变异自证 | **5 条全部被抓住**（判定反了 / IPC 不透传 / CSS 硬编码色值 / 伪逐字也渲染着色层 / 整行判据漏条件） |
| U+FFFD 扫描 | 0 命中；无 BOM；行尾保持（changelog 与本文件仍 CRLF） |

### 真实 Electron 取证（E2E）

`e2e/t81-word-timed.spec.ts` 钉三件 jsdom 验不了的事：

1. **零**词级元素（`[data-word]` / `--karaoke` / `--overlay` 都不存在）
   ⇒ 伪逐字**不可能**再出现假扫光；
2. 当前行有 `--whole`，**非**当前行没有；
3. 当前行的**实际颜色** == `--accent` 的**实际颜色**
   （用临时探针 `div` 取 `--accent` 的实际颜色 ⇒ **两套主题都成立**，不写死色值）。

并带一条**对照组**：真逐字的那首歌 **卡拉OK 照旧**（`[data-word]` 在、`--whole` 不在）。

### 遗留 / 待办

- ⚠️ **用户当前用 QQ 源 ⇒ 卡拉OK 扫光会消失**（改为整行强调色）—— 这是本改动的本意，
  但用户会**明显感到变化**；想看扫光需切到能给真逐字的源（网易云 yrc 覆盖约 27%）；
- ⚠️ **整体固定偏移仍未修**（T72 的手动滑块待用户给 Lyricify 毫秒数）；
- ⚠️ 若日后仍要接**酷狗 KRC**（真逐字 89%~100%），那是**另一个任务**
  （原规格 `docs/superpowers/specs/2026-11-10-sanlos-music-kugou-krc-lyric-source-design.md`
  仍在，已标注「未实施」）；与本任务**不冲突**（本任务只管「有没有真逐字」）。

## 四十四、T82：外壳收尾（F12 / 版本号 / 项目地址 / 自动更新从项目拉取）

### 起因

用户提了四件事（2026-11-10）：

1. 去掉软件的 **F12** 按键调出（开发者工具）；
2. 给软件加入**版本号**；
3. 加入**项目地址**；
4. 加入**自动更新功能，从项目拉取**。

⚠️ 第 4 项**不是**「从零写自动更新」—— T23 已有整条机制
（`update:check` / `update:download` / `update:install` 全在主进程），
本任务只是**把它接到项目上** + **补上版本号 / 项目地址**。

### 判定口径

| 项 | 取值 |
|---|---|
| F12 | **显式吞掉**（新增 `'swallow'` 动作）：拦下默认行为、**什么都不做**；`openDevTools` 接缝**整个拆掉**（含 `electron/oauthWindow.ts` 里那处残留的**死接缝**） |
| 打包后 | 四个窗口一律 `devTools: !app.isPackaged` ⇒ 打包后 `false` ⇒ **任何途径都开不出**；开发态仍可调试 |
| 版本号 | **主进程是唯一真相源**：`app.getVersion()` → 新 IPC `app:version`（渲染层是 sandbox，读不到 `package.json`） |
| 项目地址 | `APP_INFO.repository` = `https://github.com/pure2199/sanlos-music`（白名单加 `github.com`，仍**精确匹配**） |
| 更新源 | `APP_INFO.updateBaseUrl` = `.../releases/latest/download`（**不是某个 tag 的目录** ⇒ 永远指向最新那版） |
| 回落 | **主进程**回落（`update:check` 地址为空 ⇒ 用项目地址）；渲染层仍不碰网络、也不能指定地址 |
| 签名闸 | **默认一字不变**；新增 `update.allowUnsigned`（**默认关**）+ 设置页开关，只放宽「发布者身份」，**SHA-512 与同源仍是硬闸**（签名者不符的包**不走**这条路） |

### ⚠️ 踩坑一（本次最关键）：**Playwright 的键盘注入不会触发 `before-input-event`**

第一次写 e2e 时用 `page.keyboard.press('F12')` ⇒ 测出来「开发者工具开不出来」⇒ **绿**。
但**变异自证**立刻打脸：把 F12 **重新绑回** `openDevTools`（恢复 T82 之前的行为），
**e2e 依然全绿** ⇒ 这条 e2e **没有鉴别力**（**假绿**）。

探针（`release/verify/fnm-keylog2-probe.mjs`，在应用里挂记录器**逐键记录**）查出的真相：

| 输入通道 | 原理 | 有没有触发 `before-input-event` |
|---|---|---|
| `page.keyboard.press(...)` | CDP `Input.dispatchKeyEvent`，**直接注入渲染进程** | ❌ **一次都没有** |
| `webContents.sendInputEvent(...)` | **主进程**模拟真实按键，走**完整输入管线** | ✅ **条条都有**（F12 / Ctrl+Shift+I / Ctrl+V 全记到了） |

⇒ 改用**主进程 `sendInputEvent`** 后，同一个变异**立刻变红** ⇒ e2e 才有鉴别力。

⚠️ **量测方法本身也要自证**（这一条探针先后踩了三个坑）：

1. 主进程里的数组记录器（挂 `globalThis` / `process`）：**读不回来**
   —— Playwright 的 `app.evaluate` **每次都在独立 realm 里执行**；
2. 主进程的 stdout：**抓不到**（Windows 上 Electron 主进程的 stdout 不接管道，实测 **0 字节**）；
3. 文件记录器**路径写死进产物**才对（靠环境变量传路径 ⇒ 万一没传到就静默写到 `NUL`，结论照样是假的）。

⇒ 最终方案：**文件记录器 + 相对路径 + 「已挂载」哨兵**
（**文件不存在** = 记录器没挂上，本次测量无效；**文件存在但没有事件** = 真没事件）。

### ⚠️ 踩坑二：既有 T36 的「Ctrl+V 粘贴」e2e 也是**假绿**

由踩坑一连带查出：那条用例用 `page.keyboard.press('Control+V')` ⇒ **不会**触发 `before-input-event`
⇒ 真正让粘贴生效的是 **Blink 自己的编辑命令** ⇒ **那条 e2e 验的不是 T36 接的那条接缝**。

⚠️ **本任务不动它**（既有测试一条不许删、断言一条不许削弱）⇒ 列入待办（见文末）。

### 改动文件

| 文件 | 改什么 |
|---|---|
| `electron/appShortcuts.ts` | 新增 `'swallow'` 动作；F12 / Ctrl+Shift+I → 吞掉；**拆掉** `openDevTools` 接缝 |
| `electron/oauthWindow.ts` | 授权窗 `devTools: false`；**删掉** T36 留下的 `openDevTools?` 死接缝 |
| `electron/main.ts` | 三个窗口 `devTools: !app.isPackaged`；`registerPlayerIpc` 传 `appVersion: app.getVersion()` |
| `electron/ipc.ts` | 新增 `app:version` 通道；prefs 清洗 `allowUnsigned`；`update:check` **回落项目地址**；install 透传 `allowUnsigned` |
| `electron/update.ts` | 新增 `sha512File()`（流式）；`launchInstaller` 支持 `allowUnsigned` + `expectedSha512`，启动前**再验一次** SHA-512 |
| `electron/preload.ts` / `shared/playerBridge.ts` | 桥加 `getAppVersion()` |
| `shared/appInfo.ts` | 加 `repository` / `updateBaseUrl`；白名单加 `github.com`（仍精确匹配） |
| `shared/update.ts` | `UpdatePrefs` 加 `allowUnsigned?` |
| `src/state/updateStore.ts` | `allowUnsigned` 已存值 / 草稿 / 保存 |
| `src/components/SettingsPanel.tsx` + `settings-panel.css` | 关于页加「版本」「项目地址」；更新页加「当前版本」「用项目地址」「允许未签名」 |
| `test/app-version.test.ts`（新） | 版本号 IPC、项目地址回落、allowUnsigned 落盘与透传 |
| `test/t82-shell-contract.test.ts`（新） | **源码契约**：三处 `devTools: !app.isPackaged`、授权窗 `devTools: false`、**全仓不再有 `openDevTools`** |
| `e2e/t82-shell.spec.ts`（新） | 真实 Electron：F12 探针（`sendInputEvent` + **对照组**）、关于页版本/项目地址、更新页当前版本/更新源 |
| `test/app-shortcuts.test.ts` / `app-info.test.ts` / `tray-tooltip.test.ts` / `update.test.ts` / `media-session.test.ts` / `settings-page.test.tsx` | 改写 **4** 条前提被显式推翻的断言 + 新增用例 |

### 验收

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0 |
| `vitest` | **2111 passed / 100 files**（既有 2080 条**一条不删**；改写 **4** 条前提被显式推翻的断言） |
| `build` | exit 0 |
| `playwright` | **32 passed**（含 T82 新增 **3** 条**真实 Electron** 用例） |
| 变异自证 | **8 条全部被抓住**（F12 重新绑回 `openDevTools` / 主窗口 devTools 恒真 / 授权窗 devTools 恒真 / 生产代码复活 `openDevTools` 接缝 / `app:version` 写死 / 不回落项目地址 / 不校验 SHA-512 / 白名单改子串匹配） |

### 遗留 / 待办

- ⚠️ **T36 的「Ctrl+V 粘贴」e2e 需要重写**（改用 `sendInputEvent`）——
  否则它**测不到**自己接的那条接缝（本任务不动既有测试）；
- ⚠️ **打包态的真机复验未做**：本任务验的是**开发构建**；
  「打包后 `devTools: false`」靠**源码契约测试**钉住
  （`test/t82-shell-contract.test.ts`），**装包后按一次 F12** 仍值得用户复验一次；
- ⚠️ **自动更新默认出网**：不填地址也能「检查更新」⇒ 会访问 GitHub；
- ⚠️ 本项目**仍未办理代码签名证书** ⇒ 默认只允许下载；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验等老待办**不变**。

## 四十五、T83：音频内嵌歌词（读音频文件里自带的标签）

**一句话**：歌曲文件里**自带**的歌词也能用了 —— 主进程直接读音频文件的**内嵌标签**，
`SYLT` 的**真逐字**自动进卡拉OK，只有行级的按整行显示（**不假装逐字**）。

### 结论

| 项 | 内容 |
|---|---|
| 读哪些标签 | **ID3v2 `USLT`（行级）/ `SYLT`（真逐字）/ Vorbis 注释 `LYRICS`·`UNSYNCEDLYRICS` / MP4 `©lyr` / WAV·AIFF 里的 `ID3 ` 块**（**手写解析器，不引新依赖**） |
| 怎么用 | 一律转成**标准 LRC 文本**再交出去 ⇒ 渲染层解析器（`src/ui/lyrics/parse.ts`）**一行不改**；`SYLT` 转成增强 LRC（`<mm:ss.xxx>` 逐字标签）⇒ 真逐字自动进卡拉OK |
| 覆盖哪三层 | ① **本地导入**的歌 ② **已下载**的 NAS 曲目（读**原文件**，标签最全）③ **NAS 在线播放**（`Range: bytes=0-65535`，**读满即断开**） |
| 优先级 | 内嵌算**本地侧**、排在 NAS 前面（用户 2026-11-10 拍板）：「线上优先」= **线上 → 内嵌 → NAS**；「本地优先」= **内嵌 → NAS → 线上**；**不用外部源**时内嵌照用（**不需要外网**） |
| 界面 | 全屏歌词页**如实显示**「歌词来源：音频内嵌」；设置里的「歌词来源」下拉**不加**内嵌（内嵌不是外部源） |

### ⚠️ 踩坑一（本次最隐蔽）：**跨进程形状不一致 ⇒ 静默失效**

第一次写完 E2E 是**红的**：歌词区一直显示「暂无歌词」，而页面底部还挂着
「该音频无法播放：当前内核不支持该格式」。**两个症状，两个独立的根因**。

查「内嵌歌词没取到」时，主进程探针显示 `readEmbeddedLyric` **明明返回了歌词**，
渲染进程直接调桥也**拿得到** ⇒ 断点落在**主进程与渲染层之间**。

真因：**IPC 回的是对象**（`{ content, layer }`），而桥的契约是
`Promise<string>` ⇒ preload **原样透传** ⇒ 渲染层拿到的是对象，
被 `typeof content === 'string'` 判成「**没有**内嵌歌词」⇒
**静默失效：没有任何报错，界面只是「暂无歌词」**。

修法（两处，缺一不可）：

1. `shared/embeddedLyric.ts`（新）：**跨进程契约**——`toEmbeddedLyricText()`
   把载荷适配成字符串；preload **必须**用它（`electron/preload.ts`）；
2. `test/embedded-lyric.test.ts`：**把整条链串起来断言**
   （真 IPC 处理器 → 真适配器 → 真渲染层取法）⇒ 任何一环的形状漂移都必红。

⚠️ **教训**：`typeof x === 'string'` 这种**兜底**会把形状漂移变成**静默降级**。
跨进程边界上**要么形状对得上，要么让测试红**——不能靠兜底糊过去。

### ⚠️ 踩坑二：mock 的 WAV **不合法** ⇒ Chromium 根本播不了

第二个根因在**夹具**：给 mock 的 WAV 塞 `ID3 ` 块时，**没按 RIFF 规范**处理
**奇数长度**的块（规范要求后面跟**一个补齐字节**，且**不计入**块大小）。

后果：按规范走块结构的解析器会**错位一字节** ⇒ 读到的下一个块 id 变成
`ata.`（而不是 `data`）⇒ Chromium 找不到 `data` 块 ⇒
`NotSupportedError` ⇒「该音频无法播放：当前内核不支持该格式」。

⚠️ **我们自己的解析器没事**（`ID3 ` 块在 `data` **之前**，找到它就不用再走块链）
⇒ **单测全绿、E2E 却红**：这正是「**mock 必须自己也是合法的**」的又一个例子。

修法：mock 按规范补齐字节；并新增 `test/t83-mock-wav.test.ts`
（**走真实 HTTP 路径**取流 ⇒ 按规范走一遍块结构 ⇒ 断言 `fmt ` / `ID3 ` / `data` **按序可见**）
⇒ 夹具再坏，**单测就会红**，不用等 E2E。

### 未实测（**如实标注，不写死成契约**）

| # | 待校准 | 现状 | 兜底 |
|---|---|---|---|
| ① | NAS `GET track/stream?guid=` 是否**透传原始字节** | **未实测**（标准音质明确是服务端转 MP3 320k ⇒ **标签必丢**） | 若服务端永远转码 ⇒ ③ 层天然读不到歌词 ⇒ 功能实际生效在 **①② 两层**（本地文件 + 已下载的原文件） |
| ② | 用户曲库里到底多少歌带内嵌歌词 | **未抽样** | 无（不影响实现，只影响收益） |
| ③ | `SYLT` 的行 / 词形态分布 | **未抽样**（形态判定是**启发式**：片段去空白长度中位数 ≥ 12 ⇒ 行模式） | 规则写死 + 单测钉住；判错时**退化成行级**（不崩、不假精细） |
| ④ | `SYLT` 的时间戳格式字段（`1` = 绝对毫秒 / `2` = MPEG 帧号） | **已实测**（T84）⇒ **见「四十六、T84」** | T84 起：`1` 与 `2` **都按毫秒读**；其余（`0` / `3+`）仍整帧放弃 |

### 改动文件

| 文件 | 改什么 |
|---|---|
| `electron/audioTags.ts` | `AudioTags` 加 `lyrics?`；ID3v2 帧循环接入 `USLT`/`ULT` + `SYLT`/`SLT`（`SYLT` 无条件覆盖 `USLT`）；Vorbis 取 `LYRICS`→`UNSYNCEDLYRICS`；MP4 取 `©lyr`；**WAV 的 `ID3 ` 块**（复用 ID3v2 解析器）；各容器分支透传 `lyrics` |
| `electron/embeddedLyric.ts`（新） | 主进程模块：曲目 id → LRC 文本；三条来源分支；**永不抛**；`readAtMostBytes()`（读满即断开） |
| `electron/ipc.ts` | 新增 `ipcMain.handle('lyric:embedded')`（**只收 id**，回 `{ content, layer }`，永不抛） |
| `electron/main.ts` | `fetchStreamHead()`（`Range: bytes=0-N`）+ 把「下载索引 → 本地登记表」的路径查询接进内嵌层 |
| `electron/preload.ts` | 暴露 `readEmbeddedLyric(id)`；**用 `toEmbeddedLyricText()` 适配载荷形状** |
| `shared/embeddedLyric.ts`（新） | **跨进程契约**：载荷类型 + `toEmbeddedLyricText()` |
| `shared/playerBridge.ts` | `LyricBridge` 加 `readEmbeddedLyric(id): Promise<string>` |
| `src/player/lyricSource.ts` | `origin` 加 `'embedded'`；`toEmbeddedEntries()`；`loadLocalFirst` / `loadOnlineFirst` 插入内嵌层；`deps.embedded?` 可注入 |
| `src/player/lyricOverlay.ts` | 悬浮窗 / 词岛也接上内嵌层 |
| `src/pages/FullPlayerPage.tsx` | 「歌词来源：音频内嵌」如实显示 |
| `mock-server/fixtures.ts` / `mock-server/server.ts` | 新增那首「带内嵌歌词」的歌（`t2`）+ **按 RIFF 规范**构造带 `ID3 ` 块的 WAV |
| `test/embedded-lyric-tags.test.ts`（新） | 6 类容器的标签解析（22 条） |
| `test/embedded-lyric.test.ts`（新） | 主进程取词 / 渲染层优先级矩阵 / **跨进程契约** / 流式层读满即断 / 渲染层不碰文件系统（23 条） |
| `test/t83-mock-wav.test.ts`（新） | 夹具的 **RIFF 合法性**（走真实 HTTP 路径）（3 条） |
| `test/helpers/audio-fixtures.ts`（新） | 共用夹具（登录 / 取流 / RIFF 块走查） |
| `e2e/t83-embedded-lyric.spec.ts`（新） | 真实 Electron：内嵌歌词两行 + 来源标签 + **能播**；对照组不显示内嵌标签 |
| `test/media-session.test.ts` | mock 桥补 `readEmbeddedLyric()`（**加桩，不删断言**） |

### 验收

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0 |
| `vitest` | **2159 passed / 103 files**（既有 2133 条**一条不删**） |
| `build` | exit 0 |
| `playwright` | **34 passed**（含 T83 新增 **2** 条**真实 Electron** 用例） |
| 变异自证 | **8 条全部被抓住**（去掉 `USLT` 分支 / `SYLT` 不转逐字 / `SYLT` 丢词间空格 / 内嵌层优先级插错 / 渲染层自己读文件 / 内嵌层失败抛异常 / `LYRICS` 键取错 / 流式层无限读不 abort） |

### 遗留 / 待办

- ⚠️ **真机复验未做**（需要用户放三个文件）：
  一个带 `SYLT` 的 mp3 ⇒ 必须**进卡拉OK**；
  一个带 `LYRICS`（行级）的 flac ⇒ 必须走**整行显示**（不假装逐字）；
  一个**没有**任何歌词标签的文件 ⇒ 行为必须**与今天一致**（仍显示「暂无歌词」）；
- ⚠️ **NAS 服务端是否透传原始字节未实测** ⇒ 若始终转码，③ 层（在线播放）**天然读不到**歌词（①② 两层不受影响）；
- ⚠️ **MP4 的 `moov` 常在文件尾** ⇒ 流式层读不到 `©lyr`（**如实放弃，不猜**；本地文件层不受影响）；
- ⚠️ **全屏歌词页多了一行来源说明**（以前只有线上源 / NAS 源会显示）；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验等老待办**不变**。

## 四十六、T84：`SYLT` 的「时间戳格式 = 2」按毫秒读（跟随 mutagen 的实际约定）

**一句话**：`SYLT` 帧里声明「时间戳格式 = 2」的文件，**以前整帧被放弃** ⇒ 真机上
「真逐字」几乎等于没有；现在 **`1` 与 `2` 一律按毫秒读**。

### 起因（用户原话）

> 「你去网上下三首这样的来测试」

T83 交付后用户要求用**真实文件**复验 ⇒ 下了真实语料 ⇒ 立刻暴露一个**真缺陷**。

### 实测根因：真实语料里的 `SYLT` **全都**声明「格式 2」，存的**却是毫秒**

| 证据 | 内容 |
| --- | --- |
| 语料来源 | `Fat-Zer/lollypop-SYLT-tests`（**CC BY-SA 4.0**；录音 tim.kahn，改编 Christian Weiske） |
| 帧里的时间戳 | `0 / 1000 / 2000 / … / 10000`（**毫秒**） |
| 音频总长 | **10.97 s** ⇒ 若是 MPEG 帧号（38.28 Hz）⇒ 10 000 帧 ≈ **261 s** ⇒ **不可能是帧号** |
| ID3v2 规范 | `1` = 绝对时间（**毫秒**）；`2` = MPEG **帧号** |
| mutagen 源码 | `unit = 'fr' if self.format == 1 else 'ms'` ⇒ **它自己把 `1` 当帧号、其它当毫秒** ⇒ 与规范**恰好相反**；且它**写出的文件一律声明「格式 2」** |

⇒ **mutagen（最流行的 Python 标签库）写出的 `SYLT` 文件全部落在「格式 2 + 毫秒」这一档**，
而 T83 的实现**只认 `1`** ⇒ **现实中最常见的 `SYLT` 文件恰好是原实现整帧放弃的那一档**
⇒ 真机上「真逐字」这项能力 ≈ **没有**。

### 决策（用户 2026-11-10 拍板）

- **格式 `1` 与 `2` 一律按毫秒读**（跟随 mutagen 的实际约定）；
- 其它取值（`0` / `3+`）⇒ **真不知道是啥 ⇒ 整帧放弃**（**不猜**）；
- ⚠️ **风险如实标注**：若某个文件**真按规范**存了 MPEG 帧号，我们会把它当毫秒
  ⇒ 时间戳**偏早** ⇒ 卡拉OK 走偏 —— **不会崩、不会显示错歌词**，只是时间不准。
  取舍：**「有歌词」优先于「时间绝对准确」**。

### 做法

| 文件 | 改什么 |
| --- | --- |
| `electron/audioTags.ts` | `parseSylltFrame()` 的时间格式判定：`timeFormat !== 1` ⇒ `timeFormat !== 1 && timeFormat !== 2`（其余取值仍整帧放弃）；注释里写明**实测依据**与**风险** |
| `test/embedded-lyric-tags.test.ts` | 原「MPEG 帧号（= 2）⇒ 整帧放弃」**改写**为「格式 2 ⇒ 按毫秒读」（断言拿到什么 **+** `wordTimed` 为真）；**新增**「格式 0 / 3 ⇒ 仍整帧放弃」 |
| `test/embedded-lyric-real-samples.test.ts`（新） | **真实文件**三态回归（真逐字 / 行级 / 无歌词 / FLAC 行级，共 4 条）；样本缺失 ⇒ `describe.skipIf` 整组 skip（**CI 不依赖网络**） |
| `tools/fn-fetch-embedded-lyric-samples.mjs`（新） | 拉 3 个 mp3 + 用 ffmpeg 造带 `LYRICS` 注释的 FLAC ⇒ 落到 `release/samples/embedded-lyric/`（**gitignored**） |

⚠️ **既有断言的处理**：原那条「格式 2 ⇒ 整帧放弃」的**前提被用户显式推翻**
⇒ **改写为新行为断言**，且**不弱于**原来那条：原来只钉「拿不到」，
现在钉「拿到什么」**+** 逐字标签为真 ⇒ 鉴别力**反而更强**。

### 样本策略（用户 2026-11-10 拍板：**样本不进仓库**）

- 原因：真实语料是 **CC BY-SA 4.0** ⇒ 进库要带**署名 + 相同方式共享**（许可传染）；
- ⇒ 仓库里只留**下载脚本 + URL**，样本落在 `release/samples/embedded-lyric/`（gitignored）；
- CI 用**自造夹具**钉行为（`test/embedded-lyric-tags.test.ts`），真文件**本机复验**。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `vitest` | **2164 passed / 104 files**（既有 2159 条**一条不删**；新增 **5** 条 = 真实文件回归 **4** 条 + 「格式 0 / 3 仍放弃」**1** 条） |
| `build` | exit 0 |
| `playwright` | **34 passed**（本轮**未改**渲染层 ⇒ 用例数不变） |
| 变异自证 | **10 条全部被抓住**（T83 的 8 条 + 新增⑨「只读格式 1」+ ⑩「格式 0/3 也照读」） |

### 已知限制（如实标注）

- ⚠️ **真按规范存 MPEG 帧号的少数文件** ⇒ 时间戳偏早、卡拉OK 走偏（**不崩、不显示错歌词**）；
- ⚠️ **真实文件回归依赖本机样本** ⇒ CI 上整组 skip（**CI 钉不住**真文件的**字节级**行为，
  只钉**自造夹具**的行为）；
- ⚠️ **FLAC 样本由 ffmpeg 造**（不是第三方真语料）⇒ 只验「Vorbis 注释 `LYRICS` 能读出来」；
- ⚠️ T83 的其它遗留（NAS 是否透传原始字节、`moov` 在文件尾等）**不变**。

### 遗留 / 待办

- ⚠️ **待用户真机复验**：拿真实带 `SYLT` 的 mp3 装包跑 ⇒ 必须**进卡拉OK**；
- ⚠️ **待用户拍板**：是否接受「帧号文件会走偏」这一取舍（当前：**接受**）；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验等老待办**不变**。
