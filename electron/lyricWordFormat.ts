// ---------------------------------------------------------------------------
// 逐字歌词的**格式转换**（主进程侧共用）
// ---------------------------------------------------------------------------
//
// 本模块回答一个问题：**「各家平台的逐字歌词，怎么变成统一的增强 LRC？」**
//
// - **网易云 yrc**（T67）：`[行开始ms,行时长ms](词开始ms,词时长ms,0)词文本…`
// - **QQ qrc**（T90-④）：`[行开始ms,行时长ms](词开始ms,词时长ms)词文本…`
// - **酷狗 KRC**（T90-⑤）：`[行开始ms,行时长ms]<相对ms,词时长ms,0>词文本…`
//   （⚠️ 词时间是**相对行开始**的 ⇒ 绝对 = 行首 + 相对）
//
// ⇒ 三者都转成**标准增强 LRC**（`[mm:ss.xx]<mm:ss.xx>词…`），
//    交给**现有**的 `parseWordSegments` ⇒ **渲染层解析器一字不改**。
//
// ⚠️ **只放纯函数**：不碰网络、不碰 Electron、不碰 Node 内置模块
//    （`electron/lyricProvider.ts` 的纪律：模块顶层不得 import Electron）。
//
// ⚠️ **解密**不在这里 —— QQ 的 qrc 解密在 `electron/lyricCodecs/qrc.ts`，
//    酷狗的 krc 解密在 `electron/lyricCodecs/krc.ts`
//    （两者都是 **Node 专属**的纯实现，与本模块刻意分开）。
// ---------------------------------------------------------------------------

/**
 * 毫秒 → LRC 时间标签。
 *
 * - 整除 10 ⇒ 用**厘秒**（`[mm:ss.xx]`），否则用**毫秒**（`[mm:ss.xxx]`）
 *   ⇒ **既短又不丢精度**（实测 yrc / qrc 的时间基本都是 10 的倍数）。
 * - 负数 ⇒ 钳到 **0**（不产出负时间标签）。
 *
 * @param ms 毫秒（**绝对**时间）。
 * @returns 形如 `00:10.00` / `00:10.005` 的标签内容（**不含**方括号 / 尖括号）。
 */
