/**
 * @vitest-environment node
 */

// T131-D3：签名政策入口（README）＋ 代码所有权（CODEOWNERS）的**契约**。
//
// ---------------------------------------------------------------------------
// 为什么这些是**契约**（而不是「跑一次看看」）
// ---------------------------------------------------------------------------
// ① **README 的签名政策入口**是**索引** ⇒ 一旦有人把它写成「复述」，
//    两处内容就会各说各话（用户看到的与维护者改的不是一回事）⇒ 钉住「只指路」。
// ② **CODEOWNERS** 的**顺序**有语义（GitHub：**后匹配者优先**）⇒
//    精确规则排在目录规则前面 ⇒ 精确规则**永远不生效**（被目录规则盖掉）。
// ③ 覆盖路径缺一条 ⇒ 那条路径的改动就**不会被自动点名**（而它是发版/签名链路）。
// ④ 这些都是**纯文本** ⇒ 钉「源码结构」，不跑真流程。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8')
}

// ---------------------------------------------------------------------------
// CODEOWNERS：解析 + 规则
// ---------------------------------------------------------------------------

interface CodeownerRule {
  pattern: string
  owners: string[]
}

/** 解析 CODEOWNERS（`#` 之后是注释；空行忽略；第一个 token 是路径，后面是 owner）。 */
function parseCodeowners(text: string): CodeownerRule[] {
  const out: CodeownerRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]!.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    out.push({ pattern: parts[0]!, owners: parts.slice(1) })
  }
  return out
}

/** 目录级规则（末尾带 `/`）。 */
const DIRECTORY_RULES = ['/shared/', '/electron/', '/src/', '/test/', '/mock-server/', '/e2e/']

/** 精确到文件的规则（**必须排在目录规则后面** ⇒ 后匹配者优先）。 */
const FILE_RULES = [
  '/.github/workflows/',
  '/scripts/pack.cjs',
  '/electron-builder.yml',
  '/CODE_SIGNING_POLICY.md',
  '/docs/signing.md',
]

/** 唯一的 owner（单人维护项目）。 */
const OWNER = '@pure2199'

/**
 * 检查 CODEOWNERS 是否满足契约。
 *
 * @returns 违规说明列表；空数组 = 满足契约
 */
function collectViolations(rules: CodeownerRule[]): string[] {
  const problems: string[] = []

  // ① 每条规则都必须有 owner，且 owner 只能是 `OWNER`。
  for (const rule of rules) {
    if (rule.owners.length === 0) {
      problems.push(`规则「${rule.pattern}」没有 owner`)
      continue
    }
    for (const owner of rule.owners) {
      if (owner !== OWNER) problems.push(`规则「${rule.pattern}」的 owner 是 ${owner}，应为 ${OWNER}`)
    }
  }

  // ② 关键路径必须**全部**被覆盖。
  const patterns = rules.map((r) => r.pattern)
  for (const required of [...DIRECTORY_RULES, ...FILE_RULES]) {
    if (!patterns.includes(required)) problems.push(`缺规则「${required}」`)
  }

  // ③ 顺序：**精确文件规则必须排在所有目录规则之后**
  //    （GitHub「后匹配者优先」⇒ 反过来写等于精确规则失效）。
  const lastDir = Math.max(
    ...DIRECTORY_RULES.map((p) => patterns.indexOf(p)).filter((i) => i >= 0),
    -1,
  )
  for (const fileRule of FILE_RULES) {
    const at = patterns.indexOf(fileRule)
    if (at >= 0 && at < lastDir) {
      problems.push(`精确规则「${fileRule}」排在目录规则之前（后匹配者优先 ⇒ 它不会生效）`)
    }
  }

  return problems
}

