/**
 * @vitest-environment node
 */

// T95：`.mjs` / `.cjs` 里**不许有 TypeScript 语法**。
//
// ---------------------------------------------------------------------------
// 为什么要有这条守护（2026-11-15 实测踩出来的）
// ---------------------------------------------------------------------------
// ⚠️ **Node 的类型剥离只对 `.ts` / `.mts` / `.cts` 生效**，`.mjs` **从来不剥**
//    ⇒ `.mjs` 里写 `function f(): { a: number } {}` 是**语法错误**，
//    在 **Node 22（CI 的版本）与 Node 26（本机）上表现完全一样**：
//    `SyntaxError: Unexpected token ':'`。
//
// ⚠️ **真实事故**：Release **run #15** = `43659919970`（v0.3.0）
//    挂在「Write update manifest (unsigned)」这一步 ——
//    `scripts/publish-manifest.mjs:66` 的 `function readPackageMeta(): {...}`。
//    ⇒ v0.3.0 **一个字节都没发出去**（`gh release create` 根本没跑到）。
//    ⚠️ 而本地**从来没抓到过** ⇒ 不是「本机能跑所以没暴露」，
//    是**那个脚本本地从来没被执行过**（当时只验了工作流 YAML 与单测里的文本断言）。
//
// ---------------------------------------------------------------------------
// 这条守护为什么放在 `test/` 里（而不是 `release/verify/`）
// ---------------------------------------------------------------------------
// Release 工作流的步骤顺序是：
//   checkout → npm ci → typecheck → **test** → build → pack → 写清单 → …
// ⇒ `npm test` 排在「写清单」**之前**
// ⇒ 这类错以后会在 **`Unit tests` 那一步**就红（带文件名与行号），
//    **不会**再等到发版跑到一半才炸。
//
// ---------------------------------------------------------------------------
// 为什么用 `node --check`（而不是别的方案）
// ---------------------------------------------------------------------------
// - ✅ **零新依赖**：用的就是 **CI 那个 node 二进制**（`process.execPath`）。
// - ✅ 对 `.mjs`（含 `import` / `export`）与 `.cjs` 都按**纯 JavaScript** 解析。
// - ✅ Node 22 与 Node 26 行为**一致** ⇒ 本地跑绿 = CI 跑绿。
// - ❌ `vm.Script` 不支持 `import` / `export` ⇒ 纯 ESM 文件**假红**。
// - ❌ TypeScript 的 `createSourceFile(..., ScriptKind.JS)`：**漏报** TS 语法、
//    反而**误报**纯 ESM。
// - ❌ esbuild：能用，但它是 **vite 的传递依赖** ⇒ 不拿它当长期守护。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 不扫的目录：依赖、构建产物、gitignore 的临时目录。 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'release',
  'release-ci',
  'release-probe',
])

const SCRIPT_EXTENSIONS = new Set(['.mjs', '.cjs'])

/** 递归找出仓库里所有会被 Node 直接执行的 `.mjs` / `.cjs`。 */
function collectScriptFiles(dir: string = REPO_ROOT): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectScriptFiles(full))
    } else if (SCRIPT_EXTENSIONS.has(extname(entry))) {
      out.push(relative(REPO_ROOT, full).replace(/\\/g, '/'))
    }
  }
  return out.sort()
}

const SCRIPT_FILES = collectScriptFiles()

describe('T95 —— .mjs / .cjs 只能是纯 JavaScript', () => {
  it('守护本身不许空转（扫到了足够的文件，且包含两个「出过事」的文件）', () => {
    expect(SCRIPT_FILES.length).toBeGreaterThan(20)
    // ⚠️ 这两个是**真的出过事**的文件 ⇒ 必须每次都被扫到。
    expect(SCRIPT_FILES).toContain('scripts/publish-manifest.mjs')
    expect(SCRIPT_FILES).toContain('tools/fn-electron-net-probe.mjs')
  })

  it.each(SCRIPT_FILES)('%s 能被 Node 当作纯 JavaScript 解析（node --check）', (relPath) => {
    const result = spawnSync(process.execPath, ['--check', join(REPO_ROOT, relPath)], {
      encoding: 'utf8',
    })
    expect(
      result.status,
      `${relPath} 不是合法的 JavaScript（Node 的类型剥离不作用于 .mjs/.cjs）：\n${result.stderr ?? ''}`,
    ).toBe(0)
  })

  it('scripts/publish-manifest.mjs 里没有 TypeScript 返回类型注解', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'publish-manifest.mjs'), 'utf8')
    // ⚠️ 这条是 run #15 的**原样**回归：同一个注解改回去 ⇒ 必须变红。
    //    （用**精确字符串**而不是正则：文件里的注释里就写着 `function f(): T {}` 这个
    //     例子，正则会误命中自己的注释 ⇒ 假红。）
    expect(source).not.toContain('function readPackageMeta(): {')
    // 类型信息应当写在 JSDoc 里（编辑器仍能提示）。
    expect(source).toContain('@returns {{version: string, productName: string, prefix: string}}')
  })

  it('tools/fn-electron-net-probe.mjs 里没有「两行挤成一行」的语句粘连', () => {
    const source = readFileSync(join(REPO_ROOT, 'tools', 'fn-electron-net-probe.mjs'), 'utf8')
    // ⚠️ 这条是那个已提交进仓库的语法错误（`})    try {`）的原样回归。
    //    ⚠️ 只认**同一行里的多个空格**（`[ \t]`）—— 用 `\s` 会把正常的换行也算进去
    //    ⇒ 反而匹配到**正确**的代码 ⇒ 假红。
    expect(source).not.toMatch(/\}\)[ \t]{2,}(try|catch|const|let|await)\b/)
  })
})
