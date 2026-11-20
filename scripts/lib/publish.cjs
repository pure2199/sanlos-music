'use strict'

// ---------------------------------------------------------------------------
// scripts/lib/publish.cjs —— 把「产物从暂存目录搬到输出目录」这件事**抽出来**
// ---------------------------------------------------------------------------
//
// ⚠ **为什么要抽出来**：`scripts/pack.cjs` 是**脚本**（require 即执行）⇒ 不能直接单测
//    ⇒ 搬运逻辑若留在里面，就永远只能靠「真跑一次打包」来验 ⇒ 太贵。
//    ⇒ 抽成**纯函数模块** ⇒ 可以用临时目录把三种情形都真跑一遍。
//
// ⚠ **为什么会有「跨卷」问题**（T131-D4）：
//    `pack.cjs` 里 `outDir = path.resolve(repoRoot, process.env.SANLOS_PACK_OUTPUT)`
//    ⇒ `path.resolve` 遇到**绝对路径直接原样返回**
//    ⇒ 于是 `SANLOS_PACK_OUTPUT=D:\somewhere` 是**允许的**（跨卷）
//    ⇒ 而 `fs.renameSync` **跨卷会抛 EXDEV**（cross-device link not permitted）
//    ⇒ 旧实现直接 catch ⇒ **发布失败**（且提示语说的是「目标位置被占用」⇒ 误导）。
//
// ⚠ **修法**：先试 `renameSync`（同卷 ⇒ 零额外 IO）；
//    只有 **EXDEV** 才回退到「复制 + 删源」；其它错误**不回退**
//    （复制也解决不了「被占用 / 没权限」这类问题 ⇒ 别做无用功）。
//
// ⚠ **失败语义**：**一律保留源目录**（不删）⇒ 调用方能如实告诉用户
//    「产物还在暂存目录里」⇒ 不会「看起来发布了、其实没发布」。
// ---------------------------------------------------------------------------

const fs = require('node:fs')

/**
 * 把 `from` 搬到 `to`（**覆盖式**：目标已存在时先删掉）。
 *
 * @param {string} from 源目录。
 * @param {string} to 目标目录。
 * @returns {{ ok: boolean, method: 'rename'|'copy'|'none', error: Error|null, sourceKept: boolean }}
 *   - `ok`：产物**已经在 `to`**；
 *   - `method`：实际用的搬运方式（`copy` = 跨卷回退）；
 *   - `error`：失败原因（`ok` 为真时也可能是「删源失败」这类**非致命**错误）；
 *   - `sourceKept`：源目录**没能删掉**（复制成功但源被占用）⇒ 产物可用，但暂存目录里还有一份。
 */
function publishDir(from, to) {
  // ---- ⓪ 源必须存在 -------------------------------------------------------
  // ⚠ **先检查再删目标**：覆盖式语义下，若先删目标、再发现源没了
  //   ⇒ **已经发布出去的产物被删掉**（却什么都没发布出去）⇒ 得不偿失。
  if (!fs.existsSync(from)) {
    return {
      ok: false,
      method: 'none',
      error: new Error(`源目录不存在：${from}`),
      sourceKept: true,
    }
  }

  // ---- ① 覆盖式：先删目标 -----------------------------------------------
  // ⚠ 目标被占用（Windows：文件被别的进程持有）⇒ 删不掉 ⇒ **直接失败**
  //   ⇒ 源保留（不删）⇒ 调用方如实提示「还在暂存目录」。
  try {
    fs.rmSync(to, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, method: 'none', error: err, sourceKept: true }
  }

  // ---- ② 同卷：改名（零额外 IO）------------------------------------------
  try {
    fs.renameSync(from, to)
    return { ok: true, method: 'rename', error: null, sourceKept: false }
  } catch (err) {
    // ⚠ **只有 EXDEV 才回退**（跨卷）；其它错误（占用 / 权限 / 源不存在）复制也白搭。
    if (err.code !== 'EXDEV') {
      return { ok: false, method: 'rename', error: err, sourceKept: true }
    }
  }

  // ---- ③ 跨卷：复制 + 删源 ----------------------------------------------
  try {
    fs.cpSync(from, to, { recursive: true, force: true })
  } catch (err) {
    // ⚠ 复制失败 ⇒ 目标可能是**半个**（不完整）⇒ 删掉，别留残缺的产物。
    try {
      fs.rmSync(to, { recursive: true, force: true })
    } catch {
      // ⚠ 删不掉就算了（如实保留错误信息即可）。
    }
    return { ok: false, method: 'copy', error: err, sourceKept: true }
  }

  try {
    fs.rmSync(from, { recursive: true, force: true })
  } catch (err) {
    // ⚠ 产物**已经在目标位置**了（复制是成功的）⇒ 算发布成功；
    //   但源副本没删掉 ⇒ 如实标记（调用方会提示「暂存目录里还留着一份」）。
    return { ok: true, method: 'copy', error: err, sourceKept: true }
  }

  return { ok: true, method: 'copy', error: null, sourceKept: false }
}

module.exports = { publishDir }
