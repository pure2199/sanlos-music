# T59 设计规格：抹除真实曲库内容与 NAS 对象标识

## 1. 起因

T58 把「明文口令 / 用户自有域名 / 真实 IP / 本机路径 / 会话标识」这 7 类抹掉了，判定口径
写在 `docs/superpowers/specs/2026-11-06-sanlos-music-redaction-design.md` §2。

但 T58 的口径里**没有「曲库内容」这一类** —— 它当时面向的是「仓库里的私有标识」，
而真实歌名/歌手/NAS 对象 id 散落在**真机校准文档与设计规格的实测记录**里，
当时被当成了「技术证据的上下文」留着。

发布到 **Public** 仓库让这件事的性质变了：

- 公开仓库的**历史是永久的**，事后擦不掉；
- 残留的**真实 track guid** 与 **serverGUID** 是「用户自有标识」，与已抹的域名/IP 同类
  —— 是 T58 的**漏网**，不是口径分歧；
- 残留的**真实歌名 / 歌手**是曲库指纹（哪几首歌、哪几位歌手、各有多少首），
  公开仓库里不需要它。

⇒ 补扫后向用户确认处理档位，用户拍板：**全抹**（NAS 标识 + 歌名/歌手都换成通用占位）。

## 2. 判定口径

### 2.1 抹

| 类别 | 具体 | 替换为 |
|---|---|---|
| **真实歌名** | 13 个（含 2 个「变体」写法） | `占位曲目一` … `占位曲目十三` |
| **真实歌手** | 2 个 | `占位歌手二` / `占位歌手三` |
| **NAS 对象标识** | 1 个 `serverGUID`、1 个真实 track guid | `<SERVER-GUID>` / 仓库既有的 32 位占位 hex |
| **码位引用** | 由真实歌名推出的「文件名首字符 = 某个具体码位」与实测报错原文里的那个数值 | 换成**新占位首字符**的码位与数值 |
| **URL 编码形态** | `Content-Disposition` 的 `filename*=UTF-8''…`、URL 编码测试样本 | 同步换成新占位串的百分号编码 |

⚠️ **码位引用必须同步换**：ByteString 那条根因的说明里写着「文件名首字符是某个
具体汉字，它的码位是某个具体数值，正好落在报错的 index 22」。占位名的首字符换掉后，
**index 22 仍然不变**（前缀 `attachment; filename="` 恰好 22 个字符，与文件名内容无关），
但**码位数值必须跟着改**（新首字符的码位同样 > 255，同样会触发 ByteString 校验失败），
否则文档会自相矛盾。

⚠️ **本规格不写任何具体码位数值**（原值与替换值都不写）—— 码位数值本身虽是公开的
技术事实，但它**由真实歌名推出**，写出来就等于把歌名又抄了一遍。

### 2.2 留（并说明为什么）

| 留的 | 理由 |
|---|---|
| `示例曲目 N` / `占位歌手` / `占位歌名` / `歌一` 等**仓库既有**占位 | 本来就是通用占位 |
| `专辑#1` / `A/B` / `不是地址` / `第一行` | 通用测试样本 |
| **曲库格式分布计数**（mp3 2389 / flac 1982 / aac 36 / ape 3） | 是**一个抽样页**的聚合数（合计约 4.4 千，远小于真实总量 17 万），不含任何具体条目，不构成可定位的指纹 |
| `占 & 位`（URL 编码测试样本） | ⚠️ 一并换成了 `占 & 位`：它与其它真实歌名同形，宁可多换一处，也不留「可能是真歌名」的尾巴。断言的**鉴别力不变**（仍钉死「CJK + 空格 + `&` 的百分号编码」） |
| **开发者署名 / 公司 / 官网 / 备案号** | 与 T58 同：这是产品身份，不是私有值 |

### 2.3 探针是唯一的例外：搜索词要能配

`tools/fn-album-detail-probe.mjs` 与 `tools/fn-live-check.mjs` 里有一处**按歌手名搜索**
（真机联调时要搜一个**用户曲库里真实存在的**歌手，否则搜不到任何东西）。

直接换成占位 → **探针立刻失效**（搜一个不存在的歌手，返回空列表），
等于为了脱敏把工具改坏。

⇒ 按仓库**既有的凭证约定**处理：`tools/` 下所有真机探针的账号/口令/地址一律走环境变量
（`FN_USER` / `FN_PASS` / `FN_SERVER` / `FN_ID`）。本轮新增同族的 `FN_ARTIST`：

