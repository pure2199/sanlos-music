// 主进程会话、凭证存储与 token 续期。
//
// 本模块是**整个客户端的凭证中枢**：token 与密码只存在于主进程内存与 `session.bin` 里，
// 渲染进程永远拿不到（渲染进程只拿到 `fnm://` 代理，凭证由 Task 8 的代理在主进程内附加）。
//
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）
// ---------------------------------------------------------------------------
// 1. **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测，
//    而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串，取不到 `safeStorage`
//    （顶层 import 会让整个模块在测试里加载失败）。故 Electron 相关对象一律**惰性解析**
//    （`resolveDefaults()`），并允许在构造时注入替身。
// 2. **凭证绝不进日志、不进错误消息**：`console.*` 一律不出现；抛出的错误只带服务端 `msg`
//    与业务码，不带 token / 密码。
// 3. `safeStorage` 必须在 `app.ready` 之后使用，故 `save()` / `load()` 由调用方在 ready 之后触发。
//
// ---------------------------------------------------------------------------
// 链路事实（真实 NAS 实测，规格 §15.2–§15.7）
// ---------------------------------------------------------------------------
// - 登录端点：`POST <base>/api/v1/user/password-login`，body `{ username, password: sha256(password), deviceId }`，
//   成功返回 `{ code: 0, data: { userToken, deviceId?, user?: { username } } }`——**token 字段名是 `userToken`**。
// - 业务码：`0` 成功；`99999` 表示 token 失效。
// - **中继链路下，登录请求本身也必须带 `Cookie: mode=relay`**，否则中继返回 HTML 错误页（实测踩到）。
// - 服务端当前**不校验** `authx`，但客户端仍按上游语义发送（官方 Web 端会发，将来网关可能加强校验）。

import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  API_PREFIX,
  CODE_OK,
  CODE_TOKEN_EXPIRED,
  RELAY_COOKIE_MODE,
  RELAY_DOMAIN_SUFFIX,
} from '../shared/constants'
import { authx, buildCookie, sha256 } from './sign'
import { hostOf, normalizeBase } from './connection'
import { createHttpStack, type HttpStack } from './http'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 会话模式：独立账号（密码登录）/ NAS 账号（OAuth 授权）。 */
export type SessionMode = 'nas' | 'password'

/** 会话状态：主进程内存与 `session.bin` 共用同一份形状。 */
export interface SessionState {
  /** 音乐服务根地址，形如 `http://127.0.0.1:5666/music`（**不含** `/api/v1`）。 */
  base: string
  /** 会话模式。 */
  mode: SessionMode
  /** 身份凭据（`music-token` Cookie 的值）。 */
  token: string
  /** 设备 id（16 字节随机 hex，服务端绑定并回传）。 */
  deviceId: string
  /** 登录账号（独立账号模式下有值）。 */
  username: string
  /**
   * **明文密码**（仅独立账号模式）。
   *
   * 内存里保留明文是为了 `relogin()` 静默续期；落盘时随整个会话一起被 DPAPI 加密。
   */
  password: string
  /** 是否走 FN 中继（中继链路的所有请求都必须带 `Cookie: mode=relay`）。 */
  isRelay: boolean
}

/**
 * `safeStorage` 的最小接口。
 *
 * 只依赖这三个方法，便于单元测试注入替身（不依赖真实 Electron）。
 */
export interface SafeStorageLike {
  /** DPAPI 是否可用（不可用时退化为明文落盘，**安全性降低**）。 */
  isEncryptionAvailable(): boolean
  /** 加密字符串。 */
  encryptString(plainText: string): Buffer
  /** 解密字符串。 */
  decryptString(encrypted: Buffer): string
}

/** `SessionManager` 的可选依赖（全部可注入，便于单测）。 */
export interface SessionManagerOptions {
  /** `safeStorage` 替身；缺省时惰性取 Electron 的 `safeStorage`。 */
  storage?: SafeStorageLike
  /** 会话文件路径；缺省时惰性取 `<userData>/session.bin`。 */
  filePath?: string
  /** 时间源（便于测试注入固定时间）。 */
  now?: () => number
  /**
   * 是否允许在**没有可用加密**时以明文落盘（文件头 `P0`）。
   *
   * 默认 `false`：**没有可用加密就拒绝写盘**（抛 `SessionStateError('NO_ENCRYPTION')`），
   * 不做静默降级——明文文件里含 token 与明文口令。
   * `P0` 模式本身保留（计划要求文件头支持它），但必须由调用方显式开启。
   */
  allowPlaintextFallback?: boolean
  /**
   * 出网通道（Task 9b：Chromium 分区栈）。
   *
   * 缺省时**惰性** new 一个 `HttpStack`——Electron 运行时里走 Chromium 分区 session
   * （这样 `setCertificateVerifyProc` 的证书放行才真正生效），单测里回落到全局 `fetch`
   * （Vitest 的 `vi.stubGlobal('fetch', …)` 仍然有效）。
   *
   * ⚠️ 主进程应当注入**同一个**实例给会话层、代理层与认证 IPC——
   * 否则各层的信任版本号会各走各的，证书放行与换分区就对不上了。
   */
  http?: HttpStack
}

