// ---------------------------------------------------------------------------
// 自动更新（Task 23）—— 主进程侧
// ---------------------------------------------------------------------------
//
// 这个模块回答一个问题：**「有没有新版本？有的话，怎么安全地把它装上？」**
//
// ---------------------------------------------------------------------------
// 为什么全在主进程
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）：
// - **渲染层永远不直接发网络请求** → 检查 / 下载 / 安装**全在主进程**，
//   渲染层只发 IPC 请求、只收结果；
// - 拉清单走**已有的 Chromium 分区栈**（`electron/http.ts`）——
//   更新服务器**不在 `TrustedHosts` 里** → 该分区对它的证书校验是
//   `-3`（交回 Chromium 默认校验）→ **自签证书不会被放行**，
//   更新服务器必须用正规证书。
//
// ---------------------------------------------------------------------------
// 安全链条（**每一步都缺一不可**）
// ---------------------------------------------------------------------------
//   1. 地址合法      → 必须 https（回环才允许 http）、不许带凭证、不许带 query
//   2. 清单形状合法  → 版本号 / 文件列表 / SHA-512 全部逐项校验
//   3. 文件同源      → 安装包必须与清单**同一个源**（不许被指到别处）
//   4. 哈希相符      → 下载内容的 SHA-512 必须与清单一致
//   5. 签名相符      → 文件必须带 Authenticode 签名，且签名者 == 用户配置的预期
//   6. 用户点击      → 全程**不静默**：检查、下载、启动都是用户点的
//
// ⚠️ 第 5 条的「预期签名者」**没配置就不许启动安装器**——
//    自动更新 = 远程代码执行，这道闸不能省。
//
// ---------------------------------------------------------------------------
// 模块约束（与 `electron/http.ts` 同一套纪律）
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串。
//   故 Electron 相关对象一律**惰性解析**，并允许通过选项注入替身。
// - **不引入新依赖**：只用 Node 内置模块（`node:crypto` / `node:fs` / `node:path` /
//   `node:stream` / `node:child_process`）与标准 Web API。
//
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { evaluateSignatureGate, matchesExpectedSigner, parseSignerCandidates } from '../shared/update'
import { cleanupUpdateDir } from './updateCleanup'
import type {
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateFile,
  UpdateInstallResult,
  UpdateManifest,
  UpdateSignatureResult,
} from '../shared/update'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 更新清单的文件名（相对更新服务器目录）。 */
export const UPDATE_MANIFEST_FILE = 'latest.json'

/** SHA-512 的 hex 长度（64 字节 = 128 个 hex 字符）。 */
const SHA512_HEX_LENGTH = 128

// ---------------------------------------------------------------------------
// 地址校验
// ---------------------------------------------------------------------------

/** 回环主机（本地自测用的更新服务器）。 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * 校验更新服务器地址。
 *
 * ⚠️ 规则（**不可放宽**）：
 * - 必须是 `https:`；`http:` **只**允许回环主机（本地自测）；
 * - **不许**带 `user:pass@`（URL 里绝不能有凭证）；
 * - **不许**带 query / hash（避免把 token 藏进地址，也避免路径拼接歧义）。
 *
 * @returns 合法时返回解析后的 URL；不合法返回 `null`。
 */
export function validateUpdateBaseUrl(raw: string): URL | null {
  const text = raw.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null
  if (url.username !== '' || url.password !== '') return null
  if (url.search !== '' || url.hash !== '') return null
  return url
}

/**
 * 拼出清单地址（`<base>/latest.json`）。
 *
 * @returns 合法时返回清单 URL；不合法返回 `null`。
 */
export function resolveManifestUrl(baseUrl: string): string | null {
  const base = validateUpdateBaseUrl(baseUrl)
  if (!base) return null
  const dir = base.pathname.replace(/\/+$/, '')
  return new URL(`${dir}/${UPDATE_MANIFEST_FILE}`, base.origin).toString()
}

/**
 * 解析清单里的文件地址，并**强制同源**。
 *
 * ⚠️ **同源是硬要求**：清单可以把安装包指到任意地址——
 *    那等于给了一条「远程代码执行」的路。只允许同源（同一 scheme + host + port）。
 *
 * @returns 合法时返回绝对 URL；不合法返回 `null`。
 */
