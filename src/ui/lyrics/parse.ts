// LRC 歌词解析（行级 + 逐字）。
//
// 纯函数模块：`src/**` 会被打进**渲染进程** bundle，因此本文件
//   - 不 import Node 内置模块、不 import Electron API；
//   - 唯一的外部引用是 `import type`（类型在编译期被擦除，运行时不产生依赖）；
//   - 不引入任何新依赖。
//
// 语义约定（Task 15 / Task 19 直接消费，改动前先看这里）：
// - 时间单位一律**秒**（`LyricLine.time` / `LyricWord.start` / `LyricWord.end`）；
// - `offset` 单位是**毫秒**（与 `LyricEntry.offset` / `RawLyric.offset` 一致），
//   方向见 `applyOffset` 的 JSDoc（**正数 = 歌词延后**）；
// - 伪逐字（行级 LRC 没有词级标签时）保证 `words` 非空，供「双行逐字」高亮兜底。

import type { LyricEntry } from '../../api/types'

/** 逐字（伪逐字）的一个词：文本 + 起止时间（秒）。 */
export type LyricWord = { text: string; start: number; end: number }

/** 一行歌词：行时间（秒）+ 文本 + 逐字 + 翻译。 */
export type LyricLine = {
  time: number
  text: string
  words: LyricWord[]
  translation: string
  /**
   * 这一行的**罗马音**（T90-③：三行模型 —— 原文 / 翻译 / 罗马音）。
   *
   * ⚠️ **可选字段**：既有代码与既有测试里**手写**的 `LyricLine` 都不带这个键
   *    ⇒ 必填会让它们**全部编译不过** ⇒ 违反「既有测试一条不许改」的硬约束。
   * ⚠️ **空串 / 缺省 = 没有罗马音** ⇒ 渲染层**不渲染**第三行（不占位）。
   * ⚠️ 罗马音**没有词级时间戳** ⇒ 与翻译同理，**不参与推进**。
   */
  romanization?: string
  /**
   * 这一行的**词级时间戳是不是源给的**（**真逐字**）。
   *
   * - `true`：**有**显式逐字标签（`<mm:ss.xx>`）⇒ 词边界是**真的** ⇒ 走卡拉OK 填色；
   * - `false`：**只有**行级标签 ⇒ 词级时间是 `pseudoWords()` **插值编造**的
   *   ⇒ **不假装逐字**，改走「整行显示」（见 `LyricView` 的 `renderLine`）。
   *
   * ⚠️ **可选字段、缺省视为 `true`**：既有代码与测试里**手写**的 `LyricLine`
   *    （以及外部构造的）都不带这个键 ⇒ 一律按「有逐字」处理 ⇒ **既有行为一条不变**。
   * ⚠️ **逐行**而不是逐文件：真实文件里两种行可以**混存**
   *    （外部源的增强 LRC 里，逐字标签只覆盖部分行是常见形态）。
   */
  wordTimed?: boolean
}

/**
 * 行时间标签：`[mm:ss]` / `[mm:ss.xx]` / `[mm:ss.xxx]` / `[mm:ss:xx]`。
 * - `[mm:ss]` → 秒；
 * - `[mm:ss.xx]` → 厘秒（÷100）；
 * - `[mm:ss.xxx]` → 毫秒（÷1000）；
 * - `[mm:ss:xx]` → 厘秒（÷100，与 `.xx` 同义）。
 * - 小数/厘秒部分按**位数**折算（`N` 位 → ÷10^N），所以 `.xx`=÷100、`.xxx`=÷1000 一并成立。
 * - 分钟可以超过 59（长音频）。
 * - 小数位允许**最多 9 位**（超出的部分按毫秒精度截断），**绝不因为精度不够而丢掉整行**。
 */
const TIME_TAG = /\[(\d+):(\d{1,2})(?:[.:](\d{1,9}))?\]/

/** 逐字标签：`<mm:ss.xx>`（A2 增强 LRC 格式）；小数位规则同 `TIME_TAG`。 */
const WORD_TAG = /<(\d+):(\d{1,2})(?:[.:](\d{1,9}))?>/g

/**
 * LRC 的**同步校正标签**：`[offset:+N]` / `[offset:-N]` / `[offset:N]`（毫秒）。
 *
 * - **正数 = 时间戳整体加 N** ⇒ 歌词**延后** N 毫秒（与 `applyOffset` 同向）；
 * - **负数 = 提前** N 毫秒；
 * - **只在**行首**认**（LRC 的头标签就在那儿）⇒ 歌词正文里的同形文本**不误判**；
 * - 取**第一个**出现的标签；
 * - 畸形标签（`[offset:abc]` / `[offset:]`）**忽略**（不报错、不产生歌词行）。
 */
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i

