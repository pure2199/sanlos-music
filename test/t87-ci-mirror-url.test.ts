/**
 * @vitest-environment node
 */

// T87.9：**下载镜像变量**也必须有守卫（`ELECTRON_MIRROR` 少一个 `/` ⇒ CI 打包 404）。
//
// ⚠️ **根因（2026-11-10 CI 实测）**：CI run 42861355862 与 Release run 42861484377
//    都挂在第 8 步 `Pack`：
//      ⨯ Response code 404 (Not Found) for
//        https://github.com/electron/electron/releases/downloadv32.3.3/electron-v32.3.3-win32-x64.zip
//    ⇒ `download` 后面**少了一个 `/`**。
//    而 `@electron/get` 的下载 URL 是**纯字符串拼接**：
//      `${base}${path}/${file}`   （@electron/get/dist/cjs/artifact-utils.js:60）
//    ⇒ 镜像（`base`）**必须自带结尾的 `/`**（它的默认值 `BASE_URL` 就带）。
//
// ⚠️ **为什么本地测不出来**：本机 electron-builder 的下载缓存里**已有** electron zip
//    ⇒ 打包**根本不下载**；CI 是干净 runner ⇒ 缓存空 ⇒ **必须下载** ⇒ 必炸。
//    ⇒ 这条守卫的价值：把「CI 才会炸」变成「**`npm test` 就红**」。
//
// ⚠️ **不自己写 URL 拼接规则**：直接调 **@electron/get 自己的** `getArtifactRemoteURL`
//    ⇒ 判定口径与真正下载时**是同一份**。
//    用的是 electron-builder **内置**的那份（`app-builder-lib/node_modules/@electron/get`，
//    v3.1.0）—— **真正跑打包的就是它**（顶层那份是 v2.0.3，是 `electron` 包自己用的）。
//
// ⚠️ **环境变量必须自己接管**：`@electron/get` 的 `mirrorVar` **先看** `.npmrc` 注入的
//    `npm_config_electron_mirror`（`npm test` 时 npm 会注入）⇒ 不清掉的话算出来的
//    是 npmmirror ⇒ 那就测不到「工作流里那个值」了。

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

interface ArtifactUtils {
  getArtifactRemoteURL: (details: Record<string, unknown>) => Promise<string>
}
interface ElectronGetModule {
  getBinariesMirrorUrl: (githubOrgRepo?: string) => string
}

// ⚠️ 内部路径：electron-builder 锁死版本（26.18.0）⇒ 路径稳定；
//    万一将来变了，这条测试会**响亮地失败**（而不是静默跳过 ⇒ 守卫失效）。
const artifactUtils = require(
  'app-builder-lib/node_modules/@electron/get/dist/cjs/artifact-utils.js',
) as ArtifactUtils
const electronGet = require('app-builder-lib/out/util/electronGet.js') as ElectronGetModule

/** electron 32.3.3 / win32 / x64 的下载参数（与 CI 日志里那条 URL 一一对应）。 */
const ELECTRON_ARTIFACT = {
  artifactName: 'electron',
  version: 'v32.3.3',
  platform: 'win32',
  arch: 'x64',
  mirrorOptions: {},
}

/** 正确形态（实测 Range GET ⇒ HTTP 206）。 */
const CANONICAL_ELECTRON_URL =
  'https://github.com/electron/electron/releases/download/v32.3.3/electron-v32.3.3-win32-x64.zip'

/** **2026-11-10 CI 里那条 404 的 URL**（一个字符都不差）。 */
const BROKEN_ELECTRON_URL =
  'https://github.com/electron/electron/releases/downloadv32.3.3/electron-v32.3.3-win32-x64.zip'

/** `@electron/get` / electron-builder 会**先看**这些变量（`.npmrc` 注入的）⇒ 算 URL 前必须清掉。 */
const NPM_INJECTED_MIRROR_VARS = [
  'npm_config_electron_mirror',
  'NPM_CONFIG_ELECTRON_MIRROR',
  'npm_config_electron_custom_dir',
  'NPM_CONFIG_ELECTRON_CUSTOM_DIR',
  'npm_config_electron_custom_filename',
  'NPM_CONFIG_ELECTRON_CUSTOM_FILENAME',
  'npm_config_electron_builder_binaries_mirror',
  'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR',
  'npm_package_config_electron_mirror',
  'npm_package_config_electron_builder_binaries_mirror',
]

