// ---------------------------------------------------------------------------
// 咪咕逐字歌词（mrc）：解密（T90-⑦）
// ---------------------------------------------------------------------------
//
// 载荷形状（2026-11-14 本机**真实 Electron 主进程**实测，`content-type: application/marc`）：
//
//     <一串 hex 文本>          // 33680 个 hex 字符（实测样本）
//
// 解密链：
//
//     blocks   = 每 **16 个 hex 字符** = 1 个 **64 位**字（BigInt，按有符号解释）
//     words    = TEA 变体解密（**64 位字长**，见下）
//     bytes    = 每个字 ⇒ 8 字节**小端**
//     plain    = 把每个 8 字节块按 **UTF-16LE** 解码后拼接
//
// ---------------------------------------------------------------------------
// ⚠️ **算法与出处**
// ---------------------------------------------------------------------------
//
// 咪咕的 mrc 解密是**公开算法**：洛雪 `src/renderer/utils/musicSdk/mg/utils/mrc.js`
// （Apache-2.0）与多家社区实现口径一致。
//
// ⚠️ **本仓库按算法自行实现，不移植任何一家的代码**
//    ⇒ 但与 QRC 的 3DES 不同，**这里必须补 `THIRD_PARTY_NOTICES.md` 条目**
//    （算法虽公开，但它是一份**非常具体**的变体：64 位字长 + 固定的 9 个密钥常量
//     + 一处非标准的轮函数下标 ⇒ 「按算法自行实现」的说法不足以自证 ⇒ 声明出处更稳）。
//
// ⚠️ **不是标准 TEA**（标准 TEA 是 32 位字长）⇒ **`node:crypto` 解不了**
//    ⇒ 只能自己实现（`BigInt` + 64 位回绕）。
//
// ⚠️ **正确性锚点 = 与上游逐字节差分**（`release/verify/t90-07-migu-mrc-diff.mjs`）：
//    用**同一份真实载荷**，比对我们的输出与上游快照的输出 ⇒ **必须逐字节相等**。
//    —— 「看着像歌词」**不算**证据。
//
// 参考（**算法口径**，不是代码来源）：
// - https://github.com/lyswhut/lx-music-desktop （Apache-2.0）
//   `src/renderer/utils/musicSdk/mg/utils/mrc.js` 的 `decrypt`
//
// ---------------------------------------------------------------------------
// ⚠️ **真实密文不入库**
// ---------------------------------------------------------------------------
//
// 咪咕的密钥是**公开**的 ⇒ 真实密文入库 = 把歌词放进公开仓库
// ⇒ 单测（`test/lyric-migu.test.ts`）用**自己合成**的明文 + **自己写**的加密器
//    （独立手写 ⇒ 生产代码写错时用例会红）。
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** TEA 的 `DELTA`（标准值）。 */
const DELTA = 2654435769n

/** 咪咕 mrc 的**密钥常量**（64 位）。 */
export const MIGU_TEA_KEY: readonly bigint[] = [
  27303562373562475n,
  18014862372307051n,
  22799692160172081n,
  34058940340699235n,
]

/** 一个 64 位字 = **16 个 hex 字符**。 */
const HEX_PER_BLOCK = 16

/** 解密后至少要这么多个 hex 字符才有意义（否则直接原样返回）。 */
const MIN_HEX_LENGTH = 32

// ---------------------------------------------------------------------------
// 64 位整数工具
// ---------------------------------------------------------------------------

/** 2^63。 */
const SIGN_BIT = 1n << 63n

/** 2^64。 */
const MODULUS = 1n << 64n

/**
 * 把一个整数**按 64 位有符号**解释（回绕）。
 *
 * ⚠️ 上游用的是「超过 MAX 就减 2^64、低于 MIN 就加 2^64」的递归写法
 *    ⇒ 与这里的「先取模再判符号」**完全等价**，但这里不会递归 ⇒ 不会爆栈。
 */
function toLong(value: bigint): bigint {
  const wrapped = ((value % MODULUS) + MODULUS) % MODULUS
  return wrapped >= SIGN_BIT ? wrapped - MODULUS : wrapped
}