/**
 * 文件里 `[offset:±N]` 的**取值上限**（毫秒）。
 *
 * ⚠️ 标签来自**外部文件**（NAS / 外部歌词源）⇒ 钳到 ±60 秒，
 *    防畸形文件把整份歌词推到天边。
 */
const MAX_FILE_OFFSET_MS = 60_000

/** 钳到 0 后的最小步进（1ms）：保证钳平后的时间序列仍然**严格单调递增**。 */
const MIN_STEP = 0.001

/** 拉丁字母或十进制数字（连续的整串算一个词）。 */
const LATIN_OR_DIGIT = /[\p{Script=Latin}\p{Nd}]/u

/** 毫秒精度取整（消除浮点噪声，让下游比较可预期）。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 把时间标签的匹配结果换算成秒。 */
function tagToSeconds(match: RegExpExecArray): number {
  const minutes = Number(match[1] ?? 0)
  const seconds = Number(match[2] ?? 0)
  const fractionText = match[3] ?? ''
  const fraction = fractionText === '' ? 0 : Number(fractionText) / 10 ** fractionText.length
  return round3(minutes * 60 + seconds + fraction)
}

/** CJK 表意文字（含扩展 A、兼容区、假名、谚文）——逐字成词。 */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0xac00 && code <= 0xd7af) // 谚文音节
  )
}

/**
 * 把一行文本切成「伪逐字」的词。
 *
 * 规则（定死，测试已钉住）：
 * 1. **CJK 汉字** → **每个字单独成词**；
 * 2. **连续的拉丁字母 / 数字** → 整个连续串算**一个**词（`hello`、`2024`、`hello2world`）；
 * 3. **空白** → 直接丢弃（不占词），同时充当拉丁串的边界；
 * 4. **标点 / 其它符号** → 不单独成词，并入**前一个词**；行首没有前词时并入**后一个词**。
 *
 * 由此保证：`splitIntoWords(text).join('') === text.replace(/\s+/g, '')`（不丢字）。
 *
 * ⚠️ **关于第 3 条与简报追加要求 H 的字面冲突（已定夺，别按字面「修」回去）**：
 * 要求 H 同时写了「空格 → 并入前一个词」与「拼回原文 == 行文本**去掉空白**后的结果」，
 * 这两条**不可兼得**——若把空格留在词里，拼回结果就等于**含空白**的原文，而不是去掉空白的原文。
 * 本实现选择**后者**（不变式优先），所以空白是**丢弃**而不是并入词里；
 * 若改成「空格并入前一个词」，拼回结果就会多出空白，破坏上面那条不变式。
 */
export function splitIntoWords(text: string): string[] {
  const words: string[] = []
  let current = '' // 正在累积的拉丁串（可带尾随标点）
  let pending = '' // 行首标点：等后面的词来认领
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    if (isCjk(ch)) {
      if (current) {
        words.push(current)
        current = ''
      }
      words.push(pending + ch)
      pending = ''
      continue
    }
    if (LATIN_OR_DIGIT.test(ch)) {
      current += ch
      continue
    }
    // 标点 / 符号：不单独成词，并入前一个词（没有前词就等后一个词）
    if (current) current += ch
    else if (words.length) words[words.length - 1] += ch
    else pending += ch
  }
  if (current) words.push(current)
  if (!words.length && pending) words.push(pending)
  return words
}

/** 去掉行内所有逐字标签，只留纯文本。 */
function stripWordTags(content: string): string {
  return content.replace(WORD_TAG, '').trim()
}

/** 解析出来的原始行（还没合并重复时间戳、还没定词尾时间）。 */
interface RawEntry {
  /** 行时间（秒）。 */
  time: number
  /** 行文本（已去标签、已 trim）。 */
  text: string
  /** 显式逐字标签解析出的词；`null` = 没有逐字标签 → 需要伪逐字兜底。 */
  words: LyricWord[] | null
}

/**
 * 解析增强 LRC 行内容里的逐字标签。
 *
 * 格式：`[行时间]<词时间>字<词时间>字…`。第一个标签之前的文本按「行时间」起算。
 * 没有逐字标签时返回 `words: null`（交给伪逐字兜底）。
 */
function parseWordSegments(content: string, lineTime: number): { text: string; words: LyricWord[] | null } {
  const tags: { time: number; index: number; length: number }[] = []
  WORD_TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WORD_TAG.exec(content)) !== null) {
    tags.push({ time: tagToSeconds(match), index: match.index, length: match[0].length })
  }
  if (!tags.length) return { text: stripWordTags(content), words: null }

  const segments: { text: string; start: number }[] = []
  const leading = content.slice(0, tags[0]!.index).trim()
  if (leading) segments.push({ text: leading, start: lineTime })
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!
    const next = tags[i + 1]
    const segment = content.slice(tag.index + tag.length, next ? next.index : content.length).trim()
    if (segment) segments.push({ text: segment, start: tag.time })
  }
  const words = segments.map((segment) => ({ text: segment.text, start: segment.start, end: segment.start }))
  return { text: stripWordTags(content), words }
}