/** `request()` 的可选参数。 */
export interface SessionRequestOptions {
  /** HTTP 方法，默认 `GET`。 */
  method?: string
  /** 请求体（会被序列化成 JSON）。 */
  body?: unknown
  /** 查询参数；`undefined` / `null` 的键会被跳过。 */
  query?: Record<string, string | number | undefined>
  /**
   * 中继模式的**覆盖**（可选）。
   *
   * 缺省（不传）时用 `state.isRelay`——**行为与加这个字段之前完全一致**，
   * 现有调用方无需改动。
   *
   * 用途（Task 8 的协议代理）：主进程在「已探测出当前链路是中继」时，
   * 用它覆盖会话里按 host 推断出来的值，保证 JSON 路径与流式路径的链路模式一致
   * （中继链路必须带 `Cookie: mode=relay`，否则中继返回 HTML 错误页）。
   */
  isRelay?: boolean
}

/**
 * 业务错误：服务端返回了 `code !== 0` 的信封。
 *
 * `code` 作为属性带出去，便于上层判断（例如 `99999` 表示需要重新登录）。
 * 消息里只包含服务端 `msg` 与业务码，**不含任何凭证**。
 */
export class SessionApiError extends Error {
  /** 服务端业务码（`0` 表示成功，故此处必为非 0）。 */
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'SessionApiError'
    this.code = code
  }
}

/**
 * 会话状态错误码（**可判别**，上层据此分支，不要靠中文文案做字符串匹配）。
 *
 * - `NO_SESSION`：没有会话基址（未连接服务器）；
 * - `NO_CREDENTIAL`：没有身份凭据（未登录 / 续期未取到 token）；
 * - `NO_STORAGE`：会话文件路径不可用；
 * - `NO_ENCRYPTION`：没有可用加密，且未显式允许明文回退；
 * - `SAVE_FAILED`：写盘失败（含加密异常）；
 * - `LOAD_CORRUPTED`：会话文件内容损坏；
 * - `LOAD_DECRYPT_FAILED`：会话文件解密失败（例如在 `app.ready` 之前调用了 `load()`）；
 * - `STALE`：续期结果作废（期间会话已被显式登录 / 登出替换）。
 */
export type SessionStateErrorCode =
  | 'NO_SESSION'
  | 'NO_CREDENTIAL'
  | 'NO_STORAGE'
  | 'NO_ENCRYPTION'
  | 'SAVE_FAILED'
  | 'LOAD_CORRUPTED'
  | 'LOAD_DECRYPT_FAILED'
  | 'STALE'

/**
 * 会话状态错误：与「服务端业务错误」（`SessionApiError`）分开。
 *
 * Task 8 的代理与 Task 11 的 OAuth 流程需要区分「没有会话 / 没有凭据 / 会话文件坏了」，
 * 故用 `code` 做判别，而不是匹配中文文案。消息里**不含任何凭证**。
 */
export class SessionStateError extends Error {
  /** 可判别的错误码（见 `SessionStateErrorCode`）。 */
  readonly code: SessionStateErrorCode

  constructor(code: SessionStateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SessionStateError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 文件头标记：已加密（DPAPI），后面跟 `safeStorage.encryptString()` 的密文。 */
const HEADER_ENCRYPTED = 'E1'

/**
 * 文件头标记：明文回退。
 *
 * ⚠️ 仅在 `safeStorage.isEncryptionAvailable() === false`（DPAPI 不可用）时使用。
 *    此时 `session.bin` 里是**明文 JSON**（含 token 与明文密码），任何能读到该文件的进程都能拿到凭证，
 *    安全性显著降低——这是无法加密时的降级路径，不是常态。
 */
const HEADER_PLAINTEXT = 'P0'

/** 会话文件名（落在 `app.getPath('userData')` 下）。 */
const SESSION_FILE_NAME = 'session.bin'

/** 会话文件的结构版本号（便于将来迁移格式）。 */
const SESSION_FORMAT_VERSION = 1

// ---------------------------------------------------------------------------
// Electron 惰性解析
// ---------------------------------------------------------------------------

/**
 * `require` 的最小声明。
 *
 * Electron 主进程的打包产物是 CommonJS（esbuild `--format=cjs`），运行时存在模块作用域的 `require`；
 * 单元测试跑在 Vitest（ESM）里没有它，所以**所有使用点都必须先用 `typeof` 守卫**。
 */
declare const require: ((id: string) => unknown) | undefined

/** Electron 里本模块用到的最小接口。 */
interface ElectronLike {
  app?: { getPath(name: string): string }
  safeStorage?: SafeStorageLike
}

/**
 * 惰性取 Electron 运行时（**不在模块顶层调用**）。
 *
 * 非 Electron 进程（Vitest / 普通 Node）里 `require('electron')` 返回的是可执行文件路径字符串，
 * 取不到任何 API；此时返回 `null`，由调用方退回注入的替身。
 */
function loadElectron(): ElectronLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('electron') as ElectronLike | string
    if (typeof mod !== 'object' || mod === null) return null
    return mod
  } catch {
    return null
  }
}

