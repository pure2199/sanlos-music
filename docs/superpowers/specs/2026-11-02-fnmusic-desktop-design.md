# 飞牛音乐 Windows 桌面客户端 — 设计规格

- 日期：2026-11-02
- 状态：待评审
- 代号：`fnmusic-desktop`

---

## 1. 背景与目标

飞牛音乐（fnOS 原生音乐应用，`com.trim.music`）官方目前提供 Android / iOS / HarmonyOS 原生 App 与 Web 端，**没有官方 Windows 客户端**。官方下载页中「飞牛音乐」条目仅有 Android 1.0.3、iOS 1.0.3 与 Web 端；Windows 侧的「飞牛同步」是文件同步客户端，与播放无关。

社区已有第三方 Windows 客户端（Electron + React，Apple Music 风格，MIT 许可），功能可用但缺少：FN ID 外网接入、桌面悬浮歌词、软件 EQ、下载到本地。

**目标**：自研一个 Windows 桌面客户端，直连 fnOS 飞牛音乐服务，覆盖以下四项必备能力：

1. 曲库浏览（专辑 / 歌手 / 风格 / 歌单 / 歌曲 / 收藏 / 搜索）+ 播放 + LRC 歌词
2. 桌面悬浮歌词（双行逐字）+ 托盘常驻（关闭窗口后台续播）
3. 收藏 / 歌单 / 播放记录同步回 NAS
4. 下载到本地 + 软件 EQ

**非目标（首版明确不做）**：车机 / CarPlay、音频文件管理（增删改曲库文件）、多 NAS 账号切换、Linux / macOS 打包、迷你悬浮球、移动端 App。

---

## 2. 已确认的技术事实

飞牛音乐 API **没有公开文档**。以下契约来自对两个开源实现（`Raduap/FN-Music-Apple`，MIT；`XDORG-N1/FnMusic`，Apache-2.0）的源码分析，以及对官方网页端行为的推断。实现时以接口事实为准，自研代码，不复制他方实现。

### 2.1 服务根路径与鉴权

服务根路径：`<server>/music`，API 基址 `<server>/music/api/v1`。

每个请求必须携带两个凭证：

**a) `authx` 请求头**

```
authx: nonce=<6位数字>&timestamp=<毫秒时间戳>&sign=<md5>
```

```
sign = md5(`${SIGN_PREFIX}_${pathname}_${nonce}_${timestamp}_${payload}_${SIGN_KEY}`)
```

- `SIGN_PREFIX = NDzZTVxnRKP8Z0jXg1VAMonaG8akvh`
- `SIGN_KEY = 6D5602D4-A342-4799-A0F0-BB795E7167D0`
- `payload`：GET 请求取「参数名升序、值经 `encodeURIComponent` 编码、`+` 替换为 `%20`、再整体 `decodeURIComponent`」后的字符串的 MD5；非 GET 请求取请求体字符串的 MD5。

**b) `music-token` Cookie**

登录成功后由服务端下发 `userToken`，之后所有请求以 `Cookie: music-token=<userToken>` 携带。

**业务响应约定**：`{ code, msg, data }`。`code === 0` 为成功；`code === 99999` 表示 token 失效（客户端静默续期一次后重试，仍失败则跳登录页）。

### 2.2 登录方式

**独立账号**（飞牛音乐内建账号，与 fnOS 系统账号相互独立）

```
POST /api/v1/user/password-login
{ username, password: sha256(password), deviceId }
→ { code:0, data:{ userToken, deviceId } }
```

`deviceId` 为客户端生成的 16 字节随机 hex，服务端会绑定并回传。

**NAS 账号 OAuth**

1. `GET /api/v1/sys/config` → `data.nasOAuth.clientId`、`data.serverName`、`data.serverVersion`
   （**实测修正见 §15.8：真实响应里 `nasOAuth` 只有 `clientId`，没有 `url`**）
2. 在应用内打开独立浏览器窗口访问：
   `<signinBase>/signin?client_id=<clientId>&redirect_uri=<base>/oauth/result&app_name=飞牛音乐`
3. 拦截跳转到 `redirect_uri` 的请求，取 `code` 参数（`error` 参数代表授权失败）
4. `POST /api/v1/user/auth-login` `{ code, deviceId }` → `data.userToken`、`data.user`

校验与登出：`GET /api/v1/user/me`；`POST /api/v1/user/logout`。

### 2.3 业务端点

| 域 | 端点 |
| --- | --- |
| 专辑 | `GET /album/list`（`sort=newTrackAddedAt,desc`）、`GET /album/detail?albumGUID=`、`GET /album/artist-detail/list?artistGUID=` |
| 歌曲 | `GET /track/list`、`GET /track/album-detail/list?albumGUID=`、`GET /track/artist-detail/list?artistGUID=`、`GET /track/genre-detail/list?genreGUID=`、`GET /track/playlist-detail/list?playlistGUID=` |
| 收藏 | `GET /favorite-track/list`、`POST /favorite-track/create` `{trackGUID}`、`POST /favorite-track/delete` `{trackGUID}` |
| 歌手 / 风格 | `GET /artist/list`、`GET /genre/list` |
| 歌单 | `GET /playlist/list`、`POST /playlist/create` `{name}`、`POST /playlist/update` `{guid,name}`、`POST /playlist/delete` `{guid}`、`POST /playlist/add-track` `{guid,trackGUIDs[]}`、`POST /playlist/remove-track` `{guid,trackGUIDs[]}` |
| 搜索 | `GET /search/track?q=`、`GET /search/album?q=`、`GET /search/artist?q=` |
| 歌词 | `GET /lyric/list?trackGUID=` → `data.list[].content`（LRC 原文） |
| 封面 | `GET /static/cover?coverId=&size=`（size 取 160/600/1024/1600/2000） |
| 音频流 | `GET /track/stream?guid=` |
| 转码 | `POST /track/transcode` → 返回可直接播放的 HLS 播放列表地址；`POST /track/quit-transcode` 结束会话 |
| 探活 | `GET /health` |

