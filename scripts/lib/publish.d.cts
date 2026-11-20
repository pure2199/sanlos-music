// ---------------------------------------------------------------------------
// scripts/lib/publish.d.cts —— 给 **TypeScript** 侧 import 这个 .cjs 模块的类型声明。
// ---------------------------------------------------------------------------
//
// ⚠ 本仓库的 `tsconfig.json` **没有 `allowJs`** ⇒ TS 不能直接 import `.cjs`
//    ⇒ 这里补一份**手写声明**（不引新依赖、不改 tsconfig）。
//    ⚠ `.cjs` 对应的声明文件后缀是 **`.d.cts`**（不是 `.d.ts`）。

/** 搬运方式：`rename` = 改名（同卷）；`copy` = 复制（跨卷回退）；`none` = 还没开始搬。 */
export type PublishMethod = 'rename' | 'copy' | 'none'

/** 一次搬运的结果。 */
export interface PublishResult {
  /** 产物**已经在目标位置**。 */
  ok: boolean
  /** 实际用的搬运方式。 */
  method: PublishMethod
  /** 失败原因（`ok` 为真时也可能是「删源失败」这类**非致命**错误）。 */
  error: Error | null
  /** 源目录**没能删掉**（复制成功但源被占用）⇒ 暂存目录里还留着一份。 */
  sourceKept: boolean
}

/**
 * 把 `from` 搬到 `to`（**覆盖式**：目标已存在时先删掉）。
 *
 * ⚠ 失败时**一律保留源目录** ⇒ 调用方能如实告诉用户「产物还在暂存目录里」。
 */
export declare function publishDir(from: string, to: string): PublishResult
