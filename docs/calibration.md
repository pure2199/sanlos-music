# 真机联调校准记录

本文记录**哪些行为已经被验证过、用什么方式验证的**、**哪些还必须在真实 fnOS 上确认**，以及**联调需要用户配合什么**。

> 原则：**未实测的服务端字段与行为一律标为「待校准」**，不写死成契约。
> 探针脚本从环境变量读取凭证，**不打印、不落盘**。

---

## 一、当前状态总览

| 阶段 | 状态 |
|---|---|
| 单元测试 | ✅ **2376 条 / 116 个文件**全绿（2026-11-12 实测） |
| E2E（真实 Electron + 内嵌 mock NAS） | ✅ **34 条**全绿（2026-11-12 实测） |
| 打包 + 打包产物启动冒烟 | ✅ 通过（证据见 [`build-verification.md`](./build-verification.md)） |
| **公开发布** | ✅ **v0.2.7 已发布**（v0.2.5 / v0.2.6 / v0.2.7；GitHub Release，3 个资产；**未签名** + 构建来源证明，见 [`packaging.md` 第 7.10 节](./packaging.md)） |
| **真机联调（真实 fnOS）** | ✅ **已完成一轮** —— 真实 Electron 客户端 × 真实 NAS，**13/13 步全通**；过程中发现 3 个真实缺陷，已修复并复验（见第七节） |

---

## 二、已用探针实测确认的项

这些是开发期用 `tools/` 下的探针打真实 NAS 确认过的，联调时**只需复核一次**。

| 项 | 实测结论 | 来源 |
|---|---|---|
| **端口** | `port.httpPort = 5666`、`port.httpsPort = 5667` | `/sys/config` |
| **服务端转码** | 播放侧 `POST track/transcode` → `code=100001`（**16 种请求体形状全试过**）；**真正可用的是下载侧协议** `download/track/transcode/{prepare,status,file,delete}`（`prepare` / `status` / `delete` 全通）。⚠️ **T55 更正：服务端转码引擎其实是好的**（抽样 14 首 14/14 成功、平均就绪 988 ms）—— T54 当时的「引擎不可用」是**误判**，真凶是**客户端的就绪判定**（`percent>=100` 后单次预检）→ 详见「三十九、T54」与「四十、T55」 | `tools/sanlos-transcode-probe.mjs` + `release/verify/t54-*.mjs` |
| **兜底方案** | 改为**客户端 FFmpeg** 转 Opus（见 README 常见问题） | `tools/ffmpeg-verify.mts` |
| **本机 FFmpeg 覆盖度** | 9.0.2（Gyan full build）→ 支持 12 种容器：`ape`/`alac`/`dsf`/`wma`/`dts`/`aiff`/`ra`/`au`/`dvf`/`tta`/`dss`/`mmf`；**仅 `dff` 不支持**（无 `dsdiff` 解封装器） | `tools/ffmpeg-verify.mts` |
| **中继链路是硬性关卡** | 不带 `mode=relay` Cookie → 返回 HTML 错误页 | `tools/sanlos-httstack-verify.mjs` |
| **中继候选可达性** | `https://<fnId>.fnos.net` 命中；当前网络下内网/公网 v4/v6 不可达 | `tools/sanlos-probe.mjs` |
| **播放历史端点** | `GET /music/api/v1/play-history/list` → `total=414`，条目为**完整歌曲对象** | `tools/sanlos-history-probe.mjs` |
| **曲库编码分布** | 含 `alac` 46 首等 → **APE / ALAC 可以走兜底播放** | `tools/sanlos-codec-census.mjs` |
| **中继端口** | 中继**只监听标准 HTTPS 端口 443**，**不监听** 5666 / 5667 | `tools/sanlos-live-check.mjs`（不写端口登录失败 → 写 `:443` 成功） |
| **自建反代的端口** | 与官方中继一样**只监听标准 HTTPS 端口 443**（实测用户的 openresty 反代：5666 / 5667 都 ECONNREFUSED，443 通且 `/music/api/v1/sys/config` 返回 200）| `release/verify/t43-relay-probe.mjs` |
| **专辑详情取法** | `GET /album/detail?guid=<id>`；`data` 是**裸专辑对象**（不是 `{list,total}`）。用 `albumGUID` / `albumGuid` / `albumId` / `id` 一律 `code=100002` | `tools/sanlos-album-detail-probe.mjs` |
| **服务端不提供播放历史写入端点** | 17 个候选**历史**写端点全是 SPA 兜底 HTML；`stream` **不写**播放历史 → **NAS 历史只读**，客户端「本机记录 + NAS 只读」的设计正确。⚠️ **这条只针对「历史」**——收藏 / 歌单的写端点**是存在的**（见下一行） | `tools/sanlos-history-probe.mjs` + `tools/sanlos-writeback-probe.mjs` |
| **收藏 / 歌单写回可用** | `favorite-track/create` · `favorite-track/delete` → **`{ trackGUID }`**；`playlist/add-track` · `playlist/remove-track` → **`{ guid, trackGUIDs: [id] }`**；`playlist/create` → `{ name }`（**回显 guid**）；`playlist/delete` → `{ guid }`。四个端点**实测真生效**（收藏列表里出现 / 消失、歌单详情里出现 / 消失） | `tools/sanlos-writeback-probe.mjs` |
| **曲目对象带 `isFavorite`** | 真实曲目的 16 个字段里**有** `isFavorite`，且**取值可信**（实测：已收藏的 `true`、未收藏的 `false`）→ 行内收藏按钮的初始态可以直接取服务端字段 | `tools/sanlos-writeback-probe.mjs` |
| **历史排序依据不暴露** | 条目 `updatedAt` 与 `createdAt` **完全相同且非单调** → 服务端排序依据不可见 → 客户端**按返回顺序**展示 | `tools/sanlos-history-probe.mjs` |
| **搜索忽略分页** | `search/{track,album,artist}` **完全忽略** `page`/`size`（`size=5` 也返回全部：占位歌手三 500 首 / 37 专辑 / 2 歌手），第 1、2 页完全重叠 | `tools/sanlos-calibrate-probe.mjs` |
| **收藏取全** | `favorite-track/list`：`size=200` → 200 条，`size=500` / `size=2000` → 258 条，`total=258` → 客户端「size=200 分页循环」能取全 | `tools/sanlos-calibrate-probe.mjs` |
| **歌单总数** | `playlist/list` → `total=0`（该账号当前没有歌单） | `tools/sanlos-calibrate-probe.mjs` |
| **封面 `size` 白名单** | 只认 **200**（→ 200×200 JPEG，8.6 KB）与 **400**（→ 400×400 JPEG，26 KB）；其它值（含不传、100、300、640）都回落到**原始 640×640 WebP**（54.9 KB） | `tools/sanlos-cover-size-probe.mjs` |
| **同名专辑是多个实体** | 曲库里**存在同名但不同实体的专辑**：搜索「占位曲目一」会命中一个 4 首的「占位曲目一」，而曲目内嵌的 `album.guid` 指向的是另一个只有 1 首的「占位曲目一」。**专辑实体 id**（`/album/detail` / `/search/album` / `/album/list` 用它）与**曲目内嵌 `album.guid`** 是**两套 id** | `tools/sanlos-album-guid-probe.mjs` |
| **客户端取 id 的口径是对的** | 客户端用的是**专辑实体 id**（来自专辑列表 / 搜索结果）→ 专辑详情的曲目数与该实体一致；「按专辑名搜索」不可靠（会命中同名实体） | `tools/sanlos-album-guid-probe.mjs` + `tools/sanlos-live-check.mjs` |

---

## 三、待真机确认的清单（Step A–J）

标注 **[已实测]** 的项在开发期已确认，联调时复核即可。

| Step | 内容 | 状态 |
|---|---|---|
| **A** | FN ID 探测 —— 候选构造与并行探测命中预期链路 | **[已实测]** 中继命中；内网/公网在当前网络不可达 |
| **B** | 中继链路 —— `mode=relay` Cookie 生效、播放可用、界面显示限速提示 | **[已实测]** Cookie 是硬性关卡；**播放与限速提示已在真机复核**（真机播放「占位曲目一」成功，界面显示「中继带宽受限（约 0.5–4 Mbps）」） |
| **C** | token 续期 —— 触发 token 失效，确认静默续期路径生效 | **[已实测]** ① 显式 `relogin()` 返回 `true`，续期后曲库立刻可用（`tools/sanlos-session-renew-probe.mjs`）；② **服务端「token 失效」的真实形状已测出来**（`tools/sanlos-token-expiry-probe.mjs`）：无效 token → **HTTP 401** + `{ code: 99999, msg: "INVALID TOKEN" }` —— 业务码与 `CODE_TOKEN_EXPIRED` 一致 ⇒ **静默续期的触发条件成立**（客户端只读 body 里的业务码，不按状态码判定，401 照样能续期）。③ 二进制流路径（`track/stream`）按 401/403 静默续期一次并重发（`electron/proxy.ts`）。⚠️ 服务端**不提供**「作废当前 token」的接口，**99999 自动续期**那条路径仍无法在真机上自然触发 → 单测覆盖（已补「HTTP 401 + 99999」的真实形状）。✅ 规格 §5.4 的「续期失败 → 派发 `auth-lost` 回登录页」**已实现**（`src/api/client.ts` 的 `onAuthLost` → `src/App.tsx` → `src/pages/LoginPage.tsx` 的 `notice` + `sessionLost`；回归测试 `test/auth-lost.test.tsx` 6 条，见第八节 T19-3） |
| **D** | 转码兜底 —— 用一首 APE/ALAC 确认客户端 FFmpeg 兜底链路可用；确认系统无 ffmpeg 时的提示 | **[已实测]** 客户端 FFmpeg 兜底**全链路在真机跑通**：ALAC 曲（24.2 MB）下载 → 本地 → 播放时自动转成 **Opus**（3.43 MB）→ 经 `fnml://` 起播，**进度真的推进**（实测 `0:06`）、**0 条媒体错误**、提示显示「兜底播放使用 Opus 转码（音质有损…）」。⚠️ 过程中暴露并修掉了 **T18-6**（CSP 漏放 `fnml:` → 本地播放被 URL 安全检查拦死）。✅「系统无 ffmpeg 时的提示」也已实测（见第八节 T19-2）：「该格式（ALAC）当前无法播放：未检测到 FFmpeg。安装 FFmpeg 后即可通过转码播放。」 |
| **E** | 端口核对 | **[已实测]** 5666 / 5667；**中继只听 443** |
| **F** | 播放历史端点 —— 条目形状与规格 §15.7 一致；确认「最近播放」的排序依据（`updatedAt`？） | **[已实测]** 形状一致；**排序依据服务端不暴露**（`updatedAt`≡`createdAt` 且非单调）→ 客户端按返回顺序展示；**服务端无写接口** → NAS 历史只读 |
| **G** | 收藏 / 歌单**跨端同步** —— PC 端收藏后，用手机 App 确认可见 | ⏳ **待真机**（需手机端配合） |
| **H** | 搜索端点分页行为 —— `search/track` / `search/album` / `search/artist` 是否接受 `page`/`size`，`total` 是否准确 | **[已实测]** 服务端**完全忽略** `page`/`size`；客户端的「返回条数 > 页长 → 判定不支持分页 → 不再翻页」护栏**在真机上生效** |
| **I** | 收藏 / 歌单全量取回 —— `favorite-track/list` 与 `playlist/list` 的 `size` 上限（实测收藏 251 首 > 默认页长 200） | **[已实测]** 收藏 258 首可取全（`size=200` × 2 页）；**歌单 `total=0`**（该账号无歌单）→ 客户端的「`playlist/list` 实测 2 个」注释已过时 |
| **J** | 专辑详情与歌单创建返回形状 —— `/album/detail` 是否用列表信封返回；`/playlist/create` 是否回显 `guid` | **[已实测]** `/album/detail?guid=` → **裸专辑对象**（**不是**列表信封）；`/playlist/create` → **确实回显 `guid`** → 客户端两处假设都成立，但 `/album/detail` 的**参数名**取错了（已修，见第七节） |
| **K** | 封面 `size` 取值与取色 —— 封面 URL 的 `size` 参数语义；封面主色提取的采样策略 | **[已实测]** `size` 只认 **200 / 400**，其它值回落到原始 640×640；客户端现值 **200 正好命中白名单**（且卡片只有 160 px，200 足够）→ **取值不用改**。✅ 取色**已有实现**（此前这行写「本版本没有主色提取实现」是 T15 之前的**过时陈述**）：① 全屏播放页的**平均色**（`src/components/coverColor.ts` 的 `extractCoverColor`，Task 15 起，缩到 8×8 取像素后求均值；T31 修过「失败被缓存 ⇒ 背景永远停在兜底色」的缺陷）；② **主色**（`extractCoverDominantColor`，T89-④ 新增，色相分桶取「有性格」的那个 → 主题强调色用）。采样策略见「五十九」一节 |

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
node tools/sanlos-history-probe.mjs      # 例：播放历史
```

| 脚本 | 用途 |
|---|---|
| `tools/sanlos-probe.mjs` | FN ID 候选链路探测 |
| `tools/sanlos-con-smoke.mjs` | 连接链路冒烟 |
| `tools/sanlos-api-probe.mjs` | API 形状探测 |
| `tools/sanlos-history-probe.mjs` | 播放历史端点与条目形状 |
| `tools/sanlos-codec-census.mjs` | 曲库编码分布统计 |
| `tools/sanlos-transcode-probe.mjs` | 服务端转码可用性 |
| `tools/sanlos-empty-param-probe.mjs` | 空参数边界行为 |
| `tools/sanlos-flac-probe.js` | FLAC 相关形状 |
| `tools/sanlos-httstack-verify.mjs` | HttpStack / 中继 Cookie 行为 |
| `tools/ffmpeg-verify.mts` | 本机 FFmpeg 探测 + 转码 + 回读 + 覆盖度核对 |
| `tools/sanlos-calibrate-probe.mjs` | 搜索分页 / 收藏取全 / 专辑详情形状 / 歌单创建回显 |
| `tools/sanlos-album-detail-probe.mjs` | `/album/detail` 的路径与参数名变体扫描 |
| **`tools/sanlos-live-check.mjs`** | **真实 Electron 客户端 × 真实 NAS 的活体验检**（13 步主干路径） |
| `tools/sanlos-electron-net-probe.mjs` | Electron 出网栈对照诊断（Node / Chromium / net.fetch） |
| `tools/sanlos-partition-matrix.mjs` | 分区 × 证书校验回调的对照矩阵 |
| `tools/sanlos-login-shape-probe.mjs` | 登录请求「逐项减法」（定位失败要素） |
| `tools/sanlos-card-hit-probe.mjs` | 卡片命中检测（`elementFromPoint` + 截图） |
| `tools/sanlos-session-renew-probe.mjs` | Step C：静默续期 |
| `tools/sanlos-cover-size-probe.mjs` | Step K：封面 `size` 白名单 |
| `tools/sanlos-alac-fallback-probe.mjs` | Step D：客户端 FFmpeg 兜底全链路 |
| `tools/sanlos-first-paint-timing.mjs` | 各页首屏耗时测量 |

---

## 六、联调发现问题怎么办

联调中发现的每一个问题，都**另开一个小任务**修复（T18），并遵循：

1. 先复现（补测试或探针），再改；
2. 修复后补回归测试；
3. **不削弱**既有断言 —— 若前提被推翻，改写为**新行为**的断言并说明理由。

---

## 七、真机联调发现的问题与修复（T18）

本轮真机联调（真实 Electron 客户端 × 真实 NAS）发现 **6 个真实缺陷**，均已修复并**在真机复验通过**
（`tools/sanlos-live-check.mjs` 从修复前的 9/13 变为 **14/14** —— 新增的「本地播放」一步专门盯 `fnml://` 这条线）。

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
与「token 过期」是同一件事。新增 `tools/sanlos-token-expiry-probe.mjs`。

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

**做法**（新增 `tools/sanlos-no-ffmpeg-probe.mjs`）：**启动 Electron 时把 PATH 里的 ffmpeg 目录摘掉**，
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

> ⚠️ **时态提醒（2026-11-12 补）**：上面这两条是 T19-3 **动手之前**的原始结论，
> 记录的是「**当初缺什么**」，**不是仓库现状**。
> **当前状态**：`auth-lost` 链路**已实现并有回归测试钉住** ——
> `src/api/client.ts` 的 `onAuthLost()` → `src/App.tsx`（`sessionLost` 状态）
> → `src/pages/LoginPage.tsx` 的 `notice`（`role="status"`）+ `sessionLost`（跳过 `restore()`）；
> 回归测试见 `test/auth-lost.test.tsx`（6 条）与 `test/login-page.test.tsx`（3 条）。
> 完整落地说明见下方「已实施的修法」。

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
| ③ 上游能力层 | 真机探针 `tools/sanlos-range-probe.mjs` | **NAS 到底支不支持 Range、分段字节准不准** | mock 是假 NAS，**回答不了**上游能力 |

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
| `tools/sanlos-live-check.mjs`（**+1 步**，14 → 15） | 真机拖动定位：断言 ① 媒体被 seek 到目标位置；断言 ② **进度从新位置继续推进**（真机独有：mock 做不到）。**另加构建新鲜度闸门**（见下） |
| `tools/lib/fresh-build.mjs`（**新**） | 构建新鲜度闸门：产物（`dist/assets/main-*.js` + `dist-electron/main.js`）比源码（`src/` / `shared/` / `electron/`）旧就**硬失败**（退出码 3） |
| `tools/sanlos-seek-diag.mjs` / `tools/sanlos-seek-diag2.mjs`（**新**） | 真机 seek 链路诊断：v1 = 用户路径四个实验；v2 = 读 **React fiber** 的 hook 状态 + 直接调用 fiber 上的 React handler（把「事件没送到」与「handler 跑了但没送达」彻底分开） |
| `tools/sanlos-range-probe.mjs`（**新**） | 上游能力探针：NAS 支不支持 `Range`、分段字节准不准、越界行为 |

### 真机实测结论（`tools/sanlos-range-probe.mjs`，T20 新增）

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

排查用 `tools/sanlos-seek-diag.mjs`（用户路径四个实验）→ `tools/sanlos-seek-diag2.mjs`（读 React fiber），逐环排除：

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
2. **加闸门**：新增 `tools/lib/fresh-build.mjs`，真机脚本（`sanlos-live-check.mjs`、`sanlos-seek-diag2.mjs`）
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
- 探针脚本 `tools/sanlos-range-probe.mjs` 只读，不写任何数据；凭证只从环境变量读，不打印、不落盘。
- ⚠️ **真机脚本现在会因「产物旧」而拒绝运行**（退出码 3）——这是**故意**的。
  跑真机前先 `npm run build`。
- ⚠️ **真机上封面刷出上千条 `MediaImage src can only be of http/https/data/blob scheme: fnm://…`
  warning**。
  ⚠️ **T21 复核后更正**：这条 warning **不是**「应用内封面不显示」——
  实测（`tools/sanlos-cover-probe.mjs`）应用内 `<img src="fnm://…">` **能正常解码**
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

当时记的是「封面没显示出来」。**这是误判** —— T21 用新探针 `tools/sanlos-cover-probe.mjs` 量过：

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
| `tools/sanlos-cover-probe.mjs`（新） | 真机探针：量应用内封面实况、渲染层 fetch、blob 解码、媒体会话 artwork 的 scheme、那条 warning 的条数 |

### 真机实测（`tools/sanlos-cover-probe.mjs`，T21 新增）

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

### 真机量到的证据（`tools/sanlos-cover-probe.mjs` 的 ① / ①-b / ①-c 段）

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

### 真机复验（`tools/sanlos-live-check.mjs` + `tools/sanlos-cover-probe.mjs`）

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
| 签名 | 包**有**签名 ⇒ 签名者 == 预期；包**没**签名 ⇒ 需用户**显式授权** | 装一个没签名的包 |
| 启动 | 启动前**再验一次**签名 + **再核对一次** SHA-512（用主进程缓存的清单） | 下载到启动之间被换掉 |

⚠️ **T85 修正**：这张表以前写的是「没配预期签名者 → 一律不许启动」，
而实现里主进程**压根不探测文件**（给 `NotChecked`）+ 渲染层按 `NotSigned` 判
⇒ 两套口径叠在一起，把「允许安装未签名的更新包」**彻底堵死**（且**无任何报错**）。
现在判定口径只有一份（`shared/update.ts` 的 `evaluateSignatureGate()`），
**主进程与渲染层共用**；完整矩阵见 `docs/packaging.md` 第 7.4 节。

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

新增 `tools/sanlos-writeback-probe.mjs`（**一次登录、四段结论**）：

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
- `tools/sanlos-ui-repro.mjs`（本轮新增）保留为复现脚本：复制真实 userData → 起实例 → 截图 + 量几何。

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
- 设计规格：`docs/superpowers/specs/2026-11-04-sanlos-music-lyric-stage-design.md`

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
- 设计规格：`docs/superpowers/specs/2026-11-05-sanlos-music-settings-page-design.md`

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
| `docs/superpowers/specs/2026-11-05-sanlos-music-settings-page-design.md` | **新增**（设计规格） |
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
- 规格：`docs/superpowers/specs/2026-11-05-sanlos-music-app-info-design.md`（提交 `54d6b0c`）

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
| `docs/superpowers/specs/2026-11-05-sanlos-music-domain-port-design.md` | 6 | 同上；「不能把私有域名硬编码进白名单」那条论断改为不含原值的表述 |
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
| `tools/sanlos-fetch-embedded-lyric-samples.mjs`（新） | 拉 3 个 mp3 + 用 ffmpeg 造带 `LYRICS` 注释的 FLAC ⇒ 落到 `release/samples/embedded-lyric/`（**gitignored**） |

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

---

## 四十七、T85：自动更新的**签名闸**修好（「允许安装未签名的更新包」真的生效）

### 目的（用户 2026-11-10：「你帮我补好修好签名，修复好，不要再出这种低级错误了」）

v0.2.3 发布后用户问「为什么签名没通过」⇒ 实测发现**真缺口**：
「允许安装未签名的更新包」这个开关**在代码里是一条死路**（勾了也没用、且**无任何报错**）。

### 根因（实测，**不是推测**）

1. **主进程**：`electron/update.ts` 的 `verifyAuthenticode()` 在「预期签名者」为空时
   **提前返回 `NotChecked`、根本不读文件** ⇒ 主进程永远不知道这个包有没有签名
   ⇒「未签名放行」那道闸的第一条（`status === 'NotSigned'`）**永不成立**。
2. **渲染层还有两道更严的拦截**：`src/state/updateStore.ts` 因 expected 为空直接 return；
   `src/components/SettingsPanel.tsx` 的按钮启用条件依赖 `status === 'NotSigned'`
   （主进程却给 `NotChecked`）⇒ 按钮 **disabled** ⇒ 用户连点都点不到。
3. **文案自相矛盾**：设置页两段话描述**互斥**的两条规则。
4. **测试盲区**：T82 的所有用例 `expectedSigner` 都**非空**
   ⇒「expected 为空」这个分支**从没被测过**。

### 改了什么

| 文件 | 改什么 |
| --- | --- |
| `shared/update.ts` | 新增 `evaluateSignatureGate()` —— **唯一判定口径**（主进程与渲染层共用一份）；`UpdatePrefs` 注释同步 |
| `electron/update.ts` | `verifyAuthenticode()` **一律探测**文件（不再提前 return），按探测结果分流；`verifyUnsignedAllowed()` 改用共享口径 + 保留 SHA-512 硬闸 |
| `src/state/updateStore.ts` | `installUpdate()` 的提前拦截改成**与主进程同口径**（不再因 expected 为空就拦） |
| `src/components/SettingsPanel.tsx` | 按钮启用条件用**已保存**的 `allowUnsigned`（不是草稿）；三段说明文案重写；加「有未保存的修改」提示 |
| `test/update.test.ts` | 新增**矩阵契约测试**（判定表逐行钉）+ 共享口径单测；**改写**一条被推翻的断言（原鉴别力原样补回） |
| `test/update-store.test.ts`（新） | 渲染层 store 的判定口径（5 条） |
| `test/settings-page.test.tsx` | 按钮启用条件（已保存 vs 草稿）+ 文案不再矛盾（4 条） |

⚠️ **既有断言的处理**：原「没配预期签名者 → `status='NotChecked'`」那条的**前提被用户显式推翻**
⇒ **改写为新行为断言**，且**不弱于**原来那条：原来只钉「不许启动」，
现在**两条**分开钉（有签名 ⇒ 仍不许启动；没签名 ⇒ 照样探测），
并把「不许启动」落进**矩阵**里（`openPath` 一次都不许被调）。

### 判定矩阵（唯一口径）

| 安装包 | 预期签名者 | 允许未签名 | SHA-512 | 结果 |
| --- | --- | --- | --- | --- |
| 没签名 | 空 / 任意 | 开 | 相符 | ✅ 放行 |
| 没签名 | 空 / 任意 | 关 | 任意 | ❌ 拒绝 |
| 没签名 | 任意 | 开 | 不符 / 无 | ❌ 拒绝 |
| 有签名 | 一致 | 任意 | 任意 | ✅ 放行 |
| 有签名 | 空 | 开 | 任意 | ❌ 拒绝 |
| 有签名 | 不符 | 开 | 相符 | ❌ 拒绝 |

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `vitest` | **2189 passed / 105 files**（既有 2164 条**一条不删**；新增 **25** 条） |
| `build` | exit 0 |
| `playwright` | **34 passed**（本轮未改渲染层行为 ⇒ 用例数不变） |
| 变异自证 | **5 条全部被抓住**（提前 return 不探测 / 去掉「确实没签名」那道闸 / 渲染层换回旧口径 / 拿草稿值判定 / 有签名也放行） |

### 已知限制（如实标注）

- ⚠️ **不校验证书信任链**（老口径不变）：只保证「这个文件确实由预期的人签的」，
  信任链由 **Windows 自己**判断；
- ⚠️ **只放宽了「发布者身份」这一条**：SHA-512 / 同源 / 路径越界**一条都没松**；
- ⚠️ **「允许安装未签名的更新包」默认仍是关的** ⇒ 要装更新必须**手动勾选并保存**；
- ⚠️ **真机未实测**：本轮只跑了**单元 + E2E（mock）**；
  真机上「勾选 → 保存 → 检查 → 下载 → 启动安装 ⇒ 安装器真的起来」**待用户复验**。

### 遗留 / 待办

- ⚠️ **待用户真机复验**：设置 →「更新」勾选「允许安装未签名的更新包」→ 保存 →
  检查 → 下载 → 启动安装 ⇒ 安装器**真的起来**（此前必然失败）；
- ⚠️ **证书暂不办理**（用户 2026-11-10 拍板）⇒ 产物**始终没有签名**；
  若改主意，按「三条路线 + 主体名口径」执行（证书主体名 = 公司名，不是软件名）；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验、轮换 NAS 口令等老待办**不变**。

---

## 四十八、T86：签名链路补齐（产物**真的带上签名**了）

### 目的（用户 2026-11-10 23:20：「你把证书补上，这个你帮我修好」）

承接 T85 的追问「现在有签名了吗」⇒ 实测：**没有**（0.2.0 ~ 0.2.3 八个安装包
`Get-AuthenticodeSignature` 全是 `NotSigned`；`electron-builder.yml` 的 `win.sign` 留空）。

### ⚠️ 边界（**必须先划清，否则会做出「假信任」**）

- **能做的**：生成**本地自签**证书 ⇒ 让产物真的带上签名；给 electron-builder 接上签名；
  加**打包后签名断言**；用**真包**把更新链路跑通。
- **不能做的**：❌ 拿不到**公开可信**的证书（OV/EV 要主体材料 + CA 核验 + 硬件 token + 付款）。
- ⚠️ **自签 ⇒ 不可信** ⇒ 对外仍是「未知发布者」，且会让 Windows 显示「发布者：公司名」
  却**查不到信任链** ⇒ **比不签名更容易误导人** ⇒ 用户 2026-11-10 已拍板：
  **自签产物不进公开 Release**。

### 决策（用户 2026-11-10 23:20 拍板）

| 决策点 | 选择 |
|---|---|
| 证书性质与用途 | **自签先跑通链路**（不进公开 Release） |
| 主体名（CN） | **公司法定主体名**「广西闪链时空网络科技有限公司」（与营业执照一致 ⇒ 日后换真证书**不用改任何配置**） |
| 本机导入受信任根 | **导入**（仅当前用户，不影响别人，随时可撤销） |

### 改了什么

| 文件 | 改什么 |
| --- | --- |
| `tools/sanlos-make-selfsigned-cert.mjs`（新） | 生成自签**代码签名**证书（RSA 3072 / SHA-256 / 3 年）→ `.pfx` + `.cer` + 口令落在 `release/certs/`（**gitignored**）；`--trust` 导入**当前用户**受信任根；**自检**（读回 .pfx 确认私钥在位、主体名一致） |
| `tools/sanlos-check-signature.mjs`（新） | 读产物的 `Get-AuthenticodeSignature` ⇒ 打印 `Status` / 签名者 / 指纹；按 `--expect signed\|none` / `--expect-signer` / `--pfx` 判定，不符即非零退出 |
| `scripts/pack.cjs` | 打包后**主动断言**：配了证书却没签上 ⇒ **打包失败**；没配证书 ⇒ 只打印一行、**不**失败。查的是**暂存目录**（= 本次构建的产物，输出目录里可能躺着历史旧包 ⇒ 会误报） |
| `electron-builder.yml` | **只加注释**：签不签由 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 决定（**不改 `win.sign`**） |
| `electron/update.ts` | ⚠️ **修一个真缺陷**：签名者主体改走 **base64(UTF-8)** |
| `test/t86-signing-contract.test.ts`（新） | 6 条**源码层**契约（断言在不在、失败要不要 fail、中文走不走 base64、口令会不会入库、证书路径会不会写死） |

### ⚠️ 顺带修掉的真缺陷：中文主体名乱码

- **症状**：签名者主体名含中文时，客户端读到的签名者与用户填的**永远对不上**
  ⇒ 带签名的包会被**莫名其妙**地拒掉；
- **根因**：PowerShell 往**管道**写 stdout 用的是**控制台代码页**
  （简体中文机器 = OEM 936 / GBK），**不是 UTF-8** ⇒ Node 按 UTF-8 解出来是乱码
  （实测：`CN=广西闪链时空网络科技有限公司` → 读成一串**替换字符与问号**，
  中文部分**全丢**）；
- **修法**：PowerShell 输出 **base64(UTF-8)**，Node 侧再解 ⇒ **与代码页无关**；
- **连带**：PowerShell 脚本改用 `-EncodedCommand` 传参 ——
  `-Command "<脚本>"` 会被 Windows 命令行 + PowerShell **二次解析** ⇒ 引号被吃掉
  ⇒ 实测 `$ErrorActionPreference='Stop'` 变成「把 `Stop` 当命令执行」并报错。

### 实测（**真包**，不是 mock）

产物（`release-probe/`，本地自签）：

| 产物 | Status | 签名者 |
|---|---|---|
| `FN-Music-Setup-0.2.3.exe` | **Valid** | `CN=广西闪链时空网络科技有限公司` |
| `FN-Music-Portable-0.2.3.exe` | **Valid** | 同上 |
| `win-unpacked/Sanlos Music.exe` | **Valid** | 同上 |

真包跑更新链路（`openPath` 打桩，**绝不真的启动安装器**）——**8 / 8 通过**：

| 场景 | 结果 |
|---|---|
| 预期签名者**一致** | ✅ 放行（`openPath` 被调 1 次） |
| 预期签名者**不符** | ❌ 拒绝（理由含「不符」） |
| **未填**预期签名者 | ❌ 拒绝（理由含「未配置」） |
| 有签名 + 未填 + **已授权** | ❌ 拒绝（授权只管「未签名」的包） |
| 真·**未签名**包（0.1.0 那个）+ 已授权 + 哈希相符 | ✅ **放行**（T85 的核心，**真包实测**） |
| 真·未签名包 + **没授权** | ❌ 拒绝（默认行为不变） |

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `vitest` | **2195 passed / 106 files**（既有 2189 条**一条不删**；新增 **6** 条） |
| `build` | exit 0 |
| `playwright` | **34 passed** |
| 变异自证 | **5 条全部被抓住**（断言失败不 fail / 签名者直传 / 去掉「没签名 ⇒ 失败」/ 口令硬编码 / 证书路径写死） |

### 已知限制（如实标注）

- ⚠️ **自签不可信** ⇒ 公开产物**仍然没有签名**（真实 OV 证书未办理）；
- ⚠️ **签名 ≠ 不弹窗**：SmartScreen 判的是**文件哈希的信誉** ⇒ 第一版照样弹，
  要靠真实下载量 + 干净安装积累；**每次重新打包哈希就变 ⇒ 信誉清零**；
- ⚠️ **主体名一次定死**：换证书 = 换显示名 + 信誉清零；
- ⚠️ **不校验证书信任链**（老口径不变）；
- ⚠️ 本机受信任根里多了一张自签证书（仅当前用户；撤销命令见工具输出）；
  `Cert:\CurrentUser\My` 里还留着**第一张废弃**的自签证书（工具删除被本机安全策略拦下，
  不影响签名与信任链）。

### 遗留 / 待办

- ⚠️ **待用户拍板**：真实 OV 证书的采购（清单见 `docs/packaging.md` 第 7.8 节）；
  走流程需要主体材料 + 硬件 token + 付款；
- ⚠️ **待用户复验**：装上带签名的包后，设置 →「更新」→ 填「预期的代码签名者」
  （= `CN=广西闪链时空网络科技有限公司`）⇒ 「启动安装」应当**真的启动**；
- ⚠️ **发版**：T85 + T86 都在「未发布」小节里 ⇒ 要不要切 **v0.2.4** 由用户定；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验、**轮换 NAS 口令**、
  GitHub 改口令 + 开 2FA 等老待办**不变**。

---

## 四十九、T87：公开产物的代码签名（SignPath Foundation 免费路线）

### 做了什么

**一句话**：把「公开产物**没有**签名」变成「公开产物**带公开 OV 签名**」，
并把整条链路（**CI 打包 → 送签 → 人工审批 → 校验 → 发布**）搬进 CI。

### 关键决策（用户拍板）

| 项 | 决定 |
|---|---|
| 路线 | **SignPath Foundation 免费 OV**（证书 publisher = 「SignPath Foundation」） |
| 渠道 | **两条并存**：Release（NSIS + 应用内自更新）走 SignPath；**Microsoft Store** 另立 **T88** |
| 打包 | **搬进 CI**（SignPath 以「可信构建」为前提 ⇒ 本机手工包**签不了**） |
| 退路 | 换 Certum Standard 云签名（€209/年）⇒ **只改 CN 候选值**，不改逻辑 |

### 代码落点

| 文件 | 作用 |
|---|---|
| `shared/update.ts` | **唯一**的签名者匹配口径（`extractCommonNames` / `parseSignerCandidates` / `matchesExpectedSigner`）—— 客户端与构建期工具**共用** |
| `electron/update.ts` | 主进程按新口径核对签名者 |
| `src/components/SettingsPanel.tsx` | 「预期的代码签名者」支持**多候选**；文案写清 `SignPath Foundation` |
| `tools/sanlos-check-signature.mjs` | 断言加严：`--expect valid` / `--require-timestamp` / `--expect-cn`；判定抽成**纯函数** `evaluateSignature()` |
| `tools/sanlos-check-signature.d.mts` | 给 TS 侧 import 这个 `.mjs` 的手写声明（本仓库 tsconfig **无 `allowJs`**） |
| `scripts/pack.cjs` | 关掉「证书自动发现」；`FNM_EXPECT_SIGNER_CN` 加严开关；CI 适配说明 |
| `scripts/publish-manifest.mjs` | 认 `FNM_PACK_OUTPUT`（清单与安装包**必须同目录**） |
| `scripts/check-signpath-config.mjs` | 配置**快速失败**（缺一项就停） |
| `.github/workflows/release.yml` | 发版工作流（build → pack → 送签 → 审批 → 校验 → 发布） |
| `.signpath/artifact-configurations/default.xml` | 告诉 SignPath **签哪个文件** |
| `CODE_SIGNING_POLICY.md` / `docs/signing.md` | 申请材料 + 维护者说明 |

### 匹配口径（**一字不差**，客户端与工具同一份）

```
① 整串相等优先：规范化（trim + 折叠内部空白 + 转小写）后 subject 整串 == 候选
② 否则 extractCommonNames(subject) 的任一 CN == 候选（相等，大小写不敏感）
③ 绝不做「包含」匹配
候选分隔：',' ';' 换行；自动去掉 'CN=' 前缀；只认 CN，不认 O/C
```

### 实测（**真证书**，不是 mock）

用**微软真签名的** `C:\Windows\System32\notepad.exe`
（Subject = `CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US`）：

| 命令 | 结果 |
|---|---|
| `--expect valid --require-timestamp --expect-cn "Microsoft Windows"` | ✅ **通过**（exit 0）—— `Status=Valid`、**时间戳检出「有」**、CN 精确命中 |
| `--expect-cn "Microsoft Windows Evil"` | ❌ **失败**（exit 1）——「包含」式伪造被挡住 |
| 对**未签名**的 `electron.exe` 跑同一条 | ❌ 失败 3 条（状态不是 `Valid` / 没有签名无法核对 CN / 没有 RFC 3161 时间戳） |
| `--expect none`（对未签名文件） | ✅ 通过（exit 0）—— 旧语义**一字不变** |

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `vitest` | **2260 passed / 108 files**（既有 2195 条**一条不删**；新增 **65** 条） |
| `build` | exit 0 |
| `playwright` | **34 passed** |

### 已知限制（如实标注）

- ⚠️ **发布者会显示「SignPath Foundation」**（不是公司名）—— 免费路线的固有代价；
- ⚠️ **签名 ≠ 不弹窗**：SmartScreen 判的是**文件哈希的信誉** ⇒ 第一版照样弹
  （通常数周、数百次真实下载才积累起来）；签名真正解决的是「**不再是未知发布者**」
  与「**Smart App Control 的 Win11 不再直接拦截**」；
- ⚠️ **公开 Release 资产 5 → 3 个**：`latest.yml` / `*.blockmap` 基于**未签名** exe 算
  ⇒ 签名后失效 ⇒ 不再发布（客户端走 `latest.json` + SHA-512，本来就不用它们）；
- ⚠️ **本机手工打包不会被签**（SignPath 只签 CI 产物）；
- ⚠️ **每次发布要人工点一次批准**；不批 ⇒ 工作流超时失败（artifact 保留，可重跑）；
- ⚠️ **CI 只跑 typecheck / test / build**（`ci.yml` 现状，不跑 e2e）；
- ⚠️ **「同一套匹配逻辑」靠 esbuild 运行时复用**（`shared/update.ts` ⇒ CJS ⇒ 内存里 `new Function` 求值）
  —— 不是 Node 原生 TS 加载（CI 用 **Node 22**，原生类型剥离在该版本上不保证）；
  ⚠️ 该文件必须在 **node 环境**下测（jsdom 的 `TextEncoder` 跨 realm ⇒ esbuild 启动自检必炸）。

### 遗留 / 待办

- ⚠️ **【工程侧无法代替】** ① 用户提交 SignPath Foundation 申请（`signpath.org/apply`）；
  ② 批下来后填 5 个 secrets / variables；③ 每次发布人工批准一次；
- ⚠️ **T87.7（发版 v0.2.5）** 待上面三件事齐了才能跑；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验、**轮换 NAS 口令**、
  GitHub 改口令 + 开 2FA 等老待办**不变**。

---

## 五十、T87.8：CI 出包链路实测失败 ⇒ 打包配置里的**非法键**（2026-11-10）

### 做了什么

**一句话**：T87 落地后第一次跑发版工作流就**失败在打包** ⇒ 根因是
`electron-builder.yml` 里一行**非法键** ⇒ **整个打包挂掉**；修好之后又补了两道
守卫，让「打包配置写错」**从此不必等到发版才炸**。

### 现象与根因（**实测**，不是推断）

| 项 | 内容 |
| --- | --- |
| 触发的 run | **42857375893**（`workflow_dispatch`，`pack_only=true` ⇒ **只打包、不送签、不发版**） |
| 失败位置 | 第 8 步 `Pack`；前 7 步（checkout / setup-node / npm ci / typecheck / test / build）**全绿** |
| 报错原文 | `Invalid configuration object. electron-builder 26.18.0 has been initialized using a configuration object that does not match the API schema. - configuration.win should be one of these: null` |
| 根因 | `electron-builder.yml` 里的 `win.timeStampServer` **不是 electron-builder 26.18.0 的合法键** ⇒ 配置校验直接失败 ⇒ **整个打包挂掉** |
| 本地复现 | `node node_modules/electron-builder/cli.js --config electron-builder.yml` ⇒ **报错与 CI 一字不差** |
| 合法位置 | `win.signtoolOptions.timeStampServer`（传统 `/t`）+ `win.signtoolOptions.rfc3161TimeStampServer`（RFC 3161 `/tr`）—— 代码读的就是这两个（`windowsSignToolManager.js:199-200`） |

### 为什么「没人发现」（**流程缺口**，不是偶发）

1. **本机没重跑打包**：T87 的验证清单有 tsc / vitest / build / e2e / 变异自证 / 真证书实测，
   **唯独没有 `npm run pack`** ⇒ 改了打包配置却没打包验证过；
2. **CI 不打包**：`ci.yml` 只跑 typecheck / test / build ⇒ **配置级的错误只有发版工作流才会碰到**。

⇒ 结论：**谁改了打包配置，就必须有能验证打包配置的关卡。**

### 修法（三条，缺一不可）

1. `electron-builder.yml`：挪到 `win.signtoolOptions.{timeStampServer, rfc3161TimeStampServer}`；
2. **新** `test/t87-builder-config-schema.test.ts`：用 **electron-builder 自己的**配置加载器
   （`getConfig`）+ **它自己的 schema**（`validateConfiguration`）校验 `electron-builder.yml`
   ⇒ **不自己写校验器**（自己写的会漏判）；含「非法键必被拒」的变异自证；
3. `ci.yml` 加 `Pack (smoke)`（`node scripts/pack.cjs`，输出到 `release-ci/`）
   ⇒ 每次 push / PR **真出一次包**。

### 附带发现：CI 里的 `ELECTRON_MIRROR` 是**死代码**（**⚠️ 本节结论已被 T87.9 推翻，见「五十一」**）

- `@electron/get` 的优先级：`.npmrc` 注入的 `npm_config_electron_mirror`
  **排在 `ELECTRON_MIRROR` 前面** ⇒ 实际走的是仓库 `.npmrc` 的 npmmirror
  （实测佐证：CI 里 electron 二进制**确实**下载成功了 ⇒ 走的就是 npmmirror）；
- 而且那个值**多带尾部 `/v`** ⇒ 一旦生效就是 404（实测：
  `.../download/v32.3.3/electron-v32.3.3-win32-x64.zip` ⇒ **HTTP 206**；
  `.../download/v/v32.3.3/electron-v32.3.3-win32-x64.zip` ⇒ **HTTP 404**）；
- ⇒ 本次**把注释改成与事实一致** + 把值改成**正确形态**（行为不变：`.npmrc` 仍然优先）。

> ⚠️ **更正（2026-11-10，T87.9）**：本节「`ELECTRON_MIRROR` 是死代码」**只对 `npm ci` 成立**。
> `node scripts/pack.cjs` **不是 npm 命令** ⇒ 拿不到 `.npmrc` 注入的 `npm_config_electron_mirror`
> ⇒ **只有 `ELECTRON_MIRROR` 生效**；而且正确形态是**带结尾的 `/`**（`…/releases/download/`），
> 不是「不带 `/v`」⇒ 本节据此把值改成「无尾斜杠」，**直接把 CI 打包打挂了**（run 42861355862 / 42861484377）。
> 详见「五十一、T87.9」。

### 第二次翻车：**CRLF 行尾**（同一天，CI 又挂一次）

修完上面的非法键、推送后，两条 workflow（CI `42859918221` + Release `42860165012`）
**又挂在同一处：第 6 步 `Unit tests`**（这次**不是**打包步骤）。

从 GitHub 的 check-run annotations 读到的真实报错：

```
test/t87-builder-config-schema.test.ts
  AssertionError: expected '…' to match /^ {2}signtoolOptions:\n(?: {4}\S.*\n…/m
  AssertionError: expected '…' not to be '…'   // 变异那一步：mutated === original
```

| 根因 | 内容 |
|---|---|
| 机制 | GitHub 的 **Windows runner 上 `core.autocrlf=true`** ⇒ **检出后的文本文件是 CRLF**；而本机工作区是 LF（且仓库里 `docs/changelog.md` / `docs/calibration.md` 本来就是 CRLF）⇒ **同一份代码在两边的字节不同** |
| 表现 1 | 正则 `/^ {2}signtoolOptions:\n/` 要求 `:` 紧跟 `\n`，而 CRLF 下是 `:\r\n` ⇒ **匹配不上** |
| 表现 2 | 变异那一步的 `replace(/^win:\n/)` 同样匹配不上 ⇒ **变异没生效** ⇒ `expect(mutated).not.toBe(original)` 失败 |
| 结论 | **行尾不该是判定的变量** ⇒ 断言与变异前一律先 `replace(/\r\n/g, '\n')` 归一化 |

⚠️ **通用教训（比这一次的 bug 更值钱）**：**「本地绿、CI 红」的第一嫌疑是「两边看到的文件字节不同」**
（行尾 / BOM / 编码），而不是「CI 环境有问题」。⇒ 断言文件内容前**先归一化**，
或**按字节断言**（明确期望 CRLF 还是 LF）。

⇒ 修完补了 5 个场景的变异自证（`release/verify/t87b-mutations.mjs`）：
A1 非法键（LF）必红 / A2 按 sha256 还原 / A3 还原后必绿 / **B CRLF 行尾仍必绿** /
**C CRLF + 非法键必红** / D 还原 / E 最终态必绿 —— **7/7 全过**。

⚠️ **仍留着的隐患（本次**不改**，交由用户拍板）**：仓库**没有 `.gitattributes`**
⇒ 行尾完全由各人各机器的 `core.autocrlf` 决定 ⇒ **本地与 CI 的文件字节永远可能不同**。
彻底解法是加一个 `.gitattributes`（`* text=auto eol=lf` + 二进制文件标记）
—— 但那会**改变所有人工作区的行尾**（本仓库的 `docs/changelog.md` / `docs/calibration.md`
现在就是 CRLF）⇒ 属于**仓库级口径变更**，不夹带在本次修复里。

### 验证（全部实测）

| 项 | 结果 |
| --- | --- |
| 本地打包 `node scripts/pack.cjs` | ✅ **exit 0** —— 配置校验通过；产出 `FN-Music-Setup-0.2.4.exe` + `FN-Music-Portable-0.2.4.exe`；日志 `no code signing certificate configured, signing is skipped` ⇒ **`signtoolOptions` 不会误触发签名** |
| `tsc --noEmit` | ✅ exit 0 |
| `vitest` | ✅ **2263 passed / 109 files**（既有 2260 条**一条不删**；新增 **3** 条） |
| 变异自证 | ✅ **7/7 场景全过**：非法键（LF）必红 → 按 sha256 还原 → 还原后必绿 → **CRLF 行尾仍必绿** → **CRLF + 非法键必红** → 还原 → 最终态必绿 |
| 字节自检 | ✅ 改动文件 BOM=N / FFFD=0 / NUL=0 / 行尾与原文件一致 |

### 已知限制

- ⚠️ `ci.yml` 每次 push / PR 会**多花约 3~5 分钟**（真出一次包）—— **有意接受的代价**：
  公开产物的第一道门就是「能出包」；
- ⚠️ 本地打包时 `win-unpacked` 目录**发布不出去**（老问题 T62：被别的进程持有）
  ⇒ 产物 exe 本身正常（用的是新文件名）⇒ 与本次改动无关；
- ⚠️ `test/t87-builder-config-schema.test.ts` 走的是 electron-builder 的**内部路径**
  （`app-builder-lib/out/util/config/config.js`）⇒ 将来升级 electron-builder 若改了路径，
  这条测试会**响亮地失败**（而不是静默跳过 ⇒ 守卫失效）。

### 遗留 / 待办

- ⚠️ **T87.7（发版 v0.2.5）** 仍卡在两件工程侧无法代替的事：
  ① 用户提交 SignPath Foundation 申请；② 批下来后填 5 个 secrets / variables；
  （另：每次发布要在 SignPath 平台**人工点一次批准**）；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验、**轮换 NAS 口令**、
  GitHub 改口令 + 开 2FA 等老待办**不变**。

---

## 五十一、T87.9：CI 打包 404 ⇒ `ELECTRON_MIRROR` 少一个结尾的 `/`（2026-11-10）

### 做了什么

**一句话**：T87.8 修好配置之后，CI 仍然挂在**同一个步骤**（第 8 步 `Pack`）⇒
根因是 **T87.8 自己把 `ELECTRON_MIRROR` 改成了「无尾斜杠」** ⇒ 拼出畸形 URL ⇒ **404**；
修好之后补了一条**用 `@electron/get` 自己口径**的守卫，让「镜像变量写错」**在 `npm test` 就红**。

### 现象与根因（**实测**，不是推断）

| 项 | 内容 |
| --- | --- |
| 触发的 run | **42861355862**（CI）与 **42861484377**（Release，`pack_only=true`） |
| 失败位置 | 第 8 步 `Pack`；前 7 步**全绿** ⇒ **T87.8 的 CRLF 修复生效了**（单测这次过了） |
| 报错原文 | `⨯ Response code 404 (Not Found) for https://github.com/electron/electron/releases/downloadv32.3.3/electron-v32.3.3-win32-x64.zip` |
| 根因 | `@electron/get` 的下载 URL 是**纯字符串拼接** `${base}${path}/${file}`（`artifact-utils.js:60`）⇒ **镜像必须自带结尾的 `/`**（它的默认值 `BASE_URL` 就带） |
| 谁读这个变量 | `mirrorVar`（`artifact-utils.js:24-38`）优先级：`npm_config_electron_mirror`（`.npmrc` 注入）→ … → `ELECTRON_MIRROR` → 默认 |
| **为什么「装依赖没事、打包才炸」** | `npm ci` 是 npm 命令 ⇒ npm 注入 `npm_config_electron_mirror` ⇒ 走 npmmirror；**`node scripts/pack.cjs` 不是 npm 命令** ⇒ 拿不到那些变量 ⇒ **只有 `ELECTRON_MIRROR` 生效** |
| 为什么本地测不出来 | 本机 electron-builder 的下载缓存里**已有** electron zip ⇒ 打包**根本不下载**；CI 是干净 runner ⇒ 缓存空 ⇒ **必须下载** |
| 另一条镜像不用改 | `ELECTRON_BUILDER_BINARIES_MIRROR` 由 electron-builder 自己的 `getBinariesMirrorUrl()` 读（`electronGet.js:748`），它**自己补尾斜杠** ⇒ 带不带 `/` 都对（实测 `winCodeSign-2.6.0.7z` / `nsis-3.0.4.1.7z` 均 **206**） |

⚠️ **打脸记录（留档）**：T87.8 的 spec §9.5 判断「`ELECTRON_MIRROR` 是死代码（`.npmrc` 优先）」
⇒ 于是把值改成「无尾斜杠」⇒ **直接把 CI 打包打挂了**。那条结论**只对 `npm ci` 成立**。
⇒ **教训**：「某变量在 A 场景下无效」**推不出**「它在 B 场景下也无效」—— 而且**同一个变量在不同上下文里
的生效与否可能不同**（npm 注入 vs 直接跑 node）。

### 修法（三条）

| # | 措施 |
| --- | --- |
| ① | `ci.yml` / `release.yml` 的 `ELECTRON_MIRROR` 补回结尾的 `/`；注释改成**事实**（两个镜像变量的拼接规则不同、优先级不同） |
| ② | **新** `test/t87-ci-mirror-url.test.ts`（6 条）：用 **`@electron/get` 自己的** `getArtifactRemoteURL` 把工作流里那个值算成**真实下载 URL**；含「少一个 `/` 必红」的变异自证、「npm 上下文里 `.npmrc` 优先」的事实钉子、两个工作流必须一致的钉子 |
| ③ | spec §9.5 的错误结论**就地更正**（不删历史，标注「已被 T87.9 推翻」并指向第十节）；`docs/packaging.md` §7.9 增补「CI 里的下载镜像变量」小节 |

### 验证（全部实测）

| 项 | 结果 |
| --- | --- |
| 真实可达 | 用算出来的 URL 做 Range GET：`…/download/v32.3.3/electron-v32.3.3-win32-x64.zip` ⇒ **206**；`…/download/v32.3.3/SHASUMS256.txt` ⇒ **206** |
| 守卫有效性 | `release/verify/t87c-mutations.mjs` ⇒ ✅ **11/11 场景全过**：ci.yml 少一个 `/` 必红 → 按 sha256 还原 → 还原后必绿 → release.yml 少一个 `/` 必红 → 还原 → **CRLF 行尾仍必绿** → **CRLF + 少一个 `/` 必红** → 还原 → 两个工作流不一致必红 → 还原 → 最终态必绿 |
| `tsc --noEmit` | ✅ exit 0 |
| `vitest` | ✅ **2269 passed / 110 files**（既有 2263 条一条不删；新增 **6** 条） |
| 本地打包 | `node scripts/pack.cjs`（`FNM_PACK_OUTPUT=release-probe`）⇒ ✅ **exit 0** |
| 字节自检 | ✅ 改动文件 BOM=N / FFFD=0 / NUL=0 / 行尾与原文件一致（`docs/changelog.md`、`docs/calibration.md` 仍是 **CRLF**） |

### 已知限制

- ⚠️ `test/t87-ci-mirror-url.test.ts` 走的是 electron-builder **内置**的 `@electron/get`
  内部路径（`app-builder-lib/node_modules/@electron/get/dist/cjs/artifact-utils.js`）
  ⇒ 将来升级 electron-builder 若改了路径，这条测试会**响亮地失败**（而不是静默跳过）；
- ⚠️ CI 的打包步骤**必须联网**下载 electron zip 与构建器二进制（干净 runner 无缓存）
  ⇒ 每次约多花 1~3 分钟；**未**加 `actions/cache`（属可选优化，另立任务）；
- ⚠️ `electronDist` **未**配置 ⇒ electron-builder 仍会下载 electron zip（配了就能完全离线，也更快）
  —— 属可选优化，另立任务。

### 遗留 / 待办

- ⚠️ **T87.7（发版 v0.2.5）** 仍卡在两件工程侧无法代替的事（**不变**）；
- ⚠️ 可选优化（**待用户拍板**）：`actions/cache` 缓存 electron-builder 的缓存目录;
  `electronDist` 指向 `node_modules/electron/dist`（彻底免下载）；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验、**轮换 NAS 口令**、
  GitHub 改口令 + 开 2FA 等老待办**不变**。

---

## 五十二、T87.10：PowerShell 把 Markdown 反引号当转义符 ⇒ 发版工作流第 10 步 ParserError（2026-11-10）

### 做了什么

**一句话**：T87.9 修好之后 **CI 全绿**（含 `Pack (smoke)`），但 **Release 工作流仍失败** ——
好在这次失败**在打包之后**（产物 artifact 都上传出来了）⇒ 揪出最后一个坑：
**PowerShell 的反引号是转义符** ⇒ 摘要那一步的 Markdown 行内代码让**整个脚本解析失败**。

### 现象与根因（**实测**，不是推断）

| 项 | 内容 |
| --- | --- |
| 触发的 run | CI **42865021458**（head `32a967c`）⇒ ✅ **success**（8 步全绿，含 `Pack (smoke)`，4m47s）；Release **42865707790**（`pack_only=true`）⇒ ❌ 失败（4m31s） |
| **关键信号** | run 页面 Artifacts 里**已经有 `unsigned-artifacts`（268 MB）** ⇒ **第 8 步 `Pack` 成功了** ⇒ 失败在**之后** |
| 失败步骤 | **第 10 步 `Summary (pack only)`**（check-run annotation 锚点 `#step:10:18`） |
| 报错原文 | `ParserError: …ps1:4` → `The Unicode escape sequence is not valid. A valid sequence is `u{ followed by one to six hex digits and a closing '}'.` |
| 根因 | **PowerShell 的反引号（`` ` ``）是转义符** ⇒ 双引号字符串里的 Markdown 行内代码 `` `unsigned-artifacts` `` 被当成「转义序列起始」⇒ `` `u `` 非法 ⇒ **整个脚本 ParserError** ⇒ 退出码 1 |
| 为什么一直藏着 | 这行是 **T87 就写好**的，但此前**每一步都先挂**（非法键 → CRLF → 404）⇒ **它从未被执行过** |

⇒ **教训**：**工作流里「跑不到」的步骤等于「没写」** —— 每一步都得能单独被执行；
⇒ 而且**单测只能验结构、验不了 shell 语义** ⇒ 必须有「结构守卫 + 本地真跑一次」两道。

### 修法（两条）

| # | 措施 |
| --- | --- |
| ① | `release.yml` 的 Summary 步骤改用**单引号**字符串；Markdown 的行内代码改用「」 |
| ② | **新守卫**（`test/t87-ci-release-workflow.test.ts`，+3 条）：所有工作流的 `run:` 块里**不许出现反引号**（PowerShell 当转义符、bash 当命令替换）；含「变异自证」；另钉「Summary 的字符串用单引号」 |

### 验证（全部实测）

| 项 | 结果 |
| --- | --- |
| 本地真跑那段 PowerShell | ✅ `release/verify/t87d-powershell-summary-probe.mjs`：`powershell.exe -EncodedCommand`（base64 UTF-16LE）⇒ **exit 0**（无 ParserError）、摘要文件生成、中文**没乱码**（写出的字节是 UTF-16LE + BOM，GitHub 读取端按 BOM 解） |
| `tsc --noEmit` | ✅ exit 0 |
| `vitest` | ✅ **2272 passed / 110 files**（既有 2269 条一条不删；新增 **3** 条） |
| CI | run **42867719484**（head `7e060c1`）⇒ ✅ **success**（8 步全绿，含 `Pack (smoke)`，5m48s） |
| 发版链路 | run **42865707790**（`pack_only=true`）⇒ ❌ 失败于第 10 步（**Pack 本身已成功**）⇒ 修完后重跑 run **42867840001** ⇒ ✅ **success**（10 步全绿，5m51s；**摘要的中文渲染正常** ⇒ UTF-16LE 的 BOM 被 GitHub 正确解码） |

### 已知限制

- ⚠️ `release.yml` 里**送签之后**的步骤（SignPath Action / 校验 / 替换资产 / 发 Release）
  在 `pack_only=true` 下**全部被跳过** ⇒ **至今没有一次真发版跑过** ⇒ 只能等 T87.7（用户申请到 SignPath）才验证；
- ⚠️ 摘要文件由 PowerShell 的 `>>` 写出 ⇒ 本机实测是 **UTF-16LE（含 BOM）**；
  GitHub 的读取端按 BOM 解码 ⇒ 正常（**下次跑完要去 run 页面目视确认一次**）。

### 遗留 / 待办

- ⚠️ **T87.7（发版 v0.2.5）** 仍卡在两件工程侧无法代替的事（**不变**）；
- ⚠️ T72 手动偏移滑块、T31~T58 肉眼复验、**轮换 NAS 口令**、
  GitHub 改口令 + 开 2FA 等老待办**不变**。

---

## 五十三、T87.11：发未签名的 v0.2.5 —— 「没签名」从口头承诺变成构建期事实（2026-11-11）

### 做了什么

**一句话**：签名申请还在审核、短期批不下来 ⇒ 这一版**照发不误**，但**把「已签名」的承诺改成实话**：
未签名路径**强制断言产物确实没有签名**（`--expect none`）⇒ 「这一版没签名」变成**构建期事实**，不是嘴上的承诺；
发版流水线**第一次真跑通**（此前每一步都先挂）；产物**改由 CI 构建**；文档补上**三条零成本的 SmartScreen 绕法**。

### 决策：为什么不等签名批下来再发

| 理由 | 依据 |
|---|---|
| 签不签、何时签**不由我们决定** | SignPath Foundation 审核中；我们最弱的一项是「可验证声誉」（0 star / 0 fork / ~73 下载、仓库 2026-11-05 才建）⇒ **有拒审风险** |
| 等下去**不划算** | 发版被外部审核无限期卡住 ⇒ 功能迭代全部停摆 |
| 签名**从来没卡住过功能** | 产物至今本就未签名（v0.2.4 就是未签名发的）；自动更新链路**早已内置**「允许安装未签名的更新包」开关 |
| 代价可控 | 未签名 ⇒ Windows 提示「未知发布者」+ SmartScreen 蓝框 ⇒ 文档给了**三条绕法**（解除锁定 / `Unblock-File` / 点「仍要运行」） |

### 发版流水线第一次真跑通（**实测**）

| 项 | 结果 |
| --- | --- |
| Release run #7 | **42980511806**（head `d5b7a21`）⇒ ✅ **success**；步骤 1–9 全绿、10–15 skipped、**16 `Verify unsigned artifacts` success**、17/18/19 success |
| CI | run **42903907937**（head `d5b7a21`）⇒ ✅ **success** |
| Release | **v0.2.5**，published **2026-11-11T07:39:18Z**，**非 prerelease** |
| 公开资产 | **3 个**：`FN-Music-Setup-0.2.5.exe`（86,106,715 B）/ `FN-Music-Portable-0.2.5.exe`（79,019,462 B）/ `latest.json`（466 B） |
| sha256（回下载实测） | Setup `09aa9e1f1e58855eae7d21754f200504b77fe13029ba58aa4fe25ee9ee351367`；Portable `74ef7b502e8171b26fd6ae934986a3c140166a648dd4e6fe8ad94809c9a9deca` ⇒ 与 Release 页面表格**逐字符一致** |
| sha512（回下载实测） | 与 `latest.json` 承诺值**完全相同**（Setup `7450d4d0…b3f`） |

### 关键机制：校验值只能「**先发布、再回填**」

NSIS 安装器**内嵌构建时间戳** ⇒ **两次构建的字节必然不同** ⇒ 「可复现 = 功能一致，**不是字节一致**」
⇒ **先填哈希再打标签 = 错数据** ⇒ 流程只能是：CI 从 tag 构建 → 发布 → **回下载算哈希** → 回填文档
（`docs/releases/v0.2.5.md`）。⚠️ 产物文件名带版本号 ⇒ 每次改名**信誉清零** ⇒ 校验值**只能逐版本给**。

### ⚠️ 更正：前面几节的「T87.7（发版 v0.2.5）仍卡在两件工程侧无法代替的事」

本节取代「四十九」「五十」「五十一」「五十二」各节遗留里的那一条：**v0.2.5 已于 2026-11-11 发布**，
走的是**未签名分支**（`sign=false`）⇒ 那个前提「等 SignPath 批下来才能发」**已不成立**。
SignPath 线**保留**，批下来后从 **v0.2.6** 起启用签名。

### 已知限制（如实标注）

- ⚠️ 这一版的公开产物**仍然没有代码签名** ⇒ Windows 提示「未知发布者」；
- ⚠️ **Smart App Control 的 Windows 11 是硬拦**（没有「仍要运行」按钮）⇒ 那类机器**装不上这一版**；
- ⚠️ 企业 AppLocker / WDAC 下未签名 exe 可能被直接拒；
- ⚠️ 「允许安装未签名的更新包」**默认仍是关的** ⇒ 用应用内一键更新**必须先勾选并保存**；
- ⚠️ 公开资产只有 3 个：`latest.yml` 与 `*.blockmap` 基于**未签名** exe 算出 ⇒ 签名改了字节它们就失效 ⇒ 不发布。

### 遗留 / 待办

- ⏳ **SignPath 审核**（GitHub 2FA 未开是硬条件）⇒ 批下来后 **v0.2.6 启用签名**；
- ⬜ **T87.7-b**：README 加 `### Code signing policy` 小节（指定措辞 + 三角色 + 隐私声明）⇒ 建议与 v0.2.6 一起做；
- ⬜ 真机复验 v0.2.5（解除锁定 → 安装 → 应用内更新）；
- ⬜ 仓库副本 `docs/releases/v0.2.5.md` **不重复**「下载校验（sha256）」节（那节由流水线追加到 Release 页面）⇒ 否则下版会出现两份、且带上一版的过期哈希。

---

## 五十四、T87.11-b：CI 上签名探测加载不了 PowerShell 安全模块 ⇒ 「探测失败」被误报成「有签名」（2026-11-11）

### 做了什么

**一句话**：v0.2.5 的第一次真发版挂在**最后一道闸门**（第 16 步 `Verify unsigned artifacts`）⇒ 根因是
**签名探测脚本在 CI 上加载不了 `Microsoft.PowerShell.Security`** ⇒ 工具把「探测失败」降级成 `UnknownError`
⇒ 被 `--expect none` **误判成「有签名」**（**方向说反**）⇒ 工作流失败。

### 现象与根因（**实测**，不是推断）

| 项 | 内容 |
| --- | --- |
| 触发的 run | Release **42901166145**（head `8ad8d9a`）⇒ ❌ 失败于**第 16 步**；前面 15 步全绿 |
| 报错原文 | `CouldNotAutoloadMatchingModule`（stderr 是 **CLIXML**）⇒ 三个产物**全部探测失败** |
| 根因 | Windows runner 默认 shell 是 **pwsh 7**，它的 `PSModulePath` 指向 **PS7 的模块目录** ⇒ **Windows PowerShell 5.1 找到同名但为 .NET Core 编译的模块** ⇒ 自动加载失败 |
| 为什么「方向说反」很危险 | 探测失败 ⇒ `UnknownError` ⇒ 「既不是 Valid 也不是 NotSigned」⇒ `--expect none` 判定「**不是未签名**」⇒ 报「**有签名**」 |
| 本机**复现不了** | 本机只有 PS 5.1、`PSModulePath` 正常 ⇒ 只能靠**结构守卫 + CI 端到端**钉住 |

### 修法（三处）

| # | 措施 |
| --- | --- |
| ① | `powershellEnv()` 把 **5.1 自己的系统模块目录前置**到子进程 `PSModulePath`（只前置、不替换） |
| ② | 探测脚本按 **`$PSHOME` 绝对路径**显式 `Import-Module` 安全模块（绕开搜索顺序；失败再退回自动加载） |
| ③ | 新增 `probeFailed` 标记 —— **探测失败单独报告、跳过按状态的判定**；**闸门仍 fail-closed**（失败 ⇒ 工作流失败） |

⚠️ 另：失败原因里原本**整条 base64 命令行**被塞进报错 ⇒ 改为可读摘要（`describePowerShellFailure()`）。

### 验证（全部实测）

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | ✅ exit 0 |
| `vitest` | ✅ **2290 passed / 110 files**（既有 2281 条**一条不删**；新增 **9** 条：结构守卫 4 + 探测失败语义 3 + 端到端真跑 1 + 工作流行尾 1） |
| Playwright E2E | ✅ **34** 条全绿 |
| 字节自检 | ✅ 6 个文件 bad=0 |
| CI | run **42903907937**（head `d5b7a21`）⇒ ✅ **success** |
| 发版 | 标签 **v0.2.5 移到 `d5b7a21`**（`b7b2a28…e3edc31`，forced update）后重跑 ⇒ Release run **42980511806** ⇒ ✅ **success**，第 16 步 **success** |

⚠️ **为什么必须移动标签**：工作流的 `Checkout` 用 `ref: ${{ inputs.tag }}` ⇒ **打标签后跑的是标签里的代码**
⇒ 修复不进标签就发不出 v0.2.5（该标签刚推、尚无 Release、无人下载 ⇒ 移动不影响任何已发布产物）。

### 遗留 / 待办

- ⏳ **v0.2.6 启用签名时**，签名分支（`sign=true`）的闸门**至今一次都没真跑过** ⇒ 那时要再端到端验一次；
- ⬜ T87.7-b（README 的 Code signing policy 小节）⇒ 与 v0.2.6 一起做。

---

## 五十五、T87.12：自动更新「安装包名不合法」—— 渲染层回传了**路径**，主进程要的是**文件名**（2026-11-11）

### 做了什么

**一句话**：用户真机复验 v0.2.4 → 点「启动安装」⇒ 红框「安装包名不合法」；
根因是**契约错配** —— `update:install` 这条 IPC 的参数**从头到尾都是「裸文件名」**，
而渲染层回传的是主进程给的**绝对路径** ⇒ 主进程按「裸名」净化 ⇒ 直接判非法。
修法：**主进程把落盘用的安全文件名随下载结果一起返回，渲染层原样回传**
（主进程的安全边界**一字不动**）。

### 现象与根因（**实测**，不是推断）

| 项 | 内容 |
| --- | --- |
| 触发 | 用户真机（v0.2.4）→ 检查更新 → 下载（82.1 MB，**成功**）→ 点「启动安装」⇒ 红框「安装包名不合法」 |
| 失败点 | `electron/update.ts` 的 `sanitizeFileName()` 返回 `null` ⇒ `'安装包名不合法'` |
| 链路 | ① `src/state/updateStore.ts`：渲染层 `bridge.installUpdate(download.path)` ⇒ 传**绝对路径**<br>② `electron/preload.ts`：参数叫 `name`<br>③ `electron/ipc.ts`：按**名字**理解<br>④ `electron/update.ts`：`sanitizeFileName(name)` ⇒ **含 `\` 一律判非法** |
| 契约在别处是**写死的** | `shared/playerBridge.ts`：「`@param name` 已下载的**文件名**」；`electron/update.ts` 的控制器注释：「启动时**不许**用渲染进程传来的路径 —— 只接受**文件名**」⇒ **渲染层是唯一违约方** |
| ⚠️ **方向** | 失败发生在**授权已放行、下载已成功**之后 ⇒ **签名闸与 SHA-512 复核都还没轮到执行**，就被更前面的一道检查挡下来了 |
| 旁证 | `install()` 里那道「路径必须仍在下载目录里」的 `isInsideDir` 是**死代码**（输入刚被压成裸名 ⇒ `join(destDir, safe)` 必然在目录内）⇒ **两处校验互相矛盾** |

### 为什么一直没发现（**测试缺口**，不是运气）

| # | 缺口 | 后果 |
| --- | --- | --- |
| ① | `test/update-store.test.ts` 的假桥**只记录参数、从不校验** | 它还把「回传路径」当**正确行为**钉死了 ⇒ **反向锁死**了这个 bug |
| ② | **`createUpdateController` 一条测试都没有** | 「check → download → install」的编排整段**零覆盖**（bug 就住在这段） |
| ③ | e2e 只走到「签名不过 ⇒ 按钮禁用」 | **没点过「启动安装」** |
| ④ | 真机复验一直挂着 | calibration 里明写「**待用户复验**」 |

⇒ **教训**：**假桥只验证「调用发生了」，不验证「参数对不对」** ——
跨进程契约必须有**一端带真实校验**的测试。

### 修法（**改渲染层这一端**；主进程的安全边界**一字不动**）

| # | 措施 |
| --- | --- |
| ① | `shared/update.ts`：`UpdateDownloadResult` 加 `name`（主进程落盘用的**安全名**） |
| ② | `electron/update.ts`：`downloadUpdate()` 成功时返回 `name: safeName` |
| ③ | `src/state/updateStore.ts`：`bridge.installUpdate(download.name)`（**不再回传路径**） |

❌ 明确**不做**：不把主进程改成「接受路径再取 basename」（那会放松「只收裸名」这条刻意的硬契约）；
不在渲染层自己算 `basename()`（渲染层不许碰路径）；SHA-512 复核 / 签名闸 / `isInsideDir` 三道闸**一条都不动**。

### 验证（全部实测）

| 项 | 结果 |
| --- | --- |
| **先红后绿** | 新增的「渲染层 ↔ 主进程契约」测试在实现前**红**：`expected '安装包名不合法' to be null`（15 ms 内复现真机事故）⇒ 实现后转绿 |
| `tsc --noEmit` | ✅ exit 0 |
| `vitest` | ✅ **2293 passed / 110 files / 0 failed**（既有 2290 条**一条不删**；新增 **3** 条） |
| Playwright E2E | ✅ **34** 条全绿 |
| 字节自检 | ✅ 7 个文件 bad=0 |
| 被改写的那条断言 | `test/update-store.test.ts` 原断言「回传**路径**」是对的 ⇒ **前提被真机实测推翻** ⇒ 改写为**更强**的新断言：**必须回传裸文件名、不含路径分隔符** |

### 遗留 / 待办

- ⚠️ **这个 bug 在已发布的 0.2.4 与 0.2.5 里都有** ⇒ 用户要立刻装上 v0.2.5，**仍需手动下载安装包**（本修复要等含它的下一个版本）；
- ⬜ **真机复验**需要**新构建**：勾「允许安装未签名的更新包」→ 保存 → 检查 → 下载 → 启动安装 ⇒ 安装器真的起来；
- ⚠️ `downloadUpdate()` 里 `sanitizeFileName(file.name) ?? 'update.exe'` 的兜底：清单文件名带分隔符时落盘名与清单名对不上 ⇒ `findCached()` 查不到 ⇒ 未签名包会因「没有清单里的 SHA-512 可核对」被拒（**fail-closed，安全**）⇒ **不在本轮范围**；
- ⬜ T87.7-b、SignPath 审核、开 2FA 等老待办**不变**。
## 五十六、T87.17：无证书可信发布 —— 用 GitHub attestation 替代代码签名证书（2026-11-12）

### 背景：SignPath Foundation 的申请**已被拒**

| 项 | 事实（2026-11-12 实测） |
| --- | --- |
| 拒审原因 | **可见度不足**，不是代码质量（同生态另有 3 个项目同因被拒：WinSight / Rivulet / SteamWrapper） |
| 本仓库的短板 | star = 0 / fork = 0 / 仓库 2026-11-05 才建 / ~73 下载 |
| 结论 | 重报大概率再拒 ⇒ 用户明确「不再申请」 |

### ⚠️ 合法边界（本任务的红线）

| 允许 | 禁止 |
| --- | --- |
| 诚实未签名发布（显式声明 + 可验证的信任锚） | 伪造签名 / 伪造证书 |
| 自签证书仅用于**本机 / 内部**把链路跑通 | 冒用他人证书或主体名 |
| 「产物到底签没签」在 CI / 文档 / 客户端里**一致** | 文档或 Release 页面声称「已签名」而实际未签 |

### 现状盘点（实测，不是推测）

| 能力 | 状态 |
| --- | --- |
| CI 未签名发布路径 | ✅ 已就绪（`sign = false` ⇒ `--expect none` ⇒ 清单 ⇒ 发 Release；v0.2.5 就是这么发的） |
| 客户端「允许安装未签名的更新包」 | ✅ 已就绪（T82 加开关 / T85 修判定 / T87 修签名者匹配） |
| 更新源可达 | ✅ `curl -sIL` 打到 `releases/latest/download/latest.json` ⇒ 302 ⇒ 302 ⇒ **200 / 466 B** |
| SHA-512 / 同源 / 路径穿越硬闸 | ✅ 已就绪（`electron/update.ts`） |
| **发布者身份的可验证性** | ❌ **没有**（只有 sha256，而 sha256 与 exe 在**同一个 Release 页面** ⇒ 改得了页面就改得了两者） |

### 关键机制：attestation = 没有公开证书时的「发布者身份」信任锚

| 项 | 内容 |
| --- | --- |
| 是什么 | GitHub 官方的 **artifact attestation**（SLSA build provenance，Sigstore 公共实例签发） |
| 证明了什么 | 「这个文件确实是**本仓库的 CI** 从**这个 tag** 构建出来的」，且换一字节就验不过 |
| 成本 | **公开仓库全部计划免费**（本仓库 `visibility: public`，2026-11-12 查 GitHub API 确认） |
| Action | `actions/attest@v4`（`actions/attest-build-provenance` v4 起已只是它的包装器） |
| 需要的权限 | `id-token: write`（换 OIDC）+ `attestations: write`（落库） |
| 用户怎么验 | `gh attestation verify FN-Music-Setup-0.2.6.exe --repo pure2199/sanlos-music` |

### 改动

| 文件 | 内容 |
| --- | --- |
| `.github/workflows/release.yml` | 加 `id-token: write` + `attestations: write`；新增 `Attest build provenance` 步骤（`subject-path` 覆盖两个 exe + `latest.json`）；Step Summary 与 Release 说明给出验证入口；Release 说明按 `SIGNED` **分两种形态**写（不许写死） |
| `src/components/SettingsPanel.tsx` | 未签名提示补「怎么验证」；新增「怎么验证这个安装包」说明块（`update-verify-hint` / `update-verify-howto`） |
| `test/t87-ci-release-workflow.test.ts` | **追加** T87.17 契约测试 **8** 条（含**变异自证**） |
| `test/settings-page.test.tsx` | **追加** T87.17 界面契约 **3** 条 |
| `docs/changelog.md` | 顶部「当前状态」提示块 + 0.2.5 条目内「后续」块（**不改写历史行**） |
| `docs/packaging.md` | §7.9 更正 Certum 结论（**不要求 star**，是 €49 付费产品）+ 新增 §7.10 |
| `docs/signing.md` / `CODE_SIGNING_POLICY.md` / `README.md` | 当前状态注记 + 「未签名 + 怎么验」 |

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | ✅ exit 0 |
| `vitest` | ✅ **2304 passed / 110 files / 0 failed**（既有 2293 条**一条不删**；新增 **11** 条） |
| 字节自检 | ✅ bad=0 |
| Playwright E2E | 未跑（本任务没动运行时行为；T87.18 与发版一起跑） |

### 遗留 / 待办

- ⬜ **发 v0.2.6** 并端到端验证（attestation 真跑出来 + 一键更新真装上 + 真实 Electron 实证「应用内下载的包不带 Zone.Identifier」）⇒ 单独任务（T87.18，涉及发版 ⇒ 需先确认）。
- ⬜ README 的 `### Code signing policy` 展示位 + `.github/CODEOWNERS`（SignPath 复议时必备）。
- ⚠️ `sign` 输入默认仍是 **true**（既有契约不许削弱）⇒ 当前发版必须**手动取消勾选**（签名路径必然失败在缺 5 个 secret / variable）。
- ⚠️ 剩下 2.52 GB 缓存清理、GitHub 2FA / 改口令、NAS 口令轮换等老待办**不变**。

## 五十七、T89-②：userData 目录改名 —— `%APPDATA%\fnmusic-desktop` → `%APPDATA%\Sanlos Music`（2026-11-12）

### 背景

软件早已改名「Sanlos Music」（T49/T50），**用户数据目录**却还叫 `fnmusic-desktop`。
目录名不是随便定的：`package.json` 的 `name` 决定 Electron 的 `app.getName()`
⇒ 决定 userData 默认路径。

⚠️ **不能直接改名**：那目录里放着**偏好**（`prefs.json`）、**登录凭据**（`session.bin`，
DPAPI 加密）、**本地曲目登记**（`local-library.json`）以及 Chromium 自己的
`Local Storage` / `Network` / `Preferences` ⇒ 直接换目录 = 用户升级后**配置与凭证全丢**，
而且**不报错**、最难排查。

### 探针实测（5 条结论，**不靠推理**）

探针：`release/verify/t89-2-userdata-probe.cjs`（独立脚本）+
`release/verify/t89-2-probe-app/`（带真实 `package.json` 的探针应用）。

| # | 问题 | 实测结果 |
|---|---|---|
| ① | `app.getPath('appData')` / `app.getPath('userData')` 在 ready 之前能取到吗？ | ✅ 能（`appData` = `%APPDATA%`） |
| ② | `app.setPath('userData', …)` 能用吗？要目录**已存在**吗？ | ✅ 能，**且不要求存在** |
| ③ | ⚠️ `app.setPath('userData', …)` 会不会**覆盖** `--user-data-dir`？ | ⚠️⚠️ **会**（`userDataBefore` = 开关给的临时目录，`setPath` 之后变成我们指定的新路径）⇒ **这条路会摧毁 E2E 的数据隔离**（E2E 靠 `--user-data-dir` 把 userData 指到临时目录，见 `e2e/helpers/app.ts` 第 18–23 行）⇒ **弃用** |
| ④ | `package.json` 加 `productName` 会怎样？ | ✅ `app.getName()` = `Sanlos Music`，userData = `%APPDATA%\Sanlos Music`；⚠️ **但带 `--user-data-dir` 时开关仍然优先** ⇒ **E2E 隔离不受影响** ⇒ **走这条** |
| ⑤ | ⚠️ 模块**第一行**时，userData 目录**已经被创建**了吗？ | ⚠️ **已经创建了，而且是空的**（`existsAtFirstLine: true` 而 `entriesAtReady: []`）⇒ **Electron 在跑 main.js 之前就把目录建好了** ⇒ **不能整目录 `rename`**（目标已存在会失败）⇒ 只能「逐项搬入 + 同名不覆盖」 |

### 落地

- `package.json` 加 `"productName": "Sanlos Music"` ⇒ 目录名由它决定。
  ⚠️ `name` **保留**（它就是旧目录名的由来）；⚠️ `appId`（`com.fnmusic.desktop`）**不动**
  —— 它决定 Windows 安装路径 / 注册表项 / 升级链。
  ⚠️ `electron-builder.yml` 本来就有 `productName: Sanlos Music` ⇒ **打包产物名一字不变**。
- `electron/userDataDir.ts`（新）：把旧目录内容**逐项搬**进新目录：
  - 同名 ⇒ **不覆盖**（旧的留在旧目录里）⇒ **没有任何数据被删**；
  - 搬完写标记 `userdata-migration.json`（幂等锚点 + 「数据去哪了」的自述）；
  - ⚠️ **有搬不动的项时绝不写标记** ⇒ 下次启动会**再试一次**（标记的含义是「已经搬完了」）；
  - 跨设备改名失败（EXDEV）⇒ 降级为「复制 + **保留源**」⇒ 仍然不丢数据；
  - 搬空之后的旧目录（空壳）被清掉 ⇒ 用户不用再看到一个陌生文件夹。
- **守卫**（本任务最要紧的一层）：
  - `userData` 被人为改走（E2E / 便携版）⇒ **完全不迁移** ⇒ 跑测试不会动用户真实数据；
  - 当前生效的 userData **就是**旧目录 ⇒ 拒绝（不搬自己脚下的地板）。
- 调用时机：`electron/main.ts` **模块作用域最前面**（`registerAppSchemes()` 之前）
  ⇒ 早于 `app.whenReady()` ⇒ 早于 Chromium 读 profile ⇒ 搬过去的 Chromium 数据**能被读回来**。

### 验证

- `tsc --noEmit` exit 0；`vitest` **2316 passed / 111 files / 0 failed**（既有 2304 + 新增 12）。
- 新增 `test/user-data-dir.test.ts` **12 条** —— 用**真实临时目录**（不 mock fs）
  ⇒ 验的是真代码路径；只有「改名必失败」这一条靠**注入 fs** 制造（真造不出跨设备场景）。
- **变异自证 4 处全部被抓住**（`release/verify/t89-2-mutation-check.mjs`，每轮都复原并校验 sha256）：
  守卫失效 / 同名改成覆盖 / 去掉幂等锚点 / 有失败项也写标记 ⇒ 对应测试**立刻红**。
- ⚠️ **自测当场抓到 2 个真 bug**（都已修）：
  1. **守卫判定顺序反了** —— 「当前就在旧目录」被报成「被改走」⇒ 排查时指向错误的方向；
  2. **幂等检查排在「旧目录是否存在」之后** —— 搬完旧目录已被删 ⇒ 第二次启动报成
     `no-legacy`（而不是「已经迁过了」）⇒ 同样误导排查。

### 待真机确认

- [ ] 装 v0.2.6 后**首次启动**：旧目录被搬走、**偏好与登录态还在**（装完跑一次就知）。
- [ ] **回滚到 v0.2.5** 的影响：旧目录已搬空 ⇒ 旧版本会显示「未登录 + 偏好回默认」
  ⇒ **数据没丢**（在新版本里改回去即可）⇒ 这条要写进 v0.2.6 的发布说明。

## 五十八、T89-③：自动更新的临时安装包目录 —— 旧安装包不清理（2026-11-12）

### 背景

自动更新把安装包下到 `%TEMP%\fnmusic-update\`，**只进不出**：

- 每更新一版就多留一份 **86 MB**（实测 v0.2.5 的 Setup = 86,106,756 B），旧的永远不走；
- 下载中断留下的 `.part` 碎片也留着；
- **本机实测残留**：`%TEMP%\fnmusic-update\FN-Music-Setup-9.9.9.exe`（33 字节，
  LastWriteTime 2026-11-12 17:51:31）。

⚠️ 那 33 字节**不是用户下载的**，是 **E2E 造的**：E2E 里「自动更新：检查到新版本 →
下载校验通过 → 签名不过就不许安装」那条用例会**真的下载一次**（下载是被测对象），
而 mock 的清单版本是 `9.9.9`。

⚠️⚠️ 根因：**E2E 只隔离了 `--user-data-dir`（userData），没隔离 `%TEMP%`**
⇒ E2E 与真实应用**共用**同一个更新目录。

### 关键事实：「下载状态」是**内存态** ⇒ 跨会话的残留一定是垃圾

`src/state/updateStore.ts` 的 `download` / `status` **只存在内存里**（Zustand，不落盘）：

```ts
if (!download || download.status !== 'ok') {
  set({ status: 'error', error: '还没有已下载的安装包' })
  return
}
```

⇒ **重启应用后点「启动安装」必然报「还没有已下载的安装包」**
⇒ 「下载了、关掉应用、明天再装」这个流程**本来就不存在**
⇒ **应用启动时还躺在更新目录里的文件，按定义就是上一轮会话的垃圾** ⇒ 可以放心清空。
（这不是「顺手清理」，是「把上一轮会话的残留清掉」。）

### 落地

| 文件 | 改动 |
|---|---|
| `electron/updateCleanup.ts`（新） | 清理算法：只删**普通文件**、子目录一律跳过、删不掉的记下来**不抛错**、目录不存在**不算错** |
| `electron/update.ts` | **下载成功后**调一次清理（`keep` = 本次那个文件）⇒ 同一会话里连下两版不会占两份 86 MB；⚠️ **下载失败时走不到这里** ⇒ 失败不会把用户已有那份弄丢 |
| `electron/main.ts` | **启动时**清空一次更新目录；更新目录支持 `FNM_UPDATE_DIR` 覆盖（默认仍 `%TEMP%\fnmusic-update`） |
| `e2e/helpers/app.ts` | 每个夹具用 `FNM_UPDATE_DIR=<userData临时目录>/update` ⇒ **E2E 不再碰用户真实 `%TEMP%`**，也不会清掉用户**待装**的安装包 |

⚠️ **`FNM_UPDATE_DIR` 只在主进程读**（渲染层永远不碰）⇒ 不违反「渲染层不碰文件系统」。
⚠️ 默认值**不变**：安装包放 `%TEMP%` 是对的（系统会清理；且不该进 `%APPDATA%` 漫游配置）。

### 验证

- `tsc --noEmit` exit 0；`vitest` **2322 passed / 112 files / 0 failed**（既有 2316 + 新增 6）。
- 新增 `test/update-cleanup.test.ts` **6 条**（真实临时目录；只有「某个文件删不掉」靠注入 fs）。
- **E2E 34 条仍全绿**，且跑完后 `%TEMP%\fnmusic-update` **没有新增文件**（隔离生效）。

### 待真机确认

- [ ] 装 v0.2.6 后**启动一次** ⇒ 旧的 `FN-Music-Setup-9.9.9.exe` 残留被清掉。

## 五十九、T89-④：Fluent 主题的强调色取自封面主色（2026-11-12）

### 先纠正一件事：取色**早就有了**，缺的是另一件事

开工前核对规格与代码，结论与最初的判断不同，**必须写下来**：

| 规格条目 | 位置 | 实际状态 |
|---|---|---|
| 「全屏播放页：封面取色背景 + 逐行歌词」 | `2026-11-02-…-design.md:290` | ✅ **已实现**（T15 的 `extractCoverColor` + `--fnm-fullplayer__tint` + `full-player.css` 的渐变背景）。T31 还修过「取色白底」缺陷（失败不缓存 + 有限重试），真机实测 `tintVar=#d0cbc7` |
| 「Windows 11 Fluent 风：强调色 = **取自封面取色的** Fluent 强调色」 | `2026-11-02-…-design.md:281` | ❌ **本任务之前没做** —— `--accent` 写死 `#0a66ff` / `#0067c0` |

⇒ 本节做的是**主题级的强调色**，不是「再加一套取色」。

⚠️ 顺带更正了 **Step K** 的过时陈述：原文写「⚠️ 本版本**没有**主色提取实现，取色子项无代码可校准」
—— 那是 **T15 之前**的状态，现在**是假的** ⇒ 已改成说明「平均色（T15 起）+ 主色（T89-④）」两套实现。

### 采样策略（Step K 的「取色子项」现在有答案了）

| 项 | 值 |
|---|---|
| 采样尺寸 | 缩到 **8×8**（`COVER_SAMPLE_SIZE`）后取像素（越小越快） |
| 取像前提 | 封面走 `fnm://` 代理 ⇒ 与页面**跨源** ⇒ 必须 `crossOrigin = 'anonymous'`（**且在设 `src` 之前**），否则 canvas 被污染、`getImageData` 抛 SecurityError ⇒ **永远取不到色**（代理对所有响应带 `access-control-allow-origin: *`，普通 GET 不触发预检） |
| 平均色 | 64 个像素求均值（**T15 原算法，一字未改**）⇒ 全屏播放页的取色背景用它 |
| 主色 | 滤掉太暗（`L<0.12`）/ 太亮（`L>0.92`）/ 太灰（`S<0.18`）/ 透明（`alpha<128`）→ 色相分 **12 桶** → 取权重最大（权重 = 饱和度 × 亮度居中度）的桶 → 桶内按权重平均 **HSL**（不平均 RGB ⇒ 不损失饱和度） |
| 一个可用像素都没有 | 返回 `null`（纯黑 / 纯白 / 全透明封面） |

### 「Fluent 强调色」的判定（**这一步才是难点**）

强调色会被当成**按钮底色**，上面的文字是 `--accent-text: #ffffff`
⇒ **白字压在强调色上** ⇒ 必须满足 **WCAG AA 对比度 ≥ 4.5**。而封面主色是**任意的**。

| 步骤 | 规则 | 为什么 |
|---|---|---|
| ① 没有色相就放弃 | `S < 0.15` ⇒ `null` | 灰白封面**没有色相** ⇒ 硬凑只会得到「脏色」⇒ 不如保持主题默认色 |
| ② 饱和度夹紧 | `S ∈ [0.45, 0.85]` | 太灰不像强调色；太艳刺眼 |
| ③ 亮度夹紧 | `L ∈ [0.22, 0.55]` | Fluent 强调色的观感区间（Windows 蓝 `#0067c0` ≈ `0.42`） |
| ④ **对比度不够就继续压暗** | 白字对比度 `< 4.5` ⇒ `L -= 0.02` 直到够 | ⚠️ **对比度优先于「保留原色」** —— 强调色看不清比颜色不准严重得多 |

产物三个值：`--accent`（强调色）、`--accent-hover`（同色相 `L-0.12`）、`--focus-ring`（强调色 + 35% 透明）。

### 落地

| 文件 | 改动 |
|---|---|
| `src/components/coverColor.ts`（新） | 共享取色模块：T15 的**平均色原样搬** + 新增**主色** + 两个缓存 |
| `src/pages/FullPlayerPage.tsx` | 改成从新模块取，并 **re-export** 旧名字 ⇒ **既有 import 路径不断、既有测试一字不改** |
| `src/ui/accentColor.ts`（新） | 纯色彩数学：hex↔HSL、WCAG 相对亮度与对比度、`toFluentAccent`（**无 DOM ⇒ 可完整单测**） |
| `src/ui/useCoverAccent.ts`（新） | hook：当前歌曲封面 → 主色 → 转换 → 写 `<html>` 的内联变量 |
| `src/App.tsx` | 调用 `useCoverAccent()` |

⚠️ **只覆盖既有令牌**（`--accent` / `--accent-hover` / `--focus-ring`）——
**不新增** CSS 变量（`tokens.css` 的变量集合有契约测试钉着：两套主题的语义变量集合必须完全相同）。
⚠️ **只在 Fluent 主题下生效**（规格把 Apple 风写成「单色高饱和点缀」= 固定色）；
切回 Apple 风 ⇒ **移除内联覆盖** ⇒ 回到 CSS 里的主题色。
⚠️ 取不到色（无封面 / 加载失败 / 灰白封面）⇒ **移除覆盖** ⇒ 保持主题默认色。

### 验证

- `tsc --noEmit` exit 0；`vitest` **2349 passed / 114 files / 0 failed**（既有 2322 + 新增 27）。
- 新增 `test/accent-color.test.ts` **16 条** + `test/cover-accent.test.tsx` **11 条**。
  含一条**性质测试**：扫 15° × 6 档饱和度 × 7 档亮度（> 100 个颜色），
  断言**每一个**转出来的强调色，白字对比度都 **≥ 4.5**。
- 既有 `test/lyric-view.test.tsx` 的取色相关用例 **一字未改** 且 **65 条全绿**。
- **E2E 34 条全绿**。

### 待真机确认

- [ ] ⚠️ **你现在用的是 Apple 风 ⇒ 这个效果默认看不到** ⇒ 切到「Windows 11 风」才看得到。
- [ ] 切到 Fluent 后播不同歌曲 ⇒ 强调色是否随封面主色变化、观感是否可接受。
- [ ] ⚠️ 全屏舞台的 `--accent` 在**封面取色背景**上的对比度（规格 `2026-11-09-…:163` 就写着「需真机看一眼」）。
## 六十、T89-⑥：T87.18 本机 mock 实证（自动更新链路 · 无证书发布）

> 日期：2026-11-12　　结论：**13 / 13 条全部成立**；过程中**发现并修掉一个 P0 缺陷**

---

### 一、为什么做这件事

T87 定的「无证书可信发布」路线是「**诚实未签名 + GitHub attestation**」。
但「未签名包能不能在**真机**上真的装上去」这件事，此前**从未被验证过**：

| 覆盖手段 | 为什么没覆盖到「正路」 |
|---|---|
| E2E `smoke.spec.ts`「自动更新：检查到新版本 → 下载校验通过 → 签名不过就不许安装」 | 只测**负路**（未签名 ⇒ 「启动安装」按钮被**禁用**）⇒ **走不到启动那一步** |
| `test/update.test.ts` | 全部**注入替身** `openPath` ⇒ 从不碰真实的启动器 |

⇒ T87.18 就是把「正路」在**真 Electron + 真 86 MB 安装包**上跑一遍。

---

### 二、实证怎么做

- **探针**：`release/verify/t89-6-entry.ts`（TS）→ esbuild 打包成 `release/verify/t89-6-bundle.cjs`
  → `electron.exe` 直接跑（**与生产主进程同一套 esbuild CJS 打包** ⇒ 行为一致）。
- **真实生产代码**：`electron/update.ts` 的 `createUpdateController` + `electron/http.ts` 的
  `createHttpStack`（**Chromium 分区栈**，不是 Node 的 undici）。
- **更新服务器**：回环 `http://127.0.0.1:38000` 上的 mock，静态托管 `release/` 目录
  ⇒ 清单与安装包**天然同源**（`resolveFileUrl` 的同源硬要求天然满足）。
- **清单**：**生产脚本** `scripts/publish-manifest.mjs` 生成的 `release/latest.json`
  （version `0.2.6`，sha512 `5b822aba…`）。
- **安装包**：**真的产物** `release/FN-Music-Setup-0.2.6.exe`（86,109,536 B），不是占位字节。
- **模拟「用户当前装的是 0.2.5」**：`currentVersion` 传 `0.2.5`（生产里这个值来自 `app.getVersion()`）。
- **安全约束**：安装器起来后**立刻 kill**（不点任何按钮）⇒ 不会覆盖已装的 0.2.5；
  下载目录与 Electron userData 全在 `release/verify/` 下 ⇒ 不碰用户真实数据。

---

### 三、结论（13 条，全部成立）

| # | 断言 | 实测 |
|---|---|---|
| F0 | 生产路径（`defaultOpenPath`）能取到 Electron 的 `shell` | 取到了 |
| F0b | 对 86 MB 未签名安装包跑 PowerShell Authenticode 探测 | `NotSigned`，耗时 **599 ms** |
| F1 | 回环 mock 服务器启动 | `http://127.0.0.1:38000` |
| F2 | 清单来自生产脚本 | version `0.2.6`，1 个文件，86,109,536 B |
| F3 | 检查更新（Chromium 分区栈） | `available`（0.2.6 > 0.2.5） |
| F4 | 下载 + SHA-512 校验 | `ok`，`sha512Ok=true`，字节数与清单一致，**耗时 1.0 s** |
| F5 | 下载产物的签名状态 | `NotSigned`（本项目未做代码签名） |
| F6 | 落地文件有没有 Zone.Identifier（Mark of the Web） | **只有 `:$DATA`** ⇒ **没有 MotW** ⇒ 不触发 SmartScreen 蓝框 |
| F7 | 未开「允许安装未签名包」时启动安装器 | **拒绝**：「安装包没有代码签名，且未开启…" |
| F8 | 开了授权、走**生产路径** | **`ok` ⇒ 安装器真的被拉起来** |
| F9 | 开了授权、显式注入 `shell.openPath` | `ok`，进程 `FN-Music-Setup-0.2.6#22260` |
| F10 | 安装器起来后立刻 kill | 已受理，**残留 0** |
| F11 | 下载后**篡改 1 字节**再装 | **拒绝**：「安装包 SHA-512 与清单不一致 → 不允许安装」 |

⚠️ **F6 的含义**：应用内更新走的是**自己写的下载**（不是浏览器）⇒ 文件**天然不带 MotW**
⇒ 用户点「启动安装」时**不会**看到 SmartScreen 蓝框（下载安装包时那个蓝框是在**浏览器**里出现的）。

⚠️ **F11 的含义**：哈希闸门是**真的**在跑，不是摆设——下载完到启动之间改 1 字节就装不上。

---

### 四、⚠️ 实证过程里发现并修掉的 P0

**「启动安装」在真机上必然失败。**

- **根因**：`electron/update.ts` 的 `defaultOpenPath()` 用 `globalThis.require('electron')`
  惰性取 `shell`，而 **Electron 主进程里 `globalThis.require` 是 `undefined`**
  （实测 Electron 32.3.3 / Node 20.18.1；模块作用域的 `require` 则是 `function`）。
- **症状**：点「启动安装」必报
  「启动安装包失败：当前进程没有 Electron 运行时，无法启动安装包」。
- **为什么一直没被发现**：E2E 只测负路；单测全部注入替身 ⇒ **真机路径从未被跑过**。
- **它是孤例**：全仓库 7 个模块（`http` / `ipc` / `localLibrary` / `oauthWindow` / `tray` /
  `session` / `schemes`）都用**模块作用域**的 `require`（`declare const require` + `typeof` 守卫），
  **只有 `update.ts` 用错了** ⇒ 本次是**改回既有惯例**，不是引入新写法。
  ⇒ 也正因如此，**出网栈**（自签 NAS 的证书放行）一直好使：`http.ts` 的
  `resolveElectronSession()` 用的是模块作用域 `require` ⇒ 主进程里拿得到 `session`。
- **修法**（两处都改）：
  1. `electron/update.ts`：`resolveElectronShell()` 改成**优先用模块作用域的 `require`**；
     抽出可注入的接缝 `pickRequire()` / `resolveElectronShellFrom()`（便于单测）。
  2. `electron/main.ts`：`createUpdateController({ …, openPath: (target) => shell.openPath(target) })`
     ⇒ 生产路径**不再依赖任何惰性解析**。
- **修完复测**：F0 / F8 由 **FAIL 转 PASS** ⇒ **13 / 13**。
- **回归测试**：新增 `test/update-launch-installer.test.ts`（**15 条**），
  钉住 `require` 的**挑选顺序**、惰性解析的各种容错分支、`defaultOpenPath` 不抛错。

---

### 五、实证过程中踩到的坑（都是**工具链**的，不是产品的）

1. **`electron.exe` 是 Windows GUI 子系统程序** ⇒ PowerShell 的 `&` **不等它**
   ⇒ 探针「跑完了」其实**还在跑**（第一次实跑就是这样卡住的）。
   ⇒ 改用 `Start-Process -Wait`。
2. **`Get-Process` 与 `ForEach-Object` 分成两行** ⇒ 管道断开 ⇒ 拿到的是 PowerShell 的
   **表格文本**（第一列是 Handles，**不是 PID**）⇒ `taskkill` 打空 ⇒ 「杀不掉」。
   ⇒ 必须写成**一行**。
3. **`powershell.exe -EncodedCommand` 从外层 PowerShell 调用会直接失败（exit -1、无输出）**，
   但**从 Node 的 `execFile` 调用是好的** ⇒ **别在 bash 里用同样写法自测**（会误判成「脚本写错了」）。
4. **`ConvertTo-Json -InputObject @()` 在 PowerShell 5.1 上对空数组会出错** ⇒ 改用逗号拼接。
5. **Electron 的 `shell.openPath` 对不存在的路径是「永不 resolve」的** ⇒ 探针写报告时调它
   ⇒ 整个探针挂住、报告写不出来。⇒ 只记录「能不能拿到 shell」，**别真调**。

---

### 六、这次实证**没有**覆盖的

- 跑的是**仓库构建**（等价于 `electron .`），**不是打包产物** ⇒ 装上 v0.2.6 后
  **仍需用户手动点一次「启动安装」复验**。
- **没有点安装器的任何按钮** ⇒ 「点下一步会怎样」未验证。
- 模拟的当前版本是 `0.2.5`（`currentVersion` 注入），**不是**真实的 `app.getVersion()`。
- NSIS 安装器会在 `%TEMP%` 留 `ns*.tmp` 解压目录（本轮又留 1 个）⇒
  **工作区外的目录**本机删不掉（可恢复删除通道只允许工作区外的**普通文件**）。

---

### 七、本机残留清单

| 位置 | 内容 | 处置 |
|---|---|---|
| `%TEMP%\ns*.tmp` | NSIS 解压目录：本轮 `nsy48CB.tmp`；旧的 4 个在 2026-09-01 / 11-09 / 11-12 17:21 / 17:52 | 工作区外的**目录** ⇒ 本机删不掉，需用户执行 |
| `release/verify/t89-6-tmp/update/` | 探针下载的 86 MB 安装包（**已被篡改 1 字节**） | **不可直接用**；随 `release/` 一起走 gitignore |
| `release/verify/t89-6-{entry.ts,build.cjs,bundle.cjs,report.json,log.txt}` | 探针源码、bundle、报告、逐步日志 | 同上（gitignored） |

---

### 八、验证结果

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ exit 0 |
| `vitest` | ✅ **2364 passed / 115 files / 0 failed**（既有 2349 一条不删 + 新增 15） |
| 真机实证 | ✅ **13 / 13**（F0～F11） |
| 既有 E2E | ✅ **34 passed**（`npm run build && npm run e2e:only`，26.0 s，exit 0）—— 主进程启动器改了，渲染层零改动 |
## 六十一、T89-⑮：深色封面的歌词对比度 —— 取色背景的**亮度下限 0.60**（2026-11-13）

### 一、接续 T89-⑬/T89-⑭ 的那条线

T89-⑬ 真机把库扫了一遍（**173,671** 首 → 应用加载 **800** 首 → 546 首有封面 → 475 个封面 id
→ **去重后 43 张不同的图**），结论是：全屏播放页里**深色封面**上的当前歌词行
**基本读不出来**（对比度 1.4–2.3 vs WCAG AA 的 4.5）⇒ T89-⑭ 已把这件事如实写进
v0.2.7 的发布说明与 changelog，并承诺「**修法已定方向，待安排**」。
⇒ 本节就是那个「待安排」的修复。

### 二、诊断：两道门槛（不是「颜色选得不好」）

| 门槛 | 内容 | 实测 |
|---|---|---|
| ① 参照点错位 + 数学无解 | 校正只能**压暗**（色相/饱和度不变），压到**纯黑**时对比度是 `(L_bg + 0.05) / 0.05` ⇒ 要 4.5 必须有 **`L_bg ≥ 0.175`**；而深色封面的取色背景（封面**平均色**）亮度只有 **0.009–0.164** ⇒ **连纯黑都不够** ⇒ `toReadableAccent` **放弃校正、原样返回** | 现状最差 **1.01** |
| ② 背景明暗跨度太大 | 当前歌词行**随播放滚动**（f 实测 **23%–54%**）⇒ 背景从深到浅 ⇒ **单个颜色不可能在整段里都 ≥ 4.5** | 30 帧动态：深色封面 **30/30 帧**低于 AA |

⇒ **光调颜色解决不了** ⇒ 必须同时给背景设一个**亮度下限**。

**连带缺陷（同一个根因，之前没被发现）**：全屏页**顶部**（标题 / 艺人 / 返回按钮）
用的 `--text-primary`（`#1d1d1f`，深色）同样压在取色背景上 ⇒ 深色封面上
对比度最差 **1.01** ⇒ **顶部文字也是读不出来的**。

### 三、三个取舍点（2026-11-13 由用户拍板）

| 决策 | 结论 | 代价 |
|---|---|---|
| 校正参照点 | **对着渐变最暗端（提亮后）** | 余量大（5.2–5.8），**不需要测量**歌词位置 |
| 取色背景下限 | **相对亮度 0.60** | 39 张封面的背景会变亮 |
| 达不到 4.5 的兜底 | **不动**（仍原样返回） | `toReadableAccent` 语义与既有断言**一字不改** |

### 四、修法与实现（4 个文件，2 个 commit）

- `src/ui/accentColor.ts`（**只增不改**）：新增 `FULLPLAYER_BG_MIN_LUMINANCE = 0.6`、
  `liftToMinLuminance()`（**保色相、保饱和度**地提亮，HSL 亮度步进 0.005）、
  `lerpGradientColor()`（CSS 渐变的 sRGB 插值）。
  ⚠️ **为什么用「提亮」而不是「遮罩」**：遮罩是把暗部**洗向一个固定色**（丢饱和度、
  还要新增 token）；提亮是**把封面自己的颜色提亮** ⇒ 同样把背景抬到可读区间，
  但**色相与饱和度完整保留**、**CSS 零改动**。
- `src/pages/FullPlayerPage.tsx`：取色成功后 `setTint(liftToMinLuminance(color))`；
  **缓存里仍存原始取色结果**（缓存语义不变）；校正 effect 几乎不动。
- `test/accent-color-floor.test.ts`（**新建**）：两个纯函数的性质 + 12 个真实最差样本 +
  4 个最亮样本（**必须一字不动**）。
- `test/fullplayer-accent-contrast.test.tsx`：**只增不改**（+4 条；删除行 = 0）。

### 五、实测结果

**真机**（本地新构建 + T89-⑬ 同一支渲染探针，每首歌连续 30 帧）：

| 歌 | 主题 | 取色背景（修复前 → 修复后） | 强调色（前 → 后） | 对比度（前） | 对比度（后） | 低于 AA（前 → 后） |
|---|---|---|---|---|---|---|
| 问情 — 于春洋（浅色对照组） | Apple | `#d0cbc7` → **`#d0cbc7`（不变）** | `#0049c2` → **`#0049c2`（不变）** | 5.85 | **5.85** | 0/30 → **0/30** |
| 龙 拳 | Win11 | `#694616` → **`#e9c797`** | `#a6670e` → **`#774a0a`** | **1.04–1.16** | **5.15–5.33** | **30/30 → 0/30** ✅ |
| 生生 — 林俊杰 | Apple | `#716868` → **`#cfcbcb`** | `#0a66ff` → **`#0049c2`** | **1.45–2.30** | **5.75–5.86** | **30/30 → 0/30** ✅ |
| 裂缝中的阳光 — 林俊杰 | Apple | （20 秒内没等到歌词行 ⇒ 与 T89-⑬ 相同，**不是本次引入**） | | | | |

⇒ **浅色对照组一字未变**（tint、强调色、对比度全部相同）⇒ **零回归**；
⇒ 两首深色封面从「30/30 帧不合格」变成「0/30 帧不合格」，余量 5.15–5.86。

**全量预演**（43 张去重封面 × 2 主题，生产函数算）：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 歌词行落点对比度 ≥ 4.5 | 19 / 43 | **43 / 43** |
| 最差对比度 | 1.01（Apple）/ 1.03（Win11） | **4.55 / 4.89** |
| 顶部标题最差对比度 | 1.01 | **10.42** |

43 张按取色背景亮度分桶：`L < 0.175`（现状数学上无解）**24 张**、
`0.175 ≤ L < 0.60`（现状达标、只是观感会变亮）**15 张**、`L ≥ 0.60` **4 张**
⇒ **39 张被提亮、4 张完全不变**。

⚠️ **代价（如实标注）**：下限取 0.60 ⇒ **39 张封面的全屏页背景会变亮**
（其中 15 张现状已达标、只是观感变亮）⇒ 这是「可读性优先」换来的，**不粉饰**。

### 五之二、全量 43 张的**真机逐张复验**（2026-11-13，本轮补完）

上一节那张「全量预演」表是**用生产函数算出来的预估**；本节是**真机实测**。
两者的口径完全一致（同一套去重键、同一个 f），差别只在「分析层」还是「渲染层」。

**扫描口径**（本地新构建）：库 **797 首** / 有封面 **543 首** / 不同 coverId **472 个**
⇒ 按「**原始**平均色 + 主色」去重 ⇒ **43 张不同的图 / 每主题**（两主题合计 86 行）。
⚠️ 去重键必须用「**原始**」色：按提亮后的 tint 去重会塌成 **41 张**（不同原色被映射到同一值）。
⚠️ 修复前基线（T89-⑬，已安装的 v0.2.7）是 800 首 / 475 个 coverId ⇒ 库略有变动，
但**去重后的 43 张图完全一致** ⇒ 可比。

**分析层**（生产函数 + 真实封面像素）：

| 主题 | 低于 AA(4.5) 前 → 后 | 最差对比度 前 → 后 | 取色背景：被提亮 / 一字未动 |
|---|---|---|---|
| Apple | **24/43 → 0/43** | **1.45 → 4.55** | 39 张 / **4 张** |
| Fluent | **12/43 → 0/43** | **3.06 → 5.07** | 39 张 / **4 张** |

⇒ **4 张「一字未动」的正是单测里那 4 个「必须不动」的最亮样本**
（`#d0cbc7` 问情 / `#ededed` No Friends / `#f4ece8` 浪花季节 / `#f0f3ef` 今生最爱）
⇒ 与事前预演「39 张变亮、4 张不变」**完全吻合**。
⇒ 歌词行落点 f：Apple **0.537**、Fluent **0.818** ⇒ 与 T89-⑬ 基线**一致**。

**渲染层**（真机 DOM 逐张，43 张 × 2 主题 = 86 次）：

| 项 | Apple | Fluent |
|---|---|---|
| 页面发布的 tint **等于**分析值 | **43/43** | **43/43** |
| 量到真实 DOM 歌词行对比度的 | 20 张 | 23 张 |
| 其中**低于 4.5** 的 | **0** | **0** |
| 真实 DOM 歌词行最差 | **4.55** | **4.93** |
| 顶部标题（`--text-primary`）实测 | **43/43**，最差 **10.59**、最好 15.01 | **43/43**，最差 **10.95**、最好 15.56 |
| 顶部标题**低于 4.5** 的 | **0** | **0** |

⇒ **顶部标题那一项，上一节只做了推算（1.01 → 10.42），本轮真机实测坐实：最差 10.59 ≥ 4.5**。
⇒ 「分析值 ↔ 真实 DOM」的差：Apple 中位 **0.26** / 最大 **0.62**，Fluent 中位 **0.88** / 最大 **2.30**
⇒ 差值来自**歌词行落点 f 不同**（分析用该主题的固定 f，实测时歌词行在滚动中的实际位置）
⇒ **真机一侧的每一个数都 ≥ 4.5**（结论看真机侧；分析侧只是同口径的预估）。
⚠️ 86 次里另 **43 次**在那一刻**没有「歌词当前行」**可量（歌在播、封面 tint 正常，
只是歌词当前行尚未渲染出来）⇒ **如实标注**，不拿别的歌的数顶替。

**43 张逐张表**（脚本生成，未手抄）：

| # | 歌 — 艺人 | 原始取色 | 提亮后 | Apple 前 → 后 | Apple <AA | Fluent 前 → 后 | Fluent <AA | 真机 DOM（Apple 歌词行 / 顶部标题） |
|---|---|---|---|---|---|---|---|---|
| 1 | 今生最爱（烟嗓女声DJ版 ） — 小梁的（梁思琪） | `#f0f3ef` | `#f0f3ef` | 4.55 → **4.55** | ✅ → ✅ | 5.10 → **5.10** | ✅ → ✅ | 4.55 / 15.01 |
| 2 | 浪花季节 — 李克勤 | `#f4ece8` | `#f4ece8` | 4.78 → **4.78** | ✅ → ✅ | 5.16 → **5.16** | ✅ → ✅ | — / 14.44（该时刻无歌词当前行） |
| 3 | No Friends — No Friends | `#ededed` | `#ededed` | 4.79 → **4.79** | ✅ → ✅ | 5.07 → **5.07** | ✅ → ✅ | — / 14.38（该时刻无歌词当前行） |
| 4 | 离开的那一些 — 林俊杰 | `#7c9481` | `#c5d0c7` | 8.64 → **5.47** | ✅ → ✅ | 11.89 → **6.61** | ✅ → ✅ | 4.97 / 10.81 |
| 5 | 16 — bloomcr4zy / 16 | `#201a1b` | `#d4cbcc` | 1.49 → **5.48** | ❌ → ✅ | 7.18 → **9.75** | ✅ → ✅ | — / 10.78（该时刻无歌词当前行） |
| 6 | 爱 — 大冢 爱 | `#afaaa0` | `#d0cdc7` | 7.17 → **5.49** | ✅ → ✅ | 8.64 → **6.35** | ✅ → ✅ | 5.24 / 10.83 |
| 7 | 16 — 16 | `#4a2222` | `#e5c6c6` | 1.63 → **5.49** | ❌ → ✅ | 6.55 → **8.69** | ✅ → ✅ | — / 10.79（该时刻无歌词当前行） |
| 8 | Gunfire — Gunfire | `#442022` | `#e4c6c8` | 1.60 → **5.49** | ❌ → ✅ | 5.94 → **7.90** | ✅ → ✅ | — / 10.78（该时刻无歌词当前行） |
| 9 | 18 — 18 | `#20b1f8` | `#8ad6fb` | 6.74 → **5.81** | ✅ → ✅ | 9.00 → **6.63** | ✅ → ✅ | — / 10.64（该时刻无歌词当前行） |
| 10 | 12 — 12 | `#675749` | `#d4cac2` | 2.11 → **5.82** | ❌ → ✅ | 3.19 → **6.30** | ❌ → ✅ | — / 10.63（该时刻无歌词当前行） |
| 11 | 12-34 — Harry Gill / 12 | `#d46744` | `#eec2b4` | 8.98 → **5.83** | ✅ → ✅ | 12.06 → **6.46** | ✅ → ✅ | — / 10.59（该时刻无歌词当前行） |
| 12 | Time — DJ of Time | `#0e191e` | `#b5d0dc` | 1.45 → **5.83** | ❌ → ✅ | 5.61 → **7.73** | ✅ → ✅ | — / 10.66（该时刻无歌词当前行） |
| 13 | 刻你的名字 — 魏佳艺 | `#838383` | `#cccccc` | 9.61 → **5.83** | ✅ → ✅ | 13.22 → **6.18** | ✅ → ✅ | 5.83 / 10.69 |
| 14 | 4 — B 4 | `#404040` | `#cccccc` | 1.85 → **5.83** | ❌ → ✅ | 3.75 → **6.18** | ❌ → ✅ | 5.83 / 10.69（该时刻无歌词当前行） |
| 15 | Remember — Forever In Combat | `#5c5e5e` | `#cbcccc` | 2.15 → **5.83** | ❌ → ✅ | 3.39 → **6.54** | ❌ → ✅ | — / 10.67（该时刻无歌词当前行） |
| 16 | BaBy — BABY | `#6c6c6c` | `#cccccc` | 2.33 → **5.83** | ❌ → ✅ | 4.06 → **6.18** | ❌ → ✅ | 5.45 / 10.69 |
| 17 | 身为风帆 — 林俊杰 | `#374447` | `#c3ced1` | 1.85 → **5.84** | ❌ → ✅ | 3.06 → **6.63** | ❌ → ✅ | — / 10.69（该时刻无歌词当前行） |
| 18 | 龙 拳 — ? | `#694616` | `#e9c797` | 1.95 → **5.84** | ❌ → ✅ | 3.12 → **6.40** | ❌ → ✅ | 5.22 / 10.65 |
| 19 | Twilight — Twilight | `#65646b` | `#cccccf` | 2.24 → **5.84** | ❌ → ✅ | 4.46 → **6.21** | ❌ → ✅ | 5.62 / 10.72 |
| 20 | Stay — Stay Design | `#62705f` | `#c7cec5` | 2.33 → **5.84** | ❌ → ✅ | 3.46 → **6.27** | ❌ → ✅ | — / 10.68（该时刻无歌词当前行） |
| 21 | 跟屁虫 — 林俊杰 | `#847e7b` | `#cecbca` | 9.77 → **5.84** | ✅ → ✅ | 13.51 → **6.43** | ✅ → ✅ | — / 10.65（该时刻无歌词当前行） |
| 22 | Intermission — Intermission Banda | `#3a3b42` | `#cbccd1` | 1.79 → **5.84** | ❌ → ✅ | 6.29 → **8.06** | ✅ → ✅ | — / 10.71（该时刻无歌词当前行） |
| 23 | Not Tonight (Tomorrow Sounds Good Steve Aoki Remix) — 林俊杰 / Steve Aoki | `#1079a1` | `#8cd7f4` | 2.29 → **5.85** | ❌ → ✅ | 3.32 → **6.44** | ❌ → ✅ | 5.79 / 10.69（该时刻无歌词当前行） |
| 24 | 修炼爱情 (Jazz Version) — 林俊杰 | `#cec8c2` | `#d0cbc5` | 5.79 → **5.85** | ✅ → ✅ | 6.55 → **6.61** | ✅ → ✅ | — / 10.66（该时刻无歌词当前行） |
| 25 | 裂缝中的阳光 — 林俊杰 | `#1d1c1c` | `#cdcccc` | 1.49 → **5.85** | ❌ → ✅ | 3.53 → **6.18** | ❌ → ✅ | 5.83 / 10.72（该时刻无歌词当前行） |
| 26 | Version — Version | `#765b4d` | `#d7c9c2` | 2.19 → **5.85** | ❌ → ✅ | 3.51 → **6.15** | ❌ → ✅ | 5.43 / 10.63 |
| 27 | 3 — 3 / Patrick Borga | `#87562d` | `#e4c7ae` | 2.17 → **5.85** | ❌ → ✅ | 5.48 → **6.63** | ✅ → ✅ | — / 10.68（该时刻无歌词当前行） |
| 28 | 9 — SSSmoke / 9 | `#301e0f` | `#e5c7ad` | 1.54 → **5.85** | ❌ → ✅ | 6.92 → **9.31** | ✅ → ✅ | — / 10.70（该时刻无歌词当前行） |
| 29 | Time — Time / Azar_s | `#323f4c` | `#c2cdd7` | 1.81 → **5.85** | ❌ → ✅ | 8.13 → **10.40** | ✅ → ✅ | — / 10.63（该时刻无歌词当前行） |
| 30 | Shadows — Shadows | `#241614` | `#dec7c4` | 1.46 → **5.85** | ❌ → ✅ | 8.29 → **11.32** | ✅ → ✅ | 5.60 / 10.67 |
| 31 | 问情 — 于春洋 | `#d0cbc7` | `#d0cbc7` | 5.85 → **5.85** | ✅ → ✅ | 6.55 → **6.55** | ✅ → ✅ | 5.59 / 10.67 |
| 32 | Song — Song | `#949093` | `#cecccd` | 8.33 → **5.85** | ✅ → ✅ | 11.02 → **6.18** | ✅ → ✅ | 5.85 / 10.75（该时刻无歌词当前行） |
| 33 | Sanctuary — Sanctuary | `#5f62cf` | `#c9caef` | 2.31 → **5.85** | ❌ → ✅ | 4.93 → **6.31** | ✅ → ✅ | 5.29 / 10.76 |
| 34 | Bedtime — DJ Bedtime | `#ceadb3` | `#ddc7cb` | 6.56 → **5.85** | ✅ → ✅ | 7.90 → **6.21** | ✅ → ✅ | — / 10.69（该时刻无歌词当前行） |
| 35 | 静心等 — 萧㛤珠 | `#b7a06c` | `#d8cbaf` | 7.38 → **5.86** | ✅ → ✅ | 9.81 → **6.81** | ✅ → ✅ | — / 10.68（该时刻无歌词当前行） |
| 36 | 失败的Man - Live — 范晓萱 | `#43456a` | `#cacbdd` | 1.92 → **5.86** | ❌ → ✅ | 7.16 → **9.05** | ✅ → ✅ | 5.59 / 10.70（该时刻无歌词当前行） |
| 37 | 生生 — 林俊杰 | `#716868` | `#cfcbcb` | 2.30 → **5.86** | ❌ → ✅ | 3.39 → **6.33** | ❌ → ✅ | 5.75 / 10.68 |
| 38 | 庙堂之外 (五四特别版) — Kael | `#9b8775` | `#d4cbc3` | 8.95 → **5.87** | ✅ → ✅ | 12.31 → **6.34** | ✅ → ✅ | 5.45 / 10.71 |
| 39 | 还剩下什么 — 羽泉 / 苏慧伦 | `#84887c` | `#cccdc8` | 9.29 → **5.87** | ✅ → ✅ | 12.62 → **6.47** | ✅ → ✅ | 5.27 / 10.74（该时刻无歌词当前行） |
| 40 | 6$ — 6$ey | `#9c8f93` | `#d1cbcc` | 8.34 → **5.87** | ✅ → ✅ | 10.92 → **6.55** | ✅ → ✅ | — / 10.71（该时刻无歌词当前行） |
| 41 | 黑武士 — 林俊杰 | `#847575` | `#d1cbcb` | 10.33 → **5.87** | ✅ → ✅ | 14.63 → **6.45** | ✅ → ✅ | — / 10.70（该时刻无歌词当前行） |
| 42 | 28 — 28 | `#1d1863` | `#cbc8f2` | 1.52 → **5.87** | ❌ → ✅ | 9.12 → **12.34** | ✅ → ✅ | 5.58 / 10.68 |
| 43 | 心出发(组曲) — 周传雄 | `#80857f` | `#cbcdcb` | 9.63 → **5.87** | ✅ → ✅ | 13.27 → **6.21** | ✅ → ✅ | — / 10.74（该时刻无歌词当前行） |

⚠️ **代价（如实标注，不粉饰）**：
1. **39 张**封面的全屏页背景会变亮（其中 15 张本来已达标、只是观感变亮）；
2. **本来就达标的图，对比度会下降**（背景被抬亮 ⇒ 固定强调色与背景的差距变小）：
   「黑武士」Apple **10.33 → 5.87**、「离开的那一些」**8.64 → 5.47**
   ⇒ **余量变薄，但全部仍 ≥ 4.5**；
3. 最差的三张（`今生最爱` 4.55 / `浪花季节` 4.78 / `No Friends` 4.79）**本来就合格**
   ⇒ 提亮对它们**一字未动**，但它们**贴着 4.5 的线** ⇒ 换主题/换字体后可能掉下去（**待真机复验**）。

⚠️ **本轮真机复验踩到的坑（已修，记下来免得再踩）**：
1. **同名不同封面**：库里有多首同名歌（`16`、`12`、`爱`…）⇒ 按**标题**播放会**放错歌**
   ⇒ 改按 **coverId** 定位行（封面 URL 里带 `coverId=xxx`）⇒ 86/86 tint 全部对上；
2. **量错了歌的数不能当证据**：每条都加一道「页面发布的 tint 必须等于分析值」的校验，
   不等就**作废并换候选**；
3. **应用连播几十首后会「取色不触发」**：页面上的 `--fnm-fullplayer__tint` 为空
   （但封面图其实**已加载成功**，naturalWidth=200）⇒ 是应用状态问题，不是那首歌的问题
   ⇒ 改成「tint 空 ⇒ **重启应用后重试同一首**」，并**每测 5 张就重启一次**；
4. **后台任务会被「回合结束」掐掉** ⇒ 整轮扫描改成**每步落盘**（枚举 / 像素 / 分主题分析 /
   逐张实测）⇒ 中断后**秒级续跑**；
5. **清理进程只按 PID**（本机宿主也是 Electron ⇒ 按镜像名杀会误伤）。

### 六、验证结果

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ **exit 0** |
| `vitest` | ✅ **117 files / 2393 passed / 0 failed**（改动前基线 **2376** ⇒ **净增 17**；既有条数**一条不删**，`git diff` 删除行 = 0） |
| 真机实证（逐帧） | ✅ **3 首歌 × 30 帧**（问情 / 龙拳 / 生生），浅色对照组零变化，两首深色封面 0/30 不合格 |
| 真机实证（全量逐张） | ✅ **43 张 × 2 主题 = 86 次**：tint **86/86** 与分析值一致；量到真实 DOM 歌词行对比度的 43 次里**低于 4.5 的 0 次**（最差 4.55 / 4.93）；顶部标题 **86/86** 实测、最差 **10.59**、低于 4.5 的 **0** |
| 既有 E2E | ⚠️ **本轮未跑**（改的是渲染层取色与颜色计算，Playwright 套件需要完整构建 + NAS 会话；真机探针已覆盖同一渲染路径） |

### 七、产物（gitignored）

| 文件 | 内容 |
|---|---|
| `release/verify/t89-15-plan-math.mjs` / `t89-15-plan-final.mjs` | 四个候选修法的预演（43 张 × 2 主题，生产函数） |
| `release/verify/t89-15-extract-samples.mjs` | 提取 12 个最暗 / 4 个最亮的真实取色背景（单测内联样本的来源） |
| `release/verify/t89-15-machine-verify.mjs` | 真机复验脚本（本地新构建 + 渲染探针，**只按 PID 清理进程**） |
| `release/verify/t89-15-artifacts/dynamic-f-fixed.json` | 真机复验的逐帧原始数据 |
| `release/verify/t89-15-append-ledger.mjs` / `t89-15-ledger-section.md` | 台账追加 |

### 八、还没有做的

- **下一个版本（0.2.8）的 changelog 段**与**发布说明**尚未写（等发版时一起做）。


## 六十二、T96：「发现」页（榜单 + 为你推荐）的实测基线（2026-11-16）

### 一、榜源实测（`release/verify/t96-01/02/03` 三个探针）

| 源 | 实测结果 |
|---|---|
| **QQ 音乐** | ✅ 200 + 真实榜单条目（本轮唯一可用的源） |
| 网易云 | ❌ `music.163.com/api/top/list` 等 → `{"code":404,"message":"接口未找到！"}`（web 端点已下线；**歌词**端点仍好） |
| 酷狗 | ⚠️ `/api/v5/rank/top` → 404；`/api/v3/rank/song` → 「参数不合法」（**参数名待探**） |
| 酷我 | ⚠️ `/api/www/chart/kuwo` → 「The request is illegal!」（**缺 `kw_token`**） |
| 咪咕 | ❌ 本机 node / curl **TLS 握手失败**（需在应用内 Chromium 栈复验） |

### 二、QQ 榜单的真实形状（**写错字段名会静默拿到 undefined**）

- 端点：`https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=<id>&format=json&page=detail&type=top&song_begin=0&song_num=<n>`
- 必须带头：**UA** + **`Referer: https://y.qq.com/`**（实测带了就通）
- 响应是**扁平**结构（**不在 `data` 下**）：`{ code, songlist, topinfo, total_song_num }`
- `code = 0` 成功；`topinfo.ListName` = 榜单名（**自描述**）
- `songlist[].data` 的字段名：**`songname`**（⚠️ 不是 `title` / `name`）、**`singer[].name`**、**`albumname`**、**`interval`（秒）**
- ⚠️ **没有「榜单列表」接口**（`page=list` → `code=-1, subcode=400`）⇒ 榜单目录**只能客户端写死**

### 三、实测到的 `topid ↔ 榜单名`（37 个，节选）

| topid | 榜单名 | topid | 榜单名 |
|---|---|---|---|
| 4 | 流行指数 | 26 | **巅峰榜·热歌**（300 首） |
| 5 | **巅峰榜·内地**（100 首） | 27 | **巅峰榜·新歌**（100 首） |
| 22 | 中国好歌曲 | 57 | 电音榜 |
| 23 | 畅销 | 58 | 说唱榜 |
| 60 | 抖音热歌榜 | 62 | **飙升榜**（100 首） |
| 65 | 国风热歌榜 | 78 | 国乐榜 |

（本轮只接 **4 个**：26 / 62 / 27 / 5。）

### 四、⚠️ 曲库是「当前用户自己的」—— 命中率因人而异

- 客户端**不拉全量曲库**、**不对曲库规模做任何假设**：一律**定向查询**
  （`/search/artist` → `/track/artist-detail/list`；`/track/album-detail/list`）；
- 「榜上 N 首，你的曲库里有 M 首」里的 **M 是按当前登录账号实时算的** ——
  换一个人、换一个 NAS，数字就不同 ⇒ **不是通用结论**；
- ⚠️ **本机（demo 账号）的真实命中率待真机复验**（隔离 userData + 真实 NAS + 真实 QQ 源），
  测出来的数**也只能代表那台机、那个账号**。

### 五、⚠️ 实测踩到的坑：Chromium 分区栈**全局拦 http 明文**

- E2E 里把榜源指向 mock 的 `http://127.0.0.1:<port>/mock-chart` ⇒
  主进程用 Chromium 分区栈（`http.fetch`）去抓 ⇒ **`net::ERR_BLOCKED_BY_CLIENT`**（2026-11-16 实测）；
- ⇒ 榜源**两条通道**：**默认榜源（QQ，https）走 Chromium 分区栈**（干净、不带 NAS 凭证、**走系统代理**），
  **覆盖地址（`FNM_CHART_URL`）走 Node 的 fetch**（undici 不拦 http 明文，但**不认代理环境变量**）；
- `resolveChartBaseUrl()` 把关：只接受 **https** 或 **http + 回环地址**（`127.0.0.1` / `localhost` / `::1`）。

### 六、验证结果

- `tsc --noEmit` 0 error；Vitest **129 文件 / 2751 条**全绿；Playwright **36 条**全绿；
- 字节体检 + 控制字符扫描 **0 bad**；
- **变异自证** 3 条全部「变红 ⇒ 还原变绿」。

### 七、还没做的（待真机）

- 真实 QQ 源 + 真实 NAS 下的**命中率**与**首载耗时**；
- 真实环境里 QQ 榜源能否经**系统代理**取到（默认榜源走 Chromium 分区栈 ⇒ 认系统代理；
  若本机只有环境变量代理，则需另行处理）；
- 别家榜源（酷狗参数 / 酷我 `kw_token` / 咪咕 TLS / 网易云新端点）。

## 六十三、T96 真机复验：「发现」页的**真实命中率**与**首载耗时**（2026-11-16）

### 一、怎么复验的（**隔离 userData + 真实账号 + 真实榜源**）

| 项 | 做法 |
|---|---|
| 应用 | **仓库构建版**（`npm run build` 之后的 `dist/` + `dist-electron/`），**不是**已安装的 v0.2.9 |
| userData | **临时目录**（`mkdtemp`）⇒ 真实 `%APPDATA%\Sanlos Music` **只读**，一个字节都没改 |
| 会话 | 从真实 userData **只复制** `session.bin` + `Local State`（**原因见第二节**） |
| 偏好 | 新写一份：`downloadDir` 指向临时目录、`lyric.source = 'off'`、`autoplay = false` ⇒ 不下载、不打外部歌词、不偷播 |
| 榜源 | **不设** `FNM_CHART_URL` ⇒ 走**默认的 QQ 榜源**（真实外网） |
| 链路 | **中继**（实测界面提示「中继带宽受限（约 0.5–4 Mbps）」） |

### 二、⚠️ 踩坑：Chromium 的 `safeStorage` 密文**绑在 userData 的 master key 上**

- **症状**：把真实 `session.bin` 复制到隔离 userData 后，应用**一直「未连接」**
  ⇒ 第一轮复验直接卡在登录页（`session.load()` 静默失败）；
- **定位**：主进程 `safeStorage.decryptString()` 抛
  「Error while decrypting the ciphertext…」。用 Electron 单独跑一遍诊断发现：
  **正文不是 DPAPI 密文，而是 `v10` + 二进制** ⇒ 那是 **Chromium OSCrypt** 的格式，
  它用 **userData 里的 master key** 加解密，而 master key 存在
  **`<userData>/Local State` 的 `os_crypt.encrypted_key`**（它本身被 DPAPI 保护）；
- ⇒ **只复制 `session.bin` 换到别处 ⇒ 必解不开**；
  **隔离复验必须连 `Local State` 一起复制**（同一 Windows 用户下可用，临时目录用完即删）；
- ⇒ **症状是「未连接」而不是报错** ⇒ 很容易被误判成「账号掉了 / 口令错了」；
- ⚠️ 这条对**任何**「隔离 userData 复验」都成立，不只这一页。

### 三、真实 QQ 榜源：**可用**（经系统代理）

| 项 | 实测 |
|---|---|
| 抓取耗时 | **232 ms**（主进程 → Chromium 分区栈 → 系统代理 `127.0.0.1:7897`） |
| 榜单 | 4 个（巅峰榜·热歌 / 飙升榜 / 巅峰榜·新歌 / 巅峰榜·内地），各 **50** 条 = **200** 条 |
| 唯一歌手 | **157** 个（⇒ 定向匹配要按这 157 个歌手**逐个**查） |
| 错误 | **0** |

⇒ **「默认榜源走 Chromium 分区栈、认系统代理」这条设计在真实环境成立**。

### 四、真实命中率（**本机、该账号** ⇒ 因人而异，**不是通用结论**）

| 榜单 | 命中 / 总数 |
|---|---|
| 巅峰榜·热歌 | **31 / 50** |
| 飙升榜 | 3 / 50 |
| 巅峰榜·新歌 | 0 / 50 |
| 巅峰榜·内地 | 0 / 50 |
| **合计** | **34 / 200** |

- 页头文案：「共 200 条，你的曲库里有 34 条」；
  单榜文案：「榜上 50 首，你的曲库里有 31 首」；
- 未命中的 **19/50** 行标「不在曲库」且**没有**播放按钮（命中的 31 行才有）⇒ 与设计一致；
- ⚠️ **这个账号的库以老歌为主** ⇒ 新歌榜 / 内地榜 0 命中；
  **换个人、换个 NAS，数字完全不同** ⇒ 只代表**那台机、那个账号**。

### 五、首载耗时：**冷 29 秒 / 二次进入 40 秒**（瓶颈 = 定向查询，不是榜源）

| 阶段 | 实测 |
|---|---|
| 榜源抓取（主进程） | **232 ms**（另有主进程 5 分钟缓存） |
| **冷首载**（点「发现」→ 看到命中率） | **29.1 秒** |
| **二次进入**（切到「歌曲」再切回「发现」） | **40.3 秒**（榜源命中缓存，**但匹配不缓存 ⇒ 243 次 NAS 请求照打**） |
| 冷首载的 NAS 请求 | **255 次**（`/search/artist` 168 + `/track/artist-detail/list` 87），**0 错误** |
| 单次请求最慢 | **25 秒**（中继抖动，出现在 `/search/artist`） |

- ⚠️ **耗时波动极大**：另一次复验（同样条件）**> 300 秒仍未出结果** ⇒
  瓶颈是**中继链路的延迟抖动**（单请求能飙到 25 秒），
  **不是**榜源（232 ms）、**也不是**匹配算法本身；
- ⇒ **首载 30 秒量级**在**中继**链路上是常态 ⇒ 界面必须**先给榜单、后补命中率**
  （不能等匹配完再整页渲染），否则用户看到的是「卡住」；
- ⚠️ **二次进入「发现」会重打 NAS**（匹配结果不缓存）⇒ 同样 30–40 秒。

### 六、推荐与播放（真实数据）

| 项 | 实测 |
|---|---|
| 「因为你收藏过」 | **10** 条（理由带歌手名，如「因为你收藏了 孙燕姿」） |
| 「因为你最近听过」 | **10** 条 |
| 「同一位歌手的其他歌」 | **10** 条 |
| 播放 | 点榜单里命中的「天龙八部之宿敌」（许嵩）⇒ **播放条显示同一首歌名 + 歌手** ✓（走既有 `track/stream` 路径，没新增播放路径） |

⚠️ 曲库里的歌名带**序号前缀与引号**（如 `122.那英 - 春暖花开`、`"我与你[咋日,今日,明日]"`）
⇒ 那是**那个库的元数据**长这样，**不是匹配 bug**（归一化后两边都带前缀才全等）。

### 七、还剩什么

- ⚠️ **首载 30 秒量级**（中继链路）⇒ 下一轮该做「**先出榜单、命中异步补**」；
- ⚠️ **二次进入重打 NAS**（匹配结果不缓存）⇒ 同上；
- ⚠️ 榜单目录仍写死 4 个、仍只有 QQ 一个源（其余实测不可用）。

## 六十四、T97：「随机 20 首」组一个歌单 —— 服务端实测基线（2026-11-16）

### 一、怎么测的（4 个真机探针，`release/verify/t97-01~04`）

| 探针 | 问什么 |
|---|---|
| `t97-01` | `/track/list` 的信封形状；随机页之间**有没有重复**（页码语义对不对）；同一页连抓两次**顺序稳不稳**；`playlist/create` / `add-track` / `delete` 走不走得通 |
| `t97-02` | 分页参数**到底哪个名字**生效（`page` / `offset` / `start` / `from` / `skip` / `index` / `pageNo` / `pageIndex` / `pageNum` / `pageNumber` / `p` / `currentPage` 全试） |
| `t97-03` | 页码扫描：哪些页**真的不同**、哪些页**已经回绕** |
| `t97-04` | `sort` 参数**认哪几个**；页码上限在哪 |

⚠ 探针输出**只记形状与计数**（不落任何真实歌名 / guid）；探针自建的歌单**当场删掉**（真实 NAS 无残留）；
真实 userData **只读**（只复制 `session.bin` + `Local State`）。

### 二、⚠ 服务端实测事实（**代码按这些写**，但**别当通用契约**）

| 项 | 实测结论 | 对代码的影响 |
|---|---|---|
| **`page` 生效，页码上限 2000** | `size=10` / `size=50`：2000 好 / **2001 静默回绕到第 1 页**；`size=200`：869 好 / **870 空页** | ⇒ **页码必须 clamp 到 ≤ 2000**（不 clamp 会把同一页抽成 20 首） |
| **`size` 生效（上限 2000）** | `size=20` 真返回 20 条 | ⇒ 用 `size=200` 抽页 ⇒ **请求数少** |
| **其它分页参数一律无效** | `offset` / `start` / `from` / `skip` / `index` / `pageNo` / `pageIndex` / `pageNum` / `pageNumber` / `p` / `currentPage` 全部**回第 1 页**（与第 1 页 10/10 重合） | ⇒ **只有 `page` + `size` 管用** |
| **`sort` 只认三个** | `createdAt,asc` / `createdAt,desc` / `title,asc` **有效**（首条哈希各不相同）；`title`（无方向）/ `album` / `duration` / `updatedAt,desc` / `random` / `rand` / `RANDOM` / `shuffle` **一律无效**（回显仍是 `createdAt,desc`，首条哈希与基线相同） | ⇒ **服务端没有随机排序 ⇒ 随机只能客户端做** |
| **默认排序 `createdAt,desc`** | 相邻页的曲目**导入时间挨着**；同一页连抓两次**同序同集**（排序稳定） | ⇒ 只取一页的连续 20 首会**很同质** ⇒ 必须**分散到多个随机页** |
| **曲库规模（只属那台机）** | `total = 173671`（本机该账号）；`size=200` ⇒ 869 页 < 2000 ⇒ **全库每一页都翻得到** | ⇒ 抽样**能覆盖全库**；但 `total` 是**运行时算**的，**不写死** |

### 三、歌单写回（实测走通）

| 端点 | 实测 |
|---|---|
| `playlist/list` | `total = 0`（该账号当时**一个歌单都没有**） |
| `playlist/create` | 回显 `{ guid, name, coverId, createdAt, updatedAt }`，**`guid` 是 32 位 hex** |
| `playlist/add-track` | 真写进去（回显 `added`）；`/track/playlist-detail/list` 能取回（`total` 与返回条数一致） |
| `playlist/delete` | 能删 ⇒ 探针自建的歌单**当场删除**，真实 NAS **无残留** |

⇒ 客户端的存回路径 = `create`（拿 `guid`）→ `add-track` → **刷新列表**
（不重拉就只看得见提示、**看不见新歌单**）；
**回显为空**时按**名字**在刷新后的列表里找回（与既有「新建歌单」同一口径）⇒ 找不到就**如实报错**，不假装成功。

### 四、抽样算法（`src/api/randomPlaylist.ts`）

1. `total`（**1 次**请求就够，`size=1`）；
2. 总页数 = `ceil(total / 200)`，**clamp 到 ≤ 2000**；
3. **随机挑 4 个互不相同的页**（部分 Fisher–Yates）；
4. 每页 200 首，**页内**再随机各挑 5 首（页内不洗 ⇒ 同质）；
5. 汇总**去重** ⇒ 洗牌 ⇒ 取前 20；
6. **库不够就如实少给**（不拿重复的凑数）；`total ≤ 0` ⇒ 空数组。

⚠ **随机源与依赖都可注入** ⇒ 单测能拿到**可复现**的结果；
⚠ **曲库是「当前登录用户自己的」** ⇒ 规模与内容**因人而异** ⇒ `total`、页数一律**运行时算**，**不假设曲库有多大**。

### 五、验证结果

- `tsc --noEmit` **0 error**；Vitest **131 文件 / 2773 条**全绿（T97 新增 **2 文件 / 22 条**）；
  Playwright **38 条**全绿（T97 新增 **2 条**）；`npm run build` exit 0；
- 字节体检 + 控制字符扫描 **0 bad**（9 个新增 / 改动文件）；
- **变异自证 4 条**全部「变红 ⇒ 还原回绿」：抽样不 clamp 页码 / 抽样不去重 /
  「换一批」不重新抽样 / 「存为歌单」不调 `save`。

### 六、⚠ 变异自证抓到的**真 bug**（已修）

- **症状**：「换一批」那条变异**没把测试变红** ⇒ 一度以为是「测试假绿、这条变异无效」；
- **真因**：`handleRandom` 的 `useCallback` 依赖数组是 `[count, deps]`，**漏了 `songs`**
  ⇒ 闭包永远拿到**初始的** `songs = []`
  ⇒ 任何「拿上一批糊弄」的写法在闭包里**都看不出差别** ⇒ **测试测不出来**；
- **修法**：依赖补上 `songs`（闭包拿到最新的那一批），**另加一条**断言
  「换一批 ⇒ 面板说明的条数确实变了」的用例
  （用两轮不同的曲库：第一轮 400 首、第二轮 8 首 ⇒ 提示从「20 首」变成「8 首」）；
- ⚠ **通用教训**：`useCallback` 里读了 state 却**没进依赖数组** ⇒ 闭包永远是旧的
  ⇒ 一旦以后有人写「沿用上一批」，**测试会假绿**。

### 七、⚠ 顺带发现的**既有缺陷**（本轮**不修**，另开任务）

- `src/api/client.ts` 的 `normalizePageNumber()` **只管下界**（非法值 / `< 1` ⇒ 落回 1），**不管上界**
  ⇒ `libraryApi.songs()` 等分页接口**没有 clamp 页码 ≤ 2000**
  ⇒ **大库里「加载更多」翻过第 2000 页会重复第 1 页**（服务端静默回绕，**不报错**）；
- 本轮实测：`page=8848` 起就与第 1 页 **10/10 重合**（`size=10`）。

### 八、还剩什么（待真机复验）

- **真实抽样 + 存回真歌单**：在真实 NAS 上随机挑 20 首并**真的存成一个歌单**
  （⚠ 会在**用户 NAS 上新建一个歌单**）⇒ 待用户确认后做；
- 抽出来的 20 首**在入库时间上够不够开**（4 页 × 5 首）—— 要等真机数据下结论。

## 六十五、T97 真机复验：「随机 20 首」的**真实耗时**与**存回真歌单**（2026-11-16）

### 一、怎么复验的

| 项 | 做法 |
|---|---|
| 应用 | **仓库构建版**（`npm run build` 之后的 `dist/` + `dist-electron/`），**不是**已安装的 v0.2.9 |
| userData | **临时目录**（`mkdtemp`）⇒ 真实 `%APPDATA%\Sanlos Music` **只读**，一个字节都没改 |
| 会话 | 从真实 userData **只复制** `session.bin` + `Local State`（**原因见「六十三」第二节**：safeStorage 密文绑 master key） |
| 偏好 | `lyric.source = 'off'`、`autoplay = false` ⇒ 不下载、不打外部歌词、不偷播 |
| 探针 | `release/verify/t97-06-realmachine-verify.mjs`（**逐请求仪表**：路径 / 状态 / 耗时 / 异常） |
| 写回 | ⚠️ 阶段 B 需**用户显式授权**（`FNM_T97_WRITE=1`）⇒ 在真实 NAS 上**建一个歌单 → 当场删掉** |

### 二、阶段 A：抽样（**只读**，零副作用）

| 项 | 实测（**本机、该账号**） |
|---|---|
| 抽到几首 | **20**（库里够 ⇒ 不触发「如实少给」那条路径） |
| 耗时 | **4.5 秒**（另两次 2.6 秒 / 3.3 秒 ⇒ 中继抖动；**秒级，不是三十秒级**） |
| NAS 请求 | **5 次** `/track/list` = **1 次**（`size=1`，只拿 `total`）+ **4 次**（`size=200`，四个随机页）；**0 错误** |
| 抽到的页码 | 本次 `[376, 411, 521, 56]`；另几次 `[288, 688, 686, 556]` / `[79, 272, 219, 190]` / `[501, 82, 829, 271]` ⇒ **分散在整个库里**，不是连着的一段 |
| **页码上限** | 实测最大页码 **733** ⇒ **0 个超过 2000** ⇒ **clamp 那道闸本轮没被触发**（但它必须留着：库再大就会撞上回绕） |
| 播放 | 点「播放全部」⇒ 播放条出现**同一首**（与列表第一行一致）✓ 走既有 `track/stream`，**没新增播放路径** |

### 三、阶段 A：换一批（**真的重新抽样**）

| 项 | 实测 |
|---|---|
| 耗时 | **7.1 秒**（比第一批慢 ⇒ 中继抖动） |
| NAS 请求 | **又打了 5 次** `/track/list` ⇒ **确实重新抽了样**（不是沿用上一批） |
| 页码 | `[410, 110, 367, 733]` ⇒ 与第一批 `[376, 411, 521, 56]` **完全不同** ✓ |
| 结果 | 仍是 **20 首**（库里够） |

### 四、阶段 B：存回真歌单（**用户授权后**）

| 项 | 实测 |
|---|---|
| 存回 | **成功**：「歌单「T97-real-…」已保存（20 首）」 |
| 歌单列表 | **0 → 1** ⇒ 左栏里真的多了一个歌单 |
| 歌单详情 | `/track/playlist-detail/list` ⇒ **20 首**、`total = 20` ⇒ **那 20 首真的进去了** |
| guid | 回显 **32 位 hex**（与探针一致） |
| 清理 | **当场删掉**（`playlist/delete` → `code = 0`）⇒ **剩余歌单数 = 0**，真实 NAS **无残留** |

### 五、⚠ 真机复验抓到的**服务端硬约束**：歌单名 **≤ 32 个字符**

- **症状**：第一次跑阶段 B ⇒ 「存为歌单失败：**invalid arguments**」（服务端 `code = 100002`），
  歌单**没建出来**（列表前后都是 0 ⇒ **无残留**）；
- **定位**：探针 `t97-01` 用**同样的代理、同样的 body 形状**却成功 ⇒ 唯一差别只剩**歌单名**；
- **边界扫描**（`release/verify/t97-09-probe-create-name.mjs`；每个建成的**当场删掉**）：

| 名字 | 字符数 | 字节数 | 结果 |
|---|---|---|---|
| 纯 ASCII | **32** | 32 | ✅ 成功 |
| 纯 ASCII | **33** | 33 | ❌ `invalid arguments` |
| 含中文（探针当时用的形状） | **32** | 36 | ✅ 成功 |
| 含中文 | 34 | 42 | ❌ `invalid arguments` |

⇒ **上限 = 32 个字符**，而且按**字符数**算、**不是字节数**
（32 个中文字符 = 96 字节照样成功；38 字节的纯 ASCII 反而失败）；
⇒ **客户端自己先拦**：`src/api/playlist.ts` 的 `MAX_PLAYLIST_NAME_LENGTH = 32`
⇒ 面板超长就**禁用「存为歌单」**并给**中文**提示
（「歌单名不能超过 32 个字符（现在 33 个）」）；
⇒ ⚠️ **既有缺陷（另开任务）**：歌单页那个「新建歌单」输入框**还没这道闸**
⇒ 用户手输超过 32 个字符 ⇒ 服务端拒 ⇒ 界面只显示英文的 `invalid arguments`。

### 六、⚠ 踩坑：等「终态」**还不够**，还得等「**这一轮真的发出去了**」

- 第一版复验脚本读「换一批」的读数是**假的**：面板上**已经**写着「随机挑了 20 首」（上一批的终态）
  ⇒ 脚本**立刻**返回 ⇒ 把第二批量成「**27 ms / 0 次请求**」（真实值是 7.1 秒 / 5 次请求）；
- ⇒ 修法两条：
  ① 等**按钮不再是「正在随机…」**（加载态结束）；
  ② 等 **NAS 请求数增长**（确认这一轮真的重新抽了样）；
- ⇒ 这条对 T96 同样成立（`t96-13` 的教训：**等终态 + 逐请求仪表**）。

### 七、验证结果（**全量新鲜跑**）

- `tsc --noEmit` **0 error**；
- Vitest **131 文件 / 2774 条**全绿（T97 新增 **2 文件 / 23 条**；既有 **2751** 条**一条未删、断言一条未弱化**）；
- Playwright **39 条**全绿（T97 新增 **3 条**）；`npm run build` exit 0；
- 字节体检 + 控制字符扫描 **0 bad**（10 个新增 / 改动文件）；
- **变异自证 4 条**全部「变红 ⇒ 还原回绿」。

### 八、还剩什么

- ⚠️ **既有缺陷（另开任务）**：歌单页「新建歌单」输入框**没有 32 字符闸**
  ⇒ 超长名会撞英文的 `invalid arguments`；
- ⚠️ **既有缺陷（另开任务）**：`normalizePageNumber()` 只管下界不管上界
  ⇒ 大库「加载更多」翻过第 2000 页会**重复第一页**（服务端静默回绕）；
- ⚠️ 「随机 20 首」抽到的是「**入库时间分散**」的歌 ⇒ **不等于**「久未听的 / 新入库的」；
- ⚠️ **存回会在 NAS 上真的建一个歌单** ⇒ 同名的要自己删（客户端**不会**自动删）。

## 六十六、T98：「有声读物」识别与按集序排列 —— 服务端实测基线（2026-11-16）

### 一、怎么测的（15 支探针，`release/verify/t98-01~16`）

| 探针 | 问什么 |
|---|---|
| `t98-06` | 「有声 / 小声」这类关键词搜出来的**是不是**有声 |
| `t98-07` | 搜索的**真实语义**（命中哪些字段 / 截断 / 分词） |
| `t98-08` | 穷举名字关键词（专辑名 / 目录名）能不能定位有声 |
| `t98-09` | 服务端有没有**目录浏览端点** |
| `t98-10` ~ `t98-12` | 换个路径找有声；`path` 到底进不进索引 |
| `t98-13` | **全库扫描**（869 页 / 17.3 万首 + 171 页 / 3.4 万张专辑） |
| `t98-14` | 用**真实小说名**核对：目录到底在哪 |
| `t98-16` | **真机复验**：真代码判定 + 排序 + 误伤核对 |

⚠ 探针输出**只记形状与计数**（不落真实歌名 / guid）；真实 userData **只读**。

### 二、⚠ 服务端实测事实（**代码按这些写，但别当通用契约**）

| 项 | 实测结论 | 对代码的影响 |
|---|---|---|
| **`/track/list` 上限** | `size` 与 `page` 上限都是 **2000**；`total = 173671`（本机该账号） | ⇒ 扫全库只要 **87 页**（`size=2000`） |
| **默认排序 `createdAt,desc`** | 相邻页的曲目导入时间挨着 | ⇒ 「乱」的根源不是服务端乱序，而是**同秒无二级排序键** |
| **`sort` 只认 `createdAt` / `title`** | `title,asc` 生效，但**变长数字前缀的字典序会错** | ⇒ `sort=title` **不入生产路径** |
| **`/album/list` 有 `trackCount`** | `total = 34074` | ⇒ 目录过滤参数**被忽略** ⇒ 目录只能从 `path` 反推 |
| **没有任何目录浏览端点** | 20 个候选路径全返回 `null` | ⇒ 「作品目录」只能从 `path` **倒数第 3 段**取 |
| **搜索是 top-N 截断且命中集不稳定** | `/search/track` 命中 title / album / **artists[].name** / path；子串 + 分词 OR；`total` 上限 **500**；纯 ASCII 短 token（`vol1`）不入索引 | ⇒ ⭐ **「搜不到」不能证明「不存在」** ⇒ 存在性结论只能靠**全量扫描** |
| **`audioSpec.path` 形状** | `/vol02/1000-0-3d135437/<多层目录>/<文件>`；一级目录几乎只有 `vol02`（173670）与 `vol1`（1） | ⇒ 同一作品可能**跨分段目录**（`Disc 01` / `0001-0115`） |
| **真·有声的量** | path 含 `/vol02/1000-0-3d135437/有声小说/…` ⇒ **5244 首**（占 3.0%）；时长 ≥ 480 s ⇒ **9029 首** | ⇒ ⭐ **单靠时长会误伤 42%** ⇒ 必须靠「标题形态一致」联合判定 |

### 三、真实形态（`t98-14` 实测，决定集号规则怎么写）

| 作品 | 集数 | 标题形态 | 命中规则 |
|---|---|---|---|
| 《三体》 | 89 | `21- 序章` | `dash-prefix` |
| 《牧神记》 | 2762 | `0010` | `digits-only` |
| 《赶尸客栈》 | 288 | `025- 第01季25` | `season-episode` |
| 《让青春继续第一季》 | 31 | `让青春继续第一季 10` | `trailing` → 季集式 |
| 《茨厂街》（谐剧磁带） | 1 | `茨厂街（粤语谐剧…）` | 解析不出集号 |

⚠ **`trackNo` 在真·有声内容里大多是 `null`**（上面 4 部全是）⇒ 排序的 `trackNo` 层**多半用不上**，只当兜底。

### 四、识别信号表（**不引用任何专辑名 / 目录名**）

| 信号 | 判据 | 分值 |
|---|---|---|
| `avg-duration` | 单集**均长** ≥ 8 分钟 | +2 |
| `long-duration` | 单集**均长** ≥ 20 分钟 | +1 |
| `very-long-track` | **最长单集** ≥ 30 分钟 | +1 |
| `episode-pattern` | 标题形态一致（**命中率 ≥ 60%**）**且与时长联动** | +2 |
| `many-episodes` | 集数 ≥ 8 | +1 |
| `single-work-dir` | 曲目集中在**同一作品目录**（path 倒数第 3 段唯一） | +1 |

⇒ **≥ 4 分**判为有声读物；普通音乐专辑实测 ≤ 2 分。

### 五、集号解析（`parseEpisode`）与排序

- 规则优先级（命中数相同时取更具体的）：`season-episode` > `episode-cn` > `dash-prefix` >
  `dotted-prefix` > `digits-only` > `trailing` > `mid-number` > `bracket`；
  ⭐ **T103 已更正**：`bracket` 降到**最末**兜底（数字位置最松 ⇒ 真实数据里常是「分集后缀」）；
  旧口径 `bracket` > `digits-only` > `trailing` **作废**。
- **专辑级形态一致性** ≥ 60% 才用该规则排序，否则**整张专辑保持原序**（宁可不动也不乱）；
- 四层稳定排序键：集号 → `trackNo`（**仅当质量合格**：有值率 ≥ 90% 且去重率 ≥ 90%）→
  `createdAt` → 原下标；
- ⭐ **纯数字标题不做年份保护**（见「六十七」第五节：真机踩到的坑）。

### 六、扫描与落盘

- **只扫曲库**（87 页）+ 客户端本地按专辑聚合 ⇒ 省掉约 **3.8 万次**专辑详情请求；
- 落盘**只留候选专辑的结构指标**（集数 / 总时长 / 最长 / **形态统计** / 作品目录）+ 断点 + 改判；
- ⚠ 形态统计存的是「**每条规则命中了多少个标题**」+「标题总数」，**不存标题样本**
  （17.3 万首的库候选上万张 ⇒ 存标题样本会**超 localStorage 配额** ⇒ 续跑静默失效）；
- 持久化走 **`localStorage`**（不是 `prefs.json`：那是凭证白名单的安全边界）。

### 七、验证结果

- `tsc --noEmit` **0 error**；
- Vitest **135 文件 / 2827 条**全绿（T98 新增 **4 文件 / 53 条**：detect / sort / store / page）；
- Playwright **42 条**全绿（T98 新增 **3 条** E2E，见「六十八」）；`npm run build` exit 0；
- 字节体检 + 控制字符扫描 **0 bad**；
- **变异自证 5 条**全部「变红 ⇒ 还原回绿」。

### 八、还剩什么

- ⚠ **增量水位（`sinceCreatedAt`）API 已有但 store 未启用** ⇒ 「重新扫描」仍是全量；
- ⚠ **识别是「宁可多标」** ⇒ DJ 合辑这类结构区分不了 ⇒ 人工改判是主路径的一部分。

## 六十七、T98 真机复验：识别 / 排序 / 误伤（2026-11-16）

### 一、怎么验的

| 项 | 做法 |
|---|---|
| 应用 | **真代码的编译产物**（`tsc` 编 `src/api/audiobook.ts` 后 import）⇒ 验的是同一份源码，不是复制品 |
| 数据 | **真实 NAS**（本机 + 该账号），**只读** |
| 样本 | 4 张真·有声专辑（三体 / 牧神记 / 赶尸客栈 / 让青春继续第一季）+ **60 张随机普通专辑** |
| 脚本 | `release/verify/t98-16-realmachine-verify.mjs` |

### 二、4 张真·有声专辑：**全部**正确识别

| 专辑 | 集数 | 判定分 | 命中依据 | 形态规则（命中率） |
|---|---|---|---|---|
| 《三体》 | 89 | **8** | 均长 + 最长 + 形态 + 集数 + 目录 | `dash-prefix`（100%） |
| 《牧神记》 | 2762 | **6** | 均长 + 形态 + 集数 + 目录 | `digits-only`（100%） |
| 《赶尸客栈》 | 288 | **6** | 均长 + 形态 + 集数 + 目录 | `season-episode`（100%） |
| 《让青春继续第一季》 | 31 | **6** | 均长 + 形态 + 集数 + 目录 | `season-episode`（100%） |

### 三、排序正确性

| 专辑 | 解析出集号 | 排序后集号递增 | 重复集号 | 不丢不重 |
|---|---|---|---|---|
| 《三体》 | 89 / 89 | ✅ | 0 | ✅ |
| 《牧神记》 | 2762 / 2762 | ✅ | 0 | ✅ |
| 《赶尸客栈》 | 288 / 288 | ✅ | 0 | ✅ |
| 《让青春继续第一季》 | 31 / 31 | ✅ | 0 | ✅ |

⇒ ⭐ **2762 集（跨 1900–2100 区间的集号）全部解析**（这是本轮修掉的 bug，见第五节）。

### 四、误伤核对（60 张随机普通专辑）

| 项 | 结果 |
|---|---|
| 被判成有声的 | **1 张** |
| 是哪张 | 《茨厂街 磁带原版转录》—— 判定分 5、**均长 2706 秒（45 分钟）**、单集 |
| 算不算误伤 | ⛔ **不算**：它本身就是**长音频的有声内容**（粤语谐剧磁带转录） |

⇒ 在这 60 张普通专辑里，**结构信号零误伤**。
⚠ 但这**只代表那台机那批文件**（换库必须重测；阈值**不是**常数）。

### 五、⚠ 真机复验抓到的**真 bug**（已修 + 已加回归单测）

- **症状**：《牧神记》2762 集里，**201 集（`1900`–`2100`）被「年份保护」挡掉**
  ⇒ 解析不出集号 ⇒ 被排到末尾（用户看到「最后一批没集号」）；
- **真因**：`dash-prefix` / `bracket` / `trailing` 三条规则里都有一条「**4 位数且落在 1900–2100 ⇒ 当年份，不当集号**」的保护；
- **为什么必须留**：歌名正好是 `1900` 的概率极低，但「`2024- 某某`」这种**年份 + 文字**确实该挡；
- **修法**：**纯数字标题**（`0010`）**不做年份保护** ⇒ 一律按集号；带文字形态的仍保留保护；
- **修后**：《牧神记》**2762 / 2762 全部解析**，排序后集号**严格递增**；
- ⚠ **通用教训**：真实数据的**值域**会穿过任何「经验区间」⇒ 保护规则要**按形态**分，不能一刀切。

### 六、⚠ 复验后**自查出来的 5 个缺陷**（已修 + 变异自证钉住）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 进页面**自动全扫**（`useEffect` 调 `scan()`） | 首次进页就触发 87 页 / 6–47 分钟的扫描 |
| 2 | 续跑时**无条件**恢复旧聚合 | 上轮扫完再扫 ⇒ **集数翻倍** |
| 3 | 落盘存**每专辑 30 个标题样本** | 上万候选 ⇒ 数 MB ⇒ **超 localStorage 配额** ⇒ 续跑**静默失效** |
| 4 | 扫描路径用**均长**冒充「最长单集」 | 「≥ 30 分钟」那条信号判错 |
| 5 | 界面文案漏出 **Markdown 星号** | `识别只看**结构**` 原样显示 |

⇒ 修法：进页面只 `restore()`（**不触网**）；断点语义统一为「**下一个要扫的页**」；
落盘改存**形态统计**（规则 → 命中数 + 标题总数）⇒ 约 100 字节/张；
`judgeAlbum` 增加 `avgDurationSec` / `maxDurationSec` / `episodeStats` 覆盖项；
⇒ **变异自证 5 条**逐条「变红 ⇒ 还原回绿」（其中 2 条**第一轮没被证明** ⇒ 补了测试才过）。

### 七、验证结果（**全量新鲜跑**）

- `tsc --noEmit` **0 error**；
- Vitest **135 文件 / 2827 条**全绿（T98 新增 **4 文件 / 53 条**）；
- Playwright **42 条**全绿（T98 新增 **3 条** E2E）；`npm run build` exit 0；
- 字节体检 + 控制字符扫描 **0 bad**；
- **变异自证 5 条**全部「变红 ⇒ 还原回绿」；
- **真机复验**：4/4 识别正确、排序严格递增、60 张普通专辑零误伤。

### 八、还剩什么

- ⚠ **增量水位未在 store 启用** ⇒ 「重新扫描」仍是全量（87 页）；
- ⚠ **识别是「宁可多标」** ⇒ 人工改判是主路径的一部分；
- ⚠ 阈值（480 / 1200 / 1800 / 8 集 / 60% / 4 分）**是那台机的实测值** ⇒ 换库建议重测。

## 六十八、T98 E2E：mock 造 12 集有声专辑（2026-11-16）

### 一、这一轮补的是什么

规格 §七 验收点 4：**「E2E：mock 造一个 12 集有声专辑 ⇒ 详情页顺序 = 集号顺序 + 显示集号」**
—— 这是 T98 唯一**没做**的验收点（核心逻辑此前由**真机探针**覆盖，但界面流程没有自动化回归）。

### 二、⚠ mock 怎么加的（**共享 fixtures 一条不改**）

| 做法 | 结果 |
|---|---|
| ❌ 直接往 `mock-server/fixtures.ts` 的 `SONGS` 里加 12 首 | **会连累别的用例**：T97 断言「从你的曲库随机挑了 **8** 首」⇒ 加了就不是 8 首 |
| ✅ 给 `createMockServer()` 加 `options?: { songs?; albums? }`（**按实例注入**，不传 = 原 fixtures） | **默认行为一字不变** ⇒ 其它 39 条 E2E 一条不受影响 |

⇒ T98 的用例自己建一个 mock：`createMockServer({ songs: [...SONGS, ...AUDIOBOOK_SONGS], albums: [...ALBUMS, AUDIOBOOK_ALBUM] })`，
再用 `launchApp({ mock })` 启动（**该入口本来就有**，不用改 `e2e/helpers/app.ts`）。

### 三、12 集 fixture 的形态（**按真机实测仿**）

| 项 | 取值 | 为什么 |
|---|---|---|
| 单集时长 | **25 分钟** | 真·有声实测 9–32 分钟 ⇒ 均长信号成立 |
| 标题 | `01- 第1集` … `12- 第12集` | 真·《三体》同形（`dash-prefix`）⇒ 形态一致信号成立 |
| `path` | `…/有声小说/示例作者/示例有声作品/Disc 01/NN- ….mp3` | 倒数第 3 段 = 作品目录 ⇒ 目录唯一信号成立 |
| `trackNo` | **null** | 真·有声实测**多为 null** ⇒ 不能拿它当主排序键 |
| **数组顺序** | **故意打乱**（第 1 首是「07- 第7集」） | ⭐ 排序是**客户端自己**做的 ⇒ mock 若按集号顺序返回，**排序失效也照样通过** ⇒ 假阳性 |

⇒ 判定分 = 均长≥8 分钟(+2) + 均长≥20 分钟(+1) + 形态一致(+2) + 集数≥8(+1) + 目录唯一(+1) = **7 分**（≥ 4 判为有声）。

### 四、3 条 E2E 覆盖了什么

| # | 用例 | 钉住的行为 |
|---|---|---|
| 1 | 扫描曲库 ⇒ 识别出有声专辑 | 进页面**不自动扫**（空态 + 「还没扫描过」）⇒ 点按钮才扫；命中列表**只有**那一部（普通专辑**不出现**）；判定分 7 / 12 集 / 均长 25 分；依据**逐条**可读 |
| 2 | 点进专辑 ⇒ 按集序排 | 徽标「已按集序排列」；**乱序输入**被排成 01…12；每行「第 N 集」；「已加载 12 / 12」（**全量**都拉下来了） |
| 3 | 「这不是有声」⇒ 不再按集序排 | 徽标与集号标签**都消失**；回到 **mock 原序**（第 1 首 = 第 7 集）⇒ 证明确实「不再排」；回「有声」页**不再列出**（改判优先） |

### 五、⚠ E2E 变异自证（**5 条**，证明这些用例**咬得住**）

| # | 变异 | 变红的是 |
|---|---|---|
| E1 | `compareEpisode` 恒为 0（**排序失效**） | 用例 2（顺序不对） |
| E2 | 判定**过松**（`score < 0`）⇒ 普通专辑也命中 | 用例 1（列表里混进普通专辑） |
| E3 | 判定**过严**（`score < 999`）⇒ 一首也不命中 | 用例 1（列表空着） |
| E4 | 「不是有声」被**忽略** | 用例 3（仍然按集序排） |
| E5 | 进页面就**自动全扫** | 用例 1（那条「不自动扫」的约定被破） |

⇒ **5 条全部「变红 ⇒ 还原回绿」**（判定双重：退出码 ≠ 0 **且**输出含 failed；另有基线自检）。
⚠ **E2E 跑的是构建产物** ⇒ 每次变异后必须**重新 build**（脚本里已含）。

### 六、验证结果

- `tsc --noEmit` **0 error**；
- Vitest **135 文件 / 2827 条**全绿（**本轮未动单测**）；
- Playwright **42 条**全绿（T98 新增 **3 条**）；`npm run build` exit 0；
- 字节体检 + 控制字符扫描 **0 bad**；
- **E2E 变异自证 5 条**全部「变红 ⇒ 还原回绿」。

### 七、还剩什么

- ⚠ **增量水位（`sinceCreatedAt`）API 已有但 store 未启用** ⇒ 「重新扫描」仍是全量（87 页）；
- ⚠ **识别是「宁可多标」** ⇒ DJ 合辑这类结构区分不了 ⇒ 人工改判是主路径的一部分；
- ⚠ E2E 的 mock 只有 **12 集** ⇒ 覆盖不到「**跨分段目录**」与「**集号 > 2000**」这两种形态
  （真机侧已由探针 ⑯ 在真实数据上验过：《牧神记》2762 集跨 1900–2100 全部解析）。

## 六十九、T98 v3 改版：「用户指位置」+ 并发扫描（2026-11-16）

### 一、这一轮改的是什么（**用户实机反馈**）

用户原话：「**有声做得不行啊**」「**有声可以不扫吗，直接默认那个文件夹不就行吗？**」

⇒ v2 的做法（结构信号打分 ≥ 4 分 ⇒ **自动**决定谁能进列表）是**猜**：
猜错的代价 = 该有的没出现 + 不是有声的混进来 ⇒ 改成**用户指位置**。

### 二、三个判定**拆开**（不再混成一个分数）

| 问题 | v3 判定依据 | 来源 |
|---|---|---|
| **是不是有声** | ① 作品名秒搜**点开** ② 目录 `path` **关键字命中** ③ 手动改判 | **用户** |
| **能不能按集序排** | **形态一致性 ≥ 60%**（不够就如实说「没识别到集号，保持原有顺序」） | 标题形态 |
| **像不像有声** | 结构信号打分（**只做参考信息**，照旧显示判定分 / 依据 / 集数 / 均长） | 结构 |

⚠ **目录名只用来「定位」**，不用来**推断**「是不是有声」⇒「不靠目录名猜」这条不变量仍成立；
⚠ 目录关键字是**用户输入的默认值**（默认「有声小说」，**可改**）⇒ 不把因人而异的目录名写死成判据。

### 三、实测基线（2026-11-16，本机 + 该账号，探针 `t98-21/22/23`）

| 项 | 实测 | 结论 |
|---|---|---|
| 搜「有声小说」 | `total=37`，但 **path 命中 0 条**（全是标题带「小说」的音乐）；**分页无效**（page 1~6 返回同样 37 条）、`size` 被忽略 | **搜目录名无效** ⇒ 只能客户端按 `path` 过滤 |
| 目录关键字「有声小说」 | 全库命中 **5,244 首 / 10 张专辑**（max 2762 集；≥8 集 8 张；≥20 集 7 张；≥100 集 5 张） | 「那个文件夹」= **客户端按 path 的目录段过滤** |
| 作品名秒搜 `/search/album?q=` | 「牧神记」1 条 / **106 ms**；「三体」2 条；「赶尸客栈」1 条 | **定位单部作品不用扫库** |
| 扫描并发（`/track/list` `size=2000`） | 顺序 6 页 **7,323 ms** ⇒ 并发 8 路 **4,944 ms**（**1.48×**）；全量 87 页并发 **52,193 ms ≈ 52 s**（顺序 ≈ 106 s） | 瓶颈是**带宽** ⇒ 取 **8 路** |
| 服务端过滤 / 排序参数 | `sort=duration,desc` **无效**；**12 个过滤参数全部无效**（`total` 恒 173,671） | 枚举曲库**只能扫 87 页** |

### 四、⚠ 服务端能力硬约束（**别再试**）

1. **没有目录浏览端点**（20 个候选全 `null`）⇒ 「那个文件夹」只能客户端按 `path` 过滤；
2. **搜索只能当「发现」**（top-N 截断 + 命中集不稳定 + 中文被分词 + 分页无效）
   ⇒ 「搜不到」**不能**证明「不存在」；
3. **没有任何过滤参数**，`sort` 只认 `createdAt`（±）与 `title,asc`。

### 五、改了哪些文件

- **改** `src/api/audiobook.ts`：+`pathSegments` / `pathMatchesKeyword` / `DEFAULT_FOLDER_KEYWORD`（纯函数）；
- **改** `src/api/library.ts`：`scanLibraryTracks()` + `concurrency`（默认 8）——**批内并发、批内按页序回调**（断点语义不变）；
- **改** `src/api/search.ts`：+`searchApi.albums(q)`（只打 `/search/album`）；
- **改** `src/state/audiobookStore.ts`：落盘 +`keyword`（`STATE_VERSION` → 3）；**按目录关键字过滤**；**打分不再当门槛**；**换关键字 ⇒ 断点作废**；命中过多 ⇒ 如实告知 + 只留 500 部；
- **改** `src/pages/AudiobooksPage.tsx` (+css)：「按作品名找」区 + 「按目录找」区 + 每条标明**来源**（目录 / 你指定的）+「结构信号弱」标记；
- **新增** `test/audiobook-scan.test.ts`（4 条）；**改** 3 个既有测试文件（**+13 条**，既有断言**一条未删、一条未弱化**；按钮改名那处**改写为新行为**并说明）。

### 六、验证结果

- `tsc --noEmit` **0 error**；
- Vitest **136 文件 / 2844 条**全绿（本轮 **+17 条**）；
- Playwright **44 条**全绿（T98 **5 条**）；
- `npm run build` exit 0；字节体检 + 控制字符扫描 **0 bad**（12 个改动文件）；
- **变异自证**：单测 **11 条** + E2E **7 条**，全部「**变红 ⇒ 还原回绿**」（判定双重 + 基线自检）。

### 七、还剩什么

- ⚠ **改目录名要重扫一次**（过滤发生在扫描时）⇒ 约 52 秒；
  没做「落盘全部候选的目录段 ⇒ 换目录秒切」（34,074 张专辑的目录段全落盘 ⇒ **超 `localStorage` 配额**）；
- ⚠ **增量水位（`sinceCreatedAt`）store 层仍未启用** ⇒ 「重新扫描」仍是全量；
- ⚠ **秒搜只能当「发现」** ⇒ 同名作品可能搜不全（界面已如实说明，并保留目录扫描兜底）；
- ⚠ **打分不作门槛** ⇒ 那个目录下的非有声作品也会列出（标「结构信号弱」+ 一键改判）；
- ⚠ **真机复验**（真实 NAS + 真实账号）**还没跑这一版** ⇒ 待用户实测确认。

## 七十、T98 v3 真机复验（真实 NAS + 真实账号，2026-11-16）

> 探针 `release/verify/t98v3-05-realmachine-verify.mjs`（只读；隔离 userData；
> 判定与排序用 `src/api/audiobook.ts` 的 **tsc 编译产物** ⇒ 验的是同一份源码）。

### 一、作品名秒搜《牧神记》（v3 入口一）

| 项 | 实测 |
|---|---|
| `/search/album?q=牧神记` | 命中 **1 条**（total=1），**255 ms** |
| 拉全量（`/track/album-detail/list` 分页拉完） | **2762 集** |
| 真代码排序 | 形态规则 `digits-only`（命中率 **100%**），解析 **2762 / 2762** |
| 排序结果 | 集号**严格递增**、**不丢不重**、重复集号 **0**；前三 `[1][2][3]`、后三 `[2760][2761][2762]` |

⇒ ⭐ **1900–2100 区间也排对了**（v2 修过的真 bug「201 集被年份保护挡掉」**没复发**）。

### 二、扫「有声小说」目录（v3 入口二）

| 项 | 实测 |
|---|---|
| 全量 `/track/list`（**并发 8 路**） | **87 页 / 173,671 首**，**51.4 秒**（上一轮探针 52.2 秒 ⇒ 一致） |
| 命中 | 预筛（子串）5244 首 ⇒ **真代码目录段匹配 5244 首（否决 0 首）** ⇒ **10 张专辑**（与上一轮探针**完全一致**） |

| 专辑 | 集数 | 判定分 | 形态规则（命中率） | 解析 | 递增 | 不丢不重 | 重复集号 |
|---|---|---|---|---|---|---|---|
| 牧神记 | 2762 | 6 | `digits-only`（100%） | 2762 | 是 | 是 | 0 |
| **极品家丁** | **1333** | 4 | **无（1%）** | **0** | — | 是 | 0 |
| 娱乐春秋 | 384 | 7 | `episode-cn`（99.5%） | 382 | 是 | 是 | 0 |
| 盗墓笔记 | 337 | 7 | `dash-prefix`（100%） | 337 | 是 | 是 | 0 |
| 赶尸客栈 | 288 | 6 | `season-episode`（100%） | 288 | 是 | 是 | 0 |
| 三体 | 89 | 8 | `dash-prefix`（100%） | 89 | 是 | 是 | 0 |
| 让青春继续第一季 | 31 | 6 | `season-episode`（100%） | 31 | 是 | 是 | 0 |
| 让青春继续第三季 | 13 | 6 | `season-episode`（100%） | 13 | 是 | 是 | 0 |
| 让青春继续第二季 | 6 | 5 | `season-episode`（100%） | 6 | 是 | 是 | 0 |
| 让青春继续第一季 | 1 | 5 | `season-episode`（100%） | 1 | 是 | 是 | 0 |

### 三、交叉核对

两条路径（秒搜 / 目录扫描）指向**同一张《牧神记》专辑**（guid 一致），集数两边都是 **2762**
⇒ v3 的两个入口互相印证。

### 四、⚠ 复验抓到的**两个真问题**（**已由 T99 修** ⇒ 见第七十一节）

1. **《极品家丁》1333 集**排不了：标题形态是 `极品家丁 1332 万千柔情（完结）`
   ⇒ 集号在标题**中段**（前面是作品名）⇒ 现有 7 条规则都要求集号在**开头或结尾**
   ⇒ 解析率 **1.1%** ⇒ 形态不一致 ⇒ **不排序**、保持原序
   ⇒ 而服务端原序是 `createdAt,desc` ⇒ 用户看到的是**倒着**的（`0000预告片` 在最后）
   ⇒ ⇒ 需要**新增一条集号规则**（集号出现在标题中段）⇒ **T99 已加 `mid-number`**；
2. **《让青春继续第一季》出现两条**：服务端把 31 集那季 + 1 集那首（`让青春继续第一季 02`）
   拆成了**两张同名专辑** ⇒ 列表里会出现两条同名条目 ⇒ 需按**作品目录**归并成一部
   ⇒ **T99 已归并**（同名 + 同作品目录 ⇒ 一条；详情页按整组合并 ⇒ 第 02 集不再丢）。

⚠ 以上数字**只代表那台机那批文件**（换库必须重测；阈值不是常数）。

## 七十一、T99：「集号在中段」+ 同名专辑按作品目录归并（2026-11-16）

### 一、这一轮改的是什么

第七十节（T98 v3 真机复验）抓到的**两个真问题**，本轮一起修：

| # | 问题（真机实测） | 本轮怎么修 | 改哪儿 |
|---|---|---|---|
| ① | 《极品家丁》1333 集的标题形态是「作品名 + 空格 + 4 位数字 + 标题」⇒ 集号在**中段** ⇒ 现有 7 条规则都要求集号在**开头或结尾** ⇒ 解析率 **1.1%** ⇒ **不排序**（服务端原序是 `createdAt,desc` ⇒ 倒着） | 新增集号规则 **`mid-number`**（**放最后** ⇒ 不抢更具体的规则） | `src/api/audiobook.ts` |
| ② | 《让青春继续第一季》被 NAS 拆成**两张同名专辑**（31 集 + 1 集）⇒ 列表两条同名，**第 02 集丢了** | **同名 + 同作品目录 ⇒ 归并成一条**；详情页按**整组**拉全量后合并排序 | `src/state/audiobookStore.ts` / `src/pages/DetailPage.tsx` / `src/pages/AudiobooksPage.tsx` |

### 二、`mid-number` 的形态（**只加实测形态**）

- 规则：`/^(.+?)\s+(\d{1,5})(?:\s*.*)?$/` —— **前面必须有文字**、**数字后可无空格**接文字（实测 `极品家丁 0000预告片`）；
- **不做年份保护**（与 `digits-only` 同理：2000+ 集的长篇真实存在 ⇒ 靠**形态一致性 ≥ 60%** 兜底）；
- **放规则表最后** ⇒ 最宽松 ⇒ 不抢 `season-episode` / `trailing` / `digits-only` / `dash-prefix`；
- ⚠ 形态门槛（≥ 60%）**没放宽** ⇒ 普通音乐专辑不会因为多了这条规则就被排。

### 三、归并规则

| 组合 | 归并？ |
|---|---|
| 同名 + **同作品目录** | ✅ 合成一条（集数相加；主专辑 = 集数最多的那个） |
| 同名 + 不同作品目录 | ❌ 那是真的两部作品 |
| 不同名（季 / 卷） | ❌ 各算一部 |
| 作品目录**不唯一** | ❌ 信息不足 ⇒ 宁可分开 |

⚠ **聚合仍按 `albumId`**（实测存在「一张专辑横跨多个作品目录」⇒ 用归并键当**聚合**键会把一张专辑拆成两条）⇒ **归并放在判定阶段**。
⚠ **落盘形状不变**（`CandidateSnapshot.dirs` 已含作品目录集合 ⇒ 唯一作品目录可派生）⇒ `STATE_VERSION` **不升**（旧落盘不作废）。

### 四、本轮验证（**单机 / mock**，2026-11-16）

- `tsc --noEmit`：**0 error**；
- Vitest：**136 个文件 / 2854 条**全绿（T99 新增 **10 条**）；
- Playwright：**48 条**全绿（T99 新增 **4 条**）；
- **变异自证**：单测 **8 条** + E2E **6 条**，**全部**变红 ⇒ 还原回绿；
- ⚠ **真机复验还没跑这一版**（见第五节）。

### 五、⚠ 真机复验（**下一轮** ⇒ **已跑**，结果见**第七十二节**）

- ⚠ 本节原列的两条待验项，**2026-11-16 已在真实 NAS 上复验** ⇒ 完整结果见**第七十二节**；
- 一句话结论：**《极品家丁》** 主体排对了、**预告片排最前** ✓（但有 **14 集**因规则优先级掉队 ⇒ **另开任务**）；
  **《让青春继续第一季》** **合成 32 集**、**第 02 集在场** ✓；
- ⚠ 上面的数字（1333 集、31 + 1 = 32）**只代表那台机那个账号**（换库必须重测；阈值不是常数）。

## 七十二、T99 真机复验（真实 NAS + 真实账号，2026-11-16）

> 探针 `release/verify/t99-08-realmachine-verify.mjs`（只读；隔离 userData；
> 判定与排序用 `src/api/audiobook.ts` 的 **tsc 编译产物** ⇒ 验的是同一份源码）；
> 补充核算用 `release/verify/t99-10-realmachine-episode-gap.mjs`（掉队集的编号 vs 主序列缺的编号）；
> 另走一遍**真实界面**（真实 Electron + 真实 NAS）验「归并 + 详情页按组拉」这条生产链路。

### 一、《极品家丁》1333 集（集号在**中段**）

| 项 | 实测 | 结论 |
|---|---|---|
| 秒搜 `/search/album?q=极品家丁` | 命中 **65** 条 ⇒ 名字全等 **1** 张 ⇒ 拉全量 **1333 集**（服务端 `trackCount = 1333`） | 单点定位 ✓ |
| 作品目录（真代码 `workDirOf`） | `极品家丁` | 唯一 ✓ |
| 形态规则 | **`mid-number`**（命中率 **98.9%**，解析 **1319/1333**） | ⭐ 新规则在真机上**生效**（T98 v3 时是 `null` / 1% / 解析 0） |
| 排序后集号 | 范围 **0…1332**；**严格递增 ✓**；**不丢不重 ✓**；重复集号 **0** 个；⚠ **集号不连续**（缺 **14** 个编号） | ⭐ **主体排对了**（T98 v3 时**完全排不了**） |
| 预告片位置 | 排序后**第一行** = `极品家丁 0000预告片`（标签「第 0 集」）；库里预告片 **1** 个 | ⭐ **预告片排最前 ✓** |
| 界面 | 详情页「已按集序排列」+「已加载 **1,333** / 1,333」；列表条目「判定分 6 · 1333 集 · 单集均长 9 分」 | 生产链路一致 ✓ |

⚠ **一个真发现（新问题 ⇒ 另开任务）**：**14 集（1.1%）没进序列** —— 它们的标题末尾带
→「（1）/（2）」（如 `极品家丁 0219 夫人的阴谋（1）`）⇒ 命中了**更早的 `bracket` 规则**
⇒ 专辑级「**只用胜出的那一条规则**」⇒ 它们的集号被当成「**没有集号**」⇒ **排到了末尾**。

⭐ **补充核算（探针 `t99-10`）把修法定死了**（这一条决定了下一步怎么修）：

| 问 | 实测 | 含义 |
|---|---|---|
| 各规则命中数 | `mid-number` **1319** / `bracket` **14** | 掉队的正好是那 14 集 |
| 主序列缺的编号 | **219 / 220 / 268 / 269 / 298 / 299 / 311 / 312 / 330 / 331 / 404 / 405 / 447 / 448**（共 14 个） | 1333 集里**编号有洞** |
| 掉队 14 集的**中段数字** | **219 / 220 / 268 / 269 / 298 / 299 / 311 / 312 / 330 / 331 / 404 / 405 / 447 / 448**（**完全相同**） | ⭐ 掉队的**就是**缺的那 14 集，**不是**额外内容 |
| 若让它们用中段数字 | **撞号 0 个**；整体去重后**仍无重复** | ⇒ 调优先级**不会**引入重复集号 |

⇒ **结论**：1333 集与编号 0…1332 **一一对应** ⇒ 把 `mid-number` 提到 `bracket` 之前
（或让专辑级「胜出规则」**同源兜底**）就能**全部排对** ⇒ **T100 的修法已定**（本轮**不修**）⇒ ⭐ **T103 已修**（2026-11-17，见「七十九」）。
⚠ 这些标题的形态是「**同一部作品连着两集**共用一个剧名」（如 0219 夫人的阴谋（1）/ 0220 夫人的阴谋（2））⇒
「（1）/（2）」是**分集后缀**、**不是**集号 ⇒ 不能拿它当集号。

### 二、《让青春继续第一季》（被 NAS 拆成**两张同名专辑**）

| 项 | 实测 | 结论 |
|---|---|---|
| 秒搜 `/search/album?q=让青春继续第一季` | 命中 **315** 条 ⇒ 名字全等 **2 张**：**31 集** + **1 集** | ⭐ 确实是**两张同名专辑** |
| 作品目录 | 两张都是 `让青春继续`（分段目录也相同） | ⭐ 归并键命中 ✓ |
| 归并后 | **32 集**；形态规则 `season-episode`（**100%**，32/32）；集号 **1…32 连续 ✓**；不丢不重 ✓；重复 0 | ⭐ **合成一部了** |
| **第 02 集** | 在归并结果里（`让青春继续第一季 02`，来自**被拆出去那张**的 guid `5f548503…`） | ⭐ **以前丢的那一集回来了** |
| 界面（列表） | 「有声」页 **9** 条（T98 v3 时 **10** 条）⇒《让青春继续第一季》**只出现 1 次**：「判定分 6 · **32 集** · 单集均长 14 分 · **合并了 2 张专辑**」 | ⭐ **归并在真实界面上可见** |
| 界面（详情页） | 「已加载 **32 / 32**」+「已按集序排列」；**第 02 集在场** | ⭐ 详情页按**整组**拉全量 ✓ |

⚠ **一个既有的展示口径**（**不是** T99 引入的）：《让青春继续第一季》的集号标签是「第 **1.2** 集」
这种**季.集**形态 —— 它的标题形态是 `让青春继续第一季 02` ⇒ 命中 T98 的 `season-episode` 规则
（值 = `[季, 集]`）⇒ 标签按 `episode.join('.')` 渲染；《极品家丁》则是「第 2 集」这种**单段**形态
（`mid-number` 不带季）。⇒ 两种都**如实**，但「1.2 集」对用户不直观 ⇒ **另开任务**讨论。

### 三、⚠ 探针自己踩的三个坑（都已修，记下来）

1. **状态行带千分位**：`formatCount` ⇒ `已加载 1,333 / 1,333` ⇒ 正则 `(\d+)` 匹配不上
   ⇒ **等超时**（第一版探针就在这儿白等了 180 秒）；
2. **曲目列表是虚拟滚动**（`startIndex/endIndex`）⇒ **DOM 里只有可视窗口那几十行**
   ⇒ 全量顺序**不能**从 DOM 数行数（要用「已加载 N / N」状态行 + 真代码那侧的全量数据）；
3. ⚠ **「滚到底」也读不到真末行**（第三版探针实测）：等 `data-scroll-top` 变化后读到的**仍是首屏窗口**
   （《极品家丁》读到的末行是「第 17 集」、《让青春继续》是「第 1.18 集」，都等于首屏最后一行）
   ⇒ **DOM 的「末行」一律不可信**，不作为结论；全量顺序只认 **Node 路**（真代码 + 全量数据）。

⚠ 以上数字**只代表那台机那个账号**（换库必须重测；阈值不是常数）。

## 七十三、T100：「那个文件夹里的都是有声小说」（2026-11-17）

> 起因：用户两句 —— 「**不能一本小说就是一个专辑这样显示出来吗，不需要点搜索**」
> ＋「**有声小说就只放在那个文件夹里，那文件夹里的都是有声小说**」。
> ⇒ 口径钉死：**位置即判定** ＋ **一本小说一条** ＋ **不用点搜索 / 不用点扫描**。

### 一、用户拍板的口径

| # | 口径 | 说明 |
|---|---|---|
| P1 | **位置即判定** | 命中「那个文件夹」⇒ **就是**有声小说；**不再**用打分当门槛 |
| P2 | **一本小说 = 一条** | 列表一行 = 一部作品（**专辑名 + 唯一作品目录**） |
| P3 | **不用点搜索** | 进页**第一屏就是列表**；搜索降级为「直达一部作品」的加速器 |
| P4 | **不用点扫描** | 没扫过 ⇒ **自动开扫**；扫完落盘 ⇒ 之后**秒开** |
| P5 | **季不合并** | 《让青春继续》第一/二/三季各一条（各季集号都从 01 开始 ⇒ 并了撞号） |

⚠ **P1 的推论**：界面**不再**拿「判定分」当主信息、**不再**说「结构信号弱（可能不是有声）」
—— 那与用户刚指认的口径**自相矛盾** ⇒ 已去掉（依据仍保留在「为什么」里）。

### 二、服务端硬约束（2026-11-17 **实测**，探针 `t100-01`）

| 端点 | 实测 | 有没有作品目录 |
|---|---|---|
| `/album/list` | total **34,074** 张专辑、页上限 **2000**（⇒ **18 页**，比扫曲目便宜 5 倍） | ❌ **不返 path** |
| `/album/detail` | 同上字段 | ❌ **不返 path** |
| `/track/list` | 173,671 首；曲目的 `audioSpec.path` **带完整 NAS 路径** | ✅ **只有曲目上有目录** |
| 目录浏览端点 | 20 个候选**全 null** | ❌ 没有 |

⇒ **按目录分组只能扫曲目**（87 页 / 52 秒）⇒ 一次落盘、之后秒开；
⇒ **秒搜归并**只需**每个候选补拉 1 首**（`size=1`）⇒ 每个候选 **1 个请求**。

### 三、改了什么

| 层 | 文件 | 内容 |
|---|---|---|
| 领域 | `src/api/audiobook.ts` | 新增 **`workGroupKey`**（归并键的**单一来源** ⇒ 扫描与秒搜口径一致） |
| 领域 | `src/api/library.ts` | 新增 **`albumWorkDir`**（只拉 1 首拿目录 ⇒ 每候选 1 个请求） |
| 状态 | `src/state/audiobookStore.ts` | 新增**临时组** `extraGroups` + `registerGroup`（**不落盘** ⇒ `STATE_VERSION` 仍为 3） |
| 渲染 | `src/pages/AudiobooksPage.tsx` | 列表**置顶**；**自动开扫**；**秒搜归并**；去掉「判定分」「结构信号弱」 |
| 渲染 | `src/pages/DetailPage.tsx` | 组的查找**并上** `extraGroups` ⇒ 搜索进来也按**整组**拉（第 02 集不丢） |

### 四、验证（单机 / mock，2026-11-17）

- `tsc --noEmit`：**0 error**；
- Vitest：**136 个文件 / 2859 条**全绿（T100 新增 **5** 条）；
- Playwright：**53 条**全绿（T100 新增 **5** 条）；
- **变异自证 5 条**（全部变红 ⇒ 还原回绿）：自动扫被摘掉 / 秒搜不归并 / 详情页不认临时组 /
  界面恢复判定分 / 列表挪到最后；
- ⚠ **既有断言改写为新行为**（**前提被用户显式推翻**）：T98 E2E 3 处、T99 E2E 1 处、页面组件测试 3 处
  ⇒ **一条未删、其余未弱化**；「从**非主成员**进去」那条路径现在**产品上不可达** ⇒ 覆盖改由**单测**承担。

### 五、⚠ 遗留 / 待办

- ⚠ **自动扫第一次约 1 分钟**（87 页 / 52 秒）⇒ 页面必须**如实显示进度**；
- ⚠ 秒搜归并**只补拉 1 首**拿目录 ⇒ 某张专辑**跨多个作品目录** ⇒ 目录不唯一 ⇒ **不归并**；
- ⚠ **14 集掉队**（《极品家丁》标题末尾带「（1）/（2）」⇒ `bracket` 抢走中段集号 ⇒ 集号不连续）
  ⇒ **另开任务**修（修法已定：`mid-number` 提到 `bracket` 之前；补充核算已证明**不撞号**）；
- ⚠ 数字**只代表那台机那个账号**（换库必须重测；阈值不是常数）。

## 七十四、T100 真机复验（真实 NAS + 真实账号，2026-11-17）

> 探针 `release/verify/t100-06-realmachine-verify.mjs`：**只读**；隔离 userData（只复制 `session.bin` + `Local State`）；
> 走**真实界面**（真实 Electron + 真实 NAS）验「自动扫 → 一本一条 → 秒搜归并 → 详情按整组拉」整条生产链路；
> 判定与排序另走一遍 **Node 路**（`src/api/audiobook.ts` 的 **tsc 编译产物** ⇒ 验的是同一份源码）。

### 一、自动扫描（**没点任何按钮**）

| 项 | 实测 | 结论 |
|---|---|---|
| 进「有声」页 | **自己开始扫了**（首次采样 1.5 秒时：正在扫描…第 1 页 / 共 87 页（已扫 2000 首）） | ⭐ **不用点扫描** ✓ |
| 扫描用时 | **52.1 秒**（87 页） | 与 T98 v3 实测**同量级**（52 秒） |
| 结束后状态行 | 「上次扫描：2026/11/17 00:35:26 · 目录「有声小说」· **9 部**」 | 如实显示进度与结果 ✓ |

### 二、列表：**一本一条** + **无判定分** + **置顶**

| 项 | 实测 | 结论 |
|---|---|---|
| 列表条数 | **9** 条（三体 / 娱乐春秋 / 盗墓笔记 / 牧神记 / 极品家丁 / 赶尸客栈 / 让青春继续第一季·第二季·第三季） | ⭐ 一部作品一条 |
| 《让青春继续第一季》 | **只出现 1 次** = 「**32 集** · 单集均长 14 分 · **合并了 2 张专辑**」 | ⭐ **归并成一条** ✓ |
| 季 | 第一季 **32** / 第二季 **6** / 第三季 **13** ⇒ **各一条** | ⭐ P5「季不合并」✓ |
| 界面文本 | **没有「判定分」** | ⭐ P1「位置即判定」✓ |
| 布局 | 列表在「搜作品」**之前**（`list-before`） | ⭐ P3「不用点搜索」✓ |

### 三、秒搜 ⇒ **一条** ⇒ 进去看全集

| 项 | 实测 | 结论 |
|---|---|---|
| 秒搜结果 | 命中 **312** 条 ⇒ **第 1 条** = 「32 集 · 合并了 2 张专辑」 | 一本小说一条 ✓ |
| 详情状态行 | 「**已加载 32 / 32**」+ 徽标「**已按集序排列**」 | 按整组拉全量 ✓ |
| **第 02 集** | **在场**（`让青春继续第一季 02`）；前几行 = 01 / 02 / 03 / 04 | ⭐ 用户要的那一集**看得见** ✓ |
| DOM 行数 | 18 ⇒ **虚拟滚动**，不是总数 | 全量顺序只认 Node 路 |

### 四、再进一次 ⇒ **秒开**（落盘生效）

| 项 | 实测 | 结论 |
|---|---|---|
| 第二次进「有声」页 | 状态行仍是「上次扫描：2026/11/17 00:35:26 … · 9 部」；列表 **9** 条；**又扫了吗 = false** | ⭐ **落盘 ⇒ 不用再等 52 秒** ✓ |

### 五、Node 路复核（真代码，`src/api/audiobook.ts` 的编译产物）

| 项 | 实测 | 结论 |
|---|---|---|
| 秒搜 | 命中 **315** 条 ⇒ 名字全等 **2 张**（**31 集** + **1 集**，作品目录都是 `让青春继续`） | ⭐ 确实是两张同名专辑 |
| 归并组 | **2 成员 / 共 32 集**；规则 `season-episode`（**100%**，32/32） | ⭐ 归并 + 判定一致 |
| 集号 | **1…32**；**递增 ✓**；**连续 ✓** | ⭐ 集号连续 |
| **第 02 集** | 在场 ✓；排序后前三 = 01 / 02 / 03 | ⭐ |
| ⚠ 命中集不稳定 | 界面 **312** 条 / Node 路 **315** 条 | 服务端**子串 + top-N** ⇒ 混着《青春的喝彩》《继续》等**不同名**作品 ⇒ 按 P5 **各自一条** ⇒ **归并只对「同名 + 同目录」生效** |

### 六、⚠ 探针自己踩的坑（已修，记下来）

1. ⚠ **「递增 / 连续」第一轮判成 false** ⇒ 原因：拿**服务端原序**（`createdAt,desc`）看集号 ⇒ 那是**原序**不是**产品的排序结果**
   ⇒ 正解：**先按集序排、再算集号** ⇒ 重跑 ⇒ 递增 / 连续 = **true**；
2. ⚠ 曲目列表是**虚拟滚动** ⇒ DOM 行数（18）**不是**总数 ⇒ 全量顺序只认 Node 路。

⚠ 以上数字**只代表那台机那个账号**（换库必须重测；阈值不是常数）。



## 七十五、T101：「有声」页 = 专辑页同款**封面卡片网格** + 播放模块三处（2026-11-17）

### 一、用户拍板的口径

| 诉求 | 原话 | 落地 |
|---|---|---|
| 形态 | 「**不能做成专辑业那样吗**」 | 「有声」页 = 专辑页**同款**的**封面卡片网格**（`.fnm-card` = 封面 + 标题 + 副标题）⇒ **卡片只做下钻** |
| 播放模块 | 「**有声业的播放模块 UI 有问题**」 | 三处：① 详情页「**播放全书**」；② 全屏页**不再空等歌词**；③ 结构信号从卡片**搬到详情页** |

⚠️ 拍板时用户选了「**封面网格 + 播放模块三处都改**」（`ask_user` 的推荐项）⇒ 一次做完，不拆。

### 二、诊断（**真机截图 + DOM 实测**，2026-11-17，探针 `t101-00/01/02`）

| 现象 | 实测 | 结论 |
|---|---|---|
| 专辑页 | **封面卡片网格**（`.fnm-card` + `CoverImage`） | ⇒ 有声页要「**同款**」 |
| 有声页 | **纯文字长列表** + 每条一行**结构信号长句** + 「不是有声」按钮 | ⇒ 卡片做不成网格的**根因**就是那行长句 |
| 有声详情页 | **没有「播放全书」入口**（只能双击行）⇒ 顶部是「Ctrl/Shift 多选后可批量下载」的**下载**提示 | ⇒ 缺最常用的入口 |
| 有声全屏播放页 | 默认落在「歌词」标签 ⇒ **6 秒后仍卡「正在加载歌词…」**、整页大片空白 | ⭐ 有声**没有歌词** ⇒ 卡住的是**空**的歌词页 |
| 有声全屏页封面 | **正常**（`naturalWidth=200`，`src=fnm://srv/static/cover?coverId=track_66f7…&size=200`） | ⇒ **不是**封面 bug |
| 对照实验 | 音乐歌的全屏页歌词**正常加载** | ⇒ 「卡住」是**有声特有** |

### 三、改了什么

- **封面从哪来（三条路）**：
  - **扫描路径**：曲目的 `coverId` **本来就在返回的数据里** ⇒ 顺手记下来（**不要钱**）⇒ `ScanTrack.coverId` + 落盘；
  - **秒搜路径**：`/search/album` **自带** `coverId` ⇒ **零额外请求**；
  - **旧落盘**：没有封面 ⇒ 进页时按需补拉 **1 次** `/album/detail` ⇒ **回写落盘**（只补一次）；
  - ⚠ **`STATE_VERSION` 仍为 3**（新增字段**可选**）⇒ 旧落盘照样能读 ⇒ 用户**不用**重扫 52 秒；
- **列表改普通 CSS 网格**（`repeat(auto-fill, minmax(180px,1fr))`）⇒ **整页一起滚** ⇒ 不出现「网格里滚、页面里也滚」的**嵌套滚动**；
- **结构信号搬到详情页**（`.fnm-detail__audiobook-reasons`）⇒ 信息一点没丢；
- **播放模块三处**：详情页「**播放全书**」（整队入队 ⇒ 连播）/ 有声**不查歌词** + **12 秒超时兜底** / 有声全屏页**默认落「队列」**；
- ⚠ **顺带修了一个布局缺陷（E2E 顶出来的）**：`.fnm-page` **没有**滚动容器 ⇒ 内容溢出**画到播放条上面**
  ⇒ 最下面「换一个文件夹」里的按钮**被播放条盖住、点不到**（卡片网格比文字行高约 170px ⇒ 把它顶出来了）
  ⇒ 修法：`.fnm-audiobooks` 变成**整页的滚动容器**（与「发现」页同一套写法）；
- ⚠ **mock 补了 `/static/cover`**（之前**没有**）⇒ 卡片封面 404 ⇒ 变成占位块 ⇒ E2E **根本测不出**「有没有封面」（**纯增量**）。

### 四、验证（单机 / mock，2026-11-17）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | **0 错** |
| 单测（vitest，全量） | **137 个文件 / 2873 条**全绿（新增 `test/t101-audiobook-player.test.tsx` 6 条 + store 4 条 + 页面 4 条） |
| E2E（真实 Electron + mock NAS） | 有声四条 **18 条**全绿：`t98` 5 + `t99` 4 + `t100` 5 + `t101` 4 |
| E2E 关键断言 | 卡片是**真 grid**（`display: grid`）+ 封面 `<img>` **真的加载成功**（`naturalWidth > 0`）+ 秒搜卡片自带封面 + 「播放全书」后队列 **12 集**且当前是**第 1 集** + 全屏页「队列」标签 `aria-pressed=true` |
| **变异自证** | 单元级 **9 条** + E2E 级 **7 条** ⇒ **逐条改坏 ⇒ 逐条变红 ⇒ 还原回绿**（含**基线自检**与**双重判定**：退出码 ≠ 0 **且**输出含 failed） |
| ⚠ **变异自证里「没被证明」的那条** | E7「页面**不补拉封面**」**第一轮没变红** ⇒ 原因：E2E 里的封面走的是**扫描路径**（曲目的 `coverId` 本来就在数据里）⇒ **补拉**那条路**根本没有 E2E 咬住** ⇒ 补了一条「**旧落盘**（没有封面）⇒ 进页面**补拉一次** ⇒ 卡片出现封面」的 E2E（**另起实例**，因为落盘在 `localStorage`、已挂载的页面不会重跑 `restore()`）⇒ 补完才变红 |
| 既有断言 | **一条未删、断言一条未弱化**；唯一改写：t98 的「依据逐条给出来」⇒ 列表侧改**反向断言**、正面断言**搬到详情页** |
| ⚠ **顺带顶出来的既有断言问题** | `e2e/t81-word-timed.spec.ts`：「当前行颜色 == `--accent`」⇒ 探针挂在 `document.body` 上 ⇒ 读的是**全局**强调色；而当前行用的是「**按封面取色校正过的**」`--fnm-fullplayer__accent-text`（T89-⑪ 的设计）⇒ **以前也是绿的**（mock 以前**没有** `/static/cover` ⇒ 封面 404 ⇒ 取色失败 ⇒ 那个变量**从不生效** ⇒ 两边碰巧相等）⇒ **其实没验到「校正」这一层** ⇒ 改成探针**同作用域 + 同表达式** ⇒ **更强** |

### 五、⚠ 遗留 / 待办

1. ⚠ **扫描路径记的是「曲目的封面」**（该组**第一首曲目**的 `coverId`），秒搜路径用的是**专辑自己的** `coverId`
   ⇒ ⚠ **真机复验已更正**（见「七十六」）：真实服务端「专辑的 `coverId`」**本身也是 `track_` 形态**
   ⇒ 且**两条路给出的是两个不同的封面 id** ⇒ 同一张卡片在两处**可能显示不同的图** ⇒ **待拍板**；
   **逐首不同封面**的专辑会取**第一首**的封面 ⇒ **实机已见到**（同一张专辑里不同首曲目的封面确实不同）；
2. ⚠ **14 集掉队**（《极品家丁》`bracket` 抢走中段集号）⇒ 修法已定（`mid-number` 提到 `bracket` 之前）⇒ **待用户拍板**；
3. ⚠ **「第 1.2 集」季.集标签口径** ⇒ 另开任务；
4. ⚠ **秒搜 312 条**要不要「只显示名字全等的 / 置顶」⇒ **待用户拍板**；
5. ⚠ 本节数字**只代表那台机那个账号**（换库必须重测）。

⚠ 本节（**七十五**）记的是**实现 + 单机/mock 验证**；**真机复验**见**下一节（七十六）**。

## 七十六、T101 真机复验（真实 NAS + 真实账号，2026-11-17）

> 探针 `release/verify/t101-11-realmachine-verify.mjs`（**只读**；隔离 userData ⇒ 只复制
> `session.bin` + `Local State`，safeStorage 才解得开）；走**真实界面**（真实 Electron + 真实 NAS）
> 验「封面卡片网格 → 秒搜卡片 → 详情页播放全书 → 全屏页默认落队列」整条生产链路。
> ⚠ 数字**只代表那台机那个账号**（换库必须重测；阈值不是常数）。

### 一、自动扫描（**没点任何按钮**）

| 项 | 实测 |
|---|---|
| 扫描用时 | **52.6 秒** / **55.7 秒**（两轮；87 页） |
| 扫描后状态行 | 「上次扫描：2026/11/17 01:31:02 · 目录「有声小说」· **9 部**」 |
| 列表 | **9 张卡片**（与 T100 一致） |

### 二、封面卡片网格（**用户要的那一条**）

| 项 | 实测 | 结论 |
|---|---|---|
| 容器 `display` | **`grid`**；`grid-template-columns: 201.8px × 5` | ⭐ **真的是网格**（不是竖排列表） |
| 卡片尺寸 | **201.8 × 229** px（封面 + 标题 + 副标题 + 来源） | ⭐ 与专辑页**同款** `.fnm-card` |
| **封面真的加载出来** | **8 / 9** 张卡片有 `<img>` 且 **`naturalWidth = 200`** | ⭐ 封面**不是**占位块 |
| 唯一没有封面的 | 「**让青春继续第三季**」⇒ 它**自己就没有封面**（秒搜里那张**也**没有） | ⇒ 是内容如此，不是 bug |
| 卡片上的结构信号长句 | **9 张全为空** | ⭐ 已搬到详情页 |
| 整页滚动 | `.fnm-audiobooks`：`scrollHeight 978 / clientHeight 550`、`overflow-y: auto` | ⭐ **整页一起滚**（无嵌套滚动）；按钮不再被播放条盖住 |

⚠ 截图：`release/verify/shots/t101-01-audiobooks-grid.png`（三体 / 娱乐春秋 / 盗墓笔记 / 牧神记 /
极品家丁 / 赶尸客栈 / 让青春继续第一季 / 第二季 **封面全部真实加载**；第三季是占位块）。

### 三、秒搜结果（**同一套卡片**）

| 项 | 实测 |
|---|---|
| 命中条数 | **312** 条（与 T100 一致 ⇒ 服务端子串 + top-N 的命中集仍不稳定） |
| 卡片结构 | 与主列表**同一套**（封面 + 标题 + 副标题） |
| 封面 id | **267 / 312** 条有 `coverId`；**45** 条**没有**封面 id（服务端就没有） |
| 已加载的 | **28** 条（其余是**懒加载** + 在视口外 ⇒ 没加载不等于没有封面） |

### 四、详情页（**播放全书** + 结构信号）

| 项 | 实测 | 结论 |
|---|---|---|
| 状态行 | 「**已加载 89 / 89**」（三体） | ⭐ 整组拉全量 |
| 徽标 | 「**已按集序排列**」 | ⭐ |
| 「播放全书」按钮 | **在** | ⭐ 用户要的那一个入口 |
| 结构信号段落 | 「为什么列在这里：单集均长 ≥ 8 分钟 · 单集均长 ≥ 20 分钟 · 最长单集 ≥ 30 分钟 · 标题形态一致（可解析集号） · 集数 ≥ 8 · 曲目集中在同一作品目录」 | ⭐ **一条没少** |
| 集号标签 | 第 1 / 2 / 3 / 4 集（DOM **18** 行 ⇒ **虚拟滚动**，不是总数） | ⭐ |

### 五、全屏播放页（**不再卡歌词**）

| 项 | 实测 | 结论 |
|---|---|---|
| 默认标签 | 「**队列**」`aria-pressed=true`；「歌词」`aria-pressed=false` | ⭐ 默认落在**有用**的那一页 |
| 队列条数 | **89**（= 三体全集） | ⭐ 整书入队 ⇒ 连播 |
| 当前这首 | 「**01- 科学边界**」 | ⭐ 从**第 1 集**开始 |
| 「正在加载歌词…」 | **不出现** | ⭐ 真机那个「卡 6 秒 + 整页空白」的问题**没了** |
| 手动切到歌词页 | 空态 = 「**有声读物没有歌词**」 | ⭐ **如实说明**，不是「暂无歌词」 |

⚠ 截图：`t101-04-audiobook-fullplayer.png`（队列页）、`t101-05-audiobook-lyric-tab.png`（歌词页）。

### 六、⚠ 实测出来的**口径修正**与遗留

1. ⚠ **服务端「专辑的 `coverId`」本身就是 `track_` 形态**（实测 `track_66f7a2fc…` / `track_23e5f5f2…`）
   ⇒ T100 规格里「专辑页用 `album_xxx`、有声页用 `track_xxx`」的说法**只对 E2E mock 成立**，**真实服务端不是这样**
   ⇒ 规格与文档里凡按 `album_` / `track_` 区分两条路的说法**按本条更正**；
2. ⚠ **扫描路径与秒搜路径的封面 id 可能不同**：实测《让青春继续第一季》——
   扫描路径（主列表卡片）= `track_118fe863…`（**该组第一首曲目**的封面），
   秒搜路径（秒搜卡片）= `track_66f7a2fc…`（**专辑自己的** `coverId`）⇒ **两个不同的封面 id**
   ⇒ 同一张卡片在「主列表」与「秒搜结果」里**可能显示不同的图** ⇒ **待拍板**（要么统一取专辑封面，
   要么统一取曲目封面；主列表走扫描路径是**零请求**，专辑封面要多 1 个 `/album/detail`）；
3. ⚠ 「让青春继续第三季」**整部都没有封面 id** ⇒ 卡片画占位块（**如实**如此，不是 bug）；
4. ⚠ 秒搜 **312** 条里 **45** 条没有封面 id ⇒ 同样是占位块；
5. ⚠ 秒搜命中集**仍不稳定**（312 条 / 服务端子串 + top-N）⇒ 混着《青春的喝彩》《继续》等**不同名**作品
   ⇒ 「只显示名字全等的 / 名字全等置顶」⇒ **待拍板**（沿用 T100 的遗留）；
6. ⚠ **14 集掉队**（《极品家丁》）与「第 1.2 集」季.集标签 ⇒ 沿用 T100 的遗留，**未动**。

### 七、⚠ 探针自己踩的坑（已修，记下来）

⚠ **第一轮把详情页读早了**：等「已加载 N / N」的判据写成 `n(m[1]) >= n(m[2])`
⇒ 加载**前**的状态行就是「已加载 **0** / 0，加载中…」⇒ **0 >= 0 立刻成立** ⇒ 读到的是
「正在按集序整理…」+ 0 行 + 没有「播放全书」按钮。
⇒ 正解：**要求 `n(m[1]) > 0`**，并**另外等「播放全书」按钮真的在**（它只在曲目加载完之后才渲染）⇒ 重跑即真。
⚠ 这是「**等终态**」纪律的又一例：**「看起来满足条件」的终态也可能是假终态**。

⚠ 探针的 `app.close()` **不返回**（残留 5 个 electron 进程）⇒ 结果已落盘后按 `ExecutablePath`
前缀筛 `workspace\node_modules\electron\dist` 再 `Stop-Process` 清理（**用户装的 v0.2.9 未在运行、未被碰**）。

> 提交：规格 `a259648` / 实现 `ca27f34` / **真机复验文档（见提交说明）**。

## 七十七、T102：**统一封面 id**（同一张卡片，两处显示同一张图）（2026-11-17）

> 起因：用户 2026-11-17 在 T101 收尾时拍板的下一件事 ——
> 「**统一封面 id**」。
> ⇒ 口径钉死：「有声」页上**同一张卡片**，在「主列表」与「秒搜结果」里显示**同一个封面 id**；
> 且与**专辑页**显示同一张专辑时的封面**一致**。

### 一、问题（T101 真机复验发现）

| 位置 | 封面来源 | 实测 id（《让青春继续第一季》） |
|---|---|---|
| 有声页「**主列表**」（扫描路径） | 扫描时记下的**该组第一首曲目**的 `coverId` | `track_118fe863…` |
| 有声页「**秒搜结果**」（搜索路径） | `/search/album` **自带**的**专辑** `coverId` | `track_66f7a2fc…` |
| 专辑页（同一张专辑） | `/album/list` 的**专辑** `coverId` | `track_66f7a2fc…` |

⇒ **同一个作品，两处显示的是两张不同的图**（用户可见的问题）。
⚠ T101 规格 §六「扫描路径记的是**曲目封面**（`track_xxx`），专辑页用的是**专辑封面**（`album_xxx`），
实测两者**指向同一张图**」——**真机证明这句话是错的** ⇒ 本节作废它。

### 二、⭐ 第 0 步实测：统一源**只有**一个（探针 `t102-01`，只读）

真机探针比对**四个**来源：

| 来源 | 端点 | 实测 |
|---|---|---|
| 曲目**自己**的封面 | `/track/list` 的 `coverId` | 「庙堂之外」= `track_591e8c99…` |
| 曲目**内嵌专辑**的封面 | `/track/list` 的 `album.coverId` | 「庙堂之外」= `album_1988d5f2…` |
| **专辑自己**的封面 | `/album/detail?guid=` | 《让青春继续第一季》= `track_66f7a2fc…` |
| 专辑**第一首曲目**的封面 | `/track/album-detail/list?size=1` | 《让青春继续第一季》= `track_b9a2187d…` |

⇒ **三条结论**：

1. ⭐ **曲目的内嵌 `album.coverId` == `/album/detail` 的 `coverId`**（`track_66f7a2fc…` **三处逐字一致**）
   ⇒ **扫描路径零请求**就能拿到与专辑页 / 秒搜**完全相同**的那个 id；
2. ⭐ **曲目自己的封面与专辑封面是两个不同的 id** ⇒ 用曲目封面**永远统一不了**；
   而且「取哪一首」在两条路里**定义不同**（扫描顺序 vs 专辑详情顺序）⇒ 曲目封面**不可能**统一；
3. ⇒ **统一源只能是「专辑自己的 `coverId`」**（既是专辑页显示的那个，又是零请求拿得到的那个）。

⚠ 附带发现：服务端**专辑**的封面**不一定是** `album_` 形态（315 条秒搜结果里 `album_` / `track_` / 空**都有**）
⇒ 「专辑页用 `album_xxx`、有声页用 `track_xxx`」的说法**在服务端层面也不成立**。

### 三、改了什么

- **改** `src/api/library.ts`：`ScanTrack` 加 **`albumCoverId`**（= 内嵌专辑的 `coverId` ⇒ **零请求**）；
- **改** `src/state/audiobookStore.ts`：
  - `CandidateSnapshot` 加**可选** `albumCoverId`；`Aggregator` / `MergedGroup` / `AudiobookHit` 加 `albumCoverId`；
  - 扫描时记**专辑**封面（建聚合器时取**第一条** ⇒ 同一张专辑只有**一个**专辑封面值）；
    归并组取**主专辑**的那个（与秒搜路径同规则 ⇒ 一致）；
  - 新增 **`setAlbumCover(albumId, coverId)`**（改命中 **+ 回写落盘**）；
  - ⚠ **`STATE_VERSION` 仍为 3**（新增字段**可选** ⇒ 旧落盘照样能读 ⇒ **不用**重扫 52 秒）；
- **改** `src/pages/AudiobooksPage.tsx`：卡片封面改用 **`hit.albumCoverId`**；补拉判据改成
  「**专辑封面未知**」⇒ T101 的旧落盘**也会**被补拉；下钻的 `Album` 也用专辑封面；
  秒搜路径**一个字没改**（它本来就是专辑封面）；
- ⚠ **三态**（`albumCoverId` **不能用真假值判断**）：

  | 值 | 含义 | 页面行为 |
  |---|---|---|
  | `undefined`（**字段缺省**） | **未知**（T101 的旧落盘） | ⇒ 补拉一次 `/album/detail` |
  | `null`（**字段是 null**） | **确认没有封面** | ⇒ **不**再拉（画占位块） |
  | 字符串 | 有封面 | ⇒ 直接显示 |

  ⇒ 落盘里靠「**字段在不在**」区分（`JSON.stringify` 会丢掉 `undefined` 的 key ⇒ 读回来仍是「未知」⇒ 会再补拉）；
- ⚠ **曲目封面字段（`coverId`）保留但不再用于显示**（落盘形状不变 ⇒ T101 的旧落盘照样能读、既有测试一条不改）；
- ⚠ **取舍**：专辑**没有**封面时两边**都**是占位块（不再回退到曲目封面）⇒ **一致优先**
  ⇒ 真机实测「让青春继续第三季」**本来就没有**任何封面 id ⇒ 实测无回退损失。

### 四、验证（单机 / mock，2026-11-17）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | **0 错** |
| 单测（vitest，全量） | **137 个文件 / 2881 条**全绿（T101 的 2873 + **T102 新增 8 条**：store 5 + 页面 3） |
| E2E（真实 Electron + mock NAS） | 全量 **59 条**全绿（T101 的 58 + **T102 新增 1 条**「两边封面 id 逐字相同」） |
| E2E 关键断言 | 扫描路径卡片封面 == **专辑封面**（**且不含**曲目封面 id）/ 秒搜卡片封面 == 专辑封面 / 两条路 **逐字相同** / T101 旧落盘 ⇒ 补拉后换成专辑封面 |
| **变异自证** | 单元级 **8 条** + E2E 级 **5 条** ⇒ **逐条改坏 ⇒ 逐条变红 ⇒ 还原回绿**（含**基线自检**与**双重判定**：退出码 ≠ 0 **且**输出含 failed） |
| ⚠ **变异自证里「没被证明」的那条** | U1「扫描不记专辑封面」**第一轮没变红** ⇒ 原因：聚合器当时有**两条**路径拿到专辑封面（构造器 + 「取第一个非空」）⇒ 那条变异与原行为**等价** ⇒ **去掉冗余分支**（来源唯一）⇒ 重跑即变红 |
| 既有断言 | **一条未删、断言一条未弱化**；改写三处：`test/audiobooks-page.test.tsx` ⑨、`e2e/t101-audiobook-grid.spec.ts` ① 与「旧落盘补拉」（都改成**更强**的新行为断言） |
| ⚠ **不引**新 npm 依赖 | — |

### 五、⚠ 遗留 / 待办

1. ⚠ **曲目封面字段（`coverId`）保留但不再用于显示**（为的是落盘形状不变 ⇒ T101 旧落盘可读、既有测试不改）；
2. ⚠ **专辑没有封面时两边都是占位块**（不回退曲目封面）⇒ **一致优先**的取舍；
3. ⚠ **秒搜命中集不稳定**（312 / 315 条 ⇒ 服务端子串 + top-N）⇒ 沿用 T100 的遗留，**未动**；
4. ⚠ **14 集掉队**（《极品家丁》）与「第 1.2 集」季.集标签 ⇒ 沿用 T100 的遗留，**未动**；
5. ⚠ 本节数字**只代表那台机那个账号**（换库必须重测）。

## 七十八、T102 真机复验（真实 NAS + 真实账号，2026-11-17）

> 探针 `release/verify/t102-12-realmachine-verify.mjs`（**只读**；隔离 userData ⇒ 只复制
> `session.bin` + `Local State`，safeStorage 才解得开）；走**真实界面**（真实 Electron + 真实 NAS）。
> ⚠ 数字**只代表那台机那个账号**（换库必须重测；阈值不是常数）。

### 一、场景 A：**T101 的旧落盘** ⇒ 补拉一次 ⇒ 换成**专辑封面** ⇒ 回写落盘

| 项 | 实测 | 结论 |
|---|---|---|
| 预置的旧落盘 | **T101 的真实形状**：有**曲目**封面 `coverId = track_118fe863…`，**没有** `albumCoverId` | ⇒ 专辑封面**未知** ⇒ 该补拉 |
| 补拉后的卡片封面 | **`track_66f7a2fc…`**（**专辑自己的**那个）⇒ **不是**旧的曲目封面 | ⭐ 旧的「两张不同的图」被消灭 |
| 落盘回写 | `albumCoverId = track_66f7a2fc…`（**字段在** = `true`） | ⭐ 下次进页面**不用**再拉 |

⚠ 截图：`release/verify/shots/t102-01-old-persisted-cover.png`。

### 二、场景 B：**空落盘** ⇒ 自动扫描 ⇒ 主列表 vs 秒搜 ⇒ **逐字相同**

| 项 | 实测 | 结论 |
|---|---|---|
| 状态行 | 「上次扫描：2026/11/17 05:07:42 · 目录「有声小说」· **9 部**」 | ⭐ 自动扫描照旧 |
| 主列表 | **9 张卡片**，**8 张**有封面 | 「让青春继续第三季」**没有**封面 ⇒ 它**本来就没有**封面 id（秒搜里那张也**没有**）⇒ **如实**如此 |
| **主列表**《让青春继续第一季》 | `fnm://srv/static/cover?coverId=**track_66f7a2fc…**&size=200` | ⭐ |
| **秒搜**《让青春继续第一季》 | `fnm://srv/static/cover?coverId=**track_66f7a2fc…**&size=200` | ⭐ |
| ⭐ **逐字相同** | **是**（**同一个 id**，不是「看着像同一张图」） | ⭐ **T102 的核心验收点通过** |
| ⭐ 是**专辑自己的**封面 | **是**（`track_66f7a2fc…` == `/album/detail` == `/search/album`） | ⭐ 与**专辑页**也一致 |

⚠ 截图：`t102-02-fresh-scan-grid.png`（扫描后的网格）、`t102-03-search-grid.png`（秒搜的同一套卡片）。

### 三、⚠ 顺带确认到的：**封面 id 全部变了**（这正是改动生效的证据）

| 作品 | T101（扫描路径 = 曲目封面） | **T102（= 专辑自己的封面）** |
|---|---|---|
| 三体 | `track_9551e63d…` | **`track_500aa0bc…`** |
| 娱乐春秋 | `track_40c5e474…` | **`track_7315d3e7…`** |
| 盗墓笔记 | `track_f20373f1…` | **`track_80b534f9…`** |
| 牧神记 | `track_f3e0c6ba…` | **`track_49286765…`** |
| 极品家丁 | `track_4a46b8fa…` | **`track_d16ad4a9…`** |
| 赶尸客栈 | `track_4aea3129…` | **`track_ae097269…`** |
| 让青春继续第一季 | `track_118fe863…` | **`track_66f7a2fc…`**（== 秒搜的那个 ✓） |
| 让青春继续第二季 | `track_bb2d8cce…` | **`track_4660ea3c…`** |
| 让青春继续第三季 | （无） | （无）⇒ **它本来就没有封面 id** |

⇒ **8 张卡片的封面 id 全部换成了「专辑自己的」那个** ⇒ 现在的「有声」页与专辑页**同款同图**。

### 四、⚠ 探针自己的坑（已修，记下来）

- ⚠ 封面 `<img>` 是**懒加载** ⇒ **在视口外**的卡片可能读不到 `src` ⇒ 只读**第一张**（它在视口内）；
- ⚠ 场景 A 的判据不能只等「有封面」⇒ 那会读到旧落盘里那个**曲目**封面 ⇒ 改成
  「有封面 **且不是**曲目封面」；
- ⚠ 场景 B 等扫描完成不能用「已加载 N / N」（老坑）⇒ 等状态行「上次扫描」**且**卡片数 > 0。

> 提交：规格 `d26e14f` / 实现 `6eca659` / **真机复验文档（见提交说明）**。

### 七十九、T103 真机复验：修《极品家丁》14 集掉队（真实 NAS，2026-11-17）

> 起因：T99 真机复验发现的坑 —— **14 集（1.1%）排到了末尾**（掉队）。
> 修法：集号规则优先级重排 —— `bracket`（括号数字）从第 ⑤ 位降到**最末**（兜底）⇒ `mid-number` 赢。
> ⚠ 下面的数字**只代表这台机、这个账号**（曲库因人而异）。
> 探针：`release/verify/t103-03-realmachine-verify.mjs`（结果 JSON：同目录 `t103-03-realmachine-result.json`）。

#### 一、Node 路（`tsc` 编译后的 `src/api/audiobook.ts` = **真代码**，不复制逻辑 + 真实 1333 集）

| 项 | 实测 | 结论 |
|---|---|---|
| 秒搜 `/search/album?q=极品家丁` | 命中 **65** 条 ⇒ 名字全等 **1** 张（guid `b2c9c20a…`） | 单点定位 ✓ |
| 服务端集数 / 实拉 | **1333** / **1333** | 一条没少 ✓ |
| 各规则命中数 | **`mid-number` 1333**（`bracket` **0**） | ⭐ 旧口径是 `mid-number` 1319 / `bracket` 14 |
| 专辑级形态规则 | **`mid-number`**，命中率 **100%**（旧口径 98.9%） | ⭐ 形态**完全一致** |
| 解析出集号 | **1333 / 1333**；**没集号 0 集** | ⭐ **没有掉队的了** |
| 集号范围 | **0…1332**；去重 **1333**；**连续 ✓**；**缺号 0 个** | ⭐ 1333 集与 0…1332 **一一对应** |
| 标题带「（1）/（2）」的 14 集 | 命中规则 **`mid-number`**；集号 = **219 / 220 / 268 / 269 / 298 / 299 / 311 / 312 / 330 / 331 / 404 / 405 / 447 / 448** | ⭐ **括号里的 1/2 没被当成集号**；且**恰好**是旧口径缺的那 14 个编号 |

⇒ 与 T99 当时的实测**逐项对上**（当时的 14 个缺失编号 = 现在这 14 集的集号）⇒
**旧口径下掉的队，一个不落地排回去了，且没有引入任何重复集号**。

#### 二、渲染进程路（真实 Electron + 真实 NAS）

| 项 | 实测 | 结论 |
|---|---|---|
| 秒搜「搜作品」 | 命中 **65** 条 ⇒ 第 1 条即《极品家丁》（名字全等） | 秒搜路可用 ✓ |
| 详情页状态行 | **已加载 1,333 / 1,333**（带千分位） | ⭐ 1333 集**全在** |
| 详情页排序提示 | **已按集序排列** | ⭐ 按集序排生效 |
| 首行 | `极品家丁 0000预告片` ＝ **第 0 集** | ⭐ 预告片排最前（与 T99 一致） |

#### 三、⚠ **顺带发现的一个真缺陷（另开任务 ⇒ 不在本轮修）**

⚠ **详情页的曲目列表「滚不动」** ⇒ 1333 集只能看到**最前面十几行**。

探针实测的**滚动几何**（真实窗口）：

| 元素 | 实测 | 含义 |
|---|---|---|
| `.fnm-songlist__viewport` | `clientHeight` **63984** = `scrollHeight` **63984**；`overflow-y: auto` | ⚠️ **它不是滚动容器**（自身高度 = 内容高度） |
| `document.scrollingElement` | `clientHeight` **761** / `scrollHeight` **64429** | ⇒ 真正在滚的是**整个页面** |
| `data-scroll-top` | 三种滚法（改 `scrollTop` / 真滚轮 / `window.scrollTo`）后**恒为 0** | ⇒ **虚拟窗口永不前移** |

⇒ **根因**（对照 CSS 可直接读出来）：`SongList` 的虚拟窗口靠**自己**的 `onScroll` 更新
（`src/components/SongList.tsx:342` ⇒ `setScrollTop`），而它的滚动容器
`.fnm-songlist__viewport`（`overflow-y: auto`）**没被限高** ——
`.fnm-detail`（详情页根，**flex 列容器**）缺 `flex: 1 1 auto` / `min-height: 0` / `height: 100%`
（对比：`.fnm-audiobooks`、`.fnm-discover`、`.fnm-settings` **都有**）⇒
flex 项默认 `min-height: auto` ⇒ **不肯收缩** ⇒ 里面的虚拟列表被撑到 6 万多像素 ⇒
「虚拟裁剪」在详情页**失效**（只剩前 18 行是真实行，下面全是空画布）。

⚠ **影响面**：任何**超过一屏**的详情页曲目列表（有声 1333 集 / 大专辑 / 长歌单）⇒
用户只看得见前十几行。⚠ 这也解释了 **T99 探针的「滚到底末行」是假的**（它同样只滚到了顶部窗口）
⇒ 那轮**界面**证据其实只有「首行 + 状态行」，本轮把这条**补正**在案。

⇒ **本轮不修**（T103 的范围是「14 集掉队」）；**另开任务**修「详情页长列表滚不动」。
⇒ ✅ **已在 T104 修好**（2026-11-17，见「八十」）—— 且本节对根因的描述**已由 T104 的变异自证校准**
（哪几条声明**承重**、哪几条只是**兜底 / 观感**，见「八十」第三节）。

#### 四、⚠ 顺带确认到的：**修复不需要重扫**

- 详情页 / 秒搜走 `sortTracksByEpisode()` ⇒ `resolveAlbumEpisodes()` **实时解析**标题
  ⇒ 规则改完**立刻生效**，**旧落盘也能受益**（落盘只用来**选规则**，不存每集集号）；
- 重新扫描后落盘里的形态统计会变成 `mid-number` 1333 / `bracket` 0（旧落盘里那 14 个 `bracket` 会留到重扫为止，**无害**）；
- ⚠ **`STATE_VERSION` 仍为 3**（落盘形状**没变**）⇒ 用户已扫过的结果**不作废**、不用白扫一次 52 秒。

#### 五、⚠ 探针自己的坑（记下来）

- ⚠ **T100 之后不用点「扫描这个目录」**：进「有声」页会**自动开扫** ⇒ 扫描中那个按钮是「正在扫描…」（disabled）⇒ 点不到；
  ⇒ 探针改走**秒搜**直达详情页（实测约 0.1 秒）⇒ 不用等 87 页扫描；
- ⚠ 「等某一行出现」**不能**只等一个元素：匹配失败时页面会走另一条路 ⇒ 要等「命中 **或** 报错 **或** 空」；
- ⚠ 虚拟滚动列表：**DOM 里只有可视窗口那几十行** ⇒ 全量顺序**只能**用 Node 路（真代码 + 全量数据）验；
- ⚠ 状态行**带千分位**（`已加载 1,333 / 1,333`）⇒ 正则要容忍逗号；
- ⚠ 「滚到底」**先量几何**：先看 `clientHeight` vs `scrollHeight` ⇒ 不相等才谈得上「滚到底」。

> 提交：规格 `fa73a2d` / 实现 `3bd4b29` / **真机复验文档（见提交说明）**。

### 八十、T104 真机复验：详情页长列表能滚到底（真实 NAS，2026-11-17）

> 起因：T103 真机复验**顺带抓到**的缺陷 —— 详情页的曲目列表**滚不动**（1333 集只看得到前十几行）。
> 修法：只改 `src/pages/detail-page.css` 的 **6 条声明**
> （详情页这一层**长满页面** ＋ 区块 **basis = 0** ＋ 头部 / 标题 / 说明行**不参与伸缩**）。
> ⚠ 下面的数字**只代表这台机、这个账号**（曲库因人而异）。
> 探针：`release/verify/t104-01-realmachine-verify.mjs`（结果 JSON：同目录 `t104-01-realmachine-result.json`）。

#### 一、滚动的**几何**（同一部作品，前后对照）

| 元素 | T103（修前） | T104（修后） | 含义 |
|---|---|---|---|
| `.fnm-songlist__viewport` 的 `clientHeight` | **63984** | **239** | 修前 ＝ 内容高度（**不是**滚动容器）；修后 ＝ **一屏的高度** |
| `.fnm-songlist__viewport` 的 `scrollHeight` | **63984** | **63984** | 内容高度（不变） |
| `document.scrollingElement`（`clientHeight` / `scrollHeight`） | 761 / **64429** | **761** / **761** | 修前**整页**在滚；修后**整页不滚**（只有列表在滚） |
| `data-scroll-top` | **恒为 0** | **63745** | 虚拟窗口**真的前移**了 |

#### 二、界面（真实 Electron + 真实 NAS，秒搜直达详情页）

| 项 | 实测 | 结论 |
|---|---|---|
| 详情页状态行 | **已加载 1,333 / 1,333**（带千分位） | 1333 集**全在** |
| 详情页排序提示 | **已按集序排列** | 与 T103 一致 |
| 首行 | `极品家丁 0000预告片` ＝ **第 0 集** | 与 T103 一致 |
| **滚到底的末行** | **第 1332 集** | ⭐ **T103 时这一项验不了**（列表滚不动）⇒ 本轮**补正** |
| **中段的第 219 集** | **第 219 集** | ⭐ 同上（那 14 集里的一集，现在**够得着**了） |

⇒ 判定 **8 项全过**。

#### 三、⚠ **口径更正**：「七十九」里对根因的描述

「七十九」写的是「`.fnm-detail` 缺 `flex: 1 1 auto` / `min-height: 0` / `height: 100%`」——
**方向对**，但**哪一条承重**，本轮用**变异自证**实测区分了：

| 声明 | 承重？ | 实测 |
|---|---|---|
| `.fnm-detail` 的 `flex: 1 1 auto` | ✅ **承重** | 去掉 ⇒ 页面**不长满** ⇒ 区块拿到 0 高度 ⇒ E2E 变红 |
| `.fnm-detail__section` 的 `flex: 1 1 0` | ✅ **承重** | 改回 `1 1 auto` ⇒ 区块的**假设尺寸 = 内容高度** ⇒ 视口被顶到内容高 ⇒ E2E 变红（⚠ **只在歌手页才暴露**：那里有**两个**区块 ⇒ 本轮为此**补了一条 E2E**） |
| `.fnm-songlist__viewport` 的 `overflow-y: auto` | ✅ **承重**（既有） | 去掉 ⇒ 它不再是滚动容器 ⇒ 虚拟窗口收不到 scroll 事件 |
| `.fnm-songlist` 的 `flex: 1 1 auto` | ✅ **承重**（既有） | 改成 `0 0 auto` ⇒ 视口 ＝ 内容高度 ⇒ E2E 变红（⚠ **契约测试管不到 ⇒ 只有 E2E 咬住**） |
| `.fnm-detail` 的 `min-height: 0` | ⚪ **兜底** | 去掉 ⇒ 几何**不变**（里面的滚动容器已把 min-content 传导截断）⇒ 留着是为了与 `.fnm-audiobooks` / `.fnm-discover` / `.fnm-settings` **同一套写法** |
| `.fnm-detail__head` 的 `flex: 0 0 auto` | ⚪ **观感** | 去掉 ⇒ 窗口一矮头部就被压扁（不影响滚动） |

#### 四、⚠ 顺带发现的**新缺陷**（另开任务 ⇒ 本轮不修）

**`SongList` 的「可视区高度」在列表初始为空时量不到** ⇒ 一路用兜底常量 **600px**
⇒ 「DOM 里渲染了几行」**随导航路径变化**（初始为空 ⇒ 18 行；初始有数据 ⇒ 实测高度 ⇒ 约 10 行）。

- 根因（`src/components/SongList.tsx:387`）：**列表为空时根本不渲染视口**（空态是另一个分支）
  ⇒ 挂载时 `viewportRef.current` 为 `null` ⇒ 量高 effect **直接 return**
  ⇒ 而 effect 依赖是 `[]` ⇒ **列表后来有数据了也不会再量**；
- 后果：**不影响**「能滚到底」（行的位置由 `data-index` 决定），但会让「DOM 行数」**不可预测**
  ⇒ 这正是本轮**改写**既有 E2E 断言（「DOM 里有 N 行」⇒「**滚着收齐** N 行」）的直接原因；
- 修法（下一轮）：量高 effect 的依赖改成「视口**是否已渲染**」。

#### 五、⚠ 探针自己的坑（记下来）

- ⚠ 「等某一行出现」**不能**只等一个元素（匹配失败时页面会走另一条路）；
- ⚠ 虚拟滚动：**DOM 里只有可视窗口那几十行** ⇒ 全量顺序**只能**用 Node 路验；
- ⚠ 状态行**带千分位** ⇒ 正则要容忍逗号；
- ⚠ 「滚到底」**先量几何**（`clientHeight` vs `scrollHeight`）⇒ 不相等才谈得上「滚到底」；
- ⚠ **本轮新踩**：修好之后「DOM 行数」**不再等于**曲目数 ⇒ 断言要改成「**滚着收齐**」（按 `data-index` 去重）。

> 提交：规格 / 实现 / **真机复验文档**（见提交说明）。

## 八十一、T106 复验记录：**没有歌词就不显示桌面歌词 / 灵动歌词**（真实 Electron ＋ mock NAS，2026-11-17）

> ⚠ **本轮没有真机探针**（真实 NAS ＋ 真实账号）⇒ 真机效果**待用户确认**。
> 下面记的是**真实 Electron ＋ mock NAS** 的 E2E 结果 —— 窗口显隐**只能**在真 Electron 里验
> （jsdom 里根本没有窗口可验）。

### 一、验的是什么（真实 Electron，mock NAS）

| 项 | 结果 |
|---|---|
| **无歌词的歌** ⇒ 经典悬浮窗 | **不出现**（主进程 `BrowserWindow.isVisible()` ＝ 假；窗口**根本没被创建**） |
| **无歌词的歌** ⇒ 灵动态词岛 | **不出现** |
| **换成有歌词的歌** ⇒ 经典悬浮窗 | **自己出现**（**不依赖**用户再点一次开关） |
| **换成有歌词的歌** ⇒ 灵动态词岛 | **自己出现**（且窗口**没被干掉** —— 只是隐藏） |

### 二、⚠ 口径与坑（记下来）

- ⚠ **Playwright 的 `page.isVisible()` 是 DOM 级的**：窗口被 `hide()` 了，DOM 元素照样报「可见」
  ⇒ 验窗口显隐必须问**主进程** `BrowserWindow.isVisible()`（**OS 级**）；
- ⚠ **mock 的共享 `LYRICS` 里每首歌都有歌词** ⇒ 找不到「完全没歌词」的那首
  ⇒ **不往共享 fixtures 里加歌**（T97 断言「随机挑了 8 首」）
  ⇒ **按实例注入**一首**换 guid** 的歌（歌词表按 guid 查 ⇒ 新 guid 没有歌词）；
- ⚠ 桌面歌词是**另一个 BrowserWindow** ⇒ jsdom 验不了 ⇒ 这条行为**必须**是 E2E；
- ⚠ 判定必须抽成**纯函数**才能单测（窗口显隐的 bug 只有真机才看得见）；
- ⚠ 判定要分**三种曲目状态**：刚打开桌面歌词时主进程**不知道**当前这首有没有歌词
  ⇒ 按旧状态显示会闪一下**上一首**的歌词 ⇒ `unknown` 时**先不显示**。

> 提交：规格 `865f08f` / 实现 `dee3303` / **复验文档**（见提交说明）。

## 八十二、T107 复验记录：**按歌选源**（真实 Electron ＋ mock NAS，2026-11-17）

> ⚠ **本轮没有真机探针**（真实 NAS ＋ 真实账号）⇒ 真机效果**待用户确认**。
> 下面记的是**真实 Electron ＋ mock NAS** 的 E2E 结果 —— 「指定源真的换了歌词」
> 这条链跨了四层（控件 → store → IPC → 主进程建链），**只有真机能验**。

### 一、验的是什么（真实 Electron，mock NAS）

| 项 | 结果 |
|---|---|
| 不指定时（全局源 = **不用外部**） | 歌词 = **NAS 自带**那份（「第一行歌词」）；**一次网络请求都不发** |
| 给这首歌指定「自定义 API」 | 歌词**换成那个源的**（「外部歌词源第一行」）＋ 状态行**如实显示**「歌词来源：自定义 API」 |
| 「恢复自动」 | **回到 NAS 那份**；「恢复自动」按钮随之消失 |
| **换歌** | 上一首的指定**不跟着走**（这一首没有指定 ⇒ 按钮不出现） |

### 二、⚠ 口径与坑（记下来）

- ⚠ **桥的方法只收一个参数**（`fetchExternalLyric(query)`）⇒ 指定源必须**并进查询对象**；
  当第二个实参传 ⇒ **被静默丢掉**（现象：改了源但歌词没换）；
- ⚠ **全局源 = `off` 时，一次网络请求都不发**（主进程直接回 `not-found`）
  ⇒ 它既是「E2E 不碰真实外网」的保证，也是「换了源才有说服力」的**前提**
  （否则前后都是 NAS 那份 ⇒ 断言会成假阳性）；
- ⚠ **设置页开着的时候曲库导航不在 DOM 里** ⇒ 先点「关闭设置」；
- ⚠ **「保存歌词源」按钮在没有改动时是禁用的** ⇒ 先判 `isEnabled()` 再点（否则等到超时）；
- ⚠ 没连上服务器时**登录页不会自动出现** ⇒ 要先点顶栏「**连接**」再登录（与 t83 同一套写法）；
- ⚠ **`off` 不接受作为「按歌指定」**：它是**全局**档位 ⇒ 这样定之后，
  既有那条「渲染层传的**地址与源**被忽略」的断言**原样保留**（**一条未改**）；
- ⚠ **指定源排链首、其余源仍兜底** ⇒ 界面要**如实显示实际命中的那个源**（T73 既有口径）；
- ⚠ **上限 200 条**：本地存储是有限的 ⇒ 超出时按写入时间**淘汰最旧的**；
- ⚠ **`localStorage` 写不进去**（配额满 / 隐私模式）⇒ **静默降级**为「只在本次运行内有效」，
  但界面**看得见**（`error` 有值）—— **不许静默假装成功**。

> 提交：规格 `32181e1` / 实现 `adb8018` / **复验文档**（见提交说明）。

## 八十三、T108 复验记录：**轮询所有歌词源，带逐字时间戳的优先**（真实 Electron ＋ mock NAS，2026-11-18）

> ⚠ **本轮没有真机探针**（真实 NAS ＋ 真实账号）⇒ 真机效果**待用户确认**。
> 下面记的是**真实 Electron ＋ mock NAS** 的 E2E 结果 —— 「外部源给的逐字歌词
> 真的被渲染成真逐字」这条链跨了四层（主进程选词 → IPC → 解析 → 渲染），**只有真机能验**。

### 一、验的是什么（真实 Electron，mock NAS）

| 项 | 结果 |
|---|---|
| 外部源返回**行级**歌词 | 整行显示、**零**词级元素（不假装逐字）—— T81 既有口径，**未变** |
| 外部源返回**带 `<mm:ss.xx>`** 的歌词 | **真逐字**：词级元素**在**（`[data-word]` / `--karaoke` / `--overlay`），**整行强调不在** |
| 内容 | 是 mock 的 `/mock-lyric-word` 给的那份（NAS 里那首歌**没有**歌词）⇒ 确实走了**外部源** |
| 状态行 | 如实显示「歌词来源：自定义 API」（T73 既有口径） |

### 二、⚠ 口径与坑（记下来）

- ⚠ **「优先」由单测钉，E2E 钉不了**：E2E 里只有 mock 一个源 ⇒ 天然验不了「谁优先」
  ⇒ 「唯一带逐字者胜出 / 都带逐字按链序取第一个 / 都不带逐字用首选源 / 轮询后面的源也会被问」
  全部是**单测**（`test/lyric-word-timed-priority.test.ts`，31 条）；
  E2E 只钉「**带逐字的那份确实被采用并渲染成真逐字**」；
- ⚠ **并发轮询 ⇒ E2E 会真的打真实外网**（连 `custom` 也会去问网易云 / lrclib / QQ / 酷狗 / 酷我 / 咪咕）
  ⇒ 必须把**兜底源**限制到 mock 指的源 ⇒ 新增主进程环境变量 `FNM_LYRIC_SOURCES`
  ⇒ `launchApp` 设 `custom` ⇒ 链 = `[custom]` ⇒ 既有 E2E **行为一字不变**；
- ⚠ **改写既有断言时，「全局第 N 个请求」要换成「该源自己的第 N 个请求」**
  （按源域过滤后再取下标）⇒ 断言**更精确**；
  ⚠️ 原来那条「命中即停」其实**顺带**验了「别的源没被问」⇒ 前提被本轮需求推翻 ⇒ 改写为新行为；
- ⚠ **mock 的逐字歌词三行正文必须各不相同** ⇒ 否则 E2E 的
  `getByText(..., { exact: true })` 会**命中 3 个元素** ⇒ 严格模式报错（第一轮就踩了）；
- ⚠ **串行口径的最坏耗时是 33 秒**（3+3+8+6+5+5+3），**早就超过**渲染层的 12 秒超时
  ⇒ 并发化之后降到 **8 秒**（各源限时的最大值，QQ）⇒ **比原来更稳**；
- ⚠ **早停不能牺牲可复现性**：若按「谁先回」挑逐字候选，用户钦定的源会被网络抖动顶掉
  ⇒ 早停条件是「**链序最靠前**的逐字候选 **且它前面链序的源都出结果了**」；
- ⚠ **代价**：每首歌固定打 7 个源、最坏 8 秒、逐字源可能**没有罗马音**
  ⇒ 翻译 / 罗马音**随源变**；
- ⚠ **逐字判定是「整份文件」级**：真实文件可能只有部分行带词级标签
  ⇒ 主进程只用它「挑哪一份」，**逐行**判定仍归渲染层（`assemble` 的 `wordTimed`）。

> 提交：规格 `a40ce32` / 实现 `56db323` / **复验文档**（见提交说明）。

## 八十四、T108 **真机**复验记录：**轮询所有歌词源、带逐字的那份优先、最长 8 秒**（真实 NAS ＋ 真实账号，2026-11-18）

> ⚠ **本轮数字只代表这台机、这个账号**（别的机器 / 别的网络下会不一样）。
> ⚠ **只读**：用**隔离 userData**（只复制真实目录里的 `session.bin` ＋ `Local State`）
> ⇒ 真实账号 ＋ 真 NAS，但**不碰**用户自己的偏好 / 下载目录，**也不干扰**已装的 v0.2.9。
> 探针：`release/verify/t108-07-realmachine-verify.mjs`
> （结果 JSON：同目录 `t108-07-realmachine-result.json`；判定 **11 项全过**）。

### 一、验的是什么（三条，逐条有证据）

| 项 | 实测 | 怎么量的 |
|---|---|---|
| ① **全源轮询** | 播放真实 NAS 的一首歌 ⇒ 主进程**同时**请求了 **6 个源**（酷我 / 网易云 / lrclib / QQ / 酷狗 / 咪咕）⇒ **不再「命中即停」** | Chromium 网络栈的请求日志（主进程 `webRequest` 钩子）里出现**各源主机名** |
| ② **逐字优先** | 《晴天 / 周杰伦》⇒ 命中**酷我**，那份原文**带逐字**（`<mm:ss.xx>`）⇒ 逐源表里带逐字的是 **酷我 / QQ / 酷狗 / 咪咕** ⇒ **链序最靠前的带逐字源就是酷我** ⇒ 完全符合「按链序挑带逐字的那份」 | IPC 结果里的 `source` ＋ `original`；再用 `FNM_LYRIC_SOURCES` 白名单**逐源单独问**一次做交叉验证 |
| ③ **最长 8 秒** | 把 QQ 的两个域名指向**黑洞 IP**（连得上但不回话）⇒ 一次「哪个源都匹配不上」的查询**等了 8023 ms** ⇒ **8 秒上限实测确认** | 同上（Chromium 的 `--host-resolver-rules`，**不改系统 hosts**） |

### 二、逐源能力表（本机该账号，2026-11-18；《晴天 / 周杰伦》）

| 源 | 单源耗时 | 结果 | 带逐字 |
|---|---|---|---|
| 酷我 `kuwo` | **416 ms** | ok | ✅ |
| 网易云 `netease` | **239 ms** | **not-found** | — |
| lrclib | **1752 ms** | ok | ❌（**只有行级**） |
| QQ `qq` | **685 ms** | ok | ✅ |
| 酷狗 `kugou` | **257 ms** | ok | ✅ |
| 咪咕 `migu` | **510 ms** | ok | ✅ |

⇒ 带逐字的源里**链序最靠前的是酷我** ⇒ 正常路径（首选源也是酷我）命中酷我 ⇒ **与规则一致**；
⚠️ 网易云这一首**没匹配上**、lrclib 这一首**只有行级** ⇒ 这两个源上「逐字优先」**起不了作用**。

### 三、其他实测数字（同一台机、同一账号）

- 正常网络下，一首歌的**线上取词**耗时 **773 ms**（**10 个请求 / 6 个源**）；
  ⚠️ 同一首歌在另一轮是 **1604 ms** ⇒ 正常波动区间 **0.8–1.6 秒**；
- 那首 NAS 的歌（《茨厂街（粤语谐剧·黄庆全 陈自成 吴金英）》）**公网 6 个源都没匹配上**
  ⇒ 全屏页显示「**歌词来源：音频内嵌**」（T83 的回落口径）⇒ 说明**内嵌**与**线上**两条路都活着；
- ⚠️ **首选源是酷我**（沿用用户真实偏好 `prefs.json` 的 `lyric.source = 'kuwo'`），
  且用户**没配自定义模板** ⇒ 链 = **6 个源**（`custom` 不在链里）。

### 四、⚠ 口径与坑（记下来）

- ⚠ **歌词是「按需」取的**：桌面歌词窗**关掉**时，光是播放一首歌**一个请求都不会发**
  ⇒ 第一轮探针据此判了「产品路径没轮询」⇒ **必须打开全屏播放页的歌词页**才触发
  ⇒ 这不是 T108 的问题，是「歌词按需取」这件事的性质；
- ⚠ **要避开主进程的歌词缓存**才能量到真·网络耗时：缓存键**含 album**
  （`cacheKey`），而 **album 不参与匹配**（源码核对：album 只进「自定义模板渲染」与「缓存键」）
  ⇒ 探针查询时给 album 塞**哨兵值** ⇒ 键不同 ⇒ 主进程**真的重新轮询**；
- ⚠ **黑洞 IP 要选「连得上但不回话」的**（`192.0.2.1`，RFC 5737 TEST-NET-1）
  ⇒ 用 Chromium 的 `--host-resolver-rules` 只作用于**本进程** ⇒ **不改系统 hosts**；
  ⚠️ 选成「连不上」的地址会**秒失败** ⇒ 量不到超时预算；
- ⚠ **逐源能力表要靠 `FNM_LYRIC_SOURCES` 白名单**（T108 新增的那个环境变量）
  —— T108 之后链里**总是**有全部源 ⇒ 没法用「指定一个源」去单独问
  ⇒ 白名单 ＋ 把全局源设成同一个源 ⇒ 链 = `[那个源]` ⇒ 才问得到单个源的结果；
- ⚠ **逐字判定是「整份文件」级** ⇒ 渲染层仍是**逐行**判 `wordTimed`
  ⇒ 「主进程挑了带逐字的那份」与「界面上逐字扫光」是**两件事**（后者由 T81 / T108 的 E2E 钉住）；
- ⚠ 本轮**没有测「用户手动指定源」（T107）与逐字优先的 interplay**
  （指定的源排在链首 ⇒ 它若带逐字就赢）⇒ 可另开小任务；
- ⚠ 本轮**没有真机界面证据**（截图 / 卡拉OK 扫光）—— 真机那首 NAS 的歌走的是**内嵌歌词**
  ⇒ 要看「公网逐字歌词在真机上扫光」需另跑一次（用一首 NAS 里有、且公网词源也认识的歌）。

> 提交：规格 `a40ce32` / 实现 `56db323` / 复验文档 `c9a347f` / **本节**（见提交说明）。

## 八十五、T109 复验记录：**列表初始为空时，也要量到真实视口高度**（真实 Electron ＋ mock NAS，2026-11-18）

> ⚠ 本轮是**自动化复验**（真实 Electron ＋ mock NAS）⇒ **没有真机复验**（真实 NAS ＋ 真实账号）
> ⇒ 真机效果**待用户确认**（见文末「遗留」）。
> ⚠ 下面所有数字**只代表这一份构建、这个窗口尺寸（1200×800）**。

### 一、验的是什么（根因 → 后果 → 改法）

| 环节 | 事实 |
|---|---|
| 根因 | 列表**初始为空**时组件走**空态分支**（`src/components/SongList.tsx` L377–384）⇒ **根本不渲染** `.fnm-songlist__viewport`（唯一带 `ref={viewportRef}` 的节点） |
| 放大器 | 量高 effect 依赖写死 `[]` ⇒ 只在**挂载时**跑一次 ⇒ 那一刻 `viewportRef.current === null` ⇒ **第一行就 return**（连 `ResizeObserver` 都没挂上）⇒ **数据到达后不会重跑** |
| 后果 | `measuredHeight` 永远停在 0 ⇒ 一路用兜底常量 `SONG_LIST_FALLBACK_VIEWPORT_HEIGHT = 600` ⇒ 虚拟窗口按 600px 算（可见 13 行），而不是真实视口 ⇒ **DOM 行数随导航路径摇摆** |
| 改法 | 量高 effect 的依赖从 `[]` 改成 **`[songs.length]`** ⇒ 空态 → 有数据的**那一刻**重跑 ⇒ 节点已存在 ⇒ 量到真实高度 ＋ 挂上 `ResizeObserver` ⇒ **窗口缩放仍能跟随** |
| 口径 | 与 `LyricView`（T46 补丁②）**同一个坑、同一个修法**；`CardGrid` 无此缺陷（视口**始终渲染**） |

### 二、实测数字（真实 Electron ＋ mock NAS 的 40 集详情页）

| 项 | 实测 |
|---|---|
| 详情页曲目视口**真实高度** | **269 px**（钳到窗口高度后仍是 **269 px**） |
| 修好后 DOM 行数 | **11**（= `ceil(269 / 48)` ＝ 6 ＋ 缓冲 5） |
| 缺陷态 DOM 行数 | **18**（兜底 600 ⇒ `ceil(600 / 48)` ＝ 13 ＋ 缓冲 5） |
| 虚拟裁剪仍生效 | DOM **11** 行 ≪ 全部 **40** 首（状态行「已加载 40 / 40」） |

⇒ 缺陷态与修好后的差值是 **7 行**，且**与窗口尺寸无关**（只要真实视口 < 600）⇒ E2E 有鉴别力。

### 三、单测怎么钉（jsdom）

jsdom **没有布局引擎** ⇒ `getBoundingClientRect()` 恒返回 0 ⇒ 量不到高度 ⇒ **正好用来做对照**：

- 把 `Element.prototype.getBoundingClientRect` mock 成 **240 px**；
- 先渲染**空列表**（无视口节点）→ 再 `rerender` 成 1000 首歌；
- 断言 DOM 行数 == `ceil(240 / 48)` ＋ 5 = **10**；缺陷态是 **18** ⇒ **红**；
- 另有 3 条基线：初始就有数据（同样按实测裁剪）、量不到高度时仍用兜底且不渲染零行、
  空态 → 有数据时状态行与空态文案正确切换。

### 四、变异自证（`t109-01`）：**3 条 × 2 层**（单测 ＋ E2E）**逐条变红**

| 变异 | 单测 | E2E | 说明 |
|---|---|---|---|
| M1 依赖改回 `[]` | **红** | **红** | **缺陷原样** |
| M2 整个量高 effect 被摘掉 | **红** | **红** | 一律用兜底 600 |
| M3 量**错的元素**（量文档根而不是视口） | **红** | **红** | 高度算错 |

⇒ 基线（单测 ＋ E2E）绿；还原后 sha256 一致 ⇒ **MUTATION_OK**。

### 五、⚠ 口径与坑（本轮实战踩到的）

- ⭐ ⚠ **mock 太粗 ⇒ 单测就咬不住「量错元素」**：
  第一版 mock 把 **`Element.prototype` 上所有元素**都 mock 成 240
  ⇒ 连 `document.documentElement` 也返回 240 ⇒ M3「去量文档根」量出来**还是 240**
  ⇒ **单测层不红**（只有 E2E 层红）⇒ 差点把「M3 没被证明」当成「已被证明」放过去。
  ⇒ **正解**：只给**视口元素**高度（`this.classList.contains('fnm-songlist__viewport')`），
  其余元素仍是 0（贴近 jsdom 真实行为）⇒ 改完 M3 单测层**立刻变红**；
- ⚠ **E2E 跑的是构建产物** ⇒ 每次变异后**必须重新 build**（否则测的是旧产物 ⇒ **假绿**）；
- ⚠ **「量高」是 effect 触发的** ⇒ E2E 里要**等布局稳定**
  （`expect.poll` 等 `actual - expected == 0`）⇒ 否则会读到中间态、误判失败；
- ⚠ **别断言「DOM 里有 N 行」**：既有 E2E `t97` 的 `toHaveCount(8)` 本轮**照常通过**
  （随机面板视口 ≥ 3 行 ⇒ 8 首歌全在 DOM 里）⇒ 但那是**数据只有 8 首**的**巧合**，
  不是「视口裁剪正确」的证据 ⇒ 这类断言应写**数据**（状态行「已加载 N / N」）或
  **滚着收齐**（T104 的 `collectSongListRows`）；
- ⚠ T104 规格 §六 记的「**T105 候选**」就是这一条 ⇒ **已修**；
  编号顺延到 **T109**（T105～T108 已被占用）；
- ⚠ **历史规格不改**：T104 规格 §六 保留原样（「本任务**不**修」）⇒ 修没修记在
  changelog / calibration / 台账里（历史规格是**当时的判断**，改它等于篡改历史）。

### 六、遗留 / 待办

- ⚠ **本轮没有真机复验**（真实 NAS ＋ 真实账号）⇒ 真机上「曲库页 / 详情页的行数是否也按真实视口」
  **待用户确认**；
- ⚠ **T104 / T106 / T107 / T108 台账里顺延的「`SongList` 量高在列表初始为空时失效」**
  ——就是这一条 ⇒ **本任务已消解**；
- ⚠ 台账里另有一条**独立**的候选没动：`SongList` 的「量高」**已修**，
  但**详情页**的列表要用「滚着收齐」验（T104 已改成那样）⇒ 仍然成立；
- ⚠ **push 待确认**（当前领先 origin **41** 个提交，未推）。

> 提交：规格 `f7f62d7` / 实现 `19b27bb` / **复验文档**（见提交说明）。

## 八十六、T109 **真机**复验记录：**列表初始为空时，也要按真实视口显示行数**（真实 NAS ＋ 真实账号，2026-11-18）

> ⚠ **本轮数字只代表这台机、这个账号、这个窗口尺寸（1200×800）**（别的机器 / 别的窗口会不一样）。
> ⚠ **只读**：用**隔离 userData**（只复制真实目录里的 `session.bin` ＋ `Local State`）
> ⇒ 真实账号 ＋ 真 NAS，但**不碰**用户自己的偏好 / 下载目录，**也不干扰**已装的 v0.2.9。
> 探针：`release/verify/t109-07-realmachine-verify.mjs`
> （结果 JSON：同目录 `t109-07-realmachine-result.json`；判定 **14 项全过**）。

### 一、验的是什么（四条，逐条有证据）

| 项 | 实测 | 怎么量的 |
|---|---|---|
| ① **初始为空** | 渲染进程的时间线里**先**出现「**没有视口**」的样本（列表空态），**后**才出现「有视口 ＋ 有行」⇒ 列表确实是**先空后有**（缺陷的触发条件成立） | 注入渲染进程的**记录器**（rAF 采样，**指纹变了才记**） |
| ② **按真实视口算行数** | 曲库页：视口**真实高度 468 px** ⇒ DOM **15 行**（＝ `ceil(468 / 48)` ＋ 缓冲 5）⇒ 与期望**逐字相等** | 同一时刻读 `getBoundingClientRect().height` ＋ `window.innerHeight`（组件还会钳到窗口高度）＋ `--row-height`（行高唯一真值） |
| ③ **不再停在兜底 600** | 兜底口径是 **18 行**，实测 **15 行** ⇒ 用的**不是**兜底 | 同一份数据算两遍：按真实高度 vs 按 600 | 
| ④ **窗口缩放仍跟随** | 468 px / 15 行 ⇒（窗口缩到 560 高）⇒ **228 px / 10 行** ⇒ **`ResizeObserver` 真的挂着** | 主进程 `setBounds` 改高度 ⇒ 再量一遍 |

### 二、两个列表的实测（真实 NAS 的真实数据）

| 列表 | 视口真实高度 | DOM 实际行数 | 按真实高度算的期望 | 兜底口径（600） | 条目数 |
|---|---|---|---|---|---|
| 曲库页「歌曲」 | **468 px** | **15 行** | **15** | 18 | 已加载 **50** / 173,671 |
| 《牧神记》详情页（**2762 集**） | **179 px** | **9 行** | **9** | 18 | 已加载 **2,762** / 5,524 |

⇒ 两个列表**各自**按**各自**的真实视口算 ⇒ 不再是「统统 18 行」（缺陷态）。
⇒ 虚拟裁剪**确实生效**：曲库页 DOM **15** 行 vs 已加载 **50** 首；详情页 DOM **9** 行 vs 已加载 **2762** 首。

### 三、⭐ 最强的一条证据（**兜底那行被改小**）

曲库页的时间线（记录器抓到的三个状态）：

| 时刻 | 视口 | DOM 行数 |
|---|---|---|
| 数据到达**前** | **没有视口**（空态） | **0**（列表还没挂上节点） |
| 数据到达**那一刻** | 468 px | **18 行**（＝ 兜底 600 算出来的） |
| effect 跑完（量到真实高度） | 468 px | **15 行**（＝ 按真实高度算出来的） |

⇒ 「18 → 15」正是修复的**机制本身**：数据到达 ⇒ 视口节点挂上 ⇒ 量高 effect 因依赖变了而重跑
⇒ 量到 **468 px** ⇒ 虚拟窗口从兜底口径缩到真实口径。
⇒ **缺陷态会永远停在 18 行**（effect 不会重跑）。

### 四、⚠ 口径与坑（本轮真机又踩到的）

- ⚠ **曲库页的曲库是「页面挂载后异步加载」的**（`SongsPage` 挂载 ⇒ `useEffect` ⇒ `loadSongs(1)`）
  ⇒ `SongList` 挂载那一刻 `songs` 是空的 ⇒ **正好命中缺陷的触发条件**；
- ⚠ **普通专辑卡的副标题只有歌手名**（没有曲目数）⇒ 想挑「曲目最多」的专辑**挑不出来**
  ⇒ 要走**「有声」页**（副标题是「N 集 · 单集均长 9 分」）⇒ 本轮挑到 **《牧神记》2762 集**；
- ⚠ **条目数 ≤ 兜底口径时，「≠ 兜底」在数学上不可能成立**（行数由**数据量**决定，与视口无关）
  ⇒ 这种列表**无鉴别力** ⇒ 探针**如实记成 note**、**不判 FAIL**
  （第一轮那张只有 1 首歌的专辑就是这种情况 ⇒ 它的行数恒为 1，与视口无关）；
- ⚠ **「数据刚到」那一帧是竞态**：记录器的 rAF 有没有赶上**不确定**
  ⇒ 实测**有时抓到**（先 18 行 → 后 15 行）、**有时没抓到**（首个样本就已经是 15 行）
  ⇒ 只当**佐证**、**不当断言**；
- ⚠ **别清空启动时间线**：曲库页是应用启动后**自动加载**的，「空态」那一段就在**启动期间**
  ⇒ 清掉就把证据冲了（第一轮就是这么丢的 ⇒ 误判成「初始为空没复现」）；
- ⚠ 页面切换是 **SPA 内导航**（**不重新加载文档**）⇒ `page.addInitScript` 只对**后续导航**生效
  ⇒ 记录器要**直接注入当前文档**（`app.addInitScript` 那个 API 在 Electron 上**不存在**）；
- ⚠ 窗口**最大化**时 `setBounds` **不生效** ⇒ 缩放前要先 `unmaximize`。

### 五、遗留

- ⚠ 本轮**没有界面截图**（探针只量几何）⇒ 「看起来对不对」仍需**用户肉眼确认**；
- ⚠ **push 待确认**（当前领先 origin **42** 个提交，未推）。

> 提交：规格 `f7f62d7` / 实现 `19b27bb` / 复验文档 `0e64229` / **本节**（见提交说明）。

## 八十七、T109 **真机界面证据**：曲库页 ＋ 详情页的**行数显示**（截图，2026-11-18）

> ⚠ 探针：`release/verify/t109-10-realmachine-shots.mjs`
> （结果 JSON：同目录 `t109-10-realmachine-shots.json`；判定 **6 项全过**）。
> ⚠ 同一套**隔离 userData ＋ 真实 NAS ＋ 真实账号**（**只读**、不干扰已装的 v0.2.9）。
> ⚠ 截图落在 `release/verify/shots/`（**gitignore**）—— 与历来的真机探针截图一致
> （`t101-*` / `t102-*` / `t50-*` 都在那儿）；文档按路径引用。
> ⚠ 这是补「八十六」里缺的那一项：**之前只量了几何，没有界面证据**。

### 一、三组截图与它们对应的数字（**同一次运行**里拍的）

| # | 截图 | 场景 | 视口真实高度 | 画面里**可见**的行 | DOM 行数（含缓冲） | 兜底口径（600） |
|---|---|---|---|---|---|---|
| ① | `t109-01-library-full.png` / `t109-01-library-list.png` | 曲库页「歌曲」 | **468 px** | **10**（9 行完整 ＋ 第 10 行被底边切一半） | **15**（10 可见 ＋ 5 缓冲） | 18 |
| ② | `t109-02-detail-full.png` / `t109-02-detail-list.png` | 详情页《牧神记》（**2762 集**） | **179 px** | **4**（3 行完整 ＋ 1 半行） | **9**（4 可见 ＋ 5 缓冲） | 18 |
| ③ | `t109-03-library-narrow-full.png` / `t109-03-library-narrow-list.png` | 曲库页，窗口缩到 **560** 高 | **228 px** | **5**（4 行完整 ＋ 1 半行） | **10**（5 可见 ＋ 5 缓冲） | 18 |

### 二、肉眼能确认的（这才是「界面证据」）

- ✅ ① **视口里恰好是「该看见的那些行」**：最后一行被视口底边切一半 —— 虚拟滚动的**正常表现**；
- ✅ ② **缓冲行看不见**：DOM 里多出来的那 5 行在画布**下方**、被视口裁掉
  ⇒ 界面上**看不到**兜底态那多出来的行；
- ✅ ③ **列表下方没有多余的空白画布**（缺陷态会多出一截按 600px 算的空白）；
- ✅ ④ **状态行正常**：①「已加载 50 / 173,671」、②「已加载 2,762 / 5,524」；
- ✅ ⑤ ② 的**集号按集序**（`0001` / `0002` / `0003` / `0004`，副标题「第 N 集 宅猪」）；
- ✅ ⑥ ③ 窗口变矮 ⇒ **可见行数从 10 变成 5** ⇒ `ResizeObserver` 跟着走。

### 三、⚠ 口径

- ⚠ 截图与数字是**同一次运行**里拍的 ⇒ 数字与画面对得上；不是「先量后拍」；
- ⚠ 「可见行数」与「DOM 行数」**差 5**（= 缓冲行）⇒ 截图里只能看到可见的那部分 ——
  **这是虚拟滚动的设计**，不是「少渲染了」；
- ⚠ 截图在 `release/verify/shots/`（**gitignore**）⇒ 只在本机留着（文档按路径引用）；
- ⚠ 本轮**没有做主观审美判断** ⇒ 「好不好看」仍归用户。

### 四、遗留

- ✅ **补齐了「八十六」遗留的那一项**（当时「本轮**没有界面截图**」）⇒ 现在有三组截图，
  并已**逐张核看**（上表里的数字与画面一一对上）；
- ⚠ 原图在 **gitignore** 目录 ⇒ **只在本机** ⇒ 用户要看原图得自己开 `release/verify/shots/`；
- ⚠ **push 待确认**（当前领先 origin **43** 个提交，未推）。

> 提交：规格 `f7f62d7` / 实现 `19b27bb` / 复验文档 `0e64229` / 真机复验 `76b723d` / **本节**（见提交说明）。

## 八十八、T110 **发版 v0.4.0**（2026-11-18）

> ⚠ 用户 2026-11-18 指令 ——「**发布更新**」；
> 用户**当场拍板**：版本号 = **0.4.0**（minor）、**现在就发**，
> **未在真机复验的两项在发布说明里如实标注**。

### 一、发版链路与实测结果

| 环节 | 实测 |
|---|---|
| 版本号 | **0.4.0**（用户拍板）⇒ 标签 `v0.4.0`（**注解标签**，指向 `c2af517`） |
| 改动文件 | **4 个**：`package.json`（**只 1 行**）／`docs/releases/v0.4.0.md`（**新增**）／`docs/changelog.md`（**4 处**）／`README.md`（**12 处**） |
| 发布前验证（fresh，本机） | `tsc` **0 error**；Vitest **144 文件 / 2989 条**全绿；`build` exit 0；Playwright **68 条**全绿；字节体检 ＋ 控制字符 **0 bad** |
| CI run | Release **#17**（`workflow_dispatch`，head = `c2af517`）⇒ **success**，**6 分 08 秒** |
| 资产 | **恰好 3 个**：Setup（86,138,432 B）／Portable（79,041,406 B）／`latest.json`（472 B）⇒ 下载 URL 不 404 |
| `latest.json` | `version` = **0.4.0**；`releasedAt` = `2026-11-18T08:28:02Z`；`files[0]` = Setup 包（sha512 **128 位小写 hex**、size 与资产**对得上**） |
| attestation | Setup 包的 sha256 → attestation 库 **1 条** ⇒ **替代信任锚成立**（本版**仍未签名**） |
| Release 是不是 latest | **是**（`/releases/latest` 返回 `v0.4.0`）⇒ 自动更新拿得到本版 |

### 二、这一版装了什么（`v0.3.0..HEAD` = **45 个提交 / 102 个文件 / +20088 −142 行**）

**T96** 发现页（榜单＋为你推荐）｜**T97** 随机 20 首｜**T98** 有声读物整族｜
**T99–T103** 有声真机修复｜**T104** 详情页滚到底｜**T106** 无歌词不弹桌面歌词｜
**T107** 按歌换源｜**T108** 逐字优先全源轮询｜**T109** 列表按真实视口显示行数。

测试文件（`test/` ＋ `e2e/`）**136 → 166（+30）**。

### 三、真机复验状态（**如实标注**）

- ✅ **有真机复验**：有声整族（《极品家丁》**1333 集**集号 **0…1332 连续无缺号无重复**）／
  详情页滚到底（T104）／歌词全源轮询 ＋ 逐字优先 ＋ 最长 8 秒（T108）／列表按真实视口（T109，含截图）；
- ⚠ **只有自动化复验、未在真机跑过**：**T106**（没有歌词就不弹桌面歌词）／**T107**（按歌手动换源）
  ⇒ **发布说明里写明了**，并请用户**优先验这两项**。

### 四、⚠ 口径与坑（本轮踩到的）

- ⭐ **changelog 绝不能整篇替换 `0.3.0` → `0.4.0`**：那一段里还留着**历史**的 `## 0.3.0` 段、
  v0.3.0 发版工作流的记录、以及「相对 **v0.3.0** 的一次更新」这句话
  ⇒ **只有 4 处该改**，其余**一个字不动**（历史是**当时的记录**，改它等于篡改历史）；
- ⭐ **`package-lock.json` 的 `version` 停在 `0.2.4`**（**历史上就没同步过**）
  ⇒ **别顺手改**（改了就是本轮多改一个文件 ⇒ 违反「只改 4 个」）；
- ⭐ ⚠ **`github.com` 网页端从这台机器连不通**（DNS 指到 `20.205.243.166` ⇒ 反复超时），
  而 **SSH 与 `api.github.com` 都正常** ⇒ 别因为网页打不开就以为没权限；
  正解 = 本地起一个 **CONNECT 代理**把 `github.com` **钉到可用 IP**，再把 **HKCU 的系统代理**
  临时指过去（**不需要管理员**）⇒ 干完**还原**（`ProxyEnable` 复原 ＋ 关掉代理进程）；
- ⚠ **dispatch 表单里 `pack_only` 与 `sign` 默认都是勾上的** ⇒ **必须显式取消**
  （`sign=true` 会必然失败在「Check SignPath configuration」，因为申请已被拒）；
- ⚠ **校验值不能写死**（NSIS 内嵌构建时间戳 ⇒ 两次构建字节必然不同）⇒ 由 CI 在正文末尾**追加**；
- ⚠ **本机不打包** ⇒ 产物只能由 CI 构建（可信构建的前提）⇒ 本机打包的包 **attestation 不认**。

### 五、遗留

- ⚠ **T106 / T107 仍未在真机复验** ⇒ 请用户优先验这两项；
- ⚠ **本机已装的仍是 v0.2.9**（在 `D:\Sanlos Music\`）⇒ 要不要装 v0.4.0 由用户拍板；
- ⚠ **push 已完成**（分支 ＋ 标签都已推上远端）⇒ 本轮**无未推提交**。

## 八十九、T111：装 v0.4.0 ＋ 真机复验 T106 / T107

> 日期：**2026-11-18**｜机器：**这台 Windows 11 开发机**｜账号：**真实账号**｜后端：**真实 NAS**
> ｜被测对象：**已安装的 v0.4.0**（`D:\Sanlos Music\Sanlos Music.exe`，`app.asar` 版本 = `0.4.0`）
>
> 承接 **T110（发版 v0.4.0）**：发布说明里点名 **T106**（没有歌词就不弹桌面歌词 / 灵动歌词）
> 与 **T107**（按歌手动换源）**「只有自动化复验、未在真机跑过」** ⇒ 这一节把它们补上。

### 一、先更正一个事实（**之前记错了**）

⚠️ 之前记的是「本机已装 **v0.2.9**」—— **错**。
实测：`D:\Sanlos Music\resources\app.asar` 里的 `version` = **`0.3.0`**，
注册表 `HKLM\…\Uninstall\{fa78624c-…}` 的 `DisplayName` = 「**Sanlos Music 0.3.0**」。

⇒ **T111 之前本机装的是 v0.3.0**（不是 v0.2.9）；T111 把它换成了 v0.4.0。

### 二、安装：四步 ＋ 每步的验收（全部实测）

| 步 | 做什么 | 实测 |
|---|---|---|
| ① 下载 | 走 **`api.github.com` 的资产端点**（`GET /repos/…/releases/assets/762571948`，302 → `release-assets.githubusercontent.com`） | **86 138 432 B**，落 `D:\tmp\SanlosMusic-Setup-0.4.0.exe` |
| ② 验字节 | sha256 逐字比对 | `3d64a3323d57600720089b73115a763026c94f9d8c26ed042bfbef696105c981` —— **与 Release 页面逐字一致** ⇒ 本版**无代码签名**时，字节校验 ＋ attestation 就是信任锚 |
| ③ 备份 ＋ 装 | `D:\Sanlos Music` **改名**成 `D:\Sanlos Music.bak-v0.3.0`（**不删除**）⇒ 再 `Setup.exe /S /D=D:\Sanlos Music` | 安装器 **exit 0**；旧版 19 项**完整保留**在备份目录 |
| ④ 验收 | 读 `app.asar` 的 `version` ＋ 注册表卸载项 | `app.asar` = **0.4.0**；卸载项 = 「**Sanlos Music 0.4.0**」、卸载器仍指向 `D:\Sanlos Music\Uninstall Sanlos Music.exe`（**升级链连续**） |

⚠️ **为什么备份用「改名」不用「复制/删除」**：同卷改名是原子的（O(1)），
内容一个字节都不丢 ⇒ 出任何问题都**改个名字就回退**。

⚠️ **NSIS 的 `/D=` 绝不能带引号**：NSIS 规定 `/D=` 必须是**最后一个参数**且**不含引号**（哪怕路径里有空格）
⇒ 用 Node 的 `spawn(exe, ['/S', '/D=D:\\Sanlos Music'], { windowsVerbatimArguments: true })` 自己拼命令行
（Node 默认的 argv 拼接会把路径**加上引号** ⇒ 目录名里多个引号 ⇒ 装歪）。

### 三、真机复验的**判据**（这一节最要紧：判据错了，结论全是错的）

| 要判的 | ✅ 用的判据 | ❌ 不能用的 |
|---|---|---|
| 「这首歌**有没有歌词**」 | **歌词窗自己收到的 `lyric:state` 消息**的 `lines.length`（消息带 `track.id` ⇒ **不串台、不滞后**） | ❌ **歌词窗的 DOM 文本**（实测**滞后一首**：切到第 4 首时，窗口里还是第 3 首的「望着你」） |
| 「窗口**在不在屏幕上**」 | 主进程 `BrowserWindow.isVisible()`（**OS 级**） | ❌ `page.isVisible()`（DOM 级：窗口被 `hide()` 了它照样报「可见」⇒ **假绿**） |

⚠️ **探针迭代（四个真实的坑，都是探针的错，不是产品的错）**：

1. **DOM 文本滞后** ⇒ 第一版探针把「窗口文本变了」当「歌词状态落定」⇒ 每首都误判成「有词」
   （切到第 4 首读到的还是第 3 首的词）⇒ 换成 `lyric:state` 的**行数**才准。
2. **前 12 首全都有词** ⇒ 库里每首歌在线源都能匹配到（连有声读物的集标题 `0001`/`0002`… 也**被误匹配**）
   ⇒ 「没词」的歌要**另找**（见下面「五、新发现」）。
3. **内嵌歌词优先级最高** ⇒ 第一版拿《茨厂街》做 T107 ⇒ 标签恒为「歌词来源：**音频内嵌**」
   ⇒ 指定「QQ 音乐」**也不会换**（不是 bug，是内嵌优先级）⇒ 选歌时**先看标签**，挑一个**线上源**的歌。
4. **抢跑** ⇒ 「全屏页标签已变成 QQ 音乐」比「桌面歌词窗重取词完成」**早 ~6 秒**
   ⇒ 只等标签会误判成「桌面歌词没跟着换」⇒ 必须等**新的 track 消息**（时间戳更新）。

### 四、真机结果（**8 条断言全过**）

**T106 · 没有歌词就不弹桌面歌词 / 灵动歌词**

| 步 | 歌 | 歌词行数 | 窗口存在 | **OS 级可见** |
|---|---|---|---|---|
| ① 有词 | 《茨厂街（粤语谐剧·黄庆全 陈自成 吴金英）》 | **262** | 是 | ✅ **可见** |
| ② 没词 | `No Friends` | **0** | **是** | ✅ **不可见**（⇒ 不是「被干掉」） |
| ③ 换回有词（**全程没碰开关**） | 《茨厂街…》 | **262** | 是 | ✅ **可见**（**自己回来**） |

词岛（同一套判据）：有词 ⇒ **可见**；没词（**0 行**）⇒ **不可见**。

**T107 · 按歌手动换源**（歌：问情）

| 步 | 全屏页状态行 | 桌面歌词窗 |
|---|---|---|
| 指定前 | 「歌词来源：**酷我音乐**」 | 收到 26 行 |
| 点「QQ 音乐」 | 「歌词来源：**QQ 音乐**」 | **收到同曲目的新一份词**（跟着重取词） |
| 点「恢复自动」 | 「歌词来源：**酷我音乐**」（**回到全局**） | 又收到一份（回到酷我） |

⚠️ **「没词」那首是怎么来的（如实口径）**：库里前几十首在线源**全都能匹配到**
⇒ 这一轮**把全局源临时切到「不用外部」**（真实用户操作，在设置页里点的），
`No Friends` 这首 **NAS 也没有词、音频内嵌也没有词** ⇒ `lines = 0`
⇒ 与用户说的「匹配不到 ＋ 也没有内嵌」**等价**（实现判据同为 `lines.length === 0`）。
⚠️ 这**不是**「在线源匹配失败」那条路径的复验（那一路径在库里找不到样本）——**如实标注**。

### 五、⚠️ 新发现（**不在本轮修** ⇒ 留作下一个编号任务）

1. **数字标题的曲目会被歌词源误匹配** ⇒ 有声读物的桌面歌词会显示**不相干的歌词**：
   实测《牧神记》的集标题 `0001`/`0002`/`0003`/`0005`/`0007`/`0008`… 分别被匹配到
   **161 / 122 / 132 / 235 / 108 / 348 行**的歌词（**全是别的歌**）。
   ⚠️ **T101 已经在全屏页做了「有声读物不查歌词」**（`isAudiobookTrack` ⇒ 不查），
   但**桌面歌词这条路径（`src/player/lyricOverlay.ts`）没有同样的判断** ⇒ 它照查照显示。
   ⇒ 建议下一轮：**桌面歌词也识别有声作品 ⇒ 不查词 ⇒ 词条为空 ⇒ 窗口自然不出现**。
2. **装 v0.4.0 后，本机已是 v0.4.0**（备份 `D:\Sanlos Music.bak-v0.3.0` 仍在，**要不要删由用户定**）。

### 六、隔离 userData（不碰用户真实数据）

真机复验必须是「真实账号 + 真实 NAS」，但**不能**动用户自己的偏好 / 下载目录：

- `--user-data-dir=<临时目录>`：只复制 `session.bin`（DPAPI 加密的会话）＋ `Local State`，
  另写一份 `prefs.json`（桌面歌词开着、形态=经典、全局源=**酷我** —— 与用户真实偏好同源）。
- ⚠️ `--user-data-dir` 会**触发迁移守卫**（`electron/userDataDir.ts`）
  ⇒ 旧目录**不会被搬走**（`skipped: user-data-dir-redirected`）⇒ 用户真实数据**一个字节都没动**。
- 实测：`app.getPath('userData')` = 临时目录 ✔；跑完**删掉临时目录** ✔。
- ⚠️ **开发实例与已装版共用同一 userData** ⇒ **别同时启动**（单实例锁会让旧版直接退出）——
  本轮全程只驱动**已装版**，没有起开发实例。

### 七、遗留

- ⚠️ **「在线源匹配失败 ⇒ 不弹窗」这条路径仍未在真机上跑过**（库里找不到样本；本轮用「不用外部」等价复现了实现判据）。
- ⚠️ **有声读物被误配歌词**（上面第 1 条）—— 待立项。
- ⚠️ `D:\Sanlos Music.bak-v0.3.0`（v0.3.0 备份）**仍在**，**删不删等用户拍板**。

## 九十、T112：有声读物被**误配**桌面歌词 —— 修复与真机复验（2026-11-18）

### 一、缺陷（**真机实测**，不是推测）

在**已安装的 v0.4.0** 上复验 T106 时顺带发现：有声读物的**集标题**是 `0001`/`0002`
这种**纯数字** ⇒ 歌词源拿它去匹配就**随便命中了某首同名/近名的歌**
⇒ **桌面歌词窗（经典悬浮窗 ＋ 灵动歌词岛）给有声小说显示出不相干的词**。

T111 实测（那一台机、那个账号、真实 NAS，**装着的 v0.4.0**）：

| 集标题 | 桌面歌词窗收到的行数 |
|---|---|
| `0001` | **161** |
| `0002` | **122** |
| `0003` | **132** |
| `0005` | **235** |
| `0007` | **108** |
| `0008` | **348** |

⚠️ 根因不是歌词源「乱匹配」本身，而是**桌面歌词这条路没有「有声读物不查词」的判断**：
全屏播放页（T101）**有**（`isAudiobookTrack` ⇒ 不查、空态写「有声读物没有歌词」），
桌面歌词（`src/player/lyricOverlay.ts`）**没有** ⇒ 它照查照显示。

### 二、修法（**最小**，与既有口径一致）

- `src/player/lyricOverlay.ts`：取词**之前**先判「这首是不是有声读物」
  ⇒ 是就**一次请求都不发**、推一份**空行**（`lines: []`）
  ⇒ 主进程按 T106 的规则（`lines.length > 0`）把窗口收起来
  ⇒ **一处改动同时覆盖经典窗与灵动歌词岛**；
  判据 = `useAudiobookStore.getState().isAudiobook(song.albumId)`
  （**与全屏页同一份真相**：自动判定 ＋ 人工改判，**改判优先**），且做成**可注入**选项。
- `src/main.tsx`：启动时 `restore()` 一次有声读物的落盘状态
  （**同步、只读 localStorage、不发任何请求、幂等**）
  ⇒ **不用先进「有声」页**就知道哪些专辑是有声读物
  （否则那个判据是空的 ⇒ 守卫等于没装）。

⚠️ **不动**歌词源的匹配算法（要动 7 个源 ⇒ 风险远大于收益）。
⚠️ **不动**已发布的 `docs/releases/v0.4.0.md`；**既有测试一条不删、断言一条不弱化**。

### 三、真机复验（**源码构建的开发实例** ＋ 真实 NAS ＋ 真实账号）

⚠️ **口径（必须如实标注）**：这一轮跑的是**源码构建**（仓库里的 `electron .` ＋ `dist/`），
**不是**已发布的 v0.4.0 二进制 ⇒ 证明的是「**这个修复在真账号 / 真 NAS 上成立**」，
**不是**「v0.4.0 里已经修好了」（v0.4.0 里**还是旧行为**）。

- **隔离 userData**：只复制 `session.bin`（DPAPI 会话）＋ `Local State`
  ⇒ 真实账号 ＋ 真 NAS，**不碰**用户真实偏好 / 下载目录；
- **偏好**：桌面歌词**开着**、形态 = **经典悬浮窗**、全局源 = **酷我**
  （与用户真实偏好同源）⇒ 有声那一集**本该**被匹配上别的歌（修复前实测 **161 行**）；
- **有声判定走产品自己的入口**：「有声」页**秒搜**《牧神记》⇒ 点开
  ⇒ **用户指认了它**（与用户点的一模一样，**不往 store 里硬塞状态**）。

| 项 | 期望 | 实测 |
|---|---|---|
| **对照组**：普通歌《茨厂街（粤语谐剧·黄庆全 陈自成 吴金英）》 | 有词 ⇒ 窗口**可见** | **262 行**（首行「哎呀，行到我对脚都唔知几攰。」）⇒ **可见** ✅ |
| **主角**：《牧神记》第 1 集（标题 `0001`） | 推的是**空行** ⇒ 窗口**不可见** | **0 行**（空行）⇒ **不可见** ✅ |
| **反向核对**：窗口**没被干掉**（只是隐藏） | 仍在 | **仍在** ✅ |

⇒ **6/6 断言全过**（探针 `release/verify/t112-01-realmachine-verify.mjs`，结果 JSON 同目录）。

⚠️ **与修复前的对照**（同一台机、同一账号、同一个 `0001`）：
修复前 = **161 行**（别的歌的词）⇒ 修复后 = **0 行**、窗口不出现。

### 四、自动化复验

- **单测**（新增 `test/t112-audiobook-desktop-lyric.test.ts`）—— **8 条**：
  有声 ⇒ **NAS 与外部源一个都没被问** ＋ 推的是 `lines: []`；
  **对照组**普通歌 ⇒ 照常取词（含「线上没匹配上 ⇒ 回落本地」那条）；
  判据认的是**专辑**（同一张专辑的别的集同样不查词）；
  **默认判据**（不注入）⇒ 读 `useAudiobookStore`（人工改判**优先**，改判成「这不是有声」⇒ 照常取词）；
  `restore()` 能读回落盘里的判定。
- **E2E**（新增 `e2e/t112-audiobook-desktop-lyric.spec.ts`，真 Electron ＋ mock NAS）—— **4 条**：
  经典窗**不出现** ＋ **外部源一次没被问**（用**本文件自己起的**假歌词源服务器数请求）；
  对照组普通歌 ⇒ 窗口**出现** ＋ 外部源**确实被问过**；
  灵动态词岛同样**不出现**；
  **重启后（没进过「有声」页）仍然不出现**（证明启动 `restore()` 生效）。
- **变异自证**（把实现改坏 ⇒ 用例必须变红）：
  - **M1** 守卫改坏（判据用错专辑 id）⇒ 单测 **3 条**红 ＋ E2E **①**红；
  - **M2** 启动 `restore()` 改坏 ⇒ **只有**「重启后仍生效」那条红（①②③ 仍绿）⇒
    **两条腿各自被自己的用例钉住**。
- **全量**：`tsc --noEmit` **0 error**；Vitest **2997** 条全绿（既有 **2989** 条一条不删）；
  Playwright 全绿（既有 **68** 条一条不删）；`npm run build` exit 0。

### 五、遗留 / 待办

- ⚠ **v0.4.0 二进制里还是旧行为**（这个修复**还没进任何已发布版本**）⇒ 下一个版本才带上。
- ⚠ **「从来没扫过曲库、也没进过「有声」页」的用户仍然会查词**（判据为空 ⇒ 守卫无从判断）
  ⇒ 如实说明，不假装「已经全解决」。
- ⚠ `D:\Sanlos Music.bak-v0.3.0`（v0.3.0 备份）与 `D:\tmp\SanlosMusic-Setup-0.4.0.exe`
  **仍在**，删不删**等用户拍板**。

## 九十一、T113：发版 **v0.4.1**（含 T112 修复）—— CI 出包 ＋ 装机 ＋ 真机复验（2026-11-19）

### 一、这一版装了什么（**就一个修复**）

| 批次 | 内容 | 用户看得见的变化 |
|---|---|---|
| **T112** | 桌面歌词（经典悬浮窗 ＋ 灵动歌词岛）**取词之前**先判「这首是不是有声读物」⇒ 是就**一次请求都不发**、推一份**空行** ⇒ 主进程按 T106 的规则把窗口收起来 | 有声读物的桌面歌词**不再显示别的歌的词**（修复前《牧神记》各集被匹配到 **161 / 122 / 132 / 235 / 108 / 348 行**）⇒ **桌面歌词与词岛都不出现** |

- 版本号：**0.4.0 → 0.4.1**（**补丁版**；`v0.4.0..HEAD` 之间**只有 T112 一处代码改动**），
  **只落在一处**：`package.json` 的 `version`（资产名与 `latest.json` 由 CI 从它推导）。
- **产物仍然没有代码签名**（SignPath Foundation 的申请**已被拒**：可见度不足）
  ⇒ 替代信任锚 = **GitHub 构建来源证明**（attestation / SLSA provenance）。

### 二、为什么**产物只能由 CI 构建**（本机**不**打包）

SignPath 以「**可信构建**」为前提：只签 **CI 从本仓库构建出的**产物
⇒ 本机手工打包的包**签不了**，attestation 也**认不了**。
⇒ 发版链路固定为：**本机改版本号 → 推分支 → 打 tag → 推 tag → 网页 dispatch `release.yml` → CI 出包并建 Release**。

⚠️ **本机没有 `gh` CLI，也没有 GitHub token** ⇒ **dispatch 这一步走内置浏览器**
（GitHub 网页上的「Run workflow」，带的是用户已登录的会话）。
⚠️ **`github.com` 网页端链路会复发**（DNS 指到不可达 IP ⇒ 连不通），
而 **SSH 与 `api.github.com` 始终正常**
⇒ **别因为网页打不开就以为没权限**；轮询与验收**一律走 `api.github.com`**。

### 三、发布链路（本轮实测）

| 步骤 | 结果 |
|---|---|
| 版本号回填（`package.json` **只 1 行** ＋ changelog ＋ README **12 处**） | ✅ `git diff --numstat package.json` = `1 1`；`package-lock.json` **未动**；回填脚本**连跑 3 次 sha256 一致** |
| 发布前全量验证 | ✅ `tsc --noEmit` **0 error**；Vitest **145 文件 / 2997 条全绿**（既有 **2989** 条**一条不删**）；Playwright **72 条全绿**（既有 **68** 条**一条不删**）；`npm run build` exit 0；字节体检 ＋ 控制字符扫描 **bad=0** |
| 推分支 ＋ 打 tag ＋ 推 tag | ✅ 分支 `feature/fnmusic-desktop` 与注解 tag `v0.4.1` 都指向 **11822c6**（远端 / 本地一致） |
| 网页 dispatch | ✅ `workflow_dispatch`（分支 `feature/fnmusic-desktop`、`tag=v0.4.1`、**`pack_only=false`**、**`sign=false`**）⇒ run **44479393534**，结论 **success** |
| CI 出包 | ✅ `checkout(v0.4.1)` → `npm ci` → typecheck → test → build → pack → **断言产物确实没签名**（`--expect none`）→ 写 `latest.json` → **改名归一** → **attestation** → 拼正文（**sha256 表**）→ `gh release create` |

### 四、Release 验收（`api.github.com`，免 token）

| 项 | 实测 |
|---|---|
| Release | **https://github.com/pure2199/sanlos-music/releases/tag/v0.4.1**（是仓库的 **latest** ⇒ 自动更新拿得到） |
| 资产 | **恰好 3 个**：`SanlosMusic-Setup-0.4.1.exe`（**86 138 490** 字节）、`SanlosMusic-Portable-0.4.1.exe`（**79 045 220** 字节）、`latest.json` |
| `latest.json` | `version` = **0.4.1**；`files[0]` 指向 Setup 包，`sha512` 是 **128 位 hex**，`size` 与资产实际字节数**一致** |
| 校验值 | Setup 包 sha256 = `4c9da39b7d12873e1867834fc0ac6e5482dfd231a521cf7e5fe731aaf325b03b` ⇒ **与 Release 正文的那张表逐字一致**，且与资产 API 的 `digest` 一致 |
| 正文 | 末尾有 **sha256 表** ＋ attestation 验法 ＋ 如实写明「**本版没有代码签名**」 |

### 五、装机 ＋ 真机复验（**已发布的二进制**）

⚠️ **口径**：这一轮跑的是**已安装的 v0.4.1**（Release 产物）
⇒ 与第九十节（T112 的**源码构建**开发实例）**是两个口径**：
第九十节证明「这个修复在真账号 / 真 NAS 上成立」，**本节证明「v0.4.1 里已经修好了」**。

- **隔离 userData**：只复制 `session.bin`（DPAPI 会话）＋ `Local State`
  ⇒ 真实账号 ＋ 真 NAS，**不碰**用户真实偏好 / 下载目录；
- **有声判定走产品自己的入口**：「有声」页**秒搜**《牧神记》⇒ 用户指认它（**不往 store 里硬塞状态**）；
- 偏好：桌面歌词**开着**、形态 = **经典悬浮窗**、全局源 = **酷我**（与用户真实偏好同源）。

| 项 | 期望 | 实测 |
|---|---|---|
| 安装 | 版本 = **0.4.1** | `app.asar` = **0.4.1**；注册表卸载项 = **0.4.1**；旧 v0.4.0 曾改名留在 `D:\Sanlos Music.bak-v0.4.0`（**可一键回退**）⇒ 后按用户拍板**移入回收站**（可恢复），已装的 v0.4.1 **完好无损** |
| **对照组**：普通歌《茨厂街（粤语谐剧·黄庆全 陈自成 吴金英）》 | 有词 ⇒ 窗口**可见** | **262 行**（首行「哎呀，行到我对脚都唔知几攰。」）⇒ **可见** ✅ |
| **主角**：《牧神记》第 1 集 | 推**空行** ⇒ 窗口**不可见** | **0 行** ⇒ **不可见** ✅ |
| 反向核对：窗口**没被干掉**（只是隐藏） | 仍在 | **仍在** ✅ |

⇒ **7/7 断言全过**（探针 `release/verify/t113-06-realmachine-verify.mjs`，结果 JSON 同目录）。

### 六、这一轮踩的坑（跨项目可复用）

1. ⚠️ **`sign` 默认是 `true`** ⇒ 不显式取消勾选就**必然**失败在「Check SignPath configuration」
   （SignPath 已被拒 ⇒ 5 个 secret / variable 一个都没配）⇒ 发版必须**手动取消** `sign` 与 `pack_only`。
2. ⚠️ **GitHub 会把 Release 资产名里的空格换成点** ⇒ 带空格的下载 URL **直接 404**
   ⇒ 规范名一律**去空白**（`SanlosMusic-Setup-0.4.1.exe`）。
3. ⚠️ **校验值不能写死**：NSIS 安装器内嵌构建时间戳 ⇒ **两次构建的字节必然不同**
   ⇒ sha256 由 CI 在正文末尾**追加**，本机脚本从**正文解析**再跟**实际下载字节**比对。
4. ⚠️ **「网页上两处自洽」不等于「资产是对的」** ⇒ 必须**下载一遍**、逐字比 sha256。
5. ⚠️ **别杀用户自己开的已装应用**：装之前先查进程，若在跑就**停下来报错**（覆盖运行中的安装目录 ⇒ 装出来是半成品）。
6. ⚠️ **`app.close()` 会挂住**（应用默认拦截窗口 `close`）⇒ 探针退出要用 `app.exit(0)`。

## 九十二、T114：默认分支改名 —— `feature/fnmusic-desktop` → **`sanlos-music`**（2026-11-19）

### 一、起因（用户一句话点出来的）

用户在 GitHub Actions 页看到「**Release #18** · Manually run by pure2199 · **feature/fnmusic-desktop**」
⇒ 问「**为什么不改成我们的项目名呢**，为什么不用现在的软件名？」

⇒ 查证后确认：那确实是**产品改名前的遗留**。

### 二、事实基线（**实测**，不是推测）

| 项 | 实测 |
|---|---|
| 分支的来历 | 建于**软件还叫 "FN Music"** 的时候；T49/T50 改名成 "Sanlos Music" 时改的是**产品名 / 显示名 / userData 目录**，**分支名没跟着改** |
| 它是**默认分支** | `api.github.com` ⇒ `default_branch = feature/fnmusic-desktop` ⇒ GitHub 首页 / Actions / Release 页面**全都顶着旧代号** |
| `master` | `c640b25`；`git merge-base --is-ancestor` ⇒ **是祖先**；落后 **0** 个提交（已并入 **362** 个）⇒ 也是残留 |
| CI **没有硬编码**分支名 | `.github/workflows/ci.yml:5` ⇒ `branches: ['**']`；`release.yml` 里那两处 `pure2199/sanlos-music` 是**仓库 slug**，不是分支 |
| tag 与分支无关 | `v0.4.0` / `v0.4.1` 指向 **commit** ⇒ 分支改名**不影响**它们 |

### 三、用户拍板

| 决定 | 值 |
|---|---|
| 新分支名 | **`sanlos-music`**（用产品名；去掉误导的 `feature/` 前缀 —— 它是默认分支，不是特性分支） |
| 旧 `master` | **一并删掉**（已 100% 并入，删了不影响任何提交历史） |
| 执行范围 | **整套做**：推新分支 ＋ 网页切默认分支 ＋ 删旧分支 |

### 四、执行过程（**实际怎么做的**）

1. **规格先行**（`41608ef` 之前的那一版）⇒ `docs/superpowers/specs/2026-11-19-sanlos-music-branch-rename.md`；
2. 本地 `git branch -m` ⇒ 推同名分支 ⇒ ⚠ **重名会挡住 GitHub 的改名** ⇒ 先把那份副本删掉；
3. **网页改名**：Settings → **General** → 「Default branch」→ 铅笔 → 「Rename this branch」
   ⇒ 填新名 ⇒ ⚠ **按钮默认禁用，要让输入框失焦才解禁** ⇒ 「Rename branch」
   ⇒ GitHub **原生改名**（默认分支身份、内部引用一起搬）⇒ 旧名**直接消失**；
4. 删远端 `master` ＋ 本地 `master`；
5. 本地修上游：`git branch --set-upstream-to=origin/sanlos-music` ＋ `git remote set-head origin -a`
   （⚠ 不修的话，下次 push 会把提交推回已删的旧分支，**GitHub 会自动重建它** ⇒ 改名白做）。

### 五、复验结果（**改完之后**）

| 项 | 实测 |
|---|---|
| 远端分支 | **只剩 `sanlos-music`** 一条；旧名与 `master` **都没了** |
| 默认分支 | API `default_branch` = **`sanlos-music`** |
| 提交一条不少 | 分支 tip = **`1d5484f`**（与改名前**同一个 commit**）；提交数 = **365** |
| tag 没被挪动 | `v0.4.1` 仍解析到 **`11822c6a14de061f391613f3e032a4273b00b993`** |
| CI 照常 | 改名动作**自动**触发了新分支上的 CI（run **44482556919**，分支 `sanlos-music`）⇒ **success** |
| 本地一致 | 当前分支 = `sanlos-music`、上游 = `origin/sanlos-music`、`origin/HEAD` 已指新分支、旧分支与 `master` **本地也没了** |

⇒ 探针 `release/verify/t114-01-verify.mjs`（结果 JSON 同目录）⇒ **BRANCH_RENAME_OK**。

### 六、这一轮踩的坑（跨项目可复用）

1. ⚠ **GitHub 新版设置 UI 把「默认分支」挪到了 Settings → General**
   （**不是** Branches 页 —— 那一页现在只有「分支保护规则」）⇒ 找错页会以为功能没了。
2. ⚠ **改名对话框的「Rename branch」按钮默认是禁用的** ⇒ 填完名字**必须让输入框失焦**（按 Tab）
   ⇒ 只 `fill` 不失焦 ⇒ 按钮一直 `disabled` ⇒ 看着像「GitHub 不让改」。
3. ⚠ **目标名已存在会挡住改名** ⇒ 先删掉同名分支（或改走「切换默认分支」那条路）。
4. ⚠ **本地分支名不同步 = 改名白做**：本地还叫旧名 ⇒ 下次 push 会把提交推回已删的旧分支，
   **GitHub 会自动把它重建** ⇒ 必须 `git branch -m`。
5. ⚠ **本地 `origin/HEAD` 会悬空**（还指着已删的旧分支）⇒ `git remote set-head origin -a` 修。
6. ⚠ **改名会连带触发/取消 CI run**（同名 commit 的旧 run 被 cancel、新的被触发）⇒ **别把 cancelled 当失败**。

### 七、**没做**（划清边界）

- ⚠ **没改** `package.json` 的 `"name": "fnmusic-desktop"`（包标识 ＋ exe 元数据里的公司名）⇒ 那要**单独一轮**；
- ⚠ **没动** `LEGACY_USER_DATA_DIR_NAME = 'fnmusic-desktop'` ⇒ 它是**老用户数据目录的迁移源**，
  删了老用户升级会**丢登录态与偏好**；
- ⚠ **没改**几百处 CSS 类名（`fnm-*`）、旧规格文件名；
- ⚠ **历史段一字未动**（含 `docs/releases/v0.2.0.md` 里指向旧分支的 blob 链接、
  `docs/build-verification.md` 里 2026-11-04 那次验证的分支行）⇒ 历史是**当时的记录**。

## 九十三、T115：里层命名全量改名 —— `fnm` / `fnmusic` ⇒ **`sanlos`**（2026-11-19）

### 一、起因

T114 把仓库默认分支改成了 `sanlos-music`，**里层**却还全是旧代号：
包名 `fnmusic-desktop`、appId `com.fnmusic.desktop`、自定义协议 `fnm://` / `fnml://`、
CSS 类名前缀 `fnm-`、preload 桥 `window.fn` / `window.fnmusic` / `window.fnPlayer`、
环境变量前缀 `FNM_`、工具脚本 `tools/fn-*.mjs`、老规格文件名 `*fnmusic*`。

### 二、清点（**实测**，不是推测）

`release/verify/t115-01-scan-legacy-names.mjs` ⇒ 入库目录 **519** 个文件、**3373** 处命中：
`fnm-` **2200**、`fnm` 独立词 **331**、`fn-` **302**、`fnmusic` **189**、
`fnPlayer` **139**、`FN-Music` **126**、`FNM_` **86**、camelCase 变体 **0**。

### 三、⚠️ 为什么**不能**全局替换（这一条最要紧）

同一个词在仓库里指的是**四样东西**，其中**两样一个字都不能动**：

| 指代 | 例子 | 处理 |
|---|---|---|
| A. 本客户端的内部标识 | `fnm://`、`fnm-app__nav`、`window.fnPlayer` | ✅ **全改** |
| B. **飞牛 NAS 侧** | `fnos.net` / `fnId` / 连接接口返回的 `fn: [...]` / `FN_USER` / `FN_PASS` / `FN_ID` | ❌ **一个字都不动** |
| C. **历史事实** | `FN-Music-Setup-0.2.4.exe` / 旧 userData 目录名 `fnmusic-desktop` / 历史文档里的实测记录 | ❌ **不动** |
| D. **第三方项目名** | `XDORG-N1/FnMusic`（Apache-2.0） | ❌ **不动** |

⚠️ **B 类里最阴险的一个**：`fn` 既是本客户端的**认证桥全局名**（`window.fn`），
**也是**飞牛连接接口返回的**数组字段名**（`fn: ['xxx.fnos.net:443']`），
**还是** Vitest 的 `vi.fn()`（**672** 处）⇒ 任何全局规则都必然误伤 ⇒ 只能**逐文件点名**。

### 四、用户拍板

**「全改」**｜**「以前版本不用理」**｜**「后面版本能更新就行」**（现在没有用户，都是自己在用）
⇒ 四问全选推荐项：CSS 前缀 **`sanlos-`**｜appId **`com.sanlos.music`**｜协议一起改成 **`sanlos://`**｜**14 个**老规格/计划文件名一起改。

### 五、执行（**规则驱动**，不手改）

`release/verify/t115-03-apply-rename.mjs`：有序规则表 ＋ 保护机制（哨兵）＋ 文件作用域规则
＋ **dry-run 逐行 diff**（本次逐条判读了 274 个文件的改动）＋ 幂等复跑。

- 改写 **274** 个文件的内容（**2816** 增 / **2816** 删 ⇒ 完全对称 ⇒ 纯标识符替换）；
- `git mv` 改名 **51** 个文件（`tools/fn-*` **37** ＋ `docs/superpowers/**fnmusic*` **14**）。

### 六、协议改名的**六处联动**（漏一处就是「运行时才炸」）

| 联动点 | 漏了会怎样 |
|---|---|
| `electron/schemes.ts` 的 `registerAppSchemes()`（**两个 scheme 合并成一次**） | ⚠ **静默覆盖** ⇒ 渲染层 `fetch` 抛 `TypeError: Failed to fetch` ⇒ **整个曲库拉不出来**，而**单测全绿** |
| 三个 HTML 的 CSP | Chromium 的 URL 安全检查**直接拒绝** ⇒ 封面空白 / 本地播不了 |
| `src/api/client.ts` 的 `BASE` | 全部 API 请求打不出去 |
| `electron/proxy.ts` 的 `SCHEME` ＋ `protocol.handle` | 全部 404 |
| `shared/localMedia.ts` 的 `LOCAL_MEDIA_SCHEME` | 本地曲目播不了 |
| 常量名 `FNM_SCHEME` / `FNML_SCHEME` | 编译不过 |

⇒ `fnml://` 单独改成 **`sanlos-media://`**（不是 `sanlosl://`）：名字自解释，
**注册结构一字不动**（仍是「一次注册两个」）⇒ 不动 T13 那条「只能调用一次」的铁律。

### 七、⚠️ `localStorage` 的三个用户数据键：**旧键回落**（不许静默丢数据）

`fnmusic-local-history`（本机播放记录）/ `fnmusic-resume`（续播位置）/
`fnmusic-lyric-overrides`（T107 按歌指定歌词源）⇒ **新键没有才回落读旧键**（旧键只读、不删）。

⚠️ **「清空」必须两个键都删**：只删新键的话，新键一消失、下次读就**回落到旧键**
⇒ 用户点了「清空」，记录却**复活**了 ⇒ 已在 `src/player/resumeBridge.ts` 补上，并钉进测试。

旧键字面量的**唯一居所** = `shared/legacyStorageKeys.ts`（改名脚本**跳过**它）。

### 八、⚠️ `appId` 改动是一次性**断点**（用户已确认接受）

`com.fnmusic.desktop` ⇒ `com.sanlos.music` ⇒ NSIS 的**卸载项 GUID / 注册表项**全变
⇒ **v0.4.1 ⇒ 新版本不是「原地升级」**（旧版会残留，需手工卸载）。

⚠️ **但 userData 目录不受影响**：目录名 = `productName` = `Sanlos Music`，
**与 `name` / `appId` 无关** ⇒ **登录态（`session.bin`）、偏好、本机记录都不丢**。
⇒ **从本版起 `appId` 固定 ⇒ 之后版本之间升级正常**（这正是用户要的「后面版本能更新就行」）。

### 九、这一轮踩的坑（**跨项目可复用**）

1. ⚠ **「扩展名白名单」会漏文件**：第一版按 `/\.(ts|tsx|css|…)$/` 过滤
   ⇒ **漏了 `.mts`**（`tools/sanlos-check-signature.d.mts` 的注释还指着旧文件名）
   ⇒ 改成「按**二进制**排除」（`.png/.exe/.mp3/…`），**新扩展名自动被覆盖**。
2. ⚠ **分段拼出来的路径匹配不到**：`path.join(root, 'tools', 'fn-check-signature.mjs')`
   ⇒ `tools/fn-` 规则**匹配不到**（中间隔着 `', '`）⇒ `scripts/pack.cjs` 会**找不到签名断言脚本**
   ⇒ **打包直接失败**（不是「检查漏了」，是「跑不起来」）⇒ 必须单列一条「文件名字面量」规则。
3. ⚠ **`fn` 这个 token 不能全局动**（见第三节）⇒ 认证桥的改名只能**逐文件点名**
   （`electron/preload.ts` / `src/lib/bridge.ts` / `src/vite-env.d.ts` / 两个测试文件）。
4. ⚠ **历史文档不能全量替换**：`docs/superpowers/specs/2026-11-02-…-design.md` 里写着
   「基址常量 `const BASE = 'fnm://srv'`」——那是**当天真的这么写的** ⇒ 改它就是**篡改历史**
   ⇒ 历史文档**只改文件名**（外加**指针**：指向被改名文件的路径要跟着走，否则是**死链**）。
5. ⚠ **T115 自己的规格要跳过**：它是**唯一**一份同时写着「旧名」和「新名」的文档
   ⇒ 跑规则会把映射表**改没了**（自相矛盾）。
6. ⚠ **工具脚本的 userData 路径本来是错的**：`tools/sanlos-ui-repro.mjs` 指着旧目录名
   `fnmusic-desktop` ⇒ 复制的是一个**不存在的目录** ⇒ 探针起不来
   ⇒ 改成**从 `package.json` 读 `productName`**（跟着软件名走，以后改名也不会再错）。

### 十、复验结果

| 项 | 实测 |
|---|---|
| 验收探针 | `release/verify/t115-05-verify-rename.mjs` ⇒ **19 条全过** ⇒ **RENAME_OK** |
| 类型检查 | `tsc --noEmit` ⇒ **0 错** |
| 单元测试 | **146** 个文件 / **3024** 条 ⇒ **全绿**（改名前 145 / 2997 ⇒ 既有 **2997 条一条不删**，新增 27 条契约钉子） |
| E2E | Playwright **全绿**（既有 72 条一条不删） |
| 构建 | `npm run build` ⇒ **0** |
| 字节体检 ＋ 控制字符 | **bad=0** |
| 全量 vitest **首跑** | ⚠ 撞上**既有**的 `test/mock-server.test.ts`「bad port」偶发飘红（并发端口竞态，**与本轮改动无关**：该文件**单独跑 3 次全绿**，本轮只改了 mock 的 `track/stream` 路由）⇒ 重跑全量即 **155 文件 / 3 081 条全绿** |
| 幂等 | 改名脚本连跑两次 ⇒ 第二次 **0 处改动** |

⇒ 规格 `docs/superpowers/specs/2026-11-19-sanlos-music-inner-rename-design.md`（§十三 回填）。

### 十一、明确**没做什么**

- ❌ **没改** `LEGACY_USER_DATA_DIR_NAME`（`'fnmusic-desktop'`）—— 它是**迁移源**，删了老用户升级会丢登录态；
- ❌ **没改** `FN-Music-*`（历史产物名 ＋ 归一化测试的输入）；
- ❌ **没改** 飞牛侧的任何名字（`fnos` / `fnId` / `FN_USER` / `FN_PASS` / `FN_ID` / `FN_CON_*`）；
- ❌ **没改** 历史文档的**正文**（只改了文件名 ＋ 指向被改名文件的指针）；
- ❌ **没改** `release/verify/fnm-*`（**gitignore** 的历史一次性脚本 ⇒ 改了会让台账与历史文档的引用全成死链）；
- ❌ **没动** `docs/releases/*.md` 与历史 changelog 段。

## 九十四、T116：发版 **v0.4.2** ＋ 真机复验（2026-11-19）

### 一、这一版装了什么

T115（里层改名）＋ T114（默认分支改名）的**对外产物**。功能零变化，只改对外标识：
`package.json` 的 `version` **1 行** ⇒ `0.4.2`；`package-lock.json` root version **两处**
（顺手把自 v0.2.4 起就没同步的 **0.2.4** 对齐成 0.4.2 —— 实证 v0.4.1 在 lock=0.2.4 时 CI 照样 success）。

### 二、发版链路（**CI 自动**，本机不打包）

| 步 | 实测 |
|---|---|
| 改 5 个文件 ＋ 规格 | commit `3f570f7`（规格）→ `e6cd000`（实现） |
| 推分支 ＋ 打**注解** tag | `v0.4.2` → `e6cd000`（说明「里层命名全量改名（T115）＋ 默认分支改名（T114）」） |
| 网页 dispatch | run **44492657546** = **success**（sha `e6cd000`） |
| Release 验收 | id **451100772**、published **2026-11-19T09:07:48Z**、资产**恰好 3 个** |

⚠ **三处 sha256 逐字一致**：Release 正文表 ≡ 资产 API `digest` ≡ **本机实算**
⇒ Setup `8c97ac42…f01a7841`、Portable `611b5b47…db6f7ebf`。

### 三、装机（**踩了两个坑**）

| 坑 | 现象 | 对策 |
|---|---|---|
| ⚠ **NSIS 卸载器的父进程先退、子进程继续删目录** | 「卸完立刻装」⇒ **刚装进去的文件被卸载器的子进程删光**（只剩悬空注册表条目 ＋ 悬空快捷方式） | 卸载后**等卸载器真正结束**再装；本轮手工清理了悬空条目 ＋ 悬空 `.lnk` ＋ 空目录后重装 |
| ⚠ **安装作用域变了** | 旧 v0.4.1 是**按机器**（HKLM `/allusers`），新 v0.4.2 成了**按用户**（HKCU `/currentuser`） | 因为**先卸载了旧版** ⇒ 安装器没有旧版可沿用作用域。功能等价、卸载项干净只有一条；要回按机器需 `/allusers`（触发 UAC，非交互环境不可用） |

⚠ **`/D=` 必须是最后一个参数且不含引号**（哪怕路径里有空格）⇒ 用 Node
`spawn(exe, ['/S', '/D=D:\\…'], { windowsVerbatimArguments: true })` 自己拼命令行。

### 四、真机复验 6 项（**已发布的二进制** ＋ 真实 NAS ＋ 真实账号）

口径：**跑的是 GitHub Release 的产物**（CI 构建、已装到 `D:\Sanlos Music`），**不是**源码构建的开发实例。
Phase A = **隔离 userData**（只复制 `session.bin` ＋ `Local State`）⇒ 真实账号 ＋ 真 NAS，**不碰**用户偏好/历史；
Phase B = **真实 userData**、**只看不播**。

| # | 项 | 结果 | 实测 |
|---|---|---|---|
| ① | 主窗口能起来 | ✅ | exe `FileVersion` 0.4.2；`app.asar` 839 536 B |
| ② | **曲库拉得出来** | ✅ | 连上真实 NAS（导航 13 项）；曲库首屏 15 首 |
| ③ | **桌面歌词仍成立** | ✅ | 对照组「庙堂之外 (五四特别版)」**67 行** ＋ 窗口可见；有声那集「0001」**0 行** ＋ 窗口不可见 ＋ 窗口没被干掉 |
| ④ | 本地播放 `sanlos-media://` 真起播 | ✅ | `src = sanlos-media://local/track/local%3A…`；`currentTime` **0.005 ⇒ 0.310 s**；`paused = false` |
| ⑤ | **「检查更新」真拉到清单** | ✅ | `{"status":"up-to-date","current":"0.4.2"}` |
| ⑥ | **登录态还在** | ✅ | 真实 userData 自动登录；`session.bin` 286 B 未被动 |

### 五、⚠ 复验查出的一条 T115 遗留缺陷（**已记为 T117**）

`src/state/audiobookStore.ts` 的 `STORAGE_KEY`：`fnmusic-audiobook-state` ⇒ `sanlos-audiobook-state`
—— **没有**进 `shared/legacyStorageKeys.ts` 的旧键回落名单（那里只有**三个**键）。

⇒ **本机实测**：真实 userData 里旧键**在**、新键**不在** ⇒ **v0.4.2 读不到**用户的有声扫描结果：

- **自动判定失效**（`hits` 为空）⇒ `isAudiobook()` 对自动判定的专辑返回 `false`
  ⇒ **T112 修的「有声读物被误配桌面歌词」又回来了**（直到「有声」页重扫一次）；
- 「有声」页的**手工改判**（`这是有声读物` / `这不是有声`）**丢**；
- 「有声」页下次进入**自动全库扫描**（实测 87 页 / 6–47 分钟）⇒ 打 NAS 流量。

⇒ **T116 不改代码**（本轮只发版）⇒ 记为 **T117**：补旧键回落 ＋ 钉测试 ＋ 发 v0.4.3。

### 六、这一轮踩的坑（**跨项目可复用**）

1. ⚠ **探针的「异常被吞」＝假绿**：最终判定读 `a.checks ?? []`，
   而 Phase A 抛异常时 `a.checks` 是 `undefined` ⇒ 判定「一条没过都没有」⇒ 照样打印 `REALMACHINE_OK`。
   ⇒ **异常必须单独计入失败**（`ok !== true` 同样算失败）。
2. ⚠ **页面切换会**销毁**目标容器**：第一轮把「本地播放」放在「桌面歌词对照组」前面
   ⇒ 它切到「本地」页 ⇒「歌曲列表」那个 listbox **不存在了** ⇒ `dblclick` 30 秒超时。
   ⇒ **会切页的步骤必须放最后**（或先切回去）。
3. ⚠ **`<audio>` 元素**从不进 DOM**：播放引擎是 `document.createElement('audio')`（**不 append**）
   ⇒ `document.querySelector('audio')` **永远抓不到** ⇒ 第二轮实测 `no-audio-element-after-20s`。
   ⇒ 只能在**造元素 / 改 `src` 的那一刻**捕获（打 `document.createElement` ＋
   `HTMLMediaElement.prototype.src` 的 setter）⇒ 捕获器必须**装在第一次播放之前**
   （引擎懒建元素，整个会话只建一次，换歌只改 `src`）。
4. ⚠ **进「有声」页会自动全库扫描**（`scannedAt` 为空 ⇒ 自动开扫，实测 87 页 / 6–47 分钟）
   ⇒ 探针要么**先播种** `sanlos-audiobook-state`（把 `scannedAt` 置位），要么**不去那个页**。
   ⇒ 顺带发现一个**既有竞态**：扫描每页落盘用的是**启动时的 `overrides` 快照**
   ⇒ 秒搜写入的手工改判**可能被扫描覆盖**。
5. ⚠ **GitHub `workflow_dispatch` 的布尔输入按 YAML 默认值渲染** ⇒ `sign` / `pack_only` 默认**勾上**
   ⇒ 不显式取消就提交 ⇒ **必然**失败在对应检查步骤 ⇒ 复核用 `input[type="checkbox"]:checked` 查无此元素。

### 七、复验结果

| 项 | 实测 |
|---|---|
| 发布前 | tsc **0 错**；Vitest **146 文件 / 3 024 条全绿**；Playwright **72 passed**；build exit **0**；字节体检 ＋ 控制字符 **bad=0** |
| CI | run **44492657546** = **success** |
| Release | 资产 **3 个**；**三处 sha256 逐字一致**；`latest.json` version=0.4.2、sha512 **128 位** |
| 真机 | **6 项全过**（Phase A **14/14** ＋ Phase B **2/3**）＋ **查出 1 条 T115 遗留缺陷**（⇒ T117） |

⇒ 规格 `docs/superpowers/specs/2026-11-19-sanlos-music-v0.4.2-release.md`（§八 / §九 已回填）。

### 八、遗留 / 待办

- ⏳ **T117**：补 `sanlos-audiobook-state` 的**旧键回落** ＋ 钉测试 ＋ 发 **v0.4.3**；
- ⏳ Release `v0.4.2` 的**线上正文**还是发版时那一版（「⏳ 尚未复验」）⇒ 待同步本节结论；
- ⏳ GitHub 账号 **2FA 未启用**（已知安全缺口，待用户决定）；
- ⏳ v0.4.2 的卸载项是**按用户**（HKCU）⇒ 要回按机器需 `/allusers`（触发 UAC）。

## 九十五、T117：补第四个旧键的回落 ＋ 发版 **v0.4.3** ＋ 真机复验（2026-11-19）

### 一、这一版装了什么

一个**修复**、零功能变化：`src/state/audiobookStore.ts` 的 `localStorageAudiobookPort.load()`
改成「**新键没有才回落读旧键**」⇒ 旧键 `fnmusic-audiobook-state` 里那份「有声读物扫描结果」读得回来了。

配套：旧键字面量集中到 `shared/legacyStorageKeys.ts`（**新增** `LEGACY_AUDIOBOOK_STATE_KEY`）
⇒ 四个旧键字面量**只有一个居所**。
`STATE_VERSION` **不升**（还是 3）、`save()` **一字不改**（只写新键）、旧键**只读不删**
⇒ **一次性迁移**、**幂等**、**零删除**。

### 二、发版链路（**CI 自动**，本机不打包）

| 步 | 实测 |
|---|---|
| commit 1（规格） | `b6087c9` |
| commit 2（实现 ＋ 发版文件） | `e3b3954`（**8 个文件**） |
| 推分支 ＋ 打**注解** tag | `v0.4.3` → `e3b3954`（tagger `Mavis <mavis@local>`）已推 |
| 网页 dispatch | run **#20** id **44522673902** = **success**（335 秒） |
| Release 验收 | id **451310330**、published **2026-11-19T12:23:57Z**、非草稿非预发布、资产**恰好 3 个** |

⚠ **三处 sha256 逐字一致**（Release 正文表 ≡ 资产 API `digest` ≡ **本机实算**）：

| 资产 | 大小 | sha256 |
|---|---|---|
| `SanlosMusic-Setup-0.4.3.exe` | 86 138 684 B | `a740c0baccc15bab3dbd0e02cdd2040eee244fc9d9f0029a076afff67fbb5544` |
| `SanlosMusic-Portable-0.4.3.exe` | 79 038 722 B | `f8413634af86bc6e18389a078343130119f63d848b0306d60133e5eada59b52a` |
| `latest.json` | 472 B | `b4d1387cac20cf7a22ce02e5ab3e3422d522999f27f5b0f7a23d1a424d217b1c` |

⇒ `latest.json` 的 `version` = **0.4.3**、sha512 **128 位**、size ≡ API size。

### 三、装机（**原地升级**：appId 没变 ⇒ **不卸载**）

| 项 | 实测 |
|---|---|
| exe `FileVersion` | `0.4.3` / `0.4.3.0` / `Sanlos Music` |
| `app.asar` | **839 627 B**（v0.4.2 是 839 536 B） |
| 注册表卸载项 | 「**Sanlos Music 0.4.3**」**且无残留 0.4.2 条目** ⇒ 真·原地升级 |
| 卸载项作用域 | **HKCU（按用户）**（沿用 v0.4.2 的作用域） |
| 用户数据 | `session.bin`（286 B）**逐字未变**；`Local Storage` **11 个文件未变**；`prefs.json` 未变 |

⚠ 装机脚本**检测到应用在跑就停下报错**（不替用户杀进程）。

### 四、真机复验（**已发布的二进制** ＋ 真实 NAS ＋ 真实账号）

口径：**跑的是 GitHub Release 的产物**（已装到 `D:\Sanlos Music`），**不是**源码构建的开发实例。
**本机** Windows 10.0.26300 x64 / Node v26.13.0。
Phase A = **隔离 userData**（复制**真实 `Local Storage`** ⇒ 带旧键）⇒ 真实账号 ＋ 真 NAS；
Phase B = **真实 userData**、**只看不播**。

**Phase A（实验组，v0.4.3）—— 12 条判据全过**

| # | 判据 | 实测 |
|---|---|---|
| ① | 版本 = 0.4.3 | ✅ exe `FileVersion` 0.4.3 |
| ② | 连上真实 NAS | ✅ 导航 13 项；曲库首屏 **15 首** |
| ③ | 起点：旧键在、新键不在 | ✅ 旧键 5 个、新键 0 个 |
| ④ | ⭐ 状态行「上次扫描：」⇒ `scannedAt` **回落成功**（**没触发**全库扫描） | ✅ 「**上次扫描：2026/11/17 00:45:50 · 目录「有声小说」· 9 部**」 |
| ⑤ | 「有声」页列出作品（`hits` 恢复） | ✅ **卡片 9 张**（三体 / 娱乐春秋 / 盗墓笔记 / 牧神记 / 极品家丁…） |
| ⑥ | 专辑详情页出现「有声」标记 ⇒ **自动判定**恢复（**不经秒搜** ⇒ 无 override 污染） | ✅ 文案「**已按集序排列**」 |
| ⑦ | 有声那一集推的是**空行** | ✅ 「01- 科学边界」**0 行** |
| ⑧ | 有声那一集桌面歌词窗**不可见** | ✅ `windowVisible=false` |
| ⑨ | 有声那一集桌面歌词窗**没被干掉** | ✅ `windowExists=true` |
| ⑩ | 对照组：普通歌**有词** | ✅ 「庙堂之外 (五四特别版)」**67 行** |
| ⑪ | 对照组：桌面歌词窗**可见** | ✅ `windowVisible=true` |
| ⑫ | 旧键**只读**：跑完整轮仍在 | ✅ 旧键仍在、新键仍不在 |

**Phase A（对照组，v0.4.2 缺陷版，同一份隔离 userData）—— 4 条判据全过**

| 判据 | 实测 |
|---|---|
| 状态行显示「**正在扫描**」⇒ 缺陷版**读不到**旧键 ⇒ 触发全库扫描（**判据有鉴别力**） | ✅ 「**正在扫描…第 0 页 / 共 0 页（已扫 0 首）**」 |
| 「有声」页**没有**作品（`hits` 没恢复） | ✅ **卡片 0 张** |

⇒ 两组**唯一**差别是版本号 ⇒ ④ 的判据**有鉴别力**（不是「这条路根本没通」）。

**Phase B（真实 userData）—— 2 条全过**：自动登录（导航 13 项出现）＋ `fnmusic-audiobook-state` **仍在**。

#### 这一轮的旧键落盘（实测原样）

`version` = **3**、`scannedAt` = **1794847550212**（= 2026/11/17 00:45:50）、
关键字「**有声小说**」、`scannedCount` = **173 671**、候选 **10**、手工改判 **0**；
候选样本：牧神记 / 极品家丁 / 娱乐春秋 / 盗墓笔记 / 赶尸客栈。

### 五、这一轮踩的坑（**跨项目可复用**）

1. ⚠ **「没发生」类判据必须有对照组**：只测 v0.4.3「恢复了」⇒ **证明不了回落是它干的**
   （也可能是「这版根本不读」）。⇒ 必须再跑一遍**缺陷版**，看到「正在扫描…＋卡片 0」才算有鉴别力。
2. ⚠ **必须绕开会自我实现的路径**：「有声」页的**秒搜结果**会 `setOverride(…, 'audiobook')`
   ⇒ 走那条路，判定会变成「自己写进去的」⇒ **判据失效**。
   ⇒ 改走**列表卡片** `.sanlos-audiobooks__item`（**只下钻、不写 override**）。
3. ⚠ **探针时序**：详情页停在「正在按集序整理…」时**曲目列表还没渲染** ⇒ 那一集没播成
   ⇒ 判据拿到 `undefined` ⇒ 要**等排序完成 ＋ 等 `.sanlos-songlist__row` 就绪**（各 120 s）才取数。
4. ⚠ **体检一刀切判「裸 LF = 坏」⇒ LF 文件永远过不了**：`docs/releases/*.md` 与规格文件的
   **工作副本就是 LF** ⇒ 体检必须**按每个文件自己的约定**给模式（`crlf` / `lf`），否则回填脚本必炸。
5. ⚠ **变异自证脚本要剥 ANSI、锚定 `Tests` 行**：否则 `Test Files 1 failed` 会被误当用例数；
   还要**强制跑满 8 条** ＋ **字节级**还原校验。

### 六、复验结果

| 项 | 实测 |
|---|---|
| 发布前 | tsc **0 错**；Vitest **147 文件 / 3 032 条全绿**（原 146 / 3 024 ＋ 新增 1 文件 8 条；**既有测试一条不删、断言一条不弱化**）；Playwright **72 passed**；build exit **0**；字节体检 ＋ 控制字符 **bad=0** |
| 变异自证 | `MUTATION_OK`：A 删回落⇒**3 红**、B 旧键优先⇒**2 红**、C 升 `STATE_VERSION`⇒**5 红**、D 回落时删旧键⇒**2 红**；还原后 **8/8 全绿** ＋ **字节级**与原文一致 |
| 回填幂等 | 连跑 3 次 **sha256 完全一致**（第 2、3 次 **0 处改动**） |
| CI | run **44522673902** = **success**（335 秒） |
| Release | 资产 **3 个**；**三处 sha256 逐字一致**；`latest.json` version=0.4.3、sha512 **128 位** |
| 真机 | **对照组 4/4 ＋ 实验组 12/12 ＋ Phase B 2/2 全过** |

⇒ 规格 `docs/superpowers/specs/2026-11-19-sanlos-music-v0.4.3-release.md`（§九 / §十 已回填）。

### 七、遗留 / 待办

- ⏳ **「有声」页扫描落盘用启动时的 `overrides` 快照** ⇒ 扫描进行中做的**手工改判有可能被覆盖**
  （**既有问题**，v0.4.2 就有）⇒ **另立编号任务**，本轮明确不做；
- ✅ Release **v0.4.3 的线上正文已同步**（2026-11-19，用户确认后改的）
  ⇒ 第三节已换成实测结论；**逐字验收**：线上 body sha256 ≡ 本地目标文件 sha256
  = `55068397…cb7deacb`（6083 字符）、CI 自动追加的 sha256 表**一字未动**、**三个资产未动**；
- ⏳ Release **v0.4.2 的线上正文**仍是发版时那一版 ⇒ 按用户「以前的版本不用理」**不改**；
- ⏳ GitHub 账号 **2FA 未启用**（已知安全缺口，待用户决定）；
- ⏳ 卸载项落在 **HKCU（按用户）** ⇒ 要回按机器需 `/allusers`（触发 UAC）。

---

## 九十六、T118：「有声」页扫描落盘不再覆盖手工改判（2026-11-19）

> 起因：**第九十五节（T117）§七 遗留的第 ① 条** —— 「有声」页扫描落盘用启动时的
> `overrides` 快照 ⇒ 扫描进行中做的**手工改判有可能被覆盖**（**既有问题**，v0.4.2 就有）
> ⇒ 用户 2026-11-19 拍板立项修复。

### 一、根因（**逐行确认，不是推测**）

`src/state/audiobookStore.ts` 的 `scan()`（行号为**修复前**）：

| 行 | 代码 | 问题 |
|---|---|---|
| `:739` | `const saved = port.load() ?? emptyPersisted()` | 读一次 ⇒ **快照**（此后不再更新） |
| `:794` | `overrides: { ...saved.overrides }`（**每页断点落盘**） | 写回**启动快照** ⇒ 覆盖扫描期间的新改判 |
| `:814` | `overrides: { ...saved.overrides }`（**扫完落盘**） | 同上 ⇒ 再覆盖一次 |
| `:836` | `set({ overrides: persisted.overrides })` | **内存状态也回退** ⇒ 界面上刚点的「这不是有声」**当场消失** |

⇒ 「有声读物」页进页面**自动开扫**（实测 **87 页 / 6–47 分钟**）⇒ 扫描跨过任意一个页边界
（实测几秒～几十秒一次）就把用户刚做的改判冲掉；扫描结束再冲一次。

用户能做改判的三条路径全是「**用户的判断**」：
秒搜点开（`src/pages/AudiobooksPage.tsx:286`）/ 详情页「这不是有声」（`src/pages/DetailPage.tsx:338`）/
详情页「这是有声读物」（`src/pages/DetailPage.tsx:423`）。

⚠ **同文件另外三处都没这个毛病**：`setOverride` / `setCover` / `setAlbumCover` 都是
「**先读最新的**（`p.load()`）再只改自己那个字段」⇒ **只有 `scan()` 违反这条约定**。
一句话机理：**「谁最后写谁赢」的整对象落盘模型下，扫描这一路对 `overrides` 没有写权限，
却仍然在写。**

### 二、修法（**单一根因、单一改动**）

**扫描不再拥有 `overrides` 的写权限** —— 它只写自己的字段（断点 / 进度 / 候选 / 关键字 / 时间戳），
`overrides` 一律取 store 内存里的**活值** `get().overrides`（两处落盘；内存那次 `set` 代码不动）。

| 判据 | 内存活值 `get().overrides` | 再读磁盘 `port.load()?.overrides` |
|---|---|---|
| 是不是**完整且最新** | ✅ 是（`setOverride` 写完盘立刻同步它；`restore()` / 扫描起点也是整份读回） | ⚠ 写盘失败（配额满）时是**旧的** |
| 成本 | 零（已经在内存里） | 每页一次 `JSON.parse`（落盘可达 **500** 部作品） |
| 写盘失败（配额满） | ✅ 顺带把新改判**补写**成功 | ❌ 新改判**丢** |

⚠ **只能整体替换、不能 merge**：`{ ...saved.overrides, ...get().overrides }`
会把**「撤销改判」复活**（启动快照里有 `A`，撤销后活值里没有 ⇒ 合并结果里 `A` 又回来）。

⚠ **明确没动**：`STATE_VERSION`（**不升** ⇒ 旧落盘照读、用户的扫描结果不失效、不用重扫）、
`setOverride` / `setCover` / `setAlbumCover` / `restore`（**一个字不改**，它们本来就是对的）、
`scan()` 起点的 `set({ overrides: { ...saved.overrides } })`（⚠ 改成活值会在**冷启动**时把改判清空）、
页面侧两个文件（**页面没 bug**：改判**写对了**，是被落盘盖掉的）。

### 三、钉子（**8 条**，新增 `test/t118-audiobook-scan-override.test.tsx`）

| # | 钉子 | 抓住谁 |
|---|---|---|
| ① | 扫描中**新增**改判 ⇒ 扫完**落盘**里还在 | `:794` / `:814` |
| ② | 改判成「这不是有声」⇒ 落盘里仍是 `not-audiobook` | 同上 |
| ③ | **撤销**改判 ⇒ 扫完**不被启动快照复活** | merge 写法 |
| ④ | 扫完**内存状态**不回退 | `:836` |
| ⑤ | **对照组**：扫描期间**不改判** ⇒ 启动时的改判原样保留 | 「没把正常路径写坏」 |
| ⑥ | **页面级集成**：扫描**卡住**时秒搜点开 ⇒ 放行后落盘里改判**还在** | 用户真实路径 |
| ⑦ | **扫描进行中**（页边界落盘之后）磁盘里改判**已经在** | `:794`（中途覆盖） |
| ⑧ | **扫描中途出错**（网络断了 ⇒ 没有扫完那次落盘）磁盘里改判**还在** | `:794`（中断即丢） |

⚠ **⑦⑧ 是补上的**：①② 只看「**扫完后的**磁盘」⇒ **查不出页边界的中途覆盖**
（最终落盘会把磁盘救回来）⇒ 必须钉「扫描进行中」与「扫描中断后」两个**时点**。

### 四、变异自证（**MUTATION_OK**）

脚本 `release/verify/t118-01-mutation-check.mjs`（本地、gitignored）。
⚠ 脚本认的是「**红了哪几条**」（不是「有没有红」）⇒ **每个变体必须由对应的那几条抓住**
（一个「粗用例」能同时抓住所有变体 ⇒ 矩阵就白做了）。

| 变体 | 改什么 | 实际变红 | 结论 |
|---|---|---|---|
| **A** | 两处落盘都退回启动快照（＝复原原缺陷） | **①②③④⑥⑦⑧** | ✅ |
| **B** | **只**退「每页断点落盘」（扫完那次仍是活值） | **⑦⑧** | ✅ |
| **C** | 只退「扫完的内存 `set`」（磁盘好、内存被回退） | **④⑥** | ✅ |
| **D** | 改成 merge | **③** | ✅ |

⇒ 还原后 **8/8 绿** ＋ **sha256 字节级一致**
（`047f03474ec4392e35c82bf02d3323210617802a0a36972e175ccfe0d75a7220`，43 741 B ⇒ 工作区未被污染）。

### 五、这一轮踩的坑（**跨项目可复用**）

1. ⚠ **只看「结束时的状态」查不出「中途的覆盖」**：缺陷版里「扫完后的磁盘」也是坏的
   ⇒ ① 会红；但**只退「每页落盘」**时，**最终落盘会把磁盘救回来** ⇒ ① 变绿
   ⇒ 必须另钉「扫描进行中」与「扫描中断后」两个**时点**（⑦⑧）才抓得住。
2. ⚠ **「谁最后写谁赢」的整对象落盘模型**：一个模块如果**只拥有部分字段的写权限**，
   它写整对象时就会**连别人的字段一起覆盖** ⇒ 正确形状是「**先读最新的**再只改自己那个字段」
   ⇒ **同文件内找「写得不一样的那一处」就是根因**（本轮 `scan()` 是唯一一处）。
3. ⚠ **合并不是修复**：把「启动快照」与「活值」**合并**看着更安全 ⇒ 实际会把
   **「撤销改判」复活**（快照里有、活值里已删掉的键会回来）⇒ **只能整体替换**。
4. ⚠ **冷启动陷阱**：修「扫描起点那一处」时**不能**改成活值 —— 冷启动（还没 `restore()`）
   时活值是空 ⇒ 反而把用户的改判清空 ⇒ **起点那一处是「扫描开始那一刻的权威值」**。

### 六、复验结果

| 项 | 实测 |
|---|---|
| 回归 | tsc **0 错**；Vitest **148 文件 / 3 040 条全绿**（原 147 / 3 032 ＋ 新增 1 文件 8 条；**既有测试一条不删、断言一条不弱化**）；Playwright **72 passed**（1.6 分钟）；build exit **0**；字节体检 ＋ 控制字符 **bad=0** |
| 变异自证 | `MUTATION_OK`（A⇒红 ①②③④⑥⑦⑧、B⇒红 ⑦⑧、C⇒红 ④⑥、D⇒红 ③）；还原后 **8/8 全绿** ＋ **sha256 字节级一致** |
| 提交 | `aa9c703` 规格 → `3f81b63` 实现 ＋ 钉子（均已推送 `origin/sanlos-music`） |
| 真机 | ⏳ **未做（待真机项）** —— 扫描要 6–47 分钟 ⇒ 真机上做才有意义 ⇒ 做法见规格 §八.4 |

⇒ 规格 `docs/superpowers/specs/2026-11-19-sanlos-music-t118-audiobook-override-race.md`（§八 已回填）。

### 七、遗留 / 待办

- ⏳ **真机复验**（待真机项）：做法见规格 §八.4，**必须带对照组**（同一台机、同一份数据、
  修复前的版本 ⇒ 判据必须**不成立**）；
- ⏳ **同类的另一个毛病（本轮不动）**：扫描落盘同样会覆盖**扫描期间补拉的封面**
  （`setCover` / `setAlbumCover` 写 `candidates`，而扫描的 `candidates` 来自自己的聚合器
  ⇒ 不含那些封面）⇒ **机理同类、字段不同** ⇒ 建议另立 T119；
- ⏳ `scan()` **不防重入**（扫描中又触发一次扫描 ⇒ 两个 `scan()` 交替落盘）⇒ 建议另立；
- ⏳ `restore()` 在扫描中会把 `hits` 回退到断点快照 ⇒ 建议另立；
- ✅ **v0.4.4 已于 2026-11-20 发布**（本行原写于**发版之前** ⇒ 2026-11-20 更新；详见**第一百节**）：本任务只改实现 ⇒ **已发版**（发版 = T121）；
- ⏳ GitHub 账号 **2FA 未启用**（已知安全缺口，待用户决定）；
- ⏳ 卸载项落在 **HKCU（按用户）** ⇒ 要回按机器需 `/allusers`（触发 UAC）。

## 九十七、T119：修订「服务端不能浏览目录」的 6 处过时结论 ＋ 同步测试（2026-11-19）

> 起因：**2026-11-19 飞牛更新**（用户问：「今天飞牛更新了，飞牛音乐也更新了，是不是加入文件夹功能？」）
> ⇒ 调研确认**服务端已支持按目录浏览** ⇒ 仓库里「服务端**不能**浏览目录」这个结论**已过时**
> ⇒ 用户同日拍板立项：**「请立项修订 README 和『有声』页中『服务端不能浏览目录』的 6 处过时结论，并同步测试。」**

### 一、事实更正（**实测依据，不是推测**）

**旧结论**（写在 6 处）：

> 服务端**不能浏览目录** / NAS 音乐服务**没有「浏览目录」的接口**（实测 20 个候选端点都不通）
> ⇒ 客户端只能**把曲库扫一遍**，再按目录名挑出这个文件夹里的作品。

⚠ **错的是「服务端不能」这个因**；**「客户端目前按目录名挑」这个果仍然为真**
（客户端**还没接**那些新接口）⇒ **修法是改陈述，不是改行为**。

**新事实**（2026-11-19 真机实测，FN 中继 `https://pure2199.fnos.net/music`）：
飞牛音乐 Web 前端**由 NAS 自己托管** ⇒ 它的 JS 包里写着它**真正调用**的 API 路径
⇒ 扒主包 ＋ **44 个懒加载 chunk** ⇒ 反解出 **19 组 / 92 条**端点（路径＋方法）。

| 端点组 | 端点（方法） |
|---|---|
| `folderView` | `/folder-view/list`（GET）、`/folder-view/playable-tracks`（POST）、`/folder-view/add-to-playlist`（POST）、`/folder-view/delete`（POST）、`/folder-view/recover`（POST） |
| `appCenter` | `/app-center/authed-dir/list`（GET）、`/app-center/authed-dir/sub/list`（GET）、`/app-center/authed-dir/sub/create`（POST） |
| `sharedLibrary` | `/shared-library/{list,detail,create,edit,delete,scan,scan-all,reconnect,reconnect-check}` |

**真机实测**（只打 GET，**不碰任何写操作**）：

| 端点 | 实测 |
|---|---|
| `/album/list`（**对照**） | `code=0`，`total=34074` ⇒ 调用链路通 |
| `/folder-view/list` | `code=100002 invalid arguments`（**存在**，缺 `parentPath`）⇒ 带参 ⇒ `code=0` |
| `/app-center/authed-dir/list` | `code=0` ⇒ **2 个授权目录** |
| `/app-center/authed-dir/sub/list` | `?parent=` ⇒ `code=0` ⇒ **12 个子目录**（含 **有声小说**、**让青春继续**） |
| `/shared-library/list` | `code=0` ⇒ **2 个共享库** |
| `/artist/list-all` | `code=0` ⇒ `total=14875` |

⇒ `/folder-view/list?parentPath=/vol02/1000-0-3d135437` 直接给 `itemCount=173670` ＋ 每个子目录的曲目数。

⚠ **测出来的数字只代表那台机、那个账号**（本机 17.3 万首 / 87 页 ⇒ 与 T117/T118 记的一致）。

### 二、改法（**只改陈述，不改行为**）

**统一改成「本客户端目前」这个限定语**（6 处）：

| # | 位置 | 旧 | 新 |
|---|---|---|---|
| ① | `README.md:70` | 「服务端**不能浏览目录**，客户端只能扫曲库后按目录名挑」 | 「**本客户端目前**是扫曲库后按目录名挑」 |
| ② | `README.md:197` | 「NAS 音乐服务**没有「浏览目录」的接口**（实测 20 个候选端点都不通）⇒ 客户端只能…」 | 「**本客户端目前**是把曲库扫一遍…（⚠ 飞牛更新后服务端**已支持**「浏览目录」，**客户端还没接**）」 |
| ③ | `README.md:320` | 同 ① | 同 ① |
| ④ | `src/pages/AudiobooksPage.tsx:408` | 「（服务端不能浏览目录，客户端只能扫一遍曲库、再按目录名挑出这个文件夹里的作品）」 | 「（**本客户端目前**是扫一遍曲库、再按目录名挑出这个文件夹里的作品）」 |
| ⑤ | `src/pages/AudiobooksPage.tsx:522` | 「服务端没有浏览目录的能力（实测 20 个候选端点都不通），所以要先扫一遍曲库…」 | 「**本客户端目前**要先扫一遍曲库，再按目录名挑出这个文件夹里的作品。」 |
| ⑥ | `test/audiobooks-page.test.tsx:167`（**注释**） | 「服务端**不能浏览目录** ⇒ 客户端只能扫曲库后**按目录名**挑 ⇒…」 | 「**本客户端目前**是扫曲库后**按目录名**挑 ⇒…」 |

⚠ **用户可见文案（④⑤）不写「服务端已有接口、客户端还没接」** ⇒ 那是**内部信息**，
放进 UI 只会让人困惑 ⇒ 它写进**代码注释**（连同实测日期与端点名）⇒ 以后没人会把错因改回来。

⚠ **明确没动的**：

- **客户端行为**（仍全库扫 ＋ 按目录名挑）——「按目录浏览」是**另一个编号任务**；
- `docs/changelog.md:252` 与 calibration 的 T98 段 —— **历史段**记的是**当时**的事实 ⇒ **不篡改**；
- 既有断言（`test/audiobooks-page.test.tsx` ⑤-b 的 `toContain('主目录')` / `toContain('有声小说')`）
  —— **一条不删、一条不弱化**（断言的是**仍然为真**的事实）。

### 三、钉子（**5 条**）

| # | 钉子 | 位置 | 钉住什么 |
|---|---|---|---|
| ① | README **不含**旧说法（**句式**正则 ＋ 「候选端点都不通」逐字），**仍**含「主目录」「有声小说」，**且**含「本客户端目前」类限定语 | 新文件 `test/t119-doc-claims.test.ts` | 文档不许回退 |
| ② | 页面源码 **不含**旧说法，**仍**含「主目录」 | 同上 | 代码注释/文案不许回退 |
| ③ | `test/audiobooks-page.test.tsx` **不含**旧说法 | 同上 | 测试注释不许回退（注释别把旧结论当依据留着） |
| ④ | **历史段保持原样**：`docs/changelog.md` 里那句旧结论**仍在** | 同上 | 把「历史不篡改」**钉成显式决定**（免得以后有人为「统一口径」去改历史） |
| ⑤ | 页面**渲染**出来的提示 **不含**旧说法，**仍**写明「主目录」「有声小说」，**且**含「本客户端目前」 | 既有 `test/audiobooks-page.test.tsx`（**新增**一条） | 用户可见文案不许回退 |

⚠ **一个自引用的坑（实施时踩了两次）**：钉子要扫的**文件里**写着「不能浏览目录」这个词
（既有注释、**以及钉子自己的断言/标题**）⇒ **自己命中自己** ⇒ 假红。
⇒ 正解：正则与关键字**都用片段拼**（`['(服务端|音乐服务)', …].join('')`）
⇒ 片段之间隔着引号和逗号（**超出**间隔上限）⇒ **自我免疫**。

### 四、变异自证（**MUTATION_OK**）

脚本 `release/verify/t119-01-mutation-check.mjs`（本地、gitignored）⇒ 认的是「**红了哪几条**」。

| 变体 | 改什么 | 实际变红 | 结论 |
|---|---|---|---|
| **A** | `README.md:197` 改回旧说法 | **①** | ✅ |
| **B** | 页面 `:522` 改回旧说法 | **②⑤** | ✅ |
| **C** | 页面 `:408` 改回旧说法 | **②⑤** | ✅ |
| **D** | 测试注释改回旧说法 | **③** | ✅ |
| **E** | `README.md:70` 与 `:320` 改回旧说法 | **①** | ✅ |

⇒ 还原后 **21/21 绿** ＋ **字节级一致**（工作区未被污染）。

### 五、这一轮踩的坑（**跨项目可复用**）

1. ⚠ **「猜的候选全是 null」≠「服务端没这能力」**：我**先猜**了 25 个 `/folder/*` 命名候选 ⇒ **全部不认**
   ⇒ 真名是 **`/folder-view/*`** ⇒ **必须先拿到真实端点名再下结论**。
   ⇒ **判据**：端点**不存在** ⇒ body = `null`；**存在但缺参** ⇒ `code=100002`；正常 ⇒ `code=0`。
2. ⚠ **能拿到真实端点名的办法**：服务端托管的 Web 前端**自己**写着它调用的 API 路径
   ⇒ 扒主包 ＋ **全部懒加载 chunk**（本轮 44 个）⇒ 反解端点表
   ⇒ 比「猜名字」可靠得多（端点表在 **chunk** 里，主包只有前端路由 `/folders`）。
3. ⚠ **钉子要扫的文件里可能**写着**它自己要禁的那句话**（含钉子自己的断言与标题）
   ⇒ 正解：**正则与关键字都用片段拼** ⇒ **自我免疫**。
4. ⚠ **改陈述 ≠ 改行为**：本轮**客户端行为一个字节都没改**（仍全库扫 ＋ 按目录名挑）
   ⇒ 「按目录浏览」是**另一个编号任务**（服务端已支持 ⇒ 值得做）。
5. ⚠ **数字要标注口径**：本轮的曲目数 / 目录数都只代表**那台机、那个账号**。

### 六、复验结果

| 项 | 实测 |
|---|---|
| 回归 | tsc **0 错**；Vitest **149 文件 / 3 045 条全绿**（原 148 / 3 040 ＋ 新增 1 文件 4 条 ＋ 既有文件 1 条；**既有测试一条不删、断言一条不弱化**）；Playwright **72 passed**；build exit **0**；字节体检 ＋ 控制字符 **bad=0** |
| 变异自证 | `MUTATION_OK`（A⇒红 ①、B⇒红 ②⑤、C⇒红 ②⑤、D⇒红 ③、E⇒红 ①）；还原后 **21/21 全绿** ＋ 字节级一致 |
| 提交 | `efc6cbc` 规格 → `66a951a` 实现 ＋ 钉子 → （本节）复验文档 |
| 真机 | ✅ **不需要真机复验**（本轮**只改文档与文案**，客户端行为**一字未改**）；⚠ **但** 端点能力本身是**真机实测**的（2026-11-19，FN 中继） |

⇒ 规格 `docs/superpowers/specs/2026-11-19-sanlos-music-t119-doc-claims.md`（§三/§四/§五 已回填）。

### 七、遗留 / 待办

- ⏳ **「按目录浏览」本身还没做**（服务端已支持）⇒ 「有声」页可以**不再全库扫 87 页、不再靠 path 关键字猜目录**
  ⇒ **另立编号任务**（最值得做的下一个）；
- ⏳ **共享库**（`/shared-library/*`）也还没接 ⇒ 另立；
- ⏳ 顺带发现的**没用过的既有端点**：`/search/playlist`、`/search/suggest`、`/artist/list-all`（14 875 个歌手）、
  `/initialization/state` ⇒ 可另立小任务；
- ⏳ **T118 遗留的另一个同类毛病**（扫描落盘覆盖**扫描期间补拉的封面**；机理同类、字段不同）⇒ 仍未修 ⇒ 另立；
- ✅ **v0.4.4 已于 2026-11-20 发布**（本行原写于**发版之前** ⇒ 2026-11-20 更新；详见**第一百节**）（本任务只改文档与测试 ⇒ **已发版**）；
- ⏳ GitHub 账号 **2FA 未启用**（已知安全缺口，待用户决定）；
- ⏳ 卸载项落在 **HKCU（按用户）** ⇒ 要回按机器需 `/allusers`（触发 UAC）。

## 九十八、T120：「有声」页改为按服务端目录浏览（2026-11-19）

> 起因：**T119 §七** 留下的待办 —— 「**「按目录浏览」本身还没做**（服务端已支持）
> ⇒ 「有声」页可以**不再全库扫 87 页、不再靠 path 关键字猜目录** ⇒ **另立编号任务**」。
> 用户 2026-11-19 拍板：**「请立项 T120：将「有声」页改为按服务端目录浏览，并同步测试。」**

### 一、事实依据（**真机实测**，2026-11-19，FN 中继，**只打 GET**）

| 端点 | 参数 | 实测 |
|---|---|---|
| `GET /app-center/authed-dir/list` | — | `code=0` ⇒ **2 个授权目录** |
| `GET /app-center/authed-dir/sub/list` | `parent` | `code=0` ⇒ 子目录列表 |
| `GET /folder-view/list` | `parentPath`（必填）、`sort` | `code=0` ⇒ 文件夹视图 |

⭐ **`/folder-view/list` 的响应**（实测原文）：

```
data: { folder: { name, path, itemCount, folders:[{name,path,itemCount,isAdminDeleted}], tracks:[] },
        sort: "title,asc" }
```

- ⭐ **`tracks` 只在「直接含文件」的目录里才非空** —— 中间层是 **`[]`**
  （实测：`/有声小说` ⇒ `tracks=[]`；`/…/赶尸客栈/Disc 01` ⇒ `tracks=76`）⇒ **必须递归**；
- ⭐ **`itemCount` 是递归口径**（实测可对账：`有声小说=5244` ＝ 7 个子目录之和；
  `赶尸客栈=288` ＝ `76+65+69+78`）；
- ⭐ **「作品」层 ＝ 文件路径倒数第 3 段** —— 与客户端现有的 `workDirOf()`
  **完全一致**（实测 `/有声小说/凝眸七弦伤/赶尸客栈/Disc 01/….mp3` ⇒ `赶尸客栈`）
  ⇒ **归并键 `workGroupKey()` 不用改**；
- ⭐ 目录浏览返回的曲目**与客户端现有 `ScanTrack` 逐字对得上**
  （`album.guid` / `album.name` / `album.coverId` / `duration`(**毫秒**) / `audioSpec.path`）
  ⇒ **映射逻辑一字不用改**；
- ⚠ **`duration` 是毫秒**（实测 `829492`）⇒ 与 `/track/list` 口径一致 ⇒ 同样 `÷1000`；
- ⚠ **端点不存在时 body 是 `null`**（不是 `code≠0`）⇒ 老服务端**必须能回落**；
- ⚠ **`parentPath` 缺了是 `code=100002`**（端点存在，只是缺参）⇒ **别**当成「端点不存在」。

### 二、改法（**换数据源，不换判定**）

| | 之前 | T120 |
|---|---|---|
| 定位「那个文件夹」 | 全库扫 87 页，按 path 关键字猜 | 服务端目录树**广度优先**找 |
| 取作品 | 17.3 万首全量 | **只取**那个目录下的曲目 |
| 判定 / 归并 / 卡片 / 下钻 / 改判 | ✅ | **一行不改**（同一个 `accumulate()`） |
| 老服务端 | — | **自动回落**到旧的全库扫描 |

⚠ **落盘形状不变**：`STATE_VERSION` **不升**（`folderPaths` 是**可选字段**）
⇒ 老用户上次扫的结果**直接还在**（不用重扫）⇒ 与 T117 的教训一致。

⚠ **两条 T119 断言改写为新行为**（**前提被本任务显式推翻**：T119 钉的是「客户端还没接」）：
⑤-c 的 `toContain('本客户端目前')` ⇒ `toContain('按服务端目录浏览')`；
T119 ① 的 `toMatch(/本客户端(目前|还没接|还没)/)` ⇒ `toContain('按服务端目录')`。
**T119 其余断言一条没动** ⇒「不许再说『服务端不能浏览目录』」这条纪律**继续有效**。

### 三、钉子（**9 条**，新增 `test/t120-audiobook-folder-scan.test.tsx`）

| # | 钉子 | 抓住谁 |
|---|---|---|
| ① | **目录浏览优先**：新端点可用时 `/track/list` **一次都没被调用** | 「还在全库扫」 |
| ② | **对照组**：端点返回 `null`（不存在）⇒ `/track/list` **被调用** | 「回落失效」 |
| ③ | **只请求那个目录的子树**（同级的其它目录一次都不碰） | 「还在全库找」 |
| ④ | **递归**到「直接含文件」那层 ⇒ 12 集一条不落 | 「只取到第一层」 |
| ⑤ | 同一张专辑跨两个分段 ⇒ **合成一条** | 「拆成多条 / 集数翻倍」 |
| ⑥ | 同一份曲目：两条路 `hits` **逐字相同** | 「换了口径但判定变了」 |
| ⑦ | 服务端给的是**毫秒** ⇒ `durationSec` 是**秒**（1500000 ⇒ 1500） | 「忘了 ÷1000」 |
| ⑧ | 管理员删掉的**曲目 / 子目录**都不算 | 「把删掉的算进去」 |
| ⑨ | **落盘兼容**：`STATE_VERSION` **不升** ＋ 旧落盘照样读得出 | 「老用户数据作废」 |

⚠ **① 只钉「没走全库扫描」**（正向控制交给 ④）⇒ 免得它同时被「扫不到东西」的变异抓住
⇒ 变异矩阵分不出谁是谁。

### 四、变异自证（**MUTATION_OK**）

脚本 `release/verify/t120-01-mutation-check.mjs`（本地、gitignored）⇒ 认的是「**红了哪几条**」。

| 变体 | 改什么 | 实际变红 | 结论 |
|---|---|---|---|
| **A** | **退回全库扫描**（目录浏览的结果被丢掉） | **①④⑤⑥⑦⑧⑨** | ✅ |
| **B** | **不递归**（只取目标目录那一层） | **④⑤⑥⑦⑧⑨** | ✅ |
| **C** | **忘了 ÷1000** | **⑥⑦** | ✅ |
| **D** | **删掉回落**（老服务端抛错 ⇒ 直接失败） | **②⑥** | ✅ |
| **E** | **不跳过管理员删掉的曲目** | **⑧** | ✅ |

⇒ 还原后 **9/9 绿** ＋ **字节级一致**（工作区未被污染）。

### 五、这一轮踩的坑（**跨项目可复用**）

1. ⚠ **查询串里的空格**：通用 `buildQuery` 用 `URLSearchParams` ⇒ **空格编码成 `+`**；
   而目录名里**确实有空格**（实测「Disc 01」「03 DJ集合」…）⇒ 若服务端不把 `+` 当空格，
   **带空格的目录全都查不到**。
   ⇒ **实测真服务端三种编码都认**（`+` / `%20` / `URLSearchParams` 各 76 首），
   但生产代码**改用 `encodeURIComponent`**（`%20`）⇒ 不依赖服务端对 `+` 的处理。
   ⚠ **自己拼查询串**（不走 `opts.query`）才能这么干。
2. ⚠ **「根的深度」是「部署」决定的，不是能从路径推出来的**：mock 里我按「前 3 段」推授权目录
   ⇒ 根**深了一层**（把作品目录当成了根）⇒ 目录浏览**找不到**那个目录
   ⇒ 「有声」页列出 **0** 部作品 ⇒ **E2E 抓到了** ⇒ 改成「前 2 段」（`/volXX/<库名>` 这一层）。
3. ⚠ **先看名字、命中就停**：BFS 若把同级的其它目录也列一遍 ⇒ 多发一堆无用请求
   ⇒ 改成「**这一层的名字先全查一遍 ⇒ 命中就立刻返回**」。
4. ⚠ **浅层优先**：「`/有声小说`」和「`/有声小说/某作者/有声合集`」**同时**收下
   ⇒ 同一首曲目数两遍 ⇒ **集数翻倍** ⇒ 只取**最浅**的那一层。
5. ⚠ **「目录没找到」≠「端点不可用」**：前者**不该回落**（回落也找不到，只是白扫一遍全库），
   后者**必须回落**（老服务端）⇒ 两者要**分得开**（前者不抛错，后者抛错）。
6. ⚠ **回落提示别塞进 `error`**：那会显示成「**加载失败**：服务端不支持目录浏览」
   ⇒ **指错方向**的误导 ⇒ 单独一个 `notice` 字段，放**状态行**。

### 六、复验结果

| 项 | 实测 |
|---|---|
| 回归 | tsc **0 错**；Vitest **150 文件 / 3 054 条全绿**（原 149 / 3 045 ＋ 新增 1 文件 9 条；**既有测试一条不删**、被改写的两条**改写为新行为**）；Playwright **72 passed**（1.6 分钟）；build exit **0**；字节体检 ＋ 控制字符 **bad=0** |
| 变异自证 | `MUTATION_OK`（A⇒红 ①④⑤⑥⑦⑧⑨、B⇒红 ④⑤⑥⑦⑧⑨、C⇒红 ⑥⑦、D⇒红 ②⑥、E⇒红 ⑧）；还原后 **9/9 全绿** ＋ 字节级一致 |
| 提交 | `1c3ab32` 规格 → `25dd18c` 实现 ＋ 钉子 → （本节）复验文档 |
| 真机 | ⏳ **待真机项** —— 真机上跑一遍才有意义（尤其「作品」层的判定与耗时）⇒ 做法见规格 §六 |
| mock 端点 | **纯增量**（既有端点一个字没变）⇒ 既有 E2E 现在**走的是新路径** ⇒ 它们就是新实现的回归网 |

⇒ 规格 `docs/superpowers/specs/2026-11-19-sanlos-music-t120-folder-scan.md`（§三/§四/§五/§七 已回填）。

### 七、遗留 / 待办

- ⏳ **真机复验**（待真机项）：在真机上跑一遍「有声」页 ⇒ 看目录定位、作品层判定、耗时；
- ⏳ **共享库**（`/shared-library/*`）未接；未用过的既有端点（`/search/playlist`、
  `/search/suggest`、`/artist/list-all`、`/initialization/state`）⇒ 另立；
- ⏳ **T118 遗留的另一个同类毛病**（扫描落盘覆盖扫描期间补拉的**封面**）仍未修 ⇒ 另立；
- ✅ **v0.4.4 已于 2026-11-20 发布**（本行原写于**发版之前** ⇒ 2026-11-20 更新；详见**第一百节**）（本任务改了**行为** ⇒ **发版 = T121**）；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU（按用户）** ⇒ 要回按机器需 `/allusers`。
## 九十九、T120 真机复验：「有声」页按服务端目录浏览（2026-11-20）

> 起因：**T120 §七.4** 把「真机复验」列为**待真机项** ⇒ 本节补上。
> 用户 2026-11-20 拍板：**「真机复验 T120」**。

### 一、为什么要自己打包（**已装的验不到**）

已装的是 **v0.4.3**（T120 **之前**的版本）⇒ 装了也验不到新行为
⇒ 用 `npm run pack:probe` 打一份**带 T120 代码**的产物，
直接跑 `win-unpacked\Sanlos Music.exe`（**就是**安装器要装的那份 exe ⇒ 口径等价）
⇒ ⚠ **不碰** `D:\Sanlos Music`、**不动**注册表、**不覆盖**用户已装的版本。

⚠ **隔离 userData**：只复制 `session.bin`（DPAPI 会话）＋ `Local State`
⇒ 真实账号 ＋ 真 NAS，但**不碰**用户真实偏好 / 下载目录 / **有声扫描状态**
⇒ 因为隔离目录里**没有**落盘 ⇒ 进「有声」页**自动开扫** ⇒ 能测到真实耗时。

### 二、两组对照（**同机 / 同账号 / 同数据 / 同一天**）

| 项 | 对照组：已装 v0.4.3（旧路径） | 实验组：T120 打包产物（新路径） |
|---|---|---|
| 扫描耗时 | **56 041 ms** | **9 133 ms**（第二次探针 **6 594 ms**） |
| `/track/list` | **88 次** | **扫描窗口内 0 次**（全局 1 次，**与扫描无关**，见第三节） |
| `/folder-view/list` | 0 | **69 次** |
| `/app-center/authed-dir/list` | 0 | **1 次** |
| 作品 | **9 部** | **9 部（逐字一致）** |
| 落盘 `version` | 3 | **3（不升）** |
| 落盘 `scannedCount` | **173 671** | **5 244** |
| 落盘 `folderPaths` | 无此字段 | **`["/vol02/1000-0-3d135437/有声小说"]`** |
| 状态行 | 上次扫描：… · 目录「有声小说」· 9 部 | 上次扫描：… · 目录「有声小说」· 9 部（**/vol02/1000-0-3d135437/有声小说**） |

⇒ ⭐ **快 6–8 倍**（56.0 s → 6.6–9.1 s）；⭐ **取到的条目数正好对上**
（该目录递归共 5 244 首 ⇒ `scannedCount=5244`）。

⭐ **作品列表逐字一致**（两组完全相同）：

| 作品 | 集数 | 单集均长 |
|---|---|---|
| 三体 | 89 集 | 32 分 |
| 娱乐春秋 | 384 集 | 20 分 |
| 盗墓笔记 | 337 集 | 23 分 |
| 牧神记 | 2 762 集 | 9 分 |
| 极品家丁 | 1 333 集 | 9 分 |
| 赶尸客栈 | 288 集 | 11 分 |
| 让青春继续第一季 | 32 集（**合并了 2 张专辑**） | 14 分 |
| 让青春继续第三季 | 13 集 | 13 分 |
| 让青春继续第二季 | 6 集 | 13 分 |

⇒ ⭐⭐ 这是「**换数据源、不换判定**」的**真机证明**：
换了一条取数路径，**判定 / 归并 / 集数 / 卡片**一个字都没变。

### 三、那 1 次 `/track/list` 是谁打的（**查清楚了**）

第一次复验时实验组的 `/track/list` 计数是 **1**（不是 0）⇒ 单独探针复核：
**带时间戳**记录全部渲染层请求，并先打**基线标记**（**先不进「有声」页**，静置 25 秒）。

| 时刻 | 事件 |
|---|---|
| **t = 215 ms** | `sanlos://srv/track/list?page=1&size=50` ← **这一次** |
| t = 959 ms | 基线开始（此时还没点「有声」） |
| t = 25 968 ms | 点「有声」（⇒ 开始扫描） |
| t = 32 588 ms | 扫描完成 |

⇒ ⭐ **这一次早了近 26 秒** ⇒ 属**默认落地页**拉的一小页（`size=50`），**与扫描无关**；
⇒ ⭐ **扫描窗口（25.9 s → 32.6 s）内 `/track/list` = 0 次**
⇒ 目录浏览**确实一次都没碰**全库接口；
⇒ ⭐ **交叉验证**：对照组的 **88 次** = 87 页 ＋ **同一个那 1 次** ⇒ 两组同源。

### 四、对照组②：「目录没找到」⇒ 如实报错 **且不回落**

把目录名换成 `zzz-不存在的目录-t120` ⇒ 点「扫描这个目录」：

| 判据 | 实测 |
|---|---|
| 错误文案 | 「加载失败：服务端的目录里**没找到**叫「zzz-不存在的目录-t120」的文件夹 ⇒ 请确认它在音乐服务的曲库里（或换个目录名再试）。」 |
| 状态行 | 「上次扫描：… · 目录「zzz-不存在的目录-t120」· 0 部」⇒ **没有**「已改用全库扫描」 |
| `/track/list` 计数 | **1 → 1**（**没新增**）⇒ **没回落** |
| `/folder-view/list` | 69 → **269**（确实去服务端找了） |

⇒ ⭐ 「**目录没找到**」与「**端点不可用**」在真机上**分得开**：
前者**不回落**（回落也找不到，只是白扫一遍全库）。

### 五、⚠ 一处如实记录的差异：落盘 `coverId`（**不影响判定、不影响显示**）

真服务端 `/folder-view/list` 给的曲目 `coverId` **就是专辑封面**；
而 `/track/list` 里曲目封面与专辑封面**是两个不同的 id**
⇒ 两组落盘的 `coverId` **字段值不同**：

| | 对照组 v0.4.3（牧神记） | 实验组 T120（牧神记） |
|---|---|---|
| `coverId`（曲目封面） | `track_f3e0c6baab194b9091a82da838f6b699` | `track_4928676579f449d0856ab85ef7744a08` |
| `albumCoverId`（专辑封面） | `track_4928676579f449d0856ab85ef7744a08` | `track_4928676579f449d0856ab85ef7744a08` |

⇒ ⚠ **影响：无** —— 按 T102 的定义，`coverId` 是「**曲目**封面」**不用于显示**
（显示一律走 `albumCoverId`），判定 / 归并 / 集数也**不看**它
⇒ **卡片与判定逐字一致**（实测已证）。
⇒ 目录浏览**拿不到独立的曲目封面**（服务端没给）—— 这是**数据源的口径差**，不是缺陷。

### 六、⚠ 回落路径**真机验不了**（**如实标注，不假装验过**）

真 NAS **已是新版** ⇒ 目录浏览**不会失败** ⇒ 回落**根本不会触发**
⇒ 「老服务端 ⇒ 自动回落全库扫描」这一半**真机前提不成立**
⇒ 只能靠 **mock 的 ② 号钉子**（端点返回 `null` ⇒ `/track/list` 被调用）覆盖 —— 已在 T120 实现轮验过。

### 七、证据与复现

- 脚本：`release/verify/t120-05-realmachine-verify.mjs`（两组对照 ＋ 对照组②）、
  `release/verify/t120-06-probe-tracklist.mjs`（定位那 1 次 `/track/list`）
  —— 本地、**gitignored**；
- 证据：`t120-05-realmachine-result.json`、`t120-06-tracklist-probe.json`；
- ⚠ **口径**：耗时与曲目数**只代表这台机、这个账号、这份数据、这个网络**的一次实测。

### 八、遗留

- ✅ **v0.4.4 已于 2026-11-20 发布**（本行原写于**发版之前** ⇒ 2026-11-20 更新；详见**第一百节**）（T120 改了**行为** ⇒ 已装的 v0.4.3 仍是旧路径 ⇒ **发版 = T121**）；
- ⏳ 共享库 `/shared-library/*` 未接；T118 遗留的「扫描落盘覆盖补拉的封面」仍未修。

---

## 一百、T121：发版 v0.4.4 ＋ **装版**真机复验（2026-11-20）

> 起因：T120 改了**行为**（「有声」页改按服务端目录浏览）⇒ 已装的 v0.4.3 仍是旧路径
> ⇒ 用户拍板：**「请拍板发布 v0.4.4，将 T120 的服务端目录浏览能力正式交付。」**
>
> 规格：`docs/superpowers/specs/2026-11-20-sanlos-music-v0.4.4-release.md`

### 一、这一版发了什么（**三件事**）

| # | 东西 | 来自 |
|---|---|---|
| ① | 「有声」页按**服务端目录浏览**（不再全库扫 87 页） | T120 |
| ② | 修掉「扫描时把你手工改的判覆盖掉」 | T118 |
| ③ | 把「服务端不能浏览目录」这句过时的说明改对 | T119 |

⇒ v0.4.3..HEAD 共 **11 个 commit**、**17 个文件**。

### 二、发布链（**逐字可查**，每一步都有证据）

| 环节 | 结果 | 证据 |
|---|---|---|
| 版本号 | `package.json` 0.4.3 ⇒ **0.4.4**（**只 1 行**）；`package-lock.json` root `version` **两处**同步（⚠ 不同步 CI 的 `npm ci` 直接失败） | `t120-09-apply-version-044.mjs` |
| 注解 tag | `v0.4.4` → commit **`c21dab5`**（= 发版 commit），已推送 | `git tag -a` ＋ `git push origin v0.4.4` |
| 网页 dispatch | `release.yml`：`tag=v0.4.4`、**`pack_only` 取消勾选**、**`sign` 取消勾选** | Browser 操作记录 |
| CI run | **#21** / **`44568675852`** = **success** | GitHub Actions |
| 签名步骤 | SignPath 那几步**全部 skipped** ⇒ **未签名**路径 | run 的 step 列表 |
| attestation | ✅ 成功 ⇒ https://github.com/pure2199/sanlos-music/attestations/69747493 | 同上 |
| Release | `draft=false`、`prerelease=false`、资产**恰好 3 个** | `api.github.com` 资产端点 |
| 发版 commit | `c21dab5`（5 文件 / 240 插入 / 14 删除） | `git log` |

⚠ **`workflow_dispatch` 的布尔输入按 YAML 默认值渲染** ⇒ `pack_only` / `sign` 的 `default`
都是 `true` ⇒ **网页表单里默认是勾上的** ⇒ **不手动取消必然失败**在 SignPath 检查步骤。
⚠ 且这两个输入**各自还有一个同名 `type=hidden` 的 input** ⇒ CSS 选择器
`input[name="inputs[pack_only]"]` 会命中**那个 hidden 的** ⇒ `uncheck` 报
「target is not a checkbox」⇒ 必须用 **id**（`input#_r_p_` / `input#_r_q_`）。
✅ 取消后用 DOM 查 `input[type=checkbox]:checked` ⇒ **查不到**才是真没勾。

### 三、三处 sha256 **逐字一致**（`SHA256_OK`）

| 文件 | 字节数 | sha256 |
|---|---|---|
| `SanlosMusic-Setup-0.4.4.exe` | 86 139 754 | `56ceae67f982923c3531aa2a77992fdedf12aff0ebbc5884d28eb3aceb1c732a` |
| `SanlosMusic-Portable-0.4.4.exe` | 79 033 151 | `b771b677ae7ace55d0d8fb1ac2ee0fb061624d8b6f184a2be669882d4ed0214f` |
| `latest.json` | 472 | `1c26e95d79e4fcf1e4d2d87b34c2e05f76d160106fbbcad44b186d2b27fc7d9d` |

三个来源：**① Release 正文的「下载校验（sha256）」表**（期望值**从这里解析**，
不在脚本里另抄一份 ⇒ 不会「抄错却彼此一致」）／**② 资产 API 的 `asset.digest`**
（独立第二来源）／**③ 本地下载后自己算的**。
⚠ `latest.json` **不在正文表里**（工作流只给两个 `.exe` 写表）⇒ 只验了 ② ＝ ③。

### 四、装版（**原地升级**，**不卸载** v0.4.3）—— `INSTALL044_OK`

appId `com.sanlos.music` 没变 ⇒ 卸载项 GUID 不变 ⇒ **直接覆盖安装**
⇒ **绝对不先跑卸载器**（NSIS 的卸载器父进程先退、子进程继续删目录）。

| 项 | 实测 |
|---|---|
| 装前守卫 | **没有** Sanlos Music 在跑 ⇒ 才装（**不替用户杀进程**） |
| 安装器 | `SanlosMusic-Setup-0.4.4.exe /S /D=D:\Sanlos Music`（⚠ `/D=` **必须最后一个参数且不含引号**）⇒ exit **0** |
| 落盘判据 | exe ＋ asar 存在 ＋ **连续 3 次大小不变** ＋ exe FileVersion **已是 0.4.4**（NSIS 父进程先退 ⇒ exit 0 **不代表装完了**） |
| 主程序 | FileVersion **0.4.4** / ProductVersion 0.4.4.0 / ProductName `Sanlos Music` |
| 应用包 | `app.asar` **844 415 B**、mtime 2026-11-19T16:43:56Z、内含 `package.json` version = **0.4.4** ＋ **5/5** 个 v0.4.4 标志命中 |
| 卸载项 | **HKCU** `…\Uninstall\370ec968-468d-54c5-8c47-1ad7446b1631` ⇒ `Sanlos Music 0.4.4` / `0.4.4`；**没有**残留的 0.4.3 条目 |
| 快捷方式 | 开始菜单 `Sanlos Music.lnk` 在 |
| **用户数据** | `session.bin`（286 B）**逐字未变**、`Local Storage` **11 个文件未变**、`prefs.json` 未变 |

⚠ **注册表要两步查**：`reg query … /f '<名称>'` 的输出**只含匹配行**
⇒ 卸载项里的 `DisplayVersion`（值 `0.4.4`，**不含** "Sanlos Music"）**根本不在**那段输出里
⇒ 直接解析必得 null ⇒ 正解：先 `/s /f` 找**键路径**，再**不带过滤** `reg query <键>` 取全部值。

### 五、真机复验（**已装 v0.4.4** ＋ **真实 FN NAS** ＋ 真实账号 ＋ **隔离 userData`）

⚠ 隔离 userData = 只复制**真实会话**（`session.bin` ＋ `Local State`）
⇒ 真实账号 ＋ 真 NAS，但**不碰**你本机的偏好 / 下载目录 / **有声扫描状态**；
⇒ 隔离目录里**没有**落盘 ⇒ 进「有声」页**自动开扫** ⇒ 能测到真实耗时。
⚠ 这次跑的是 `D:\Sanlos Music\Sanlos Music.exe`（**装上去的那份**）⇒ 不是自打产物。

#### ① 「有声」页按目录浏览

| 复验项 | v0.4.3（旧路径） | **v0.4.4（已装版）** | 结论 |
|---|---|---|---|
| 扫描耗时 | **56 041 ms** | **16 075 ms** | ✅ 快 3.5 倍（⚠ 只代表这台机这次） |
| `/track/list` | 88 次（87 页 ＋ 1） | **全程 1 次、扫描窗口内 0 次** | ✅ 没再全库扫 |
| `/folder-view/list` | 0 | **69 次** | ✅ |
| `/app-center/authed-dir/list` | 0 | **1 次** | ✅ |
| 作品 | 9 部 | **9 部（逐字一致）** | ✅ 判定口径没变 |
| 落盘 `version` | 3 | **3（没升）** | ✅ |
| 落盘 `scannedCount` | 173 671 | **5 244** | ✅ |
| 落盘 `folderPaths` | 无 | **`["/vol02/1000-0-3d135437/有声小说"]`** | ✅ |
| 扫完状态行 | 「…· 9 部」 | 「上次扫描：… · 目录「有声小说」· 9 部（**/vol02/…/有声小说**）」 | ✅ |

作品（三体 89 集 / 娱乐春秋 384 / 盗墓笔记 337 / 牧神记 2 762 / 极品家丁 1 333 /
赶尸客栈 288 / 让青春继续第一季 32（合并 2 张专辑）/ 第三季 13 / 第二季 6）
⇒ 与 T120 那轮**逐字一致**。

> **「窗口内 0 次」的口径**：真机上**整个应用在跑** ⇒ 默认落地页也会拉**一小页**歌曲列表
> ⇒ 那一次发生在点「有声」页**之前 737 ms** ⇒ **与扫描无关**
> ⇒ 扫描那一段里它**一次都没被调用**。

#### ② T118：扫描**进行中**的手工改判，扫完**不许**被覆盖（**第一次在真机上验**）

| 步骤 | 实测 |
|---|---|
| 第一轮扫描 | 13 179 ms ⇒ 9 部作品 |
| 目标 | 《让青春继续第二季》（列表**最后一张** ⇒ 集数最少 ⇒ 详情页最快 ⇒ 来得及在扫描窗口内点） |
| 动作 | 点「从头重扫」⇒ **扫描进行中**点卡片进详情页（**页内路由**，同一窗口）⇒ 「这不是有声」出现 ⇒ 点它 |
| ⭐ 改判**落在扫描窗口内** | **true**（改判时刻 **早于**扫描的最终落盘时刻）⇒ 这次断言**不是白测** |
| 扫完后落盘 | **还留着** `{albumId: "805e6d029e94436182cda98e8a4e5866", value: "not-audiobook", albumTitle: "让青春继续第二季"}` |
| 扫完后界面 | 「这不是有声」按钮**没有回来**（`isAudiobook` 仍为 false）⇒ 改判**仍然生效** |

⇒ **T118 在已装 v0.4.4 上真机成立**。
⚠ 判据为什么选「按钮**没有回来**」：点了「这不是有声」之后 `isAudiobook` 变 false
⇒ 那个区块**本来就该消失** ⇒ 若扫描把改判覆盖掉 ⇒ `isAudiobook` 回到 true
⇒ 按钮**重新出现** ⇒ **「它回来了」才是回归信号**。

#### ③ 对照组②：「那个文件夹**不存在**」时 ⇒ 如实报错 **且不回落**

目录名换成 `zzz-不存在的目录-t121` ⇒

> 「加载失败：服务端的目录里**没找到**叫「zzz-不存在的目录-t121」的文件夹 ⇒ 请确认它在音乐服务的曲库里（或换个目录名再试）。」

⇒ `/track/list` 计数 **1 → 0**（**没新增**）⇒ **没回落**；
⇒ `/folder-view/list` 69 → 200 ⇒ 它在**继续找目录**，不是改去扫全库。

### 六、这一轮踩的坑（**跨项目可复用**）

1. ⚠ **`workflow_dispatch` 的布尔输入默认勾着** ⇒ 不手动取消**必然**失败
   ⇒ 且每个布尔输入还有一个**同名 hidden input** ⇒ 按 `name` 选会命中 hidden 那个
   ⇒ **用 id** ＋ 用 `input[type=checkbox]:checked` 复核（**读 `checked` 属性不可靠**）；
2. ⚠ **`@electron/asar` 的 `extractFile` 在 Windows 上要**反斜杠**分隔**
   ⇒ 用正斜杠会**静默抛错** ⇒ 若被 try/catch 吞掉 ⇒ asar 文本里只剩 `main.js`
   ⇒ 标志检查「0 命中」= **假红**（本轮真踩了一次：装版脚本第一版报红，实际 5/5 命中）；
3. ⚠ **注册表要两步查**（`/f` 的输出只含匹配行 ⇒ `DisplayVersion` 不在里面）；
4. ⚠ **NSIS 的 `/D=` 必须最后一个参数且不含引号** ⇒ Node 要 `windowsVerbatimArguments: true`；
5. ⚠ **父进程 exit 0 ≠ 装完了** ⇒ 判据必须是「exe ＋ asar 存在 ＋ **连续 3 次大小不变** ＋ **版本已是目标版本**」；
6. ⭐ **「没发生」类判据在真机上会被别的功能污染** ⇒ 口径必须写成「**扫描窗口内**零次」
   ⇒ 用**带时间戳**的请求日志划窗口，并说明窗口外那一次的归属。

### 七、⚠ 如实标注的边界

- ⚠ **回落路径真机验不了**（真 NAS 已是新版 ⇒ 目录浏览不会失败 ⇒ 回落**不触发**）
  ⇒ 靠 **mock 的 ② 号钉子**覆盖 ⇒ **不假装真机验过**；
- ⚠ **扫描刚开始约 1 秒内**状态行还是旧口径「正在扫描…第 0 页 / 共 0 页（已扫 0 首）」
  （`progress.mode` 要等第一次目录回调才切到 `folder`）⇒ 随后才变「正在按目录浏览…」
  ⇒ **T120 那轮采样到的也是同一形态** ⇒ **不是本版新出现的**；
- ⚠ **落盘里「曲目封面」那个 id 变了**（目录浏览拿不到独立曲目封面）
  ⇒ **不用于显示**、判定也**不看**它 ⇒ **无影响**；
- ⚠ **耗时 / 曲目数只代表这台机、这个账号、这份数据、这个网络**的一次实测
  （本轮 16.1 s vs T120 那轮 9.1 / 6.6 s ⇒ 机器负载也会影响）。

### 八、证据

- `release/verify/t121-01-download-and-verify-release.mjs`（三处 sha256）、
  `t121-02-install-v044.mjs`（装版验收）、`t121-03-check-installed-asar.mjs`（asar 标志）、
  `t121-04-realmachine-verify-installed.mjs`（真机三阶段）—— 本地、**gitignored**；
- 证据：`t121-02-install-result.json`、`t121-04-realmachine-installed-result.json`。

### 九、遗留 / 待办

- ⏳ 共享库 `/shared-library/*` 未接；
- ⏳ **T118 遗留的另一个同类毛病**（扫描落盘覆盖**扫描期间补拉的封面**；机理同类、字段不同）仍未修 ⇒ 另立；
- ⏳ **回落路径真机验不了**（见 §七）；
- ⏳ GitHub 账号 **2FA 未启用**（已知安全缺口，待用户决定）；
- ⏳ 卸载项落在 **HKCU（按用户）** ⇒ 要回按机器需 `/allusers`（触发 UAC）；
- ⏳ Release **v0.4.2 / v0.4.3 的线上正文**按用户「以前的版本不用管」**不改**。
- ⚠ **本轮回归撞到一次 `test/mock-server.test.ts` 的飘红**（`/track/genre-detail/list`
  那条报 `fetch failed` / `bad port`）⇒ **不是本轮改动引起的**（本轮**只改文档**）
  ⇒ **单独跑该文件 3 次全绿**（64/64）、**全量重跑 150 文件 / 3 054 条全绿**
  ⇒ 属**既有的并发端口竞态**（mock 用 `listen(0)` 让系统分配端口；Windows **顺序**分配
  ⇒ 并发下可能落到 fetch 的「禁用端口」，或 `address()` 尚未就绪 ⇒ 端口为 **0** ⇒ `bad port`）
  ⇒ **既有测试一条没改、断言一条没弱化**；修它属**另一个编号任务**；

### 十、线上 Release 正文已同步（2026-11-20，**用户确认后**改的）

- **起因**：发版时 CI 把 `docs/releases/v0.4.4.md`（**tag 里那份**）当作 Release 正文
  ⇒ 第五节写的是「**⏳ 待装版复验**」⇒ 装版复验做完后**线上正文与仓库里的实测结论不一致**；
- **改法**：**只替换第五节**（前缀＝第一～四节，后缀＝第六～八节 ＋ CI 追加的两节）
  ⇒ **前后两段一个字符都没动**（脚本里用 sha256 **断言**前缀/后缀未变）；
- **验收**：线上正文 sha256 = `efaa171cb8c50be130a9cc4294c3c919b0925ac856b8d2242d1691a47cfd360f`
  （**9 236 字符**）⇒ **内容**与目标稿**逐字一致**（行尾归一化后）
  ⇒ 「⏳ 待装版复验」**已清除**，第五节已是「**✅ 已装版复验，2026-11-20**」；
- ⚠ **线上正文是全 CRLF** —— 这是**网页表单提交**的结果（HTML 的 urlencoded 序列化规定换行用 CRLF）
  ⇒ 正好与 **v0.4.3** 同步后的口径一致（183 CRLF / 0 LF）
  ⇒ ⚠ **CI 追加的 sha256 表内容一字未动**，且仍与**资产 API 的 `digest`** 逐字一致；
- **资产没被动过**：仍**恰好 3 个**（Setup / Portable / `latest.json`），
  name / size / digest 逐字不变；tag `v0.4.4` / 标题 / `draft=false` / `prerelease=false` / `latest` **都没变**；
- ⚠ **没有 token、没有 `gh` CLI** ⇒ 只能走**网页表单**（`/releases/edit/v0.4.4`）
  ⇒ 正文用 `textarea` 的**原生 setter + input 事件**写入（React 受控组件才认）
  ⇒ 写入前在**页内核对了 sha256**（与目标稿一致）才点保存；
- ⚠ **正文里那 9 KB 不内联进工具调用**：用「脚本文件 + `run_script` 的 `path`」把正文带进页面
  ⇒ 顺带发现 **`https` 页面 fetch 本机 `http://127.0.0.1` 会被混合内容策略挡掉**。
## 第一百零一节、T122：接共享库 `/shared-library/*`（2026-11-20）

> 起因：T119 反解出服务端有 `sharedLibrary` 这组端点（`/shared-library/{list,detail,create,edit,delete,scan,scan-all,reconnect,reconnect-check}`），
> 但**一直没人接** ⇒ 台账里长期挂着「⏳ 共享库未接 ⇒ 另立」。
> 用户 2026-11-20 拍板：「ABCD 全做」（共享库 / 修既有缺陷 / 接未用端点 / 卫生项）⇒ 本节是第一组。

### 一、真机实测（2026-11-20，FN 中继 `https://pure2199.fnos.net/music`，**只打 GET**）

⚠️ **只读探针**：`release/verify/t122-01-probe-shared-library.mjs`（用**隔离 userData** ＋ 只带 `session.bin`
⇒ 真实账号 ＋ 真 NAS，**不碰**用户真实偏好 / 落盘状态；走**客户端自己的通道** `sanlos://srv/...`
⇒ **不碰任何凭证**，token 只在主进程内存里）。

| 端点 | 实测 |
|---|---|
| `GET /shared-library/list` | `code=0`；`data.list[]` = `{ guid, name, path, autoDownloadLyric, metadataPreference, contentLastChangedAt, accessStatus }`；本机 **2** 项 |
| `GET /shared-library/list?page=1&size=50` | 与不带参**同形**（该端点**不分页**） |
| `GET /shared-library/detail?guid=<guid>` | `code=0`，返回**同一个对象**（**无额外字段**）⇒ **不接**（拿不到新信息，多一个端点就多一个会坏的面） |
| `GET /shared-library/scan-all` | HTTP 200，body = **`null`** ⇒ 端点不存在或方法不对 |
| `GET /shared-library/reconnect-check` | 同上（body = `null`）⇒ ⚠️ **真实路径是 `/shared-library/reconnect/check`**（前端反解确认，**T119 那张表写错了**） |
| `GET /shared-library/track/list` | body = `null` ⇒ **不存在**「按共享库取曲目」的端点 |
| **对照**：`GET /app-center/authed-dir/list` | `code=0` ⇒ **2 个授权目录** |
| **对照**：`GET /track/list?page=1&size=3&guid=<共享库 guid>` | **不生效**（返回的还是普通全库第一页）⇒ 服务端**不接受**按共享库 guid 过滤 |

### 二、⭐ 两个决定设计的关键事实

1. **共享库不是另一份曲库**：本机这 2 个共享库的 `path` **正好就是**那 2 个授权目录
   （`/vol02/1000-0-3d135437`、`/vol1/1000/music/music`）
   ⇒ 共享库 = **同一个曲库的「共享视角」** ⇒ 浏览它**不需要新的取数路径**；
2. **`name` 是空串**（两个都是）⇒ 展示名必须**兜底**，否则界面上是空白项。

### 三、扒飞牛音乐 Web 前端包（2026-11-20，46 个 chunk）后的结论

| 事实 | 依据 |
|---|---|
| **方法只有 2 个 GET**（`list` / `detail`），其余 7 个**全是 POST** | 方法表 `yb`（chunk `5e884898…BwvE3acT.js`） |
| 真实路径 `/shared-library/reconnect/check`（**不是** `reconnect-check`） | 端点表 `q.sharedLibrary` ⇒ **T119 的端点表在此处是错的** |
| `accessStatus`：**0 = 正常**、非 0 = **访问异常**（前端渲染「访问异常，前往处理 >>」） | `8a84e406…DMwNLWNT.js` 三态徽标；⚠️ **库级数值含义前端包里没有枚举** ⇒ 客户端**只标异常、不解释** |
| `metadataPreference` 枚举：`local_preferred` / `cloud_preferred` / `local_only` | `7dfb4cf…D2EFmKVC.js` 的枚举 `T` |
| `name` 为空时的兜底顺序：`name` → 语义路径末段 → 物理路径末段 → `guid`（**前端不额外调接口补名**） | `qj`（`1bc04b52…BzHXPaBs.js`） |
| 共享库列表**每 15 秒轮询**；扫描进度从任务 `ext.libraryGUID`（**大写 GUID**）反推 | `7dfb4cf…` / `8a84e406…` |

⭐ **「共享库的曲目从哪来」——最关键的一条**：
**前端包里根本不存在「按共享库 guid 取曲目」的接口**
（全包检索 `sharedLibraryGuid` / `library_guid` **0 命中**；`libraryGuid` 仅 3 处且都是**本地 state key**，不是请求参数）：

- `/track/list` 全站**只被调用一次**，且**不带任何库筛选**（`getLibraryPageData` 连 `path` 都不转发）；
- 物理目录浏览是另一条线：`GET /folder-view/list?parentPath=&sort=`。

⇒ **共享库对象只提供「目录 ＋ 扫描策略 ＋ 访问状态」，不提供曲目清单。**
⇒ 本客户端**选目录浏览那条**（只读、当场见效、不扫全库）⇒ 与 T120「有声」页**同一套口径**。

### 四、改动清单

| 文件 | 动作 |
|---|---|
| `shared/types.ts` | ＋`SharedLibrary` 类型（含实测依据与「不解释」的边界） |
| `src/api/sharedLibrary.ts` | **新建**：`listSharedLibraries()` / `mapSharedLibrary()` / `isUnsupportedError()` / `sharedLibraryApi` |
| `src/api/folder.ts` | ＋导出 `folderTrackToSong()`（**复用 `client.ts` 的 `mapSong`** ⇒ 毫秒→秒、封面归一、多歌手连接，与曲库同一套字段） |
| `src/pages/SharedLibrariesPage.tsx` / `shared-libraries-page.css` | **新建**：列表态 ＋ 浏览态（面包屑 / 子目录下钻 / 曲目可播） |
| `src/App.tsx` | ＋「共享」导航（曲库导航组，**需要 NAS**）＋ 视图分支 |
| `mock-server/server.ts` | ＋`GET /shared-library/list`（**共享库的 `path` 从 `authedRoots` 推导** ⇒ 与 mock 曲库永远对得上） |
| `test/t122-shared-library.test.tsx` | **新建**：8 条钉子 |
| `e2e/t122-shared-library.spec.ts` | **新建**：接线 E2E |
| `docs/superpowers/specs/2026-11-20-sanlos-music-t122-shared-library.md` | **新建**：规格 |
| `README.md` / `docs/changelog.md` / 本节 | 能力清单 ＋ 变更说明 ＋ 本节 |

### 五、钉子（**8 条**）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | 列表渲染；`name` 空 ⇒ 展示名兜底（路径末段 ⇒ `guid`） | 不许出现空白项 |
| ② | 老服务端（抛「响应不是预期信封」）⇒ 显示「不支持共享库」，不崩 | 不许白屏 / 不许假装有数据 |
| ③ | 点共享库 ⇒ 子目录可下钻、曲目列出来 | 浏览链路通 |
| ④ | 双击曲目 ⇒ `onPlay(song, index, list)`；**时长是秒不是毫秒**；`list` = 整队 | 播放口径与曲库一致 |
| ⑤ | 浏览失败 ⇒ 如实显示错误 | 不许吞异常 |
| ⑥ | 映射：`displayName` 兜底链、`accessStatus` 原样、`contentLastChangedAt` 是 **Unix 秒**、`metadataPreference` 透传 | 映射规则不回退 |
| ⑦ | 页面源码**不含**「服务端不能浏览目录」那类过时结论 | T119 纪律延伸到新页面 |
| ⑧ | E2E：顶栏「共享」→ 列表 → 浏览 → 双击播放条出歌名 | 接线 ＋ 真链路 |

### 六、复验结果

| 项 | 实测 |
|---|---|
| `tsc` | **0 错** |
| Vitest | **151 文件 / 3 061 条全绿**（原 150 / 3 054 ＋ 新增 1 文件 7 条；**既有测试一条没删、断言一条没弱化**） |
| Playwright | 见 §七 验收记录（新增 1 条 T122 用例） |
| `build` | exit **0** |
| 字节体检 ＋ 控制字符 | `bad=0` |

### 七、遗留 / 待办

- ⏳ **共享库的管理操作**（添加文件夹 / 扫描 / 重建搜索索引 / 重连）**一律不接**（**写操作**）⇒ 需要管理请用飞牛音乐 Web 端；
- ⏳ **库级 `accessStatus` 的数值含义**未确证（前端只判 `!==0`）⇒ 客户端只标「访问异常」，**不解释**；
- ⏳ `reconnect/check` / `reconnect` 的响应字段（`requiresConfirmation` / `matchAccepted` / `reconnected` / `scanStarted`）**未实测**（不接 ⇒ 不需要）；
- ⚠️ **T119 那张端点表**里 `reconnect-check` 应为 `reconnect/check` ⇒ 已在本节标注，**待另立小任务**订正文档（**历史段不篡改**）；
- ⏳ 共享库里的新曲目**要等服务端扫描完**才看得到（客户端不代劳扫描 —— 那是写操作）；
- ⏳ **真机复验待装版后做**（本轮改动**未发版**）。

## 第一百零二节、T123：退出前补写一次「上次播放」的位置（2026-11-20）

> 起因：台账遗留原文 —— 「『退出前补写一次位置』（把续播误差从最多 10 s 压到 ≈ 0）本轮未实现」
> ⇒ 用户 2026-11-20 拍板「ABCD 全做」⇒ 本节是**第二组（修既有缺陷）的第一项**。

### 一、代码事实（不是推测）

| 事实 | 出处 |
|---|---|
| 写盘是**节流**的：非 `force` 时 `now - lastResumeWriteAt < RESUME_SAVE_INTERVAL_MS` ⇒ **不写** | `src/state/playerStore.ts` 的 `persistResume()` |
| `RESUME_SAVE_INTERVAL_MS = 10_000` | 同上 |
| 强制写只发生在**切歌**（`playTrack` / `next` / `prev`）与**恢复**（`resumePlayback`） | 同上 |
| **没有**「退出前写一次」的调用点 | 全仓库检索 |
| 「关掉自动播放 ⇒ 不出声，但位置照记」**已经是既有行为**（`restoreLastPlayback` 的 `disabled` 分支：**连记录都不读** ⇒ 更不会覆盖它） | `src/state/resumeFlow.ts` |

⚠ 最后那条**只是「代码层面已实现」** ⇒ 台账里它挂的是「**安装版实测**」
⇒ 本轮补**单测钉子**（代码层面先钉死），**安装版真机复验另列**（**不假装验过**）。

### 二、改动清单（**5 个文件**）

| 文件 | 动作 |
|---|---|
| `src/state/playerStore.ts` | ＋`flushResume()`：**强制**写一次（`force = true` ⇒ 不受 10 秒节流约束）；**没有当前曲目 ⇒ 不写** |
| `src/player/resumeFlush.ts` | **新建**：`installResumeFlush(flush)` ⇒ 装 `beforeunload` + `pagehide` 两个钩子；**写盘异常一律吞掉** |
| `src/App.tsx` | `useEffect(() => installResumeFlush(() => usePlayerStore.getState().flushResume()), [])` |
| `test/t123-resume-flush.test.ts` | **新建**：5 条钉子 |
| `docs/superpowers/specs/2026-11-20-sanlos-music-t123-resume-flush.md` | **新建**：规格 |

### 三、钉子（**5 条**）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | `flushResume()` **强制**写一次（拖到 42 秒后节流内**不写** ⇒ 补写后立刻写出 42 秒） | 「不受节流约束」这条契约 |
| ② | **没有当前曲目** ⇒ 不写 | 不制造「看起来存了、其实读不出来」的假状态 |
| ③ | `beforeunload` / `pagehide` 都会补写；卸载后不再补写 | 钩子接线 |
| ④ | 补写抛异常 ⇒ **不冒泡** | 退出路径不被记录拖垮 |
| ⑤ | 关掉自动播放 ⇒ `restored:false / reason:'disabled'`、`play` 未调用、**`load` 也没调用** | 「不出声但位置照记」 |

### 四、⚠ 这一轮踩的坑（跨项目可复用）

1. ⚠ **全量测试偶发 OOM**（`FATAL ERROR: MarkCompactCollector … JavaScript heap out of memory`）
   ⇒ **不是**本轮改动引起的（本轮只加了一个 action ＋ 一个纯函数 ＋ 5 条钉子），
   而是**机器当时的内存压力**（同时还跑着别的应用）⇒ **重跑一次就全绿**
   ⇒ ⚠ **看到 OOM 先查机器内存，别急着怀疑自己的改动**；
2. ⚠ **「关窗口只是隐藏、播放继续」**这条路**不会**触发 `beforeunload` / `pagehide`
   ⇒ 装钩子**不会**改变「播放继续」时的任何行为（那本来就有 10 秒节流在写）⇒ **零回归面**；
3. ⚠ **`beforeunload` 在窗口销毁路径上不一定发**（Chromium 某些路径只发 `pagehide`）
   ⇒ **两个都挂**，别只挂一个。

### 五、如实标注的边界

- ⚠ **安装版真机复验待做**：「关掉自动播放 ⇒ 不出声但位置照记」与「退出前补写 ⇒ 误差 ≈ 0」；
- ⚠ 「关掉自动播放」当前语义 = **完全恢复**（不加载、不定位）
  ⇒ 若用户期待「**加载那首歌并定位到进度、但不出声**」，那是**另一种语义** ⇒ **待用户拍板**；
- ⚠ 本轮**未发版**。

### 六、遗留

- ⏳ 发现页「**先出榜单、命中异步补**」＋「二次进入重打 NAS（匹配结果不缓存）」；
- ⏳ 曲库分页 / `normalizePageNumber()` 的**上界 clamp**（现状：曲库 `size` 已 clamp ≤ 2000，
  **页码上界仍未夹** ⇒ 需先实测服务端对超大 `page` 的行为再定上界，**不猜**）；
- ⏳ 歌单面板**排序 / 分页**；
- ⏳ README `### Code signing policy` ＋ `.github/CODEOWNERS`；
- ⏳ `scripts/pack.cjs` 跨卷 EXDEV / 占用兜底（老问题 **T62**）。
## 第一百零三节、T124：发现页「先出榜单、命中异步补」＋「二次进入不重打 NAS」（2026-11-20）

> 起因：台账 T96/T97/T98/T100 的遗留里连着挂了同一条 ——
> 「发现页『**先出榜单、命中异步补**』」「二次进入『发现』会**重打 NAS**（匹配结果不缓存）」。
> 用户 2026-11-20 拍板「ABCD 全做」⇒ 本节是**第二组（修既有缺陷）的第二项**。

### 一、代码事实（不是推测）

| 事实 | 出处 |
|---|---|
| 匹配 = **逐个歌手定向查**（`/search/artist` → `/track/artist-detail/list`），**不拉全量** | `src/api/discover.ts` 的 `matchChartsToLibrary()` |
| 并发用 `mapWithLimit`（`DISCOVER_QUERY_CONCURRENCY`） | 同上 |
| 条目最终判定是**纯计算**（`shared/chartMatch.ts` 的 `matchChartEntry()`） | 同上 |
| ⚠ `loadCharts()` 把「拉榜」与「匹配」**串成 await** ⇒ **榜单被匹配挡住** | `src/state/discoverStore.ts`（改前） |
| 中继链路上匹配要 **30–40 秒** | 台账 T96 实测 |

⇒ 榜单明明已经拿到了，却要等曲库匹配完才出现在屏幕上；而且**二次进入再打一遍 NAS**。

### 二、改动清单（**7 个文件**）

| 文件 | 动作 |
|---|---|
| `shared/chartTypes.ts` | `MatchedChartEntry` ＋**可选** `pending?: boolean`（缺省 = 已匹配完 ⇒ **既有行为一字未变**） |
| `src/api/discover.ts` | ＋`pendingChartBoards(boards)`：造一份「**还没匹配**」的榜单 |
| `src/state/discoverStore.ts` | ① 榜单一到 ⇒ **立刻**出榜单（条目 `pending`）＋ `matching: true`；② 匹配在后台跑 ⇒ 完成后**补上**；③ **会话内缓存**（模块级 `Map`，key = 榜单 id ＋ 条目数 ＋ 首条标题） |
| `src/pages/DiscoverPage.tsx` | pending 条目显示「**匹配中…**」；状态行 / 命中率文案在匹配期间显示「正在匹配你的曲库…」 |
| `test/t124-discover-async-match.test.tsx` | **新建**：5 条钉子 |
| `docs/superpowers/specs/2026-11-20-sanlos-music-t124-discover-async-match.md` | **新建**：规格 |
| `docs/changelog.md` / 本节 | 「未发布」段 ＋ **第一百零三节** |

### 三、钉子（**5 条**）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | 榜单一到 ⇒ `boards` 已有条目且标 `pending`、`matching === true` | 「榜单先出」 |
| ② | 匹配完成 ⇒ `pending` 清空、命中数 / 总数正确 | 「命中异步补」 |
| ③ | **同样榜单第二次进来** ⇒ `searchArtists` **一次都没被调用** | 「二次进入不重打 NAS」 |
| ④ | 曲库查不动 ⇒ 榜单**仍在** ＋ `matchError` ＋ 条目**全部 pending** | 「不假装有结论」 |
| ⑤ | 界面：pending 显示「匹配中…」，**一个「不在曲库」都不许出现** | 文案不撒谎 |

### 四、⚠ 这一轮踩的坑（跨项目可复用）

1. ⚠ **「还没查完」和「查了没有」是两件事** ⇒ 同一个布尔字段装不下
   ⇒ 必须**多一个状态**（`pending`）⇒ 否则界面会在匹配期间**说假话**（「不在曲库」）；
2. ⚠ **「先出榜单」不能只改 store** ⇒ 界面上还有两处**基于计数**的文案
   （状态行「共 N 条，你的曲库里有 M 条」＋ 命中率「榜上 N 首，你的曲库里有 M 首」）
   ⇒ 匹配期间它们会报「**0 首**」⇒ **文案也要跟着状态走**；
3. ⚠ **缓存 key 必须含内容指纹**（条目数 ＋ 首条标题）⇒ 只用榜单 id 的话，
   榜单内容变了会命中**旧缓存** ⇒ 给出过时结论；
4. ⚠ **缓存别做长期** ⇒ 曲库内容会变（用户新加歌）⇒ 长期缓存会给出**过时**的命中状态
   ⇒ 「二次进入不重打」只需要覆盖**同一次运行** ⇒ **进程退出即失效**最安全；
5. ⚠ **单测里模块级缓存会串用例** ⇒ 每个用例**必须用不同的榜单 id**。

### 五、复验结果

| 项 | 实测 |
|---|---|
| `tsc` | **0 错** |
| Vitest | **153 文件 / 3 071 条全绿**（原 152 / 3 066 ＋ 新增 1 文件 5 条；**既有测试一条没删、断言一条没弱化**） |
| Playwright | **73 passed** |
| `build` | exit **0** |
| 字节体检 ＋ 控制字符 | **bad=0** |

### 六、如实标注的边界

- ⚠ **真机首屏耗时待装版后实测**（榜源 + 匹配的真实秒数）；
- ⚠ 匹配**仍是逐个歌手定向查**（**不改判定口径**）⇒ 真正的提速要靠服务端；
- ⚠ 「为你推荐」那块**仍是 await**（它是**另一个 Tab**，不挡榜单）⇒ 本轮**不动**；
- ⚠ 缓存**跨进程不保留**（重启应用后重新匹配）—— **有意为之**；
- ⚠ 本轮**未发版**。

### 七、遗留 / 待办（第二组剩下的）

- ⏳ 曲库分页 / `normalizePageNumber()` 的**上界 clamp**（`size` 已 clamp ≤ 2000；
  **页码上界仍未夹** ⇒ 需先实测服务端对超大 `page` 的行为再定上界，**不猜**）；
- ⏳ 歌单面板**排序 / 分页**（⚠ 台账 T42 已记：真实账号 `playlist/list` 实测 `total=0`
  ⇒ **对用户无实际价值** ⇒ 本轮**不做**，待用户拍板）；
- ⏳ MP4/M4A **尾读 moov**（条目出处待定位）；
- ⏳ README `### Code signing policy` ＋ `.github/CODEOWNERS`；
- ⏳ `scripts/pack.cjs` 跨卷 EXDEV / 占用兜底（老问题 **T62**）；
- ⏳ `test/mock-server.test.ts` 的 `bad port` 偶发飘红（既有并发端口竞态）。

## 第一百零四节、T125：页码上界 clamp（离谱页码兜底）（2026-11-20）

> 起因：T123 / T124 的遗留里连着挂了同一条 ——「曲库分页 / `normalizePageNumber()` 的**上界 clamp**
> （`size` 已 clamp ≤ 2000；**页码上界仍未夹** ⇒ 需先实测服务端对超大 `page` 的行为再定上界，**不猜**）」。
> 用户 2026-11-20 明确要求：「**先实测服务端对超大 page 的行为，再实现并验证页码上界 clamp**」
> ⇒ 本节是**第二组（修既有缺陷）的第三项**。

### 一、真机实测（**先测，再定**）

- 环境：本机 ＋ **FN 中继** ＋ **真实 NAS**；账号：**用户本人的真实账号**（**只读 GET**，不写任何数据）；
- 曲库：`total = 173 671` 首；日期：**2026-11-20**；
- 探针：`release/verify/t125-01-probe-big-page.mjs`（`release/verify/**` 是 gitignored ⇒ **不入库**）；
- 证据：`release/verify/t125-01-big-page-probe.json`（同不入库）。

| 请求 | 实测结果 | 耗时 |
|---|---|---|
| `page=1&size=50` | 50 条，首曲「茨厂街…」 | 5 186 ms（首请求含连接建立） |
| `page=1&size=2000` | **2000 条** | 1 120 ms |
| `page=1&size=2001` | **静默回落成 50 条**（服务端默认页长） | 309 ms |
| `page=1000&size=50` | 首曲「勇敢一点 - Live」⇒ **翻页正常** | — |
| `page=10000 / 100000 / 10000000 / 999999999999 / 0 / -5` | **全部** `code=0`、**50 条**、首曲 = **第一页那首** | 303 / 429 / 327 ms（重复 3 次，**不变慢**） |

⚠ **结论**：服务端对**越界 / 非法 page 一律静默回退第一页** —— **不报错、不返回空**。
⇒ 客户端**猜不出**服务端到底回了第几页 ⇒ 义务不是「探测」，而是**别把离谱页码发出去**。

### 二、代码事实（不是推测）

| 事实 | 出处 |
|---|---|
| `normalizePageNumber()` **只夹下界**（≥ 1），**无上界** | `src/api/client.ts`（改前） |
| `normalizePageSize()` 已夹到 `MAX_PAGE_SIZE = 2000`（与服务端实测上限一致） | `src/api/client.ts` |
| 业务模块的 `page` **都过** `normalizePageNumber()` | `src/api/library.ts` / `search.ts` / `playlist.ts` / `history.ts` |
| ⚠ **两个出口没归一**：`fetchAllByPaging()` 的循环页码、`fetchScanPage()` 的扫描页码 | `src/api/client.ts` / `src/api/library.ts`（改前） |
| 翻页护栏已有**两道**：按 `total` 判 `hasMore` ＋ `LIBRARY_MAX_NO_PROGRESS_PAGES = 3` | `src/state/libraryStore.ts` |
| 合并按 **id 去重** ⇒ 服务端回第一页**不会**把重复条目灌进列表 | `src/state/libraryStore.ts` 的 `loadPage()` |

### 三、改动清单（**4 个文件**）

| 文件 | 动作 |
|---|---|
| `src/api/client.ts` | ＋`MAX_PAGE_NUMBER = 1_000_000`（**绝对上界**）；`normalizePageNumber()` **夹上界**；`fetchAllByPaging()` 的页码**也过归一**，`maxPages` 一起夹 |
| `src/api/library.ts` | `fetchScanPage()` 的页码**也过归一**；`scanLibraryTracks()` 的 `startPage` / `maxPages` **一起夹** |
| `test/t125-page-number-clamp.test.ts` | **新建**：4 条钉子 |
| `docs/superpowers/specs/2026-11-20-sanlos-music-t125-page-number-clamp.md` | **新建**：规格 |

### 四、⚠ 三个容易做错的地方

1. ⚠ **上界不能用 `total` 推**：真正合法的上界 = `ceil(total / size)`，
   但它**依赖服务端返回的 `total`**（会随曲库变化）⇒ 曲库**变大**时旧 `total` **偏小**
   ⇒ 会**静默截断新增曲目**（回归）⇒ 上界只能是**绝对常量**；
   - 取值 **1 000 000 页**：× 50 条/页 = **5000 万首** = 实测曲库（3474 页）的 **288 倍**
     ⇒ 真实曲库**永远碰不到**它；
2. ⚠ **这个上界不是「越界保护」**：真正防越界的是客户端现有**两道护栏**
   （按 `total` 判 `hasMore` ＋「3 页无进展」护栏）⇒ 文档必须写清，**免得后人误以为夹了上界就安全**；
3. ⚠ **自增页码的循环**：只夹「发出去的页码」而**不夹循环上限** ⇒ 页码到上界后被夹成**同一个值**
   ⇒ **同一个请求被反复重发**（且永远取不到新数据）⇒ 循环上限必须**一起夹**。

### 五、钉子（**4 条**）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | `normalizePageNumber(1e12 / 1e300 / MAX_SAFE_INTEGER)` ⇒ `MAX_PAGE_NUMBER`；上界之内（3474 页）**原样通过** | 「有上界」＋「不截断真实曲库」 |
| ② | 既有归一语义**一条没变**（0 / -3 / NaN / Infinity ⇒ 1、2.9 ⇒ 2、5 ⇒ 5） | 「不许弱化既有断言」 |
| ③ | `libraryApi.songs(1e300, 50)` ⇒ 真的发出去的是 `page=1000000`（**十进制整数**，不是 `1e+300`） | 「夹在**出口**生效」 |
| ④ | 曲库**变大**（total 50 → 120）⇒ 页码一路 1 → 2 → 3，**新增曲目一条不少** | 「**不**按 `total` 夹页码」 |

### 六、变异自证（**4 个变异，各自只被对应钉子抓住**）

| 变异 | 红了 | 判据 |
|---|---|---|
| M1 去掉上界（回到「只夹下界」） | ① ③ | OK |
| M2 store 层改成「按 `total` 夹页码」 | ④ | OK |
| M3 小数不向下取整（`floor` → `ceil`） | ② | OK |
| M4 `libraryApi.songs` 出口漏掉归一 | ③ | OK |

⚠ **这一轮踩的坑**：变异脚本**没有在每个变异之间还原** ⇒ M1 的坏改动**污染**了 M2 / M3 的结果
（看到「四条全红」还以为钉子没分辨力）⇒ **每个变异必须从干净基线出发**。

### 七、复验结果

| 项 | 实测 |
|---|---|
| `tsc` | **0 错** |
| Vitest | **154 文件 / 3 075 条全绿**（原 153 / 3 071 ＋ 新增 1 文件 4 条；**既有测试一条没删、断言一条没弱化**） |
| Playwright | **73 passed** |
| `build` | exit **0** |
| 字节体检 ＋ 控制字符 | **bad=0** |
| 变异自证 | **MUTATION_OK**（4 / 4 判据 OK ＋ 还原校验 OK） |

### 八、如实标注的边界

- ⚠ 服务端「越界静默回第一页」是**服务端行为**，客户端**改不了**（只能**不越界请求**）；
- ⚠ 上界是**兜底荒谬值**，**不是**越界保护（见 §四.2）；
- ⏳ 真机上「翻到曲库末尾（第 3474 页）」**待装版后实测**；
- ⚠ 本轮**未发版**。

### 九、遗留 / 待办

- ⏳ 组 B 剩余：MP4/M4A **尾读 moov**（条目出处待定位）、歌单面板排序 / 分页（**建议跳过**，待用户拍板）；
- ⏳ 组 C：`/search/playlist`、`/search/suggest`、`/artist/list-all`、`/initialization/state`；
- ⏳ 组 D：`mock-server` 端口竞态、T118「扫描落盘覆盖补拉封面」、README `### Code signing policy` ＋ `.github/CODEOWNERS`、`scripts/pack.cjs` 跨卷 EXDEV（T62）。

## 第一百零五节、T126：MP4 / M4A 的 `moov` 读不全 / 在文件尾 ⇒ 内嵌歌词读不到（2026-11-20）

> 起因：台账 T83 遗留原文「⚠ **MP4/M4A 的 `moov` 在文件尾** ⇒ 内嵌歌词**读不到**
> （头读拿不到 `©lyr`）⇒ 另开一轮（**尾读 `Range: bytes=-N`**）」——
> 本轮**先定位、再实测、最后动手**（用户 2026-11-20 拍板「ABCD 全做」⇒ **第二组第三项**）。

### 一、定位结论（**只有流式层受影响**）

| 项 | 结论 |
|---|---|
| 受影响的层 | **只有「流式层」**（NAS 在线播放、没下载、没本地文件）——`electron/embeddedLyric.ts` ③ 分支**只读头 64 KB** |
| **本地文件层不受影响** | T42 已改成走**顶层原子表按偏移找 `moov`**（随机访问）⇒ 文件尾的 `moov` 也能找到 |
| 真正的缺口 | 「**头读窗口不够**」的**两种**：**G1** `moov` 在文件尾；**G2** `moov` 在头但**超过 64 KB 窗口**（实测那首的 `moov` 有 **212 KB**） |

### 二、真机实测（2026-11-20，本机 ＋ FN 中继 ＋ 真实 NAS，**只读 GET**）

- 曲库 `total = 173 671`；扫前 20 000 首的格式分布：
  `mp3 17 965 / flac 1 319 / wav 665 / ape 13 / dts 15 / **m4a 14** / wma 9`；
- 探针 `release/verify/t126-01…04-*.mjs` ＋ 证据 `t126-0*-probe.json`（**gitignored ⇒ 不入库**）。

**① 服务端支持尾读**

| 请求 | 实测 |
|---|---|
| 无 Range | **200**，`content-length: 43379841`（整文件），`accept-ranges: bytes` |
| `Range: bytes=0-0` | **206**，`content-range: bytes 0-0/43379841` ⇒ 能拿**总长度** |
| `Range: bytes=0-65535` | **206**，65536 字节（现状：读头） |
| **`Range: bytes=-65536`** | **206**，`content-range: bytes 43314305-43379840/43379841` ⇒ **确实是文件尾** |
| `Range: bytes=-1024` | **206**，`content-range: bytes 43378817-43379840/43379841` |
| `Range: bytes=100-199` | **206**，`content-range: bytes 100-199/43379841` |

⚠ **尾读很快**（215 / 116 ms），**从头读反而慢**（4–7 s）⇒ 尾读**不贵**。

**② 这台 NAS 的 m4a 是 faststart，且没有内嵌歌词**（**全部 14 首**逐首量）

| 指标 | 实测 |
|---|---|
| `moov` 在**文件头** | **14 / 14**（偏移 32） |
| `moov` 在**文件尾** | **0 / 14** |
| `ilst` 在**头 64 KB 内** | **14 / 14**（偏移 10 304 – 19 360） |
| 带 `©lyr`（内嵌歌词） | **0 / 14** |
| `moov` 原子大小 | 样本《无眠》= **217 027 字节**（212 KB）⇒ **超过 64 KB 窗口** |

⚠⚠ **两条必须如实写下的结论**：

1. 这台 NAS 的 m4a **现有流式层已经能解析**（`ilst` 在头内）⇒ 本轮修复**对这台机当前文件没有可见变化**；
2. 这台机的 m4a **本身没有内嵌歌词** ⇒ 即便修复，也**读不出歌词**（没有词可读）。

⇒ 本轮修的是**机制缺口**，**这台机上没有实例**⇒ 机制用**合成样本**验（如实标注，**不假装验过**）。

### 三、改动清单（**8 个文件**）

| 文件 | 动作 |
|---|---|
| `electron/audioTags.ts` | ① 抽出 **`parseMp4MoovContent()`**（moov 内容 → 标签，本地文件层与流式层**共用一份**）；② 导出 **`findMp4AtomInBuffer()`**（走顶层原子表定位 `moov` 的**绝对偏移＋大小**）；③ 新增 **`findMp4MoovInTail()`**（尾段里按签名 ＋ **大小自洽校验**定位，返回**是否完整**）；④ 导出 **`isMp4Container()`** |
| `electron/embeddedLyric.ts` | ① 新增**可选**依赖 **`fetchStreamRange?(guid, start, length)`**（`start < 0` ＝ 尾读，返回 `{ bytes, totalSize }`）；② 流式层：**是 MP4 且没拿到歌词** ⇒ 补读一次（**G2 续读** / **G1 尾读**）；③ 新增 `parseContentRangeTotal()` |
| `electron/main.ts` | 实现 **`fetchStreamRange`**：`Range: bytes=start-end`（尾读用 `bytes=-N`）＋ 从 `Content-Range` 取总长 ＋ **读满即断**（不把整首歌拉下来） |
| `mock-server/fixtures.ts` / `mock-server/server.ts` | 加一首「**`moov` 在文件尾**的 MP4」（**按实例注入** ⇒ 共享 fixtures 一条不改）；`track/stream` 对它返回该 MP4 |
| `test/t126-mp4-tail-lyrics.test.ts` | **新建**：6 条钉子 |
| `e2e/t126-mp4-tail-lyric.spec.ts` | **新建**：真 Electron（尾读 ⇒ 内嵌歌词出现 ＋ 来源如实显示） |
| `docs/superpowers/specs/2026-11-20-sanlos-music-t126-mp4-tail-lyrics.md` | **新建**：规格 |

### 四、⚠ 四个容易做错的地方

1. ⚠ **尾段里不能走顶层原子表**：尾段是从文件中间**截断**的，第一个字节多半在某个原子的**载荷中间**
   ⇒ 只能**按 `'moov'` 签名找** ＋ **大小自洽校验**（`size < 8` 不是原子头；`size == 0` ＝ 延伸到文件尾；
   否则必须**完整落在尾段里**才算完整）；
2. ⚠ **从尾往头扫**：真正的 `moov`（在文件尾时）通常是**最后一个**顶层原子
   ⇒ 音频数据里的同名字节更靠前 ⇒ 先命中的是**更可能真的**那个；
3. ⚠ **尾窗口装不下时**（`complete === false`）：用 `Content-Range` 的**总长度**换算 `moov` 的
   **绝对偏移**后**整读** ⇒ **不必加大窗口**；
4. ⚠ **只对 MP4 补读**：别的容器头读就够 ⇒ 不白花请求（钉子 ⑥）；**也不扩大头窗口**（64 KB 是既有契约）。

### 五、钉子（**6 条**）＋ 变异自证（**5 个**）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | 尾段里能定位 `moov`（完整时内容齐全）⇒ 解析出 `©lyr` | 「尾读能找到 moov」 |
| ② | 头里能定位 `moov` 的**绝对偏移＋大小** | 「续读的前提」 |
| ③ | **对照组**：没有 `moov` / 有个**假的** `moov` 签名 ⇒ 不许当成真的 | 「不许误命中」 |
| ④ | 流式层：G1（尾读）⇒ 拿到歌词，且**只补读一次** | 「尾读这条路通」 |
| ⑤ | 流式层：G2（续读）⇒ 拿到歌词，且**只补读一次** | 「续读这条路通」 |
| ⑥ | **非 MP4**（MP3 流）⇒ **一次都不补读** | 「不白花请求」 |

| 变异 | 红了 | 判据 |
|---|---|---|
| M1 尾段校验坏掉（不再跳过「比原子头还小」的 size） | ③ | OK |
| M2 流式层去掉 G2 续读 | ⑤ | OK |
| M3 流式层去掉 G1 尾读 | ④ | OK |
| M4 MP4 判断坏掉（恒说「不是 MP4」） | ④ ⑤ | OK |
| M5 `©lyr` 不透传 | ① ④ ⑤ | OK |

### 六、复验结果

| 项 | 实测 |
|---|---|
| `tsc` | **0 错** |
| Vitest | **155 文件 / 3 081 条全绿**（原 154 / 3 075 ＋ 新增 1 文件 6 条；**既有测试一条没删、断言一条没弱化**） |
| Playwright | **74 passed**（原 73 ＋ 新增 1 条） |
| `build` | exit **0** |
| 字节体检 ＋ 控制字符 | **bad=0** |
| 变异自证 | **MUTATION_OK**（5 / 5 判据 OK ＋ 还原校验 OK） |

### 七、如实标注的边界

- ✅ **已验**：服务端**支持**尾读 `Range: bytes=-N`（206 ＋ 正确的 `content-range`）；
- ✅ **已验（机制）**：合成样本（`moov` 在尾 ＋ `©lyr`）⇒ 修前读不到、**修后读得到**（单测 ＋ 真 Electron E2E）；
- ⚠ **这台 NAS 上没有实例** ⇒ 真机上**看不到可见变化**（m4a 都是 faststart ＋ 都没有 `©lyr`）；
- ⚠ E2E 里的 MP4 **音频不可解码**（`mdat` 是占位字节）⇒ 该用例**不断言「能播」**，**不假装验过播放**；
- ⚠ 本轮**未发版**。

### 八、遗留 / 待办

- ⏳ 组 B 剩余：歌单面板**排序 / 分页**（⚠ 台账 T42 已记真实账号 `playlist/list` 实测 `total=0`
  ⇒ **对用户无实际价值** ⇒ **建议跳过**，待用户拍板）；
- ⏳ 组 C：`/search/playlist`、`/search/suggest`、`/artist/list-all`、`/initialization/state`；
- ⏳ 组 D：`mock-server` 端口竞态、T118「扫描落盘覆盖补拉封面」、README `### Code signing policy`
  ＋ `.github/CODEOWNERS`、`scripts/pack.cjs` 跨卷 EXDEV（T62）。

## 第一百零六节、T127：接服务端的「搜索建议」端点 `/search/suggest`（组 C 第一项）（2026-11-20）

> 起因：**ABCD 全做**里的 **C 组（接没用过的既有端点）**。
> T119 扒 NAS 自托管的 Web 前端时反解出 **19 组 / 92 条**端点，其中 4 条客户端一直没用：
> `/search/playlist`、`/search/suggest`、`/artist/list-all`、`/initialization/state`。
> 用户拍板「先做 C 组（接 4 个端点）」⇒ 实测后收窄为 **只做 T127 ＝ `/search/suggest`**
> （用户二次拍板：「只做 T127＝/search/suggest（推荐）」）。

### 一、实测依据（**2026-11-20 真机**，FN 中继 ＋ 真实 NAS，**只读 GET**）

探针：`release/verify/t127-01-probe-endpoints.mjs`、`release/verify/t127-02-probe-suggest.mjs`
（**gitignored**，不入库）；对照组用 `/album/list`（已知可用）⇒ 证明探测链路本身通。

#### 1. 四个端点的实测形状

| 端点 | 实测 | 结论 |
|---|---|---|
| `/artist/list-all` | `code=0`；**分页参数被忽略**（`?size=1&page=1` 仍回 **14 875 条全量**）；耗时 **15.3 s / 14.2 s**；字段只有 `guid/name/coverId/createdAt/updatedAt` | ❌ **不接** |
| `/search/suggest` | 参数名 **`q`**；返回四段 `{track, album, artist, playlist}`；每段 `{total, items}`；**带 `score`**；耗时 **1.39 / 1.65 / 1.42 s** | ✅ **本任务接它** |
| `/search/playlist` | `code=0` 恒 `total=0`；对照组 `/playlist/list` 也 `total=0` | ❌ **不接** |
| `/initialization/state` | `code=0`，`data = { initialized: true }`，**只此一个字段**，174 ms | ⏳ **留给 T128** |

#### 2. `/search/suggest` 的六条行为事实（**逐条实测，不是推测**）

| # | 事实 | 实测 |
|---|---|---|
| ① | **参数名是 `q`** | `?q=音乐` ⇒ `code=0`；`?keyword=音乐` ⇒ **`code=100002 invalid arguments`** |
| ② | **空 `q` 会被服务端拒** | `?q=` ⇒ `code=100002`；`?q=%20%20%20`（纯空格）⇒ `code=0` 但四段全空 |
| ③ | **`size` 被忽略** | `size=1 / 3 / 20 / 100` ⇒ 每段都是 `total=5`、`itemsLen=5` |
| ④ | **`page` 被忽略** | `page=1` 与 `page=2` 的首条标题**逐字相同** ⇒ **固定 top-5** |
| ⑤ | **返回「四段 ＋ 每段 `{total, items}`」**，**不是** `{list, total}` | `data = { track, album, artist, playlist }`，每段 `{ total, items }` |
| ⑥ | **服务端是模糊匹配** | `q=zzz不存在的词zzz` 仍回 5 首 ＋ 5 张专辑（「不存在的存在」「世界上不存在的歌」） |

#### 3. ⭐ 白捡的发现：`score` 客户端一直丢掉了

`/search/track`（**客户端现在就在用**）的条目**本来就带 `score`**（实测 `2.195477722355097`）
⇒ 客户端的 `mapSong` 把它丢了。本轮顺手把它接住（**可选字段**）。

#### 4. ⭐ 顺带发现的真缺陷（**不在本任务范围**，另立编号任务）

NAS 重启后首次请求撞上 **30 s 超时**时，主进程协议代理返回的是**业务信封**
`{ code: -1, msg: '无法连接音乐服务（网络不可达或服务未响应）' }`
⇒ `apiCall` 抛的是 **`ApiError`（业务错误）而不是 `ApiNetworkError`（网络错误）**
⇒ 渲染层按错误类型区分「可重试 / 服务端拒绝」会**误判**。
（实测数据：`t127-02-suggest.json` 的 `size_1` / `size_3` 两次各 30 s 超时。）

### 二、范围（**做什么 / 不做什么 / 为什么**）

| 端点 | 不做的理由（**实测数字**） |
|---|---|
| `/artist/list-all` | 比现有 `/artist/list` **慢 9.5 倍**（15.3 s vs 1.6 s）、**字段更少**（没有 `trackCount`/`albumCount`）、**分页参数被忽略**（一次回 14 875 条全量）⇒ **零增量价值**，接了反而更慢 |
| `/search/playlist` | 这台机 **0 个歌单**（`/playlist/list` 对照组同样 `total=0`）⇒ 恒空列表；客户端已有 `/playlist/list` 全量接口 |
| `/initialization/state` | 有价值（连接自检），但**落点要另定** ⇒ **留给 T128** |

**明确不改**：既有三段搜索的行为（`/search/track`、`/search/album`、`/search/artist`）、
分页 / 排序 / 收藏 / 歌单写回；既有测试**一条不删、一条不弱化**。

### 三、设计

- **数据流**：防抖 `SEARCH_DEBOUNCE_MS`(300) 后**两条链**（既有三段完整搜索 ＋ 新增建议）
  **并发**、互不等待 ⇒ 建议（1.4 s）**先出**、完整结果（5.8 s）随后补上；
  两条链**共用同一个代次** `generationRef` ⇒ 过期响应一律丢弃（复用既有机制）。
- **API 层**：`searchApi.suggest(q)` **只打** `/search/suggest?q=`，**不发** `page`/`size`
  （实测服务端**忽略**它们 ⇒ 发它们只是噪音）；**空 / 纯空格 `q` 客户端自己拦**
  （实测服务端回 `code=100002`）⇒ **一次请求都不发**；
  服务端的 `{total, items}` ⇒ 转成客户端的 `{list, total}`。
- **领域模型 `score`**：**只在服务端给了时才往领域对象上放这个键**（条件展开，
  **不是**无条件 `score: null`）⇒ 既有断言**零破坏**。
- **建议区**：**独立状态**（**不复用** `Section<T>`：建议没有分页、没有「加载更多」）；
  **不复用 `SongList`**（它带 `selectedIds` ⇒ 建议与完整结果会**共享选中态** ⇒ 语义混乱）
  ⇒ 用自己的轻量行渲染；**建议失败只显示在建议区**，**绝不影响**完整搜索结果；
  **不显示「命中 N」**（suggest 的 `total` 恒 5，是「给了几条」不是「总命中数」）；
  **不自己按 `score` 重排**（服务端已按相关性排序）。
- **`suggest` 是 `SearchPanelApi` 的可选方法** ⇒ 不提供时**不渲染建议区**
  （只读环境 / 老服务端没有这个端点）⇒ **既有的测试假接口一行都不用改**。

### 四、钉子（**8 条**，新文件 `test/t127-search-suggest.test.tsx`）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | `suggest('音乐')` ⇒ URL **恰为** `/search/suggest?q=音乐`，**不含** `page=`/`size=` | 端点路径 ＋ 不发无意义参数 |
| ② | 空 `q` / 纯空格 `q` ⇒ **一次请求都不发**，四段全空 | 客户端自己拦空关键字 |
| ③ | 服务端的 `{total, items}` ⇒ 客户端拿到 `{list, total}` | 形状转换 |
| ④-a | `score` 被透传 | 相关性分没丢 |
| ④-b | 服务端**没给** `score` ⇒ 领域对象里**没有这个键** | 条件透传 ＋ 零破坏 |
| ⑤ | suggest 成功 ⇒ 渲染出建议（歌曲 / 专辑 / 歌手三段） | 功能落地 |
| ⑥ | suggest **失败** ⇒ **完整搜索结果仍然正常显示** | 建议失败不污染搜索结果 |
| ⑦ | 建议区**不出现**「命中 N」 | `total` 恒 5，不是命中总数 |

⚠ **RED 阶段的真实状态**：**7 红 ＋ 1 绿** —— ④-b（「没给 `score` 时没有这个键」）
**在实现之前就绿** ⇒ 它是**回归护栏**（防「无条件 `score: null`」）
⇒ 靠**变异自证**（M4）抓，不靠 RED。**如实记录，不假装「8 条全红」。**

### 五、变异自证（**8 个变体**，各自只被对应钉子抓住）

| 变体 | 改什么 | 实际变红 | 结论 |
|---|---|---|---|
| **M1** | 建议端点打错（去掉 `/search/` 前缀） | **①** | ✅ |
| **M2** | 空关键字不再拦（照发请求） | **②** | ✅ |
| **M3** | 形状转换坏掉（`items` → `list` 写错） | **③** | ✅ |
| **M4** | `score` 改成**无条件**透传 | **④-b** | ✅ |
| **M5** | `score` 干脆不传 | **④-a** | ✅ |
| **M6** | 建议区不渲染（`hasSuggest` 恒假） | **⑤⑦** | ✅ |
| **M7** | 建议失败时把完整搜索结果也清掉 | **⑥** | ✅ |
| **M8** | 建议区显示「命中 N」 | **⑦** | ✅ |

⇒ `MUTATION_OK`（8/8）＋ 还原后**字节级一致**。
⚠ **每个变体之间都还原基线**（否则第 N 个变体会继承前面所有坏改动 ⇒ 判据失真）。

### 六、复验结果

| 项 | 实测 |
|---|---|
| 类型检查 | `tsc --noEmit` exit **0**（零错误） |
| 单元测试 | Vitest **156 文件 / 3 089 条全绿**（原 155 / 3 081 ＋ 新增 1 文件 8 条；**既有测试一条不删、断言一条不弱化**） |
| E2E | Playwright **新增 1 条 passed**（真实 Electron：建议区出现 ＋ 完整结果照常显示） |
| 构建 | `npm run build` exit **0** |
| 字节体检 | `release/verify/t115-10-bytes-check-all.mjs` ⇒ **bad=0** |
| 变异自证 | `release/verify/t127-05-mutation-check.mjs` ⇒ **`MUTATION_OK`**（8/8） |
| 提交 | `3a07f2a` 规格 → 实现 ＋ 钉子 ＋ mock ＋ e2e |
| 真机 | ⚠ **本轮的端点形状是真机实测的**；建议区的**界面行为**由**合成 mock ＋ 真 Electron E2E** 验（真 NAS 上 `/search/suggest` 有数据，但客户端**尚未发版** ⇒ 真机上跑不到新界面） |

### 七、遗留 / 待办

- ⏳ **v0.4.5 未发**（本轮改了行为 ⇒ 发版另立编号任务）；
- ⏳ **`/initialization/state`**（`{initialized: true}`，174 ms）⇒ **T128**（连接自检；落点待定）；
- ⏳ **主进程协议代理 30 s 超时返回业务信封 `code=-1`** ⇒ `apiCall` 抛 `ApiError` 而非
  `ApiNetworkError` ⇒ 渲染层的「可重试 / 服务端拒绝」判断会**误判** ⇒ 建议另立编号任务；
- ⏳ `/artist/list-all`、`/search/playlist` ⇒ **已实测、不接**（理由见 §二）；
- ⏳ `score` 已接住，但**界面还没用它排序**（服务端已排序 ⇒ 客户端不重排）；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU** ⇒ 要回按机器需 `/allusers`。
## 第一百零七节、T128：接服务端的「初始化状态」端点 `/initialization/state`（组 C 第二项）（2026-11-20）

> 起因：**ABCD 全做**里的 **C 组（接没用过的既有端点）** 的**第二项**。
> T119 扒 NAS 自托管的 Web 前端时反解出 **19 组 / 92 条**端点，其中 4 条客户端一直没用：
> `/search/playlist`、`/search/suggest`、`/artist/list-all`、`/initialization/state`。
> T127 接了 `/search/suggest`；本轮接 **`/initialization/state`**。
>
> ⚠ **只读**：`/initialization/prepare`、`/initialization/confirm` 是 **POST**
> 且要 **NAS 管理员权限** ⇒ 本客户端**绝不碰**。

### 一、实测依据（**2026-11-20 真机**，FN 中继 ＋ 真实 NAS，**只读 GET**）

| 项 | 实测 | 结论 |
|---|---|---|
| `GET /initialization/state` | `code=0`；`data = { initialized: true }`，**data 只有这一个字段**；耗时 **174 ms** | ✅ 本任务接它 |
| ⚠ 端点**不存在**时 | HTTP 200 但 body = **`null`**（T119 记录的判据）⇒ `apiCall` 因「响应不是预期信封」**抛错** | ⇒ **必须捕获**，**不能**当成「未初始化」 |

⚠ **口径**：上面的 `initialized: true` 是**这台 NAS、这个账号、这一天**的实测值。
飞牛音乐这个「应用」在**别的机器**上可能是 `false` ⇒ 界面才有提示。

### 二、⭐ 语义证据（扒 NAS 自托管的 Web 前端包，**代码级**，不是推测）

| 包 | 原文 | 含义 |
|---|---|---|
| `bdf49c3c…js` | `Ee = e => e.initialized ? e.currentUser ? '/' : '/login' : '/welcome'` | ⇒ `initialized === false` ⇒ 路由到 **`/welcome`（初始化引导页）** |
| `5e884898…js` | `DO = { mode: 'login', entryRoute: '/welcome', …, initialized: false, … }` | ⇒ 官方客户端的**默认态**就是「未初始化 + 去 `/welcome`」 |
| `8a84e406…js` | `k = y.data?.initialized === false`；`d === 'server-not-initialized' \|\| (!s.isDirty && k) ? t('clientLogin.serverNotInitialized') : …` | ⇒ **官方客户端自己**用这个字段判断，并在登录页显示「服务端未初始化」 |
| `5e884898…js` | 错误码 `110002 AppNotInitialized`、`110003 InitRequiresNASAdmin`、`110004 InitSessionNotFound` | ⇒ 初始化是**独立的一套流程**，要 NAS 管理员权限 |

⇒ **`initialized` ＝ 飞牛音乐这个「应用」有没有完成首次初始化（扫库 / 建索引）**，
**不是**「NAS 有没有登录」。
⇒ **未初始化 ⇒ 曲库索引没建好 ⇒ 搜索 / 建议 / 榜单必然是空的**
⇒ 客户端的价值 = **如实告诉用户「不是没找到，是服务端还没初始化」**。

### 三、设计：**三态**（`true` / `false` / **`null`＝未知**）

| 状态 | 含义 | 界面 |
|---|---|---|
| `true` | **已初始化** | 连接页事实项显示「音乐服务：**已初始化**」 |
| `false` | **未初始化** | 连接页事实项显示「音乐服务：**未初始化**」＋ **醒目提示**（`role="alert"`）＋ 搜索页空结果**换文案** |
| `null` | **未知**（老服务端没这端点 / 字段缺失 / 请求失败） | ⚠ **一个字都不显示** ⇒ 老服务端上界面**零可见变化** |

⚠ **「未知」绝不当成「未初始化」** —— 这是本任务**最重要**的一条约束。
⇒ 类型层面用 **`boolean | null`**（不是 `boolean`）⇒ 漏判空会**编译不过**。

⚠ **为什么放独立 store**（不塞 `sessionStore`）：既有断言 `Object.keys(session).sort()`
是**精确数组**（`test/login-page.test.tsx`）⇒ 往会话里加字段就**红**
⇒ 状态放 `src/state/initializationStore.ts`。
⇒ **什么时候拉**：`src/App.tsx` 监听 `connected` ⇒ 拉**一次**
（覆盖「手动登录」＋「会话恢复」两条路）⇒ **不轮询**。

### 四、两个落点

| 落点 | 位置 | 未初始化（`false`）时 | 其它状态 |
|---|---|---|---|
| **A 连接页** | `src/pages/LoginPage.tsx` 的「已连接」区块 | 事实项「未初始化」＋ `role="alert"` 提示：**「飞牛音乐服务尚未初始化（曲库索引还没建好）⇒ 搜索、建议、榜单都会是空的。请在飞牛音乐网页端完成初始化后再来。」** | `true` ⇒ 显示「已初始化」；`null` ⇒ **不显示** |
| **B 搜索页空结果** | `src/components/SearchPanel.tsx` | 换成「**服务端尚未初始化（曲库索引还没建好）⇒ 现在搜不到东西；请先在飞牛音乐网页端完成初始化**」 | `true` / `null` ⇒ 仍是「没有找到」 |

⚠ **提示文案里绝不能出现「已连接」三个字** —— 既有断言是 `findByText('已连接')`
⇒ 多一个匹配就**红**。
⚠ **新增事实项的值不能是 `'demo'`** —— 既有断言是 `getByText('demo')`（精确匹配）。
⚠ **既有 37 条 LoginPage 用例一条不许删 / 弱化**。

### 五、钉子（**8 条**，新文件 `test/t128-initialization-state.test.tsx`）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | 打 `/initialization/state`，服务端说已初始化 ⇒ `true` | 端点路径 ＋ `true` 透传 |
| ② | 响应里**没有** `initialized` ⇒ **`null`**（**不是 false**） | 缺失 ≠ 未初始化 |
| ③ | 端点抛错（老服务端 body = `null`）⇒ **不崩**，返回 `null` | 异常不炸界面 |
| ④ | store 的三态映射（`false`/`true`/`null` ⇒ `false`/`true`/`null`） | 三态不被压扁成布尔 |
| ⑤ | 连接页：`false` ⇒ 显示「未初始化」＋ **可行动**的提示 | 落点 A 生效 |
| ⑥ | 连接页：`true` ⇒ 显示「已初始化」，**不**显示未初始化提示 | 三态分流正确 |
| ⑦ | 搜索页空结果：`false` ⇒ 换文案（且**不再**显示「没有找到」） | 落点 B 生效 |
| ⑧ | **未知（`null`）⇒ 仍是「没有找到」，任何页面都不显示未初始化提示** | 「未知 ≠ 未初始化」 |

⚠ **⑤⑥⑧ 都必须走 store 的 `load()`**（不是直接 `setState`）
⇒ 否则「store 把未知当未初始化」这类缺陷**绕过了 store ⇒ 抓不到**
（踩过：第一轮变异 M4 抓不到 ⑧）。

### 六、变异自证（**8 个变体**，各自只被对应钉子抓住）

| 变体 | 改什么 | 实际变红 | 结论 |
|---|---|---|---|
| **M1** | 端点路径打错（`/init/state`） | **①** | ✅ |
| **M2** | 字段缺失被当成「未初始化」（`return false`） | **②** | ✅ |
| **M3** | 端点抛错不再捕获 | **③** | ✅ |
| **M4** | store 把「未知」当「未初始化」（`?? false`） | **④⑧** | ✅ |
| **M5** | 连接页不显示未初始化提示 | **⑤** | ✅ |
| **M6** | 连接页把「已初始化」也显示成未初始化 | **⑥** | ✅ |
| **M7** | 搜索页空结果不换文案 | **⑦** | ✅ |
| **M8** | 未知时也显示未初始化提示 | **⑧** | ✅ |

⇒ `MUTATION_OK`（8/8）＋ 还原后**字节级一致**。
⚠ **每个变体之间都还原基线**（否则第 N 个变体继承前面所有坏改动 ⇒ 判据失真）。
⚠ **认「红了哪几条」而不是「有没有红」** ⇒ 矩阵才有分辨力。
⚠ ⭐ **别用「用例名子串」认钉子**：⑧ 的用例名里含「不显示未初始化提示」，
⑥ 的用例名里**也含**它 ⇒ **子串匹配**会让 ⑥ **误命中** ⑧ 的失败行
⇒ 第一轮 M6「一条都没红」/ M8「红了两条」都是这个坑。
⇒ 正解：**用 vitest 的 JSON reporter**，按 `assertionResults[].title` 的**首字符**（①…⑧）精确认钉子。

### 七、复验结果

| 项 | 实测 |
|---|---|
| 类型检查 | `tsc --noEmit` exit **0**（零错误） |
| 单元测试 | Vitest **157 文件 / 3097 条全绿**（原 156 / 3089 ＋ 新增 1 文件 8 条；**既有测试一条不删、断言一条不弱化**） |
| E2E | Playwright 全量 **77 passed**（原 75 ＋ 新增 2 条） |
| 构建 | `npm run build` exit **0** |
| 字节体检 | `release/verify/t115-10-bytes-check-all.mjs` ⇒ **bad=0** |
| 变异自证 | `release/verify/t128-03-mutation-check.mjs` ⇒ **`MUTATION_OK`**（8/8） |
| 真机 | ⚠ **端点形状是真机实测的**；但**这台 NAS 的 `initialized` 恒为 `true`** ⇒ 真机上**看不到**「未初始化」界面 ⇒ 该界面由 **mock 注入 `false`** 证 |

### 八、遗留 / 待办

- ⏳ **v0.4.5 未发**（本轮改了行为 ⇒ 发版另立编号任务）；
- ⏳ **未实测**：「未初始化时能否登录成功」、「未登录时能否查这个端点」；
- ⏳ **主进程协议代理 30 s 超时返回业务信封 `code=-1`** ⇒ `ApiError` vs `ApiNetworkError` 误判 ⇒ 建议另立编号任务；
- ⏳ **`/artist/list-all`、`/search/playlist`** ⇒ 已实测、不接；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU** ⇒ 要回按机器需 `/allusers`。
## 第一百零八节、T129：发版 v0.4.5（2026-11-20）

> 起因：**ABCD 全做**里的 **C 组**已经收尾 ⇒ 但 **v0.4.4 之后积了 11 个 commit、8 项用户可感知的功能 / 修复**
> ⇒ **线上仍是 v0.4.4** ⇒ 已投入的研发价值**兑现率为 0** ⇒ **T129 = 发版 v0.4.5**。

### 一、发版链（**每一步都有证据**）

| 环节 | 结果 |
|---|---|
| 版本号（**四处同步**） | `package.json`（1 处）／ `package-lock.json`（**2 处**）／ `README.md`（**12 处**）／ `docs/changelog.md`（1 处）⇒ 全部 0.4.5，**零残留 0.4.4** |
| ⚠ **12 处不是 10 处** | README 行 112（`[Releases · v0.4.4](…/tag/v0.4.4)`）与行 125（`[docs/releases/v0.4.4.md](…)`）**各含两处** ⇒ 按「行」数会数成 10 |
| 规格 | `docs/superpowers/specs/2026-11-20-sanlos-music-v0.4.5-release.md`（先写死要做什么 / 怎么验 / 什么算过） |
| 发布说明 | `docs/releases/v0.4.5.md`（**CI 的 Release 正文来源** ⇒ 缺它工作流直接 `throw`） |

### 二、发版**前**的真机复验（**闸门**）

⚠ **为什么要先验**：v0.4.4 是「先发版、再装版复验」⇒ 万一有坑，**已经发出去了**
⇒ 这次先打一份带新代码的**本地自打产物**当闸门，**过了再发**。

| 手段 | 为什么这么选 |
|---|---|
| `npm run pack:probe`（输出到 `release-probe/`，gitignored） | 打出带新代码的产物；**不装** ⇒ **零注册表副作用** |
| ⚠ **产物路径要按时间戳找** | `pack.cjs` 是「删旧 ＋ 改名」搬到输出目录 ⇒ 旧目录被占用时**搬运失败** ⇒ 输出目录里留的是**上一版的旧产物**！实测：输出目录躺的是 **0.4.3**，真正的 0.4.5 在 `.pack-staging-<时间戳>/` ⇒ **只查输出目录会验错版本**（假红） |
| **隔离 userData** | 只复制 `session.bin` ＋ `Local State` ⇒ 真实账号 ＋ 真 NAS，但不碰真实偏好 / 下载目录 / 扫描状态 |
| 走 `sanlos://srv/...` | **不碰任何凭证**（token 只在主进程内存里） |
| **静音** | `webContents.setAudioMuted(true)` ⇒ 位置照走，但机器不出声 |

### 三、复验结果（**8 项全通过**，2026-11-20）

| 项 | 实测 | 结论 |
|---|---|---|
| `GET /initialization/state` | `code=0`；`data={initialized: true}` | ✅ |
| `GET /search/suggest?q=音乐` | `code=0`；歌曲 / 专辑 / 歌手各 `total=5`（`playlist` 0）；**共 15 条，15 条带 `score`**；首条 score `2.195477722355097` | ✅ |
| `GET /shared-library/list` | `code=0`；本机 **2 个**共享库（`name` 空串 ⇒ 用路径末段兜底） | ✅ |
| 连接页初始化状态 | 显示「**已初始化**」；未初始化提示条 0 条 | ✅ |
| 「共享」页 | 列出 **2 个**（显示名 1000-0-3d135437、music）；点进去有 **11** 个子目录 | ✅ |
| 搜索建议 | **2819 ms** 出现；歌曲 5 ＋ 专辑 5 ＋ 歌手 5；错误条 0 | ✅ |
| 「发现」页先出榜单 | 榜单 **299 ms** 出来（4 个榜）；命中数 **17463 ms** 后补上（31/50、10/50、0/50、0/50） | ✅ |
| 退出前补写「上次播放」 | 退出前 `updatedAt=1795178020665` ⇒ 退出后重开读到 **1795178027691**（**变新了** ⇒ 退出那一刻被重写过）；当时播放器 **0:20** | ✅ |

⭐ **T122 的遗留补上了**：台账里「⚠ 本轮未发版 ⇒ 真机复验（**装版后**打开「共享」页出 2 个库并能浏览出曲目）**待做**」
⇒ 本轮在**真实 NAS** 上验到：**2 个共享库** ＋ 点进去 **11** 个子目录。

### 四、⚠ 这一版**如实标注**的边界

1. ⚠ **页码上界** 与 **MP4 内嵌歌词补读** 是**纯代码级**的 ⇒ 真机上**没有可观测的界面差异**
   ⇒ 由自动化测试覆盖，**不假装真机验过**；
2. ⚠ **服务端「未初始化」那一支** 这台 NAS 的 `initialized` 恒为 `true`
   ⇒ 真机上**看不到** ⇒ 由 **mock 注入 `false`** 证；
3. ⚠ **发版前**这一轮验的是**本地自打产物**，**不是**线上 Release 的安装包
   ⇒ 「装版复验」是发布**之后**的另一轮；
4. ⚠ **产物仍然没有代码签名**（SignPath 申请已被拒）⇒ 替代信任锚是 GitHub 构建来源证明。

### 五、遗留 / 待办

- ⏳ **T130**：主进程代理 30 s 超时返回业务信封 `code=-1` ⇒ `apiCall` 抛 `ApiError`
  而不是 `ApiNetworkError` ⇒ 渲染层「可重试 / 服务端拒绝」判断**误判**；
- ⏳ **T131**：D 组卫生项（mock-server 端口竞态、T118「扫描落盘覆盖补拉封面」、
  README `### Code signing policy` ＋ `.github/CODEOWNERS`、`scripts/pack.cjs` 跨卷 EXDEV）；
- ⏳ **T132**：B 组最后一项「歌单排序 / 分页」（真实账号 `playlist/list` `total=0` ⇒ **只能靠 mock 验**）；
- ⏳ **T119 端点表订正**（`reconnect-check` 应为 `reconnect/check`）⇒ 历史段不篡改 ⇒ 另立小任务；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU** ⇒ 要回按机器需 `/allusers`。
## 第一百零九节、T129：发版 v0.4.5（发布后核对 ＋ 装版复验）（2026-11-20）

> 这一节记的是**发布之后**的那一轮：Release 核对 ＋ **把线上安装包装进 `D:\Sanlos Music`** ＋ **已装版**的真机复验。

### 一、Release 核对（公开 API，只读）

| 项 | 实测 |
|---|---|
| `draft` / `prerelease` | `false` / `false` |
| 发布于 | `2026-11-20T12:48:38Z` |
| 资产 | **3 个**：`latest.json`（472 B）、`SanlosMusic-Portable-0.4.5.exe`（79,046,880 B）、`SanlosMusic-Setup-0.4.5.exe`（86,143,023 B） |
| 资产 digest（GitHub 侧） | `latest.json` → `5c38a3588760f38b…`；`SanlosMusic-Portable-0.4.5.exe` → `140f1c50daea7daa…`；`SanlosMusic-Setup-0.4.5.exe` → `096c754b88f182a5…` |

### 二、装版（**原地升级**，不卸载旧版）

| 环节 | 实测 | 结论 |
|---|---|---|
| 升级前 exe 版本 | `0.4.4` | — |
| 升级后 exe 版本 | `0.4.5` | ✅ |
| 已装 asar 标志 | **8/8**（① 共享库页(shared-library)、② 退出前补写(beforeunload/pagehide)、③ 发现页先出(discover/chart)、④ 页码上界(1e6)、⑤ MP4 补读(moov)、⑥ 搜索建议(search/suggest)、⑦ 初始化状态(initialization/state)、⑧ 相关性分（弱标志）(score)） | ✅ |
| 卸载项 | `Sanlos Music 0.4.5`（HKCU） | ✅ |
| 用户数据 | `session.bin` sha256 b7430e29ed9c ⇒ b7430e29ed9c（**逐字未变**） | ✅ |

⚠ **本机没装程序在跑**才装（脚本会先查 `tasklist`，发现就在跑就**停下**，**不替用户杀进程**）。

### 三、已装版的真机复验

隔离 userData（只带 `session.bin` ＋ `Local State`）＋ 走 `sanlos://srv/...`（不碰凭证）＋ **静音**：

- ✅ `ep-init` 探针：/initialization/state —— {"http":200,"code":0,"initialized":true,"raw":"{\"code\":0,\"msg\":\"\",\"data\":{\"initialized\":true}}"}
- ✅ `ep-suggest` 探针：/search/suggest（固定 top-5 ＋ 带 score） —— {"ok":true,"http":200,"code":0,"msg":"","segs":{"track":{"total":5,"len":5},"album":{"total":5,"len":5},"artist":{"total":5,"len":5},"playlist":{"total":0,"len":0}},"totalItems":15,"withScore":15,"firstTitle":"音乐节","firs
- ✅ `ep-shared` 探针：/shared-library/list —— {"http":200,"code":0,"count":2,"names":["",""],"paths":["/vol02/1000-0-3d135437","/vol1/1000/music/music"]}
- ✅ `ui-init` 界面：连接页显示「音乐服务：已初始化」且无未初始化提示 —— {"factValue":"已初始化","noticeCount":0}
- ✅ `ui-shared` 界面：共享页列出共享库并能浏览 —— {"count":2,"names":["1000-0-3d135437","music"],"emptyText":null,"browsed":{"trail":"1000-0-3d135437","folders":11,"tracks":0,"empty":null}}
- ✅ `ui-suggest` 界面：搜索页建议区出现 —— {"ms":2331,"tracks":5,"albums":5,"artists":5,"errorCount":0}
- ✅ `ui-discover` 界面：发现页榜单先出（命中异步补） —— {"boardsMs":301,"boards":4,"matchMs":16450,"boardsFirst":true,"countSamples":["31/50","10/50","0/50","0/50"]}
- ✅ `ui-resume-flush` 界面：退出前补写「上次播放」（退出后位置比退出前更新） —— {"quitVia":"close window (closeBehavior=quit)","before":1795179291284,"after":1795179298312,"playerPositionText":"0:20","p1":{"raw":"{\"id\":\"ce34e3d4f1d84e84ae98ccd582fba96d\",\"title\":\"音乐节\",\"artist\":\"A1Trip / Ni

**合计 8/8 通过。**

### 四、⚠ 如实标注

1. ⚠ **线上 Release 正文** 是 CI 在**发版那一刻**读 `docs/releases/v0.4.5.md` 生成的
   ⇒ 本地文件**事后**补的「十四、已装版复验」段**原本不在**线上正文里
   ⇒ ✅ **已另行同步**（2026-11-20，走 GitHub 网页编辑页）：线上正文现为 **8902 字符**，
   行尾被网页表单**统一成 CRLF**（原本是「CI 写的 LF ＋ 表单追加的 CRLF」的混合行尾），
   ⇒ **内容与本地逐字一致**（行尾归一化后相同）；
   ⇒ **字节 sha256 与本地文件不同属预期**（网页表单的换行序列化规定用 CRLF）；
2. ⚠ 产物**仍然没有代码签名**（SignPath 申请已被拒）⇒ 替代信任锚是 **GitHub 构建来源证明（attestation）**；
3. ⚠ 页码上界 ＋ MP4 内嵌歌词 仍是**纯代码级** ⇒ 真机无可见差异 ⇒ 靠自动化测试。
