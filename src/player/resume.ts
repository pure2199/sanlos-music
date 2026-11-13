// ---------------------------------------------------------------------------
// T89-⑲：「上次播放」记录（**运行状态**，不是偏好）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么它不住在 `prefs.json`**：
// - `prefs.json` 的语义是**用户偏好**（「要不要这样」）；
// - 「上次是哪一首、播到第几秒」是**运行状态**（跟 `fnmusic-local-history`
//   那个「本机播放记录」同族）；
// - ⚠️ 而且主进程早就把这条纪律钉死了：**播放状态是「临时态，不落盘」**
//   （`electron/main.ts`），把它写进偏好文件就等于把临时态变成用户偏好。
// ⇒ 这个模块的记录走 `localStorage`（见 `resumeBridge.ts`）。
//
// ⚠️ **为什么只存 7 个字段**：够「显示 + 定位」就够了，`Song` 那 20+ 个字段
//   大部分与恢复无关。
// ⚠️ **但恢复时绝不能直接拿这条记录去播**（见 `src/state/resumeFlow.ts`）：
//   `codec` 留空会被引擎判成「Chromium 解不了」而可能根本播不起来；
//   `favorite` 留空会显示「未收藏」、用户一点可能把服务端的收藏反过来写掉。
//   ⇒ 必须拿到曲库里的**完整曲目**。
//
// 只用浏览器 API，不 import Node 内置模块或 Electron API。
// ---------------------------------------------------------------------------

/** 上次播放的记录（**只存恢复必需的 7 个字段**）。 */
export interface ResumeRecord {
  /** 曲目 guid。 */
  id: string
  /** 歌名（显示用）。 */
  title: string
  /** 歌手（显示用）。 */
  artist: string
  /** 封面 id（显示用；无封面时是空串）。 */
  coverId: string
  /** 该曲总时长（**秒**）——判定「距结尾还有多远」用。 */
  duration: number
  /** 上次播到的位置（**秒**）。 */
  positionSec: number
  /** 记录写入时间（Unix **毫秒**）。 */
  updatedAt: number
}

/**
 * 「上次播放」的持久化端口（**可注入**）。
 *
 * ⚠️ 做成端口而不是直接读写 `localStorage`：
 *   单测要能注入假端口，生产用 `resumeBridge.ts` 里的真实现，
 *   没有 `localStorage` 的环境（浏览器预览 / 隐私模式）自动降级为 no-op。
 */
export interface ResumePort {
  /** 读回上次播放的记录；没有 / 读失败 ⇒ `null`。 */
  load(): Promise<ResumeRecord | null>
  /** 写一条记录。 */
  save(record: ResumeRecord): Promise<void>
  /** 清除记录（「设置」里那个「清除上次播放记录」按钮）。 */
  clear(): Promise<void>
}

/**
 * 位置**太靠前**就不值得续（从头播更自然）。
 *
 * ⚠️ 这是**经验值**：3 秒处续播，用户会觉得「怎么从头开始了」。
 */
export const RESUME_MIN_POSITION_SEC = 30

/**
 * **距结尾太近**就不值得续（差几秒就播完了，续过去等于直接结束）。
 */
export const RESUME_TAIL_GUARD_SEC = 15

/**
 * 把任意输入压成合法的记录；**任何一项不合法就整条丢弃**。
 *
 * ⚠️ **外部数据不可信**：这条记录来自 `localStorage`（用户可编辑）⇒
 *   陌生值一律丢弃，**绝不**构造出半截数据（那样界面会显示错的歌名 / 错的进度）。
 */
export function normalizeResumeRecord(raw: unknown): ResumeRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  const id = record['id']
  if (typeof id !== 'string' || id.length === 0) return null

  const title = record['title']
  if (typeof title !== 'string') return null

  const artist = record['artist']
  if (typeof artist !== 'string') return null

  const coverId = record['coverId']
  if (typeof coverId !== 'string') return null

  const duration = record['duration']
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null

  const positionSec = record['positionSec']
  if (typeof positionSec !== 'number' || !Number.isFinite(positionSec) || positionSec < 0) return null

  const updatedAt = record['updatedAt']
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return null

  return { id, title, artist, coverId, duration, positionSec, updatedAt }
}

/**
 * 这条记录**值得**恢复吗？
 *
 * ⚠️ 两个门槛（都有理由，别随手改）：
 * - 位置 ≥ {@link RESUME_MIN_POSITION_SEC}：刚开头就续 ⇒ 用户觉得「怎么从头开始了」；
 * - 距结尾 ≥ {@link RESUME_TAIL_GUARD_SEC}：差几秒就播完还续 ⇒ 荒唐。
 */
export function shouldResume(record: ResumeRecord | null): boolean {
  if (!record) return false
  if (record.positionSec < RESUME_MIN_POSITION_SEC) return false
  if (record.duration - record.positionSec < RESUME_TAIL_GUARD_SEC) return false
  return true
}
