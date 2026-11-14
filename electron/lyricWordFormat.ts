// ---------------------------------------------------------------------------
// 逐字歌词的**格式转换**（主进程侧共用）
// ---------------------------------------------------------------------------
//
// 本模块回答一个问题：**「各家平台的逐字歌词，怎么变成统一的增强 LRC？」**
//
// - **网易云 yrc**（T67）：`[行开始ms,行时长ms](词开始ms,词时长ms,0)词文本…`
// - **QQ qrc**（T90-④）：`[行开始ms,行时长ms](词开始ms,词时长ms)词文本…`
//
// ⇒ 两者都转成**标准增强 LRC**（`[mm:ss.xx]<mm:ss.xx>词…`），
//    交给**现有**的 `parseWordSegments` ⇒ **渲染层解析器一字不改**。
//
// ⚠️ **只放纯函数**：不碰网络、不碰 Electron、不碰 Node 内置模块
//    （`electron/lyricProvider.ts` 的纪律：模块顶层不得 import Electron）。
//
// ⚠️ **解密**不在这里 —— QQ 的 qrc 解密在 `electron/lyricCodecs/qrc.ts`
//    （3DES 是 **Node 专属**的纯 JS 实现，与本模块刻意分开）。
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
 * 9. 空串 / 非串 → 返回空串（**不抛异常**）。
 *
 * @param qrc 解密后的 QRC 明文。
 * @param hint 标题识别提示（**可选**：QQ 的 QRC 标题行可以很长 ⇒ 靠**歌名**认更准）。
 * @returns 标准增强 LRC（多行，行间 `\n`）。
 */
export function qrcToEnhancedLrc(qrc: string, hint?: QrcTitleHint): string {
  if (typeof qrc !== 'string' || qrc === '') return ''
  const out: string[] = []
  /** 带行头的候选行的序号（0 起）—— 标题行规则用。 */
  let candidateIndex = 0
  for (const rawLine of qrc.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const head = QRC_LINE_HEAD.exec(line)
    if (!head) continue // 无行头（`[ti:]` 之类 / 不是歌词行）→ 丢掉
    const lineStart = Number(head[1])
    if (!Number.isFinite(lineStart)) continue
    const rest = line.slice(head[0].length)
    const currentIndex = candidateIndex
    candidateIndex += 1

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

    // ⚠️ **元信息行**（制作信息 / 标题行）→ 丢掉（实测 QQ 的 QRC 里混着 14 行制作信息）。
    const plainText = rest.replace(QRC_WORD_TUPLE, '').trim()
    if (isQrcMetaLine(plainText, currentIndex, hint)) continue

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

    const body = words
      .map((word) => `<${msToLrcTag(word.start)}>${word.text}`)
      .join('')
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