/** 惰性解析出来的默认值。 */
interface ResolvedDefaults {
  /** `safeStorage`；无 Electron 时为 `null`（等价于「加密不可用」）。 */
  storage: SafeStorageLike | null
  /** 会话文件路径；无 Electron 时为 `null`。 */
  filePath: string | null
}

/**
 * 惰性解析默认值：`safeStorage` 取 Electron 的，`session.bin` 落在 `app.getPath('userData')` 下。
 *
 * 测试环境没有 Electron，此时返回 `{ storage: null, filePath: null }`，
 * 由构造参数注入的替身覆盖。
 */
function resolveDefaults(): ResolvedDefaults {
  const electron = loadElectron()
  if (!electron) return { storage: null, filePath: null }
  let filePath: string | null = null
  try {
    const dir = electron.app?.getPath('userData')
    if (dir) filePath = join(dir, SESSION_FILE_NAME)
  } catch {
    filePath = null
  }
  return { storage: electron.safeStorage ?? null, filePath }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 空会话状态。 */
function emptyState(): SessionState {
  return {
    base: '',
    mode: 'password',
    token: '',
    deviceId: '',
    username: '',
    password: '',
    isRelay: false,
  }
}

/** 是否是普通对象（数组与 null 都不算）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 取字符串字段（不是字符串就当没有）。 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 取业务码（缺失 / 非法时返回 -1，表示「不是业务信封」）。 */
function readCode(json: unknown): number {
  const code = asRecord(json)?.['code']
  return typeof code === 'number' ? code : -1
}

/** 取服务端 `msg`（缺失时返回空串）。 */
function readMsg(json: unknown): string {
  return readString(asRecord(json)?.['msg'])
}

/** 是否是「token 失效」的业务码。 */
function isTokenExpired(json: unknown): boolean {
  return readCode(json) === CODE_TOKEN_EXPIRED
}

/** 归一化基址：必须是可用的 http/https 音乐根地址。 */
function requireMusicRoot(base: string): string {
  const root = normalizeBase(base)
  if (!root) throw new Error('服务器地址无效：只支持 http/https 地址')
  return root
}

/** 按基址 host 推断是否走 FN 中继（host 以 `.fnos.net` 结尾）。 */
function isRelayHost(base: string): boolean {
  const host = hostOf(base)
  return host.length > 0 && host.endsWith(RELAY_DOMAIN_SUFFIX)
}

/**
 * 生成 16 字节随机 hex 的设备 id（规格 §2.2）。
 *
 * ⚠️ **导出**是为了让 Task 11 的 OAuth 流程用**同一个**生成规则
 * （设备 id 是服务端作用域的凭证，两处各写一套会漂）。
 */
export function newDeviceId(): string {
  return randomBytes(16).toString('hex')
}

/** 拼接查询串；`undefined` / `null` 的键跳过。 */
function buildQuery(query: Record<string, string | number | undefined> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.append(key, String(value))
  }
  const text = params.toString()
  return text.length > 0 ? `?${text}` : ''
}

/**
 * 读响应体并解析 JSON。
 *
 * **不是 JSON 时返回 `null`（不抛异常）**：调用方要靠 `status` 判断真实状态码，
 * 这里抛异常会把原始状态码掩盖掉。
 */
async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text()
    if (!text) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * 主进程会话管理器：持有 token / 密码，负责登录、续期与带签名的业务请求。
 *
 * 生命周期：
 * - 启动时 `load()` 恢复上次会话（文件不存在 / 损坏 / 解密失败时返回 `false`，不抛异常；
 *   失败原因见 `lastLoadError`）；
 * - 登录成功后由调用方 `save()` 落盘（DPAPI 加密；续期成功后由管理器自动落盘）；
 * - 登出时 `clear()` 删除文件并清空内存状态。
 *
 * **世代号（generation）语义**：每次**显式**登录（`passwordLogin` / `nasLogin`）、
 * 恢复会话（`load()`）与登出（`clear()`）都会让世代号 +1。
 * 续期（`relogin()`）在发起时记下世代号，落地时若世代号已变（期间发生过显式登录 / 登出），
 * 则**丢弃续期自己的结果**——既不覆盖更新的会话，也**不销毁**更新的会话。
 */