/** 扫描原始文本 → 原始行列表（一个时间标签一行，多时间标签展开成多行）。 */
function parseRawLines(raw: string, enhanced: boolean): { entries: RawEntry[]; offsetMs: number } {
  const entries: RawEntry[] = []
  if (typeof raw !== 'string' || raw === '') return { entries, offsetMs: 0 }
  /** 文件自带的同步校正量（毫秒）；取**第一个**出现的标签。 */
  let offsetMs = 0
  let offsetSeen = false
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    let trimmed = rawLine.trim()
    if (!trimmed) continue
    // ⚠️ `[offset:±N]` 必须是**行首**（LRC 的头标签就在那儿）：
    //    ⇒ 歌词**正文里**的同形文本不会被误当成校正标签。
    const tagMatch = OFFSET_TAG.exec(trimmed)
    if (tagMatch && tagMatch.index === 0) {
      if (!offsetSeen) {
        const value = Number(tagMatch[1])
        offsetMs = Number.isFinite(value)
          ? Math.max(-MAX_FILE_OFFSET_MS, Math.min(MAX_FILE_OFFSET_MS, value))
          : 0
        offsetSeen = true
      }
      // 把标签摘掉，剩下的部分照常按时间标签解析（`[offset:+500][00:12.00]词` 也认）。
      trimmed = trimmed.slice(tagMatch[0].length).trim()
      if (!trimmed) continue
    }
    let rest = trimmed
    const times: number[] = []
    for (;;) {
      const match = TIME_TAG.exec(rest)
      if (!match || match.index !== 0) break
      times.push(tagToSeconds(match))
      rest = rest.slice(match[0].length).trim()
    }
    // 没有时间标签 → 元信息标签（`[ti:]` 等）或纯文本行 → 忽略
    if (!times.length) continue
    for (const time of times) {
      const parsed = enhanced
        ? parseWordSegments(rest, time)
        : { text: stripWordTags(rest), words: null }
      entries.push({ time, text: parsed.text, words: parsed.words })
    }
  }
  return { entries, offsetMs }
}

/**
 * 判断两段文本是否**实质相同**（**忽略所有空白**）。
 *
 * ⚠️ **为什么需要它**（真机踩过的坑，2026-11-04）：
 *    实测 NAS 对**同一首歌**返回**两条内容近乎相同**的歌词记录（`source` 不同）。
 *    客户端按「第一条作原文、其余作翻译」的规则合并 →
 *    第二条被挂成 `translation` → **同一句歌词在界面上显示两遍**
 *    （一遍蓝色大字 = 原文，一遍灰色小字 = 翻译；字面完全一样）。
 *    ⇒ 内容**实质相同**时**不当翻译**（不显示第二遍）。
 *
 * ⚠️ **只判「实质相同」**：真的是翻译（内容不同）照常显示。
 * ⚠️ 两边都为空 → 视为**不相同**（空行没有「重复显示」的问题）。
 *
 * @param a 文本一。
 * @param b 文本二。
 * @returns 去掉空白后是否相等。
 */
export function isSameText(a: string, b: string): boolean {
  const left = typeof a === 'string' ? a.replace(/\s+/g, '') : ''
  const right = typeof b === 'string' ? b.replace(/\s+/g, '') : ''
  if (!left.length || !right.length) return false
  return left === right
}

// ---------------------------------------------------------------------------
// 伪逐字：按**音节权重**分配行时长（T66）
// ---------------------------------------------------------------------------

/**
 * 估算一个拉丁词的音节数（**启发式**，不追求英语 phonology 精确）。
 *
 * 规则（定死）：
 * 1. 只保留 `a-z`（其余字符丢掉）；
 * 2. 长度 ≤ 3 ⇒ **1**（`the` / `a` / `you` 之类）；
 * 3. 去掉词尾的**哑 e / 哑 es**（`make`→`mak`、`makes`→`mak`）；
 * 4. 去掉词首的 `y`（不算音节：`yes`→`es`）；
 * 5. 数**元音组**（连续的元音字母算 1 个音节：`ea` / `eau` / `io` 各算 1）。
 *
 * ⚠️ 个别词会差 1 个音节（如 `away` 估成 3）——**方向正确比绝对精确更重要**：
 *    长词分到更长时间，这正是本任务要的。
 */
