/**
 * Electron 二进制兜底安装脚本（postinstall）。
 *
 * 背景：electron@32 的 install.js 依赖 extract-zip@2.0.1，该版本在 Node 26 上
 * 解压会挂起（promise 永不 settle），表现为 `npm install` 成功后
 * node_modules/electron/dist/electron.exe 依然缺失、且不报错。
 *
 * 本脚本只在「二进制确实缺失」时运行：用 Windows 自带的 tar.exe 解压 npm
 * 缓存里的 electron 归档（校验 SHA-256），并写回 path.txt。
 * 二进制已存在时立即返回，不做任何事。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..')
const electronDir = path.join(repoRoot, 'node_modules', 'electron')
const electronExe = path.join(electronDir, 'dist', 'electron.exe')

function log(msg) {
  console.log(`[ensure-electron] ${msg}`)
}

if (!fs.existsSync(electronDir)) {
  log('electron 未安装，跳过。')
  process.exit(0)
}

if (fs.existsSync(electronExe)) {
  log('electron 二进制已存在，跳过。')
  process.exit(0)
}

if (process.platform !== 'win32') {
  log('非 Windows 平台，跳过（其它平台 extract-zip 可正常工作）。')
  process.exit(0)
}

const { version } = require(path.join(electronDir, 'package.json'))
const artifactName = `electron-v${version}-win32-${process.arch}.zip`
const checksums = require(path.join(electronDir, 'checksums.json'))
const expectedSha = checksums[artifactName]

if (!expectedSha) {
  log(`checksums.json 中没有 ${artifactName} 的校验和，跳过。`)
  process.exit(0)
}

const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
const archives = []
;(function walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name === artifactName) archives.push(p)
  }
})(cacheRoot)

if (archives.length === 0) {
  log(`npm 缓存中找不到 ${artifactName}，跳过（请手动执行 electron 的 install.js）。`)
  process.exit(0)
}

const archive = archives[0]
const sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
if (sha !== expectedSha) {
  log('SHA-256 校验失败，拒绝解压。请删除缓存后重试。')
  process.exit(1)
}

const dist = path.join(electronDir, 'dist')
fs.mkdirSync(dist, { recursive: true })
log(`解压 ${artifactName} -> ${dist}`)
execFileSync('tar', ['-xf', archive, '-C', dist], { stdio: 'inherit' })
fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe')
log(fs.existsSync(electronExe) ? 'electron 二进制安装完成。' : '解压后仍未找到 electron.exe。')
