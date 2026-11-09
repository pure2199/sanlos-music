// T69：`electron/main.ts` 的**接线契约**（读源码断言，不启动 Electron）。
//
// ⚠️ 为什么读源码：主进程的窗口显隐**没法在 jsdom 里跑**（要真 Electron、
//    真窗口），但本任务**最危险的两个坑**全在接线层：
//    ① 用 `setLyricVisible(false)` 实现「暂停隐藏」⇒ 渲染层停止推送
//       ⇒ **恢复播放后词岛永不再现（死锁）**；
//    ② 把 `lyricPlaying` 写进 `prefs.json` ⇒ 临时态变成用户偏好。
//    ⇒ 这两条必须**静态**钉死，否则将来重构会踩回去。
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

/** 取出所有 `prefs.write({...})` 的调用文本。 */
function prefsWriteCalls(source: string): string[] {
  return source.match(/prefs\.write\(\{[\s\S]*?\}\)/g) ?? []
}

describe('T69 主进程接线契约', () => {
  it('applyIslandVisibility 存在，且是词岛显隐的唯一入口', () => {
    expect(MAIN_SRC).toContain('const applyIslandVisibility = (): void => {')
  })

  it('applyIslandVisibility **不**调用 setLyricVisible（否则渲染层停推 ⇒ 死锁）', () => {
    const body = bodyAfter(MAIN_SRC, 'const applyIslandVisibility = (): void => {')
    expect(body).not.toContain('setLyricVisible')
  })

  it('applyIslandVisibility **不**发 lyric:visibility（那会让渲染层停推）', () => {
    const body = bodyAfter(MAIN_SRC, 'const applyIslandVisibility = (): void => {')
    expect(body).not.toContain('lyric:visibility')
  })

  it('applyIslandVisibility 只在「应显示 ≠ 当前可见」时才动窗口', () => {
    const body = bodyAfter(MAIN_SRC, 'const applyIslandVisibility = (): void => {')
    expect(body).toContain('shouldShowIsland(')
    // ⚠️ 守卫必须**原样**存在：只断言「出现过 isVisible()」会被下方的
    //    hide 分支蒙混过关（变异自证 M8 就是这么漏网的）。
    expect(body).toContain('if (win && win.isVisible()) return')
  })

  it('applyIslandVisibility 对经典形态**直接返回**（经典窗行为一字不变）', () => {
    const body = bodyAfter(MAIN_SRC, 'const applyIslandVisibility = (): void => {')
    expect(body).toContain("if (lyricMode !== 'island') return")
  })

  it('lyricPlaying 是临时态：初值 false，且**不落盘**', () => {
    expect(MAIN_SRC).toContain('let lyricPlaying = false')
    for (const call of prefsWriteCalls(MAIN_SRC)) {
      expect(call).not.toContain('lyricPlaying')
    }
  })

  it('onLyricState 先更新播放状态、再更新可见性、最后才转发', () => {
    const body = bodyAfter(MAIN_SRC, 'onLyricState: (message) => {')
    const updateAt = body.indexOf('lyricPlaying = playingFromLyricMessage(')
    const applyAt = body.indexOf('applyIslandVisibility()')
    const forwardAt = body.indexOf("target.webContents.send('lyric:state'")
    expect(updateAt).toBeGreaterThanOrEqual(0)
    expect(applyAt).toBeGreaterThan(updateAt)
    expect(forwardAt).toBeGreaterThan(applyAt)
  })

  it('setLyricMode 的词岛分支改走 applyIslandVisibility', () => {
    const body = bodyAfter(MAIN_SRC, 'const setLyricMode = (mode: LyricOverlayMode): void => {')
    expect(body).toContain('applyIslandVisibility()')
    // 词岛的窗口**不该**再被直接 show（显隐只归 applyIslandVisibility 管）。
    expect(body).not.toContain('island?.show()')
  })

  it('setLyricVisible 的词岛分支改走 applyIslandVisibility', () => {
    const body = bodyAfter(MAIN_SRC, 'const setLyricVisible = (visible: boolean): void => {')
    expect(body).toContain('applyIslandVisibility()')
    expect(body).not.toContain('island?.show()')
  })

  it('经典悬浮窗的分支**一字未改**（仍是 createLyricWindow()?.show()）', () => {
    const body = bodyAfter(MAIN_SRC, 'const setLyricVisible = (visible: boolean): void => {')
    expect(body).toContain('createLyricWindow()?.show()')
  })

  it('lyric:visibility 的发送时机不变（仍在 setLyricVisible 末尾）', () => {
    const body = bodyAfter(MAIN_SRC, 'const setLyricVisible = (visible: boolean): void => {')
    const sendAt = body.indexOf("win.webContents.send('lyric:visibility', visible)")
    expect(sendAt).toBeGreaterThanOrEqual(0)
    // 必须在可见性判定之后 —— 否则渲染层停推就再也收不到 isPlaying。
    expect(body.indexOf('applyIslandVisibility()')).toBeLessThan(sendAt)
  })
})
