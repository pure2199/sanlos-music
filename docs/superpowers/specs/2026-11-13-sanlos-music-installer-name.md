# 规格：安装包文件名改成与软件名一致（T89-㉔）

> 状态：**已实现**（2026-11-13）
> 关联任务：T89-㉔（清理残留 + 安装包改名）
> 上游：T87（发版工作流）、T89-⑳/㉑/㉒（v0.2.9 发版链）

---

## 1. 诉求（用户原话）

> 「安裝包名字能改成和軟件名一樣嗎」

软件名 = `Sanlos Music`（`package.json` 的 `productName`，也是开始菜单 / 应用列表 /
窗口标题 / 卸载项里显示的名字）。

现状：对外分发的两个文件叫 `FN-Music-Setup-<版本>.exe` / `FN-Music-Portable-<版本>.exe`
⇒ **装到机器上叫「Sanlos Music」，下载下来的文件却叫「FN-Music」** ⇒ 对不上。

**目标**：

| 角色 | 旧名 | 新名 |
|---|---|---|
| 安装包（NSIS） | `FN-Music-Setup-0.2.9.exe` | `Sanlos Music-Setup-0.2.9.exe` |
| 便携版 | `FN-Music-Portable-0.2.9.exe` | `Sanlos Music-Portable-0.2.9.exe` |

**名字形式**：用户选定「**与软件名逐字一致（含空格）**」。
代价：命令行里要加引号（`gh attestation verify "Sanlos Music-Setup-0.2.9.exe"`）⇒
文档与工作流里**一律带引号**写。

---

## 2. 单一真相源：不要再写死名字

⚠️ **旧做法的问题**：`FN-Music-Setup-` 这个前缀在仓库里**被抄了 6 遍**
（打包配置 / 清单脚本 / 发版工作流 6 处 / SignPath 配置 / mock 服务器 / 测试断言），
外加 5 份文档 ⇒ **改一次要改十几处，漏一处就发出去一个名字不一致的包**。

**新做法**：名字从 `package.json` 的 `productName` **派生**，一处定义、处处引用。

| 位置 | 改法 |
|---|---|
| `electron-builder.yml` | `artifactName: ${productName}-Setup-${version}.${ext}`（**electron-builder 官方宏**） |
| `scripts/publish-manifest.mjs` | 读 `package.json` 的 `productName` ⇒ 拼出清单里的 `name` / `url` |
| `.github/workflows/release.yml` | 「改名归一」步骤从 `package.json` 读 `productName` 算规范名 |
| `.signpath/…/default.xml` | glob 改成 `Sanlos Music-Setup-*.exe`（SignPath 的配置**没法读 package.json**，只能写字面量） |

**宏展开实测**（不靠文档，靠本仓库锁定的 electron-builder 版本）：

```
sanitizeFileName("Sanlos Music") = "Sanlos Music"        ← 空格保留
expandMacro("${productName}-Setup-${version}.${ext}")
  = "Sanlos Music-Setup-0.2.9.exe"                        ✅
```

⚠️ **实测时踩到的两个坑**（都写进了 `release/verify/t89-24-check-macro.mjs`）：
① `expandMacro(pattern, arch, appInfo, extra, isProductNameSanitized)` —— **第三参**才是 appInfo；
② `${productName}` 走的是 **`appInfo.sanitizedProductName`**（不是字面 productName）
⇒ **必须实测**，不能假设它等于 productName。

---

## 3. 生效范围：为什么「只改配置」不够

用户选定：**现在就把线上 v0.2.9 的资产换成新名**。

⚠️ **不能只把文件改名再传上去** —— 那会**毁掉信任链**：

- 现有 attestation 的 **subject 里带文件名**
  （实测：必须遍历整个 `subject` 数组，按「digest **且** 文件名」同时匹配）；
- `gh attestation verify` **只接受文件路径**，**没有 `--digest`**（查过官方手册：
  它只有 `--digest-alg`，即摘要算法，不是摘要值）
  ⇒ 文件名一改，**按新名验证必然失败**；
- 而**伪造**一个 attestation（对下载来的旧文件重新签发）= 谎称「这个文件是 CI 构建的」
  ⇒ **绝对不做**。

⇒ **唯一诚实的路**：**用新名重新构建一次，并让 CI 对新名重新签发 attestation**。

---

## 4. 怎么重建：工作流里加一步「改名归一」

⚠️ **关键约束**：`workflow_dispatch` 跑的**工作流 YAML 来自你选的分支**，
但 `actions/checkout` 把**标签的源码**签出到工作区 ⇒
**跑的所有脚本都是标签里的那份**（`pack.cjs` / `publish-manifest.mjs` 都是旧名字的版本）。

⇒ 于是工作流里加一步（**排在「写清单」之后、「签发 attestation」之前**）：

