// ---------------------------------------------------------------------------
// 外部歌词 API（Task 32）—— 主进程侧
// ---------------------------------------------------------------------------
//
// 这个模块回答一个问题：**「NAS 没有歌词时，去哪儿再找一份？」**
//
// ---------------------------------------------------------------------------
// 为什么全在主进程
// ---------------------------------------------------------------------------
// 安全边界（不可放宽）：
// - **渲染层永远不直接发网络请求** → 外部歌词的抓取**全在主进程**，
//   渲染层只发 IPC 请求、只收结果（与自动更新 Task 23 同一套纪律）；
// - 走**已有的 Chromium 分区栈**（`electron/http.ts`）——
//   外部歌词源**不在** `TrustedHosts` 里 → 该分区对它的证书校验是 `-3`
//   （交回 Chromium 默认校验）→ **自签证书不会被放行**，歌词源必须用正规证书；
// - ⚠️ **绝不附带 NAS 的凭证**：本模块用的是**干净的**分区栈
//   （不附 token / Cookie）→ 第三方歌词源**看不到** NAS 的任何凭证。
//
// ---------------------------------------------------------------------------
// 模块约束（与 `electron/update.ts` 同一套纪律）
// ---------------------------------------------------------------------------
// - **模块顶层不得 import Electron**：本文件要能在 Vitest（普通 Node）里直接单测，
//   而非 Electron 进程里 `require('electron')` 返回的是可执行文件路径字符串。
//   故 fetch 走**注入**（`opts.fetchImpl`），由 IPC 层把 `httpStack.fetch` 塞进来。
// - **不引入新依赖**：只用标准 Web API。
//
// ---------------------------------------------------------------------------
// 实测依据（2026-11-04，本机真打）
// ---------------------------------------------------------------------------
// | 源                | 搜索             | 歌词               | 稳定性   |
// |-------------------|------------------|--------------------|----------|
// | 网易云（默认）    | 200，18–235ms    | 200，31–41ms，带时间戳 | 10/10 全绿 |
// | lrclib.net（备选）| 200，366–1300ms  | —                  | **偶发 503** |
// | QQ 音乐（T33）    | 200，**814ms**   | 200，**70ms**，明文 LRC + 翻译 | 通（内置备选）|
//
// ⚠️ 网易云 / QQ 都是**非官方**公开 Web 接口：没有 SLA、条款上属灰色、接口可能变更。
//    ⇒ **不押注一家**：默认网易云（国内最快），内置 lrclib 可切，
//      再留 `custom`（URL 模板）给自建实例。
//
// ---------------------------------------------------------------------------

import type {
  ExternalLyricQuery,
  ExternalLyricResult,
  LyricSource,
} from '../shared/lyricProvider'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 网易云搜索接口（公开 Web 接口，**非官方**）。 */
const NETEASE_SEARCH_URL = 'https://music.163.com/api/search/get/web'

/** 网易云歌词接口（公开 Web 接口，**非官方**）。 */
const NETEASE_LYRIC_URL = 'https://music.163.com/api/song/lyric'

/** lrclib 的精确匹配接口。 */
const LRCLIB_GET_URL = 'https://lrclib.net/api/get'

/** lrclib 的模糊搜索接口。 */
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search'

/** QQ 音乐搜索接口（公开 Web 接口，**非官方**）。 */
const QQ_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'

/** QQ 音乐歌词接口（公开 Web 接口，**非官方**；返回**明文** LRC + 翻译）。 */
const QQ_LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'

/**
 * 时长容差（**秒**）。
 *
 * ⚠️ 同名歌很多（实测《占位曲目一》有 4 个版本）→ 不比时长就会拿到**别的版本**的歌词。
 * ⚠️ 各源的时长精度不同（网易云是毫秒、lrclib 是浮点秒），故容差取 3 秒。
 */
export const DURATION_TOLERANCE_SECONDS = 3

/** 失败结果的缓存时长（**毫秒**）—— 防止连续切歌把外部源打爆。 */
export const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000

/** 成功结果的缓存条数上限（LRU）。 */
export const SUCCESS_CACHE_LIMIT = 64

/** 用户代理（部分公开接口会拒绝没有 UA 的请求）。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把任意异常压成一句人话。 */
function readableError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** 取对象（不是对象 → `null`）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

