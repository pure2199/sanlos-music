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
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
    "[ordered]@{ status = [string]$s.Status; signer = $signer } | ConvertTo-Json -Compress",
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
          const parsed = JSON.parse(String(stdout).trim()) as { status?: unknown; signer?: unknown }
          const status = typeof parsed.status === 'string' ? parsed.status : 'UnknownError'
          const signer = typeof parsed.signer === 'string' && parsed.signer !== '' ? parsed.signer : null
          resolve({ status, signer })
        } catch {
          resolve({ status: 'UnknownError', signer: null })
        }
      },
    )
  })
}

/**
 * 校验安装包的 Authenticode 签名。
 *
 * ⚠️ **判定口径**（刻意**不验信任链**）：
 * - 必须**有签名**（`NotSigned` → 不通过）；
 * - 签名者主体必须与**用户配置的预期签名者**一致；
 * - 信任链由 Windows 自己判断（`Status` 如实反映），我们不越权替它下结论。
 *
 * ⚠️ **预期签名者没配置 → 一律不通过**（不许启动安装器）。
 */
export async function verifyAuthenticode(
  filePath: string,
  expectedSigner: string | undefined,
  runner: AuthenticodeRunner = runPowerShellAuthenticode,
): Promise<UpdateSignatureResult> {
  const expected = (expectedSigner ?? '').trim()
  if (expected === '') {
    return {
      ok: false,
      status: 'NotChecked',
      signer: null,
      reason: '未配置「预期的代码签名者」→ 不允许启动安装器（自动更新等于远程代码执行，这道闸不能省）',
    }
  }
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
  if (probed.signer !== expected) {
    return {
      ok: false,
      status: probed.status,
      signer: probed.signer,
      reason: `签名者与预期不符（预期 ${expected}，实际 ${probed.signer}）`,
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
  /** 预期的代码签名者（不配置 → 签名一栏判为不通过）。 */
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

  const signature = await verifyAuthenticode(
    targetPath,
    opts.expectedSigner,
    opts.runAuthenticode ?? runPowerShellAuthenticode,
  )

  return {
    status: 'ok',
    path: targetPath,
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
  /** 预期的代码签名者（不配置 → 拒绝启动）。 */
  expectedSigner?: string
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
 */
export async function launchInstaller(opts: LaunchInstallerOptions): Promise<UpdateInstallResult> {
  const signature = await verifyAuthenticode(
    opts.filePath,
    opts.expectedSigner,
    opts.runAuthenticode ?? runPowerShellAuthenticode,
  )
  if (!signature.ok) {
    return {
      status: 'error',
      message: `安装包签名校验未通过，已拒绝启动：${signature.reason ?? '未知原因'}`,
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
  /** 启动安装器。 */
  install(name: string, expectedSigner?: string): Promise<UpdateInstallResult>
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
    install: async (name: string, expectedSigner?: string): Promise<UpdateInstallResult> => {
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
      return await launchInstaller({
        filePath,
        expectedSigner,
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

/** 惰性取 Electron 的 `shell`（**不在模块顶层调用**）。 */
function resolveElectronShell(): { openPath(path: string): Promise<string> } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req = (globalThis as unknown as { require?: (id: string) => unknown }).require
    if (typeof req !== 'function') return null
    const mod = req('electron') as { shell?: unknown } | string
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

/** 默认的启动执行器（Electron `shell.openPath`；拿不到就报错）。 */
export async function defaultOpenPath(path: string): Promise<string> {
  const shell = resolveElectronShell()
  if (!shell) return '当前进程没有 Electron 运行时，无法启动安装包'
  return await shell.openPath(path)
}
