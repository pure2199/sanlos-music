// ---------------------------------------------------------------------------
// 网易云「副行」（翻译 / 罗马音）以原文行为锚的重新定时（T90-⑧）
// ---------------------------------------------------------------------------
//
// 为什么需要它（2026-11-15 实测，详见规格 §16.2）
// ---------------------------------------------------------------------------
// 网易云给的 `tlyric`（翻译）与 `romalrc`（罗马音）都在 **`lrc`（行级原文）那条时间轴**上，
// 而 `yrc`（逐字原文）是**另一条轴**（实测行间差最大 **1899 ms**）。
//
// ⇒ 副行原样交给渲染层时，渲染层 `attachAuxiliary` 的「时间戳**精确匹配**」分支
//    **必然落空**（`romalrc` 的标签还是**厘秒**、`yrc` 行头是**毫秒**，精度也对不上）
//    ⇒ 退到「≤ 0.5 s 就近」⇒ 实测丢 **14%–72%** 的行，还可能挂错行。
//
// 本模块的做法（= 规格 §16.3）
// ---------------------------------------------------------------------------
//     原文行 --(纯文本相同 + 顺序单调)--> lrc 行 --(时间精确相等)--> 副行
//     输出 = [原文行的「原标签」] + 副行文本
//
// ⚠️ 输出**复用原文行的原标签**（逐字符一致）
//    ⇒ 渲染层的「精确匹配」分支**必然命中** ⇒ 有副行的那些行**零错行**。
//
// ⚠️ 为什么**不用**洛雪上游的 `fixTimeTag`（顺序配对 + 100 ms 容差）：
//    它的容差是 100 ms，而我们的轴差实测到 1899 ms ⇒ 照搬会丢 44/48 行。
//
// ⚠️ 本模块是**纯函数**：不 import 渲染层（`src/ui/lyrics/parse.ts` 跑在渲染进程里，
//    主进程不能反向依赖它）⇒ 自己解析 LRC 行头（口径与渲染层对齐）。
//
// ---------------------------------------------------------------------------

/** 一行 LRC。 */
interface TaggedLine {
  /** 行首时间标签的**原文**（含方括号）—— 输出时**原样复用**。 */
  tag: string
  /** 标签里的时间（**毫秒**，整数）。 */
  ms: number
  /** 纯文本（已去逐字标签、已去首尾空白）。 */
  text: string
}

/**
 * 行首时间标签：`[mm:ss.xx]` / `[mm:ss.xxx]` / `[mm:ss:xx]`（小数位最多 9 位）。
 *
 * ⚠️ 与渲染层 `src/ui/lyrics/parse.ts` 的 `TIME_TAG` **同一套口径**。
 */
const TIME_TAG = /^\[(\d+):(\d{1,2})(?:[.:](\d{1,9}))?\]/

/** 逐字标签：`<mm:ss.xx>`（增强 LRC 的词级标签）。 */
const WORD_TAG = /<\d+:\d{1,2}(?:[.:]\d{1,9})?>/g

/** LRC 的**同步校正标签**：`[offset:±N]`（不是歌词行 ⇒ 摘掉）。 */
const OFFSET_TAG = /\[offset:\s*[+-]?\d+\s*\]/i

/**
 * 时间标签 → 毫秒。
 *
 * ⚠️ 与渲染层 `tagToSeconds` **同一套口径**（先算秒、再按毫秒精度取整）
 *    ⇒ 两边算出来的毫秒**逐个相等**（副行才能靠「时间精确相等」配上）。
 */
function tagToMs(match: RegExpExecArray): number {
  const minutes = Number(match[1] ?? 0)
  const seconds = Number(match[2] ?? 0)
  const fractionText = match[3] ?? ''
  const fraction = fractionText === '' ? 0 : Number(fractionText) / 10 ** fractionText.length
  const total = Math.round((minutes * 60 + seconds + fraction) * 1000) / 1000
  return Math.round(total * 1000)
}

/** 去掉逐字标签，只留纯文本。 */
function stripWordTags(content: string): string {
  return content.replace(WORD_TAG, '').trim()
}

/** 桥接用的文本归一化：**去掉所有空白**（与渲染层 `isSameText` 同款口径）。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * 把一段 LRC 拆成「带行头」的行列表。
 *
 * ⚠️ 与渲染层 `parseRawLines` **同口径**：
 * - 没有时间标签的行（元信息标签 / 纯文本行）**丢掉**；
 * - `[offset:±N]` 摘掉；
 * - 一行**多个**时间标签 ⇒ **展开成多行**（同一段文本、多个时间）。
 *
 * @param raw LRC 文本（任意输入；非串 ⇒ 空数组）。
 */
