# T87：公开产物的代码签名落地（SignPath Foundation 免费路线）

> 日期：2026-11-10
> 承接：T85（修好「允许安装未签名的更新包」）、T86（把签名**管线**接上）
> 状态：设计已获用户批准（路线 = SignPath Foundation 免费签名；打包搬进 CI；Store 路线留作 T88）
>
> ⚠️ **2026-11-11 状态更新**：申请**已提交、审核中** ⇒ **v0.2.5 的产物仍未签名**，
> **v0.2.6 起**才启用（发版改走 `sign=false` 的未签名分支，直到证书到位）。
> 详见 [2026-11-11 的未签名发版规格](./2026-11-11-sanlos-music-unsigned-release-design.md)。
> **本文是设计记录**（「目标」那一节写的是**计划**，不是**已发生的现状**）。

---

## 一、问题与现状

公开产物的安装包**没有代码签名**，造成两个后果：

1. **Windows SmartScreen 显示「未知发布者」**（UAC 提示里显示未经验证的发布者），
   普通用户会因此放弃安装；
2. **更严重**：在**开启了 Smart App Control 的 Windows 11** 上，未签名程序会被
   **直接拦截**（`WinError 4551`）—— 那不是「提示难看」，是**跑不起来**，
   而且没有「按应用临时放行」的开关（只能整体关掉，且关掉后不能开回来，
   除非重装 Windows）。

T86 已经把**签名管线**接好（`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` + 打包后签名断言），
但**手里没有公开可信的证书** ⇒ 公开产物至今未签名。

### 1.1 `docs/packaging.md` §7.8 的采购清单**已过时**（2026-11-10 实测修正）

| 旧口径 | 实测结论（2026-11-10） |
|---|---|
| 「私钥**必须**在硬件 token / HSM / 云签名」 | **对 DigiCert / GlobalSign / Sectigo 成立**；但 **Certum 提供云签名（SimplySign）**，私钥在云 HSM（FIPS 140-2 L3 / CC EAL4+），**不需要实体 UKey** |
| 「Azure Artifact Signing 对中国大陆主体不可用」 | 仍然成立（资格限美国/加拿大/欧盟/英国的组织 + 美加个人，组织还需 3 年以上可验证税务历史） |
| 未提「免费路线」 | **Certum 开源代码签名**：托管在 GitHub、**star > 1k** 的项目可免费申请（**我们 star=0，够不着**）；**SignPath Foundation**：OSI 许可 + 公开仓库 + 活跃维护 + 已发布 ⇒ **我们符合** |

### 1.2 2026-11-10 实测到的事实（含来源）

| 事实 | 来源 |
|---|---|
| Certum Open Source Code Signing in the Cloud = **€49 gross**；Standard Code Signing in the Cloud = **€209 gross**；有效期上限 **459 天**（2026-02-27 起） | `shop.certum.eu/code-signing.html` |
| Certum 开源计划：**GitHub star > 1k** 可免费；申请人须为**中华人民共和国国籍**；每月签名上限 5000 次 | `certumcodesign.cn/shop/product/open-source-code-signing-cloud` |
| **SignPath Foundation**：给符合资格的开源项目**免费** OV 级代码签名证书；私钥在 SignPath 的 **HSM**；**证书 publisher = 「SignPath Foundation」**（不是项目自己的组织名）；**每次发布都要人工审批**；团队成员须对 SignPath 与仓库都启用 **MFA** | `signpath.org` / `foropensource.com/signpath` / `eztoolset.com/tools/signpath-foundation/` |
| **SignPath 以「可信构建」为前提**：只签 **CI（GitHub Actions 等）从本仓库构建出的**产物 | `about.signpath.io/product/open-source`；同类项目 Vortelio 的 `docs/SIGNING.md` |
| **单维护者可以兼任 author / reviewer / approver 三个角色**（有先例） | RepoAtlas `CODE_SIGNING_POLICY.md` |
| 签名**没有时间戳** ⇒ 证书到期时**连同历史包一起失效** ⇒ 必须带 RFC 3161 时间戳 | CA/B 通行做法；同类项目的发布清单把它列为**失败条件** |
| **EV 不再有 SmartScreen 即时信誉**（微软 2024 起取消）⇒ OV 与 EV 在提示上无差别 | 2026 选型资料 + 微软 SmartScreen 信誉文档 |
| Microsoft Store 的 **MSIX** 包由**微软证书重签** ⇒ **彻底免 SmartScreen**；但 **Store 的 EXE/MSI 列表不提供自动更新** | electron-builder `msix` 文档 / `storefast.app` / `itechguides.com` |

> ⚠️ **来源冲突已记录**：个别 2026 年选型文章仍写「EV 证书能立即获得 SmartScreen 信誉」。
> 本项目按**微软官方口径**（EV 与 OV 均需积累信誉）执行，不采用该说法。

