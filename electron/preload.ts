import { contextBridge } from 'electron'

// 渲染进程与主进程之间的桥。凭证永远不经过这里，只暴露只读的平台信息。
const api = {
  platform: process.platform,
}

contextBridge.exposeInMainWorld('fnmusic', api)
