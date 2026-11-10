// T82：外壳契约 —— 「开发者工具这条路是拆掉的」在**源码层**钉死。
//
// ---------------------------------------------------------------------------
// 为什么必须读源码（而不是只靠 E2E）
// ---------------------------------------------------------------------------
// E2E 跑的是**开发构建**（`electron .` ⇒ `app.isPackaged === false`
// ⇒ `devTools: true`）⇒ E2E 只能验「**按 F12 没反应**」，
// **验不到**「**打包后 `devTools: false`**」这一条 ——
// 那条只有**源码**能钉（真实打包的 E2E 要跑 `pack` 产物，太重）。
// ⇒ 两条腿：① E2E（`e2e/t82-shell.spec.ts`）验**行为**；
//            ② 本文件钉**声明**（打包后确实关掉了）。
//
// ⚠️ 用**本测试文件自身的位置**推导仓库根，与 cwd 无关
//    （cwd ≠ 仓库根时读到的就是别的目录 → 断言**空转通过**）。

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 剥掉注释，只留代码。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // ⚠️ `//` **前面不是 `:`** 才算行注释（否则 `https://` 会被吃掉半截）。
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 读仓库里的一个文件。 */
function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8')
}

/** 递归收集目录下所有 `.ts` / `.tsx` 源文件。 */
function collectSources(dir: string): string[] {
  const root = join(REPO_ROOT, dir)
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
  }
  walk(root)
  return out
}

describe('T82 外壳契约：开发者工具这条路是拆掉的', () => {
  it('主窗口 / 经典悬浮窗 / 词岛三处都是 `devTools: !app.isPackaged`', () => {
    const src = stripComments(readRepoFile('electron', 'main.ts'))

    // ⚠️ **恰好三处**：主窗口、经典悬浮窗、词岛。
    //    新增窗口时**必须显式写** `devTools` ⇒ 计数变了这条会红（是提醒，不是刁难）。
    const matches = src.match(/devTools:\s*!app\.isPackaged/g) ?? []
    expect(matches).toHaveLength(3)

    // ⚠️ **不许出现恒真的 `devTools: true`**（那等于打包后也能开出来）。
    expect(src).not.toMatch(/devTools:\s*true/)
  })

  it('授权窗是 `devTools: false`（它加载的是**外部页面**）', () => {
    const src = stripComments(readRepoFile('electron', 'oauthWindow.ts'))
    expect(src).toMatch(/devTools:\s*false/)
    expect(src).not.toMatch(/devTools:\s*true/)
  })

  it('生产代码里**不再有** `openDevTools` / `toggleDevTools` 的调用或接缝', () => {
    const offenders: string[] = []
    for (const dir of ['electron', 'src', 'shared']) {
      for (const file of collectSources(dir)) {
        const code = stripComments(readFileSync(file, 'utf8'))
        if (/openDevTools|toggleDevTools/.test(code)) {
          offenders.push(file.slice(REPO_ROOT.length + 1))
        }
      }
    }
    // ⚠️ **鉴别力**：把 F12 重新绑回 `openDevTools`（哪怕只在一个文件里）→ 这条立刻红。
    expect(offenders).toEqual([])
  })

  it('快捷键模块只认「复制 / 粘贴 / 吞键」三种动作', () => {
    const src = stripComments(readRepoFile('electron', 'appShortcuts.ts'))
    // ⚠️ 动作联合类型里**不许**再出现 devtools 那一支。
    expect(src).toMatch(/export type ShortcutAction = 'copy' \| 'paste' \| 'swallow'/)
    expect(src).not.toMatch(/ShortcutAction\s*=\s*[^;]*devtools/)
  })

  it('版本号由**主进程**给（`app.getVersion()`），并注册进 IPC', () => {
    const mainSrc = stripComments(readRepoFile('electron', 'main.ts'))
    expect(mainSrc).toMatch(/appVersion:\s*app\.getVersion\(\)/)

    const ipcSrc = stripComments(readRepoFile('electron', 'ipc.ts'))
    expect(ipcSrc).toContain("'app:version'")
  })

  it('更新地址没配时**回落项目地址**（`APP_INFO.updateBaseUrl`）', () => {
    const ipcSrc = stripComments(readRepoFile('electron', 'ipc.ts'))
    expect(ipcSrc).toContain('APP_INFO.updateBaseUrl')

    const appInfoSrc = stripComments(readRepoFile('shared', 'appInfo.ts'))
    expect(appInfoSrc).toContain(
      'updateBaseUrl: \'https://github.com/pure2199/sanlos-music/releases/latest/download\'',
    )
    expect(appInfoSrc).toContain('repository: \'https://github.com/pure2199/sanlos-music\'')
  })
})