---

## 二、目标与非目标

### 2.1 目标

1. **公开安装包带上微软信任的公开 OV 签名** ⇒ 不再显示「未知发布者」，
   且**在开启 Smart App Control 的 Windows 11 上不再被直接拦截**；
2. **签名者判定口径能吃下真实证书的 Subject 形态**（当前是整串精确相等，手打必错）；
3. **签名断言加严**：没有时间戳 ⇒ **判失败**（否则证书到期后历史包集体失效）；
4. **打包搬进 CI**（SignPath 的硬性前提），顺带把发版流程自动化；
5. **申请材料与政策文档**齐备，用户提交表单即可。

### 2.2 非目标（本轮明确不做）

- ❌ **不做 Microsoft Store / MSIX**（另立 **T88**，两条渠道并存：Release 走 NSIS + 应用内自更新，
  Store 走 MSIX + Store 推送更新）。本轮改动**不阻塞** T88（CI 工作流可继续扩 MSIX job）。
- ❌ **不承诺「SmartScreen 蓝框彻底消失」**：信誉靠真实下载量积累（通常数周、数百次下载）；
  **第一版仍可能弹**「Windows 已保护你的电脑」。文案与文档一律如实写。
- ❌ **不用自签证书进公开 Release**（T86 决策不变：自签会让 Windows 显示公司名却查不到信任链，
  比不签名更容易误导人）。
- ❌ **不改「允许安装未签名的更新包」这条口径**（T85 口径一字不动）。

### 2.3 路线取舍的诚实说明

| 取舍 | 内容 |
|---|---|
| **发布者显示什么** | SignPath 免费证书的 publisher 是 **「SignPath Foundation」**，**不是**「广西闪链时空网络科技有限公司」⇒ Windows 上显示的是前者。**这是免费路线的固有代价**，用户已知悉并选定。 |
| **退路** | 若 Foundation 拒审、或单人三角色不被接受 ⇒ 换 **Certum Standard Code Signing in the Cloud（€209/年，组织身份，CN = 公司法定主体名）**。本轮的代码（87.2 / 87.3 / 87.4）**不绑定 SignPath**，只换证书来源与 CN 候选值即可。 |
| **每次发布的额外动作** | 在 SignPath 平台**人工点一次审批**。 |

---

## 三、设计

### 3.1 签名者匹配口径（87.2）——**前置缺陷修复**

**现状缺陷**：`electron/update.ts` 的 `verifyAuthenticode()` 用
`probed.signer !== expected` **整串精确相等**比对，而 `probed.signer` 是 PowerShell
`SignerCertificate.Subject` 的**完整 RFC4514 串**，形如：

```text
CN=SignPath Foundation, O=SignPath Foundation GmbH, C=AT
```

⇒ 用户必须**逐字符**粘贴这串才能匹配（手打必错；证书续期或换 CA 后还会失效）。
而「预期的代码签名者」这个设置项在 UI 上就是一个普通输入框。

**修法**（判定逻辑仍只放一份，落在 `shared/update.ts`，主进程与渲染层共用）：

新增三个**纯函数**（不 import Electron / Node / DOM，可安全进渲染层 bundle）：

| 函数 | 语义 |
|---|---|
| `extractCommonNames(subject: string): string[]` | 从 RFC4514 Subject 里取出**全部** `CN` 分量（按未转义的 `,` 切分，支持 `\,` 转义），去空白、折叠内部空白 |
| `parseSignerCandidates(expected: string): string[]` | 把用户填的值解析成候选集：先按 `,` `;` 换行 切分，逐项去空白 |
| `matchesExpectedSigner(subject: string, expected: string): boolean` | 判定是否命中 |

**匹配顺序（安全关键）**：

1. **整串相等优先**：规范化（trim + 折叠内部空白 + 转小写）后，
   `subject` 整串 == 某个候选 ⇒ 命中
   —— 这一步保住**既有配置**（有人已经粘了整个 Subject 串）；
2. 否则取 `subject` 的**全部 CN**，与候选逐个**相等**比较 ⇒ 命中。

**绝不做「包含匹配」**：候选 `SignPath Foundation Evil` **不得**匹配
`CN=SignPath Foundation`；候选 `Evil` 也不得匹配。
（用包含匹配的话，攻击者可以签一张 `CN=SignPath Foundation Evil` 的证书骗过闸门。）

**既有口径一字不动**：
- 包**有**签名 + **没配**预期签名者 ⇒ 仍**拒绝**（授权也救不了）；
- 包**没**签名 ⇒ 仍走「允许安装未签名的更新包」那条路（仍必须 SHA-512 相符）；
- 探测失败 ⇒ 仍**拒绝**。

