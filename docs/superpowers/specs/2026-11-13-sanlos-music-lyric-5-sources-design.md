# T90 设计规格：歌词源对齐洛雪 5 源 + 罗马音三行

- 日期：2026-11-13
- 状态：已获用户批准（三项决策，见 §1.2）
- 关联：`T74a`（酷狗 KRC 源，**曾实现后整体回滚**，规格与实测数据仍有效）、
  `T33`（QQ 行级源，已实现）、`T81`（词级时间戳门槛，已实现）

---

## 1. 起因与用户拍板

### 1.1 起因

用户问：「知道洛雪音乐用的是什么歌词 API 吗？能接入到我们的软件吗？」

⇒ 调研洛雪（`lyswhut/lx-music-desktop`，Apache-2.0）的歌词实现后确认：
**洛雪没有「一个歌词 API」，而是逐平台直连官方 Web 接口**，
且在「真逐字 + 翻译 + 罗马音」三件事上**比我们做得好**。

### 1.2 用户拍板（2026-11-13，问卷三题全选）

| 决策点 | 结论 |
| --- | --- |
| 接法 | **补 QQ 逐字**（`musicu.fcg` + QRC 解密） |
| 范围 | **再补酷狗 / 酷我 / 咪咕**，对齐洛雪 5 源 |
| 罗马音 | **一起做成原文 / 翻译 / 罗马音三行**（不是只取回不展示） |

### 1.3 与既有工作的关系（**不重复劳动**）

| 既有工作 | 状态 | 本任务怎么用 |
| --- | --- | --- |
| `T74a` 酷狗 KRC 源 | **已实现后整体回滚**（2026-11-10，用户当时改方向「先修观感、不追词源」） | 规格文档 `docs/superpowers/specs/2026-11-10-sanlos-music-kugou-krc-lyric-source-design.md` **仍在**，含**实测数据**（端点、坑、解密算法、元信息行规则）⇒ **直接复用** |
| `T33` QQ 行级源 | 已实现（我们现在用的 `fcg_query_lyric_new.fcg`） | 其规格记录了「QQ 搜索必须带 Referer，否则 `retcode=-1310` 静默失败」等坑 ⇒ **直接复用** |
| `T81` 词级时间戳门槛 | 已实现（`LyricLine.wordTimed`） | 真逐字才走卡拉OK、否则整行显示 ⇒ **本次不动它**，只给它喂更好的数据 |

---

## 2. 洛雪的歌词实现（源码事实，2026-11-13 核对 `master`）

每个平台一个模块：`src/renderer/utils/musicSdk/<平台>/lyric.js`。

| 平台 | 搜索 | 歌词端点 | 加密 | 能拿到 |
| --- | --- | --- | --- | --- |
| **网易云** `wy` | `music.163.com/api/search/get/web` | `POST interface3.music.163.com/eapi/song/lyric/v1` | **EAPI** = AES 加密的 form（`wy/utils/crypto.js`，**2.4 KB**） | `lrc` / `tlyric` / `romalrc` / **`yrc`** / `ytlrc` / `yromalrc` |
| **QQ** `tx` | `c.y.qq.com/soso/fcgi-bin/client_search_cp` | `POST u.y.qq.com/cgi-bin/musicu.fcg`（`GetPlayLyricInfo`，`crypt:1, qrc:1, roma:1, trans:1`） | **QRC** = **3DES-EDE3（ECB）+ zlib inflate**，固定密钥 `!@#)(*$%123ZXC!@!@#)(NHL` | **逐字 qrc** + 翻译 + **罗马音** |
| **酷狗** `kg` | `songsearch.kugou.com/song_search_v2`（要 `FileHash` + `Duration`） | `lyrics.kugou.com/search` → `lyrics.kugou.com/download?fmt=krc` | **KRC** = XOR + zlib（`common/utils/lyricUtils/kg.js`，2.2 KB） | 原文逐字（**无翻译、无罗马音**） |
| **酷我** `kw` | 洛雪 `kw/musicSearch.js` | `http://mlyric.kuwo.cn/mobi.s?f=web&type=lyric&lrcx=1&rid=<songmid>&encode=utf8` | `decodeLyric`（XOR + base64，key `yeelion`） | 原文 + 翻译（`lrcx=1` 带逐字 `<起,时>` 标签） |
| **咪咕** `mg` | 洛雪 `mg/musicSearch.js` | `getMusicInfo(songmid)` → `mrcUrl` / `lrcUrl` / `trcUrl` → GET | mrc 需 `decrypt`（`mg/utils/mrc`） | 原文（mrc 逐字）+ 翻译（trc 明文） |

