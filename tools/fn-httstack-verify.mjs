// Task 9b 的**真实 Electron 主进程**运行时验证脚本。
//
// ---------------------------------------------------------------------------
// 为什么必须有这个脚本（追加要求 F）
// ---------------------------------------------------------------------------
// 本任务的核心结论——「证书放行是否真的生效」「换分区是否真的绕开证书错误缓存」——
// **在 Vitest 里证明不了**：单测用注入的 `fetchImpl`，根本碰不到 Chromium 网络栈。
// 故本脚本在**真的 Electron 主进程**里跑一遍，把结论打印出来。
//
// 覆盖的实测点：
// 1. 未受信的 host（本地自签 HTTPS 证书）→ `ses.fetch` **应当失败**（证书错误）；
// 2. 把该 host 登记进 `trusted` 并 `bumpTrustEpoch()` → 再打**同一个 host:port**
//    → **应当成功**（这就是「换分区才能绕开证书错误缓存」的实测证据）；
// 3. 打印实际使用的分区名，确认 epoch 变化后分区名确实变了；
// 4. 追加要求 D 的三项能力实测：
//    D.1 `ses.fetch` 能否设置 `Cookie` 头；
//    D.2 `ses.fetch` 是否支持 `init.signal`；
//    D.3 `ses.fetch` 的响应体能否当流读取。
//
// ---------------------------------------------------------------------------
// 约束
// ---------------------------------------------------------------------------
// - 用 `node_modules/electron` 里的 Electron 跑（`electron tools/fn-httstack-verify.mjs`），
//   **不引入任何新的运行时依赖**（esbuild 是既有 devDependency，只用来打包本仓库的 TS）。
// - **绝不**把真实 FN ID / 账号 / 口令写进脚本或输出：自签证书是本地临时生成的一次性证书，
//   目标 host 是 `localhost`，Cookie 里放的是假 token。
// - 证书生成用 Git for Windows 自带的 openssl；找不到就**如实报错退出**，不伪造结论。

import { app } from 'electron'
import { createRequire } from 'node:module'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

/** 打印一行（同时收集，便于最后汇总）。 */
function log(...args) {
  console.log(...args)
}

/** 统一的退出码：0 = 全部符合预期。 */
let exitCode = 0

/** 记录一条「不符合预期」的结论。 */
function fail(message) {
  exitCode = 1
  console.log(`[FAIL] ${message}`)
}

/** 记录一条「符合预期」的结论。 */
function pass(message) {
  console.log(`[OK]   ${message}`)
}

// ---------------------------------------------------------------------------
// 加载本仓库的 `electron/http.ts` / `electron/probe.ts`（真实实现，不是复刻）
// ---------------------------------------------------------------------------

/**
 * 加载某个模块的编译产物。
 *
 * 优先用已构建的 `dist-electron/<name>.js`；没有就地用 esbuild（既有 devDependency）
 * 打包一份到临时目录——**不新增任何运行时依赖**。
 */
