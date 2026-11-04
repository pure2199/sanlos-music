# T38 设计规格：未登录也能当播放器（本地音乐 + 已下载）

- 日期：2026-11-05
- 状态：已获用户批准（问卷：导入方式 / 未登录界面 / 已下载元数据 三项均取推荐项）
- 前置：Task 11（`fnml://` 本地媒体协议）、Task 12（FFmpeg 兜底）、T35（设置页整页化）

---

## 1. 背景与动机

用户诉求：**「让软件没登陆的时候，也可以做为音乐播放器，能添加播放本地的音乐和已下载的音乐」**。

### 1.1 现状（实测）

| 现状 | 证据 |
| --- | --- |
| 未登录时主区**只有**登录页 | `src/App.tsx` 的 `renderMainView` 默认分支返回 `<LoginPage>` |
| `fnml://` **只**认已下载索引里的路径 | `electron/localMedia.ts` 的 `lookup` 只查下载索引 |
| **没有任何文件选择对话框** | 全仓库 `showOpenDialog` 零命中 |
| `Song` **没有**「本地曲目」标记 | `shared/types.ts` 的 `Song` 无本地字段 |
| 下载索引**没有标题** | `DownloadEntry` = `songId` / `file` / `bytes` / `ext` / `downloadedAt` |

⇒ 要满足诉求，需要三件事：**一个本地曲目登记表**、**一条能播本地文件的通路**、**一个未登录也进得去的主区入口**。

### 1.2 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 导入方式 | **两个都要**：「添加文件」（多选）+「添加文件夹」（递归扫描） |
| 未登录界面 | 顶栏只留「连接」+「本地」，主区**默认**就是「本地」页；登录后恢复完整导航 |
| 已下载元数据 | 下载索引加 `title` / `artist` **快照**；老条目用**文件名反推**兜底（不迁移索引） |

---

## 2. 核心思路

**渲染层永远不碰文件系统、不碰路径。**

主进程维护一张「本地曲目登记表」，`fnml://` 的查找链从「下载索引」扩成：

```
兜底转码产物  →  下载索引  →  本地曲目登记表
```

渲染层全程只认一个 **id**。⇒ `electron/localMedia.ts` **一个字都不用改**，只改 `electron/main.ts` 里 lookup 的那一行链条。

### 2.1 为什么不新增 URL 种类

`fnml://local/track/<id>` 这条路由**已经**能安全地取本地字节（`parseLocalMediaTarget` 要求路径恰好两段，id 只当**索引键**用，绝不参与拼路径）。本地曲目只要被登记进同一张表，就自动获得：

- Range 支持（拖动进度条）；
- 跨源放行头（`corsEnabled` 必需的 CORS 头）；
- FFmpeg 兜底通路（兜底产物也走同一条路由）。

⇒ **不新增路由种类 = 不放宽任何安全边界。**

---

## 3. 数据模型

### 3.1 本地曲目 id

```
local:<sha1(绝对路径) 前 16 位十六进制>
```

- **主进程生成**（渲染进程不碰 `node:crypto`）；
- **稳定**：同一路径永远同一个 id → 重复添加自动去重；
- **与 NAS guid 不冲突**（NAS guid 是 32 位十六进制，无 `local:` 前缀）。

### 3.2 本地清单文件

