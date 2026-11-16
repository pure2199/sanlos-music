// 外部**音乐榜单**抓取（主进程；T96）。
//
// ⚠️ **渲染进程不碰网络**：它只发一个「给我榜单」的请求，地址与解析全在主进程
//    （与歌词源 `lyric:fetch` 同一条纪律）。抓取走**干净的 Chromium 分区栈**
//    （`httpStack.fetch`）⇒ 第三方榜源**看不到** NAS 的 token / Cookie。
//
// ---------------------------------------------------------------------------
// 实测基线（2026-11-16，release/verify/t96-01 / t96-02 / t96-03）
// ---------------------------------------------------------------------------
// - 端点：`https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=<id>&format=json&page=detail&type=top&song_begin=0&song_num=<n>`
// - 必须带头：**UA** + **`Referer: https://y.qq.com/`**（实测带了就通）。
// - 响应是**扁平**结构（**不在 `data` 下**）：`{ code, songlist, topinfo, total_song_num, … }`。
// - `code = 0` 表示成功；`topinfo.ListName` = 榜单名（**自描述**）。
// - `songlist[]` 每条 = 榜单专属字段 + `data`（真正的歌）：
//   `data` 的字段名是 **`songname`**（⚠️ 不是 `title` / `name`）、**`singer: [{id,mid,name}]`**、
//   **`albumname`**、**`interval`（秒）**、`songid`、`songmid`。
// - ⚠️ **没有「榜单列表」接口**（`page=list` → `code=-1, subcode=400`）⇒ 榜单目录**只能客户端写死**。
// - 实测出的 `topid ↔ 榜单名`（37 个）见下面的注释；本模块只取 4 个通用性最强的。
//
// ⚠️ **别家源本轮不接**（实测结论）：网易云的 web 榜单端点已下线（`{"code":404}`）、
//    酷狗参数待探、酷我缺 `kw_token`、咪咕本机 TLS 握手失败
//    ⇒ 但**结构留好了**（`ChartSource`），以后实测通了加一个适配器即可，上层不用改。
// ---------------------------------------------------------------------------

import type { ChartBoard, ChartEntry, ChartResult } from '../shared/chartTypes'

/** 注入的 fetch（主进程里是 `httpStack.fetch`）。 */
export type ChartFetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 单个榜单的限时（毫秒）。 */
export const CHART_SOURCE_TIMEOUT_MS = 8000

/** 成功结果的缓存时长（毫秒）。 */
export const CHART_CACHE_TTL_MS = 5 * 60 * 1000

/** 每个榜单取多少条。 */
export const CHART_BOARD_SIZE = 50

/** UA（榜源对 UA 有要求）。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** QQ 榜单端点（默认榜源）。 */
export const DEFAULT_QQ_TOPLIST_URL = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg'

/**
 * 校验**榜源地址**（可覆盖默认地址用；E2E / 自建镜像）。
 *
 * ⚠️ **只接受两种**：
 * - `https://…`（公网榜源）；
 * - `http://` + **回环地址**（`127.0.0.1` / `localhost` / `::1`）—— 本机测试用。
 *
 * 其余（`http://` 的公网地址、`file:` / `data:` 等）一律**拒绝**
 * ⇒ 回落默认榜源。
 *
 * ⚠️ **为什么不让渲染层指定地址**：渲染层是**不可信输入**；
 *    可覆盖的地址只由**主进程**从**环境变量**读（`FNM_CHART_URL`），
 *    且必须过这一关。
 *
 * @param raw 原始值（通常是环境变量）。
 * @returns 合法地址；不合法（或没给）时返回 `null`（调用方回落默认值）。
 */
export function resolveChartBaseUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return text
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase()
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return text
  }
  return null
}

/** 榜单目录项。 */
export interface ChartBoardDef {
  /** 榜源的榜单编号（`topid`）。 */
  topid: number
  /** 榜源没给名字时用的兜底名。 */
  name: string
}

