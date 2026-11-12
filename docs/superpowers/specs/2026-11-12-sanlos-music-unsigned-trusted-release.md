# T87.17 —— 无证书可信发布（用 GitHub attestation 替代代码签名证书）

> 日期：2026-11-12
> 分支：`feature/fnmusic-desktop`
> 状态：规格（先于实现提交）

---

## 1. 背景：为什么有这一节

SignPath Foundation 的免费签名申请 **2026-11-12 被拒**。拒审原因不是代码质量，
而是**可见度**：同一生态里 4 个独立项目同因被拒（WinSight 2026-07-29
「visibility decision, not a judgment of software quality」、Rivulet 2026-10
「insufficient stars/downloads」、SteamWrapper 2026-10-05、
usage-monitor-for-claude「insufficient public visibility signals」）。

本仓库 star = 0 / fork = 0 / 仓库 2026-11-05 才建 ⇒ **重报大概率再拒**。

用户明确表示：**不再申请**，要求把发布与更新链路在**没有公开可信证书**的前提下走通。

### 1.1 合法边界（本任务的红线）

「绕过证书」只允许落在**诚实披露**的路线上：

| 允许 | 禁止 |
|---|---|
| 诚实未签名发布（显式声明未签名 + 可验证的信任锚） | 伪造签名 / 伪造证书 |
| 自签证书仅用于**本机 / 内部**把链路跑通 | 冒用他人证书或他人主体名 |
| 让「产物到底签没签」在 CI / 文档 / 客户端里**一致** | 文档或 Release 页面声称「已签名」而实际未签 |

**公开可信的 Authenticode 签名无法绕过**：拿到微软信任的签名必须由 CA 签发，
需要付款 + 法律主体身份核验 ⇒ 这一步只能本人做，不能代签、代付、伪造。

---

## 2. 现状盘点（2026-11-12 实测，不是推测）

| 能力 | 状态 | 证据 |
|---|---|---|
| CI 未签名发布路径 | **已就绪** | `.github/workflows/release.yml` 有 `sign` 输入；`sign=false` 走 `Verify unsigned artifacts`（`--expect none`）→ 清单 → 发 Release。v0.2.5 就是这么发的（run `43004372370` success） |
| 客户端「允许安装未签名的更新包」 | **已就绪** | T82 加开关、T85 修好判定口径、T87 修签名者匹配；判定收在 `shared/update.ts` 的 `evaluateSignatureGate()` |
| 更新源可达 | **已实测** | `curl -sIL .../releases/latest/download/latest.json` → 302 → 302 → **200 / 466 B** |
| SHA-512 / 同源 / 路径穿越硬闸 | **已就绪** | `electron/update.ts`（`resolveFileUrl` / `sanitizeFileName` / `sha512File`） |
| 三条零成本 SmartScreen 绕法 | **已写进文档** | README「快速开始 → 下载安装」：解除锁定 / `Unblock-File` / 点「仍要运行」 |
| **发布者身份的可验证性** | ❌ **没有** | 公开产物只有 sha256，而 sha256 与 exe 在**同一个 Release 页面** ⇒ 「发布者身份」这一层是空的 |
| **文档里「签名在途」的说法** | ❌ **已过时且不实** | `docs/changelog.md` 写「申请已于 2026-11-11 提交、审核中 ⇒ v0.2.6 起会带签名」⇒ 申请已被拒 ⇒ 这是假陈述 |
| **`docs/packaging.md` §7.9 的 Certum 结论** | ❌ **已被证伪** | 该处写「Certum 开源计划要 GitHub star > 1k ⇒ 本项目 star=0 够不着」⇒ 实测 Certum 的「Open Source Code Signing in the Cloud」是 **€49 的付费产品**（`shop.certum.eu` schema.org `price: 49.00 EUR` / sku `bd_005` / InStock），**不要求 star** |

### 2.1 一个新实测：下载落盘不带 Mark-of-the-Web

本机实测（`release/verify/motw-probe/`）：

```
Get-Item -LiteralPath latest.json -Stream *
  Stream  Length
  :$DATA    466          ← 只有数据流，没有 Zone.Identifier
```

