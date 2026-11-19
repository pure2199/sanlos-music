# 构建与打包验证记录

> 本文件记录**实际跑过的验证**及其证据。口径与操作见 [`packaging.md`](./packaging.md)。
> 原始打包日志在本地 `release/verify/pack.log`（该目录被 `.gitignore` 忽略，不入库）。
>
> ⚠️ **产物名已按 T49 的改名同步更新**（`飞牛音乐.exe` → `Sanlos Music.exe`），
> 其余**历史实测数据本身不变**（那次打包确实产出的是改名前的名字）。

> ⚠️ **分支已于 2026-11-19 改名为 `sanlos-music`**（仓库默认分支；原名 `feature/fnmusic-desktop`）。
> 下面记的分支名是**当时**的名字 —— 那是**历史记录，不改**。

> ⚠️ **里层已于 2026-11-19 全量改名**（包名 `sanlos-music`、appId `com.sanlos.music`、
> 自定义协议 `sanlos://` ＋ `sanlos-media://`、CSS 前缀 `sanlos-`、preload 桥
> `sanlos` / `sanlosAuth` / `sanlosPlayer`）。
> 下面记的**旧名**是**当时**的名字 —— 那是**历史记录，不改**。

> ✅ **v0.4.2 已于 2026-11-19 发布并真机复验完毕**（发布链：注解 tag `v0.4.2` ⇒
> 网页 dispatch `release.yml` ⇒ CI run **44492657546** = success ⇒ Release 资产**恰好 3 个**
> ⇒ **三处 sha256 逐字一致**）⇒ 装到 `D:\Sanlos Music` 之后的**真机复验 6 项全过**
> （曲库拉得出、桌面歌词仍成立、本地播放走 `sanlos-media://` 真起播、
> 「检查更新」真拉到清单、登录态还在）。
> ⚠ 复验**顺带查出 T115 漏了第四个 `localStorage` 键的旧键回落**（有声扫描状态）
> ⇒ **已记为 T117**。完整记录见 [calibration.md](./calibration.md) 第九十四节
> 与 [releases/v0.4.2.md](./releases/v0.4.2.md) 第三节。

> ✅ **v0.4.3 已于 2026-11-19 发布并真机复验完毕**（发布链：注解 tag `v0.4.3` ⇒
> 网页 dispatch `release.yml` ⇒ CI run **44522673902** = success ⇒ Release 资产**恰好 3 个**
> ⇒ **三处 sha256 逐字一致**）⇒ **原地升级**装到 `D:\Sanlos Music`（**不卸载 v0.4.2**）之后的
> **真机复验全过**：**对照组**（v0.4.2 缺陷版，同一份数据）看到「正在扫描…＋卡片 0」、
> **实验组**（v0.4.3）看到「上次扫描：2026/11/17 00:45:50 · 目录「有声小说」· 9 部」＋ **卡片 9 张**
> ⇒ **旧键回落真机生效**（有声那一集 **0 行** ＋ 桌面歌词窗**不可见** ＋ 窗没被干掉），
> 对照组普通歌**仍然 67 行** ＋ 窗口可见。
> 完整记录见 [calibration.md](./calibration.md) 第九十五节与 [releases/v0.4.3.md](./releases/v0.4.3.md) 第三节。

