// 真机联调校准：系统**没有** FFmpeg 时，客户端给不给「人话」提示（T19-2）
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// Step D 最后一个子项：「确认**系统无 ffmpeg 时**的提示」。
// 之前一直没测，是因为本机装了 winget 版 ffmpeg（9.0.2）——
// 平时测到的永远是「有 ffmpeg」那条分支。
//
// ⇒ 这里的做法是：**启动 Electron 时把 PATH 里的 ffmpeg 目录摘掉**，
//    让应用「以为」本机没有 ffmpeg（`detectFfmpeg()` 逐个候选试，第一个能跑 `-version` 的就是它；
//    摘掉 PATH 里的那个之后，另外三个固定候选路径本机也不存在 → 必然探测不到）。
//    然后播一首 **ALAC**（Chromium 解不了的格式），
//    看界面给出的是不是那句「未检测到 FFmpeg。安装 FFmpeg 后即可通过转码播放。」
//
// ⚠️ **为什么不给它一个真的 ALAC 文件**：
//    兜底转码的判定顺序是「有本地副本？→ 有 FFmpeg？→ 才转码」。
//    所以只要索引里有**一个**指向本地文件的条目就够了 ——
//    压根走不到「读文件内容」那一步。用一个几字节的占位文件即可，
//    省掉 24 MB 的下载。
//
// ---------------------------------------------------------------------------
// 验收
// ---------------------------------------------------------------------------
// 播放提示必须包含「未检测到 FFmpeg」，且**不能**是「内核不支持该格式」那种误导文案。
//
// 凭证只从环境变量读，不打印、不落盘。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-no-ffmpeg-probe.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const SERVER = process.env.FN_SERVER ?? ''
if (!FN_USER || !FN_PASS || !SERVER) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-no-ffmpeg-probe.mjs')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// PATH 裁剪
// ---------------------------------------------------------------------------

/**
 * 算出「摘掉 ffmpeg 所在目录」的 PATH。
 *
 * ⚠️ Windows 的环境变量名大小写不敏感（`Path` / `PATH` 都可能），故两种都找。
 */
function stripFfmpegFromPath() {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const dirs = raw.split(delimiter).filter((entry) => entry.length > 0)
  const kept = []
  const removed = []
  for (const dir of dirs) {
    if (existsSync(join(dir, 'ffmpeg.exe'))) removed.push(dir)
    else kept.push(dir)
  }
  return { path: kept.join(delimiter), removed }
}

const trimmed = stripFfmpegFromPath()
if (trimmed.removed.length === 0) {
  console.log('⚠️ PATH 里本来就没有 ffmpeg → 这次测的就是「本来就没有」的分支')
} else {
  console.log(`✓ 从 PATH 里摘掉 ${trimmed.removed.length} 个含 ffmpeg.exe 的目录`)
}
for (const dir of trimmed.removed) console.log(`    · ${dir}`)

// ---------------------------------------------------------------------------
// 找一首 ALAC（客户端能扫到的最小的一首）
// ---------------------------------------------------------------------------

/** 在渲染进程里通过 `fnm://` 扫曲库，找体积最小的 ALAC/APE。 */
async function findUndecodable(window) {
  return window.evaluate(async () => {
    const found = []
    for (let page = 1; page <= 12; page += 1) {
      const res = await fetch(`fnm://srv/track/list?page=${page}&size=1000`)
      const json = await res.json()
      const list = json?.data?.list ?? []
      for (const track of list) {
        const codec = String(track.audioSpec?.codec ?? '').toUpperCase()
        if (codec !== 'ALAC' && codec !== 'APE') continue
        found.push({
          guid: track.guid,
          title: track.title,
          codec,
          size: Number(track.audioSpec?.size ?? 0),
        })
      }
      if (list.length === 0) break
    }
    found.sort((a, b) => (a.size || 1e12) - (b.size || 1e12))
    return found[0] ?? null
  })
}

