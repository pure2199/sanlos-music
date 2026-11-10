# T83 设计规格：读音频内嵌歌词标签（本地文件 / 已下载 / NAS 在线流）

> **状态**：已批准（2026-11-10，用户拍板：**优先级链放 A**（内嵌算本地侧、排 NAS 前）、**三个来源层全做**（含 NAS 在线流））。
>
> 本规格**未实施**，落地时按 §10 的两个 commit 走（规格 = 本文件；实现 = 第二个 commit）。

## 1. 起因

现在的软件**只读音频文件里的四个标签字段**（歌名 / 歌手 / 专辑 / 时长），
**一个字的歌词都不读** ⇒ 用户的曲库里那些自带歌词（`USLT` / `SYLT` / `LYRICS` / `©lyr`）的文件，
在我们这儿等于没有歌词。

而歌词的两个现有来源都各有天花板：

- **NAS 自带**（`/lyric/list?trackGUID=`）：多半只有**行级**时间戳；
- **线上源**（网易云 / lrclib / QQ / 自定义）：能出**真逐字**，但**匹配不上就没了**
  （冷门歌、remix、现场版、纯音乐）。

⇒ 内嵌歌词是**第三类源**：它是**作者自己放的**（行时间戳通常比服务端刮的准），
而且 `SYLT` 帧是**真逐字**、**离线可得**、**不需要外网、不需要追词源、不需要解密**。

本任务把它补进歌词管线。

### 1.1 目标

1. 音频文件里的歌词标签（6 种格式）**能被读出来**；
2. 读出来的歌词按既有优先级链参与取词（**方案 A**：内嵌算「本地侧」，排在 NAS 前面）；
3. `SYLT`（真逐字）转成**增强 LRC**（`<mm:ss.xx>` 逐字标签）⇒ 交给**现有**解析器
   ⇒ **渲染层解析器一行不改**，且自动进卡拉OK；
4. 行级内嵌歌词 ⇒ 按 T81 的口径走**整行显示**（**不假装逐字**）；
5. 界面**如实显示**命中的来源（「歌词来源：音频内嵌」）。

### 1.2 不做什么（范围收窄）

- **不改用户的音乐文件**（只读，不写回标签）；
- 不做 MP4 的 `----:com.apple.iTunes:LYRICS` 自由格式（只做 `©lyr`）；
- 不做 ID3v1（没有歌词字段）；
- 不做 WAV 的非标准帧（`LIST INFO` 没有歌词字段）；
- **不为 NAS 在线流做「整流下载后再找标签」**（代价太大）；
- **不改** `src/ui/lyrics/parse.ts`（**一行都不改**）；
- 不新增第三方 npm 依赖；
- 不动 NAS 服务端歌词（`/lyric/list` 一字不改）。

## 2. 现状（读码结论，实施前的事实基线）

| 事实 | 位置 |
|---|---|
| 标签解析产物只有 4 个字段 | `electron/audioTags.ts:38-47`（`AudioTags`） |
| ID3v2 只认 `TIT2` / `TPE1` / `TALB` | `electron/audioTags.ts:327-333` |
| Vorbis 注释只取 `TITLE` / `ARTIST` / `ALBUM` | `electron/audioTags.ts:581-583`、`771-773` |
| MP4 只取 `©nam` / `©ART` / `©alb` | `electron/audioTags.ts:1018-1020` |
| 全仓**没有**任何 `USLT` / `SYLT` / `LYRICS` / `UNSYNCEDLYRICS` / `©lyr` 的生产代码 | grep 只命中 e2e 夹具 |
| 标签解析只在两处发生（本地导入 / 下载完成） | `electron/localLibrary.ts:32`、`electron/downloadManager.ts:356`、`676` |
| 歌词两个来源：NAS `/lyric/list` + 线上源链 | `src/api/lyric.ts:17`、`electron/lyricProvider.ts:792` |
| 本地曲目 id = `local:<sha1 前 16 位>`（**不是** guid） | `electron/localLibrary.ts:170` ⇒ 查 NAS 歌词**必然查不到** |
| 取词入口（两处调用同一个函数） | `src/pages/FullPlayerPage.tsx:355`、`src/player/lyricOverlay.ts:227` |
| 优先级两档：`online-first`（线上 → NAS）/ `local-first`（NAS → 线上） | `src/player/lyricSource.ts:286`（online-first）、`:242`（local-first） |
| 渲染层解析器**已经会吃** `<mm:ss.xx>` 逐字标签 | `src/ui/lyrics/parse.ts:53`（`WORD_TAG`）、`:179`（`parseWordSegments`） |
| 真逐字 / 伪逐字的分水岭 | `src/ui/lyrics/parse.ts:434`（`wordTimed`）、`src/ui/lyrics/LyricView.tsx:611` |
| 逐字填色的对齐口径（词 vs 行文本，按**去空白**字符数） | `src/ui/lyrics/LyricView.tsx:153`（`buildSegments`）、`:177`（长度不等 ⇒ 整行退化成纯文本） |
| NAS 音频流端点与 Range 支持 | `electron/main.ts:513`（`GET …/track/stream?guid=` + `range` 头）、`electron/downloadManager.ts:599`（接受 200/206） |