/**
 * 本轮用的 4 个榜单（**实测可用**，见 `t96-03-probe-qq-boards.mjs`）。
 *
 * ⚠️ 目录**必须写死**（榜源没有「榜单列表」接口）。
 * 实测到的其它 topid（以后要加直接往这儿加即可）：
 * `4` 流行指数 / `6` 港台 / `16` 韩国 / `22` 中国好歌曲 / `23` 畅销 / `25` 中国新歌声 /
 * `28` 网络歌曲 / `29` 影视金曲 / `36` K歌金曲 / `50` 中国有嘻哈 / `51` 明日之子 /
 * `52` 腾讯音乐人原创榜 / `53` 机车 / `54` 勇闯天涯·明日之子 / `55` 中国新说唱 /
 * `56` 2018中国好声音 / `57` 电音榜 / `58` 说唱榜 / `59` 香港地区榜 / `60` 抖音热歌榜 /
 * `61` 台湾地区榜 / `63` DJ舞曲榜 / `64` 综艺新歌榜 / `65` 国风热歌榜 / `66` ACG新歌榜 /
 * `67` 听歌识曲榜 / `70` 达人音乐榜 / `72` 动漫音乐榜 / `73` 游戏音乐榜 /
 * `74` Q音快手榜 / `75` 有声榜 / `76` 音乐巅峰榜 / `77` 扑通指数榜 / `78` 国乐榜
 */
export const QQ_BOARD_DEFS: ChartBoardDef[] = [
  { topid: 26, name: '巅峰榜·热歌' },
  { topid: 62, name: '飙升榜' },
  { topid: 27, name: '巅峰榜·新歌' },
  { topid: 5, name: '巅峰榜·内地' },
]

/** 一个榜单源（以后接别的源就实现这个接口）。 */
export interface ChartSource {
  /** 源 id（如 `'qq'`）。 */
  id: string
  /** 这个源提供哪些榜单。 */
  boards(): ChartBoardDef[]
  /** 抓一个榜单。 */
  fetchBoard(def: ChartBoardDef, fetchImpl: ChartFetchLike, timeoutMs: number): Promise<ChartBoard>
}

/**
 * 造一个 QQ 榜单源。
 *
 * @param baseUrl 榜源地址（缺省 {@link DEFAULT_QQ_TOPLIST_URL}；
 *   覆盖它必须过 {@link resolveChartBaseUrl}）。
 */
export function createQqChartSource(baseUrl: string = DEFAULT_QQ_TOPLIST_URL): ChartSource {
  return {
    id: 'qq',
    boards: () => QQ_BOARD_DEFS,
    fetchBoard: (def, fetchImpl, timeoutMs) =>
      fetchQqBoard(fetchImpl, def, timeoutMs, baseUrl),
  }
}

/** QQ 榜单源（默认地址）。 */
export const qqChartSource: ChartSource = createQqChartSource()

/** 取字符串字段（不是字符串就当没有）。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 取正数（不是正数就当没有）。 */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 抓 QQ 的一个榜单。
 *
 * ⚠️ **缺歌名的条目直接跳过**（不伪造）：榜源偶尔会给出没有 `songname` 的条目。
 * ⚠️ **排名用原始下标 + 1**：跳过条目时后面的名次**不会**跟着前移（名次要如实）。
 */
