/**
 * @vitest-environment node
 */

// T87.8：**打包配置**也必须有守卫（`electron-builder.yml` 的键必须合法）。
//
// ⚠️ **为什么要有这个文件**：T87 在 `electron-builder.yml` 里加了一行
//    `win.timeStampServer` —— 它**不是** electron-builder 26.18.0 的合法键
//    ⇒ 配置校验**直接失败** ⇒ **整个打包挂掉**。
//    而两道本该拦住它的关卡都没拦住：
//      ① 本地 T87 的验证清单里**没有 `npm run pack`**（只验了 tsc/vitest/build/e2e）；
//      ② `ci.yml` 只跑 typecheck / test / build ⇒ **根本不打包**。
//    ⇒ 直到发版工作流才炸（run 42857375893，失败在第 8 步 `Pack`）。
//    ⇒ 这里把「配置非法键」从「发版时才发现」变成「**`npm test` 就红**」。
//
// ⚠️ **不自己写 schema 校验器**：直接调 **electron-builder 自己的**
//    `getConfig`（它自己的 YAML 解析 + 配置合并）+ `validateConfiguration`
//    （**它自己的** schema）⇒ 判定口径与真正打包时**是同一份**
//    ⇒ 不会出现「自己写的校验器漏判，于是照样放行」。
//
// ⚠️ **为什么跑在 node 环境**：要 `require()` electron-builder 的 CommonJS 产物
//    （vitest 默认的 jsdom 环境没有 CommonJS 的 `require` / `__dirname` 语义）。

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

interface BuilderConfigModule {
  getConfig: (
    projectDir: string,
    configPath: string | null,
    configFromOptions: unknown,
  ) => Promise<Record<string, unknown>>
  validateConfiguration: (
    config: Record<string, unknown>,
    debugLogger: { isEnabled: boolean; add: (name: string, value: string) => void },
  ) => Promise<void>
}

// ⚠️ 内部路径（`out/`）：electron-builder 锁死版本（26.18.0）⇒ 路径稳定；
//    万一将来变了，这条测试会**响亮地失败**（而不是静默跳过 ⇒ 守卫失效）。
const builderConfig = require('app-builder-lib/out/util/config/config.js') as BuilderConfigModule

/** electron-builder 的 `debugLogger` 只需要这两个成员。 */
const NOOP_LOGGER = { isEnabled: false, add: () => {} }

/** 用 electron-builder **自己**的加载器 + **它自己的** schema 校验一份配置文件。 */
async function validateConfigFile(configPath: string): Promise<void> {
  const config = await builderConfig.getConfig(REPO_ROOT, configPath, null)
  await builderConfig.validateConfiguration(config, NOOP_LOGGER)
}

describe('T87.8 —— 打包配置的守卫', () => {
  it('`electron-builder.yml` **能通过 electron-builder 自己的 schema 校验**', async () => {
    // ⚠️ 这一条就是「整个打包挂掉」的那道闸：配置不合法 ⇒ 这里就红。
    await expect(
      validateConfigFile(join(REPO_ROOT, 'electron-builder.yml')),
    ).resolves.toBeUndefined()
  })

  it('**非法键必被拒**（变异自证：把 `win.timeStampServer` 塞回去 ⇒ 必须失败）', async () => {
    const original = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    // ⚠️ 复刻 2026-11-10 那次失败：`win` **顶层**多一行 `timeStampServer`。
    const mutated = original.replace(
      /^win:\n/m,
      'win:\n  timeStampServer: http://timestamp.digicert.com\n',
    )
    // 变异必须真的改到了东西（否则下面的「必被拒」就是在验一个没变过的文件）。
    expect(mutated).not.toBe(original)
    expect(mutated).toMatch(/^ {2}timeStampServer:/m)

    const dir = mkdtempSync(join(tmpdir(), 'fnm-builder-config-'))
    const file = join(dir, 'electron-builder.yml')
    writeFileSync(file, mutated, 'utf8')

    await expect(validateConfigFile(file)).rejects.toThrow(/Invalid configuration object/)
  })

  it('**时间戳源写在 `win.signtoolOptions` 下**（合法位置）', () => {
    const yml = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^ {2}signtoolOptions:\n(?: {4}\S.*\n)+/m)
    expect(yml).toContain('timeStampServer: http://timestamp.digicert.com')
    expect(yml).toContain('rfc3161TimeStampServer: http://timestamp.digicert.com')
  })
})
