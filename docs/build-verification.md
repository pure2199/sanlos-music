# 构建与打包验证记录

> 本文件记录**实际跑过的验证**及其证据。口径与操作见 [`packaging.md`](./packaging.md)。
> 原始打包日志在本地 `release/verify/pack.log`（该目录被 `.gitignore` 忽略，不入库）。

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
| 主进程构建 | `node scripts/build-electron.cjs` | exit 0，产物 `main.js` / `preload.js` |
| 打包 | `npm run pack:probe` | exit 0（NSIS + portable 双目标） |

---

## 二、打包产物核对

| 项 | 实测 |
|---|---|
| 安装包 | `FN-Music-Setup-0.1.0.exe` — **82.05 MB** |
| 便携版 | `FN-Music-Portable-0.1.0.exe` — **75.15 MB** |
| 差分映射 | `FN-Music-Setup-0.1.0.exe.blockmap` — 0.09 MB |
| 解包目录 | `win-unpacked/飞牛音乐.exe`（`productName` 已生效） |
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
- ✅ **不含 `.exe` / 资源以外的多余文件**。

---

## 三、打包产物**真机启动**冒烟

> 验证的是**打包后的 exe**，不是开发目录。

| 检查 | 实测 |
|---|---|
| exe 文件版本 | `0.1.0` |
| exe 产品版本 | `0.1.0.0` |
| exe 产品名 | `飞牛音乐` |
| exe 公司名 | `fnmusic-desktop` |
| 启动后 12 秒是否存活 | **是**（进程树 4 个：主进程 + 渲染 + GPU + utility） |
| 隔离 userData 是否被应用写入 | **是** —— 写出 `prefs.json` + Chromium profile（`Local Storage` / `Cache` / `Preferences` 等） |

→ 结论：打包产物**能启动、能初始化自己的偏好存储**，不是「打出来就崩」的空壳。

---

## 四、已知限制（不是缺陷，是当前明确的口径）

| 限制 | 说明 |
|---|---|
| **无代码签名** | 日志：`no code signing certificate configured, signing is skipped` → Windows SmartScreen 会提示「未知发布者」。正式发布需自备证书。 |
| **默认 Electron 图标** | 日志：`default Electron icon is used` → `build/icon.ico` 尚未提供。 |
| **不承诺字节级一致** | NSIS 安装器内嵌构建时间戳 → 两次构建的 exe 哈希必然不同。可复现 = 同输入可重建/可安装/可运行。 |
| **仅 Windows x64** | 未配置其它平台与架构。 |
| **未做真机联调** | 打包产物连的是 **mock NAS**，不是真实 fnOS；真实 NAS 的联调校准见 T17。 |

---

## 五、复现步骤

```bash
npm install          # postinstall 会兜底安装 electron 二进制
npm run typecheck    # tsc --noEmit（含 noUnused 闸门）
npm test             # vitest 1216 条
npm run e2e          # Playwright E2E 冒烟 4 条
npm run pack         # 正式产物 → release/
```

验证打包产物能启动：

```bash
npm run pack:probe
# 然后启动 release-probe/win-unpacked/<exe>，或用隔离的 --user-data-dir 跑
```
