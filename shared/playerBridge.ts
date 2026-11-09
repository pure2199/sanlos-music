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
import type { FfmpegFallbackResult, FfmpegStatus } from './ffmpeg'
import type { ExternalLyricQuery, ExternalLyricResult, LyricPrefs } from './lyricProvider'
import type { PlayMode, StreamQuality, ThemeName } from './types'
import type {
  UpdateCheckResult,
  UpdateDownloadResult,
  UpdateInstallResult,
  UpdatePrefs,
} from './update'

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
  /**
   * 封面 id（T76）。
   *
   * ⚠️ **可选**：老消息 / 经典悬浮窗**不带**这个键；无封面时是**空串**
   *    （与 `Song.coverId` 的既有约定一致）⇒ 调用方一律按「拿不到封面」处理。
   */
  coverId?: string
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
  /**
   * 这一行的**词级时间戳是不是源给的**（**真逐字**）。T81。
   *
   * ⚠️ **可选**、**缺省视为 `true`**（老消息 / 外部构造的行不带这个键 ⇒ 按「有逐字」处理）。
   * ⚠️ `false` ⇒ 词级时间是**插值编造**的 ⇒ 渲染层**不假装逐字**，改走「整行显示」。
   */
  wordTimed?: boolean
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
 * 桌面歌词的**样式**（T45）。
 *
 * - `classic`：经典悬浮歌词窗（可自由拖动，位置会被记住）——**Task 10 的既有形态**；
 * - `island`：灵动态词岛（屏幕顶部居中的胶囊，位置由显示器算出来）。
 *
 * ⚠️ **缺省 = `classic`** → 老用户升级后行为**一字不变**。
 */
export type LyricOverlayMode = 'classic' | 'island'

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
   * 桌面悬浮歌词的偏好（Task 10；T45 加了样式）。
   *
   * ⚠️ **非敏感**：只有「要不要显示」「哪种样式」与「窗口在哪儿」——
   *    与 `session.bin`（凭证）**无关**。
   */
  lyricOverlay?: {
    /** 是否显示悬浮窗。 */
    visible: boolean
    /**
     * 样式（**缺省 = `classic`**）。
     *
     * ⚠️ 只认 `'classic'` / `'island'` 两个值，别的**一律丢弃**
     *    （偏好文件是用户手改也改得动的地方）。
     */
    mode?: LyricOverlayMode
    /**
     * 悬浮窗的位置与尺寸。
     *
     * ⚠️ **只对 `classic` 有意义**：词岛的位置是按显示器**算**出来的，不落盘。
     */
    bounds?: WindowBounds
  }
  /**
   * 下载目录（Task 11）。
   *
   * ⚠️ **绝对路径**；不设 = 用默认的「我的音乐\飞牛音乐」子目录。
   *    非敏感（只是路径），与 `session.bin`（凭证）无关。
   */
  downloadDir?: string
  /**
   * 本地优先播放（Task 11）：本地有副本就播本地。
   *
   * ⚠️ **默认开启**（`undefined` 视为 `true`）。
   */
  localFirst?: boolean
  /**
   * 播放模式（T29）：上次退出时用的那个（顺序 / 随机 / 单曲循环 / 列表循环）。
   *
   * ⚠️ **非敏感**：就是一个模式名，与 `session.bin`（凭证）**无关**。
   * ⚠️ **只有合法值才落盘**（主进程白名单）：`prefs.json` 是用户可编辑的文件，
   *    写进去的陌生值一律丢弃 → 读回来时按「顺序播放」处理。
   */
  playMode?: PlayMode
  /**
   * 音质偏好（T54）：`original`（原始音质）/ `standard`（标准音质，服务端转码）。
   *
   * ⚠️ **非敏感**：就是一个档位名，与 `session.bin`（凭证）**无关**。
   * ⚠️ **缺省 = `original`** → 老用户升级后行为**一字不变**。
   * ⚠️ **只有合法值才落盘**（主进程白名单）：`prefs.json` 是用户可编辑的文件，
   *    写进去的陌生值一律丢弃 → 读回来时按「原始音质」处理。
   */
  streamQuality?: StreamQuality
  /**
   * 自动更新的偏好（Task 23）。
   *
   * ⚠️ **非敏感**：更新服务器地址与预期签名者主体名都是公开信息，
   *    与 `session.bin`（凭证）**无关**。
   */
  update?: UpdatePrefs
  /**
   * 外部歌词源的偏好（Task 32）。
   *
   * ⚠️ **非敏感**：只是「用哪个源」与「自定义 URL 模板」，都是公开信息，
   *    与 `session.bin`（凭证）**无关**。
   * ⚠️ **只有合法值才落盘**（主进程白名单）：`prefs.json` 是用户可编辑的文件，
   *    写进去的陌生值一律丢弃。
   */
  lyric?: LyricPrefs
}

