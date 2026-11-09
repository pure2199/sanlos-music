/**
 * 主进程构建（esbuild JS API）。
 *
 * 为什么不用纯命令行（`esbuild electron/main.ts ... --outdir=dist-electron`）：
 * **命令行没有「先清空输出目录」的能力** —— 历史上改过入口文件名后，
 * 旧的产物（例：`dist-electron/session.js`）会一直躺在输出目录里，
 * 而 `electron-builder.yml` 的 `files` 又是整个 `dist-electron` 目录通配
 * → **陈旧文件会被打进 app.asar**，产物内容随构建历史漂移 → 不可复现。
 *
 * 这里用 `fs.rmSync` 先清空再构建，保证「输出目录 == 本次构建产物」，
 * **不引入 rimraf 之类的额外依赖**。
 *
 * 用法：`node scripts/build-electron.cjs`
 */
const fs = require('node:fs')
const path = require('node:path')

const esbuild = require('esbuild')

const repoRoot = path.resolve(__dirname, '..')
const outdir = path.join(repoRoot, 'dist-electron')

/** 要打包的入口（`main` 是主进程，`preload` 是渲染进程的桥）。 */
const entryPoints = [
  path.join(repoRoot, 'electron', 'main.ts'),
  path.join(repoRoot, 'electron', 'preload.ts'),
]

function main() {
  // ⚠️ **先清空**：esbuild 的 `--outdir` 是「合并写入」，不会删旧文件。
  fs.rmSync(outdir, { recursive: true, force: true })

  esbuild
    .build({
      entryPoints,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      // `electron` 由运行时提供，不能打进产物。
      external: ['electron'],
      outdir,
      logLevel: 'info',
      // ⚠️ 源码映射**不产出**：包体里不带 .map（也不泄露源码结构）。
      sourcemap: false,
    })
    .then(() => {
      // T75：把应用图标复制进输出目录 ⇒ 随 `dist-electron/**/*` 进 asar
      //      （主进程按 `__dirname/icon.png` 解析，见 `electron/appIcon.ts`）。
      const iconSrc = path.join(repoRoot, 'build', 'icon.png')
      if (fs.existsSync(iconSrc)) {
        fs.copyFileSync(iconSrc, path.join(outdir, 'icon.png'))
      } else {
        // ⚠️ **如实说明**：没有图标 ⇒ 产物用 Electron 默认图标（**不阻断构建**）。
        console.warn('[build-electron] ⚠️ 找不到 build/icon.png ⇒ 产物将没有应用图标')
      }
      const files = fs.readdirSync(outdir).sort()
      console.log(`[build-electron] 输出目录已清空并重建：${files.join(', ')}`)
    })
    .catch((err) => {
      console.error('[build-electron] 构建失败', err)
      process.exitCode = 1
    })
}

main()
