// ---------------------------------------------------------------------------
// T115：里层命名全量改名的**契约钉子**
// ---------------------------------------------------------------------------
//
// 这个测试防的是什么
// ---------------------------------------------------------------------------
// T115 把里层（旧代号 `fnm` / `fnmusic`）的标识符**全量**换成了 `sanlos`：
// 包名、appId、自定义协议、CSS 类名前缀、preload 桥名、环境变量前缀、工具脚本文件名。
//
// ⚠️ **这类改名的失败模式是「漏一处、运行时才炸」**：
//   - 协议注册漏一处 ⇒ `registerSchemesAsPrivileged()` 静默覆盖 ⇒ 渲染层 `fetch` 抛
//     `TypeError: Failed to fetch` ⇒ **整个曲库拉不出来**，而**单测全绿**；
//   - CSP 漏放行 ⇒ Chromium 的 URL 安全检查**直接拒绝** ⇒ 封面空白 / 本地播不了；
//   - preload 桥名与渲染层取值不一致 ⇒ `getBridge()` 返回 `null` ⇒ 登录页永远转圈；
//   - 旧名**漏改** ⇒ 以后每次搜旧代号都要重新判断一遍「这个要不要改」。
//
// ⇒ 本测试把**改完之后必须成立的不变量**全部钉住：
//   ① 新名就位；② 旧名**只**允许出现在**白名单**里；③ 协议**一次**注册**两个** scheme；
//   ④ `localStorage` 的三个用户数据键**旧键回落**（改名不丢数据）。
//
// ⚠️ **既有测试一条不许删、断言一条不许弱化**：本文件是**新增**的钉子，
//    既有测试里因「前提被推翻」而改写的断言见 T115 规格 §九。
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { SANLOS_SCHEME, SANLOS_MEDIA_SCHEME, registerAppSchemes } from '../electron/schemes'
import { LEGACY_USER_DATA_DIR_NAME } from '../electron/userDataDir'
import { LOCAL_HISTORY_KEY } from '../src/state/historyStore'
import { RESUME_STORAGE_KEY, createResumePort } from '../src/player/resumeBridge'
import { LYRIC_OVERRIDE_STORAGE_KEY, createLyricOverridePort } from '../src/state/lyricOverrideStore'
import {
  LEGACY_LOCAL_HISTORY_KEY,
  LEGACY_RESUME_STORAGE_KEY,
  LEGACY_LYRIC_OVERRIDE_STORAGE_KEY,
} from '../shared/legacyStorageKeys'

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

/** 递归列出目录下的文件（相对仓库根）。 */
function listFiles(rel: string, out: string[] = []): string[] {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return out
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const next = `${rel}/${entry.name}`
    if (entry.isDirectory()) listFiles(next, out)
    else out.push(next)
  }
  return out
}

/** 假存储（可注入键值对；两个端口的形状一样）。 */
function fakeStorage(initial: Record<string, string> = {}): {
  data: Record<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
} {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    removeItem: (key: string) => {
      delete data[key]
    },
  }
}

// ---------------------------------------------------------------------------
// 旧代号白名单
// ---------------------------------------------------------------------------

/**
 * 旧代号**允许**出现的文件与形态。
 *
 * ⚠️ 每一个都必须有**理由**：
 * - `electron/userDataDir.ts` 的 `fnmusic-desktop` = **旧 userData 目录名**（迁移源，
 *   删了老用户升级会丢登录态）；
 * - `shared/legacyStorageKeys.ts` = **旧 `localStorage` 键的字面量**（数据在磁盘上的原样）；
 * - 本文件 = **钉住**上面那两个旧字面量（否则测不到「字面量有没有被改坏」）。
 */
const ALLOWED_OLD_NAME: Record<string, RegExp[]> = {
  'electron/userDataDir.ts': [/fnmusic-desktop/],
  'shared/legacyStorageKeys.ts': [/fnmusic-(local-history|resume|lyric-overrides)/],
  // ⚠️ 本文件**自己**就写着旧名（负向断言 ＋ 旧键字面量）⇒ 必须放行。
  'test/t115-rename-contract.test.ts': [
    /fnmusic-(local-history|resume|lyric-overrides)/,
    /fnPlayer/,
    /FNM_/,
  ],
}