// ---------------------------------------------------------------------------
// 下载（Task 11）
// ---------------------------------------------------------------------------

/**
 * 下载任务的状态。
 *
 * - `pending`：已排队，**还没开始**；
 * - `running`：正在下载；
 * - `done`：已完成（文件已落到下载目录）；
 * - `error`：失败（`error` 里有可读原因）；
 * - `canceled`：被用户取消。
 */
export type DownloadStatus = 'pending' | 'running' | 'done' | 'error' | 'canceled'

/**
 * 一首歌的下载请求（渲染进程 → 主进程）。
 *
 * ⚠️ **只带拼文件名要用的元数据**：文件名由主进程清洗后生成，
 *    渲染进程**不能**指定落盘路径（那是主进程的职责）。
 */
export interface DownloadRequest {
  /** 歌曲 guid。 */
  songId: string
  /** 歌名（拼文件名用）。 */
  title: string
  /** 歌手名（拼文件名用）。 */
  artist: string
  /** 文件扩展名（不含点，如 `flac`）。 */
  ext: string
}

/** 已下载完成的一首歌（主进程索引里的一条）。 */
export interface DownloadEntry {
  /** 歌曲 guid。 */
  songId: string
  /** 本地绝对路径。 */
  file: string
  /** 文件字节数。 */
  bytes: number
  /** 扩展名（不含点）。 */
  ext: string
  /** 下载完成时间（ISO 8601 字符串）。 */
  downloadedAt: string
  /**
   * 歌名快照（T38）。
   *
   * ⚠️ **可选**：只有本次升级后下载的条目才有；
   *    老条目没有 → 渲染层用**文件名反推**兜底（近似值）。
   */
  title?: string
  /**
   * 歌手快照（T38）。
   *
   * ⚠️ **可选**：理由同 `title`。
   */
  artist?: string
  /**
   * 时长（**秒**，T39）。
   *
   * ⚠️ **可选**：来自下载文件的**内嵌标签**；读不到 → **缺省**（= 未知）。
   */
  duration?: number
  /**
   * 专辑名（T39）。
   *
   * ⚠️ **可选**：来自下载文件的**内嵌标签**；读不到 → **缺省**。
   */
  album?: string
}

/** 下载任务（进度用；主进程 → 渲染进程推送）。 */
export interface DownloadTask {
  /** 歌曲 guid。 */
  songId: string
  /** 歌名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 当前状态。 */
  status: DownloadStatus
  /** 已下载字节数。 */
  received: number
  /** 总字节数（`0` = 未知）。 */
  total: number
  /** 失败原因（可读文案，**不含任何凭证**）。 */
  error: string | null
  /** 完成后的本地绝对路径（未完成时为 `null`）。 */
  file: string | null
}

// ---------------------------------------------------------------------------
// 本地曲目（T38）
// ---------------------------------------------------------------------------

/**
 * 本地曲目（主进程「本地曲目登记表」里的一条）。
 *
 * ⚠️ **明文但非敏感**：只有绝对路径、歌名、歌手、大小——**没有**任何凭证。
 */
