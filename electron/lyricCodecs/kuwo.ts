// ---------------------------------------------------------------------------
// 酷我逐字歌词（lrcx）：解密（T90-⑥）
// ---------------------------------------------------------------------------
//
// 载荷形状（2026-11-14 本机**真实 Electron 主进程**实测）：
//
//     "TP=content\r\nlrcx=1\r\n\r\n" + <密文>
//
// 解密链：
//
//     body      = buf.subarray(buf.indexOf('\r\n\r\n') + 4) // 跳过头部
//     inflated  = zlib.inflateSync(body)                  // 标准 zlib
//     inner     = Buffer.from(inflated.toString('utf8'), 'base64')
//     out[i]    = inner[i] ^ 'yeelion'[i % 8]              // 8 字节固定密钥，循环 XOR
//     plain     = out.toString('utf8')
//
// ---------------------------------------------------------------------------
// ⚠️ **出处与协议（与 `electron/lyricCodecs/krc.ts` 的纪律一致）**
// ---------------------------------------------------------------------------
//
// 酷我的 lrcx 解密算法是**公开算法**（洛雪的 `src/renderer/utils/musicSdk/kw/util.js`
// 的 `decodeLyric` 与多家社区实现口径一致）。
//
// ⚠️ **本仓库按算法自行实现，不移植任何一家的代码**
//    ⇒ `THIRD_PARTY_NOTICES.md` **不需要新增条目**（与 QRC 的 3DES 不同：
//    那次是**移植了洛雪的源码**，所以必须声明）。
//
// 参考（**算法口径**，不是代码来源）：
// - https://github.com/lyswhut/lx-music-desktop （Apache-2.0）
//   `src/renderer/utils/musicSdk/kw/util.js` 的 `decodeLyric`
//
// ---------------------------------------------------------------------------
// ⚠️ **真实密文不入库**
// ---------------------------------------------------------------------------
//
// 酷我的 XOR 密钥是**公开**的 ⇒ 真实密文入库 = 把歌词放进公开仓库
// ⇒ 单测（`test/lyric-kuwo.test.ts`）用**自己合成**的密文
// （且**独立手写**一份 XOR ⇒ 生产代码的密钥写错时用例会红）。
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
 * 酷我 lrcx 的 **XOR 密钥**（8 字节，循环使用）。
 *
 * ⚠️ 这是**公开算法常量**（不是密钥管理意义上的「秘密」）
 *    —— 它的作用与 `node:crypto` 的算法编号同级。
 */
export const KUWO_XOR_KEY = 'yeelion'

/** 酷我载荷的**头**（ASCII `tp=content`）—— 用来识别「这确实是酷我的歌词」。 */
export const KUWO_HEADER = 'tp=content'

/** 头部与密文之间的**分隔符**。 */
const KUWO_SEPARATOR = '\r\n\r\n'

// ---------------------------------------------------------------------------
// 解密
// ---------------------------------------------------------------------------

/**
 * 解密一份 **酷我 lrcx 载荷** ⇒ lrcx 明文。
 *
 * **规则（定死）**：
 * 1. 载荷为空 / 太短 ⇒ **抛错**（如实报「源不可用」，不静默吞掉）；
 * 2. 前 10 字节**不是 `tp=content`**（大小写不敏感）⇒ **抛错**
 *    （⚠️ 这条很重要：万一接口改格式，我们**如实报错**，而不是把一堆乱码当歌词）；
 * 3. 找不到 `\r\n\r\n` 分隔符 ⇒ **抛错**；
 * 4. 分隔符之后 ⇒ 标准 **zlib inflate** ⇒ **base64 解码** ⇒ 与
 *    {@link KUWO_XOR_KEY} **循环 XOR** ⇒ UTF-8；
 * 5. inflate 失败 / 解出来**不是 base64** ⇒ **抛错**（带一句人话）；
 * 6. 解出来的明文**没有任何时间戳** ⇒ **抛错**
 *    （⇒ 说明密钥或格式变了 ⇒ 如实报错，别把乱码当歌词显示给用户）。
 *
 * @param raw 歌词接口返回的**原始字节**（`res.arrayBuffer()` 的结果）。
 * @returns lrcx 明文（`[mm:ss.xxx]<a,b>词…` 形状）。
 */
export function decodeKuwoLrcxPayload(raw: Uint8Array): string {
  if (!raw || raw.length === 0) {
    throw new Error('酷我歌词载荷为空')
  }
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (buf.length < KUWO_HEADER.length) {
    throw new Error(`酷我歌词载荷太短（解出来只有 ${buf.length} 字节）`)
  }
  const head = buf.toString('utf8', 0, KUWO_HEADER.length).toLowerCase()
  if (head !== KUWO_HEADER) {
    throw new Error(`酷我歌词载荷头不是 ${KUWO_HEADER}（得到 ${JSON.stringify(head)}）`)
  }
  const separator = buf.indexOf(KUWO_SEPARATOR)
  if (separator < 0) {
    throw new Error('酷我歌词载荷缺少头部分隔符')
  }
  const body = buf.subarray(separator + KUWO_SEPARATOR.length)
  let inflated: Buffer
  try {
    inflated = inflateSync(body)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`酷我歌词解压失败：${message}`)
  }
  // ⚠️ inflate 出来的是 **base64 文本** ⇒ 先解 base64，再 XOR。
  const base64Text = inflated.toString('utf8').trim()
  if (base64Text === '' || !/^[A-Za-z0-9+/=\s]+$/.test(base64Text)) {
    throw new Error('酷我歌词解压结果不是 base64（格式可能已变）')
  }
  const inner = Buffer.from(base64Text, 'base64')
  if (inner.length === 0) {
    throw new Error('酷我歌词解出来是空的')
  }
  const key = Buffer.from(KUWO_XOR_KEY, 'utf8')
  const out = Buffer.alloc(inner.length)
  for (let i = 0; i < inner.length; i += 1) {
    out[i] = inner[i]! ^ key[i % key.length]!
  }
  const plain = out.toString('utf8')
  // ⚠️ 酷我的歌词**一定有**时间戳 ⇒ 没有 ⇒ 密钥错了或格式变了 ⇒ 如实报错。
  if (!/\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(plain)) {
    throw new Error('酷我歌词解密结果里没有任何时间戳（密钥或格式可能已变）')
  }
  return plain
}