export class SessionManager {
  /** 当前会话状态（主进程内存）。 */
  state: SessionState = emptyState()

  /** 最近一次续期失败的原因（**不含凭证**，仅供上层诊断）。 */
  lastReloginError: Error | null = null

  /**
   * 最近一次 `load()` 失败的原因。
   *
   * `null` = 没有失败（要么成功，要么「文件不存在」这种正常的「没登录」状态）；
   * 非 `null` 时 `code` 可判别失败类型（`LOAD_DECRYPT_FAILED` / `LOAD_CORRUPTED` / …）。
   */
  lastLoadError: SessionStateError | null = null

  /** 最近一次 `save()` 失败的原因（续期落盘失败时供上层诊断）。 */
  lastSaveError: SessionStateError | null = null

  private readonly options: SessionManagerOptions

  /** 惰性解析出来的默认值（首次用到 `save()` / `load()` 时才解析）。 */
  private resolved: ResolvedDefaults | null = null

  /** 正在进行的续期任务（并发调用共享同一个 Promise，保证只发一次登录请求）。 */
  private inflightRelogin: Promise<boolean> | null = null

  /** 出网通道（惰性解析：注入优先，其次自建一个 Chromium 分区栈）。 */
  private httpStack: HttpStack | null = null

  /** NAS 模式的续期处理器（由 Task 11 的 OAuth 静默续期注入）：返回新的 token 字符串。 */
  private nasRelogin: (() => Promise<string>) | null = null

  /**
   * 世代计数：显式登录 / 恢复会话 / 登出各 +1。
   *
   * 续期发起时记下当时的世代号，落地时不一致就**丢弃自己的结果**（不动 `this.state`）。
   */
  private generation = 0

  constructor(options: SessionManagerOptions = {}) {
    this.options = options
  }

  // -------------------------------------------------------------------------
  // 依赖（惰性解析 + 可注入）
  // -------------------------------------------------------------------------

  /** 解析后的默认值（注入优先于 Electron 运行时）。 */
  private defaults(): ResolvedDefaults {
    if (!this.resolved) {
      const fallback = resolveDefaults()
      this.resolved = {
        storage: this.options.storage ?? fallback.storage,
        filePath: this.options.filePath ?? fallback.filePath,
      }
    }
    return this.resolved
  }

  /** 会话文件路径（不可用时抛错——**不静默把凭证写到别处**）。 */
  private resolveFilePath(): string {
    const filePath = this.defaults().filePath
    if (!filePath) {
      throw new SessionStateError(
        'NO_STORAGE',
        '会话文件路径不可用：当前进程没有 Electron 运行时，且未注入 filePath',
      )
    }
    return filePath
  }

  /** `safeStorage`（无 Electron 且未注入时为 `null`，等价于「加密不可用」）。 */
  private resolveStorage(): SafeStorageLike | null {
    return this.defaults().storage
  }

  /** 当前时间（可注入固定值）。 */
  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * 出网通道（惰性解析）。
   *
   * 注入优先；没注入就自建一个 `HttpStack`——Electron 运行时里走 Chromium 分区栈，
   * 单测里回落到全局 `fetch`。
   */
  private http(): HttpStack {
    if (!this.httpStack) {
      this.httpStack = this.options.http ?? createHttpStack()
    }
    return this.httpStack
  }

  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------

  /**
   * 密码登录（独立账号）。
   *
   * `POST <base>/api/v1/user/password-login`，body `{ username, password: sha256(password), deviceId }`。
   *
   * - `opts.isRelay` 省略时按基址 host 是否以 `.fnos.net` 结尾推断；
   * - 中继链路的登录请求**必须**带 `Cookie: mode=relay`（否则中继返回 HTML 错误页）；
   * - 成功后把 token、设备 id、账号与**明文密码**写入内存状态（明文密码供 `relogin()` 用）。
   *
   * 失败时抛 `SessionApiError`（消息含服务端 `msg`，属性 `code` 带业务码），且**不改动**已有状态。
   *
   * **竞态语义**：这是**显式登录**，开始时会让任何在飞行的续期作废（世代号 +1）；
   * 新状态先构建到局部变量，只有世代号仍然匹配时才提交——**绝不覆盖更新的会话**。
   */
  async passwordLogin(
    base: string,
    username: string,
    password: string,
    opts: { isRelay?: boolean } = {},
  ): Promise<void> {
    // 先校验地址：纯输入错误不该作废在飞行的续期。
    const root = requireMusicRoot(base)
    this.generation += 1
    const generation = this.generation
    const next = await this.performPasswordLogin(root, username, password, opts)
    // 期间又发生了显式登录 / 登出 / 恢复会话：本次结果作废（不覆盖更新的会话）。
    if (generation !== this.generation) return
    this.state = next
  }

