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
| `win-unpacked/` | 解包后的目录（`Sanlos Music.exe` + `resources/app.asar`） |

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
3. `release/win-unpacked/Sanlos Music.exe`（或 `electron.exe`）能双击启动，
   打开登录页、连上 NAS、播放一首；
4. `release/verify/*.log` 记录本次验证的实际输出（**不是空文件**）。

#### 验「音频内嵌歌词」要用的真实样本（**不进仓库**）

这一版多了「读音频文件内嵌标签」的功能 ⇒ 验收它需要**真的带标签的音频文件**：

```bash
node tools/fn-fetch-embedded-lyric-samples.mjs   # 落到 release/samples/embedded-lyric/（gitignored）
node node_modules/vitest/vitest.mjs run test/embedded-lyric-real-samples.test.ts
```

⚠️ **样本不进仓库**：真实语料是 **CC BY-SA 4.0**（许可传染）⇒ 仓库里只留
**下载脚本 + URL**。样本缺失时 `test/embedded-lyric-real-samples.test.ts` **整组 skip**
⇒ **CI 钉不住真文件的字节级行为**，只钉**自造夹具**的行为（CI 不依赖网络）。

### 自动化验证

仓库自带的自动化检查：

```bash
npm test          # 单元测试（2164 条）
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

---

## 七、自动更新（Task 23）

### 7.1 它是怎么工作的

```
用户点「检查更新」
  → 主进程拉 <更新服务器地址>/latest.json          ← 渲染层不碰网络
    → 比版本（语义化版本）
      → 有新版本 → 用户点「下载更新」
        → 下载到临时目录 + 校验 SHA-512（与清单一致）
          → 校验 Authenticode 签名（包有签名 ⇒ 签名者 == 用户配置的「预期签名者」；
            包没签名 ⇒ 需要用户显式授权「允许安装未签名的更新包」，见 7.6）
            → 用户点「启动安装」→ **再验一次签名 + 再核对一次 SHA-512** → 启动安装器
```

**全程不静默**：检查、下载、启动都是用户点的。

### 7.2 清单格式（`latest.json`）

清单是**本项目自定义的 JSON**（不是 electron-builder 的 `latest.yml`）——
因为 `latest.yml` 是 YAML，要解析它就得引 `js-yaml`，而本项目**不引新依赖**。

```json
{
  "version": "1.2.3",
  "releasedAt": "2026-11-04T00:00:00.000Z",
  "notes": "这次更新了什么（可空）",
  "files": [
    {
      "name": "FN-Music-Setup-1.2.3.exe",
      "url": "FN-Music-Setup-1.2.3.exe",
      "sha512": "<128 位小写 hex>",
      "size": 90231360
    }
  ]
}
```

⚠️ **字段约束**（客户端逐项校验，任何一项不合规**整个清单作废**）：

| 字段 | 约束 |
|---|---|
| `version` | 非空字符串（语义化版本；支持 `v` 前缀与 `-预发布` 后缀） |
| `files` | 非空数组 |
| `files[].name` | 非空；**只用 basename**（路径穿越会被拒绝） |
| `files[].url` | 相对清单目录的路径；**必须与清单同源**（跨源一律拒绝） |
| `files[].sha512` | 128 位 hex（大小写不敏感） |
| `files[].size` | 正整数 |
| `releasedAt` / `notes` | 可选字符串 |

### 7.3 怎么发布

```bash
npm run pack              # 1. 打出产物（release/FN-Music-Setup-<version>.exe）
npm run publish:manifest  # 2. 生成 release/latest.json（自动算 SHA-512）
```

然后把 **`latest.json` 与安装包放在同一个目录**上传到你的更新服务器（静态文件即可）。
⚠️ 两者**必须同源**：客户端会拒绝跨源的安装包地址。

客户端的更新服务器地址**不在构建期**——在应用「设置 → 自动更新 → 更新服务器地址」里填，
存进 `prefs.json` 的 `update.baseUrl`（换服务器不用重新打包）。

⚠️ **v0.2.2 起有缺省值**：地址**留空**时，主进程自动回落到**项目自己的 Releases**
（`shared/appInfo.ts` 的 `APP_INFO.updateBaseUrl` = `releases/latest/download`
⇒ **永远指向最新那版**）；设置页也有「用项目地址」一键填入。

### 7.4 安全边界（**每一条都缺一不可**）

| 闸 | 规则 | 挡住什么 |
|---|---|---|
| 地址 | 必须 `https://`（**回环地址**才允许 `http://`）；不许带凭证 / query | 明文传输、URL 里藏 token |
| 清单 | 逐项校验形状 | 畸形清单、字段类型错乱 |
| 同源 | 安装包必须与清单**同源** | 清单把安装包指到别处（= 远程代码执行） |
| 哈希 | SHA-512 必须与清单一致 | 下载被篡改 / 传输损坏 |
| 签名 | 包**有**签名时：签名者必须 == 配置的预期签名者；包**没**签名时：需用户**显式授权** | 装一个来路不明的包 |
| 启动 | 启动前**再验一次**签名、**再核对一次** SHA-512（用主进程自己缓存的清单） | 下载到启动之间被换掉 |

