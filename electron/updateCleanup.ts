import { readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// T89-③：自动更新的临时安装包目录 —— 旧安装包不清理
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这个目录必须有人管**：自动更新把安装包下到
//    `%TEMP%\fnmusic-update\`，**只进不出** ⇒ 每更新一版就多留一份
//    **86 MB**（实测 v0.2.5 的 Setup = 86,106,756 B），旧的永远不走。
//
// ⚠️ **为什么「启动时清空」是安全的**（不是乱删）：更新状态
//    （`download` / `status`）是**内存态**（`src/state/updateStore.ts`，不落盘）
//    ⇒ 重启之后点「启动安装」必然报「还没有已下载的安装包」
//    ⇒ 「下载了、关掉应用、明天再装」这个流程**本来就不存在**
//    ⇒ **应用启动时还躺在这里的文件，按定义就是上一轮会话的垃圾**。
//
// ⚠️ **安全边界**：
//    - **只删普通文件**；遇到**子目录一律跳过**（不递归、不删目录）⇒ 不会误伤别的东西。
//    - **删不掉就算了**（文件被安装器占用 / 权限不足）⇒ 清理**绝不能**让启动或下载失败。
//    - 只管**自己那一个目录** ⇒ `%TEMP%` 里的其它东西一个都不碰。
// ---------------------------------------------------------------------------

/** 一次清理的结果。 */
export interface UpdateCleanupResult {
  /** 删掉的文件名。 */
  removed: string[]
  /** 删不掉的（被占用 / 权限不足）⇒ **不影响其它文件**。 */
  failed: string[]
  /** 跳过的**子目录**（不删目录）。 */
  skipped: string[]
}

/** 清理用到的文件系统操作（可注入 ⇒ 可单测）。 */
export interface UpdateCleanupFs {
  readdir(dir: string): string[]
  stat(target: string): { isDirectory(): boolean }
  rm(target: string): void
}

/** 默认实现（真文件系统）。 */
const DEFAULT_FS: UpdateCleanupFs = {
  readdir: readdirSync,
  stat: statSync,
  rm: (target) => {
    rmSync(target, { force: true })
  },
}

/**
 * 清理更新目录里的旧文件。
 *
 * @param dir 更新目录（只管这一个）。
 * @param opts.keep 要**保留**的文件名（本次刚下载的那个）。
 * @param opts.fs 文件系统操作（默认真文件系统；测试可注入）。
 */
export function cleanupUpdateDir(
  dir: string,
  opts?: { keep?: string; fs?: UpdateCleanupFs },
): UpdateCleanupResult {
  const fs = opts?.fs ?? DEFAULT_FS
  const result: UpdateCleanupResult = { removed: [], failed: [], skipped: [] }

  let entries: string[]
  try {
    entries = fs.readdir(dir)
  } catch {
    // ⚠️ 目录不存在（还没下过更新）⇒ **不是错误**，什么都不用做。
    return result
  }

  for (const entry of entries) {
    // ⚠️ 本次刚下载的那个要留着（下一步就要装它）。
    if (opts?.keep !== undefined && entry === opts.keep) continue

    const target = path.join(dir, entry)
    try {
      // ⚠️ **只删普通文件**：子目录一律跳过（不递归、不删目录）。
      if (fs.stat(target).isDirectory()) {
        result.skipped.push(entry)
        continue
      }
      fs.rm(target)
      result.removed.push(entry)
    } catch {
      // ⚠️ 删不掉（被安装器占用 / 权限不足）⇒ **记下来，不抛**
      //    ⇒ 清理永远不能让启动或下载失败。
      result.failed.push(entry)
    }
  }

  return result
}