### 2.1 两个**容易误解**的点

1. **洛雪的「自定义源脚本」（`api-source.js`）是给在线音频链接用的，不提供歌词** ⇒ 不可用于本任务。
2. **洛雪的「开放 API」**（v2.7.0+，`http://127.0.0.1:23332/lyric?id=…`，据社区文档）只暴露
   「洛雪自己正在播放的那首歌」⇒ 依赖用户装洛雪、对我们的多源曲库无价值 ⇒ **不采用**。

### 2.2 洛雪自己把 yrc/qrc 解析成两份

标准 LRC + 它自有的 `lxlyric`（行内**相对**毫秒逐字）。
⇒ **我们不抄它的格式**：我们已有「增强 LRC」（`<mm:ss.xx>` 绝对毫秒逐字标签）管线
（`yrcToEnhancedLrc` / `parseWordSegments`）⇒ 各平台的逐字格式**统一转成增强 LRC**即可，
**渲染层解析器一字不改**。

---

## 3. 我们现状与差距

### 3.1 现状（`electron/lyricProvider.ts`，主进程）

- 源链：`ONLINE_SOURCE_ORDER = ['netease', 'lrclib', 'qq', 'custom']`；设置面板可单选。
- 三级链路：**内嵌（T83）→ NAS 自带 → 外部源**；优先级默认「线上优先」。
- 已有能力：
  - `netease`：`music.163.com/api/song/lyric?…&yv=-1` ⇒ **已有 yrc 真逐字** + 行级 `tlyric`；
  - `qq`：`fcg_query_lyric_new.fcg` ⇒ **明文行级 LRC + 翻译**（**无逐字**）；
  - `lrclib`：第三方开源（实测 366–1300 ms、**偶发 503**）；
  - `custom`：用户自配 URL 模板。
- 实测：网易云歌词 31–41 ms / 10-10 全绿；QQ 歌词 70 ms 但**搜索 814 ms**。

### 3.2 差距

| 能力 | 我们 | 洛雪 | 差距 |
| --- | --- | --- | --- |
| QQ 逐字 | ❌ | ✅ | **最大缺口**（用户点名要） |
| 网易云逐字**翻译** | ❌（只有行级 tlyric） | ✅ `ytlrc` | 次要 |
| 罗马音 | ❌ | ✅（网易云 / QQ） | 用户点名要做 |
| 平台覆盖 | 2 个（网易云 / QQ）+ lrclib + custom | 5 个 | 冷门歌覆盖 |

### 3.3 ⚠️ 罗马音**不是所有源都有**（必须如实呈现）

| 源 | 罗马音 |
| --- | --- |
| 网易云 | ✅ 行级（`rv=-1`）；逐字（`yromalrc`）**需 EAPI** |
| QQ | ✅ **逐字**（`roma:1`，qrc 加密） |
| 酷狗 / 酷我 / 咪咕 | ❌ **没有** |

⇒ UI 的第三行**按源有无**决定显示，不存在时**不显示空行**。

---

## 4. 设计

### 4.1 模型扩展：原文 / 翻译 / 罗马音三行

现状的「第一条作原文、其余作翻译」是**位置约定** ⇒ 加第三行会歧义 ⇒ **必须引入角色标记**。

