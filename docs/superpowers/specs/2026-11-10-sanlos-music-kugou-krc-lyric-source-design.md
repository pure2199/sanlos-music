# T74a 设计规格：接酷狗 KRC 真逐字歌词源

> ⚠️ **本规格未实施（2026-11-10 已放弃并整体回滚）**。
>
> 用户在审阅后改变方向：「**满足行字时间戳的歌词就用卡啦OK模式，不满足的就正常整行显示就好**」
> ⇒ 决定**先修观感，不追词源**。
>
> - T74a 的实现（KRC 解密 / 酷狗源 / 设置页下拉）**已整体回滚**，仓库里**没有**这部分代码；
> - 替代方案见 **T81 规格**：
>   `docs/superpowers/specs/2026-11-10-sanlos-music-word-timed-karaoke-gate-design.md`；
> - 本文档**仅作历史记录**保留（§2 的实测结论仍然有效：QQ 源只有行级 LRC ⇒ 走伪逐字）。
>
> ⚠️ 若日后仍要接酷狗 KRC，**先读 T81 规格**：两者不冲突，但 T81 才是当前主线。

## 1. 起因

用户报障：「怎么现在歌词时间戳又不对了？」。经本机实测排查（详见 §2），结论是：

- **不是**旧包、**不是**旧实例（三处判定源已统一、可听延迟实测仅 10ms）；
- **是源的天花板**：用户当前 `lyric.source = "qq"`，而 **QQ 歌词端点只能返回明文行级 LRC**
  （逐字 qrc 在 `u.y.qq.com` 的 `PlayLyricInfo`，且是密文）⇒ 全部走**伪逐字**
  ⇒ **字级时间戳是按音节权重插值编造的** ⇒ 卡拉OK 扫光必然跟不准人声。

⇒ 要让「字」变准，必须换到**能给真逐字**的源。本任务新增**酷狗音乐**源。

### 1.1 目标

- 新增「酷狗音乐」外部歌词源，能取到**真逐字**（KRC）；
- 用户可在设置里切过去 ⇒ 卡拉OK 扫光按**真实词级时间戳**推进；
- **零新增解析分支**：KRC 转成**标准增强 LRC**（`<mm:ss.xx>` 逐字标签），
  交给**现有**解析器（`parseWordSegments` 早就在等喂）⇒ **渲染层解析器一字不改**；
- 不引新 npm 依赖（`zlib` 是 Node 内置）。

### 1.2 不做什么（范围收窄）

- **不做 QQ qrc**（3DES 密文 + eapi 加密，复杂度更高）⇒ 另议；
- **不做多源择优**（并发取多个源、优先真逐字）⇒ **T74b**；
- **不改源链顺序**（酷狗排最前）⇒ **T74b**（本任务只把 `'kugou'` 加进源链，
  位置与「用户选的源排第一」的既有规则不变）；
- **不改默认源**（仍 `netease`）；
- **不做 T72 手动偏移滑块**（治「行整体偏几秒」，与「字不准」是另一个病）；
- **不改 `src/ui/lyrics/parse.ts`**；
- **不碰服务端 NAS 歌词**。

## 2. 实测依据（2026-11-09 / 10，本机真打）

### 2.1 各源的「真逐字」能力

| 源 | 搜索 | 逐字 | 结论 |
|---|---|---|---|
| **QQ** | `c.y.qq.com/soso/fcgi-bin/client_search_cp`（**必须带 Referer**，否则 `retcode=-1310` 且歌词长度 0，HTTP 仍 200 ⇒ 静默失败） | ❌ **只有行级**（qrc 密文，拿不到） | 行准、字不准 |
| **网易云** | `music.163.com/api/search/get/web` | ⚠️ `yv=-1` 才有 `yrc`；yrc 来自 **K 歌用户上传** ⇒ **周杰伦的歌实测搜不到原唱**（搜「一路向北 歌手」全是 DJ 版/伴奏版/虚拟歌手），实测候选全部 `hasYrc=false` | 对大牌歌**不通用** |
| **酷狗** | ✅ **免签名**：`mobilecdn.kugou.com/api/v3/search/song`（`www.kugou.com/yy/search/song` 返回 **`"Access Deny ! No Actions !"`**，加 Referer 也一样） | ✅ **KRC 真逐字** | **本任务采用** |

