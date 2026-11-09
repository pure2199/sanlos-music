// T70：歌词来源**优先级**偏好（`prefs.lyric.priority`）的落盘往返。
//
// ⚠️ 为什么要单独测：偏好文件是**用户手改也改得动**的地方 → 里面可能有
//    任意形状的 `priority`（旧版本、手改、别的软件写的）→ 主进程的白名单
//    必须「只认两个合法值，其余一律丢弃」，**不能**把乱值写进内存偏好。
//
// ⚠️ 还要钉住一条**很容易踩**的坑：`prefs.json` 的 `lyric` 组是**整体替换**的
//    （`PrefsStore.write` 只在**顶层**合并）⇒ 只写 `{source, template}`
//    会把 `priority` **悄悄抹掉** ⇒ 渲染层必须**整组一起写**。

import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrefsStore } from '../electron/ipc'

/** 每次用例一个独立的偏好文件（系统临时目录，不入库）。 */
function tempFile(): string {
  return join(tmpdir(), `fnm-t70-prefs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

describe('T70 歌词优先级偏好', () => {
  it("priority: 'local-first' → 原样保留", () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyric: { source: 'netease', template: '', priority: 'local-first' } })
    expect(prefs.read().lyric?.priority).toBe('local-first')
  })

  it("priority: 'online-first' → 原样保留", () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyric: { source: 'netease', template: '', priority: 'online-first' } })
    expect(prefs.read().lyric?.priority).toBe('online-first')
  })

  it('非法值 → **丢弃该字段**（不写半截进偏好）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({
      lyric: { source: 'netease', template: '', priority: 'garbage' as never },
    })
    expect(prefs.read().lyric?.priority).toBeUndefined()
    // 其余字段**不受影响**（不能因为一个字段非法就整段丢掉）。
    expect(prefs.read().lyric?.source).toBe('netease')
  })

  it('缺省 → 不写 priority（读回来是 undefined ⇒ 渲染层归一化成「线上优先」）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyric: { source: 'netease', template: '' } })
    expect(prefs.read().lyric?.priority).toBeUndefined()
  })

  it('⚠️ `lyric` 组是**整体替换**的：只写源与模板会把 priority **抹掉**', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ lyric: { source: 'netease', template: '', priority: 'local-first' } })
    expect(prefs.read().lyric?.priority).toBe('local-first')
    // 只写源与模板 ⇒ **优先级没了**（这就是渲染层必须整组一起写的原因）。
    prefs.write({ lyric: { source: 'qq', template: 'https://example.com/{title}' } })
    expect(prefs.read().lyric?.priority).toBeUndefined()
    expect(prefs.read().lyric?.source).toBe('qq')
  })
})
