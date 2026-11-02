#!/usr/bin/env node
/**
 * FN Connect 实盘冒烟验证（一次性联调工具，Task 4）
 *
 * ⚠️ 定位说明：**一次性联调工具**，**不是测试套件的一部分**（`npm test` 不会跑它），
 * 也**不是生产代码**（不会被 electron 主进程或渲染进程引用）。仓库保留它只是为了
 * 将来需要复核「真实 FN 连接接口的响应形状」时能一键复跑。
 *
 * 用途：把 **真实** `POST https://5ddd.com/api/v1/fn/con` 的返回，与本仓库
 * `electron/connection.ts` 的 `parseConnectionParams` + `buildCandidates` 输出逐项对照，
 * 确认「解析」与「候选构造」与真实响应吻合。
 *
 * 该接口**只需要 FN ID，不需要账号密码**。FN ID 是对外可访问的设备标识，
 * 因此**只从环境变量读取**，不落盘、不写进仓库、不打印原文（输出中以 `<fnId>` 代替）。
 * 任何输出（含错误信息）都先经 `mask()` 处理，避免服务端回显的 FN ID 明文外泄。
 *
 * 用法:
 *   FN_ID=<你的 FN ID> node tools/fn-con-smoke.mjs
 *
 * 未设置 FN_ID 时给出提示并跳过（退出码 0）；请求失败或校验不通过时退出码非 0。
 *
 * 实现说明：脚本用 esbuild（devDependency）把 `electron/connection.ts` 与 `electron/sign.ts`
 * 现场打成一份 CJS 再加载，因此验证的是**真实实现**，不是脚本里的复刻版。
 * 临时打包文件放在系统临时目录，**无论成功失败都在 finally 里删除**。
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fnId = (process.env.FN_ID ?? '').trim()

if (!fnId) {
  console.log('未设置 FN_ID 环境变量，跳过实盘冒烟验证。')
  console.log('用法: FN_ID=<你的 FN ID> node tools/fn-con-smoke.mjs')
  process.exit(0)
}

/** 输出里把 FN ID 原文替换掉，避免设备标识落进日志。 */
const mask = (text) => String(text).split(fnId).join('<fnId>')
const show = (text) => console.log(mask(text))
const showErr = (text) => console.error(mask(text))

// ---------------------------------------------------------------------------
// 加载真实实现
// ---------------------------------------------------------------------------

