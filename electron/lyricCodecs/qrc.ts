// ---------------------------------------------------------------------------
// QQ 逐字歌词（QRC）：解密 + 转成增强 LRC（T90-④）
// ---------------------------------------------------------------------------
//
// ⚠️ **出处与协议（必须保留）**
//
// 本文件的 **3DES（DES-EDE3）核心是从「洛雪音乐」移植的**：
//
// - 上游：https://github.com/lyswhut/lx-music-desktop
// - 文件：`src/renderer/utils/musicSdk/tx/qrcDecode.js`
// - 协议：**Apache-2.0**（本仓库的 `THIRD_PARTY_NOTICES.md` 里有完整声明与协议正文）
// - 本仓库的改动：
//   1. 改写为 TypeScript；
//   2. S 盒表拆成「**基础表 + 两处补丁**」⇒ 单测可以证明那两处改动**真的在起作用**
//      （见 `QRC_SBOX_WITH_STANDARD_VALUES` 与 `test/lyric-qrc.test.ts`）；
//   3. 抽出 `decrypt3des` / `encrypt3des`（原实现只导出 `decodeQrc`）；
//   4. 补 **QRC → 增强 LRC** 的转换器（原实现在调用方做，且输出的是洛雪自己的格式）；
//   5. 补**元信息行过滤**（QQ 的 QRC 会把制作信息混在歌词行里，见下面的「行形状」）。
//
// ---------------------------------------------------------------------------
// ⚠️ **为什么不能拿 `node:crypto` 当锚点**（本任务的核心风险，2026-11-14 实测定论）
// ---------------------------------------------------------------------------
//
// QRC 用的是**非标准 DES 变体**。洛雪的注释写明其中**两处**与标准 DES 不同：
//
// - `S2[23] = 15`（标准 DES 是 **14**）
// - `S4[53] = 10`（标准 DES 是 **1**）
//
// ⚠️ **实测更正**：这**两处不够** —— 把这两处改回标准值后，本实现与 `node:crypto`
//    的 `des-ede3` 仍然**对不上**；再穷举「单点修正 8192 种」「S2×S4 双点 1024×1024 种」
//    ⇒ **都无解** ⇒ QRC 的 3DES 与标准 DES 的差异**不止那两处**
//    （是改造过的 DES 变体，不是「标准表改两格」）。
//
// ⇒ 结论：
// 1. `node:crypto` 的 `des-ede3` **解不开** QRC（`des-ecb` / `des-cbc` 在本机
//    OpenSSL 3 上更是**直接不可用** —— legacy provider 没开）；
// 2. 因此**不能**用「同一份核心 + 标准 S 盒」去对 `node:crypto` 的密文；
// 3. 唯一可靠的**外部锚点** = **与洛雪上游逐字节差分**：
//    同一份真实 QQ 密文 ⇒ 本实现与洛雪原版解出的明文**逐字节相同**（实测 8587 字符全等）。
//    仓库里固化的是「**占位歌词**密文 + 上游解出的期望明文」这组 fixture
//    （真实密文**不入库** —— 密钥是公开的，密文入库等于把歌词放进公开仓库）。
//
// ---------------------------------------------------------------------------
// 行形状（2026-11-14 实测，样本：孤勇者）
// ---------------------------------------------------------------------------
//
// - 行头：`[起ms,时长ms]`；
// - 词元组：`(起ms,时长ms)`，**词时间是绝对毫秒**（实测第 40 行：行首 93766、
//   首词 93766、末词 95181，全部 ≥ 行首）；
// - 头部有 **12 行无行头**的元信息（`[ti:]` 之类）⇒ 天然被行头规则挡掉；
// - **69 行带行头**的行里，**10 行是制作信息**（`词：X` `曲：X` `编曲：X` `吉他：X`
//   `混音/母带：X` `词版权管理方：X` `曲版权管理方：X` `录音作品及MV版权：X`
//   `出品监制：X` `制作人：X`）⇒ **必须过滤**，否则制作信息会当成歌词显示出来。
//
// ⚠️ 本模块在**主进程**里用（`electron/lyricProvider.ts`）⇒ 可以用 `node:zlib`。
//    **不许**把本文件拖进渲染层（渲染层 bundle 里没有 Node 内置模块）。
//
// ---------------------------------------------------------------------------

