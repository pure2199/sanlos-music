import { defineConfig } from '@playwright/test'

// ---------------------------------------------------------------------------
// Playwright 配置（Task 13：E2E 冒烟）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么必须是 Playwright（Electron），而不是 Vitest + jsdom**：
//    这个应用的核心链路**只在 Electron 主进程里存在**——
//    `fnm://` 协议代理、主进程 IPC（`prefs:*` / `download:*` / `ffmpeg:*`）、
//    `fnml://` 本地媒体协议、真实 `<audio>`、托盘、窗口、DPAPI 加密的会话。
//    jsdom 里这些**一个都没有**，在 jsdom 里「测通过」等于什么都没测。
//
// ⚠️ **一次只跑一个**（`workers: 1` + `fullyParallel: false`）：
//    每个用例都要起一个 Electron 进程 + 一个 mock server，并行跑会抢端口、
//    抢单实例锁，还会让失败现场互相干扰。
//
// ⚠️ **不下载浏览器**：Playwright 的 `_electron` 驱动的是**本仓库的** Electron
//    （`node_modules/electron`），不需要 `playwright install`。
// ---------------------------------------------------------------------------

export default defineConfig({
  /** 用例目录。 */
  testDir: './e2e',
  /** 禁止并行：Electron 实例与 mock server 都要独占资源。 */
  fullyParallel: false,
  /** 单进程串行。 */
  workers: 1,
  /** 有人写了 `test.only` 就不许提交（CI 卫生）。 */
  forbidOnly: true,
  /** 失败不自动重试——重试会掩盖真实的不稳定。 */
  retries: 0,
  /** 单个用例超时（起 Electron + 登录 + 拉曲库，冷启动偏慢）。 */
  timeout: 120_000,
  /** 断言重试窗口。 */
  expect: { timeout: 20_000 },
  reporter: [['list']],
  /** 失败时的产物目录（截图 / trace）。 */
  outputDir: 'test-results',
  use: {
    /** 失败时保留 trace（便于复盘）。 */
    trace: 'retain-on-failure',
    /** 失败时截图。 */
    screenshot: 'only-on-failure',
  },
})
