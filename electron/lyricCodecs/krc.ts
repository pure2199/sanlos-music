// ---------------------------------------------------------------------------
// 酷狗逐字歌词（KRC）：解密（T90-⑤）
// ---------------------------------------------------------------------------
//
// 载荷形状（2026-11-14 本机实测）：
//
//     base64 → 解码后前 4 字节是 ASCII `krc1` → 其余是 **XOR 加密的 zlib 流**
//
//     body   = base64Decode(content).subarray(4)      // 跳过 "krc1"
//     body[i] ^= KRC_XOR_KEY[i % 16]                  // 循环 XOR（16 字节固定密钥）
//     plain  = zlib.inflateSync(body).toString('utf8') // 标准 zlib
//
// 验算：密文首两字节 `0x38 0xdb` ⊕ `0x40 0x47` = `0x78 0x9c` ⇒ **正是 zlib 头**。
//
// ---------------------------------------------------------------------------
// ⚠️ **出处与协议（与 `electron/lyricCodecs/qrc.ts` 的纪律一致）**
// ---------------------------------------------------------------------------
//
// KRC 的解密算法是**公开算法**（4 个独立公开实现交叉验证一致：洛雪的
// `src/common/utils/lyricUtils/kg`、KuGouMusicApi 的 `util/util.js`、
// Rust `lyrics-helper` 的 `decrypt_krc`、以及若干社区实现）。
//
// ⚠️ **本仓库按算法自行实现，不移植任何一家的代码**
//    ⇒ `THIRD_PARTY_NOTICES.md` **不需要新增条目**（与 QRC 的 3DES 不同：
//    那次是**移植了洛雪的源码**，所以必须声明）。
//
// 参考（**算法口径**，不是代码来源）：
// - https://github.com/lyswhut/lx-music-desktop （Apache-2.0）
//   `src/renderer/utils/musicSdk/kg/lyric.js` 的端点与 `fmt` 判定口径
//
// ---------------------------------------------------------------------------
// ⚠️ **真实密文不入库**
// ---------------------------------------------------------------------------
//
// KRC 的 XOR 密钥是**公开**的 ⇒ 真实密文入库 = 把歌词放进公开仓库
// ⇒ 单测（`test/lyric-krc.test.ts`）用**自己合成**的密文
// （且**独立手写**一份 XOR ⇒ 生产代码的密钥写错时测试**会红**）。
//
// ---------------------------------------------------------------------------
// ⚠️ 本模块在**主进程**里用（`electron/lyricProvider.ts`）⇒ 可以用 `node:zlib`。
//    **不许**把本文件拖进渲染层（渲染层 bundle 里没有 Node 内置模块）。
//
// ---------------------------------------------------------------------------

import { inflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * KRC 的 **XOR 密钥**（16 字节，循环使用）。
 *
 * ⚠️ 这是**公开算法常量**（不是密钥管理意义上的「秘密」）
 *    —— 它的作用与 `node:crypto` 的算法编号同级。
 */
export const KRC_XOR_KEY: readonly number[] = [
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
]

/** KRC 载荷的**头**（ASCII `krc1`）—— 用来识别「这确实是 KRC」。 */
export const KRC_HEADER = 'krc1'

// ---------------------------------------------------------------------------
// 解密
// ---------------------------------------------------------------------------

/**
 * 解密一份 **KRC 载荷**（base64）⇒ KRC 明文。
 *
 * **规则（定死）**：
 * 1. 载荷为空 / 非串 ⇒ **抛错**（如实报「源不可用」，不静默吞掉）；
 * 2. base64 解码后**头不是 `krc1`** ⇒ **抛错**
 *    （⚠️ 这条很重要：万一接口改格式，我们**如实报错**，而不是把一堆乱码当歌词）；
 * 3. 跳过 4 字节头 ⇒ **循环 XOR** ⇒ 标准 zlib inflate ⇒ UTF-8；
 * 4. 解压失败 ⇒ **抛错**（带一句人话）；
 * 5. ⚠️ 明文**可能带 UTF-8 BOM**（实测《孤勇者》《Counting Stars》带、《一路向北》不带）
 *    ⇒ **保留原样**（不在这里剥）⇒ 由解析层容忍（与 QRC 同一套纪律）。
 *
 * @param content 歌词接口返回的 `content`（base64 文本）。
 * @returns KRC 明文。
 */
export function decodeKrcPayload(content: string): string {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('KRC 载荷为空')
  }
  // ⚠️ Node 的 base64 解码**静默忽略**非法字符 ⇒ 解码后要自己验头。
  const raw = Buffer.from(content.trim(), 'base64')
  if (raw.length <= KRC_HEADER.length) {
    throw new Error(`KRC 载荷太短（解出来只有 ${raw.length} 字节）`)
  }
  const head = raw.subarray(0, KRC_HEADER.length).toString('latin1')
  if (head !== KRC_HEADER) {
    throw new Error(`KRC 载荷头不是 ${KRC_HEADER}（得到 ${JSON.stringify(head)}）`)
  }
  const body = Buffer.from(raw.subarray(KRC_HEADER.length))
  for (let i = 0; i < body.length; i += 1) {
    const key = KRC_XOR_KEY[i % KRC_XOR_KEY.length]!
    body[i] = body[i]! ^ key
  }
  try {
    return inflateSync(body).toString('utf8')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`KRC 解压失败：${message}`)
  }
}

/**
 * 解码一份**行级**歌词载荷（`fmt=lrc`）—— **只做 base64 解码，不解密**。
 *
 * ⚠️ **为什么要单独一个函数**：酷狗的歌词下载接口有两种格式
 *    （`fmt=krc` 真逐字 / `fmt=lrc` 行级）⇒ **两者都返回 base64**，
 *    但只有 `krc` 那份还要再 XOR + inflate。
 *    （洛雪上游也是这么分的：`fmt === 'krc'` 走解密，`fmt === 'lrc'` 直接 base64。）
 *
 * @param content 歌词接口返回的 `content`（base64 文本）。
 * @returns 明文 LRC。
 */
export function decodeKrcPlainPayload(content: string): string {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('歌词载荷为空')
  }
  return Buffer.from(content.trim(), 'base64').toString('utf8')
}
