// ---------------------------------------------------------------------------
// T89-②：userData 目录改名（`fnmusic-desktop` → `Sanlos Music`）+ 旧目录迁移
// ---------------------------------------------------------------------------
//
// ⚠️ **钉的是什么**：
// 1. 目录名的**来源**是 `package.json` 的 `productName`（钉住机制本身，
//    免得以后有人「顺手」改成 `app.setPath` ⇒ 那个 API 会覆盖 `--user-data-dir`
//    ⇒ 会摧毁 E2E 的数据隔离）。
// 2. 旧目录的内容**整个搬过去**，**一个字节都不丢**（偏好 / 凭据 / Chromium 数据）。
// 3. 同名**不覆盖** ⇒ 旧的那份留在旧目录里（最坏情况只是「分家」，不是「丢失」）。
// 4. **守卫**：`userData` 被人为改走（E2E / 便携版）时**完全不迁移**
//    ⇒ 跑测试不会动用户真实数据。
// 5. **幂等**：搬过一次之后不再搬。
// 6. 降级路径（跨设备改名失败）⇒ 复制 + 保留源 ⇒ **仍然不丢数据**。
//
// ⚠️ 测试用**真实临时目录**（不 mock fs）⇒ 验的是真代码路径；
//    只有「改名必失败」这一条靠**注入 fs** 制造（真造不出跨设备场景）。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_USER_DATA_DIR_NAME,
  MIGRATION_MARKER_FILE_NAME,
  USER_DATA_DIR_NAME,
  migrateLegacyUserData,
  type UserDataFsOps,
} from '../electron/userDataDir'

/** 仓库根目录（**不依赖 `process.cwd()`**）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 真文件系统（注入用）。 */
const REAL_FS: UserDataFsOps = {
  exists: existsSync,
  readdir: readdirSync,
  mkdir: (dir, opts) => {
    mkdirSync(dir, opts)
  },
  rename: renameSync,
  rmdir: rmdirSync,
  writeFile: (target, data, encoding) => {
    writeFileSync(target, data, encoding)
  },
  stat: statSync,
  copyFile: copyFileSync,
}

/** 本次测试用到的临时目录（`afterEach` 统一清）。 */
const tempDirs: string[] = []

/** 造一个临时的 appData 根目录。 */
function tempAppData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnm-t89-2-'))
  tempDirs.push(dir)
  return dir
}

/** 造一个「旧 userData 目录」，内容固定。 */
function seedLegacy(appData: string): string {
  const legacy = join(appData, LEGACY_USER_DATA_DIR_NAME)
  mkdirSync(join(legacy, 'Local Storage'), { recursive: true })
  writeFileSync(join(legacy, 'prefs.json'), '{"prefs":{"theme":"fluent"}}', 'utf8')
  writeFileSync(join(legacy, 'session.bin'), 'CIPHER', 'utf8')
  writeFileSync(join(legacy, 'local-library.json'), '{}', 'utf8')
  writeFileSync(join(legacy, 'Local Storage', 'leveldb'), 'LS', 'utf8')
  return legacy
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 目录名的来源
// ---------------------------------------------------------------------------

describe('userData 目录名的来源（T89-②）', () => {
  it('目录名 = `package.json` 的 `productName`；`name` 保持不变（它就是旧目录名的由来）', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      name?: string
      productName?: string
    }
    expect(pkg.productName).toBe(USER_DATA_DIR_NAME)
    expect(pkg.name).toBe(LEGACY_USER_DATA_DIR_NAME)
  })

  it('新旧目录名**不是同一个**（否则这次改名等于没做）', () => {
    expect(USER_DATA_DIR_NAME).not.toBe(LEGACY_USER_DATA_DIR_NAME)
  })
})

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

