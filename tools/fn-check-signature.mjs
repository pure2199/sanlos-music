// ---------------------------------------------------------------------------
// T86 / T87：产物的 **Authenticode 签名断言**（打包后主动查一次）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这个**：electron-builder 在签名环节**失败时可能只警告、不失败**
//    ⇒ 「打包成功」**不等于**「签名成功」。
//    ⇒ 打包后**主动**读一次产物的签名状态，把「签没签、签的是谁」摆到构建输出里
//    ⇒ 以后「签名没通过」是**构建期事实**，不是玄学。
//
// ⚠️ **口径**：只看 `Get-AuthenticodeSignature` 的 `Status` 与 `SignerCertificate.Subject`；
//    **不判信任链**（与客户端一致 —— 信任链由 Windows 自己判断）。
//
// ---------------------------------------------------------------------------
// T87 加严的三件事
// ---------------------------------------------------------------------------
// ① `--expect valid`
//    —— 签名状态必须是 **`Valid`**。
//    ⚠️ `--expect signed` 只查「状态不是 NotSigned」⇒ `HashMismatch` / `Expired`
//       / `NotTrusted` / `UnknownError` 全都会**放过去** ⇒ 当发布闸门**不够严**。
// ② `--require-timestamp`
//    —— 必须带 **RFC 3161 时间戳**（`TimeStamperCertificate` 非空）。
//    ⚠️ 没有时间戳 ⇒ 证书到期那天，**历史上所有安装包一起失效**（用户装不上了）。
// ③ `--expect-cn "<名字>"`
//    —— 按 **CN 相等**匹配签名者（可逗号分隔多个候选）。
//    ⚠️ **绝不做「包含」匹配** —— `CN=SignPath Foundation Evil` 骗不过去。
//
// ---------------------------------------------------------------------------
// T87.11-b：CI 上的两个坑
// ---------------------------------------------------------------------------
// ① **PowerShell 5.1 加载不了安全模块**（CI 专属，本机复现不出来）
//    —— GitHub 的 Windows runner **默认 shell 是 pwsh 7** ⇒ runner 把
//       `PSModulePath` 指向 **PS7 的模块目录**；我们自起的 `powershell.exe`
//       （5.1）继承它 ⇒ 5.1 的自动加载先找到**同名但为 .NET Core 编译**的那份
//       ⇒ 加载失败 ⇒ `Get-AuthenticodeSignature` 整个不可用
//       （实测：Release run 42901166145 死在这，3 个产物全部「探测失败」）。
//    ⇒ 双保险：`powershellEnv()` **前置** 5.1 的系统模块目录
//      + 脚本内按 **`$PSHOME` 绝对路径**显式 `Import-Module`。
//
// ② **探测失败 ≠ 「有签名」**
//    —— 探测不出来时状态是**未知**，不是「不是 NotSigned」
//       ⇒ 绝不能拿它判「有签名」（那会把「探不出来」说成「被签了名」）。
//    ⇒ 打 `probeFailed` 标记；判定层单独报「探测失败」并**跳过**其余判定。
//    ⚠️ **闸门仍然失败**（fail-closed 不变）—— 改的只是**措辞**与**判定对象**。
//
// ⚠️ **为什么 CN 口径必须复用客户端那套**（T87 的核心纪律）：
//    「同一套判定各写一遍」= 两边语义漂移 = **静默失效**
//    （客户端放行、构建期误拒，或反过来）。
//    ⇒ 这里用 **esbuild**（本仓库**已有的直接依赖**）把 `shared/update.ts`
//      在运行时打成一份可执行模块来调用 ⇒ **单一事实来源**，不复制逻辑。
//
// 用法：
//   node tools/fn-check-signature.mjs [--expect signed|none|valid] [--expect-signer "<Subject>"]
//                                   [--expect-cn "<CN>"] [--require-timestamp]
//                                   [--pfx <路径>] [--pfx-password <口令>]
//                                   <文件或目录...>
//
//   --expect signed   每个产物都必须**有签名**（Status ≠ NotSigned）
//   --expect none     每个产物都必须**没有签名**（Status = NotSigned）
//   --expect valid    每个产物的签名状态都必须是 **Valid**（T87 加严）
//   --expect-signer   有签名时，签名者主体必须**正好等于**它（**整串**相等；旧语义不变）
//   --expect-cn       有签名时，Subject 里的 **CN** 必须与它**相等**（可逗号分隔多个候选）
//   --require-timestamp
//                     每个产物都必须带 **RFC 3161 时间戳**
//   --pfx             额外要求：产物的签名者 == 这个 .pfx 的主体（防「签错证书」）
//   --pfx-password    .pfx 的口令（不给则读环境变量 WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD）
//
// 退出码：0 = 全部符合预期；1 = **有产物不符合预期**（打包应当失败）。
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** 仓库根目录（本文件在 `tools/` 下）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 共享签名逻辑（**单一事实来源**）
// ---------------------------------------------------------------------------

