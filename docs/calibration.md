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

### T19-3：规格 §5.4 的「续期失败 → 回登录页」**尚未实现**（待办）

规格 §5.4 写的是：「token 失效（99999）→ 静默续期一次；**失败则派发 `auth-lost` 事件回到登录页**」。

实测代码后的结论：

- ✅ 「静默续期一次」**已实现**（主进程 `electron/session.ts` 的 `request()`），且触发条件经 T19-1 实测成立；
- ❌ 「失败则派发 `auth-lost` 回到登录页」**整条链路都不存在**：
  全仓库只有规格文档里出现过 `auth-lost` 这个名字，
  `src/` 与 `electron/` 里**没有任何**地方检查 `99999`、也没有任何地方派发类似事件。
  `sessionStore.reset()`（登出）虽然存在，但**没有任何调用点**。

**后果**：token 真的过期、且**续期也失败**时（例如用户改了 NAS 口令、或续期那一刻中继不通），
用户只会看到当前页面冒出一句 `INVALID TOKEN`，而且**之后每个请求都会再失败一次**，
界面停在「已登录」的死状态里；只有自己点「连接 → 退出登录」才能脱身。

**建议的修法（尚未实施，待拍板）**：在渲染进程唯一的 API 出口（`src/api/client.ts` 的
`requestJson`）识别 `ApiError.code === 99999` → 触发一次「会话失效」通知 →
`App` 里 `sessionStore.reset()` + 切回「连接」页 + 提示「登录已失效，请重新登录」。
纯渲染层改动，不碰凭证与出网边界。