分页参数统一为 `page` + `size`，响应 `data.list` / `data.total`。封面 ID 形如 `album_<hex>` / `track_<hex>` / `artist_<hex>`，部分接口会返回裸 32 位 hex（实为歌曲 GUID），此类封面 ID 需丢弃以免 400。

### 2.4 FN Connect 外网接入（用户当前场景）

飞牛账号体系下的 FN ID 可在**任何网络**下访问 NAS，解析流程：

1. `POST https://5ddd.com/api/v1/fn/con`，body `{ fnId }`，`authx` 头使用**另一组密钥**：`SIGN_PREFIX` 同上，但 `apiKey = zIGtkc3dqZnJpd29qZXJqa2w7c`
2. 响应形如：

```json
{ "ipv4": ["192.168.x.x"], "publicIpv4": [], "publicIpv6": [],
  "fn": ["xxxxx.fnos.net:443"], "port": { "httpPort": 5666, "httpsPort": 5667 } }
```

3. 按优先级构造候选并**并行探测**，取优先级最高的可达项：

| 分组 | 协议 | 端口 | 说明 |
| --- | --- | --- | --- |
| 内网 IPv4 | HTTP 优先，HTTPS 兜底 | 5666 / 5667 | 直连速度最快 |
| 公网 IPv6 | HTTP 优先，HTTPS 兜底 | 5666 / 5667 | 格式 `http://[ipv6]:port` |
| 公网 IPv4 | HTTP 优先，HTTPS 兜底 | 5666 / 5667 | 直连速度最快 |
| 中继 | 仅 HTTPS | 443 | 域名取 `fn[]`，回退 `<fnId>.fnos.net` |

4. **中继链路必须携带 `mode=relay`**：与 `music-token` 合并在同一个 `Cookie` 头（拆成两个键会互相覆盖丢失该标志）。
5. 探测：已登录时打 `/music/api/v1/track/list` 并带 token 校验（TCP 可达但 token 被拒视为不可用）；未登录时打 `/music/api/v1/health`。超时：直连 3s、中继 10s。
6. IP 直连优先 HTTP 是为了避开自签证书校验；中继域名有官方 SSL 证书。

**中继限速是飞牛侧限制**：社区实测中继约 500KB/s–4Mbps，无损 FLAC 勉强可听，DSF/DSD 无解。客户端必须常驻显示当前链路类型，并对中继链路给出限速提示。同理，**下载与无损直出建议在局域网内进行**。

### 2.5 格式支持

Chromium（Electron 内核）原生可解码：MP3、AAC、FLAC、WAV、Vorbis、Opus。
无法解码：APE、WMA、DSF/DFF/DSD、DTS、AIFF、ALAC 等。

兜底路径：服务端 `POST /track/transcode` 转 HLS，客户端用 hls.js（MediaSource）播放。转码会话在切歌 / 停止时调 `quit-transcode` 结束。

---

## 3. 技术选型

**Electron 32 + React 18 + TypeScript + Vite + Zustand**

选型理由：本项目的四项必备能力中，透明置顶悬浮歌词（`BrowserWindow` + `setIgnoreMouseEvents`）、软件 EQ（Web Audio `BiquadFilterNode`）、系统托盘、Windows SMTC 媒体控制，全部是 Web / Electron 生态的成熟能力，无需自研原生插件。安装包约 100MB、内存占用约 200MB，对于一个常驻托盘的播放器是可接受的代价。

被否方案：
- **Tauri 2**：体积与内存更优，但签名、代理、证书信任、下载全需 Rust 实现，工作量约 1.5 倍。
- **Fork `FN-Music-Apple`（MIT）**：最快，但缺 FN ID 接入、EQ、下载、悬浮歌词，且 UI 非本项目设计目标。
- **Flutter 桌面**：Dart 侧 API 层可复用，但桌面悬浮歌词、托盘、窗口穿透、EQ 都需写 Windows 原生插件，成本最高。

---

## 4. 架构