function estimateSyllables(word: string): number {
  const letters = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!letters) return 1
  if (letters.length <= 3) return 1
  // 词尾哑 e / 哑 es（`make`→`mak`、`makes`→`mak`）。
  const stripped = letters.replace(/(?:[^laeiouy]es|[^laeiouy]e)$/, '')
  // 词首 y 不算音节（`yes`→`es`）。
  const body = stripped.replace(/^y/, '')
  const groups = body.match(/[aeiouy]+/g)
  const count = groups ? groups.length : 0
  return count > 0 ? count : 1
}

/**
 * 一个词的「音节权重」。
 *
 * - **汉字**：1 字 = 1 音节（`占位` → 权重 2）；
 * - **拉丁词**：按 `estimateSyllables` 估（`hello` → 2、`beautiful` → 3）；
 * - **数字 / 纯标点**：1 份（读不出来就别瞎猜）。
 */
function tokenWeight(token: string): number {
  let cjk = 0
  for (const ch of token) {
    if (isCjk(ch)) cjk += 1
  }
  if (cjk > 0) return cjk
  const latin = token.replace(/[^\p{Script=Latin}]/gu, '')
  if (!latin) return 1
  return estimateSyllables(latin)
}

/**
 * 把总毫秒按权重分给各词。
 *
 * - `floor` 之后按**小数部分从大到小**补齐（平局靠前）
 *   ⇒ 总量**精确等于**总毫秒（不多不少）；
 * - 预算够时（总毫秒 ≥ 词数）保证**每词至少 1ms**
 *   （从最宽裕的词里扣回来，总量不变）
 *   ⇒ 词起点**严格递增**、每个词 `end > start`；
 * - 预算不够时（总毫秒 < 词数，现实中不可达）**如实退化**：不保证严格递增。
 */
function allocateMs(totalMs: number, weights: number[], totalWeight: number): number[] {
  const count = weights.length
  const exact = weights.map((weight) => (totalMs * weight) / totalWeight)
  const allocations = exact.map((value) => Math.floor(value))
  let rest = totalMs - allocations.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  let cursor = 0
  while (rest > 0) {
    const target = order[cursor % count]!
    allocations[target.index] = allocations[target.index]! + 1
    rest -= 1
    cursor += 1
  }
  if (totalMs >= count) {
    let deficit = 0
    for (let i = 0; i < count; i++) {
      if (allocations[i]! < 1) {
        allocations[i] = 1
        deficit += 1
      }
    }
    const donors = allocations
      .map((value, index) => ({ index, value }))
      .sort((a, b) => b.value - a.value || a.index - b.index)
    for (const donor of donors) {
      while (deficit > 0 && allocations[donor.index]! > 1) {
        allocations[donor.index] = allocations[donor.index]! - 1
        deficit -= 1
      }
      if (deficit === 0) break
    }
  }
  return allocations
}

/**
 * 在 `[time, end]` 区间内按**音节权重**切出伪逐字。
 *
 * ⚠️ 与旧实现（按**词数**均分）的差别**只在分配比例**：
 *    - 切分规则（`splitIntoWords`）**一字不改**；
 *    - 「总量 = 行时长」「首词起点 = 行时间」「末词终点 = 下一行时间」**一字不改**；
 *    ⇒ **纯中文行每个字 1 音节 ⇒ 分配结果与旧实现逐字相同**。
 */
function pseudoWords(text: string, time: number, end: number): LyricWord[] {
  const tokens = splitIntoWords(text)
  if (!tokens.length) return []
  const startMs = Math.round(time * 1000)
  const endMs = Math.round(end * 1000)
  const totalMs = Math.max(0, endMs - startMs)
  const weights = tokens.map(tokenWeight)
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const allocations = allocateMs(totalMs, weights, totalWeight)
  const words: LyricWord[] = []
  let cursor = startMs
  for (let i = 0; i < tokens.length; i++) {
    const span = allocations[i]!
    words.push({
      text: tokens[i]!,
      start: round3(cursor / 1000),
      end: round3((cursor + span) / 1000),
    })
    cursor += span
  }
  return words
}

/**
 * 把原始行收口成最终的 `LyricLine[]`：
 * 1. **稳定排序**（LRC 文件常常乱序；同时间戳保持原样，原文在前、翻译在后）；
 * 2. **合并相同时间戳的多行**（第一条作 `text`，其余作 `translation`，换行拼接）；
 * 3. 补齐逐字时间（伪逐字按行时长均匀切分；显式逐字的词尾取下一个词/下一行）。
 */