落 `<userData>/local-library.json`：

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "local:3f2a…",
      "path": "D:\\Music\\占位歌手三 - 占位曲目十三.flac",
      "title": "占位曲目十三",
      "artist": "占位歌手三",
      "size": 34567890,
      "ext": "flac",
      "addedAt": "2026-11-05T01:00:00.000Z"
    }
  ]
}
```

⚠️ **明文但非敏感**（路径 + 歌名），与 `prefs.json` 同一性质。清单里**没有** token / 口令。

### 3.3 已下载条目的元数据

`DownloadEntry` 增加**两个可选字段**：

```ts
export interface DownloadEntry {
  songId: string
  file: string
  bytes: number
  ext: string
  downloadedAt: string
  /** 歌名快照（**本次升级后**下载的条目才有）。 */
  title?: string
  /** 歌手快照（**本次升级后**下载的条目才有）。 */
  artist?: string
}
```

- **索引格式版本不变**（`DOWNLOAD_INDEX_VERSION` 仍是 1）→ 不需要迁移、不动用户的 `downloads.json`；
- **老条目**（本次升级前下的）没有快照 → 渲染层用**文件名反推**兜底（形如 `歌手 - 歌名.ext`，近似值）。

---

## 4. 文件名反推（`shared/localMeta.ts`）

**不解析音频标签**（ID3v2 / Vorbis Comment / FLAC metadata）——那要手写三个解析器，范围与风险都太大，**单开任务**。

本任务只做**文件名反推**：

```
D:\Music\占位歌手三 - 占位曲目十三.flac  →  { artist: '占位歌手三', title: '占位曲目十三' }
D:\Music\占位曲目十三.flac           →  { artist: '',      title: '占位曲目十三' }
```

规则：去掉扩展名 → 按**第一个** ` - ` 分割 → 左边是歌手、右边是歌名。

⚠️ 下载文件名由 `sanitizeFileName()` 清洗过（Windows 非法字符 → `_`），所以**反推值是近似的**（可能有下划线）。这一点要在界面上如实说明。

**扩展名白名单**（`AUDIO_EXTENSIONS`）与 `electron/localMedia.ts` 的 `MIME_BY_EXT` 保持一致：

```
mp3 flac m4a mp4 aac ogg opus oga wav wma ape alac mka webm aiff aif
```

---

## 5. 主进程

### 5.1 新增 `electron/localLibrary.ts`

| 组成 | 职责 |
| --- | --- |
| `LocalLibrary` 类 | 读 / 写清单；按 id 查路径；登记；移除 |
| `scanDirectory()` | 递归扫描目录，收集音频文件 |
| `registerLocalLibraryIpc()` | 注册 `local:*` 通道 |

**扫描上限**（防止一个巨大的目录把主进程拖死）：

| 上限 | 值 |
| --- | --- |
| 递归深度 | 8 |
| 单次文件数 | 20000 |
| 单文件大小 | 不限（只登记，不读内容） |

⚠️ **跳过符号链接与 Windows reparse point**（junction / 符号链接会形成环）。

**模块约束**（照 `electron/localMedia.ts` 的写法）：

- **模块顶层不得 import Electron**——`dialog` 与 `ipcMain` 一律**惰性解析** → 单测能跑在普通 Node（Vitest）；
- 文件读写**可注入** → 单测用内存替身，不碰真实磁盘。

### 5.2 IPC 通道

| 通道 | 方向 | 入参 | 出参 |
| --- | --- | --- | --- |
| `local:list` | invoke | — | `LocalLibraryItem[]` |
| `local:pick-files` | invoke | — | `string[]`（用户选中的绝对路径；取消 = 空数组） |
| `local:pick-folder` | invoke | — | `string`（用户选中的目录；取消 = 空串） |
| `local:add` | invoke | `string[]`（路径） | `LocalLibraryItem[]` |
| `local:add-folder` | invoke | `string`（目录） | `LocalLibraryItem[]` |
| `local:remove` | invoke | `string`（id） | `LocalLibraryItem[]` |

### 5.3 `electron/main.ts`

```ts
registerLocalMedia({
  lookup: (songId) =>
    fallback.lookup(songId) ?? downloads.localPath(songId) ?? localLibrary.localPath(songId),
})
```

⇒ **改一行**。

---

## 6. 渲染层

### 6.1 新增 `src/state/localLibraryStore.ts`

形状与既有 store 一致（Zustand）：

| 字段 | 说明 |
| --- | --- |
| `items` | 已登记的本地曲目 |
| `loading` | 正在扫描 / 写盘 |
| `error` | 上一次操作的错误（可读文案，不含凭证） |
| `load()` | 读一次清单 |
| `addFiles()` | 「添加文件」：对话框 → 登记 |
| `addFolder()` | 「添加文件夹」：对话框 → 递归扫描 → 登记 |
| `remove(id)` | 移除一项（**只从清单移除，不删用户的文件**） |

⚠️ `remove` **绝不删磁盘文件**——那是用户的音乐。界面上也要说清楚。

### 6.2 播放源解析

`src/state/downloadStore.ts` 的 `resolvePlaybackSource()` 加一条分支：

```ts
if (isLocalTrackId(song.id)) return localMediaUrl(song.id)
```

⇒ 本地曲目**不走 NAS**，直接 `fnml://`。

⚠️ **既有行为一字不变**：NAS 曲目仍然「命中下载索引且开关打开 → `fnml://`，否则 → `fnm://srv/track/stream`」。

### 6.3 会话恢复的收敛

`src/state/sessionStore.ts` 新增 `restore()` 动作：

- **in-flight 去重**：并发调用共享同一个 Promise；
- **`restored` 标记**：恢复完成（或失败）后置 `true`。

`src/pages/LoginPage.tsx` 改成调 store 的 `restore()`，不再自己写一份。