export function resolveFileUrl(baseUrl: string, fileUrl: string): string | null {
  const base = validateUpdateBaseUrl(baseUrl)
  if (!base) return null
  const manifestUrl = resolveManifestUrl(baseUrl)
  if (!manifestUrl) return null
  const text = fileUrl.trim()
  if (text === '') return null
  let resolved: URL
  try {
    resolved = new URL(text, manifestUrl)
  } catch {
    return null
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return null
  if (resolved.origin !== new URL(manifestUrl).origin) return null
  return resolved.toString()
}

/**
 * 把清单里的文件名压成**安全的 basename**。
 *
 * ⚠️ 清单里的 `name` 是**不可信输入**：`../../evil.exe` 这类路径穿越必须堵死。
 *
 * @returns 安全的文件名；不合法返回 `null`。
 */
export function sanitizeFileName(name: string): string | null {
  const text = name.trim()
  if (text === '') return null
  if (/[\\/]/.test(text)) return null
  if (text === '.' || text === '..') return null
  if (/[\u0000-\u001f]/.test(text)) return null
  return basename(text)
}

// ---------------------------------------------------------------------------
// 版本比对
// ---------------------------------------------------------------------------

/** 解析后的版本。 */
interface ParsedVersion {
  /** 数字段（最多取 3 段：主 / 次 / 修订）。 */
  release: [number, number, number]
  /** 预发布后缀（`1.2.3-beta.1` 的 `beta.1`）；没有就是 `null`。 */
  pre: string | null
}

/** 解析版本号（容忍 `v` 前缀与预发布后缀）。 */
function parseVersion(raw: string): ParsedVersion {
  const text = raw.trim().replace(/^v/i, '')
  const dash = text.indexOf('-')
  const core = dash >= 0 ? text.slice(0, dash) : text
  const pre = dash >= 0 ? text.slice(dash + 1) : null
  const parts = core.split('.')
  const nums: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i += 1) {
    const part = parts[i]
    const value = part === undefined ? 0 : Number.parseInt(part, 10)
    nums[i] = Number.isFinite(value) ? value : 0
  }
  return { release: nums, pre }
}

/**
 * 比两个版本号（语义化版本）。
 *
 * @returns `a < b` → `-1`；`a > b` → `1`；相等 → `0`。
 *
 * ⚠️ 预发布后缀按 semver 规则：同版本号时**带后缀的更旧**
 *    （`1.2.3-beta` < `1.2.3`）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    const va = pa.release[i] ?? 0
    const vb = pb.release[i] ?? 0
    if (va !== vb) return va < vb ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre < pb.pre ? -1 : 1
}

// ---------------------------------------------------------------------------
// 清单解析
// ---------------------------------------------------------------------------

/**
 * 解析并校验更新清单。
 *
 * ⚠️ **逐项校验**：任何一项不合规 → 整个清单作废（返回 `null`），
 *    不做「部分接受」——清单是**不可信输入**。
 */
export function parseUpdateManifest(raw: string): UpdateManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>

  const version = record['version']
  if (typeof version !== 'string' || version.trim() === '') return null

  const rawFiles = record['files']
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) return null

  const files: UpdateFile[] = []
  for (const entry of rawFiles) {
    if (typeof entry !== 'object' || entry === null) return null
    const item = entry as Record<string, unknown>
    const name = item['name']
    const url = item['url']
    const sha512 = item['sha512']
    const size = item['size']
    if (typeof name !== 'string' || name.trim() === '') return null
    if (typeof url !== 'string' || url.trim() === '') return null
    if (typeof sha512 !== 'string' || !/^[0-9a-f]{128}$/i.test(sha512.trim())) return null
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null
    files.push({ name: name.trim(), url: url.trim(), sha512: sha512.trim().toLowerCase(), size })
  }

  const manifest: UpdateManifest = { version: version.trim(), files }
  const releasedAt = record['releasedAt']
  if (typeof releasedAt === 'string' && releasedAt.trim() !== '') manifest.releasedAt = releasedAt.trim()
  const notes = record['notes']
  if (typeof notes === 'string' && notes.trim() !== '') manifest.notes = notes.trim()
  return manifest
}

/** 从清单里挑出安装包（**第一个 `.exe`**）。 */
export function pickInstaller(manifest: UpdateManifest): UpdateFile | null {
  for (const file of manifest.files) {
    if (file.url.toLowerCase().endsWith('.exe')) return file
  }
  return null
}

// ---------------------------------------------------------------------------
// 哈希
// ---------------------------------------------------------------------------

/** 计算字节的 SHA-512（小写 hex）。 */
export function sha512Hex(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('hex')
}

/**
 * 计算**文件**的 SHA-512（小写 hex，流式，不把整个文件读进内存）。
 *
 * ⚠️ T82：给「允许安装未签名更新」那条路用——启动安装器前**再验一次**哈希
 *    （下载到启动之间，文件理论上可能被换掉）。
 *
 * @param filePath 文件路径。
 * @returns 小写 hex；读不了抛错（调用方据此拒绝）。
 */
