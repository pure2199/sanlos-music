// ---------------------------------------------------------------------------
// T86：产物的 **Authenticode 签名断言**（打包后主动查一次）
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
// 用法：
//   node tools/fn-check-signature.mjs [--expect signed|none] [--expect-signer "<CN>"]
//                                   [--pfx <路径>] [--pfx-password <口令>]
//                                   <文件或目录...>
//
//   --expect signed   每个产物都必须**有签名**（Status ≠ NotSigned）
//   --expect none     每个产物都必须**没有签名**（Status = NotSigned）
//   --expect-signer   有签名时，签名者主体必须**正好等于**它
//   --pfx             额外要求：产物的签名者 == 这个 .pfx 的主体（防「签错证书」）
//   --pfx-password    .pfx 的口令（不给则读环境变量 WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD）
//
// 退出码：0 = 全部符合预期；1 = **有产物不符合预期**（打包应当失败）。
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { expect: '', expectSigner: '', pfx: '', pfxPassword: '', targets: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--expect') out.expect = argv[++i] ?? ''
    else if (arg === '--expect-signer') out.expectSigner = argv[++i] ?? ''
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
 * 跑一段 PowerShell（`-EncodedCommand`）。
 *
 * ⚠️ **为什么用 `-EncodedCommand`**：`-Command "<脚本>"` 的参数会被
 *    Windows 命令行 + PowerShell **二次解析** ⇒ 脚本里的引号会被吃掉
 *    （实测：`$ErrorActionPreference='Stop'` 变成「把 `Stop` 当命令执行」）。
 *    `-EncodedCommand` 收 **base64(UTF-16LE)** ⇒ 零引号问题。
 */
function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  )
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
 */
export function probeSignature(filePath) {
  const script = [
    '$ProgressPreference="SilentlyContinue"',
    '$ErrorActionPreference="Stop"',
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(filePath)}'))`,
    '$s=Get-AuthenticodeSignature -LiteralPath $p',
    '$signer=""',
    '$thumb=""',
    'if ($s.SignerCertificate) { $signer=[string]$s.SignerCertificate.Subject; $thumb=[string]$s.SignerCertificate.Thumbprint }',
    '$signerB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($signer))',
    '[ordered]@{ status=[string]$s.Status; signerB64=$signerB64; thumbprint=$thumb } | ConvertTo-Json -Compress',
  ].join('\n')
  const out = parseLastJson(runPowerShell(script))
  return {
    status: typeof out.status === 'string' ? out.status : 'UnknownError',
    signer: fromB64(out.signerB64) || null,
    thumbprint: typeof out.thumbprint === 'string' ? out.thumbprint : '',
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

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(
    '用法：node tools/fn-check-signature.mjs [--expect signed|none] [--expect-signer "<CN>"]\n' +
      '                                   [--pfx <路径>] [--pfx-password <口令>] <文件或目录...>',
  )
  process.exit(0)
}

if (args.targets.length === 0) {
  console.error('[sign] 没有要检查的目标')
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
    info = { status: 'UnknownError', signer: null, thumbprint: '' }
    problems.push(`${basename(file)} —— 探测失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
  rows.push({ file, ...info })

  if (args.expect === 'signed' && info.status === 'NotSigned') {
    problems.push(`${basename(file)} —— **没有签名**（要求必须有）`)
  }
  if (args.expect === 'none' && info.status !== 'NotSigned') {
    problems.push(`${basename(file)} —— **有签名**（要求必须没有）：${info.signer ?? ''}`)
  }
  if (args.expectSigner && info.status !== 'NotSigned' && info.signer !== args.expectSigner) {
    problems.push(
      `${basename(file)} —— 签名者不符（预期 ${args.expectSigner}，实际 ${info.signer ?? '(无)'}）`,
    )
  }
  if (pfxSubject && info.status !== 'NotSigned' && info.signer !== pfxSubject) {
    problems.push(
      `${basename(file)} —— 签名者不是我们指定的那张证书（.pfx 是 ${pfxSubject}，产物是 ${info.signer ?? '(无)'}）`,
    )
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('')
for (const row of rows) {
  console.log(`[sign]   ${basename(row.file)}`)
  console.log(`[sign]     Status   = ${row.status}`)
  console.log(`[sign]     Signer   = ${row.signer ?? '(无)'}`)
  if (row.thumbprint) console.log(`[sign]     指纹     = ${row.thumbprint}`)
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