/** 把一个 64 位字变成 **8 字节小端**。 */
function longToBytes(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  let rest = value
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

// ---------------------------------------------------------------------------
// TEA 变体解密
// ---------------------------------------------------------------------------

/**
 * TEA 变体解密（**64 位字长**，就地改写 `data`）。
 *
 * ⚠️ 与标准 TEA 的差别：
 * - 字长 **64 位**（不是 32 位）；
 * - 轮计数器的初值是 `(6 + 52 / n) * DELTA`（标准 TEA 是 `n * DELTA`）；
 * - 密钥下标是 `(3 & 轮次) ^ 轮函数的中间量`（标准 TEA 是 `sum >> 11` / `sum & 3`）。
 *
 * @param data 64 位字数组（**就地**改写）。
 * @param key 密钥常量（**只用前 4 个**——下标恒在 0…3）。
 */
function teaDecrypt(data: bigint[], key: readonly bigint[]): bigint[] {
  const count = BigInt(data.length)
  if (data.length < 1) return data
  let current = data[0]!
  let sum = toLong((6n + 52n / count) * DELTA)
  for (;;) {
    if (sum === 0n) break
    const mixed = toLong(3n & toLong(sum >> 2n))
    // ⚠️ 内层：从最后一个字**倒着**算到第 1 个字（第 0 个字单独算）。
    let index = count
    for (;;) {
      index -= 1n
      if (index > 0n) {
        const previous = data[Number(index - 1n)]!
        const keyIndex = Number(toLong(toLong(3n & index) ^ mixed))
        current = toLong(
          data[Number(index)]! -
            (toLong(toLong(current ^ sum) + toLong(previous ^ key[keyIndex]!)) ^
              toLong(
                toLong(toLong(previous >> 5n) ^ toLong(current << 2n)) +
                  toLong(toLong(current >> 3n) ^ toLong(previous << 4n)),
              )),
        )
        data[Number(index)] = current
      } else break
    }
    const last = data[Number(count - 1n)]!
    const keyIndex = Number(toLong(toLong(index & 3n) ^ mixed))
    current = toLong(
      data[0]! -
        (toLong(toLong(key[keyIndex]! ^ last) + toLong(current ^ sum)) ^
          toLong(
            toLong(toLong(last >> 5n) ^ toLong(current << 2n)) +
              toLong(toLong(current >> 3n) ^ toLong(last << 4n)),
          )),
    )
    data[0] = current
    sum = toLong(sum - DELTA)
  }
  return data
}

/**
 * 把 hex 文本切成 64 位字数组（**每 16 个 hex 字符一个字**）。
 *
 * ⚠️ 尾部不足 16 个字符的部分**丢掉**（上游同款）。
 */
function hexToBlocks(hex: string): bigint[] {
  const count = Math.floor(hex.length / HEX_PER_BLOCK)
  const out: bigint[] = []
  for (let i = 0; i < count; i += 1) {
    out.push(toLong(BigInt(`0x${hex.slice(i * HEX_PER_BLOCK, (i + 1) * HEX_PER_BLOCK)}`)))
  }
  return out
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 解密一份 **咪咕 mrc 载荷** ⇒ mrc 明文。
 *
 * **规则（定死）**：
 * 1. 载荷为空 / 不是字符串 ⇒ **抛错**（如实报「源不可用」）；
 * 2. 载荷**太短**（< 32 个 hex 字符）⇒ **原样返回**（上游同款：不足以构成密文）；
 * 3. 载荷**不是合法的 hex** ⇒ **抛错**（格式变了 ⇒ 如实报错，别把乱码当歌词）；
 * 4. 每 16 个 hex 字符 = 1 个 64 位字 ⇒ TEA 变体解密 ⇒ 8 字节小端
 *    ⇒ 按 **UTF-16LE** 解码拼接；
 * 5. 解出来的明文**没有任何行头** ⇒ **抛错**
 *    （⇒ 说明密钥或格式变了 ⇒ 如实报错）。
 *
 * @param payload mrc 载荷（**hex 文本**）。
 * @returns mrc 明文（`[起ms,时ms]词(起ms,时ms)词…` 形状）。
 */
export function decryptMiguMrc(payload: string): string {
  if (typeof payload !== 'string') {
    throw new Error('咪咕歌词载荷不是字符串')
  }
  const hex = payload.trim()
  if (hex === '') {
    throw new Error('咪咕歌词载荷为空')
  }
  if (hex.length < MIN_HEX_LENGTH) {
    // ⚠️ 太短 ⇒ 不可能是密文 ⇒ 原样返回（上游同款口径）。
    return payload
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('咪咕歌词载荷不是 hex 文本（格式可能已变）')
  }
  const blocks = hexToBlocks(hex)
  if (!blocks.length) {
    throw new Error('咪咕歌词载荷解不出任何块（太短）')
  }
  const words = teaDecrypt(blocks, MIGU_TEA_KEY)
  const plain = words.map((word) => longToBytes(word).toString('utf16le')).join('')
  // ⚠️ mrc 的歌词**一定有**行头（`[起ms,时ms]`）⇒ 没有 ⇒ 密钥错了或格式变了。
  if (!/\[\d+,\d+\]/.test(plain)) {
    throw new Error('咪咕歌词解密结果里没有任何行头（密钥或格式可能已变）')
  }
  return plain
}
