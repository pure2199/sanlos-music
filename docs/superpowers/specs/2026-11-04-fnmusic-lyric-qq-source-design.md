# T33 设计规格：QQ 音乐外部歌词源

- 日期：2026-11-04
- 状态：已获用户批准
- 前置：T32（外部歌词 API 框架，`d4967e9`）

---

## 1. 背景与动机

用户提出「能加入 Lyricify Fusion 的歌词 API 吗」。调研结论如下。

### 1.1 Lyricify 没有可供第三方调用的公开歌词 API

- Lyricify Fusion 是 **Windows 桌面软件**（面向所有接入 SMTC 的播放器），**不是** API 服务。
- 官方文档站 `docs.lyricify.app` 只有使用指南，**没有** API 参考文档。
- 主服务器 `api.lyricify.app` 可达（实测 `https://api.lyricify.app/app/connection-test` → `OK`），
  但**没有** `openapi.json` / swagger，也**没有任何文档化的歌词查询端点**。
- Lyricify 账户与 Spotify 账号关联（文档原文：首次登录 Spotify 时自动注册）→
  账户凭证属于 **Spotify OAuth token**，是**凭证**而非公开信息。

### 1.2 Lyricify 真正的护城河是「免凭据词源 + 逐字 + 翻译」

官方开源库 `WXRIW/Lyricify-Lyrics-Helper`（Apache-2.0）的**访问凭据表**：

| 来源 | 配置要求 |
| --- | --- |
| QQ 音乐、网易云音乐、酷狗音乐、汽水音乐、LRCLIB | **无需配置** |
| Apple Music | 必须提供 Media User Token |
| Musixmatch | User Token（可自动获取） |
| Spotify | 必须提供 `sp_dc` Cookie |

⇒ Lyricify 的歌词能力**绝大部分建立在免凭据词源上**。本任务把其中**一个源（QQ 音乐）**
接入本项目，不涉及任何账号 / token / OAuth。

### 1.3 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 集成档位 | **接 Lyricify 同款免凭据词源**：新增「QQ 音乐」内置源（行级 LRC + 翻译） |
| 全屏歌词形态 | 歌词舞台式（全量渲染 + 当前行放大逐字高亮 + 自动滚动）→ **T34**，本任务不做 |
| 多源策略 | **保持单选**（网易云 / QQ / lrclib / 自定义），行为与 T32 一致 |

---

## 2. 实测依据（2026-11-04，本机真打）

### 2.1 可用端点

| 端点 | 结果 |
| --- | --- |
| `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=<关键词>&format=json` | **200 / 814ms**，`data.song.list[]` |
| `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=<mid>&format=json&nobase64=1` | **200 / 70ms**，`lyric` = **明文 LRC**、`trans` = 翻译 LRC |

### 2.2 已下线 / 不可用的端点（**不采用**）

| 端点 | 结果 |
| --- | --- |
| `c.y.qq.com/soso/fcgi-bin/client_search_cv` | **404 已下线** |
| `c.y.qq.com/song.fcg` | **404 已下线** |
| `c.y.qq.com/soso/fcgi-bin/search_client_cp` | **404 已下线** |
| `u.y.qq.com/cgi-bin/musicu.fcg`（`music.search.SearchCgiService`） | `code: 500001`（参数被拒） |
| `u.y.qq.com/cgi-bin/musicu.fcg`（`DoSearchForQQMusicDesktop`） | 200 但**列表为空** |

### 2.3 关键形态结论

1. **QQ 的 `lyric` 是明文 LRC**：带 base64 时也只是**传输编码**（解码后仍是明文），**不是加密**。
   ⇒ **零解密成本**。
2. **QQ 的这个歌词端点不返回 `qrc`**（实测 `qrc` / `qrc_t` 长度均为 0）→ **拿不到逐字**。
   逐字在 `u.y.qq.com` 的 `PlayLyricInfo`（`qrc` 为**密文**，需解密）→ **本任务不做**。
3. **翻译 `trans` 可能为空串**（实测《占位曲目五》为 0 长度）→ 缺失就是空，**不报错**。
4. **QQ 搜索结果带 `<em>` 高亮标签**（实测 `albumname_hilight`）→ 歌名/专辑名必须**剥标签**，
   否则与查询条件对不上 → 匹配失败。
