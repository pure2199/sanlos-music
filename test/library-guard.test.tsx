// ---------------------------------------------------------------------------
// Task 14 修复轮次 2：曲库分页护栏 + 样式契约
//
// 本文件钉住修复轮次 2 的三条回归：
//
// - **NEW-01（Critical）**：服务端连续返回重复数据时，分页请求数**有上界**。
//   上一轮把页码簿记改成「无条件前进」（`nextPage` 一直往前推），而页面层有
//   「内容填不满视口就自动续一页」的 effect（`SongList` / `CardGrid` 各一处）——
//   两者撞在一起就是**无界的请求自旋**：复审实测 500ms 内 31 次请求，
//   撤掉人为上限后 node 100% CPU、RSS 涨到 1.17 GB、vitest 挂死。
//   → 护栏必须落在 **store 层**（两个页面的 effect 都被同一处状态挡住）。
//
// - **NEW-04**：组件吐出的 `fnm-*` 类名 ↔ 对应 `.css` 里的选择器**双向**一一对应。
//   类名既是**样式钩子**也是**测试钩子**，必须被用例守住（上一轮这个结论
//   只存在于审查报告里，仓库没有用例）。
//
// - **NEW-06**：组件层**不反向** import 页面层的 CSS
//   （`src/components/LibraryPageShell.tsx` 曾 import `../pages/library-page-shell.css`）。
//
// ⚠️ 测试里一律用占位数据（「歌一」「示例专辑」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名 / 真实专辑名**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Album, Song } from '../shared/types'
import {
  createLibraryStore,
  LIBRARY_MAX_NO_PROGRESS_PAGES,
  type LibraryApi,
} from '../src/state/libraryStore'
import { SongsPage } from '../src/pages/SongsPage'
import { AlbumsPage } from '../src/pages/AlbumsPage'

// ---------------------------------------------------------------------------
// 测试数据（占位）
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(index: number): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
    artist: '甲',
    artistId: '',
    album: '示例专辑',
    albumId: '',
    coverId: '',
    duration: 100,
    favorite: false,
    codec: 'FLAC',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    year: 0,
    trackNo: index,
    discNo: 1,
  }
}

/** 一张占位专辑。 */
function makeAlbum(index: number): Album {
  return {
    id: `album-${index}`,
    title: `示例专辑${index}`,
    artist: '甲',
    artistId: '',
    coverId: null,
    year: null,
    trackCount: 1,
  }
}

/** 造一个假的曲库 API（默认全部返回空页）。 */
function createFakeApi(overrides: Partial<LibraryApi> = {}): LibraryApi {
  const base: LibraryApi = {
    albums: vi.fn(async () => ({ list: [] as Album[], total: 0 })),
    artists: vi.fn(async () => ({ list: [] as never[], total: 0 })),
    genres: vi.fn(async () => ({ list: [] as never[], total: 0 })),
    songs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    favorites: vi.fn(async () => [] as Song[]),
    playlists: vi.fn(async () => [] as never[]),
    playlistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    // ---- 详情下钻（Task 4）------------------------------------------------
    album: vi.fn(async () => null),
    albumSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    artistAlbums: vi.fn(async () => ({ list: [] as never[], total: 0 })),
    artistSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    genreSongs: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
    history: vi.fn(async () => ({ list: [] as Song[], total: 0 })),
  }
  return { ...base, ...overrides }
}

/** 等一小会儿（真实计时器）：确认**没有**新的请求再冒出来。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

/**
 * 造一个「有上限」的假接口：被调用超过 `cap` 次之后**再也不回应**。
 *
 * ⚠️ 这是测试自己的兜底，不是被测行为：护栏坏掉时页面会进入**无界请求自旋**
 *    （复审实测：500ms 内 31 次请求；撤掉人为上限后 node 100% CPU、
 *    RSS 涨到 1.17 GB、vitest 挂死——微任务链饿死事件循环）。
 *    这个上限让「护栏坏了」表现为**一条红用例**，而不是把测试进程挂死。
 *
 * ⚠️ 护栏正常时请求数只有 4 次，**永远碰不到**这个上限。
 */
