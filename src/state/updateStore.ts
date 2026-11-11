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
// - 「能不能启动安装器」用**共享口径**（`evaluateSignatureGate`，与主进程同一份）——
//   界面要**提前说清楚**，但**不许比主进程严**（那会把功能堵死，T85 的教训）；
// - 任何一步失败都**如实显示可读文案**，不静默吞掉。
// ---------------------------------------------------------------------------

import { create } from 'zustand'

import type { PlayerBridge } from '../../shared/playerBridge'
import { evaluateSignatureGate } from '../../shared/update'
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
  /**
   * 已保存的「允许安装未签名更新」（T82；**默认关**）。
   */
  allowUnsigned: boolean
  /** 更新服务器地址的**输入草稿**。 */
  baseUrlDraft: string
  /** 预期签名者的**输入草稿**。 */
  signerDraft: string
  /** 「允许安装未签名更新」的**草稿**。 */
  allowUnsignedDraft: boolean
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
  /** 改「允许安装未签名更新」草稿（不落盘）。 */
  setAllowUnsignedDraft: (value: boolean) => void
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
  allowUnsigned: false,
  baseUrlDraft: '',
  signerDraft: '',
  allowUnsignedDraft: false,
  status: 'idle',
  result: null,
  download: null,
  error: null,

  load: async (): Promise<void> => {
    const bridge = playerBridge()
    if (!bridge) {
      set({
        baseUrl: '',
        expectedSigner: '',
        allowUnsigned: false,
        baseUrlDraft: '',
        signerDraft: '',
        allowUnsignedDraft: false,
        error: null,
      })
      return
    }
    try {
      const prefs = await bridge.getPrefs()
      const update = prefs.update ?? {}
      const baseUrl = update.baseUrl ?? ''
      const expectedSigner = update.expectedSigner ?? ''
      const allowUnsigned = update.allowUnsigned === true
      set({
        baseUrl,
        expectedSigner,
        allowUnsigned,
        baseUrlDraft: baseUrl,
        signerDraft: expectedSigner,
        allowUnsignedDraft: allowUnsigned,
        error: null,
      })
    } catch {
      set({ error: '读取更新设置失败' })
    }
  },

  save: async (): Promise<void> => {
    const bridge = playerBridge()
    const { baseUrlDraft, signerDraft, allowUnsignedDraft } = get()
    if (!bridge) {
      // 没有桥 → 只在本地生效（浏览器预览；不崩、也不静默写盘）。
      set({
        baseUrl: baseUrlDraft,
        expectedSigner: signerDraft,
        allowUnsigned: allowUnsignedDraft,
        error: null,
      })
      return
    }
    try {
      const prefs = await bridge.setPrefs({
        update: { baseUrl: baseUrlDraft, expectedSigner: signerDraft, allowUnsigned: allowUnsignedDraft },
      })
      const update = prefs.update ?? {}
      const baseUrl = update.baseUrl ?? ''
      const expectedSigner = update.expectedSigner ?? ''
      const allowUnsigned = update.allowUnsigned === true
      set({
        baseUrl,
        expectedSigner,
        allowUnsigned,
        baseUrlDraft: baseUrl,
        signerDraft: expectedSigner,
        allowUnsignedDraft: allowUnsigned,
        error: null,
      })
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

  setAllowUnsignedDraft: (value: boolean): void => {
    set({ allowUnsignedDraft: value })
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
    const { download, allowUnsigned } = get()
    if (!bridge) {
      set({ status: 'error', error: '当前环境不支持启动安装器' })
      return
    }
    if (!download || download.status !== 'ok') {
      set({ status: 'error', error: '还没有已下载的安装包' })
      return
    }
    // ⚠️ **提前说清楚**（这不是闸，闸在主进程那边）。
    //    ⚠️ T85：判定口径必须用**共享**的 `evaluateSignatureGate`（与主进程**同一份**）——
    //       旧实现在这里「预期签名者为空就直接拦」，比主进程**严**
    //       ⇒ 把「允许安装未签名的更新包」整个堵死了（用户勾了也没用）。
    const gate = evaluateSignatureGate({
      signatureOk: download.signature.ok,
      signatureStatus: download.signature.status,
      signatureReason: download.signature.reason,
      allowUnsigned,
    })
    if (!gate.allowed) {
      set({ status: 'error', error: gate.reason ?? '签名校验未通过，不允许启动安装器' })
      return
    }
    set({ status: 'installing', error: null })
    try {
      // ⚠️ **T87.12**：回传**文件名**，**不是** `download.path` ——
      //    `update:install` 的参数是**裸文件名**（主进程净化后拼到下载目录下面），
      //    传绝对路径会被判「安装包名不合法」（真机事故：v0.2.4 / v0.2.5 都中招）。
      const result = await bridge.installUpdate(download.name)
      set({
        status: result.status === 'ok' ? 'idle' : 'error',
        error: result.status === 'ok' ? null : result.message,
      })
    } catch {
      set({ status: 'error', error: '启动安装器失败' })
    }
  },
}))
