import { contextBridge, ipcRenderer } from 'electron'
import type { FnBridge } from '../shared/bridge'

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
