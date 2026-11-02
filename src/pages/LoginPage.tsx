import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'

import type { CandidateInfo, ServerInfo } from '../../shared/bridge'
import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT } from '../../shared/constants'
import { stripUserInfo, withDefaultPort } from '../lib/address'
import { getBridge } from '../lib/bridge'
import { KIND_LABELS } from '../lib/connection'
import { useSessionStore } from '../state/sessionStore'
import { useSettingsStore } from '../state/settingsStore'
import './login-page.css'

// ---------------------------------------------------------------------------
// 登录页（Task 10b）
//
// 两个正交的开关：
// - **连接方式**：直接地址（默认带协议 + 端口）/ FN ID 探测；
// - **登录方式**：独立账号（口令）/ NAS 账号（OAuth 授权，Task 11 才可用）。
//
// 凭证边界（追加要求 E）：
// - **口令只存在于本组件的本地 `useState`**——不进 store、不进 localStorage、
//   不进 URL、不进日志；登录成功后立刻清空。
// - `window.fn` 的返回也只有脱敏的 `AuthSessionInfo`（没有 token / 口令）。
// ---------------------------------------------------------------------------

/** 连接方式：直连地址 / FN ID 探测。 */
type TargetMode = 'address' | 'fnid'

/** 登录方式：独立账号（口令）/ NAS 账号（OAuth）。 */
type LoginMethod = 'password' | 'nas'

/** 主进程在 Task 11 之前抛出的 NAS 分支错误（`electron/ipc.ts`）。 */
const NAS_HANDLER_MISSING = '尚未安装 NAS 账号登录处理器'

/** 面向用户的降级提示（**不暴露**技术错误串）。 */
const NAS_UNAVAILABLE_HINT = 'NAS 账号授权登录将在下一版本开放，请先使用独立账号登录'

/** 桥不可用时的提示（纯浏览器预览等场景）。 */
const BRIDGE_UNAVAILABLE = '认证桥不可用：请在飞牛音乐桌面客户端内使用本页面'

/** 地址输入框的默认值：带协议 + 默认端口（端口取自共享常量，不写字面量）。 */
const DEFAULT_ADDRESS = `http://192.168.1.2:${DEFAULT_HTTP_PORT}`

/**
 * 把主进程抛出的错误变成可以给用户看的文案。
 *
 * - 主进程的错误消息**已经脱敏**（`redactError` 改写过 message / stack / cause 链），
 *   这里直接展示，不自己再拼装；
 * - 剥掉 Electron IPC 的技术前缀：`ipcRenderer.invoke` 拒绝时的 message 形如
 *   `Error invoking remote method 'auth:server-info': Error: 服务器响应异常（HTTP 500）`
 *   —— 直接展示整句观感很差，这里**只剥这一层前缀**（不剥正文）；
 * - NAS 分支的技术错误（尚未安装处理器）换成**可读的降级提示**，
 *   界面上**不出现**原始错误串（追加要求 C.2 / J）。
 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  if (cleaned.includes(NAS_HANDLER_MISSING)) return NAS_UNAVAILABLE_HINT
  return cleaned.length > 0 ? cleaned : '操作失败，请稍后重试'
}

/** 候选的展示状态：不可达 / 可达但有备注 / 可达。 */
function candidateStatus(candidate: CandidateInfo): 'unreachable' | 'note' | 'ok' {
  if (!candidate.ok) return 'unreachable'
  return candidate.error ? 'note' : 'ok'
}

