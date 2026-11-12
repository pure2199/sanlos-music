/**
 * @vitest-environment node
 */

// T87：发版工作流（CI 打包 → SignPath 送签 → 人工审批 → 校验 → 发 Release）的契约。
//
// ---------------------------------------------------------------------------
// 为什么这些是**契约**（而不是「跑一次看看」）
// ---------------------------------------------------------------------------
// ① 工作流是 **YAML** ⇒ 单元测试跑不起来 ⇒ 只能钉**源码结构**：
//    「必须先查配置再送签」「必须用官方 Action」「必须跑加严断言」
//    「不许发失效的资产」—— 这些是**安全属性**，少一条就出事。
// ② `scripts/check-signpath-config.mjs` 是**真代码** ⇒ 直接跑它的函数（行为测试）。
// ③ 配错变量的后果是「**悄悄跳过签名照样发布**」⇒ 必须钉「缺一个就失败」。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_SIGNPATH_KEYS, checkSignPathConfig } from '../scripts/check-signpath-config.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读仓库里的一个文件。 */
function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8')
}

describe('T87 发版工作流 —— 结构', () => {
  const yml = readRepoFile('.github', 'workflows', 'release.yml')

  it('是**手动触发**的（`workflow_dispatch`），且有 `tag` 与 `pack_only` 两个输入', () => {
    expect(yml).toContain('workflow_dispatch:')
    expect(yml).toMatch(/^\s+tag:\s*$/m)
    expect(yml).toMatch(/^\s+pack_only:\s*$/m)
  })

  it('**先查配置再送签**（缺配置 ⇒ 快速失败，不做「跳过签名照样发布」）', () => {
    expect(yml).toContain('scripts/check-signpath-config.mjs')
    // ⚠️ 检查步骤必须**排在**送签步骤**之前**。
    const checkAt = yml.indexOf('check-signpath-config.mjs')
    const signAt = yml.indexOf('github-action-submit-signing-request')
    expect(checkAt).toBeGreaterThan(-1)
    expect(signAt).toBeGreaterThan(-1)
    expect(checkAt).toBeLessThan(signAt)
  })

  it('用 **SignPath 官方 Action**（不是自己手搓 REST 调用）', () => {
    expect(yml).toContain('signpath/github-action-submit-signing-request@')
    // ⚠️ 必须**钉版本**（不许用会漂的 `@main` / `@master`）。
    expect(yml).toMatch(/github-action-submit-signing-request@v\d/)
    // 关键输入一个都不能少。
    for (const input of [
      'api-token:',
      'organization-id:',
      'project-slug:',
      'signing-policy-slug:',
      'artifact-configuration-slug:',
      'github-artifact-id:',
    ]) {
      expect(yml).toContain(input)
    }
    // ⚠️ **人工审批** ⇒ 必须等它完成（Foundation 计划要求逐次人工批准）。
    expect(yml).toContain('wait-for-completion: true')
  })

  it('送签前跑的是**加严**断言（Valid + 时间戳 + CN）', () => {
    expect(yml).toContain('tools/fn-check-signature.mjs')
    expect(yml).toContain('--expect valid')
    expect(yml).toContain('--require-timestamp')
    expect(yml).toContain('--expect-cn')
  })

  it('打包**直接调 pack.cjs**（不跑 `npm run pack` —— 那会再 build 一次）', () => {
    expect(yml).toContain('run: node scripts/pack.cjs')
    expect(yml).not.toMatch(/run:\s*npm run pack/)
    // ⚠️ CI 的产物目录与打包脚本共用同一个变量。
    expect(yml).toContain('FNM_PACK_OUTPUT: release-ci')
  })

  it('**只发 3 个资产**（不发基于未签名 exe 算出来的 `latest.yml` / `blockmap`）', () => {
    // ⚠️ **只看「资产清单」那一段** —— 文件里提到 blockmap 的地方是
    //    「为什么不发它」的注释，不是清单。
    const start = yml.indexOf('$assets = @(')
    const end = yml.indexOf(')', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const list = yml.slice(start, end)
    expect(list).toContain('FN-Music-Setup-$version.exe')
    expect(list).toContain('FN-Music-Portable-$version.exe')
    expect(list).toContain('release-ci/latest.json')
    // ⚠️ **不许**把失效的资产发出去。
    expect(list).not.toContain('latest.yml')
    expect(list).not.toContain('blockmap')
    // ⚠️ 恰好 3 个（多一个少一个都要红）。
    expect(list.split('\n').filter((line) => line.includes('"release-ci/')).length).toBe(3)
  })

  it('用 **Node 22**（Node 26 上 electron 的 install.js 会挂起）', () => {
    expect(yml).toContain("node-version: '22'")
  })

  it('`pack_only` 关掉时才会送签 / 发版', () => {
    expect(yml).toContain('${{ !inputs.pack_only }}')
  })
})

describe('T87 SignPath artifact configuration', () => {
  const xml = readRepoFile('.signpath', 'artifact-configurations', 'default.xml')

  it('根元素是 `zip-file`（GitHub artifact 永远是 ZIP）', () => {
    expect(xml).toContain('<artifact-configuration')
    expect(xml).toContain('<zip-file>')
  })

  it('签**我们分发的两个产物**，且都用 `authenticode-sign`', () => {
    expect(xml).toContain('FN-Music-Setup-*.exe')
    expect(xml).toContain('FN-Music-Portable-*.exe')
    expect(xml.match(/<authenticode-sign \/>/g)?.length).toBe(2)
  })
})

describe('T87 SignPath 配置检查（快速失败）', () => {
  const FULL: Record<string, string> = {
    SIGNPATH_API_TOKEN: 'token',
    SIGNPATH_ORG_ID: 'org',
    SIGNPATH_PROJECT_SLUG: 'project',
    SIGNPATH_POLICY_SLUG: 'policy',
    SIGNPATH_ARTIFACT_SLUG: 'artifact',
  }

  it('配置齐全 ⇒ 通过', () => {
    const result = checkSignPathConfig(FULL)
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('缺一个 ⇒ 报出缺哪个', () => {
    const env = { ...FULL }
    delete env.SIGNPATH_POLICY_SLUG
    const result = checkSignPathConfig(env)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['SIGNPATH_POLICY_SLUG'])
  })

  it('**空字符串**也算缺（GitHub 上「配了但没值」就是空串）', () => {
    const result = checkSignPathConfig({ ...FULL, SIGNPATH_API_TOKEN: '   ' })
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('SIGNPATH_API_TOKEN')
  })

  it('**一个都不能少**（5 项）', () => {
    expect(REQUIRED_SIGNPATH_KEYS).toEqual([
      'SIGNPATH_API_TOKEN',
      'SIGNPATH_ORG_ID',
      'SIGNPATH_PROJECT_SLUG',
      'SIGNPATH_POLICY_SLUG',
      'SIGNPATH_ARTIFACT_SLUG',
    ])
    expect(checkSignPathConfig({}).missing.length).toBe(5)
  })

  it('CLI：缺配置 ⇒ **退出码 1** 且说清缺哪几个', () => {
    const script = join(REPO_ROOT, 'scripts', 'check-signpath-config.mjs')
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      // ⚠️ 显式清空这几个变量 ⇒ 模拟「GitHub 上没配」。
      env: { ...process.env, SIGNPATH_API_TOKEN: '', SIGNPATH_ORG_ID: '' },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('快速失败')
    expect(result.stderr).toContain('SIGNPATH_API_TOKEN')
  })
})

describe('T87 更新清单与产物目录', () => {
  it('`publish-manifest.mjs` 认 `FNM_PACK_OUTPUT`（CI 的产物在 `release-ci/`）', () => {
    const src = readRepoFile('scripts', 'publish-manifest.mjs')
    expect(src).toContain('FNM_PACK_OUTPUT')
    // ⚠️ 清单与安装包**必须同一个目录**（客户端拒绝跨源）。
    expect(src).toContain('RELEASE_DIR')
  })
})

// ---------------------------------------------------------------------------
// T87.10：工作流脚本里的**反引号**（2026-11-10 实测踩到）
// ---------------------------------------------------------------------------
//
// ⚠️ **现象**：Release run 42865707790 挂在第 10 步 `Summary (pack only)`：
//      ParserError: … The Unicode escape sequence is not valid.
//    ⇒ **PowerShell 的反引号是转义符** ⇒ 双引号字符串里的 Markdown 行内代码
//    （`unsigned-artifacts`）被当成「转义序列起始」⇒ **整个脚本解析失败**。
//
// ⚠️ **为什么这类坑会藏着**：那一步在 T87 就写好了，但此前**每一步都先挂**
//    （非法键 → CRLF → 404）⇒ 一直**没被执行到**。
//    ⇒ **跑不到的步骤等于没写** ⇒ 必须有守卫。
//
// ⚠️ **口径**：
//    - **PowerShell** 把 `` ` `` 当**转义符**；
//    - **bash** 把 `` ` `` 当**命令替换**；
//    ⇒ 两边都不许出现。**YAML 注释里可以有**（注释不会被 shell 执行）。

/**
 * 收集工作流里所有 `run:` 块里**非注释**的行。
 *
 * @param yml 工作流文件的原文
 * @returns 每个 `run:` 块里需要交给 shell 执行的行（已去注释、去空行）
 */
function collectRunBlockLines(yml: string): string[] {
  const out: string[] = []
  let inBlock = false
  let blockIndent = 0
  for (const raw of yml.split('\n')) {
    const indent = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (!inBlock) {
      const m = /^run:\s*(.*)$/.exec(trimmed)
      if (m) {
        const value = (m[1] ?? '').trim()
        if (value === '|' || value === '>') {
          // 块状（literal / folded）⇒ 收集到「缩进不大于 `run:` 的非空行」为止。
          inBlock = true
          blockIndent = indent
        } else {
          // 单行 `run: xxx` ⇒ 整行就是脚本。
          out.push(value)
        }
      }
      continue
    }
    // 块结束：下一个同级 key / 下一个 step（缩进不大于 `run:` 且非空）。
    if (trimmed && indent <= blockIndent) {
      inBlock = false
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) continue
    out.push(trimmed)
  }
  return out
}

describe('T87.10 —— 工作流脚本里的反引号', () => {
  const workflows = ['ci.yml', 'release.yml']

  it('所有工作流的 `run:` 块里**不许出现反引号**', () => {
    for (const name of workflows) {
      const yml = readRepoFile('.github', 'workflows', name)
      const bad = collectRunBlockLines(yml).filter((line) => line.includes('`'))
      expect(bad, `${name} 的 run 块里有反引号`).toEqual([])
    }
  })

  it('**变异自证**：把反引号塞回 `run:` 块 ⇒ 必被抓出来', () => {
    const yml = readRepoFile('.github', 'workflows', 'release.yml')
    const mutated = yml.replace(
      /^(\s*)echo '产物已上传为 artifact.*$/m,
      "$1echo '产物已上传为 artifact `unsigned-artifacts`（未签名）。' >> $env:GITHUB_STEP_SUMMARY",
    )
    // 变异必须真的改到了东西（否则下面的断言就是在验一个没变过的文件）。
    expect(mutated).not.toBe(yml)
    const bad = collectRunBlockLines(mutated).filter((line) => line.includes('`'))
    expect(bad.length).toBeGreaterThan(0)
  })

  it('Summary 步骤的字符串**用单引号**（PowerShell 单引号里没有转义语义）', () => {
    const yml = readRepoFile('.github', 'workflows', 'release.yml')
    const lines = collectRunBlockLines(yml)
    const summaryLines = lines.filter((line) => line.includes('GITHUB_STEP_SUMMARY'))
    expect(summaryLines.length).toBeGreaterThan(0)
    for (const line of summaryLines) {
      // ⚠️ 一律单引号：双引号里 PowerShell 会展开 `$` 与反引号 ⇒ 容易出「看着像 Markdown
      //    其实被 shell 解释」的坑。
      expect(line).not.toMatch(/echo\s+"/)
    }
  })
})

// ---------------------------------------------------------------------------
// T87.11：未签名发布路径（2026-11-11）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这条路径**：SignPath Foundation 的申请 2026-11-11 已提交，
//    批不批、何时批**不由我们决定** ⇒ 发版不能被外部审核无限期卡住。
//    ⇒ v0.2.5 以**未签名**形式发布。
//
// ⚠️ **纪律**：既有断言一条不删、一条不削弱；本节只**追加**。
//    且「未签名」必须是**构建期事实**（机械断言），不是文档里的口头承诺。

/**
 * 从工作流原文里取出某个 step 的文本块（从 `- name: X` 到下一个 `- name:`）。
 *
 * @param yml 工作流原文
 * @param name step 的名字
 * @returns 该 step 的完整文本
 */
function stepBlock(yml: string, name: string): string {
  const marker = `- name: ${name}`
  const start = yml.indexOf(marker)
  if (start < 0) throw new Error(`找不到步骤：${name}`)
  const next = yml.indexOf('\n      - name:', start)
  return next < 0 ? yml.slice(start) : yml.slice(start, next)
}

/** 取出某个 step 里的 `UPDATE_NOTES` 值（单引号包裹的那一段）。 */
function updateNotesOf(block: string): string {
  const matched = block.match(/UPDATE_NOTES: '([^']*)'/)
  return matched?.[1] ?? ''
}

describe('T87.11 —— 未签名发布路径', () => {
  const yml = readRepoFile('.github', 'workflows', 'release.yml')

  it('有 `sign` 输入，且**默认 true**（签名是默认路径，未签名必须显式关掉）', () => {
    const inputs = yml.slice(yml.indexOf('workflow_dispatch:'), yml.indexOf('concurrency:'))
    expect(inputs).toMatch(/^\s+sign:\s*$/m)
    const signBlock = inputs.slice(inputs.indexOf('\n      sign:'))
    expect(signBlock).toContain('default: true')
    expect(signBlock).toContain('type: boolean')
  })

  it('**未签名路径必须断言产物确实没有签名**（不是口头承诺）', () => {
    const block = stepBlock(yml, 'Verify unsigned artifacts')
    expect(block).toContain('if: ${{ !inputs.pack_only && !inputs.sign }}')
    expect(block).toContain('--expect none')
    expect(block).toContain('release-ci')
  })

  it('**签名路径仍然加严**（Valid + 时间戳 + CN 一条不少）', () => {
    const block = stepBlock(yml, 'Verify signed artifact')
    expect(block).toContain('if: ${{ !inputs.pack_only && inputs.sign }}')
    expect(block).toContain('--expect valid')
    expect(block).toContain('--require-timestamp')
    expect(block).toContain('--expect-cn')
  })

  it('清单生成**排在替换签名件之后**（否则清单算的是未签名 exe 的哈希）', () => {
    // ⚠️ 比的是**步骤位置**，不是 `publish-manifest.mjs` 这个字符串的位置
    //    —— 文件头的注释里也出现过它。
    const replaceAt = yml.indexOf('- name: Replace artifacts with signed ones')
    const manifestAt = yml.indexOf('- name: Write update manifest (signed)')
    expect(replaceAt).toBeGreaterThan(-1)
    expect(manifestAt).toBeGreaterThan(-1)
    expect(manifestAt).toBeGreaterThan(replaceAt)
  })

  it('两种模式**各有各的清单步骤**（未签名路径不许复用签名路径那步）', () => {
    expect(stepBlock(yml, 'Write update manifest (signed)')).toContain(
      'if: ${{ !inputs.pack_only && inputs.sign }}',
    )
    expect(stepBlock(yml, 'Write update manifest (unsigned)')).toContain(
      'if: ${{ !inputs.pack_only && !inputs.sign }}',
    )
  })

  it('**未签名的 notes 里不许出现「已签名 / SignPath」**（这一版确实没签）', () => {
    const notes = updateNotesOf(stepBlock(yml, 'Write update manifest (unsigned)'))
    expect(notes).toContain('未做代码签名')
    expect(notes).not.toContain('SignPath')
    expect(notes).not.toContain('已由')
  })

  it('**变异自证**：把未签名的 notes 改成声称已签名 ⇒ 必被抓出来', () => {
    const mutated = yml.replace(
      /UPDATE_NOTES: '本版未做代码签名[^']*'/,
      "UPDATE_NOTES: '安装包已由 SignPath Foundation 签名（Authenticode，含 RFC 3161 时间戳）。'",
    )
    // 变异必须真的改到了东西（否则下面的断言就是在验一个没变过的文件）。
    expect(mutated).not.toBe(yml)
    const notes = updateNotesOf(stepBlock(mutated, 'Write update manifest (unsigned)'))
    expect(notes).toContain('SignPath')
    expect(notes).not.toContain('未做代码签名')
  })

  it('Release 说明**由工作流附上 sha256 与字节数**（本机没有 gh，只能这样）', () => {
    const block = stepBlock(yml, 'Prepare release notes with checksums')
    expect(block).toContain('Get-FileHash')
    expect(block).toContain('SHA256')
    expect(block).toContain('RUNNER_TEMP')
    // 发布那一步**必须**用这份带校验值的说明。
    const publish = stepBlock(yml, 'Publish GitHub Release')
    expect(publish).toContain("Join-Path $env:RUNNER_TEMP 'release-notes.md'")
    expect(publish).toContain('--notes-file $notesFile')
  })

  it('**编码必须显式指定**（PS 5.1 默认按控制台代码页读 ⇒ 中文会乱码）', () => {
    const block = stepBlock(yml, 'Prepare release notes with checksums')
    expect(block).toContain('-Encoding UTF8')
    expect(block).toContain('UTF8Encoding($false)')
  })

  it('**行尾统一成 LF**（`docs/releases/*.md` 是 LF；Windows 的 `NewLine` 是 CRLF ⇒ 会混行尾）', () => {
    const block = stepBlock(yml, 'Prepare release notes with checksums')
    // ⚠️ 只看**可执行行**（注释里可以提到被弃用的写法）。
    const exec = collectRunBlockLines(block).join('\n')
    expect(exec).toContain('$nl = [string][char]10')
    expect(exec).not.toContain('[Environment]::NewLine')
    // ⚠️ 不许用反引号转义（`` "`n" ``）—— PowerShell 的反引号是转义符。
    expect(collectRunBlockLines(block).filter((line) => line.includes('`'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T87.17：构建来源证明（attestation）
// ---------------------------------------------------------------------------
//
// ⚠️ **背景**：SignPath Foundation 的申请已被拒（可见度不足）⇒ 公开产物**长期没有**
//    Authenticode 签名 ⇒ 「发布者身份」这一层由 **GitHub attestation**
//    （SLSA build provenance，Sigstore 签发）承担。
//
// ⚠️ **为什么这些必须是契约**：这一步被改坏（顺序错 / subject 漏了 / 权限没了）
//    **不会**让工作流失败 ⇒ 发出去的是「验不了来源」的产物，而页面上看不出差别
//    ⇒ 必须把结构钉死。
//
// ⚠️ **纪律**：既有断言一条不删、一条不削弱；本节只**追加**。

describe('T87.17 —— 构建来源证明（attestation）', () => {
  const yml = readRepoFile('.github', 'workflows', 'release.yml')

  /** 取出 attestation 步骤的 `subject-path` 值。 */
  const subjectOf = (text: string): string =>
    stepBlock(text, 'Attest build provenance').match(/subject-path: '([^']*)'/)?.[1] ?? ''

  /** subject 是否覆盖了两个 exe（`release-ci/*.exe`）。 */
  const coversExe = (text: string): boolean => subjectOf(text).includes('release-ci/*.exe')

  it('job 权限里有 `id-token: write` 与 `attestations: write`（少一个就签不出来）', () => {
    const permissionsAt = yml.indexOf('\npermissions:')
    expect(permissionsAt).toBeGreaterThan(-1)
    const block = yml.slice(permissionsAt, yml.indexOf('\njobs:'))
    expect(block).toContain('id-token: write')
    expect(block).toContain('attestations: write')
  })

  it('用**官方 Action**且**钉版本**（不许用会漂的 @main / @master）', () => {
    expect(yml).toContain('actions/attest@v')
    expect(yml).not.toMatch(/actions\/attest[a-z-]*@(main|master)/)
  })

  it('subject 覆盖**两个 exe + 更新清单**（清单也是公开资产）', () => {
    const subject = subjectOf(yml)
    expect(subject).toContain('release-ci/*.exe')
    expect(subject).toContain('release-ci/latest.json')
  })

  it('**两条路径都签发**（签过名的也签 —— 不冲突、不重复）', () => {
    expect(stepBlock(yml, 'Attest build provenance')).toContain('if: ${{ !inputs.pack_only }}')
  })

  it('**必须排在产物定版之后**：清单生成之后、发 Release 之前', () => {
    // ⚠️ 比的是**步骤位置**。签名路径的清单步骤在未签名路径之前 ⇒
    //    排在未签名那步之后就同时满足了两条路径。
    const manifestAt = yml.indexOf('- name: Write update manifest (unsigned)')
    const attestAt = yml.indexOf('- name: Attest build provenance')
    const publishAt = yml.indexOf('- name: Publish GitHub Release')
    expect(manifestAt).toBeGreaterThan(-1)
    expect(attestAt).toBeGreaterThan(manifestAt)
    expect(publishAt).toBeGreaterThan(attestAt)
  })

  it('Release 说明**按实际形态**写（不许写死「已签名」或「没签名」）', () => {
    const block = stepBlock(yml, 'Prepare release notes with checksums')
    expect(block).toContain('SIGNED: ${{ inputs.sign }}')
    expect(block).toContain("if ($env:SIGNED -eq 'true')")
    // 两种形态各有一段文案。
    expect(block).toContain('本版**已**做 Authenticode 代码签名')
    expect(block).toContain('**本版没有代码签名**')
  })

  it('attestation 的页面地址进 Release 说明（用户得知道去哪验）', () => {
    const block = stepBlock(yml, 'Prepare release notes with checksums')
    expect(block).toContain('ATTEST_URL:')
    expect(block).toContain('$env:ATTEST_URL')
  })

  it('**变异自证**：把 subject 改成不含 exe ⇒ 必被抓出来', () => {
    const mutated = yml.replace(
      /subject-path: '[^']*'/,
      "subject-path: '${{ github.workspace }}/release-ci/latest.json'",
    )
    // 变异必须真的改到了东西（否则下面的断言就是在验一个没变过的文件）。
    expect(mutated).not.toBe(yml)
    // 用**同一套判定**跑变异体 ⇒ 必须判不通过（否则这个守卫是摆设）。
    expect(coversExe(yml)).toBe(true)
    expect(coversExe(mutated)).toBe(false)
  })
})
