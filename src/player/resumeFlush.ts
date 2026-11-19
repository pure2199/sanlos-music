// ---------------------------------------------------------------------------
// T123：退出前补写一次「上次播放」的位置
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这个文件**
// ---------------------------------------------------------------------------
// `src/state/playerStore.ts` 的 `persistResume()` 的规矩是「**切歌 / 暂停 / 每 10 秒**」
// 写一次 ⇒ **异常退出最多丢 10 秒进度**（台账原话：「把续播误差从最多 10 s 压到 ≈ 0」）。
//
// ⇒ 这里给渲染进程装一个**退出前**的钩子：窗口真正要没了（`beforeunload` / `pagehide`）
//    就**强制写一次**。
//
// ⚠️ **为什么不影响「关窗口后继续播放」**：
//    应用默认**关窗口只是隐藏**（播放继续）⇒ 那条路**不会**触发 `beforeunload` / `pagehide`
//    ⇒ 行为**一字不变**（播放继续时本来就有 10 秒节流在写）。
//    ⇒ 只有**应用真的要退出**时才会补写。
//
// ⚠️ **不许让补写影响退出**：写盘失败 / 抛异常都**吞掉**（退出路径不能被记录拖垮）。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。
// ---------------------------------------------------------------------------

/** 装上「退出前补写」的钩子；返回**卸载函数**。 */
export function installResumeFlush(flush: () => void): () => void {
  const onUnload = (): void => {
    try {
      flush()
    } catch {
      // ⚠️ 写盘失败**不许**影响退出（记录不是关键路径）。
    }
  }
  window.addEventListener('beforeunload', onUnload)
  // ⚠️ `pagehide` 补一手：Chromium 在某些退出路径上**只**发 `pagehide`
  //    （例如窗口被销毁 / 导航离开），不发 `beforeunload`。
  window.addEventListener('pagehide', onUnload)
  return () => {
    window.removeEventListener('beforeunload', onUnload)
    window.removeEventListener('pagehide', onUnload)
  }
}