describe('旧 userData 目录迁移（T89-②）', () => {
  it('旧目录不存在 → 什么都不做（全新安装），连新目录都不建', () => {
    const appData = tempAppData()

    const report = migrateLegacyUserData({
      userDataDir: join(appData, USER_DATA_DIR_NAME),
      appDataDir: appData,
    })

    expect(report.status).toBe('no-legacy')
    expect(report.moved).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
    expect(existsSync(join(appData, USER_DATA_DIR_NAME))).toBe(false)
  })

  it('旧目录存在 → 内容**整个搬过去**（偏好 / 凭据 / Chromium 数据逐字节相同），旧目录消失', () => {
    const appData = tempAppData()
    const legacy = seedLegacy(appData)
    const target = join(appData, USER_DATA_DIR_NAME)
    // ⚠️ Electron 会在跑 main.js **之前**就把新目录建好（空的）—— 必须能处理。
    mkdirSync(target, { recursive: true })

    const report = migrateLegacyUserData({ userDataDir: target, appDataDir: appData })

    expect(report.status).toBe('migrated')
    expect([...report.moved].sort()).toEqual([
      'Local Storage',
      'local-library.json',
      'prefs.json',
      'session.bin',
    ])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])

    // ⚠️ 逐字节相同 —— 不是「文件在」，是**内容一样**。
    expect(readFileSync(join(target, 'prefs.json'), 'utf8')).toBe('{"prefs":{"theme":"fluent"}}')
    expect(readFileSync(join(target, 'session.bin'), 'utf8')).toBe('CIPHER')
    expect(readFileSync(join(target, 'local-library.json'), 'utf8')).toBe('{}')
    expect(readFileSync(join(target, 'Local Storage', 'leveldb'), 'utf8')).toBe('LS')

    // 搬空了 ⇒ 旧目录（空壳）被清掉 ⇒ 用户不用再看到一个陌生文件夹。
    expect(existsSync(legacy)).toBe(false)
  })

  it('新目录已有同名文件 → **不覆盖**；旧的那份**留在旧目录**里（不丢数据）', () => {
    const appData = tempAppData()
    const legacy = seedLegacy(appData)
    const target = join(appData, USER_DATA_DIR_NAME)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'prefs.json'), 'NEW', 'utf8')

    const report = migrateLegacyUserData({ userDataDir: target, appDataDir: appData })

    expect(report.status).toBe('migrated')
    expect(report.skipped).toContain('prefs.json')
    expect(report.moved).not.toContain('prefs.json')

    // ⚠️ 新目录里的是**新**的那份，没被旧的盖掉。
    expect(readFileSync(join(target, 'prefs.json'), 'utf8')).toBe('NEW')
    // ⚠️ 旧的那份**还在**旧目录里 ⇒ 没有任何数据被删。
    expect(readFileSync(join(legacy, 'prefs.json'), 'utf8')).toBe('{"prefs":{"theme":"fluent"}}')
    // 旧目录里还有东西 ⇒ 目录本身保留。
    expect(existsSync(legacy)).toBe(true)
  })

  it('**幂等**：搬过一次之后再来 ⇒ `already-migrated`（不再搬、不再写）', () => {
    const appData = tempAppData()
    seedLegacy(appData)
    const target = join(appData, USER_DATA_DIR_NAME)
    mkdirSync(target, { recursive: true })

    expect(migrateLegacyUserData({ userDataDir: target, appDataDir: appData }).status).toBe('migrated')

    const second = migrateLegacyUserData({ userDataDir: target, appDataDir: appData })
    expect(second.status).toBe('already-migrated')
    expect(second.moved).toEqual([])
  })

  it('标记文件记录「搬了什么 / 跳过了什么」（可解释：用户问「数据去哪了」能答）', () => {
    const appData = tempAppData()
    seedLegacy(appData)
    const target = join(appData, USER_DATA_DIR_NAME)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'prefs.json'), 'NEW', 'utf8')

    migrateLegacyUserData({ userDataDir: target, appDataDir: appData })

    const marker = JSON.parse(
      readFileSync(join(target, MIGRATION_MARKER_FILE_NAME), 'utf8'),
    ) as { from: string; to: string; moved: string[]; skipped: string[] }
    expect(marker.from).toBe(LEGACY_USER_DATA_DIR_NAME)
    expect(marker.to).toBe(USER_DATA_DIR_NAME)
    expect(marker.moved).toContain('session.bin')
    expect(marker.skipped).toContain('prefs.json')
  })
})

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

