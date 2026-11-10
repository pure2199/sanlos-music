# T87.11：发**未签名**的 v0.2.5（把「已签名」的承诺改成实话 + 加 Mark-of-the-Web 绕过说明）

> 日期：2026-11-11
> 承接：T87（公开产物签名链路）、T87.7-a（SignPath Foundation 申请已于 2026-11-11 提交）
> 状态：**用户已拍板**（① 发未签名 v0.2.5，并把签名承诺改成实话 + 加 MotW 绕过说明；② SignPath 线**保留**，批下来在 v0.2.6 启用）

---

## 一、为什么改主意（触发条件）

SignPath Foundation 的申请在 **2026-11-11 已提交成功**（页面回执 `Form submitted`），
但**批不批、何时批不由我们决定**，于是发版被**外部审核**卡住。

而审核口径里我们**最弱的一项是「可验证声誉」**：

| 事实 | 数值 |
|---|---|
| GitHub star / fork / watcher | **0 / 0 / 0** |
| Releases 下载量 | ~73 |
| 仓库创建时间 | 2026-11-05 |

⇒ **存在被拒风险**，且「等多久」完全不可控。

同时要认清一件事：**产物至今本来就未签名**（v0.2.4 就是未签名发的），
且自动更新链路**早就内置了「允许安装未签名的更新包」开关**（v0.2.4 起）
⇒ **签名从来没有卡住过我们的功能**。

⇒ **发版不必等签名。**

---

## 二、目标与非目标

### 2.1 目标

1. **v0.2.5 未签名发布**（产物由 CI 构建 —— 发版搬进 CI 这件事 T87 已就绪）；
2. 公开文档里**所有「已签名」的表述改成实话**（README / `docs/changelog.md` / `docs/signing.md` / `CODE_SIGNING_POLICY.md`）；
3. 给用户一条**零成本**绕开 SmartScreen 蓝框的办法（**解除锁定** / `Unblock-File`）；
4. **SignPath 线保留且随时可启用**（v0.2.6 一填 5 个 secrets 即生效）。

### 2.2 非目标（本轮明确不做）

- ❌ **不放弃 SignPath**：工程一行不动，申请不撤，政策文档不删；
- ❌ **不宣称「已签名」**——一条假陈述都不留；
- ❌ **不承诺 SmartScreen 蓝框彻底消失**（信誉是独立于签名的一层）；
- ❌ **不承诺 Smart App Control 用户不受影响**（那是硬拦，只能等签名上线）；
- ❌ **不动客户端的签名校验逻辑**（`shared/update.ts` / `electron/update.ts` 一字不改）。

---

## 三、2026-11-11 查证到的事实（附来源）

| 事实 | 来源 |
|---|---|
| **SmartScreen 只检查带 Mark of the Web（`Zone.Identifier`）的文件** ⇒ 移除该标记即不再触发 | bugnet.io（SmartScreen 触发条件：MotW + 未签名/无信誉） |
| 右键属性勾「解除锁定」/ `Unblock-File` ⇒ **蓝框立即消失** | errornotes.dev（MotW 与三种解除办法）、rottenwifi.com（`Unblock-File` 移除 `Zone.Identifier`） |
| **Smart App Control 没有逐应用白名单、没有「仍要运行」按钮**；只在 **Windows 11 干净安装**上出现；三态 On / Evaluation / Off | venture-lab.org、trendsmask.com、gadgethacks.com |
| SAC 的 On↔Off 在 **2026-04 累积更新（KB5083769）后**才可逆（之前关掉≈永久） | gadgethacks.com（并注明「部分 Microsoft Learn 文档仍写着要重装，是旧文档」） |
| 未签名包**同样会积累信誉**（用户点「仍要运行」就是信誉信号），但**文件名/哈希一变就清零** | AiPC `docs/SIGNING.md`（GitHub）、exegenerator.com、nhimg.org（GlobalSign 口径：签名有效 ≠ 立即可信） |
| 向 Microsoft 提交文件审阅**免费**，可消 Defender 误报并加速信誉积累 | microsoft.com/wdsi/filesubmission（AiPC 文档引述） |
| **本项目 NSIS 构建非字节级可复现**：本地重建 0.2.4 得 `c2111893…` / 86,106,756 字节，发布版是 `f49d026e…` / 86,106,122 字节 ⇒ **哈希只能逐版本给，且必须发布后回填** | 本地实测（2026-11-11）；`docs/packaging.md` §一 已写明「NSIS 内嵌构建时间戳」 |