> ✅ **T118 已于 2026-11-19 修复「有声」页扫描落盘覆盖手工改判**（`src/state/audiobookStore.ts`
> 的 `scan()`：**每页断点落盘**与**扫完落盘**原先写的是**扫描启动时的 `overrides` 快照**
> ⇒ 扫描进行中用户做的**手工改判**会被覆盖，**内存状态**也一起回退）
> ⇒ 改法：**扫描不再拥有 `overrides` 的写权限** —— 它只写自己的字段，
> `overrides` 一律取 store 内存里的**活值**（`get().overrides`）。
> **实测**：`tsc` **0 错**、Vitest **148 文件 / 3 040 条全绿**（新增 1 文件 8 条）、
> Playwright **72 passed**、build exit **0**、字节体检 ＋ 控制字符 **bad=0**、
> **变异自证 `MUTATION_OK`**（A⇒红 ①②③④⑥⑦⑧、B⇒红 ⑦⑧、C⇒红 ④⑥、D⇒红 ③；
> 还原后 8/8 全绿 ＋ sha256 字节级一致）。
> ⚠ **本条不含真机复验**（扫描要 6–47 分钟 ⇒ 真机上做才有意义 ⇒ 列为待真机项）。
> 完整记录见 [calibration.md](./calibration.md) 第九十六节与规格
> `docs/superpowers/specs/2026-11-19-sanlos-music-t118-audiobook-override-race.md`。

> ✅ **T119 已于 2026-11-19 修订「服务端不能浏览目录」这 6 处过时结论**
> （2026-11-19 飞牛更新后**真机实测**：服务端**已支持**按目录浏览
> —— `/folder-view/*`、`/app-center/authed-dir/*`、`/shared-library/*`；
> 旧结论「服务端**不能**浏览目录」**已不成立**）
> ⇒ 改法：**只改陈述、不改行为** —— 6 处统一改成「**本客户端目前**是扫曲库后按目录名挑」
> （客户端**还没接**那些接口 ⇒ 行为不变）；
> 顺带加了 **5 条钉子**（4 条扫仓库文件 ＋ 1 条扫页面渲染结果）防回退。
> **实测**：`tsc` **0 错**、Vitest **149 文件 / 3 045 条全绿**（新增 1 文件 4 条 ＋ 既有文件 1 条）、
> Playwright **72 passed**、build exit **0**、字节体检 ＋ 控制字符 **bad=0**、
> **变异自证 `MUTATION_OK`**（A⇒红 ①、B⇒红 ②⑤、C⇒红 ②⑤、D⇒红 ③、E⇒红 ①；
> 还原后 21/21 全绿 ＋ 字节级一致）。
> ⚠ **本条不含真机复验**（只改文档与文案 ⇒ 客户端行为一字未改）。
> 完整记录见 [calibration.md](./calibration.md) 第九十七节与规格
> `docs/superpowers/specs/2026-11-19-sanlos-music-t119-doc-claims.md`。