function assemble(entries: RawEntry[]): LyricLine[] {
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.time - b.entry.time || a.index - b.index)
    .map((item) => item.entry)

  const merged: { time: number; text: string; translation: string; words: LyricWord[] | null }[] = []
  for (const entry of sorted) {
    const last = merged[merged.length - 1]
    if (last && last.time === entry.time) {
      // ⚠️ **内容实质相同的不当翻译**（否则同一句会显示两遍——见 `isSameText`）。
      if (entry.text && !isSameText(entry.text, last.text)) {
        last.translation = last.translation ? `${last.translation}\n${entry.text}` : entry.text
      }
      continue
    }
    merged.push({ time: entry.time, text: entry.text, translation: '', words: entry.words })
  }

  const lines: LyricLine[] = []
  for (let i = 0; i < merged.length; i++) {
    const current = merged[i]!
    const next = merged[i + 1]
    // 行区间：下一行的时间；最后一行 → 自身 time + 0.5
    const lineEnd = next ? next.time : current.time + 0.5
    let words: LyricWord[]
    // ⚠️ **T81：词级时间戳是「源给的」还是「我们插值编的」？**
    //    这是**卡拉OK 与整行显示的分水岭** —— 见 `LyricLine.wordTimed`。
    //    - `current.words` 非空 ⇒ 来自 `parseWordSegments`（**显式逐字标签**）⇒ **真逐字**；
    //    - 否则走 `pseudoWords` ⇒ 字级时间是**按音节权重插值编造的** ⇒ **伪逐字**。
    //    ⚠️ 伪逐字的 `words` **照旧算出来**（双行推进等纯函数还要用），
    //    本任务只改**呈现**，不改**数据管线**。
    const wordTimed = Boolean(current.words && current.words.length)
    if (current.words && current.words.length) {
      words = current.words.map((word, index) => {
        const nextWord = current.words![index + 1]
        const end = nextWord
          ? Math.max(word.start, nextWord.start)
          : lineEnd > word.start
            ? lineEnd
            : word.start + 0.5
        return { text: word.text, start: word.start, end }
      })
    } else {
      words = pseudoWords(current.text, current.time, lineEnd)
    }
    lines.push({
      time: current.time,
      text: current.text,
      words,
      translation: current.translation,
      // ⚠️ **T90-③**：罗马音**显式写出来**（不靠「缺省即没有」）
      //    ⇒ 解析器产出的行**自带**这个事实（与 `wordTimed` 同一套纪律）。
      //    ⚠️ 这里恒为**空串**：罗马音来自**另一份** LRC（`role: 'romanization'`），
      //    由 `parseLyricEntries` 事后挂上来（见 `attachRomanizations`）。
      romanization: '',
      // ⚠️ **T81**：显式写出来（不靠「缺省即真逐字」）⇒ 解析器产出的行**自带**这个事实。
      wordTimed,
    })
  }
  return lines
}

/**
 * 解析 LRC（**行级与逐字都吃**）。
 *
 * - **行级 LRC**（没有 `<mm:ss.xx>` 逐字标签）→ 按该行时长把文本切成
 *   「中文按字、英文/数字按词」的伪逐字（见 `splitIntoWords`），
 *   因此每行的 `words` **非空**（空文本行除外）——双行逐字高亮可以直接消费。
 * - **带逐字标签的 LRC** → 按**真实词级时间戳**解析（与 `parseEnhancedLrc` 完全一致）。
 *   控制器追加要求 I 明写：「两个函数在有逐字标签的输入上都必须正确解析逐字」——
 *   若这里忽略逐字标签，下游会拿到**静默错误**的逐字时间
 *   （词被按 CJK 逐字重切、时间被均匀铺满整行），且**没有任何报错**。
 *
 * 本函数等价于 `parseEnhancedLrc`（简报要求两个入口都存在，语义统一到这里）。
 *
 * @param raw LRC 原文；`null` / `undefined` / 空串 → 返回空数组。
 * @param options.offsetMs 可选的时间偏移（毫秒），语义见 `applyOffset`。
 */
export function parseLrc(raw: string, options?: { offsetMs?: number }): LyricLine[] {
  return parseEnhancedLrc(raw, options)
}

/**
 * 解析增强 LRC（带 `<mm:ss.xx>` 逐字标签）。
 *
 * **降级兜底**：实测真实 NAS 的歌词**只有行级 LRC、没有逐字标签**，
 * 因此遇到没有逐字标签的行时，本函数退化成与 `parseLrc` **完全一致**的伪逐字，
 * 绝不返回 `words: []`。
 *
 * `parseLrc` 直接委托到这里——两者行为一致（要求 I：行级输入逐字一致，
 * 有逐字标签的输入也都要正确解析逐字）。
 *
 * **偏移（T66）**：文件自带的 `[offset:±N]`（毫秒）与 `options.offsetMs`
 * **同向叠加**（正数 = 延后），且**一次**施加。
 *
 * @param raw LRC 原文；`null` / `undefined` / 空串 → 返回空数组。
 * @param options.offsetMs 可选的时间偏移（毫秒），语义见 `applyOffset`。
 */
