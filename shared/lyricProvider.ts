// ---------------------------------------------------------------------------
// 外部歌词 API（Task 32）—— 跨进程类型
// ---------------------------------------------------------------------------
//
// ⚠️ 本文件**不得出现副作用**，也不得 import Electron / Node 内置模块 / DOM 类型：
// - 类型（`interface` / `type`）供主进程（`electron/lyricProvider.ts`、
//   `electron/ipc.ts`）与渲染进程（`src/player/lyricSource.ts`、设置面板）**共用**；
// - 末尾的 `normalizeLyricSource` 是**纯函数**（无副作用、可单测），
//   与 `shared/themes.ts` 的 `resolveThemeName` 同一套范式。
//
// 理由与 `shared/playerBridge.ts` 完全相同：渲染进程跑在 `contextIsolation: true`
// 的沙箱里——一旦这里混进主进程逻辑，就会把主进程逻辑打进渲染层 bundle。
//
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）
// ---------------------------------------------------------------------------
// 1. **本文件里的任何一个类型都不许携带凭证**：没有 token / 口令 / deviceId。
//    歌词源的名称与地址模板**不是**凭证（它们只是公开信息），
//    故可以放在 `AppPrefs`（`prefs.json`）里。
// 2. **渲染层永远不直接发网络请求**：外部歌词的抓取**全在主进程**，
//    渲染层只发 IPC 请求、只收结果。
// 3. **渲染进程是不可信输入**：主进程只接受「歌名 / 歌手 / 专辑 / 时长」
//    这四个字段，**不接受渲染层传来的任何 URL**（除了用户自己在设置里配的模板），
//    以免把主进程变成任意出网代理。
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

/**
 * 外部歌词来源。
 *
 * - `off`：**不查外部**，只用 NAS 自带的歌词；
 * - `netease`：网易云音乐的公开 Web 接口（**非官方**，实测国内最快）；
 * - `lrclib`：`lrclib.net`（开源、官方、免费；实测偶发 503）；
 * - `qq`：QQ 音乐的公开 Web 接口（**非官方**；与 Lyricify 同款词源；
 *   明文 LRC + 翻译，**无逐字**）；
 * - `kugou`：酷狗音乐的公开 Web 接口（**非官方**；**KRC 真逐字**，
 *   T90-⑤ 实测三首全有逐字；**没有**翻译与罗马音）；
 * - `kuwo`：酷我音乐的公开 Web 接口（**非官方**；**lrcx 真逐字**，
 *   T90-⑥ 实测三首全有逐字；英文歌**有翻译**、**没有**罗马音）；
 * - `custom`：用户自己配的 **URL 模板**（返回**纯文本 LRC**）。
 */
export type LyricSource = 'off' | 'netease' | 'lrclib' | 'qq' | 'kugou' | 'kuwo' | 'custom'

/**
 * 歌词来源的**优先级**（T70）。
 *
 * - `online-first`：**线上优先** —— 线上（外部源）匹配上就用线上的；
 *   线上匹配不上 / 源不可用 / 超时 ⇒ **回落本地**（NAS 自带的歌词）；
 * - `local-first`：**本地优先** —— NAS 自带的歌词先用，NAS 没有才查外部
 *   （Task 32 的老口径）。
 *
 * ⚠️ **缺省 = `online-first`**（用户显式要求）⇒ 老用户升级后行为**会变**。
 */
export type LyricPriority = 'online-first' | 'local-first'

/**
 * 歌词来源偏好（落在主进程 `prefs.json` 的 `lyric` 键下）。
 *
 * ⚠️ **非敏感**：源名与地址模板都是公开信息，与 `session.bin`（凭证）**无关**。
 */
export interface LyricPrefs {
  /**
   * 用哪个源；缺省 = `netease`。
   *
   * ⚠️ `prefs.json` 是**用户可编辑的文件** → 陌生值一律丢弃（不落盘）。
   */
  source?: LyricSource
  /**
   * `source = 'custom'` 时的 **URL 模板**。
   *
   * 支持的占位符：`{title}` `{artist}` `{album}` `{duration}`。
   * ⚠️ 必须是 **https**（回环主机才允许 `http`）；**不许**带 `user:pass@`。
   * ⚠️ 响应体必须**是纯文本 LRC**（含 `[mm:ss` 时间戳）——纯文本歌词
   *    没有时间戳，解析出来是空的。
   */
  template?: string
  /**
   * 歌词来源的**优先级**（T70）：`online-first`（线上优先，缺省）/ `local-first`（本地优先）。
   *
   * ⚠️ **只有合法值才落盘**（主进程白名单）：`prefs.json` 是用户可编辑的文件，
   *    写进去的陌生值一律丢弃 → 读回来时按「线上优先」处理。
   */
  priority?: LyricPriority
}

// ---------------------------------------------------------------------------
// IPC 契约
// ---------------------------------------------------------------------------