> ✅ **T120 已于 2026-11-19 把「有声」页改为按服务端目录浏览**
> （数据源从「**全库扫 87 页**（17.3 万首）＋ 按 path 关键字挑」换成
> 「**服务端目录树**定位那个文件夹 ＋ 递归取它下面的曲目」：
> `/app-center/authed-dir/list` ＋ `/folder-view/list`，真机实测 2026-11-19）
> ⇒ ⭐ **判定 / 归并 / 卡片 / 下钻 / 改判 —— 一行都没改**（同一个 `accumulate()`）；
> ⇒ ⭐ **落盘形状不变**（`STATE_VERSION` **不升**）⇒ 老用户上次扫的结果**直接还在**；
> ⇒ ⚠ 老服务端（没更新飞牛）**自动回落**到旧的全库扫描（提示放在**状态行**，不是错误条）；
> ⇒ 顺带加了 **9 条钉子**（①/② 成对：目录浏览优先 ＋ 回落对照组）。
> **实测**：`tsc` **0 错**、Vitest **150 文件 / 3 054 条全绿**（新增 1 文件 9 条）、
> Playwright **72 passed**（1.6 分钟）、build exit **0**、字节体检 ＋ 控制字符 **bad=0**、
> **变异自证 `MUTATION_OK`**（A⇒红 ①④⑤⑥⑦⑧⑨、B⇒红 ④⑤⑥⑦⑧⑨、C⇒红 ⑥⑦、
> D⇒红 ②⑥、E⇒红 ⑧；还原后 9/9 全绿 ＋ 字节级一致）。
> ✅ **T120 的真机复验已于 2026-11-20 完成**（本机 ＋ **真实 FN NAS** ＋ 真实账号）：
> **对照组 = 已装的 v0.4.3**（旧路径：全库扫 87 页）⇒ **56.0 秒** ＋ `/track/list` **88 次**；
> **实验组 = 带 T120 代码的打包产物**（新路径：目录浏览）⇒ **9.1 秒**（第二次 **6.6 秒**）
> ＋ `/folder-view/list` **69 次** ＋ `/app-center/authed-dir/list` **1 次**
> ⇒ ⭐ **扫描窗口内 `/track/list` 零次调用**（那 1 次发生在启动后 0.2 s ⇒ 属默认落地页，
> **与扫描无关**；交叉验证：对照组的 88 次 = 87 页 ＋ 同一个那 1 次）
> ⇒ ⭐⭐ **两边作品列表逐字一致**（**9 部**：三体 89 集 / 娱乐春秋 384 集 / 盗墓笔记 337 集 /
> 牧神记 2 762 集 / 极品家丁 1 333 集 / 赶尸客栈 288 集 /
> 让青春继续第一季 32 集（合并了 2 张专辑）/ 第三季 13 集 / 第二季 6 集）
> ⇒ **「换数据源、不换判定」真机成立**；
> ⇒ ⭐ **落盘 `version` 仍 3**（不升）＋ 新增 `folderPaths: ["/vol02/1000-0-3d135437/有声小说"]`
> ⇒ 老用户上次扫的结果**直接还在**；
> ⇒ ⭐ **对照组②**（目录名换成不存在的）⇒ 如实报「服务端的目录里**没找到**」**且不回落**
> （`/track/list` 计数 1 → 1，**没新增**）；
> ⚠ **回落路径真机上验不了**（真 NAS 已是新版 ⇒ 目录浏览不会失败 ⇒ 回落不触发）
> ⇒ 那一半靠 mock 的 ② 号钉子覆盖 ⇒ **不假装真机验过**。
> 完整记录见 [calibration.md](./calibration.md) 第九十八、九十九节与规格
> `docs/superpowers/specs/2026-11-19-sanlos-music-t120-folder-scan.md`。

> ✅ **v0.4.4 已于 2026-11-20 发布并**装版**真机复验完毕**（发布链：注解 tag `v0.4.4`
> ⇒ commit `c21dab5` ⇒ 网页 dispatch `release.yml`（`tag=v0.4.4`、**`pack_only` 关**、
> **`sign` 关**）⇒ CI run **44568675852**（#21）= success ⇒ SignPath 那几步**全部 skipped**
> ⇒ 走**未签名**路径 ＋ **attestation 成功** ⇒ Release 资产**恰好 3 个**
> ⇒ **三处 sha256 逐字一致**）
> ⇒ **原地升级**装到 `D:\Sanlos Music`（**不卸载 v0.4.3**）：exe FileVersion **0.4.4**、
> `app.asar` 844 415 B 且内含 **5/5** 个 v0.4.4 标志、注册表「**Sanlos Music 0.4.4**」
> 且**无残留 0.4.3**、`session.bin`（286 B）**逐字未变**、`Local Storage` **11 个文件未变**、
> `prefs.json` 未变；
> ⇒ **真机复验（已装版 ＋ 真实 FN NAS ＋ 真实账号 ＋ 隔离 userData）三阶段全过**：
> **①** 「有声」页走目录浏览 —— **16 075 ms**、**9 部**（与 v0.4.3 **逐字一致**）、
> **扫描窗口内 `/track/list` 零次**、`/folder-view/list` **69 次**、
> 落盘 `version` **仍 3** ＋ `folderPaths: ["/vol02/1000-0-3d135437/有声小说"]` ＋ `scannedCount` **5 244**；
> **②** ⭐ **T118 第一次在真机上验过** —— 扫描**进行中**点「这不是有声」
> ⇒ 改判**落在扫描窗口内**（**true**）⇒ 扫完落盘**还留着**该改判、按钮**没有回来**；
> **③** 对照组②（目录名换成不存在的）⇒ 如实报「没找到」**且不回落**（`/track/list` **1 → 0**）。
> ⚠ **回落路径真机上验不了**（真 NAS 已是新版 ⇒ 回落不触发）⇒ 靠 mock 的 ② 号钉子覆盖
> ⇒ **不假装真机验过**。
> 完整记录见 [calibration.md](./calibration.md) 第一百节、
> [releases/v0.4.4.md](./releases/v0.4.4.md) 第五节与规格
> `docs/superpowers/specs/2026-11-20-sanlos-music-v0.4.4-release.md`。
**验证时间**：2026-11-04
**平台**：Windows 10.0.26300 x64 / Node v26.13.0 / npm 11.x
**分支**：`feature/fnmusic-desktop`

