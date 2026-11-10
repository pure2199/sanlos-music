// T86：签名链路契约 —— 「签了就要确证签上了」「中文主体名不许乱码」在**源码层**钉死。
//
// ---------------------------------------------------------------------------
// 为什么必须读源码（而不是只靠 E2E）
// ---------------------------------------------------------------------------
// ① **签名断言**只在**打包**时跑（`scripts/pack.cjs`）——
//    E2E 跑的是开发构建，压根不打包 ⇒ 只有源码能钉「配了证书却没签上 ⇒ 打包失败」。
// ② **中文乱码**那条更没法靠 E2E 钉：它取决于**运行机器的代码页**（936 / GBK），
//    CI 与本机可能不同 ⇒ 只能钉「**实现里不许直传非 ASCII**」这条**结构事实**。
//
// ⚠️ 用**本测试文件自身的位置**推导仓库根，与 cwd 无关
//    （cwd ≠ 仓库根时读到的就是别的目录 → 断言**空转通过**）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读仓库里的一个文件。 */
function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8')
}

describe('T86 签名链路契约', () => {
  it('打包脚本在配了证书时**必须**跑签名断言，且断言失败要让打包失败', () => {
    const src = readRepoFile('scripts', 'pack.cjs')

    // ⚠️ 断言用的是**暂存目录**（= 本次构建的产物）——
    //    用输出目录会把**历史旧包**一起算进来 ⇒ 误报。
    expect(src).toContain('fn-check-signature.mjs')
    expect(src).toContain("'--expect', 'signed'")
    expect(src).toContain('stagingDir')
    // ⚠️ 断言失败 ⇒ 打包失败（不是「打个警告就算了」）。
    expect(src).toMatch(/check\.status\s*!==\s*0[\s\S]{0,200}?fail\(/)
  })

  it('**没配**证书时打包**照旧成功**（默认行为一字不变）', () => {
    const src = readRepoFile('scripts', 'pack.cjs')

    // 没配证书 ⇒ 只打印一行说明，**不** fail。
    expect(src).toContain('WIN_CSC_LINK')
    expect(src).toContain('产物**未签名**（预期行为）')
    // ⚠️ 「不 fail」这条：只有配了证书那一支才允许调 fail。
    const branches = src.split('if (cscLink ===') [1] ?? ''
    expect(branches).toContain('else')
  })

  it('`electron-builder.yml` 的 `win.sign` **仍然留空**（签不签由环境变量决定）', () => {
    const yml = readRepoFile('electron-builder.yml')

    // ⚠️ **不许**写死证书路径（那会让「没证书的机器」直接构建失败）。
    expect(yml).not.toMatch(/certificateFile:/)
    expect(yml).not.toMatch(/sign:\s*\S/)
    // 但**必须**留下说明：环境变量怎么用。
    expect(yml).toContain('WIN_CSC_LINK')
  })

  it('签名探测**不许直传非 ASCII**（PowerShell 走的是控制台代码页，不是 UTF-8）', () => {
    const src = readRepoFile('electron', 'update.ts')

    // ⚠️ 签名者主体必须走 base64(UTF-8) ⇒ 与代码页无关。
    expect(src).toContain('signerB64')
    expect(src).toContain('ToBase64String')
    expect(src).toContain('decodeBase64Utf8')
  })

  it('签名断言工具在**源码层**声明了「没有签名 ⇒ 失败」这条判定', () => {
    const src = readRepoFile('tools', 'fn-check-signature.mjs')

    expect(src).toContain("'--expect'")
    expect(src).toContain("'signed'")
    // ⚠️ 判定的两半都要在：`NotSigned` ⇒ 没签；签名者不符 ⇒ 签错证书。
    expect(src).toContain('NotSigned')
    expect(src).toContain('expectSigner')
    expect(src).toContain('process.exit(1)')
    // ⚠️ **核心那一行**：要求有签名时，遇到 NotSigned 必须进问题列表。
    //    只断言「出现过 NotSigned」是不够的（`--expect none` 那一支也有它）。
    expect(src).toMatch(/expect\s*===\s*'signed'\s*&&\s*info\.status\s*===\s*'NotSigned'/)
  })

  it('证书生成工具**不许**把私钥或口令写进仓库（只落在 gitignored 目录）', () => {
    const src = readRepoFile('tools', 'fn-make-selfsigned-cert.mjs')

    // ⚠️ `.pfx` / 口令文件都在 `release/` 下 ⇒ 整个目录被 gitignore。
    expect(src).toContain("'release', 'certs'")
    expect(src).toContain('pfx-password.txt')
    // ⚠️ 不许把口令**硬编码**在脚本里。
    expect(src).not.toMatch(/password\s*=\s*['"][^'"]+['"]/)
  })
})