### 2.2 酷狗 KRC 真逐字覆盖率（18 首抽样）

抽样：周杰伦 5 首、林俊杰 2 首、邓紫棋/陈奕迅/薛之谦/Beyond/李克勤各 1~2 首、
Ed Sheeran / Adele 各 1 首。判定「真逐字」= 该行的**词时长不全相等**（相对差 ≥ 3%）。

| 结果 | 数值 |
|---|---|
| 成功取到 KRC | **18 / 18** |
| 真逐字行占比 | **89% ~ 100%**（一路向北/周杰伦 100%、Shape of You 100%、青花瓷 100%） |
| 每首的**元信息行**数 | 0 ~ 8 行（`词：X` `曲：X` `编曲：X` `歌名 - 歌手`） |

⇒ 酷狗 KRC 是**唯一实测能对大牌歌给真逐字**的路。

### 2.3 端点与坑（全部实测）

| 端点 | 用途 | 实测 |
|---|---|---|
| `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=…&page=1&pagesize=20&showtype=1` | 搜索 | ✅ 免签名可用；返回 `data.info[]`（`hash` / `songname` / `singername` / `album_id` / `duration`（**秒**）） |
| `http://krcs.kugou.com/search?ver=1&man=yes&client=pc&utf8=1&keyword=…&duration=…&hash=…` | 取 `accesskey` | ✅ 返回 `candidates[0]`（`id` / `accesskey` / `contenttype` / `krctype`） |
| `http://lyrics.kugou.com/download?ver=1&client=pc&id=…&accesskey=…&fmt=krc&charset=utf8` | 下载 KRC | ✅ 返回 **JSON**：`{"status":200,"info":"OK","fmt":"krc","contenttype":0,"content":"<base64>"}` |
| `http://www.kugou.com/yy/index.php?r=play/getdata&hash=…&album_id=…&format=json` | （旧接口） | ❌ `err_code: 20010`（参数错）⇒ **不用** |

⚠️ **`fmt=lrc` 拿到的是行级 LRC**（无逐字标签）⇒ 必须用 `fmt=krc`。

⚠️ **响应可能是 JSON 也可能是纯文本** ⇒ 解析器两条路都要看
（本轮探针第一次只读 `raw` 分支，把 JSON 响应误判成「空内容」，白查一轮）。

### 2.4 KRC 格式与解密算法

**载荷**：base64 → 解码后前 4 字节是 ASCII `krc1` → 其余是 **XOR 加密的 zlib 流**。

**解密**（4 个独立公开实现交叉验证一致：CSDN 的 Python 版与 JS 版、精易论坛易语言版、
KuGouMusicApi 的 `util/util.js`、Rust `lyrics-helper` 的 `decrypt_krc`）：

```
body   = base64Decode(content).subarray(4)      // 跳过 "krc1"
body[i] ^= KRC_XOR_KEY[i % 16]                  // 循环 XOR
plain  = zlib.inflateSync(body).toString('utf8') // 标准 zlib
```

```
KRC_XOR_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]
```

**验算**：密文首两字节 `0x38 0xdb` ⊕ `0x40 0x47` = `0x78 0x9c` ⇒ **正是 zlib 头** ✅

**解密后的明文**（实测）：

```
[id:$00000000]
[ti:一路向北 (《头文字D》电影插曲)]
[ar:周杰伦]
[0,13544]<0,1693,0>一<1693,1693,0>路<3386,1693,0>向<5079,846,0>北<5925,847,0> <6772,1693,0>- <8465,1693,0>周<10158,1693,0>杰<11851,1693,0>伦
[35576,3432]<0,335,0>后<335,440,0>视<775,417,0>镜<1192,487,0>里<1679,433,0>的<2112,512,0>世<2624,808,0>界
```

