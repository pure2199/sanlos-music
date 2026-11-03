// 渲染进程与主进程之间的**播放器 / 窗口 / 偏好**桥类型定义。
//
// ⚠️ 本文件**只能是纯类型**（`interface` / `type`）：
// - 不得出现任何运行时代码（导出的值、常量、函数）；
// - 不得 import Electron / Node 内置模块 / DOM 类型。
//
// 理由与 `shared/bridge.ts` 完全相同：主进程（`electron/ipc.ts`、`electron/preload.ts`）
// 与渲染进程（`src/player/mediaSession.ts`）**共用**这份契约，而渲染进程跑在
// `contextIsolation: true` 的沙箱里——一旦这里混进运行时代码，渲染进程 import 它时
// 会把那些代码一起打进 bundle，等于把主进程逻辑泄露到页面。
//
// ---------------------------------------------------------------------------
// 与 `shared/bridge.ts` 的分工（**不许混**）
// ---------------------------------------------------------------------------
// - `shared/bridge.ts` = **认证桥**（七个 `auth:*` 通道，已通过复审，**不许**往里塞东西）；
// - 本文件 = **播放器 / 窗口 / 偏好桥**（Task 17 新建）。
//
// ---------------------------------------------------------------------------
// 通道清单（方向**不许搞反**）
// ---------------------------------------------------------------------------
// | 通道                  | 方向              | 机制                 | 入参 → 出参                          |
// |-----------------------|-------------------|----------------------|--------------------------------------|
// | `player:state`        | 渲染进程 → 主进程 | `ipcRenderer.send`   | `PlayerStateSnapshot`（单向推送）    |
// | `player:command`      | 渲染进程 → 主进程 | `ipcRenderer.send`   | `PlayerCommand`                      |
// | `player:command`      | 主进程 → 渲染进程 | `webContents.send`   | `PlayerCommand`                      |
// | `win:minimize`        | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → 无                              |
// | `win:toggle-maximize` | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → 无                              |
// | `win:close`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → 无                              |
// | `prefs:get`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | 无 → `AppPrefs`                      |
// | `prefs:set`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | `Partial<AppPrefs>` → `AppPrefs`     |
// | `theme:set`           | 渲染进程 → 主进程 | `ipcRenderer.invoke` | `ThemeName` → `AppPrefs`             |
//
// ⚠️ **`player:command` 是双向的**（同一个通道名、两个方向、两套机制）：
// - **渲染进程 → 主进程**：媒体会话（Windows 媒体键 / SMTC）的 action handler
//   把命令**发给主进程**；主进程是唯一的命令路由，把它**转发**给渲染进程执行。
// - **主进程 → 渲染进程**：托盘菜单点击时直接下发。
//
//   为什么要绕这一圈：播放状态由**渲染进程**持有（`<audio>` 在渲染进程里），
//   主进程只是消费它来更新托盘。媒体会话的 handler **只负责发命令**、
//   **不直接改状态**——否则会与「状态回传」形成回环。
//   渲染进程**只执行**从主进程收到的命令，绝不本地直接执行自己发出的命令，
//   所以不存在「发一次执行两遍」。
//
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）
// ---------------------------------------------------------------------------
// 1. **本文件里的任何一个类型都不许携带凭证**：没有 token / password / deviceId。
// 2. `AppPrefs` 是**偏好**（窗口位置 / 主题名 / 关闭窗口的行为），
//    **不是**会话——偏好文件里绝不允许出现凭证。

import type { EqPrefsPayload } from './eqPrefs'
import type { PlayMode, ThemeName } from './types'

// ---------------------------------------------------------------------------
// 播放命令
// ---------------------------------------------------------------------------

/**
 * 播放命令（主进程 ↔ 渲染进程）。
 *
 * ⚠️ 这是一个**判别联合**（`type` 字段区分）：接收方按 `type` 分派，
 *    不认识的 `type` 一律忽略（向前兼容）。
 */
export type PlayerCommand =
  /** 继续播放。 */
  | { type: 'play' }
  /** 暂停。 */
  | { type: 'pause' }
  /** 播放 / 暂停切换。 */
  | { type: 'toggle' }
  /** 下一首。 */
  | { type: 'next' }
  /** 上一首。 */
  | { type: 'prev' }
  /** 定位（**秒**）。 */
  | { type: 'seek'; seconds: number }