/**
 * 查外部歌词的入参（渲染层 → 主进程）。
 *
 * ⚠️ **只有这四个字段**，且都必须是标量 —— 主进程据此去外部源匹配。
 */
export interface ExternalLyricQuery {
  /** 歌名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 专辑名（可能为空串）。 */
  album: string
  /** 歌曲时长（**秒**）。用于排除同名不同版本的错配。 */
  duration: number
}

/**
 * 外部歌词的结果（主进程 → 渲染层）。
 *
 * ⚠️ 主进程**只回 LRC 原文与翻译**，不回领域对象 ——
 *    由渲染层包成 `LyricEntry[]` 后交给**现有**的 `parseLyricEntries`
 *    （翻译合并 / 冗余副本去重 / 伪逐字降级全都白拿，解析逻辑一行不改）。
 */
export type ExternalLyricResult =
  /** 找到了歌词。 */
  | {
      status: 'ok'
      /** 实际用的源。 */
      source: LyricSource
      /** 原文 LRC（可能为空串）。 */
      original: string
      /** 翻译 LRC（**可能为空串** —— 很多歌没有翻译）。 */
      translation: string
      /**
       * 罗马音 LRC（**可选** —— 只有网易云 / QQ 给罗马音，酷狗 / 酷我 / 咪咕没有）。
       *
       * ⚠️ **可选字段、不是必填**（T90-③）：既有代码与既有测试**手写**的是
       *    `{ status, source, original, translation }` ⇒ 必填会让它们**全部编译不过**
       *    ⇒ 违反「既有测试一条不许改」的硬约束。
       * ⚠️ 缺省 / 空串 ⇒ **没有罗马音** ⇒ 渲染层**不渲染**第三行。
       */
      romanization?: string
    }
  /** 外部源**确实没有**这首歌的歌词（不是错误）。 */
  | { status: 'not-found' }
  /** 外部源**不可用**（网络 / 地址不合法 / 响应不对）。 */
  | { status: 'error'; message: string }

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 合法的歌词源（**白名单**）。 */
export const LYRIC_SOURCES: readonly LyricSource[] = [
  'off',
  'netease',
  'lrclib',
  'qq',
  'kugou',
  'kuwo',
  'custom',
]

/**
 * 默认的歌词源。
 *
 * ⚠️ 默认 **网易云**（实测国内最快：搜索 18–235ms、歌词 31–41ms、10/10 全绿）。
 * ⚠️ 但它是**非官方**公开接口 → 用户可以在设置里一键切成 lrclib 或自定义模板。
 */
export const DEFAULT_LYRIC_SOURCE: LyricSource = 'netease'

/** 合法的歌词优先级（**白名单**）。 */
export const LYRIC_PRIORITIES: readonly LyricPriority[] = ['online-first', 'local-first']

/**
 * 缺省的歌词优先级（T70）：**线上优先**。
 *
 * ⚠️ 用户显式要求：「优先使用线上歌词，线上匹配不上再使用本地歌词」。
 */
export const DEFAULT_LYRIC_PRIORITY: LyricPriority = 'online-first'

/**
 * 把任意输入归一成**合法的歌词源**。
 *
 * ⚠️ `prefs.json` 是**用户可编辑的文件** → 陌生值一律当默认值
 *    （与 `normalizePlayMode` / `resolveThemeName` 同一套纪律）。
 *
 * @param value 任意值。
 * @returns 合法时返回该源；否则返回 `DEFAULT_LYRIC_SOURCE`。
 */
export function normalizeLyricSource(value: unknown): LyricSource {
  if (typeof value === 'string' && (LYRIC_SOURCES as readonly string[]).includes(value)) {
    return value as LyricSource
  }
  return DEFAULT_LYRIC_SOURCE
}

/**
 * 把任意输入归一成**合法的歌词优先级**。
 *
 * ⚠️ `prefs.json` 是**用户可编辑的文件** → 陌生值一律当默认值
 *    （与 `normalizeLyricSource` 同一套纪律）。
 *
 * @param value 任意值。
 * @returns 合法时返回该优先级；否则返回 `DEFAULT_LYRIC_PRIORITY`。
 */
export function normalizeLyricPriority(value: unknown): LyricPriority {
  if (typeof value === 'string' && (LYRIC_PRIORITIES as readonly string[]).includes(value)) {
    return value as LyricPriority
  }
  return DEFAULT_LYRIC_PRIORITY
}

/**
 * 把任意输入归一成**合法的模板字符串**。
 *
 * ⚠️ 只做「是不是字符串」的判断 —— 模板的**合法性**（https / 占位符 / 无凭证）
 *    由主进程在**真正用的时候**校验（`electron/lyricProvider.ts` 的
 *    `validateLyricTemplate`），因为那里才有最终的判断权。
 */
export function normalizeLyricTemplate(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
