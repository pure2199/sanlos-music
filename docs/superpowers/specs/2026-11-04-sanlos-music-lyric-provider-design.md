# 外部歌词 API 接入 —— 设计规格

- **日期**：2026-11-04
- **任务编号**：T32
- **状态**：已批准（用户选「按方案开工」）

---

## 一、要解决的问题

当前歌词只有一条来源：NAS 自带的 `/lyric/list`。实测 NAS 对同一首歌会返回**两条内容逐字相同**的记录（T31 已按冗余副本处理），
且**部分歌根本没有歌词**（`/lyric/list` 返回空列表）→ 那些歌在客户端与桌面歌词窗口都只能显示「暂无歌词」。

目标：

1. **接入一个稳定的外部歌词 API**，把 NAS 没歌词的歌补上；
2. **设置里可自己手动设置歌词 API**（URL 模板），换源或自建实例不用等发版。

---

## 二、候选源（全部本机真打实测，2026-11-04）

| 源 | 搜索 | 歌词 | 稳定性 | 结论 |
|---|---|---|---|---|
| 网易云 `music.163.com` | 200，18–235ms | 200，**31–41ms**，带时间戳 | 10/10 全绿 | **默认**（国内最快、中文覆盖好）；⚠️ 非官方公开接口 |
| QQ 音乐 `c.y.qq.com` | 200，**2.2s** | 200，65ms，带时间戳 | 通 | 搜索太慢；不内置 |
| lrclib.net | 200，366–1300ms | — | **偶发 503** | **内置备选**（开源、官方、免费）；有中文但少 |
| vvhan / injahow / lolimi | **不通 / 404** | — | — | 那些公益聚合接口现已不可用 |

⚠️ **网易云 / QQ 都是非官方 Web 接口**：没有 SLA、条款上属灰色、接口可能变更。
⇒ **不押注一家**：默认网易云，内置 lrclib 可切，再留 URL 模板给自建实例。

---

## 三、架构

### 3.1 数据流（NAS 优先 → 缺了再查外部）

```
渲染层 lyricApi.list(song.id) ──fnm:// 代理──▶ NAS
    │
    ├─ 有内容 ──────────────────────────▶ 直接用（**完全不碰外网**）
    │
    └─ 为空
         │  IPC `lyric:fetch`（songId + title + artist + album + duration）
         ▼
主进程  读 prefs.json 的 `lyric` 偏好 → 选适配器
         │  走 electron/http.ts 的 httpStack（Chromium 分区栈）
         ▼
外部 API ──▶ LRC ──▶ 包成 LyricEntry[]（原文一条 + 翻译一条）
         ▼
渲染层  复用现有 parseLyricEntries ──▶ 双语 / 逐字 / 去重
```

### 3.2 复用现有解析器（关键设计决策）

外部源**只负责取回 LRC 原文**，**解析逻辑一行不改**：

- 现有 `parseLyricEntries` 已处理：翻译合并（同时间戳的第二条挂成 translation）、冗余副本去重、伪逐字降级；
- 网易云的 `lrc.lyric`（原文）+ `tlyric.lyric`（翻译）正好对应**两条 `LyricEntry`** → 现有解析器自动出双语；
- ⚠️ **区分**：lrclib 的 `syncedLyrics`（带时间戳）与 `plainLyrics`（纯文本）是**同一首歌的两种格式**，不是原文/翻译
  ⇒ 只取 `syncedLyrics`，为空才回落 `plainLyrics`；**绝不**把两者当成两条记录。

### 3.3 模块划分

| 模块 | 职责 | 进程 |
|---|---|---|
| `shared/lyricProvider.ts` | **纯类型**：`LyricSource`、`LyricPrefs`、IPC 契约 | 两边共用 |
| `electron/lyricProvider.ts` | 三个适配器 + 地址校验 + 缓存 | 主进程 |
| `src/player/lyricSource.ts` | 「NAS → 外部」的合并入口（可注入） | 渲染层 |
| `src/state/appPrefsStore.ts` | 偏好的镜像（乐观应用 + 回滚） | 渲染层 |
| `src/components/SettingsPanel.tsx` | 设置界面 | 渲染层 |

---

## 四、类型契约（草案）

