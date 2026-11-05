# T54 设计规格：音质偏好（原始音质 / 标准音质）

- 日期：2026-11-05
- 承接：T53（词岛的长歌词不再被裁掉）
- 状态：已实现并验证

> ⚠️ **T55 已更正本规格第 2 节的第 4 条**（当时写的「本机 NAS 的**转码引擎不可用**」是**误判**）：
> 2026-11-05 的 T55-0 探针组实测 —— 服务端转码**一直是好的**（抽样 14 首 **14/14 成功**，
> 平均就绪 **988 ms**，产物 = MP3 320k，比原始 FLAC **省 88.8 % 流量**）；
> 当时的失败来自**客户端的就绪判定**（`percent>=100` 后**单次**预检，一次误判即回退）。
> 更正与新设计见
> [`2026-11-05-sanlos-music-stream-quality-ready-design.md`](./2026-11-05-sanlos-music-stream-quality-ready-design.md)。

---

## 1. 起因（用户原话）

> 加入音质偏好设置，原始音质和标准音质，标准音质好是192K飞牛音乐服务器支持的好像是这个

---

## 2. 目标与取舍

用户诉求：「音质偏好设置，原始音质 / 标准音质」——**省流量**。

取舍只有一个：**省流量只能靠服务端转码**（客户端转码仍要先拉完整原文件，流量一分不省）。
所以先花 9 轮探针把「服务端转码入口」挖到底，再据此设计客户端。

⚠️ **实测结论先行**（原始数据见 [`docs/calibration.md`](../../calibration.md)「三十九、T54」）：

1. 官方 App **播放侧**那套（`POST /track/transcode` → `GET /track/hls/{guid}/preset.m3u8`）
   在本机 NAS 上**不可用**（16 种请求体形状全 `code=100001`）；
2. **真正可用的是「下载侧」那套**：
   `download/track/transcode/{prepare,status,file,delete}`；
3. 服务端**只认** `quality` 的 `standard` 与 `original` 两个值
   （`higher` / `exhigh` → `code=100002 invalid arguments`）；
4. 但本机 NAS 的**转码引擎不可用**（`errno=68157441 / errmsg='transcoding error'`）。

⇒ 客户端侧的**设计目标**因此定为「**铺路 + 诚实降级**」：
**协议链路一次做对**，服务端一旦具备能力就**自动生效**；在此之前**绝不假装成功**。

---

## 3. 数据模型

```ts
// shared/types.ts
export type StreamQuality = 'original' | 'standard'
```

| 取值 | 语义 |
| --- | --- |
| `original` | **原始音质**：直拉 NAS 上的原文件（FLAC 等）——**既有行为，一字不变** |
| `standard` | **标准音质**：让 NAS 服务端转码（官方旧下载协议里 = MP3 320k）后播放 |

- ⚠️ **缺省 = `original`** → 老用户升级后行为**一字不变**；
- ⚠️ **非敏感**：只是一个档位名，落 `prefs.json`，与 `session.bin`（凭证）**无关**；
- ⚠️ **主进程白名单只认这两个值**：`prefs.json` 是用户可编辑的文件 → 陌生值**整段丢弃**；
- ⚠️ **服务端没有 192k 那一档**（用户原话里的「192K」在服务端不存在）。

---

## 4. 协议（渲染层 → `fnm://` 代理 → NAS）

| 步骤 | 请求 | 成功 | 失败 |
| --- | --- | --- | --- |
| 1. 准备 | `POST download/track/transcode/prepare` `{ trackGUID, quality }` | `code:0` → `data.downloadId` | `code≠0` → `prepare-rejected` |
| 2. 轮询 | `GET download/track/transcode/status?downloadId=` | `data.percent` 递增 | `data.status='failed'` → `transcode-failed` |
| 3. 产物 | `GET download/track/transcode/file?downloadId=` | 音频字节（**支持 Range**） | 读不出 → `unavailable` |
| 4. 清理 | `POST download/track/transcode/delete` `{ downloadId }` | `data.deleted:true` | 忽略（服务端自回收） |

**两条实测得来的「反直觉」约束**（写进代码注释，避免后人踩）：

1. **`status` 的 `status` 词不可信** —— 第一次查询就报 `ready`，随后又变回 `transcoding/percent=N`。
   ⇒ **只认 `percent`**（`percent >= 100` 才算完成）。