## 3. 范围

### 3.1 三个来源层

| 层 | 曲目 id | 文件在哪 | 读取方式 |
|---|---|---|---|
| ① 本地导入 | `local:<hash>` | 本地登记表里的绝对路径 | 直接读磁盘（`readFileTags`） |
| ② 已下载的 NAS 曲目 | 32 位 guid | 下载索引 `songId → file` | 直接读磁盘（`readFileTags`）——**原文件**，标签最完整 |
| ③ NAS 在线播放 | 32 位 guid | 只有 `GET track/stream?guid=` 流 | `Range: bytes=0-65535` 取头 ⇒ 解析 ⇒ **读满立刻 abort** |

### 3.2 六种帧格式

| 容器 | 歌词字段 | 内容形态 |
|---|---|---|
| ID3v2（mp3 / AIFF / WAV 的 `ID3 ` 块） | `USLT` | 文本 LRC（可能含 `<mm:ss.xx>`） |
| ID3v2 | `SYLT` | **二进制**：编码 + 语言 + 时间戳格式 + 内容类型 + 描述符 + 若干「文本 + 4 字节时间戳」条目 ⇒ **真逐字** |
| Vorbis 注释（FLAC / Ogg / Opus） | `LYRICS` / `UNSYNCEDLYRICS` | 文本 LRC |
| MP4 / M4A（`moov.udta.meta.ilst`） | `©lyr` | 文本 LRC |
| WAV `LIST INFO` | — | 无标准歌词帧 ⇒ **不做** |
| AIFF | — | 无独立歌词块 ⇒ 靠 `ID3 ` 块 ⇒ **复用 ID3 解析器**（白捡） |

### 3.3 「本地层」与「流式层」的能力差（**必须如实告诉用户**）

- **① ② 两层**：支持**全部 6 种格式**（含 MP4 —— 本地文件可以按偏移随机读，`moov` 在文件尾也能读到）；
- **③ 流式层**：**只支持「元数据在文件头」的容器**（MP3/ID3、FLAC、Ogg）。
  理由：MP4 的 `moov` 原子**常在文件尾**（`electron/audioTags.ts:842-843` 已写明），
  要读它就得再发一次尾部 Range 请求 ⇒ 本任务**不做**（流式层遇 MP4 直接放弃，不报错）。

## 4. 关键设计决策

### 4.1 决策一：主进程转成 LRC 文本 ⇒ 渲染层解析器一字不改

**做法**：在**主进程**把内嵌歌词转成**标准 LRC 文本**（`SYLT` 二进制 → 增强 LRC 的
`<mm:ss.xx>` 逐字标签），再按既有 `LyricEntry{guid, source, content, …}` 交给渲染层。

**为什么**：

- `src/ui/lyrics/parse.ts` 的 `parseWordSegments`（`:179`）**早就在等喂**逐字标签
  —— 这条路 T74a（酷狗 KRC）已经论证过（见
  `docs/superpowers/specs/2026-11-10-sanlos-music-kugou-krc-lyric-source-design.md` §1.1）；