/** 当前态目录（**历史文档 `docs/` 不在其中** —— 那是当时的事实，不改）。 */
const CURRENT_DIRS = ['src', 'electron', 'shared', 'mock-server', 'scripts', 'tools', 'test', 'e2e']

/** 当前态根级文件。 */
const CURRENT_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'index.html',
  'lyric.html',
  'island.html',
  'vite.config.ts',
  'playwright.config.ts',
  'tsconfig.json',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'CODE_SIGNING_POLICY.md',
]

/** 要盯的旧代号形态（**每一条都必须只剩在白名单里**）。 */
const OLD_TOKENS: RegExp[] = [
  /fnm:\/\//,
  /fnml:\/\//,
  /\bfnm-/,
  /\bfnPlayer\b/,
  /\bFnBridge\b/,
  /\bFNM_/,
  /\bregisterFnmSchemePrivileges\b/,
  /com\.fnmusic\.desktop/,
]

/** 一条合法的「上次播放」记录（`normalizeResumeRecord` 的字段一个都不能少）。 */
function resumeRecord() {
  return {
    id: 'song-1',
    title: '歌',
    artist: '甲',
    coverId: '',
    duration: 100,
    positionSec: 42,
    updatedAt: 1,
  }
}

/**
 * 把 T115 自己那一节**摘掉**（它**合法地**提到旧名 —— 那是描述，不是指针）。
 */
function stripT115Section(text: string): string {
  const at = text.indexOf('## 九十三、T115')
  if (at < 0) return text
  const rest = text.slice(at)
  const rel = rest.slice(1).search(/^## /m)
  const end = rel === -1 ? text.length : at + rel
  return text.slice(0, at) + text.slice(end)
}

// ---------------------------------------------------------------------------
// ① 包名 / appId / 环境变量
// ---------------------------------------------------------------------------

describe('T115 · 包名与 appId', () => {
  it('`package.json` 的 name = `sanlos-music`，productName 仍是 `Sanlos Music`', () => {
    const pkg = JSON.parse(read('package.json')) as { name: string; productName: string }
    expect(pkg.name).toBe('sanlos-music')
    expect(pkg.productName).toBe('Sanlos Music')
  })

  it('`package-lock.json` 的两处 name 与 `package.json` 一致', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      name: string
      packages: Record<string, { name?: string }>
    }
    expect(lock.name).toBe('sanlos-music')
    expect(lock.packages['']?.name).toBe('sanlos-music')
  })

  it('`electron-builder.yml` 的 appId = `com.sanlos.music`（productName 不动）', () => {
    const yml = read('electron-builder.yml')
    expect(yml).toMatch(/^appId:\s*com\.sanlos\.music$/m)
    expect(yml).toMatch(/^productName:\s*Sanlos Music$/m)
  })

  it('⚠️ 旧 userData 目录名**必须保留**（它是迁移源，删了老用户升级会丢登录态）', () => {
    expect(LEGACY_USER_DATA_DIR_NAME).toBe('fnmusic-desktop')
    expect(read('electron/userDataDir.ts')).toContain("LEGACY_USER_DATA_DIR_NAME = 'fnmusic-desktop'")
  })

  it('本客户端自己的环境变量前缀是 `SANLOS_`（`FNM_PACK_OUTPUT` 等）', () => {
    expect(read('package.json')).toContain('SANLOS_PACK_OUTPUT')
    expect(read('.github/workflows/release.yml')).toContain('SANLOS_PACK_OUTPUT')
    expect(read('.github/workflows/ci.yml')).toContain('SANLOS_PACK_OUTPUT')
    expect(read('scripts/pack.cjs')).toContain('SANLOS_PACK_OUTPUT')
    expect(read('scripts/publish-manifest.mjs')).toContain('SANLOS_PACK_OUTPUT')
  })
})

// ---------------------------------------------------------------------------
// ② 协议：名字 + **一次注册两个**（T13 那条铁律）
// ---------------------------------------------------------------------------