```js
const q = encodeURIComponent(process.env.FN_ARTIST ?? '占位歌手')
```

⇒ 仓库里**不再有**真实歌手名；探针在用户机器上仍可用（注入 `FN_ARTIST` 即可）。

## 3. 影响文件清单

**已跟踪，19 个文件被改写（均为注释 / 文档 / 测试样本 / 探针搜索词）**

| 文件 | 改了什么 |
|---|---|
| `docs/calibration.md`（**CRLF**） | 真机校准记录里的歌名、歌手、track guid |
| `docs/changelog.md` | 码位引用（首字符 + 码位数值） |
| `docs/superpowers/specs/2026-11-02-fnmusic-desktop-design.md`（**CRLF**） | 实测样本歌名、serverGUID |
| `docs/superpowers/specs/2026-11-04-fnmusic-lyric-provider-design.md` | 歌名 |
| `docs/superpowers/specs/2026-11-04-fnmusic-lyric-qq-source-design.md` | 歌名 |
| `docs/superpowers/specs/2026-11-05-fnmusic-local-music-design.md` | 文件名反推示例里的歌名/歌手 |
| `docs/superpowers/specs/2026-11-05-sanlos-music-stream-quality-ready-design.md` | 抽样曲目表 |
| `docs/superpowers/specs/2026-11-06-sanlos-music-upstream-net-request-design.md` | 文件名示例 + 码位引用 |
| `electron/http.ts` | 注释里的中文文件名示例 |
| `electron/lyricProvider.ts` | 注释里的歌名 |
| `electron/proxy.ts`（**CRLF**） | 注释里的中文文件名示例 |
| `shared/localMeta.ts` | `parseTrackFileName` 的示例文件名 |
| `src/player/transcode.ts` | 注释里的失败曲目名 |
| `test/http-stack.test.ts` | 中文文件名**样本** + 码位注释 |
| `test/local-library.test.ts` | 真实 track guid → 占位 hex |
| `test/lyric-provider.test.ts` | 同名歌样本的标题 + URL 编码样本 |
| `test/proxy.test.ts` | 中文文件名样本 |

**已跟踪，2 个探针改造（搜索词走环境变量）**

- `tools/fn-album-detail-probe.mjs`
- `tools/fn-live-check.mjs`

**仓库外**

- 台账 `progress-ledger.md`：本轮重写历史后，97 处 sha 引用要**再**同步一次。

⚠️ **既有测试一条不许删、断言一条不许削弱**。本轮改动的断言只有两类：

1. **样本值替换**（`title: '占位曲目一'` → `title: '占位曲目一'`）：断言的**结构与鉴别力一字未变**
   ——「同名歌很多时选中时长对得上的那条」仍然是靠**时长**区分，不是靠歌名；
2. **URL 编码期望串**（`%E9%97%AE…` → `%E5%8D%A0…`）：仍然逐字钉死编码结果。

## 4. 验收点

1. 工作树里 **24 类私值 0 命中**（歌名 / 歌手 / serverGUID / track guid / 码位）；
2. `tsc --noEmit` exit 0；
3. `vitest` **1862 passed / 85 files**（与改动前**完全一致**，不增不减）；
4. `playwright` **24 passed**；
5. `npm run build` exit 0；
6. 改写过的文件：**行尾保持原样**（CRLF 的 3 个文件仍是 CRLF，其余仍是 LF）、无 BOM、无 U+FFFD；
7. 历史重写后：**全部 commit 的内容与提交信息**里私值 0 命中，旧对象真的消失。

## 5. 风险与遗留

- **重写历史会再改一轮 sha**（本轮是第二次）→ 台账的 sha 引用要再同步一次；
  任何**外部**引用（PR 链接、CI 徽章）目前都没有。
- **探针要用户自己注入 `FN_ARTIST`**：不注入时搜索步骤会搜一个不存在的占位歌手
  → 只能验证「搜索通路通不通」，不能验证「搜到真实歌手的结果」。
  这是脱敏与可用性的**必要取舍**，已在两处探针的注释里写明。
- **真机校准记录的可追溯性下降**：歌名换掉后，
  「哪首歌在哪个版本崩了」需要靠上下文（时长 / 位深 / 进度百分比）反推 ——
  这些技术数据一个没动。
- 真实曲名/歌手**只出现在**真机校准文档与设计规格的实测记录里，
  **运行时代码零改动**（`src/` / `electron/` 只改了注释）。
