/**
 * 打包（electron-builder 封装）。
 *
 * 存在的理由：让打包**可复现**、**可离线**，且**不被输出目录的旧状态影响**。
 *
 * ---------------------------------------------------------------------------
 * 一、构建永远发生在「干净暂存目录」里
 * ---------------------------------------------------------------------------
 * electron-builder 会在 `<output>/win-unpacked.tmp` 里暂存解包结果，
 * 最后再改名成 `win-unpacked`。于是：
 *
 *   - 上一次构建被中断 → `win-unpacked.tmp` 残留 → 下一次构建 EBUSY 失败；
 *   - `<output>` 里任何**陈旧产物**都可能被当成这次的输入（同一类问题：
 *     历史上 `dist-electron/session.js` 就这么混进过 app.asar）。
 *
 * ⇒ 本脚本把 electron-builder 的输出指向**每次全新**的暂存目录
 *   （`.pack-staging/`），构建成功后再把**成品**发布到真正的输出目录。
 *   这样「输出目录里残留了什么」**不再影响构建结果**。
 *
 * ⚠️ 为什么需要暂存：`release/win-unpacked` 与 `release/win-unpacked.tmp` 里的
 *    `resources` 目录（内含 `app.asar` / `default_app.asar`）可能被别的进程
 *    （实测：MiniMax Code 自己的 Node 工具进程）以「允许读写、
 *    但不允许删除共享」的方式持有 —— Windows 会拒绝删除/改名这些目录
 *    （EPERM / SHARING_VIOLATION）。此时**产物 exe 依然可以正常发布**，
 *    因为它用的是新文件名。
 *
 * ---------------------------------------------------------------------------
 * 二、另外三件它替我们固定下来的事
 * ---------------------------------------------------------------------------
 * 1. **锁定 electron 版本并复用本地二进制**
 *    - `electronVersion` 写在 `electron-builder.yml` 里 → builder 不会自己解析版本；
 *    - `ELECTRON_OVERRIDE_DIST_PATH` 指向**本仓库** `node_modules/electron/dist`
 *      → **不联网下载** electron（用的是项目里那份，版本天然一致），
 *      离线机器 / 内网环境也能出包。
 *
 * 2. **输出目录可切换**
 *    - 默认 `release/`；
 *    - `FNM_PACK_OUTPUT=<dir>` 可改到别处。
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
// 暂存目录：每次全新
// ---------------------------------------------------------------------------

/**
 * 准备一个**全新**的暂存目录。
 *
 * ⚠️ 上一次留下的 `.pack-staging` 可能因为里面的文件被别的进程持有而
 *    **删不掉**（EBUSY）→ 这时**不能**报错退出，那会让「打包」整体不可用。
 *    ⇒ 换个唯一名字继续，保证**打包永远能跑起来**。
 */
function prepareStaging() {
  const preferred = path.join(repoRoot, '.pack-staging')
  try {
    fs.rmSync(preferred, { recursive: true, force: true })
    fs.mkdirSync(preferred, { recursive: true })
    return preferred
  } catch {
    const fallback = path.join(repoRoot, `.pack-staging-${Date.now()}`)
    fs.mkdirSync(fallback, { recursive: true })
    console.log(`[pack] ⚠️ 旧的暂存目录删不掉（被占用），改用：${fallback}`)
    return fallback
  }
}

const stagingDir = prepareStaging()

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const args = [
  '--config',
  'electron-builder.yml',
  `--config.directories.output=${stagingDir}`,
]

console.log(`[pack] electron 版本锁定：${require(path.join(repoRoot, 'node_modules', 'electron', 'package.json')).version}`)
console.log(`[pack] 复用本地 electron 二进制：${electronDist}`)
console.log(`[pack] 暂存目录（每次全新）：${stagingDir}`)
console.log(`[pack] 产物发布目录：${outDir}`)

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

// ---------------------------------------------------------------------------
// 发布：把成品从暂存目录搬到真正的输出目录
// ---------------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true })

/** 把 `from` 搬到 `to`（覆盖式；失败时保留 `from` 并回报）。 */
function publish(from, to) {
  try {
    fs.rmSync(to, { recursive: true, force: true })
    fs.renameSync(from, to)
    return true
  } catch {
    return false
  }
}

const published = []
const kept = []

for (const name of fs.readdirSync(stagingDir)) {
  const src = path.join(stagingDir, name)
  const dst = path.join(outDir, name)
  if (publish(src, dst)) {
    published.push(name)
  } else {
    kept.push(name)
  }
}

console.log(`[pack] 已发布到 ${outDir}：${published.join(', ') || '(无)'}`)
if (kept.length > 0) {
  console.log(
    `[pack] ⚠️ 以下内容**未能**发布（目标位置被占用 / 无删除权限），仍留在暂存目录：\n` +
      `        ${stagingDir}\n` +
      `        → ${kept.join(', ')}\n` +
      '        典型原因：旧目录里的文件被别的进程持有（Windows 会拒绝删除）。\n' +
      '        处理：关闭占用者后重跑，或直接用暂存目录里的产物。',
  )
}

// 暂存目录：发布成功的部分已被搬走，剩下的保留（上面已指明位置）。
if (kept.length === 0) {
  fs.rmSync(stagingDir, { recursive: true, force: true })
}

console.log(`[pack] 完成。产物目录：${outDir}`)