describe('T131-D3：签名政策入口（README）', () => {
  const readme = readRepoFile('README.md')

  it('① 有 `### Code signing policy` 小节，且排在「下载安装」之后、「有声小说放在哪里」之前', () => {
    const downloadAt = readme.indexOf('### 下载安装')
    const policyAt = readme.indexOf('### Code signing policy')
    const audiobooksAt = readme.indexOf('### 有声小说放在哪里（必读）')
    expect(downloadAt).toBeGreaterThan(-1)
    expect(policyAt).toBeGreaterThan(-1)
    expect(audiobooksAt).toBeGreaterThan(-1)
    expect(policyAt).toBeGreaterThan(downloadAt)
    expect(policyAt).toBeLessThan(audiobooksAt)
  })

  it('② 小节**指路**到三份签名文档（政策原文 / 操作手册 / 无证书期发版）', () => {
    const section = readme.slice(
      readme.indexOf('### Code signing policy'),
      readme.indexOf('### 有声小说放在哪里（必读）'),
    )
    expect(section).toContain('CODE_SIGNING_POLICY.md')
    expect(section).toContain('docs/signing.md')
    expect(section).toContain('docs/packaging.md')
  })

  it('③ 小节是**索引**、不是复述（不复述「解除锁定」那套绕过步骤）', () => {
    // ⚠️ 绕过步骤在「下载安装」一节已经写全 ⇒ 这里再抄一遍就会**两处各说各话**。
    const section = readme.slice(
      readme.indexOf('### Code signing policy'),
      readme.indexOf('### 有声小说放在哪里（必读）'),
    )
    expect(section).not.toContain('Unblock-File')
    expect(section).not.toContain('解除锁定')
    // ⚠️ 但**必须**写明「未签名」是当前状态（否则用户会以为装到了坏包）。
    expect(section).toContain('未签名')
  })

  it('④ 「八、文档索引」里那两行**仍在**（既有段落零改动）', () => {
    expect(readme).toContain('| [`docs/signing.md`](./docs/signing.md) |')
    expect(readme).toContain('| [`CODE_SIGNING_POLICY.md`](./CODE_SIGNING_POLICY.md) |')
  })
})

describe('T131-D3：CODEOWNERS（代码所有权）', () => {
  const codeowners = readRepoFile('.github', 'CODEOWNERS')

  it('① `.github/CODEOWNERS` 存在且满足契约（覆盖 / owner / 顺序）', () => {
    const violations = collectViolations(parseCodeowners(codeowners))
    expect(violations).toEqual([])
  })

  it('② 关键路径**全部**被点名（发版 / 打包 / 签名政策 / 各源码目录）', () => {
    const patterns = parseCodeowners(codeowners).map((r) => r.pattern)
    for (const required of [...DIRECTORY_RULES, ...FILE_RULES]) {
      expect(patterns, `缺规则：${required}`).toContain(required)
    }
  })

  it('③ **变异自证**：把 owner 换成别人 ⇒ 必被抓出来', () => {
    const mutated = codeowners.replace(/@pure2199/g, '@someone-else')
    // 变异必须真的改到了东西（否则下面的断言就是在验一个没变过的文件）。
    expect(mutated).not.toBe(codeowners)
    expect(collectViolations(parseCodeowners(mutated)).length).toBeGreaterThan(0)
  })

  it('④ **变异自证**：把精确规则排到目录规则**前面** ⇒ 必被抓出来', () => {
    const lines = codeowners.split('\n')
    const fileRuleLine = lines.findIndex((l) => l.includes('/scripts/pack.cjs'))
    const dirRuleLine = lines.findIndex((l) => l.includes('/src/'))
    expect(fileRuleLine).toBeGreaterThan(-1)
    expect(dirRuleLine).toBeGreaterThan(-1)
    // 把精确规则挪到目录规则之前 ⇒ 「后匹配者优先」下它就失效了。
    const mutatedLines = [...lines]
    const [moved] = mutatedLines.splice(fileRuleLine, 1)
    mutatedLines.splice(dirRuleLine, 0, moved!)
    const mutated = mutatedLines.join('\n')
    expect(mutated).not.toBe(codeowners)
    expect(collectViolations(parseCodeowners(mutated)).length).toBeGreaterThan(0)
  })
})
