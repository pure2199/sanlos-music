import { app, BrowserWindow, session as electronSession } from 'electron'
import path from 'node:path'

import { registerAuthIpc } from './ipc'
import { TrustedHosts } from './cert'
import { registerFnmSchemePrivileges, registerProxy } from './proxy'
import { SessionManager } from './session'

// dev 模式由 VITE_DEV_SERVER_URL 指向 vite dev server；
// 生产模式（npm start / 打包后的应用）加载随包发布的 dist/index.html。
const devServerUrl = process.env.VITE_DEV_SERVER_URL

// ---------------------------------------------------------------------------
// 接线顺序（**顺序本身就是正确性的一部分**）
// ---------------------------------------------------------------------------
//
// 1. **在 `app.whenReady()` 之前**注册 `fnm://` 的 scheme 特权——
//    Electron 只允许在 ready 之前调用 `registerSchemesAsPrivileged()`，
//    放到 ready 之后会抛错。
registerFnmSchemePrivileges()

app
  .whenReady()
  .then(() => {
    // 2. ready 之后才创建会话管理器：`safeStorage` 与 `app.getPath('userData')`
    //    在 ready 之前都不可用。
    const session = new SessionManager()

    // 受信 host 集合：**只**放行「用户填过的服务器 host」与
    // 「由 FN ID 推导出来的中继域名」。同一个实例要同时交给
    // `registerAuthIpc`（登录 / 探测时登记）与证书校验回调（放行判定）。
    const trusted = new TrustedHosts()

    // 3. `fnm://` 协议代理（渲染进程唯一的出网出口）。
    registerProxy(session)

    // 4. 认证 IPC（渲染进程的登录页通过 `window.fn` 调用）。
    registerAuthIpc(session, { trusted })

    // 5. 证书放行：**只**对 `trusted` 里的 host 放行自签 / 非受信证书。
    //    ⚠️ 绝不无条件 `callback(0)`——未登记的 host 一律走 Chromium 默认校验
    //    （`verify` 返回 `-3`），其余站点照常校验。
    //    ⚠️ `session` 这个名字已被会话管理器占用，故 Electron 的 session 模块取别名。
    electronSession.defaultSession.setCertificateVerifyProc((request, callback) => {
      callback(trusted.verify(request.hostname))
    })

    // 6. 恢复上次会话（Task 7 的生命周期约定：启动时 `load()`）。
    //    失败（文件不存在 / 损坏 / 解密失败）不影响启动，界面会显示未登录。
    session.load()

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

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[fnmusic] 页面加载失败: ${errorCode} ${errorDescription} (${validatedURL})`)
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
  })
  .catch((err: unknown) => {
    console.error('[fnmusic] 应用启动失败:', err)
    app.quit()
  })

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
