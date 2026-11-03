import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createMockServer, type MockServer } from '../../mock-server/server'

// ---------------------------------------------------------------------------
// E2E 的应用夹具（Task 13）
// ---------------------------------------------------------------------------
//
// 起一个**真实**的 Electron 进程 + 一个**假 NAS**（mock server），
// 让用例可以在**没有 NAS、没有网络**的前提下走通「登录 → 曲库 → 播放」。
//
// ---------------------------------------------------------------------------
// 隔离要点（每一条都是踩过才知道的）
// ---------------------------------------------------------------------------
// 1. **`--user-data-dir` 指向临时目录**：
//    - 隔离 `prefs.json` / `session.bin` / `downloads.json`（绝不能污染用户数据）；
//    - **更关键**：Electron 的单实例锁是按 userData 目录走的——
//      用户机器上若正开着真客户端，E2E 实例会因拿不到锁而**直接 `app.quit()`**
//      （`electron/main.ts` 里的既定行为），表现为「窗口一闪就没了」。
//      隔离 userData 就等于隔离了锁。
// 2. **不设 `VITE_DEV_SERVER_URL`** → 走生产路径 `loadFile(dist/index.html)`，
//    故运行 E2E 前必须先 `npm run build`（`package.json` 的 `e2e` 脚本已串好）。
// 3. **mock server 跑在测试进程里**：端口随机 → 通过登录表单把地址填进去，
//    既不写死端口，也不需要额外的环境变量。
// 4. **退出要强制**：应用默认拦截窗口 `close`（隐藏窗口、播放继续），
//    普通的 `app.quit()` 会被 `preventDefault()` 挡下来 → 进程不退出、
//    用例会挂。故用 `app.exit(0)` 强制退出。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - mock 的口令是**公开字面量**（`x`），只在本机回环上有效（mock 自带回环守卫）；
// - **不写真实 FN ID / 账号 / 口令**——用的是 mock 的占位数据；
// - 临时目录用完即删。

/** 仓库根目录（`e2e/helpers/` 上两级）。 */
const APP_ROOT = resolve(__dirname, '..', '..')

/** mock 的账号口令（**公开字面量**，见 `mock-server/server.ts`）。 */
export const MOCK_USERNAME = 'demo'

/** mock 的账号口令（**公开字面量**，见 `mock-server/server.ts`）。 */
export const MOCK_PASSWORD = 'x'

/** 一个已启动的应用实例。 */
export interface AppFixture {
  /** Electron 应用实例。 */
  app: ElectronApplication
  /** 主窗口的页面。 */
  window: Page
  /** mock server（假 NAS）。 */
  mock: MockServer
  /** 隔离出来的 userData 目录。 */
  userDataDir: string
  /** 关闭应用并清理临时目录。 */
  close: () => Promise<void>
}

/**
 * 把 `process.env` 转成 Playwright 要的 `Record<string, string>`。
 *
 * ⚠️ `process.env` 的值类型是 `string | undefined`（`NODE_ENV` 之类可能没设），
 *    而 Playwright 的 `env` 只收 `string` → 这里**滤掉** undefined。
 */
function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/**
 * 启动应用（Electron 进程 + mock server）。
 *
 * @returns 应用夹具；调用方**必须**在结束时调 `close()`。
 */
export async function launchApp(): Promise<AppFixture> {
  const mock = createMockServer()
  const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-e2e-'))

  let app: ElectronApplication
  try {
    app = await electron.launch({
      // ⚠️ 第一个参数是**应用目录**（`package.json` 的 `main` 指向
      //    `dist-electron/main.js`）；后面跟的是 Chromium 开关。
      args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
      env: stringEnv(process.env),
    })
  } catch (err) {
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
    throw err
  }

  const window = await app.firstWindow()

  const close = async (): Promise<void> => {
    await quitApp(app)
    await mock.close()
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // 清理失败不掩盖测试结果（Electron 可能还攥着几个句柄）。
    }
  }

  return { app, window, mock, userDataDir, close }
}

/**
 * 强制退出 Electron 进程。
 *
 * ⚠️ 应用默认拦截窗口 `close`（隐藏窗口、播放继续），普通 `app.quit()` 会被
 *    `preventDefault()` 挡下来 → 进程不退出、用例挂住。故走 `app.exit(0)`
 *    （立即退出，不触发 `before-quit` / `will-quit`）。
 */
async function quitApp(app: ElectronApplication): Promise<void> {
  await Promise.race([
    app
      .evaluate(({ app: electronApp }) => {
        electronApp.exit(0)
      })
      .catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  await app.close().catch(() => undefined)
}

/**
 * 在登录页完成一次登录（地址模式 + 独立账号）。
 *
 * @param window 主窗口页面。
 * @param server 服务器地址（形如 `http://127.0.0.1:12345`）。
 */
export async function login(window: Page, server: string): Promise<void> {
  await window.fill('#fnm-address', server)
  await window.fill('#fnm-username', MOCK_USERNAME)
  await window.fill('#fnm-password', MOCK_PASSWORD)
  await window.click('button[type="submit"]')
}
