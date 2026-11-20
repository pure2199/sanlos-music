// 跨进程共享常量：主进程（Electron）与渲染进程（React）同时 import。
// 本文件只能是纯数据，不得引入 Electron API、Node 内置模块或 DOM 类型。

import type { EqPreset } from './types'

// ---------------------------------------------------------------------------
// 签名常量（逐字照抄规格，改动一个字符会导致所有请求被服务端拒绝）
// ---------------------------------------------------------------------------

/** authx 签名前缀，音乐接口与 FN 连接接口共用。 */
export const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'

/** 音乐接口（`<server>/music/api/v1/...`）的签名密钥。 */
export const SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'

/** FN 连接接口（`5ddd.com/api/v1/fn/con`）专用的签名密钥，与 SIGN_KEY 不同，不可混用。 */
export const FN_SIGN_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c'

// ---------------------------------------------------------------------------
// 接口路径
// ---------------------------------------------------------------------------

/** 音乐服务 API 版本前缀。 */
export const API_PREFIX = '/api/v1'

/** 音乐服务挂载路径，最终基址为 `<server>/music/api/v1`。 */
export const MUSIC_PATH = '/music'

/** FN 连接（候选地址发现）接口。 */
export const FN_CON_API = 'https://5ddd.com/api/v1/fn/con'

/** FN 连接接口参与签名的纯路径（实测：该接口用纯路径签名，音乐接口用完整 URL 的 pathname）。 */
export const FN_CON_PATH = '/api/v1/fn/con'

// ---------------------------------------------------------------------------
// 服务端口
// ---------------------------------------------------------------------------

/** 音乐服务的默认 HTTP 端口（实测与规格一致）。 */
export const DEFAULT_HTTP_PORT = 5666

/** 音乐服务的默认 HTTPS 端口（实测与规格一致）。 */
export const DEFAULT_HTTPS_PORT = 5667

// ---------------------------------------------------------------------------
// 凭证与链路
// ---------------------------------------------------------------------------

/** 音乐凭证 Cookie 键。 */
export const MUSIC_TOKEN_COOKIE = 'music-token'

/** 中继链路附加的 Cookie 键值（与 token 合并在同一个 Cookie 头）。 */
export const RELAY_COOKIE_MODE = 'relay'

/** 中继链路附加的 Cookie **键名**（与 `RELAY_COOKIE_MODE` 配对使用）。 */
export const RELAY_COOKIE_KEY = 'mode'

/** 中继域名后缀：回退地址为 `<fnId>.fnos.net`（实测；`5ddd.com` 只是 FN 连接接口自身的服务域名）。 */
export const RELAY_DOMAIN_SUFFIX = '.fnos.net'

// ---------------------------------------------------------------------------
// NAS 账号 OAuth（Task 11）
// ---------------------------------------------------------------------------
//
// ⚠️ 实测（规格 §15.8 第 2 条）：`GET <base>/api/v1/sys/config` 返回的
// `data.nasOAuth` 里**只有 `clientId`，没有 `url` 字段**——授权地址必须**自行拼装**：
//
//   <服务器根>/signin?client_id=<clientId>&redirect_uri=<base>/oauth/result&app_name=Sanlos Music
//
// 这里集中放**唯一一份**字面量：应用名与回调路径不许散落在多个文件里。

/** NAS 账号 OAuth 的应用名（授权地址的 `app_name` 参数；拼进 query 前要 URL 编码）。 */
export const NAS_OAUTH_APP_NAME = 'Sanlos Music'

/** NAS 账号 OAuth 的登录页路径（拼在**服务器根**之后：`<服务器根>/signin`）。 */
export const NAS_OAUTH_SIGNIN_PATH = '/signin'

/** NAS 账号 OAuth 的回调路径（拼在**音乐根**之后：`<base>/oauth/result`）。 */
export const NAS_OAUTH_REDIRECT_PATH = '/oauth/result'

// ---------------------------------------------------------------------------
// 业务码
// ---------------------------------------------------------------------------

/** 业务码 0 表示成功。 */
export const CODE_OK = 0

/** 业务码 99999 表示 token 失效（静默续期一次后重试）。 */
export const CODE_TOKEN_EXPIRED = 99999

// ---------------------------------------------------------------------------
// 代理层错误类别（**信封里的 `proxy` 字段**）
// ---------------------------------------------------------------------------
//
// ⚠⚠ **为什么需要它**（T130）：
//    主进程把所有**代理层故障**统一转成 `HTTP 502 + { code: -1, msg }`
//    （超时、网络不可达、未连接、未登录、路径非法、请求体非法 —— 全是同一个形状）。
//    ⇒ 而 `code = -1` **与服务端真实业务码撞码**（实测：榜单端点 `page=list` 就返回
//    `{ code: -1, subcode: 400 }`）⇒ 渲染层**无歧义地分不出来**「代理层故障」与
//    「服务端业务拒绝」⇒ 超时被当成业务错误抛成 `ApiError`。
//
// ⇒ 正解：主进程在信封里**多带一个类别标记**（**不占用 `code` 空间**，
//    所以既不与服务端业务码撞码，也不改动既有的 `code: -1` 契约）。