export async function sha512File(filePath: string): Promise<string> {
  const hash = createHash('sha512')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

/**
 * 校验下载内容的 SHA-512 是否与清单一致。
 *
 * ⚠️ **大小写不敏感**：清单里写大写 hex 也认（统一转小写再比）。
 */
export function verifySha512(bytes: Uint8Array, expected: string): boolean {
  const want = expected.trim().toLowerCase()
  if (want.length !== SHA512_HEX_LENGTH || !/^[0-9a-f]+$/.test(want)) return false
  return sha512Hex(bytes) === want
}

// ---------------------------------------------------------------------------
// Authenticode 签名
// ---------------------------------------------------------------------------

/** Authenticode 探测的执行器（**可注入**，便于单测）。 */
export type AuthenticodeRunner = (filePath: string) => Promise<{ status: string; signer: string | null }>

/**
 * 默认执行器：用 PowerShell 的 `Get-AuthenticodeSignature` 读签名。
 *
 * ⚠️ 只读签名信息，**不执行**被检查的文件。
 * ⚠️ Windows 之外没有 PowerShell → 返回 `Unavailable`（调用方据此判为不通过）。
 *
 * ⚠️ **T86：签名者主体用 base64 传回**（不是直接吐原文）。
 *    原因：PowerShell 往**管道**写 stdout 时用的是**控制台代码页**
 *    （简体中文机器 = OEM 936 / GBK），不是 UTF-8 ⇒ 主体名里带中文时
 *    （本项目的证书主体名就是**公司法定主体名**，是中文），
 *    Node 按 UTF-8 解出来是**乱码** ⇒ 与用户填的「预期的代码签名者」
 *    **永远对不上** ⇒ 安装包会被**莫名其妙**地拒掉。
 *    ⇒ 让 PowerShell 输出 **base64(UTF-8)**，Node 侧再解 ⇒ 与代码页无关。
 */
export async function runPowerShellAuthenticode(filePath: string): Promise<{
  status: string
  signer: string | null
}> {
  if (process.platform !== 'win32') return { status: 'Unavailable', signer: null }
  const literal = filePath.replace(/'/g, "''")
  const script = [
    "$s = Get-AuthenticodeSignature -LiteralPath '" + literal + "'",
    "$signer = ''",
    'if ($s.SignerCertificate) { $signer = [string]$s.SignerCertificate.Subject }',
    '$signerB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($signer))',
    "[ordered]@{ status = [string]$s.Status; signerB64 = $signerB64 } | ConvertTo-Json -Compress",
  ].join('\n')
  return await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ status: 'UnknownError', signer: null })
          return
        }
        try {
          const parsed = JSON.parse(String(stdout).trim()) as { status?: unknown; signerB64?: unknown }
          const status = typeof parsed.status === 'string' ? parsed.status : 'UnknownError'
          resolve({ status, signer: decodeBase64Utf8(parsed.signerB64) })
        } catch {
          resolve({ status: 'UnknownError', signer: null })
        }
      },
    )
  })
}

