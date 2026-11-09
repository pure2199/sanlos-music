// T71 真机补丁：`electron/main.ts` 的**接线契约**（读源码断言，不启动 Electron）。
//
// ⚠️ 为什么读源码：主进程的窗口行为**没法在 jsdom 里跑**（要真 Electron、真窗口）。
//    而本缺陷**恰恰**在接线层：
//    「曲目 + 歌词」与「播放位置」是**两条不同的消息**
//    （`shared/playerBridge.ts` 的判别联合），而新建的歌词窗口**只拿得到最后一条**
//    ⇒ 它拿到了歌词却**没有位置** ⇒ 位置停在 0 ⇒ 当前词不在任何被渲染的行里
//    ⇒ **卡拉OK 不推进**（真机 E2E 实测：经典悬浮窗里 `--karaoke` 数量 = 0）。
//    ⇒ 「两条都补发」必须**静态**钉死，否则将来重构会踩回去。
//
// ⚠️ 用**本测试文件自身的位置**推导仓库根，与 cwd 无关
//    （cwd ≠ 仓库根时读到的就是别的目录 → 断言**空转通过**）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_SRC = readFileSync(join(REPO_ROOT, 'electron', 'main.ts'), 'utf8')

/**
 * 取 `marker` 之后那个函数的函数体（按大括号配平）。
 *
 * ⚠️ 用它是因为主进程的这些函数**没法单测**（要真 Electron），
 *    只能静态断言它们的**形状**。
 */
function bodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', start)
  if (open < 0) throw new Error(`no body after: ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces after: ${marker}`)
}

describe('T71 真机补丁：新建的歌词窗口要补发**两条**消息', () => {
  it('「曲目 + 歌词」与「播放位置」**分开缓存**（不再是「最后一条」）', () => {
    expect(MAIN_SRC).toContain('let lastTrackMessage: LyricOverlayMessage | null = null')
    expect(MAIN_SRC).toContain('let lastProgressMessage: LyricOverlayMessage | null = null')
  })

  it('旧的「最后一条」缓存已消失（否则又会只重放一条）', () => {
    expect(MAIN_SRC).not.toContain('lastLyricMessage')
  })

  it('onLyricState **按 kind** 分别落缓存', () => {
    const body = bodyAfter(MAIN_SRC, 'onLyricState: (message) => {')
    expect(body).toContain("if (message.kind === 'track') lastTrackMessage = message")
    expect(body).toContain("else if (message.kind === 'progress') lastProgressMessage = message")
  })

  it('replayLyricState **两条都发**（少一条 = 位置停在 0 = 卡拉OK 不推进）', () => {
    const body = bodyAfter(MAIN_SRC, 'const replayLyricState = (target: BrowserWindow): void => {')
    expect(body).toContain("target.webContents.send('lyric:state', lastTrackMessage)")
    expect(body).toContain("target.webContents.send('lyric:state', lastProgressMessage)")
    // ⚠️ 必须是**两条**（不是一条）：只发一条 ⇒ 新窗口要么没歌词、要么没位置。
    const sends = body.match(/webContents\.send\('lyric:state'/g) ?? []
    expect(sends).toHaveLength(2)
  })

  it('经典悬浮窗与灵动态词岛的 did-finish-load **都**走 replayLyricState', () => {
    const calls = MAIN_SRC.match(/replayLyricState\(win\)/g) ?? []
    expect(calls).toHaveLength(2)
    // ⚠️ 两个窗口的加载完成回调都必须存在（少一个 = 那个窗口永远拿不到消息）。
    const handlers = MAIN_SRC.match(/win\.webContents\.on\('did-finish-load'/g) ?? []
    expect(handlers).toHaveLength(2)
  })

  it('两个窗口的 did-finish-load 里**不再**直接发 lastLyricMessage', () => {
    expect(MAIN_SRC).not.toContain("webContents.send('lyric:state', lastLyricMessage)")
  })
})