**UI**：设置项「预期的代码签名者」改为**支持多个候选**（逗号 / 分号 / 换行分隔），
帮助文案写清：可填 `SignPath Foundation`；留空 ⇒ 「有签名的包」一律拒绝。

### 3.2 签名断言加严（87.3）

`tools/fn-check-signature.mjs` 新增：

| 选项 | 语义 |
|---|---|
| `--require-timestamp` | 要求 `Get-AuthenticodeSignature` 的 `TimeStamperCertificate` **非空** ⇒ 签名带了 RFC 3161 时间戳。**没有时间戳 ⇒ 判失败**（证书到期后历史包会集体失效） |
| `--expect-cn <name>` | 要求签名者 Subject 里的 **CN** 与 `<name>` 相等（复用 §3.1 的匹配口径；`<name>` 可含逗号分隔的多个候选） |

既有选项（`--expect signed\|none` / `--expect-signer` / `--pfx`）**行为不变**。

### 3.3 打包搬进 CI + 送签（87.4 / 87.5）

**为什么必须搬进 CI**：SignPath 免费计划以「可信构建」为前提 —— 只签 **CI 从本仓库构建出的**产物，
本机手工打包的包**签不了**。⇒ 发版流程从「本机手工」改为「CI 自动」。

**新工作流 `.github/workflows/release.yml`**（`workflow_dispatch`，输入 `tag` 与 `pack_only`）：

```
checkout(ref=tag) → setup-node(22) → npm ci
  → typecheck / test / build
  → node scripts/pack.cjs            (FNM_PACK_OUTPUT=release-ci)
  → upload-artifact(release-ci/*)
  → 【pack_only=true 时到此为止】    ← 用来验证「CI 能跑 pack」
  → SignPath：提交送签 → 等人工审批 → 取回签名件
  → 校验：fn-check-signature --expect signed --require-timestamp --expect-cn "<CN>"
  → publish-manifest（latest.json：version / releasedAt / notes / sha512 / size）
  → 建/更新 GitHub Release，上传 5 个资产
```

**失败即失败（安全失败设计）**：以下任一情况 ⇒ 工作流**失败**，**绝不产出「声称已签名」的产物**：

| 情况 | 处理 |
|---|---|
| SignPath 的 secrets 未配置 | **快速失败**并说明缺哪几个（不做「跳过签名照样发布」） |
| 签名状态不是 `Valid` | 失败 |
| **没有时间戳** | 失败 |
| CN 与预期不符 | 失败 |
| 审批超时 | 失败（保留 artifact 供排查） |

**87.5（打包脚本适配 CI）**：`scripts/pack.cjs` 已支持 `FNM_PACK_OUTPUT`、
已复用本地 `node_modules/electron/dist`（`ELECTRON_OVERRIDE_DIST_PATH`）、
`npm ci` 的 postinstall 会装 electron ⇒ **适配面很小**。需要补的：

- CI 里 `npm run pack` 会**重复跑一次 build** ⇒ 工作流直接调 `node scripts/pack.cjs`
  （第 4 步已 build，`pack.cjs` 自带前置检查）；
