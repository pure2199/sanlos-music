// ---------------------------------------------------------------------------
// 收藏写回器（串行化 + 序号守卫）—— Task 25
// ---------------------------------------------------------------------------
//
// 这个模块回答一个问题：**「用户点了收藏，界面与服务端怎么保持一致？」**
//
// ---------------------------------------------------------------------------
// 为什么从 SearchPanel 里搬出来
// ---------------------------------------------------------------------------
// 原来这段逻辑住在 `src/components/SearchPanel.tsx` 里（Task 16 写的），
// 于是**只有搜索页**能收藏 —— 曲库 / 收藏 / 专辑 / 歌手 / 风格 / 歌单 / 最近播放
// 这些页面的歌曲行**一个收藏入口都没有**（用户看到的是「收藏页能收藏，
// 但在别的地方收藏不了」这种割裂）。
//
// T25 要把行内收藏铺到**所有**列歌曲的页面 → 写回器必须先变成**公共件**。
//
// ⚠️ **既有导入路径保持不变**：`SearchPanel.tsx` 仍然 `export { createFavoriteWriteback }`，
//    `test/favorite-writeback.test.ts` 的 import **一个字都不用改**。
//
// ---------------------------------------------------------------------------
// 语义（逐条定死，不要自己发挥）
// ---------------------------------------------------------------------------
// - **乐观更新**：点击后界面**立刻**反映目标态（不等请求回来）；
// - **串行化**：同一首歌的多次写回**排队**，上一笔落地后才发下一笔
//   （否则「收藏 → 取消」两次请求乱序到达，最终态可能反了）；
// - **序号守卫**：每次点击 +1；**只有最新一笔**的失败才回滚乐观态
//   （过期的一笔失败不能把用户更新的意图推回去）；
// - **失败回滚**：回滚到「已确认态」（最后一次成功写入的值），并留下可读提示；
// - **已确认态与乐观态分离**：`committed`（服务端确认过的）与 `target`（界面显示的）。
//
// ---------------------------------------------------------------------------

/** 单首歌的收藏写回状态。 */
export interface FavoriteWritebackState {
  /** 目标态（乐观值——界面立刻按它显示）。 */
  target: boolean
  /** 已确认态（最后一次写回成功的服务端态；失败回滚到它）。 */
  committed: boolean
  /** 是否正在写回（含排队中的）。 */
  pending: boolean
  /** 序号（每次点击 +1；用来判断响应是否过期）。 */
  seq: number
}

/** 收藏写回器（对外接口）。 */
export interface FavoriteWriteback {
  /** 读某首歌的写回状态（没有记录时按初始值合成）。 */
  get: (songId: string, initial: boolean) => FavoriteWritebackState
  /** 切换收藏态（乐观更新 → 串行化写回 → 失败回滚 + 提示）。 */
  toggle: (songId: string, initial: boolean) => void
  /** 订阅状态变化（返回退订函数）。 */
  subscribe: (listener: () => void) => () => void
  /** 版本号（变化即代表状态变了——给 `useSyncExternalStore` 用）。 */
  getSnapshot: () => number
  /** 最后一次写回失败的提示（没有则 `null`）。 */
  getLastError: () => string | null
  /** 清掉失败提示。 */
  clearError: () => void
}

/** 把异常变成可读的文案。 */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : '操作失败，请稍后重试'
}

/**
 * 造一个收藏写回器。
 *
 * @param setFavorite 真正的写回实现（`favoriteApi.set`）。
 */
export function createFavoriteWriteback(
  setFavorite: (songId: string, on: boolean) => Promise<void>,
): FavoriteWriteback {
  /** 每首歌的写回状态（`inflight` = 排队 + 在途的笔数）。 */
  interface Entry extends FavoriteWritebackState {
    inflight: number
  }

  const entries = new Map<string, Entry>()
  /** 每首歌的写回**串行队列**（上一笔落地后才发下一笔）。 */
  const chains = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()
  let version = 0
  let lastError: string | null = null

  const emit = (): void => {
    version += 1
    for (const listener of Array.from(listeners)) listener()
  }

  const read = (songId: string, initial: boolean): FavoriteWritebackState => {
    const entry = entries.get(songId)
    if (!entry) return { target: initial, committed: initial, pending: false, seq: 0 }
    return {
      target: entry.target,
      committed: entry.committed,
      pending: entry.inflight > 0,
      seq: entry.seq,
    }
  }

  const toggle = (songId: string, initial: boolean): void => {
    const entry = entries.get(songId)
    const current = entry ? entry.target : initial
    const next = !current
    const seq = (entry?.seq ?? 0) + 1

    // 乐观更新：先改本地态并立刻反映到界面，**后**发请求。
    entries.set(songId, {
      target: next,
      committed: entry ? entry.committed : initial,
      pending: true,
      seq,
      inflight: (entry?.inflight ?? 0) + 1,
    })
    lastError = null
    emit()

    // 串行化：这一笔接在此前所有写回之后。
    const previous = chains.get(songId) ?? Promise.resolve()
    const started = previous.then(() => setFavorite(songId, next))
    chains.set(
      songId,
      started.then(
        () => undefined,
        () => undefined,
      ),
    )

    started.then(
      () => {
        const current2 = entries.get(songId)
        if (!current2) return
        const isLatest = current2.seq === seq
        entries.set(songId, {
          ...current2,
          // 成功 = 服务端已确认这一笔的值；
          // 但**不覆盖**更新的乐观态（更新的点击才是用户当前的意图）。
          committed: next,
          target: isLatest ? next : current2.target,
          pending: current2.inflight - 1 > 0,
          inflight: Math.max(0, current2.inflight - 1),
        })
        emit()
      },
      (err: unknown) => {
        const current2 = entries.get(songId)
        if (!current2) return
        const isLatest = current2.seq === seq
        lastError = describeError(err)
        entries.set(songId, {
          ...current2,
          // 只有**最新一笔**失败才回滚；过期失败不回滚更新的乐观态。
          target: isLatest ? current2.committed : current2.target,
          pending: current2.inflight - 1 > 0,
          inflight: Math.max(0, current2.inflight - 1),
        })
        emit()
      },
    )
  }

  return {
    get: read,
    toggle,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => version,
    getLastError: () => lastError,
    clearError: () => {
      if (lastError === null) return
      lastError = null
      emit()
    },
  }
}
