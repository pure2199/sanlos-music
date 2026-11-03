// FLAC / 格式可解性实测探针（Electron 32.3.3 / Chromium 128）。
//
// 用法：& "<repo>\node_modules\electron\dist\electron.exe" tools\fn-flac-probe.js
//
// 用途：为「Chromium 能不能解这个格式」的判定提供**可复现的实测依据**，
// 而不是抄文档。ALAC / APE / DSF 等格式的 canPlayType 返回空串 → 确实不可解。
const { app, BrowserWindow } = require('electron')

app.disableHardwareAcceleration()

const TYPES = [
  'audio/flac',
  'audio/mpeg',
  'audio/wav',
  'audio/aiff',
  'audio/x-ape',
  'audio/x-dsd',
  'audio/vnd.dlna-adts',
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 })
  await win.loadURL('data:text/html,<html><body>x</body></html>')
  const probe = await win.webContents.executeJavaScript(`(() => {
    const a = document.createElement('audio')
    const out = {}
    for (const t of ${JSON.stringify(TYPES)}) {
      try { out[t] = a.canPlayType(t) } catch (e) { out[t] = 'throw:' + e.message }
    }
    return out
  })()`)
  console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, probe }, null, 2))
  app.quit()
}).catch((e) => {
  console.error('PROBE_ERROR', e && e.message)
  app.quit()
})