export function msToLrcTag(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const rest = total % 1000
  const fraction =
    rest % 10 === 0 ? String(rest / 10).padStart(2, '0') : String(rest).padStart(3, '0')
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fraction}`
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
// ---------------------------------------------------------------------------
// 词内空白 ⇒ 拆成多个独立词（T90-④-b）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要在转换层拆**（而不是改渲染层）：
//
// QQ / 网易云都会把**整段英文**（含空格）塞进**一个**词元组
// （实测《孤勇者》有 1 个词：18 字符、3 个普通空格）。
// ⇒ 渲染层的 `LyricView.buildSegments` 会按空白把它**拆成多个 DOM 元素**
//   （**共用同一个 `data-word`**）⇒ 卡拉OK 填色时**每个片段各自从 0 起算**
//   ⇒ 视觉上就是「**填色分段重置**」。
//
// ⚠️ **不能改渲染层**：`test/lyric-view.test.tsx` **显式钉住**了
// 「含空格的词被拆成多个片段、共享一个词号、一起染色」这个行为
// ⇒ 改它等于**推翻既有断言**。
//
// ⇒ 正解：**转换层**就别产出「内部含空白的词」——
//   把它按空白拆成**多个独立词**，并按字符数比例分配时间
//   ⇒ 渲染层看到的是「每个词内部没有空白」⇒ **不会拆**
//   ⇒ 填色**逐词连续推进**，不再分段重置。

/**
 * 把一个**词文本**按空白拆成多个片段。
 *
 * **规则（定死）**：
 * 1. 没有空白 ⇒ 原样返回（**一个**片段）；
 * 2. 按**空白串**切开 ⇒ 空白**跟着它前面的片段**走（`A B` ⇒ `['A ', 'B']`）
 *    ⇒ 拼回去**逐字等于原文**（不丢空格）；
 * 3. **纯空白**的片段（词首/词尾多出来的空格）**并进相邻的有字片段**
 *    ⇒ 否则渲染层 trim 之后那个片段会「消失」（凭空少一个词）；
 * 4. 整段都是空白 ⇒ **不拆**（返回原串）。
 *
 * @param text 词文本（**原样**，不 trim）。
 * @returns 片段数组（拼起来 === 原文）。
 */
export function splitWordByWhitespace(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  if (!/\s/.test(text)) return [text]
  const parts = text.split(/(\s+)/)
  const raw: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const merged = `${parts[i] ?? ''}${parts[i + 1] ?? ''}`
    if (merged !== '') raw.push(merged)
  }
  const out: string[] = []
  let pending = ''
  for (const piece of raw) {
    if (piece.replace(/\s+/g, '') === '') {
      // ⚠️ 纯空白片段 ⇒ 并进**下一个**有字的片段（否则渲染层 trim 后它会「消失」）。
      pending += piece
      continue
    }
    out.push(`${pending}${piece}`)
    pending = ''
  }
  if (pending) {
    // 结尾的纯空白 ⇒ 并进**上一个**。
    if (out.length) out[out.length - 1] = `${out[out.length - 1]!}${pending}`
    else return [text]
  }
  return out
}

/**
 * 把一行里的词表里「**内部含空白**」的词**拆成多个独立词**（时间按字符数比例分配）。
 *
 * ⚠️ **时间口径必须与渲染层 `assemble` 一致**：
 *   渲染层给每个词的**词尾** =「**下一个词的起点**」；行内最后一个词 ⇒「**下一行的行时间**」
 *   （没有下一行 ⇒ 行时间 + 0.5s）。
 *   ⇒ 拆出来的片段**正好铺满**这个词的时间区间 ⇒ 填色**连续**，不会分段重置。
 *
 * ⚠️ **跨度不够就不拆**：片段数 ≥ 跨度（毫秒）⇒ 必然出现「零长度的词」
 *   （渲染层会算出 `end === start` ⇒ 比例除零）⇒ 那就**保持原样**（宁可不变形）。
 *
 * @param words 一行内的词（**绝对毫秒** + 文本），**按时间递增**。
 * @param lineEnd 该行在渲染层的**行尾时间**（下一行行时间；无则行时间 + 0.5s）。
 */
export function splitWordsAtWhitespace(
  words: { start: number; text: string }[],
  lineEnd: number,
): { start: number; text: string }[] {
  if (!Array.isArray(words) || !words.length) return []
  const out: { start: number; text: string }[] = []
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    const next = words[i + 1]
    // ⚠️ **词尾口径与渲染层 `assemble` 逐字一致**。
    const end = next
      ? Math.max(word.start, next.start)
      : lineEnd > word.start
        ? lineEnd
        : word.start + 500
    const fragments = splitWordByWhitespace(word.text)
    if (fragments.length <= 1) {
      out.push(word)
      continue
    }
    const weights = fragments.map((fragment) => fragment.replace(/\s+/g, '').length)
    const total = weights.reduce((sum, value) => sum + value, 0)
    const span = end - word.start
    // ⚠️ **全是空白**或**跨度不够** ⇒ 不拆（保持原样）。
    if (total <= 0 || span < fragments.length) {
      out.push(word)
      continue
    }
    const starts: number[] = []
    let acc = 0
    fragments.forEach((_fragment, index) => {
      let value = Math.round(word.start + (span * acc) / total)
      // ⚠️ 片段起点必须**严格递增**（否则会出现零长度的词 ⇒ 比例除零）。
      const previous = starts[starts.length - 1]
      if (previous !== undefined && value <= previous) value = previous + 1
      starts.push(value)
      acc += weights[index]!
    })
    // ⚠️ 最后一个片段的起点必须**小于词尾**（否则它会盖住下一个词）。
    if (starts[starts.length - 1]! >= end) {
      out.push(word)
      continue
    }
    fragments.forEach((fragment, index) => {
      out.push({ start: starts[index]!, text: fragment })
    })
  }
  return out
}

export function yrcToEnhancedLrc(yrc: string): string {
  if (typeof yrc !== 'string' || yrc === '') return ''
  // --- ① 解析出所有**带行头**的行（**两遍**：第二遍才知道「下一行行时间」）---
  const candidates: { lineStart: number; rest: string }[] = []
  for (const rawLine of yrc.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const head = /^\[(\d+),(\d+)\]/.exec(line)
    if (!head) continue
    const lineStart = Number(head[1])
    if (!Number.isFinite(lineStart)) continue
    candidates.push({ lineStart, rest: line.slice(head[0].length) })
  }
  const out: string[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const { lineStart, rest } = candidates[index]!
    // ⚠️ **行尾** = 下一行的行时间（与渲染层 `assemble` 同口径）。
    const nextLineStart = candidates[index + 1]?.lineStart
    const lineEnd = nextLineStart !== undefined ? nextLineStart : lineStart + 500

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
    // ⚠️ **词内含空白** ⇒ 拆成多个独立词（否则渲染层会把填色分段重置）。
    const expanded = splitWordsAtWhitespace(words, lineEnd)
    const body = expanded.map((word) => `<${msToLrcTag(word.start)}>${word.text}`).join('')
    out.push(`[${msToLrcTag(lineStart)}]${leading}${body}`)
  }
  return out.join('\n')
}

// QRC → 增强 LRC
// ---------------------------------------------------------------------------

/** QRC 的行头：`[行开始ms,行时长ms]`。 */
const QRC_LINE_HEAD = /^\[(\d+),(\d+)\]/

/** QRC 的词元组：`(词开始ms,词时长ms)`。 */
const QRC_WORD_TUPLE = /\((\d+),(\d+)\)/g

// ---------------------------------------------------------------------------
// 元信息行过滤（QQ 的 QRC 会把**制作信息**混在歌词行里）
// ---------------------------------------------------------------------------
//
// 实测（2026-11-14，孤勇者）：69 行带行头的行里，**12 行是制作信息**：
//
//     词：X     曲：X     编曲：X   吉他：X   人声录音师：X   混音/母带：X
//     词版权管理方：X   曲版权管理方：X   录音作品及MV版权：X
//     出品监制：X     制作人：X   联合出品方：X
//
// ⇒ 不过滤的话，**制作信息会当成歌词显示出来**。
// ⇒ 滤干净之后：**57 行歌词 + 12 行制作信息 = 69 行**（活体验证已核对）。
//
// ⚠️ **角色词白名单与 T74a（酷狗 KRC）同一套** —— QQ 的 QRC 与酷狗的 KRC 在这一点上同形。

/**
 * 制作信息的**角色词**白名单（**精确匹配**用）。
 *
 * ⚠️ 与 T74a（酷狗 KRC 规格 §3.3）**逐字一致** —— 两条链路的元信息形态相同，
 *    口径必须一样（否则同一个角色词在两个源上判定结果不同 ⇒ 行为不可预测）。
 * ⚠️ 末尾几项是 **QQ 的 QRC 实测**到的复合角色词（QQ 比酷狗多）。
 */
const QRC_META_ROLES: readonly string[] = [
  '词',
  '曲',
  // ↓ 酷狗 KRC 实测到的（T90-⑤）：QQ 的 QRC 写「词：X」「曲：X」，
  //    酷狗的 KRC 写的是「**作词**：X」「**作曲**：X」⇒ 不补这两个会**漏网**
  //    （制作信息会被当成歌词显示出来）。
  '作词',
  '作曲',
  '编曲',
  '监制',
  '出品',
  '制作人',
  '录音',
  '混音',
  '母带',
  '和声',
  '吉他',
  '贝斯',
  '鼓',
  '弦乐',
  '键盘',
  '语言',
  '演唱',
  '歌手',
  '专辑',
  '发行',
  '策划',
  '统筹',
  '封面',
  'OP',
  'SP',
  '特别鸣谢',
  '原唱',
  '和声制作',
  '鼓手',
  '乐手',
  '音乐制作',
  '录音师',
  '混音师',
  '母带师',
  // ↓ QQ 的 QRC 实测到的复合角色词
  '出品方',
  '出品监制',
  '混音/母带',
  '词版权管理方',
  '曲版权管理方',
  '录音作品及MV版权',
  '联合出品方',
  '人声录音棚',
  'Vocal edite',
]

/**
 * 制作信息角色词的**后缀**白名单（**只收 ≥ 2 字**的）。
 *
 * ⚠️ 为什么要有后缀：QQ 的角色词**带修饰前缀**（实测 `联合出品方：X`）
 *    ⇒ 只按「开头匹配」会漏掉 ⇒ 「以角色词**结尾** + 角色部分**够短**」才是通用形态。
 * ⚠️ **不收单字**（`鼓` / `词` / `曲`）：单字结尾太容易撞上歌词
 *    （「他在敲鼓：」这种 ⇒ 不能误杀歌词行）。
 */
const QRC_META_SUFFIXES: readonly string[] = [
  // ↓ 酷狗 KRC 实测（T90-⑤）：「作词」「作曲」是 **2 字** ⇒ 可以安全进后缀表
  //    （覆盖「联合作词：X」这种带修饰前缀的复合角色词）。
  //    ⚠️ 单字 `词` / `曲` **仍然不进**（见上面的说明：「词不达意：」那种歌词行会被误杀）。
  '作词',
  '作曲',
  '出品方',
  '出品',
  '监制',
  '制作人',
  '制作',
  '编曲',
  '混音',
  '母带',
  '录音',
  '录音棚',
  '吉他',
  '贝斯',
  '和声',
  '弦乐',
  '键盘',
  '策划',
  '统筹',
  '封面',
  '专辑',
  '发行',
  '特别鸣谢',
  '原唱',
  '版权',
  '版权管理方',
  '演唱',
  '歌手',
  '鼓手',
  '乐手',
  '音乐制作',
  '录音师',
  '混音师',
  '母带师',
  '配唱制作人',
  '人声编辑',
  '音频编辑',
  '音乐发行',
  'ISRC',
  'OP',
  'SP',
]

/**
 * 制作信息角色词的**前缀**白名单（**只收 ≥ 2 字**的）。
 *
 * ⚠️ **单字角色词（`词` / `曲` / `鼓` …）不进这里** —— 它们只走「精确匹配」。
 *    否则「词不达意：…」这种**歌词行**会被误杀（内容丢失比多显示一行制作信息严重得多）。
 */
const QRC_META_PREFIXES: readonly string[] = [
  '编曲',
  '监制',
  '出品',
  '制作人',
  '录音',
  '录音棚',
  '混音',
  '母带',
  '和声',
  '吉他',
  '贝斯',
  '弦乐',
  '键盘',
  '语言',
  '演唱',
  '歌手',
  '专辑',
  '发行',
  '策划',
  '统筹',
  '封面',
  'OP',
  'SP',
  '特别鸣谢',
  '原唱',
  '和声制作',
  '鼓手',
  '乐手',
  '音乐制作',
  '录音师',
  '混音师',
  '母带师',
]

/** 角色部分的**长度上限**（后缀规则用）—— 短 ⇒ 是角色词；长 ⇒ 是歌词句。 */
const QRC_META_ROLE_MAX_LENGTH = 6

/** 前缀规则里「角色词之后那段」的长度上限。 */
const QRC_META_TAIL_MAX_LENGTH = 12

/** 角色部分里**不许**出现的字符（标点 / 空白）—— 有 ⇒ 是歌词句，不是角色词。 */
const QRC_META_ROLE_FORBIDDEN = /[\s：:，。！？、；,.;!?]/

/**
 * **英文**角色词（QQ 的 QRC 里偶尔出现，实测 `Vocal edite：…`）。
 *
 * ⚠️ **只收「多词」形态**（**必须含空格**）：单个英文词（`Mixing` / `Baby`）
 *    极容易撞上歌词（「Baby：Don't cry」这种 ⇒ **不能误杀歌词行**）。
 * ⇒ `Vocal edite` / `Mixing Engineer` / `Arranged by` 这类**两个词以上**的才收。
 */
const QRC_META_ENGLISH_ROLE = /^[A-Za-z]+(?:\s+[A-Za-z]+)+$/

/** 英文角色词的**长度上限**（防「一整句英文歌词」被当成角色词）。 */
const QRC_META_ENGLISH_ROLE_MAX_LENGTH = 20

/**
 * 判断一行文本**是不是制作信息行**（`词：X` / `混音/母带：X` / `联合出品方：X` …）。
 *
 * **规则（定死）**：先把**第一个冒号**之前当作「角色部分」，再三选一：
 *
 * - **A. 精确命中**白名单（`词` `曲` `编曲` `混音/母带` `录音作品及MV版权` …）；
 * - **B. 后缀命中**：角色部分 **≤ 6 字**且以某个**多字**角色词**结尾**
 *   （覆盖 `联合出品方` 这类**带修饰前缀**的复合角色词）；
 * - **C. 前缀命中**：角色部分以某个**多字**角色词**开头**，且剩下的 ≤ 12 字、
 *   **不含标点 / 空白**（覆盖 `录音作品及MV版权`）；
 * - **D. 英文多词角色词**：角色部分**只由拉丁字母与空格**组成、**至少含一个空格**
 *   且 ≤ 20 字符（覆盖 QQ 实测到的 `Vocal edite：…`）。
 *
 * ⚠️ 比 T74a **更严**（T74a 是「前缀白名单命中 ⇒ 无条件跳过」）——
 *    本仓库实测发现「只按前缀」既会**误杀歌词行**（歌词里以「曲」「词」开头的句子很多），
 *    又会**漏掉复合角色词**（`联合出品方`）⇒ 必须三管齐下。
 *
 * ⚠️ **D 为什么要「必须含空格」**：`Mixing` / `Baby` 这种**单个**英文词
 *    很容易撞上歌词（「Baby：Don't cry」）⇒ **宁可漏掉一行制作信息，
 *    也不能误杀一句歌词**（丢内容比多显示一行严重得多）。
 *
 * @param text 该行正文（**已去掉词元组**、已 trim）。
 */
export function isQrcCreditLine(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false
  const colon = text.search(/[：:]/)
  if (colon < 0) return false
  const role = text.slice(0, colon).trim()
  if (!role) return false
  // A. 精确命中
  if (QRC_META_ROLES.includes(role)) return true
  // D. 英文**多词**角色词（实测 `Vocal edite：…`）
  if (
    role.length <= QRC_META_ENGLISH_ROLE_MAX_LENGTH &&
    QRC_META_ENGLISH_ROLE.test(role)
  ) {
    return true
  }
  // B. 后缀命中（角色部分要**短**）
  if (role.length <= QRC_META_ROLE_MAX_LENGTH) {
    for (const suffix of QRC_META_SUFFIXES) {
      if (role.endsWith(suffix)) return true
    }
  }
  // C. 前缀命中（**多字**角色词 + 不含标点的短后缀）
  for (const prefix of QRC_META_PREFIXES) {
    if (!role.startsWith(prefix)) continue
    const tail = role.slice(prefix.length)
    if (tail.length > QRC_META_TAIL_MAX_LENGTH) continue
    if (QRC_META_ROLE_FORBIDDEN.test(tail)) continue
    return true
  }
  return false
}

/**
 * **标题行的识别提示**（来自**搜索结果**的歌名）。
 *
 * ⚠️ **为什么需要它**（真机回归实测，2026-11-14）：
 *    QQ 的 QRC 标题行**不短** —— 实测《孤勇者》的那一行有 **45 字**：
 *    `孤勇者 (《英雄联盟：双城之战》动画剧集中文主题曲) - 陈奕迅 (Eason Chan)`
 *    ⇒ 「长度 ≤ 30」的启发式**判不出**它 ⇒ **整行标题被当成歌词显示出来**。
 *
 * ⇒ 有了**歌名**，判据就精确了：**这一行以歌名开头** ⇒ 它就是标题行
 *    （不论多长、不论在第几条）。
 */
export interface QrcTitleHint {
  /** 歌名（**搜索结果里的歌名**）。 */
  title?: string
}

/**
 * 从歌名里取出「**括号前**的那一段」（`孤勇者 (Live)` ⇒ `孤勇者`）。
 *
 * ⚠️ QQ 的 QRC 标题行常常在歌名后面**跟一段括号说明** ⇒ 用「括号前的部分」
 *    去比对，才对得上（搜索到的歌名可能带后缀，QRC 里的也可能带）。
 */
function titleCore(title: string): string {
  const trimmed = title.trim()
  const cut = trimmed.search(/[（(【\[「『]/)
  const core = cut >= 0 ? trimmed.slice(0, cut).trim() : trimmed
  return core
}

/**
 * 判断一行文本**是不是标题行**（`歌名 - 歌手`）。
 *
 * **两条判据（任一命中即是）**：
 *
 * - **① 带提示时**：这一行**以歌名开头**且含 ` - `
 *   （⇒ 长标题行也能认出来；实测《孤勇者》那条 45 字的标题行）；
 * - **② 无提示时（兜底）**：**前 5 条带行头的候选行**内、长度 ≤ 30 字、含 ` - `
 *   （T74a 同口径；**既有行为与既有断言一条不改**）。
 *
 * ⚠️ **为什么是「前 5 条候选行」而不是「前 5 条源行」**：
 *    QQ 的 QRC 头部有 **12 行无行头**的元信息（`[ti:]` 之类）⇒ 按源行数计，
 *    「前 5 行」永远是头部 ⇒ 标题行规则**永不生效**（等于没有）⇒ 改成按
 *    **带行头的候选行**计数才有意义。
 *
 * ⚠️ **① 为什么要「含 ` - `」**：光「以歌名开头」会误杀**歌词里出现歌名**的行
 *    （《孤勇者》的歌词里就有「孤勇者」三个字）⇒ 必须再要求这一行**像**标题
 *    （含 `歌名 - 歌手` 的分隔）。
 *
 * @param text 该行正文（**已去掉词元组**、已 trim）。
 * @param candidateIndex 该行是**第几条带行头的候选行**（0 起）。
 * @param hint 标题识别提示（**可选**；不给就走兜底判据）。
 */
export function isQrcTitleLine(
  text: string,
  candidateIndex: number,
  hint?: QrcTitleHint,
): boolean {
  if (typeof text !== 'string' || text === '') return false
  // ① 带提示：**以歌名开头** + 含 ` - ` ⇒ 标题行（不看长度、不看位置）。
  const core = titleCore(hint?.title ?? '')
  if (core && text.startsWith(core) && text.includes(' - ')) return true
  // ② 兜底（T74a 同口径）。
  if (candidateIndex >= 5) return false
  if (text.length > 30) return false
  return text.includes(' - ')
}

/**
 * 判断一行文本**是不是元信息行**（制作信息 **或** 标题行）。
 *
 * @param text 该行正文（**已去掉词元组**、已 trim）。
 * @param candidateIndex 该行是**第几条带行头的候选行**（0 起）。
 * @param hint 标题识别提示（**可选**）。
 */
export function isQrcMetaLine(
  text: string,
  candidateIndex: number,
  hint?: QrcTitleHint,
): boolean {
  return isQrcCreditLine(text) || isQrcTitleLine(text, candidateIndex, hint)
}

/**
 * QRC 的**词时间基准**。
 *
 * ⚠️ **实测（2026-11-14）**：QQ 的 QRC 词时间是**绝对毫秒**（与行首同量纲；
 *    样本第 40 行：行首 93766、首词 93766、末词 95181，**全部 ≥ 行首**）。
 *
 * ⇒ 判定规则（**定死**）：**词时间 ≥ 行首 ⇒ 绝对**；否则 ⇒ **相对**（加上行首）。
 *    —— 保留「相对基准」的兜底，是为了个别歌曲的数据形状不同也不会整首跑偏。
 *
 * ⚠️ 为什么不会判错：相对基准时，**第一个词**的相对时间通常是 0 ⇒ `0 < 行首`
 *    ⇒ 判成相对 ⇒ 绝对 = 行首（正确）；绝对基准时第一个词的绝对时间 == 行首
 *    ⇒ `≥` ⇒ 判成绝对（正确）⇒ **两种基准的第一词结果一致**。
 */
function resolveWordTime(wordMs: number, lineStartMs: number): number {
  return wordMs >= lineStartMs ? wordMs : lineStartMs + wordMs
}

/**
 * 把 **QRC 明文**（逐字）转成**增强 LRC**（`[mm:ss.xx]<mm:ss.xx>词…`）。
 *
 * **规则（定死）**：
 * 1. 行头只认 `[起ms,时长ms]`；**无行头**的行（`[ti:]` / `[ar:]` 之类）**丢掉**；
 * 2. **元信息行**（制作信息 / 标题行）**丢掉**（见 {@link isQrcMetaLine}）——
 *    ⚠️ 实测 QQ 的 QRC 会把**制作信息**混在带行头的歌词行里，不过滤就会显示出来；
 * 3. 行内按**顺序扫描**找词元组 ⇒ 词文本里的括号**不会错位**；
 * 4. 词元组之间的文本 = 该词的文本（**原样保留**，不 trim 词内空格）；
 * 5. 词时间按 {@link resolveWordTime} 归一 ⇒ 输出**绝对**毫秒；
 * 6. **零时长词**（实测是标点 / 停顿占位）→ **并入前一个词**，不单独成词；
 * 7. **空文本的词**（实测：QRC **每行末尾**都有一个「没有文字的终止标记」）
 *    → **不产出标签**（没有文字的「词」不是词）；
 * 8. 一行里**没有有效词** → 只输出行级标签（行级 LRC）；
 * 9. **词内含空白**（实测：QQ 把**整段英文**塞进一个词元组）→ **拆成多个独立词**，
 *    时间按字符数比例分配（见 {@link splitWordsAtWhitespace}）⇒ 渲染层不会拆它
 *    ⇒ 卡拉OK 填色**不会分段重置**；
 * 10. 空串 / 非串 → 返回空串（**不抛异常**）。
 *
 * @param qrc 解密后的 QRC 明文。
 * @param hint 标题识别提示（**可选**：QQ 的 QRC 标题行可以很长 ⇒ 靠**歌名**认更准）。
 * @returns 标准增强 LRC（多行，行间 `\n`）。
 */
export function qrcToEnhancedLrc(qrc: string, hint?: QrcTitleHint): string {
  if (typeof qrc !== 'string' || qrc === '') return ''
  // --- ① 解析出所有**带行头**的候选行 -----------------------------------------
  // ⚠️ **要两遍**：拆词需要「**下一行行时间**」（= 渲染层给的行尾）⇒ 得先知道全部行。
  const candidates: { lineStart: number; rest: string; candidateIndex: number }[] = []
  for (const rawLine of qrc.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const head = QRC_LINE_HEAD.exec(line)
    if (!head) continue // 无行头（`[ti:]` 之类 / 不是歌词行）→ 丢掉
    const lineStart = Number(head[1])
    if (!Number.isFinite(lineStart)) continue
    candidates.push({
      lineStart,
      rest: line.slice(head[0].length),
      // 带行头的候选行的序号（0 起）—— 标题行规则用。
      candidateIndex: candidates.length,
    })
  }

  // --- ② 丢掉**元信息行**（制作信息 / 标题行）--------------------------------
  // ⚠️ **被丢掉的行不参与「下一行行时间」的计算** ⇒ 与渲染层看到的一致。
  const lyricLines: typeof candidates = []
  for (const item of candidates) {
    const plainText = item.rest.replace(QRC_WORD_TUPLE, '').trim()
    if (isQrcMetaLine(plainText, item.candidateIndex, hint)) continue
    lyricLines.push(item)
  }

  // --- ③ 转换 ----------------------------------------------------------------
  const out: string[] = []
  for (let index = 0; index < lyricLines.length; index += 1) {
    const { lineStart, rest } = lyricLines[index]!
    // ⚠️ **行尾** = 下一行的行时间（与渲染层 `assemble` 同口径）。
    const nextLineStart = lyricLines[index + 1]?.lineStart
    const lineEnd = nextLineStart !== undefined ? nextLineStart : lineStart + 500

    // 词元组（**按顺序扫描** ⇒ 词文本里的括号不会错位）。
    const pattern = new RegExp(QRC_WORD_TUPLE.source, 'g')
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

    // ⚠️ **元信息行**已在上面（②）丢掉（实测 QQ 的 QRC 里混着 14 行制作信息）。

    if (!marks.length) {
      // 没有词元组 ⇒ **行级**歌词行（翻译 / 罗马音就是这个形状）。
      const text = rest.trim()
      if (!text) continue
      out.push(`[${msToLrcTag(lineStart)}]${text}`)
      continue
    }

    // 零时长词**并入前一个词**（实测是标点 / 停顿占位），不单独成词。
    const words: { start: number; text: string }[] = []
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i]!
      const textEnd = i + 1 < marks.length ? marks[i + 1]!.to : rest.length
      const text = rest.slice(mark.from, textEnd)
      if (mark.dur === 0) {
        const previous = words[words.length - 1]
        if (previous) previous.text += text
        continue
      }
      // ⚠️ **空文本的词** → **不产出标签**。
      //    实测（2026-11-14，孤勇者）：QRC **每行末尾**都有一个「没有文字的终止标记」
      //    （57 行 ⇒ 57 个）⇒ 若照样产出标签，增强 LRC 里就会多出 57 个空标签。
      //    ⇒ 渲染层的 `parseWordSegments` 本来也会把它们丢掉（空文本 ⇒ 不成词），
      //    所以**用户看不到**；但那是有 57 个「词」的**假数据**（词数对不上、时间轴带噪点）
      //    ⇒ 在**转换层**就滤掉。
      if (text === '') continue
      words.push({ start: resolveWordTime(mark.start, lineStart), text })
    }
    if (!words.length) continue

    // 第一个词元组**之前**的文本（实测通常为空）→ 并进第一个词。
    const leading = rest.slice(0, marks[0]!.to).trim()
    if (leading) {
      const first = words[0]
      if (first) first.text = leading + first.text
    }

    // ⚠️ **词内含空白** ⇒ 拆成多个独立词（否则渲染层会把填色分段重置）。
    const expanded = splitWordsAtWhitespace(words, lineEnd)
    const body = expanded.map((word) => `<${msToLrcTag(word.start)}>${word.text}`).join('')
    out.push(`[${msToLrcTag(lineStart)}]${body}`)
  }
  return out.join('\n')
}

/**
 * 把 **QRC 明文**（翻译 / 罗马音：只有行头，没有词元组）转成**行级 LRC**。
 *
 * ⚠️ 副行**没有逐字时间** ⇒ 只保留文本（词元组**整条摘掉**）。
 * ⚠️ **元信息行**同样**丢掉**（与 {@link qrcToEnhancedLrc} 同一口径）。
 *
 * @param qrc 解密后的 QRC 明文。
 */
export function qrcToPlainLrc(qrc: string): string {
  if (typeof qrc !== 'string' || qrc === '') return ''
  const out: string[] = []
  let candidateIndex = 0
  for (const rawLine of qrc.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const head = QRC_LINE_HEAD.exec(line)
    if (!head) continue
    const lineStart = Number(head[1])
    if (!Number.isFinite(lineStart)) continue
    const currentIndex = candidateIndex
    candidateIndex += 1
    const text = line.slice(head[0].length).replace(QRC_WORD_TUPLE, '').trim()
    if (!text) continue
    if (isQrcMetaLine(text, currentIndex)) continue
    out.push(`[${msToLrcTag(lineStart)}]${text}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 酷狗 KRC（真逐字）→ 增强 LRC（T90-⑤）