import { inflate, constants } from 'node:zlib'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** DES 的 S 盒（8 张表，每张 64 项）。 */
export type DesSbox = readonly (readonly number[])[]

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * QRC 的固定密钥（24 字节 = 3 组 DES 密钥）。
 *
 * ⚠️ 这是**公开的固定算法参数**（洛雪的源码里也是字面量），**不是**用户凭证。
 * ⚠️ 本仓库**绝不**附带任何 NAS / 账号 / 会话凭证。
 */
export const QRC_KEY: Uint8Array = new Uint8Array([
  0x21, 0x40, 0x23, 0x29, 0x28, 0x2a, 0x24, 0x25, 0x31, 0x32, 0x33, 0x5a, 0x58, 0x43, 0x21, 0x40, 0x21, 0x40, 0x23,
  0x29, 0x28, 0x4e, 0x48, 0x4c,
])

/**
 * DES 的 S 盒表（8 × 64）。
 *
 * ⚠️ 逐字节来自洛雪的 `qrcDecode.js`（它把**非标准**表整体硬编码）。
 *    本仓库把「标准表」与「QRC 的两处补丁」**拆开**：
 *    标准表 ⇒ 能拿 `node:crypto` 交叉验证；打上补丁 ⇒ 就是 QRC 要的那张表。
 */
const BASE_SBOX: readonly (readonly number[])[] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
]

/** S 盒补丁：`[表号, 项号, 值]`。 */
type SboxPatch = readonly [table: number, index: number, value: number]

/**
 * QRC 的两处**非标准**补丁（洛雪的注释里写明这两处与标准 DES 不同）。
 *
 * ⚠️ **不可改成标准值**（14 / 1）—— 改了 QRC 就解不开。
 */
const QRC_PATCHES: readonly SboxPatch[] = [
  [1, 23, 15],
  [3, 53, 10],
]

/**
 * 同样两个位置上的**标准 DES 值**（14 / 1）。
 *
 * ⚠️ 只用于**单测**：拿它当 S 盒去解同一份密文，结果必须与 QRC 表**不同**
 *    ⇒ 证明那两处改动**真的在起作用**。
 * ⚠️ **生产路径不用它**（见文件头的「为什么不能拿 `node:crypto` 当锚点」：
 *    QRC 的 3DES 与标准 DES 的差异**不止这两处**，标准表**解不开** QRC）。
 */
const STANDARD_PATCHES: readonly SboxPatch[] = [
  [1, 23, 14],
  [3, 53, 1],
]

/** 按补丁生成一张 S 盒表（**深拷贝**，不改 `BASE_SBOX`）。 */
function buildSbox(patches: readonly SboxPatch[]): DesSbox {
  const tables = BASE_SBOX.map((table) => table.slice())
  for (const [tableIndex, index, value] of patches) {
    const table = tables[tableIndex]
    if (!table) throw new Error(`S 盒补丁越界：表 ${tableIndex}`)
    table[index] = value
  }
  return tables
}

/**
 * 把那两处改回**标准值**的 S 盒表（**仅供单测**）。
 *
 * ⚠️ **它不是「标准 DES 表」** —— QRC 与标准 DES 的差异**不止那两处**
 *    （实测穷举无解，见文件头）⇒ 这张表**仍然解不开**真实 QRC，
 *    只用来做「同密文、换表 ⇒ 结果不同」的**差分断言**。
 */
export const QRC_SBOX_WITH_STANDARD_VALUES: DesSbox = buildSbox(STANDARD_PATCHES)

/** **QRC 用的非标准** S 盒（生产路径）。 */
export const QRC_SBOX: DesSbox = buildSbox(QRC_PATCHES)

// ---------------------------------------------------------------------------
// DES 核心（移植自洛雪；改动 = S 盒变成参数 + 补加密方向）
// ---------------------------------------------------------------------------

/** 加密 / 解密方向（决定轮密钥的排布）。 */
const DES_ENCRYPT = 1
const DES_DECRYPT = 0

/** 每轮的密钥移位量。 */
const KEY_RND_SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]

/** 密钥置换表（C 位）。 */
const KEY_PERM_C = [
  56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
]

