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
| **服务端转码** | `track/transcode` 返回 `code=100001` → **不可用** | `tools/fn-transcode-probe.mjs` |
| **兜底方案** | 改为**客户端 FFmpeg** 转 Opus（见 README 常见问题） | `tools/ffmpeg-verify.mts` |
| **本机 FFmpeg 覆盖度** | 9.0.2（Gyan full build）→ 支持 12 种容器：`ape`/`alac`/`dsf`/`wma`/`dts`/`aiff`/`ra`/`au`/`dvf`/`tta`/`dss`/`mmf`；**仅 `dff` 不支持**（无 `dsdiff` 解封装器） | `tools/ffmpeg-verify.mts` |
| **中继链路是硬性关卡** | 不带 `mode=relay` Cookie → 返回 HTML 错误页 | `tools/fn-httstack-verify.mjs` |
| **中继候选可达性** | `https://<fnId>.fnos.net` 命中；当前网络下内网/公网 v4/v6 不可达 | `tools/fn-probe.mjs` |
| **播放历史端点** | `GET /music/api/v1/play-history/list` → `total=414`，条目为**完整歌曲对象** | `tools/fn-history-probe.mjs` |
| **曲库编码分布** | 含 `alac` 46 首等 → **APE / ALAC 可以走兜底播放** | `tools/fn-codec-census.mjs` |
| **中继端口** | 中继**只监听标准 HTTPS 端口 443**，**不监听** 5666 / 5667 | `tools/fn-live-check.mjs`（不写端口登录失败 → 写 `:443` 成功） |
| **专辑详情取法** | `GET /album/detail?guid=<id>`；`data` 是**裸专辑对象**（不是 `{list,total}`）。用 `albumGUID` / `albumGuid` / `albumId` / `id` 一律 `code=100002` | `tools/fn-album-detail-probe.mjs` |
| **服务端没有写接口** | 17 个候选写端点全是 SPA 兜底 HTML；`stream` **不写**播放历史 → **NAS 历史只读**，客户端「本机记录 + NAS 只读」的设计正确 | `tools/fn-history-probe.mjs` |
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
