// ---------------------------------------------------------------------------
// T89-③：自动更新的临时安装包目录 —— 旧安装包清理
// ---------------------------------------------------------------------------
//
// ⚠️ **钉的是什么**：
// 1. **只删普通文件**；遇到**子目录一律跳过**（不递归、不删目录）⇒ 不会误伤别的东西。
// 2. `keep` 指定的文件（本次刚下载的那个）**不被删**。
// 3. 删不掉的文件**不影响其它文件被删**，也**不抛错** ⇒ 清理不会让启动 / 下载失败。
// 4. 目录不存在 ⇒ **不报错**（还没下过更新是正常状态）。
//
// ⚠️ 测试用**真实临时目录**（不 mock fs）⇒ 验的是真代码路径；
//    只有「某个文件删不掉」这一条靠**注入 fs** 制造（真造不出「被占用」）。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanupUpdateDir, type UpdateCleanupFs } from '../electron/updateCleanup'

/** 本次测试用到的临时目录（`afterEach` 统一清）。 */
const tempDirs: string[] = []

/** 造一个临时目录。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnm-t89-3-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

describe('更新目录清理（T89-③）', () => {
  it('目录不存在 ⇒ **不报错**，结果为空（还没下过更新是正常状态）', () => {
    const dir = join(tempDir(), 'never-created')

    const result = cleanupUpdateDir(dir)

    expect(result.removed).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('清空目录里的**普通文件**', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'FN-Music-Setup-0.2.5.exe'), 'x', 'utf8')
    writeFileSync(join(dir, 'FN-Music-Setup-0.2.6.exe.part'), 'x', 'utf8')

    const result = cleanupUpdateDir(dir)

    expect(result.removed.sort()).toEqual(['FN-Music-Setup-0.2.5.exe', 'FN-Music-Setup-0.2.6.exe.part'])
    expect(readdirSync(dir)).toEqual([])
  })

  it('`keep` 指定的文件**不被删**（本次刚下载的那个要留着装）', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'FN-Music-Setup-0.2.6.exe'), 'x', 'utf8')
    writeFileSync(join(dir, 'FN-Music-Setup-0.2.5.exe'), 'x', 'utf8')

    const result = cleanupUpdateDir(dir, { keep: 'FN-Music-Setup-0.2.6.exe' })

    expect(result.removed).toEqual(['FN-Music-Setup-0.2.5.exe'])
    expect(readdirSync(dir)).toEqual(['FN-Music-Setup-0.2.6.exe'])
  })

  it('遇到**子目录一律跳过**（不递归、不删目录）⇒ 不会误伤别的东西', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'inner.txt'), 'x', 'utf8')
    writeFileSync(join(dir, 'old.exe'), 'x', 'utf8')

    const result = cleanupUpdateDir(dir)

    expect(result.removed).toEqual(['old.exe'])
    expect(result.skipped).toEqual(['sub'])
    // ⚠️ 子目录**原样留着**，里面那个文件也没动。
    expect(existsSync(join(dir, 'sub', 'inner.txt'))).toBe(true)
  })

  it('某个文件**删不掉** ⇒ 不影响其它文件被删，也不抛错', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'locked.exe'), 'x', 'utf8')
    writeFileSync(join(dir, 'normal.exe'), 'x', 'utf8')

    const fs: UpdateCleanupFs = {
      readdir: (target) => readdirSync(target),
      stat: (target) => statSync(target),
      rm: (target) => {
        if (target.includes('locked.exe')) throw new Error('EBUSY: resource busy')
        rmSync(target, { force: true })
      },
    }

    const result = cleanupUpdateDir(dir, { fs })

    expect(result.failed).toEqual(['locked.exe'])
    // ⚠️ 其它文件**照常被删** ⇒ 一个坏文件不会卡住整轮清理。
    expect(result.removed).toEqual(['normal.exe'])
    expect(existsSync(join(dir, 'locked.exe'))).toBe(true)
    expect(existsSync(join(dir, 'normal.exe'))).toBe(false)
  })

  it('目录里**什么都没有** ⇒ 结果为空，不报错', () => {
    const dir = tempDir()

    const result = cleanupUpdateDir(dir)

    expect(result.removed).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.skipped).toEqual([])
  })
})
