# 版本变更说明

本项目当前版本：**0.1.0**（首个可交付版本）

---

## 0.1.0 —— 2026-11

首个功能完整、可打包交付的版本。

### 新增

| 领域 | 内容 |
|---|---|
| **曲库** | 歌曲 / 专辑 / 歌手 / 风格 / 歌单 / 收藏 / 最近播放 / 搜索八个页面；专辑·歌手·风格详情下钻；分页「继续加载」入口 |
| **播放** | 播放引擎、队列、进度拖动、系统媒体会话（媒体控制中心）、播放条第三行状态与错误渲染、**播放模式切换按钮（顺序 / 随机 / 单曲循环 / 列表循环）** |
| **歌词** | LRC 解析、双行逐字高亮、翻译合并、偏移校正；**桌面悬浮歌词独立窗口**（可拖动 / 可点歌跳转 / 托盘常驻） |
| **同步** | 收藏（单一真相源）、歌单写回 NAS、播放记录（本机 + NAS 只读） |
| **下载** | 主进程下载器、断点续传、本地优先播放、下载目录可配 |
| **EQ** | 10 段 / 15 段可切换、10 条预置曲线、增益 ±12 dB、偏好持久化 |
| **兜底解码** | 客户端 FFmpeg 转 Opus（有损，界面如实注明）、单槽产物缓存、缺 FFmpeg / 缺本地副本的可读提示 |
| **主题** | Apple 风 / Windows 11 Fluent 风双主题，运行时即时切换 |
| **体验** | 关闭窗口行为设置（隐藏继续播放 / 直接退出）、窗口位置尺寸记忆、托盘菜单 |
| **工程** | 单元测试 1331 条；Playwright E2E 冒烟 8 条（真实 Electron + 内嵌 mock NAS）；`noUnusedLocals` / `noUnusedParameters` 质量闸门；可复现打包（锁 electron 版本 / 离线 / 干净暂存目录） |

### 修复

| 修复 | 影响 |
|---|---|
| **`fnm://` 协议特权被 `fnml://` 覆盖** | Electron 的 `registerSchemesAsPrivileged()` 整个进程只能调用一次，第二次会**静默覆盖**第一次 → `fnm` 不在 Blink 的 scheme 白名单里 → 渲染层 `fetch('fnm://…')` 直接抛 `TypeError: Failed to fetch` → **整个曲库都拉不出来**。现将两个 scheme **合并成一次**注册（`electron/schemes.ts` 的 `registerAppSchemes()` 是唯一正确入口） |
| `fnml://` 缺失跨源放行头 | 该 scheme 开了 `corsEnabled`，Chromium 会强制校验 → 响应不带 `Access-Control-Allow-Origin` 会被浏览器直接拒收 |
| 收藏态多真相源 | 搜索页与收藏页各说各话 → 统一为单一真相源 |
| 分页卡死后无出路 | 停下后提供「继续加载」入口，并复位护栏 |
| 歌单写回后选中态残留 | 写回成功后清空选中 |
| 播放器错误不可见 | 播放条补上第三行：错误（`role="alert"`）/ 转码中 / 有损说明（`role="status"`） |

### 已知限制

- **无代码签名** → Windows SmartScreen 提示「未知发布者」。
- **默认 Electron 图标** → 尚未提供 `build/icon.ico`。
- **不承诺字节级一致** → NSIS 安装器内嵌构建时间戳；可复现 = 同输入可重建 / 可安装 / 可运行。
- **仅 Windows x64**。
- **兜底解码只对「已下载到本地」的曲目生效**；且不支持 `dff`（本机 FFmpeg build 无 `dsdiff` 解封装器）。
- **真机联调尚未完成** —— 详见 [`calibration.md`](./calibration.md) 的 Step A–K。

---

## 版本号规则

遵循 **语义化版本（SemVer）** `MAJOR.MINOR.PATCH`：

| 位 | 何时递增 |
|---|---|
| **MAJOR** | 不兼容的改动（如协议、配置格式变更导致旧数据无法读取） |
| **MINOR** | 新增功能 / 新增端点 / 新增设置项 |
| **PATCH** | 缺陷修复、文案与样式调整、构建与依赖维护 |

### 版本号与打包产物

版本号取自 `package.json` 的 `version`，electron-builder 用它命名产物：

```
FN-Music-Setup-<version>.exe
FN-Music-Portable-<version>.exe
```

打包产物的 exe 版本元数据也由它写入（实测：文件版本 `0.1.0` / 产品版本 `0.1.0.0` / 产品名 `飞牛音乐` / 公司 `fnmusic-desktop`）。

### 升级版本号的流程

1. 改 `package.json` 的 `version`；
2. 同步 `package-lock.json`（`npm install --package-lock-only`）；
3. 在本文顶部新增一节；
4. 提交：`chore(release): <版本号>`。
