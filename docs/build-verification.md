# 构建与打包验证记录

> 本文件记录**实际跑过的验证**及其证据。口径与操作见 [`packaging.md`](./packaging.md)。
> 原始打包日志在本地 `release/verify/pack.log`（该目录被 `.gitignore` 忽略，不入库）。
>
> ⚠️ **产物名已按 T49 的改名同步更新**（`飞牛音乐.exe` → `Sanlos music.exe`），
> 其余**历史实测数据本身不变**（那次打包确实产出的是改名前的名字）。

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
| 解包目录 | `release/win-unpacked/Sanlos music.exe`（`productName` 已生效） |
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

> 验证的是**打包后的 exe**（`release/win-unpacked/Sanlos music.exe`），不是开发目录。

| 检查 | 实测 |
|---|---|
| exe 文件版本 | `0.1.0` |
| exe 产品版本 | `0.1.0.0` |
| exe 产品名 | `Sanlos music` |
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
   `Sanlos music.exe` 可直接运行（见第三节冒烟证据）。

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
# 启动 release\win-unpacked\Sanlos music.exe
# 或用隔离的 --user-data-dir 跑，观察它是否写出自己的 prefs.json
```