describe('T115 · 自定义协议', () => {
  it('scheme 名 = `sanlos`（NAS 代理）与 `sanlos-media`（本地媒体）', () => {
    expect(SANLOS_SCHEME).toBe('sanlos')
    expect(SANLOS_MEDIA_SCHEME).toBe('sanlos-media')
  })

  it('⭐ `registerAppSchemes()` **只调用一次** `registerSchemesAsPrivileged`，且**带两个** scheme', () => {
    // ⚠️ 这条是 T13 用真机换来的铁律：Electron 的 `registerSchemesAsPrivileged()`
    //    **整个进程只能调用一次**，第二次会**静默覆盖**第一次 ⇒ 漏一个 scheme
    //    ⇒ 渲染层 `fetch` 抛 `TypeError: Failed to fetch` ⇒ **整个曲库拉不出来**，
    //    而**单元测试全绿**（jsdom 没有自定义协议）。
    const calls: { scheme: string }[][] = []
    registerAppSchemes({
      handle: () => undefined,
      registerSchemesAsPrivileged: (schemes) => {
        calls.push(schemes as { scheme: string }[])
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(2)
    expect(calls[0]?.map((s) => s.scheme)).toEqual(['sanlos', 'sanlos-media'])
  })

  it('客户端基址 = `sanlos://srv`', () => {
    expect(read('src/api/client.ts')).toContain("const BASE = 'sanlos://srv'")
  })

  it('本地媒体地址 = `sanlos-media://local/track/<id>`', () => {
    expect(read('shared/localMedia.ts')).toContain("LOCAL_MEDIA_SCHEME = 'sanlos-media'")
  })
})

// ---------------------------------------------------------------------------
// ③ CSP：三个页面都必须放行两个新 scheme，且**不再有旧 scheme**
// ---------------------------------------------------------------------------

describe('T115 · CSP 与 scheme 放行', () => {
  const PAGES = ['index.html', 'lyric.html', 'island.html'] as const

  it.each(PAGES)('%s 的 CSP 放行 `sanlos:` 与 `sanlos-media:`，且没有旧 scheme', (page) => {
    const html = read(page)
    const csp = html.match(/content="([^"]*default-src[^"]*)"/)?.[1] ?? ''
    expect(csp).not.toBe('')
    expect(csp).toContain('sanlos:')
    expect(csp).toContain('sanlos-media:')
    // ⚠️ 旧 scheme **必须**不在了 —— 留着只会让人以为还有第二条通路。
    expect(csp).not.toContain('fnm:')
    expect(csp).not.toContain('fnml:')
  })
})

// ---------------------------------------------------------------------------
// ④ preload 桥名
// ---------------------------------------------------------------------------

describe('T115 · preload 桥', () => {
  it('暴露的是 `sanlos` / `sanlosAuth` / `sanlosPlayer`，旧的三个都没了', () => {
    const src = read('electron/preload.ts')
    expect(src).toContain("exposeInMainWorld('sanlos', api)")
    expect(src).toContain("exposeInMainWorld('sanlosAuth', sanlosAuth)")
    expect(src).toContain("exposeInMainWorld('sanlosPlayer', sanlosPlayer)")
    expect(src).not.toContain("exposeInMainWorld('fnmusic'")
    expect(src).not.toContain("exposeInMainWorld('fn'")
    expect(src).not.toContain("exposeInMainWorld('fnPlayer'")
  })

  it('渲染层取桥用的是 `window.sanlosAuth`（类型声明与取值一致）', () => {
    expect(read('src/lib/bridge.ts')).toContain('{ sanlosAuth?: AuthBridge }')
    expect(read('src/vite-env.d.ts')).toMatch(/^\s*sanlosAuth:\s*AuthBridge$/m)
    expect(read('src/vite-env.d.ts')).toMatch(/^\s*sanlos:\s*\{\s*platform:\s*string\s*\}$/m)
    // ⚠️ `sanlosPlayer` **没有**进 `Window` 声明（它靠 `as unknown as { … }` 取）
    //    ⇒ 这里钉的是「文档与实现同名」，不是「`Window` 上有这一条」。
    expect(read('shared/playerBridge.ts')).toContain('window.sanlosPlayer')
  })
})

// ---------------------------------------------------------------------------
// ⑤ 旧代号**只**能出现在白名单里
// ---------------------------------------------------------------------------

describe('T115 · 旧代号残留', () => {
  const files = [
    ...CURRENT_DIRS.flatMap((d) => listFiles(d)),
    ...CURRENT_ROOT_FILES,
  ].filter((f) => /\.(ts|tsx|css|html|mjs|cjs|js|json|yml|yaml|md)$/i.test(f))

  it('当前态目录里**没有**任何旧代号（白名单除外）', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = read(file)
      const allowed = ALLOWED_OLD_NAME[file] ?? []
      for (const token of OLD_TOKENS) {
        const re = new RegExp(token.source, 'g')
        for (const m of text.matchAll(re)) {
          const hit = m[0]
          if (allowed.some((re) => re.test(hit))) continue
          offenders.push(`${file}: ${hit}`)
        }
      }
    }
    expect(offenders, `旧代号残留：\n${offenders.join('\n')}`).toEqual([])
  })

  it('⚠️ 白名单里的旧名**确实还在**（白名单不是「改了但忘了更新测试」）', () => {
    expect(read('electron/userDataDir.ts')).toContain('fnmusic-desktop')
    expect(read('shared/legacyStorageKeys.ts')).toContain('fnmusic-local-history')
    expect(read('shared/legacyStorageKeys.ts')).toContain('fnmusic-resume')
    expect(read('shared/legacyStorageKeys.ts')).toContain('fnmusic-lyric-overrides')
  })

  it('⚠️ 历史产物名 `FN-Music-*` **必须保留**（v0.2.8 及以前的真产物名）', () => {
    expect(read('CODE_SIGNING_POLICY.md')).toContain('FN-Music-Setup-')
    expect(read('README.md')).toContain('FN-Music-Setup-')
    expect(read('.github/workflows/release.yml')).toContain('FN-Music-Setup-')
  })
})

// ---------------------------------------------------------------------------
// ⑥ 文件改名
// ---------------------------------------------------------------------------

describe('T115 · 文件改名', () => {
  it('`tools/` 下不再有 `fn-*`（工具脚本文件名）', () => {
    const stale = listFiles('tools').filter((f) => f.startsWith('tools/fn-'))
    expect(stale).toEqual([])
    expect(existsSync(join(ROOT, 'tools/sanlos-check-signature.mjs'))).toBe(true)
    expect(existsSync(join(ROOT, 'tools/sanlos-live-check.mjs'))).toBe(true)
  })

  it('`docs/superpowers/` 下不再有文件名含 `fnmusic`', () => {
    const stale = [
      ...listFiles('docs/superpowers/specs'),
      ...listFiles('docs/superpowers/plans'),
    ].filter((f) => /fnmusic/i.test(f))
    expect(stale).toEqual([])
    expect(existsSync(join(ROOT, 'docs/superpowers/specs/2026-11-02-sanlos-music-desktop-design.md'))).toBe(true)
    expect(existsSync(join(ROOT, 'docs/superpowers/plans/2026-11-02-sanlos-music-desktop.md'))).toBe(true)
  })

  it('引用了被改名文件的地方**跟着改了**（指针不死链）', () => {
    // ⚠️ `scripts/pack.cjs` 是**分段拼路径**的（`path.join(root, 'tools', '…')`）
    //    ⇒ 这里只能断言**文件名**，断不了路径形态。
    expect(read('scripts/pack.cjs')).toContain('sanlos-check-signature.mjs')
    expect(read('docs/packaging.md')).toContain('tools/sanlos-check-signature.mjs')
    // ⚠️ 判「旧**文件名**」而不是判字面量 `tools/fn-`：
    //    历史文档**合法地**提到旧名（如「工具脚本 `tools/fn-*.mjs`」）——
    //    那是**对旧名的描述**，不是指向旧文件的指针 ⇒ 不能算死链。
    // ⚠️ 而且 T115 自己那一节**必然**提到旧名（它在讲旧名长什么样）⇒ 先摘掉那一节。
    const OLD_TOOL_NAME = /(?<![A-Za-z0-9-])fn-[a-z0-9-]+\.(?:mjs|js)(?![a-z0-9])/g
    for (const f of ['docs/calibration.md', 'docs/changelog.md', 'docs/packaging.md', 'docs/signing.md']) {
      expect(stripT115Section(read(f)).match(OLD_TOOL_NAME), `${f} 还指着旧文件名`).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// ⑦ `localStorage` 旧键回落（**改名不许丢用户数据**）
// ---------------------------------------------------------------------------

describe('T115 · localStorage 旧键回落', () => {
  it('旧键的字面量**一个字都没改**（它们就是数据在磁盘上的原样）', () => {
    expect(LEGACY_LOCAL_HISTORY_KEY).toBe('fnmusic-local-history')
    expect(LEGACY_RESUME_STORAGE_KEY).toBe('fnmusic-resume')
    expect(LEGACY_LYRIC_OVERRIDE_STORAGE_KEY).toBe('fnmusic-lyric-overrides')
  })

  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('本机播放记录：新键没有 ⇒ 回落读旧键（老用户升级不丢记录）', async () => {
    window.localStorage.setItem(
      LEGACY_LOCAL_HISTORY_KEY,
      JSON.stringify([{ id: 'song-1', title: '老歌', artist: '甲', albumId: '', album: '' }]),
    )
    const mod = await import('../src/state/historyStore')
    const items = mod.useLocalHistory.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('song-1')
  })

  it('本机播放记录：新键**优先**于旧键（不能被旧数据顶掉）', async () => {
    window.localStorage.setItem(
      LEGACY_LOCAL_HISTORY_KEY,
      JSON.stringify([{ id: 'old', title: '旧的', artist: '甲', albumId: '', album: '' }]),
    )
    window.localStorage.setItem(
      LOCAL_HISTORY_KEY,
      JSON.stringify([{ id: 'new', title: '新的', artist: '甲', albumId: '', album: '' }]),
    )
    const mod = await import('../src/state/historyStore')
    const items = mod.useLocalHistory.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('new')
  })

  it('上次播放：新键没有 ⇒ 回落读旧键（老用户升级不丢续播位置）', async () => {
    const storage = fakeStorage({
      [LEGACY_RESUME_STORAGE_KEY]: JSON.stringify(resumeRecord()),
    })
    const port = createResumePort(storage)
    const loaded = await port.load()
    expect(loaded?.id).toBe('song-1')
    expect(loaded?.positionSec).toBe(42)
  })

  it('⭐「清空」把**两个键都删掉**（只删新键 ⇒ 旧键复活，用户点了清空却还在）', async () => {
    const storage = fakeStorage({
      [LEGACY_RESUME_STORAGE_KEY]: JSON.stringify(resumeRecord()),
    })
    const port = createResumePort(storage)
    await port.clear()
    expect(storage.data[LEGACY_RESUME_STORAGE_KEY]).toBeUndefined()
    expect(storage.data[RESUME_STORAGE_KEY]).toBeUndefined()
    expect(await port.load()).toBeNull()
  })

  it('按歌指定歌词源：新键没有 ⇒ 回落读旧键（老用户升级不丢 T107 的指定）', () => {
    const storage = fakeStorage({
      [LEGACY_LYRIC_OVERRIDE_STORAGE_KEY]: JSON.stringify({ 'song-1': { source: 'kuwo', updatedAt: 1 } }),
    })
    const port = createLyricOverridePort(storage)
    const map = port.load()
    expect(map['song-1']?.source).toBe('kuwo')
  })

  it('按歌指定歌词源：新键**优先**于旧键', () => {
    const storage = fakeStorage({
      [LEGACY_LYRIC_OVERRIDE_STORAGE_KEY]: JSON.stringify({ 'song-1': { source: 'kuwo', updatedAt: 1 } }),
      [LYRIC_OVERRIDE_STORAGE_KEY]: JSON.stringify({ 'song-1': { source: 'kugou', updatedAt: 2 } }),
    })
    const port = createLyricOverridePort(storage)
    expect(port.load()['song-1']?.source).toBe('kugou')
  })
})