const bundle = await build({
  stdin: {
    contents: [
      "export * from './electron/connection.ts'",
      "export * from './electron/sign.ts'",
      "export { FN_CON_API, FN_CON_PATH, FN_SIGN_KEY } from './shared/constants.ts'",
    ].join('\n'),
    resolveDir: repoRoot,
    sourcefile: 'fn-con-smoke-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  write: false,
})

const bundleFile = join(tmpdir(), `fn-con-smoke-${process.pid}.cjs`)
writeFileSync(bundleFile, bundle.outputFiles[0].text, 'utf8')

let exitCode = 0
try {
  const require = createRequire(import.meta.url)
  const impl = require(bundleFile)

  /**
   * 切出上游参考实现 tools/fn-probe.mjs 的 buildCandidates（已在真实 NAS 上跑通）。
   * 探针的 buildCandidates 依赖模块级 `fnId`，这里把它作为工厂参数注入。
   */
  function loadProbeBuildCandidates() {
    const src = readFileSync(join(repoRoot, 'tools', 'fn-probe.mjs'), 'utf8')
    const start = src.indexOf('function buildCandidates(params) {')
    const end = src.indexOf('async function probe(candidate)')
    if (start < 0 || end < 0 || end <= start) {
      throw new Error('tools/fn-probe.mjs 结构已变化：切不出 buildCandidates')
    }
    return new Function(
      'fnId',
      'params',
      `${src.slice(start, end)}\nreturn buildCandidates(params)`,
    )
  }

  const probeBuildCandidates = loadProbeBuildCandidates()

  // -------------------------------------------------------------------------
  // 真实请求（原始响应 = 基准事实）
  // -------------------------------------------------------------------------

  const body = JSON.stringify({ fnId })
  const res = await fetch(impl.FN_CON_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: impl.authx('POST', impl.FN_CON_PATH, body, { key: impl.FN_SIGN_KEY }),
    },
    body,
    signal: AbortSignal.timeout(15000),
  })
  const raw = await res.json().catch(() => null)

  if (!raw) {
    throw new Error(`FN 连接接口返回非 JSON (HTTP ${res.status})`)
  }
  if (raw.code !== 0) {
    throw new Error(`FN 连接接口失败: code=${raw.code} msg=${raw.msg ?? ''}`)
  }

  show(`=== FN 连接接口原始响应 (HTTP ${res.status}) ===`)
  show(`code=${raw.code} msg=${raw.msg ?? ''}`)
  const data = raw.data ?? {}
  show(`ipv4        : ${JSON.stringify(data.ipv4 ?? [])}`)
  show(`publicIpv4  : ${JSON.stringify(data.publicIpv4 ?? [])}`)
  show(`publicIpv6  : ${JSON.stringify(data.publicIpv6 ?? [])}`)
  show(`fn          : ${JSON.stringify(data.fn ?? [])}`)
  show(`port        : ${JSON.stringify(data.port ?? {})}`)

  // -------------------------------------------------------------------------
  // 对照：解析结果 / 候选构造 / 上游参考实现
  // -------------------------------------------------------------------------

  const parsed = impl.parseConnectionParams(data)
  const fetched = await impl.fetchConnectionParams(fnId)
  const candidates = impl.buildCandidates(fnId, parsed)
  const probeCandidates = probeBuildCandidates(fnId, data)

  show('\n=== parseConnectionParams 输出 ===')
  show(JSON.stringify(parsed, null, 2))

  show('\n=== buildCandidates 输出 ===')
  for (const c of candidates) {
    show(`[${c.kind.padEnd(6)}] ${c.address.padEnd(40)} ${c.label} isRelay=${c.isRelay}`)
  }

  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok })
    show(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }

  show('\n=== 对照校验 ===')
  check('接口业务码为 0', raw.code === 0, `code=${raw.code}`)

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check(
    '解析结果与原始响应逐字段一致',
    eq(parsed.internalIPv4s, data.ipv4 ?? []) &&
      eq(parsed.publicIPv4s, data.publicIpv4 ?? []) &&
      eq(parsed.publicIPv6s, data.publicIpv6 ?? []) &&
      eq(parsed.relayAddresses, data.fn ?? []) &&
      parsed.httpPort === (data.port?.httpPort ?? 5666) &&
      parsed.httpsPort === (data.port?.httpsPort ?? 5667),
  )
  check('fetchConnectionParams 与 parseConnectionParams 结果一致', eq(fetched, parsed))
  check('候选列表与上游参考实现 tools/fn-probe.mjs 逐字节一致（正常载荷下）', eq(candidates, probeCandidates))

  // 候选不变量
  const relayCandidates = candidates.filter((c) => c.kind === 'relay')
  check(
    '中继候选只生成 https 且去掉端口后缀',
    relayCandidates.length > 0 &&
      relayCandidates.every((c) => c.address.startsWith('https://') && !/:\d+$/.test(c.address)),
  )
  check(
    'IPv6 候选带方括号',
    parsed.publicIPv6s.every((ip) =>
      candidates.some((c) => c.address.includes(`[${ip}]`)),
    ),
  )
  // 每个 IP 先 http 后 https（按去掉协议与端口后的主机名配对）
  const hostOfAddress = (address) => address.replace(/^https?:\/\//, '').replace(/:\d+$/, '')
  const ipCandidates = candidates.filter((c) => c.kind !== 'relay')
  check(
    '每个 IP 先 http 后 https',
    ipCandidates.every((c, i) => {
      if (!c.address.startsWith('https://')) return true
      const prev = ipCandidates[i - 1]
      return (
        !!prev &&
        prev.address.startsWith('http://') &&
        hostOfAddress(prev.address) === hostOfAddress(c.address)
      )
    }),
  )
  check('中继候选排在最后', candidates.length > 0 && candidates[candidates.length - 1].kind === 'relay')
  check(
    '中继地址优先取接口返回值（fn 数组非空时不回退）',
    (data.fn ?? []).length === 0 ||
      relayCandidates.every((c) =>
        (data.fn ?? []).some((f) => c.address === `https://${String(f).replace(/:\d+$/, '')}`),
      ),
  )

  const failed = checks.filter((c) => !c.ok)
  show(`\n结果: ${checks.length - failed.length}/${checks.length} 项通过`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (err) {
  // 错误信息可能回显 FN ID：一律先掩码再输出（修复轮次 I2）。
  showErr(`错误: ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
} finally {
  // 临时打包文件必须清理。process.exit 不会执行 finally，故退出放在 try/catch 之后。
  try {
    unlinkSync(bundleFile)
  } catch {
    /* 文件已不存在 */
  }
}

process.exit(exitCode)
