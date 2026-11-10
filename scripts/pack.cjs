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
 * ---------------------------------------------------------------------------
 * 三、CI 适配（T87）
 * ---------------------------------------------------------------------------
 * SignPath 免费签名以「**可信构建**」为前提 ⇒ 产物**必须**由 CI 从本仓库构建
 * ⇒ 打包搬进 CI（`.github/workflows/release.yml`）。为此本脚本固定了三件事：
 *
 * 1. **关掉证书自动发现**（`CSC_IDENTITY_AUTO_DISCOVERY=false`）
 *    - electron-builder 默认会去 Windows 证书库里翻代码签名证书
 *      ⇒ 干净 runner 上找不到（无害），但**本机**若装了证书就会**自动签**
 *      ⇒「本机产物有签名、CI 产物没签名」⇒ 不可预期。
 *    - 要签就**显式**给 `WIN_CSC_LINK`（口径唯一）；临时打开用
 *      `FNM_CSC_AUTO_DISCOVERY=1`。
 *
 * 2. **CI 里直接跑 `node scripts/pack.cjs`**（不要 `npm run pack`）
 *    - `npm run pack` 会**再跑一次 build**（`npm run build && node scripts/pack.cjs`）
 *      ⇒ CI 里浪费一轮；工作流已经在上一步 build 过 ⇒ 直接调本脚本。
 *    - 本脚本**自带前置检查**（缺 `dist/index.html` / `dist-electron/main.js`
 *      会**早失败**并说清楚缺什么）。
 *
 * 3. **输出目录用 `FNM_PACK_OUTPUT=release-ci`**
 *    - CI 上传到 artifact、交给 SignPath 送签的，就是这个目录。
 *    - ⚠️ 目录名以 `release-` 开头 ⇒ 已在 `.gitignore` 里（本地试跑也不脏仓库）。
 *
 * ⚠️ **加严签名断言是可选的**（`FNM_EXPECT_SIGNER_CN`）：设了就额外要求
 *    「状态 Valid + 带 RFC 3161 时间戳 + CN 相等」。
 *    ⚠️ **SignPath 路线用不着它** —— SignPath 是在**打包之后**签的
 *    ⇒ 打包阶段产物必然没签名 ⇒ 断言要放在「取回签名件之后」（release.yml 里做）。
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
    // ⚠️ **T87 / CI 必需：关掉「证书自动发现」**。
    //    electron-builder 默认会去 Windows 证书库里翻代码签名证书：
    //    - 干净 runner 上找不到（无害）；
    //    - 但**本机**若装了证书就会**自动签** ⇒「本机产物有签名、CI 产物没签名」
    //      ⇒ 同一份代码、两种结果 ⇒ 不可预期。
    //    ⇒ 默认关掉；要签就**显式**给 `WIN_CSC_LINK`（口径唯一）。
    //    临时需要打开时：`FNM_CSC_AUTO_DISCOVERY=1`。
    CSC_IDENTITY_AUTO_DISCOVERY: process.env.FNM_CSC_AUTO_DISCOVERY === '1' ? 'true' : 'false',
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
// 签名断言（T86）：**签了就要确证签上了**
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么不能信「打包成功」**：electron-builder 在签名环节失败时
//    **可能只警告、不失败** ⇒「打包成功」**不等于**「签名成功」。
//    ⇒ 这里主动读一次产物的签名状态（Status / 签名者主体），摆到构建输出里；
//    配了证书却没签上 ⇒ **让打包失败**（别让「没签名」悄悄溜过去）。
//
// ⚠️ **检查的是暂存目录**（= **本次构建**的产物）——
//    输出目录里可能还躺着**历史上**的旧产物（老版本号的安装包），
//    拿整个输出目录去查会把旧包一起算进来 ⇒ 误报。
const cscLink = (process.env.WIN_CSC_LINK || process.env.CSC_LINK || '').trim()
const checkScript = path.join(repoRoot, 'tools', 'fn-check-signature.mjs')

// ⚠️ **T87：加严断言的开关**（默认**关** ⇒ 行为与 T86 一字不变）。
// 设了 `FNM_EXPECT_SIGNER_CN` ⇒ 除了「有签名」，还要求：
//   ① 签名状态是 **Valid**（不是 HashMismatch / Expired / NotTrusted）；
//   ② 带 **RFC 3161 时间戳**（证书到期后历史安装包不会集体失效）；
//   ③ 签名者 **CN** 与它**相等**（口径与客户端**同一份**：`shared/update.ts`）。
// ⚠️ **SignPath 路线用不着这个开关**：SignPath 是在**打包之后**签的
//    ⇒ 打包阶段产物必然没签名 ⇒ 断言要放在「取回签名件之后」（见 release.yml）。
const expectCn = (process.env.FNM_EXPECT_SIGNER_CN || '').trim()

if (cscLink === '') {
  console.log('[pack] ℹ️ 未配置签名证书（WIN_CSC_LINK / CSC_LINK）⇒ 产物**未签名**（预期行为）')
} else {
  const checkArgs = [checkScript]
  if (expectCn) {
    console.log(`[pack] 加严签名断言：Valid + RFC 3161 时间戳 + CN = ${expectCn}`)
    checkArgs.push('--expect', 'valid', '--require-timestamp', '--expect-cn', expectCn)
  } else {
    checkArgs.push('--expect', 'signed')
  }
  // ⚠️ `CSC_LINK` 可以是 **base64 内容**；只有它是**文件路径**时才能核对
  //    「签的是不是我们指定的那张证书」。
  if (cscLink.toLowerCase().endsWith('.pfx') && fs.existsSync(cscLink)) {
    checkArgs.push('--pfx', cscLink)
  }
  checkArgs.push(stagingDir)
  console.log('[pack] 校验产物签名…')
  const check = spawnSync(process.execPath, checkArgs, { cwd: repoRoot, stdio: 'inherit' })
  if (check.error) {
    fail(`跑签名断言失败：${check.error.message}`)
  }
  if (check.status !== 0) {
    fail('签名断言失败（产物没签上 / 签错了证书）—— 详见上面的输出')
  }
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