export function LoginPage(): ReactElement {  const [target, setTarget] = useState<TargetMode>('address')
  const [method, setMethod] = useState<LoginMethod>('password')
  const [address, setAddress] = useState<string>(DEFAULT_ADDRESS)
  const [fnId, setFnId] = useState('')
  const [username, setUsername] = useState('')
  /** ⚠️ 口令**只**在这里（组件本地 state）；不进 store、不落盘。 */
  const [password, setPassword] = useState('')
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [candidates, setCandidates] = useState<CandidateInfo[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const session = useSessionStore((s) => s.session)
  const setSession = useSessionStore((s) => s.setSession)
  const setConnection = useSessionStore((s) => s.setConnection)
  const setStoreCandidates = useSessionStore((s) => s.setCandidates)
  const setLastServer = useSettingsStore((s) => s.setLastServer)

  // -------------------------------------------------------------------------
  // 启动时恢复一次会话（追加要求 F）
  //
  // ⚠️ `restore()` 会让主进程的会话世代号 +1，从而作废正在飞行的静默续期，
  //    所以**只在挂载时调一次**——不要放进每次渲染 / 每个 effect / 轮询里。
  //    「重连」是 `relogin()`，不是 `restore()`。
  //
  // ⚠️ 用 `useRef` 守卫而不是「每次 effect 都调」：React 18 的 StrictMode 会把
  //    effect 跑两遍（卸载再挂载），守卫保证 `restore()` 只被调一次；
  //    同时**不**用 `cancelled` 标志丢弃结果——写的是全局 store，卸载后写入是安全的，
  //    否则 StrictMode 下第一次的结果会被丢掉，界面永远停在「未登录」。
  // -------------------------------------------------------------------------
  const restoreStarted = useRef(false)
  useEffect(() => {
    if (restoreStarted.current) return
    restoreStarted.current = true
    const bridge = getBridge()
    if (!bridge) return
    void (async () => {
      try {
        const info = await bridge.restore()
        setSession(info)
        if (info.connected) {
          const connection = await bridge.connectionInfo()
          setConnection(connection)
        }
      } catch {
        // 恢复失败按「未登录」处理：不阻断界面。
      }
    })()
  }, [setSession, setConnection])

  /**
   * 登录用的服务器基址。
   *
   * - FN ID 模式：取选中的候选地址——**原样使用**（候选自带端口，不补默认端口）；
   * - 地址模式：取地址输入框，并**补默认端口**（只填 host 时否则会打到 80 端口）。
   */
  const effectiveServer =
    target === 'fnid' ? (selectedAddress ?? '') : withDefaultPort(address.trim())

  /** 地址模式：读取服务器信息（名称 / 版本 / 是否支持 NAS 账号登录）。 */
  const handleCheckServer = async (): Promise<void> => {
    const raw = address.trim()
    if (!raw) {
      setError('请填写服务器地址')
      return
    }
    // ⚠️ 只填 host 时补默认端口（`normalizeBase` 不补端口，否则会打到 80 端口）。
    const value = withDefaultPort(raw)
    const bridge = getBridge()
    if (!bridge) {
      setError(BRIDGE_UNAVAILABLE)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const info = await bridge.serverInfo(value)
      setServerInfo(info)
      // ⚠️ 落盘前剥掉 userinfo：用户可能把 `user:口令@host` 粘进地址框，
      //    口令绝不能进 localStorage（`stripUserInfo` 与有没有协议无关）。
      setLastServer(stripUserInfo(value))
    } catch (err) {
      setServerInfo(null)
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  /** FN ID 模式：探测候选链路。 */
  const handleProbe = async (): Promise<void> => {
    const value = fnId.trim()
    if (!value) {
      setError('请填写 FN ID')
      return
    }
    const bridge = getBridge()
    if (!bridge) {
      setError(BRIDGE_UNAVAILABLE)
      return
    }
    setBusy(true)
    setError(null)
    setCandidates([])
    setSelectedAddress(null)
    try {
      const list = await bridge.probe(value)
      setCandidates(list)
      // 缓存给 ConnectionBadge 展开时展示（不含凭证）。
      setStoreCandidates(list)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  /** 选中一条候选链路（不可达的候选**也允许**选中，交给真实登录去判定）。 */
  const handleSelectCandidate = (candidate: CandidateInfo): void => {
    setSelectedAddress(candidate.address)
    setError(null)
  }

  /** 执行登录。 */
  const handleLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const server = effectiveServer
    if (!server) {
      setError('请先填写服务器地址或选择一条链路')
      return
    }
    const bridge = getBridge()
    if (!bridge) {
      setError(BRIDGE_UNAVAILABLE)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const info = await bridge.login({
        server,
        // NAS 分支由主进程走 OAuth，**不用**账号口令（字段仍须传，传空串）。
        username: method === 'nas' ? '' : username.trim(),
        password: method === 'nas' ? '' : password,
        mode: method,
      })
      // 登录成功：立刻清空口令框，并同步脱敏的会话状态。
      setPassword('')
      setSession(info)
      // ⚠️ 同上：落盘前剥掉 userinfo，口令不落盘。
      setLastServer(stripUserInfo(server))
      try {
        // 链路信息取不到**不影响**登录结果（不让它把一次成功的登录报成失败）。
        const connection = await bridge.connectionInfo()
        setConnection(connection)
      } catch {
        // 忽略：顶栏指示器会退化成「未连接」。
      }
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  /** 登出（桥返回的是脱敏状态）。 */
  const handleLogout = async (): Promise<void> => {
    const bridge = getBridge()
    if (!bridge) {
      setError(BRIDGE_UNAVAILABLE)
      return
    }
    setBusy(true)
    try {
      const info = await bridge.logout()
      setSession(info)
      setConnection(null)
      setStoreCandidates([])
      setServerInfo(null)
      setCandidates([])
      setSelectedAddress(null)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const connected = session.connected

  return (
    <div className="fnm-login">
      <section className="fnm-login__card" aria-label="登录">
        <h1 className="fnm-login__title">连接飞牛音乐</h1>

        {connected && (
          <section className="fnm-login__connected" role="status">
            <h2 className="fnm-login__connected-title">已连接</h2>
            <dl className="fnm-login__facts">
              <div className="fnm-login__fact">
                <dt>服务器</dt>
                <dd>{session.serverLabel ?? '—'}</dd>
              </div>
              <div className="fnm-login__fact">
                <dt>登录账号</dt>
                <dd>{session.username ?? '—'}</dd>
              </div>
              <div className="fnm-login__fact">
                <dt>登录方式</dt>
                <dd>{session.mode === 'nas' ? 'NAS 授权登录' : '独立账号登录'}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="fnm-login__button fnm-login__button--ghost"
              onClick={() => void handleLogout()}
              disabled={busy}
            >
              退出登录
            </button>
          </section>
        )}

        <form
          className="fnm-login__form"
          hidden={connected}
          onSubmit={(event) => void handleLogin(event)}
        >
          <div className="fnm-login__modes" role="group" aria-label="连接方式">
            <button
              type="button"
              className="fnm-login__mode"
              aria-pressed={target === 'address'}
              onClick={() => setTarget('address')}
            >
              直接地址
            </button>
            <button
              type="button"
              className="fnm-login__mode"
              aria-pressed={target === 'fnid'}
              onClick={() => setTarget('fnid')}
            >
              FN ID
            </button>
          </div>

          {target === 'address' ? (
            <div className="fnm-login__field">
              <label className="fnm-login__label" htmlFor="fnm-address">
                NAS 地址
              </label>
              <input
                id="fnm-address"
                className="fnm-login__input"
                type="text"
                placeholder="NAS 地址，例如 http://192.168.1.2:5666"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="fnm-login__hint">
                未填写端口时按协议自动补默认端口：HTTP {DEFAULT_HTTP_PORT} / HTTPS{' '}
                {DEFAULT_HTTPS_PORT}
              </p>
              <button
                type="button"
                className="fnm-login__button fnm-login__button--secondary"
                onClick={() => void handleCheckServer()}
                disabled={busy}
              >
                检测服务器
              </button>
              {serverInfo && (
                <dl className="fnm-login__facts">
                  <div className="fnm-login__fact">
                    <dt>服务器名称</dt>
                    <dd>{serverInfo.serverName ?? '未提供'}</dd>
                  </div>
                  <div className="fnm-login__fact">
                    <dt>服务器版本</dt>
                    <dd>{serverInfo.serverVersion ?? '未提供'}</dd>
                  </div>
                  <div className="fnm-login__fact">
                    <dt>NAS 账号登录</dt>
                    <dd>{serverInfo.supportsNasLogin ? '支持' : '不支持'}</dd>
                  </div>
                </dl>
              )}
            </div>
          ) : (
            <div className="fnm-login__field">
              <label className="fnm-login__label" htmlFor="fnm-fnid">
                设备标识
              </label>
              <input
                id="fnm-fnid"
                className="fnm-login__input"
                type="text"
                aria-label="FN ID"
                placeholder="FN ID，例如 example-fn-id"
                value={fnId}
                onChange={(event) => setFnId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="fnm-login__button fnm-login__button--secondary"
                onClick={() => void handleProbe()}
                disabled={busy}
              >
                探测链路
              </button>
              {candidates.length > 0 && (
                <ul className="fnm-login__candidates">
                  {candidates.map((candidate) => {
                    const status = candidateStatus(candidate)
                    return (
                      <li key={candidate.address} className="fnm-login__candidate">
                        <button
                          type="button"
                          className="fnm-login__candidate-button"
                          aria-pressed={selectedAddress === candidate.address}
                          onClick={() => handleSelectCandidate(candidate)}
                        >
                          <span className="fnm-login__candidate-label">{candidate.label}</span>
                          <span className="fnm-login__candidate-kind">
                            {KIND_LABELS[candidate.kind]}
                          </span>
                          <span className="fnm-login__candidate-address">{candidate.address}</span>
                          <span className="fnm-login__candidate-status">
                            {candidate.ok ? '可达' : '不可达'}
                          </span>
                        </button>
                        {candidate.error && (
                          <p
                            className="fnm-login__candidate-note"
                            data-status={status}
                          >
                            {candidate.error}
                          </p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="fnm-login__hint">
                将连接到：{selectedAddress ?? '（请先选择一条链路）'}
              </p>
            </div>
          )}

          <fieldset className="fnm-login__fieldset">
            <legend className="fnm-login__legend">登录方式</legend>
            <label className="fnm-login__radio">
              <input
                type="radio"
                name="fnm-login-method"
                value="password"
                checked={method === 'password'}
                onChange={() => setMethod('password')}
              />
              <span>独立账号</span>
            </label>
            <label className="fnm-login__radio">
              <input
                type="radio"
                name="fnm-login-method"
                value="nas"
                checked={method === 'nas'}
                onChange={() => setMethod('nas')}
              />
              <span>NAS 账号</span>
            </label>
          </fieldset>

          {method === 'password' && (
            <div className="fnm-login__credentials">
              <div className="fnm-login__field">
                <label className="fnm-login__label" htmlFor="fnm-username">
                  账号
                </label>
                <input
                  id="fnm-username"
                  className="fnm-login__input"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  spellCheck={false}
                />
              </div>
              <div className="fnm-login__field">
                <label className="fnm-login__label" htmlFor="fnm-password">
                  密码
                </label>
                <input
                  id="fnm-password"
                  className="fnm-login__input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </div>
            </div>
          )}

          {error && (
            <p className="fnm-login__error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="fnm-login__button" disabled={busy}>
            登录
          </button>
        </form>
      </section>
    </div>
  )
}
