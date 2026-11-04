// 真机联调校准：**专辑 id 的三处来源是否一致**（T17 诊断）。
//
// ---------------------------------------------------------------------------
// 现象
// ---------------------------------------------------------------------------
// 客户端从「搜索结果」点开专辑 → 专辑详情页显示「已加载 1 / 1 首」，
// 而探针用**曲目对象里的 `album.guid`** 请求 `/track/album-detail/list` 能拿到 46 首。
// ⇒ 怀疑：**搜索结果里的专辑 id**、**曲目里的 `album.guid`**、**详情端点回显的 guid**
//    可能是**三套不同的 id**。
//
// 这个脚本在**客户端渲染进程**里（走 `fnm://` → 主进程代理 → 真实 NAS）逐个比对：
//   G1 = 曲目对象里的 `album.guid`
//   G2 = `/search/album` 结果里的专辑 `guid`
//   G3 = `/album/detail?guid=G2` 回显的 `guid`
// 并分别用三者请求 `/track/album-detail/list?albumGUID=<id>`，看各自返回几首。
//
// 凭证只从环境变量读，不打印、不落盘。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-album-guid-probe.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
const SERVER = process.env.FN_SERVER ?? ''
if (!FN_USER || !FN_PASS || !SERVER) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-album-guid-probe.mjs')
  process.exit(2)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-guid-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})

try {
  const window = await app.firstWindow()
  await window.fill('#fnm-address', SERVER)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window.getByText('已连接', { exact: false }).first().waitFor({ timeout: 30000 })

  const report = await window.evaluate(async () => {
    /** 调一个 API 并拿到 data。 */
    const get = async (path) => {
      const res = await fetch(`fnm://srv${path}`)
      const json = await res.json()
      return json?.data ?? null
    }

    // 取一首有专辑的曲目（逐页找第一首带 album.guid 的）。
    let track = null
    for (let page = 1; page <= 5 && !track; page += 1) {
      const data = await get(`/track/list?page=${page}&size=200`)
      const list = data?.list ?? []
      track = list.find((t) => t?.album?.guid) ?? null
    }
    if (!track) return { error: '没找到带 album.guid 的曲目' }

    const G1 = String(track.album.guid)
    const albumName = String(track.album.name ?? '')

    // 搜索同名专辑，拿搜索结果里的 guid。
    const searched = await get(`/search/album?q=${encodeURIComponent(albumName)}`)
    const hits = searched?.list ?? []
    const hit = hits.find((a) => String(a.name ?? '') === albumName) ?? hits[0] ?? null
    const G2 = hit ? String(hit.guid ?? '') : ''

    // 详情端点回显的 guid。
    let G3 = ''
    let detailName = ''
    if (G2) {
      const detail = await get(`/album/detail?guid=${encodeURIComponent(G2)}`)
      G3 = String(detail?.guid ?? '')
      detailName = String(detail?.name ?? '')
    }

    // 分别用三个 id 请求专辑曲目。
    const countFor = async (id) => {
      if (!id) return { id, total: null, items: 0 }
      const data = await get(
        `/track/album-detail/list?albumGUID=${encodeURIComponent(id)}&page=1&size=50`,
      )
      return { id, total: Number(data?.total ?? -1), items: (data?.list ?? []).length }
    }

    return {
      trackTitle: track.title ?? '',
      albumName,
      G1,
      G2,
      G3,
      detailName,
      g1Count: await countFor(G1),
      g2Count: await countFor(G2),
      g3Count: await countFor(G3),
      searchHitCount: hits.length,
    }
  })

  console.log('\n─── 专辑 id 三处来源比对 ───\n')
  console.log(JSON.stringify(report, null, 2))
} catch (err) {
  console.log(`\n✗ 失败：${err instanceof Error ? err.message : String(err)}`)
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
