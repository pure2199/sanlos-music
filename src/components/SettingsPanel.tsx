// ---------------------------------------------------------------------------
// 设置页（T35；原为「设置面板」Task 8）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么从「顶栏下拉的浮层」改成「整页」**（用户 2026-11-05 反馈「设置页做得不对」）：
//    浮层只有 294px 宽，却塞了 6 组设置 → 说明文字被折成 2～4 行、输入框里的
//    示例 URL 被截断、下半截（FFmpeg / 自动更新）掉到视口外只能在小窄条里滚动，
//    而且它**盖住顶栏** → 开着的时候别的顶栏按钮点不到。
//    ⇒ 现在是**主区里的整页**：左侧分类导航 + 右侧内容（内容列宽 ≈ 900px，
//      说明文字一行放得下），顶栏**不再被遮挡**，点「设置」或「关闭设置」都能退出。
//
// ⚠️ **只改呈现，不改数据模型**：`prefs.json` 的键、IPC、偏好白名单**一字未动**；
//    每一项的控件、名字、草稿/保存语义都保持原样。
//
// ---------------------------------------------------------------------------
// 偏好的单一真相源
// ---------------------------------------------------------------------------
//
// ⚠️ 偏好的**单一真相源 = 主进程 `prefs.json`**：本页只经 `useAppPrefsStore`
//    读写，不碰偏好文件本身。
//
// ---------------------------------------------------------------------------
// 样式约定
// ---------------------------------------------------------------------------
//
// ⚠️ 颜色**只用 CSS 语义变量**（`src/styles/tokens.css`），
//    样式住在同目录的 `settings-panel.css`。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState, type ChangeEvent as ReactChangeEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'

import { APP_INFO } from '../../shared/appInfo'
import type { CloseBehavior, LyricOverlayMode, PlayerBridge } from '../../shared/playerBridge'
import type { FfmpegStatus } from '../../shared/ffmpeg'
import type { LyricSource } from '../../shared/lyricProvider'
import type { StreamQuality } from '../../shared/types'
import { isLocalTrackId } from '../../shared/localMedia'
import { useAppPrefsStore } from '../state/appPrefsStore'
import { totalDownloadedBytes, useDownloadStore } from '../state/downloadStore'
import { usePlayerStore } from '../state/playerStore'
import { useUpdateStore } from '../state/updateStore'
import { detectFfmpegStatus, hasFfmpegSupport } from '../player/fallback'
import { probeServerTranscode } from '../player/transcode'
import { formatBytes } from './DownloadButton'
import './settings-panel.css'

/** 设置页的分类。 */
export type SettingsCategory = 'general' | 'lyrics' | 'download' | 'decoder' | 'update' | 'about'

/** 左侧分类导航的条目（顺序 = 显示顺序）。 */
const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'lyrics', label: '歌词' },
  { id: 'download', label: '下载' },
  { id: 'decoder', label: '解码' },
  { id: 'update', label: '更新' },
  { id: 'about', label: '关于' },
]

/** `SettingsPanel` 的属性。 */
export interface SettingsPanelProps {
  /** 附加类名。 */
  className?: string
  /** 「关闭设置」回调（不传就没有关闭按钮）。 */
  onClose?: () => void
}

