import { contextBridge, ipcRenderer } from 'electron'
import type { FnBridge } from '../shared/bridge'
import type {
  DownloadTask,
  LocalLibraryItem,
  LyricOverlayMessage,
  PlayerBridge,
  PlayerCommand,
} from '../shared/playerBridge'

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
  // -------------------------------------------------------------------------
  // 桌面悬浮歌词（Task 10）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **同一个桥在两个窗口里都存在**：主窗口用它**推**数据，
  //    悬浮窗用它**收**数据；两边各用各的方法，互不冲突。
  pushLyricState: (message) => ipcRenderer.send('lyric:state', message),
  onLyricState: (handler) => {
    const listener = (_event: unknown, message: LyricOverlayMessage): void => {
      handler(message)
    }
    ipcRenderer.on('lyric:state', listener)
    return () => {
      ipcRenderer.removeListener('lyric:state', listener)
    }
  },
  onLyricVisibility: (handler) => {
    const listener = (_event: unknown, visible: boolean): void => {
      handler(visible === true)
    }
    ipcRenderer.on('lyric:visibility', listener)
    return () => {
      ipcRenderer.removeListener('lyric:visibility', listener)
    }
  },
  setLyricVisible: (visible) => ipcRenderer.invoke('lyric:set-visible', visible === true),
  // -------------------------------------------------------------------------
  // 下载（Task 11）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 渲染进程**只能发请求、只能收进度**：
  //    落盘路径、文件名清洗、断点续传**全在主进程**。
  listDownloads: () => ipcRenderer.invoke('download:list'),
  startDownload: (request) => ipcRenderer.invoke('download:start', request),
  cancelDownload: (songId) => ipcRenderer.invoke('download:cancel', { songId }),
  clearDownloads: () => ipcRenderer.invoke('download:clear'),
  onDownloadChange: (handler) => {
    const listener = (_event: unknown, tasks: DownloadTask[]): void => {
      handler(Array.isArray(tasks) ? tasks : [])
    }
    ipcRenderer.on('download:changed', listener)
    return () => {
      ipcRenderer.removeListener('download:changed', listener)
    }
  },
  // -------------------------------------------------------------------------
  // 本地曲目（T38）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 渲染进程**不碰文件系统**：它只能让主进程弹对话框、把选中的路径
  //    交给主进程登记、拿回登记好的清单——**给不出任意路径**。
  listLocalTracks: () => ipcRenderer.invoke('local:list') as Promise<LocalLibraryItem[]>,
  pickLocalFiles: () => ipcRenderer.invoke('local:pick-files') as Promise<string[]>,
  pickLocalFolder: () => ipcRenderer.invoke('local:pick-folder') as Promise<string>,
  addLocalTracks: (paths) => ipcRenderer.invoke('local:add', paths) as Promise<LocalLibraryItem[]>,
  addLocalFolder: (folder) =>
    ipcRenderer.invoke('local:add-folder', folder) as Promise<LocalLibraryItem[]>,
  removeLocalTrack: (id) => ipcRenderer.invoke('local:remove', id) as Promise<LocalLibraryItem[]>,
  // -------------------------------------------------------------------------
  // FFmpeg 兜底解码（Task 12）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 渲染进程**只发请求**：本地文件的定位、转码、临时产物的存放
  //    **全在主进程**——这里既不能指定路径，也拿不到任何凭证。
  ffmpegStatus: () => ipcRenderer.invoke('ffmpeg:status'),
  ffmpegFallback: (songId) => ipcRenderer.invoke('ffmpeg:fallback', { songId }),
  // -------------------------------------------------------------------------
  // 自动更新（Task 23）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **渲染进程只发请求、只收结果**：拉清单、下载、启动安装器**全在主进程**
  //    ——渲染进程**不碰网络**，也**不能指定装哪个路径**（只报文件名）。
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (name) => ipcRenderer.invoke('update:download', { name }),
  installUpdate: (name) => ipcRenderer.invoke('update:install', { name }),
  // -------------------------------------------------------------------------
  // 外部歌词（Task 32）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 渲染进程**只发请求**：外部歌词的抓取**全在主进程**——
  //    渲染进程**不碰网络**，也**不能指定要抓哪个地址**（只报歌名 / 歌手 / 时长）。
  fetchExternalLyric: (query) => ipcRenderer.invoke('lyric:fetch', query),
}

contextBridge.exposeInMainWorld('fnPlayer', fnPlayer)