- 本任务比 KRC 干净得多：**不需要解密、不需要外网、不需要追词源**；
- `wordTimed` 由解析器自己算（`parse.ts:434`）⇒ `SYLT` 自动获得「真逐字」⇒
  **自动进卡拉OK**；行级内嵌歌词 ⇒ `wordTimed=false` ⇒ **整行显示**（T81 的口径，**不假装逐字**）。

### 4.2 决策二：优先级链放 **A**（内嵌算「本地侧」，排在 NAS 前面）

| 优先级档 | 实际链 |
|---|---|
| `online-first`（缺省） | 线上（用户选的源 → netease → lrclib → qq → custom） → **内嵌** → NAS |
| `local-first` | **内嵌** → NAS → 线上 |

**理由**：

1. 内嵌歌词是**作者自己放的**，比 NAS 刮来的更准（尤其行时间戳）；
2. `SYLT` 是**离线可得的真逐字源** —— 正好补上 T81 缺的那块；
3. 与「本地优先」既有语义一致（「先用文件自带的」）⇒ **不用新增第三档优先级、不用加设置项**；
4. **默认档（`online-first`）下老用户行为几乎不变** —— 内嵌只在线上没匹配上时才顶上来
   ⇒ **风险最低**。

⚠️ **对既有行为的唯一改变**：默认档下，若线上没匹配上而 NAS 也没有，则**原来显示「暂无歌词」、
现在可能显示内嵌歌词**。这是**纯增**（原来没有歌词的地方多出歌词），**不夺走任何已有歌词**。

### 4.3 决策三：`lyric.source = 'off'` 时**内嵌照用**

`off` 的语义是「**不用外部源**」（`electron/ipc.ts:1551`），而**内嵌不需要外网**
⇒ 内嵌照常参与取词。⇒ 「`off` + `local-first`」= **纯本地歌词**（NAS + 内嵌，不出网）。

### 4.4 决策四：界面**如实显示**命中的来源

`LyricLoadResult.origin` 增加 `'embedded'`；全屏歌词页的状态行显示「歌词来源：音频内嵌」。
⚠️ **不装作是别的源** —— 与 T73「命中哪个源就显示哪个源」同一条纪律。

### 4.5 决策五：`SYLT` 的行/词形态判定（**写死的规则 + 明确的启发式**）

`SYLT` 的条目既可能是「一整行」，也可能是「一个词/音节」，**取决于写标签的工具**。
我们**没有**元数据能直接区分 ⇒ 规则写死如下（**全部有单测钉住**）：

1. 解析出条目列表 `{ text, timeMs }`，按 `timeMs` 升序（同刻保持原序）；
2. **切分**：每个条目的 `text` 按 `\n` 切成片段，片段继承该条目的 `timeMs`；
   记录该条目是否**以 `\n` 结尾**（= 行尾标记）；
3. **形态判定**：`median(片段去空白后的长度) >= 12` ⇒ **行模式**；否则 ⇒ **词模式**。
   ⚠️ **这是启发式**（阈值写死 = 12）：真实标签里「一整行」通常 ≥ 10 字，「一个词」通常 ≤ 6 字；
4. **行模式**：每个片段 = 一行 ⇒ `[mm:ss.xx]片段文本` ⇒ **行级**；
5. **词模式**：
   - 行边界 = 条目**以 `\n` 结尾**处断开；
   - 若**全程没有任何 `\n`** ⇒ **启发式断行**：累积片段，直到「累计去空白长度 ≥ 24」
     或「片段以 CJK 句读（`，。！？；、`）结尾」⇒ 断行；
     ⚠️ **行切分是猜的**，但**词级时间戳是真的** ⇒ 卡拉OK 填色仍然跟嘴；
   - 每行首片段的时间戳 = 行时间；行内片段 = 词 ⇒ 逐字标签用各自 `timeMs`；
   - 行内只有 1 个片段 ⇒ 退化成 `[mm:ss.xx]文本`（行级）；
6. 输出**增强 LRC**文本。

### 4.6 决策六：逐字标签之间的**空白必须保留**

`buildSegments`（`src/ui/lyrics/LyricView.tsx:153`）按**去空白后的字符数**把词对齐到行文本；
长度对不上 ⇒ **整行退化成纯文本**（没有填色）。