/** 密钥置换表（D 位）。 */
const KEY_PERM_D = [
  62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3,
]

/** 密钥压缩置换表。 */
const KEY_COMPRESSION = [
  13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36, 46, 54, 29,
  39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
]

/**
 * 取 `a` 的第 `b` 位（**从 1 开始数**，MSB 在前）⇒ 放到第 `c` 位。
 *
 * ⚠️ 全部以**无符号 32 位**处理（`>>> 0`）⇒ 溢出行为与 C++ 的 `uint32_t` 一致。
 * ⚠️ 越界时取 **0**（`?? 0`）—— 与上游 JS 的 `undefined >>> n === 0` **完全一致**。
 */
function bitnum(a: Uint8Array, b: number, c: number): number {
  return (
    ((((a[((b / 32) | 0) * 4 + 3 - (((b % 32) / 8) | 0)] ?? 0) >>> (7 - (b % 8))) & 1) << c) >>> 0
  )
}

/** 取 `a` 的第 `b` 位（**从 0 开始数**，LSB 在前）⇒ 放到第 `c` 位。 */
function bitnumIntr(a: number, b: number, c: number): number {
  return (((a >>> (31 - b)) & 1) << c) >>> 0
}

/** 取 `a` 的第 `b` 位（**从 0 开始数**，MSB 在前）⇒ 放到第 `c` 位。 */
function bitnumIntl(a: number, b: number, c: number): number {
  return (((((a << b) >>> 0) & 0x80000000) >>> 0) >>> c) >>> 0
}

/** S 盒索引的「行/列」重排。 */
function sboxBit(a: number): number {
  return (a & 32) | ((a & 31) >>> 1) | ((a & 1) << 4)
}

/** 初始置换 ⇒ `[左半, 右半]`。 */
function initialPermutation(input: Uint8Array): [number, number] {
  const s0 = (
    bitnum(input, 57, 31) |
    bitnum(input, 49, 30) |
    bitnum(input, 41, 29) |
    bitnum(input, 33, 28) |
    bitnum(input, 25, 27) |
    bitnum(input, 17, 26) |
    bitnum(input, 9, 25) |
    bitnum(input, 1, 24) |
    bitnum(input, 59, 23) |
    bitnum(input, 51, 22) |
    bitnum(input, 43, 21) |
    bitnum(input, 35, 20) |
    bitnum(input, 27, 19) |
    bitnum(input, 19, 18) |
    bitnum(input, 11, 17) |
    bitnum(input, 3, 16) |
    bitnum(input, 61, 15) |
    bitnum(input, 53, 14) |
    bitnum(input, 45, 13) |
    bitnum(input, 37, 12) |
    bitnum(input, 29, 11) |
    bitnum(input, 21, 10) |
    bitnum(input, 13, 9) |
    bitnum(input, 5, 8) |
    bitnum(input, 63, 7) |
    bitnum(input, 55, 6) |
    bitnum(input, 47, 5) |
    bitnum(input, 39, 4) |
    bitnum(input, 31, 3) |
    bitnum(input, 23, 2) |
    bitnum(input, 15, 1) |
    bitnum(input, 7, 0)
  ) >>> 0
  const s1 = (
    bitnum(input, 56, 31) |
    bitnum(input, 48, 30) |
    bitnum(input, 40, 29) |
    bitnum(input, 32, 28) |
    bitnum(input, 24, 27) |
    bitnum(input, 16, 26) |
    bitnum(input, 8, 25) |
    bitnum(input, 0, 24) |
    bitnum(input, 58, 23) |
    bitnum(input, 50, 22) |
    bitnum(input, 42, 21) |
    bitnum(input, 34, 20) |
    bitnum(input, 26, 19) |
    bitnum(input, 18, 18) |
    bitnum(input, 10, 17) |
    bitnum(input, 2, 16) |
    bitnum(input, 60, 15) |
    bitnum(input, 52, 14) |
    bitnum(input, 44, 13) |
    bitnum(input, 36, 12) |
    bitnum(input, 28, 11) |
    bitnum(input, 20, 10) |
    bitnum(input, 12, 9) |
    bitnum(input, 4, 8) |
    bitnum(input, 62, 7) |
    bitnum(input, 54, 6) |
    bitnum(input, 46, 5) |
    bitnum(input, 38, 4) |
    bitnum(input, 30, 3) |
    bitnum(input, 22, 2) |
    bitnum(input, 14, 1) |
    bitnum(input, 6, 0)
  ) >>> 0
  return [s0, s1]
}