// ---------------------------------------------------------------------------
// 播放器状态
// ---------------------------------------------------------------------------

/**
 * 当前曲目的**精简快照**（推给主进程用）。
 *
 * ⚠️ 只保留托盘 / 媒体会话真正需要的字段——**不含**封面字节、不含队列、
 *    更不含任何凭证。
 */
export interface TrackSnapshot {
  /** 歌曲 guid。 */
  id: string
  /** 歌曲名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 专辑名。 */
  album: string
  /** 封面 id；无封面时为空串（与 `Song.coverId` 的约定一致）。 */
  coverId: string
  /** 时长（秒）。 */
  duration: number
}

/**
 * 播放器状态快照（渲染进程 → 主进程）。
 *
 * ⚠️ 这是**精简**形状：不含 `queue`（队列可能有几百首，没有必要跨进程传）。
 */
export interface PlayerStateSnapshot {
  /** 当前曲目；未播放时为 `null`。 */
  current: TrackSnapshot | null
  /** 是否正在播放。 */
  isPlaying: boolean
  /** 播放进度（秒）。 */
  position: number
  /** 当前曲目总时长（秒）。 */
  duration: number
  /** 音量（0~1）。 */
  volume: number
  /** 播放模式。 */
  mode: PlayMode
  /** 是否静音。 */
  muted: boolean
}

// ---------------------------------------------------------------------------
// 桌面悬浮歌词（Task 10）
// ---------------------------------------------------------------------------
//
// ⚠️ **主进程只转发、不解析**歌词内容：它既不渲染也不懂逐字时间，
//    收到就原样转给悬浮窗的渲染进程。故这里的歌词形状是**结构化但宽松**的。

/** 悬浮窗显示的曲目信息。 */
export interface LyricOverlayTrack {
  /** 歌曲 guid。 */
  id: string
  /** 歌曲名。 */
  title: string
  /** 歌手名。 */
  artist: string
}

/**
 * 悬浮窗的一行歌词。
 *
 * ⚠️ 与渲染层的 `LyricLine` **结构完全相同**（可直接赋值），
 *    但这里**独立声明**——`shared/` **不许**依赖 `src/`（层次反了）。
 */
export interface LyricOverlayLine {
  /** 行时间（秒）。 */
  time: number
  /** 行文本。 */
  text: string
  /** 逐字（词级时间，秒）。 */
  words: Array<{ text: string; start: number; end: number }>
  /** 翻译（副行；没有就是空串）。 */
  translation: string
}

/**
 * 悬浮歌词消息（主窗口渲染进程 → 主进程 → 悬浮窗渲染进程）。
 *
 * ⚠️ **判别联合**（`kind` 区分），因为两者的**频率差了两个数量级**：
 * - `track`：**低频**（切歌时一次）——带整份歌词（几十 KB）；
 * - `progress`：**高频**（每次位置更新，~4Hz）——只有两个数字。
 *
 * → 分开是为了**不把整份歌词每秒推 4 次**。
 */
export type LyricOverlayMessage =
  | { kind: 'track'; track: LyricOverlayTrack | null; lines: LyricOverlayLine[] }
  | { kind: 'progress'; position: number; isPlaying: boolean }

// ---------------------------------------------------------------------------
// 偏好
// ---------------------------------------------------------------------------

/**
 * 「关闭窗口」的行为。
 *
 * - `hide`：默认——关闭窗口只是隐藏窗口，**播放继续**（后台续播）；
 * - `quit`：关闭窗口即退出应用。
 */
export type CloseBehavior = 'hide' | 'quit'

/** 窗口位置与尺寸。 */
export interface WindowBounds {
  /** 宽度（像素）。 */
  width: number
  /** 高度（像素）。 */
  height: number
  /** 左上角横坐标（缺省表示「不指定」）。 */
  x?: number
  /** 左上角纵坐标（缺省表示「不指定」）。 */
  y?: number
}

/**
 * 应用偏好（主进程 `prefs.json` 的内容）。
 *
 * ⚠️ **这里只放非敏感偏好**：主题名、窗口位置、「关闭窗口的行为」。
 *    **凭证（token / 密码 / deviceId）一律不许出现在这里**——
 *    那是 `session.bin`（DPAPI 加密）的职责，两者**不许混**。
 */
