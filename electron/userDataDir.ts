import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// T89-②：userData 目录改名（`fnmusic-desktop` → `Sanlos Music`）+ 旧目录迁移
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这件事不能「改名了事」**：用户数据目录里放着**偏好**（`prefs.json`）、
//    **登录凭据**（`session.bin`，DPAPI 加密）、**本地曲目登记**（`local-library.json`）
//    以及 Chromium 自己的 `Local Storage` / `Network` / `Preferences`。
//    直接换目录 ⇒ 用户升级后「配置与凭证全丢」，而且**不报错**、最难排查。
//    ⇒ 必须把旧目录的内容**搬**过去。
//
// ⚠️ **目录名是谁定的**：Electron 的 userData 默认路径 = `<appData>\<app.getName()>`，
//    而 `app.getName()` 读的是 `package.json` 的 **`productName`**（没有才回落 `name`）。
//    ⇒ 改 `package.json` 的 `productName` 即可，**不要**用 `app.setPath('userData', …)`：
//    实测 `setPath` 会**覆盖** `--user-data-dir` ⇒ 会摧毁 E2E 的数据隔离
//    （E2E 靠这个开关把 userData 指到临时目录，见 `e2e/helpers/app.ts`）。
//    ⚠️ 而 `productName` **不会**覆盖它（开关优先级更高）⇒ E2E 不受影响。
//
// ⚠️ **为什么是「逐项搬入」而不是整目录改名**：实测 Electron 在跑 main.js
//    **之前**就已经把 userData 目录**建好了（空的）** ⇒ `rename(legacy, target)`
//    会因「目标已存在」失败 ⇒ 只能逐项搬。
//
// ⚠️ **安全边界（一条都不许越线）**：
//    - **只搬，不删**：搬 = 改名（源路径消失、内容不丢）；
//      同名冲突时**跳过**（不覆盖），那一项**原地留在旧目录** ⇒ 没有任何数据被删。
//    - 唯一被移除的是「搬空之后的旧目录本身」（空目录）。
//    - **守卫**：`userData` 被人为改走（E2E / 便携版 / 命令行）时**完全不迁移**，
//      否则每次跑 E2E 都会把用户真实的旧目录搬走。
// ---------------------------------------------------------------------------

/** 新 userData 目录名（= `package.json` 的 `productName`）。 */
export const USER_DATA_DIR_NAME = 'Sanlos Music'

/** 旧 userData 目录名（= 旧 `package.json` 的 `name`）。 */
export const LEGACY_USER_DATA_DIR_NAME = 'fnmusic-desktop'

/** 迁移标记文件名（落在**新** userData 目录里）。 */
export const MIGRATION_MARKER_FILE_NAME = 'userdata-migration.json'

/**
 * 本模块用到的**文件系统操作**（可注入 ⇒ 降级路径也能被测试钉住）。
 *
 * ⚠️ 只抽出真正用到的那几个，**不做通用 fs 抽象**。
 */
export interface UserDataFsOps {
  exists(target: string): boolean
  readdir(dir: string): string[]
  mkdir(dir: string, opts: { recursive: boolean }): void
  rename(from: string, to: string): void
  rmdir(dir: string): void
  writeFile(target: string, data: string, encoding: 'utf8'): void
  stat(target: string): { isDirectory(): boolean }
  copyFile(from: string, to: string): void
}