export interface LocalLibraryItem {
  /** 曲目 id（`local:<hash>`；**只当索引键**用）。 */
  id: string
  /** 本地绝对路径。 */
  path: string
  /**
   * 歌名。
   *
   * ⚠️ **来源可能是标签，也可能是文件名反推**（近似值）→ 看 `tagSource`。
   */
  title: string
  /**
   * 歌手名（**可能为空串**）。
   *
   * ⚠️ **来源同 `title`**。
   */
  artist: string
  /** 文件字节数。 */
  size: number
  /** 扩展名（不含点，小写）。 */
  ext: string
  /** 加入时间（ISO 8601 字符串）。 */
  addedAt: string
  /**
   * 专辑名（T39）。
   *
   * ⚠️ **可选**：来自文件内嵌标签；没有标签 / 没读到 → **缺省**。
   */
  album?: string
  /**
   * 时长（**秒**，T39）。
   *
   * ⚠️ **可选**：来自文件内嵌标签；读不到 → **缺省**（= 未知）。
   * ⚠️ 播放后仍以**媒体元素实测时长**为准（这里只是播放前的初值）。
   */
  duration?: number
  /**
   * 歌名 / 歌手的来源（T39）。
   *
   * - `'tag'`：至少有一个字段来自文件内嵌标签；
   * - `'name'`：全部来自**文件名反推**（近似值）；
   * - **缺省**：**还没解析过**（后台正在读标签）。
   */
  tagSource?: 'tag' | 'name'
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
   * 用**系统默认浏览器**打开一个外部链接（`app:open-external`）。
   *
   * ⚠️ **白名单在主进程那一侧**（`shared/appInfo.ts` 的 `isAllowedExternalUrl`）：
   *    只允许 `https` + 白名单域名 → 渲染层给什么 URL 都开不了别的站点。
   * @returns 是否真的打开了。
   */
  openExternal(url: string): Promise<boolean>
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
  /**
   * 切换桌面歌词的**样式**（`lyric:set-mode`；主进程据此换成对应的窗口并落盘）。
   *
   * ⚠️ T45：两种形态**互斥** —— 切过去时另一种会收起。
   */
  setLyricMode(mode: LyricOverlayMode): Promise<void>
  /**
   * 订阅桌面歌词样式的变化（`lyric:mode`，`webContents.send`）。
   *
   * ⚠️ **主窗口渲染进程**用它同步自己知道的样子（例：词岛模式下不再走经典窗的老路）。
   */
  onLyricMode(handler: (mode: LyricOverlayMode) => void): () => void
  /**
   * 订阅「指针是否落在词岛上」（`lyric:pointer`，`webContents.send`）。
   *
   * ⚠️ T46：词岛是**点击穿透**的（不挡屏幕顶部的应用）→ 忽略鼠标事件之后，
   *    渲染进程**收不到「鼠标离开」**（实测：指针移出后 0 个 mousemove）
   *    → 「移出后恢复显示」只能由**主进程轮询**指针位置，变化时从这里通知。
   */
  onLyricPointer(handler: (inside: boolean) => void): () => void
  // -------------------------------------------------------------------------
  // 频谱（T47）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **一条频谱 = 8 个 0–255 的整数**（`number[]`）：低频稀、高频密，
  //    每段取区间最大值。**纯数字**，不含任何凭证或曲目信息。
  //    ⚠️ 词岛把它**左右各 8 根**画出来（右组是左组的**镜像**）。
  //
  // ⚠️ **主窗口渲染进程推**（它才有 `<audio>` 与 `AnalyserNode`），
  //    **词岛渲染进程收**（它只负责显示）。
  /**
   * 推送频谱数据（`lyric:spectrum`，`ipcRenderer.send`）。
   *
   * ⚠️ **主窗口渲染进程**用它把频谱推给主进程 → 再转发给词岛窗。
   */
  pushSpectrum(bins: number[]): void
  /**
   * 订阅频谱数据（`lyric:spectrum`，`webContents.send`）。
   *
   * ⚠️ **词岛渲染进程**用它接收数据；**经典悬浮窗不订阅**
   *    （经典窗的显示内容**一字不变**）。
   */
  onSpectrum(handler: (bins: number[]) => void): () => void
  // -------------------------------------------------------------------------
  // 下载（Task 11）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 渲染进程**只发请求**、**只收进度**：
  //    落盘路径、文件名清洗、断点续传**全在主进程**；
  //    渲染进程既不能指定落盘路径，也拿不到任何凭证。
  /** 读本地下载索引 + 当前任务 + 下载目录（`download:list`）。 */
  listDownloads(): Promise<{
    entries: Record<string, DownloadEntry>
    tasks: DownloadTask[]
    /** 当前下载目录（绝对路径）。 */
    dir: string
  }>
  /** 开始下载一首歌（`download:start`）。 */
  startDownload(request: DownloadRequest): Promise<void>
  /** 取消下载（`download:cancel`）。 */
  cancelDownload(songId: string): Promise<void>
  /** 清空本地下载（删文件 + 清索引，`download:clear`）。 */
  clearDownloads(): Promise<void>
  /** 订阅下载任务变化（`download:changed`，主进程推送）。 */
  onDownloadChange(handler: (tasks: DownloadTask[]) => void): () => void
  // -------------------------------------------------------------------------
  // 本地曲目（T38）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 渲染进程**不碰文件系统**：它只能
  //    ① 让主进程弹对话框选文件 / 文件夹；
  //    ② 把**选中的路径**交给主进程登记；
  //    ③ 拿到登记好的曲目清单。
  //
  // ⚠️ **登记的门槛在主进程**：路径必须**真实存在**、是**文件**、
  //    扩展名在**白名单**里 → 渲染进程给不出「任意路径」。
  /** 读本地曲目清单（`local:list`）。 */
  listLocalTracks(): Promise<LocalLibraryItem[]>
  /**
   * 弹**文件**选择对话框（`local:pick-files`，可多选）。
   *
   * @returns 选中的绝对路径；用户取消 → **空数组**。
   */
  pickLocalFiles(): Promise<string[]>
  /**
   * 弹**文件夹**选择对话框（`local:pick-folder`）。
   *
   * @returns 选中的目录绝对路径；用户取消 → **空串**。
   */
  pickLocalFolder(): Promise<string>
  /**
   * 登记这些路径（`local:add`）——主进程会**逐个校验**再登记。
   *
   * @param paths 绝对路径数组（可以为空）。
   */
  addLocalTracks(paths: string[]): Promise<LocalLibraryItem[]>
  /**
   * 递归扫描这个目录并登记（`local:add-folder`）。
   *
   * @param folder 目录绝对路径。
   */
  addLocalFolder(folder: string): Promise<LocalLibraryItem[]>
  /**
   * 从清单里移除一项（`local:remove`）。
   *
   * ⚠️ **只改清单，绝不删用户的音乐文件**。
   *
   * @param id 曲目 id。
   */
  removeLocalTrack(id: string): Promise<LocalLibraryItem[]>
  /**
   * 订阅**清单变化**（`local:changed`，主进程 → 渲染进程）。
   *
   * ⚠️ **只推变化的那几条**（T39 的后台标签解析会分批推）。
   *
   * @returns 取消订阅的函数。
   */
  onLocalChanged(handler: (items: LocalLibraryItem[]) => void): () => void
  // -------------------------------------------------------------------------
  // FFmpeg 兜底解码（Task 12）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 渲染进程**只说「给这首歌兜底一下」**，**不能指定路径**：
  //    本地文件的定位、转码、临时产物的存放**全在主进程**。
  /** 读 FFmpeg 探测结果（`ffmpeg:status`）：本机有没有可用的 FFmpeg。 */
  ffmpegStatus(): Promise<FfmpegStatus>
  /**
   * 请求兜底解码（`ffmpeg:fallback`）：把这首歌的**本地副本**转码成
   * Chromium 能解的格式。
   *
   * @param songId 歌曲 guid（**只当索引键**）。
   * @returns 成功时带可播放的**本地地址**；失败时带**可判别**的 `reason`。
   */
  ffmpegFallback(songId: string): Promise<FfmpegFallbackResult>
  // -------------------------------------------------------------------------
  // 自动更新（Task 23）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **渲染层只发请求、只收结果**：检查 / 下载 / 启动**全在主进程**——
  //    渲染层既不碰网络，也**不能指定要装哪个路径**（只报**文件名**）。
  //
  // ⚠️ 这三个方法**都不返回任何凭证**。
  /** 检查更新（`update:check`）：拉清单、比版本。 */
  checkUpdate(): Promise<UpdateCheckResult>
  /**
   * 下载安装包（`update:download`）。
   *
   * @param name 清单里的**文件名**（主进程会用自己缓存的清单项下载）。
   */
  downloadUpdate(name: string): Promise<UpdateDownloadResult>
  /**
   * 启动安装器（`update:install`）。
   *
   * @param name 已下载的**文件名**（主进程拼到下载目录下面，并复查签名）。
   */
  installUpdate(name: string): Promise<UpdateInstallResult>
  // -------------------------------------------------------------------------
  // 外部歌词（Task 32）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **渲染层只发请求、只收结果**：外部歌词的**抓取全在主进程**——
  //    渲染层既不碰网络，也**不能指定要抓哪个地址**（只报歌名 / 歌手 / 专辑 / 时长）。
  //
  // ⚠️ 这个方法**不返回任何凭证**（只回 LRC 文本）。
  /**
   * 查外部歌词（`lyric:fetch`）：NAS 没有歌词时**补一份**。
   *
   * @param query 歌名 / 歌手 / 专辑 / 时长（**只当匹配线索**，不是地址）。
   */
  fetchExternalLyric(query: ExternalLyricQuery): Promise<ExternalLyricResult>
}