/** 把 base64(UTF-8) 解成字符串；不是合法 base64 / 空 ⇒ `null`。 */
function decodeBase64Utf8(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const text = Buffer.from(value, 'base64').toString('utf8')
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * 校验安装包的 Authenticode 签名。
 *
 * ⚠️ **判定口径**（刻意**不验信任链**）：
 * - 必须**有签名**（`NotSigned` → 不通过）；
 * - 签名者主体必须与**用户配置的预期签名者**一致；
 * - 信任链由 Windows 自己判断（`Status` 如实反映），我们不越权替它下结论。
 *
 * ⚠️ **T85：不再因为「没配预期签名者」就跳过探测**。
 *    旧实现在 `expected === ''` 时**提前返回 `NotChecked`、根本不读文件**
 *    ⇒ 主进程永远不知道这个包有没有签名 ⇒「允许安装未签名的更新包」
 *    那条路**从没有真正走到过**。
 *    ⇒ 现在**一律探测**，再按探测结果分流：
 *    - `NotSigned`（确实没签名）⇒ 交由「未签名放行」那条路判（它要看用户授权 + 哈希）；
 *    - 有签名但**没配**预期签名者 ⇒ 不通过（授权**也**救不了：那不是「未签名包」）；
 *    - 有签名且**不符** ⇒ 不通过。
 */
export async function verifyAuthenticode(
  filePath: string,
  expectedSigner: string | undefined,
  runner: AuthenticodeRunner = runPowerShellAuthenticode,
): Promise<UpdateSignatureResult> {
  const expected = (expectedSigner ?? '').trim()
  let probed: { status: string; signer: string | null }
  try {
    probed = await runner(filePath)
  } catch {
    return { ok: false, status: 'UnknownError', signer: null, reason: '签名校验执行失败' }
  }
  if (probed.status === 'NotSigned') {
    return { ok: false, status: probed.status, signer: null, reason: '安装包没有 Authenticode 签名' }
  }
  if (!probed.signer) {
    return { ok: false, status: probed.status, signer: null, reason: '读不到签名者信息' }
  }
  // ⚠️ **有签名、但没配预期签名者** ⇒ 拒绝。
  //    （T85：这里以前是「不探测就直接拒」，现在改成「探测完再拒」——
  //    区别在于主进程**现在知道**这个包有没有签名，
  //    「没签名 + 用户已授权」这条路才走得通。）
  if (expected === '') {
    return {
      ok: false,
      status: probed.status,
      signer: probed.signer,
      reason: '安装包有代码签名，但未配置「预期的代码签名者」',
    }
  }
  // ⚠️ **T87：不再用「整串精确相等」**。
  //    旧口径拿整个 RFC4514 Subject 串（`CN=…, O=…, C=…`）跟用户填的值比
  //    ⇒ 用户必须**逐字符**粘贴才能匹配（手打必错；证书续期后还会失效）。
  //    ⇒ 现在按**共享口径**（`shared/update.ts` 的 `matchesExpectedSigner`）：
  //      ① 整串相等（兼容「粘了整个 Subject」的既有配置）；
  //      ② 否则取 Subject 的**全部 CN** 与候选**相等**比较。
  //    ⇒ **绝不做「包含」匹配**：`CN=SignPath Foundation Evil` 骗不过去。
  if (!matchesExpectedSigner(probed.signer, expected)) {
    const candidates = parseSignerCandidates(expected).join(' / ')
    return {
      ok: false,
      status: probed.status,
      signer: probed.signer,
      reason: `签名者与预期不符（预期 ${candidates || expected}，实际 ${probed.signer}）`,
    }
  }
  return { ok: true, status: probed.status, signer: probed.signer, reason: null }
}

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

/** `checkForUpdate` 的入参。 */
export interface CheckUpdateOptions {
  /** 更新服务器地址（目录）。 */
  baseUrl: string
  /** 当前版本号。 */
  currentVersion: string
  /** 拉取用的 fetch。 */
  fetchImpl: typeof fetch
}

/**
 * 检查有没有新版本。
 *
 * ⚠️ **不静默**：只查、只报，不下载、不安装。
 */
export async function checkForUpdate(opts: CheckUpdateOptions): Promise<UpdateCheckResult> {
  if (opts.baseUrl.trim() === '') return { status: 'not-configured' }
  const manifestUrl = resolveManifestUrl(opts.baseUrl)
  if (!manifestUrl) {
    return {
      status: 'error',
      message: '更新服务器地址不合法：必须是 https://（回环地址才允许 http://），且不许带凭证或查询参数',
    }
  }
  let response: Response
  try {
    response = await opts.fetchImpl(manifestUrl, { headers: { accept: 'application/json' } })
  } catch (cause) {
    return { status: 'error', message: `连不上更新服务器：${readableError(cause)}` }
  }
  if (!response.ok) {
    return { status: 'error', message: `更新服务器返回 ${response.status}` }
  }
  let raw: string
  try {
    raw = await response.text()
  } catch (cause) {
    return { status: 'error', message: `读取更新清单失败：${readableError(cause)}` }
  }
  const manifest = parseUpdateManifest(raw)
  if (!manifest) {
    return { status: 'error', message: '更新清单格式不对（不是本项目约定的 latest.json）' }
  }
  const file = pickInstaller(manifest)
  if (!file) {
    return { status: 'error', message: '更新清单里没有可安装的文件（.exe）' }
  }
  if (compareVersions(manifest.version, opts.currentVersion) <= 0) {
    return { status: 'up-to-date', current: opts.currentVersion }
  }
  return { status: 'available', current: opts.currentVersion, manifest, file }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/** `downloadUpdate` 的入参。 */
export interface DownloadUpdateOptions {
  /** 更新服务器地址（目录）。 */
  baseUrl: string
  /** 清单里选中的文件。 */
  file: UpdateFile
  /** 下载目录（主进程落盘的位置）。 */
  destDir: string
  /** 拉取用的 fetch。 */
  fetchImpl: typeof fetch
  /** Authenticode 校验执行器。 */
  runAuthenticode?: AuthenticodeRunner
  /** 预期的代码签名者（不配置 → **包有签名时**判为不通过；包没签名时走「未签名放行」那条路）。 */
  expectedSigner?: string
}

/**
 * 下载安装包并校验（**SHA-512 必过**；签名只做判定，不拦下载）。
 *
 * ⚠️ 下载用 `.part` 临时文件，**校验通过后**才改名成正式文件名——
 *    避免「校验没过却留下一个看起来能装的 exe」。
 */
export async function downloadUpdate(opts: DownloadUpdateOptions): Promise<UpdateDownloadResult> {
  const fileUrl = resolveFileUrl(opts.baseUrl, opts.file.url)
  if (!fileUrl) {
    return { status: 'error', message: '安装包地址不合法（必须与更新清单同源）' }
  }
  const safeName = sanitizeFileName(opts.file.name) ?? 'update.exe'
  const targetPath = join(opts.destDir, safeName)
  const partPath = `${targetPath}.part`

  let response: Response
  try {
    response = await opts.fetchImpl(fileUrl)
  } catch (cause) {
    return { status: 'error', message: `下载安装包失败：${readableError(cause)}` }
  }
  if (!response.ok) {
    return { status: 'error', message: `下载安装包失败：服务器返回 ${response.status}` }
  }
  if (!response.body) {
    return { status: 'error', message: '下载安装包失败：响应没有内容' }
  }

  await mkdir(opts.destDir, { recursive: true })
  const hasher = createHash('sha512')
  try {
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hasher.update(chunk)
          yield chunk
        }
      },
      createWriteStream(partPath),
    )
  } catch (cause) {
    await rm(partPath, { force: true }).catch(() => undefined)
    return { status: 'error', message: `写安装包失败：${readableError(cause)}` }
  }

  const digest = hasher.digest('hex')
  const expected = opts.file.sha512.trim().toLowerCase()
  if (digest !== expected) {
    // ⚠️ 哈希不符 → 立刻删掉，不留半成品。
    await rm(partPath, { force: true }).catch(() => undefined)
    return {
      status: 'error',
      message: '安装包校验失败（SHA-512 与清单不一致），已丢弃下载内容',
    }
  }

  try {
    await rm(targetPath, { force: true })
    await rename(partPath, targetPath)
  } catch (cause) {
    await rm(partPath, { force: true }).catch(() => undefined)
    return { status: 'error', message: `保存安装包失败：${readableError(cause)}` }
  }

  // ⚠️ T89-③：本次下载成功了 ⇒ 把更新目录里**别的**旧文件清掉
  //    （同一次会话里连下两版会白白占两份 86 MB；顺带清掉 `.part` 碎片）。
  //    ⚠️ **下载失败时走不到这里** ⇒ 失败不会把用户已经有的那份弄丢。
  //    ⚠️ 清不掉就算了（删文件失败不抛）⇒ 清理不会让下载失败。
  cleanupUpdateDir(opts.destDir, { keep: safeName })

  const signature = await verifyAuthenticode(
    targetPath,
    opts.expectedSigner,
    opts.runAuthenticode ?? runPowerShellAuthenticode,
  )

  return {
    status: 'ok',
    path: targetPath,
    // ⚠️ **T87.12**：把落盘用的**文件名**一起给渲染层 ——
    //    启动安装时它要回传的就是这个名字（`update:install` 的参数是**裸文件名**）。
    name: safeName,
    bytes: opts.file.size,
    sha512Ok: true,
    signature,
  }
}