---

## 四、工作流改动（`.github/workflows/release.yml`）

### 4.1 新增输入 `sign`（boolean，**默认 `true`**）

| `pack_only` | `sign` | 行为 |
|---|---|---|
| `true` | 任意 | **只打包**：构建 → 打包 → 上传 artifact → 写 Summary（**不发版、不送签**） |
| `false` | `true` | **签名发布**（原 T87 路线）：查配置 → 送签 → 人工审批 → 校验（Valid + 时间戳 + CN）→ 替换 → 生成清单 → 发 Release |
| `false` | `false` | **未签名发布**（本轮新增）：断言产物**确实没有签名** → 生成清单 → 发 Release |

⚠️ **默认 `sign=true`** —— 签名是默认路径，未签名必须**显式**关掉（fail-closed 方向）。

### 4.2 未签名发布也必须过一道**机械断言**

`node tools/fn-check-signature.mjs --expect none release-ci`

⇒ 「我们声明这一版未签名」不是**口头承诺**，而是**构建期事实**：
产物若因为任何原因带上了签名（本地装了证书、环境里有 `WIN_CSC_LINK`……）⇒ **工作流失败，不发布**。

（`--expect none` 是既有选项，语义 = 「每个产物都必须**没有**签名（Status = NotSigned）」，**一字未改**。）

### 4.3 清单生成必须从「替换签名件」那一步里**拆出来**

现在 `publish-manifest.mjs` 写在 `Replace artifacts with signed ones and write update manifest` 步骤里
⇒ 未签名路径会**跳过**它 ⇒ `latest.json` 不会生成 ⇒ Release 缺资产。

⇒ 拆成两个**各自独立**的步骤（顺序：替换签名件 **在先**，生成清单 **在后**）：

| 步骤 | 条件 | `UPDATE_NOTES` |
|---|---|---|
| `Write update manifest (signed)` | `!pack_only && sign` | 「安装包已由 SignPath Foundation 签名（Authenticode，含 RFC 3161 时间戳）。」 |
| `Write update manifest (unsigned)` | `!pack_only && !sign` | 「本版**未做代码签名**（Windows 可能提示『未知发布者』）；详见 Release 说明。」 |

⚠️ 两个步骤的 notes **必须分开写**，不能用 `&&` / `||` 塞进同一个 env
—— 否则「未签名路径也写着已签名」这种回归**测不出来**。

### 4.4 Release 说明里**自动附上 sha256 与字节数**

本机**没有 `gh`** ⇒ 本地无法编辑 Release 页面 ⇒ 校验值必须由**工作流自己**算：

- 「Prepare release notes with checksums」步骤：对两个 exe 算 `Get-FileHash -Algorithm SHA256` + 文件长度，
  追加一节「下载校验（sha256）」到 `docs/releases/<tag>.md` 的副本（写到 `$RUNNER_TEMP`），再交给 `gh release create --notes-file`；
- ⇒ **Release 页面自带校验值**（用户真正会去看的地方）。

⚠️ **不许新增第 4 个资产**（`SHA256SUMS.txt`）—— 既有契约是**只发 3 个资产**（`latest.yml` / `*.blockmap`
是基于未签名 exe 算的，已失效）。校验值进**说明文字**，不进资产清单。

---

## 五、文档改动清单