/** 读一份文本文件，并把行尾**统一成 LF**（Windows runner 检出的是 CRLF）。 */
function readNormalized(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

/** 从工作流文件里取出某个环境变量的值。 */
function readWorkflowEnv(workflow: string, name: string): string {
  const text = readNormalized(join(REPO_ROOT, '.github', 'workflows', workflow))
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S+)[ \\t]*$`, 'm').exec(text)
  const value = match?.[1]
  if (value === undefined) {
    throw new Error(`${workflow} 里找不到 ${name}`)
  }
  return value
}

/**
 * 在**受控**的环境变量下跑一段逻辑（跑完**原样还原**）。
 *
 * ⚠️ 先清掉 `.npmrc` 注入的那批变量，再套用调用方给的值 ⇒
 *    调用方给 `npm_config_electron_mirror` 时**能生效**（用来验优先级）。
 */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>()
  const apply = (name: string, value: string | undefined): void => {
    if (!saved.has(name)) saved.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const name of NPM_INJECTED_MIRROR_VARS) apply(name, undefined)
  for (const [name, value] of Object.entries(vars)) apply(name, value)
  try {
    return await fn()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** 用 **@electron/get 自己的**拼接逻辑算 electron 的真实下载 URL。 */
function electronDownloadUrl(mirror: string): Promise<string> {
  return withEnv({ ELECTRON_MIRROR: mirror }, () =>
    artifactUtils.getArtifactRemoteURL({ ...ELECTRON_ARTIFACT }),
  )
}

describe('T87.9 —— 下载镜像变量的守卫', () => {
  it('`ci.yml` 的 `ELECTRON_MIRROR` 拼出的 electron 下载 URL **必须是规范形态**', async () => {
    const mirror = readWorkflowEnv('ci.yml', 'ELECTRON_MIRROR')
    await expect(electronDownloadUrl(mirror)).resolves.toBe(CANONICAL_ELECTRON_URL)
  })

  it('`release.yml` 的 `ELECTRON_MIRROR` 拼出的 electron 下载 URL **必须是规范形态**', async () => {
    const mirror = readWorkflowEnv('release.yml', 'ELECTRON_MIRROR')
    await expect(electronDownloadUrl(mirror)).resolves.toBe(CANONICAL_ELECTRON_URL)
  })

  it('**少一个 `/` 必被抓住**（变异自证：复刻 CI 里那个 404 URL）', async () => {
    const mirror = readWorkflowEnv('ci.yml', 'ELECTRON_MIRROR')
    // 镜像**必须自带结尾的 `/`**（`@electron/get` 是纯字符串拼接，不会补）。
    expect(mirror.endsWith('/')).toBe(true)

    const broken = mirror.replace(/\/$/, '')
    expect(broken).not.toBe(mirror)

    const url = await electronDownloadUrl(broken)
    // 一字不差地复刻 2026-11-10 CI 里那条 404 的 URL。
    expect(url).toBe(BROKEN_ELECTRON_URL)
    expect(url).not.toBe(CANONICAL_ELECTRON_URL)
  })

  it('`ELECTRON_BUILDER_BINARIES_MIRROR` 由 electron-builder **自己补尾斜杠**（写法可以随意）', async () => {
    const mirror = readWorkflowEnv('ci.yml', 'ELECTRON_BUILDER_BINARIES_MIRROR')
    const normalized = await withEnv(
      { ELECTRON_BUILDER_BINARIES_MIRROR: mirror },
      () => electronGet.getBinariesMirrorUrl(),
    )
    expect(normalized.endsWith('/')).toBe(true)
    // 拼出来的 toolset URL 不能出现 `downloadv…` 这种畸形段。
    expect(`${normalized}winCodeSign-2.6.0/winCodeSign-2.6.0.7z`).not.toMatch(/downloadv/)
  })

  it('**npm 上下文里 `.npmrc` 优先**（这正是「`npm ci` 不炸、打包才炸」的原因）', async () => {
    const mirror = readWorkflowEnv('ci.yml', 'ELECTRON_MIRROR')
    const npmMirror = 'https://npmmirror.com/mirrors/electron/'
    const url = await withEnv(
      { ELECTRON_MIRROR: mirror, npm_config_electron_mirror: npmMirror },
      () => artifactUtils.getArtifactRemoteURL({ ...ELECTRON_ARTIFACT }),
    )
    expect(url).toBe(`${npmMirror}v32.3.3/electron-v32.3.3-win32-x64.zip`)
    expect(url).not.toContain('github.com')
  })

  it('两个工作流的镜像变量**必须一致**（不能各写各的）', () => {
    expect(readWorkflowEnv('release.yml', 'ELECTRON_MIRROR')).toBe(
      readWorkflowEnv('ci.yml', 'ELECTRON_MIRROR'),
    )
    expect(readWorkflowEnv('release.yml', 'ELECTRON_BUILDER_BINARIES_MIRROR')).toBe(
      readWorkflowEnv('ci.yml', 'ELECTRON_BUILDER_BINARIES_MIRROR'),
    )
  })
})