// ---------------------------------------------------------------------------
// 启动安装器
// ---------------------------------------------------------------------------

/** `launchInstaller` 的入参。 */
export interface LaunchInstallerOptions {
  /** 安装包路径。 */
  filePath: string
  /**
   * 预期的代码签名者（不配置 → **包有签名时**拒绝启动；
   * 包**没签名**时改走「允许安装未签名包」那条路，T85 起**不再**直接拒）。
   */
  expectedSigner?: string
  /**
   * 是否**允许安装未签名包**（T82；**默认 false** = 原行为，一字不变）。
   *
   * ⚠️ 只在「包**没有**签名」时才起作用；**哈希不符 → 照样拒绝**。
   */
  allowUnsigned?: boolean
  /**
   * 清单里的 **SHA-512**（T82）：启动前**再验一次**。
   *
   * ⚠️ 必须是**主进程自己缓存的清单**里的那个值（不是渲染进程给的）。
   */
  expectedSha512?: string
  /** Authenticode 校验执行器。 */
  runAuthenticode?: AuthenticodeRunner
  /** 启动文件的执行器（默认走 Electron 的 `shell.openPath`）。 */
  openPath: (path: string) => Promise<string>
}

/**
 * 启动安装器。
 *
 * ⚠️ **启动前重新验一次签名**：下载到启动之间，文件理论上可能被换掉。
 * ⚠️ 签名不通过 → **绝不启动**（这是最后一道闸）。
 *
 * ⚠️ **T82 的例外路径**（唯一一条，且**默认关闭**）：
 *    - 包**没有**签名（`NotSigned`）**且** 用户显式开了「允许安装未签名更新」
 *      **且** 启动前重算的 **SHA-512 与清单相符**
 *      ⇒ 才放行（此时**只**放宽了「发布者身份」，其余闸门一字没松）。
 *    - 其余任何情况（签名不符 / 签名者不符 / 哈希不符 / 没开授权）→ **一律拒绝**。
 */