// ---------------------------------------------------------------------------
//
// 行形状（2026-11-14 本机实测，三首：孤勇者 / 一路向北 / Counting Stars）：
//
//     [行开始ms,行时长ms]<相对ms,词时长ms,0>词文本<相对ms,词时长ms,0>词文本…
//
// ⚠️ **与 QRC 的两处关键差异**（转换器必须区别对待）：
//
// 1. 词元组是**尖括号** `<>`（不是圆括号）；
// 2. 词时间是**相对行开始**的毫秒 ⇒ **绝对 = 行首 + 相对**
//    ⇒ ⚠️ **不能**用 QRC 那套「相对值 ≥ 行首 ⇒ 判绝对」的逐词判据
//       （KRC 的行内相对值**可以超过行首的毫秒数** ⇒ 长句会误判 ⇒ 填色偏 1 秒）。
//
// ⚠️ **元信息行的规则与 QRC 共用**（`isQrcMetaLine`）：
//    QQ 的 QRC 与酷狗的 KRC 在这一点上**同形**（制作信息 + 标题行）
//    ⇒ 同一套规则 ⇒ 两个源的行为一致（否则同一个角色词在两个源上判定不同，
//    行为不可预测）。
//    ⚠️ 酷狗实测的角色词里多了「**作词**」「**作曲**」⇒ 已补进白名单。

