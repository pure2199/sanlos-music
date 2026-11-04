// 真机联调诊断：Step D 失败定位（T17 收尾）
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// Step D（客户端 FFmpeg 兜底全链路）的结果是：
//   - 下载落盘 ✓（24.2 MB 的 ALAC/m4a）
//   - 兜底产物 ✓（<userData>/fallback/*.opus，3.43 MB）
//   - 播放 ✗：「该音频无法播放：当前内核不支持该格式」，`<audio>` 的 src 读不到
//
// ⇒ 要回答的是**两件事**：
//   1. `fnml://local/track/<id>` 到底返回了**哪一个文件**（.opus 产物？还是 .m4a 原件？）
//      —— 这决定了「兜底产物有没有真的被喂给 Chromium」；
//   2. 引擎给媒体元素设的 **真实 src** 是什么、`play()` 被怎么拒了、`MediaError.code` 是几。
//
// ⚠️ **原探针的盲区（必须知道）**：
//    引擎的 `<audio>` 是 `document.createElement('audio')` 造的、**从不挂进 DOM**
//    （见 `src/player/engine.ts` 的 `defaultCreateAudioElement`）
//    → `document.querySelector('audio')` **永远查不到它**
//    → 原探针报的「`<audio>` src：（空）」是**探针看不见**，不是「src 真的是空」。
//    本脚本改用**原型劫持**（`HTMLMediaElement.prototype`）来观测引擎的真实媒体元素。
//
// ---------------------------------------------------------------------------
// 两阶段（为了不重复下载 24 MB）
// ---------------------------------------------------------------------------
//   阶段 A：登录 → 扫描曲库 → 找到一首体积最小的 ALAC/APE（拿到 guid 与标题）→ 退出；
//   阶段 B：把**已下载好的本地文件**写进索引当种子（免下载）→ 重启 → 搜索该曲 →
//           劫持媒体原型 → 双击播放 → 观测 → 并直接 fetch `fnml://` 看它返回什么。
//
// 凭证只从环境变量读，不打印、不落盘。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-fallback-playback-diag.mjs
//       （可选）FN_SEED_FILE=<本地已下载的音频路径> —— 用它当阶段 B 的本地副本
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const SERVER = process.env.FN_SERVER ?? ''
const SEED_FILE = process.env.FN_SEED_FILE ?? ''
if (!FN_USER || !FN_PASS || !SERVER) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-fallback-playback-diag.mjs')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 通用：登录
// ---------------------------------------------------------------------------

/** 把「m:ss」/「h:mm:ss」解析成秒（解析不了返回 0）。 */
function toSeconds(text) {
  const parts = String(text ?? '')
    .split(':')
    .map((part) => Number(part))
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

async function login(window) {
  await window.fill('#fnm-address', SERVER)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window.getByText('已连接', { exact: false }).first().waitFor({ timeout: 30000 })
}

/** 找不可解格式的曲目（在渲染进程里通过 fnm:// 调真实 API）。 */
async function findUndecodable(window) {
  return window.evaluate(async () => {
    const found = []
    const PAGE_SIZE = 1000
    const MAX_PAGES = 12
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await fetch(`fnm://srv/track/list?page=${page}&size=${PAGE_SIZE}`)
      const json = await res.json()
      const list = json?.data?.list ?? []
      for (const track of list) {
        const codec = String(track.audioSpec?.codec ?? '').toUpperCase() || '(空)'
        if (codec !== 'ALAC' && codec !== 'APE') continue
        found.push({
          guid: track.guid,
          title: track.title,
          codec,
          size: Number(track.audioSpec?.size ?? 0),
          durationMs: Number(track.duration ?? 0),
          albumGuid: String(track.album?.guid ?? ''),
        })
      }
      if (list.length === 0) break
    }
    found.sort((a, b) => (a.size || 1e12) - (b.size || 1e12))
    // 只保留「在所属专辑前 50 首内」的候选（专辑详情一屏 50 行，点得到）。
    for (const candidate of found) {
      if (!candidate.albumGuid) continue
      const res = await fetch(
        `fnm://srv/track/album-detail/list?albumGUID=${encodeURIComponent(candidate.albumGuid)}&page=1&size=50`,
      )
      const json = await res.json()
      const list = json?.data?.list ?? []
      if (list.find((t) => t.guid === candidate.guid)) return candidate
    }
    return null
  })
}

