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
4. `release/verify/*.log` 记录本次验证的实际输出（**不是空文件**）；
5. **签名状态**：`node tools/fn-check-signature.mjs release`
   ⇒ 打印每个产物的 `Status` / 签名者 / 指纹
   （配了证书却没签上 ⇒ **打包本身就会失败**，这一步是**独立复核**）。

#### 本次产物（v0.2.4，本机实测）

| 资产 | 字节 | sha256 |
|---|---|---|
| `FN-Music-Setup-0.2.4.exe` | 86,106,122 | `f49d026e3a80e304375a10dc3b60ebd0679f6fe3d6fa37e7e678ec1ebb8a847c` |
| `FN-Music-Portable-0.2.4.exe` | 79,009,806 | `6757f39ee34b9a4e7fc96410372a40c2b5a4cb4880d19cfb11cbd3b0f86323e7` |
| `FN-Music-Setup-0.2.4.exe.blockmap` | 90,275 | `3ffd1ccf4c54a91a08bd369c3e8b81dbbf2f60cbcf9b32182eda3d7b7cd2b2ac` |
| `latest.yml` | 344 | `df13d89e76e7baaef7d53a3229b1d980b1fab052b77c138adc3232f8167fe9dd` |
| `latest.json` | 619 | `38f5de922919f818170150dfbb248a0b6626e02631a14d961cfb8b6d8b1eaad3` |

产物自检：两个安装包的 **FileVersion = 0.2.4**；本次构建的 `app.asar` 里
`package.json` 版本 = **0.2.4**、条目 **20** 条、**不含 `node_modules`**；
签名状态 = `NotSigned`（**公开产物不签名**，理由见 §7.7）。

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
npm test          # 单元测试（2195 条）
npm run e2e       # E2E 冒烟（Playwright 驱动真实 Electron）
npm run typecheck # 跑 tsc --noEmit（开着 noUnusedLocals / noUnusedParameters 闸门）
```

---

## 六、已知限制

- **无代码签名**：产物未签名 → Windows SmartScreen 会提示「未知发布者」。这是**预期**的；
  要签名**不用改配置** —— 设 `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` 即可（见 §7.5），
  打包后**自动断言**签没签上。
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

产物**默认不签**（`electron-builder.yml` 里 `win.sign` 留空）。
**要签不用改配置**——electron-builder 原生读这两个环境变量：

```powershell
$env:WIN_CSC_LINK='<证书路径（.pfx）或 base64 内容>'
$env:WIN_CSC_KEY_PASSWORD='<证书口令>'
npm run pack
```

- 没设这两个变量 ⇒ **自动跳过签名**（不报错）⇒ 产物就是未签名的；
- ⚠️ **打包后有断言**（`scripts/pack.cjs` → `tools/fn-check-signature.mjs`）：
  配了证书却没签上 ⇒ **打包直接失败**（electron-builder 本身可能只警告 ⇒ 不能信「打包成功」）。
  没配证书 ⇒ 只打印一行「产物未签名（预期行为）」，**不**失败；
- ⚠️ **口令绝不入库**：走环境变量 / CI Secret，**不要**写进 `electron-builder.yml`。

⚠️ 证书**由你自备**（本项目不附带任何证书）。
⚠️ 配好签名后，把证书的**主体名**（形如 `CN=你的公司`）填进应用的「预期的代码签名者」——
   两边对不上，客户端会拒绝启动安装器（这是**故意的**）。
⚠️ **主体名必须是公司法定主体名**（与营业执照一致）—— Windows 上显示的「发布者」= 证书 CN，
   **不是**软件名；软件名只能住在 exe 元数据里。

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

### 7.7 本地自签证书（**只为把链路跑通**，T86）

```powershell
# 生成一张自签「代码签名」证书（.pfx / .cer / 口令 ⇒ 都在 release/certs/，gitignored）
node tools/fn-make-selfsigned-cert.mjs --trust

# 用它打一个带签名的包（验证用产物 ⇒ 不碰 release/）
$env:WIN_CSC_LINK=(Resolve-Path 'release\certs\sanlos-code-signing.pfx').Path
$env:WIN_CSC_KEY_PASSWORD=(Get-Content -Raw 'release\certs\pfx-password.txt').Trim()
npm run pack:probe

