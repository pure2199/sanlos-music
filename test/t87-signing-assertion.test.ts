/**
 * @vitest-environment node
 */

// T87：构建期**签名断言加严**（`--expect valid` / `--require-timestamp` / `--expect-cn`）。
//
// ⚠️ **为什么这个文件跑在 node 环境**（而不是仓库默认的 jsdom）：
//    jsdom 的全局 `TextEncoder` 造出来的 `Uint8Array` **跨 realm**
//    ⇒ esbuild 的启动自检（`new TextEncoder().encode("") instanceof Uint8Array`）
//    在 jsdom 下**必然失败** ⇒ 工具里的 esbuild 加载会抛错。
//    而这个工具本来就是 **Node 脚本**（真实运行时就是纯 node）⇒ 用 node 环境测它。
//
// ---------------------------------------------------------------------------
// 为什么要有这个测试
// ---------------------------------------------------------------------------
// ① 这套断言是**发布闸门**（CI 里「不过 ⇒ 不发版」）⇒ 判定必须**可复核**，
//    不能只能靠「跑一次看看」。
// ② `--expect-cn` 的匹配口径**必须与客户端那套是同一份**（`shared/update.ts`）——
//    「同一套判定两边各写一遍」= 语义漂移 = **静默失效**（T85 的事故就是这么来的）。
//    ⇒ 这里既跑**行为一致性**，也钉**源码结构**（它真的在调用 shared，而不是抄一份）。
// ③ `--expect signed` / `--expect none` / `--expect-signer` / `--pfx` 是
//    **T86 的老语义** ⇒ 加严**不许**顺手把它们也改了（那会让老调用方的行为漂移）。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePowerShellFailure, evaluateSignature, powershellEnv } from '../tools/fn-check-signature.mjs'
import type { SignatureProbeInfo } from '../tools/fn-check-signature.mjs'
import { extractCommonNames, matchesExpectedSigner, parseSignerCandidates } from '../shared/update'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一张「真实公开 OV 证书」长什么样的 Subject（SignPath Foundation 的形态）。 */
const SIGNPATH_SUBJECT = 'CN=SignPath Foundation, O=SignPath Foundation GmbH, C=AT'

/** 造一个探测结果（默认 = 一份「签好了、带时间戳、状态 Valid」的产物）。 */
function probe(overrides: Partial<SignatureProbeInfo> = {}): SignatureProbeInfo {
  return {
    status: 'Valid',
    signer: SIGNPATH_SUBJECT,
    thumbprint: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678',
    hasTimestamp: true,
    timeStamper: 'CN=TS Root, O=DigiCert',
    ...overrides,
  }
}

describe('T87 签名断言 —— 状态必须 Valid', () => {
  it('`Valid` ⇒ 通过', () => {
    expect(evaluateSignature(probe(), { expect: 'valid' })).toEqual([])
  })

  it.each([
    ['HashMismatch', '文件被改过'],
    ['NotSigned', '根本没签'],
    ['NotTrusted', '签名者不受信任'],
    ['Expired', '证书已过期'],
    ['UnknownError', '探测不出来'],
  ])('状态 `%s`（%s）⇒ **失败**', (status) => {
    const problems = evaluateSignature(probe({ status }), { expect: 'valid' })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join('|')).toContain('Valid')
  })

  it('`--expect signed` 的**老语义不变**（只查「不是 NotSigned」）', () => {
    // ⚠️ `HashMismatch` 在老语义下**不算没签名** ⇒ 依然放行。
    //    这条钉住「加严没有顺手改掉老选项」。
    expect(evaluateSignature(probe({ status: 'HashMismatch' }), { expect: 'signed' })).toEqual([])
    expect(evaluateSignature(probe({ status: 'NotSigned' }), { expect: 'signed' }).length).toBeGreaterThan(0)
  })

  it('`--expect none` 的**老语义不变**', () => {
    expect(evaluateSignature(probe({ status: 'NotSigned', signer: null }), { expect: 'none' })).toEqual([])
    expect(evaluateSignature(probe(), { expect: 'none' }).length).toBeGreaterThan(0)
  })
})