/** 缓存起来的 `shared/update.ts` 导出（懒加载）。 */
let sharedSigning = null

/**
 * 载入 `shared/update.ts` 的导出（客户端与本工具**共用同一份**）。
 *
 * ⚠️ **为什么用 esbuild 现打现用**（而不是把逻辑复制一份到本文件）：
 *    「同一套判定两边各写一遍」⇒ 语义漂移 ⇒ **静默失效**（T85/T87 的共同教训）。
 *    ⇒ `shared/update.ts` 是**唯一**的实现；本文件只负责**调用**它。
 *
 * ⚠️ **为什么懒加载**：本工具的「有/无签名」判定**不依赖**它
 *    ⇒ 不该因为「拿不到 esbuild」就让 `--expect signed` 这条老路也挂掉。
 */
export function getSharedSigning() {
  if (sharedSigning) return sharedSigning
  const tsPath = join(REPO_ROOT, 'shared', 'update.ts')
  if (!existsSync(tsPath)) {
    throw new Error(`找不到共享签名逻辑：${tsPath}（仓库不完整？）`)
  }
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch (cause) {
    throw new Error(
      `加载 esbuild 失败（要用 --expect-cn 就必须能编译 shared/update.ts）：${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
  const result = esbuild.buildSync({
    entryPoints: [tsPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild 没有产出代码（shared/update.ts 编译失败？）')
  const mod = { exports: {} }
  const factory = new Function('exports', 'module', 'require', '__filename', '__dirname', output.text)
  factory(mod.exports, mod, require, tsPath, dirname(tsPath))
  sharedSigning = mod.exports
  return sharedSigning
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 解析命令行参数。 */
export function parseArgs(argv) {
  const out = {
    expect: null,
    // ⚠️ `null` = **没给这个选项**；`''` = **给了但是空的**。
    //    这两者必须区分：给了空的 ⇒ **判定失败**（不许因为空值就静默跳过检查）。
    expectSigner: null,
    expectCn: null,
    requireTimestamp: false,
    pfx: '',
    pfxPassword: '',
    targets: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--expect') out.expect = argv[++i] ?? ''
    else if (arg === '--expect-signer') out.expectSigner = argv[++i] ?? ''
    else if (arg === '--expect-cn') out.expectCn = argv[++i] ?? ''
    else if (arg === '--require-timestamp') out.requireTimestamp = true
    else if (arg === '--pfx') out.pfx = argv[++i] ?? ''
    else if (arg === '--pfx-password') out.pfxPassword = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') out.help = true
    else out.targets.push(arg)
  }
  return out
}

/** base64（UTF-8）——用来把中文安全地塞进 PowerShell 命令行。 */
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

/**
 * 给 PowerShell 子进程用的环境变量。
 *
 * ⚠️ **为什么要动 `PSModulePath`**（T87.11-b）：
 *    GitHub 的 Windows runner **默认 shell 是 pwsh 7（PowerShell 7）**
 *    ⇒ runner 把 `PSModulePath` 指向 **PS7 的模块目录**；
 *    而我们自起的 `powershell.exe`（= Windows PowerShell **5.1**）**继承**这个变量
 *    ⇒ 5.1 的模块自动加载会先找到 **PS7 那份同名模块**
 *    （为 .NET Core 编译的**二进制**模块）⇒ **5.1 加载不了**
 *    ⇒ `Get-AuthenticodeSignature` **整个不可用**
 *    （`CouldNotAutoloadMatchingModule`）⇒ 每个产物都「探测失败」
 *    （实测：Release run `42901166145` 死在这一步，Release 没建出来）。
 *    ⇒ 修法：把 **5.1 自己的**系统模块目录**前置**到 `PSModulePath`
 *    ⇒ 5.1 先找到自己那份 ⇒ 自动加载直接成功。
 *
 * ⚠️ **前置而不是替换**：别的路径（用户模块、PS7 的模块…）可能还有用
 *    ⇒ 只把 5.1 的系统目录**加到最前面**，其余**原样保留**。
 *
 * ⚠️ **本机复现不出来**：开发机只有 PS 5.1、`PSModulePath` 正常
 *    ⇒ 「本地绿、CI 红」的典型形态 ⇒ 这条必须靠**源码结构断言**钉住。
 *
 * @param env 基础环境（默认当前进程的环境）。
 * @returns 传给子进程的环境。
 */
export function powershellEnv(env = process.env) {
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows'
  const sysModules = join(systemRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules')
  const out = { ...env }
  if (existsSync(sysModules)) {
    const current = out.PSModulePath || ''
    out.PSModulePath = current ? `${sysModules};${current}` : sysModules
  }
  return out
}

/**
 * 把 PowerShell 的失败整理成**一句人能看懂的话**。
 *
 * ⚠️ **为什么不用 `execFileSync` 自带的报错**：它把**整条命令行**
 *    （含那段几百字符的 base64 脚本）也塞进 `message`
 *    ⇒ 日志里全是 Base64，**真正的错误被埋在中间**。
 *
 * @param cause `execFileSync` 抛出的错误。
 * @returns 一行可读的失败原因。
 */
export function describePowerShellFailure(cause) {
  const status = typeof cause?.status === 'number' ? cause.status : null
  const stderr = String(cause?.stderr ?? '').trim()
  const stdout = String(cause?.stdout ?? '').trim()
  const detail = (stderr || stdout).replace(/\s+/g, ' ').slice(0, 400)
  const head =
    status === null
      ? `PowerShell 被信号 ${String(cause?.signal ?? '未知')} 终止`
      : `PowerShell 退出码 ${status}`
  return `${head}${detail ? `：${detail}` : ''}`
}

/**
 * 跑一段 PowerShell（`-EncodedCommand`）。
 *
 * ⚠️ **为什么用 `-EncodedCommand`**：`-Command "<脚本>"` 的参数会被
 *    Windows 命令行 + PowerShell **二次解析** ⇒ 脚本里的引号会被吃掉
 *    （实测：`$ErrorActionPreference='Stop'` 变成「把 `Stop` 当命令执行」）。
 *    `-EncodedCommand` 收 **base64(UTF-16LE)** ⇒ 零引号问题。
 *
 * ⚠️ **失败时抛的是「整理过」的错**（见 `describePowerShellFailure`）
 *    ⇒ 日志里第一眼看到的是**真原因**，不是一段 Base64。
 */
function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: powershellEnv(),
      },
    )
  } catch (cause) {
    throw new Error(describePowerShellFailure(cause))
  }
}

/** 解析 PowerShell 吐的 JSON（取最后一行 —— 前面可能有 CLIXML 噪音）。 */
function parseLastJson(stdout) {
  const line = String(stdout)
    .trim()
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .pop()
  if (!line) throw new Error('PowerShell 没有输出 JSON')
  return JSON.parse(line)
}

/** 从 base64(UTF-8) 解字符串。 */
function fromB64(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/**
 * 读一个文件的签名信息。
 *
 * ⚠️ 签名者主体走 **base64(UTF-8)**：PowerShell 往管道写 stdout 用的是
 *    **控制台代码页**（简体中文机器 = 936/GBK）⇒ 中文主体名直出会变乱码。
 *
 * ⚠️ `TimeStamperCertificate` 就是 **RFC 3161 时间戳**的签发证书：
 *    它**非空** ⇒ 签名带了时间戳 ⇒ 证书到期后签名依然有效。
 */
export function probeSignature(filePath) {
  const script = [
    '$ProgressPreference="SilentlyContinue"',
    '$ErrorActionPreference="Stop"',
    // ⚠️ **先把安全模块按绝对路径导进来**（T87.11-b）：
    //    `Get-AuthenticodeSignature` 住在 `Microsoft.PowerShell.Security` 里，
    //    而**模块自动加载**是按 `PSModulePath` 的顺序找的
    //    ⇒ CI 上（runner 默认 shell 是 pwsh 7）会找到**同名但为 .NET Core 编译**的那份
    //    ⇒ 5.1 加载不了 ⇒ cmdlet 整个不可用（`CouldNotAutoloadMatchingModule`）。
    //    ⇒ 直接从 **当前 edition 自己的** `$PSHOME` 导入 ⇒ 绕开搜索顺序。
    //    ⚠️ 导不进来**不判失败**：退回自动加载，让真正的错误自己冒出来。
    '$sec = Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
    'try { if (Test-Path -LiteralPath $sec) { Import-Module -Name $sec -ErrorAction Stop } } catch { }',
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(filePath)}'))`,
    '$s=Get-AuthenticodeSignature -LiteralPath $p',
    '$signer=""',
    '$thumb=""',
    '$hasTs=$false',
    '$tsSubject=""',
    'if ($s.SignerCertificate) { $signer=[string]$s.SignerCertificate.Subject; $thumb=[string]$s.SignerCertificate.Thumbprint }',
    'if ($s.TimeStamperCertificate) { $hasTs=$true; $tsSubject=[string]$s.TimeStamperCertificate.Subject }',
    '$signerB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($signer))',
    '$tsB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tsSubject))',
    '[ordered]@{ status=[string]$s.Status; signerB64=$signerB64; thumbprint=$thumb; hasTimestamp=$hasTs; timeStamperB64=$tsB64 } | ConvertTo-Json -Compress',
  ].join('\n')
  const out = parseLastJson(runPowerShell(script))
  return {
    status: typeof out.status === 'string' ? out.status : 'UnknownError',
    signer: fromB64(out.signerB64) || null,
    thumbprint: typeof out.thumbprint === 'string' ? out.thumbprint : '',
    hasTimestamp: out.hasTimestamp === true,
    timeStamper: fromB64(out.timeStamperB64) || null,
    probeFailed: false,
  }
}

/** 读一个 .pfx 的主体名（用来核对「签的是不是我们以为的那张证书」）。 */
export function probePfxSubject(pfxPath, password) {
  const script = [
    '$ProgressPreference="SilentlyContinue"',
    '$ErrorActionPreference="Stop"',
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(pfxPath)}'))`,
    `$pw=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(password)}'))`,
    '$secure=ConvertTo-SecureString -String $pw -Force -AsPlainText',
    '$c=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($p,$secure,"Export")',
    '$subjectB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$c.Subject))',
    '[ordered]@{ subjectB64=$subjectB64; thumbprint=$c.Thumbprint } | ConvertTo-Json -Compress',
  ].join('\n')
  const out = parseLastJson(runPowerShell(script))
  return { subject: fromB64(out.subjectB64), thumbprint: typeof out.thumbprint === 'string' ? out.thumbprint : '' }
}

