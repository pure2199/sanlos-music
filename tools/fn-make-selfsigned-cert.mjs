// ---------------------------------------------------------------------------
// T86：生成**本地自签**代码签名证书（只为把签名链路跑通）
// ---------------------------------------------------------------------------
//
// ⚠️ **先说清楚这是什么、不是什么**：
//
//   这是**自签**证书 ⇒ **没有任何第三方机构背书** ⇒ 对外发布时 Windows 仍会提示
//   「未知发布者 / 不受信任的证书」。它**不能**替代真实 OV/EV 证书。
//
//   它的用途只有一个：**把「签名 → 探测 → 比对签名者 → 放行/拒绝」这条链路
//   在真包上跑通**（此前只跑过 mock），并给 electron-builder 接上**打包后断言**
//   ⇒ 以后「签名没通过」是**构建期事实**，不是玄学。
//
// ⚠️ **私钥绝不入库**：.pfx 与口令都落在 `release/certs/`（**gitignored**）。
//    将来换成真实证书时，私钥必须留在**硬件 token / HSM / 云签名**里
//    （软件 .pfx 已被行业规则禁掉），口令走环境变量或 CI Secret。
//
// 用法：
//   node tools/fn-make-selfsigned-cert.mjs [--trust] [--force] [--cn "<主体名>"]
//
//   --trust   把证书导入**当前用户**的「受信任的根证书颁发机构」
//             （只影响本机，不影响别人；可随时撤销，见输出里的撤销命令）
//   --force   已有证书时重新生成（旧证书不自动删除，会打印出来）
//   --cn      证书主体名（默认 = 公司法定主体名，**与营业执照一致**）
//
// ⚠️ 主体名口径：Windows 上显示的「发布者」= 证书 CN ⇒ 真实证书必须是
//    **公司法定主体名**（不是软件名）⇒ 这里默认用公司名，
//    日后换真实证书**不用改任何配置**、用户填的「预期签名者」也不用改。
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 默认主体名 = 公司法定主体名（与营业执照一致 ⇒ 日后换真证书不用改配置）。 */
const DEFAULT_CN = '广西闪链时空网络科技有限公司'

/** 默认输出目录（在 `release/` 下 ⇒ 整个目录被 gitignore）。 */
const DEFAULT_OUT_DIR = join(REPO, 'release', 'certs')

/** 证书文件名。 */
const PFX_NAME = 'sanlos-code-signing.pfx'
const CER_NAME = 'sanlos-code-signing.cer'
const PWD_NAME = 'pfx-password.txt'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { trust: false, force: false, cn: DEFAULT_CN, outDir: DEFAULT_OUT_DIR }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--trust') out.trust = true
    else if (arg === '--force') out.force = true
    else if (arg === '--cn') out.cn = argv[++i] ?? DEFAULT_CN
    else if (arg === '--out-dir') out.outDir = resolve(argv[++i] ?? DEFAULT_OUT_DIR)
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`不认识的参数：${arg}`)
  }
  return out
}

/** base64（UTF-8）——用来把中文与路径安全地塞进 PowerShell 命令行。 */
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

/**
 * 跑一段 PowerShell（`-EncodedCommand`）。
 *
 * ⚠️ **为什么用 `-EncodedCommand` 而不是 `-Command "<脚本>"`**：
 *    `-Command` 的参数会被 **Windows 命令行 + PowerShell 二次解析**，
 *    脚本里的引号会被吃掉（实测：`$ErrorActionPreference='Stop'` 变成
 *    「把 `Stop` 当命令执行」并报错）。
 *    `-EncodedCommand` 收的是 **base64(UTF-16LE)** ⇒ **零引号问题**。
 */
function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  )
}

/**
 * 从 PowerShell 的 JSON 里取**可能含中文**的字段。
 *
 * ⚠️ PowerShell 往管道写 stdout 用的是**控制台代码页**（简体中文机器 = 936/GBK），
 *    不是 UTF-8 ⇒ 中文直接吐出来会被 Node 解成**乱码**。
 *    ⇒ 脚本里一律把中文字段做 **base64(UTF-8)**，这边再解。
 */
