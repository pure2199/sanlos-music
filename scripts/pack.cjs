/**
 * 打包（electron-builder 封装）。
 *
 * 存在的理由：让打包**可复现**、**可离线**，且**不污染**正式产物目录。
 *
 * ---------------------------------------------------------------------------
 * 三件它替我们固定下来的事
 * ---------------------------------------------------------------------------
 * 1. **锁定 electron 版本并复用本地二进制**
 *    - `electronVersion` 写在 `electron-builder.yml` 里 → builder 不会自己解析版本；
 *    - `ELECTRON_OVERRIDE_DIST_PATH` 指向**本仓库** `node_modules/electron/dist`
 *      → **不联网下载** electron（用的是项目里那份，版本天然一致），
 *      离线机器 / 内网环境也能出包。
 *
 * 2. **输出目录可切换**
 *    - 默认 `release/`；
 *    - `FNM_PACK_OUTPUT=<dir>` 可改到别处 —— 验证打包时用它绕开
 *      被上一次构建污染的目录，**不必先删任何东西**。
 *
 * 3. **入口固定**
 *    - 直接用 node 跑本仓库 `node_modules/electron-builder/cli.js`，
 *      不依赖全局 PATH 上装了什么版本（也**不经过 shell**，避免 Node 22+
 *      的 `shell: true` 弃用告警与路径含空格的引号问题）。
 *
 * 用法：
 *   npm run pack            # 正式产物 → release/
 *   npm run pack:probe      # 验证用产物 → release-probe/（不动 release/）
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const electronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist')
const defaultOut = path.join(repoRoot, 'release')
const outDir = process.env.FNM_PACK_OUTPUT
  ? path.resolve(repoRoot, process.env.FNM_PACK_OUTPUT)
  : defaultOut

function fail(msg) {
  console.error(`[pack] ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 前置检查（**失败要早、要清楚**，不要让 builder 报一堆无关的错）
// ---------------------------------------------------------------------------

const electronExe = path.join(electronDist, 'electron.exe')
if (!fs.existsSync(electronExe)) {
  fail(
    `本仓库的 electron 二进制不存在：${electronExe}\n` +
      '        请先执行 `npm install`（postinstall 会用 scripts/ensure-electron.cjs 兜底安装）。',
  )
}

const builderBin = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js')
if (!fs.existsSync(builderBin)) {
  fail(`未找到本仓库的 electron-builder：${builderBin}（请先执行 npm install）`)
}

for (const entry of ['dist/index.html', 'dist-electron/main.js']) {
  const p = path.join(repoRoot, entry)
  if (!fs.existsSync(p)) {
    fail(`构建产物缺失：${entry} —— 请先执行 \`npm run build\`。`)
  }
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const args = [
  '--config',
  'electron-builder.yml',
  `--config.directories.output=${outDir}`,
]

console.log(`[pack] electron 版本锁定：${require(path.join(repoRoot, 'node_modules', 'electron', 'package.json')).version}`)
console.log(`[pack] 复用本地 electron 二进制：${electronDist}`)
console.log(`[pack] 输出目录：${outDir}`)

const result = spawnSync(process.execPath, [builderBin, ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  // ⚠️ **不用 shell**：直接用 node 跑 electron-builder 的 cli.js。
  //    （`shell: true` 在 Node 22+ 会告警 "Passing args to a child process with
  //    shell option true can lead to security vulnerabilities"，
  //    且路径含空格时会有引号问题。）
  env: {
    ...process.env,
    // 关键：不联网下载 electron，直接用项目里那份。
    ELECTRON_OVERRIDE_DIST_PATH: electronDist,
  },
})

if (result.error) {
  fail(`启动 electron-builder 失败：${result.error.message}`)
}
if (result.status !== 0) {
  console.error(`[pack] electron-builder 退出码 ${result.status}`)
  process.exit(result.status ?? 1)
}

console.log(`[pack] 完成。产物目录：${outDir}`)
