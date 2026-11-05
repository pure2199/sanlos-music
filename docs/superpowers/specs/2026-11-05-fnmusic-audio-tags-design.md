# T39 设计规格：真标签解析（本地音乐的歌名 / 歌手 / 时长）

- 日期：2026-11-05
- 状态：已获用户批准（问卷：覆盖范围 / 解析时机 两项均取推荐项）
- 前置：T38（未登录也能当播放器：本地音乐 + 已下载）、Task 11（`fnml://`）、Task 12（FFmpeg 兜底）

---

## 1. 背景与动机

T38 把「没登录也能当播放器」做出来了，但本地曲目的元数据是**文件名反推出来的近似值**，时长在播放前一律显示 `--`。

### 1.1 现状（代码事实）

| 现状 | 证据 |
| --- | --- |
| 本地曲目的歌名 / 歌手来自**文件名反推** | `shared/localMeta.ts` 的 `parseTrackFileName()`；`electron/localLibrary.ts` 的 `addPaths()` 调它 |
| 时长恒为 0 | `src/state/localLibraryStore.ts` 的 `localItemToSong()` 写死 `duration: 0` |
| 播放后才补时长 | `src/player/engine.ts` 的 `durationchange` → `handleDurationChange()`（只补**当前这一首**） |
| 队列里其它曲目仍是 `--` | `SongList` 渲染 `formatDuration(song.duration)` |
| 「已下载」分区的歌名 / 歌手是 NAS 快照（精确），但时长同样为 0 | `shared/playerBridge.ts` 的 `DownloadEntry`；`src/state/downloadStore.ts` 的 `downloadEntryToSong()` |
| **全仓库没有任何音频标签解析** | `grep -ri "id3\|vorbiscomment\|flac" --include=*.ts` 无命中 |

⇒ 短板是**元数据精度**，不是播放通路。补齐它需要**手写标签解析器**（**不引新 npm 依赖**）。

### 1.2 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 覆盖范围 | **「本地文件」+「已下载」都做**：已下载也补时长，老条目一并回填 |
| 解析时机 | **后台渐进解析**：登记立刻完成，列表随后逐批变精确 |

---

## 2. 核心思路

### 2.1 解析器是纯函数，住在主进程

```
文件字节  →  [ electron/audioTags.ts 纯解析器 ]  →  AudioTags { title?, artist?, album?, duration? }
                                                              ↓
                                              合并规则（标签优先、文件名兜底）
                                                              ↓
                                    清单条目（local-library.json / downloads.json）
```

- **纯函数**：输入 `Buffer`，输出结构化标签；**不碰 fs、不碰 Electron** → 单测直接喂构造出来的字节流，**不放二进制样本文件**；
- **主进程持有**：读取文件头 / 文件尾的是主进程 → **渲染层的文件系统边界一个字没松**；
- **失败即兜底**：解析不出来、格式不认识、文件读不到 → 静默退回文件名反推，**绝不崩、绝不弹错误**。

### 2.2 标签优先、文件名兜底

```
歌名 = 标签 TITLE  ??  文件名反推的歌名
歌手 = 标签 ARTIST ??  文件名反推的歌手
专辑 = 标签 ALBUM  ??  ''
时长 = 标签时长    ??  0
```

**两个分区的优先级不同**（各取各的「更权威」来源）：

| 分区 | 歌名 / 歌手 | 专辑 / 时长 |
| --- | --- | --- |
| **本地文件** | 标签 → 文件名 | 标签 |
| **已下载** | **NAS 快照** → 标签 → 文件名 | 标签 |

⚠️ 「已下载」的歌名 / 歌手**以 NAS 快照为准**——服务端曲库是权威，标签可能是旧版本或带 feat. 后缀。

### 2.3 时长是双源的

- **标签时长**只用来**播放前**显示（列表里不再全是 `--`）；
- **播放开始后**仍以**媒体元素实测时长**为准（`src/player/engine.ts` 的既有逻辑**一字不改**）。

⇒ 两者不是冲突关系，是「先给个大概，再以实测为准」。

---

## 3. 格式覆盖

| 容器 | 扩展名 | 解析什么 | 时长来源 | 精度 |
| --- | --- | --- | --- | --- |
| **ID3v2.3 / 2.4 / 2.2** | `mp3` | `TIT2` / `TPE1` / `TALB` | `Xing` / `Info` 帧计数；无则按 CBR 估算 | 精确 / 近似 |
| **FLAC** | `flac` | `STREAMINFO` + `VORBIS_COMMENT` | `STREAMINFO` 总采样数 ÷ 采样率 | **精确** |
| **Vorbis / Opus** | `ogg` `opus` `oga` | 识别头 + 注释头 | 末页 granule ÷ 采样率 | **精确** |

**本轮不解析**（继续走文件名兜底，列为 T40 候选）：`m4a` `mp4` `wav` `wma` `ape` `alac` `aac` `aiff`。

**内嵌封面不提取**（`APIC` / `PICTURE`）——要把图片字节跨进程送到渲染层，是另一件事。

