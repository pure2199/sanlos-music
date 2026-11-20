/**
 * @vitest-environment node
 */

// T131-D4：产物搬运（`scripts/lib/publish.cjs`）的**契约**。
//
// ---------------------------------------------------------------------------
// 为什么要有这些用例
// ---------------------------------------------------------------------------
// ① `scripts/pack.cjs` 原本自己写 `fs.renameSync` ⇒ **跨卷（EXDEV）直接失败**
//    ⇒ 而 `SANLOS_PACK_OUTPUT` **允许写绝对路径**（`path.resolve` 对绝对路径原样返回）
//    ⇒ 输出目录指到别的盘时，产物**搬不过去**（而提示语说的是「目标位置被占用」⇒ 误导）。
// ② 搬运逻辑抽成模块后，才能用**临时目录**把「同卷 / 跨卷 / 目标被占用」三种情形真跑一遍
//    （**不跑真打包**）。
// ③ ⚠ **失败语义**是契约的一部分：**失败 ⇒ 保留源** ⇒ 调用方能如实说「产物还在暂存目录里」。

import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishDir } from '../scripts/lib/publish.cjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8')
}

/** 造一个「产物目录」的样子（两层 + 一个 exe）。 */
function makeSource(root: string, name = 'app'): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'win-unpacked'), { recursive: true })
  writeFileSync(join(dir, 'win-unpacked', 'app.exe'), 'BINARY')
  writeFileSync(join(dir, 'setup.exe'), 'SETUP')
  return dir
}

/**
 * 找一个**与临时目录不同卷**的可写根（跨卷真实验证用）。
 *
 * ⚠ CI runner（windows-latest）**只有一个卷** ⇒ 找不到时那条用例会**跳过**
 *   （不是「假装通过」）⇒ 本机有第二个盘时才会真跑到跨卷那条。
 */
function findOtherVolume(): string | null {
  const srcRoot = parse(tmpdir()).root.toUpperCase()
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (root.toUpperCase() === srcRoot) continue
    if (!existsSync(root)) continue
    try {
      const probe = join(root, 't131-pack-probe')
      mkdirSync(probe, { recursive: true })
      rmSync(probe, { recursive: true, force: true })
      return root
    } catch {
      // ⚠ 这个盘不可写 ⇒ 试下一个。
      continue
    }
  }
  return null
}

const OTHER_VOLUME = findOtherVolume()