2. **产物端点可能挂死** —— 任务标称 `ready` 时，`GET file` **45 秒拿不到响应头**。
   ⇒ 起播前必须**产物预检**（Range 取首字节），否则界面会一直停在「缓冲中…」，用户以为卡死。

---

## 5. 客户端设计

| 层 | 做法 |
| --- | --- |
| **代理**（`electron/proxy.ts`） | `download/track/transcode/file` 加进 `DEFAULT_BINARY_PATHS` → 走**二进制透传**：上游 body 直接作为响应体，`Range` / `206` 原样透传。⚠️ **必须**：JSON 路径会把字节丢掉（`JSON.parse` 失败 → `null`），且有 30 秒超时、**不透传 `Range`**（拖进度条就没了） |
| **协议模块**（`src/player/transcode.ts`） | 渲染层只说「给这首歌准备标准音质」；**不碰凭证**、**不直连**；失败一律抛**可判别**的 `TranscodeError`（`prepare-rejected` / `transcode-failed` / `timeout` / `unavailable` / `network`） |
| **引擎**（`src/player/engine.ts`） | 新增两个接缝：`prepareStandardSource?: (song) => Promise<string>`、`streamQuality?: () => StreamQuality`；标准音质走 `playViaStandardQuality()`（复用既有的 `preparing` / **世代号作废**机制 → 切歌后旧结果回来**不得**改状态） |
| **播放源**（`src/state/downloadStore.ts`） | `prepareStandardQualitySource(song)`：**本地曲目**、**本地有副本且「本地优先」开着** → 返回**空串**（不需要转码）；否则 → 走服务端转码 |
| **偏好镜像**（`src/state/appPrefsStore.ts`） | 与既有偏好同一套纪律：乐观应用 + 写回失败**回滚** |
| **设置页** | 「解码」分类新增「音质偏好」：两档单选 + 说明 + 「检测服务端能力」按钮（如实回答这台 NAS 到底能不能转） |
| **播放条** | 准备中 → 「正在准备标准音质…」（`role="status"`）；失败 → **灰字**说明「标准音质不可用：…，已改用原始音质播放」（`role="status"`，**不是**错误） |

---

## 6. 失败语义（本设计的核心）

**标准音质失败 ≠ 播放失败**。

- 失败 → **自动改用原始音质**，音乐照常播（**不黑屏、不卡死**）；
- 同时给一条**灰字**说明（**如实带上服务端给的原因**，如「服务端转码失败（transcoding error）」）；
- **绝不用红色 `role="alert"`** —— 那会误导成「播放出错」，而音乐其实照放。

---

## 7. 安全边界（不放宽）

- 渲染层**永远拿不到凭证**：转码请求只经 `fnm://` 代理，凭证由主进程注入；
- `prefs.json` 里**只有档位名**，没有凭证；
- 产物地址只经 `fnm://`（**同源代理**），不引入新的 scheme、不放宽任何跨源策略；
- 代理的**路径护栏不动**（`download/track/transcode/file` 的每一段都是普通 ASCII，无点号）。

---

## 8. 验收点

1. `tsc --noEmit` 0 错；
2. 单元测试**全绿**（既有断言一条不许删、不许削弱）；
3. Playwright E2E 全绿；
4. 打包通过；
5. **真机**：切「标准音质」→ 服务端失败时**自动回退原始音质** + 灰字说明，且**音乐照常播**；
6. 偏好**跨重启保留**。

---

## 9. 已知限制（如实标注）

- ⚠️ **当前这台 NAS 上标准音质必然回退**（转码引擎 `errno=68157441`）；
- ⚠️ 服务端**没有 192k**（只有 `standard` = 320k 与 `original`）；
- ⚠️ 服务端转码**占 NAS 的 CPU**，切歌时有几秒等待；
- ⚠️ 「检测服务端能力」会**真的让 NAS 转一遍**（只在用户点按钮时触发，**不做启动自动探测**）；
- ⚠️ **待用户侧确认**：NAS 的 fnOS 版本（实测 `serverVersion=1.0.10` / `mediasrvVersion=0.8.43`）
  与应用中心里是否有「媒体转码」类组件需要启用。