export async function launchInstaller(opts: LaunchInstallerOptions): Promise<UpdateInstallResult> {
  const signature = await verifyAuthenticode(
    opts.filePath,
    opts.expectedSigner,
    opts.runAuthenticode ?? runPowerShellAuthenticode,
  )
  if (!signature.ok) {
    const unsignedAllowed = await verifyUnsignedAllowed(opts, signature)
    if (!unsignedAllowed.ok) {
      return {
        status: 'error',
        message: `安装包签名校验未通过，已拒绝启动：${unsignedAllowed.reason}`,
      }
    }
  }
  try {
    const error = await opts.openPath(opts.filePath)
    if (typeof error === 'string' && error.trim() !== '') {
      return { status: 'error', message: `启动安装包失败：${error}` }
    }
    return { status: 'ok', path: opts.filePath }
  } catch (cause) {
    return { status: 'error', message: `启动安装包失败：${readableError(cause)}` }
  }
}

/**
 * 「未签名包能否放行」的判定（T82；T85 修好它的判定口径）。
 *
 * ⚠️ **三道条件缺一不可**：
 * 1. 用户**显式**开了「允许安装未签名更新」（`allowUnsigned`）；
 * 2. 这个包**确实没有**签名（`NotSigned`）——签名者不符的包**不走这条路**；
 * 3. 启动前重算的 **SHA-512 与清单相符**（哈希是硬闸）。
 *
 * ⚠️ **第 1、2 条用共享口径**（`evaluateSignatureGate`，与渲染层**同一份**）——
 *    T85 的事故就是两边各判各的 ⇒ 这两条**不许**在这里另写一遍。
 *
 * @returns 放行返回 `{ ok: true }`；否则 `{ ok: false, reason }`（reason 可直接显示给用户）。
 */
async function verifyUnsignedAllowed(
  opts: LaunchInstallerOptions,
  signature: UpdateSignatureResult,
): Promise<{ ok: boolean; reason: string }> {
  // 签名本来就通过 ⇒ 这条路不用走（调用方只在 `!signature.ok` 时才进来，这里兜个底）。
  if (signature.ok) return { ok: true, reason: '' }
  const gate = evaluateSignatureGate({
    signatureOk: signature.ok,
    signatureStatus: signature.status,
    signatureReason: signature.reason,
    allowUnsigned: opts.allowUnsigned === true,
  })
  if (!gate.allowed) {
    return { ok: false, reason: gate.reason ?? '未知原因' }
  }
  const expected = (opts.expectedSha512 ?? '').trim().toLowerCase()
  if (expected.length !== SHA512_HEX_LENGTH || !/^[0-9a-f]+$/.test(expected)) {
    return { ok: false, reason: '没有清单里的 SHA-512 可核对 → 不允许安装未签名包' }
  }
  let actual: string
  try {
    actual = await sha512File(opts.filePath)
  } catch (cause) {
    return { ok: false, reason: `读不到安装包内容，无法核对 SHA-512：${readableError(cause)}` }
  }
  if (actual !== expected) {
    return { ok: false, reason: '安装包 SHA-512 与清单不一致 → 不允许安装（哈希不符一律拒绝）' }
  }
  return { ok: true, reason: '' }
}

// ---------------------------------------------------------------------------
// 控制器（IPC 用）
// ---------------------------------------------------------------------------

/** `createUpdateController` 的参数。 */
export interface UpdateControllerOptions {
  /** 出网（Chromium 分区栈）。 */
  fetchImpl: typeof fetch
  /** 当前版本号。 */
  currentVersion: string
  /** 下载目录（安装包落在这里）。 */
  destDir: string
  /** 启动文件的执行器（默认走 Electron 的 `shell.openPath`）。 */
  openPath?: (path: string) => Promise<string>
  /** Authenticode 校验执行器。 */
  runAuthenticode?: AuthenticodeRunner
}