- CI 环境加 `CSC_IDENTITY_AUTO_DISCOVERY=false`（避免 builder 在无证书机器上做证书自动探测）；
- `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 沿用 `ci.yml` 里的设置。

**SignPath 需要的 5 个 secrets**（批下来才填，缺失时工作流快速失败）：
`SIGNPATH_ORG_ID`、`SIGNPATH_PROJECT_SLUG`、`SIGNPATH_ARTIFACT_SLUG`、
`SIGNPATH_POLICY_SLUG`、`SIGNPATH_API_TOKEN`。

### 3.4 申请材料与政策文档（87.1）

| 文件 | 用途 |
|---|---|
| **新** `CODE_SIGNING_POLICY.md` | SignPath 审核会看的**代码签名政策**：项目与许可证、构建来源（CI 可信构建）、团队角色（单维护者兼 author/reviewer/approver + MFA）、签名范围（只签本项目自己的产物）、密钥不落地（私钥在 SignPath HSM，CI 只持 API token）、每次发布人工审批、证书到期与吊销的处理、发布前校验清单 |
| **新** `docs/signing.md` | 面向维护者/用户的说明：签名怎么来的、怎么验证（`Get-AuthenticodeSignature` / `Status=Valid` / CN）、时间戳的意义、签了仍可能弹 SmartScreen 的实话、申请与审批流程 |

### 3.5 客户端与文档（87.6）

| 文件 | 改什么 |
|---|---|
| `src/components/SettingsPanel.tsx` | 「预期的代码签名者」支持多候选 + 帮助文案（含默认值 `SignPath Foundation`） |
| `src/state/updateStore.ts` | 透传候选串（类型不变，只是语义扩展） |
| `README.md` | 安装说明补「已签名」状态与验证方法；提示 SmartScreen 蓝框仍可能出现 |
| `docs/packaging.md` | **新增 §7.9**：SignPath 路线怎么走（含 §7.8 的事实修正） |
| `docs/changelog.md` | 「未发布」小节并入 T87 |
| `docs/calibration.md` | 新增「四十九、T87」 |

### 3.6 发版（87.7）

- 版本号 **0.2.5**（0.2.4 已发布且未签名，签名版必须是新版本）；
- 产物来自 **CI**（NSIS 内嵌构建时间戳 ⇒ 哈希与 0.2.4 必然不同）；
- 发布后**回下载比对 sha256**（复用 `release/verify/fnm-verify-release-assets-*.mjs` 的分块下载法）；
- 客户端侧：预期签名者填 `SignPath Foundation` ⇒ 走「有签名且匹配」那条路放行。

---

## 四、数据流（签名版一次发布）

```
git tag v0.2.5  ──►  GitHub Actions（release.yml，workflow_dispatch，ref=v0.2.5）
                        │  build → pack（release-ci/）
                        ▼
                     SignPath 提交送签 ──► 【人工审批：维护者在 SignPath 平台点一次】
                        │
                        ▼
                     取回签名件 ──► 断言：Status=Valid ∧ 有时间戳 ∧ CN 匹配
                        │（任一不满足 ⇒ 失败，不发布）
                        ▼
                     latest.json（sha512/size）→ GitHub Release（5 个资产）
                        │
                        ▼
        客户端检查更新 → 下载 → 验 SHA-512 → 验 Authenticode（CN ∈ 候选集）
                        │                                    │
                        │                                    └─ 不匹配 ⇒ 拒绝启动安装器
                        ▼
                     启动安装器 ⇒ Windows 显示「发布者: SignPath Foundation」
