// 渲染进程与主进程之间的**认证桥**类型定义。
//
// ⚠️ 本文件**只能是纯类型**（`interface` / `type`）：
// - 不得出现任何运行时代码（导出的值、常量、函数）；
// - 不得 import Electron / Node 内置模块 / DOM 类型。
//
// 理由：主进程（`electron/ipc.ts`）与渲染进程（Task 10b 的登录页）**共用**这份契约，
// 而渲染进程跑在 `contextIsolation: true` 的沙箱里——一旦这里混进运行时代码，
// 渲染进程 import 它时会把那些代码一起打进 bundle，等于把主进程逻辑泄露到页面。
//
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）
// ---------------------------------------------------------------------------
// 1. **桥接口绝不能回传凭证**：`AuthSessionInfo` 只有
//    `{ connected, mode, username, serverLabel, isRelay }`——**没有** token、
//    **没有** password、**没有** deviceId。凭证只存在于主进程内存与 `session.bin`。
// 2. `ServerInfo` 只暴露 `{ serverName, serverVersion, supportsNasLogin }` 三个字段，
//    **不把整个 `sys/config` 透出去**（它含 `serverGUID` 等服务端内部信息）。
// 3. `CandidateInfo` 只描述链路候选（地址 / 展示名 / 类型 / 可达性），
//    **不含 token**，也不含任何账号口令。

import type { ConnectionInfo, ConnectionKind } from './types'

/** 登录方式：独立账号（密码登录）/ NAS 账号（OAuth 授权登录）。 */
export type AuthMode = 'password' | 'nas'

/**
 * **脱敏**的会话状态：渲染进程唯一能看到的会话信息。
 *
 * ⚠️ 这里**没有** token / password / deviceId——主进程只在 `auth:*` 内部使用凭证。
 */
export interface AuthSessionInfo {
  /** 是否已连接服务器并持有凭据。 */
  connected: boolean
  /** 登录方式；未登录时为 `null`。 */
  mode: AuthMode | null
  /** 登录账号；未登录时为 `null`。 */
  username: string | null
  /** 服务器展示名（`host[:port]`）；未登录时为 `null`。 */
  serverLabel: string | null
  /** 是否走 FN 中继（中继链路的所有请求都必须带 `Cookie: mode=relay`）。 */
  isRelay: boolean
}

/**
 * 服务器信息：**只**三个字段（来自 `GET <base>/api/v1/sys/config`）。
 *
 * 实测（规格 §15.8）：真实 `data` 形如
 * `{ nasOAuth: { clientId: 'EDDLUH2WLY' }, serverGUID, serverName, serverVersion,
 *    mediasrvVersion, capabilities: { folderView, libraryReconnect } }`——
 * `nasOAuth` 里**没有** `url` 字段，授权地址由 Task 11 自行拼装。
 */
export interface ServerInfo {
  /** 服务器名称（如「纯音乐」）；服务端没给时为 `null`。 */
  serverName: string | null
  /** 服务器版本（如 `1.0.10`）；服务端没给时为 `null`。 */
  serverVersion: string | null
  /** 是否支持 NAS 账号（OAuth）登录：`!!data.nasOAuth?.clientId`。 */
  supportsNasLogin: boolean
}

/** 一条链路候选的探测结果（**不含 token**）。 */
export interface CandidateInfo {
  /** 候选基址（不含 `/music`）。 */
  address: string
  /** 界面展示名。 */
  label: string
  /** 链路类型：内网直连 / 公网直连 / FN 中继。 */
  kind: ConnectionKind
  /** 是否走 FN 中继。 */
  isRelay: boolean
  /**
   * 链路是否可达——**只看 HTTP 状态码**（Task 9 的硬规则）。
   *
   * `error` **不能**被读成「链路不可达」：`ok === true` 时 `error` 也可能有值
   * （如「token 已失效」这类备注）。
   */
  ok: boolean
  /** 失败原因 / 备注（可读中文，**不含凭证**）。 */
  error?: string
}

/**
 * `window.fn` 桥接口（渲染进程侧的完整契约）。
 *
 * 七个方法与主进程的七个 IPC 通道一一对应。
 * **没有任何一个方法能拿到 token 或密码。**
 */
export interface FnBridge {
  /** 读取服务器信息（免凭证）：名称 / 版本 / 是否支持 NAS 账号登录。 */
  serverInfo(server: string): Promise<ServerInfo>
  /**
   * 登录。
   *
   * - `mode === 'password'`：独立账号，`password` 是**明文**口令，只在这一次经过 IPC；
   * - `mode === 'nas'`：NAS 账号，走主进程里的 OAuth 授权窗口（Task 11 安装）。
   *
   * `server` 是**直连基址**（如 `https://192.168.1.2:5667/music`）；FN ID 走 `probe()`。
   */
  login(args: {
    server: string
    username: string
    password: string
    mode: AuthMode
  }): Promise<AuthSessionInfo>
  /** 恢复上次会话（脱敏状态；未登录时 `connected === false`）。 */
  restore(): Promise<AuthSessionInfo>
  /** 登出（尽力通知服务端，随后清理本地会话）。 */
  logout(): Promise<AuthSessionInfo>
  /** 静默续期；成功返回 `true`。 */
  relogin(): Promise<boolean>
  /** 用 FN ID 探测候选链路（**只把 FN ID 发给 FN 连接接口**，绝不发送账号口令）。 */
  probe(fnId: string): Promise<CandidateInfo[]>
  /** 当前链路信息；没有会话时返回 `null`。 */
  connectionInfo(): Promise<ConnectionInfo | null>
}
