import { contextBridge, ipcRenderer } from 'electron'
import type { FnBridge } from '../shared/bridge'
import type { PlayerBridge, PlayerCommand } from '../shared/playerBridge'

// 渲染进程与主进程之间的桥。凭证永远不经过这里，只暴露只读的平台信息。
const api = {
  platform: process.platform,
}

contextBridge.exposeInMainWorld('fnmusic', api)

// ---------------------------------------------------------------------------
// `window.fn`：认证桥（Task 10）
// ---------------------------------------------------------------------------
//
// 七个方法与主进程的七个 `auth:*` IPC 通道一一对应。
//
// ⚠️ **桥里不得出现任何能返回 token / 密码的接口**：
// 主进程侧的 `auth:restore` / `auth:login` / `auth:logout` 只回**脱敏**的
// `AuthSessionInfo`（`connected` / `mode` / `username` / `serverLabel` / `isRelay`），
// 这里原样透传即可——**不要**在这里加工出任何凭证字段。
//
// ⚠️ `shared/bridge.ts` 是**纯类型**文件（只有 `interface` / `type`），
//    这里的 import 是**类型导入**：编译后不留任何运行时代码，
//    不会把主进程逻辑打进渲染进程 bundle。
const fn: FnBridge = {
  serverInfo: (server) => ipcRenderer.invoke('auth:server-info', server),
  login: (args) => ipcRenderer.invoke('auth:login', args),
  restore: () => ipcRenderer.invoke('auth:restore'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  relogin: () => ipcRenderer.invoke('auth:relogin'),
  probe: (fnId) => ipcRenderer.invoke('auth:probe', fnId),
  connectionInfo: () => ipcRenderer.invoke('auth:connection-info'),
}

contextBridge.exposeInMainWorld('fn', fn)

// ---------------------------------------------------------------------------
// `window.fnPlayer`：播放器 / 窗口 / 偏好桥（Task 17）
// ---------------------------------------------------------------------------
//
// 与 `window.fn`（认证桥）**并列、互不重叠**：本桥里**没有任何一个方法能拿到凭证**
// （没有 token / 密码 / deviceId——偏好只有主题名、窗口位置、关闭窗口的行为）。
//
// ⚠️ `shared/playerBridge.ts` 是**纯类型**文件（只有 interface / type），
//    这里的 import 是**类型导入**：编译后不留任何运行时代码，
//    不会把主进程逻辑打进渲染进程 bundle。
//
// ---------------------------------------------------------------------------
// 通道与方向
// ---------------------------------------------------------------------------
// | 通道                  | 方向              | 机制                 |
// |-----------------------|-------------------|----------------------|
// | `player:state`        | 渲染进程 → 主进程 | `ipcRenderer.send`   |
// | `player:command`      | 渲染进程 → 主进程 | `ipcRenderer.send`   |
// | `player:command`      | 主进程 → 渲染进程 | `ipcRenderer.on`     |
// | `win:minimize`        | 渲染进程 → 主进程 | `ipcRenderer.invoke` |
// | `win:toggle-maximize` | 渲染进程 → 主进程 | `ipcRenderer.invoke` |
// | `win:close`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` |
// | `prefs:get`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` |
// | `prefs:set`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` |
// | `theme:set`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` |
//
// ⚠️ `player:command` 是**双向**的（同一个通道名、两个方向、两套机制）：
// 渲染进程发出去的命令由主进程**转发**回来执行（主进程是唯一的命令路由），
// 渲染进程**只执行**从主进程收到的命令——不存在「发一次执行两遍」。
const fnPlayer: PlayerBridge = {
  pushState: (state) => ipcRenderer.send('player:state', state),
  sendCommand: (command) => ipcRenderer.send('player:command', command),
  onCommand: (handler) => {
    const listener = (_event: unknown, command: PlayerCommand): void => {
      handler(command)
    }
    ipcRenderer.on('player:command', listener)
    return () => {
      ipcRenderer.removeListener('player:command', listener)
    }
  },
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
  close: () => ipcRenderer.invoke('win:close'),
}

contextBridge.exposeInMainWorld('fnPlayer', fnPlayer)