/** KRC 的行头：`[行开始ms,行时长ms]`。 */
const KRC_LINE_HEAD = /^\[(\d+),(\d+)\]/

/** KRC 的词元组：`<相对ms,词时长ms,0>`。 */
const KRC_WORD_TUPLE = /<(\d+),(\d+),(\d+)>/g

/**
 * 把 **KRC 明文**（逐字）转成**增强 LRC**（`[mm:ss.xx]<mm:ss.xx>词…`）。
 *
 * **规则（定死，规格 §13.4）**：
 * 1. 行头只认 `[起ms,时长ms]`；**无行头**的行（`[id:]` / `[ti:]` / `[ar:]` 之类）**丢掉**
 *    （实测《孤勇者》81 行里 **11 行**是无行头的元信息）；
 * 2. **元信息行**（制作信息 / 标题行）**丢掉**（见 {@link isQrcMetaLine}）；
 * 3. 行内按**顺序扫描**找词元组（只认数字形状）⇒ 词文本里的尖括号**不会错位**；
 * 4. 词文本 = 词元组之间的内容（**原样保留**，不 trim 词内空格）；
 * 5. 词的绝对时间 = **行首 + 相对毫秒**（KRC 的词时间**一律相对**）；
 * 6. **零时长词**（实测《孤勇者》4 个）→ **并入前一个词**，不单独成词；
 * 7. **空文本的词** → **不产出标签**（没有文字的「词」不是词）；
 * 8. **词内含空白** → **拆成多个独立词**（见 {@link splitWordsAtWhitespace}）
 *    ⇒ 渲染层不会拆它 ⇒ 卡拉OK 填色**不会分段重置**
 *    （实测《Counting Stars》**432 / 547** 个词元组含空白 ⇒ 不拆必然错）；
 * 9. 一行里**没有有效词** → **跳过该行**；
 * 10. 空串 / 非串 → 返回空串（**不抛异常**）。
 *
 * @param krc 解密后的 KRC 明文。
 * @param hint 标题识别提示（**可选**：酷狗的标题行可以很长 ⇒ 靠**歌名**认更准）。
 * @returns 标准增强 LRC（多行，行间 `\n`）。
 */
