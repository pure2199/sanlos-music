// ---------------------------------------------------------------------------
// tools/fn-check-signature.d.mts —— 给 **TypeScript** 侧 import 这个 .mjs 工具用的类型声明。
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么需要它**：本仓库的 `tsconfig.json` **没有 `allowJs`**
//    ⇒ TS 不能直接 import `.mjs`（会报「找不到对应的类型声明文件」）。
//    ⇒ 这里补一份**手写声明**：**不引新依赖、不改 tsconfig**。
//
// ⚠️ **声明必须与实现对齐**：实现改了 ⇒ 这里也要跟着改
//    （单测 `test/t87-signing-assertion.test.ts` 会钉住关键字段与行为）。
// ---------------------------------------------------------------------------

/** 一个产物的签名探测结果（`probeSignature` 的返回）。 */
export interface SignatureProbeInfo {
  /** 签名状态（Windows 的 `Status`：`Valid` / `NotSigned` / `HashMismatch` …）。 */
  status: string
  /** 签名者主体（`CN=…`）；没有签名时为 `null`。 */
  signer: string | null
  /** 签名者证书的指纹（thumbprint）。 */
  thumbprint: string
  /** 是否带 **RFC 3161 时间戳**。 */
  hasTimestamp: boolean
  /** 时间戳签发者主体；没有时间戳时为 `null`。 */
  timeStamper: string | null
  /**
   * **探测本身是否失败**（T87.11-b）。
   *
   * ⚠️ `true` = 签名状态**未知**（探不出来），**不等于**「有签名」。
   *    ⇒ 判定层必须**单独**报「探测失败」，不许拿它判「有签名」。
   */
  probeFailed?: boolean
}

/** 判定条件（`evaluateSignature` 的第二个参数）。 */
export interface SignatureCheckOptions {
  /**
   * `signed`（有签名）/ `none`（没签名）/ `valid`（状态必须是 Valid）。
   *
   * ⚠️ `null` = **没要求**；其它任何字符串都按「字面量」判
   *    （CLI 层会把未知值直接判失败 ⇒ 不存在「拼错就悄悄跳过检查」）。
   */
  expect?: string | null
  /** 期望的**整串**签名者主体（`CN=…, O=…`）；`null` = 没要求。 */
  expectSigner?: string | null
  /** 期望的 **CN**（可逗号分隔多个候选）；`null` = 没要求。 */
  expectCn?: string | null
  /** 是否要求 **RFC 3161 时间戳**。 */
  requireTimestamp?: boolean
  /** 期望的 .pfx 主体（**整串**相等）。 */
  pfxSubject?: string
}

/** 命令行参数解析结果。 */
export interface SignatureCliArgs {
  /** `signed` / `none` / `valid`；`null` = 没给这个选项。 */
  expect: string | null
  /** 期望的整串签名者主体；`null` = 没给这个选项。 */
  expectSigner: string | null
  /** 期望的 CN；`null` = 没给这个选项。 */
  expectCn: string | null
  requireTimestamp: boolean
  pfx: string
  pfxPassword: string
  targets: string[]
  help?: boolean
}

/** 解析命令行参数。 */
export function parseArgs(argv: string[]): SignatureCliArgs

/**
 * 载入 `shared/update.ts` 的导出（客户端与本工具**共用同一份**）。
 *
 * ⚠️ 懒加载：只在真的要比 CN 时才加载（不让 esbuild 影响「有/无签名」那条老路）。
 */
export function getSharedSigning(): {
  matchesExpectedSigner(subject: string, expected: string): boolean
  parseSignerCandidates(expected: string): string[]
  extractCommonNames(subject: string): string[]
}

/** 读一个文件的签名信息（走 `Get-AuthenticodeSignature`）。 */
export function probeSignature(filePath: string): SignatureProbeInfo

/**
 * 给 PowerShell 子进程用的环境变量。
 *
 * ⚠️ 会把 **Windows PowerShell 5.1 自己的**系统模块目录**前置**到
 *    `PSModulePath`（CI 上 runner 的 `PSModulePath` 指向 pwsh 7 的模块目录
 *    ⇒ 5.1 会找到同名但加载不了的模块）。
 */
export function powershellEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv

/** 把 PowerShell 的失败整理成一行可读的失败原因。 */
export function describePowerShellFailure(cause: unknown): string

/** 读一个 .pfx 的主体名。 */
export function probePfxSubject(
  pfxPath: string,
  password: string,
): { subject: string; thumbprint: string }

/**
 * 判定一个产物的签名是否符合预期，返回**问题列表**（空数组 = 通过）。
 *
 * ⚠️ 每条问题**不含**文件名（由调用方补上）。
 */
export function evaluateSignature(
  info: SignatureProbeInfo,
  options?: SignatureCheckOptions,
): string[]

/** CLI 主流程。 */
export function main(argv: string[]): void