5. **QQ 的 `interval` 是「秒」**（实测《占位曲目五》256，对应 4:16）→ 与 `pickCandidate` 的口径一致，
   **不需要**像网易云那样除以 1000。

### 2.4 与既有源的速度对比

| 源 | 搜索 | 歌词 |
| --- | --- | --- |
| 网易云（T32 默认） | 200，18–235ms | 200，31–41ms |
| **QQ 音乐（T33 新增）** | 200，**814ms** | 200，**70ms** |
| lrclib（T32 备选） | 200，366–1300ms | — |

⇒ QQ 搜索明显慢于网易云 ⇒ **不改变默认值**（仍是网易云），QQ 作为**可选源**。

---

## 3. 设计

### 3.1 架构：沿用 T32 三段式

```
渲染层（SettingsPanel / FullPlayerPage）
  │  只发标量（title/artist/album/duration）给主进程，永不碰网络
  ▼
主进程 electron/lyricProvider.ts
  │  走 electron/http.ts 的干净分区栈（不附 NAS 凭证）
  ▼
外部歌词源（netease / lrclib / qq / custom）
```

- 渲染层**永不接触 token**（本任务也**不需要** token）。
- QQ 音乐不在 `TrustedHosts` 内 → Chromium 默认证书校验 → **必须 https**（本方案全是 https）。
- 主进程只收四个标量，**不接受渲染层传来的任何 URL**（`custom` 的模板来自 `prefs.json`）。

### 3.2 `shared/lyricProvider.ts`

| 改动 | 内容 |
| --- | --- |
| `LyricSource` | `'off' \| 'netease' \| 'lrclib' \| 'qq' \| 'custom'` |
| `LYRIC_SOURCES` | 白名单加 `'qq'` |
| `DEFAULT_LYRIC_SOURCE` | **不变**（`'netease'`） |
| `normalizeLyricSource` | **逻辑不变**（陌生值一律回落默认）—— 白名单加了 `'qq'` 就自动生效 |
| `ExternalLyricResult` | `source` 字段类型自动含 `'qq'`（联合类型派生，**无需**改） |

⚠️ 本文件**不得出现副作用**、不得 import Electron / Node 内置模块 / DOM 类型（纪律同 T32）。

### 3.3 `electron/lyricProvider.ts`

新增：

```ts
const QQ_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
```

- `stripHighlightTags(text)`：剥掉 `<em>` 等 HTML 标签并 trim。
  ⚠️ 搜索结果里的歌名/专辑名可能是 `<em>高亮</em>` 包裹的；不剥 → 与查询歌名对不上 → 匹配失败。
- `readQqCandidates(payload)`：读 `data.song.list[]` →
  `{ id: songmid, title: songname(剥标签), artist: singer[].name 逗号拼接, duration: interval(秒) }`。
  缺 `songmid` / `songname` 的条目**跳过**。
- `fetchQq(fetchImpl, query)`：
  1. 搜索：`?p=1&n=10&w=<歌名 歌手>&format=json`（`encodeURIComponent`）；
  2. `pickCandidate(...)`（**复用**既有纯函数，顺序：歌名 → 歌手 → 时长 ±3s）；
  3. 歌词：`?songmid=<mid>&format=json&nobase64=1`；
  4. 原文 = `lyric`，翻译 = `trans`；
  5. `looksLikeLrc(original)` 不通过 → `not-found`（**不是** error）；
  6. 返回 `{ status:'ok', source:'qq', original, translation }`。

dispatch 增分支：

```ts
} else if (source === 'qq') {
  result = await fetchQq(opts.fetchImpl, query)
}
```

⚠️ 模块顶层**不得** import Electron（单测在普通 Node 里跑）→ fetch 仍走**注入**。

### 3.4 `src/components/SettingsPanel.tsx`

「外部歌词源」`<select name="fnm-lyric-source">` 增加一项：

```html
<option value="qq">QQ 音乐</option>
```

位置：网易云之后、lrclib 之前（按实测速度排序）。
⚠️ 按钮名仍为「**保存歌词源**」（面板里已有一个同名「保存」会撞车，见 T32 的坑）。