/**
 * 更新控制器（IPC 背后用的那一个）。
 *
 * ⚠️ **为什么要有它**：渲染进程是**不可信输入**。
 *    - 下载时**不许**用渲染进程传来的地址 / 哈希 —— 一律用**主进程自己刚查到的清单**；
 *    - 启动时**不许**用渲染进程传来的路径 —— 只接受**文件名**，
 *      由主进程拼到下载目录下面，并确认结果**仍在目录内**。
 *    ⇒ 渲染进程最多能说「装哪个名字」，**不能**说「去哪儿装」。
 */
export interface UpdateController {
  /** 检查更新（成功后把清单缓存下来）。 */
  check(baseUrl: string): Promise<UpdateCheckResult>
  /** 下载安装包（用缓存里的清单项）。 */
  download(name: string, expectedSigner?: string): Promise<UpdateDownloadResult>
  /**
   * 启动安装器。
   *
   * @param allowUnsigned 是否允许装**未签名**包（T82；默认 false = 原行为）。
   */
  install(name: string, expectedSigner?: string, allowUnsigned?: boolean): Promise<UpdateInstallResult>
}

/**
 * 造一个更新控制器。
 *
 * ⚠️ 清单缓存**只留最新的一份**：检查完才有清单，
 *    没检查过就直接下载 → 明确报错（不猜、不自己拼地址）。
 */
export function createUpdateController(opts: UpdateControllerOptions): UpdateController {
  /**
   * 最近一次检查到的安装包（`null` = 还没检查过）。
   *
   * ⚠️ **地址一起缓存**：下载时要用**当初检查的那个地址**，
   *    不许渲染进程临时换一个（那等于让渲染层决定去哪儿下东西）。
   */
  let cached: { baseUrl: string; file: UpdateFile } | null = null

  const openPath = opts.openPath ?? defaultOpenPath
  const runner = opts.runAuthenticode ?? runPowerShellAuthenticode

  /** 在缓存里按文件名找一项。 */
  const findCached = (name: string): { baseUrl: string; file: UpdateFile } | null => {
    if (!cached) return null
    const safe = sanitizeFileName(name)
    if (!safe) return null
    return cached.file.name === safe ? cached : null
  }

  return {
    check: async (baseUrl: string): Promise<UpdateCheckResult> => {
      const result = await checkForUpdate({
        baseUrl,
        currentVersion: opts.currentVersion,
        fetchImpl: opts.fetchImpl,
      })
      cached = result.status === 'available' ? { baseUrl, file: result.file } : null
      return result
    },
    download: async (name: string, expectedSigner?: string): Promise<UpdateDownloadResult> => {
      const entry = findCached(name)
      if (!entry) {
        return { status: 'error', message: '没有可下载的更新（请先「检查更新」）' }
      }
      return await downloadUpdate({
        baseUrl: entry.baseUrl,
        file: entry.file,
        destDir: opts.destDir,
        fetchImpl: opts.fetchImpl,
        runAuthenticode: runner,
        expectedSigner,
      })
    },
    install: async (name: string, expectedSigner?: string, allowUnsigned?: boolean): Promise<UpdateInstallResult> => {
      const safe = sanitizeFileName(name)
      if (!safe) {
        return { status: 'error', message: '安装包名不合法' }
      }
      const filePath = join(opts.destDir, safe)
      // ⚠️ 二次确认：拼出来的路径必须**仍在下载目录里**。
      if (!isInsideDir(opts.destDir, filePath)) {
        return { status: 'error', message: '安装包路径不合法' }
      }
      if (!existsSync(filePath)) {
        return { status: 'error', message: '安装包不存在（请先下载）' }
      }
      // ⚠️ T82：未签名包要核对哈希 ⇒ 用**主进程自己缓存的清单**里的 SHA-512
      //    （不是渲染进程给的；缓存里没有就不给 ⇒ 那条路自然关着）。
      const cachedEntry = findCached(safe)
      return await launchInstaller({
        filePath,
        expectedSigner,
        allowUnsigned,
        expectedSha512: cachedEntry?.file.sha512,
        runAuthenticode: runner,
        openPath,
      })
    },
  }
}

/** 判断 `target` 是否在 `dir` 目录之内（防止路径穿越）。 */
function isInsideDir(dir: string, target: string): boolean {
  const base = resolvePath(dir)
  const full = resolvePath(target)
  return full === base || full.startsWith(`${base}${sep}`)
}


