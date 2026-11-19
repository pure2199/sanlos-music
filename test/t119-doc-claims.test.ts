// ---------------------------------------------------------------------------
// T119：「服务端不能浏览目录」这个结论**已过时** ⇒ 文档/源码不许再这么写
// ---------------------------------------------------------------------------
//
// ⚠ **为什么要有这个钉子**
// ---------------------------------------------------------------------------
// 2026-11-19 飞牛更新后，实测确认飞牛音乐服务端**已支持按目录浏览**
// （`/folder-view/*`、`/app-center/authed-dir/*`、`/shared-library/*`）
// ⇒ 「服务端**不能**浏览目录」这个结论**已不成立**，而它当时写在 **6 处**
// （README ×3、「有声」页 ×2、测试注释 ×1）⇒ 修订之后要有钉子**防回退**：
// 以后谁把旧说法抄回去（抄旧文档、抄旧截图、凭印象写）⇒ 测试变红。
//
// ⚠ **只扫「活」的文件**：`docs/changelog.md` 与 `docs/calibration.md` 是**历史段**
//    （记的是**当时**的事实）⇒ **不扫**（篡改历史是另一条纪律）。
//
// ⚠ **断言写的是「形状」不是「逐字」**：钉「服务端…（不能|没有|不支持）…浏览目录」
//    这个**句式** ⇒ 换词（「服务端不支持浏览目录」）**也**会被抓住；
//    而正确的写法「服务端**已支持**按目录浏览」**不会**被误伤。
//
// ⚠ **既有测试一条不许删、断言一条不许弱化**：本文件是**新增**的钉子；
//    被改写的那条（`test/audiobooks-page.test.tsx` ⑤-b）的断言**一字未动**
//    （它断言的「主目录」「有声小说」**仍然为真**）。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 找仓库根（从当前工作目录向上找）。 */
function findRepoRoot(): string {
  let current = process.cwd()
  for (let depth = 0; depth < 10; depth += 1) {
    const ok = ['package.json', 'index.html', 'lyric.html'].every((name) =>
      existsSync(resolve(current, name)),
    )
    if (ok) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`从 ${process.cwd()} 向上找不到仓库根`)
}

const ROOT = findRepoRoot()

/** 读一个仓库文件（相对仓库根）。 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * 过时结论的**句式**：「（服务端|音乐服务）…（不能|没有|不支持）…（浏览|列举|遍历）目录」。
 *
 * ⚠ **为什么用形状而不是逐字**：逐字钉不住「换了个说法」的回退；
 *    而正确的写法（「服务端**已支持**按目录浏览」）**不含**（不能|没有|不支持）
 *    ⇒ **不会**被误伤。
 *
 * ⚠ **为什么用片段拼**：本文件自己会被「测试文件」那条钉子扫到
 *    ⇒ 若正则写成**字面量**，它的**源码**就会**命中自己的形状**
 *    ⇒ 用 `join('')` 拼 ⇒ 片段之间隔着引号和逗号（超出间隔上限）⇒ **自我免疫**。
 */
const STALE_CLAIM = new RegExp(
  [
    '(服务端|音乐服务)',
    '[^。；\\n]{0,20}',
    '(不能|没有|不支持)',
    '[^。；\\n]{0,10}',
    '(浏览|列举|遍历)目录',
  ].join(''),
)

/**
 * 另一句也要钉住的过时说法（「实测 20 个候选端点都不通」）。
 *
 * ⚠ **为什么用片段拼**：本文件与 `test/audiobooks-page.test.tsx` 里**都写着**这句断言
 *    ⇒ 若这里写**字面量**，那个文件就会**命中自己** ⇒ 用 `join('')` 拼 ⇒ **自我免疫**。
 */
const STALE_PROBE_NOTE = ['候选端点', '都不通'].join('')

describe('T119：文档/源码不许再说「服务端不能浏览目录」', () => {
  it('① README 不含过时的说法，且写明「本客户端目前」', () => {
    const readme = read('README.md')
    expect(readme).not.toMatch(STALE_CLAIM)
    expect(readme).not.toContain(STALE_PROBE_NOTE)
    // ⚠ **仍然为真**的事实必须留着（用户 2026-11-17 的原话：文件要放在主目录下的那个文件夹里）。
    expect(readme).toContain('主目录')
    expect(readme).toContain('有声小说')
    // ⚠ 新的限定语：这是**客户端**的限制，不是服务端的。
    expect(readme).toMatch(/本客户端(目前|还没接|还没)/)
  })

  it('② 「有声」页源码不含过时的说法', () => {
    const src = read('src/pages/AudiobooksPage.tsx')
    expect(src).not.toMatch(STALE_CLAIM)
    expect(src).not.toContain(STALE_PROBE_NOTE)
    // ⚠ **仍然为真**的事实必须留着。
    expect(src).toContain('主目录')
  })

  it('③ 「有声」页的测试文件也不含（注释别把旧说法当依据留着）', () => {
    const test = read('test/audiobooks-page.test.tsx')
    expect(test).not.toMatch(STALE_CLAIM)
    expect(test).not.toContain(STALE_PROBE_NOTE)
  })

  it('④ 历史段**不扫**（changelog / calibration 记的是当时的事实 ⇒ 不得篡改）', () => {
    // ⚠ 这条不是「断言不许改历史」，而是把「不扫它们」这件事**钉成显式决定**：
    //    免得以后有人为了「统一口径」去改历史段（那是另一条纪律：历史记录不篡改）。
    expect(STALE_CLAIM.test(read('docs/changelog.md'))).toBe(true)
  })
})