// ---------------------------------------------------------------------------
// 判定（**纯函数** —— 可被单测直接调用）
// ---------------------------------------------------------------------------

/**
 * 判定一个产物的签名是否符合预期，返回**问题列表**（空数组 = 通过）。
 *
 * ⚠️ **这里是唯一的判定处**（CLI 与单测共用）⇒ 不会出现「CLI 判一套、
 *    测试判另一套」。
 *
 * @param info 探测结果（`probeSignature` 的返回）。
 * @param options 判定条件。
 * @returns 问题描述数组（每条都**不含**文件名 —— 由调用方补上）。
 */
export function evaluateSignature(info, options = {}) {
  const {
    expect = null,
    expectSigner = null,
    expectCn = null,
    requireTimestamp = false,
    pfxSubject = '',
  } = options

  const problems = []
  const status = info.status
  const signer = info.signer ?? null

  // ⚠️ **探测失败 ≠ 「有签名」**（T87.11-b）：
  //    探不出来时，签名状态是**未知**（不是「不是 NotSigned」）
  //    ⇒ **不能拿它当「有签名」的证据**。
  //    ⇒ 单独报「探测失败」，并**跳过**其余按状态的判定
  //      （状态未知，判了也是瞎判 —— 尤其不能拿 `UnknownError` 去判「有签名」）。
  //    ⚠️ **闸门仍然失败**：这条本身就是一个问题 ⇒ 依旧 fail-closed
  //      （实测：Release run 42901166145 曾把「探测失败」说成「**有签名**」，
  //        方向完全说反 ⇒ 白查半天「是不是被谁签了名」）。
  if (info && info.probeFailed === true) {
    problems.push('**探测失败**（无法判定签名状态）')
    return problems
  }

  // ① 「有没有签名」—— T86 的老语义，**一字不变**。
  if (expect === 'signed' && info.status === 'NotSigned') {
    problems.push('**没有签名**（要求必须有）')
  }
  if (expect === 'none' && info.status !== 'NotSigned') {
    problems.push(`**有签名**（要求必须没有）：${signer ?? ''}`)
  }

  // ② T87：签名状态必须**是** `Valid`（比「不是 NotSigned」严得多）。
  if (expect === 'valid' && status !== 'Valid') {
    problems.push(`签名状态不是 **Valid**（实际 ${status}）`)
  }

  // ③ T86 的老语义：**整串**相等（用户粘了整个 Subject 时用）。
  if (expectSigner !== null && info.status !== 'NotSigned' && signer !== expectSigner) {
    problems.push(`签名者不符（预期 ${expectSigner}，实际 ${signer ?? '(无)'}）`)
  }

  // ④ T87：按 **CN 相等**匹配（口径来自 `shared/update.ts`，客户端同一份）。
  if (expectCn !== null) {
    if (info.status === 'NotSigned') {
      problems.push('**没有签名**（无法核对签名者 CN）')
    } else {
      const { parseSignerCandidates, matchesExpectedSigner } = getSharedSigning()
      const candidates = parseSignerCandidates(expectCn)
      if (candidates.length === 0) {
        problems.push(`--expect-cn 没有解析出任何候选：${expectCn}`)
      } else if (!matchesExpectedSigner(signer ?? '', expectCn)) {
        problems.push(`签名者 CN 不符（预期 ${candidates.join(' / ')}，实际 ${signer ?? '(无)'}）`)
      }
    }
  }

  // ⑤ T87：必须带 RFC 3161 时间戳（否则证书到期后历史包集体失效）。
  if (requireTimestamp && info.hasTimestamp !== true) {
    problems.push('**没有 RFC 3161 时间戳**（证书到期后历史安装包会集体失效）')
  }

  // ⑥ T86 的老语义：核对「签的是不是我们指定的那张 .pfx」。
  if (pfxSubject && info.status !== 'NotSigned' && signer !== pfxSubject) {
    problems.push(
      `签名者不是我们指定的那张证书（.pfx 是 ${pfxSubject}，产物是 ${signer ?? '(无)'}）`,
    )
  }

  return problems
}

