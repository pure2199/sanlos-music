// ---------------------------------------------------------------------------
// 自动更新（Task 23）—— 跨进程类型
// ---------------------------------------------------------------------------
//
// ⚠️ 本文件**只能是纯类型**（`interface` / `type`）：
// - 不得出现任何运行时代码（导出的值、常量、函数）；
// - 不得 import Electron / Node 内置模块 / DOM 类型。
//
// 理由与 `shared/playerBridge.ts` 完全相同：主进程（`electron/update.ts`、
// `electron/ipc.ts`）与渲染进程（`src/state/updateStore.ts`、设置面板）
// **共用**这份契约，而渲染进程跑在 `contextIsolation: true` 的沙箱里——
// 一旦这里混进运行时代码，就会把主进程逻辑打进渲染层 bundle。
//
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）
// ---------------------------------------------------------------------------
// 1. **本文件里的任何一个类型都不许携带凭证**：没有 token / 密码 / deviceId。
//    更新服务器地址与预期签名者**不是**凭证（它们只是地址与公开主体名），
//    故可以放在 `AppPrefs`（`prefs.json`）里。
// 2. **渲染层永远不直接发网络请求**：检查更新 / 下载安装包 / 启动安装器
//    **全在主进程**，渲染层只发 IPC 请求、只收结果。
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 更新清单
// ---------------------------------------------------------------------------

/**
 * 更新清单里的一个文件。
 *
 * ⚠️ `url` 是**相对**清单所在目录的相对路径——跨源会被主进程**拒绝**
 *    （清单可以把安装包指到别处 = 一条远程代码执行的路，必须堵死）。
 */
export interface UpdateFile {
  /** 文件名（**只取 basename**：清单不许用路径穿越）。 */
  name: string
  /** 相对清单目录的路径。 */
  url: string
  /** 文件内容的 SHA-512（**小写 hex**，128 个字符）。 */
  sha512: string
  /** 文件字节数（正整数）。 */
  size: number
}

/**
 * 更新清单（服务端上的 `latest.json`）。
 *
 * ⚠️ 形状是**本项目自定义**的（不是 electron-builder 的 `latest.yml`）：
 *    目的是**零新依赖**——不引 `js-yaml`，也不引 `electron-updater`。
 *    代价是清单与 `electron-builder` 的产物不通用；发布脚本
 *    （`scripts/publish-manifest.mjs`）负责把产物转成这个形状。
 */
export interface UpdateManifest {
  /** 版本号（语义化版本，如 `1.2.3`）。 */
  version: string
  /** 发布时间（ISO 8601 字符串；缺省表示没写）。 */
  releasedAt?: string
  /** 更新说明（纯文本；缺省表示没写）。 */
  notes?: string
  /** 可下载的文件（客户端取**第一个 `.exe`** 作为安装包）。 */
  files: UpdateFile[]
}

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

/**
 * 检查更新的结果（**判别联合**，`status` 区分）。
 *
 * ⚠️ 四种状态**互斥且穷尽**：客户端按 `status` 分派，
 *    不认识的 `status` 一律当 `error` 处理（向前兼容）。
 */
export type UpdateCheckResult =
  /** 已是最新版本。 */
  | { status: 'up-to-date'; current: string }
  /** 有新版本（附清单与选中的安装包）。 */
  | { status: 'available'; current: string; manifest: UpdateManifest; file: UpdateFile }
  /** **没有配置更新服务器地址**（不是错误，是「还没配」）。 */
  | { status: 'not-configured' }
  /** 检查失败（网络 / 地址不合法 / 清单损坏）。 */
  | { status: 'error'; message: string }

// ---------------------------------------------------------------------------
// 下载与安装
// ---------------------------------------------------------------------------

/**
 * Authenticode 签名校验结果。
 *
 * ⚠️ `ok` 的判定口径（**刻意不验信任链**）：
 *    「文件带签名」+「签名者主体 == 用户配置的预期签名者」。
 *    信任链由 Windows 自己负责（`Status` 字段会如实反映），
 *    我们**只**保证「这个文件确实由预期的人签的」。
 */
export interface UpdateSignatureResult {
  /** 是否通过。 */
  ok: boolean
  /** 签名状态（Windows 的 `Status`：如 `Valid` / `NotSigned` / `UnknownError`）。 */
  status: string
  /** 签名者主体（`CN=…`）；没有签名时为 `null`。 */
  signer: string | null
  /** 失败原因（可读文案；通过时为 `null`）。 */
  reason: string | null
}

/** 下载更新包的结果。 */
export type UpdateDownloadResult =
  /** 下载完成（**不代表能安装**——能不能装看签名结果）。 */
  | {
      status: 'ok'
      /** 下载文件的绝对路径（主进程落盘的位置）。 */
      path: string
      /** 实际字节数。 */
      bytes: number
      /** SHA-512 是否与清单一致。 */
      sha512Ok: boolean
      /** Authenticode 校验结果。 */
      signature: UpdateSignatureResult
    }
  /** 下载失败。 */
  | { status: 'error'; message: string }