export function parseEnhancedLrc(raw: string, options?: { offsetMs?: number }): LyricLine[] {
  const parsed = parseRawLines(raw, true)
  const lines = assemble(parsed.entries)
  // 偏移 = 文件自带的 `[offset:±N]` **加** 调用方给的（服务端 `LyricEntry.offset`）。
  // ⚠️ **一次**施加（不是分两次）⇒ 不会因为中途钳零而走形。
  const totalOffset = parsed.offsetMs + (options?.offsetMs ?? 0)
  return totalOffset ? applyOffset(lines, totalOffset) : lines
}

/**
 * 施加时间偏移（**毫秒**）。
 *
 * **方向语义（定死，Task 15/19 直接消费）**：
 * - `ms > 0` → 每个时间戳**加上** `ms` → 歌词**延后**出现（late）；
 * - `ms < 0` → 每个时间戳**减去** `|ms|` → 歌词**提前**出现（early）；
 * - `ms === 0` → 原样返回（副本）。
 *
 * 依据：LRC 规范里 `[offset:+N]` 的含义是「时间戳整体加上 N 毫秒」，
 * 正数让歌词更晚出现；服务端 `LyricEntry.offset` 的正负语义**未实测确认**，
 * 本模块统一按「正 = 延后」解释，**调用方不要再自己翻转符号**。
 *
 * **负数时间**：偏移后出现负数时间戳时**钳到 0**（不保留负值）。
 *
 * **钳零后的单调性修复（要求 G：必须仍然单调递增）**：
 * 钳零会把相邻时间戳压到同一刻（例如整行都落到 0），因此钳零之后**逐项抬升**：
 * - 行时间：若 `lines[i].time <= lines[i-1].time` → 抬到 `lines[i-1].time + 1ms`；
 * - 词起点：若 `words[i].start <= words[i-1].start` → 抬到 `words[i-1].start + 1ms`；
 * - 词终点：若 `words[i].end <= words[i].start` → 抬到 `words[i].start + 1ms`。
 * 于是偏移后**行时间与词时间都严格单调递增**、且**没有任何负数**；
 * 行时间仍严格递增 ⇒ 被钳平的文件上 `findActiveLine` 依然能选对行（不会跳到末行）。
 *
 * 偏移**同时**作用于 `line.time` 与该行所有 `word.start` / `word.end`。
 *
 * @returns 新的数组（不修改入参）。
 */
export function applyOffset(lines: LyricLine[], ms: number): LyricLine[] {
  if (!Array.isArray(lines) || !lines.length) return []
  if (!Number.isFinite(ms) || ms === 0) return lines.map((line) => ({ ...line, words: [...line.words] }))
  const delta = ms / 1000
  const clamp = (value: number): number => Math.max(0, round3(value + delta))
  const result = lines.map((line) => ({
    ...line,
    time: clamp(line.time),
    words: line.words.map((word) => ({
      text: word.text,
      start: clamp(word.start),
      end: clamp(word.end),
    })),
  }))
  // 钳零可能让相邻时间戳塌缩到同一刻 → 逐项抬升 1ms，恢复严格单调递增。
  for (let i = 1; i < result.length; i++) {
    const previous = result[i - 1]!
    const current = result[i]!
    if (current.time <= previous.time) current.time = round3(previous.time + MIN_STEP)
  }
  for (const line of result) {
    for (let i = 0; i < line.words.length; i++) {
      const word = line.words[i]!
      if (i > 0) {
        const previous = line.words[i - 1]!
        if (word.start <= previous.start) word.start = round3(previous.start + MIN_STEP)
      }
      if (word.end <= word.start) word.end = round3(word.start + MIN_STEP)
    }
  }
  return result
}

/**
 * 把「副行」挂到原文行上（按时间戳对齐）—— 翻译与罗马音**同一套逻辑**（T90-③）。
 *
 * 规则：
 * - 时间戳**精确匹配** → 直接挂上；
 * - 精确匹配不上 → 取**时间差最小**的一行，容差 **0.5s（含边界）**；
 * - 仍然匹配不上 → 该副行留空串。
 * - 原文行**已有**该副行（同文件内同时间戳的兄弟行）时**不覆盖**。
 *
 * 合并**不改变**原文行的 `time` / `text` / `words`。
 *
 * ⚠️ **同时间戳只挂第一条**（`exact` 表里每个时间戳只留**最先出现**的那行）
 *    ⇒ 两条内容不同、但时间戳相同的翻译，界面上**只显示第一条**。
 *    （这是**既有行为**，T90-③ 一字未改。）
 *
 * @returns 新的数组（不修改入参）。
 */