```
Normalize asset names
  ① 规范名 = package.json 的 productName + "-Setup-" / "-Portable-" + version
  ② 若产物还是旧名（FN-Music-*）或宏没展开（${productName}-*）⇒ 改名成规范名
  ③ latest.json 里的 name / url 同步改名（**sha512 与 size 不变** —— 字节没变，只是文件名）
  ④ 把规范名写进 GITHUB_OUTPUT，给后面的「写说明」「发 Release」用
```

**为什么这个顺序**：

| 步骤 | 为什么在这个位置 |
|---|---|
| 在「写清单」**之后** | 标签里的 `publish-manifest.mjs` 认的是**旧名** ⇒ 必须在它跑完（产出 `latest.json`）之后再改名 |
| 在「签发 attestation」**之前** | attestation 的 subject 是**文件名** ⇒ 必须在改名之后签，否则 subject 还是旧名 |
| 在「写说明 / 发 Release」**之前** | 这两步要用规范名算 sha256、上传资产 |

**对未来的标签是 no-op**：新标签的 `electron-builder.yml` 直接产出新名 ⇒ 改名步骤
发现「已经是规范名」⇒ 跳过；`latest.json` 里也没有旧名 ⇒ 无需替换。
⇒ **同一份工作流对新旧标签都成立**。

---

## 5. 影响面清单（逐个文件）

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `electron-builder.yml` | 两个 `artifactName` → `${productName}-…` |
| 2 | `scripts/publish-manifest.mjs` | 清单里的文件名从 `package.json` 的 productName 派生（不再写死前缀） |
| 3 | `.github/workflows/release.yml` | 新增「改名归一」步骤；4 处写死的资产名改用步骤输出；attestation 提示语加引号 |
| 4 | `.signpath/artifact-configurations/default.xml` | 两个 `<pe-file path>` 的 glob + 注释 |
| 5 | `mock-server/server.ts` | `MOCK_UPDATE_INSTALLER_NAME` |
| 6 | `test/t87-ci-release-workflow.test.ts` | **4 条断言**（工作流 2 条 + SignPath 2 条）改成新名；另加 1 条「改名归一步骤必须在签发 attestation 之前」 |
| 7 | `README.md` / `CODE_SIGNING_POLICY.md` / `docs/packaging.md` / `docs/signing.md` / `docs/changelog.md` | 下载说明、产物表、示例清单 |
| 8 | `docs/releases/v0.2.9.md` | 正文里那句 `gh attestation verify`（发布页正文会重新用这份文档拼） |

⚠️ **历史文档一律不改**：`docs/releases/v0.2.0–v0.2.8.md`、`docs/calibration.md`、
`docs/superpowers/specs|plans/` 里记的都是**当时真实发布的名字** ⇒ 改了就成假陈述。

---

## 6. 验收点

| # | 项 | 通过标准 |
|---|---|---|
| 1 | `tsc --noEmit` | exit 0 |
| 2 | `vitest run` | **全绿**，且**既有断言一条没删**（改写的 4 条是「资产名变了」这个前提被显式推翻 ⇒ 改写成对新名字的断言，强度不减） |
| 3 | 宏展开 | `expandMacro` 实测 = `Sanlos Music-Setup-0.2.9.exe` |
| 4 | 线上资产 | v0.2.9 Release 上**只剩 3 个资产**，文件名全是新名 |
| 5 | attestation | 每个新资产都有 attestation，subject 的 **digest 与文件名同时**对得上，`gitCommit` = `3d03b00…` |
| 6 | 清单 | `latest.json` 的 `name` / `url` = 新名，`sha512` = 本地重算值，`size` = API 值 |
| 7 | 发布说明 | 正文里的 sha256 表 = API `digest`；`gh attestation verify "Sanlos Music-Setup-0.2.9.exe" …` 这条命令**文件名与实际资产一致** |
| 8 | 本机 | 重装后 `D:\Sanlos Music\Sanlos Music.exe` 的版本 = 0.2.9，且安装包哈希 = 线上资产哈希 |

---

## 7. 风险与取舍（如实）

| 风险 | 说明 | 处置 |
|---|---|---|
| **v0.2.9 的字节会变** | NSIS 内嵌构建时间戳 ⇒ 重新构建的字节必然不同 ⇒ **已发布过的 sha256 表作废**，改为新构建的值 | CI 自动重新生成 sha256 表（表 = 本次构建的真实值） |
| **已经下载过 v0.2.9 的用户** | 手上的旧文件哈希与新表对不上 | 如实写进发布说明的校验小节；本机同步重装到新资产 |
| **带空格的文件名** | 命令行要加引号；URL 要 `%20` | 客户端用 `new URL(text, manifestUrl)` ⇒ **自动编码**；`sanitizeFileName` 允许空格 ⇒ 落盘名与清单名一致（已查代码确认） |
| **旧的 `FN-Music-*` 名字会消失** | 老的直链（若有）会 404 | 公开资产一直只有这几个，没有对外承诺过旧直链 |
| **SignPath 路径** | 申请已被拒 ⇒ 签名路径本来就跑不通 | 顺带把 SignPath 的 glob 改成新名，将来真拿到证书时不会签错文件 |