```

---

## 五、测试与验收

### 5.1 单测（既有测试一条不删、断言一条不削弱）

| 断言 | 期望 |
|---|---|
| `extractCommonNames('CN=SignPath Foundation, O=SignPath Foundation GmbH, C=AT')` | `['SignPath Foundation']` |
| `extractCommonNames` 处理转义逗号 `CN=A\\, B` | `['A, B']` |
| `matchesExpectedSigner(subject, 'SignPath Foundation')` | **true** |
| `matchesExpectedSigner(subject, 'signpath foundation')` | **true**（大小写不敏感） |
| `matchesExpectedSigner(subject, 'SignPath Foundation Evil')` | **false**（含式伪造不放行） |
| `matchesExpectedSigner(subject, 'Evil, Other')` | **false** |
| `matchesExpectedSigner(subject, 'CN=SignPath Foundation, O=…, C=AT')` | **true**（整串相等，兼容既有配置） |
| `matchesExpectedSigner(subject, '')` | **false**（留空 ⇒ 有签名的包仍被拒） |
| 候选集分隔（`A;B` / `A,B` / 换行） | 都能命中 |
| `--require-timestamp`：产物无时间戳 | 判定**失败** |
| `--expect-cn`：CN 不符 | 判定**失败** |

### 5.2 契约测试（源码层，沿用 T86 的做法）

钉住「工作流里必须有哪些东西」：必须有 `pack_only` 快路径、必须有 `--require-timestamp`、
必须有 `--expect-cn`、缺 secrets 必须失败（不许静默跳过签名）、必须有「校验通过才发布」的顺序。

### 5.3 端到端验收点

| 项 | 期望 |
|---|---|
| `tsc --noEmit` | exit 0 |
| `vitest` | **≥ 2195**（既有 2195 条一条不删；新增若干） |
| `npm run build` | exit 0 |
| `playwright` | **34 passed**（一条不删） |
| **CI `pack_only=true`** | 在 `windows-latest` 上 `pack` 成功并产出 5 个产物（**这是 87.5 的门**） |
| 签名产物（**需 Foundation 批下来才能实测**） | `Status=Valid`、`Subject` 含 `CN=SignPath Foundation`、`TimeStamperCertificate` 非空 |
| 客户端三态（真机） | 填 `SignPath Foundation` ⇒ 放行；填错 ⇒ 拒绝；填 `SignPath Foundation Evil` ⇒ 拒绝 |

---

## 六、风险与退路

| 风险 | 退路 |
|---|---|
| Foundation 拒审 / 单人三角色不被接受 | 换 Certum Standard 云签名（€209/年，CN=公司名）；**87.2/87.3/87.4 的代码不绑定 SignPath** |
| CI 跑不动 `npm run pack` | 用 `pack_only` 定位；必要时改「本机构建 + SignPath hash-signing API」（origin verification 弱化，**申请时要说明**） |
| 审核耗时不定（数周） | 不阻塞 87.2/87.3/87.5/87.6；期间公开产物仍走「允许安装未签名的更新包」 |
| SmartScreen 蓝框仍弹 | 如实写进文档与更新说明；**不承诺彻底消失** |
| 证书 CN 变了 / 证书吊销 | 候选集机制让「换证书来源」只改配置不改逻辑；吊销处理写进 `CODE_SIGNING_POLICY.md` |

---

## 七、子任务、commit 与验收

| # | 子任务 | 主要文件 |
|---|---|---|
| 87.1 | 申请材料与政策文档 | **新** `CODE_SIGNING_POLICY.md`、**新** `docs/signing.md` |
| 87.2 | 签名者匹配口径（前置缺陷） | `shared/update.ts`、`electron/update.ts`、`src/components/SettingsPanel.tsx`、`src/state/updateStore.ts`、`test/update.test.ts`、`test/settings-page.test.tsx` |
| 87.3 | 签名断言加严（时间戳 + CN） | `tools/fn-check-signature.mjs`、`test/t86-signing-contract.test.ts` |
| 87.5 | 打包适配 CI | `scripts/pack.cjs`（若需要） |
| 87.4 | CI 打包 + 送签工作流 | **新** `.github/workflows/release.yml`、`test/t87-signing-workflow.test.ts`（新） |
| 87.6 | 客户端与文档 | `README.md`、`docs/packaging.md`、`docs/changelog.md`、`docs/calibration.md` |
| 87.7 | 发版 v0.2.5 | 版本号 bump + `docs/releases/v0.2.5.md` + 发布 + 回下载比对 |

**commit 口径**：本任务 **2 个 commit** ——① 规格先行（本文件）；② 实现（87.1~87.6 的全部改动）。
87.7 发版另起（版本号 bump、发版说明各一个 commit），沿用 v0.2.4 的口径。

---

## 八、待用户完成的事项（工程侧无法代替）

1. 提交 SignPath Foundation 申请（`signpath.org/apply`，提供仓库 URL、许可证、项目描述、维护者身份）；
2. 批下来后把 5 个 secrets 填进仓库；
3. 每次发布时在 SignPath 平台**点一次审批**；
4. 真机复验 §5.3 的客户端三态。

---

## 九、T87.8 修订：`electron-builder.yml` 非法键导致 CI 出包失败（2026-11-10）

### 9.1 现象

T87 实现提交（`78ff477`）之后，手动 dispatch 了一次 `Release` 工作流
（`workflow_dispatch`，`pack_only=true`，**只打包、不送签、不发版**）：

- run **42857375893** ⇒ **失败**（作业 `build → sign → verify → publish`）
- 失败步骤：**第 8 步 `Pack`**；前 7 步（checkout / setup-node / npm ci /
  typecheck / test / build）**全绿** ⇒ **不是环境问题，是配置问题**。

job log 原文：

```
Error: Invalid configuration object. electron-builder 26.18.0 has been initialized
using a configuration object that does not match the API schema.
 - configuration.win should be one of these:
   null
    at validateSchema (…/app-builder-lib/src/util/config/schemaValidator.ts:45:9)
    at validateConfiguration (…/app-builder-lib/src/util/config/config.ts:238:17)
    at Packager.validateConfig (…/app-builder-lib/src/packager.ts:399:5)
```

### 9.2 根因

**`electron-builder.yml` 里的 `win.timeStampServer` 不是 electron-builder 26.18.0
的合法键 ⇒ 配置校验直接失败 ⇒ 整个打包挂掉。**

证据（本机实测，不是推断）：

| 事实 | 证据 |
|---|---|
| 该键只存在于 **`WindowsSigntoolConfiguration`** | `node_modules/app-builder-lib/out/options/winOptions.d.ts`：`timeStampServer`（第 114 行）与 `rfc3161TimeStampServer`（第 109 行）同属该接口 |
| `WindowsSigntoolConfiguration` 挂在 **`win.signtoolOptions`** 下 | 同文件 `WindowsConfiguration.signtoolOptions?: WindowsSigntoolConfiguration \| null` |
| 代码真正读的就是 `signtoolOptions` | `out/codeSign/windowsSignToolManager.js:199-200`：`options.options.signtoolOptions?.rfc3161TimeStampServer` / `?.timeStampServer`，缺省都是 `http://timestamp.digicert.com` |
| 写到 `win` 顶层 ⇒ **整个打包直接失败** | 本地复现：`node node_modules/electron-builder/cli.js --config electron-builder.yml` ⇒ **报错与 CI 一字不差** |