⇒ 转换时**必须**把词之间的空格原样留在标签之间（`<00:01.00>Hello <00:01.20>world`）：
- 行文本（`stripWordTags`）= `Hello world`（显示正确）；
- 词（解析器逐段 `trim`）= `['Hello','world']` ⇒ 去空白后 10 字符 = 行文本去空白后 10 字符 ✔ 对齐。

⚠️ 反例（**必须避免**）：`<00:01.00>Hello<00:01.20>world` ⇒ 行文本变成 `Helloworld` ⇒ **显示丢空格**。

## 5. 数据流（端到端）

```
渲染层（拿到 song.id）
 └─ loadLyricEntries(id, target, deps)                 src/player/lyricSource.ts
      ├─ 线上源链（既有，不改）                          electron/lyricProvider.ts
      ├─ NAS /lyric/list（既有，不改）                   src/api/lyric.ts
      └─ 【新增】内嵌层 deps.embedded(id)
           └─ IPC 'lyric:embedded' { id }               electron/ipc.ts
                └─ electron/embeddedLyric.ts（主进程·新增）
                     ├─ id 是 local:* → 本地登记表 → 路径
                     ├─ id 是 guid 且已下载 → 下载索引 → 路径
                     └─ id 是 guid 未下载 → GET track/stream?guid=… + Range: bytes=0-65535
                                            → 读满即 abort
                     └─ readFileTags / 流解析 → audioTags
                          └─ SYLT → 增强 LRC；USLT / LYRICS / ©lyr → 原样
                                └─ LyricEntry[]（source='embedded'）
                                     └─ 渲染层 parseLyricEntries（**不改**）
```

⚠️ **渲染层不碰文件系统**：IPC 入参**只收曲目 id**（不收路径）⇒ 路径一律由主进程自己解析。

## 6. 实现清单

### 6.1 `electron/audioTags.ts`（改）

| 改动 | 说明 |
|---|---|
| `AudioTags` 加 `lyrics?: string` | **可选字段、缺省 = 没有歌词** ⇒ 既有对象与既有测试**一字不改** |
| ID3v2：`USLT` / `ULT`（v2.2） | 帧体：编码字节 + 3 字节语言 + 描述符（按编码终止）+ 歌词文本 ⇒ 解出文本 |
| ID3v2：`SYLT` / `SLT`（v2.2） | 二进制解析 + 按 §4.5 转增强 LRC |
| Vorbis 注释：`LYRICS` / `UNSYNCEDLYRICS` | 键已大写（`parseVorbisCommentBlock` 会 `toUpperCase`）⇒ 直接取；**`LYRICS` 优先**，空则取 `UNSYNCEDLYRICS` |
| MP4：`©lyr` | 加一个 `MP4_TAG_LYRICS` 常量（与既有 `MP4_TAG_TITLE` 同一套） |
| WAV `LIST INFO` | **不动**（没有歌词字段） |
| `readTagsFromReader` 的各容器分支 | 把 `lyrics` 透传出来（现在各分支只填 4 个字段） |

⚠️ **`audioTags.ts` 是纯函数模块**（不 import Electron、不碰 fs）⇒ 新增的解析必须**纯字节**，
单测直接喂内存字节。

### 6.2 `electron/embeddedLyric.ts`（**新增**）

职责（**单一职责**：把「一个曲目 id」变成「一段 LRC 文本或 null」）：

- `resolveTrackPath(id)`：按 §3.1 的三条分支解析出**本地路径**（`local:` → 本地登记表；
  guid → 下载索引）；解析不到 → `null`；
- `readEmbeddedLyricFromFile(path)`：走 `readFileTags` ⇒ 取 `tags.lyrics`；
- `readEmbeddedLyricFromStream(guid)`：`GET …/track/stream?guid=` + `Range: bytes=0-65535`
  ⇒ **读满 64 KB 立刻 `reader.cancel()`** ⇒ 把这段字节喂给 `readTagsFromReader`
  （⚠️ 流式层只支持头在文件头的容器 ⇒ MP4 直接放弃）；