function boundedMock<T>(impl: () => Promise<T>, cap = 10): ReturnType<typeof vi.fn> {
  let calls = 0
  return vi.fn(async () => {
    calls += 1
    if (calls > cap) return new Promise<T>(() => {})
    return impl()
  })
}

// ---------------------------------------------------------------------------
// NEW-01：无界请求自旋的回归
// ---------------------------------------------------------------------------

describe('NEW-01 曲库分页护栏（无界请求自旋）', () => {
  it('服务端连续返回重复数据时，请求数有上界（store 层）', async () => {
    // 复审员的探针形状：每页 5 条，**相邻页 id 完全重复**。
    const duplicate = Array.from({ length: 5 }, (_, i) => makeSong(i))
    const songs = vi.fn(async () => ({ list: duplicate, total: 100 }))
    const store = createLibraryStore(createFakeApi({ songs }))

    // 首屏：加载第 1 页。
    await store.getState().loadSongs(1)

    // 模拟页面层的「内容填不满视口就自动续一页」effect：
    // 只要 `hasMore` 还是 true，就请求页码簿记里的**下一页**。
    // （`rounds < 50` 是测试自己的兜底：护栏坏掉时这里会跑满 50 轮 → 断言变红，
    //   **不会**把测试进程挂死。）
    let rounds = 0
    while (store.getState().songs.hasMore && rounds < 50) {
      const { nextPage } = store.getState().songs
      await store.getState().loadSongs(nextPage)
      rounds += 1
    }

    const state = store.getState().songs
    // 请求数**有上界**：首屏 1 次 + 连续容忍的 `LIBRARY_MAX_NO_PROGRESS_PAGES` 次。
    expect(songs).toHaveBeenCalledTimes(LIBRARY_MAX_NO_PROGRESS_PAGES + 1)
    // 绝对上界：复审探针要求「500ms 内个位数」，而不是几十次的无界自旋。
    expect(songs.mock.calls.length).toBeLessThanOrEqual(5)
    // 停下时：`hasMore` 为 false，页码簿记**不再前进**（否则 effect 仍会触发）。
    expect(state.hasMore).toBe(false)
    expect(state.nextPage).toBe(LIBRARY_MAX_NO_PROGRESS_PAGES + 1)
    // 护栏状态**能被人看见**（暴露在 `LibraryCollection` 上）。
    expect(state.stalled).toBe(true)
    expect(state.noProgressPages).toBe(LIBRARY_MAX_NO_PROGRESS_PAGES)
  })

  it('偶发重复页**不会**截断曲库（每页都有新条目时，翻页一直继续）', async () => {
    // 每 3 页里有 1 页带新条目 → 连续「无进展」最多 2 页 < 阈值 → 不该被拦下。
    // 这条用例守住护栏的**另一半**：它挡得住自旋，但不会把 17.3 万首的曲库截断。
    const songs = vi.fn(async (page: number) => ({
      list: page % 3 === 0 ? [makeSong(page)] : [makeSong(1)],
      total: 1000,
    }))
    const store = createLibraryStore(createFakeApi({ songs }))

    for (let page = 1; page <= 12; page += 1) {
      await store.getState().loadSongs(page)
    }

    const state = store.getState().songs
    expect(state.stalled).toBe(false)
    expect(state.hasMore).toBe(true)
    expect(state.noProgressPages).toBeLessThan(LIBRARY_MAX_NO_PROGRESS_PAGES)
    // 第 1/3/6/9/12 页各带来 1 条新条目 → 5 条；其余页全是重复 id。
    expect(state.items).toHaveLength(5)
  })

  it('SongsPage：服务端连续返回重复数据时不会自旋（SongList 的自动续页 effect 被挡住）', async () => {
    const duplicate = Array.from({ length: 5 }, (_, i) => makeSong(i))
    const songs = boundedMock(async () => ({ list: duplicate, total: 100 }))
    const store = createLibraryStore(createFakeApi({ songs }))

    render(<SongsPage store={store} />)

    await waitFor(() => expect(store.getState().songs.stalled).toBe(true))
    // 再等一会儿：确认**没有**新的请求冒出来（不是「停一下又继续」）。
    await wait(60)
    expect(songs.mock.calls.length).toBeLessThanOrEqual(5)
    expect(store.getState().songs.hasMore).toBe(false)
  })

  it('AlbumsPage：服务端连续返回重复数据时不会自旋（CardGrid 的自动续页 effect 被挡住）', async () => {
    const duplicate = Array.from({ length: 5 }, (_, i) => makeAlbum(i))
    const albums = boundedMock(async () => ({ list: duplicate, total: 100 }))
    const store = createLibraryStore(createFakeApi({ albums }))

    render(<AlbumsPage store={store} />)

    await waitFor(() => expect(store.getState().albums.stalled).toBe(true))
    await wait(60)
    expect(albums.mock.calls.length).toBeLessThanOrEqual(5)
    expect(store.getState().albums.hasMore).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// NEW-04 / NEW-06：样式契约
// ---------------------------------------------------------------------------

/**
 * 仓库根目录（**不依赖 `process.cwd()`**）。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 源码目录（扫描目标）。 */
const SRC_DIR = join(REPO_ROOT, 'src')

/** 递归列出目录下的所有文件。 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

/** 读 `src/` 下的源码文件（路径相对 `src/`）。 */
function readSource(relativePath: string): string {
  return readFileSync(join(SRC_DIR, relativePath), 'utf8')
}

/**
 * 抽出 TSX 源码里**真正作为 className 出现**的 `fnm-*` 类名。
 *
 * 两种形态都要覆盖：
 * 1. `className="fnm-…"` / `className={`… fnm-…`}`（属性）；
 * 2. `const classNames = … 'fnm-…'`（**类名变量**，随后被塞进 `className`）——
 *    例如 `Cards.tsx` 里的 `fnm-cover` 就是这么来的。
 *
 * ⚠️ 为什么不是「全文 grep `fnm-`」：注释里提到的类名**不算**组件吐出的类名
 *    （否则一条注释就能冒充一个「有选择器」的类名）。
 */
function extractEmittedClassNames(source: string): Set<string> {
  const names = new Set<string>()

  // 形态 1：`className=` 属性。
  const attrPattern = /className\s*=\s*/g
  let match: RegExpExecArray | null
  while ((match = attrPattern.exec(source)) !== null) {
    const fragment = readAttributeValue(source, match.index + match[0].length)
    for (const token of fragment.match(/fnm-[A-Za-z0-9_-]+/g) ?? []) names.add(token)
  }

  // 形态 2：类名变量（`const classNames = …`）。
  const variablePattern = /^\s*(?:const|let|var)\s+(?:className|classNames|classes|classList)\b\s*=/gm
  while ((match = variablePattern.exec(source)) !== null) {
    // 取等号之后的**同一行**（`^\s*` 可能吃掉了上一行的换行，行尾要从匹配之后开始找）。
    const valueStart = match.index + match[0].length
    const lineEnd = source.indexOf('\n', valueStart)
    const line = source.slice(valueStart, lineEnd === -1 ? source.length : lineEnd)
    for (const token of line.match(/fnm-[A-Za-z0-9_-]+/g) ?? []) names.add(token)
  }

  return names
}

/** 从 `className=` 之后读出属性值的文本片段。 */
function readAttributeValue(source: string, start: number): string {
  const first = source[start]
  if (first === '"' || first === "'") {
    const end = source.indexOf(first, start + 1)
    return end === -1 ? source.slice(start) : source.slice(start, end + 1)
  }
  if (first === '{') {
    // 花括号表达式：按深度扫描（模板字面量里的 `${}` 同样配平）。
    let depth = 0
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, index + 1)
      }
    }
    return source.slice(start)
  }
  return ''
}

/**
 * 抽出 CSS 里的类选择器（`.fnm-*`）。
 *
 * ⚠️ 先去掉 CSS 注释：注释里提到的类名**不算**有选择器
 *    （这样「每个选择器都有类名」这一侧才是真的在查死样式）。
 */
function extractCssClassSelectors(source: string): Set<string> {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set<string>()
  for (const token of code.match(/\.(fnm-[A-Za-z0-9_-]+)/g) ?? []) names.add(token.slice(1))
  return names
}

/**
 * 「类名 ↔ 选择器」契约的对照表。
 *
 * ⚠️ 范围**限定在 Task 14 的曲库区**：仓库里别处存在**动态拼接**的类名
 *    （例如 `fnm-playerbar__button--${quality}`、`fnm-lyricview__line--${slot}`），
 *    静态扫描无法穷举，那部分不在本任务的改动范围内。
 */
const STYLE_CONTRACTS: Array<{ source: string; style: string }> = [
  { source: 'components/SongList.tsx', style: 'components/song-list.css' },
  { source: 'components/Cards.tsx', style: 'components/cards.css' },
  { source: 'components/LibraryPageShell.tsx', style: 'components/library-page-shell.css' },
  { source: 'pages/PlaylistsPage.tsx', style: 'pages/library-pages.css' },
]

describe('NEW-04「类名 ↔ 选择器」契约', () => {
  it('每个组件吐出的类名都有选择器，每个选择器都有类名（双向一一对应）', () => {
    for (const contract of STYLE_CONTRACTS) {
      const emitted = extractEmittedClassNames(readSource(contract.source))
      const selectors = extractCssClassSelectors(readSource(contract.style))

      // 先确认两边都**不是空集**（否则下面的断言会空转通过）。
      expect(emitted.size, `${contract.source} 没扫到类名`).toBeGreaterThan(0)
      expect(selectors.size, `${contract.style} 没扫到选择器`).toBeGreaterThan(0)

      // 方向一：组件吐出的类名都有对应的选择器。
      expect(
        [...emitted].filter((name) => !selectors.has(name)).sort(),
        `${contract.source} 里的类名在 ${contract.style} 里没有选择器`,
      ).toEqual([])
      // 方向二：每个选择器都对应一个真正被吐出的类名（没有死样式）。
      expect(
        [...selectors].filter((name) => !emitted.has(name)).sort(),
        `${contract.style} 里的选择器在 ${contract.source} 里没有类名`,
      ).toEqual([])
    }
  })

  it('曲库区的类名与选择器**严格 1:1**（不多不少）', () => {
    const emitted = new Set<string>()
    const selectors = new Set<string>()
    for (const contract of STYLE_CONTRACTS) {
      for (const name of extractEmittedClassNames(readSource(contract.source))) emitted.add(name)
      for (const name of extractCssClassSelectors(readSource(contract.style))) selectors.add(name)
    }
    expect(emitted.size).toBe(selectors.size)
    expect([...emitted].filter((name) => !selectors.has(name))).toEqual([])
    expect([...selectors].filter((name) => !emitted.has(name))).toEqual([])
  })
})

describe('NEW-06 组件层不反向依赖页面层', () => {
  it('LibraryPageShell 的样式住在 src/components/，不再 import ../pages/ 的 CSS', () => {
    // 1) 样式文件已经搬到组件目录（页面目录里那份已删除）。
    expect(existsSync(join(SRC_DIR, 'components', 'library-page-shell.css'))).toBe(true)
    expect(existsSync(join(SRC_DIR, 'pages', 'library-page-shell.css'))).toBe(false)

    // 2) 组件改成 import 同目录的样式。
    const source = readSource('components/LibraryPageShell.tsx')
    expect(source).toContain("./library-page-shell.css")

    // 3) 更一般地：src/components/** 下的任何文件都不许 import ../pages/ 下的 CSS。
    for (const file of listFiles(join(SRC_DIR, 'components'))) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
      const text = readFileSync(file, 'utf8')
      expect(
        /(?:import|export)\s[^;]*['"][^'"]*\.\.\/pages\/[^'"]*\.css['"]/.test(text),
        `${file} 反向 import 了页面层的 CSS`,
      ).toBe(false)
    }
  })
})