export function krcToEnhancedLrc(krc: string, hint?: QrcTitleHint): string {
  if (typeof krc !== 'string' || krc === '') return ''
  // --- ① 解析出所有**带行头**的候选行 -----------------------------------------
  // ⚠️ **要两遍**：拆词需要「**下一行行时间**」（= 渲染层给的行尾）⇒ 得先知道全部行。
  const candidates: { lineStart: number; rest: string; candidateIndex: number }[] = []
  for (const rawLine of krc.split(/\r\n|\r|\n/)) {
    // ⚠️ 解密后的明文**可能带 UTF-8 BOM**（实测部分文件带）⇒ 显式剥掉。
    const line = rawLine.replace(/^\uFEFF/, '').trim()
    if (!line) continue
    const head = KRC_LINE_HEAD.exec(line)
    if (!head) continue // 无行头（`[id:]` 之类 / 不是歌词行）→ 丢掉
    const lineStart = Number(head[1])
    if (!Number.isFinite(lineStart)) continue
    candidates.push({
      lineStart,
      rest: line.slice(head[0].length),
      // 带行头的候选行的序号（0 起）—— 标题行规则用。
      candidateIndex: candidates.length,
    })
  }

  // --- ② 丢掉**元信息行**（制作信息 / 标题行）--------------------------------
  // ⚠️ **被丢掉的行不参与「下一行行时间」的计算** ⇒ 与渲染层看到的一致。
  const lyricLines: typeof candidates = []
  for (const item of candidates) {
    const plainText = item.rest.replace(KRC_WORD_TUPLE, '').trim()
    if (isQrcMetaLine(plainText, item.candidateIndex, hint)) continue
    lyricLines.push(item)
  }

  // --- ③ 转换 ----------------------------------------------------------------
  const out: string[] = []
  for (let index = 0; index < lyricLines.length; index += 1) {
    const { lineStart, rest } = lyricLines[index]!
    // ⚠️ **行尾** = 下一行的行时间（与渲染层 `assemble` 同口径）。
    //    ⚠️ **KRC 自带的行时长不能用**（实测行 11 的行时长 7433ms，
    //    而「下一行行首 − 行首」= 7499ms ⇒ 是源给的另一套口径）。
    const nextLineStart = lyricLines[index + 1]?.lineStart
    const lineEnd = nextLineStart !== undefined ? nextLineStart : lineStart + 500

    // 词元组（**按顺序扫描** ⇒ 词文本里的尖括号不会错位）。
    const pattern = new RegExp(KRC_WORD_TUPLE.source, 'g')
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
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i]!
      const textEnd = i + 1 < marks.length ? marks[i + 1]!.to : rest.length
      const text = rest.slice(mark.from, textEnd)
      if (mark.dur === 0) {
        const previous = words[words.length - 1]
        if (previous) previous.text += text
        continue
      }
      // ⚠️ **空文本的词** → **不产出标签**（没有文字的「词」不是词）。
      if (text === '') continue
      // ⚠️ KRC 的词时间是**相对行开始**的 ⇒ 绝对 = 行首 + 相对。
      words.push({ start: lineStart + mark.start, text })
    }
    if (!words.length) continue

    // 第一个词元组**之前**的文本（实测通常为空）→ 并进第一个词。
    const leading = rest.slice(0, marks[0]!.to).trim()
    if (leading) {
      const first = words[0]
      if (first) first.text = leading + first.text
    }

    // ⚠️ **词内含空白** ⇒ 拆成多个独立词（酷狗的 KRC **也**把整段英文塞进一个词元组
    //    ⇒ 否则渲染层会把填色分段重置）。
    const expanded = splitWordsAtWhitespace(words, lineEnd)
    const body = expanded.map((word) => `<${msToLrcTag(word.start)}>${word.text}`).join('')
    out.push(`[${msToLrcTag(lineStart)}]${body}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 酷我 lrcx（真逐字）→ 增强 LRC（T90-⑥）
// ---------------------------------------------------------------------------
//
// 行形状（2026-11-14 本机**真实 Electron 主进程**实测，三首：孤勇者 /
// Counting Stars / 一路向北）：
//
//     [mm:ss.xxx]<a,b>词文本<a,b>词文本…
//
// ⚠️ **与 QRC / KRC 的三处关键差异**（转换器必须区别对待）：
//
// 1. **行头是 `[mm:ss.xxx]`**（时间标签），**不是** `[起ms,时长ms]`
//    ⇒ 解析器要另写一条分支；
// 2. `<a,b>` **不是**「开始毫秒 + 时长毫秒」，而是**经过缩放**的一对数
//    ⇒ 必须先读文件里的 `[kuwo:八进制]` 偏移参数（见 §14.3）；
// 3. **翻译行**与原文行**混在同一个时间戳下**（翻译行排在前面，
//    词标签**全为 `<0,0>`**）⇒ 见 §14.4。
//
// ⚠️ **元信息行的规则与 QRC / KRC 共用**（`isQrcMetaLine`）
//    （实测酷我也有「词：唐恬」「曲：钱雷」这类制作信息 + 标题行）。
//
// ⚠️ **词内空白**：酷我**已经把英文按词拆开**（空格是独立的词元组）
//    ⇒ 实测**没有**「整段英文塞进一个词元组」的情况
//    ⇒ 但仍走 `splitWordsAtWhitespace` 作**防御**（当前实测是 no-op）。

/** 酷我的行头：`[mm:ss.xxx]`（也接受 `[mm:ss.xx]`）。 */
const KUWO_LINE_HEAD = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/

/** 酷我的词标签：`<a,b>`（`a` / `b` **可负**；可选第三段）。 */
const KUWO_WORD_TAG = /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g

/** 酷我的偏移参数标签：`[kuwo:八进制数]`。 */
const KUWO_SCALE_TAG = /\[kuwo:\s*([^\]]*)\]/i

/**
 * 酷我 lrcx 的**偏移参数**（来自 `[kuwo:八进制数]`）。
 *
 * ⚠️ **三首实测各不相同**（`[kuwo:034]`→(2,8)、`[kuwo:140]`→(9,6)、`[kuwo:061]`→(4,9)）
 *    ⇒ **不能写死**。
 */
interface KuwoScale {
  /** 词**开始**时间的除数因子（`offset × 2`）。 */
  offset: number
  /** 词**时长**的除数因子（`offset2 × 2`）。 */
  offset2: number
}

/**
 * 读出文件里的 `[kuwo:八进制数]` 偏移参数。
 *
 * **规则（定死，规格 §14.3）**：
 * 1. 文件里**没有** `[kuwo:…]` ⇒ 缺省 `offset = offset2 = 1`（洛雪的缺省口径）；
 * 2. 有 ⇒ 内容按**八进制**解析（`parseInt(content, 8)`），
 *    再拆成 `offset = trunc(v / 10)`、`offset2 = trunc(v % 10)`；
 * 3. `offset` 或 `offset2` **小于 1**（含 0 与 NaN）⇒ **抛错**
 *    （除零 ⇒ 这份歌词的时间轴全错 ⇒ 如实报错，不产出错的歌词）。
 *
 * ⚠️ `[kuwo:…]` **可以出现在任何一行** ⇒ 解析行**之前**先全量扫一遍。
 */
function readKuwoScale(plain: string): KuwoScale {
  const match = KUWO_SCALE_TAG.exec(plain)
  if (!match) return { offset: 1, offset2: 1 }
  let content = (match[1] ?? '').trim()
  // ⚠️ 洛雪的口径：`][` 之后的内容**不算**参数（兼容参数里带别的标签的形状）。
  const cut = content.indexOf('][')
  if (cut >= 0) content = content.slice(0, cut).trim()
  const value = parseInt(content, 8)
  if (!Number.isFinite(value)) {
    throw new Error(`酷我歌词的 [kuwo:] 参数不是八进制数（${JSON.stringify(content)}）`)
  }
  const offset = Math.trunc(value / 10)
  const offset2 = Math.trunc(value % 10)
  if (offset < 1 || offset2 < 1) {
    throw new Error(`酷我歌词的 [kuwo:] 参数无效（offset=${offset} offset2=${offset2}）`)
  }
  return { offset, offset2 }
}

/** 解析出来的一个酷我词。 */
interface KuwoWord {
  /** **相对行首**的开始毫秒。 */
  relStart: number
  /** **相对行首**的时长毫秒。 */
  relDur: number
  /** 词文本（**原样**，不 trim 词内空格）。 */
  text: string
}

/** 解析出来的一行酷我歌词。 */
interface KuwoLine {
  /** 行首（**绝对**毫秒）。 */
  lineStart: number
  /** 行正文（行头之后的文本）。 */
  rest: string
  /** 词表（时间**相对行首**）。 */
  words: KuwoWord[]
  /** 第一个词标签**之前**的文本（实测通常为空）。 */
  leading: string
  /** 行正文（去掉词标签、trim 过）。 */
  plainText: string
  /** 这一行是不是**翻译行**（词标签全为零时长）。 */
  isTranslation: boolean
}

/**
 * 解析酷我 lrcx 明文 ⇒ 行列表。
 *
 * ⚠️ **翻译行的判据（规格 §14.4）**：词标签**全为零时长**的行 = 翻译行。
 *    实测三首：原文行里的零时长词 = **0** ⇒ 判据**零误判风险**。
 */
function parseKuwoLines(plain: string, scale: KuwoScale): KuwoLine[] {
  const out: KuwoLine[] = []
  for (const rawLine of plain.split(/\r\n|\r|\n/)) {
    // ⚠️ 解密后的明文**可能带 UTF-8 BOM** ⇒ 显式剥掉。
    const line = rawLine.replace(/^\uFEFF/, '').trim()
    if (!line) continue
    const head = KUWO_LINE_HEAD.exec(line)
    if (!head) continue // 没有行头（`[ti:]` / `[kuwo:034]` / `[ml:1.0]` 之类）→ 丢掉
    const fraction = head[3] ?? '0'
    const millis =
      fraction.length === 1
        ? Number(fraction) * 100
        : fraction.length === 2
          ? Number(fraction) * 10
          : Number(fraction)
    const lineStart = Number(head[1]) * 60_000 + Number(head[2]) * 1000 + millis
    const rest = line.slice(head[0].length)

    // 词标签（**按顺序扫描** ⇒ 词文本里的尖括号不会错位）。
    const pattern = new RegExp(KUWO_WORD_TAG.source, 'g')
    const marks: { start: number; dur: number; from: number; to: number }[] = []
    let match: RegExpExecArray | null
    while ((match = pattern.exec(rest)) !== null) {
      const a = Number(match[1])
      const b = Number(match[2])
      marks.push({
        // ⚠️ **相对行首**（规格 §14.3）：开始 = |a+b| / (offset×2)，
        //    时长 = |a-b| / (offset2×2) ⇒ 绝对 = 行首 + 相对。
        start: Math.trunc(Math.abs((a + b) / (scale.offset * 2))),
        dur: Math.trunc(Math.abs((a - b) / (scale.offset2 * 2))),
        from: match.index + match[0].length,
        to: match.index,
      })
    }
    const words: KuwoWord[] = []
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i]!
      const textEnd = i + 1 < marks.length ? marks[i + 1]!.to : rest.length
      words.push({ relStart: mark.start, relDur: mark.dur, text: rest.slice(mark.from, textEnd) })
    }
    const hasRealTiming = words.some((word) => word.relDur > 0)
    out.push({
      lineStart,
      rest,
      words,
      leading: marks.length ? rest.slice(0, marks[0]!.to).trim() : rest.trim(),
      plainText: rest.replace(new RegExp(KUWO_WORD_TAG.source, 'g'), '').trim(),
      // ⚠️ **没有词标签**的行**不算**翻译行（实测是空行 / 行级歌词行）。
      isTranslation: words.length > 0 && !hasRealTiming,
    })
  }
  return out
}

/**
 * 把 **酷我 lrcx 明文**（逐字）转成**增强 LRC**（`[mm:ss.xx]<mm:ss.xx>词…`）。
 *
 * **规则（定死，规格 §14.8）**：
 * 1. 先全量读 `[kuwo:…]` 偏移参数（缺省 1 / 1；无效 ⇒ 抛错）；
 * 2. 行头只认 `[mm:ss.xxx]`；**没有行头**的行（各种标签行）**丢掉**；
 * 3. **翻译行**（词标签全为零时长）**不产出原文**（走 {@link kuwoToPlainLrc}）；
 * 4. **元信息行**（制作信息 / 标题行）**丢掉**（见 {@link isQrcMetaLine}）；
 * 5. 词的**绝对时间** = **行首 + 相对毫秒**；
 * 6. **零时长词** → **并入前一个词**，不单独成词；
 * 7. **空文本的词** → **不产出标签**（没有文字的「词」不是词）；
 * 8. ⚠️ **纯空格的词元组必须保留**（渲染层会把它 trim 掉，
 *    但**行文本**仍保留那个空格 ⇒ 丢了它英文歌词会显示成 `CountingStars`）；
 * 9. **词内含空白** → 走 {@link splitWordsAtWhitespace}（防御性）；
 * 10. 一行里**没有有效词** → **跳过该行**；
 * 11. 空串 / 非串 → 返回空串（**不抛异常**）。
 *
 * @param plain 解密后的酷我 lrcx 明文。
 * @param hint 标题识别提示（**可选**：酷我的标题行可以很长 ⇒ 靠**歌名**认更准）。
 * @returns 标准增强 LRC（多行，行间 `\n`）。
 */
export function kuwoToEnhancedLrc(plain: string, hint?: QrcTitleHint): string {
  if (typeof plain !== 'string' || plain === '') return ''
  const scale = readKuwoScale(plain)
  const parsed = parseKuwoLines(plain, scale)

  // --- ① 拆出**原文行**（翻译行另走 {@link kuwoToPlainLrc}）--------------------
  const originals = parsed.filter((line) => !line.isTranslation)

  // --- ② 丢掉**元信息行**（制作信息 / 标题行）--------------------------------
  // ⚠️ **被丢掉的行不参与「下一行行时间」的计算** ⇒ 与渲染层看到的一致。
  // ⚠️ `candidateIndex` = 该行在**原文行**里的序号（**过滤前**）——
  //    与 QRC / KRC 的口径一致（标题行的兜底规则只看「前 5 条候选行」）。
  const lyricLines: typeof originals = []
  for (let index = 0; index < originals.length; index += 1) {
    const item = originals[index]!
    if (isQrcMetaLine(item.plainText, index, hint)) continue
    lyricLines.push(item)
  }

  // --- ③ 转换 ----------------------------------------------------------------
  const out: string[] = []
  for (let index = 0; index < lyricLines.length; index += 1) {
    const line = lyricLines[index]!
    // ⚠️ **行尾** = 下一行的行时间（与渲染层 `assemble` 同口径）。
    const nextLineStart = lyricLines[index + 1]?.lineStart
    const lineEnd = nextLineStart !== undefined ? nextLineStart : line.lineStart + 500

    // 零时长词**并入前一个词**；空文本的词**不产出标签**。
    const words: { start: number; text: string }[] = []
    for (const word of line.words) {
      if (word.relDur === 0) {
        const previous = words[words.length - 1]
        if (previous) previous.text += word.text
        continue
      }
      if (word.text === '') continue
      // ⚠️ 酷我的词时间**相对行首** ⇒ 绝对 = 行首 + 相对。
      words.push({ start: line.lineStart + word.relStart, text: word.text })
    }
    if (!words.length) continue

    // 第一个词标签**之前**的文本（实测通常为空）→ 并进第一个词。
    if (line.leading) {
      const first = words[0]
      if (first) first.text = line.leading + first.text
    }

    // ⚠️ **词内含空白** ⇒ 拆成多个独立词（防御性；实测酷我已是 no-op）。
    const expanded = splitWordsAtWhitespace(words, lineEnd)
    const body = expanded.map((word) => `<${msToLrcTag(word.start)}>${word.text}`).join('')
    out.push(`[${msToLrcTag(line.lineStart)}]${body}`)
  }
  return out.join('\n')
}

/**
 * 把 **酷我 lrcx 明文**里的**翻译行**转成**行级 LRC**。
 *
 * ⚠️ 翻译行**没有逐字时间**（实测词标签全是 `<0,0>`）
 *    ⇒ 只保留文本（词标签**整条摘掉**）。
 * ⚠️ **制作信息行同样丢掉**（与 {@link kuwoToEnhancedLrc} 同一口径），
 *    但**不套**标题行规则（标题提示是给原文用的）。
 *
 * ⚠️⚠️ **翻译行的时间戳要「回退」到「上一句」原文**（规格 §14.4 / §14.8 第 12 条，
 *    洛雪上游 `sortLrcArr` 同款）：酷我把翻译行排在它对应的那句英文**之前**，
 *    但**翻译行自带的时间戳是「下一句」英文的**
 *    ⇒ 不回退的话，渲染层会按时间戳把中文挂到**下一句**英文上（**整体偏移一行**）。
 *
 * @param plain 解密后的酷我 lrcx 明文。
 */
export function kuwoToPlainLrc(plain: string): string {
  if (typeof plain !== 'string' || plain === '') return ''
  const scale = readKuwoScale(plain)
  const parsed = parseKuwoLines(plain, scale)
  const out: string[] = []
  // ⚠️ 「前面最近一条**原文行**」的行首毫秒（**文件原序**）。
  let previousOriginalStart: number | null = null
  for (const line of parsed) {
    if (!line.isTranslation) {
      // ⚠️ **含元信息行**（标题行 / 制作信息行也是「原文行」）：
      //    它们会被原文侧滤掉 ⇒ 它们对应的翻译也无处可挂 ⇒ 一样是「不显示」。
      previousOriginalStart = line.lineStart
      continue
    }
    const text = line.plainText
    if (!text) continue
    if (isQrcCreditLine(text)) continue
    // ⚠️ **没有前序原文行 ⇒ 丢掉这条翻译**（洛雪同款：`lrc.length < 2` ⇒ `continue`）。
    if (previousOriginalStart === null) continue
    out.push(`[${msToLrcTag(previousOriginalStart)}]${text}`)
  }
  return out.join('\n')
}