| 文件 | 改什么 | 为什么 |
|---|---|---|
| `package.json` | `version` → `0.2.5` | 发版 |
| `README.md` | 顶部版本指针、下载表、**签名承诺段改成实话** + 加 MotW 绕过、FAQ「未知发布者」条目 | 公开文档里的假陈述 |
| `docs/changelog.md` | 顶部版本号 → 0.2.5；「未发布 T87」段 → 「0.2.5」段并改实话 | 同上 |
| `docs/signing.md` | 开头「一句话」改实话；申请状态；发版流程补 `sign` 输入；退路补 Certum 开源线 | 同上 |
| `CODE_SIGNING_POLICY.md` | 第 77–79 行的「MFA **已启用**」改成**承诺式**表述 | 交给审核的文档不能有假陈述 |
| `docs/releases/v0.2.5.md` | **新建**：发布说明（未签名 + MotW + 校验值位置） | 工作流的 `--notes-file` 源 |
| `.github/workflows/release.yml` | §4 的全部改动 | 发布未签名版 |
| `test/t87-ci-release-workflow.test.ts` | **追加**断言（既有断言一条不改、一条不删） | 新路径必须有守卫 |

---

## 六、校验值（sha256）的两段式

**为什么不能「先填哈希再打标签」**：NSIS 内嵌构建时间戳 ⇒ **CI 构建的字节必然与本地不同**
⇒ 标签里的哈希若来自本地/上一次构建，就是**错数据**。

⇒ **先发布、再回填**：

| 位置 | 什么时候有校验值 |
|---|---|
| **Release 页面** | 发布时由工作流**自动附上**（§4.4）⇒ 用户看得到 |
| **分支 HEAD 的 `README.md` / `docs/releases/v0.2.5.md`** | 发布后本地回填（下载公开资产 → 算 sha256 → 提交） |
| **标签 `v0.2.5` 里那一份** | ⚠️ **没有**（打标签时产物还不存在）⇒ README 与发布说明里必须**写明这一点**，不许留空让人误以为是漏了 |

---

## 七、验收点

1. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` ⇒ 0 错；
2. `node node_modules/vitest/vitest.mjs run` ⇒ 全绿，**既有断言一条没删、一条没削弱**，
   且**新增**断言覆盖：① `sign` 输入存在 ② 未签名路径跑 `--expect none`
   ③ `publish-manifest` 排在「替换签名件」**之后** ④ 未签名路径的 `UPDATE_NOTES` **不含**「已签名」类措辞
   ⑤ **变异自证**（把未签名路径的 notes 改成声称已签名 ⇒ 必被抓出）；
3. `npm run e2e:only` ⇒ 34 条全绿；
4. **文档一致性**：全仓库检索「从 v0.2.5 起签发 / 已签名」类表述 ⇒ **零残留假陈述**；
5. **发布跑通**：Release 页面 3 个资产 + 说明里带 sha256 + 字节数；
6. **回下载比对**：`sha512(下载到的 exe)` **等于** `latest.json` 里记录的 `sha512`（客户端更新时核对的就是它）
   ⇒ 证明「发布的字节」与「清单里承诺的字节」是同一份；
7. `release/verify/fnm-bytes-check.mjs` ⇒ BOM / U+FFFD / NUL / 裸 CR 全 0。

---

## 八、风险与回退

| 风险 | 处理 |
|---|---|
| SignPath 拒审 / 迟迟不批 | **不影响** v0.2.5 发布；转 **Certum 开源线**（€49，证书签给我们主体、发布者显示公司名、无需人工审批）或商业 OV |
| SAC 用户被硬拦 | v0.2.5 **无法**解决（只能等签名）；README 里**如实标注** |
| 企业 AppLocker / WDAC 策略拒未签名 exe | 同上 |
| 「未签名」被误当成「不负责任」 | 文档如实写清楚**为什么**（审核在途、成本为零、绕法给出），不粉饰 |

⚠️ **代码不绑定 SignPath**：换证书来源只需要改「预期的 CN 候选值」
（`SIGNPATH_EXPECTED_CN` + 客户端「预期的代码签名者」）⇒ **退路成本很低**。