describe('T131-D4：产物搬运（scripts/lib/publish.cjs）', () => {
  it('① 同卷 ⇒ 走「改名」（零额外 IO）：源消失、目标内容一致', () => {
    const root = mkdtempSync(join(tmpdir(), 't131-pack-'))
    try {
      const src = makeSource(root, 'src-dir')
      const dst = join(root, 'dst-dir')

      const result = publishDir(src, dst)

      expect(result.ok).toBe(true)
      expect(result.method).toBe('rename')
      expect(result.sourceKept).toBe(false)
      expect(existsSync(src)).toBe(false)
      expect(readFileSync(join(dst, 'setup.exe'), 'utf8')).toBe('SETUP')
      expect(readFileSync(join(dst, 'win-unpacked', 'app.exe'), 'utf8')).toBe('BINARY')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!OTHER_VOLUME)('② 跨卷 ⇒ 走「复制 + 删源」：源消失、目标内容一致', () => {
    // ⚠ 真跨卷（不是 mock）⇒ 源在临时目录（多半 C 盘）、目标在另一个卷。
    const srcRoot = mkdtempSync(join(tmpdir(), 't131-pack-'))
    const dstRoot = mkdtempSync(join(OTHER_VOLUME!, 't131-pack-'))
    try {
      const src = makeSource(srcRoot, 'src-dir')
      const dst = join(dstRoot, 'dst-dir')

      const result = publishDir(src, dst)

      expect(result.ok).toBe(true)
      // ⚠ **必须是复制**（同卷就是改名 ⇒ 那就没有覆盖到跨卷这条路）。
      expect(result.method).toBe('copy')
      expect(existsSync(src)).toBe(false)
      expect(readFileSync(join(dst, 'setup.exe'), 'utf8')).toBe('SETUP')
      expect(readFileSync(join(dst, 'win-unpacked', 'app.exe'), 'utf8')).toBe('BINARY')
    } finally {
      rmSync(srcRoot, { recursive: true, force: true })
      rmSync(dstRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')(
    '③ 目标被占用 ⇒ **失败并保留源**（不吞错，目标也不被破坏）',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 't131-pack-'))
      const dst = join(root, 'dst-dir')
      mkdirSync(dst, { recursive: true })
      const held = join(dst, 'locked.exe')
      writeFileSync(held, 'LOCKED')
      // ⚠ **真实成因**：目录被某个进程当作**工作目录** ⇒ Windows 拒绝删除它。
      //   ⚠ **实测过两种「看起来像占用」的写法，Windows 上都挡不住删除**：
      //   ① 文件设成只读（0o444）⇒ Node 的 rm 会先清掉只读属性；
      //   ② 文件被 `openSync` 持有 ⇒ libuv 以 `FILE_SHARE_DELETE` 打开 ⇒ 删除只是「标记」。
      //   ⇒ 只有「进程的工作目录落在里面」才真的挡得住（EPERM）。
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        cwd: dst,
        stdio: 'ignore',
      })
      const exited = new Promise((r) => child.once('exit', r))
      try {
        // ⚠ 等子进程**真的起来**（cwd 已占住）再搬。
        await new Promise((r) => setTimeout(r, 800))
        const src = makeSource(root, 'src-dir')

        const result = publishDir(src, dst)

        expect(result.ok).toBe(false)
        expect(result.error).toBeTruthy()
        // ⚠ **源必须还在**（失败不许把产物弄丢）。
        expect(existsSync(src)).toBe(true)
        expect(readFileSync(join(src, 'setup.exe'), 'utf8')).toBe('SETUP')
        // ⚠ 目标也没被破坏（占住的那个文件还在）。
        expect(readFileSync(held, 'utf8')).toBe('LOCKED')
      } finally {
        if (child.exitCode === null) {
          child.kill()
          await exited
        }
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it('④ 源不存在 ⇒ 失败（不吞错），且**不会先把已发布的目标删掉**', () => {
    const root = mkdtempSync(join(tmpdir(), 't131-pack-'))
    try {
      const dst = join(root, 'dst-dir')
      mkdirSync(dst, { recursive: true })
      writeFileSync(join(dst, 'old.exe'), 'OLD')

      const result = publishDir(join(root, 'missing-dir'), dst)

      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
      // ⚠ **覆盖式**的顺序是「先删目标再搬」⇒ 若不先查源，
      //   源没了就会把**上一次发布好的产物**删掉 ⇒ 这里必须保住。
      expect(readFileSync(join(dst, 'old.exe'), 'utf8')).toBe('OLD')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('⑤ 目标已存在 ⇒ **被覆盖**（旧内容没了，新内容在）', () => {
    const root = mkdtempSync(join(tmpdir(), 't131-pack-'))
    try {
      const src = makeSource(root, 'src-dir')
      const dst = join(root, 'dst-dir')
      mkdirSync(dst, { recursive: true })
      writeFileSync(join(dst, 'old.exe'), 'OLD')

      const result = publishDir(src, dst)

      expect(result.ok).toBe(true)
      expect(existsSync(join(dst, 'old.exe'))).toBe(false)
      expect(readFileSync(join(dst, 'setup.exe'), 'utf8')).toBe('SETUP')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('T131-D4：pack.cjs 与搬运模块的**结构契约**', () => {
  const pack = readRepoFile('scripts', 'pack.cjs')
  const lib = readRepoFile('scripts', 'lib', 'publish.cjs')

  it('⑥ `pack.cjs` 走 `publishDir`（不再自己 rename ⇒ 跨卷回退不会被打绕过）', () => {
    expect(pack).toContain("require('./lib/publish.cjs')")
    expect(pack).toContain('publishDir(src, dst)')
    // ⚠ **不许**再有裸的 `fs.renameSync`（那会把跨卷回退绕过去）。
    expect(pack).not.toContain('fs.renameSync')
  })

  it('⑦ **只有 EXDEV 才回退复制**（占用 / 权限类错误复制也白搭）', () => {
    expect(lib).toContain("err.code !== 'EXDEV'")
    expect(lib).toContain('fs.cpSync(from, to, { recursive: true, force: true })')
  })

  it('⑧ 跨卷复制**成功但删不掉源** ⇒ 仍算「已发布」，但**如实标记**源还在', () => {
    // ⚠ 这条钉的是**语义**：产物已经在目标位置了 ⇒ 不能报「发布失败」（那会误导用户
    //   去重跑），但也**不能假装源没了**（暂存目录里确实还留着一份）。
    expect(lib).toContain('sourceKept')
    expect(pack).toContain('sourceKept')
    // ⚠ 源还在时**不许**删暂存目录（会把没搬干净的产物删掉）。
    expect(pack).toContain('if (kept.length === 0 && sourceKept.length === 0) {')
  })
})