/** 登录。 */
async function login(window) {
  await window.fill('#fnm-address', SERVER)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window.getByText('已连接', { exact: false }).first().waitFor({ timeout: 30000 })
}

/** 启动应用（可指定 PATH）。 */
async function launch(userDataDir, pathValue) {
  return electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PATH: pathValue, Path: pathValue },
  })
}

// ---------------------------------------------------------------------------
// 阶段 A：扫曲库，拿到一首 ALAC
// ---------------------------------------------------------------------------

console.log('\n═══ Step D 补测：系统无 FFmpeg 时的提示 ═══\n')

const scanDir = mkdtempSync(join(tmpdir(), 'fnmusic-noff-scan-'))
let target = null
{
  const app = await launch(scanDir, process.env.PATH ?? '')
  try {
    const window = await app.firstWindow()
    await login(window)
    target = await findUndecodable(window)
    if (!target) {
      console.log('✗ 曲库里没有 ALAC / APE 曲目，无法验证兜底提示')
      process.exit(1)
    }
    console.log(`✓ 目标：「${target.title}」｜${target.codec}｜${(target.size / 1048576).toFixed(1)} MB`)
  } finally {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    await app.close().catch(() => undefined)
    rmSync(scanDir, { recursive: true, force: true, maxRetries: 3 })
  }
}

// ---------------------------------------------------------------------------
// 阶段 B：裁剪 PATH + 种子文件 → 播放 → 看提示
// ---------------------------------------------------------------------------

const playDir = mkdtempSync(join(tmpdir(), 'fnmusic-noff-play-'))
{
  // 占位「本地副本」：兜底判定只看「索引里有没有这条」，压根不会读它的内容。
  const fakeDir = join(playDir, 'media')
  mkdirSync(fakeDir, { recursive: true })
  const fakeFile = join(fakeDir, 'placeholder.m4a')
  writeFileSync(fakeFile, Buffer.from('placeholder'), 'utf8')
  writeFileSync(
    join(playDir, 'downloads.json'),
    JSON.stringify(
      {
        version: 1,
        entries: {
          [target.guid]: {
            songId: target.guid,
            file: fakeFile,
            bytes: 11,
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

  const app = await launch(playDir, trimmed.path)
  try {
    const window = await app.firstWindow()
    const consoleErrors = []
    window.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await login(window)
    console.log('✓ 登录成功（本次启动的 PATH 里没有 ffmpeg）')

    // 搜到那首 ALAC
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
    } else {
      const row = window.locator('[role="option"]').filter({ has: window.locator(selector) }).first()
      await row.scrollIntoViewIfNeeded()
      await row.dblclick()

      // 等提示出现（转码探测很快，失败也是秒级）
      let notice = ''
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        await window.waitForTimeout(500)
        notice =
          (await window.locator('[data-testid="player-notice"]').first().textContent().catch(() => '')) ??
          ''
        notice = notice.trim()
        if (notice.length > 0) break
      }

      console.log(`\n【播放提示】${notice || '（没有提示）'}`)
      const expected = '未检测到 FFmpeg'
      if (notice.includes(expected)) {
        console.log(`  ✓ 提示包含「${expected}」→ 用户知道**下一步做什么**（装 FFmpeg）`)
      } else {
        console.log(`  ✗ 提示**没有**提到 FFmpeg → 用户只会看到一个无用的报错`)
        process.exitCode = 1
      }
      if (notice.includes('内核不支持该格式')) {
        console.log('  ✗ 提示是「内核不支持该格式」——**误导**（真实原因是本机没装 FFmpeg）')
        process.exitCode = 1
      }
      if (consoleErrors.length > 0) {
        console.log(`\n  控制台错误（${consoleErrors.length} 条）：`)
        for (const line of consoleErrors.slice(0, 5)) console.log(`    · ${line}`)
      }
    }
  } finally {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    await app.close().catch(() => undefined)
    rmSync(playDir, { recursive: true, force: true, maxRetries: 3 })
  }
}
