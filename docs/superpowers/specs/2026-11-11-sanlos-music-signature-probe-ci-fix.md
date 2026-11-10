# T87.11-b：签名探测在 CI 上**加载不了 PowerShell 安全模块** ⇒ 未签名发布被闸门拦下

> 日期：2026-11-11
> 承接：T87.11（发未签名 v0.2.5）
> 事件：Release run **`42901166145`**（`#6`）在 **`Verify unsigned artifacts`** 这一步**失败**（exit code 1）
> 状态：**规格已定**，待实现

---

## 一、事件

T87.11 的未签名发布流水线在 GitHub Actions 里跑到第 16 步就挂了：

| 步骤 | 结论 |
|---|---|
| 1–9（Checkout / Node / 依赖 / 类型检查 / 单测 / 构建 / 打包 / 上传产物） | ✅ 全部成功 |
| 10–15（pack_only 摘要 / SignPath 四步） | ⏭️ 按条件跳过（本次 `sign=false`） |
| **16 `Verify unsigned artifacts`** | ❌ **failure（exit code 1）** |
| 17–19（清单 / 发布说明 / 发 Release） | ⏭️ 被前置失败连带跳过 |

⇒ **Release 没有建出来**，v0.2.5 **仍未发布**。

---

## 二、现象（日志原文）

```
[sign] 检查 3 个产物的 Authenticode 签名…
#< CLIXML
<Objs Version="1.1.0.1" ...>
  <S S="Error">Get-AuthenticodeSignature : The 'Get-AuthenticodeSignature' command was found in the module
  'Microsoft.PowerShell.Security', but the module could not be loaded. For more information, run
  'Import-Module Microsoft.PowerShell.Security'.</S>
  <S S="Error">FullyQualifiedErrorId : CouldNotAutoloadMatchingModule</S>
</Objs>
[sign]   FN-Music-Portable-0.2.5.exe
[sign]     Status   = UnknownError
[sign]     Signer   = (无)
[sign]   - FN-Music-Portable-0.2.5.exe —— **有签名**（要求必须没有）：
```

⇒ **两个问题叠在一起**：

1. **探测本身失败**：3 个产物（`FN-Music-Setup-0.2.5.exe` / `FN-Music-Portable-0.2.5.exe` /
   `win-unpacked/Sanlos Music.exe`）**一个都没探到**，`Status` 全是 `UnknownError`；
2. **报错口径说反了**：工具把「探测失败」降级成 `UnknownError` 状态，
   而 `--expect none` 的判定是「状态 ≠ `NotSigned` ⇒ 算『有签名』」
   ⇒ **「探不出来」被说成「有签名」** —— 方向完全反了。

⚠️ 第 2 条是**独立的缺陷**：即使这次模块加载问题不存在，
只要探测失败，输出就会误导人去查「是不是被谁签了名」。

---

## 三、根因

GitHub 的 Windows runner **默认 shell 是 pwsh 7（PowerShell 7）**，runner 会把
`PSModulePath` 指向 **PS7 的模块目录**。

而本工具是自己 spawn `powershell.exe`（= **Windows PowerShell 5.1**）去跑
`Get-AuthenticodeSignature` 的 —— **它继承了那个 `PSModulePath`**：

- 5.1 的模块自动加载按 `PSModulePath` 的顺序找 `Microsoft.PowerShell.Security`；
- 找到的是 **PS7 那份同名模块**（为 .NET Core 编译的**二进制**模块）；
- 5.1 的 AppDomain **加载不了它** ⇒ `CouldNotAutoloadMatchingModule`；
- ⇒ `Get-AuthenticodeSignature` **整个不可用** ⇒ 每个产物都「探测失败」。

⚠️ **本机复现不出来**：开发机只有 PS 5.1、`PSModulePath` 正常 ⇒
**「本地绿、CI 红」的典型形态**（已实测：人为把 `PSModulePath` 污染成
「同名但加载不了」的模块目录，本机仍能正常探测 ⇒ 本地不是同一条路径）。

---

## 四、修法（三条，缺一不可）

