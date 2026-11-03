# 真机联调校准记录

本文记录**哪些行为已经被验证过、用什么方式验证的**、**哪些还必须在真实 fnOS 上确认**，以及**联调需要用户配合什么**。

> 原则：**未实测的服务端字段与行为一律标为「待校准」**，不写死成契约。
> 探针脚本从环境变量读取凭证，**不打印、不落盘**。

---

## 一、当前状态总览

| 阶段 | 状态 |
|---|---|
| 单元测试 | ✅ 1216 条 / 42 个文件全绿 |
| E2E（真实 Electron + 内嵌 mock NAS） | ✅ 4 条全绿 |
| 打包 + 打包产物启动冒烟 | ✅ 通过（证据见 [`build-verification.md`](./build-verification.md)） |
| **真机联调（真实 fnOS）** | ⏳ **未开始** —— 需用户提供环境（见第四节） |

---

## 二、已用探针实测确认的项

这些是开发期用 `tools/` 下的探针打真实 NAS 确认过的，联调时**只需复核一次**。

| 项 | 实测结论 | 来源 |
|---|---|---|
| **端口** | `port.httpPort = 5666`、`port.httpsPort = 5667` | `/sys/config` |
| **服务端转码** | `track/transcode` 返回 `code=100001` → **不可用** | `tools/fn-transcode-probe.mjs` |
| **兜底方案** | 改为**客户端 FFmpeg** 转 Opus（见 README 常见问题） | `tools/ffmpeg-verify.mts` |
| **本机 FFmpeg 覆盖度** | 9.0.2（Gyan full build）→ 支持 12 种容器：`ape`/`alac`/`dsf`/`wma`/`dts`/`aiff`/`ra`/`au`/`dvf`/`tta`/`dss`/`mmf`；**仅 `dff` 不支持**（无 `dsdiff` 解封装器） | `tools/ffmpeg-verify.mts` |
| **中继链路是硬性关卡** | 不带 `mode=relay` Cookie → 返回 HTML 错误页 | `tools/fn-httstack-verify.mjs` |
| **中继候选可达性** | `https://<fnId>.fnos.net` 命中；当前网络下内网/公网 v4/v6 不可达 | `tools/fn-probe.mjs` |
| **播放历史端点** | `GET /music/api/v1/play-history/list` → `total=414`，条目为**完整歌曲对象** | `tools/fn-history-probe.mjs` |
| **曲库编码分布** | 含 `alac` 46 首等 → **APE / ALAC 可以走兜底播放** | `tools/fn-codec-census.mjs` |

---

## 三、待真机确认的清单（Step A–J）

标注 **[已实测]** 的项在开发期已确认，联调时复核即可。

| Step | 内容 | 状态 |
|---|---|---|
| **A** | FN ID 探测 —— 候选构造与并行探测命中预期链路 | **[已实测]** 中继命中；内网/公网在当前网络不可达 |
| **B** | 中继链路 —— `mode=relay` Cookie 生效、播放可用、界面显示限速提示 | **[已实测]** Cookie 是硬性关卡；**播放与限速提示待真机复核** |
| **C** | token 续期 —— 触发 token 失效，确认静默续期路径生效 | ⏳ **待真机** |
| **D** | 转码兜底 —— 用一首 APE/ALAC 确认客户端 FFmpeg 兜底链路可用；确认系统无 ffmpeg 时的提示 | ⏳ **待真机**（服务端转码已实测不可用） |
| **E** | 端口核对 | **[已实测]** 5666 / 5667 |
| **F** | 播放历史端点 —— 条目形状与规格 §15.7 一致；确认「最近播放」的排序依据（`updatedAt`？） | **端点已实测**；**排序依据待校准** |
| **G** | 收藏 / 歌单**跨端同步** —— PC 端收藏后，用手机 App 确认可见 | ⏳ **待真机**（需手机端配合） |
| **H** | 搜索端点分页行为 —— `search/track` / `search/album` / `search/artist` 是否接受 `page`/`size`，`total` 是否准确 | ⏳ **待真机**（客户端无条件透传分页参数，服务端若忽略也不亏） |
| **I** | 收藏 / 歌单全量取回 —— `favorite-track/list` 与 `playlist/list` 的 `size` 上限（实测收藏 251 首 > 默认页长 200） | ⏳ **待真机**（客户端按分页循环取全，需确认循环终止条件与 `total` 一致） |
| **J** | 专辑详情与歌单创建返回形状 —— `/album/detail` 是否用列表信封返回；`/playlist/create` 是否回显 `guid` | ⏳ **待真机**（客户端按「列表信封 + 取 `list[0]`」与「回显缺失则兜底」处理） |
| **K** | 封面 `size` 取值与取色 —— 封面 URL 的 `size` 参数语义；封面主色提取的采样策略 | ⏳ **待真机** |

---

## 四、联调需要用户配合什么

| 需要 | 用途 | 备注 |
|---|---|---|
| fnOS 的 **FN ID** | 外网中继链路探测 | 不写入仓库、不写入日志 |
| 飞牛音乐的**独立账号 + 口令** | password-login 联调 | 同上 |
| 客户端**能连到的网络环境** | 内网直连 / 中继两条链路都测 | 至少要能连中继 |
| **手机端 App**（可选） | Step G 跨端同步验证 | |
| 一首 **APE / ALAC** 曲目 | Step D 兜底解码全链路 | |

> ⚠️ 联调期间口令会出现在对话里，**联调结束后建议轮换该账号口令**。

---

## 五、探针工具

`tools/` 下的脚本都从**环境变量**读凭证，不打印、不落盘。

```powershell
$env:FN_USER = '<飞牛音乐账号>'
$env:FN_PASS = '<口令>'
node tools/fn-history-probe.mjs      # 例：播放历史
```

| 脚本 | 用途 |
|---|---|
| `tools/fn-probe.mjs` | FN ID 候选链路探测 |
| `tools/fn-con-smoke.mjs` | 连接链路冒烟 |
| `tools/fn-api-probe.mjs` | API 形状探测 |
| `tools/fn-history-probe.mjs` | 播放历史端点与条目形状 |
| `tools/fn-codec-census.mjs` | 曲库编码分布统计 |
| `tools/fn-transcode-probe.mjs` | 服务端转码可用性 |
| `tools/fn-empty-param-probe.mjs` | 空参数边界行为 |
| `tools/fn-flac-probe.js` | FLAC 相关形状 |
| `tools/fn-httstack-verify.mjs` | HttpStack / 中继 Cookie 行为 |
| `tools/ffmpeg-verify.mts` | 本机 FFmpeg 探测 + 转码 + 回读 + 覆盖度核对 |

---

## 六、联调发现问题怎么办

联调中发现的每一个问题，都**另开一个小任务**修复（T18），并遵循：

1. 先复现（补测试或探针），再改；
2. 修复后补回归测试；
3. **不削弱**既有断言 —— 若前提被推翻，改写为**新行为**的断言并说明理由。
