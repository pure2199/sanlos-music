// ---------------------------------------------------------------------------
// T90-⑦：咪咕 mrc 的**合成载荷**助手（测试专用）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这个文件**：咪咕的 mrc 是**加密**的
//    ⇒ 测「解密」必须有**密文**，而**真实密文不入库**
//    （咪咕的 TEA 密钥是公开的 ⇒ 真实密文入库 = 把歌词放进公开仓库）。
//    ⇒ 这里用**自己合成**的明文 + **独立手写**的**加密器**。
//
// ⚠️ **为什么这份加密器可信**（鉴别力的关键）：
//    「加密器与解密器一起理解错」会让单测**假绿**。
//    ⇒ 正解 = 拿**上游快照的解密器**（洛雪 `mg/utils/mrc.js`）来验：
//    本助手加密 ⇒ 上游解密 ⇒ 必须**还原成同一个明文**（逐字节相等）。
//    ⇒ 已验过（`release/verify/t90-07-migu-encryptor-check.mjs`，4/4 通过）。
//
// ⚠️ **本文件不是测试**（文件名不含 `.test.`）⇒ Vitest 不会把它当用例收集。
//
// ---------------------------------------------------------------------------

const DELTA = 2654435769n
const SIGN_BIT = 1n << 63n
const MODULUS = 1n << 64n

/** 咪咕的 TEA 密钥（**公开的**客户端常量；故意**不** import 生产代码的常量）。 */
export const KEY_LITERAL: readonly bigint[] = [
  27303562373562475n,
  18014862372307051n,
  22799692160172081n,
  34058940340699235n,
]

/** 64 位有符号回绕。 */
function toLong(value: bigint): bigint {
  const wrapped = ((value % MODULUS) + MODULUS) % MODULUS
  return wrapped >= SIGN_BIT ? wrapped - MODULUS : wrapped
}

/** 非线性混合函数（**独立手写**：把两项的加法与异或分开写）。 */
function mix(x: bigint, y: bigint, sum: bigint, k: bigint): bigint {
  const a = toLong(x ^ sum)
  const b = toLong(y ^ k)
  const left = toLong(toLong(y >> 5n) ^ toLong(x << 2n))
  const right = toLong(toLong(x >> 3n) ^ toLong(y << 4n))
  return toLong(toLong(a + b) ^ toLong(left + right))
}

/** 轮数 = `6 + floor(52 / n)`（上游的 `6 + 52/n` 是 BigInt 除法 ⇒ 截断）。 */
function roundCount(length: number): number {
  return Number(6n + 52n / BigInt(length))
}

/** 加密（**就地**改写明文字组 ⇒ 密文字组）。 */
function teaEncrypt(plain: bigint[], key: readonly bigint[]): bigint[] {
  const c = plain.slice()
  let sum = 0n
  for (let round = 0; round < roundCount(plain.length); round += 1) {
    sum = toLong(sum + DELTA)
    const j5 = toLong(3n & toLong(sum >> 2n))
    // ① 第 0 个字：密文 = 明文 + mix(明文[1], 明文[末])
    c[0] = toLong(c[0]! + mix(c[1]!, c[c.length - 1]!, sum, key[Number(j5)]!))
    // ② 其余的字（**从小到大**）：密文 = 明文 + mix(下一个明文, 上一个密文)
    for (let i = 1; i < c.length; i += 1) {
      const ki = Number(toLong(toLong(3n & BigInt(i)) ^ j5))
      const next = i === c.length - 1 ? c[0]! : c[i + 1]!
      c[i] = toLong(c[i]! + mix(next, c[i - 1]!, sum, key[ki]!))
    }
  }
  return c
}

/** 明文（UTF-16LE）⇒ 64 位字组（**只取整块**）。 */
function textToWords(text: string): bigint[] {
  const bytes = Buffer.from(text, 'utf16le')
  const words: bigint[] = []
  for (let i = 0; i + 8 <= bytes.length; i += 8) {
    let value = 0n
    for (let b = 7; b >= 0; b -= 1) {
      value = (value << 8n) | BigInt(bytes[i + b]!)
    }
    words.push(toLong(value))
  }
  return words
}

/** 64 位字组 ⇒ hex 文本。 */
function wordsToHex(words: bigint[]): string {
  return words
    .map((word) => {
      let value = toLong(word)
      if (value < 0n) value += MODULUS
      return value.toString(16).padStart(16, '0')
    })
    .join('')
}

/**
 * 明文要**补齐到 8 字节的整数倍**（= 4 个 UTF-16 码元）
 * —— 否则最后一个不满的块会被丢掉（上游同款：只取整块）。
 */
export function padToBlock(text: string): string {
  return text + ' '.repeat((4 - (text.length % 4)) % 4)
}

/** 造一份**合成的**咪咕 mrc 载荷（**hex 文本**）。 */
export function makeMiguPayload(plain: string): string {
  return wordsToHex(teaEncrypt(textToWords(padToBlock(plain)), KEY_LITERAL))
}