function parseTaggedLines(raw: string): TaggedLine[] {
  const out: TaggedLine[] = []
  if (typeof raw !== 'string' || raw === '') return out
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    let rest = rawLine.trim()
    if (!rest) continue
    const offset = OFFSET_TAG.exec(rest)
    if (offset && offset.index === 0) {
      rest = rest.slice(offset[0].length).trim()
      if (!rest) continue
    }
    const tags: { tag: string; ms: number }[] = []
    for (;;) {
      const match = TIME_TAG.exec(rest)
      if (!match) break
      tags.push({ tag: match[0], ms: tagToMs(match) })
      rest = rest.slice(match[0].length).trim()
    }
    if (!tags.length) continue
    const text = stripWordTags(rest)
    for (const tag of tags) out.push({ tag: tag.tag, ms: tag.ms, text })
  }
  return out
}

/**
 * 把网易云的副行（翻译 / 罗马音）**重新定时**到原文行上（规格 §16.3）。
 *
 * 做法：**以原文行为锚** —— 原文行经「纯文本相同 + 顺序单调」找到 `lrc` 里对应的行，
 * 再用**时间精确相等**找到副行；输出时**复用原文行的原标签**。
 *
 * ⚠️ **宁缺勿错**：配不上的副行**直接丢弃**（不猜、不就近）。
 * ⚠️ **纯函数**：不改入参、不抛异常（任何畸形输入都退化成空串）。
 *
 * @param original 生产原文（逐字增强 LRC，或行级 LRC）。
 * @param lrc 网易云的**行级**原文（副行与它**精确同刻** ⇒ 它是唯一可靠的桥）。
 * @param auxiliary 副行（`tlyric` 翻译 / `romalrc` 罗马音）。
 * @returns 重新定时后的副行 LRC（空串 = 没有可用的副行）。
 */
export function alignNeteaseAuxiliary(original: string, lrc: string, auxiliary: string): string {
  const originalLines = parseTaggedLines(original)
  const auxiliaryLines = parseTaggedLines(auxiliary)
  if (!originalLines.length || !auxiliaryLines.length) return ''
  const lrcLines = parseTaggedLines(lrc)

  // 副行按**时间**建索引（同刻只留第一条 —— 与渲染层 `exact` 表同口径）。
  const auxiliaryByMs = new Map<number, TaggedLine>()
  for (const line of auxiliaryLines) {
    if (!line.text) continue
    if (!auxiliaryByMs.has(line.ms)) auxiliaryByMs.set(line.ms, line)
  }
  if (!auxiliaryByMs.size) return ''

  // lrc 行按**纯文本**建索引（保留出现顺序 —— 副歌重复时要按顺序配对）。
  const lrcByText = new Map<string, { line: TaggedLine; index: number }[]>()
  lrcLines.forEach((line, index) => {
    const key = normalizeText(line.text)
    if (!key) return
    const list = lrcByText.get(key) ?? []
    list.push({ line, index })
    lrcByText.set(key, list)
  })

  const out: string[] = []
  let cursor = 0
  for (const originalLine of originalLines) {
    const key = normalizeText(originalLine.text)
    if (!key) continue
    const candidates = lrcByText.get(key) ?? []
    // ⚠️ **顺序单调**：只往后找（同一句歌词重复出现时按出现顺序配对 ⇒ 不逆序）。
    let bridge: { line: TaggedLine; index: number } | undefined
    for (const candidate of candidates) {
      if (candidate.index >= cursor) {
        bridge = candidate
        break
      }
    }
    if (!bridge) continue
    // ⚠️ 选中了桥就**消费**它（哪怕那一行没有副行）
    //    ⇒ 后面重复的句子不会抢同一个桥 ⇒ 配对保持单调。
    cursor = bridge.index + 1
    const auxiliaryLine = auxiliaryByMs.get(bridge.line.ms)
    if (!auxiliaryLine) continue
    // ⚠️ **复用原文行的原标签** ⇒ 渲染层「时间戳精确匹配」必然命中 ⇒ 零错行。
    out.push(`${originalLine.tag}${auxiliaryLine.text}`)
  }
  return out.join('\n')
}
