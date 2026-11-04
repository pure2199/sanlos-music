// ---------------------------------------------------------------------------
// 自动更新的**渲染层镜像**（Task 23）
// ---------------------------------------------------------------------------
//
// ⚠️ **渲染进程只做两件事**：
// 1. 发「检查更新 / 下载 / 安装」的请求；
// 2. 把结果**显示**出来。
//    **拉清单、下载文件、启动安装器全在主进程**——
//    渲染进程连网络都不碰，更碰不到文件系统。
//
// ---------------------------------------------------------------------------
// 状态形状
// ---------------------------------------------------------------------------
// - `baseUrl` / `expectedSigner`：**已保存**的更新偏好
//   （单一真相源 = 主进程 `prefs.json` 的 `update` 键）；
// - `baseUrlDraft` / `signerDraft`：**输入草稿**（点「保存」才写回）；
// - `result`：最近一次检查的结果；
// - `download`：最近一次下载的结果；
// - `status`：当前处于流程的哪一步（给按钮的禁用/文案用）。
//
// ---------------------------------------------------------------------------
// 约定
// ---------------------------------------------------------------------------
// - **store 里不放任何凭证**；
// - 「预期签名者」**没配就不许启动安装器**（主进程会拒）——
//   界面要**提前说清楚**，不能等用户点了才被拒；
// - 任何一步失败都**如实显示可读文案**，不静默吞掉。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { PlayerBridge } from '../../shared/playerBridge'
import type {
  UpdateCheckResult,
  UpdateDownloadResult,
} from '../../shared/update'

/** 取渲染进程的播放器桥（桌面壳里恒定存在；纯浏览器预览 / 单测里为 `null`）。 */
function playerBridge(): PlayerBridge | null {
  const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
  return scope.fnPlayer ?? null
}

/** 更新流程的当前阶段。 */
export type UpdateStatus =
  /** 什么都没做。 */
  | 'idle'
  /** 正在检查。 */
  | 'checking'
  /** 检查完成（有新版本 / 已是最新）。 */
  | 'checked'
  /** 正在下载。 */
  | 'downloading'
  /** 下载完成。 */
  | 'downloaded'
  /** 正在启动安装器。 */
  | 'installing'
  /** 出错了（`error` 里有可读原因）。 */
  | 'error'

/** 更新镜像 store 的形状。 */
export interface UpdateStore {
  /** 已保存的更新服务器地址（空 = 未配置）。 */
  baseUrl: string
  /** 已保存的预期签名者（空 = **不许启动安装器**）。 */
  expectedSigner: string
  /** 更新服务器地址的**输入草稿**。 */
  baseUrlDraft: string
  /** 预期签名者的**输入草稿**。 */
  signerDraft: string
  /** 当前阶段。 */
  status: UpdateStatus
  /** 最近一次检查的结果。 */
  result: UpdateCheckResult | null
  /** 最近一次下载的结果。 */
  download: UpdateDownloadResult | null
  /** 错误文案（`null` = 没有）。 */
  error: string | null
  /** 读一次偏好（设置面板打开时调用）。 */
  load: () => Promise<void>
  /** 保存地址与签名者（写回主进程偏好）。 */
  save: () => Promise<void>
  /** 改地址草稿（不落盘）。 */
  setBaseUrlDraft: (value: string) => void
  /** 改签名者草稿（不落盘）。 */
  setSignerDraft: (value: string) => void
  /** 检查更新。 */
  check: () => Promise<void>
  /** 下载安装包。 */
  downloadUpdate: () => Promise<void>
  /** 启动安装器。 */
  installUpdate: () => Promise<void>
}

/** 更新镜像 store（生产用）。 */
export const useUpdateStore = create<UpdateStore>()((set, get) => ({
  baseUrl: '',
  expectedSigner: '',
  baseUrlDraft: '',
  signerDraft: '',
  status: 'idle',
  result: null,
  download: null,
  error: null,

  load: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      set({ baseUrl: '', expectedSigner: '', baseUrlDraft: '', signerDraft: '', error: null })
      return
    }
    try {
      const prefs = await bridge.getPrefs()
      const update = prefs.update ?? {}
      const baseUrl = update.baseUrl ?? ''
      const expectedSigner = update.expectedSigner ?? ''
      set({ baseUrl, expectedSigner, baseUrlDraft: baseUrl, signerDraft: expectedSigner, error: null })
    } catch {
      set({ error: '读取更新设置失败' })
    }
  },

  save: async (): Promise<void> => {
    const bridge = playerBridge()
    const { baseUrlDraft, signerDraft } = get()
    if (!bridge) {
      // 没有桥 → 只在本地生效（浏览器预览；不崩、也不静默写盘）。
      set({ baseUrl: baseUrlDraft, expectedSigner: signerDraft, error: null })
      return
    }
    try {
      const prefs = await bridge.setPrefs({
        update: { baseUrl: baseUrlDraft, expectedSigner: signerDraft },
      })
      const update = prefs.update ?? {}
      const baseUrl = update.baseUrl ?? ''
      const expectedSigner = update.expectedSigner ?? ''
      set({ baseUrl, expectedSigner, baseUrlDraft: baseUrl, signerDraft: expectedSigner, error: null })
    } catch {
      set({ error: '保存更新设置失败' })
    }
  },

  setBaseUrlDraft: (value: string): void => {
    set({ baseUrlDraft: value })
  },

  setSignerDraft: (value: string): void => {
    set({ signerDraft: value })
  },

  check: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      set({ status: 'error', error: '当前环境不支持检查更新' })
      return
    }
    set({ status: 'checking', error: null, result: null, download: null })
    try {
      const result = await bridge.checkUpdate()
      set({ status: 'checked', result, error: null })
    } catch {
      set({ status: 'error', error: '检查更新失败' })
    }
  },

  downloadUpdate: async (): Promise<void> => {
    const bridge = playerBridge()
    const result = get().result
    if (!bridge) {
      set({ status: 'error', error: '当前环境不支持下载更新' })
      return
    }
    if (!result || result.status !== 'available') {
      set({ status: 'error', error: '没有可下载的更新（请先「检查更新」）' })
      return
    }
    set({ status: 'downloading', error: null })
    try {
      const download = await bridge.downloadUpdate(result.file.name)
      set({
        status: download.status === 'ok' ? 'downloaded' : 'error',
        download,
        error: download.status === 'ok' ? null : download.message,
      })
    } catch {
      set({ status: 'error', error: '下载更新失败' })
    }
  },

  installUpdate: async (): Promise<void> => {
    const bridge = playerBridge()
    const { download, expectedSigner } = get()
    if (!bridge) {
      set({ status: 'error', error: '当前环境不支持启动安装器' })
      return
    }
    if (!download || download.status !== 'ok') {
      set({ status: 'error', error: '还没有已下载的安装包' })
      return
    }
    // ⚠️ **没配预期签名者就不许启动**——提前说清楚，别等主进程拒。
    if (expectedSigner.trim() === '') {
      set({ status: 'error', error: '未配置「预期的代码签名者」→ 不允许启动安装器' })
      return
    }
    set({ status: 'installing', error: null })
    try {
      const result = await bridge.installUpdate(download.path)
      set({
        status: result.status === 'ok' ? 'idle' : 'error',
        error: result.status === 'ok' ? null : result.message,
      })
    } catch {
      set({ status: 'error', error: '启动安装器失败' })
    }
  },
}))