# 随时单独查一次产物的签名状态
node tools/fn-check-signature.mjs release-probe
```

⚠️ **自签证书不可信** ⇒ 对外发布时 Windows 仍提示「未知发布者 / 不受信任的证书」
⇒ **自签产物只用于本地/内部把链路跑通**，**不要**发到公开 Release
（它会让 Windows 显示「发布者：公司名」却**查不到信任链** ⇒ 比不签名更容易误导人）。
⚠️ `--trust` 只导入**当前用户**的「受信任的根证书颁发机构」（**不影响别人**），撤销：
`certutil.exe -user -delstore Root <指纹>`。
⚠️ 主体名用**公司法定主体名** ⇒ 日后换成真实证书时**不用改任何配置**、
用户填的「预期的代码签名者」也不用改。

### 7.8 换成**真实** OV 证书（采购清单）

| 路线 | 可行性 | 要点 |
|---|---|---|
| **商业 OV**（DigiCert / Sectigo / GlobalSign 等） | ✅ 要走流程 | 私钥**必须**在硬件 token / HSM / 云签名（软件 `.pfx` 已被行业规则禁掉）；有效期上限已被压到 **459 天**；价格约 **$96.75（5 年）~$700（1 年）** |
| **Azure Artifact Signing** | ❌ 对中国大陆主体**不可用** | 公开信任资格限美国 / 加拿大 / 欧盟 / 英国的组织 + 美加个人；组织还需 3 年以上可验证税务历史 |
| **自签** | ⚠️ 只在本机不弹警告 | 对外照样「未知发布者」⇒ 公开发布**零意义** |

⚠️ **签名 ≠ 不弹窗**：SmartScreen 判的是**文件哈希的信誉** ⇒ 第一版照样弹；
要靠真实下载量 + 干净安装积累（通常数周、数百次）；**每次重新打包哈希就变 ⇒ 信誉清零**；
**必须加时间戳**（否则证书到期后历史安装包全部验证失败）。
唯一彻底免的是 **Microsoft Store**（商店代签，显示商店名）。
⚠️ **主体名一次定死**：换证书 = 换显示名 + SmartScreen 信誉清零 ⇒ 别换来换去。

### 7.9 走 **SignPath Foundation**（公开产物签名的当前路线，T87）

⚠️ **为什么不再按 §7.8「采购商业证书」走**：实测（2026-11）之后有三条**事实修正**：

| 原以为 | 实测（2026-11） |
|---|---|
| Certum 开源计划（免费）谁都能申请 | **要 GitHub star > 1k** ⇒ 本项目 star=0 ⇒ **够不着** |
| EV 证书能立刻拿到 SmartScreen 信誉 | 微软 **2024 起取消** EV 的即时信誉 ⇒ OV 与 EV **无差别**（个别 2026 选型文章仍在宣传「EV 秒获信誉」⇒ **过期信息**） |
| 签名证书要插 U 盾 | **Certum Standard 云签名 €209/年**，**SimplySign 云签名无需 UKey**；有效期上限已被压到 **459 天** |

⇒ **SignPath Foundation**（给符合资格的开源项目的**免费** OV 证书）是当前最优解：

| 事实 | 内容 |
|---|---|
| 成本 | **免费** |
| 密钥 | 私钥在 **SignPath 的 HSM**，CI 只持一个 **Submitter** 权限的 API token |
| 签发者 | **「SignPath Foundation」**（**不是**公司名）⇒ 用户看到的发布者就是它 |
| 前提 | **可信构建** —— 只签 **CI 从本仓库构建出的**产物 ⇒ **打包必须搬进 CI** |
| 流程 | **每次发布人工审批**（在 SignPath 平台点一次） |
| 团队 | 单维护者可兼任 author / reviewer / approver 三角色（有先例） |
| 前置 | GitHub 与 SignPath **两个账号都要开 MFA**；仓库要有 **OSI 认可的许可证**（本项目 = MIT） |

#### 落地形态（代码在仓库里）

| 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | 打包 → 送签 → 等审批 → 取回 → **校验** → 发 Release |
| `.signpath/artifact-configurations/default.xml` | 告诉 SignPath **签哪个文件**（两个 exe） |
| `scripts/check-signpath-config.mjs` | 配置**快速失败**（缺一项就停，绝不「跳过签名照样发布」） |
| `tools/fn-check-signature.mjs` | 签名断言：`--expect valid` + `--require-timestamp` + `--expect-cn` |
| `CODE_SIGNING_POLICY.md` | 交给 SignPath 审核的**代码签名政策** |
| `docs/signing.md` | 面向维护者/用户的完整说明（申请、配置、发版、故障排查） |

#### ⚠️ 时间戳源写在哪（**写错位置 = 整个打包挂掉**，T87.8 实测）

`electron-builder.yml` 里显式钉时间戳源，**必须**写在 `win.signtoolOptions` 下面：

```yaml
win:
  signtoolOptions:
    timeStampServer: http://timestamp.digicert.com       # 传统时间戳 /t
    rfc3161TimeStampServer: http://timestamp.digicert.com # RFC 3161 时间戳 /tr