| # | 改哪 | 做什么 | 为什么 |
|---|---|---|---|
| **A** | `tools/fn-check-signature.mjs` → `runPowerShell` | 给子进程的 `PSModulePath` **前置** Windows PowerShell 5.1 自己的系统模块目录（`%SystemRoot%\system32\WindowsPowerShell\v1.0\Modules`） | 让 5.1 **先找到自己那份**模块 ⇒ 自动加载直接成功 |
| **B** | 同上 → `probeSignature` 的脚本 | 脚本开头**按 `$PSHOME` 的绝对路径**显式 `Import-Module` `Microsoft.PowerShell.Security.psd1`（失败则退回自动加载） | **绕开 `PSModulePath` 的搜索顺序** ⇒ 即使 A 被谁改掉也还能用 |
| **C** | 同上 → `evaluateSignature` + `main` | 新增 `probeFailed` 标记：**探测失败**单独报，**不再**按状态判「有签名」；其余按状态的判定**跳过**（状态未知，判了是瞎判） | 报错口径不许说反；闸门仍**失败**（fail-closed 不变） |

⚠️ **C 不许弱化闸门**：探测失败**仍然是一个问题** ⇒ 仍然 exit 1 ⇒ 仍然**不许发布**。
改的只是**措辞**（不再谎称「有签名」）与**判定对象**（不再拿未知状态当证据）。

**附带（不属于 A/B/C）**：发布说明生成那步的行尾统一成 LF
（`$nl = [string][char]10`）—— 因为 `docs/releases/*.md` 是 LF，
而 `[Environment]::NewLine` 在 Windows 上是 CRLF ⇒ 拼出来的说明会**混行尾**。
⚠️ 用 `[char]10` 而不是 `` "`n" ``：**工作流 `run:` 块里一律不许有反引号**
（PowerShell 的反引号是转义符 ⇒ 会被当成转义序列起始 ⇒ 整个脚本 ParserError）。

---

## 五、影响文件清单

| 文件 | 改什么 |
|---|---|
| `tools/fn-check-signature.mjs` | A + B + C（含错误信息降噪：不再把整条 base64 命令行塞进报错） |
| `tools/fn-check-signature.d.mts` | `SignatureProbeInfo` 加 `probeFailed?: boolean` |
| `.github/workflows/release.yml` | 发布说明行尾归一（`[char]10`） |
| `test/t87-signing-assertion.test.ts` | 追加断言（结构守卫 + 探测失败语义） |
| `docs/superpowers/specs/2026-11-11-sanlos-music-signature-probe-ci-fix.md` | 本规格 |

⚠️ **既有测试一条不许删、断言一条不许削弱**。

---

## 六、验收点

1. `node tools/fn-check-signature.mjs --expect none release-probe` 在本机**仍然**按老语义工作
   （认得本机自签的 0.2.3 包、放过未签名的包）；
2. 工具源码**必须**含：$PSHOME 绝对路径导入安全模块 + 前置 5.1 系统模块目录；
3. `evaluateSignature({ probeFailed: true, … })` ⇒ 报「探测失败」，**且不出现**「有签名」；
4. `tsc --noEmit` 0 错、`npm test` 全绿、`npm run e2e:only` 全绿；
5. CI 上 `Verify unsigned artifacts` **通过**（这次要靠真正的 CI 跑出来）。

---

## 七、遗留（需要用户确认）

- ⚠️ **修复必须进到 tag 里**：`release.yml` 的 `Checkout` 用的是 `ref: ${{ inputs.tag }}`
  ⇒ 打 tag 之后跑工作流，跑的是**标签里的代码**，分支上的修复**不生效**。
  ⇒ **必须把 `v0.2.5` 这个标签移到修复后的提交**。
  - 该标签于 **2026-11-11 刚推上去**，**还没有任何 Release**、**没有任何下载**
    ⇒ 移动它不会影响任何已发布产物；
  - 但它是**公开可见**的改动 ⇒ **需要用户确认后**再动。
- 标签移动后重跑：`tag=v0.2.5`、`pack_only=false`、`sign=false`。
- 之后再做 T87.11 的收尾：回下载比对 sha512/sha256 → 回填 README / `docs/releases/v0.2.5.md`
  → 台账追加 T87.11 一节。