describe('T87 签名断言 —— 必须带 RFC 3161 时间戳', () => {
  it('有时间戳 ⇒ 通过', () => {
    expect(evaluateSignature(probe(), { requireTimestamp: true })).toEqual([])
  })

  it('没有时间戳 ⇒ **失败**（证书到期后历史包会集体失效）', () => {
    const problems = evaluateSignature(probe({ hasTimestamp: false }), { requireTimestamp: true })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join('|')).toContain('时间戳')
  })

  it('没签名的产物 ⇒ 必然没有时间戳 ⇒ **失败**', () => {
    const info = probe({ status: 'NotSigned', signer: null, hasTimestamp: false })
    expect(evaluateSignature(info, { requireTimestamp: true }).length).toBeGreaterThan(0)
  })
})

describe('T87 签名断言 —— 按 CN 相等匹配', () => {
  it('CN 相等 ⇒ 通过（真实证书 Subject 带 O / C 也能过）', () => {
    expect(evaluateSignature(probe(), { expectCn: 'SignPath Foundation' })).toEqual([])
  })

  it('写成 `CN=SignPath Foundation` ⇒ 也通过（自动去掉 CN= 前缀）', () => {
    expect(evaluateSignature(probe(), { expectCn: 'CN=SignPath Foundation' })).toEqual([])
  })

  it('**绝不做「包含」匹配** —— `CN=SignPath Foundation Evil` ⇒ 失败', () => {
    const info = probe({ signer: 'CN=SignPath Foundation Evil, O=Evil Inc, C=CN' })
    const problems = evaluateSignature(info, { expectCn: 'SignPath Foundation' })
    expect(problems.length).toBeGreaterThan(0)
  })

  it('只命中 O（组织）不算数 ⇒ 失败', () => {
    const info = probe({ signer: 'O=SignPath Foundation, C=AT' })
    expect(evaluateSignature(info, { expectCn: 'SignPath Foundation' }).length).toBeGreaterThan(0)
  })

  it('多个候选（逗号分隔）⇒ 命中任一即通过', () => {
    expect(evaluateSignature(probe(), { expectCn: 'Some Other CA, SignPath Foundation' })).toEqual([])
    expect(evaluateSignature(probe(), { expectCn: 'Some Other CA, Certum' }).length).toBeGreaterThan(0)
  })

  it('没签名的产物 ⇒ 无法核对 CN ⇒ **失败**', () => {
    const info = probe({ status: 'NotSigned', signer: null })
    expect(evaluateSignature(info, { expectCn: 'SignPath Foundation' }).length).toBeGreaterThan(0)
  })

  it('候选解析不出来（全是空白）⇒ **失败**（不许悄悄放行）', () => {
    const problems = evaluateSignature(probe(), { expectCn: '   ' })
    expect(problems.length).toBeGreaterThan(0)
  })

  it('给了**空值**（`--expect-cn ""`）⇒ **失败**（不许因为空值就静默跳过检查）', () => {
    expect(evaluateSignature(probe(), { expectCn: '' }).length).toBeGreaterThan(0)
  })

  it('给了**空值**（`--expect-signer ""`）⇒ **失败**（同上）', () => {
    expect(evaluateSignature(probe(), { expectSigner: '' }).length).toBeGreaterThan(0)
  })

  it('`--expect-signer` 的**老语义不变**（整串相等，不是 CN 口径）', () => {
    // 只有 CN 相同、整串不同 ⇒ 老语义下**不通过**。
    expect(evaluateSignature(probe(), { expectSigner: 'SignPath Foundation' }).length).toBeGreaterThan(0)
    expect(evaluateSignature(probe(), { expectSigner: SIGNPATH_SUBJECT })).toEqual([])
  })

  it('`.pfx` 核对的老语义不变（整串相等）', () => {
    expect(evaluateSignature(probe(), { pfxSubject: SIGNPATH_SUBJECT })).toEqual([])
    expect(evaluateSignature(probe(), { pfxSubject: 'CN=别的证书' }).length).toBeGreaterThan(0)
  })
})