### 3.5 明确不做（范围不扩）

- ❌ 逐字（QRC 密文解密 + A2 增强 LRC 转换）→ 留给后续任务
- ❌ Lyricify 账户 / Spotify OAuth / 任何 token
- ❌ 酷狗（KRC 密文）、汽水音乐源
- ❌ 多源自动兜底（用户选了**保持单选**）
- ❌ 改默认源（仍是网易云）
- ❌ 新增 npm 依赖

---

## 4. 测试计划

### 4.1 `test/lyric-provider.test.ts`（既有 33 条，一条不删、断言不削弱）

新增 `describe('QQ 音乐适配器')`：

| 用例 | 断言要点 |
| --- | --- |
| 搜索 → 按时长挑中 → 取歌词 → 原文与翻译都拿到 | `result.original` / `result.translation`；`calls[1]` 含 `songmid=002` |
| **歌名带 `<em>` 高亮标签** → 剥掉后仍能匹配上 | 候选 `songname: '<em>占位歌名</em>'` 也能被挑中 |
| 搜索结果里没有对得上的 → `not-found` | 不是 error |
| 搜索接口返回 500 → `error` + 可读原因 | `message` 含 `500`，**不抛异常** |
| 歌词不是 LRC（纯文本）→ `not-found` | 不把纯文本塞给解析器 |
| 翻译字段为空 → 仍是 `ok`，`translation === ''` | 不报错 |
| QQ 的 `interval` 按**秒**处理 | 候选 `interval: 200` 与 `duration: 200` 的歌能被挑中 |

### 4.2 `test/settings-lyric-source.test.tsx`

- 断言下拉里有「QQ 音乐」选项（`value="qq"`）。
- 断言选中 QQ 时**不**要求填自定义模板（模板输入框仍禁用）。

### 4.3 不动的部分

- `mock-server/server.ts` **不改**：mock 的 `/mock-lyric` 是给 `custom` 模板用的；
  QQ 源走真实网络，**不参与 E2E**。
- `e2e/smoke.spec.ts` **不改**：E2E 继续用默认的网易云 / 自定义模板，不引入外网依赖。
- `test/lyric-source.test.ts`（渲染层取词）**不改**：它不区分具体源。

---

## 5. 验收点

1. `tsc --noEmit` → **0 错**。
2. `vitest run` → 全绿，条数 **≥ 基线 1456 / 59 files**。
3. `playwright test` → 全绿（**≥ 17 passed**）。
4. **U+FFFD 扫描 0 命中**（`release/verify/fffd-scan.mjs`）。
5. **行尾保持**：除 `docs/calibration.md`（CRLF）外全部 LF；无 BOM。
6. **变异自证**（每处先红后复原，sha256 回基线）：
   - M1：去掉 `stripHighlightTags` → 带 `<em>` 的用例必须红；
   - M2：把 QQ 的 `interval` 当**毫秒**（除以 1000）→ 时长挑选用例必须红；
   - M3：去掉 `looksLikeLrc` 校验 → 「不是 LRC → not-found」用例必须红。
7. **既有测试一条不删、断言不削弱**。
8. 文档同步：`docs/calibration.md`（实测数据表）、`README.md`、changelog。

---

## 6. 风险与边界

| 风险 | 处置 |
| --- | --- |
| QQ / 网易云都是**非官方**公开接口，无 SLA、可能变更 | T32 已立规矩：**不押注一家**；用户可一键切换；本任务不改变默认值 |
| QQ 搜索 814ms 偏慢 | 作为**可选**源；文档如实标注实测数字 |
| QQ 无逐字 | 本任务范围外；文档如实说明 |
| QQ 翻译覆盖不全 | `trans` 为空即空，**不报错**、**不阻塞** |

---

## 7. 待校准点（未实测）

- 真实客户端「渲染层 → 主进程 → Chromium 分区栈 → QQ 外网」**完整链路**未做活体验检
  （本轮只直打 API 验证了端点与形态）。
- QQ 接口在**无 Referer / 不同 UA** 下的行为未逐一验证（本实现固定带 UA 与 Referer）。
