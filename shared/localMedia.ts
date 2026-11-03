// ---------------------------------------------------------------------------
// 本地媒体协议的**共享常量**（Task 11）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么放在 `shared/`**：
//    `electron/localMedia.ts` 要 import `node:path` / `node:fs`（主进程专属），
//    **渲染进程不能 import 它**（会把 Node 内置模块打进渲染包）。
//    故把「协议名 / 主机名 / URL 构造」这三样纯逻辑提到 `shared/`，
//    两边共用**同一份**——**不会出现两边地址写法不一致**的情况。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 歌曲 guid **只当作索引键**（主进程查本地索引），**绝不**参与拼文件路径；
// - 渲染进程**不能指定落盘路径**：落盘路径由主进程的下载索引决定。

/** 协议 scheme 名。 */
export const LOCAL_MEDIA_SCHEME = 'fnml'

/** 唯一允许的虚拟主机名。 */
export const LOCAL_MEDIA_HOST = 'local'

/**
 * 构造某个歌曲的本地媒体地址。
 *
 * 形状：`fnml://local/track/<encodeURIComponent(songId)>`。
 *
 * @param songId 歌曲 guid。
 */
export function localMediaUrl(songId: string): string {
  return `${LOCAL_MEDIA_SCHEME}://${LOCAL_MEDIA_HOST}/track/${encodeURIComponent(songId)}`
}
