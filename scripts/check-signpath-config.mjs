// ---------------------------------------------------------------------------
// T87：SignPath 配置的**快速失败**检查
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这个**：发版工作流要在**送签之前**确认「配置齐了」。
//    缺配置时如果**继续跑**，会走到一半才炸（白等一轮 CI），
//    或者更糟 —— **悄悄跳过签名、照样发布**（那就产出了「声称已签名」其实是
//    没签的东西）⇒ 必须在最前面**快速失败**并**说清楚缺哪几个**。
//
// 用法：
//   node scripts/check-signpath-config.mjs
//
// 环境变量（缺任何一个 ⇒ 退出码 1）：
//   SIGNPATH_API_TOKEN     —— SignPath 的 API token（**secret**）
//   SIGNPATH_ORG_ID        —— 组织 ID
//   SIGNPATH_PROJECT_SLUG  —— 项目 slug
//   SIGNPATH_POLICY_SLUG   —— 签名策略 slug
//   SIGNPATH_ARTIFACT_SLUG —— artifact configuration slug
// ---------------------------------------------------------------------------

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 需要的配置项（顺序 = 报告顺序）。 */
export const REQUIRED_SIGNPATH_KEYS = [
  'SIGNPATH_API_TOKEN',
  'SIGNPATH_ORG_ID',
  'SIGNPATH_PROJECT_SLUG',
  'SIGNPATH_POLICY_SLUG',
  'SIGNPATH_ARTIFACT_SLUG',
]

/**
 * 检查配置是否齐全。
 *
 * @param {Record<string, string | undefined>} env 环境变量（通常是 `process.env`）。
 * @returns {{ ok: boolean; missing: string[] }} 缺哪几个。
 */
export function checkSignPathConfig(env) {
  const missing = REQUIRED_SIGNPATH_KEYS.filter((key) => {
    const value = env[key]
    return typeof value !== 'string' || value.trim() === ''
  })
  return { ok: missing.length === 0, missing }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 本文件被**直接当脚本跑**时为真（被测试 import 时为假 ⇒ 不会自己跑一遍）。 */
function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const a = resolve(entry)
    const b = resolve(fileURLToPath(import.meta.url))
    // ⚠️ Windows 上路径**大小写不敏感** ⇒ 比较前统一转小写。
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

if (isMainModule()) {
  const result = checkSignPathConfig(process.env)

  if (!result.ok) {
    console.error('[signpath] ✗ SignPath 配置不完整，**快速失败**（不做「跳过签名照样发布」）：')
    for (const key of result.missing) {
      console.error(`[signpath]   - 缺 ${key}`)
    }
    console.error('')
    console.error('[signpath] 怎么配：')
    console.error('[signpath]   GitHub → Settings → Secrets and variables → Actions')
    console.error('[signpath]   · Secret：SIGNPATH_API_TOKEN')
    console.error('[signpath]   · Variables：SIGNPATH_ORG_ID / SIGNPATH_PROJECT_SLUG /')
    console.error('[signpath]                 SIGNPATH_POLICY_SLUG / SIGNPATH_ARTIFACT_SLUG')
    console.error('[signpath]   详见 docs/signing.md')
    process.exit(1)
  }

  console.log(`[signpath] ✓ SignPath 配置齐全（${REQUIRED_SIGNPATH_KEYS.length} 项）`)
}