---

## 一、自动化检查（全部通过）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（`tsc --noEmit`，**开着 `noUnusedLocals` + `noUnusedParameters`**） | exit **0**，零错误 |
| 单元测试 | `npm test`（vitest） | **1216 passed / 42 files** |
| E2E 冒烟 | `npm run e2e`（Playwright 驱动真实 Electron） | **4 passed** |
| 渲染层构建 | `vite build` | exit 0，产物 6 assets + 2 html |
| 主进程构建 | `node scripts/build-electron.cjs` | exit 0，产物 `main.js` / `preload.js`（**陈旧产物已清**） |
| 打包 | `npm run pack` | exit **0**（NSIS + portable 双目标） |

---

## 二、打包产物核对

| 项 | 实测 |
|---|---|
| 安装包 | `release/FN-Music-Setup-0.1.0.exe` — **82.05 MB** |
| 便携版 | `release/FN-Music-Portable-0.1.0.exe` — **75.15 MB** |
| 差分映射 | `release/FN-Music-Setup-0.1.0.exe.blockmap` — 0.09 MB |
| 解包目录 | `release/win-unpacked/Sanlos Music.exe`（`productName` 已生效） |
| electron 版本 | **32.3.3**（锁定） |

### app.asar 内容清单（实测）

```
\package.json
\dist\index.html
\dist\lyric.html
\dist\assets\lyric-CHhBSdT8.js
\dist\assets\lyric-Cl7y4qbb.css
\dist\assets\main-DN-h2u0J.js
\dist\assets\main-DQ572n0p.css
\dist\assets\tokens-CtLO_GWP.js
\dist\assets\tokens-uVtEPSG3.css
\dist-electron\main.js
\dist-electron\preload.js
```

**核对结论**：

- ✅ **不含 `node_modules`** —— 运行时依赖已清空（react / react-dom / zustand 归入 devDependencies）；
  electron-builder 日志同步印证：`no node modules returned while searching directories`。
- ✅ **不含陈旧产物** —— 只有 `main.js` / `preload.js`；
  历史残留的 `dist-electron/session.js`（无人引用的旧入口产物）已被「构建前清空输出目录」消除。
- ✅ **不含 `.map`** —— 包体不带源码映射。

---

## 三、打包产物**真机启动**冒烟

> 验证的是**打包后的 exe**（`release/win-unpacked/Sanlos Music.exe`），不是开发目录。

| 检查 | 实测 |
|---|---|
| exe 文件版本 | `0.1.0` |
| exe 产品版本 | `0.1.0.0` |
| exe 产品名 | `Sanlos Music` |
| exe 公司名 | `fnmusic-desktop` |
| 启动后 12 秒是否存活 | **是**（进程树 4 个：主进程 + 渲染 + GPU + utility） |
| 隔离 userData 是否被应用写入 | **是** —— 写出 `prefs.json` + Chromium profile（`Local Storage` / `Cache` / `Preferences` 等） |

