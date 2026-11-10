// ---------------------------------------------------------------------------
// scripts/check-signpath-config.d.mts —— 给 **TypeScript** 侧 import 这个 .mjs 脚本的类型声明。
// ---------------------------------------------------------------------------
//
// ⚠️ 本仓库的 `tsconfig.json` **没有 `allowJs`** ⇒ TS 不能直接 import `.mjs`
//    ⇒ 这里补一份**手写声明**（不引新依赖、不改 tsconfig）。

/** 需要的配置项（顺序 = 报告顺序）。 */
export declare const REQUIRED_SIGNPATH_KEYS: string[]

/**
 * 检查 SignPath 配置是否齐全。
 *
 * @param env 环境变量（通常是 `process.env`）。
 * @returns `ok` = 是否齐全；`missing` = 缺哪几个。
 */
export declare function checkSignPathConfig(
  env: Record<string, string | undefined>,
): { ok: boolean; missing: string[] }