function attachAuxiliary(
  lines: LyricLine[],
  auxiliaryLines: LyricLine[],
  field: 'translation' | 'romanization',
): LyricLine[] {
  if (!Array.isArray(lines) || !lines.length) return []
  if (!Array.isArray(auxiliaryLines) || !auxiliaryLines.length) {
    return lines.map((line) => ({ ...line, words: [...line.words] }))
  }
  const exact = new Map<number, LyricLine>()
  for (const candidate of auxiliaryLines) {
    if (!exact.has(candidate.time)) exact.set(candidate.time, candidate)
  }
  return lines.map((line) => {
    const current = field === 'translation' ? line.translation : line.romanization
    if (current) return { ...line, words: [...line.words] }
    let matched = exact.get(line.time)
    if (!matched) {
      let best: LyricLine | undefined
      let bestDiff = Number.POSITIVE_INFINITY
      for (const candidate of auxiliaryLines) {
        const diff = Math.abs(candidate.time - line.time)
        if (diff < bestDiff) {
          bestDiff = diff
          best = candidate
        }
      }
      if (best && bestDiff <= 0.5) matched = best
    }
    // ⚠️ **内容实质相同的不当副行**（NAS 对同一首歌会返回两条近乎相同的记录，
    //    直接挂上会让同一句歌词在界面上显示两遍——见 `isSameText`）。
    const value = matched && !isSameText(matched.text, line.text) ? matched.text : ''
    if (field === 'translation') return { ...line, words: [...line.words], translation: value }
    return { ...line, words: [...line.words], romanization: value }
  })
}

/**
 * 把翻译行挂到原文行上（按时间戳对齐）。
 *
 * ⚠️ **对外签名与行为一字未改**（T90-③ 只是把实现泛化成了 `attachAuxiliary`）。
 */
export function attachTranslations(lines: LyricLine[], translationLines: LyricLine[]): LyricLine[] {
  return attachAuxiliary(lines, translationLines, 'translation')
}

/**
 * 把**罗马音**行挂到原文行上（按时间戳对齐）—— 与翻译**同一套逻辑**（T90-③）。
 *
 * ⚠️ 罗马音**没有词级时间戳** ⇒ 与翻译同理，**不参与推进**（只当副行显示）。
 */
export function attachRomanizations(
  lines: LyricLine[],
  romanizationLines: LyricLine[],
): LyricLine[] {
  return attachAuxiliary(lines, romanizationLines, 'romanization')
}

/**
 * 找当前时间所属的行。
 *
 * 边界语义：**左闭右开**（`t === line.time` 归属该行）。
 * - `t` 早于第一行 → `-1`；
 * - `t` 晚于最后一行 → 最后一行索引（行尾保持高亮）；
 * - 空数组 → `-1`。
 */
