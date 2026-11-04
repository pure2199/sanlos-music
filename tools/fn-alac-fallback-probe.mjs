// 真机联调校准：Step D —— **客户端 FFmpeg 兜底解码全链路**（T17）。
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// 客户端最硬的一条能力链：曲库里有一首 Chromium **解不了**的格式（ALAC / APE），
// 用户的正常路径是「先下载到本地 → 播放时自动转码成 Opus → 用 fnml:// 播」。
// 这条链在开发期只有**单测**覆盖，真机上从没跑通过。
//
// 脚本按真实用户路径走：
//   1. 在**客户端自己的渲染进程**里通过 `fnm://` 调 `/track/list`，
//      找出曲库里的 ALAC / APE 曲目（挑**体积最小**的一首，中继带宽有限）；
//   2. **按专辑**搜到它所在的专辑 → 点开专辑详情（曲库里那首同名歌有几十首，
//      靠歌名搜索会落在渲染窗口外，故走专辑这条确定路径）；
//   3. 在专辑详情里点该行的**下载按钮** → 等下载完成；
//   4. 双击该行**播放** → 引擎识别到不可解格式 → 走客户端 FFmpeg 兜底转码；
//   5. 核对：播放条标题、进度是否推进、`<audio>` 的 **真实 src**（必须是 `fnml://`，
//      说明放的是本地转码产物而不是 NAS 原流）、播放提示文案；
//   6. 报告下载落盘路径与兜底产物路径（**不删除**，由使用者决定）。
//
// ⚠️ 下载会写进**用户的「我的音乐」目录**（`%USERPROFILE%\Music\飞牛音乐`），
//    这是客户端的既定行为；脚本会把落盘路径打印出来，便于事后清理。
//
// 凭证只从环境变量读，不打印、不落盘。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-alac-fallback-probe.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const SERVER = process.env.FN_SERVER ?? ''
if (!FN_USER || !FN_PASS || !SERVER) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-alac-fallback-probe.mjs')
  process.exit(2)
}

/** 找不可解格式的曲目（在渲染进程里通过 fnm:// 调真实 API）。 */
async function findUndecodable(window) {
  return window.evaluate(async () => {
    const found = []
    const histogram = {}
    // 实测：不可解格式散落在 17.3 万首里，前几百首没有 → 必须多翻几页。
    const PAGE_SIZE = 1000
    const MAX_PAGES = 12
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await fetch(`fnm://srv/track/list?page=${page}&size=${PAGE_SIZE}`)
      const json = await res.json()
      const list = json?.data?.list ?? []
      for (const track of list) {
        const codec = String(track.audioSpec?.codec ?? '').toUpperCase() || '(空)'
        histogram[codec] = (histogram[codec] ?? 0) + 1
        if (codec !== 'ALAC' && codec !== 'APE') continue
        found.push({
          guid: track.guid,
          title: track.title,
          codec,
          size: Number(track.audioSpec?.size ?? 0),
          durationMs: Number(track.duration ?? 0),
          format: String(track.audioSpec?.format ?? ''),
          albumName: String(track.album?.name ?? ''),
          albumGuid: String(track.album?.guid ?? ''),
          page,
        })
      }
      if (list.length === 0) break
    }
    // 体积优先（没有体积就看时长）——中继带宽有限，优先挑小的。
    found.sort(
      (a, b) => (a.size || 1e12) - (b.size || 1e12) || (a.durationMs || 1e12) - (b.durationMs || 1e12),
    )

    // ⚠️ 只保留「**在所属专辑的前 50 首内**」的候选：
    //    专辑详情页一屏只渲染 50 行，深处的曲目点不到（客户端分页要滚到底才续）。
    const visible = []
    for (const candidate of found) {
      if (!candidate.albumGuid) continue
      const res = await fetch(
        `fnm://srv/track/album-detail/list?albumGUID=${encodeURIComponent(candidate.albumGuid)}&page=1&size=50`,
      )
      const json = await res.json()
      const list = json?.data?.list ?? []
      const hit = list.find((t) => t.guid === candidate.guid)
      if (hit) {
        visible.push({
          ...candidate,
          albumTotal: Number(json?.data?.total ?? 0),
          // 目标在专辑**第一页**里的行号（虚拟列表按行高定位用）。
          indexInAlbum: list.findIndex((t) => t.guid === candidate.guid),
        })
        if (visible.length >= 3) break
      }
    }
    return { found: visible.slice(0, 5), histogram, total: found.length }
  })
}

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-alac-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