/** 启动安装器的结果。 */
export type UpdateInstallResult =
  /** 安装器已启动。 */
  | { status: 'ok'; path: string }
  /** 启动失败（含「签名不通过，不许装」）。 */
  | { status: 'error'; message: string }

// ---------------------------------------------------------------------------
// 签名这一关的**唯一判定口径**（T85）
// ---------------------------------------------------------------------------

/**
 * 「签名这一关」的判定入参。
 */
export interface SignatureGateInput {
  /** 签名校验结果本身是否通过（`UpdateSignatureResult.ok`）。 */
  signatureOk: boolean
  /** 签名校验结果的 `status`（`NotSigned` / `Valid` / `UnknownError` …）。 */
  signatureStatus: string
  /** 签名校验结果给出的理由（用于显示；缺省 = 没有）。 */
  signatureReason?: string | null
  /**
   * 用户是否**显式**授权安装未签名包。
   *
   * ⚠️ 必须是**已保存**的值（主进程读 `prefs.json`、渲染层读 store），
   *    **不是**设置页里还没保存的草稿 —— 草稿还没生效，
   *    用它判定会「界面说可以、主进程拒」。
   */
  allowUnsigned: boolean
}

/** 「签名这一关」的判定结果。 */
export interface SignatureGateResult {
  /** 是否放行。 */
  allowed: boolean
  /** 不放行的原因（`null` = 放行了）。 */
  reason: string | null
}

/**
 * 「签名这一关」的唯一判定口径（T85）。
 *
 * ⚠️ **为什么必须只有一份**：T85 的事故就是「主进程与渲染层各判各的」——
 *    主进程在「预期签名者为空」时**不探测文件**（给 `NotChecked`），
 *    渲染层却按「是不是 `NotSigned`」判 ⇒ 「允许安装未签名的更新包」
 *    **从没有真正生效过**。⇒ 判定逻辑放这里，**两边共用**。
 *
 * ⚠️ **口径**：
 *    - 包**有**签名 ⇒ 必须与「预期的代码签名者」一致（`signatureOk` 为真）；
 *      没配预期签名者 ⇒ **拒绝**（授权也救不了：那不是「未签名包」）。
 *    - 包**没有**签名（`NotSigned`）⇒ 用户**显式授权**了才放行；
 *      没授权 ⇒ **拒绝**（默认行为，一字不变）。
 *    - 探测失败（`UnknownError` / `Unavailable` …）⇒ **拒绝**（不猜）。
 *
 * ⚠️ **它只判「签名这一关」**：**SHA-512 复核**只有主进程能做
 *    （渲染层碰不到文件系统）⇒ 留在主进程那侧。
 */
export function evaluateSignatureGate(input: SignatureGateInput): SignatureGateResult {
  if (input.signatureOk) return { allowed: true, reason: null }
  if (input.signatureStatus === 'NotSigned') {
    if (input.allowUnsigned) return { allowed: true, reason: null }
    return {
      allowed: false,
      reason: '安装包没有代码签名，且未开启「允许安装未签名的更新包」',
    }
  }
  return {
    allowed: false,
    reason: input.signatureReason ?? '签名校验未通过，不允许启动安装器',
  }
}

// ---------------------------------------------------------------------------
// 偏好
// ---------------------------------------------------------------------------

/**
 * 自动更新的偏好（落在主进程 `prefs.json` 的 `update` 键下）。
 *
 * ⚠️ **非敏感**：更新服务器地址与签名者主体名都是公开信息，
 *    与 `session.bin`（凭证）**无关**。
 */
export interface UpdatePrefs {
  /**
   * 更新服务器地址（**目录**，清单放在 `<baseUrl>/latest.json`）。
   *
   * ⚠️ 空串 / 缺省 = **未配置** → 「检查更新」会直接返回 `not-configured`。
   *    必须是 `https://`（回环地址才允许 `http://`）。
   */
  baseUrl?: string
  /**
   * 预期的代码签名者主体（`CN=…`）。
   *
   * ⚠️ **T85 起**：不配置**不再**等于「一律不许启动」——
   *    - 包**有**签名但不配置 ⇒ **拒绝启动**（授权也救不了）；
   *    - 包**没有**签名 ⇒ 走「允许安装未签名的更新包」那条路
   *      （仍必须 **SHA-512 与清单相符**）。
   *    详见 `evaluateSignatureGate()`。
   */
  expectedSigner?: string
  /**
   * 是否**允许安装未签名的更新包**（T82 加；T85 修好它的判定）。
   *
   * ⚠️ **默认关**（缺省 / `false`）：本项目暂未办理代码签名证书 ⇒
   *    未签名包一律**拒绝启动**（默认行为，一字不变）。
   * ⚠️ **开了也只是放宽「发布者身份」这一条**：安装包仍必须
   *    **SHA-512 与清单相符**（且启动前再验一次）+ **与清单同源**。
   * ⚠️ 只对「**确实没有**签名」的包有效：包有签名但签名者不符 ⇒ 授权**无效**。
   */
  allowUnsigned?: boolean
}