```ts
/** 外部歌词来源。 */
export type LyricSource = 'off' | 'netease' | 'lrclib' | 'custom'

/** 歌词来源偏好（落在主进程 prefs.json 的 `lyric` 键下）。 */
export interface LyricPrefs {
  /** 用的哪个源；缺省 = 'netease'。 */
  source?: LyricSource
  /** source='custom' 时的 URL 模板（含 {title} {artist} {album} {duration}）。 */
  template?: string
}

/** 渲染层 → 主进程：查外部歌词。 */
export interface ExternalLyricQuery {
  title: string
  artist: string
  album: string
  /** 秒。 */
  duration: number
}

/** 主进程 → 渲染层：外部歌词结果。 */
export type ExternalLyricResult =
  | { status: 'ok'; entries: LyricEntry[]; source: LyricSource }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
```

⚠️ `LyricEntry` 不含任何凭证；`LyricPrefs` 只存**非敏感**信息（源名 + 地址模板）。

---

## 五、安全边界（不可放宽）

| 约束 | 做法 | 理由 |
|---|---|---|
| 渲染层永不直接发网络请求 | 外部 fetch **全在主进程** | 与自动更新（Task 23）同一套纪律 |
| 绝不带 NAS 凭证 | httpStack 的 fetch 是**干净分区栈**（不附 token / Cookie） | 第三方绝不能看到 NAS 的凭证 |
| 证书校验 | 外部 host **不在** `TrustedHosts` → 走 Chromium 默认校验 | ⇒ 必须 **https**（回环才允许 http） |
| 不全局放行证书 | 复用 `electron/http.ts` 的 verify proc（未命中 → `-3`） | 绝不 `callback(0)` |
| 模板地址校验 | 禁 `user:pass@`；必须 https（回环才 http） | 同一个 URL 里不能藏凭证 |
| 偏好与凭证分离 | 落 `prefs.json`（非敏感）；凭证仍只在 `session.bin` | 与既有约定一致 |

⚠️ **渲染进程是不可信输入**：主进程只接受「歌名 / 歌手 / 专辑 / 时长」这四个**字符串与数字**，
不接受任何 URL（除了用户自己配置的模板）—— 防止渲染层把主进程变成任意出网代理。

---

## 六、匹配策略

| 源 | 流程 |
|---|---|
| **网易云** | ① `/api/search/get/web?s={歌名}+{歌手}&type=1&limit=10` → ② 用**时长筛**（\|Δ\| ≤ 3s）→ ③ 取第一条 `/api/song/lyric?id=&lv=1&kv=1&tv=-1` → ④ `lrc.lyric` = 原文，`tlyric.lyric` = 翻译 |
| **lrclib** | ① `/api/get?track_name=&artist_name=&duration=` → 失败则 ② `/api/search?q={歌名}+{歌手}` → ③ 取 `syncedLyrics`（空则 `plainLyrics`） |
| **自定义模板** | ① 替换占位符 → ② GET → ③ 响应体当**纯文本 LRC**（非 JSON） |

⚠️ 时长筛的作用：同名歌很多（《占位曲目一》实测有 4 个版本）→ 不筛会拿到**别的版本**的歌词。

---

## 七、缓存

主进程按 `(source, title, artist, duration)` 缓存：

- **成功结果**：进程内缓存（LRU，上限 64 条）；
- **失败结果**：缓存 5 分钟（防止连续切歌把外部源打爆）。

---

## 八、界面

设置面板新增一组「歌词来源」：

- 下拉：网易云音乐（默认）/ lrclib.net / 自定义 URL 模板 / 只用 NAS（不查外部）；
- 输入框（仅「自定义」时启用）：URL 模板，提示占位符 `{title}` `{artist}` `{album}` `{duration}`；
- 「保存」按钮；保存后**即时生效**（下一首歌就用新源）。

---

## 九、验收点

1. `tsc --noEmit` exit 0；`vitest` / `playwright` 全绿；
2. **NAS 有歌词的歌 → 完全不触发外部请求**（断言外部 fetch 替身未被调用）；
3. NAS 无歌词 → 外部补齐，**双语**（原文 + 翻译）显示；
4. 外部源失败 → **如实说明**（「暂无歌词（外部源不可用：…）」），不静默；
5. **既有测试一条不删、断言一条不许削弱** ⇒ 外部歌词入口做成**可选依赖**（无桥 → 不查外部），
   现有 FullPlayerPage / lyricOverlay 的注入式测试行为不变；
6. **变异自证 ≥4 处**（全部先红后改回，文件哈希核对回基线）。

---

## 十、遗留 / 风险

- 网易云 / QQ 是**非官方接口** → 变更风险。缓解：内置 lrclib 备选 + 自定义模板，一键切走；
- lrclib 偶发 503 → 重试 1 次，仍失败则如实报错；
- 外部歌词通常**无逐字** → 自动降级伪逐字（现有能力）；
- 外部源不可用时**不影响 NAS 已有歌词**的显示（NAS 优先）。