try {
  const window = await app.firstWindow()
  console.log('\n─── Step D：客户端 FFmpeg 兜底全链路 ───\n')

  // -- 登录 -----------------------------------------------------------------
  await window.fill('#fnm-address', SERVER)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window.getByText('已连接', { exact: false }).first().waitFor({ timeout: 30000 })
  console.log('✓ 登录成功')

  // -- 找不可解格式的曲目 ---------------------------------------------------
  const scan = await findUndecodable(window)
  const histogram = Object.entries(scan.histogram ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([codec, n]) => `${codec}×${n}`)
    .join('、')
  console.log(`扫描编码分布：${histogram || '（无）'}`)
  console.log(`不可解格式曲目数：${scan.total}`)

  if (scan.found.length === 0) {
    console.log('✗ 曲库里没找到 ALAC / APE 曲目，本步骤无法验证。')
    process.exitCode = 1
  } else {
    console.log('体积最小的几首（且在专辑前 50 首内、点得到）：')
    for (const c of scan.found) {
      console.log(
        `   · ${c.title}｜${c.codec}｜${(c.size / 1048576).toFixed(1)} MB｜${Math.round(c.durationMs / 60000)} 分钟｜专辑「${c.albumName}」（共 ${c.albumTotal} 首）`,
      )
    }
    // -- 逐个候选：按**曲目标题**搜到它 ------------------------------------
    // ⚠️ 实测：曲库里存在**同名但不同实体**的专辑（搜索「十年一刻」会命中另一个只有 1 首的实体），
    //    所以**必须按曲目标题搜**（标题更唯一），且要在虚拟列表里滚到那一行。
    await window.locator('nav[aria-label="主导航"] button', { hasText: '搜索' }).first().click()
    const input = window.locator('input[type="search"], input[type="text"]').first()
    await input.waitFor({ timeout: 10000 })

    /** 在搜索结果里定位某个 guid 的下载按钮；找不到返回 null。 */
    const locateRow = async (guid) => {
      const selector = `[data-testid="fnm-download-button"][data-song-id="${guid}"]`
      if ((await window.locator(selector).count()) > 0) return selector
      // 搜索结果一次性全在 store 里（服务端忽略分页），滚虚拟列表即可渲染出任意一行。
      for (let offset = 0; offset <= 6000; offset += 600) {
        await window.evaluate((scrollTop) => {
          const list = document.querySelector('[aria-label="搜索结果歌曲列表"]')
          if (!list) return
          list.scrollTop = scrollTop
          list.dispatchEvent(new Event('scroll', { bubbles: true }))
        }, offset)
        await window.waitForTimeout(400)
        if ((await window.locator(selector).count()) > 0) return selector
      }
      return null
    }

    let target = null
    let dlSelector = ''
    for (const candidate of scan.found) {
      await input.fill(candidate.title)
      await input.press('Enter')
      await window.waitForTimeout(4000)
      const selector = await locateRow(candidate.guid)
      if (selector) {
        target = candidate
        dlSelector = selector
        console.log(`✓ 搜索命中「${candidate.title}」，找到目标曲目行`)
        break
      }
      console.log(`· 搜索「${candidate.title}」没找到目标行，换下一首`)
    }

    if (!target) {
      const diag = await window.evaluate(() => ({
        status: document.querySelector('.fnm-page__status')?.textContent?.trim() ?? '',
        error: document.querySelector('.fnm-page__error')?.textContent?.trim() ?? '',
        rows: document.querySelectorAll('[role="option"]').length,
        counts: document.querySelector('[data-testid="fnm-search-count-tracks"]')?.textContent?.trim() ?? '',
      }))
      console.log(
        `✗ 候选曲目都没能在搜索结果里定位到行。` +
          `诊断：命中「${diag.counts}」状态「${diag.status}」错误「${diag.error}」已渲染 ${diag.rows} 行`,
      )
      process.exitCode = 1
    } else {
      // -- 下载 -------------------------------------------------------------
      const dlButton = window.locator(dlSelector).first()
      await dlButton.scrollIntoViewIfNeeded()
      await dlButton.click()
      console.log('… 已点下载，等待落盘（中继带宽有限，可能要几分钟）')
      const deadline = Date.now() + 20 * 60 * 1000
      let status = ''
      while (Date.now() < deadline) {
        status = (await dlButton.getAttribute('data-status')) ?? ''
        if (status === 'done' || status === 'error') break
        await window.waitForTimeout(1500)
      }
      console.log(`${status === 'done' ? '✓' : '✗'} 下载状态：${status}`)

      if (status !== 'done') {
        process.exitCode = 1
      } else {
        // -- 播放（应触发兜底转码）---------------------------------------
        const row = window
          .locator('[role="option"]')
          .filter({ has: window.locator(dlSelector) })
          .first()
        await row.scrollIntoViewIfNeeded()
        await row.dblclick()

        let audioSrc = ''
        let barTitle = ''
        let notice = ''
        let position = ''
        const playDeadline = Date.now() + 180000
        while (Date.now() < playDeadline) {
          const snapshot = await window.evaluate(() => {
            const audio = document.querySelector('audio')
            return {
              src: audio?.getAttribute('src') ?? audio?.src ?? '',
              bar: document.querySelector('.fnm-playerbar__title')?.textContent?.trim() ?? '',
              notice:
                document.querySelector('[data-testid="player-notice"]')?.textContent?.trim() ?? '',
              position: document.querySelector('[data-testid="player-position"]')?.textContent?.trim() ?? '',
            }
          })
          audioSrc = snapshot.src
          barTitle = snapshot.bar
          notice = snapshot.notice
          position = snapshot.position
          if (audioSrc.startsWith('fnml://') && position && position !== '0:00') break
          await window.waitForTimeout(1000)
        }

        console.log(`  播放条标题：${barTitle || '（空）'}`)
        console.log(`  播放提示：${notice || '（无）'}`)
        console.log(`  播放进度：${position || '（无）'}`)
        console.log(`  <audio> src：${audioSrc || '（空）'}`)

        const isLocal = audioSrc.startsWith('fnml://')
        const advanced = Boolean(position) && position !== '0:00'
        console.log(
          `${isLocal ? '✓' : '✗'} 播放源是本地产物（fnml://）：${isLocal}\n` +
            `${advanced ? '✓' : '✗'} 进度已推进：${advanced}`,
        )
        if (!isLocal || !advanced) process.exitCode = 1

        // -- 落盘产物 --------------------------------------------------------
        let downloaded = '（未读到下载索引）'
        try {
          const index = JSON.parse(readFileSync(join(userDataDir, 'downloads.json'), 'utf8'))
          const entry = Object.values(index.entries ?? {}).find((e) => e?.songId === target.guid)
          if (entry?.file) {
            downloaded = `${entry.file}（${(statSync(entry.file).size / 1048576).toFixed(1)} MB）`
          }
        } catch {
          /* 索引缺失就如实说明 */
        }
        console.log(`\n下载落盘：${downloaded}`)

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
        console.log(`兜底产物目录（<userData>/fallback）：${artifacts}`)
      }
    }
  }
} catch (err) {
  console.log(`\n✗ Step D 失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
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