// ---------------------------------------------------------------------------
// 阶段 A：扫描
// ---------------------------------------------------------------------------

async function phaseScan() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-diag-scan-'))
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userDataDir}`], env: { ...process.env } })
  try {
    const window = await app.firstWindow()
    console.log('\n─── 阶段 A：扫描曲库里的不可解格式曲目 ───\n')
    await login(window)
    console.log('✓ 登录成功')
    const target = await findUndecodable(window)
    if (!target) {
      console.log('✗ 没找到 ALAC / APE 曲目')
      return null
    }
    console.log(
      `✓ 目标：「${target.title}」｜${target.codec}｜${(target.size / 1048576).toFixed(1)} MB｜guid=${target.guid}`,
    )
    return target
  } finally {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    await app.close().catch(() => undefined)
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 阶段 B：播放 + 观测
// ---------------------------------------------------------------------------

/** 在渲染进程里劫持 `HTMLMediaElement.prototype`，观测引擎的真实媒体元素。 */
const INSTRUMENT = () => {
  const diag = {
    srcSets: [],
    plays: [],
    errors: [],
    created: 0,
  }
  window.__diag = diag
  const proto = HTMLMediaElement.prototype

  const srcDesc = Object.getOwnPropertyDescriptor(proto, 'src')
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get() {
      return srcDesc.get.call(this)
    },
    set(value) {
      diag.srcSets.push({ value: String(value), at: Date.now() })
      srcDesc.set.call(this, value)
    },
  })

  const origPlay = proto.play
  proto.play = function patchedPlay() {
    const record = {
      at: Date.now(),
      srcAttr: this.getAttribute('src') ?? '',
      currentSrc: this.currentSrc ?? '',
      readyState: this.readyState,
      networkState: this.networkState,
    }
    diag.plays.push(record)
    let result
    try {
      result = origPlay.call(this)
    } catch (error) {
      record.thrown = String(error)
      return result
    }
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          record.resolved = true
        },
        (error) => {
          record.rejected = `${error?.name ?? ''}: ${error?.message ?? ''}`
        },
      )
    }
    return result
  }

  const origAdd = proto.addEventListener
  proto.addEventListener = function patchedAdd(type, listener, options) {
    if (type === 'error') {
      return origAdd.call(
        this,
        type,
        function wrappedErrorListener(event) {
          try {
            diag.errors.push({
              at: Date.now(),
              code: this?.error?.code ?? null,
              message: this?.error?.message ?? '',
              srcAttr: this?.getAttribute('src') ?? '',
              currentSrc: this?.currentSrc ?? '',
              readyState: this?.readyState,
              networkState: this?.networkState,
              duration: Number.isFinite(this?.duration) ? this.duration : null,
            })
          } catch {
            /* 忽略 */
          }
          return listener.call(this, event)
        },
        options,
      )
    }
    return origAdd.call(this, type, listener, options)
  }

  const origCreate = Document.prototype.createElement
  Document.prototype.createElement = function patchedCreate(tag, options) {
    const element = origCreate.call(this, tag, options)
    if (String(tag).toLowerCase() === 'audio') {
      diag.created += 1
      try {
        diag.srcSets.push({ value: '(created <audio>)', at: Date.now() })
      } catch {
        /* 忽略 */
      }
    }
    return element
  }
}

async function phasePlay(target) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-diag-play-'))

  // -- 种子：把已下载好的本地文件写进下载索引（免掉重复下载）------------------
  let seeded = null
  if (SEED_FILE && existsSync(SEED_FILE)) {
    const bytes = statSync(SEED_FILE).size
    writeFileSync(
      join(userDataDir, 'downloads.json'),
      JSON.stringify(
        {
          version: 1,
          entries: {
            [target.guid]: {
              songId: target.guid,
              file: SEED_FILE,
              bytes,
              ext: 'm4a',
              downloadedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )
    seeded = SEED_FILE
    console.log(`✓ 已用本地副本做种子（${(bytes / 1048576).toFixed(1)} MB）`)
  } else {
    console.log('· 没有 FN_SEED_FILE → 本次不下载（兜底需要本地副本，可能直接报 no-local）')
  }

  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userDataDir}`], env: { ...process.env } })
  try {
    const window = await app.firstWindow()
    console.log('\n─── 阶段 B：播放 + 观测 ───\n')
    const consoleErrors = []
    window.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    window.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

    await login(window)
    console.log('✓ 登录成功')

    // -- 搜索目标曲目 --------------------------------------------------------
    await window.locator('nav[aria-label="主导航"] button', { hasText: '搜索' }).first().click()
    const input = window.locator('input[type="search"], input[type="text"]').first()
    await input.waitFor({ timeout: 10000 })
    await input.fill(target.title)
    await input.press('Enter')
    await window.waitForTimeout(4000)

    const selector = `[data-testid="fnm-download-button"][data-song-id="${target.guid}"]`
    let located = false
    for (let offset = 0; offset <= 6000 && !located; offset += 600) {
      await window.evaluate((scrollTop) => {
        const list = document.querySelector('[aria-label="搜索结果歌曲列表"]')
        if (!list) return
        list.scrollTop = scrollTop
        list.dispatchEvent(new Event('scroll', { bubbles: true }))
      }, offset)
      await window.waitForTimeout(400)
      located = (await window.locator(selector).count()) > 0
    }
    if (!located) {
      console.log('✗ 搜索结果里定位不到目标行')
      process.exitCode = 1
      return
    }
    console.log('✓ 已在搜索结果里定位到目标行')

    // -- 劫持媒体原型（在播放之前）--------------------------------------------
    await window.evaluate(INSTRUMENT)

    // -- 双击播放 ------------------------------------------------------------
    const row = window.locator('[role="option"]').filter({ has: window.locator(selector) }).first()
    await row.scrollIntoViewIfNeeded()
    await row.dblclick()

    // -- 观测 40 秒 ----------------------------------------------------------
    const takeSnapshot = () =>
      window.evaluate(() => {
        const audio = document.querySelector('audio')
        return {
          domAudioCount: document.querySelectorAll('audio').length,
          diag: window.__diag,
          notice: document.querySelector('[data-testid="player-notice"]')?.textContent?.trim() ?? '',
          position: document.querySelector('[data-testid="player-position"]')?.textContent?.trim() ?? '',
          title: document.querySelector('.fnm-playerbar__title')?.textContent?.trim() ?? '',
          quality: document.querySelector('[data-testid="player-quality"]')?.textContent?.trim() ?? '',
          domAudioSrc: audio?.getAttribute('src') ?? null,
        }
      })

    const deadline = Date.now() + 40000
    let last = null
    let played = false
    while (Date.now() < deadline) {
      last = await takeSnapshot()
      played = last?.diag?.plays?.some((p) => p.resolved) ?? false
      if (played) break
      await window.waitForTimeout(800)
    }
    // ⚠️ **play() 兑现后再观察几秒**：进度是靠 `timeupdate` 推进的，
    //    在 play 兑现的那一刻快照必然还是「0:00」——那不是「没播起来」。
    if (played) {
      await window.waitForTimeout(6000)
      last = await takeSnapshot()
    }

    const diag = last?.diag ?? { srcSets: [], plays: [], errors: [], created: 0 }
    console.log('\n【观测结果】')
    console.log(`  DOM 里的 <audio> 数量：${last?.domAudioCount}（引擎的音频元素**不挂 DOM**，这是预期）`)
    console.log(`  创建过的 <audio> 个数：${diag.created}`)
    console.log(`  播放条标题：${last?.title || '（空）'}`)
    console.log(`  播放提示：${last?.notice || '（无）'}`)
    console.log(`  播放进度：${last?.position || '（无）'}`)
    console.log(`  音质徽标：${last?.quality || '（无）'}`)
    console.log(`\n  src 赋值记录（${diag.srcSets.length} 条）：`)
    for (const entry of diag.srcSets) console.log(`    · ${entry.value}`)
    console.log(`\n  play() 调用记录（${diag.plays.length} 条）：`)
    for (const entry of diag.plays) {
      console.log(
        `    · srcAttr=${entry.srcAttr || '（空）'} currentSrc=${entry.currentSrc || '（空）'} ` +
          `readyState=${entry.readyState} → ${entry.resolved ? '✓兑现' : entry.rejected ? `✗被拒 ${entry.rejected}` : entry.thrown ? `✗抛错 ${entry.thrown}` : '（未兑现）'}`,
      )
    }
    console.log(`\n  媒体 error 事件（${diag.errors.length} 条）：`)
    for (const entry of diag.errors) {
      console.log(
        `    · code=${entry.code} message=${entry.message || '（空）'} srcAttr=${entry.srcAttr || '（空）'} ` +
          `readyState=${entry.readyState} networkState=${entry.networkState}`,
      )
    }
    if (consoleErrors.length > 0) {
      console.log(`\n  控制台错误（${consoleErrors.length} 条）：`)
      for (const line of consoleErrors.slice(0, 10)) console.log(`    · ${line}`)
    }

    // -- 直接问 `fnml://` 到底返回什么 ----------------------------------------
    const probe = await window.evaluate(async (guid) => {
      const url = `fnml://local/track/${encodeURIComponent(guid)}`
      const out = { url }
      try {
        const res = await fetch(url)
        out.status = res.status
        out.contentType = res.headers.get('content-type')
        out.contentLength = res.headers.get('content-length')
        out.contentRange = res.headers.get('content-range')
        const buffer = new Uint8Array(await res.arrayBuffer())
        out.byteLength = buffer.byteLength
        out.magicHex = Array.from(buffer.slice(0, 8))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')
        out.magicText = String.fromCharCode(...buffer.slice(0, 8)).replace(/[^\x20-\x7e]/g, '.')
      } catch (error) {
        out.fetchError = String(error)
      }
      try {
        const res = await fetch(url, { headers: { range: 'bytes=0-99' } })
        out.rangeStatus = res.status
        out.rangeContentRange = res.headers.get('content-range')
      } catch (error) {
        out.rangeError = String(error)
      }
      return out
    }, target.guid)

    console.log('\n【直接 fetch fnml:// 的结果】')
    console.log(`  地址：${probe.url}`)
    console.log(`  状态：${probe.status ?? '（异常）'} ${probe.fetchError ?? ''}`)
    console.log(`  Content-Type：${probe.contentType ?? '（无）'}`)
    console.log(`  Content-Length：${probe.contentLength ?? '（无）'}`)
    console.log(`  实收字节：${probe.byteLength ?? '（无）'}`)
    console.log(`  头部 8 字节：${probe.magicHex ?? '（无）'}  「${probe.magicText ?? ''}」`)
    console.log(`  Range 请求：状态 ${probe.rangeStatus ?? '（异常）'} / ${probe.rangeContentRange ?? '（无）'}`)

    // -- 兜底产物目录 --------------------------------------------------------
    let artifacts = '（无）'
    try {
      artifacts = readdirSync(join(userDataDir, 'fallback'))
        .map((name) => {
          const st = statSync(join(userDataDir, 'fallback', name))
          return `${name}（${(st.size / 1048576).toFixed(2)} MB）`
        })
        .join('、')
    } catch {
      /* 没有兜底目录 */
    }
    console.log(`\n【兜底产物目录】${artifacts}`)

    // -- 结论判定 ------------------------------------------------------------
    const position = last?.position ?? ''
    const advanced = toSeconds(position) > 0
    console.log('\n【结论】')
    console.log(`  play() 是否兑现：${played ? '✓' : '✗'}`)
    console.log(`  进度是否推进：${advanced ? `✓（${position}）` : `✗（${position || '（无）'}）`}`)
    console.log(`  媒体错误事件：${diag.errors.length} 条`)
    console.log(
      `  直接 fetch fnml://：${
        probe.fetchError
          ? '被 CSP connect-src 拦下（**按设计**：渲染层从不 fetch 本地媒体，只有 <audio src> 用它）'
          : `状态 ${probe.status}｜${probe.contentType ?? '（无类型）'}`
      }`,
    )
  } finally {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    await app.close().catch(() => undefined)
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

console.log('\n═══ Step D 失败定位：兜底转码产物 → Chromium 播放 ═══')
const target = await phaseScan()
if (!target) {
  process.exitCode = 1
} else {
  await phasePlay(target)
}
