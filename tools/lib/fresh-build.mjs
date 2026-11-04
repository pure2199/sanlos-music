// 构建新鲜度闸门（真机活体验检用）
//
// ---------------------------------------------------------------------------
// 这个模块回答什么
// ---------------------------------------------------------------------------
// **「我现在跑的这个应用，是不是当前源码构建出来的？」**
//
// ⚠️ **为什么必须有这道闸门（T20 的血泪教训）**：
//    真机活体验检（T20）报「拖动进度条定位失败：媒体没被 seek」，
//    排查了两小时，最后定位到：**跑的是一份陈旧的 `dist/`**——
//    那份产物的 `commitSeek` 里**没有** `store.getState().seek(pending)`，
//    所以「松手」只会清掉预览值、**永远不会**真的定位。
//    而 E2E 是过的 —— 因为 `npm run e2e` 会先 `npm run build` 重建 `dist/`。
//    ⇒ **同一个「拖动定位」，E2E 测的是新代码、真机测的是旧代码**，
//      两边结论天然对不上，而且**没有任何报错**。
//
// ⚠️ **为什么用 mtime 而不是内容哈希**：
//    Vite 不产出「源码 → 产物」的哈希清单，想做内容级校验就得自己加构建期清单
//    （属于扩范围）。mtime 足够可靠，且**偏差方向是安全的**：
//    - 误报「产物旧了」→ 只是让你重跑一次 `npm run build`，无害；
//    - 漏报「产物旧了」→ 真机静默测旧代码，正是 T20 踩的坑。
//    宁可多报，不可漏报。
//
// ---------------------------------------------------------------------------
// 用法
// ---------------------------------------------------------------------------
// ```js
// import { assertFreshBuild } from './lib/fresh-build.mjs'
// assertFreshBuild('真机活体验检')   // 产物过期 → 打印原因并以退出码 3 结束
// ```
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件在 `tools/lib/` 下 → 仓库根是上两级。 */
const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..', '..')

/**
 * 源码目录（这些目录里任何一处变了，产物就算旧了）。
 *
 * ⚠️ **为什么包含 `electron/` 和 `shared/`**：主进程（`electron/`）与
 *    前后端共享类型（`shared/`）也进产物 —— 它们变了，产物同样算旧。
 */
const SOURCE_DIRS = ['src', 'shared', 'electron']

/**
 * 递归取一个目录里**最新**的文件修改时间（毫秒）。
 *
 * @param {string} dir 目录绝对路径。
 * @returns {number} 最新 mtime；目录不存在或为空时返回 0。
 */
function newestMtime(dir) {
  const root = join(APP_ROOT, dir)
  if (!existsSync(root)) return 0
  let newest = 0
  /** @param {string} current 当前目录。 */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const mtime = statSync(full).mtimeMs
        if (mtime > newest) newest = mtime
      }
    }
  }
  walk(root)
  return newest
}

/**
 * 看一眼构建产物与源码的时间关系。
 *
 * @returns {{
 *   ok: boolean,
 *   reason: string,
 *   srcNewest: number,
 *   artifacts: Array<{ name: string, mtime: number }>,
 * }}
 */
export function inspectBuild() {
  /** @type {Array<{ name: string, mtime: number }>} */
  const artifacts = []

  // 渲染层产物：`dist/assets/main-<hash>.js`（文件名带内容哈希）。
  const assetDir = join(APP_ROOT, 'dist', 'assets')
  if (existsSync(assetDir)) {
    const bundle = readdirSync(assetDir).find((name) => /^main-.*\.js$/.test(name))
    if (bundle) {
      artifacts.push({
        name: `dist/assets/${bundle}`,
        mtime: statSync(join(assetDir, bundle)).mtimeMs,
      })
    }
  }

  // 主进程产物。
  const mainPath = join(APP_ROOT, 'dist-electron', 'main.js')
  if (existsSync(mainPath)) {
    artifacts.push({ name: 'dist-electron/main.js', mtime: statSync(mainPath).mtimeMs })
  }

  const srcNewest = Math.max(...SOURCE_DIRS.map(newestMtime), 0)
  if (artifacts.length === 0) {
    return { ok: false, reason: '找不到构建产物（dist/ 或 dist-electron/ 不存在）', srcNewest, artifacts }
  }

  const oldest = artifacts.reduce((min, a) => (a.mtime < min.mtime ? a : min))
  if (oldest.mtime < srcNewest) {
    return {
      ok: false,
      reason: `产物 ${oldest.name} 比源码旧`,
      srcNewest,
      artifacts,
    }
  }
  return { ok: true, reason: '', srcNewest, artifacts }
}

/**
 * 产物过期就**硬失败**（不做「提示一下继续跑」——那正是 T20 踩的坑）。
 *
 * @param {string} label 报错前缀（谁在要求新鲜产物）。
 * @returns {ReturnType<typeof inspectBuild>} 通过时的检查结果。
 */
export function assertFreshBuild(label) {
  const info = inspectBuild()
  if (info.ok) return info
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
  console.error(`✗ ${label}：构建产物比源码旧 —— 这次测的就不是当前源码！`)
  console.error(`    ${info.reason}`)
  for (const a of info.artifacts) console.error(`    产物：${a.name}（${fmt(a.mtime)}）`)
  console.error(`    源码最新改动：${fmt(info.srcNewest)}`)
  console.error('    修法：先跑 `npm run build`，再跑本脚本。')
  process.exit(3)
}