/**
 * 代理层错误类别：**网络 / 代理层故障**（超时、网络不可达）⇒ **可重试**。
 *
 * 渲染进程据此抛 `ApiNetworkError`（而不是「服务端业务错误」）。
 */
export const PROXY_ERROR_NETWORK = 'network'

/**
 * 代理层错误类别：**会话失效**（未连接 / 未登录 / 续期失败）⇒ 应当**回登录页**。
 *
 * 渲染进程据此触发「会话失效」通知（规格 §5.4），
 * 避免用户卡在「已登录、但每个请求都失败」的死状态里。
 */
export const PROXY_ERROR_AUTH = 'auth'

/**
 * 代理层错误类别：**请求本身不合法**（地址 / 路径 / 请求体）⇒ 客户端用错了。
 *
 * 渲染进程据此抛 `ApiError`（客户端错误），**不冒充**「服务端业务拒绝」。
 */
export const PROXY_ERROR_REQUEST = 'request'

/** 代理层错误类别的联合类型。 */
export type ProxyErrorKind =
  | typeof PROXY_ERROR_NETWORK
  | typeof PROXY_ERROR_AUTH
  | typeof PROXY_ERROR_REQUEST

// ---------------------------------------------------------------------------
// EQ 频点与预置曲线
// ---------------------------------------------------------------------------

/** 10 段 EQ 频点（Hz），标准 ISO 1/1 倍频程。 */
export const EQ_BANDS_10: number[] = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/** 15 段 EQ 频点（Hz），标准 ISO 1/1 倍频程。 */
export const EQ_BANDS_15: number[] = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
]

/** peaking 滤波器 Q 值。 */
export const EQ_Q = 1.41

/** 单段增益上限（dB）。 */
export const EQ_GAIN_LIMIT = 12

/**
 * 10 条预置 EQ 曲线，key 为稳定标识。
 *
 * 取用规则（Task 21）：段数 10 取 `gains`（对应 `EQ_BANDS_10`），段数 15 取 `gains15`（对应 `EQ_BANDS_15`）；
 * 两套频点不同，不可互相切片。`gains` 与 `gains15` 均为必填，避免双份真相源漂移。
 */
export const EQ_PRESETS: Record<string, EqPreset> = {
  flat: {
    label: '平直',
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    gains15: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  pop: {
    label: '流行',
    gains: [4, 3, 0, -1, -1, 0, 2, 3, 3, 2],
    gains15: [4, 3, 1, -1, -2, -1, 0, 1, 2, 3, 3, 3, 2, 2, 2],
  },
  rock: {
    label: '摇滚',
    gains: [5, 4, 2, -1, -2, 0, 2, 4, 5, 4],
    gains15: [5, 4, 3, 1, -1, -2, -1, 0, 2, 4, 5, 5, 4, 4, 3],
  },
  jazz: {
    label: '爵士',
    gains: [3, 2, 0, 1, 2, 1, -1, -1, 1, 2],
    gains15: [3, 3, 1, 0, 1, 2, 2, 1, 0, -1, -1, 0, 1, 2, 2],
  },
  classical: {
    label: '古典',
    gains: [2, 2, 1, 0, -1, -1, 0, 2, 3, 3],
    gains15: [3, 3, 2, 1, 0, -1, -1, -1, 0, 1, 2, 3, 3, 3, 2],
  },
  electronic: {
    label: '电子',
    gains: [4, 3, 1, 0, -2, 1, 1, 0, 2, 3],
    gains15: [5, 4, 2, 0, -2, -1, 1, 1, 1, 0, 1, 1, 2, 3, 3],
  },
  acoustic: {
    label: '原声',
    gains: [3, 3, 2, 1, 1, 1, 2, 3, 3, 2],
    gains15: [3, 3, 3, 2, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 2],
  },
  loudness: {
    label: '响度',
    gains: [6, 4, 0, -2, -2, 0, 1, 3, 5, 6],
    gains15: [6, 5, 2, -1, -3, -2, 0, 0, 1, 2, 3, 4, 5, 6, 6],
  },
  vocal: {
    label: '人声',
    gains: [-2, -2, -1, 1, 3, 4, 4, 3, 1, -1],
    gains15: [-3, -3, -2, 0, 2, 3, 4, 4, 4, 3, 2, 1, 0, -1, -2],
  },
  'bass-boost': {
    label: '低音增强',
    gains: [6, 5, 4, 2, 0, -1, -2, -3, -4, -4],
    gains15: [7, 6, 5, 3, 1, 0, -1, -2, -2, -3, -3, -4, -4, -5, -5],
  },
}
