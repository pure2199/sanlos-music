# 打包口径（Windows / x64）

本文说明「怎么打」「打出来是什么」「怎么验」，以及**可复现的确切含义**。

---

## 一、可复现 = 什么，不 = 什么

### ✅ 本项目承诺的

同样的**源码 + 锁定的依赖 + 同一台机器** → 产出的安装包**能装、能跑、功能一致**。

具体由这几件事保证：

| 措施 | 位置 | 作用 |
|---|---|---|
| **构建在干净暂存目录里进行** | `scripts/pack.cjs` | electron-builder 的输出指向**每次全新**的 `.pack-staging/`，构建成功后再把**成品**发布到 `release/` → **输出目录里残留了什么，不再影响构建结果** |
| **锁死 electron 版本** | `electron-builder.yml` 的 `electronVersion: 32.3.3` | builder 不再自己解析版本 → 不会拉到别的 electron |
| **复用本地 electron 二进制** | `scripts/pack.cjs` 的 `ELECTRON_OVERRIDE_DIST_PATH` | **不联网下载** electron；离线/内网机器也能出包 |
| **运行时依赖为空** | `package.json`（react / react-dom / zustand 都在 **devDependencies**） | asar 里不含 npm 依赖；builder 不必做依赖收集 / npmRebuild |
| **输出目录先清空** | `scripts/build-electron.cjs` 的 `fs.rmSync` | **陈旧产物不会混进 asar**（历史上 `dist-electron/session.js` 就是这么混进去的） |
| **白名单式 `files`** | `electron-builder.yml` | 包内文件清单**由配置决定**，不由构建历史决定 |
| **不产出源码映射** | `scripts/build-electron.cjs`（`sourcemap: false`）+ `files` 里的 `!*.map` | 包体不带 `.map` |

### ❌ 本项目**不**承诺的

**字节级一致**（两次构建的 exe 哈希相同）。

原因：NSIS 安装器会内嵌**构建时间戳**，这也是绝大多数 Electron 项目的常态。
若确实要追字节一致，需额外固定 `SOURCE_DATE_EPOCH` 与工具链版本 —— 超出当前目标。

> 换句话说：**「可复现」指的是「同样的输入能得到同样可用的产物」，不是「同样的字节」。**

---

## 二、怎么打

### 正式产物

```bash
npm run pack
# 等价于：npm run build && node scripts/pack.cjs
# 产物 → release/
```

流程：

```
build/  ──►  .pack-staging/（每次全新，保证干净）  ──►  release/（发布成品）
```

> **为什么要暂存**：electron-builder 会在 `<output>/win-unpacked.tmp` 里暂存解包结果。
> 若上一次构建被中断，那个目录会残留 → 下一次构建直接 EBUSY 失败。
> 而且 `<output>` 里任何**陈旧产物**都可能被当成这次的输入
> （同一类问题：历史上 `dist-electron/session.js` 就这么混进过 app.asar）。
> ⇒ 暂存目录**每次全新**，「输出目录的旧状态」不再影响构建结果。

### 验证用产物（不碰 `release/`）

```bash
npm run pack:probe
# 产物 → release-probe/
```

> `pack:probe` 走的是**同一个** `scripts/pack.cjs`，只是把输出目录换成 `release-probe/`。
> 它的意义是：**在正式目录被旧产物污染时，仍然可以先验证「打包这件事本身可行」**，
> 而不必先删任何东西。
>
> ⚠️ `pack:probe` **不重建** `dist/` —— 它打包的是**当前**的构建产物。
> 要先重建再探针：`npm run build && npm run pack:probe`。
> 若 `dist/index.html` 或 `dist-electron/main.js` 缺失，`scripts/pack.cjs` 会**在启动 builder 之前**明确报错。

### 离线打包

本机已缓存 `electron-v32.3.3-win32-x64.zip` / `nsis` / `nsis-resources` / `7zip`
（`%LOCALAPPDATA%\electron-builder\Cache` 与 `%LOCALAPPDATA%\electron\Cache`）→ **打包全程不需要联网**。

若在**全新机器**上打包且无缓存，需要一次联网拉取上述资源；之后即可离线。

---

## 三、`scripts/pack.cjs` 的前置检查

在启动 builder **之前**就检查，失败要早、要清楚（不要让 builder 报一堆无关的错）：

1. `node_modules/electron/dist/electron.exe` 存在 → 否则提示先 `npm install`
   （`postinstall` 会用 `scripts/ensure-electron.cjs` 兜底安装 —— electron@32 的
   `install.js` 依赖 `extract-zip@2.0.1`，该版本在 Node 26 上解压会挂起）；
2. `node_modules/.bin/electron-builder` 存在 → 不依赖全局 PATH；
3. `dist/index.html` 与 `dist-electron/main.js` 存在 → 否则提示先 `npm run build`。

---

## 四、产物清单

| 产物 | 说明 |
|---|---|
| `FN-Music-Setup-<version>.exe` | NSIS 安装包（`oneClick: false`，可改安装目录） |
| `FN-Music-Portable-<version>.exe` | 便携版（免安装） |
| `FN-Music-Setup-<version>.exe.blockmap` | 安装包差分更新用 |
| `win-unpacked/` | 解包后的目录（`飞牛音乐.exe` + `resources/app.asar`） |

**app.asar 内应只有**：`package.json`、`dist/**`、`dist-electron/**` —— **不含 `node_modules`**。

> ⚠️ `win-unpacked.tmp/` 是 builder 打包过程中的**临时暂存目录**。
> 若上一次构建**被中断**，它会残留下来，并让下一次打包失败（目录已存在 / 文件被占用）。
> 遇到这种情况**删掉 `win-unpacked.tmp/` 再重打**即可。
>
> ⚠️ 若 `release/win-unpacked/` 里的文件**被别的进程占用**（Windows 会拒绝删除/改名它们），
> 发布步骤会**跳过**它，并把新构建留在 `.pack-staging/win-unpacked/`，
> 同时在日志里明确提示路径与原因。此时**安装包（exe）不受影响**，
> `release/` 里的 `.exe` 照常是本次的新构建。

---

## 五、怎么验

```bash
npm run build      # 1. 构建（dist-electron 会被清空重建）
npm run pack       # 2. 打包
```

打包后核对：

1. `release/win-unpacked/resources/app.asar` 存在；
2. asar 内文件清单**不含** `node_modules`；
3. `release/win-unpacked/飞牛音乐.exe`（或 `electron.exe`）能双击启动，
   打开登录页、连上 NAS、播放一首；
4. `release/verify/*.log` 记录本次验证的实际输出（**不是空文件**）。

### 自动化验证

仓库自带的自动化检查：

```bash
npm test          # 单元测试（1216 条）
npm run e2e       # E2E 冒烟（Playwright 驱动真实 Electron）
npm run typecheck # 跑 tsc --noEmit（开着 noUnusedLocals / noUnusedParameters 闸门）
```

---

## 六、已知限制

- **无代码签名**：产物未签名 → Windows SmartScreen 会提示「未知发布者」。这是**预期**的；
  正式发布需要自备代码签名证书（`electron-builder.yml` 里配 `win.signAndEditExecutable` / `certificateFile`）。
- **图标是 Electron 默认图标**：`directories.buildResources: build` 指向的 `build/` 目录当前不存在
  → 用的是默认图标。需要自定义图标时，把 `build/icon.ico`（≥256×256）放进去即可。
- **仅 Windows x64**：未配置其它平台与架构。