  /**
   * 密码登录的 HTTP 部分：拿到新状态但**不提交**到 `this.state`。
   *
   * 提交与否由调用方按世代号判断（显式登录与续期共用这段逻辑，避免两条路径语义漂移）。
   */
  private async performPasswordLogin(
    base: string,
    username: string,
    password: string,
    opts: { isRelay?: boolean },
  ): Promise<SessionState> {
    const root = requireMusicRoot(base)
    const isRelay = opts.isRelay ?? isRelayHost(root)
    // 设备 id 是**服务端作用域**的：换了服务器必须重新生成，不能把上一台服务器的 device id 带过去。
    const deviceId =
      this.state.base === root && this.state.deviceId ? this.state.deviceId : newDeviceId()
    const body = JSON.stringify({ username, password: sha256(password), deviceId })
    const url = `${root}${API_PREFIX}/user/password-login`

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authx: authx('POST', url, body),
    }
    // 中继关卡：登录请求本身也要带 mode=relay（此时还没有 token，只带 mode）。
    if (isRelay) headers['cookie'] = `mode=${RELAY_COOKIE_MODE}`

    const json = await this.postJson(url, headers, body)
    const code = readCode(json)
    if (code !== CODE_OK) {
      const msg = readMsg(json)
      throw new SessionApiError(
        `登录失败：${msg.length > 0 ? msg : '服务端拒绝登录'}（code=${code}）`,
        code,
      )
    }

    const data = asRecord(asRecord(json)?.['data'])
    const token = readString(data?.['userToken'])
    if (!token) {
      throw new SessionApiError('登录失败：服务端未返回 token', -1)
    }
    const user = asRecord(data?.['user'])