/** 设置页。 */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const { className, onClose } = props
  /** 当前分类（左侧导航选中哪一档，右侧就显示哪一组）。 */
  const [category, setCategory] = useState<SettingsCategory>('general')

  const closeBehavior = useAppPrefsStore((state) => state.closeBehavior)
  const setCloseBehavior = useAppPrefsStore((state) => state.setCloseBehavior)
  const lyricOverlayVisible = useAppPrefsStore((state) => state.lyricOverlayVisible)
  const setLyricOverlayVisible = useAppPrefsStore((state) => state.setLyricOverlayVisible)
  // --- 桌面歌词样式（T45）-------------------------------------------------
  const lyricOverlayMode = useAppPrefsStore((state) => state.lyricOverlayMode)
  const setLyricOverlayMode = useAppPrefsStore((state) => state.setLyricOverlayMode)
  const error = useAppPrefsStore((state) => state.error)

  // --- 音质偏好（T54）------------------------------------------------------
  const streamQuality = useAppPrefsStore((state) => state.streamQuality)
  const setStreamQuality = useAppPrefsStore((state) => state.setStreamQuality)
  /**
   * 服务端转码能力的**探测结果**（`null` = 还没探测过）。
   *
   * ⚠️ 探测会**真的让 NAS 转一遍** → 只在用户点「检测」时才做，**不做自动探测**。
   */
  const [qualityProbe, setQualityProbe] = useState<{ supported: boolean; detail: string | null } | null>(
    null,
  )
  /** 正在探测（界面显示「检测中…」）。 */
  const [qualityProbing, setQualityProbing] = useState(false)

  const handleSelectStreamQuality = useCallback(
    (quality: StreamQuality) => {
      void setStreamQuality(quality)
    },
    [setStreamQuality],
  )

  /**
   * 探测服务端**到底能不能**转码。
   *
   * ⚠️ 用**当前正在播的那首**当探测对象：本地曲目在 NAS 上根本不存在，
   *    拿它去探测只会得到一个无意义的失败。
   */
  const handleProbeTranscode = useCallback(async () => {
    const song = usePlayerStore.getState().current
    if (!song || isLocalTrackId(song.id)) return
    setQualityProbing(true)
    try {
      const result = await probeServerTranscode(song.id)
      setQualityProbe(result)
    } catch {
      setQualityProbe({ supported: false, detail: '探测失败' })
    } finally {
      setQualityProbing(false)
    }
  }, [])

  const handleChange = useCallback(
    (behavior: CloseBehavior) => {
      void setCloseBehavior(behavior)
    },
    [setCloseBehavior],
  )

  const handleToggleLyricOverlay = useCallback(
    (visible: boolean) => {
      void setLyricOverlayVisible(visible)
    },
    [setLyricOverlayVisible],
  )

  // --- 桌面歌词样式（T45）-------------------------------------------------
  const handleSelectLyricMode = useCallback(
    (mode: LyricOverlayMode) => {
      void setLyricOverlayMode(mode)
    },
    [setLyricOverlayMode],
  )

  // --- 本地下载（Task 11）-------------------------------------------------
  const localFirst = useDownloadStore((state) => state.localFirst)
  const setLocalFirst = useDownloadStore((state) => state.setLocalFirst)
  const entries = useDownloadStore((state) => state.entries)
  const dir = useDownloadStore((state) => state.dir)
  const setDir = useDownloadStore((state) => state.setDir)
  const clearDownloads = useDownloadStore((state) => state.clear)
  const downloadError = useDownloadStore((state) => state.error)

  /** 下载目录的**输入草稿**（点「保存」才写回主进程偏好）。 */
  const [dirDraft, setDirDraft] = useState(dir)
  useEffect(() => {
    setDirDraft(dir)
  }, [dir])

  const handleToggleLocalFirst = useCallback(
    (enabled: boolean) => {
      void setLocalFirst(enabled)
    },
    [setLocalFirst],
  )

  const handleSaveDir = useCallback(() => {
    void setDir(dirDraft)
  }, [dirDraft, setDir])

  const handleClearDownloads = useCallback(() => {
    void clearDownloads()
  }, [clearDownloads])

  const downloadedCount = Object.keys(entries).length
  const downloadedBytes = totalDownloadedBytes(entries)

  // --- FFmpeg 兜底解码（Task 12）-------------------------------------------
  //
  // ⚠️ **只做检测与展示**：设置里**改不了** FFmpeg 的安装（客户端**绝不**
  //    自动下载 / 安装外部程序），只告诉用户装没装、怎么装。
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>({
    available: false,
    path: '',
    version: '',
  })
  const [ffmpegChecking, setFfmpegChecking] = useState(false)

  const refreshFfmpeg = useCallback((): void => {
    if (!hasFfmpegSupport()) {
      // 没有桥 → 同步置为「未检测到」，**不发起异步请求**。
      setFfmpeg({ available: false, path: '', version: '' })
      return
    }
    setFfmpegChecking(true)
    void detectFfmpegStatus()
      .then((next) => setFfmpeg(next))
      .finally(() => setFfmpegChecking(false))
  }, [])

  useEffect(() => {
    refreshFfmpeg()
  }, [refreshFfmpeg])

  // --- 自动更新（Task 23）---------------------------------------------------
  //
  // ⚠️ **渲染层只发请求**：检查 / 下载 / 启动全在主进程。
  //    「预期的代码签名者」没配 → **不许启动安装器**（界面提前说清楚）。
  // --- 外部歌词源（Task 32）-------------------------------------------------
  //
  // ⚠️ **渲染层不碰网络**：这里只改偏好；抓取全在主进程。
  // ⚠️ 源与模板都是**草稿**，点「保存」才写回（与「自动更新」那一组同一套交互）。
  const lyricSource = useAppPrefsStore((state) => state.lyricSource)
  const lyricTemplate = useAppPrefsStore((state) => state.lyricTemplate)
  const setLyricSource = useAppPrefsStore((state) => state.setLyricSource)
  // --- 歌词来源优先级（T70）------------------------------------------------
  //
  // ⚠️ 与「源 / 模板」不同：优先级**即时生效**（不点保存）——
  //    改了下一首歌就该用新口径（与「桌面歌词样式」同一套交互）。
  const lyricPriority = useAppPrefsStore((state) => state.lyricPriority)
  const setLyricPriority = useAppPrefsStore((state) => state.setLyricPriority)

  /** 歌词源的**输入草稿**。 */
  const [lyricSourceDraft, setLyricSourceDraft] = useState<LyricSource>(lyricSource)
  /** 自定义模板的**输入草稿**。 */
  const [lyricTemplateDraft, setLyricTemplateDraft] = useState(lyricTemplate)
  useEffect(() => {
    setLyricSourceDraft(lyricSource)
    setLyricTemplateDraft(lyricTemplate)
  }, [lyricSource, lyricTemplate])

  const handleSaveLyricSource = useCallback(() => {
    void setLyricSource(lyricSourceDraft, lyricTemplateDraft)
  }, [lyricSourceDraft, lyricTemplateDraft, setLyricSource])

  /** 歌词源已保存（没改动 → 「保存」按钮禁用）。 */
  const lyricSourceSaved =
    lyricSourceDraft === lyricSource && lyricTemplateDraft.trim() === lyricTemplate.trim()

  const updateBaseUrl = useUpdateStore((state) => state.baseUrl)
  const updateExpectedSigner = useUpdateStore((state) => state.expectedSigner)
  const baseUrlDraft = useUpdateStore((state) => state.baseUrlDraft)
  const signerDraft = useUpdateStore((state) => state.signerDraft)
  const updateStatus = useUpdateStore((state) => state.status)
  const updateResult = useUpdateStore((state) => state.result)
  const updateDownload = useUpdateStore((state) => state.download)
  const updateError = useUpdateStore((state) => state.error)
  const loadUpdate = useUpdateStore((state) => state.load)
  const saveUpdate = useUpdateStore((state) => state.save)
  const setBaseUrlDraft = useUpdateStore((state) => state.setBaseUrlDraft)
  const setSignerDraft = useUpdateStore((state) => state.setSignerDraft)
  const checkUpdate = useUpdateStore((state) => state.check)
  const downloadUpdate = useUpdateStore((state) => state.downloadUpdate)
  const installUpdate = useUpdateStore((state) => state.installUpdate)
  const allowUnsigned = useUpdateStore((state) => state.allowUnsigned)
  const allowUnsignedDraft = useUpdateStore((state) => state.allowUnsignedDraft)
  const setAllowUnsignedDraft = useUpdateStore((state) => state.setAllowUnsignedDraft)

  // --- 版本号（T82）--------------------------------------------------------
  //
  // ⚠️ 渲染层是 sandbox，**读不到 `package.json`** ⇒ 版本号只能由主进程给
  //    （`app.getVersion()`，与安装包的 `FileVersion` 同源）。
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
    const bridge = scope.fnPlayer
    // ⚠️ **桥可能没有这个方法**（浏览器预览 / 旧单测替身）→ 不炸、不显示假版本。
    if (!bridge || typeof bridge.getAppVersion !== 'function') return
    let alive = true
    void bridge
      .getAppVersion()
      .then((version) => {
        if (alive) setAppVersion(version)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    void loadUpdate()
  }, [loadUpdate])

  const handleSaveUpdate = useCallback(() => {
    void saveUpdate()
  }, [saveUpdate])

  const handleCheckUpdate = useCallback(() => {
    void checkUpdate()
  }, [checkUpdate])

  const handleDownloadUpdate = useCallback(() => {
    void downloadUpdate()
  }, [downloadUpdate])

  const handleInstallUpdate = useCallback(() => {
    void installUpdate()
  }, [installUpdate])

  /**
   * 「用项目地址」：把更新源填成**项目自己的 Release 目录**并保存（T82）。
   *
   * ⚠️ 主进程在**没配地址**时本来就会回落项目地址；这个按钮是让用户
   *    **看得见、也改得动**（填别的源时，一键切回项目）。
   */
  const handleUseProjectSource = useCallback(() => {
    setBaseUrlDraft(APP_INFO.updateBaseUrl)
    void saveUpdate()
  }, [setBaseUrlDraft, saveUpdate])

  /** 「允许安装未签名更新」的开关（T82）。 */
  const handleToggleAllowUnsigned = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>): void => {
      setAllowUnsignedDraft(event.target.checked)
    },
    [setAllowUnsignedDraft],
  )

  /**
   * 点官网 → 用**系统默认浏览器**打开（不在应用内跳转）。
   *
   * ⚠️ **必须 `preventDefault()`**：主窗口**没有** `setWindowOpenHandler`
   *    → 不拦住的话，浏览器会把**应用窗口整个导航到那个网站**
   *    （应用界面被替换掉，等于把软件弄坏）。
   * ⚠️ **白名单在主进程那一侧**（`shared/appInfo.ts` 的 `isAllowedExternalUrl`）
   *    → 渲染层给什么 URL 都开不了别的站点。
   */
  const handleOpenWebsite = useCallback((event: ReactMouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault()
    const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
    void scope.fnPlayer?.openExternal(APP_INFO.website)
  }, [])

  /**
   * 点**项目地址** → 用系统默认浏览器打开源码仓库（T82）。
   *
   * ⚠️ 同样**必须 `preventDefault()`**（否则应用窗口被导航走）；
   *    白名单在主进程那一侧（`github.com` 已在白名单里，仍是**精确匹配**）。
   */
  const handleOpenRepository = useCallback((event: ReactMouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault()
    const scope = globalThis as unknown as { fnPlayer?: PlayerBridge }
    void scope.fnPlayer?.openExternal(APP_INFO.repository)
  }, [])

  const updateBusy =
    updateStatus === 'checking' || updateStatus === 'downloading' || updateStatus === 'installing'
  const updateSaved =
    baseUrlDraft.trim() === updateBaseUrl &&
    signerDraft.trim() === updateExpectedSigner &&
    allowUnsignedDraft === allowUnsigned
  /**
   * 能不能点「启动安装」。
   *
   * ⚠️ T82：除了「签名校验通过」，还多一条路 —— **未签名包 + 用户显式授权**
   *    （`allowUnsigned`）⇒ 可以装（主进程那边**仍会再验一次 SHA-512**）。
   */
  const signatureOk =
    updateDownload?.status === 'ok' &&
    (updateDownload.signature.ok === true ||
      (allowUnsignedDraft && updateDownload.signature.status === 'NotSigned'))

  const rootClass = className ? `fnm-settings ${className}` : 'fnm-settings'

  return (
    <section className={rootClass} role="region" aria-label="设置">
      {/* --- 左侧：分类导航 --------------------------------------------- */}
      <nav className="fnm-settings__nav" aria-label="设置分类">
        <h1 className="fnm-settings__title">设置</h1>
        {CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="fnm-settings__nav-item"
            // ⚠️ `aria-current="page"` 标明「当前这一档」——屏幕阅读器靠它播报。
            aria-current={category === item.id ? 'page' : undefined}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
        {onClose && (
          <button type="button" className="fnm-settings__close" onClick={onClose}>
            关闭设置
          </button>
        )}
      </nav>

      {/* --- 右侧：当前分类的内容 --------------------------------------- */}
      <div className="fnm-settings__content">
        {/* ⚠️ **偏好的错误横幅永远在最上面**：某一类设置写回失败时，
            用户可能正停在别的分类上 → 错误不能被藏起来。 */}
        {error && (
          <p className="fnm-settings__error" role="alert">
            {error}
          </p>
        )}

        {category === 'general' && (
          <>
            <fieldset className="fnm-settings__group">
              <legend className="fnm-settings__legend">关闭窗口时</legend>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-close-behavior"
                  value="hide"
                  checked={closeBehavior === 'hide'}
                  onChange={() => handleChange('hide')}
                />
                <span>隐藏窗口（播放继续）</span>
              </label>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-close-behavior"
                  value="quit"
                  checked={closeBehavior === 'quit'}
                  onChange={() => handleChange('quit')}
                />
                <span>直接退出应用</span>
              </label>
            </fieldset>
            <p className="fnm-settings__hint">窗口位置与尺寸会自动记住，下次启动时恢复。</p>
          </>
        )}

        {category === 'lyrics' && (
          <>
            <fieldset className="fnm-settings__group">
              <legend className="fnm-settings__legend">桌面悬浮歌词</legend>
              <label className="fnm-settings__option">
                <input
                  type="checkbox"
                  name="fnm-lyric-overlay"
                  checked={lyricOverlayVisible}
                  onChange={(event) => handleToggleLyricOverlay(event.target.checked)}
                />
                <span>显示悬浮歌词（双行逐字 · 透明背景 · 点击穿透）</span>
              </label>
            </fieldset>

            <fieldset className="fnm-settings__group">
              <legend className="fnm-settings__legend">桌面歌词样式</legend>
              <p className="fnm-settings__hint">
                「灵动态词岛」= 屏幕顶部居中的胶囊（像灵动岛）；「经典悬浮窗」= 透明背景的纯歌词（像酷狗桌面歌词）。
                两种形态**互斥**，切换后立刻生效。
              </p>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-lyric-overlay-mode"
                  // ⚠️ **显式 aria-label**：`<label>` 包着 radio 时，可访问名会把
                  //    整个说明文字都带进去 → 名字不稳定、没法精确选中。
                  aria-label="经典悬浮窗"
                  checked={lyricOverlayMode === 'classic'}
                  onChange={() => handleSelectLyricMode('classic')}
                />
                <span>经典悬浮窗（透明背景 · 纯歌词 · 点击穿透）</span>
              </label>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-lyric-overlay-mode"
                  aria-label="灵动态词岛"
                  checked={lyricOverlayMode === 'island'}
                  onChange={() => handleSelectLyricMode('island')}
                />
                <span>灵动态词岛（屏幕顶部居中的胶囊）</span>
              </label>
            </fieldset>

            <fieldset className="fnm-settings__group">
              <legend className="fnm-settings__legend">歌词来源</legend>
              <p className="fnm-settings__hint">
                这里是先用哪个外部源；这个源匹配不上时，会自动按顺序试下一个线上源
                （网易云 → lrclib → QQ → 自定义模板），全都试完才回落到 NAS 自带的。
                谁优先（线上还是 NAS 自带的），见下一组「歌词优先级」。
              </p>
              <label className="fnm-settings__option fnm-settings__option--stack">
                <span>外部歌词源</span>
                <select
                  className="fnm-settings__input"
                  name="fnm-lyric-source"
                  // ⚠️ **显式 aria-label**：`<label>` 包着 `<select>` 时，
                  //    可访问名会把**所有选项文字**也带进去 → 名字不稳定、没法精确选中
                  //    （与 T30 那个「复选框把曲目数带进名字」是同一个坑）。
                  aria-label="外部歌词源"
                  value={lyricSourceDraft}
                  onChange={(event) => setLyricSourceDraft(event.target.value as LyricSource)}
                >
                  <option value="netease">网易云音乐（国内实测最快）</option>
                  <option value="lrclib">lrclib.net（开源、免费）</option>
                  <option value="qq">QQ 音乐（Lyricify 同款词源）</option>
                  <option value="custom">自定义歌词 API（URL 模板）</option>
                  <option value="off">不用外部（只用 NAS）</option>
                </select>
              </label>
              <label className="fnm-settings__option fnm-settings__option--stack">
                <span>自定义歌词 API 模板</span>
                <input
                  type="text"
                  className="fnm-settings__input"
                  name="fnm-lyric-template"
                  // ⚠️ 显式 aria-label（同上：别让 `<label>` 的文字拼进名字）。
                  aria-label="自定义歌词 API 模板"
                  value={lyricTemplateDraft}
                  placeholder="https://example.com/lyric?title={title}&artist={artist}&album={album}&duration={duration}"
                  disabled={lyricSourceDraft !== 'custom'}
                  onChange={(event) => setLyricTemplateDraft(event.target.value)}
                />
              </label>
              <div className="fnm-settings__row">
                <button
                  type="button"
                  className="fnm-settings__button"
                  onClick={handleSaveLyricSource}
                  disabled={lyricSourceSaved}
                >
                  {/* ⚠️ **名字必须专属**：面板里「自动更新」那一组也有一个「保存」→
                      两个同名按钮会让 `getByRole('button', { name: '保存' })` 命中多个。 */}
                  保存歌词源
                </button>
              </div>
              <p className="fnm-settings__hint">
                占位符：{'{title}'} {'{artist}'} {'{album}'} {'{duration}'}；
                地址必须是 https（不许带账号密码）；返回的正文必须是**带时间戳的 LRC**。
              </p>
            </fieldset>

            <fieldset className="fnm-settings__group">
              <legend className="fnm-settings__legend">歌词优先级</legend>
              <p className="fnm-settings__hint">
                线上 = 上面的外部歌词源（多数能给出**真逐字**时间戳，卡拉OK 填色更跟嘴）；
                本地 = NAS 自带的歌词（断网也有，但多半只有行级时间戳）。
                选了「线上优先」而线上没匹配上时，**自动回落到本地**。
              </p>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-lyric-priority"
                  // ⚠️ **显式 aria-label**：`<label>` 包着 radio 时，可访问名会把
                  //    整个说明文字都带进去 → 名字不稳定、没法精确选中。
                  aria-label="线上优先"
                  checked={lyricPriority === 'online-first'}
                  onChange={() => void setLyricPriority('online-first')}
                />
                <span>线上优先（默认）</span>
              </label>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-lyric-priority"
                  aria-label="本地优先"
                  checked={lyricPriority === 'local-first'}
                  onChange={() => void setLyricPriority('local-first')}
                />
                <span>本地优先（先用 NAS 自带的歌词）</span>
              </label>
            </fieldset>
          </>
        )}

        {category === 'download' && (
          <fieldset className="fnm-settings__group">
            <legend className="fnm-settings__legend">本地下载</legend>
            <label className="fnm-settings__option">
              <input
                type="checkbox"
                name="fnm-local-first"
                checked={localFirst}
                onChange={(event) => handleToggleLocalFirst(event.target.checked)}
              />
              <span>本地优先播放（本地有副本就播本地，不再走 NAS）</span>
            </label>
            <label className="fnm-settings__option fnm-settings__option--stack">
              <span>下载目录</span>
              <input
                type="text"
                className="fnm-settings__input"
                name="fnm-download-dir"
                value={dirDraft}
                placeholder="默认：我的音乐\Sanlos music"
                onChange={(event) => setDirDraft(event.target.value)}
              />
            </label>
            <div className="fnm-settings__row">
              <button
                type="button"
                className="fnm-settings__button"
                onClick={handleSaveDir}
                disabled={dirDraft.trim() === dir.trim()}
              >
                保存目录
              </button>
              <button
                type="button"
                className="fnm-settings__button fnm-settings__button--danger"
                onClick={handleClearDownloads}
                disabled={downloadedCount === 0}
              >
                清空本地下载
              </button>
            </div>
            <p className="fnm-settings__hint">
              已下载 {downloadedCount} 首，占用 {formatBytes(downloadedBytes)}。
            </p>
            {downloadError && (
              <p className="fnm-settings__error" role="alert">
                {downloadError}
              </p>
            )}
          </fieldset>
        )}

        {category === 'decoder' && (
          <>
            <fieldset className="fnm-settings__group">
              <legend className="fnm-settings__legend">音质偏好</legend>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-stream-quality"
                  value="original"
                  checked={streamQuality === 'original'}
                  onChange={() => handleSelectStreamQuality('original')}
                />
                <span>原始音质（直拉 NAS 上的原文件，FLAC 无损）</span>
              </label>
              <label className="fnm-settings__option">
                <input
                  type="radio"
                  name="fnm-stream-quality"
                  value="standard"
                  checked={streamQuality === 'standard'}
                  onChange={() => handleSelectStreamQuality('standard')}
                />
                <span>标准音质（由 NAS 服务端转码，流量小得多）</span>
              </label>
              <p className="fnm-settings__hint">
                标准音质由 NAS 服务端转码后播放（官方协议里是 MP3 320k），流量比原始文件小一个量级。
                若服务端没启用转码、或转码失败，会自动改用原始音质播放，并在播放条上说明原因。
              </p>
              <div className="fnm-settings__row">
                <button
                  type="button"
                  className="fnm-settings__button"
                  onClick={() => {
                    void handleProbeTranscode()
                  }}
                  disabled={qualityProbing}
                >
                  {qualityProbing ? '检测中…' : '检测服务端能力'}
                </button>
              </div>
              {qualityProbe && (
                <p className="fnm-settings__hint" data-testid="stream-quality-probe">
                  {qualityProbe.supported
                    ? '服务端转码可用：标准音质能正常生效。'
                    : `服务端转码不可用：${qualityProbe.detail ?? '未知原因'}。标准音质会自动回退原始音质。`}
                </p>
              )}
            </fieldset>
            <fieldset className="fnm-settings__group">
              <legend className="fnm-settings__legend">FFmpeg 兜底解码</legend>
              <p className="fnm-settings__hint" data-testid="ffmpeg-status">
                {ffmpeg.available
                  ? `已检测到 FFmpeg：${ffmpeg.version || ffmpeg.path}`
                  : '未检测到 FFmpeg。'}
              </p>
              <p className="fnm-settings__hint">
                APE / ALAC / DSF 等格式 Chromium 解不了：把歌曲下载到本地后，客户端会用 FFmpeg
                转码成 Opus 播放（音质有损，原始文件不变）。
              </p>
              {!ffmpeg.available && (
                <p className="fnm-settings__hint">
                  安装方式：<code>winget install Gyan.FFmpeg</code>，装完后点「重新检测」。
                </p>
              )}
              <div className="fnm-settings__row">
                <button
                  type="button"
                  className="fnm-settings__button"
                  onClick={refreshFfmpeg}
                  disabled={ffmpegChecking}
                >
                  {ffmpegChecking ? '检测中…' : '重新检测'}
                </button>
              </div>
            </fieldset>
          </>
        )}

        {category === 'update' && (
          <fieldset className="fnm-settings__group">
            <legend className="fnm-settings__legend">自动更新</legend>
            <p className="fnm-settings__hint" data-testid="update-current-version">
              {`当前版本：${appVersion ? `v${appVersion}` : '（读取中…）'}　更新源：项目 Releases`}
            </p>
            <label className="fnm-settings__option fnm-settings__option--stack">
              <span>更新服务器地址</span>
              <input
                type="text"
                className="fnm-settings__input"
                name="fnm-update-base-url"
                value={baseUrlDraft}
                placeholder={APP_INFO.updateBaseUrl}
                onChange={(event) => setBaseUrlDraft(event.target.value)}
              />
            </label>
            <div className="fnm-settings__row">
              <button
                type="button"
                className="fnm-settings__button"
                onClick={handleUseProjectSource}
                data-testid="update-use-project-source"
              >
                用项目地址
              </button>
            </div>
            <label className="fnm-settings__option fnm-settings__option--stack">
              <span>预期的代码签名者</span>
              <input
                type="text"
                className="fnm-settings__input"
                name="fnm-update-signer"
                value={signerDraft}
                placeholder="CN=你的证书主体名"
                onChange={(event) => setSignerDraft(event.target.value)}
              />
            </label>
            {/* ⚠️ T82：默认**关**——本项目暂未办理代码签名证书，
                未签名包默认**拒绝安装**（原行为一字不变）。 */}
            <label className="fnm-settings__checkbox">
              <input
                type="checkbox"
                name="fnm-update-allow-unsigned"
                checked={allowUnsignedDraft}
                onChange={handleToggleAllowUnsigned}
                data-testid="update-allow-unsigned"
              />
              <span>允许安装未签名的更新包</span>
            </label>
            <div className="fnm-settings__row">
              <button
                type="button"
                className="fnm-settings__button"
                onClick={handleSaveUpdate}
                disabled={updateSaved}
              >
                保存
              </button>
              <button
                type="button"
                className="fnm-settings__button"
                onClick={handleCheckUpdate}
                disabled={updateBusy}
              >
                {updateStatus === 'checking' ? '检查中…' : '检查更新'}
              </button>
            </div>
            {updateResult?.status === 'up-to-date' && (
              <p className="fnm-settings__hint" data-testid="update-latest">
                {`已是最新版本（${updateResult.current}）。`}
              </p>
            )}
            {updateResult?.status === 'not-configured' && (
              <p className="fnm-settings__hint" data-testid="update-not-configured">
                还没填「更新服务器地址」，无法检查更新。
              </p>
            )}
            {updateResult?.status === 'available' && (
              <p className="fnm-settings__hint" data-testid="update-available">
                {`发现新版本 ${updateResult.manifest.version}${
                  updateResult.manifest.notes ? `：${updateResult.manifest.notes}` : ''
                }`}
              </p>
            )}
            {updateDownload?.status === 'ok' && (
              <p className="fnm-settings__hint" data-testid="update-downloaded">
                {`安装包已下载（${formatBytes(updateDownload.bytes)}）。${
                  updateDownload.signature.ok
                    ? '签名校验通过。'
                    : updateDownload.signature.status === 'NotSigned' && allowUnsignedDraft
                      ? '安装包没有代码签名（已按你的授权放行；主进程仍会核对 SHA-512）。'
                      : `签名校验未通过：${updateDownload.signature.reason ?? '未知原因'}——不允许安装。`
                }`}
              </p>
            )}
            {updateResult?.status === 'available' && (
              <div className="fnm-settings__row">
                <button
                  type="button"
                  className="fnm-settings__button"
                  onClick={handleDownloadUpdate}
                  disabled={updateBusy}
                >
                  {updateStatus === 'downloading' ? '下载中…' : '下载更新'}
                </button>
                <button
                  type="button"
                  className="fnm-settings__button"
                  onClick={handleInstallUpdate}
                  disabled={updateBusy || !signatureOk}
                  title={
                    signatureOk
                      ? '启动安装器'
                      : '需要先下载，且签名校验通过（未配置预期签名者时不允许安装）'
                  }
                >
                  {updateStatus === 'installing' ? '启动中…' : '启动安装'}
                </button>
              </div>
            )}
            {updateError && (
              <p className="fnm-settings__error" role="alert">
                {updateError}
              </p>
            )}
            <p className="fnm-settings__hint">
              默认从**项目自己的 Releases** 拉更新（不用填地址）；填了别的地址就用别的源。
            </p>
            <p className="fnm-settings__hint">
              安装包必须带代码签名，且签名者与「预期的代码签名者」一致才会被启动；
              未配置预期签名者时只允许下载，不允许安装。
            </p>
            <p className="fnm-settings__hint">
              ⚠️ 本项目暂未办理代码签名证书 ⇒ 安装包**没有签名**。勾选「允许安装未签名的更新包」
              后才允许安装（**SHA-512 与同源校验照旧**，哈希不符一律拒绝）。
            </p>
          </fieldset>
        )}

        {category === 'about' && (
          <fieldset className="fnm-settings__group">
            <legend className="fnm-settings__legend">关于</legend>
            <dl className="fnm-settings__about" data-testid="app-about">
              <div className="fnm-settings__about-row">
                <dt>应用名称</dt>
                <dd>{APP_INFO.name}</dd>
              </div>
              <div className="fnm-settings__about-row">
                <dt>版本</dt>
                <dd data-testid="app-about-version">{appVersion ? `v${appVersion}` : '（读取中…）'}</dd>
              </div>
              <div className="fnm-settings__about-row">
                <dt>开发者</dt>
                <dd data-testid="app-about-developer">{APP_INFO.developer}</dd>
              </div>
              <div className="fnm-settings__about-row">
                <dt>公司</dt>
                <dd data-testid="app-about-company">{APP_INFO.company}</dd>
              </div>
              <div className="fnm-settings__about-row">
                <dt>官网</dt>
                <dd>
                  {/* ⚠️ 必须 `preventDefault`（见 `handleOpenWebsite`）：
                      不拦住的话浏览器会把**应用窗口**导航到那个网站。 */}
                  <a
                    className="fnm-settings__about-link"
                    href={APP_INFO.website}
                    onClick={handleOpenWebsite}
                  >
                    {APP_INFO.website}
                  </a>
                </dd>
              </div>
              <div className="fnm-settings__about-row">
                <dt>备案号</dt>
                <dd data-testid="app-about-icp">{APP_INFO.icp}</dd>
              </div>
              <div className="fnm-settings__about-row">
                <dt>项目地址</dt>
                <dd>
                  {/* ⚠️ 同样必须 `preventDefault`（见 `handleOpenRepository`）。 */}
                  <a
                    className="fnm-settings__about-link"
                    href={APP_INFO.repository}
                    onClick={handleOpenRepository}
                    data-testid="app-about-repository"
                  >
                    {APP_INFO.repository}
                  </a>
                </dd>
              </div>
            </dl>
            <p className="fnm-settings__hint">
              点官网 / 项目地址都会用系统默认浏览器打开（不在应用内跳转）。
            </p>
          </fieldset>
        )}
      </div>
    </section>
  )
}