describe('T87 签名断言 —— 与客户端**共用同一套**匹配口径', () => {
  // ⚠️ 这是本文件**最关键**的一条：
  //    工具（构建期）与客户端（运行期）必须对同一批样本给出**同一个结论**。
  //    如果哪天有人在工具里「顺手再写一份」CN 逻辑，这条会立刻红。
  const SAMPLES: SignatureProbeInfo[] = [
    probe(),
    probe({ signer: 'CN=SignPath Foundation' }),
    probe({ signer: 'CN=SignPath Foundation Evil, O=Evil Inc' }),
    probe({ signer: 'O=SignPath Foundation, C=AT' }),
    probe({ signer: 'CN=signpath foundation, O=X' }),
    probe({ signer: 'CN=SignPath Foundation, O=SignPath Foundation GmbH, C=AT' }),
    probe({ signer: 'CN=Certum Code Signing, O=Certum' }),
    probe({ signer: '' }),
  ]

  it('工具的 CN 判定结果 == `shared/update.ts` 的 `matchesExpectedSigner`', () => {
    for (const info of SAMPLES) {
      const toolPassed = evaluateSignature(info, { expectCn: 'SignPath Foundation' }).length === 0
      const sharedPassed = matchesExpectedSigner(info.signer ?? '', 'SignPath Foundation')
      expect({ signer: info.signer, toolPassed }).toEqual({ signer: info.signer, toolPassed: sharedPassed })
    }
  })

  it('工具转发的候选集 == shared 的 `parseSignerCandidates`', () => {
    const candidates = parseSignerCandidates('SignPath Foundation, CN=Certum')
    expect(candidates).toEqual(['SignPath Foundation', 'Certum'])
    expect(extractCommonNames(SIGNPATH_SUBJECT)).toEqual(['SignPath Foundation'])
  })

  it('工具源码**真的在调用** shared（而不是抄一份逻辑）', () => {
    const src = readFileSync(join(REPO_ROOT, 'tools', 'fn-check-signature.mjs'), 'utf8')
    expect(src).toContain('shared/update.ts')
    expect(src).toContain('getSharedSigning')
    expect(src).toContain('matchesExpectedSigner')
    expect(src).toContain('parseSignerCandidates')
  })

  it('工具源码里**探测了时间戳**（不是靠猜）', () => {
    const src = readFileSync(join(REPO_ROOT, 'tools', 'fn-check-signature.mjs'), 'utf8')
    expect(src).toContain('TimeStamperCertificate')
    expect(src).toContain('hasTimestamp')
    expect(src).toContain("'--require-timestamp'")
    expect(src).toContain("'--expect-cn'")
  })
})

describe('T87 打包脚本适配 CI', () => {
  const packSrc = readFileSync(join(REPO_ROOT, 'scripts', 'pack.cjs'), 'utf8')

  it('**关掉证书自动发现**（本机装了证书也会自动签 ⇒ 结果不可预期）', () => {
    expect(packSrc).toContain('CSC_IDENTITY_AUTO_DISCOVERY')
    expect(packSrc).toContain('FNM_CSC_AUTO_DISCOVERY')
    // ⚠️ 默认必须是「关」—— 只有显式 `=1` 才打开。
    expect(packSrc).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY:\s*process\.env\.FNM_CSC_AUTO_DISCOVERY\s*===\s*'1'\s*\?\s*'true'\s*:\s*'false'/)
  })

  it('加严断言由 `FNM_EXPECT_SIGNER_CN` 开关控制（默认关 ⇒ 老行为一字不变）', () => {
    expect(packSrc).toContain('FNM_EXPECT_SIGNER_CN')
    expect(packSrc).toContain("'--require-timestamp'")
    expect(packSrc).toContain("'--expect-cn'")
    expect(packSrc).toContain("'--expect', 'valid'")
    // ⚠️ 老路径（没设开关）仍然是 `--expect signed`。
    expect(packSrc).toContain("'--expect', 'signed'")
  })

  it('CI 的输出目录 `release-ci/` 已被忽略（本地试跑不脏仓库）', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/^release-ci\/$/m)
  })

  it('`electron-builder.yml` **显式**钉了时间戳源（不靠默认值），且**写在合法位置**', () => {
    // ⚠️ **行尾归一化到 LF**：Windows runner 检出后是 **CRLF**（`core.autocrlf=true`），
    //    而本机可能是 LF ⇒ 直接对原文做「按行」的正则会**在 CI 上莫名其妙地不匹配**
    //    （2026-11-10 实测：两条 workflow 都因此挂在「Unit tests」）。
    const yml = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
    // ① 两种时间戳源都要显式写出来（传统 `/t` + RFC 3161 `/tr`）。
    expect(yml).toContain('timeStampServer: http://timestamp.digicert.com')
    expect(yml).toContain('rfc3161TimeStampServer: http://timestamp.digicert.com')
    // ② ⚠️ **必须在 `win.signtoolOptions` 下面**（T87.8 修订）。
    //    写在 `win` 顶层是**非法键** ⇒ electron-builder 的配置校验**直接失败**
    //    ⇒ **整个打包挂掉**（2026-11-10 实测：CI run 42857375893 死在这一行）。
    expect(yml).toMatch(/^ {2}signtoolOptions:\n(?: {4}\S.*\n)+/m)
    // ③ `win` 顶层**不许**再出现时间戳源（那正是上面的非法键）。
    expect(yml).not.toMatch(/^ {2}timeStampServer:/m)
    expect(yml).not.toMatch(/^ {2}rfc3161TimeStampServer:/m)
  })
})