    return {
      base: root,
      mode: 'password',
      token,
      deviceId: readString(data?.['deviceId']) || deviceId,
      username: readString(user?.['username']) || username,
      password,
      isRelay,
    }
  }

  /**
   * NAS 账号登录：**只初始化会话状态，不获取 token**。
   *
   * 职责边界：OAuth 授权窗口（`auth-login` 换 token）与静默续期属于 **Task 11**
   * （`electron/oauthWindow.ts`）；本方法只负责把 `mode` / `base` / `deviceId` / `isRelay` 落到状态里，
   * token 由 Task 11 拿到后交给 `setNasRelogin()` 的处理器返回。
   *
   * 本方法**不发起任何网络请求**。
   *
   * **竞态语义**：这是**显式登录**，开始时会让任何在飞行的续期作废（世代号 +1），
   * 因此在飞行的密码续期**不会**把 NAS 会话覆写回 `mode: 'password'`。
   */
  async nasLogin(base: string, deviceId: string, opts: { isRelay?: boolean } = {}): Promise<void> {
    // 先校验地址：纯输入错误不该作废在飞行的续期。
    const root = requireMusicRoot(base)
    this.generation += 1
    const generation = this.generation
    const isRelay = opts.isRelay ?? isRelayHost(root)
    const next: SessionState = {
      base: root,
      mode: 'nas',
      token: '',
      deviceId: deviceId || newDeviceId(),
      username: '',
      password: '',
      isRelay,
    }
    // 期间又发生了显式登录 / 登出：本次结果作废（不覆盖更新的会话）。
    if (generation !== this.generation) return
    this.state = next
  }

  /**
   * 安装 NAS 模式的续期处理器（**接缝**，由 Task 11 注入）。
   *
   * handler 负责完成 OAuth 静默续期并**返回新的 token 字符串**（空串表示失败）。
   *
   * ⚠️ 契约说明：handler **不直接改** `state.token`，而是把新 token 返回给管理器，
   *    由管理器在世代守卫下提交——否则「续期在飞行中、期间用户又显式登录」时，
   *    handler 会把旧 token 写进新的会话里（这正是审查 I2 指出的覆盖问题）。
   *
   * 未安装 handler 时 `relogin()` 返回 `false`（**不伪造 token**）。
   */
  setNasRelogin(handler: () => Promise<string>): void {
    this.nasRelogin = handler
  }

  // -------------------------------------------------------------------------
  // 续期
  // -------------------------------------------------------------------------

  /**
   * 静默续期。
   *
   * - `mode === 'password'`：用保存的**明文密码**重新登录；
   * - `mode === 'nas'`：交给 Task 11 注入的 OAuth 续期处理器（未安装则返回 `false`）。
   *
   * **并发共享同一个 in-flight Promise**：同时触发多次 `relogin()` 时实际只发一次登录请求，
   * 其余调用复用同一个 Promise。
   *
   * 任何失败都**返回 `false` 而不抛异常**（原因记在 `lastReloginError`）：
   * 上层（`request()`）要靠这个返回值决定是否把 `99999` 原样抛回渲染层。
   *
   * 续期成功后会**把新 token 落盘**（写盘失败不影响续期本身，原因记在 `lastSaveError`）。
   */
  relogin(): Promise<boolean> {
    if (this.inflightRelogin) return this.inflightRelogin
    const running = this.doRelogin().finally(() => {
      if (this.inflightRelogin === running) this.inflightRelogin = null
    })
    this.inflightRelogin = running
    return running
  }

  /** 续期的实际动作（`relogin()` 的内部实现，失败一律转成 `false`）。 */
  private async doRelogin(): Promise<boolean> {
    this.lastReloginError = null
    const generation = this.generation
    try {
      if (this.state.mode === 'nas') {
        if (!this.nasRelogin) {
          this.lastReloginError = new SessionStateError(
            'NO_SESSION',
            'NAS 模式尚未安装 OAuth 续期处理器（Task 11）',
          )
          return false
        }
        const token = await this.nasRelogin()
        // 期间发生了显式登录 / 登出：**丢弃续期自己的结果**，不动 `this.state`。
        if (generation !== this.generation) {
          this.lastReloginError = new SessionStateError(
            'STALE',
            '续期结果已过期（期间会话已被替换），已丢弃',
          )
          return false
        }
        if (!token) {
          // ⚠️ handler 已经记下**更具体**的原因时（例如「fnOS 登录已过期」），
          //    **保留它**，不要覆盖成通用文案——
          //    否则「可操作」的信息（用户该重新登录 NAS 账号了）到不了诊断与用户。
          //    handler 没记原因时，行为与之前**完全一致**（通用文案）。
          this.lastReloginError ??= new SessionStateError(
            'NO_CREDENTIAL',
            'OAuth 静默续期失败：未取得新 token',
          )
          return false
        }
        this.state = { ...this.state, token }
        this.persist()
        return true
      }

      // 独立账号：用保存的明文密码重新登录。
      if (!this.state.password) {
        this.lastReloginError = new SessionStateError('NO_CREDENTIAL', '没有保存密码，无法自动续期')
        return false
      }
      const next = await this.performPasswordLogin(
        this.state.base,
        this.state.username,
        this.state.password,
        { isRelay: this.state.isRelay },
      )
      // 期间发生了显式登录 / 登出：**丢弃续期自己的结果**，不动 `this.state`
      // （早期实现在这里把状态清空，会把用户刚建立的新会话误删——表现为「莫名其妙登出」）。
      if (generation !== this.generation) {
        this.lastReloginError = new SessionStateError(
          'STALE',
          '续期结果已过期（期间会话已被替换），已丢弃',
        )
        return false
      }
      this.state = next
      this.persist()
      return this.state.token.length > 0
    } catch (err) {
      this.lastReloginError = err instanceof Error ? err : new Error(String(err))
      return false
    }
  }

  /**
   * 续期成功后把新状态落盘（**写盘失败不影响续期本身**）。
   *
   * 为什么由管理器自己落盘、而不是暴露 `onSessionChanged` 回调：
   * `session.bin` 的写入方只有本管理器一个；把落盘策略推给调用方，
   * 就会出现「续期成功但没人记得 save」——那正是审查 I3 指出的缺陷（每次启动都恢复一个已失效的 token）。
   */
  private persist(): void {
    try {
      this.save()
      this.lastSaveError = null
    } catch (err) {
      this.lastSaveError =
        err instanceof SessionStateError
          ? err
          : new SessionStateError('SAVE_FAILED', '会话保存失败：无法写入会话文件', { cause: err })
    }
  }

  // -------------------------------------------------------------------------
  // 业务请求
  // -------------------------------------------------------------------------

  /**
   * 发起带签名的业务请求。
   *
   * - URL：`${base}${API_PREFIX}/${path}`（`path` **不带**前导斜杠，如 `track/list`）；
   * - 请求头：统一附加 `authx` 签名与 `Cookie: music-token=<token>`（中继时追加 `mode=relay`）；
   * - 有 body 时序列化成 JSON 并带 `content-type: application/json`；
   * - 响应不是 JSON 时 `json` 为 `null`（**不抛异常**，由调用方按 `status` 判断）；
   * - `json.code === 99999`（token 失效）时**触发一次** `relogin()` 并重试一次；
   *   重试后仍是 `99999` 就把结果原样返回（不会无限重试）。
   *
   * 网络异常时抛带可读中文消息的错误。
   */
  async request(
    path: string,
    opts: SessionRequestOptions = {},
  ): Promise<{ status: number; json: unknown }> {
    if (!this.state.base) {
      throw new SessionStateError('NO_SESSION', '尚未连接服务器：缺少会话基址')
    }
    if (!this.state.token) {
      throw new SessionStateError('NO_CREDENTIAL', '尚未登录：缺少身份凭据')
    }

    const method = (opts.method ?? 'GET').toUpperCase()
    const relative = path.replace(/^\/+/, '')
    const url = `${this.state.base}${API_PREFIX}/${relative}${buildQuery(opts.query)}`
    const bodyString = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    // 中继模式：调用方可以覆盖（缺省仍用会话状态）。
    const isRelay = opts.isRelay ?? this.state.isRelay

    const first = await this.send(url, method, bodyString, isRelay)
    const json = await readJson(first)
    if (!isTokenExpired(json)) {
      return { status: first.status, json }
    }

    // token 失效：静默续期一次，然后重试**一次**。
    await this.relogin()
    const second = await this.send(url, method, bodyString, isRelay)
    return { status: second.status, json: await readJson(second) }
  }

  /**
   * 发一次请求（附加 authx 与凭证 Cookie）。
   *
   * `isRelay` 缺省用会话状态；`request()` 会把它算好后显式传进来。
   */
  private async send(
    url: string,
    method: string,
    bodyString?: string,
    isRelay: boolean = this.state.isRelay,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authx: authx(method, url, bodyString),
      cookie: buildCookie(this.state.token, isRelay),
    }
    if (bodyString !== undefined) headers['content-type'] = 'application/json'
    try {
      // 走出网通道（Electron 运行时里 = Chromium 分区栈，证书放行才真正生效）。
      return await this.http().fetch(url, { method, headers, body: bodyString })
    } catch (cause) {
      // 消息里**不含** URL 与凭证，只说明「连不上」。
      throw new Error('无法连接音乐服务（网络不可达或服务未响应）', { cause })
    }
  }

  /** 登录用的 POST（失败时把网络异常转成可读错误）。 */
  private async postJson(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<unknown> {
    let res: Response
    try {
      res = await this.http().fetch(url, { method: 'POST', headers, body })
    } catch (cause) {
      throw new Error('无法连接音乐服务（网络不可达或服务未响应）', { cause })
    }
    const json = await readJson(res)
    if (json === null) {
      throw new SessionApiError(`登录失败：服务器响应异常（HTTP ${res.status}）`, -1)
    }
    return json
  }

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------

  /**
   * 保存会话到磁盘。
   *
   * 文件格式：`<2 字节文件头><载荷>`。
   * - `E1`：载荷是 `safeStorage.encryptString()` 的密文（Windows DPAPI）；
   * - `P0`：载荷是**明文 JSON**——只在**显式**允许明文回退
   *   （`allowPlaintextFallback: true`）且没有可用加密时使用；
   *   此时文件里含 token 与明文密码，**安全性显著降低**。
   *
   * 载荷是 `{ version, savedAt, state }`；`load()` 同时兼容裸的 state 对象。
   *
   * **不做静默降级**：
   * - 没有可用加密且未显式允许明文 → 抛 `SessionStateError('NO_ENCRYPTION')`，**不写任何文件**；
   * - 加密过程出错（`encryptString` 抛异常）→ 抛 `SessionStateError('SAVE_FAILED')`，
   *   **不降级成明文**（悄悄把明文写盘比保存失败更糟）。
   *
   * **原子写**：先写 `<file>.tmp` 再 `rename` 覆盖，避免写到一半崩溃留下截断的会话文件。
   */
  save(): void {
    const filePath = this.resolveFilePath()
    const storage = this.resolveStorage()
    const payload = JSON.stringify({
      version: SESSION_FORMAT_VERSION,
      savedAt: this.now(),
      state: this.state,
    })

    let header: string
    let body: Buffer
    if (storage && storage.isEncryptionAvailable()) {
      header = HEADER_ENCRYPTED
      try {
        body = storage.encryptString(payload)
      } catch (cause) {
        // 加密失败：**不降级成明文**，直接报错（没有写出任何文件）。
        throw new SessionStateError(
          'SAVE_FAILED',
          '会话加密失败：safeStorage 加密异常（已放弃写入，未降级为明文）',
          { cause },
        )
      }
    } else {
      if (!this.options.allowPlaintextFallback) {
        throw new SessionStateError(
          'NO_ENCRYPTION',
          '会话加密不可用（safeStorage 不可用），拒绝以明文落盘；如确需降级请显式开启 allowPlaintextFallback',
        )
      }
      header = HEADER_PLAINTEXT
      body = Buffer.from(payload, 'utf8')
    }

    const tmpPath = `${filePath}.tmp`
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(tmpPath, Buffer.concat([Buffer.from(header, 'utf8'), body]))
      renameSync(tmpPath, filePath)
    } catch (cause) {
      // 半成品临时文件不能留下（否则下次启动会把它当成会话文件）。
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // 清理失败不掩盖原始错误。
      }
      throw new SessionStateError('SAVE_FAILED', '会话保存失败：无法写入会话文件', { cause })
    }
  }

  /**
   * 从磁盘恢复会话。
   *
   * 返回是否恢复成功。**文件不存在 / 内容损坏 / 解密失败都返回 `false` 且不抛异常**，
   * 此时内存状态保持原样（不会写进半截状态）。
   *
   * **失败可观测**（控制器裁定）：
   * - 文件不存在 = 正常的「没登录」→ 返回 `false`，`lastLoadError` 保持 `null`；
   * - 解密失败 / 文件损坏 → 返回 `false`，并写入 `lastLoadError`（带可判别的 `code`）
   *   + 一条**不含凭证**的 `console.warn`。
   *   这样调用方能区分「失败不是没登录，而是解密失败」（例如在 `app.ready` 之前调用了 `load()`）。
   */
  load(): boolean {
    this.lastLoadError = null

    let filePath: string
    try {
      filePath = this.resolveFilePath()
    } catch (err) {
      this.failLoad(
        'NO_STORAGE',
        '会话文件路径不可用（当前进程没有 Electron 运行时，且未注入 filePath）',
        err,
      )
      return false
    }

    let raw: Buffer
    try {
      raw = readFileSync(filePath)
    } catch {
      // 文件不存在 = 正常的「没登录」状态，不报错、不告警。
      return false
    }

    try {
      if (raw.length < 2) {
        this.failLoad('LOAD_CORRUPTED', '会话文件已损坏（长度不足）')
        return false
      }
      const header = raw.subarray(0, 2).toString('utf8')
      const body = raw.subarray(2)

      let text: string
      if (header === HEADER_ENCRYPTED) {
        const storage = this.resolveStorage()
        if (!storage) {
          this.failLoad('LOAD_DECRYPT_FAILED', '会话文件已加密，但当前环境没有可用的 safeStorage（无法解密）')
          return false
        }
        try {
          text = storage.decryptString(body)
        } catch (cause) {
          this.failLoad(
            'LOAD_DECRYPT_FAILED',
            '会话解密失败（可能是在 app.ready 之前调用了 load()，或文件来自其它系统账户）',
            cause,
          )
          return false
        }
      } else if (header === HEADER_PLAINTEXT) {
        text = body.toString('utf8')
      } else {
        this.failLoad('LOAD_CORRUPTED', '会话文件头标记无法识别')
        return false
      }

      const state = extractState(JSON.parse(text) as unknown)
      if (!state) {
        this.failLoad('LOAD_CORRUPTED', '会话文件内容不是有效的会话记录')
        return false
      }
      // 恢复出来的会话作废任何在飞行的续期。
      this.generation += 1
      this.state = state
      return true
    } catch (cause) {
      this.failLoad('LOAD_CORRUPTED', '会话文件内容损坏（无法解析）', cause)
      return false
    }
  }

  /**
   * 记录一次 `load()` 失败：写 `lastLoadError` + 打一条**不含凭证**的告警。
   *
   * ⚠️ 告警里**只写本函数给定的固定文案**，**不写原始异常消息**：
   * `JSON.parse` 的报错会带上一小段文件内容（明文回退时就是口令片段），
   * 原始原因只留在 `lastLoadError.cause` 里供调用方判断，不进日志。
   */
  private failLoad(code: SessionStateErrorCode, message: string, cause?: unknown): void {
    this.lastLoadError = new SessionStateError(
      code,
      message,
      cause === undefined ? undefined : { cause },
    )
    console.warn(`[fnmusic] 会话加载失败：${message}`)
  }

  /**
   * 清除会话：删除会话文件并清空内存状态。
   *
   * 文件不存在 / 删除失败都不抛异常（内存状态照样清空）。
   */
  clear(): void {
    this.generation += 1
    try {
      const filePath = this.resolveFilePath()
      rmSync(filePath, { force: true })
      rmSync(`${filePath}.tmp`, { force: true })
    } catch {
      // 文件不存在或路径不可用：忽略。
    }
    this.state = emptyState()
    this.inflightRelogin = null
  }
}

/**
 * 从落盘载荷里还原状态。
 *
 * 兼容两种形状：`{ version, savedAt, state }` 与裸的 state 对象。
 * 形状不合法（缺 base / mode 非法）时返回 `null`。
 */
function extractState(parsed: unknown): SessionState | null {
  const root = asRecord(parsed)
  if (!root) return null
  const raw = asRecord(root['state']) ?? root

  const mode = readString(raw['mode'])
  if (mode !== 'nas' && mode !== 'password') return null
  const base = normalizeBase(readString(raw['base']))
  if (!base) return null

  return {
    base,
    mode,
    token: readString(raw['token']),
    deviceId: readString(raw['deviceId']),
    username: readString(raw['username']),
    password: readString(raw['password']),
    isRelay: raw['isRelay'] === true,
  }
}
