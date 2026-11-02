import { app, BrowserWindow } from 'electron'
import path from 'node:path'

app.whenReady().then(() => {
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
  win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173')
  win.once('ready-to-show', () => win.show())
})
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