⇒ 正确写法是 `win.signtoolOptions.timeStampServer`（RFC 3161 用
`rfc3161TimeStampServer`）；**不是** `win.timeStampServer`，**也不是**
`win.sign.timeStampServer`。

### 9.3 为什么会「没人发现」

两道本该拦住它的关卡都没拦住：

1. **本机没重跑打包** —— T87 的验证清单里有 `tsc / vitest / build / e2e /
   变异自证 / 真证书实测`，**唯独没有 `npm run pack`** ⇒ 改了
   `electron-builder.yml` 却没打包验证过；
2. **CI 不打包** —— `ci.yml` 只跑 `typecheck / test / build`
   ⇒ **配置级的错误只有发版工作流才会碰到**。

⇒ 这不是「偶发环境问题」，是**流程缺口**：
**谁改了打包配置，就必须有能验证打包配置的关卡。**

### 9.4 修法（三条，缺一不可）

| # | 措施 | 作用 |
|---|---|---|
| ① | `win.timeStampServer` → `win.signtoolOptions.{timeStampServer, rfc3161TimeStampServer}` | 修掉**这一次**的失败 |
| ② | **新** `test/t87-builder-config-schema.test.ts`：用 **electron-builder 自己的**配置加载器（`getConfig`）+ **它自己的 schema**（`validateConfiguration`）校验 `electron-builder.yml` | 把「配置非法键」从「发版时才发现」变成「`npm test` 就红」 |
| ③ | `ci.yml` 加一步 `Pack (smoke)`（`node scripts/pack.cjs`，输出到 `release-ci/`） | 每次 push **真出一次包** ⇒ 打包链路（而不只是源码）始终被验证 |

⚠️ ② **不自己写 schema 校验器**：直接调 electron-builder 自己的
`validateConfiguration` ⇒ 判定口径与真正打包时**是同一份**，
不会出现「自己写的校验器漏判、于是照样放行」。

⚠️ ③ 的代价：CI 每次 push 多花约 3~5 分钟（要下 NSIS / winCodeSign 等构建器
二进制）。**接受** —— 公开产物的第一道门就是「能出包」。

### 9.5 附带发现：CI 里的 `ELECTRON_MIRROR` 覆盖其实是**死代码**（**⚠️ 本节结论已被 T87.9 推翻，见第十节**）

`@electron/get` 的取值优先级（`node_modules/@electron/get/dist/cjs/artifact-utils.js:26-32`）：
**`.npmrc` 注入的 `npm_config_electron_mirror` 排在 `ELECTRON_MIRROR` 前面**
⇒ 仓库 `.npmrc` 的 `electron_mirror=https://npmmirror.com/mirrors/electron/`
**优先于**工作流里写的 `ELECTRON_MIRROR` ⇒ 那句「这里显式指回官方源」与
**实际行为不符**。

而且那个值本身也是坏的：`https://github.com/electron/electron/releases/download/v`
多了尾部 `/v`，而 `@electron/get` 会自己拼 `v<version>/` 目录。实测（Range GET）：

- `…/releases/download/v32.3.3/electron-v32.3.3-win32-x64.zip` ⇒ **HTTP 206**（正确形态）
- `…/releases/download/v/v32.3.3/electron-v32.3.3-win32-x64.zip` ⇒ **HTTP 404**（多一个 `/v`）

⇒ 本次**不改行为**（现网 CI 是绿的 ⇒ 不夹带无关变更），只把注释改成**与事实一致**，
并把「真要改用官方源，必须用 npm 风格的小写变量名、且值不带 `/v`」写进注释。

> ⚠️ **更正（2026-11-10，T87.9）**：本节的「`ELECTRON_MIRROR` 是死代码」**只对 `npm ci` 成立**。
> `node scripts/pack.cjs` **不是 npm 命令** ⇒ 拿不到 `.npmrc` 注入的
> `npm_config_electron_mirror` ⇒ **只有 `ELECTRON_MIRROR` 生效**。
> 而且「值不带 `/v`」这条**不完整**：正确形态是**带结尾的 `/`**（`…/releases/download/`）
> ⇒ 本节末尾那句「值不带 `/v`」被当成了「不带尾斜杠」⇒ **T87.8 把 CI 打包打挂了**。
> 详见第十节。

### 9.6 验收

| 项 | 口径 |
|---|---|
| 本地打包 | `node scripts/pack.cjs` **exit 0**，且产出 `FN-Music-Setup-*.exe` / `FN-Music-Portable-*.exe` |
| 守卫有效性 | 把非法键塞回 `electron-builder.yml` ⇒ **新测试必红**（变异自证） |
| `tsc --noEmit` | exit 0 |
| `vitest` | **≥ 2260**（既有 2260 条一条不删；新增若干） |
| CI | `ci.yml` run **success**（含新增的 `Pack (smoke)` 步骤） |
| 发版链路 | `release.yml`（`pack_only=true`）run **success** ⇒ 证明「CI 能出包」 |