/** 逆置换：把 `[左半, 右半]` 写回 8 字节。 */
function inversePermutation(s0: number, s1: number, out: Uint8Array): void {
  out[3] =
    (bitnumIntr(s1, 7, 7) |
      bitnumIntr(s0, 7, 6) |
      bitnumIntr(s1, 15, 5) |
      bitnumIntr(s0, 15, 4) |
      bitnumIntr(s1, 23, 3) |
      bitnumIntr(s0, 23, 2) |
      bitnumIntr(s1, 31, 1) |
      bitnumIntr(s0, 31, 0)) &
    0xff
  out[2] =
    (bitnumIntr(s1, 6, 7) |
      bitnumIntr(s0, 6, 6) |
      bitnumIntr(s1, 14, 5) |
      bitnumIntr(s0, 14, 4) |
      bitnumIntr(s1, 22, 3) |
      bitnumIntr(s0, 22, 2) |
      bitnumIntr(s1, 30, 1) |
      bitnumIntr(s0, 30, 0)) &
    0xff
  out[1] =
    (bitnumIntr(s1, 5, 7) |
      bitnumIntr(s0, 5, 6) |
      bitnumIntr(s1, 13, 5) |
      bitnumIntr(s0, 13, 4) |
      bitnumIntr(s1, 21, 3) |
      bitnumIntr(s0, 21, 2) |
      bitnumIntr(s1, 29, 1) |
      bitnumIntr(s0, 29, 0)) &
    0xff
  out[0] =
    (bitnumIntr(s1, 4, 7) |
      bitnumIntr(s0, 4, 6) |
      bitnumIntr(s1, 12, 5) |
      bitnumIntr(s0, 12, 4) |
      bitnumIntr(s1, 20, 3) |
      bitnumIntr(s0, 20, 2) |
      bitnumIntr(s1, 28, 1) |
      bitnumIntr(s0, 28, 0)) &
    0xff
  out[7] =
    (bitnumIntr(s1, 3, 7) |
      bitnumIntr(s0, 3, 6) |
      bitnumIntr(s1, 11, 5) |
      bitnumIntr(s0, 11, 4) |
      bitnumIntr(s1, 19, 3) |
      bitnumIntr(s0, 19, 2) |
      bitnumIntr(s1, 27, 1) |
      bitnumIntr(s0, 27, 0)) &
    0xff
  out[6] =
    (bitnumIntr(s1, 2, 7) |
      bitnumIntr(s0, 2, 6) |
      bitnumIntr(s1, 10, 5) |
      bitnumIntr(s0, 10, 4) |
      bitnumIntr(s1, 18, 3) |
      bitnumIntr(s0, 18, 2) |
      bitnumIntr(s1, 26, 1) |
      bitnumIntr(s0, 26, 0)) &
    0xff
  out[5] =
    (bitnumIntr(s1, 1, 7) |
      bitnumIntr(s0, 1, 6) |
      bitnumIntr(s1, 9, 5) |
      bitnumIntr(s0, 9, 4) |
      bitnumIntr(s1, 17, 3) |
      bitnumIntr(s0, 17, 2) |
      bitnumIntr(s1, 25, 1) |
      bitnumIntr(s0, 25, 0)) &
    0xff
  out[4] =
    (bitnumIntr(s1, 0, 7) |
      bitnumIntr(s0, 0, 6) |
      bitnumIntr(s1, 8, 5) |
      bitnumIntr(s0, 8, 4) |
      bitnumIntr(s1, 16, 3) |
      bitnumIntr(s0, 16, 2) |
      bitnumIntr(s1, 24, 1) |
      bitnumIntr(s0, 24, 0)) &
    0xff
}

/**
 * Feistel 轮函数 `f(state, key)`。
 *
 * ⚠️ **S 盒是参数**（本仓库对洛雪的改动）⇒ 标准表与 QRC 表走**同一份**核心。
 */