function pickB64(obj, key) {
  const raw = obj[key]
  if (typeof raw !== 'string' || raw === '') return ''
  try {
    return Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log('用法：node tools/fn-make-selfsigned-cert.mjs [--trust] [--force] [--cn "<主体名>"]')
  process.exit(0)
}

mkdirSync(args.outDir, { recursive: true })

const pfxPath = join(args.outDir, PFX_NAME)
const cerPath = join(args.outDir, CER_NAME)
const pwdPath = join(args.outDir, PWD_NAME)

if (existsSync(pfxPath) && !args.force) {
  console.log(`[cert] 已存在，未改动：${pfxPath}`)
  console.log('[cert] 要重新生成请加 --force；要在本机信任它请加 --trust。')
  process.exit(0)
}

// ⚠️ 口令是**随机**的，单独存一个文件（与 .pfx 同目录，也在 gitignore 里）。
//    这只是**本地测试证书**的口令，不是任何真实凭据。
const password = randomBytes(24).toString('base64url')

console.log(`[cert] 主体名（CN）：${args.cn}`)
console.log(`[cert] 输出目录：${args.outDir}`)

const ps = [
  "$ErrorActionPreference='Stop'",
  `$cn=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args.cn)}'))`,
  `$pfxPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(pfxPath)}'))`,
  `$cerPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(cerPath)}'))`,
  `$pwd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(password)}'))`,
  '$secure=ConvertTo-SecureString -String $pwd -Force -AsPlainText',
  // ⚠️ -Type CodeSigningCert ⇒ EKU = 代码签名；-KeyUsage DigitalSignature。
  "$cert=New-SelfSignedCertificate -Type CodeSigningCert -Subject (\"CN=\" + $cn) " +
    '-KeyExportPolicy Exportable -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 3072 ' +
    "-HashAlgorithm SHA256 -CertStoreLocation Cert:\\CurrentUser\\My " +
    "-NotAfter (Get-Date).AddYears(3) -FriendlyName 'Sanlos Music Code Signing (self-signed, local only)'",
  'Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure | Out-Null',
  '$bytes=$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)',
  '[IO.File]::WriteAllBytes($cerPath,$bytes)',
  // ⚠️ 主体名走 base64（stdout 的代码页不是 UTF-8 ⇒ 中文会变乱码）。
  '$subjectB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$cert.Subject))',
  '[ordered]@{ subjectB64=$subjectB64; thumbprint=$cert.Thumbprint; notAfter=$cert.NotAfter.ToString("o") } | ConvertTo-Json -Compress',
].join('\n')

const stdout = runPowerShell(ps)
const info = JSON.parse(String(stdout).trim().split('\n').pop())
const subject = pickB64(info, 'subjectB64')
writeFileSync(pwdPath, `${password}\n`, 'utf8')

console.log('[cert] ✓ 已生成自签代码签名证书')
console.log(`[cert]   Subject   = ${subject}`)
console.log(`[cert]   Thumbprint= ${info.thumbprint}`)
console.log(`[cert]   NotAfter  = ${info.notAfter}`)
console.log(`[cert]   .pfx      = ${pfxPath}`)
console.log(`[cert]   .cer      = ${cerPath}`)
console.log(`[cert]   口令文件  = ${pwdPath}`)

// ---------------------------------------------------------------------------
// 可选：导入**当前用户**的「受信任的根证书颁发机构」
// ---------------------------------------------------------------------------

if (args.trust) {
  // ⚠️ 用 `certutil -f`：不加 `-f` 会弹一个「安全警告」对话框
  //    ⇒ 非交互场景下会**卡死**（这正是要避免的）。
  // ⚠️ `-user` = 只动**当前用户**的存储（不动本机全局）⇒ 不影响别的用户。
  runPowerShell(
    [
      '$ErrorActionPreference=Stop',
      `$cer=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(cerPath)}'))`,
      '& certutil.exe -f -user -addstore Root $cer | Out-Null',
      "Write-Output 'trusted'",
    ].join('\n'),
  )
  console.log('[cert] ✓ 已导入**当前用户**的「受信任的根证书颁发机构」')
  console.log('[cert]   ⇒ 本机 `Get-AuthenticodeSignature` 看到的是 Status=Valid')
  console.log(`[cert]   撤销：certutil.exe -user -delstore Root ${info.thumbprint}`)
} else {
  console.log('[cert] ℹ️ 未加 --trust ⇒ 本机看到的将是 Status=NotTrusted（证书不受信任）')
  console.log(`[cert]   之后想信任它：certutil.exe -f -user -addstore Root "${cerPath}"`)
}

// ---------------------------------------------------------------------------
// 怎么用它签包
// ---------------------------------------------------------------------------

console.log('')
console.log('[cert] 签包（electron-builder 原生支持，**不用改任何代码**）：')
console.log(
  `[cert]   $env:WIN_CSC_LINK='${pfxPath}'\n` +
    `[cert]   $env:WIN_CSC_KEY_PASSWORD=(Get-Content -Raw '${pwdPath}').Trim()\n` +
    '[cert]   npm run pack:probe',
)
console.log('[cert] ⚠️ 这两个变量**只在当前 PowerShell 会话**有效；别写进仓库。')

// ⚠️ 自检：把刚生成的东西读回来，确认真的能用（而不是「以为建好了」）。
const probe = JSON.parse(
  String(
    runPowerShell(
      [
        '$ErrorActionPreference=Stop',
        `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(pfxPath)}'))`,
        `$pwd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(password)}'))`,
        '$secure=ConvertTo-SecureString -String $pwd -Force -AsPlainText',
        '$c=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($p,$pwd,"Export")',
        '$subjectB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$c.Subject))',
        '[ordered]@{ subjectB64=$subjectB64; hasPrivateKey=$c.HasPrivateKey; thumbprint=$c.Thumbprint } | ConvertTo-Json -Compress',
      ].join('\n'),
    ),
  )
    .trim()
    .split('\n')
    .pop(),
)
const probeSubject = pickB64(probe, 'subjectB64')
if (!probe.hasPrivateKey) {
  console.error('[cert] ✗ 自检失败：读回来的 .pfx **没有私钥**')
  process.exit(1)
}
if (probeSubject !== subject) {
  console.error(`[cert] ✗ 自检失败：主体名对不上（生成的是 ${subject}，读回来的是 ${probeSubject}）`)
  process.exit(1)
}
console.log(`[cert] ✓ 自检通过：.pfx 可读、私钥在位（Subject=${probeSubject}）`)

// ⚠️ 顺手把 .pfx 的「是不是我们以为的那个」写进一个机器可读的清单（gitignored）。
writeFileSync(
  join(args.outDir, 'cert-info.json'),
  JSON.stringify(
    {
      subject: probeSubject,
      thumbprint: probe.thumbprint,
      cn: args.cn,
      selfSigned: true,
      note: '本地自签测试证书 —— 不可信、不可用于公开发布',
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
console.log(`[cert] 机器可读清单：${join(args.outDir, 'cert-info.json')}`)