⇒ **命令行下载写出的文件不带 `Zone.Identifier`（MotW）** ⇒ SmartScreen 的蓝框
（触发条件之一就是 MotW）**不会**因此出现。

⚠️ 推论边界：这说明「**应用内一键更新**下载的包」也不带 MotW（走的是
`fetch` + Node `fs` 写盘，与 curl 同一条路，**不是**浏览器的下载管理器）⇒
**从应用内更新安装不会弹蓝框**；而**从 Release 页面用浏览器下载**会带 MotW ⇒
仍需「解除锁定」。这条推论要用真实 Electron 跑一次才算实证（T87.18）。

---

## 3. 目标

在没有公开可信代码签名证书的前提下，让公开产物具备**可验证的发布者身份**，
并把「这一版没签名」在 CI / 文档 / 客户端里**诚实且一致**地表达出来。

**不做**：不伪造签名、不冒用他人证书、不放宽客户端既有安全闸、不在本任务里发版。

---

## 4. 设计

### 4.1 CI：attestation = 替代信任锚

用 GitHub 官方的 **artifact attestation**（SLSA build provenance，Sigstore 公共实例签发）
补上「发布者身份」这一层：

- **签发方**：GitHub（用 OIDC 换 Sigstore 短期证书）⇒ 证明「这个文件确实是
  **本仓库的 CI** 从**这个 tag** 构建出来的」，而不是任何人随便放上去的。
- **绑定**：attestation 绑定的是 **subject（文件 + digest）** ⇒ 换成别的字节就验不过。
- **可用性**：**公开仓库全部计划免费**（Bronze/Silver/Gold 旧计划除外）⇒ 本仓库
  `visibility: public` ✅（2026-11-12 查 GitHub API：`"private": false`）。
- **版本**：`actions/attest-build-provenance` v4 起**只是 `actions/attest` 的包装器**
  ⇒ 新实现直接用 `actions/attest@v4`。

**工作流改动**（`.github/workflows/release.yml`）：

1. job `permissions` 增加 `id-token: write` 与 `attestations: write`
   （`id-token` 用于换 Sigstore 证书，`attestations` 用于落库）。
2. 新增步骤 **「Attest build provenance」**：
   - `if: ${{ !inputs.pack_only }}` ⇒ 两条路径（签名 / 未签名）**都**签发；
   - `subject-path: 'release-ci/*.exe, release-ci/latest.json'` ⇒ 覆盖
     **两个 exe + 更新清单**（清单也是公开资产，也该可验证）；
   - ⚠️ **必须排在产物定版之后**：
     - 签名路径 ⇒ 排在 `Replace artifacts with signed ones` 之后（签名改字节）；
     - 未签名路径 ⇒ 排在 `Verify unsigned artifacts` 之后；
     - 且必须排在 `Write update manifest (...)` **之后**（`latest.json` 得先存在）。
   - ⇒ 统一放在**两个清单步骤之后**、发 Release 之前。
3. 把 attestation 的 `attestation-url` / `attestation-id` 写进 **Step Summary** 与
   **Release 说明** ⇒ 用户知道去哪验。

**既有断言一条不删、一条不削弱**：签名路径仍 `Valid` + 时间戳 + CN；未签名路径仍 `--expect none`。

### 4.2 客户端：不改安全边界，只把「怎么验」讲清楚

- **默认 `allowUnsigned` 仍为关**（未签名包默认拒绝安装）——这是既定纪律，本任务不放宽。
- 下载完成后若判定为未签名，提示文案**从「没签名」升级为「没签名 + 你可以这样验」**
  （sha256 比对 / attestation 验证命令）。
- 设置页补一段说明：**这一版没签名时，怎么确认下载到的是官方产物**。

### 4.3 文档：把过时的陈述改成事实

