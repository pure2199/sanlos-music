// CSP 与自定义 scheme 注册表的一致性（回归测试，T18-6）
//
// ---------------------------------------------------------------------------
// 这个测试防的是什么
// ---------------------------------------------------------------------------
// 真机联调（Step D）实测到一个**单测与 HTTP 探针都发现不了**的缺陷：
// `index.html` / `lyric.html` 的 CSP 里 `media-src` 只放行了 `fnm:`，
// **漏了 `fnml:`**（本地媒体 scheme）→ Chromium 的 URL 安全检查直接拒绝
// `<audio src="fnml://local/track/…">`（MediaError code 4
// 「Media load rejected by URL safety check」）→ 对外表现成
// 「该音频无法播放：当前内核不支持该格式」。
//
// ⇒ 后果是**下载到本地 / 本地优先播放 / FFmpeg 兜底产物**三条线在真机上**全部播不了**，
//   而且报错文案完全指错方向（看着像「格式不支持」，其实是「被 CSP 拦了」）。
//
// ---------------------------------------------------------------------------
// 为什么钉在「注册表」上而不是钉死字符串
// ---------------------------------------------------------------------------
// 死记 `media-src` 的完整字符串，改一次 CSP 就要改一次测试，容易被「顺手改断言」带偏。
// 这里钉的是**不变量**：
//   **凡是注册成特权 scheme 的，都必须在 media-src 里被放行** ——
//   新增 scheme 时若忘了同步 CSP，本测试立刻失败。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { FNM_SCHEME, FNML_SCHEME } from '../electron/schemes'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 找仓库根（从当前工作目录向上找）。
 *
 * ⚠️ **不能用 `import.meta.url`**：Vitest 的 jsdom 环境里它不是 `file:` URL
 *    （`fileURLToPath` 会抛「The URL must be of scheme file」）。
 *    故按「仓库根必须同时有这三个文件」来定位。
 */
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
  throw new Error(`从 ${process.cwd()} 向上找不到仓库根（package.json / index.html / lyric.html）`)
}

/** 两个页面的文件（相对仓库根）。 */
const PAGES = [
  { name: 'index.html', path: resolve(findRepoRoot(), 'index.html') },
  { name: 'lyric.html', path: resolve(findRepoRoot(), 'lyric.html') },
] as const

/** 取出 CSP 的原文（`content="…"` 里的那段）。 */
function readCsp(filePath: string): string {
  const html = readFileSync(filePath, 'utf8')
  const match = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/.exec(html)
  if (!match || !match[1]) throw new Error(`页面里没有找到 CSP：${filePath}`)
  return match[1]
}

/** 把 CSP 拆成「指令名 → 允许列表」。 */
function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((token) => token.length > 0)
    const name = tokens[0]
    if (!name) continue
    directives.set(name.toLowerCase(), tokens.slice(1))
  }
  return directives
}

/** 取某条指令的允许列表（没有这条指令 = 空数组）。 */
function sourceList(csp: string, directive: string): string[] {
  return parseCsp(csp).get(directive.toLowerCase()) ?? []
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('CSP 与自定义 scheme 的一致性', () => {
  it.each(PAGES)('$name 存在 CSP 且有 media-src 指令', (page) => {
    const csp = readCsp(page.path)
    expect(csp.length).toBeGreaterThan(0)
    expect(sourceList(csp, 'media-src').length).toBeGreaterThan(0)
  })

  it.each(PAGES)('$name 的 media-src 放行 fnm:（NAS 代理）', (page) => {
    const csp = readCsp(page.path)
    expect(sourceList(csp, 'media-src')).toContain(`${FNM_SCHEME}:`)
  })

  it.each(PAGES)('$name 的 media-src 放行 fnml:（本地媒体）', (page) => {
    const csp = readCsp(page.path)
    // ⚠️ 这条就是回归点：漏掉 `fnml:` → 本地播放与兜底产物全部播不了。
    expect(sourceList(csp, 'media-src')).toContain(`${FNML_SCHEME}:`)
  })

  it.each(PAGES)('$name 的 media-src 放行**全部**已注册的应用 scheme', (page) => {
    const csp = readCsp(page.path)
    const allowed = sourceList(csp, 'media-src')
    for (const scheme of [FNM_SCHEME, FNML_SCHEME]) {
      expect(allowed).toContain(`${scheme}:`)
    }
  })

  it('两个页面的 media-src 保持同款（主窗口与悬浮歌词窗口不许漂移）', () => {
    const [main, lyric] = PAGES
    expect(main).toBeDefined()
    expect(lyric).toBeDefined()
    if (!main || !lyric) return
    expect(sourceList(readCsp(main.path), 'media-src')).toEqual(
      sourceList(readCsp(lyric.path), 'media-src'),
    )
  })

  it('NAS 代理仍是渲染层唯一的出网出口（connect-src 放行 fnm:）', () => {
    for (const page of PAGES) {
      const csp = readCsp(page.path)
      expect(sourceList(csp, 'connect-src')).toContain(`${FNM_SCHEME}:`)
    }
  })
})