describe('T87 签名断言 —— CLI 层', () => {
  const tool = join(REPO_ROOT, 'tools', 'fn-check-signature.mjs')

  it('`--help` ⇒ 退出码 0，且**列出新选项**', () => {
    const result = spawnSync(process.execPath, [tool, '--help'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--require-timestamp')
    expect(result.stdout).toContain('--expect-cn')
    expect(result.stdout).toContain('valid')
  })

  it('目标里没有 .exe ⇒ 退出码 1（不许「没东西可查」就当通过）', () => {
    const result = spawnSync(
      process.execPath,
      [tool, '--expect', 'signed', join(REPO_ROOT, '不存在的目录-xyz')],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('没找到任何 .exe')
  })

  it('没有目标 ⇒ 退出码 1', () => {
    const result = spawnSync(process.execPath, [tool], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('没有要检查的目标')
  })

  it('`--expect` 的值**拼错** ⇒ 退出码 1（fail-closed：不许「什么都不检查就通过」）', () => {
    const result = spawnSync(
      process.execPath,
      [tool, '--expect', 'valeid', join(REPO_ROOT, '不存在的目录-xyz')],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未知的 --expect 值')
  })
})

// ---------------------------------------------------------------------------
// T87.11-b：CI 上的 PowerShell 模块加载 + 「探测失败 ≠ 有签名」
// ---------------------------------------------------------------------------
//
// ⚠️ **背景**：Release run `42901166145`（#6）在 `Verify unsigned artifacts` 失败。
//    CI 上 Windows PowerShell 5.1 加载不了 `Microsoft.PowerShell.Security`
//    （runner 默认 shell 是 pwsh 7 ⇒ `PSModulePath` 指向 PS7 的模块目录
//    ⇒ 5.1 找到同名但为 .NET Core 编译的模块 ⇒ `CouldNotAutoloadMatchingModule`）
//    ⇒ 3 个产物全部「探测失败」⇒ Release 没建出来。
//
// ⚠️ **本机复现不出来**（本机只有 5.1、PSModulePath 正常）⇒
//    ① 行为面钉「`powershellEnv` 的前置顺序」；
//    ② 结构面钉「源码里必须有 `$PSHOME` 绝对路径导入 + 前置系统模块目录」；
//    ③ 再加一条**真跑一次**的端到端（CI 上跑 ⇒ 就是这次的回归网）。
//
// ⚠️ **纪律**：本节只**追加**；既有断言一条不删、一条不削弱。

describe('T87.11-b —— 签名探测在 CI 上的两个坑', () => {
  const tool = join(REPO_ROOT, 'tools', 'fn-check-signature.mjs')
  const toolSrc = readFileSync(tool, 'utf8')

  describe('① PowerShell 5.1 加载不了安全模块', () => {
    it('**按 `$PSHOME` 绝对路径**显式导入安全模块（绕开 PSModulePath 的搜索顺序）', () => {
      expect(toolSrc).toContain('$PSHOME')
      expect(toolSrc).toContain('Microsoft.PowerShell.Security.psd1')
      expect(toolSrc).toContain('Import-Module')
    })

    it('子进程的 `PSModulePath` **前置** 5.1 自己的系统模块目录', () => {
      const sysModules = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'system32',
        'WindowsPowerShell',
        'v1.0',
        'Modules',
      )
      const env = powershellEnv({ ...process.env, PSModulePath: 'ZZZ-TAIL' })
      // ⚠️ **前置**（第一段就是它）⇒ 5.1 先找到自己那份 ⇒ 自动加载成功。
      expect(env.PSModulePath?.startsWith(sysModules)).toBe(true)
      // ⚠️ 别的路径**不许被替换掉**（用户模块、PS7 的模块…可能还有用）。
      expect(env.PSModulePath).toContain('ZZZ-TAIL')
    })

    it('**没有** `PSModulePath` 时也能补上系统模块目录', () => {
      const env = powershellEnv({ SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' })
      expect(env.PSModulePath).toContain('WindowsPowerShell')
    })

    it('PowerShell 的失败信息**降噪**（不许把整条 base64 命令行塞进报错）', () => {
      const cause = Object.assign(
        new Error('Command failed: powershell.exe -NoProfile -EncodedCommand Q0xJW01MLAAAAA'),
        { status: 1, stderr: 'Get-AuthenticodeSignature : module could not be loaded\n' },
      )
      const text = describePowerShellFailure(cause)
      expect(text).toContain('退出码 1')
      expect(text).toContain('could not be loaded')
      // ⚠️ 命令行（那段 base64）**不许**出现在报错里 ⇒ 真原因才看得见。
      expect(text).not.toContain('Q0xJW01MLAAAAA')
    })
  })

  describe('② 探测失败 ≠ 「有签名」', () => {
    const failed = probe({ status: 'UnknownError', signer: null, hasTimestamp: false, probeFailed: true })

    it('**探测失败** ⇒ 报「探测失败」，**不许**说成「有签名」', () => {
      for (const options of [
        { expect: 'none' },
        { expect: 'valid' },
        { expect: 'signed' },
        { expectCn: 'SignPath Foundation' },
      ]) {
        const problems = evaluateSignature(failed, options)
        expect(problems.length).toBeGreaterThan(0)
        expect(problems.join('|')).toContain('探测失败')
        // ⚠️ **不许**出现「有签名」—— 那是「探不出来」的**反向**说法。
        expect(problems.join('|')).not.toContain('有签名')
      }
    })

    it('**探测失败** ⇒ 闸门**仍然失败**（fail-closed 一条不许松）', () => {
      expect(evaluateSignature(failed, { expect: 'none' }).length).toBeGreaterThan(0)
      expect(evaluateSignature(failed, { expect: 'valid' }).length).toBeGreaterThan(0)
    })

    it('**没打 `probeFailed` 标记** ⇒ 老语义一字不变', () => {
      // ⚠️ 既有语义：`UnknownError` 在 `--expect valid` 下仍然算失败（且仍报 Valid）。
      expect(evaluateSignature(probe({ status: 'UnknownError' }), { expect: 'valid' }).join('|')).toContain(
        'Valid',
      )
      // `--expect none` + 真的没签名 ⇒ 依旧放行。
      expect(evaluateSignature(probe({ status: 'NotSigned', signer: null }), { expect: 'none' })).toEqual([])
    })
  })

  describe('③ 端到端：真跑一次探测', () => {
    // ⚠️ 夹具用 esbuild 的二进制（**未签名**、只有 ~11 MB，比 electron.exe 小得多）。
    const fixture = join(REPO_ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
    const hasFixture = process.platform === 'win32' && existsSync(fixture)

    it.skipIf(!hasFixture)('未签名的 exe ⇒ `--expect none` 通过（CI 上这就是回归网）', () => {
      const result = spawnSync(process.execPath, [tool, '--expect', 'none', fixture], { encoding: 'utf8' })
      expect(result.stderr).not.toContain('探测失败')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('NotSigned')
    })
  })
})