| 位置 | 改动 | 性质 |
| --- | --- | --- |
| `shared/lyricProvider.ts` | `ExternalLyricResult` 的 `ok` 变体加 `romanization: string`；`LyricSource` 加 `'kg' \| 'kw' \| 'mg'` | 改 |
| `src/api/types.ts` | `LyricEntry` 加 `role?: 'original' \| 'translation' \| 'romanization'`（**可选 ⇒ 缺省按旧位置约定 ⇒ 既有数据行为不变**） | 改 |
| `src/player/lyricSource.ts` | `toExternalEntries` 产出**三条**（原文 / 翻译 / 罗马音），各自带 `role` | 改 |
| `src/ui/lyrics/parse.ts` | `parseLyricEntries` 的合并规则改为**按 `role`**（无 `role` 的按旧位置约定 ⇒ 旧数据不受影响）；`LyricLine` 加 `romanization: string` | 改 |
| `src/ui/lyrics/LyricView.tsx` | 渲染第三行（罗马音）：无值时**不渲染**，不占位 | 改 |

⚠️ **向后兼容纪律**：`role` 缺失 ⇒ 按「第 1 条原文、其余翻译」处理
⇒ **既有测试一条不改也必须绿**。

### 4.2 适配器分层（沿用 T74a 的思路）

| 单元 | 职责 | 依赖 |
| --- | --- | --- |
| `electron/lyricWordFormat.ts`（**已存在？否，T74a 回滚时删了**） | `msToLrcTag()` | 无 |
| `electron/lyricCodecs/qrc.ts`（新增） | QRC 解密：**纯 JS 3DES（非标准 S 盒）** + `node:zlib` inflate | `node:zlib` |
| `electron/lyricCodecs/krc.ts`（新增） | KRC 解密：base64 → 跳 `krc1` → XOR → `node:zlib` inflate | `node:zlib` |
| `electron/lyricCodecs/kuwo.ts`（新增） | 酷我 `decodeLyric`：XOR + base64 | 无 |
| `electron/lyricCodecs/migu.ts`（新增） | 咪咕 `decrypt` | 无 |
| `electron/lyricProvider.ts`（改） | 每平台一个 `fetchXxx()`（内部完成「平台搜索 → 拿 id/hash → 取歌词」） | `fetchImpl`（注入） |

⚠️ **QQ 的 3DES 不能用 `node:crypto`**：QRC 用的是**非标准 DES 变体**
（`S2[23]=15`、`S4[53]=10`，标准值是 14 / 1）⇒ OpenSSL 的标准 DES **解不出来**
⇒ **必须移植洛雪那份纯 JS 3DES**（`tx/qrcDecode.js`，约 250 行，Apache-2.0，**须注明出处**）。

⚠️ **各平台的「搜索 → 取歌词」全部在主进程内部完成**：
渲染层**只传 4 个字段**（歌名 / 歌手 / 专辑 / 时长）——这是既有的**安全边界**
（主进程不接受渲染层传来的任何 id / URL）⇒ **不许**为了省事把 songid 之类塞进 IPC 契约。

### 4.3 出网通道

沿用 `electron/http.ts` 的 Chromium 分区 session：
- 自定义 header（酷狗要 `KG-RC` / `KG-THash` / `User-Agent`；酷我要 `Referer`）⇒ `session.fetch` 支持 `init.headers` ✔；
- ⚠️ 酷狗 / 酷我用的是 **http 明文**接口 ⇒ Chromium 默认允许（主进程发请求，不受页面 CSP / 混合内容约束），
  但**必须实测**（见 T90-②）；
- 仍**绝不附带 NAS 凭证**（干净分区、不附 token / Cookie）✔。

### 4.4 逐字 → 增强 LRC 的统一口径

各平台逐字格式的差异（**转换器必须区别对待**）：

| | 网易云 yrc | QQ qrc | 酷狗 KRC | 酷我 lrcx | 咪咕 mrc |
| --- | --- | --- | --- | --- | --- |
| 词元组 | `(起,时,0)` | `(起,时)` | `<起,时,0>` | `<起,时>` | `(起,时)` |
| 词时间基准 | **绝对毫秒** | **相对行开始** | **相对行开始** | 相对行开始 | 相对行开始 |
| 行头 | `[起,时]` | `[起,时]` | `[起,时]` | `[mm:ss.xx]` | `[起,时]` |

