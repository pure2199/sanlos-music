# 代码签名（SignPath Foundation）

> ⚠️ **本文档讲的是「公开产物」的签名**。
> 本地开发用的**自签**证书是另一回事（见 [packaging.md](./packaging.md) 第七节）——
> **自签产物绝不发到公开 Release**。

**一句话**：本项目曾向 **[SignPath Foundation](https://signpath.org)** 申请**免费**的
公开 OV（Organization Validation）代码签名证书，**2026-11-12 申请被拒**
（原因是**可见度不足**，不是代码质量）⇒ **公开安装包当前仍然没有签名**。

⚠️ **「发布者身份」改由构建来源证明承担**：GitHub 官方的 **artifact attestation**
（SLSA build provenance，由 Sigstore 签发）证明每个产物确实是**本仓库的 CI** 从对应标签
构建出来的 ⇒ 用户可用 `gh attestation verify` 独立验证。
详见 [packaging.md](./packaging.md) 第 7.10 节。

⚠️ **未签名对用户意味着什么**：Windows 会提示「未知发布者」/ SmartScreen 蓝框
⇒ 按 [README「三、快速开始」的绕法](../README.md#三快速开始)处理（解除锁定 / `Unblock-File`）；
**开启了 Smart App Control 的 Windows 11 是硬拦**（没有「仍要运行」按钮）
⇒ 那类机器装不了未签名版本。

---

## 一、签名是怎么来的

```
git tag v0.2.5
   │
   ▼
GitHub Actions（.github/workflows/release.yml，手动触发）
   │  checkout(v0.2.5) → npm ci → typecheck / test / build → node scripts/pack.cjs
   │  ⇒ 产物（此时**还没签名**）
   ▼
upload-artifact（unsigned-artifacts）
   │
   ▼
SignPath 官方 Action 提交签名请求
   │  · 私钥在 **SignPath 的 HSM** 里，全程不落地
   │  · CI 只持有一个 **Submitter** 权限的 API token（提不了权、不能自己签）
   │  · ⏸ **人工审批**：在 SignPath 平台上点一次「批准」（Foundation 计划要求逐次审批）
   ▼
取回签名件 → 校验（Valid + 有 RFC 3161 时间戳 + CN 匹配）
   │
   ▼
生成 latest.json（基于**签名后**的安装包算 SHA-512）→ 发 GitHub Release
```

⚠️ **为什么必须搬进 CI**：SignPath 免费计划以「**可信构建**」为前提 —— 只签
**CI 从本仓库构建出的**产物 ⇒ **本机手工打包的包签不了**（也不是不想签，是签不了）。

---

## 二、用户怎么验证「这个包确实签了」

在 PowerShell 里：

```powershell
Get-AuthenticodeSignature .\FN-Music-Setup-0.2.5.exe |
  Format-List Status, SignerCertificate, TimeStamperCertificate
```

应该看到：

| 字段 | 期望值 | 含义 |
|---|---|---|
| `Status` | `Valid` | 签名**有效**（证书在有效期内、文件未被篡改、链能被 Windows 认可） |
| `SignerCertificate.Subject` | `CN=SignPath Foundation, …` | 签发者（Windows 上显示的「发布者」） |
| `TimeStamperCertificate` | 非空 | **RFC 3161 时间戳**存在 ⇒ 证书到期后签名依然有效 |

也可以图形化查看：右键 exe → **属性** → **数字签名**。

### ⚠️ 实话：签名 ≠ 一定不弹窗

- **SmartScreen 的「Windows 已保护你的电脑」提示，第一版照样会弹。**
  微软判的是**文件哈希的信誉**，不是「有没有签名」⇒ 新证书的信誉要从零开始积累
  （通常需要数周、数百次真实下载）。
- **签名真正解决的是两件事**：① 不再显示「**未知发布者**」这种无名提示；
  ② **开启 Smart App Control 的 Windows 11 不会再直接拦截**（未签名程序会被
  `WinError 4551` 拦掉）。
- **唯一能彻底免掉 SmartScreen 提示的渠道是 Microsoft Store**（由微软证书重签）——
  本项目把它作为**并行的第二渠道**规划（T88），与 SignPath 路线并存。

---

## 三、维护者：怎么申请 + 怎么配（**申请已被拒；下面是复议或换路线时要做的事**）

### 3.1 提交申请（**2026-11-11 提交，2026-11-12 被拒**：可见度不足）

1. 打开 <https://signpath.org/apply>；
2. 需要准备：仓库地址（https://github.com/pure2199/sanlos-music ）、许可证（MIT）、
   项目描述、维护者身份信息；
3. ⚠️ **两个账号都要开 MFA**：GitHub 账号与 SignPath 账号（Foundation 硬性要求）——
   ⇒ **GitHub 账号的 MFA 必须开**（这是审核的**阻塞项**，不是可选项）；
4. ⚠️ 本项目是**单维护者**，author / reviewer / approver 三个角色由同一人担任
   （政策见仓库根目录的 [`CODE_SIGNING_POLICY.md`](../CODE_SIGNING_POLICY.md)）——
   Foundation 接受这种安排（有先例）。

**当前状态**：申请表 13 个字段已填 + 2 项必选法律同意，**2026-11-11 由维护者本人提交**
（页面回执 `Form submitted`）⇒ **等审核**。
⚠️ **最弱的一项是「可验证声誉」**（0 star / 0 fork / ~73 下载 / 仓库 2026-11-05 才建）
⇒ **存在被拒风险**；被拒则走 §六 的退路。

### 3.2 SignPath 后台的配置

| 项目 | 值 | 说明 |
|---|---|---|
| Trusted Build System | `GitHub.com` | 绑定到本仓库（SignPath GitHub App） |
| Project | slug 随意（如 `sanlos-music`） | |
| Artifact Configuration | 导入 [`.signpath/artifact-configurations/default.xml`](../.signpath/artifact-configurations/default.xml) | 声明「签哪个文件、怎么签」 |
| Signing Policy | 如 `release-signing` | 绑定证书、限定 GitHub 托管 Runner 与版本标签、**要求人工批准** |
| API Token | CI 用户（角色仅 `Submitter`） | 只用来**提交**请求，**不能批准、不能自己签** |

### 3.3 GitHub 侧的 5 项配置

在 **Settings → Secrets and variables → Actions** 里：

| 类型 | 名称 | 值 |
|---|---|---|
| **Secret** | `SIGNPATH_API_TOKEN` | SignPath CI 用户的 API token |
| **Variable** | `SIGNPATH_ORG_ID` | 组织 ID |
| **Variable** | `SIGNPATH_PROJECT_SLUG` | 项目 slug |
| **Variable** | `SIGNPATH_POLICY_SLUG` | 签名策略 slug |
| **Variable** | `SIGNPATH_ARTIFACT_SLUG` | artifact configuration slug |
| （可选 **Variable**） | `SIGNPATH_EXPECTED_CN` | 期望的签名者 CN，默认 `SignPath Foundation` |

⚠️ 后 4 项在 **Variables** 里就够（它们不是机密）；但工作流**同时**读 secrets，
所以放在 secrets 里也能用（`vars.X || secrets.X`）。

⚠️ **没配全 ⇒ 工作流会「快速失败」并逐项列出缺哪个**
（`scripts/check-signpath-config.mjs`）⇒ **绝不会**「跳过签名照样发布」。

### 3.4 发版（**签名版**）

1. 打标签：`git tag v0.2.6 && git push origin v0.2.6`；
2. GitHub Actions → **Release** → **Run workflow**：
   - `tag` = `v0.2.6`
   - `pack_only` = **false**（关掉才会送签 + 发版）
   - `sign` = **true**（默认；签名路径）
3. ⏸ **去 SignPath 平台点一次「批准」**（最多等 90 分钟）；
4. 工作流自动：校验签名 → 生成 `latest.json` → 建/更新 GitHub Release（3 个资产：
   安装包、便携版、`latest.json`）；
5. ⚠️ **发布说明**取自 `docs/releases/v<版本>.md` ⇒ 发版前要先把那个文件写好；
   工作流会**自动给它附上**该版本的字节数与 sha256。

> 💡 `pack_only` = **true** 时只跑「构建 + 打包 + 上传 artifact」，
> **不送签、不发版** ⇒ 用来验证「CI 能出包」而**不需要** SignPath 账号。

### 3.5 发**未签名**版（`sign` = false）—— **当前发版走的就是这条**

**签名申请已被拒**（2026-11-12）⇒ 当前发版**一律走这条**（不依赖任何证书）：

1. `tag` = 目标版本、`pack_only` = **false**、**`sign` = false**；
2. 工作流会先**断言产物确实没有签名**（`--expect none`）
   ⇒ 「这一版没签名」是**构建期事实**，不是口头承诺；
   （产物若因为任何原因带上了签名 ⇒ **工作流失败，绝不发布**）；
3. 生成 `latest.json` → 发 Release（同样 3 个资产），说明末尾自动附字节数与 sha256。

⚠️ **两条路径互不干扰**：`sign` 默认 **true** ⇒ 签名路径的闸门一条都没松。
⚠️ **未签名版的固有代价**：SmartScreen 照旧会拦（可绕）、**Smart App Control 硬拦**（绕不过）、
企业 AppLocker / WDAC 可能直接拒 ⇒ 详见 README「三、快速开始」。

---

## 四、常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 工作流报「SignPath 配置不完整」 | 5 项配置缺了 | 按 §3.3 逐项补齐（报错会列出缺哪几个） |
| 签名请求被拒（SignPath 侧） | artifact configuration 与实际产物对不上 | 确认待签 ZIP 顶层是那两个 exe（artifact configuration 的根元素是 `zip-file`） |
| 签名请求一直不批 | 忘了去 SignPath 平台点批准 | 去平台批准；超过 90 分钟工作流会失败（artifact 保留着可重跑） |
| `签名状态不是 Valid` | 证书还没生效 / 产物被改过 / 链不被认可 | 看 SignPath 侧状态；本地可用 `Get-AuthenticodeSignature` 复核 |
| `没有 RFC 3161 时间戳` | 签名没带时间戳 | 失败是**故意的**：没有时间戳 ⇒ 证书到期后历史包集体失效 |
| `签名者 CN 不符` | 期望的 CN 与实际不符 | 改 `SIGNPATH_EXPECTED_CN`（客户端设置页里的「预期的代码签名者」也要同步改） |

---

## 五、本地开发用的自签证书（**别拿来发版**）

`tools/fn-make-selfsigned-cert.mjs` 能生成一张本地自签代码签名证书，用来把
「打包 → 断言 → 客户端校验」这条链路在本机跑通。

⚠️ **自签证书不受信任** ⇒ 对外发布时 Windows 仍提示「未知发布者 / 不受信任的证书」
⇒ **自签产物只用于本地/内部，绝不发到公开 Release**（T86 决策不变）。

---

## 六、退路（如果 Foundation 拒审）

本项目的签名代码**不绑定 SignPath**：换证书来源只需要改「期望的 CN 候选值」。

| 方案 | 成本 | 签发者（CN） |
|---|---|---|
| **SignPath Foundation**（当前路线） | 免费 | `SignPath Foundation` |
| **Certum 开源线**（Open Source Code Signing in the Cloud） | **€49**（商品页 schema.org 标价；社区另有 €69 起 / 中国区 €329/年 / **GitHub ≥1k star 可免**的说法，**需向 Certum 官方核实**） | **公司法定主体名**（待向官方确认） |
| Certum Standard Code Signing in the Cloud | €209/年 | **公司法定主体名**（如「广西闪链时空网络科技有限公司」） |

⚠️ **Certum 开源线相对 SignPath 的差别**：证书签给我们**自己**的主体 ⇒ Windows 上显示的是
**公司名**（不是「SignPath Foundation」）、**没有逐版人工审批**；代价是**要付费**。

采购清单见 [packaging.md](./packaging.md) 第 7.8 节。

---

## 七、相关文件

| 文件 | 作用 |
|---|---|
| [`CODE_SIGNING_POLICY.md`](../CODE_SIGNING_POLICY.md) | 交给 SignPath 审核的**代码签名政策**（英文） |
| [`.signpath/artifact-configurations/default.xml`](../.signpath/artifact-configurations/default.xml) | 告诉 SignPath「签哪个文件、怎么签」 |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | 发版工作流（打包 → 送签 → 审批 → 校验 → 发布） |
| `scripts/check-signpath-config.mjs` | 配置**快速失败**检查 |
| `tools/fn-check-signature.mjs` | 签名**断言**（Valid / 时间戳 / CN） |
| `shared/update.ts` | 客户端与工具**共用**的签名者匹配口径 |
