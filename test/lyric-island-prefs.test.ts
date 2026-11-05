// T45：桌面歌词**样式偏好**（`prefs.lyricOverlay.mode`）的归一化。
//
// ⚠️ 为什么要单独测：偏好文件是**用户手改也改得动**的地方 → 里面可能有
//    任意形状的 `mode`（旧版本、手改、别的软件写的）→ 归一化必须
//    「只认两个合法值，其余一律丢弃」，**不能**把乱值写进内存偏好。
//
// ⚠️ 缺省时**不写** `mode` → 老用户升级后行为一字不变（仍是经典悬浮窗）。

import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrefsStore } from '../electron/ipc'

/** 每次用例一个独立的偏好文件（系统临时目录，不入库）。 */
function tempFile(): string {
  return join(tmpdir(), `fnm-t45-prefs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

describe('T45 桌面歌词样式偏好', () => {
  it("mode: 'island' → 原样保留", () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyricOverlay: { visible: true, mode: 'island' } })
    expect(prefs.read().lyricOverlay?.mode).toBe('island')
  })

  it("mode: 'classic' → 原样保留", () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyricOverlay: { visible: true, mode: 'classic' } })
    expect(prefs.read().lyricOverlay?.mode).toBe('classic')
  })

  it('非法值 → **丢弃该字段**（不写半截进偏好）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({
      lyricOverlay: { visible: true, mode: 'garbage' as never },
    })
    expect(prefs.read().lyricOverlay?.mode).toBeUndefined()
    // 其余字段**不受影响**（不能因为一个字段非法就整段丢掉）
    expect(prefs.read().lyricOverlay?.visible).toBe(true)
  })

  it('缺省 → 不写 mode（老用户升级后行为不变）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyricOverlay: { visible: true } })
    expect(prefs.read().lyricOverlay?.mode).toBeUndefined()
  })

  it('mode 与 visible 互不影响', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyricOverlay: { visible: false, mode: 'island' } })
    const overlay = prefs.read().lyricOverlay
    expect(overlay?.visible).toBe(false)
    expect(overlay?.mode).toBe('island')
  })
})
