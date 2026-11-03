// ---------------------------------------------------------------------------
// EQ 偏好的**落盘形状**（主进程与渲染进程共用）
// ---------------------------------------------------------------------------
//
// ⚠️ 为什么单独一个文件：主进程的偏好白名单（`electron/ipc.ts` 的 `sanitizePatch`）
//    要**认**这个形状，渲染进程（`src/player/eq.ts`）也要**用它** ——
//    两边共用一份定义，避免各写一份慢慢走偏。
//
//    注意 `shared/playerBridge.ts` 是**纯类型**文件（不许出现运行时代码），
//    所以校验函数放在这里，而不是塞进那个文件。
//
// ⚠️ 这里**只有曲线参数**，**绝不含凭证**（凭证归 `session.bin` / DPAPI，两者不许混）。
// ---------------------------------------------------------------------------

/** EQ 偏好的落盘形状。 */
export interface EqPrefsPayload {
  /** 选中的预置（`'custom'` 也合法）。 */
  presetKey: string
  /** 手动偏移（每个段，dB）。 */
  manualOffset: number[]
  /** 段数（10 / 15）。 */
  bandCount: 10 | 15
  /** 是否启用。 */
  enabled: boolean
  /**
   * 预置基线（**可选**）。
   *
   * 存了就能**无损**恢复「自定义」曲线（否则重启后基线丢失，
   * 原本「基线 + 偏移」会退化成「只有偏移」）。缺省时按 `presetKey` 反推。
   */
  presetBaseline?: number[]
}

/**
 * 把任意输入压成**合法的 EQ 偏好载荷**（**浅**校验）。
 *
 * ⚠️ **浅**校验是刻意的分工：
 * - 主进程只保证「**落盘的东西形状对**」——不把明显畸形的值写进 `prefs.json`；
 * - **深度**校验（增益钳制到 ±12、段数归一、预置 key 归一）在渲染进程的
 *   `normalizeEqPrefs`（`src/player/eq.ts`）里——那份才是权威，且已有测试覆盖。
 *
 * @returns 合法的载荷；形状不对时返回 `null`（调用方**丢弃**这一段偏好）。
 */
export function sanitizeEqPrefsPayload(value: unknown): EqPrefsPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Partial<EqPrefsPayload>

  if (typeof raw.presetKey !== 'string' || raw.presetKey.length === 0) return null
  if (raw.bandCount !== 10 && raw.bandCount !== 15) return null
  if (typeof raw.enabled !== 'boolean') return null

  const manualOffset = readNumberArray(raw.manualOffset)
  if (!manualOffset) return null

  const payload: EqPrefsPayload = {
    presetKey: raw.presetKey,
    manualOffset,
    bandCount: raw.bandCount,
    enabled: raw.enabled,
  }

  if (raw.presetBaseline !== undefined) {
    const baseline = readNumberArray(raw.presetBaseline)
    if (!baseline) return null
    payload.presetBaseline = baseline
  }

  return payload
}

/**
 * 读一个「全是有限数字」的数组。
 *
 * @returns 合法数组；不是数组 / 有非数字元素时返回 `null`。
 */
function readNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null
    out.push(item)
  }
  return out
}