---

## 十、T87.9 修订：`ELECTRON_MIRROR` 缺尾斜杠导致 CI 打包 404（2026-11-10）

### 10.1 现象

T87.8 的两个提交（`3db3c8c` 修配置、`370ca6f` 修行尾断言）推上去之后：

- CI run **42861355862** ⇒ **失败**（作业 `typecheck + unit tests + build + pack`）
- Release run **42861484377**（`pack_only=true`）⇒ **失败**（作业 `build → sign → verify → publish`）

两个作业的**前 7 步全绿**（checkout / setup-node / npm ci / typecheck / **test** / build）
⇒ **T87.8 的 CRLF 修复生效了**（单测这次过了）⇒ 失败都落在**第 8 步 `Pack`**。

job log 原文（CI run 42861355862，第 20 行）：

```
  • packaging       platform=win32 arch=x64 electron=32.3.3 appOutDir=.pack-staging\win-unpacked
  • downloaded      label=electron progress=100%
⨯ Response code 404 (Not Found) for
  https://github.com/electron/electron/releases/downloadv32.3.3/electron-v32.3.3-win32-x64.zip
```

⇒ `download` 后面**少了一个 `/`**。

### 10.2 根因

**`ELECTRON_MIRROR` 的值必须自带结尾的 `/`；T87.8 把它改成了「无尾斜杠」⇒ CI 打包必 404。**

事实（本机读代码 + Range GET 实测，不是推断）：

| 事实 | 证据 |
|---|---|
| `@electron/get` 的下载 URL 是**纯字符串拼接** | `app-builder-lib/node_modules/@electron/get/dist/cjs/artifact-utils.js:59`：`return \`${base}${path}/${file}\`` ⇒ `base`（镜像）**自带** `/` 时才是 `…/download/v32.3.3/electron-….zip` |
| 它的默认值**带**尾斜杠 | 同文件 `BASE_URL = 'https://github.com/electron/electron/releases/download/'` |
| `ELECTRON_MIRROR` 只在**非 npm 上下文**里生效 | `mirrorVar`（同文件 23-38）优先级：`npm_config_electron_mirror`（**`.npmrc` 注入**）→ `NPM_CONFIG_…` → … → `ELECTRON_MIRROR` → 默认。`npm ci` 时 npm 会注入前者 ⇒ 走 npmmirror；**`node scripts/pack.cjs` 不是 npm 命令 ⇒ 拿不到那些变量 ⇒ 只有 `ELECTRON_MIRROR` 生效** |
| 正确形态确实可达 | `https://github.com/electron/electron/releases/download/v32.3.3/electron-v32.3.3-win32-x64.zip` ⇒ **HTTP 206**；`…/download/v32.3.3/SHASUMS256.txt` ⇒ **HTTP 206** |

⇒ **是本任务自己把上一轮改坏的**：T87.8 §9.5 判断「`ELECTRON_MIRROR` 是死代码（`.npmrc` 优先）」，
于是把值改成「无尾斜杠」形态 ⇒ 在**非 npm 上下文**里拼出畸形 URL。
⚠️ 那条结论**只对 `npm ci` 成立**，对 `node scripts/pack.cjs` **不成立**。

⚠️ **另一条镜像不用改**：`ELECTRON_BUILDER_BINARIES_MIRROR` 由 electron-builder 自己的
`getBinariesMirrorUrl()` 读（`app-builder-lib/out/util/electronGet.js:748`），
它**自己补尾斜杠**（`url.endsWith("/") ? url : \`${url}/\``）⇒ 带不带 `/` 都对。
（实测 `…/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z` 与
`…/download/nsis-3.0.4.1/nsis-3.0.4.1.7z` 均 **206**。）

### 10.3 为什么本地测不出来

| 本机 | CI |
|---|---|
| electron-builder 的下载缓存里**已有** electron zip ⇒ **根本不下载** | 干净 runner ⇒ 缓存空 ⇒ **必须下载** |
| 之前那次打包已经把 zip 拉下来了 | 每次 run 都是新机器 |

⇒ 「本地绿、CI 红」的又一种形态：**不是代码不同，是「本机有缓存、CI 没缓存」**。
⇒ 凡是「本机靠缓存跑通、CI 必须联网」的步骤，**必须有一条不依赖缓存的守卫**。

### 10.4 修法（三条，缺一不可）