⚠️ 原因：**未登录时主区默认是「本地」页 → 登录页根本没挂载 → `restore()` 没人调** → 应用永远不知道自己登录了没有。恢复动作必须**从 App 出发**，与当前视图无关。

### 6.4 新增 `src/pages/LocalMusicPage.tsx` + `.css`

```
本地音乐
├─ 工具条：[添加文件] [添加文件夹]        ← 未登录时的「去登录」提示条
├─ 分区一「本地文件」  → SongList（本地清单）
└─ 分区二「已下载」    → SongList（下载索引）
```

- 复用**既有** `SongList`（虚拟滚动 + 双击播放 + 多选）——不新造列表组件；
- 本地曲目 `coverId` 为空串 → `CoverImage` 渲染**占位块**（不发封面请求）；
- `album` 为空串、`duration` 为 0（播放后由媒体元素补）。

### 6.5 `src/App.tsx`

| 改动 | 说明 |
| --- | --- |
| `MainView` 新增 `'local'` | 主区多一个视图 |
| 初始 `view` = `'local'` | 未登录时打开就是播放器 |
| 顶栏按 `session.connected` 切导航 | 未登录：只渲染「连接」+「本地」；登录后：完整导航 |
| 自动进「歌曲」页 | **仅**在「启动时 restore 完成且已登录」时触发一次（ref 守卫） |

⚠️ **登录后不自动跳页**（保持现状：登录页显示「已连接」）。

---

## 7. 安全边界

| 边界 | 怎么守 |
| --- | --- |
| 渲染进程不得任意读文件 | `fnml://` 的 lookup 只认**登记表里的精确路径**；渲染进程给不出路径，只能给 id |
| 渲染进程不得注册任意路径 | 渲染层给的路径只是「候选」；主进程必须 **stat + 扩展名白名单 + 确认是文件** 才登记 |
| 路径穿越 | 登记的是**绝对路径本身**（不是拼接出来的）→ 目录外的路径用户选不出来，也伪造不出来 |
| 凭证 | 本地通路**不出网**、不碰 token；清单里只有路径和歌名 |
| 删除 | 移除操作**只改清单**，**绝不删用户的音乐文件** |

---

## 8. 已知限制（如实写进界面与文档）

1. **不解析音频标签** → 本地文件的歌名 / 歌手来自**文件名反推**（近似值）；时长在**播放后**由媒体元素补（队列里其它曲目的时长仍显示 `--`）。要真标签得单开任务手写解析器（不引新依赖）。
2. **只支持本地盘符路径**：不支持 `\\server\share` 网络路径，不支持 `.lnk` 快捷方式。
3. **扫描有上限**：深度 8 / 2 万文件，超出部分**不登记**（并在结果里如实汇报）。
4. Chromium 播不了的格式（FLAC / APE 等）→ 走**已有的 FFmpeg 兜底**，那条路对本地曲目同样有效。

---

## 9. 测试

### 9.1 新增

| 文件 | 覆盖 |
| --- | --- |
| `test/local-library.test.ts` | id 生成 / 去重 / 扩展名过滤 / 扫描上限 / 清单读写 / 文件名反推 / 快照字段 |
| `test/local-playback-source.test.ts` | 本地 id → `fnml://`；NAS 曲目行为**不变** |
| `test/local-music-page.test.tsx` | 页面渲染 / 空态 / 两个导入按钮 / 移除 |
| `test/app-guest-nav.test.tsx` | 未登录只有「连接」+「本地」；登录后完整导航 |

### 9.2 改写既有 E2E（前提被用户显式推翻）

| 用例 | 改法 |
| --- | --- |
| `启动 → 渲染出登录页`（断言「曲库导航在启动时可见」） | **前提被推翻**（未登录不再显示曲库导航）→ 改写为「启动 → 直接进本地音乐页，顶栏只有『连接』+『本地』，曲库导航不可见」 |
| `默认菜单栏已去掉，且输入框仍能 Ctrl+V 粘贴` | 地址框在登录页 → **加一步「先点『连接』」**（**断言一字未改**，与 T35 改写同一手法） |
| `登录 mock NAS → 显示「已连接」` | 登录后不自动跳页 → **断言不动** |

⚠️ 既有 Vitest **一条不删、断言一条不削弱**。

---

## 10. 验收点

1. `tsc --noEmit` = 0 错；
2. `vitest run` 全绿（预计 +30 条）；
3. `playwright` 全绿（预计 +1 条）；
4. **变异自证** ≥ 4 处（本地 id 解析 / 未登录导航隐藏 / 快照字段落盘 / 扫描去重），先红后复原，哈希回基线；
5. 真机复验：未登录 → 打开就是本地页 → 加一个本地文件 → 能播。