⚠️ **与网易云 yrc 的三处关键差异**（转换器必须区别对待）：

| | 网易云 yrc | **酷狗 KRC** |
|---|---|---|
| 词元组形状 | `(词开始ms,词时长ms,0)` | `<词开始ms,词时长ms,0>` |
| 词时间的基准 | **绝对毫秒**（从歌开头算起） | **相对行开始的毫秒** ⇒ 绝对 = **行开始 + 相对** |
| 额外内容 | 无 | **元信息行**（制作信息 + 标题行） |

⚠️ 解密后可能是 **UTF-8 with BOM**（实测部分文件带 `﻿`）⇒ 解析时须容忍。

## 3. 设计

### 3.1 架构

两个边界清晰的新单元：

| 单元 | 职责 | 依赖 | 可测性 |
|---|---|---|---|
| **`electron/lyricWordFormat.ts`**（新增） | `msToLrcTag()`：毫秒 → LRC 时间标签 | 无 | 纯函数 |
| **`electron/kugouKrc.ts`**（新增） | ① `decodeKrcPayload()`：base64 → 解密 → 明文<br>② `krcToEnhancedLrc()`：KRC 明文 → 增强 LRC（含元信息行过滤）<br>③ `isKrcMetaLine()`：元信息行判定 | 仅 `node:zlib`（Node 内置） | 纯函数，直接单测 |
| **`electron/lyricProvider.ts`**（改） | `fetchKugou()`：搜索 → accesskey → 下载 → 调上面的纯函数 | `fetchImpl`（注入） | 注入假 fetch 即可测 |

**为什么把 `msToLrcTag` 抽出来**：`electron/lyricProvider.ts` 里它当前是**私有函数**
（未导出），KRC 转换器需要同样的换算 ⇒ 抽到 `electron/lyricWordFormat.ts` 后两处共用。
⚠️ **公开导出不变**（`yrcToEnhancedLrc` 仍在 `lyricProvider.ts` 导出）⇒ **既有测试一条不改**。

**为什么不塞进 `electron/lyricProvider.ts`**：那文件已 900+ 行且混了 4 个适配器；
解密与格式转换是**独立于网络**的领域逻辑，单独成文件才能纯函数单测，
也便于日后 QQ qrc 复用同一套「逐字 → 增强 LRC」的思路。

### 3.2 KRC → 增强 LRC 的转换规则（定死）

1. **逐行**扫描；行头用 `^\[(\d+),(\d+)\]` 取「行开始 ms」；不匹配的（`[id:…]` `[ti:…]`
   `[total:…]` `[language:…]` 等头标签）**自动跳过**；
2. 行内按**顺序扫描**找词元组 `<(\d+),(\d+),(\d+)>`（只认数字形状）
   ⇒ 词文本里的尖括号**不会错位**；
3. **词的绝对时间 = 行开始 + 相对毫秒**（KRC 的词时间是相对行开始的）；
4. **零时长词**（实测是标点 / 停顿占位，如 `<556,0,0>`）→ **并入前一个词**，不单独成词
   （没有前词可并 ⇒ 丢弃）—— 与 yrc 的同一套处理；
5. 词开始早于行开始（异常数据）→ **钳到行开始**；
6. 一行里**没有有效词** → **跳过该行**；
7. **元信息行** → **跳过**（规则见 §3.3）；
8. 空串 / 非串 → 返回空串（**不抛异常**）。

输出格式与 yrc 转换器**完全一致**：

```
[行标签]<词1标签>词1<词2标签>词2…
```

⇒ 交给**现有** `parseLyricEntries` ⇒ `assemble` 走 `current.words` 分支（**真逐字**）
⇒ **渲染层一字不改**。

### 3.3 元信息行过滤（保守，两类）

实测每首 0 ~ 8 行，形态固定：