| # | 措施 | 作用 |
|---|---|---|
| ① | `ci.yml` / `release.yml` 的 `ELECTRON_MIRROR` 补回结尾的 `/`；注释改成**事实**（两个镜像变量的**拼接规则不同**、**优先级不同**） | 修掉**这一次**的失败 |
| ② | **新** `test/t87-ci-mirror-url.test.ts`：用 **@electron/get 自己的** `getArtifactRemoteURL` 把工作流里那个值算成**真实下载 URL** | 把「少一个 `/`」从「CI 打包才红」变成「`npm test` 就红」 |
| ③ | 更正 §9.5 的错误结论 + 在 `docs/packaging.md` 写清「这两个变量的写法不一样」 | 不让**同一个错误结论**留在仓库里骗下一个人 |

⚠️ ② **不自己写 URL 拼接规则**：直接调 `@electron/get` 的 `getArtifactRemoteURL`
⇒ 判定口径与真正下载时**是同一份**（与 T87.8 的 `validateConfiguration` 同一思路）。

### 10.5 验收

| 项 | 口径 |
|---|---|
| 守卫有效性 | 去掉 `ELECTRON_MIRROR` 的尾斜杠 ⇒ **新测试必红**（变异自证） |
| 真实可达 | 用算出来的 URL 做 Range GET ⇒ **206** |
| `tsc --noEmit` | exit 0 |
| `vitest` | **≥ 2263**（既有 2263 条一条不删；新增若干） |
| CI | run **success**（含 `Pack (smoke)`） |
| 发版链路 | `release.yml`（`pack_only=true`）run **success** |

---

## 十一、T87.10 修订：PowerShell 把 Markdown 反引号当转义符 ⇒ Summary 步骤解析失败（2026-11-10）

### 11.1 现象

T87.9 修好之后（head `32a967c`）：

| run | 工作流 | 结果 |
|---|---|---|
| **42865021458** | CI（push） | ✅ **success**（8 步全绿，含 `Pack (smoke)`，耗时 4m47s） |
| **42865707790** | Release（`workflow_dispatch`，`pack_only=true`） | ❌ **失败**（4m31s） |

Release 这一轮有个**关键信号**：run 页面的 **Artifacts 里已经有 `unsigned-artifacts`（268 MB）**
⇒ **第 8 步 `Pack` 成功了**（两个 exe 都出出来了）⇒ 失败在**之后**的步骤。
失败步骤 = **第 10 步 `Summary (pack only)`**（check-run annotation 的锚点是 `#step:10:18`）。

job log 原文：

```
Summary (pack only)
1s
Run echo "### 只打包模式" >> $env:GITHUB_STEP_SUMMARY

ParserError: D:\a\_temp\1c8f7698-d0f4-421f-8a7c-4e86787eef31.ps1:4

Line |
   4 |  echo "产物已上传为 artifact \`unsigned-artifacts\`（**未签名**，符合预期）。" >> $env: …
     |                         ~~
     | The Unicode escape sequence is not valid. A valid sequence is `u{ followed by one to six hex digits and a
     | closing '}'.

Error: Process completed with exit code 1.
```

### 11.2 根因

**PowerShell 的反引号（`` ` ``）是转义符** ⇒ 双引号字符串里的 Markdown 行内代码
`` `unsigned-artifacts` `` 被当成「转义序列起始」⇒ `` `u `` 不是合法的转义序列
⇒ **整个脚本解析失败**（ParserError）⇒ 步骤退出码 1。

⚠️ 这行是 **T87 就写好**的，但此前**每一步都先挂**（非法键 → CRLF → 404）
⇒ 它一直藏着，**直到 Pack 通了才第一次被执行到**。
⇒ **教训**：**工作流里「跑不到」的步骤等于「没写」** —— 每一步都得能单独被执行。

### 11.3 修法（两条，缺一不可）

| # | 措施 | 作用 |
|---|---|---|
| ① | `release.yml` 的 Summary 步骤改用 **单引号**字符串（PowerShell 单引号里**没有**转义语义 ⇒ 反引号是普通字符） | 修掉**这一次**的失败 |
| ② | **新守卫测试**：所有工作流的 `run:` 块里**不许出现反引号**（PowerShell 把它当转义符、bash 把它当命令替换 ⇒ 两边都不能有） | 把它从「CI 跑到才发现」变成「**`npm test` 就红**」 |

⚠️ ② 的口径：**只看 `run:` 块里非注释的行**（YAML 注释里的反引号无害 —— 注释不会被 shell 执行）。

### 11.4 验收

| 项 | 口径 |
|---|---|
| 守卫有效性 | 把反引号塞回某个 `run:` 块 ⇒ **新测试必红**（变异自证） |
| `tsc --noEmit` | exit 0 |
| `vitest` | **≥ 2269**（既有 2269 条一条不删；新增若干） |
| Release 链路 | `release.yml`（`pack_only=true`）run **success** ⇒ 证明「CI 能出包 + 打包后的步骤也能跑」 |