⚠️ **按文件头嗅探分派**，不靠扩展名猜（扩展名只决定「要不要读」，文件头决定「怎么解析」）：

```
"fLaC"              → FLAC
"ID3"               → ID3v2
"OggS"              → Ogg（Vorbis / Opus）
0xFF Ex/Fx          → 无 ID3 头的裸 MPEG 音频
其余                → 不认识 → null
```

---

## 4. 数据模型

### 4.1 本地清单条目

`shared/playerBridge.ts` 的 `LocalLibraryItem` 增加**三个可选字段**：

```ts
export interface LocalLibraryItem {
  id: string
  path: string
  title: string
  artist: string
  size: number
  ext: string
  addedAt: string
  /** 专辑名（来自标签；**可能为空串**）。 */
  album?: string
  /** 时长（秒；来自标签；**0 = 未知**）。 */
  duration?: number
  /** 歌名 / 歌手的来源：`'tag'` = 来自标签；`'name'` = 文件名兜底。 */
  tagSource?: 'tag' | 'name'
}
```

- ⚠️ **清单版本不变**（`LOCAL_LIBRARY_VERSION` 仍是 1）——加的是**可选**字段，老清单读得动，**不迁移、不动用户的 `local-library.json`**（与 T38 的 `DownloadEntry` 同一手法）；
- `tagSource` **缺省 = 还没解析过** → 既是「解析进度」的判据，也是「来源」的判据。

### 4.2 下载索引条目

`DownloadEntry` 增加两个**可选**字段：

```ts
  /** 时长（秒；来自标签；**缺省 = 未知**）。 */
  duration?: number
  /** 专辑名（来自标签）。 */
  album?: string
```

⚠️ `DOWNLOAD_INDEX_VERSION` **仍是 1**，**不迁移**。

---

## 5. 主进程

### 5.1 新增 `electron/audioTags.ts`

| 导出 | 职责 |
| --- | --- |
| `AudioTags` | `{ title?, artist?, album?, duration? }` |
| `TagFileSystem` | 最小文件系统接口（`readBytes` / `statSize`） |
| `readFileTags(fs, path)` | **入口**：读文件 → 嗅探 → 解析 → 返回 `AudioTags \| null` |
| `parseId3v2(buf)` / `parseFlacMetadata(buf)` / `parseOggMetadata(head, tail)` | 三个**纯**解析器（单测直接喂字节） |
| `mergeTrackTags(fileName, tags)` | 标签 / 文件名合并（与 `shared/localMeta.ts` 共用同一份规则） |

**读取预算**（防大文件拖死主进程）：

| 项 | 值 | 理由 |
| --- | --- | --- |
| 文件头 | 64 KB | 覆盖绝大多数 ID3 头 + FLAC 元数据块 |
| FLAC 元数据续读 | 最多 2 MB | `PICTURE` 块可能很大，要能跳过去 |
| 文件尾（仅 Ogg） | 64 KB | 末页 granule 在文件尾附近 |
| 单文件读次数 | ≤ 4 | 头 / 续读 / 尾 / ID3 后的音频帧 |

### 5.2 `electron/localLibrary.ts`

| 改动 | 说明 |
| --- | --- |
| `LocalLibraryFs` 增加 `readBytes?` | **可选** → 单测的内存替身**不用改**；没有它 = 解析能力自动降级 |
| `LocalLibraryOptions` 增加 `onChanged?` | 清单变化回调（**只推变化的那几条**） |
| `LocalLibrary.parsePending()` | 后台分批解析**还没解析过**的条目；每批落盘 + 回调 |
| `addPaths()` 登记时**不解析** | 登记 = 纯登记（快）；解析交给 `parsePending()` |

**分批策略**：一批 50 条 → 解析 → 落盘 → 回调 → 下一批。批与批之间 `await`，**主进程事件循环不被占死**（托盘、菜单照常响应）。

**并发守卫**：`parsePending()` 重入时直接返回（已有解析在跑）。

**文件不在了**（`statSize` 返回 `null`）→ 标记 `tagSource: 'name'`（**不无限重试**，条目仍留在清单里，由用户手动移除）。

### 5.3 `electron/downloadManager.ts`

| 改动 | 说明 |
| --- | --- |
| `DownloadManagerDeps` 增加 `readBytes?` | 同上，**可选** |
| 下载成功登记条目时 | `await` 解析标签 → 写入 `duration` / `album`（失败即空，**不影响下载结果**） |
| 新增 `backfillTags()` | 老条目（没有 `duration`）**逐个解析回填**；索引写一次 |

### 5.4 IPC

| 通道 | 方向 | 入参 | 出参 |
| --- | --- | --- | --- |
| `local:changed` | **主 → 渲染** | — | `LocalLibraryItem[]`（**只含变化的那几条**） |

⚠️ **只推变化的那几条**，不推整个清单——两万条的清单每批推一次会把 IPC 打满。

