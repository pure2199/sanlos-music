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