- `toLyricEntries(id, lrcText)`：产出 `LyricEntry[]`（`source = 'embedded'`）。

⚠️ **依赖注入**：文件读、流取、路径解析都要能注入 ⇒ 单测不碰真实磁盘与真实网络。

### 6.3 主进程接线

| 文件 | 改动 |
|---|---|
| `electron/main.ts` | 把「取流」的既有能力（`buildUpstreamRequest` + `http.fetch`，见 `:513-521`）复用给流式取标签；把 `localLibrary` / `downloadManager` 的**只读查询**接进 `embeddedLyric` |
| `electron/ipc.ts` | 新增 `ipcMain.handle('lyric:embedded', …)`；入参**只收 id**；返回 `{ entries }` 或 `{ entries: [] }`（**永不抛**） |
| `electron/preload.ts` | 暴露 `readEmbeddedLyric(id)` |
| `electron/localLibrary.ts` | 暴露「按 id 查绝对路径」的**只读**接口 |
| `electron/downloadManager.ts` | 暴露「按 songId 查已落盘文件」的**只读**接口 |

### 6.4 共享层

| 文件 | 改动 |
|---|---|
| `shared/playerBridge.ts` | `LyricBridge` 加 `readEmbeddedLyric(id)` |
| `shared/lyricProvider.ts` | 加 `LyricOrigin = 'nas' \| 'external' \| 'embedded' \| 'none'`；⚠️ **不给 `LYRIC_SOURCES` 加 `'embedded'`**（内嵌不是外部源，不进那个下拉） |

### 6.5 渲染层

| 文件 | 改动 |
|---|---|
| `src/player/lyricSource.ts` | `LyricLoadResult.origin` 加 `'embedded'`；`loadOnlineFirst` / `loadLocalFirst` 按 §4.2 插入内嵌层；`deps.embedded?` **可注入**（单测用，缺省 = 不查内嵌 ⇒ 既有测试行为不变） |
| `src/pages/FullPlayerPage.tsx` | `SOURCE_LABEL` 加「音频内嵌」；状态行如实显示 |
| `src/player/lyricOverlay.ts` | 若浮窗/词岛也显示来源 ⇒ 一并透传（**先查现状**，不改就不改） |
| `src/ui/lyrics/parse.ts` | **不改**（**一行都不改**） |

### 6.6 测试

| 文件 | 内容 |
|---|---|
| `test/audio-tags.test.ts`（改） | 新增用例：`USLT` / `SYLT` / Vorbis `LYRICS` / `UNSYNCEDLYRICS` / MP4 `©lyr` / 无歌词；`SYLT` 断言**转成了逐字标签**且**空白保留** |
| `test/embedded-lyric.test.ts`（**新增**） | id → 路径三条分支；流式的 Range 头与「读满即 abort」；`SYLT` 形态判定的三种文件形态（行模式 / 词模式带 `\n` / 词模式无 `\n`） |
| `test/lyric-source.test.ts`（改） | 优先级矩阵：`online-first` / `local-first` × (内嵌有 / 无) = 4 例；**内嵌为空 ⇒ 既有断言一字不改** |
| `e2e/t83-embedded-lyric.spec.ts`（**新增**） | 临时目录造一个带 `USLT` 的 mp3 字节 ⇒ 导入本地库 ⇒ 播放 ⇒ 断言歌词出现且来源显示「音频内嵌」 |
| 变异自证脚本（`release/verify/fnm-t83-mutations.mjs`，gitignored） | 8 条变异必须全被抓住：① 去掉 `USLT` 分支 ② `SYLT` 不转逐字 ③ `SYLT` 丢掉词间空格 ④ 内嵌层插错优先级 ⑤ 渲染层自己读文件 ⑥ 内嵌层失败时抛异常 ⑦ `LYRICS` 键取错 ⑧ 流式层无限读不 abort |

### 6.7 文档

- `README.md`：功能表加一行（本地音乐 / 歌词）；
- `docs/changelog.md`：新小节；
- `docs/calibration.md`：新一节（真机实测结论 + 未实测项）；
- 本文件（规格）；
- 台账（`progress-ledger.md`，**仓库外**）。