⚠️ `local:*` 的既有六个通道**形状一字不变**（既有测试断言了通道名列表，**不许动**）。

---

## 6. 渲染层

### 6.1 `src/state/localLibraryStore.ts`

| 改动 | 说明 |
| --- | --- |
| `localItemToSong()` | 用 `item.album` / `item.duration`（原来写死 `''` / `0`） |
| 新增 `installLocalLibraryStore()` | 订阅 `local:changed` → **按 id 合并**进 `items` |
| 新增 `pendingTagCount()` | 数一数还有几条**没解析**（`tagSource` 缺省）→ 界面提示用 |

### 6.2 `src/state/downloadStore.ts`

`downloadEntryToSong()` 用 `entry.duration` / `entry.album`；**歌名 / 歌手的既有优先级一字不改**（快照 → 文件名反推）。

### 6.3 `src/pages/LocalMusicPage.tsx`

| 改动 | 说明 |
| --- | --- |
| 工具条提示文案 | 「歌名与歌手**优先读文件内标签**，读不到才按文件名推断；移除只是从列表里去掉，不会删除磁盘上的文件。」 |
| 新增解析进度提示 | 还有 N 条没解析 → 显示「正在读取标签，还剩 N 首…」（`role="status"`） |

⚠️ 「移除只是从列表里去掉，不会删除磁盘上的文件」这句**保留**——那是 T38 的安全承诺。

### 6.4 `src/main.tsx`

`installLocalLibraryStore()`（与 `installDownloadStore()` 同一位置）。

---

## 7. 安全边界

| 边界 | 怎么守 |
| --- | --- |
| 渲染进程不得任意读文件 | 解析**全在主进程**；渲染层仍然只能给 id、拿清单 |
| 渲染进程不得注册任意路径 | 不变：主进程 **stat + 扩展名白名单 + 确认是文件** 才登记 |
| 解析不得读整个文件 | 读取**有字节预算**（头 64KB / 尾 64KB / FLAC 续读 ≤ 2MB） |
| 解析不得出网 | 解析器是**纯函数**，只读本地字节，**不碰任何网络接口** |
| 凭证 | 解析结果只有歌名 / 歌手 / 专辑 / 时长，**没有任何凭证** |
| 删除 | 移除操作**只改清单**，**绝不删用户的音乐文件** |
| 崩溃 | 解析全程 `try/catch`；解析失败 = 退回文件名兜底，**不影响登记与播放** |

---

## 8. 已知限制（如实写进界面与文档）

1. **只支持三种容器**：ID3v2 / FLAC / Ogg（Vorbis、Opus）。`m4a` `wav` `wma` `ape` `alac` 等继续按文件名推断。
2. **不提取内嵌封面** → 本地曲目的封面仍是占位块。
3. **ID3v2 的 unsynchronisation 标记（`0x80`）不做反同步** → 这类文件读不出标签，按文件名兜底。
4. **裸 MPEG（无 ID3 头）无 Xing 头时，时长是 CBR 估算值**，可能有 ±1 秒误差。
5. **老清单 / 老下载索引会在后台补齐**：首次启动后列表会「逐批变精确」，这是**预期行为**，不是卡住。
6. **扫描与解析都有上限**：扫描深度 8 / 2 万文件；解析按批进行，不阻塞界面。

---

## 9. 测试

### 9.1 新增

| 文件 | 覆盖 |
| --- | --- |
| `test/audio-tags.test.ts` | 三个解析器（**用构造的字节流**喂）：ID3v2.3 / 2.4 / 2.2 帧、Vorbis 注释、FLAC `STREAMINFO` + `VORBIS_COMMENT`、Ogg Vorbis / Opus 的 granule 时长、损坏输入不抛、`Xing` 与 CBR 两条时长路径 |

### 9.2 扩展既有（**只加不减**）

| 文件 | 加什么 |
| --- | --- |
| `test/local-library.test.ts` | 内存 fs 增加 `readBytes`；`parsePending()` 的行为（标签优先、文件名兜底、分批落盘、文件不在了不重试）；**既有断言一条不动** |
| `test/download-manager.test.ts` | 下载完成写入 `duration`；`backfillTags()` 回填老条目 |
| `test/local-music-page.test.tsx` | 标签来源提示文案；解析进度提示 |

⚠️ 既有 Vitest / E2E **一条不删、断言一条不削弱**。

---

## 10. 验收点

1. `tsc --noEmit` = 0 错；
2. `vitest run` 全绿（预计 +35 条左右）；
3. `playwright` 全绿；
4. **变异自证 ≥ 5 处**（标签优先合并 / 三个解析器各一 / 时长落盘 / 后台推送），先红后复原，sha256 回基线；
5. 无 U+FFFD、无 BOM、行尾与原文件一致（`docs/calibration.md` 保持 CRLF，其余 LF）；
6. **真机复验**：放一个带 ID3 标签的 mp3 + 一个带 Vorbis 注释的 flac → 加进「本地音乐」→ 歌名 / 歌手 / 时长当场变精确。