/** 把任意错误转成**可读且不含凭证**的文案。 */
export function readableError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  if (typeof cause === 'string' && cause !== '') return cause
  return '未知错误'
}

// ---------------------------------------------------------------------------
// 惰性取 Electron 的 `shell`
// ---------------------------------------------------------------------------

/**
 * Electron 主进程里的 `require`（**只是类型声明**；运行时由 Node 的 CJS 包装器提供）。
 *
 * ⚠️ **为什么需要它（T87.18 真机实证，2026-11-12）**：
 *    Electron 的**主进程**里 `globalThis.require` 是 **undefined**
 *    （实测 Electron 32.3.3 / Node 20.18.1）⇒ 旧实现（只认 `globalThis.require`）
 *    在主进程**永远**拿不到 `shell`
 *    ⇒ 「启动安装」在真机上必然报
 *    「启动安装包失败：当前进程没有 Electron 运行时，无法启动安装包」。
 *    而**模块作用域**的 `require` 在主进程是有的
 *    （esbuild 打成 CJS ⇒ Node 的 CJS 包装器提供 `require`）
 *    ⇒ 改成**优先用模块作用域的 `require`**。
 *
 * ⚠️ **不能改成顶层 `import { shell } from 'electron'`**：本文件要能在
 *    Vitest（普通 Node / ESM）里直接单测 ⇒ Electron 对象必须**惰性**解析
 *    （与 `electron/http.ts` 是同一套纪律）。
 */
declare const require: ((id: string) => unknown) | undefined

/** `require` 的形状。 */
type RequireFn = (id: string) => unknown

/**
 * 在「模块作用域的 `require`」与「`globalThis.require`」之间挑一个。
 *
 * ⚠️ **顺序不可颠倒**：主进程只有**模块作用域**那个能用（`globalThis.require`
 *    在主进程是 undefined）；单测环境（ESM）两个都没有 ⇒ `null`。
 *
 * @param moduleRequire 模块作用域的 `require`（没有就传 `undefined`）。
 * @param globalRequire `globalThis.require`（没有就传 `undefined`）。
 */
export function pickRequire(
  moduleRequire: RequireFn | undefined,
  globalRequire: RequireFn | undefined,
): RequireFn | null {
  if (typeof moduleRequire === 'function') return moduleRequire
  if (typeof globalRequire === 'function') return globalRequire
  return null
}

/** 取当前环境里的 `require`（主进程 ⇒ 模块作用域那个；单测 ⇒ `null`）。 */
function currentRequire(): RequireFn | null {
  // ⚠️ `typeof` 守卫：ESM（Vitest）里 `require` 根本不存在 ⇒ 不会 ReferenceError。
  const moduleRequire = typeof require === 'function' ? require : undefined
  const globalRequire = (globalThis as unknown as { require?: RequireFn }).require
  return pickRequire(moduleRequire, globalRequire)
}

/**
 * 惰性取 Electron 的 `shell`（**不在模块顶层调用**）。
 *
 * @param requireImpl 取 `electron` 模块用的 `require`（**可注入** ⇒ 便于单测）。
 * @returns 拿不到时返回 `null`。
 */
export function resolveElectronShellFrom(
  requireImpl: RequireFn | null,
): { openPath(path: string): Promise<string> } | null {
  if (typeof requireImpl !== 'function') return null
  try {
    const mod = requireImpl('electron') as { shell?: unknown } | string
    if (typeof mod !== 'object' || mod === null) return null
    const shell = (mod as { shell?: unknown }).shell
    if (typeof shell !== 'object' || shell === null) return null
    const openPath = (shell as { openPath?: unknown }).openPath
    if (typeof openPath !== 'function') return null
    return { openPath: (openPath as (path: string) => Promise<string>).bind(shell) }
  } catch {
    return null
  }
}

/**
 * 惰性取 Electron 的 `shell`（生产路径）。
 *
 * @param requireImpl 覆盖用的 `require`；**省略** ⇒ 用当前环境里的那个。
 */
export function resolveElectronShell(
  requireImpl?: RequireFn | null,
): { openPath(path: string): Promise<string> } | null {
  const req = requireImpl === undefined ? currentRequire() : requireImpl
  return resolveElectronShellFrom(req)
}

/** 默认的启动执行器（Electron `shell.openPath`；拿不到就报错）。 */
export async function defaultOpenPath(path: string): Promise<string> {
  const shell = resolveElectronShell()
  if (!shell) return '当前进程没有 Electron 运行时，无法启动安装包'
  return await shell.openPath(path)
}