describe('迁移守卫（T89-②）', () => {
  it('`userData` 被改走（E2E / 便携版）→ **完全不迁移**：用户真实数据一个字节都不动', () => {
    const appData = tempAppData()
    const legacy = seedLegacy(appData)
    // ⚠️ E2E 就是这么干的（`--user-data-dir` 指向临时目录）。
    const isolated = mkdtempSync(join(tmpdir(), 'fnm-t89-2-e2e-'))
    tempDirs.push(isolated)

    const report = migrateLegacyUserData({ userDataDir: isolated, appDataDir: appData })

    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('user-data-dir-redirected')
    expect(report.moved).toEqual([])

    // ⚠️ 旧目录**原封不动**。
    expect(readFileSync(join(legacy, 'prefs.json'), 'utf8')).toBe('{"prefs":{"theme":"fluent"}}')
    expect(existsSync(join(legacy, 'session.bin'))).toBe(true)
    // ⚠️ 连新目录都没被创建。
    expect(existsSync(join(appData, USER_DATA_DIR_NAME))).toBe(false)
  })

  it('当前生效的 userData **就是**旧目录 → 拒绝（不搬自己脚下的地板）', () => {
    const appData = tempAppData()
    const legacy = seedLegacy(appData)

    const report = migrateLegacyUserData({ userDataDir: legacy, appDataDir: appData })

    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('legacy-dir-in-use')
    expect(existsSync(join(legacy, 'prefs.json'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 降级路径
// ---------------------------------------------------------------------------

describe('跨设备改名失败的降级（T89-②）', () => {
  it('改名失败 → 降级为「复制 + 保留源」⇒ **仍然不丢数据**', () => {
    const appData = tempAppData()
    const legacy = seedLegacy(appData)
    const target = join(appData, USER_DATA_DIR_NAME)
    mkdirSync(target, { recursive: true })

    const fs: UserDataFsOps = {
      ...REAL_FS,
      rename: () => {
        throw new Error('EXDEV: cross-device link not permitted')
      },
    }

    const report = migrateLegacyUserData({ userDataDir: target, appDataDir: appData, fs })

    expect(report.status).toBe('migrated')
    expect(report.moved).toContain('prefs.json')
    expect(report.failed).toEqual([])
    // ⚠️ 内容复制过去了。
    expect(readFileSync(join(target, 'prefs.json'), 'utf8')).toBe('{"prefs":{"theme":"fluent"}}')
    expect(readFileSync(join(target, 'Local Storage', 'leveldb'), 'utf8')).toBe('LS')
    // ⚠️ 源**保留**（复制不是移动）⇒ 旧目录还在。
    expect(existsSync(join(legacy, 'prefs.json'))).toBe(true)
    expect(existsSync(legacy)).toBe(true)
  })

  it('改名与复制**都**失败 → 记进 `failed`，**源保留**（数据不丢，只是没搬动）', () => {
    const appData = tempAppData()
    const legacy = seedLegacy(appData)
    const target = join(appData, USER_DATA_DIR_NAME)
    mkdirSync(target, { recursive: true })

    const fs: UserDataFsOps = {
      ...REAL_FS,
      rename: () => {
        throw new Error('EXDEV')
      },
      copyFile: () => {
        throw new Error('EPERM')
      },
    }

    const report = migrateLegacyUserData({ userDataDir: target, appDataDir: appData, fs })

    expect(report.status).toBe('migrated')
    expect(report.failed).toContain('prefs.json')
    // ⚠️ 搬不动的那些**还在旧目录里**。
    expect(existsSync(join(legacy, 'prefs.json'))).toBe(true)
    expect(readFileSync(join(legacy, 'prefs.json'), 'utf8')).toBe('{"prefs":{"theme":"fluent"}}')
    // ⚠️⚠️ **有失败项时不写标记文件** —— 标记的含义是「已经搬完了」。
    //    写上去 ⇒ 下次启动直接跳过 ⇒ 那几项**永远**不会被重试。
    expect(existsSync(join(target, MIGRATION_MARKER_FILE_NAME))).toBe(false)
  })

  it('有失败项时**不写标记** ⇒ 下次启动会**再试一次**（不放弃）', () => {
    const appData = tempAppData()
    seedLegacy(appData)
    const target = join(appData, USER_DATA_DIR_NAME)
    mkdirSync(target, { recursive: true })

    // ⚠️ 「失败」= 改名失败**且**复制也失败（只失败一个会走降级复制，仍算搬成功）。
    let allFail = true
    const fs: UserDataFsOps = {
      ...REAL_FS,
      rename: (from, to) => {
        if (allFail) throw new Error('EPERM')
        renameSync(from, to)
      },
      copyFile: (from, to) => {
        if (allFail) throw new Error('EPERM')
        copyFileSync(from, to)
      },
    }

    const first = migrateLegacyUserData({ userDataDir: target, appDataDir: appData, fs })
    expect(first.failed).toContain('prefs.json')
    expect(existsSync(join(target, MIGRATION_MARKER_FILE_NAME))).toBe(false)

    // ⚠️ 第二次：改名不再失败 ⇒ 补搬成功 ⇒ 这时才写标记。
    allFail = false
    const second = migrateLegacyUserData({ userDataDir: target, appDataDir: appData, fs })
    expect(second.moved).toContain('prefs.json')
    expect(existsSync(join(target, MIGRATION_MARKER_FILE_NAME))).toBe(true)
    expect(readFileSync(join(target, 'prefs.json'), 'utf8')).toBe('{"prefs":{"theme":"fluent"}}')
  })
})