// ---------------------------------------------------------------------------
// 收集要检查的文件
// ---------------------------------------------------------------------------

/** 收集目标：文件直接收；目录收顶层 `*.exe` + `win-unpacked/*.exe`。 */
function collectFiles(targets) {
  const files = []
  for (const target of targets) {
    const abs = resolve(target)
    if (!existsSync(abs)) continue
    if (statSync(abs).isFile()) {
      files.push(abs)
      continue
    }
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      if (statSync(p).isFile() && name.toLowerCase().endsWith('.exe')) files.push(p)
    }
    const unpacked = join(abs, 'win-unpacked')
    if (existsSync(unpacked) && statSync(unpacked).isDirectory()) {
      for (const name of readdirSync(unpacked)) {
        const p = join(unpacked, name)
        if (statSync(p).isFile() && name.toLowerCase().endsWith('.exe')) files.push(p)
      }
    }
  }
  return [...new Set(files)]
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 本文件被**直接当脚本跑**时为真（被测试 import 时为假 ⇒ 不会自己跑一遍）。 */
function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const a = resolve(entry)
    const b = resolve(fileURLToPath(import.meta.url))
    // ⚠️ Windows 上路径**大小写不敏感** ⇒ 比较前统一转小写。
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

/** CLI 主流程。 */
export function main(argv) {
  const args = parseArgs(argv)

  if (args.help) {
    console.log(
      '用法：node tools/fn-check-signature.mjs [--expect signed|none|valid] [--expect-signer "<Subject>"]\n' +
        '                                   [--expect-cn "<CN>"] [--require-timestamp]\n' +
        '                                   [--pfx <路径>] [--pfx-password <口令>] <文件或目录...>',
    )
    process.exit(0)
  }

  if (args.targets.length === 0) {
    console.error('[sign] 没有要检查的目标')
    process.exit(1)
  }

  // ⚠️ **fail-closed**：`--expect` 的值必须是已知的三个之一。
  //    拼错（`valeid`）或给空 ⇒ **一道检查都不跑** ⇒ 工具「通过」⇒ **危险**。
  if (args.expect !== null && !['signed', 'none', 'valid'].includes(args.expect)) {
    console.error(`[sign] 未知的 --expect 值：${args.expect}（只能是 signed / none / valid）`)
    process.exit(1)
  }

  const files = collectFiles(args.targets)
  if (files.length === 0) {
    console.error(`[sign] 目标里没找到任何 .exe：${args.targets.join(', ')}`)
    process.exit(1)
  }

  console.log(`[sign] 检查 ${files.length} 个产物的 Authenticode 签名…`)

  // ⚠️ 跨进程的 pfx 主体核对（防「签错证书」）。
  let pfxSubject = ''
  if (args.pfx && existsSync(args.pfx)) {
    const password = args.pfxPassword || process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD || ''
    try {
      pfxSubject = probePfxSubject(resolve(args.pfx), password).subject
    } catch (cause) {
      console.error(`[sign] ✗ 读 .pfx 失败：${cause instanceof Error ? cause.message : String(cause)}`)
      process.exit(1)
    }
  }

  const problems = []
  const rows = []

  for (const file of files) {
    let info
    try {
      info = probeSignature(file)
    } catch (cause) {
      // ⚠️ **打上 `probeFailed` 标记**（T87.11-b）：
      //    「探不出来」**不等于**「有签名」⇒ 必须让判定层知道这是**未知**，不是**否**。
      info = {
        status: 'UnknownError',
        signer: null,
        thumbprint: '',
        hasTimestamp: false,
        timeStamper: null,
        probeFailed: true,
      }
      problems.push(`${basename(file)} —— 探测失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    rows.push({ file, ...info })

    const reasons = evaluateSignature(info, {
      expect: args.expect,
      expectSigner: args.expectSigner,
      expectCn: args.expectCn,
      requireTimestamp: args.requireTimestamp,
      pfxSubject,
    })
    for (const reason of reasons) {
      problems.push(`${basename(file)} —— ${reason}`)
    }
  }

  // -------------------------------------------------------------------------
  // 输出
  // -------------------------------------------------------------------------

  console.log('')
  for (const row of rows) {
    console.log(`[sign]   ${basename(row.file)}`)
    console.log(`[sign]     Status   = ${row.probeFailed ? '**探测失败**' : row.status}`)
    console.log(`[sign]     Signer   = ${row.signer ?? '(无)'}`)
    if (row.thumbprint) console.log(`[sign]     指纹     = ${row.thumbprint}`)
    console.log(`[sign]     时间戳   = ${row.hasTimestamp ? '有' : '**无**'}`)
    if (row.timeStamper) console.log(`[sign]     时间戳签发者 = ${row.timeStamper}`)
  }
  if (pfxSubject) console.log(`[sign]   指定证书 = ${pfxSubject}`)
  console.log('')

  if (problems.length > 0) {
    console.error(`[sign] ✗ ${problems.length} 个产物不符合预期：`)
    for (const problem of problems) console.error(`[sign]   - ${problem}`)
    process.exit(1)
  }

  console.log(`[sign] ✓ ${files.length} 个产物全部符合预期`)
  process.exit(0)
}

if (isMainModule()) {
  main(process.argv.slice(2))
}
