import { app, BrowserWindow, session as electronSession } from 'electron'
import path from 'node:path'

import type { PlayerCommand, PlayerStateSnapshot } from '../shared/playerBridge'
import type { ThemeName } from '../shared/types'
import { resolveThemeName, themeSpec } from '../shared/themes'
import { registerAuthIpc, registerPlayerIpc, PrefsStore } from './ipc'
import { TrustedHosts } from './cert'
import { createHttpStack } from './http'
import { createNasOAuthHandlers } from './oauthWindow'
import { registerFnmSchemePrivileges, registerProxy } from './proxy'
import { SessionManager } from './session'
import { createCoverFetcher, createTray } from './tray'

// dev 模式由 VITE_DEV_SERVER_URL 指向 vite dev server；
// 生产模式（npm start / 打包后的应用）加载随包发布的 dist/index.html。
const devServerUrl = process.env.VITE_DEV_SERVER_URL

// ---------------------------------------------------------------------------
// 进程级状态（托盘 / 单实例 / 关闭拦截都要用）
// ---------------------------------------------------------------------------

/** 主窗口（`second-instance` 与托盘都要用它）。 */
let mainWindow: BrowserWindow | null = null

/**
 * 「正在退出」标志。
 *
 * ⚠️ **关闭窗口被拦截后 `app.on('window-all-closed')` 永远不触发** → 应用会常驻
 *    （这是**预期**行为：后台续播）。真正退出只能走托盘菜单的「退出」，
 *    退出前先把本标志置位，让 `close` 处理器不再拦截。
 */
let isQuitting = false

/** 主进程缓存的播放器状态（托盘 tooltip / 图标用）。 */
let currentPlayerState: PlayerStateSnapshot | null = null

/** 调出主窗口（托盘左键、单实例 `second-instance`、IPC `win:*` 都走它）。 */
function showMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------------------------------------------------------------------------
// 接线顺序（**顺序本身就是正确性的一部分**）
// ---------------------------------------------------------------------------
//
// 1. **在 `app.whenReady()` 之前**注册 `fnm://` 的 scheme 特权——
//    Electron 只允许在 ready 之前调用 `registerSchemesAsPrivileged()`，
//    放到 ready 之后会抛错。
registerFnmSchemePrivileges()

// 2. **单实例锁**（**尽早调用**，`app.whenReady()` 之前即可）。
//
//    第二个实例直接退出；首个实例收到 `second-instance` 时把已有窗口调出来。
//    ⚠️ Task 23 的 E2E 若要「连启两次」，会被这道锁拦掉——那是既定行为。
const isPrimaryInstance = app.requestSingleInstanceLock()