⇒ 统一输出：`[行标签]<词1标签>词1<词2标签>词2…`（**绝对**毫秒的 `<mm:ss.xx>`）
⇒ 交给**现有** `parseWordSegments` ⇒ **渲染层解析器一字不改**。

### 4.5 错误处理（沿用既有纪律：如实上报，不静默）

| 情况 | 结果 |
| --- | --- |
| 平台搜索无结果 / 无候选 | `not-found` |
| 端点非 200 / 响应形状不对 | `error`（带消息） |
| 解密失败 / 头不是 `krc1` | `error`（**如实报，不静默吞掉**） |
| 解密后过滤完没有有效歌词行 | `not-found` |
| 任一环节超时 | 源级预算 ⇒ `error`，源链继续试下一个源 |

---

## 5. 任务拆分（一次一个编号任务）

| 编号 | 任务 | 产出 | 关键验收点 |
| --- | --- | --- | --- |
| **T90-①** | **立项与规格**（本任务） | 本文档 + 台账段 | 事实表可溯源（洛雪源码路径 / T74a 实测） |
| **T90-②** | **接口探针：5 个源今天还活着吗** | `release/verify/t90-02-probe-*.mjs` + JSON 证据 | 连通性 / 延迟 / 字段形状 / **http 明文能否走**；**不解密内容**（只验活） |
| **T90-③** | **模型扩到三行** | `role` 字段 + `LyricLine.romanization` + LyricView 第三行 | 既有测试**一条不改**全绿；新单测钉住「无 `role` 按旧约定」 |
| **T90-④** | **QQ 逐字** | `lyricCodecs/qrc.ts` + `fetchQq()` | QRC 解密单测（含**非标准 S 盒**）；真机逐字跟嘴 |
| **T90-⑤** | **酷狗源** | `lyricCodecs/krc.ts` + `fetchKugou()` | 复用 T74a 规则：元信息行过滤 + 防误杀用例 |
| **T90-⑥** | **酷我源** | `lyricCodecs/kuwo.ts` + `fetchKuwo()` | `lrcx=1` 逐字标签解析 |
| **T90-⑦** | **咪咕源** | `lyricCodecs/migu.ts` + `fetchMigu()` | mrc / lrc / trc 三分支 |
| **T90-⑧** | **网易云罗马音 + 源链与设置面板** | `rv=-1` 行级 romalrc；源链加 3 源；下拉选项 | 源链顺序与「用户选的排第一」规则不变 |
| **T90-⑨** | **真机实测 + 台账回填 + 发布说明** | 实测记录 + 台账 + changelog | 5 源逐个实测；三行显示正确；**线上资产不受影响** |

⚠️ **T90-② 排在最前的原因**：洛雪的这些代码是**几年前**的
（酷狗 / 酷我走的还是 http 明文接口）⇒ **必须先验活再动手写生产代码**，
否则可能照抄一堆已经失效的端点。

---

## 6. 风险与未知

1. **接口会变**（非官方、无 SLA）：5 个源都是非官方公开接口 ⇒ 源链的**兜底设计**（多源依次试）比单个源更重要。
2. **http 明文**：酷狗 / 酷我目前是 http ⇒ 若哪天上 https，适配器要改；先实测再定。
3. **许可与出处**：移植洛雪的纯 JS 3DES / 解密实现 ⇒ **必须注明出处 + Apache-2.0 声明**；
   本仓库自身协议需与用户确认后再定发布形式。
4. **QQ 三跳**：搜索（带 Referer）→ `songmid` → `songID`（`getMusicInfo`）→ `musicu.fcg`
   ⇒ **搜索那跳现在实测 814 ms** ⇒ QQ 逐字的**总延迟**可能到 1 s 级
   ⇒ 源级超时预算要单独放宽，且**UI 要能接受 1 s 才出词**（先出 NAS 的、线上后到覆盖）。