## 7. 验收点

1. `tsc --noEmit` **0 错误**；
2. `vitest` 全绿，且**既有断言一条不删、不削弱**；
3. `playwright` 全绿；
4. **变异自证 8 条全部被抓住**（改坏必红）；
5. 优先级矩阵 4 例全绿；**内嵌为空时行为与今天逐字一致**；
6. E2E：本地文件带内嵌歌词 ⇒ 歌词页出现歌词 + 来源显示「音频内嵌」；
7. **真机**（需要用户放两个文件）：
   - 一个带 `SYLT` 的 mp3 ⇒ 必须**进卡拉OK**（真逐字，`wordTimed=true`）；
   - 一个带 `LYRICS`（行级）的 flac ⇒ 必须走**整行显示**（不假装逐字）；
   - 一个**没有**任何歌词标签的文件 ⇒ 必须**与今天行为一致**（「暂无歌词」）。

## 8. 风险与待校准点（**未实测的一律标注，不写死成契约**）

| # | 待校准 | 现状 | 兜底 |
|---|---|---|---|
| ① | NAS `GET track/stream?guid=` 是否**支持 Range** | **未实测**（下载器一直在用 `range` 且接受 206，见 `downloadManager.ts:599`） | 不支持时：服务端返回 200 整流 ⇒ 我们**只读头 64 KB 就 cancel** ⇒ 不炸，但浪费一次连接 |
| ② | NAS 服务端「原始音质」是否**透传原文件字节** | **未实测**（标准音质明确是服务端转 MP3 320k ⇒ 标签必丢） | 若服务端永远转码 ⇒ **③ 层天然读不到歌词** ⇒ 功能实际生效在 **①② 两层**（本地文件 + 已下载文件） |
| ③ | 用户曲库里到底多少歌带内嵌歌词 | **未抽样** | 无（不影响实现，只影响收益） |
| ④ | `SYLT` 的行/词形态 | **未抽样**（形态判定是启发式，§4.5） | 规则写死 + 单测钉住；判错时退化成行级（**不崩、不假精细**） |
| ⑤ | `SYLT` 的时间戳格式字段（`1` = 绝对毫秒 / `2` = MPEG 帧号） | **未实测** | 只支持 `1`（绝对毫秒）；`2` ⇒ 该帧**放弃**（不猜帧率） |

## 9. 实施步骤

### commit 1 —— 规格（本文件）

- `docs/superpowers/specs/2026-11-10-sanlos-music-embedded-lyric-design.md`（新增）。

### commit 2 —— 实现

按 §6 的顺序：**先解析器（纯函数，好测）→ 再主进程取词模块 → 再接线 → 再渲染层 → 再测试 → 再文档**。

## 10. 附录：涉及的既有代码位置

| 关注点 | 位置 |
|---|---|
| 标签解析（纯函数） | `electron/audioTags.ts` |
| 标签解析的调用方 | `electron/localLibrary.ts:32`、`electron/downloadManager.ts:356`、`676` |
| 本地曲目 id | `electron/localLibrary.ts:170`（`local:<sha1 前 16 位>`） |
| NAS 音频流（带凭证 + Range） | `electron/main.ts:513-521` |
| 线上源链 | `electron/lyricProvider.ts:792`（`ONLINE_SOURCE_ORDER`）、`:809`（`buildSourceChain`） |
| 取词编排（渲染层） | `src/player/lyricSource.ts:242`（local-first）、`:286`（online-first）、`:350`（入口） |
| LRC 解析（**不改**） | `src/ui/lyrics/parse.ts:50`（`TIME_TAG`）、`:53`（`WORD_TAG`）、`:179`（`parseWordSegments`）、`:434`（`wordTimed`）、`:689`（`parseLyricEntries`） |
| 真逐字 / 伪逐字的分水岭 | `src/ui/lyrics/LyricView.tsx:611`、`buildSegments:153` |
| 歌词来源显示 | `src/pages/FullPlayerPage.tsx:268`、`520`（`SOURCE_LABEL`） |
| 设置页歌词两组 | `src/components/SettingsPanel.tsx:476`（来源）、`:533`（优先级） |
