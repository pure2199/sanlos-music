import { app, BrowserWindow, Menu, session as electronSession } from 'electron'
import path from 'node:path'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

import type { LyricOverlayMessage, PlayerCommand, PlayerStateSnapshot } from '../shared/playerBridge'
import type { ThemeName } from '../shared/types'
import { API_PREFIX } from '../shared/constants'
import { resolveThemeName, themeSpec } from '../shared/themes'
import { registerAuthIpc, registerPlayerIpc, registerUpdateIpc, registerLyricIpc, PrefsStore } from './ipc'
import { TrustedHosts } from './cert'
import {
  DEFAULT_DOWNLOAD_SUBDIR,
  DOWNLOAD_INDEX_FILE_NAME,
  DOWNLOAD_INDEX_VERSION,
  DownloadManager,
  type DownloadIndex,
} from './downloadManager'
import { createHttpStack } from './http'
import { attachAppShortcuts } from './appShortcuts'
import { createLyricProvider } from './lyricProvider'
import { registerLocalMedia } from './localMedia'
import { LOCAL_LIBRARY_FILE_NAME, LocalLibrary, readFileBytes, registerLocalLibraryIpc } from './localLibrary'
import { registerAppSchemes } from './schemes'
import { FallbackTranscoder } from './fallbackTranscoder'
import { createNasOAuthHandlers } from './oauthWindow'
import { buildUpstreamRequest, registerProxy } from './proxy'
import { SessionManager } from './session'
import { createCoverFetcher, createTray } from './tray'
import { createBoundsSaver, resolveWindowBounds } from './windowBounds'
import { createUpdateController } from './update'

// dev 模式由 VITE_DEV_SERVER_URL 指向 vite dev server；
// 生产模式（npm start / 打包后的应用）加载随包发布的 dist/index.html。
const devServerUrl = process.env.VITE_DEV_SERVER_URL

// ---------------------------------------------------------------------------
// 桌面悬浮歌词窗口（Task 10）
// ---------------------------------------------------------------------------

/** 悬浮窗的默认宽度（像素）。 */
const LYRIC_WINDOW_WIDTH = 560
/** 悬浮窗的默认高度（像素）。 */
const LYRIC_WINDOW_HEIGHT = 200

// ---------------------------------------------------------------------------
// 进程级状态（托盘 / 单实例 / 关闭拦截都要用）
// ---------------------------------------------------------------------------

/** 主窗口（`second-instance` 与托盘都要用它）。 */
let mainWindow: BrowserWindow | null = null

/**
 * 「正在退出」标志。
 *
 * ⚠️ **关闭窗口被拦截后 `app.on('window-all-closed')` 永远不触发** → 应用会常驻
 *    （这是**预期**行为：后台续播）。真正退出只能走托盘菜单的「退出」，
 *    退出前先把本标志置位，让 `close` 处理器不再拦截。
 */
let isQuitting = false

/** 主进程缓存的播放器状态（托盘 tooltip / 图标用）。 */
let currentPlayerState: PlayerStateSnapshot | null = null

/**
 * 桌面悬浮歌词窗口（Task 10）。
 *
 * ⚠️ **播放只有一个 `<audio>`**（在主窗口的渲染进程里）——
 *    悬浮窗**只负责显示**，绝不自己播音频（否则双解码 + 双倍流量 + 同步地狱）。
 */
let lyricWindow: BrowserWindow | null = null

/** 悬浮窗当前是否可见（主进程侧的状态；与 `prefs.lyricOverlay.visible` 同步）。 */
let lyricVisible = false

/**
 * 主进程缓存的**最后一条**悬浮歌词消息。
 *
 * ⚠️ 悬浮窗**刚创建**时，渲染进程可能还没推过消息 →
 *    页面加载完成后把这条缓存补给它（否则它要等到下一次切歌才有内容）。
 */
let lastLyricMessage: LyricOverlayMessage | null = null