```

⚠️ **写在 `win` 顶层（`win.timeStampServer`）是「非法键」** ⇒ electron-builder 的配置校验
**直接失败** ⇒ **整个打包挂掉**（2026-11-10 实测：CI run 42857375893 就死在这一行，
报错是 `Invalid configuration object … configuration.win should be one of these: null`）。

| 键 | 合法归属 | 代码读它的地方 |
|---|---|---|
| `timeStampServer` | `WindowsSigntoolConfiguration` ⇒ `win.signtoolOptions.timeStampServer` | `app-builder-lib/out/codeSign/windowsSignToolManager.js:200` |
| `rfc3161TimeStampServer` | 同上 ⇒ `win.signtoolOptions.rfc3161TimeStampServer` | 同上 `:199`（sha256 签名走这条 `/tr`） |

⇒ **守卫已就位**（别再靠「记得手测一遍」）：

- `test/t87-builder-config-schema.test.ts` 用 **electron-builder 自己的**配置加载器 +
  **它自己的 schema** 校验 `electron-builder.yml`（含「非法键必被拒」的变异自证）；
- `ci.yml` 每次 push / PR 都会 **真出一次包**（`Pack (smoke)` 步骤）
  ⇒ 配置写错不会再等到发版工作流才炸。

#### ⚠️ CI 里的下载镜像变量（**两个变量的写法不一样**，T87.9 实测）

`ci.yml` / `release.yml` 里有两个下载镜像变量，**它们的拼接规则不一样** ⇒ 照抄会挂：

| 变量 | 谁读它 | 拼接规则 | 正确写法 |
|---|---|---|---|
| `ELECTRON_MIRROR` | **@electron/get** | **纯字符串拼接** `${mirror}${version}/${file}` ⇒ **它自己不会补 `/`** | **必须自带结尾的 `/`**：`https://github.com/electron/electron/releases/download/` |
| `ELECTRON_BUILDER_BINARIES_MIRROR` | **electron-builder 自己**（`getBinariesMirrorUrl`） | `${base}${releaseName}/${file}`，但它**先补尾斜杠** | 带不带 `/` 都对 |

⚠️ **少了那个 `/` = 整个打包挂掉**（2026-11-10 实测）：CI run 42861355862 与
Release run 42861484377 都死在第 8 步 `Pack`：

```
⨯ Response code 404 (Not Found) for
  https://github.com/electron/electron/releases/downloadv32.3.3/electron-v32.3.3-win32-x64.zip
```

⚠️ **为什么「装依赖时没事、打包时才炸」**：`@electron/get` 的取值优先级里，
`.npmrc` 注入的 `npm_config_electron_mirror` **排在 `ELECTRON_MIRROR` 前面**
⇒ **`npm ci`**（npm 会注入）走 npmmirror；**`node scripts/pack.cjs` 不是 npm 命令**
⇒ 拿不到那些变量 ⇒ **只有 `ELECTRON_MIRROR` 生效**。

⇒ **守卫已就位**：`test/t87-ci-mirror-url.test.ts` 用 **@electron/get 自己的**
`getArtifactRemoteURL` 把工作流里那个值算成**真实下载 URL** ⇒ 镜像写错（少一个 `/`）
⇒ **`npm test` 就红**（不必等到 CI 打包挂掉才发现）。

#### ⚠️ 打包搬进 CI 带来的三个副作用

1. **产物集合变了**：签名会改 exe 的字节 ⇒ electron-builder 基于**未签名** exe 算出来的
   `latest.yml` 与 `*.blockmap` **失效** ⇒ **不再发布**它们
   （本项目的自动更新走自己的 `latest.json` + SHA-512，本来就不用它们）⇒
   公开 Release 的资产从 5 个变成 **3 个**（安装包 / 便携版 / `latest.json`）。
2. **`latest.json` 必须在签名之后生成**（否则 SHA-512 对不上，客户端一更新就失败）。
3. **本机手工打包的包签不了**（SignPath 不签非 CI 产物）⇒ 这是**特性**，不是缺陷。

#### 退路

若 Foundation 拒审、或单人三角色不被接受 ⇒ 换 **Certum Standard Code Signing in the Cloud
（€209/年）**。本项目的签名代码**不绑定 SignPath** ⇒ 只需要改「期望的 CN 候选值」
（客户端设置页 + CI 的 `SIGNPATH_EXPECTED_CN`）即可，**不用改任何逻辑**。