| 类别 | 实例 | 规则 |
|---|---|---|
| **制作信息行** | `词：方文山` `曲：周杰伦` `编曲：蔡科俊` `吉他：X` `贝斯：X` `制作人：X` `OP：X` | **前缀白名单**命中 ⇒ **无条件跳过**（任何位置） |
| **标题行** | `一路向北 - 周杰伦` / `周杰伦 - 稻香` / `晴天 - 周杰伦 (Jay Chou)` | **三个条件全满足**才跳过：① 出现在**前 5 行**内 ② 长度 ≤ 30 字 ③ 含 ` - `（两侧空格） |

**前缀白名单**（`词` `曲` `编曲` `监制` `出品` `制作人` `录音` `混音` `母带` `和声` `吉他`
`贝斯` `鼓` `弦乐` `键盘` `语言` `演唱` `歌手` `专辑` `发行` `策划` `统筹` `封面`
`OP` `SP` `特别鸣谢` `原唱` `和声制作` `鼓手` `乐手` `音乐制作` `录音师` `混音师` `母带师`）
后接 `:` 或 `：`。

**为什么标题行要三个条件**：正常歌词里也可能出现 `xxx - yyy` 的写法
⇒ 单靠「含 ` - `」会误杀 ⇒ 叠加「短」与「在前 5 行内」两道闸。

**为什么制作信息行无条件跳**：这些词头是**制作元信息**，任何位置都不是歌词。

⚠️ 该规则必须有单测钉住，**且要有「正常歌词不被误杀」的防误杀用例**。

### 3.4 数据流

```
设置页选「酷狗音乐」 → prefs.lyric.source='kugou'
 → 切歌 / 改源 → 渲染层 loadLyricEntries → IPC fetchExternalLyric
   → 主进程 buildSourceChain（用户选的源排第一 ⇒ 'kugou' 在第一位）
     → fetchOne('kugou', 源级 6 秒预算)
       ① mobilecdn.kugou.com/api/v3/search/song   （免签名）
       ② krcs.kugou.com/search                     → accesskey
       ③ lyrics.kugou.com/download?fmt=krc          → base64
       ④ decodeKrcPayload → krcToEnhancedLrc（过滤元信息行）
     → { status:'ok', source:'kugou', original: 增强LRC, translation:'' }
   → toExternalEntries → parseLyricEntries
     → 增强 LRC 带 <mm:ss.xx> ⇒ assemble 走「真逐字」分支（**不走**伪逐字）
   → 三处歌词页面（词岛 / 经典浮窗 / 全屏舞台）共用同一份 lines
     ⇒ 卡拉OK 按**真实词级时间戳**推进
```

**候选匹配**：复用现成的 `pickCandidate`（歌名 → 歌手 → 时长 ±3s）。
⚠️ 酷狗候选的 `duration` 是**秒**（实测《一路向北》= 294），与既有口径一致。
⚠️ 用户曲库里的歌手名可能是字面「歌手」（NAS 元数据问题）⇒ 歌手过滤会落空
⇒ 靠「歌名命中 + 时长 ±3s」兜底选中正确版本。

### 3.5 错误处理（全部**如实上报**，不静默）

| 情况 | 结果 |
|---|---|
| 搜索无结果 / `krcs` 无候选 | `not-found` |
| 下载非 200 / 无 `content` | `error`（带消息） |
| base64 解出来**头不是 `krc1`** | `error`（**如实报，不静默吞掉**） |
| zlib 解压失败 | `error` |
| 解密后**过滤完没有有效歌词行** | `not-found` |
| 任一环节超时 | 源级 6 秒 ⇒ `error`，源链继续试下一个源 |

### 3.6 超时预算

现有 `PER_SOURCE_TIMEOUT_MS = 3000` 是**每源**预算（`fetchOne` 已是源级总预算）。
酷狗要**串行三跳**（搜索 → accesskey → 下载）⇒ 单独给 **6 秒**
（`KUGOU_SOURCE_TIMEOUT_MS`），其余源仍 3 秒。

⚠️ 内部三个请求各自仍受主进程 http 超时（30 秒）兜底，但源级 `Promise.race`
先超时 ⇒ 不会挂死。

