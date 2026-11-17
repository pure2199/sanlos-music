// ---------------------------------------------------------------------------
// 曲目列表（**虚拟滚动**）的 E2E 辅助（T104）
// ---------------------------------------------------------------------------
//
// ⚠ **为什么需要它**：详情页的曲目列表用的是 `SongList` —— **虚拟滚动**
//    （DOM 节点数与**可视区**成正比，与曲目总数**无关**）。
//    ⇒ 「一共有 N 首」只能验**数据**（状态行「已加载 N / N」），
//      「最后一首能滚到」只能验**行为**（滚一遍 ⇒ 末行在场）。
//
// ⚠ **为什么不能直接 `expect(rows).toHaveCount(N)`**：
//    那验的是「**DOM 里有 N 行**」—— 在列表**滚不动**（T104 修掉的那个缺陷）时
//    **恰好成立**（视口被内容顶高 ⇒ 全部行都在 DOM 里）⇒ 它验的是**缺陷的副产品**。
//    T104 修好之后，DOM 里只剩「可视区那一屏 + 缓冲行」⇒ 这类断言会**假红**
//    （而且**随导航路径变化**：有时 12 行、有时 10 行 —— 因为「量高」在
//    列表初始为空时根本没生效，见 T105 候选缺陷）。
//
// ⇒ 本模块的收集法：**从顶滚到底，把每一屏的行按 `data-index` 收齐**
//    （`data-index` 是行在列表里的**绝对下标** ⇒ 与虚拟窗口无关）。
//    ⇒ 收齐 12 行本身就证明了「**能滚到底**」（收不齐 = 滚不到）。
// ---------------------------------------------------------------------------

import type { Page } from '@playwright/test'

/** 列表里的一行（按 `data-index` 定位 ⇒ 与虚拟窗口无关）。 */
export interface SongListRow {
  /** 行在列表里的**绝对下标**（`data-index`）。 */
  index: number
  /** 曲目标题。 */
  title: string
  /** 集号徽标（详情页才有；没有则 `null`）。 */
  episode: string | null
}

/** 读当前 DOM 里那一屏的行。 */
async function readVisibleRows(page: Page): Promise<SongListRow[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.fnm-songlist__row')].map((el) => ({
      index: Number(el.getAttribute('data-index') ?? '-1'),
      title: el.querySelector('.fnm-songlist__title')?.textContent ?? '',
      episode: el.querySelector('.fnm-detail__episode')?.textContent ?? null,
    })),
  )
}

/** 等虚拟窗口**真的挪了**（`data-scroll-top` 变了）。 */
async function waitForWindowMove(page: Page, previous: number): Promise<void> {
  await page
    .waitForFunction(
      (prev) =>
        Number(
          document.querySelector('.fnm-songlist__viewport')?.getAttribute('data-scroll-top') ?? '0',
        ) !== prev,
      previous,
      { timeout: 5_000, polling: 50 },
    )
    .catch(() => undefined)
}

/** 把列表滚回顶部（并等虚拟窗口回到顶）。 */
export async function scrollSongListToTop(page: Page): Promise<void> {
  const previous = await page.evaluate(() =>
    Number(document.querySelector('.fnm-songlist__viewport')?.getAttribute('data-scroll-top') ?? '0'),
  )
  await page.evaluate(() => {
    const v = document.querySelector('.fnm-songlist__viewport')
    if (v) v.scrollTop = 0
  })
  await waitForWindowMove(page, previous)
}

/** 把列表滚到底（并等虚拟窗口追上来）。 */
export async function scrollSongListToBottom(page: Page): Promise<void> {
  const previous = await page.evaluate(() =>
    Number(document.querySelector('.fnm-songlist__viewport')?.getAttribute('data-scroll-top') ?? '0'),
  )
  await page.evaluate(() => {
    const v = document.querySelector('.fnm-songlist__viewport')
    if (v) v.scrollTop = v.scrollHeight - v.clientHeight
  })
  await waitForWindowMove(page, previous)
}

/**
 * 把**整张列表**的行收上来（虚拟滚动 ⇒ DOM 只有一屏 ⇒ 必须滚一遍）。
 *
 * ⚠️ 收完会把列表**滚回顶部**（免得影响后续断言里「第一行是谁」）。
 *
 * @param page 主窗口页面。
 * @returns 按 `data-index` 升序、去重后的行。
 */
export async function collectSongListRows(page: Page): Promise<SongListRow[]> {
  const rows = new Map<number, SongListRow>()

  const absorb = async (): Promise<void> => {
    for (const row of await readVisibleRows(page)) {
      if (row.index >= 0) rows.set(row.index, row)
    }
  }

  await scrollSongListToTop(page)
  await absorb()

  // 一屏一屏往下滚（每步滚「一个视口高」⇒ 不会跳过整屏）。
  for (let step = 0; step < 200; step += 1) {
    const previous = await page.evaluate(() =>
      Number(document.querySelector('.fnm-songlist__viewport')?.getAttribute('data-scroll-top') ?? '0'),
    )
    const moved = await page.evaluate(() => {
      const v = document.querySelector('.fnm-songlist__viewport')
      if (!v) return false
      const max = v.scrollHeight - v.clientHeight
      if (v.scrollTop >= max - 1) return false
      v.scrollTop = Math.min(max, v.scrollTop + v.clientHeight)
      return true
    })
    if (!moved) break
    await waitForWindowMove(page, previous)
    await absorb()
  }
  await absorb()

  await scrollSongListToTop(page)
  return [...rows.values()].sort((a, b) => a.index - b.index)
}