⚠️ **签名判定口径**：我们**只**保证「这个文件确实由预期的人签的」；
**信任链由 Windows 自己判断**（`Status` 字段会如实反映 `Valid` / `NotSigned` / `UnknownError`）。
另外 `CN` 本身**不是唯一标识**——真正的信任来自「HTTPS + 清单哈希」这条链。

⚠️ **判定口径只有一份**（T85）：`shared/update.ts` 的 `evaluateSignatureGate()`，
**主进程与渲染层共用同一份** —— 以前两边各判各的（主进程「不填预期签名者就不探测文件」、
渲染层「按 `NotSigned` 判」）⇒ 叠在一起把「允许安装未签名的更新包」**彻底堵死**，
而且**一条报错都没有**。

| 安装包 | 预期的代码签名者 | 允许安装未签名 | SHA-512 | 结果 |
|---|---|---|---|---|
| 没签名 | 空 / 任意 | **开** | 相符 | ✅ 放行 |
| 没签名 | 空 / 任意 | 关 | 任意 | ❌ 拒绝（默认行为不变） |
| 没签名 | 任意 | 开 | 不符 / 无从核对 | ❌ 拒绝（哈希是硬闸） |
| 有签名 | 与实际一致 | 任意 | 任意 | ✅ 放行 |
| 有签名 | 空 | 开 | 任意 | ❌ 拒绝（授权只管「未签名」的包） |
| 有签名 | 与实际不符 | 开 | 相符 | ❌ 拒绝（授权救不了） |
| 探测失败 | 任意 | 开 | 任意 | ❌ 拒绝（不猜） |

### 7.5 代码签名怎么配（需自备证书）

产物当前**未签名**（`electron-builder.yml` 里 `win.sign` 留空）。自备证书的做法：

```yaml
win:
  signAndEditExecutable: true
  certificateFile: <你的 .pfx 路径>
  # 口令走环境变量，不要写进配置文件：
  # CSC_KEY_PASSWORD
```

⚠️ 证书**由你自备**（本项目不附带任何证书）。
⚠️ 配好签名后，把证书的**主体名**（形如 `CN=你的公司`）填进应用的「预期的代码签名者」——
   两边对不上，客户端会拒绝启动安装器（这是**故意的**）。

### 7.6 没证书怎么装更新（T85 起）

本项目**暂未办理**代码签名证书 ⇒ 安装包**没有签名**（`Get-AuthenticodeSignature` 报 `NotSigned`）。
这时**不用**填「预期的代码签名者」，只要：

1. 设置 →「更新」→ 勾选「**允许安装未签名的更新包**」→ **点「保存」**（**不保存不生效**）；
2. 「检查更新」→「下载更新」→「启动安装」。

⚠️ 放行的**只有「发布者身份」这一条**：
**SHA-512 必须与清单相符**（启动前**再核对一次**）、必须与清单**同源**、路径不许越界 ——
这些**一条都没放宽**。
⚠️ 「允许安装未签名的更新包」**默认是关的**，且**只对「确实没有签名」的包生效**：
万一哪天产物带上了签名而签名者与预期不符，**授权救不了**（那是另一个、更糟的情况）。