export function findActiveLine(lines: LyricLine[], t: number): number {
  if (!Array.isArray(lines) || !lines.length) return -1
  let lo = 0
  let hi = lines.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const line = lines[mid]!
    if (line.time <= t) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * 找当前时间所属的词。
 *
 * 边界语义：**左闭右开**（`t === word.start` 归属该词，`t === word.end` 归属下一个词）。
 * - `t` 早于第一个词 → `-1`；
 * - `t` 落在词与词之间的空隙 → 归到**下一个**词（即将到来）；
 * - `t` 晚于最后一个词 → **最后一个词的索引**（行尾不丢高亮）；
 * - `words` 为空 → `-1`。
 *
 * ⚠️ **关于「词间空隙」分支的可达性（注释与实现必须一致）**：
 * 本解析器构造出来的词区间**恒连续**（`words[i].end === words[i+1].start`，
 * 见 `assemble` 与 `applyOffset`），所以**本模块产出的行不会命中空隙分支**。
 * 该分支只对**外部手工构造**的非连续 `LyricLine` 兜底（例如 Task 19 自建的行），
 * 此时 `t` 落在 `words[i].end` 与 `words[i+1].start` 之间 → 返回下一个词的索引。
 */
export function findActiveWord(line: LyricLine, t: number): number {
  const words = line?.words
  if (!Array.isArray(words) || !words.length) return -1
  let lo = 0
  let hi = words.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const word = words[mid]!
    if (word.start <= t) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (result < 0) return -1
  const word = words[result]!
  if (t < word.end) return result
  // 已经越过该词：落到下一个词；已经过了最后一个词 → 停在最后一个词
  return result + 1 < words.length ? result + 1 : result
}

/**
 * 直接消费 `LyricEntry[]`（Task 15/19 的便利入口）。
 *
 * 内部流程：挑选原文 → 解析（增强 LRC，缺逐字时自动降级）→ 施加该条自己的 `offset`
 * → 其余条目同样解析并施加各自的 `offset` → 按时间戳对齐合并翻译 → 返回最终 `LyricLine[]`。
 *
 * **原文 / 翻译 / 罗马音的挑选规则（T90-③，定死）**：
 * - **有 `role` 的按 `role` 归类**：`'original'` 原文、`'translation'` 翻译、
 *   `'romanization'` 罗马音。
 * - **没有 `role` 的按旧的位置约定**：**第一条「内容非空」的条目作原文**，其余条目
 *   一律当翻译。
 *   依据：① 实测同一首歌会返回两条 `source` 不同、内容近乎相同的记录，
 *   但 `source` 的具体取值**未确认**，因此**不按 `source` 字符串硬猜**；
 *   ② 本仓库既有约定 `src/api/lyric.ts` 的 `lyricApi.raw` 就是「取第一条的 LRC 原文」，
 *   本函数与之保持一致，避免同一个 API 在两处给出不同答案。
 * - **原文候选优先级**：`role:'original'` → 无 `role` → `role:'translation'`。
 *   （都没有 ⇒ 返回空数组。）
 * - 条目**内容为空**时跳过（不占用「第一条」的名额）；全部为空 → 返回空数组。
 * - **多余的条目一律当翻译候选**（内容不丢）；翻译 / 罗马音条目之间不做二次区分：
 *   它们按各自 `offset` 偏移后，按时间戳就近对齐挂到原文行上。
 *
 * @param entries `lyricApi.list()` 的返回值；`null` / `undefined` → 返回空数组。
 */
export function parseLyricEntries(entries: LyricEntry[]): LyricLine[] {
  if (!Array.isArray(entries) || !entries.length) return []
  const usable = entries.filter(
    (item) => item && typeof item.content === 'string' && item.content.trim() !== '',
  )
  if (!usable.length) return []

  // ---- 1. 选原文（T90-③）--------------------------------------------------
  // ⚠️ **优先级**：显式 `role:'original'` → 无 `role`（旧的位置约定）→ `role:'translation'`。
  const original =
    usable.find((item) => item.role === 'original') ??
    usable.find((item) => !item.role) ??
    usable.find((item) => item.role === 'translation')
  if (!original) return []

  // ---- 2. 其余条目按「翻译 / 罗马音」归类 --------------------------------
  // ⚠️ **多余的条目一律当翻译候选**（内容不丢）；只有显式 `role:'romanization'`
  //    的条目才当罗马音 ⇒ **没有 role 的条目永远不会被当成罗马音**。
  const translationCandidates: LyricEntry[] = []
  const romanizationCandidates: LyricEntry[] = []
  for (const item of usable) {
    if (item === original) continue
    if (item.role === 'romanization') {
      romanizationCandidates.push(item)
      continue
    }
    translationCandidates.push(item)
  }

  // ⚠️ 文件自带的 `[offset:±N]` 与服务端 `offset` 在**同一次**偏移里叠加
  //    （`parseEnhancedLrc` 内部求和）⇒ 两者的正负语义天然一致（正 = 延后）。
  const originalLines = parseEnhancedLrc(original.content, { offsetMs: original.offset ?? 0 })

  // ⚠️ **冗余副本要整条丢掉**（真机踩过的坑，2026-11-04）：
  //    实测 NAS 对**同一首歌**返回**两条 `source` 不同（1 / 2）但内容逐字相同**的记录
  //    ——它们是**同一份 LRC 的两份拷贝**，不是「原文 + 翻译」。
  //    若把第二条当翻译 → **每一句歌词都显示两遍**（一遍大字、一遍小字，字面完全一样）。
  //    ⇒ 内容（忽略空白）与偏移都相同的条目 → **直接丢弃**。
  //    ⚠️ 偏移不同的不算副本（偏移后时间线不同，仍是有效翻译）。
  const translationEntries = translationCandidates.filter(
    (item) =>
      (item.offset ?? 0) !== (original.offset ?? 0) ||
      !isSameText(item.content, original.content),
  )
  // ⚠️ 罗马音**同样**适用这条规则 ⇒ **罗马音与原文实质相同就不显示**
  //    （否则界面上会出现两遍一模一样的行）。
  const romanizationEntries = romanizationCandidates.filter(
    (item) =>
      (item.offset ?? 0) !== (original.offset ?? 0) ||
      !isSameText(item.content, original.content),
  )

  let result = originalLines
  if (translationEntries.length) {
    const translationLines: LyricLine[] = []
    for (const item of translationEntries) {
      for (const line of parseEnhancedLrc(item.content, { offsetMs: item.offset ?? 0 })) {
        translationLines.push(line)
      }
    }
    result = attachTranslations(originalLines, translationLines)
  }
  if (romanizationEntries.length) {
    const romanizationLines: LyricLine[] = []
    for (const item of romanizationEntries) {
      for (const line of parseEnhancedLrc(item.content, { offsetMs: item.offset ?? 0 })) {
        romanizationLines.push(line)
      }
    }
    result = attachRomanizations(result, romanizationLines)
  }
  return result
}