## 4. 影响文件清单

| 文件 | 改动 | 性质 |
|---|---|---|
| `electron/lyricWordFormat.ts` | **新增**：`msToLrcTag()` | 纯函数 |
| `electron/kugouKrc.ts` | **新增**：`decodeKrcPayload()` / `krcToEnhancedLrc()` / `isKrcMetaLine()` | 纯函数 |
| `electron/lyricProvider.ts` | 加 `fetchKugou()`；`ONLINE_SOURCE_ORDER` 加 `'kugou'`；酷狗源级预算 6 秒；`msToLrcTag` 改为 import | 改 |
| `shared/lyricProvider.ts` | `LyricSource` 加 `'kugou'`；`LYRIC_SOURCES` 白名单加 | 改（3 行） |
| `src/pages/FullPlayerPage.tsx` | `SOURCE_LABEL` 加 `kugou: '酷狗音乐'` | 改（1 行） |
| `src/components/SettingsPanel.tsx` | 下拉加一个 `<option value="kugou">` | 改（1 行） |
| `test/kugou-krc.test.ts` | **新增**：纯函数单测（解密 / 换算 / 过滤 / 防误杀） | 新增 |
| `test/lyric-provider.test.ts` | 加酷狗适配器用例（注入假 fetch）+ `normalizeLyricSource('kugou')` | 改（只加不减） |
| `docs/changelog.md`、`README.md` | 文档 | 改 |

## 5. 测试与验收

### 5.1 单测（新增 `test/kugou-krc.test.ts`）

- `decodeKrcPayload`：正常载荷 → 明文；头不是 `krc1` → **抛错**；非法 base64 → **抛错**；
  带 BOM 的载荷 → 明文保留（后续解析容忍）；
- `krcToEnhancedLrc`：
  - **词时间 = 行开始 + 相对毫秒**（核心断言）；
  - 行数与 KRC 的有效行一致；
  - 词时间**严格递增**；
  - **不丢字**（转换前后的纯文字逐字相同）；
  - **零时长词并入前一个词**；
  - 输出**能被 `looksLikeLrc` 接受**；
  - 空串 / 非串 → 空串（不抛异常）；畸形输入不抛异常；
- `isKrcMetaLine`：
  - `词：方文山` / `曲：周杰伦` / `编曲：蔡科俊` / `OP：X` ⇒ 判为元信息行；
  - `一路向北 - 周杰伦`（前 5 行内、≤30 字）⇒ 判为元信息行；
  - **防误杀**：普通歌词行（中文长句、含 ` - ` 的短句但在**第 6 行之后**、
    含 ` - ` 但**超过 30 字**）⇒ **判为歌词行**；
- `shared/lyricProvider`：`normalizeLyricSource('kugou')` → `'kugou'`；陌生值仍回落默认。

### 5.2 变异自证（每条必须**变红**）

| 变异 | 期望 |
|---|---|
| `KRC_XOR_KEY` 改 1 个字节 | 解密单测必红 |
| 去掉「加行开始」（词时间直接用相对毫秒） | 词时间单测必红 |
| 关掉元信息行过滤 | 过滤单测必红 |
| 去掉「跳过 4 字节头」 | 解密单测必红 |

### 5.3 验收点

- `tsc --noEmit` **0 错**；
- `vitest run` **全绿**（既有测试**一条不删、断言一条不削弱**；只新增）；
- `npm run build` exit 0；
- **真机**：设置里选「酷狗音乐」→ 切歌 → 全屏歌词页显示「歌词来源：酷狗音乐」；
  词岛 / 经典浮窗的卡拉OK 扫光**跟嘴**；「词：方文山」这类行**不出现**；
  切回别的源仍正常。

## 6. 后续（T74b，不在本任务）

- 多源**并发**取词、**优先真逐字**（需要 `ExternalLyricResult` 增加「是否真逐字」标记）；
- 酷狗排源链**最前**；
- 与之配套的「界面显示实际命中的源 + 是否真逐字」。