/** 默认实现（真文件系统）。 */
const DEFAULT_FS: UserDataFsOps = {
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

/** 迁移结果。 */
export type UserDataMigrationStatus =
  /** 旧目录不存在（全新安装）⇒ 什么都不用做。 */
  | 'no-legacy'
  /** 守卫拦下（`userData` 被人为改走）⇒ **什么都没动**。 */
  | 'skipped'
  /** 标记文件已在 ⇒ 已经迁过（幂等）。 */
  | 'already-migrated'
  /** 搬完了。 */
  | 'migrated'

/** 一次迁移的结果报告。 */
export interface UserDataMigrationReport {
  /** 结果。 */
  status: UserDataMigrationStatus
  /** 旧目录绝对路径。 */
  legacyDir: string
  /** 新目录绝对路径。 */
  targetDir: string
  /** 搬过去的项。 */
  moved: string[]
  /** 因同名而**跳过**（留在旧目录里）的项。 */
  skipped: string[]
  /** 搬不动的项（既不能改名也不能复制）⇒ **留在旧目录里**。 */
  failed: string[]
  /** 守卫拦下的原因（`status === 'skipped'` 时有值）。 */
  reason?: string
}

/**
 * 比较两个路径是不是同一个目录。
 *
 * ⚠️ Windows 上路径**大小写不敏感** ⇒ 一律按小写比；
 *    同时 `path.resolve` 掉 `..`、相对路径与尾部斜杠。
 */
function samePath(a: string, b: string): boolean {
  const x = path.resolve(a)
  const y = path.resolve(b)
  return process.platform === 'win32'
    ? x.toLowerCase() === y.toLowerCase()
    : x === y
}

/**
 * 算出新旧两个 userData 目录的绝对路径。
 *
 * @param appDataDir `app.getPath('appData')`（Windows 上就是 `%APPDATA%`）。
 */
export function resolveUserDataPaths(appDataDir: string): {
  targetDir: string
  legacyDir: string
} {
  return {
    targetDir: path.join(appDataDir, USER_DATA_DIR_NAME),
    legacyDir: path.join(appDataDir, LEGACY_USER_DATA_DIR_NAME),
  }
}

/**
 * 守卫：判断**该不该**迁移。
 *
 * ⚠️ **这一层是本模块最要紧的东西**：迁移会动用户真实数据，
 *    条件不满足时必须**一个字节都不碰**。
 *
 * 两条否决：
 * 1. `userData` 被人为改走（`--user-data-dir`、便携版…）
 *    ⇒ 当前的 userData **不是**默认那个 ⇒ 搬旧目录等于**在测试/别人的环境里
 *    动用户的数据** ⇒ 拒绝。
 * 2. 当前生效的 userData **就是**旧目录
 *    ⇒ 说明这个进程还在用旧目录（`productName` 没生效）⇒ 搬走它等于**搬走
 *    自己脚下的地板** ⇒ 拒绝。
 */
export function checkUserDataMigrationGuard(opts: {
  /** 当前生效的 userData 目录。 */
  userDataDir: string
  /** 新目录。 */
  targetDir: string
  /** 旧目录。 */
  legacyDir: string
}): { ok: boolean; reason?: string } {
  // ⚠️ **判定顺序要紧**：先问「是不是正踩在旧目录上」，再问「是不是被改走了」。
  //    反过来写的话，「当前就在旧目录」会被报成「被改走」⇒ 排查时指向错误的方向。
  if (samePath(opts.userDataDir, opts.legacyDir)) {
    return { ok: false, reason: 'legacy-dir-in-use' }
  }
  if (!samePath(opts.userDataDir, opts.targetDir)) {
    return { ok: false, reason: 'user-data-dir-redirected' }
  }
  return { ok: true }
}

/**
 * 递归复制一个目录（**跨设备改名失败**时的降级路径）。
 *
 * ⚠️ **只复制、不删源** ⇒ 任何一步失败都只是「多了一份」，**不会丢数据**。
 */
function copyDirRecursive(from: string, to: string, fs: UserDataFsOps): void {
  fs.mkdir(to, { recursive: true })
  for (const entry of fs.readdir(from)) {
    const src = path.join(from, entry)
    const dst = path.join(to, entry)
    if (fs.stat(src).isDirectory()) copyDirRecursive(src, dst, fs)
    else fs.copyFile(src, dst)
  }
}

/**
 * 把旧 userData 目录的内容**搬**进新目录。
 *
 * ⚠️ **绝不覆盖**：目标已有同名项 ⇒ 跳过（那一项留在旧目录里）。
 * ⚠️ **幂等**：新目录里已有 {@link MIGRATION_MARKER_FILE_NAME} ⇒ 直接跳过。
 *
 * @param opts.userDataDir 当前生效的 userData 目录（`app.getPath('userData')`）。
 * @param opts.appDataDir `app.getPath('appData')`。
 * @param opts.fs 文件系统操作（默认真文件系统；测试可注入）。
 */
export function migrateLegacyUserData(opts: {
  userDataDir: string
  appDataDir: string
  fs?: UserDataFsOps
}): UserDataMigrationReport {
  const fs = opts.fs ?? DEFAULT_FS
  const { targetDir, legacyDir } = resolveUserDataPaths(opts.appDataDir)

  const report: UserDataMigrationReport = {
    status: 'no-legacy',
    legacyDir,
    targetDir,
    moved: [],
    skipped: [],
    failed: [],
  }

  // 守卫先过 —— 不满足就**什么都不做**。
  const guard = checkUserDataMigrationGuard({
    userDataDir: opts.userDataDir,
    targetDir,
    legacyDir,
  })
  if (!guard.ok) {
    report.status = 'skipped'
    report.reason = guard.reason
    return report
  }

  // ⚠️ **幂等检查必须排在「旧目录是否存在」之前**：
  //    搬完之后旧目录**已经不存在了**（被清空后删掉）⇒ 若先判旧目录存在，
  //    第二次启动会报成 `no-legacy`（而不是「已经迁过了」）⇒ 排查时会被误导。
  if (fs.exists(path.join(targetDir, MIGRATION_MARKER_FILE_NAME))) {
    report.status = 'already-migrated'
    return report
  }

  if (!fs.exists(legacyDir)) {
    report.status = 'no-legacy'
    return report
  }

  fs.mkdir(targetDir, { recursive: true })

  for (const entry of fs.readdir(legacyDir)) {
    const from = path.join(legacyDir, entry)
    const to = path.join(targetDir, entry)

    // 同名 ⇒ **不覆盖**（新目录里的是更新的一份），旧的留在原地。
    if (fs.exists(to)) {
      report.skipped.push(entry)
      continue
    }

    try {
      // 同卷 ⇒ 改名是**原子**且 O(1)（不拷字节）。
      fs.rename(from, to)
      report.moved.push(entry)
    } catch {
      // 跨设备（EXDEV）/ 被占用（EPERM、EBUSY）⇒ 降级为「复制 + 保留源」。
      try {
        if (fs.stat(from).isDirectory()) copyDirRecursive(from, to, fs)
        else fs.copyFile(from, to)
        report.moved.push(entry)
        // ⚠️ 源**保留**：复制失败也不会丢数据，只是旧目录还在。
      } catch {
        report.failed.push(entry)
      }
    }
  }

  // 标记文件：幂等锚点 + 「数据去哪了」的自述。
  // ⚠️⚠️ **有搬不动的项时绝不写标记**：标记的含义是「已经搬完了」。
  //    写上去 ⇒ 下次启动直接跳过 ⇒ 那几项**永远**留在旧目录里、永远不会被重试。
  //    不写 ⇒ 下次启动会再试一次（成功的那些已经搬走了，不会重复搬）。
  if (report.failed.length === 0) {
    fs.writeFile(
      path.join(targetDir, MIGRATION_MARKER_FILE_NAME),
      `${JSON.stringify(
        {
          version: 1,
          from: LEGACY_USER_DATA_DIR_NAME,
          to: USER_DATA_DIR_NAME,
          moved: report.moved,
          skipped: report.skipped,
          failed: report.failed,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }

  // 旧目录搬空了 ⇒ 把这个**空壳**删掉（用户不用再看到一个陌生文件夹）。
  // ⚠️ 只在**确实空了**时才删；里面还有东西（跳过的 / 失败的）⇒ 原样留着。
  try {
    if (fs.readdir(legacyDir).length === 0) fs.rmdir(legacyDir)
  } catch {
    /* 删不掉不影响正确性（旧目录还在而已） */
  }

  report.status = 'migrated'
  return report
}