```
┌─ Electron 主进程 (electron/) ──────────────────────────────┐
│  session.ts    凭证状态机 + DPAPI 持久化 + token 静默续期    │
│  sign.ts       authx 签名（纯函数）                          │
│  proxy.ts      fnm:// 协议代理（统一附签名 + token）          │
│  connection.ts 地址归一化 + FN ID 候选构造 + 并行探测        │
│  cert.ts       证书信任（仅放行用户填写的 host）             │
│  tray.ts       系统托盘                                     │
│  lyrics.ts     悬浮歌词窗口                                 │
│  download.ts   下载管理器（流式落盘 + 进度）                 │
│  smtc.ts       Windows 媒体控制中心                         │
└────────────────────────────┬───────────────────────────────┘
                             │ fnm://srv/...（渲染层不持有凭证）
┌─ 渲染进程 (src/) ──────────▼───────────────────────────────┐
│  api/      library / favorite / playlist / search / lyric    │
│  player/   engine(Web Audio) / eq / queue / transcode       │
│  ui/       theme(token) / pages / components                │
│  state/    zustand stores                                    │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 安全边界（硬性要求）

- 渲染进程**永远不接触** `music-token`。所有请求经 `fnm://` 协议由主进程转发，主进程统一附加 `authx` 签名与 Cookie。
- 凭证经 Electron `safeStorage`（Windows DPAPI）加密后落盘，密钥不出用户账户。
- `session.setCertificateVerifyProc` 仅对用户填写的服务器 host 放行自签证书，其他站点照常校验。
- 生产构建启用 CSP；`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。

### 4.2 模块边界

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `sign.ts` | authx 签名、MD5/SHA-256 | 无（纯函数） |
| `connection.ts` | 地址归一化、候选构造、探测 | `sign.ts`、fetch |
| `session.ts` | 登录、续期、凭证存储 | `sign.ts`、`proxy.ts` |
| `proxy.ts` | fnm:// → 上游转发、Header 白名单 | `sign.ts`、`session.ts` |
| `api/*` | 业务端点封装与数据映射 | `proxy.ts` |
| `player/engine.ts` | 播放、队列、进度、增益 | `api/stream.ts` |
| `player/eq.ts` | 10/15 段 EQ 链 + 预置曲线 | `engine.ts` |
| `lyrics.ts` + `ui/lyrics/` | 悬浮歌词窗与渲染 | `state`、IPC |
| `download.ts` | 下载任务、落盘、本地映射 | `proxy.ts` |

每个模块单一职责、通过明确定义的接口通信；业务端点全部收敛在 `api/` 一层，便于飞牛更新接口变更时单点修补。

---

## 5. 连接层设计

### 5.1 地址输入

登录页支持两种输入：

- **直接地址**：`192.168.1.10:5666`、`https://nas.example.com`、`http://1.2.3.4:8000`。归一化规则：缺协议补 `http://`；去尾部斜杠；未以 `/music` 结尾则追加 `/music`。
- **FN ID**：交给连接探测器解析。

### 5.2 探测策略

```
用户输入 FN ID
  → POST 5ddd.com/api/v1/fn/con  拿候选参数
  → 按 [内网, 公网v6, 公网v4, 中继] 生成候选地址列表
  → 并行探测（直连 3s / 中继 10s），首个确认可达且优先级最高者胜出
  → 缓存上次成功地址，下次启动优先快探该地址（只升级不降级）
```

探测请求携带当前 token，确保「TCP 可达但 token 被拒」的地址不被误判为可用。

### 5.3 链路状态展示

主界面顶部常驻一个链路指示器：

- `内网直连` / `公网直连` / `中继` + 探测方式描述
- 中继链路额外显示提示：「中继带宽受限（约 0.5–4 Mbps），无损与下载建议在局域网内进行」
- 点击可展开全部候选链路的手动探测结果，允许手动指定某条链路

### 5.4 失败降级

| 场景 | 处理 |
| --- | --- |
| FN ID 查询失败 | 提示检查 FN ID 拼写，保留手动填地址入口 |
| 全部候选不可达 | 汇总各链路失败原因（DNS / 拒绝连接 / 超时 / 证书）并给出对应处置建议 |
| 中继连接但 stream 卡顿 | 自动提示切回内网地址；不自动重试以免雪崩 |
| token 失效（99999） | 静默续期一次；失败则派发 `auth-lost` 事件回到登录页 |

---

## 6. 播放引擎设计

### 6.1 音频链路

```
HTTP stream → HTMLAudioElement → MediaElementAudioSourceNode
            → [10 或 15 个 BiquadFilter(peaking)] → GainNode → destination
```

- 播放源为 `fnm://srv/track/stream?guid=`，由主进程代理并附加凭证。
  **路径口径（Task 8 实测固化）**：`fnm://srv/` 之后就是「**相对 API 基址**」的路径（不含 `/music/api/v1`）——代理会自己拼上 `<base>/api/v1/`。写成 `fnm://srv/api/v1/track/stream` 会多出一层 `/api/v1`。
- `MediaElementSource` 每首歌只创建一次并复用于滤镜链，避免重复连接导致爆音。
- 增益节点负责音量与「关音效直通」开关（EQ 旁路时增益链完全旁路）。

### 6.2 EQ

- **段数**：10 段与 15 段可切换，频点取标准 ISO 1/1 倍频程：
  - 10 段：31.5 / 63 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz
  - 15 段：25 / 40 / 63 / 100 / 160 / 250 / 400 / 630 / 1k / 1.6k / 2.5k / 4k / 6.3k / 10k / 16k Hz
- **每段增益**：±12 dB，peaking 滤波器，`Q = 1.41`。
- **预置曲线**：Flat（平直）、Pop、Rock、Jazz、Classical、Electronic、Acoustic、Loudness、Vocal、Bass Boost 共 10 条，可一键应用。
- **叠加规则**：预置曲线与用户手动调整**相乘叠加**，界面明确显示「预设基线 vs 手动偏移」两层。
- **旁路开关**：一键关闭全部滤镜（严格直通，不改变增益）。

### 6.3 转码兜底

播放前读取 `audioSpec.codec` / `audioSpec.path` 扩展名判定是否属 Chromium 无法解码的集合；是则先 `POST /track/transcode`，拿到 HLS 播放列表后交给 hls.js 挂载到 `<audio>`。切歌与停止时调用 `quit-transcode` 释放服务端会话。

### 6.4 队列与进度

- 队列：单首 / 全部 / 随机 / 列表循环 / 单曲循环。
- 进度、音量、播放模式、队列内容本地持久化，重启后恢复上次位置。
- 播放器状态通过 IPC 同步给托盘、SMTC、悬浮歌词三个消费者。

---

## 7. 界面设计

### 7.1 双主题（用户确认：两套都要）

设计以 **CSS 变量 token 层** 实现，两套预设可随时切换且即时生效：

| 维度 | Apple Music 风 | Windows 11 Fluent 风 |
| --- | --- | --- |
| 背景 | 大面积留白 / 柔和渐变 | Acrylic 毛玻璃（`backdrop-filter: blur()`） |
| 圆角 | 连续圆角，较大（12–18px） | Win11 风格小圆角（8px） |
| 字体 | SF Pro / 系统 UI + 大标题排版 | Segoe UI Variable + 紧凑层级 |
| 强调色 | 单色高饱和点缀 | 取自封面取色的 Fluent 强调色 |
| 导航 | 通高侧边栏 + 内容区 | 侧边栏收成图标栏时用 Reveal 式悬停展开 |

Token 定义在 `src/ui/theme/tokens.ts`，每套主题一组变量；组件只消费变量，不写死颜色。主题切换持久化到 `prefs.json`，并同步到 `nativeTheme.themeSource` 以影响原生控件。

### 7.2 页面结构

侧边栏：主页 / 专辑 / 歌手 / 风格 / 歌单 / 收藏 / 最近播放（本地）/ 设置
底部：全局播放条（封面、歌名歌手、播放控制、进度、音量、队列、EQ 入口、音质标识）
全屏播放页：封面取色背景 + 逐行歌词

### 7.3 交互要点

- 歌曲列表：单击选中、双击播放、Ctrl 多选、Shift 连选、↑↓ 键盘导航、右键菜单
- 搜索：侧边栏输入即搜，按歌手 / 专辑 / 歌曲分组
- 虚拟滚动：万首级列表不卡顿
- 加载反馈：所有列表接口分页渐进呈现（先出首批再补齐），避免长时间白屏

---

## 8. 桌面能力

### 8.1 托盘

- 关闭窗口默认最小化到托盘，音乐继续播放；可在设置中改为直接退出
- 托盘图标显示当前曲目封面，右键菜单：播放/暂停、上一首/下一首、显示窗口、退出
- 托盘提示文字显示当前歌曲（Windows 限制 127 字符，超长按字符截断）

### 8.2 悬浮歌词（用户确认：双行逐字）

- 独立透明无边框置顶窗口，默认双行模式
- **双行逐字语义**：两行同时在场，各按自己的时间区间逐字走进度；上一行走满后停在全满状态，下一行在原位继续，整页走完才一起换行。单行模式保留，可切换。
- 逐字高亮依赖 LRC 中的逐字时间戳（增强型 LRC，行内含词级时间标签）；仅有时行级时间戳的歌词自动退化为逐行高亮（功能降级但不出错）
- 可调：字号、颜色、透明度、背景模糊、窗口透明度、置顶开关
- 锁定状态下鼠标穿透不挡桌面操作；悬停时临时解除穿透以便操作，移开立即恢复
- 拖动位置与尺寸本地记忆

### 8.3 SMTC 与媒体键

通过 `electron-media-service` / SMTC 接入 Windows 媒体控制中心，支持系统媒体键（播放/暂停/上下曲）与音量。

### 8.4 下载到本地

- 主进程代理 `track/stream` 流式落盘到 `音乐\FnMusic\<歌手>\<专辑>\<曲名>.<ext>`
- 维护 `guid → 本地路径` 映射（`prefs` + 独立索引文件）
- 播放时优先命中本地文件（避免重复走网络，尤其是外网中继场景）
- 下载任务面板：进度、速度、取消、失败重试；中继链路上给出带宽提示

---

## 9. 数据同步

| 数据 | 方向 | 机制 |
| --- | --- | --- |
| 收藏 | 双向 | `favorite-track/create` / `delete` 即时写回 NAS，手机端立即可见 |
| 歌单 | 双向 | `playlist/create` / `update` / `delete` / `add-track` / `remove-track` |
| 播放记录 | 待定 | **服务端端点未知**：已分析的两个开源实现均无历史记录端点。首版本地保存并展示；拿到真实 NAS 后抓包确认端点，再补同步（见 §12） |
| 账号隔离 | — | 服务端按 `music-token` + `deviceId` 隔离多用户数据，客户端不做本地合并 |

---

## 10. 错误处理与降级

| 场景 | 表现 |
| --- | --- |
| 网络不可达 | 顶栏横幅提示；已缓存的列表与封面仍可用；播放报错并保留队列 |
| token 失效（99999） | 静默续期一次 → 失败则回登录页，保留当前路由与队列 |
| 单个接口失败 | 只影响对应区块，页面其余部分正常；错误信息就地显示而非整页报错 |
| 封面 400 | 丢弃非法 `coverId`，回退到占位图或用所属专辑封面补全 |
| 流式播放中断 | 自动重试 1 次（带 Range 头），仍失败则标记该曲不可播并跳下一首 |
| 渲染进程崩溃 | 自动重新载入窗口（`render-process-gone` 监听），保留播放状态 |
| 自签证书 | 仅放行用户填写的 host，其他站点仍严格校验 |

---

## 11. 测试与验证策略

**单元测试**（Vitest）
- authx 签名：GET 排序、特殊字符编码、非 GET body、空参数边界
- 地址归一化：缺协议 / 缺端口 / 缺 `/music` / IPv6 方括号 / 尾部斜杠
- FN 候选构造：优先级顺序、协议与端口选择、中继域名回退、IPv6 加方括号
- LRC 解析：行级、逐字、多时间标签、翻译行
- 数据映射：字段缺失、非法封面 ID、时长单位（毫秒 → 秒）

**Mock server**（Node，无 NAS 也能开发）
模拟 `/music/api/v1` 全部端点，含分页、收藏/歌单状态变更、可播放示例音频、同步歌词；登录页填任意账号密码即可进入。

**E2E**（Playwright + Electron）
登录 → 浏览曲库 → 播放 → 歌词滚动 → 收藏写回 → 歌单增删 → 搜索 → 下载 → 重启恢复队列与进度。

**真实 NAS 联调**（需用户提供）
外网 FN ID + 音乐独立账号，覆盖：中继链路、token 续期、转码兜底、播放历史端点探测。

---

## 12. 里程碑

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| M1 骨架 | Electron 工程 + mock server + 登录（独立账号）+ 曲库浏览 + 播放 + 行级歌词 | 可在无 NAS 环境完整跑通 |
| M2 真实接入 | FN ID 探测 + 外网链路 + 链路指示器 + 托盘 + SMTC | 真实 NAS 上可听可放 |
| M3 桌面增强 | 双主题 token 体系 + 双行逐字悬浮歌词 + 逐字 LRC 解析 | 桌面体验达标 |
| M4 高级能力 | 10/15 段 EQ + 10 条预置曲线 + 下载到本地 + 本地播放优先 + 收藏/歌单写回 | 全部必备能力齐备 |
| M5 收尾 | 播放历史端点探测与同步 + 打包分发（安装版 / 便携版）+ 使用文档 | 可交付 |

---

## 13. 风险登记

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| API 无文档，飞牛更新后变更 | 高 | 端点全部收敛在 `api/` 一层；单点修补；mock server 保证无 NAS 也能回归 |
| FN Connect 中继限速 | 中高 | 链路指示器 + 明确提示 + 下载/无损引导到内网 |
| 播放历史端点未知 | 中 | 首版本地保存；抓包确认后补同步，不阻塞主流程 |
| Chromium 无法解码 APE/DSD/DTS | 中 | 服务端转码兜底 + hls.js |
| OAuth 登录页在受限网络下打不开 | 中 | 提供独立账号登录路径作为备选 |
| NAS 证书自签 | 低 | 仅信任用户填写的 host |

---

## 14. 待确认事项

- 播放历史的真实服务端端点（需要真实 NAS 抓包）
- fnOS 音乐服务在最新版本中的端口默认值（当前按 5666 / 5667 假设，需联调核对）
- 转码会话的实际生命周期与并发限制（`transcode` 是否支持多路并发）

---

## 附：参考来源

- 飞牛音乐官方上线公告与功能说明（IT之家、凤凰网科技，2026-08-27）
- 飞牛官网下载页 `fnnas.com/download`（确认官方无 Windows 客户端）
- `Raduap/FN-Music-Apple`（MIT）—— `src/api.js`、`electron/util.js`、`electron/main.js`
- `XDORG-N1/FnMusic`（Apache-2.0）—— `lib/app/services/feiniu/fn_connection_probe_service.dart`、`fn_models.dart`、`transcode_service.dart`
- 飞牛帮助中心「如何远程访问到飞牛 NAS」（FN Connect 模式说明）

---

## 15. 实测校验与规格修正（2026-11-02，真实 NAS）

用 `tools/fn-probe.mjs`、`fn-api-probe.mjs`、`fn-transcode-probe.mjs`、`fn-codec-census.mjs` 对真实 NAS（FN ID `<fnId>`，fnOS 音乐 1.0.10）完成端到端实测。本节覆盖上文相应内容，以本节为准。

### 15.1 实测链路

FN 连接参数返回：

| 项 | 实测值 |
| --- | --- |
| 内网 IPv4 | `192.168.100.xxx` |
| 公网 IPv4 | `117.182.192.247` |
| 公网 IPv6 | `2409:8a5c:...`（2 个） |
| 中继域名 | `<fnId>.fnos.net:443` |
| 端口 | `httpPort=5666`、`httpsPort=5667` ✅ 与规格假设一致 |

9 条候选探测结果：内网 IPv4 超时（当前不在局域网）、公网 IPv6 `ECONNREFUSED`、公网 IPv4 超时、**中继 `https://<fnId>.fnos.net` HTTP 200 命中**。

### 15.2 规格修正（7 条）

1. **中继域名是 `<fnId>.fnos.net`**，不是 `.5ddd.com`（`5ddd.com` 只是 FN 连接接口自身的服务域名）。候选构造必须优先使用接口返回的 `fn` 数组；回退值改为 `<fnId>.fnos.net`。
2. **中继链路下，登录请求同样必须携带 `Cookie: mode=relay`**，否则中继不识别该请求并返回 HTML 错误页（实测踩到）。所有走中继的请求——登录、接口、音频流——一律带此 Cookie。
3. **`authx` 的 nonce 与 timestamp 必须只生成一次**，同时用于请求头与签名计算。重复调用会得到不一致的凭证，服务端拒绝（实测踩到，返回 HTML 而非 JSON）。
4. **FN 连接接口的签名使用纯路径**（`/api/v1/fn/con`）而非完整 URL；音乐接口使用完整 URL 的 pathname。两者都取路径部分参与签名，路径相同即可。
5. **`GET /music/api/v1/health` 返回非 JSON**（实测 `code=null`），探测判定必须以 HTTP 状态码为准，不能依赖业务码。
6. **曲库规模要求服务端分页**：实测全库 **173,669 首 / 34,071 张专辑 / 14,872 位歌手 / 592 个风格 / 251 首收藏 / 414 条播放历史**。`size` 实测支持到 2000；`page=1000&size=500` 返回 0 条，说明偏移上限约在 50 万量级。**严禁全量拉取歌曲列表**，必须服务端分页 + 增量加载 + 虚拟滚动。
7. **服务端转码不可用**：实测 `POST /music/api/v1/track/transcode` 端点存在（返回结构化 JSON），但对 FLAC / WAV 及 `{trackGUID}` / `{guid}` / `{trackGUID,format}` / `{trackGUID,codec}` / `{guid,path}` 等全部参数组合一律返回 `code=100001 unknown error`。该 NAS 未启用服务端转码能力。

### 15.3 新增发现（原规格未知项已解决）

- **播放历史端点确认**：`GET /music/api/v1/play-history/list`，支持 `page` / `size`（默认返回 50 条），实测 `total=414`。原规格 §9 与 §14 的「未知」项解除，Task 16 需补该方法。
- **歌词只有行级 LRC，无逐字时间戳**。`GET /music/api/v1/lyric/list?trackGUID=` 返回 `data.list[]`，每项字段为 `guid, source, content, createdAt, updatedAt, isLRC, offset`；同一首歌返回两条内容近乎相同的记录（不同 `source`）。内容含酷狗来源的元信息标签 `[kuwo:014] [ver:] [ti:] [ar:] [al:] [by:] [offset:]`，解析时须忽略。**实测样本均不含 `<词级时间>` 标签**。
  - 应对：悬浮歌词保持双行语义；逐字高亮在有词级时间戳时用真数据，无则**按该行字符比例把行段时间均分到各词**，做伪逐字点亮，并在设置中标注「逐字为估算」。
- **音频流支持 Range**：`GET /music/api/v1/track/stream?guid=` 实测返回 HTTP 206、`content-type: audio/flac`、`accept-ranges: bytes`，正确返回 `fLaC` 文件头。中继链路下可正常流式播放与拖动定位。
- **封面接口正常**：`GET /music/api/v1/static/cover?coverId=&size=` 实测 `image/jpeg`，`size=160` 约 7 KB，`size=600` 约 75 KB。
- **曲库字段实测**：`year` / `trackNo` / `discNo` / `releaseDate` 可能是 `null`（不是 0）；歌曲对象的 `genres` 为空数组（风格须单独查）；`audioSpec` 含 `bitDepth, sampleRate, channel, bitrate, codec, container, duration, format, path, size`；`duration` 单位为毫秒。
- **风格接口**：`GET /music/api/v1/genre/list` 返回 `guid, name, coverId(null), trackCount`，存在 `Pop` 与 `POP` 等大小写重复的风格名，展示时需做大小写归一化。
- **歌单为空**：该账号 `GET /music/api/v1/playlist/list` 返回空列表，创建歌单是高频需求。
- **搜索可用**：`search/track` / `search/album` / `search/artist` 均返回 `code=0`。

### 15.4 格式普查与兜底策略修正

抽样 4,500 首（全库 173,669）：

| codec | 数量 | Chromium 可解 |
| --- | --- | --- |
| mp3 | 2389 | ✅ |
| flac | 1982 | ✅ |
| alac | 46 | ❌ |
| aac | 36 | ✅ |
| pcm_s16le / s24le / f32le | 44 | ✅ |
| ape / mp2 / wmav2 | 3 | ❌ |

需兜底比例约 **1.1%**，且**无 DSD / DTS**。鉴于服务端转码不可用（15.2.7），兜底链改为：

1. 直连 stream → Chromium 原生解码（覆盖 98.9%）
2. 服务端转码（best-effort，失败不阻塞）
3. **客户端 FFmpeg 转码为 WAV/PCM → Web Audio**（使用系统已安装的 `ffmpeg`，不存在时提示该格式无法播放并给出安装指引）

原规格 §6.3 的「服务端转码兜底」以此为准。

### 15.5 凭据使用说明

本次联调使用的 FN ID 与音乐账号仅用于验证，**不写入仓库、不写入日志、不提交**。仓库内的探测工具一律从环境变量 `FN_USER` / `FN_PASS` 读取凭据。

### 15.6 签名校验与中继 Cookie（实测，重要）

用 `tools/fn-empty-param-probe.mjs` 与一组 Cookie 对照实验，在真实 NAS 上得到以下事实：

| 实验 | 结果 |
| --- | --- |
| GET 请求使用**全零伪造签名** | `code=0` —— 服务端**不校验** `authx` |
| POST 密码登录使用**全零伪造签名** | `code=0` —— 同样不校验 |
| 中继链路 + `Cookie: mode=relay` | `code=0` ✅ |
| 中继链路 + **不带**该 Cookie | 返回 HTML 错误页（非 JSON）❌ |
| 中继链路 + `Cookie: mode=relay; x=1` | `code=0` ✅（其余 cookie 内容不敏感） |
| 同一 URL 按「保留空值」与「丢弃空值」两种规范串分别签名 | 服务端**均接受**（因 GET 签名根本不校验） |

结论与影响：

1. **中继链路的硬性关卡是 Cookie 头里的 `mode=relay`**，而非签名。客户端走中继时**必须**携带该 Cookie——这是实测确认的必做项。
2. **`authx` 仍按上游语义实现并发送**：官方 Web 端会发送该头，某些网关或服务端将来可能加强校验。实现以**上游语义**为准（参数名升序、只丢弃字面量 `'undefined'` / `'null'`、**保留空值参数**、路径取完整 URL 的 pathname 而 FN 连接接口用纯路径），避免行为突变。
3. 规范串的具体细节（空值参数、编码细节）**不影响当前服务端接受度**，因此 Task 6 的 API 封装仍建议不发送空值查询参数，但这是规范性建议而非正确性依赖。

### 15.7 字段形状实测（2026-11-02 二次联调，Task 6 期间补充）

为校准 `mapSong` / `mapAlbum` / `mapArtist` 与 mock server 的保真度，对真实 NAS 又做了一轮形状取证（20 首曲库样本 + 专辑/歌手/收藏/播放历史各端点）。

**1. `audioSpec.bitrate` 的单位是 **比特/秒（bps）**，不是 kbps。** 证据（20 首样本，`bitrate` 与 `size×8/秒` 逐条吻合）：

| 曲目 | codec | bitrate | size(B) | duration(ms) | 实算 bps | 实算 kbps |
| --- | --- | --- | --- | --- | --- | --- |
| 占位曲目二 (变体一) | flac | 870398 | 34628341 | 318280 | 870387 | 870 |
| 占位曲目三 (变体二) | flac | 1885693 | 54804140 | 232509 | 1885661 | 1886 |
| 占位曲目四 | mp3 | 320000 | 26518765 | 662831 | 320067 | 320 |

→ 映射规则：`Song.bitrate`（kbps）= `round(audioSpec.bitrate / 1000)`。实施计划 Task 6 的测试断言 `bitrate: 900000 → 900` **正确**；`shared/types.ts` 里 `AudioSpec.bitrate` 原注释「kbps」**错误**，已更正为 bps。

**2. 真实曲库每首歌带 `isFavorite` 布尔字段** → 应直接映射到 `Song.favorite`，而不是在客户端猜。实测样本中同时存在 `true` 与 `false`。

**3. 真实 `coverId` 形如 `<类型>_<32位小写hex>`**，类型前缀实测有 `track_` / `album_` / `artist_` 三种，另有 `null`（无封面）。10/10 样本匹配 `/^[^_]+_[0-9a-fA-F]+$/` → §「`coverId` 仅保留形如 `xxx_<hex>`」的规则**成立**，不会误清空真实封面。

**4. 服务端专辑对象没有 `year` 字段**，只有 `releaseDate`（如 `"2005-04-01"`，或 `null`）。`Album.year` 需由 `releaseDate` 前 4 位派生，缺失时为 `null`。

**5. `createdAt` / `updatedAt` 是 Unix 秒**（如 `1792563278`），**不是 ISO 字符串**。涉及专辑、歌手、歌曲、歌词条目。

**6. 播放历史条目本身就是完整的歌曲对象**（`guid,title,coverId,year,discNo,trackNo,isrc,duration,isCue,createdAt,updatedAt,album,artists,genres,audioSpec`），**不是** `{ track: <歌曲> }` 包装。`historyApi` 应直接对条目调用 `mapSong`。此前按「条目内嵌 track」推导的占位形状作废。

**7. 各端点条目形状汇总（服务端原始 JSON）**

```
歌曲    { guid, title, coverId, year, discNo, trackNo, isrc, duration, isCue,
          createdAt, updatedAt, album{...}, artists[{...}], genres:[],
          audioSpec{bitDepth,sampleRate,channel,bitrate,codec,container,duration,format,path,size},
          isFavorite }
专辑    { guid, name, coverId, releaseDate, barcode, createdAt, updatedAt, artists[{...}], trackCount }
歌手    { guid, name, coverId, createdAt, updatedAt, trackCount, albumCount }
歌手条目{ guid, name, coverId, createdAt, updatedAt }（出现在 album.artists / song.artists 里）
收藏条目= 完整歌曲对象（同「歌曲」）
历史条目= 完整歌曲对象（同「歌曲」）
风格    { guid, name, coverId(null), trackCount }
```

**8. `container` 实测为空串 `""`**（而非 `null`），`audioSpec.path` 是 NAS 上的绝对路径（如 `/vol02/1000-0-.../xxx.flac`）。

**9. 该账号 `playlist/list` 仍返回空列表**（歌单字段形状仍未实测，保留占位并标注待校准）。

**对 mock server 的影响**：fixtures 必须按上述形状重写（歌曲加 `isFavorite`/`isrc`/`isCue`/`createdAt`/`updatedAt`，专辑删掉不存在的 `year` 改为 `releaseDate`，`coverId` 前缀用 `track_`/`album_`/`artist_`，播放历史条目直接用歌曲对象），否则 mock 与真实 NAS 的偏差会传导进客户端映射。

### 15.8 认证链路实测（Task 10 前补充，推翻 §2.2 的两处假设）

1. **`sys/config` 的真实路径是 `/music/api/v1/sys/config`**（在音乐 API 前缀下）。实测 `/sys/config` → **HTTP 404 + HTML**。
2. **真实 `sys/config` 响应**（实测）：

   ```json
   { "code": 0, "msg": "", "data": {
     "nasOAuth": { "clientId": "EDDLUH2WLY" },
     "serverGUID": "<SERVER-GUID>",
     "serverName": "纯音乐",
     "serverVersion": "1.0.10",
     "mediasrvVersion": "0.8.43",
     "capabilities": { "folderView": false, "libraryReconnect": true } } }
   ```

   → **§2.2 里写的 `data.nasOAuth.url` 并不存在**。OAuth 授权地址必须**自行拼装**：`<服务器根>/signin?client_id=<clientId>&redirect_uri=<base>/oauth/result&app_name=飞牛音乐`（`<服务器根>` = 去掉 `/music` 后的服务器根，例如 `https://<fnId>.fnos.net`）。
3. **`/music/api/v1/health` 实测返回的是 HTML（HTTP 200），不是 JSON** —— 说明该路径在 NAS 上并不存在，NAS 的 SPA 回退把首页 HTML 返回了。这进一步坐实实测修正 M5：**探测可达性只能看 HTTP 状态码**，任何「解析业务码」的写法在这里都会失效。
4. **登录响应的 `data` 实测为 `{ userToken, user: { guid, name, role, lastAccessedAt, createdAt, updatedAt } }`** —— **不含 `deviceId`**。客户端必须保留自己生成的 deviceId（Task 7 已按 `data.deviceId ?? 请求时的 deviceId` 实现，正确）。

### 15.9 证书放行的运行时事实（Electron 32.3.3 / Chromium 128 实测）

Task 10 实现后在真实 Electron 主进程里做了一组对照实验，结论如下（**这决定了「证书放行」怎么实现**）：

| 实验 | 结果 |
| --- | --- |
| `net.fetch` 能否设置 `Cookie` 头（浏览器 Fetch 规范里 `Cookie` 是 forbidden header） | **能** —— 实测请求头原样到达：`cookie: "music-token=ABC123; mode=relay"`、`authx` 也在 |
| `net.fetch` 是否走 `session.defaultSession.setCertificateVerifyProc` | **走** —— verify proc 被调用（`hostname=localhost`）；回调 `0` → 放行成功，回调 `-3` → `net::ERR_CERT_AUTHORITY_INVALID` |
| 第一次证书校验失败后，再信任并重试同一 `host:port` | **仍然失败** —— Chromium 按 host:port 缓存证书错误 |
| `session.clearCache()` 能否清掉该缓存 | **不能** |
| `session.clearHostResolverCache()` 能否清掉该缓存 | **不能** |
| **换一个 Electron 分区（partition）** 后重试同一 `host:port` | **成功** —— 新分区有独立的证书错误缓存 |

**由此确定的设计（Task 9b）**：

1. 主进程对 NAS 的出网流量改走 **Electron 分区 session**（`session.fromPartition(name).fetch(...)`），而不是 Node 的全局 `fetch`（undici）—— 只有 Chromium 栈才受 `setCertificateVerifyProc` 管辖。
2. 分区名**带一个信任版本号**，形如 `fn-nas-v<epoch>`：每次**信任集合变化**（用户新增/移除受信 host）就 `epoch++` 并改用新分区，从而绕开旧分区里缓存的证书错误。新分区用 `{ cache: false }`。
3. **用户输入的服务器 host 必须在第一次请求它之前就登记进信任集合**（用户显式输入即显式信任），否则第一次握手失败会把错误缓存住。
4. FN ID 探测阶段候选 host 尚未受信 → 自签 HTTPS 候选会失败并缓存错误；用户放行后因 `epoch++` 换了新分区，该 host 立即可用。
5. 未受信的 host 一律走 Chromium 默认校验（verify proc 返回 `-3`）——**绝不**全局 `callback(0)`。

**影响面**：真实用户的当前链路是**中继** `https://<fnId>.fnos.net`（实测证书有效，Node fetch 直接可用），局域网 HTTP（5666）也不需要证书；只有「HTTPS 直连 + 自签证书」这一种场景依赖本条。

<deliver-assets>
<media type="file" src="docs/superpowers/specs/2026-11-02-fnmusic-desktop-design.md" caption="设计规格（含真实 NAS 实测校验、7 条规格修正与字段形状实测 §15.7）" />
</deliver-assets>