/** 调出主窗口（托盘左键、单实例 `second-instance`、IPC `win:*` 都走它）。 */
function showMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------------------------------------------------------------------------
// 接线顺序（**顺序本身就是正确性的一部分**）
// ---------------------------------------------------------------------------
//
// 1. **在 `app.whenReady()` 之前**注册**全部**自定义 scheme 的特权——
//    Electron 的 `registerSchemesAsPrivileged()` **整个进程只能调用一次**，
//    第二次会**静默覆盖**第一次的注册结果 → 所以 `fnm` 与 `fnml`
//    **必须合并成一次**注册（见 `electron/schemes.ts` 的详细说明）。
registerAppSchemes()

// 2. **单实例锁**（**尽早调用**，`app.whenReady()` 之前即可）。
//
//    第二个实例直接退出；首个实例收到 `second-instance` 时把已有窗口调出来。
//    ⚠️ Task 23 的 E2E 若要「连启两次」，会被这道锁拦掉——那是既定行为。
const isPrimaryInstance = app.requestSingleInstanceLock()

if (!isPrimaryInstance) {
  // 不是首个实例：立刻退出（不建窗口、不建托盘）。
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app
    .whenReady()
    .then(() => {
      // 3. ready 之后才创建会话管理器：`safeStorage` 与 `app.getPath('userData')`
      //    在 ready 之前都不可用。
      //
      //    受信 host 集合：**只**放行「用户填过的服务器 host」与
      //    「由 FN ID 推导出来的中继域名」。同一个实例要同时交给
      //    `registerAuthIpc`（登录 / 探测时登记）与证书校验回调（放行判定）。
      const trusted = new TrustedHosts()

      // 4. 出网通道（Task 9b）：**Chromium 分区栈**。
      //
      //    主进程对 NAS 的流量（会话层 / 探测 / 代理 / server-info / 托盘封面）
      //    全部走它，而不是 Node 的全局 `fetch`（undici）——只有 Chromium 栈才受
      //    `setCertificateVerifyProc` 管辖，「只放行用户填写的 host」才真正生效。
      //    分区名带信任版本号（`fn-nas-v<epoch>`）：信任集合一变就换分区，
      //    绕开旧分区里缓存的证书错误（规格 §15.9 的实测结论）。
      //
      //    ⚠️ 会话层 / 代理层 / 认证 IPC / **托盘封面**必须共用**同一个**实例，
      //    否则各层的信任版本号各走各的。
      const http = createHttpStack({ trusted })

      const session = new SessionManager({ http })

      // 5. `fnm://` 协议代理（渲染进程唯一的出网出口）。
      registerProxy(session, { http })

      // 6. NAS 账号 OAuth（Task 11）：授权窗口 + 静默续期。
      //
      //    ⚠️ **必须注入同一个 `HttpStack` 实例**（追加要求 F）：
      //    `createHttpStack()` 不传 `trusted` 时会内部 new 一个**空**信任集合，
      //    自签 NAS 直接连不上且极难排查。
      //    ⚠️ `trusted` 也必须是同一个实例：授权分区上的证书放行要用同一份信任集合。
      const { nasLoginHandler, nasReloginHandler } = createNasOAuthHandlers({
        session,
        http,
        trusted,
      })

      //    静默续期（Task 7 的 `setNasRelogin` 契约）：返回新 token，空串 = 失败。
      session.setNasRelogin(nasReloginHandler)

      // 7. 认证 IPC（渲染进程的登录页通过 `window.fn` 调用）。
      registerAuthIpc(session, { trusted, http, nasLoginHandler })

      // 8. 证书放行：**只**对 `trusted` 里的 host 放行自签 / 非受信证书。
      //    ⚠️ 绝不无条件 `callback(0)`——未登记的 host 一律走 Chromium 默认校验
      //    （`verify` 返回 `-3`），其余站点照常校验。
      //    ⚠️ `session` 这个名字已被会话管理器占用，故 Electron 的 session 模块取别名。
      //    （分区 session 上的 verify proc 由 `HttpStack` 自己注册；
      //    这里额外给 defaultSession 也挂一份，覆盖渲染进程自己发起的请求。）
      electronSession.defaultSession.setCertificateVerifyProc((request, callback) => {
        callback(trusted.verify(request.hostname))
      })

      // 9. 恢复上次会话（Task 7 的生命周期约定：启动时 `load()`）。
      //    失败（文件不存在 / 损坏 / 解密失败）不影响启动，界面会显示未登录。
      session.load()

      // 10. 偏好（`<userData>/prefs.json`）：**只有非敏感偏好**，
      //     凭证在 `session.bin` 里，两者**不许混**。
      const prefs = new PrefsStore()

      // 10b. 主题（Task 6）与窗口位置尺寸记忆（Task 8）。
      //
      //     ⚠️ 主题：渲染进程的 CSS 会接管窗口内容，但**窗口本身**在页面加载完成前
      //        是一块默认底色 → 这里先按主题铺上，避免「白闪」。
      //        真相源是 `prefs.json`（`prefs.read().theme`），这里只是**应用**它。
      //     ⚠️ 窗口尺寸：审计报表 G-1——`AppPrefs.windowBounds` 早就有，
      //        主进程却**从不消费** → 尺寸记忆形同虚设。
      //        逻辑放在 `electron/windowBounds.ts`（可单测），这里只做接线。
      const boundsOptions = resolveWindowBounds(prefs.read().windowBounds, {
        width: 1200,
        height: 800,
      })

      // 2b. **去掉默认菜单栏**（T36）。
      //
      //     ⚠️ Windows 上 Electron 会自动挂一排默认菜单（File / Edit / View /
      //        Window / Help）→ 看起来像"没做完的开发工具"，不像一个**完整软件**。
      //     ⇒ 应用菜单置空（**全局**：主窗口 / 悬浮歌词窗 / 授权窗一起生效）。
      //
      //     ⚠️ **代价**：默认菜单同时绑着**编辑快捷键**（Ctrl+C / Ctrl+V）→
      //     菜单一去掉，**粘贴就没了** → 用 `attachClipboardShortcuts()` 手工接回来
      //     （见 `electron/editShortcuts.ts`）。
      Menu.setApplicationMenu(null)

      const win = new BrowserWindow({
        width: boundsOptions.width,
        height: boundsOptions.height,
        x: boundsOptions.x,
        y: boundsOptions.y,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      })
      mainWindow = win

      // ⚠️ T36：菜单栏没了 → **Ctrl+V 粘贴 / F12 开发者工具**得自己接回来
      //    （否则登录框粘不了口令、调试也打不开控制台）。
      attachAppShortcuts(win.webContents)

      /** 按主题设置窗口底色（避免启动 / 切主题瞬间的白闪）。 */
      const applyWindowTheme = (theme: ThemeName): void => {
        if (win.isDestroyed()) return
        win.setBackgroundColor(themeSpec(theme).windowBackground)
      }
      applyWindowTheme(resolveThemeName(prefs.read().theme))

      // 位置尺寸记忆：移动 / 缩放后去抖写回偏好（写盘是同步的，不去抖会每帧写盘）。
      const boundsSaver = createBoundsSaver({
        getBounds: () => (win.isDestroyed() ? null : win.getBounds()),
        save: (bounds) => {
          prefs.write({ windowBounds: bounds })
        },
      })
      win.on('resize', () => boundsSaver.schedule())
      win.on('move', () => boundsSaver.schedule())

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`[fnmusic] 页面加载失败: ${errorCode} ${errorDescription} (${validatedURL})`)
      })

      // 11. **关闭窗口 = 隐藏，播放继续**（Task 17 的核心用户体验）。
      //
      //     默认 `preventDefault()` + `hide()`；偏好里选了「直接退出」才真退出。
      win.on('close', (event) => {
        // 关闭前先把位置尺寸落盘（用户可能刚拖动过窗口）。
        boundsSaver.saveNow()
        if (isQuitting) return
        if (prefs.read().closeBehavior === 'quit') {
          isQuitting = true
          app.quit()
          return
        }
        event.preventDefault()
        win.hide()
      })

      if (devServerUrl) {
        win.loadURL(devServerUrl).catch((err: unknown) => {
          console.error(`[fnmusic] dev server 加载失败 (${devServerUrl}):`, err)
        })
      } else {
        // __dirname = resources/app/dist-electron，故 ../dist/index.html 即随包发布的渲染进程入口
        const indexPath = path.join(__dirname, '../dist/index.html')
        win.loadFile(indexPath).catch((err: unknown) => {
          console.error(`[fnmusic] 生产页面加载失败 (${indexPath}):`, err)
        })
      }

      win.once('ready-to-show', () => win.show())

      // 11b. 本地下载（Task 11）。
      //
      //     ⚠️ **下载在主进程**：渲染进程不能写盘、也不该让几十 MB 的音频
      //        在渲染进程里过一遍内存；更要紧的是**凭证只在主进程**——
      //        下载请求的 `authx` 与 Cookie 由主进程拼，渲染进程全程不参与。
      //     ⚠️ 下载**复用同一个 `HttpStack`**：自签证书放行、中继 `mode=relay`
      //        Cookie 全部继承既有链路，不新造出网通道。
      const downloadIndexPath = path.join(app.getPath('userData'), DOWNLOAD_INDEX_FILE_NAME)

      /** 读下载索引（`<userData>/downloads.json`）。 */
      const readDownloadIndex = (): DownloadIndex => {
        try {
          const raw = readFileSync(downloadIndexPath, 'utf8')
          const parsed = JSON.parse(raw) as Partial<DownloadIndex>
          const entries = parsed?.entries
          if (!entries || typeof entries !== 'object') {
            return { version: DOWNLOAD_INDEX_VERSION, entries: {} }
          }
          return { version: DOWNLOAD_INDEX_VERSION, entries: entries as DownloadIndex['entries'] }
        } catch {
          // 文件不存在 / 损坏 → 当作没有索引（**不抛**）。
          return { version: DOWNLOAD_INDEX_VERSION, entries: {} }
        }
      }

      /** 写下载索引（原子写：先 `.tmp` 再改名）。 */
      const writeDownloadIndex = (index: DownloadIndex): void => {
        const tmpPath = `${downloadIndexPath}.tmp`
        try {
          mkdirSync(path.dirname(downloadIndexPath), { recursive: true })
          writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8')
          renameSync(tmpPath, downloadIndexPath)
        } catch {
          // 半成品临时文件不能留下。
          try {
            rmSync(tmpPath, { force: true })
          } catch {
            // 清理失败不掩盖原始错误。
          }
        }
      }

      /**
       * 下载目录：优先用用户设置的（`prefs.downloadDir`），
       * 否则用「我的音乐\飞牛音乐」子目录。
       */
      const resolveDownloadDir = (): string => {
        const override = prefs.read().downloadDir
        if (typeof override === 'string' && override.trim().length > 0) return override
        let base = ''
        try {
          base = app.getPath('music')
        } catch {
          base = ''
        }
        if (base.length === 0) {
          try {
            base = app.getPath('userData')
          } catch {
            base = process.cwd()
          }
        }
        return path.join(base, DEFAULT_DOWNLOAD_SUBDIR)
      }

      /**
       * 取音频流（**主进程拼签名与凭证**）。
       *
       * @param rangeStart 断点续传起点（`0` = 从头）。
       */
      const fetchDownloadStream = async (
        songId: string,
        rangeStart: number,
      ): Promise<Response> => {
        const base = session.state.base
        const token = session.state.token
        if (!base || !token) {
          throw new Error('尚未登录或未连接服务器')
        }
        const url = `${base}${API_PREFIX}/track/stream?guid=${encodeURIComponent(songId)}`
        const headers = new Headers()
        if (rangeStart > 0) headers.set('range', `bytes=${rangeStart}-`)
        const request = buildUpstreamRequest(
          { method: 'GET', url, headers },
          token,
          session.state.isRelay,
        )
        return await http.fetch(request)
      }

      const downloads = new DownloadManager({
        fetchStream: fetchDownloadStream,
        getDownloadDir: resolveDownloadDir,
        readIndex: readDownloadIndex,
        writeIndex: writeDownloadIndex,
        // ⚠️ T39：读下载文件头的**内嵌标签** → 时长 / 专辑。
        readBytes: readFileBytes,
        onChange: (tasks) => {
          if (win.isDestroyed()) return
          win.webContents.send('download:changed', tasks)
        },
      })

      // `fnml://` 协议：把已下载的文件交给渲染进程的 `<audio>` 播放。
      // ⚠️ 路径**只**来自下载索引（已落盘的记录），渲染进程碰不到文件系统。
      //
      // 11c. FFmpeg 兜底解码（Task 12）。
      //
      //     不可解格式（APE / ALAC / DSF …）→ 用本机的 FFmpeg 把**本地副本**
      //     转码成 Opus，再交给渲染进程播。
      //     ⚠️ 产物走**同一个** `fnml://local/track/<id>` 路由（**不新增路由种类**）：
      //        lookup 改成「**临时产物优先 → 下载索引**」。
      //     ⚠️ 产物在**临时目录**里、**单槽**、**不进**下载索引、**不污染**下载目录；
      //        退出应用时清掉整个临时目录。
      // 11d. 本地曲目登记表（T38）。
      //
      //     ⚠️ **用户自己加进来的本地文件**也走**同一条** `fnml://` 路由——
      //        渲染进程**只能给一个 id**（`local:<hash>`），路径**只**来自登记表
      //        → **不新增路由种类 = 不放宽任何安全边界**。
      //
      // ⚠️ **必须先于 `fallback` 建**：兜底转码的查找链要用到它。
      const localLibrary = new LocalLibrary({
        filePath: path.join(app.getPath('userData'), LOCAL_LIBRARY_FILE_NAME),
        // ⚠️ T39：后台解析完一批标签就推一批给渲染层（**只推变化的那几条**）。
        onChanged: (items) => {
          if (win.isDestroyed()) return
          win.webContents.send('local:changed', items)
        },
      })
      // ⚠️ T39：启动后**后台补齐**老条目的标签
      //    （老清单里只有文件名反推的近似值 → 读完标签就变精确）。
      void localLibrary
        .load()
        .then(() => localLibrary.parsePending())
        .catch(() => undefined)

      const fallback = new FallbackTranscoder({
        // ⚠️ T38：**本地曲目也要能被兜底转码**（FLAC / APE 等 Chromium 播不了的格式）
        //    → 查找链是「下载索引 → 本地曲目登记表」。
        lookupLocal: (songId) => downloads.localPath(songId) ?? localLibrary.localPath(songId),
        tempDir: path.join(app.getPath('userData'), 'fallback'),
      })

      registerLocalMedia({
        lookup: (songId) =>
          fallback.lookup(songId) ?? downloads.localPath(songId) ?? localLibrary.localPath(songId),
      })

      // 12. 托盘（Task 17）。
      //
      //     封面字节由主进程自己取（**同一个 `HttpStack` 实例**），
      //     按 `coverId` 缓存（有上界），**异步**取——**不阻塞**托盘创建。
      const cover = createCoverFetcher({ http, session })
      const tray = createTray({
        cover,
        getState: () => currentPlayerState,
        // 托盘菜单 → 主进程 → 渲染进程执行（主进程是唯一的命令路由）。
        sendCommand: (command: PlayerCommand) => {
          win.webContents.send('player:command', command)
        },
        showWindow: showMainWindow,
        // 桌面悬浮歌词（Task 10）：开 / 关切换（窗口由主进程管）。
        toggleLyricOverlay: () => {
          setLyricVisible(!lyricVisible)
        },
        quit: () => {
          isQuitting = true
          app.quit()
        },
      })

      // 12b. 桌面悬浮歌词窗口（Task 10）。
      //
      //     ⚠️ **窗口归主进程管**（创建 / 显示 / 隐藏 / 位置尺寸记忆）；
      //     ⚠️ **内容归渲染进程管**（主窗口推数据 → 主进程转发 → 悬浮窗渲染）。
      //     ⚠️ 悬浮窗**不碰音频**：播放只有一个 `<audio>`（在主窗口里）。
      const createLyricWindow = (): BrowserWindow | null => {
        if (lyricWindow && !lyricWindow.isDestroyed()) return lyricWindow

        const saved = prefs.read().lyricOverlay?.bounds
        const win = new BrowserWindow({
          width: saved?.width ?? LYRIC_WINDOW_WIDTH,
          height: saved?.height ?? LYRIC_WINDOW_HEIGHT,
          x: saved?.x,
          y: saved?.y,
          show: false,
          // 悬浮窗：无边框 + 透明 + 不进任务栏 + 不可缩放。
          frame: false,
          transparent: true,
          resizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          hasShadow: false,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        })
        // 置顶到最高级（'screen-saver'）：连全屏应用都压得住它。
        win.setAlwaysOnTop(true, 'screen-saver')
        // 所有工作区都可见（含全屏）。
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        lyricWindow = win

        // ⚠️ T36：菜单栏没了 → **Ctrl+C / Ctrl+V** 自己接回来（悬浮歌词也可复制）。
        attachAppShortcuts(win.webContents)

        // 位置尺寸记忆（与主窗口同一套机制：`electron/windowBounds.ts`）。
        const lyricBoundsSaver = createBoundsSaver({
          getBounds: () => (win.isDestroyed() ? null : win.getBounds()),
          save: (bounds) => {
            prefs.write({ lyricOverlay: { visible: lyricVisible, bounds } })
          },
        })
        win.on('resize', () => lyricBoundsSaver.schedule())
        win.on('move', () => lyricBoundsSaver.schedule())
        win.on('closed', () => {
          lyricBoundsSaver.saveNow()
          lyricWindow = null
        })

        // 页面加载完成 → 把缓存的消息补给它（否则要等到下一次切歌才有内容）。
        win.webContents.on('did-finish-load', () => {
          if (lastLyricMessage) {
            win.webContents.send('lyric:state', lastLyricMessage)
          }
        })

        if (devServerUrl) {
          const url = `${devServerUrl.replace(/\/$/, '')}/lyric.html`
          win.loadURL(url).catch((err: unknown) => {
            console.error(`[fnmusic] 悬浮歌词页面加载失败 (${url}):`, err)
          })
        } else {
          const lyricPath = path.join(__dirname, '../dist/lyric.html')
          win.loadFile(lyricPath).catch((err: unknown) => {
            console.error(`[fnmusic] 悬浮歌词页面加载失败 (${lyricPath}):`, err)
          })
        }
        return win
      }

      /** 显示 / 隐藏悬浮窗（落盘 + 通知主窗口渲染进程）。 */
      const setLyricVisible = (visible: boolean): void => {
        lyricVisible = visible
        if (visible) {
          createLyricWindow()?.show()
        } else {
          lyricWindow?.hide()
        }
        // 落盘（下次启动恢复）：可见性 + 当前（或上次记住的）位置尺寸。
        const live = lyricWindow && !lyricWindow.isDestroyed() ? lyricWindow.getBounds() : null
        const previous = prefs.read().lyricOverlay?.bounds
        const bounds = live
          ? { width: live.width, height: live.height, x: live.x, y: live.y }
          : previous
        prefs.write({ lyricOverlay: bounds ? { visible, bounds } : { visible } })
        // 通知主窗口渲染进程：它据此决定要不要拉歌词、要不要继续推进度。
        if (!win.isDestroyed()) win.webContents.send('lyric:visibility', visible)
      }

      // 13. 播放器 / 窗口 / 偏好 IPC（Task 17）。
      //
      //     `player:state`（渲染进程推来）→ 更新托盘；
      //     `player:command`（渲染进程推来）→ **转发**回渲染进程执行。
      registerPlayerIpc({
        prefs,
        getTarget: () => (win.isDestroyed() ? null : win.webContents),
        getWindow: () => (win.isDestroyed() ? null : win),
        onPlayerState: (state) => {
          currentPlayerState = state
          tray.update(state)
        },
        // 主题切了 → 窗口底色跟着换（Task 6）。
        onTheme: (theme) => applyWindowTheme(theme),
        requestClose: () => {
          if (win.isDestroyed()) return
          win.close()
        },
        // 悬浮歌词（Task 10）：主进程**只转发**，不理解歌词内容。
        onLyricState: (message) => {
          lastLyricMessage = message
          if (!lyricWindow || lyricWindow.isDestroyed()) return
          lyricWindow.webContents.send('lyric:state', message)
        },
        setLyricVisible,
        // 本地下载（Task 11）：落盘 / 断点续传 / 索引全在主进程。
        downloads,
        // FFmpeg 兜底解码（Task 12）：探测与转码全在主进程。
        ffmpeg: fallback,
      })

      // 13a. 本地曲目 IPC（T38）。
      //
      //     ⚠️ **渲染进程不碰文件系统**：它只能让主进程弹对话框、
      //        把选中的路径交给主进程登记、拿回登记好的清单。
      //     ⚠️ **登记的门槛在主进程**：路径必须真实存在、是普通文件、
      //        扩展名在白名单里 → 渲染进程给不出「任意路径」。
      registerLocalLibraryIpc({ library: localLibrary })

      // 14. 自动更新 IPC（Task 23）。
      //
      //     ⚠️ **出网走同一个 Chromium 分区栈**：更新服务器**不在 `TrustedHosts` 里**
      //     → 该分区对它的证书走 Chromium 默认校验（自签**不会**被放行）。
      //     ⚠️ **渲染层不碰网络**：检查 / 下载 / 启动全在主进程。
      registerUpdateIpc({
        prefs,
        update: createUpdateController({
          fetchImpl: http.fetch,
          currentVersion: app.getVersion(),
          destDir: path.join(app.getPath('temp'), 'fnmusic-update'),
        }),
      })

      // 14b. 外部歌词 IPC（Task 32）：NAS 没有歌词时去外部源补一份。
      //
      //     ⚠️ **出网走同一个 Chromium 分区栈**（`http.fetch`）——外部歌词源
      //     **不在 `TrustedHosts` 里** → 证书走 Chromium 默认校验（自签不会被放行）。
      //     ⚠️ **这个 fetch 是干净的**：不附带 NAS 的 token / Cookie
      //     → 第三方歌词源看不到 NAS 的任何凭证。
      //     ⚠️ **渲染层不碰网络**：只报歌名 / 歌手 / 专辑 / 时长，
      //     地址一律取主进程自己读到的偏好。
      registerLyricIpc({
        prefs,
        provider: createLyricProvider({ fetchImpl: http.fetch }),
      })

      // 13b. 启动时按偏好恢复悬浮窗（上次是开着的就接着开）。
      if (prefs.read().lyricOverlay?.visible === true) {
        setLyricVisible(true)
      }

      // 13c. 退出时清掉兜底转码的临时目录（**只删自己建的那个目录**）。
      app.on('before-quit', () => {
        void fallback.dispose()
      })
    })
    .catch((err: unknown) => {
      console.error('[fnmusic] 应用启动失败:', err)
      app.quit()
    })
}

// ⚠️ 窗口被拦截关闭时这个分支**永远不触发**（应用常驻是预期行为）。
//    真正退出走托盘菜单的「退出」。
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