/** 取非空字符串（不是字符串 / 空串 → `null`）。 */
function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * 剥掉搜索结果里的 **HTML 高亮标签**。
 *
 * ⚠️ QQ 音乐会把命中的关键词包在 `<em>` 里（实测 `albumname_hilight` 是
 *    `<em>占位曲目五</em>`）→ 不剥掉就**永远匹配不上**查询的歌名。
 *
 * @param text 原始文本。
 * @returns 去掉标签并 trim 后的文本。
 */
export function stripHighlightTags(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim()
}

/**
 * 尽力把一段文本**还原**成 LRC（base64 兜底）。
 *
 * ⚠️ QQ 的 `nobase64=1` 实测返回**明文**；但万一哪天它失效、开始返回 base64，
 *    明文就会被当成「不是 LRC」→ 白白丢一份**能用的**歌词。
 *    → 这里做一次兜底解码（base64 → UTF-8）。
 *
 * ⚠️ 只用 **Web API**（`atob` + `TextDecoder`），不碰 Node 专属全局 →
 *    本模块哪天被渲染层复用也不会炸。
 *
 * @param text 原始文本。
 * @returns 解码后的文本；不是 base64 或解码失败时**原样返回**。
 */
export function decodeMaybeBase64(text: string): string {
  const trimmed = text.trim()
  // base64 只可能由这些字符组成；明文 LRC 一定含 `[` / `:` → 会被这里挡住。
  if (trimmed === '' || !/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return text
  try {
    const binary = atob(trimmed)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const decoded = new TextDecoder('utf-8').decode(bytes)
    return decoded.includes('[') ? decoded : text
  } catch {
    return text
  }
}

/** 回环主机（本地自测用的歌词源）。 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

// ---------------------------------------------------------------------------
// 网易云 yrc（真逐字）→ 增强 LRC（T67）
// ---------------------------------------------------------------------------
//
// 为什么要有它
// ---------------------------------------------------------------------------
// 官方飞牛 APP 与 Lyricify 这类工具拿到的**逐字**歌词（enhanced LRC / yrc / qrc），
// 才有**真的跟嘴**的卡拉OK 填色。我们此前只有**行级** LRC ⇒ 逐字是**推算**的。
//
// 网易云的 `yrc` 字段就是**真逐字**（实测 2026-11-06，匿名请求）：
//
//     [行开始ms,行时长ms](词开始ms,词时长ms,0)词文本(词开始ms,词时长ms,0)词文本
//
// - 词时间是**绝对毫秒**（从歌开头算起），**跨行连续递增**；
// - 词元组**之间没有分隔符**；
// - **词时长可以为 0**（标点 / 停顿占位）。
//
// ⇒ 这里把它转成**标准增强 LRC**（`<mm:ss.xx>` 逐字标签），
//   交给**现有**解析器（`parseWordSegments` 早就在等喂）⇒ **渲染层零改动**。
// ---------------------------------------------------------------------------

/**
 * yrc 的**词元组**：`(开始ms, 时长ms, 0)`。
 *
 * ⚠️ **只认数字形状**的元组 ⇒ 词文本里含 `(` / `)` 也不会错位
 *    （实测样本的词文本里就有标点）。
 */
const YRC_WORD_PATTERN = /\((-?\d+),(-?\d+),(-?\d+)\)/g

/**
 * 毫秒 → LRC 时间标签。
 *
 * - 整除 10 ⇒ 用**厘秒**（`[mm:ss.xx]`），否则用**毫秒**（`[mm:ss.xxx]`）
 *   ⇒ **既短又不丢精度**（实测 yrc 的时间基本都是 10 的倍数）。
 */
function msToLrcTag(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const rest = total % 1000
  const fraction =
    rest % 10 === 0 ? String(rest / 10).padStart(2, '0') : String(rest).padStart(3, '0')
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fraction}`
}

/**
 * 把网易云的 **yrc（真逐字）** 转成**增强 LRC**（`<mm:ss.xx>` 逐字标签）。
 *
 * **规则（定死）**：
 * 1. **逐行**扫描；行头用 `^\[(\d+),(\d+)\]` 取「行开始 ms」；
 * 2. 行内按**顺序扫描**找词元组（只认数字形状）⇒ 词文本里的括号**不会错位**；
 * 3. 每个词 → `<mm:ss.xx>`（词开始 ms）+ **原样**的词文本
 *    （**不 trim 词内的空格**：英文歌的词间空格要靠它；
 *    渲染层的整行底层文本本来就会保留空格）；
 * 4. **零时长词**（实测是标点 / 停顿占位）→ **并入前一个词**，不单独成词
 *    （没有前词可并 ⇒ 丢弃）；
 * 5. 词开始早于行开始（异常数据）→ **钳到行开始**；
 * 6. 一行里**没有有效词** → **跳过该行**（不产生歌词行）；
 * 7. 空串 / 非串 → 返回空串（**不抛异常**）。
 *
 * @returns 标准增强 LRC（多行，行间 `\n`）。
 */
export function yrcToEnhancedLrc(yrc: string): string {
  if (typeof yrc !== 'string' || yrc === '') return ''
  const out: string[] = []
  for (const rawLine of yrc.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const head = /^\[(\d+),(\d+)\]/.exec(line)
    if (!head) continue
    const lineStart = Number(head[1])
    const rest = line.slice(head[0].length)

    // 行内按**顺序扫描**找词元组（只认数字形状 ⇒ 词文本里的括号不会错位）。
    const pattern = new RegExp(YRC_WORD_PATTERN.source, 'g')
    const marks: { start: number; dur: number; from: number; to: number }[] = []
    let match: RegExpExecArray | null
    while ((match = pattern.exec(rest)) !== null) {
      marks.push({
        start: Number(match[1]),
        dur: Number(match[2]),
        from: match.index + match[0].length,
        to: match.index,
      })
    }
    if (!marks.length) continue

    // 零时长词**并入前一个词**（实测是标点 / 停顿占位），不单独成词。
    const words: { start: number; text: string }[] = []
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i]!
      const textEnd = i + 1 < marks.length ? marks[i + 1]!.to : rest.length
      const text = rest.slice(mark.from, textEnd)
      if (mark.dur === 0) {
        const previous = words[words.length - 1]
        if (previous) previous.text += text
        continue
      }
      words.push({ start: Math.max(lineStart, mark.start), text })
    }
    if (!words.length) continue

    // 第一个词元组**之前**的文本（实测通常为空）→ 放在行标签之后
    //    ⇒ 渲染层的 `parseWordSegments` 会把它当成该行的首段。
    const leading = rest.slice(0, marks[0]!.to).trim()
    const body = words.map((word) => `<${msToLrcTag(word.start)}>${word.text}`).join('')
    out.push(`[${msToLrcTag(lineStart)}]${leading}${body}`)
  }
  return out.join('\n')
}

/**
 * 判断一段文本**是不是 LRC**（含 `[mm:ss` 或 `[mm:ss.xx` 时间戳）。
 *
 * ⚠️ **必须判**：纯文本歌词（没有时间戳）交给解析器会得到**空数组**
 *    → 界面上等于「暂无歌词」，用户会以为歌词源坏了。
 */
export function looksLikeLrc(text: string): boolean {
  return /\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(text)
}

// ---------------------------------------------------------------------------
// 地址校验与模板渲染
// ---------------------------------------------------------------------------

/**
 * 校验用户填的**歌词 API 模板**。
 *
 * ⚠️ 规则（**不可放宽**）：
 * - 必须是 `https:`；`http:` **只**允许回环主机（本地自测）；
 * - **不许**带 `user:pass@`（URL 里绝不能有凭证）；
 * - 必须有**占位符**（否则每首歌都查同一个地址，必然错）。
 *
 * @returns 合法时返回解析后的 URL；不合法返回 `null`。
 */
export function validateLyricTemplate(raw: string): URL | null {
  const text = raw.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null
  if (url.username !== '' || url.password !== '') return null
  if (!/\{(title|artist|album|duration)\}/.test(text)) return null
  return url
}

/**
 * 把模板里的占位符换成实际值。
 *
 * ⚠️ 替换后的值一律 **`encodeURIComponent`** —— 歌名里有 `&`、`#`、空格是常事，
 *    不转义会把 URL 拆坏（甚至被当成别的参数）。
 *
 * @returns 渲染后的 URL 字符串；模板不合法时返回 `null`。
 */
export function renderLyricTemplate(template: string, query: ExternalLyricQuery): string | null {
  if (!validateLyricTemplate(template)) return null
  const values: Record<string, string> = {
    title: query.title,
    artist: query.artist,
    album: query.album,
    duration: String(query.duration),
  }
  const rendered = template.replace(/\{(title|artist|album|duration)\}/g, (_all, key: string) =>
    encodeURIComponent(values[key] ?? ''),
  )
  try {
    return new URL(rendered).toString()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 候选挑选
// ---------------------------------------------------------------------------

/** 一个候选（外部源搜出来的歌）。 */
interface Candidate {
  /** 源内部的歌曲 id。 */
  id: string
  /** 歌名。 */
  title: string
  /** 歌手名。 */
  artist: string
  /** 时长（**秒**）。 */
  duration: number
}

/** 名字是否「算同一个」（忽略大小写、空白与常见修饰）。 */
function sameName(a: string, b: string): boolean {
  const norm = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[\s·・\-_()（）《》"'`,.!?！？]/g, '')
  return norm(a) === norm(b)
}

/**
 * 从候选里挑**最可能**是这首歌的那一条。
 *
 * ⚠️ 顺序很重要：
 * 1. 先按**歌名**完全相同筛掉「同名的别的歌」；
 * 2. 再按**歌手**相同筛掉「同名不同歌手」（翻唱 / 组合）；
 * 3. 最后按**时长**（±3s）筛掉「同一歌手的别的版本」（Live / Remix）。
 *
 * ⚠️ 时长筛**过严**时（各源时长口径不同）会误杀 → 故先在「名字+歌手都对」的
 *    候选里按时长挑；全都对不上时长就退回「名字+歌手都对」的第一条。
 *
 * @returns 选中的候选；没有合适的返回 `null`。
 */
export function pickCandidate(
  candidates: Candidate[],
  query: ExternalLyricQuery,
  tolerance: number = DURATION_TOLERANCE_SECONDS,
): Candidate | null {
  if (!candidates.length) return null
  const byTitle = candidates.filter((item) => sameName(item.title, query.title))
  const pool = byTitle.length ? byTitle : candidates
  const byArtist = pool.filter((item) => sameName(item.artist, query.artist))
  const named = byArtist.length ? byArtist : pool
  if (query.duration > 0) {
    const timed = named.filter(
      (item) => item.duration > 0 && Math.abs(item.duration - query.duration) <= tolerance,
    )
    if (timed.length) return timed[0]!
  }
  return named[0] ?? null
}

// ---------------------------------------------------------------------------
// 网易云适配器
// ---------------------------------------------------------------------------

/** 网易云搜索响应里的一首歌。 */
interface NeteaseSong {
  id?: unknown
  name?: unknown
  duration?: unknown
  artists?: unknown
  album?: unknown
}

/** 把网易云的搜索结果读成候选列表。 */
function readNeteaseCandidates(payload: unknown): Candidate[] {
  const root = asRecord(payload)
  const songs = root?.['result']
  const list = asRecord(songs)?.['songs']
  if (!Array.isArray(list)) return []
  const out: Candidate[] = []
  for (const raw of list) {
    const song = asRecord(raw) as NeteaseSong | null
    if (!song) continue
    // ⚠️ 网易云的 `id` 是**数字**（实测 `222`），不是字符串 → 两种都要认。
    const id =
      readString(song.id) ?? (typeof song.id === 'number' && Number.isFinite(song.id) ? String(song.id) : null)
    const name = readString(song.name)
    if (!id || !name) continue
    const artists = Array.isArray(song.artists) ? song.artists : []
    const artistName = readString(asRecord(artists[0])?.['name']) ?? ''
    const durationMs = typeof song.duration === 'number' && Number.isFinite(song.duration) ? song.duration : 0
    out.push({ id, title: name, artist: artistName, duration: durationMs / 1000 })
  }
  return out
}

/** 网易云歌词响应。 */
interface NeteaseLyricPayload {
  lrc?: { lyric?: unknown }
  tlyric?: { lyric?: unknown }
  /**
   * **逐字**歌词（yrc）。
   *
   * ⚠️ **必须请求 `yv=-1` 才有**（实测：带 → 有；不带 → 根本没有这个字段）。
   * ⚠️ 形状实测 = `{ version, lyric }`。
   */
  yrc?: { lyric?: unknown }
}

/**
 * 走网易云取歌词。
 *
 * ⚠️ **原文与翻译分两个字段**（`lrc.lyric` / `tlyric.lyric`）→ 正好对应
 *    渲染层要的两条 `LyricEntry`（原文 + 翻译）→ 现有解析器自动出双语。
 */
async function fetchNetease(
  fetchImpl: FetchLike,
  query: ExternalLyricQuery,
): Promise<ExternalLyricResult> {
  const keyword = [query.title, query.artist].filter((part) => part.trim() !== '').join(' ')
  const searchUrl = `${NETEASE_SEARCH_URL}?csrf_token=&type=1&offset=0&total=true&limit=10&s=${encodeURIComponent(keyword)}`
  const searchRes = await fetchImpl(searchUrl, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
  if (!searchRes.ok) {
    return { status: 'error', message: `网易云搜索返回 ${searchRes.status}` }
  }
  const searchText = await searchRes.text()
  let searchPayload: unknown
  try {
    searchPayload = JSON.parse(searchText) as unknown
  } catch {
    return { status: 'error', message: '网易云搜索返回的不是 JSON' }
  }
  const candidate = pickCandidate(readNeteaseCandidates(searchPayload), query)
  if (!candidate) return { status: 'not-found' }

  // ⚠️ `yv=-1` = **要逐字**（yrc）。实测：不带这个参数，网易云**根本不会**回 yrc 字段。
  const lyricRes = await fetchImpl(
    `${NETEASE_LYRIC_URL}?id=${encodeURIComponent(candidate.id)}&lv=1&kv=1&tv=-1&yv=-1`,
    {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    },
  )
  if (!lyricRes.ok) {
    return { status: 'error', message: `网易云歌词返回 ${lyricRes.status}` }
  }
  const lyricText = await lyricRes.text()
  let lyricPayload: NeteaseLyricPayload
  try {
    lyricPayload = JSON.parse(lyricText) as NeteaseLyricPayload
  } catch {
    return { status: 'error', message: '网易云歌词返回的不是 JSON' }
  }
  const translation = typeof lyricPayload.tlyric?.lyric === 'string' ? lyricPayload.tlyric.lyric : ''
  // ⚠️ **逐字优先**（T67）：有 yrc 就用它（真逐字 ⇒ 卡拉OK 填色真的跟嘴）；
  //    没有 yrc ⇒ 回退行级 lrc（**行为与本任务之前一字不变**）。
  //    ⚠️ yrc 畸形（转换出空串）⇒ **回退 lrc**，不因此丢掉整首歌。
  const yrc = typeof lyricPayload.yrc?.lyric === 'string' ? lyricPayload.yrc.lyric : ''
  const lrc = typeof lyricPayload.lrc?.lyric === 'string' ? lyricPayload.lrc.lyric : ''
  const original = yrc ? yrcToEnhancedLrc(yrc) || lrc : lrc
  if (!looksLikeLrc(original)) return { status: 'not-found' }
  return { status: 'ok', source: 'netease', original, translation }
}

// ---------------------------------------------------------------------------
// lrclib 适配器
// ---------------------------------------------------------------------------

/** lrclib 的一条结果。 */
interface LrclibEntry {
  trackName?: unknown
  artistName?: unknown
  duration?: unknown
  syncedLyrics?: unknown
  plainLyrics?: unknown
}

/**
 * 走 lrclib 取歌词。
 *
 * ⚠️ `syncedLyrics`（带时间戳）与 `plainLyrics`（纯文本）是**同一首歌的两种格式**，
 *    **不是**原文与翻译 → 只能取其一（优先带时间戳的），
 *    **绝不**当成两条记录丢给解析器（否则同一句会显示两遍 —— T31 的坑）。
 */
async function fetchLrclib(
  fetchImpl: FetchLike,
  query: ExternalLyricQuery,
): Promise<ExternalLyricResult> {
  const params = new URLSearchParams({
    track_name: query.title,
    artist_name: query.artist,
  })
  if (query.duration > 0) params.set('duration', String(Math.round(query.duration)))
  const getRes = await fetchImpl(`${LRCLIB_GET_URL}?${params.toString()}`, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  })
  if (getRes.ok) {
    const text = await getRes.text()
    try {
      const payload = JSON.parse(text) as LrclibEntry
      const synced = typeof payload.syncedLyrics === 'string' ? payload.syncedLyrics : ''
      const content = looksLikeLrc(synced) ? synced : ''
      if (content) return { status: 'ok', source: 'lrclib', original: content, translation: '' }
      // ⚠️ 精确匹配到但**没有带时间戳的歌词** → `plainLyrics` 是**纯文本**，
      //    没有时间戳、解析出来是空的 → 如实报「没找到」，
      //    别把纯文本硬塞进去（那等于给用户一个「什么都没有」的界面）。
    } catch {
      return { status: 'error', message: 'lrclib 返回的不是 JSON' }
    }
  } else if (getRes.status !== 404) {
    return { status: 'error', message: `lrclib 返回 ${getRes.status}` }
  }

  // 精确匹配没有 → 模糊搜索。
  const searchParams = new URLSearchParams({
    track_name: query.title,
    artist_name: query.artist,
    q: [query.title, query.artist].filter((part) => part.trim() !== '').join(' '),
  })
  const searchRes = await fetchImpl(`${LRCLIB_SEARCH_URL}?${searchParams.toString()}`, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  })
  if (!searchRes.ok) {
    // ⚠️ 404 = **确实没有**（不是错误）→ 如实报「没找到」。
    if (searchRes.status === 404) return { status: 'not-found' }
    return { status: 'error', message: `lrclib 搜索返回 ${searchRes.status}` }
  }
  const searchText = await searchRes.text()
  let list: unknown
  try {
    list = JSON.parse(searchText) as unknown
  } catch {
    return { status: 'error', message: 'lrclib 搜索返回的不是 JSON' }
  }
  if (!Array.isArray(list)) return { status: 'not-found' }
  const candidates: Candidate[] = []
  const contents = new Map<string, string>()
  for (const raw of list) {
    const item = asRecord(raw) as LrclibEntry | null
    if (!item) continue
    const trackName = readString(item.trackName)
    const artistName = readString(item.artistName) ?? ''
    if (!trackName) continue
    const duration =
      typeof item.duration === 'number' && Number.isFinite(item.duration) ? item.duration : 0
    const key = `${trackName}|${artistName}|${duration}`
    candidates.push({ id: key, title: trackName, artist: artistName, duration })
    const synced = typeof item.syncedLyrics === 'string' ? item.syncedLyrics : ''
    if (looksLikeLrc(synced)) contents.set(key, synced)
  }
  const picked = pickCandidate(candidates, query)
  if (!picked) return { status: 'not-found' }
  const content = contents.get(picked.id)
  if (!content) return { status: 'not-found' }
  return { status: 'ok', source: 'lrclib', original: content, translation: '' }
}

// ---------------------------------------------------------------------------
// QQ 音乐适配器（T33）
// ---------------------------------------------------------------------------
//
// Lyricify（Fusion）**没有**可供第三方调用的公开歌词 API：它的「歌词源」是**客户端
// 内置**的，而官方开源库 `WXRIW/Lyricify-Lyrics-Helper`（Apache-2.0）的**访问凭据表**
// 写明——QQ 音乐 / 网易云 / 酷狗 / 汽水 / LRCLIB **免凭据**，Apple Music / Musixmatch /
// Spotify 才要 token。
//
// ⇒ 本适配器接的是**与 Lyricify 同款的免凭据词源**，**不需要任何账号 / token**。
//
// ⚠️ 端点选择的坑（2026-11-04 本机真打）：
// - `client_search_cv` / `song.fcg` / `search_client_cp` → **404 已下线**；
// - `u.y.qq.com` 的 `music.search.SearchCgiService` → `code: 500001`；
// - `u.y.qq.com` 的 `DoSearchForQQMusicDesktop` → 200 但**列表为空**；
// - ✅ 唯一可用：`c.y.qq.com/soso/fcgi-bin/client_search_cp`（200 / 814ms）。
//
// ⚠️ QQ 的歌词是**明文 LRC**（带 base64 时也只是**传输编码**，**不是加密**）
//    → **零解密成本**；但该端点**不返回 `qrc`** → **拿不到逐字**（逐字在
//    `u.y.qq.com` 的 `PlayLyricInfo`，`qrc` 是**密文**）。
//
// ⚠️ **歌词端点强制要求 `Referer`**（**搜索端点不要求**）：带 → `retcode=0`；
//    不带 → **`retcode=-1310`**、歌词长度 0 → **静默失败**（HTTP 仍是 200）。
//    ⇒ 那个 `referer` 头是**必需的**。已在**真实 Electron 主进程**里验过：
//    `session.fetch` **会保留** `Referer`（不带 → `retcode=-1310`）。

/** QQ 音乐搜索结果里的一首歌。 */
interface QqSong {
  songmid?: unknown
  songname?: unknown
  albumname?: unknown
  interval?: unknown
  singer?: unknown
}

/** 把 QQ 音乐的搜索结果读成候选列表。 */
function readQqCandidates(payload: unknown): Candidate[] {
  const root = asRecord(payload)
  const data = asRecord(root?.['data'])
  const song = asRecord(data?.['song'])
  const list = song?.['list']
  if (!Array.isArray(list)) return []
  const out: Candidate[] = []
  for (const raw of list) {
    const item = asRecord(raw) as QqSong | null
    if (!item) continue
    const id = readString(item.songmid)
    // ⚠️ 歌名可能带 `<em>` 高亮标签 → **必须剥掉**，否则永远匹配不上。
    const title = typeof item.songname === 'string' ? stripHighlightTags(item.songname) : ''
    if (!id || !title) continue
    const singers = Array.isArray(item.singer) ? item.singer : []
    const names: string[] = []
    for (const entry of singers) {
      const name = readString(asRecord(entry)?.['name'])
      if (name) names.push(name)
    }
    // ⚠️ QQ 的 `interval` 是**秒**（实测《占位曲目五》= 256，对应 4:16）
    //    → 与 `pickCandidate` 的口径**一致**，**不需要**除以 1000。
    const duration =
      typeof item.interval === 'number' && Number.isFinite(item.interval) ? item.interval : 0
    out.push({ id, title, artist: names.join(','), duration })
  }
  return out
}

/**
 * 走 QQ 音乐取歌词。
 *
 * ⚠️ **原文与翻译分两个字段**（`lyric` / `trans`）→ 与网易云同构，
 *    渲染层自动出双语。
 */
async function fetchQq(
  fetchImpl: FetchLike,
  query: ExternalLyricQuery,
): Promise<ExternalLyricResult> {
  const keyword = [query.title, query.artist].filter((part) => part.trim() !== '').join(' ')
  const searchUrl = `${QQ_SEARCH_URL}?p=1&n=10&format=json&w=${encodeURIComponent(keyword)}`
  const searchRes = await fetchImpl(searchUrl, {
    headers: {
      accept: 'application/json',
      referer: 'https://y.qq.com/',
      'user-agent': USER_AGENT,
    },
  })
  if (!searchRes.ok) {
    return { status: 'error', message: `QQ 音乐搜索返回 ${searchRes.status}` }
  }
  const searchText = await searchRes.text()
  let searchPayload: unknown
  try {
    searchPayload = JSON.parse(searchText) as unknown
  } catch {
    return { status: 'error', message: 'QQ 音乐搜索返回的不是 JSON' }
  }
  const candidate = pickCandidate(readQqCandidates(searchPayload), query)
  if (!candidate) return { status: 'not-found' }

  const lyricRes = await fetchImpl(
    `${QQ_LYRIC_URL}?songmid=${encodeURIComponent(candidate.id)}&format=json&nobase64=1`,
    {
      headers: {
        accept: 'application/json',
        referer: 'https://y.qq.com/',
        'user-agent': USER_AGENT,
      },
    },
  )
  if (!lyricRes.ok) {
    return { status: 'error', message: `QQ 音乐歌词返回 ${lyricRes.status}` }
  }
  const lyricText = await lyricRes.text()
  let lyricPayload: { retcode?: unknown; lyric?: unknown; trans?: unknown }
  try {
    lyricPayload = JSON.parse(lyricText) as { retcode?: unknown; lyric?: unknown; trans?: unknown }
  } catch {
    return { status: 'error', message: 'QQ 音乐歌词返回的不是 JSON' }
  }
  // ⚠️ **`retcode` 非 0 = 源本身报错**（实测 `-1310` = 缺少 `Referer` → HTTP 仍是 **200**，
  //    但歌词长度 0 → **静默失败**）。此时**如实报「源不可用」**，别报「确实没有」，
  //    否则用户会以为这首歌就是没歌词。
  const retcode = typeof lyricPayload.retcode === 'number' ? lyricPayload.retcode : 0
  if (retcode !== 0) {
    return { status: 'error', message: `QQ 音乐歌词返回错误码 ${retcode}` }
  }
  const original = decodeMaybeBase64(
    typeof lyricPayload.lyric === 'string' ? lyricPayload.lyric : '',
  )
  const translation = decodeMaybeBase64(
    typeof lyricPayload.trans === 'string' ? lyricPayload.trans : '',
  )
  // ⚠️ 纯文本歌词（没有时间戳）交给解析器会得到**空数组** → 如实报「没找到」。
  if (!looksLikeLrc(original)) return { status: 'not-found' }
  return { status: 'ok', source: 'qq', original, translation }
}

// ---------------------------------------------------------------------------
// 自定义模板适配器
// ---------------------------------------------------------------------------

/** 走用户自配的 URL 模板取歌词（响应体必须是**纯文本 LRC**）。 */
async function fetchCustom(
  fetchImpl: FetchLike,
  template: string,
  query: ExternalLyricQuery,
): Promise<ExternalLyricResult> {
  const url = renderLyricTemplate(template, query)
  if (!url) {
    return {
      status: 'error',
      message: '歌词 API 模板不合法：必须是 https（回环才 http）、不许带凭证、且必须含 {title} 等占位符',
    }
  }
  const res = await fetchImpl(url, { headers: { accept: 'text/plain', 'user-agent': USER_AGENT } })
  if (!res.ok) return { status: 'error', message: `歌词 API 返回 ${res.status}` }
  const text = await res.text()
  if (!looksLikeLrc(text)) {
    return { status: 'error', message: '歌词 API 返回的不是 LRC（正文里没有 [mm:ss 时间戳）' }
  }
  return { status: 'ok', source: 'custom', original: text, translation: '' }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** 注入的 fetch（主进程里是 `httpStack.fetch`）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** `createLyricProvider` 的参数。 */
export interface LyricProviderOptions {
  /** 抓取用的 fetch（**干净分区栈**，不带 NAS 凭证）。 */
  fetchImpl: FetchLike
  /** 现在的时刻（毫秒）；单测可注入以验证缓存过期。 */
  now?: () => number
}

/** 歌词源提供器。 */
export interface LyricProvider {
  /**
   * 查外部歌词。
   *
   * @param source 用哪个源（`off` → 直接返回 `not-found`，**不出网**）。
   * @param template `source = 'custom'` 时的 URL 模板。
   * @param query 歌名 / 歌手 / 专辑 / 时长。
   */
  fetchExternalLyric(
    source: LyricSource,
    template: string,
    query: ExternalLyricQuery,
  ): Promise<ExternalLyricResult>
}

/** 缓存里的一条。 */
interface CacheEntry {
  at: number
  result: ExternalLyricResult
}

/**
 * 创建一个歌词源提供器。
 *
 * ⚠️ **缓存策略**：
 * - 成功结果 → 一直留（LRU，上限 64 条）→ 反复切同一首歌**不重复打**外部源；
 * - 失败结果 → 留 5 分钟 → 连续切歌**不会**把外部源打爆。
 *
 * ⚠️ **实例级缓存**（不是模块级）→ 单测之间不会互相污染。
 */
export function createLyricProvider(opts: LyricProviderOptions): LyricProvider {
  const now = opts.now ?? ((): number => Date.now())
  const cache = new Map<string, CacheEntry>()

  /** 缓存的键。 */
  function cacheKey(source: LyricSource, query: ExternalLyricQuery, template: string): string {
    // ⚠️ **自定义源必须把「模板」算进键里**（T34 修）：
    //    同一个源、同一个歌，但**模板不同**就是**完全不同的接口**
    //    （可以指向另一个词源、另一种返回格式）→ 不算进键里的话，
    //    用户在设置里换了模板/换了源，**拿到的还是上一个源的旧歌词**
    //    （E2E 实测撞过：同一首歌、只换模板 → 拿回来的仍是旧模板的结果）。
    return [
      source,
      source === 'custom' ? template : '',
      query.title,
      query.artist,
      query.album,
      Math.round(query.duration),
    ].join('|')
  }

  /** 读缓存（过期的失败结果视为没有）。 */
  function readCache(key: string): ExternalLyricResult | null {
    const hit = cache.get(key)
    if (!hit) return null
    if (hit.result.status === 'ok') {
      // 成功结果：续命（LRU 语义：命中就挪到末尾）。
      cache.delete(key)
      cache.set(key, hit)
      return hit.result
    }
    if (now() - hit.at >= FAILURE_CACHE_TTL_MS) {
      cache.delete(key)
      return null
    }
    return hit.result
  }

  /** 写缓存。 */
  function writeCache(key: string, result: ExternalLyricResult): void {
    if (result.status === 'ok' && cache.size >= SUCCESS_CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { at: now(), result })
  }

  return {
    async fetchExternalLyric(
      source: LyricSource,
      template: string,
      query: ExternalLyricQuery,
    ): Promise<ExternalLyricResult> {
      // ⚠️ `off` = 明确不用外部 → **一次网络请求都不发**。
      if (source === 'off') return { status: 'not-found' }

      const key = cacheKey(source, query, template)
      const cached = readCache(key)
      if (cached) return cached

      let result: ExternalLyricResult
      try {
        if (source === 'netease') {
          result = await fetchNetease(opts.fetchImpl, query)
        } else if (source === 'lrclib') {
          result = await fetchLrclib(opts.fetchImpl, query)
        } else if (source === 'qq') {
          result = await fetchQq(opts.fetchImpl, query)
        } else {
          result = await fetchCustom(opts.fetchImpl, template, query)
        }
      } catch (cause) {
        result = { status: 'error', message: `连接歌词源失败：${readableError(cause)}` }
      }
      writeCache(key, result)
      return result
    },
  }
}