export interface AppPrefs {
  /** 主题名（Task 18 的双主题会用它）。 */
  theme?: ThemeName
  /** 「关闭窗口」的行为（默认 `hide`：关闭窗口 = 隐藏，播放继续）。 */
  closeBehavior?: CloseBehavior
  /** 上次关闭时的窗口位置与尺寸。 */
  windowBounds?: WindowBounds
  /**
   * 软件 EQ 的偏好（Task 5）。
   *
   * ⚠️ **只有曲线参数**：预置 key / 手动偏移 / 段数 / 开关 / 基线——
   *    里面**没有任何凭证**，与 `session.bin` 无关。
   * ⚠️ 形状定义在 `shared/eqPrefs.ts`（主进程白名单与渲染进程共用一份）。
   */
  eq?: EqPrefsPayload
  /**
   * 桌面悬浮歌词的偏好（Task 10）。
   *
   * ⚠️ **非敏感**：只有「要不要显示」与「窗口在哪儿」——
   *    与 `session.bin`（凭证）**无关**。
   */
  lyricOverlay?: {
    /** 是否显示悬浮窗。 */
    visible: boolean
    /** 悬浮窗的位置与尺寸。 */
    bounds?: WindowBounds
  }
}

// ---------------------------------------------------------------------------
// 桥接口
// ---------------------------------------------------------------------------

/**
 * `window.fnPlayer` 桥接口（渲染进程侧的完整契约）。
 *
 * 与 `window.fn`（认证桥）**并列**、互不重叠：本接口里没有任何一个方法能拿到凭证。
 */
export interface PlayerBridge {
  /**
   * 推送播放器状态到主进程（`player:state`，`ipcRenderer.send`）。
   *
   * 主进程用它更新托盘 tooltip 与托盘图标。
   */
  pushState(state: PlayerStateSnapshot): void
  /**
   * 把播放命令**发给主进程**（`player:command`，`ipcRenderer.send`）。
   *
   * 主进程会把它转发给渲染进程执行（主进程是唯一的命令路由）。
   * 调用方**不要**在本地直接执行同一个命令——否则会执行两遍。
   */
  sendCommand(command: PlayerCommand): void
  /**
   * 订阅主进程下发的播放命令（`player:command`，`webContents.send`）。
   *
   * @returns 取消订阅的函数。
   */
  onCommand(handler: (command: PlayerCommand) => void): () => void
  /** 读取偏好（`prefs:get`）。 */
  getPrefs(): Promise<AppPrefs>
  /** 写入偏好（`prefs:set`）；返回落盘后的完整偏好。 */
  setPrefs(patch: Partial<AppPrefs>): Promise<AppPrefs>
  /** 设置主题（`theme:set`）；写入的是**主进程 `prefs.json`**（主题的单一真相源）。 */
  setTheme(theme: ThemeName): Promise<AppPrefs>
  /** 最小化窗口（`win:minimize`）。 */
  minimize(): Promise<void>
  /** 切换最大化（`win:toggle-maximize`）。 */
  toggleMaximize(): Promise<void>
  /** 关闭窗口（`win:close`；默认只是隐藏，播放继续）。 */
  close(): Promise<void>
  /**
   * 推送悬浮歌词消息（`lyric:state`，`ipcRenderer.send`）。
   *
   * ⚠️ **主窗口渲染进程**用它把「曲目 + 歌词」与「播放进度」推给主进程，
   *    主进程再转给悬浮窗的渲染进程。
   */
  pushLyricState(message: LyricOverlayMessage): void
  /**
   * 订阅悬浮歌词消息（`lyric:state`，`webContents.send`）。
   *
   * ⚠️ **悬浮窗渲染进程**用它接收数据；两种 `kind` 都要处理
   *    （`track` 换歌时来一次，`progress` 高频来）。
   */
  onLyricState(handler: (message: LyricOverlayMessage) => void): () => void
  /**
   * 订阅悬浮窗的**可见性**变化（`lyric:visibility`，`webContents.send`）。
   *
   * ⚠️ **主窗口渲染进程**用它决定「要不要去拉歌词、要不要继续推进度」
   *    （悬浮窗关着时**不多打 NAS**）。
   */
  onLyricVisibility(handler: (visible: boolean) => void): () => void
  /** 设置悬浮窗的可见性（`lyric:set-visible`；主进程据此创建 / 隐藏窗口并落盘）。 */
  setLyricVisible(visible: boolean): Promise<void>
}