→ 结论：打包产物**能启动、能初始化自己的偏好存储**，不是「打出来就崩」的空壳。

---

## 四、本轮发现并解决的一个「产物污染」问题

### 现象

`release/win-unpacked.tmp/` 与 `release/win-unpacked/` 里的 `resources/*.asar`
被某个进程以「允许读写、但**不允许删除共享**」的方式持有 →
Windows 拒绝删除/改名它们（`SHARING_VIOLATION` / `EPERM`）
→ `electron-builder` 在解包阶段 `unlink` 旧暂存文件时 **EBUSY 失败**，
**`npm run pack` 直接跑不起来**。

### 定位

用 **Windows Restart Manager API**（`rstrtmgr.dll`）精确查询持锁进程：

```
PID=20864  app='MiniMax Code'  type=RmUnknownApp  restartable=False
```

→ 持锁的是 **本应用自己的 Node 工具进程**（`--utility-sub-type=node.mojom.NodeService`），
不是外部软件。（同期另有 `awesun_guard.exe`（向日葵远控）以该目录为工作目录，
但它不是 `.asar` 句柄的持有者。）

### 解决

1. **打包不再受输出目录旧状态影响** —— `scripts/pack.cjs` 改为
   **在全新暂存目录 `.pack-staging/` 里构建**，构建成功后再把**成品**发布到 `release/`。
   ⇒ 旧 `win-unpacked.tmp` 残留不再让打包失败；安装包照常落到 `release/`。
2. **旧的 `app.asar` 被就地覆盖** —— 该文件**不能删、不能改名**，但**可以写**
   （独占 `r+` 打开成功）→ 用新构建的 `app.asar`（463 221 字节）覆盖旧的
   （38 034 019 字节，且**还带着 T1 已删除的 `hls.js` 与旧渲染层包**）。
   留着旧包是个坑：跑起来会得到**带 `fnm://` 缺陷的旧版应用**。
3. **`release/win-unpacked/` 补齐为完整可运行构建** —— 把新构建**就地合并**
   （truncate + write，不走 unlink）写进去，73 个文件齐备，
   `Sanlos Music.exe` 可直接运行（见第三节冒烟证据）。

### 仍然残留（**不影响使用**）

- `release/win-unpacked.tmp/resources/default_app.asar`（0.1 MB）
  —— 上一次构建的暂存残留，仍被上述句柄锁住，**删不掉**。
  它只是 Electron 的默认 asar，**不在打包路径上**，也不影响 `npm run pack`。
- 释放句柄的方式：关闭 MiniMax Code 后再删，或重启机器。

---

## 五、已知限制（不是缺陷，是当前明确的口径）

| 限制 | 说明 |
|---|---|
| **无代码签名** | 日志：`no code signing certificate configured, signing is skipped` → Windows SmartScreen 会提示「未知发布者」。正式发布需自备证书。 |
| **默认 Electron 图标** | 日志：`default Electron icon is used` → `build/icon.ico` 尚未提供。 |
| **不承诺字节级一致** | NSIS 安装器内嵌构建时间戳 → 两次构建的 exe 哈希必然不同。可复现 = 同输入可重建/可安装/可运行。 |
| **仅 Windows x64** | 未配置其它平台与架构。 |
| **未做真机联调** | 打包产物连的是 **mock NAS**，不是真实 fnOS；真实 NAS 的联调校准见 [`calibration.md`](./calibration.md)。 |

---

## 六、复现步骤

```bash
npm install          # postinstall 会兜底安装 electron 二进制
npm run typecheck    # tsc --noEmit（含 noUnused 闸门）
npm test             # vitest 1216 条
npm run e2e          # Playwright E2E 冒烟 4 条
npm run pack         # 正式产物 → release/
```

验证打包产物能启动：

```bash
npm run pack
# 启动 release\win-unpacked\Sanlos Music.exe
# 或用隔离的 --user-data-dir 跑，观察它是否写出自己的 prefs.json
```
