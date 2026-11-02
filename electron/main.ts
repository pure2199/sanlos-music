import { app, BrowserWindow } from 'electron'
import path from 'node:path'

// dev 模式由 VITE_DEV_SERVER_URL 指向 vite dev server；
// 生产模式（npm start / 打包后的应用）加载随包发布的 dist/index.html。
const devServerUrl = process.env.VITE_DEV_SERVER_URL

app
  .whenReady()
  .then(() => {
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
