// ---------------------------------------------------------------------------
// 生成自动更新的清单（`release/latest.json`）
// ---------------------------------------------------------------------------
//
// 用法：
//   node scripts/pack.cjs            # 先打出产物
//   node scripts/publish-manifest.mjs # 再生成本清单
//
// ---------------------------------------------------------------------------
// 为什么自己写清单（而不是用 electron-builder 的 `latest.yml`）
// ---------------------------------------------------------------------------
// - **零新依赖**：`latest.yml` 是 YAML，要解析它就得引 `js-yaml`；
//   本项目不引新依赖，故用 **JSON**；
// - **形状自己说了算**：清单是**不可信输入**（客户端要逐项校验），
//   字段越少越好 —— 本清单只有 4 个字段，其中 2 个是必填。
//
// ---------------------------------------------------------------------------
// 清单形状（客户端 = `electron/update.ts` 的 `parseUpdateManifest`）
// ---------------------------------------------------------------------------
// {
//   "version": "1.2.3",
//   "releasedAt": "2026-11-04T00:00:00.000Z",
//   "notes": "更新说明（可空）",
//   "files": [
//     { "name": "….exe", "url": "….exe", "sha512": "<128 位 hex>", "size": 123456 }
//   ]
// }
//
// ⚠️ `files[].url` 是**相对清单所在目录**的相对路径，且**必须与清单同源**
//    （客户端会拒绝跨源地址）—— 所以安装包与 `latest.json` 必须放在同一个目录。
//
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')
// ⚠️ **T87 / CI：输出目录与 `scripts/pack.cjs` 共用同一个变量**。
//    CI 里产物在 `release-ci/`（`FNM_PACK_OUTPUT=release-ci`），
//    而清单必须基于**同一个目录**里的安装包算 SHA-512
//    ⇒ 两边指同一个目录，否则会拿**旧包**算哈希（客户端一更新就失败）。
const RELEASE_DIR = process.env.FNM_PACK_OUTPUT
  ? resolve(APP_ROOT, process.env.FNM_PACK_OUTPUT)
  : join(APP_ROOT, 'release')
const MANIFEST_NAME = 'latest.json'

/**
 * 读 `package.json` 里的**版本**与**软件名**（清单的 `version` 与文件名都取它们）。
 *
 * ⚠️ **T89-㉔：名字不再写死前缀** —— 改成从 `productName` 派生，
 *    与 `electron-builder.yml` 的 `artifactName` **同源**
 *    ⇒ 两边不可能对不上（旧做法是同一个前缀抄 6 遍，漏一处就发出去个错名字的包）。
 *
 * ⚠️ **发布名里不能有空格**（2026-11-13 实测，Release run #13）：
 *    GitHub 会把 Release 资产名里的空格**换成点** ⇒ 带空格的下载 URL **404**
 *    ⇒ 自动更新清单里的 `url` 会指向一个不存在的文件。
 *    ⇒ 规则：**发布名前缀 = `productName` 去掉所有空白**
 *    （"Sanlos Music" ⇒ "SanlosMusic"），
 *    与 `electron-builder.yml` 的 `artifactName: "SanlosMusic-Setup-${version}.${ext}"`
 *    **逐字对齐**（由 `test/t87-ci-release-workflow.test.ts` 锁住两边不许漂移）。
 */
function readPackageMeta(): { version: string; productName: string; prefix: string } {
  const raw = readFileSync(join(APP_ROOT, 'package.json'), 'utf8')
  const parsed = JSON.parse(raw)
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
  if (!version) throw new Error('package.json 里没有 version')
  const productName = typeof parsed.productName === 'string' ? parsed.productName.trim() : ''
  if (!productName) throw new Error('package.json 里没有 productName')
  // ⚠️ **去掉所有空白**（不只是空格）：GitHub 的资产名不允许空格。
  const prefix = productName.replace(/\s+/g, '')
  if (!prefix) throw new Error('productName 去掉空白后是空的')
  return { version, productName, prefix }
}

/** 流式算一个文件的 SHA-512（小写 hex）。 */
async function sha512Of(filePath) {
  const hash = createHash('sha512')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

const { version, prefix } = readPackageMeta()
// ⚠️ 与 `electron-builder.yml` 的 `artifactName: "SanlosMusic-Setup-${version}.${ext}"`
//    **逐字对齐**（多了「-Setup-」这一段，其余同源；前缀 = productName 去掉空白）。
const installerName = `${prefix}-Setup-${version}.exe`
const installerPath = join(RELEASE_DIR, installerName)

let size
try {
  size = statSync(installerPath).size
} catch {
  console.error(`✗ 找不到安装包：${installerPath}`)
  console.error('  先跑 `node scripts/pack.cjs` 打出产物，再生成清单。')
  process.exit(1)
}

const sha512 = await sha512Of(installerPath)

const manifest = {
  version,
  releasedAt: new Date().toISOString(),
  notes: process.env.UPDATE_NOTES ?? '',
  files: [
    {
      name: installerName,
      url: installerName,
      sha512,
      size,
    },
  ],
}

const manifestPath = join(RELEASE_DIR, MANIFEST_NAME)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`✓ 已生成更新清单：${manifestPath}`)
console.log(`  版本：${version}`)
console.log(`  安装包：${installerName}（${size} 字节）`)
console.log(`  sha512：${sha512}`)
console.log('')
console.log('  把 latest.json 与安装包**放在同一个目录**上传到更新服务器，')
console.log('  然后在应用「设置 → 自动更新」里填那个目录地址即可。')