function loadModule(name) {
  const built = path.join(repoRoot, 'dist-electron', `${name}.js`)
  if (existsSync(built)) {
    log(`[setup] 用已构建的产物：${built}`)
    return require(built)
  }
  const esbuild = require('esbuild')
  const outDir = mkdtempSync(path.join(tmpdir(), 'fnm-httpstack-'))
  const outfile = path.join(outDir, `${name}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'electron', `${name}.ts`)],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    outfile,
  })
  log(`[setup] 用 esbuild 现场打包：${outfile}`)
  return require(outfile)
}

// ---------------------------------------------------------------------------
// 一次性自签证书
// ---------------------------------------------------------------------------

/** openssl 的候选路径（Git for Windows 自带一份）。 */
const OPENSSL_CANDIDATES = [
  process.env.FNMUSIC_OPENSSL,
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\bin\\openssl.exe',
].filter(Boolean)

/** 找一个可用的 openssl。 */
function findOpenssl() {
  for (const candidate of OPENSSL_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return 'openssl'
  } catch {
    return null
  }
}

/**
 * 生成一份**一次性**自签证书（CN/SAN = localhost）。
 *
 * 只在本机回环上用，验证完即删；**不含任何真实身份信息**。
 */
function makeSelfSigned(dir) {
  const openssl = findOpenssl()
  if (!openssl) {
    throw new Error(
      '找不到 openssl（Git for Windows 自带：' +
        'C:\\Program Files\\Git\\usr\\bin\\openssl.exe）。' +
        '可用环境变量 FNMUSIC_OPENSSL 指定，或把 openssl 放进 PATH。',
    )
  }
  const keyFile = path.join(dir, 'key.pem')
  const certFile = path.join(dir, 'cert.pem')
  execFileSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  log(`[setup] 自签证书已生成：${certFile}`)
  return { key: readFileSync(keyFile), cert: readFileSync(certFile) }
}

// ---------------------------------------------------------------------------
// 本地 HTTPS 服务器（回显收到的请求头 / 请求体 / 分片响应 / 慢响应）
// ---------------------------------------------------------------------------

/** 读完请求体并按 utf8 返回（用于回显 POST 的体）。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/** 启动本地 HTTPS 服务器，返回 `{ port, close() }`。 */
function startServer(tls) {
  const server = https.createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/slow')) {
      // 5 秒后才响应：用来测「信号能不能真的中止请求」。
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('slow')
      }, 5000)
      return
    }
    if (url.startsWith('/chunks')) {
      // 分两片写：用来测「响应体能不能当流读取」。
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write(Buffer.from([1, 2, 3]))
      setTimeout(() => {
        res.end(Buffer.from([4, 5, 6]))
      }, 50)
      return
    }
    const body = JSON.stringify({ url, headers: req.headers, body: await readBody(req) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`)
  log('')

  const { createHttpStack, TrustedHosts } = loadModule('http')
  const { classifyProbeError, PROBE_ERROR_TLS } = loadModule('probe')
  const workDir = mkdtempSync(path.join(tmpdir(), 'fnm-httstack-'))
  let server = null

  try {
    const tls = makeSelfSigned(workDir)
    server = await startServer(tls)
    const base = `https://localhost:${server.port}`
    log(`[setup] 本地自签 HTTPS 服务：${base}`)
    log('')

    // ---- 分区 0：未受信 --------------------------------------------------
    const trusted = new TrustedHosts()
    const stack = createHttpStack({ trusted, partitionPrefix: 'fn-verify' })
    const partition0 = stack.partitionName()
    log(`[1] 未受信时使用的分区：${partition0}`)

    let firstError = null
    try {
      await stack.fetch(`${base}/info`)
      fail('未受信的自签证书竟然请求成功了（预期应当失败）')
    } catch (err) {
      firstError = err
      const message = err instanceof Error ? err.message : String(err)
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : ''
      const causeCode =
        err instanceof Error && err.cause && typeof err.cause === 'object'
          ? err.cause.code
          : undefined
      log(`    预期中的失败：${message}`)
      log(`    cause：${cause}${causeCode ? `（code=${String(causeCode)}）` : ''}`)
      // 打印 Chromium 错误的**形态**：实测 `code` / `cause` 都是 undefined，
      // 错误码只在 message 里——这是「必须从 message 抽 net::ERR_*」的依据。
      const ownKeys = err instanceof Error ? Object.getOwnPropertyNames(err) : []
      log(
        `    错误形态：name=${JSON.stringify(err instanceof Error ? err.name : '')}` +
          ` code=${JSON.stringify(err instanceof Error ? err.code : undefined)}` +
          ` cause=${JSON.stringify(err instanceof Error ? err.cause : undefined)}` +
          ` 自有属性=${JSON.stringify(ownKeys)}`,
      )
      const looksLikeCertError =
        /CERT|certificate|self[- ]signed/i.test(`${message} ${cause} ${String(causeCode ?? '')}`)
      if (looksLikeCertError) pass('未受信 host 的证书被 Chromium 拒绝（符合预期）')
      else fail(`失败原因不像证书错误：${message} ${cause}`)

      // 把**真实**的 Chromium 错误喂给**真实**的归类函数：
      // 探针必须给出「TLS 握手失败：证书不受信，可在设置里放行该主机后重试」，
      // 而不是笼统的「连接失败（网络异常或服务未响应）」。
      const classified = classifyProbeError(err)
      log(`    classifyProbeError(真实 Chromium 错误) → ${classified}`)
      if (classified === PROBE_ERROR_TLS) {
        pass('真实 Chromium 证书错误被归类为 TLS 握手失败（放行提示保留）')
      } else {
        fail(`真实 Chromium 证书错误被归类成「${classified}」（丢掉了放行提示）`)
      }
    }

    // ---- 登记 + 换分区 --------------------------------------------------
    const changed = trusted.add('localhost')
    log('')
    log(`[2] trusted.add('localhost') 返回 ${changed}（true = 集合真的变了）`)
    stack.bumpTrustEpoch()
    const partition1 = stack.partitionName()
    log(`    bumpTrustEpoch() 之后的分区：${partition1}`)
    if (partition1 !== partition0) pass(`分区名确实变了：${partition0} → ${partition1}`)
    else fail(`分区名没有变化（仍是 ${partition0}）`)

    // ---- 同一个 host:port 再打一次：应当成功 ----------------------------
    log('')
    log('[3] 用新分区重打同一个 host:port（预期成功）')
    let echoed = null
    try {
      const res = await stack.fetch(`${base}/info`, {
        headers: { cookie: 'music-token=FAKE-TOKEN-NOT-REAL; mode=relay' },
      })
      const text = await res.text()
      echoed = JSON.parse(text)
      pass(`请求成功：HTTP ${res.status}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fail(`换分区之后仍然失败：${message}`)
    }

    // ---- 追加要求 D.1：Cookie 头能不能设置 --------------------------------
    log('')
    log('[D.1] ses.fetch 能否设置 Cookie 头')
    if (echoed) {
      const got = echoed.headers?.cookie
      log(`    服务器收到的 cookie 头：${JSON.stringify(got ?? null)}`)
      if (typeof got === 'string' && got.includes('FAKE-TOKEN-NOT-REAL')) {
        pass('Cookie 头原样到达上游（可以设置）')
      } else {
        fail(`Cookie 头没有原样到达（收到 ${JSON.stringify(got ?? null)}）`)
      }
    } else {
      fail('没有拿到响应，无法验证 Cookie 头')
    }

    // ---- 追加要求 D.2：init.signal 支持 ----------------------------------
    log('')
    log('[D.2] ses.fetch 是否支持 init.signal（150ms 后中止一个 5s 的慢请求）')
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 150)
    const guard = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('__GUARD_TIMEOUT__')), 3000)
    })
    try {
      await Promise.race([stack.fetch(`${base}/slow`, { signal: controller.signal }), guard])
      fail('请求在 150ms 内就返回了（说明 signal 没有生效）')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const name = err instanceof Error ? err.name : ''
      if (message.includes('__GUARD_TIMEOUT__')) {
        fail('3 秒内既没返回也没被中止：ses.fetch 不支持 init.signal（会挂死）')
      } else {
        pass(`signal 生效，请求被中止：${name}: ${message}`)
      }
    } finally {
      clearTimeout(abortTimer)
    }

    // ---- 追加要求 D.3：响应体能否当流读取 --------------------------------
    log('')
    log('[D.3] ses.fetch 的响应体能否当流读取')
    try {
      const res = await stack.fetch(`${base}/chunks`)
      const body = res.body
      if (!body || typeof body.getReader !== 'function') {
        fail(`res.body 不是 ReadableStream（实际：${Object.prototype.toString.call(body)}）`)
      } else {
        const reader = body.getReader()
        let chunks = 0
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks += 1
          total += value?.byteLength ?? 0
        }
        pass(`响应体可流式读取：读到 ${chunks} 个分片，共 ${total} 字节`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fail(`流式读取失败：${message}`)
    }

    // ---- 追加要求 D.4：ses.fetch 接受 Request 对象（代理实际走的就是它）----
    //
    // `electron/proxy.ts` 的二进制流式路径传的是 `buildUpstreamRequest()` 产出的
    // **Request 对象**（带体的 POST + authx + cookie），不是字符串 URL。
    // 将来改 `buildUpstreamRequest` 或 `http.fetch` 可能悄悄破坏 `POST /track/stream`，
    // 故这里把它钉住。
    log('')
    log('[D.4] ses.fetch 接受 Request 对象（带体 POST + authx + cookie）')
    try {
      const requestBody = JSON.stringify({ trackGUID: 'GUID-1' })
      const request = new Request(`${base}/music/api/v1/track/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'music-token=FAKE-TOKEN-NOT-REAL; mode=relay',
          authx: 'nonce=1&timestamp=2&sign=deadbeef',
        },
        body: requestBody,
      })
      const res = await stack.fetch(request)
      const echoed = JSON.parse(await res.text())
      const gotBody = echoed.body
      const gotCookie = echoed.headers?.cookie
      const gotAuthx = echoed.headers?.authx
      log(`    服务器收到的请求体：${JSON.stringify(gotBody ?? null)}`)
      log(`    服务器收到的 cookie 头：${JSON.stringify(gotCookie ?? null)}`)
      log(`    服务器收到的 authx 头：${JSON.stringify(gotAuthx ?? null)}`)
      if (gotBody === requestBody) pass('Request 的请求体逐字到达上游')
      else fail(`Request 的请求体没有逐字到达（收到 ${JSON.stringify(gotBody ?? null)}）`)
      if (typeof gotCookie === 'string' && gotCookie.includes('mode=relay')) {
        pass('Request 的 cookie 头原样到达上游')
      } else {
        fail(`Request 的 cookie 头没有原样到达（收到 ${JSON.stringify(gotCookie ?? null)}）`)
      }
      if (gotAuthx === 'nonce=1&timestamp=2&sign=deadbeef') pass('Request 的 authx 头原样到达上游')
      else fail(`Request 的 authx 头没有原样到达（收到 ${JSON.stringify(gotAuthx ?? null)}）`)
      const resBody = res.body
      if (resBody && typeof resBody.getReader === 'function') {
        pass('Request 路径的响应体仍是 ReadableStream')
      } else {
        fail(`Request 路径的响应体不是 ReadableStream（${Object.prototype.toString.call(resBody)}）`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fail(`ses.fetch(Request) 失败：${message}`)
    }

    log('')
    log(`汇总：${exitCode === 0 ? '全部符合预期' : '存在不符合预期的项'}`)
    log(`（第一次失败的错误信息：${firstError instanceof Error ? firstError.message : 'n/a'}）`)
  } finally {
    if (server) await server.close()
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
}

app
  .whenReady()
  .then(() => main())
  .catch((err) => {
    console.error('[FATAL]', err)
    exitCode = 1
  })
  .finally(() => {
    app.exit(exitCode)
  })