async function fetchQqBoard(
  fetchImpl: ChartFetchLike,
  def: ChartBoardDef,
  timeoutMs: number,
  baseUrl: string = DEFAULT_QQ_TOPLIST_URL,
): Promise<ChartBoard> {
  const url =
    `${baseUrl}?topid=${def.topid}&format=json&page=detail&type=top` +
    `&song_begin=0&song_num=${CHART_BOARD_SIZE}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        // ⚠️ **必须带 Referer**（实测：不带会被拒）。
        referer: 'https://y.qq.com/',
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`榜源返回 HTTP ${res.status}`)
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('榜源返回的不是 JSON')
    }
    const record = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
    if (record['code'] !== 0) throw new Error(`榜源返回错误码 ${String(record['code'])}`)

    const rawList = Array.isArray(record['songlist']) ? (record['songlist'] as unknown[]) : []
    const entries: ChartEntry[] = []
    rawList.forEach((rawItem, index) => {
      const item = (typeof rawItem === 'object' && rawItem !== null ? rawItem : {}) as Record<string, unknown>
      const data = (typeof item['data'] === 'object' && item['data'] !== null
        ? item['data']
        : {}) as Record<string, unknown>
      const title = str(data['songname']).trim()
      if (title === '') return
      const singers = Array.isArray(data['singer'])
        ? (data['singer'] as unknown[])
            .map((s) => str((s as Record<string, unknown>)['name']).trim())
            .filter((name) => name !== '')
        : []
      entries.push({
        rank: index + 1,
        title,
        artist: singers.join(' / '),
        album: str(data['albumname']).trim(),
        duration: positiveNumber(data['interval']),
      })
    })

    const topinfo = (typeof record['topinfo'] === 'object' && record['topinfo'] !== null
      ? record['topinfo']
      : {}) as Record<string, unknown>
    const selfName = str(topinfo['ListName']).trim()
    return {
      id: `qq-${def.topid}`,
      name: selfName !== '' ? selfName : def.name,
      source: 'qq',
      entries,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 榜单提供器。 */
export interface ChartProvider {
  /**
   * 拉全部榜单。
   *
   * ⚠️ **永不抛**：榜源挂了返回 `{ status: 'error', message }`（可读中文）。
   */
  fetchCharts(): Promise<ChartResult>
}

/** `createChartProvider` 的参数。 */
export interface ChartProviderOptions {
  /** 抓取用的 fetch（**干净分区栈**，不带 NAS 凭证）。 */
  fetchImpl: ChartFetchLike
  /** 现在的时刻（毫秒）；单测可注入以验证缓存过期。 */
  now?: () => number
  /** 单个榜单的限时（毫秒）；缺省 {@link CHART_SOURCE_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 榜单源；缺省只有 QQ（以后接别的源往这儿加）。 */
  sources?: ChartSource[]
}

/**
 * 造一个榜单提供器。
 *
 * ⚠️ **缓存策略**：
 * - **成功**结果 → 缓存 {@link CHART_CACHE_TTL_MS}（切页面不重复打榜源）；
 * - **失败**结果 → **不缓存**（下次重试能立刻恢复，不让用户被一次抖动卡住 5 分钟）。
 */
export function createChartProvider(opts: ChartProviderOptions): ChartProvider {
  const now = opts.now ?? ((): number => Date.now())
  const timeoutMs = opts.timeoutMs ?? CHART_SOURCE_TIMEOUT_MS
  const sources = opts.sources ?? [qqChartSource]
  let cached: { at: number; result: ChartResult } | null = null

  return {
    async fetchCharts(): Promise<ChartResult> {
      if (cached && now() - cached.at < CHART_CACHE_TTL_MS) return cached.result

      const boards: ChartBoard[] = []
      const failures: string[] = []

      for (const source of sources) {
        const defs = source.boards()
        const results = await Promise.allSettled(
          defs.map((def) => source.fetchBoard(def, opts.fetchImpl, timeoutMs)),
        )
        for (const item of results) {
          if (item.status === 'fulfilled') boards.push(item.value)
          else {
            const reason = item.reason instanceof Error ? item.reason.message : String(item.reason)
            failures.push(reason)
          }
        }
      }

      if (boards.length === 0) {
        // ⚠️ **失败不缓存**（见上）。
        return {
          status: 'error',
          message: `榜单源暂时不可用：${failures[0] ?? '未知原因'}`,
          boards: [],
        }
      }

      const result: ChartResult = { status: 'ok', boards }
      if (failures.length > 0) {
        // 部分榜单没取到 ⇒ **如实说明**，但已经取到的照常显示。
        result.message = `有 ${failures.length} 个榜单暂时取不到`
      }
      cached = { at: now(), result }
      return result
    },
  }
}