| 文件 | 改什么 |
|---|---|
| `docs/changelog.md` | 「签名申请审核中 / v0.2.6 起带签名」⇒ **申请已被拒**；新增 T87.17 条目与「无证书期」的正式说明 |
| `README.md` | 下载节加「**本版未签名**」+ 两种验证方式（sha256 / attestation）+ 三条绕 SmartScreen 的办法 |
| `docs/packaging.md` | §7.9 更正 Certum 结论（**不要求 star**，是 €49 付费产品）；新增 §7.10「无证书期怎么发版（attestation 路线）」 |
| `docs/signing.md` | 顶部加「**当前状态：未签名**」；说明 attestation 路线 |
| `CODE_SIGNING_POLICY.md` | 保留（未来申请 SignPath 仍要用），加一行当前状态注记 |
| `docs/calibration.md` | 追加 T87.17 校准记录（该文件是 CRLF ⇒ 改时必须按 `/\r?\n/` 切分再 `join(eol)`） |

---

## 5. 影响文件清单

| 文件 | 改动 |
|---|---|
| `.github/workflows/release.yml` | 加 permissions、加 attestation 步骤、Summary 与 Release 说明带验证入口 |
| `src/components/SettingsPanel.tsx` | 未签名提示文案 + 「怎么验证」说明块 |
| `test/t87-ci-release-workflow.test.ts` | **追加** T87.17 契约测试（不改既有断言） |
| `docs/changelog.md` | 更正「签名在途」+ 新增条目（CRLF） |
| `docs/calibration.md` | 追加 T87.17 记录（CRLF） |
| `docs/packaging.md` | §7.9 更正 + 新增 §7.10 |
| `docs/signing.md` | 当前状态 + attestation 路线 |
| `CODE_SIGNING_POLICY.md` | 当前状态注记 |
| `README.md` | 下载节补「未签名 + 怎么验」 |

**不引新 npm 依赖**；不新增 npm 依赖的验证工具（attestation 用 GitHub 官方 Action +
`gh attestation verify`，本仓库**不自己实现** Sigstore 验签器）。

---

## 6. 验收点

1. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` ⇒ **0 错**。
2. `node node_modules/vitest/vitest.mjs run` ⇒ **全绿**，既有 2293 条一条不删、一条不削弱。
3. **新增契约测试**（`test/t87-ci-release-workflow.test.ts` 的 T87.17 段）至少钉住：
   - `permissions` 里有 `id-token: write` 与 `attestations: write`；
   - 用的是**官方 Action** 且**钉版本**（`actions/attest@v4`，不许 `@main`）；
   - `subject-path` 覆盖**两个 exe + `latest.json`**；
   - **attestation 步骤排在清单生成之后、发 Release 之前**；
   - 变异自证：把 subject 改成不含 exe ⇒ 必被抓出来。
4. 工作流 `run:` 块里**不许出现反引号**（既有守卫继续生效）。
5. 写完每个文件跑 `release/verify/fnm-bytes-check.mjs` ⇒ **bad = 0**（无 U+FFFD / 无 BOM / 行尾正确）。
6. `git status` 干净；两次提交（规格先行 + 实现）。

---

## 7. 遗留 / 待后续任务

| 项 | 归属 |
|---|---|
| 发 v0.2.6 并端到端验证（attestation 真跑出来 + 一键更新真装上 + 应用内下载的包无 MotW 的真实 Electron 实证） | **T87.18**（需 bump 版本 + 打 tag + 发版 ⇒ 外部可见动作 ⇒ 单独确认） |
| README 的 `### Code signing policy` 展示位（SignPath 审核硬要求）+ `.github/CODEOWNERS`（三角色） | T87.7-b（等仓库有起色再复议 SignPath 时做） |
| 开 GitHub 2FA / 改已泄露的 GitHub 口令 / 轮换 NAS 口令 | 用户侧 |

---

## 8. 参考

- GitHub artifact attestations（公开仓库免费）：
  <https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds>
- `actions/attest@v4`（v4 起是官方统一入口，支持 provenance / SBOM / custom 三种模式）：
  <https://github.com/actions/attest>
- 验证命令：`gh attestation verify <file> --repo pure2199/sanlos-music`
- SignPath 拒审口径（可见度）：见 §1