if (!isPrimaryInstance) {
  // 不是首个实例：立刻退出（不建窗口、不建托盘）。
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app
    .whenReady()
    .then(() => {
      // 3. ready 之后才创建会话管理器：`safeStorage` 与 `app.getPath('userData')`
      //    在 ready 之前都不可用。
      //
      //    受信 host 集合：**只**放行「用户填过的服务器 host」与
      //    「由 FN ID 推导出来的中继域名」。同一个实例要同时交给
      //    `registerAuthIpc`（登录 / 探测时登记）与证书校验回调（放行判定）。
      const trusted = new TrustedHosts()

      // 4. 出网通道（Task 9b）：**Chromium 分区栈**。
      //
      //    主进程对 NAS 的流量（会话层 / 探测 / 代理 / server-info / 托盘封面）
      //    全部走它，而不是 Node 的全局 `fetch`（undici）——只有 Chromium 栈才受
      //    `setCertificateVerifyProc` 管辖，「只放行用户填写的 host」才真正生效。
      //    分区名带信任版本号（`fn-nas-v<epoch>`）：信任集合一变就换分区，
      //    绕开旧分区里缓存的证书错误（规格 §15.9 的实测结论）。
      //
      //    ⚠️ 会话层 / 代理层 / 认证 IPC / **托盘封面**必须共用**同一个**实例，
      //    否则各层的信任版本号各走各的。
      const http = createHttpStack({ trusted })

      const session = new SessionManager({ http })

      // 5. `fnm://` 协议代理（渲染进程唯一的出网出口）。
      registerProxy(session, { http })

      // 6. NAS 账号 OAuth（Task 11）：授权窗口 + 静默续期。
      //
      //    ⚠️ **必须注入同一个 `HttpStack` 实例**（追加要求 F）：
      //    `createHttpStack()` 不传 `trusted` 时会内部 new 一个**空**信任集合，
      //    自签 NAS 直接连不上且极难排查。
      //    ⚠️ `trusted` 也必须是同一个实例：授权分区上的证书放行要用同一份信任集合。
      const { nasLoginHandler, nasReloginHandler } = createNasOAuthHandlers({
        session,
        http,
        trusted,
      })

      //    静默续期（Task 7 的 `setNasRelogin` 契约）：返回新 token，空串 = 失败。
      session.setNasRelogin(nasReloginHandler)

      // 7. 认证 IPC（渲染进程的登录页通过 `window.fn` 调用）。
      registerAuthIpc(session, { trusted, http, nasLoginHandler })

      // 8. 证书放行：**只**对 `trusted` 里的 host 放行自签 / 非受信证书。
      //    ⚠️ 绝不无条件 `callback(0)`——未登记的 host 一律走 Chromium 默认校验
      //    （`verify` 返回 `-3`），其余站点照常校验。
      //    ⚠️ `session` 这个名字已被会话管理器占用，故 Electron 的 session 模块取别名。
      //    （分区 session 上的 verify proc 由 `HttpStack` 自己注册；
      //    这里额外给 defaultSession 也挂一份，覆盖渲染进程自己发起的请求。）
      electronSession.defaultSession.setCertificateVerifyProc((request, callback) => {
        callback(trusted.verify(request.hostname))
      })

      // 9. 恢复上次会话（Task 7 的生命周期约定：启动时 `load()`）。
      //    失败（文件不存在 / 损坏 / 解密失败）不影响启动，界面会显示未登录。
      session.load()

      // 10. 偏好（`<userData>/prefs.json`）：**只有非敏感偏好**，
      //     凭证在 `session.bin` 里，两者**不许混**。
      const prefs = new PrefsStore()

      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      })
      mainWindow = win

      // 10b. 主题（Task 6）：按**已保存**的主题设置窗口底色。
      //
      //     ⚠️ 渲染进程的 CSS 会接管窗口内容，但**窗口本身**在页面加载完成前
      //        是一块默认底色 → 这里先按主题铺上，避免「白闪」。
      //     ⚠️ 主题的真相源是 `prefs.json`（`prefs.read().theme`），
      //        不是这里的常量——这里只是**应用**它。
      const applyWindowTheme = (theme: ThemeName): void => {
        if (win.isDestroyed()) return
        win.setBackgroundColor(themeSpec(theme).windowBackground)
      }
      applyWindowTheme(resolveThemeName(prefs.read().theme))

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`[fnmusic] 页面加载失败: ${errorCode} ${errorDescription} (${validatedURL})`)
      })

      // 11. **关闭窗口 = 隐藏，播放继续**（Task 17 的核心用户体验）。
      //
      //     默认 `preventDefault()` + `hide()`；偏好里选了「直接退出」才真退出。
      win.on('close', (event) => {
        if (isQuitting) return
        if (prefs.read().closeBehavior === 'quit') {
          isQuitting = true
          app.quit()
          return
        }
        event.preventDefault()
        win.hide()
      })

      if (devServerUrl) {
        win.loadURL(devServerUrl).catch((err: unknown) => {
          console.error(`[fnmusic] dev server 加载失败 (${devServerUrl}):`, err)
        })
      } else {
        // __dirname = resources/app/dist-electron，故 ../dist/index.html 即随包发布的渲染进程入口
        const indexPath = path.join(__dirname, '../dist/index.html')
        win.loadFile(indexPath).catch((err: unknown) => {
          console.error(`[fnmusic] 生产页面加载失败 (${indexPath}):`, err)
        })
      }

      win.once('ready-to-show', () => win.show())

      // 12. 托盘（Task 17）。
      //
      //     封面字节由主进程自己取（**同一个 `HttpStack` 实例**），
      //     按 `coverId` 缓存（有上界），**异步**取——**不阻塞**托盘创建。
      const cover = createCoverFetcher({ http, session })
      const tray = createTray({
        cover,
        getState: () => currentPlayerState,
        // 托盘菜单 → 主进程 → 渲染进程执行（主进程是唯一的命令路由）。
        sendCommand: (command: PlayerCommand) => {
          win.webContents.send('player:command', command)
        },
        showWindow: showMainWindow,
        quit: () => {
          isQuitting = true
          app.quit()
        },
      })

      // 13. 播放器 / 窗口 / 偏好 IPC（Task 17）。
      //
      //     `player:state`（渲染进程推来）→ 更新托盘；
      //     `player:command`（渲染进程推来）→ **转发**回渲染进程执行。
      registerPlayerIpc({
        prefs,
        getTarget: () => (win.isDestroyed() ? null : win.webContents),
        getWindow: () => (win.isDestroyed() ? null : win),
        onPlayerState: (state) => {
          currentPlayerState = state
          tray.update(state)
        },
        // 主题切了 → 窗口底色跟着换（Task 6）。
        onTheme: (theme) => applyWindowTheme(theme),
        requestClose: () => {
          if (win.isDestroyed()) return
          win.close()
        },
      })
    })
    .catch((err: unknown) => {
      console.error('[fnmusic] 应用启动失败:', err)
      app.quit()
    })
}

// ⚠️ 窗口被拦截关闭时这个分支**永远不触发**（应用常驻是预期行为）。
//    真正退出走托盘菜单的「退出」。
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