function desF(state: number, key: Uint8Array, sbox: DesSbox): number {
  const t1 = (
    bitnumIntl(state, 31, 0) |
    (((state & 0xf0000000) >>> 0) >>> 1) |
    bitnumIntl(state, 4, 5) |
    bitnumIntl(state, 3, 6) |
    (((state & 0x0f000000) >>> 0) >>> 3) |
    bitnumIntl(state, 8, 11) |
    bitnumIntl(state, 7, 12) |
    (((state & 0x00f00000) >>> 0) >>> 5) |
    bitnumIntl(state, 12, 17) |
    bitnumIntl(state, 11, 18) |
    (((state & 0x000f0000) >>> 0) >>> 7) |
    bitnumIntl(state, 16, 23)
  ) >>> 0
  const t2 = (
    bitnumIntl(state, 15, 0) |
    (((state & 0x0000f000) << 15) >>> 0) |
    bitnumIntl(state, 20, 5) |
    bitnumIntl(state, 19, 6) |
    (((state & 0x00000f00) << 13) >>> 0) |
    bitnumIntl(state, 24, 11) |
    bitnumIntl(state, 23, 12) |
    (((state & 0x000000f0) << 11) >>> 0) |
    bitnumIntl(state, 28, 17) |
    bitnumIntl(state, 27, 18) |
    (((state & 0x0000000f) << 9) >>> 0) |
    bitnumIntl(state, 0, 23)
  ) >>> 0

  const lrgstate = [
    (t1 >>> 24) & 0xff,
    (t1 >>> 16) & 0xff,
    (t1 >>> 8) & 0xff,
    (t2 >>> 24) & 0xff,
    (t2 >>> 16) & 0xff,
    (t2 >>> 8) & 0xff,
  ]
  for (let i = 0; i < 6; i += 1) lrgstate[i] = (lrgstate[i] as number) ^ (key[i] as number)

  const s = (
    ((sbox[0] as readonly number[])[sboxBit((lrgstate[0] as number) >>> 2)]! << 28) |
    ((sbox[1] as readonly number[])[sboxBit((((lrgstate[0] as number) & 0x03) << 4) | ((lrgstate[1] as number) >>> 4))]! << 24) |
    ((sbox[2] as readonly number[])[sboxBit((((lrgstate[1] as number) & 0x0f) << 2) | ((lrgstate[2] as number) >>> 6))]! << 20) |
    ((sbox[3] as readonly number[])[sboxBit((lrgstate[2] as number) & 0x3f)]! << 16) |
    ((sbox[4] as readonly number[])[sboxBit((lrgstate[3] as number) >>> 2)]! << 12) |
    ((sbox[5] as readonly number[])[sboxBit((((lrgstate[3] as number) & 0x03) << 4) | ((lrgstate[4] as number) >>> 4))]! << 8) |
    ((sbox[6] as readonly number[])[sboxBit((((lrgstate[4] as number) & 0x0f) << 2) | ((lrgstate[5] as number) >>> 6))]! << 4) |
    (sbox[7] as readonly number[])[sboxBit((lrgstate[5] as number) & 0x3f)]!
  ) >>> 0

  return (
    bitnumIntl(s, 15, 0) |
    bitnumIntl(s, 6, 1) |
    bitnumIntl(s, 19, 2) |
    bitnumIntl(s, 20, 3) |
    bitnumIntl(s, 28, 4) |
    bitnumIntl(s, 11, 5) |
    bitnumIntl(s, 27, 6) |
    bitnumIntl(s, 16, 7) |
    bitnumIntl(s, 0, 8) |
    bitnumIntl(s, 14, 9) |
    bitnumIntl(s, 22, 10) |
    bitnumIntl(s, 25, 11) |
    bitnumIntl(s, 4, 12) |
    bitnumIntl(s, 17, 13) |
    bitnumIntl(s, 30, 14) |
    bitnumIntl(s, 9, 15) |
    bitnumIntl(s, 1, 16) |
    bitnumIntl(s, 7, 17) |
    bitnumIntl(s, 23, 18) |
    bitnumIntl(s, 13, 19) |
    bitnumIntl(s, 31, 20) |
    bitnumIntl(s, 26, 21) |
    bitnumIntl(s, 2, 22) |
    bitnumIntl(s, 8, 23) |
    bitnumIntl(s, 18, 24) |
    bitnumIntl(s, 12, 25) |
    bitnumIntl(s, 29, 26) |
    bitnumIntl(s, 5, 27) |
    bitnumIntl(s, 21, 28) |
    bitnumIntl(s, 10, 29) |
    bitnumIntl(s, 3, 30) |
    bitnumIntl(s, 24, 31)
  ) >>> 0
}