5. **逐字 ≠ 好看**：T81 已经确立「没有真逐字就整行显示」⇒ 新源若给不出真逐字，
   **不要为了显示而伪造**。
6. **罗马音的可用性**：只有网易云 / QQ 有 ⇒ 第三行在别的源上恒为空（**如实不显示**）。

---

## 7. 明确不做

- 不做洛雪的「开放 API」接入（依赖用户装洛雪、只覆盖单曲）。
- 不做洛雪的「自定义源脚本」机制（那是音频 URL 的，与歌词无关）。
- 不做多源**并发**择优（保持「依次试」的既有源链）。
- 不改 `src/ui/lyrics/parse.ts` 的**时间标签 / 伪逐字**逻辑（只加 `role` 合并规则）。
- 不改 NAS 侧歌词（服务端不动）。
- 不动已发布的 v0.2.9 资产（本次不发版，改完再走正常发版流程）。

---

## 8. 探针实测后的修正（T90-②，2026-11-14）

T90-② 的接口探针（`tools/fn-lyric-source-probe*.mjs`，**只验活 / 看字段形状 / 记延迟，不解密内容**）
推翻了本规格里的两处假设，并发现了两个必须改计划的事实。

### 8.1 两处修正

| # | 立项时的判断 | 实测 | 处置 |
| --- | --- | --- | --- |
| 1 | 酷我 `mobi.s` 返回 base64 密文 | 响应是 **`TP=content\r\nlrcx=1\r\n\r\n` + 二进制密文**（4655 B）；洛雪的 `decodeLyric(raw, …)` 收的正是 **Buffer** | **形状一致** ⇒ T90-⑥ 可直接照抄洛雪的 `kw/util` |
| 2 | 咪咕 `resourceinfo` 传 `copyrightId` | **必须传 `songId`**：传 copyrightId ⇒ `resource: []`；传 songId ⇒ 1 条 / 6631 B | **洛雪这里有传参错位** ⇒ T90-⑦ 用 `songId` |

### 8.2 两个必须改计划的事实

1. ⚠️ **我们线上在用的 QQ 旧端点已彻底下线**
   （`c.y.qq.com/lyric/fcg_query_lyric_new.fcg`，2 个 songmid × 3 个 URL 变体 = **6/6 全 404**）
   ⇒ **QQ 源目前是坏的** ⇒ **T90-④ 从「锦上添花」升级为「修复已坏的功能」**，优先级提到最前。
2. **网易云仍活着但覆盖差**：12 首样本里 5 首有 `lrc`、**2 首有 `yrc`**、**2 首有 `romalrc`**
   ⇒ **T90-⑧ 的罗马音可行**（旧接口加 `rv=-1` 即可，**不必上 EAPI**）；
   ⚠️ **周杰伦原唱基本没词**（与 T74a 结论一致）⇒ 网易云源的定位是「有就很好、没有就换源」。

### 8.3 五源实测速查（2026-11-14）

| 源 | 状态 | 延迟 | 逐字 | 罗马音 | 翻译 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 网易云 | ✅ 200 | 30–52ms | ✅ `yrc`（**覆盖约 2/12**） | ✅ `romalrc`（**2/12**） | 行级 `tlyric` | 覆盖差；周杰伦原唱无词 |
| QQ（旧） | ❌ **404** | — | — | — | — | **生产在用，已坏** |
| QQ（逐字） | ✅ 200 | 61ms（搜索 1507ms） | ✅ `qrc`（hex 6048 字符） | ✅ `roma`（样本为 0） | ✅ `trans`（样本为 0） | 需 QRC 解密 |
| 酷狗 | ✅ 200 | 63ms | ✅ `krc`（头 `krc1`） | ❌ | ❌ | **格式与 T74a 一致** |
| 酷我 | ✅ 200 | 126ms | ✅ `lrcx=1` 逐字标签 | ❌ | ✅ | **http 明文可达** |
| 咪咕 | ✅ 200 | 139ms | ⚠️ `mrcUrl` **样本为空串** | ❌ | ⚠️ `trcUrl` **样本为空串** | 行级可用；**逐字待更多样本定性** |