/**
 * 单个 8 字节分组的 DES 加/解密（**同一个函数** —— 方向由轮密钥排布决定）。
 *
 * @param input 8 字节分组。
 * @param schedule 16 轮子密钥（每轮 6 字节）。
 * @param output 写出的 8 字节。
 * @param sbox S 盒表。
 */
function desCrypt(
  input: Uint8Array,
  schedule: readonly Uint8Array[],
  output: Uint8Array,
  sbox: DesSbox,
): void {
  let [s0, s1] = initialPermutation(input)
  for (let i = 0; i < 15; i += 1) {
    const prev = s1
    s1 = (desF(s1, schedule[i] as Uint8Array, sbox) ^ s0) >>> 0
    s0 = prev
  }
  s0 = (desF(s1, schedule[15] as Uint8Array, sbox) ^ s0) >>> 0
  inversePermutation(s0, s1, output)
}

/** 生成 16 轮子密钥（每轮 6 字节）。 */
function keySchedule(key: Uint8Array, mode: number): Uint8Array[] {
  const schedule: Uint8Array[] = Array.from({ length: 16 }, () => new Uint8Array(6))
  let c = 0
  let d = 0
  for (let i = 0; i < 28; i += 1) {
    c = (c | bitnum(key, KEY_PERM_C[i] as number, 31 - i)) >>> 0
    d = (d | bitnum(key, KEY_PERM_D[i] as number, 31 - i)) >>> 0
  }
  for (let i = 0; i < 16; i += 1) {
    const shift = KEY_RND_SHIFT[i] as number
    c = ((((c << shift) >>> 0) | (c >>> (28 - shift))) & 0xfffffff0) >>> 0
    d = ((((d << shift) >>> 0) | (d >>> (28 - shift))) & 0xfffffff0) >>> 0
    const togen = mode === DES_DECRYPT ? 15 - i : i
    for (let j = 0; j < 24; j += 1) {
      const row = schedule[togen] as Uint8Array
      row[(j / 8) | 0] = (row[(j / 8) | 0] as number) | bitnumIntr(c, KEY_COMPRESSION[j] as number, 7 - (j % 8))
    }
    for (let j = 24; j < 48; j += 1) {
      const row = schedule[togen] as Uint8Array
      row[(j / 8) | 0] =
        (row[(j / 8) | 0] as number) |
        bitnumIntr(d, (KEY_COMPRESSION[j] as number) - 27, 7 - (j % 8))
    }
  }
  return schedule
}

/** 3DES（EDE3）的三组轮密钥（**EDE** ⇒ 加密/解密的组序不同）。 */
function tripledesKeySetup(key: Uint8Array, mode: number): Uint8Array[][] {
  if (mode === DES_ENCRYPT) {
    return [
      keySchedule(key.subarray(0, 8), DES_ENCRYPT),
      keySchedule(key.subarray(8, 16), DES_DECRYPT),
      keySchedule(key.subarray(16, 24), DES_ENCRYPT),
    ]
  }
  return [
    keySchedule(key.subarray(16, 24), DES_DECRYPT),
    keySchedule(key.subarray(8, 16), DES_ENCRYPT),
    keySchedule(key.subarray(0, 8), DES_DECRYPT),
  ]
}

/** 3DES 的单个分组（EDE：三次 DES，首尾同向、中间反向）。 */
function tripledesCrypt(
  input: Uint8Array,
  schedule: readonly Uint8Array[][],
  output: Uint8Array,
  sbox: DesSbox,
): void {
  const buf = new Uint8Array(8)
  desCrypt(input, schedule[0] as Uint8Array[], buf, sbox)
  desCrypt(buf, schedule[1] as Uint8Array[], output, sbox)
  desCrypt(output, schedule[2] as Uint8Array[], buf, sbox)
  output.set(buf)
}

/**
 * 3DES-EDE3（**ECB、无填充**）解密。
 *
 * ⚠️ 尾部不足一组的字节**原样保留**（与洛雪一致）⇒ 密文长度不是 8 的倍数时
 *    后续 inflate 会失败 ⇒ {@link decodeQrc} 返回空串。
 *
 * @param input 密文字节。
 * @param key 24 字节密钥。
 * @param sbox S 盒表（默认 QRC 的非标准表）。
 */
export function decrypt3des(
  input: Uint8Array,
  key: Uint8Array,
  sbox: DesSbox = QRC_SBOX,
): Uint8Array {
  const schedule = tripledesKeySetup(key, DES_DECRYPT)
  const out = new Uint8Array(input.length)
  const block = new Uint8Array(8)
  for (let i = 0; i + 8 <= input.length; i += 8) {
    tripledesCrypt(input.subarray(i, i + 8), schedule, block, sbox)
    out.set(block, i)
  }
  return out
}

/**
 * 3DES-EDE3（**ECB、无填充**）加密。
 *
 * ⚠️ **只为单测与造 fixture 存在**：
 * 1. **差分断言**：同一份密文，用 `QRC_SBOX` 与 `QRC_SBOX_WITH_STANDARD_VALUES`
 *    解出的结果必须**不同** ⇒ 证明那两处 S 盒改动**真的在起作用**；
 * 2. **造上游锚点**：用**占位歌词**造出「QRC 形状」的密文，交给**洛雪上游**
 *    解一次 ⇒ 把上游解出的明文固化成测试期望值（见 `test/lyric-qrc.test.ts`）。
 *
 * ⚠️ **不是**用来跟 `node:crypto` 对齐的 —— QRC 的 3DES 与标准 DES 的差异**不止两处**
 *    （见文件头），`node:crypto` 的 `des-ede3` **解不开**它。
 */
export function encrypt3des(
  input: Uint8Array,
  key: Uint8Array,
  sbox: DesSbox = QRC_SBOX,
): Uint8Array {
  const schedule = tripledesKeySetup(key, DES_ENCRYPT)
  const out = new Uint8Array(input.length)
  const block = new Uint8Array(8)
  for (let i = 0; i + 8 <= input.length; i += 8) {
    tripledesCrypt(input.subarray(i, i + 8), schedule, block, sbox)
    out.set(block, i)
  }
  return out
}

// ---------------------------------------------------------------------------
// QRC 解密（3DES + zlib）
// ---------------------------------------------------------------------------

/**
 * zlib 解压（**容忍尾部不完整的流** —— 对应洛雪忽略 `Z_BUF_ERROR` 的行为）。
 */
function inflateAsync(data: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflate(data, { finishFlush: constants.Z_SYNC_FLUSH }, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

/**
 * 解密 QQ 的 QRC 歌词。
 *
 * **数据流程**：hex 字符串 → 字节 → 3DES-EDE3（ECB、无填充）→ zlib inflate → UTF-8 文本。
 *
 * ⚠️ 任何一步失败（hex 非法 / 解不开 / 解压失败）⇒ **返回空串**（**不抛异常**）——
 *    上层据此如实报「没取到」，别把异常抛到 IPC。
 *
 * @param hex 服务端返回的十六进制密文。
 * @param sbox S 盒表（缺省 = **QRC 的非标准表**，生产路径）；
 *   单测会传 `QRC_SBOX_WITH_STANDARD_VALUES` 做**差分断言**。
 */
export async function decodeQrc(hex: string, sbox: DesSbox = QRC_SBOX): Promise<string> {
  if (typeof hex !== 'string' || hex === '') return ''
  if (hex.length % 2 !== 0) return ''
  if (!/^[0-9a-fA-F]+$/.test(hex)) return ''
  const encrypted = Buffer.from(hex, 'hex')
  if (!encrypted.length) return ''
  const decrypted = decrypt3des(new Uint8Array(encrypted), QRC_KEY, sbox)
  try {
    const result = await inflateAsync(decrypted)
    return result.toString('utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
