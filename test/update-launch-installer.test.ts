// ---------------------------------------------------------------------------
// T87.18：「启动安装」在 Electron 主进程里取不到 shell 的回归测试
// ---------------------------------------------------------------------------
//
// ⚠️ **这个 bug 是真机实证发现的**（2026-11-12，T87.18）：
//
//    `electron/update.ts` 的 `defaultOpenPath()` 原来靠
//    `globalThis.require('electron')` 惰性取 `shell`，
//    而 **Electron 主进程里 `globalThis.require` 是 undefined**
//    （实测 Electron 32.3.3 / Node 20.18.1）
//    ⇒ 「启动安装」在真机上**必然**报
//    「启动安装包失败：当前进程没有 Electron 运行时，无法启动安装包」。
//
// ⚠️ **为什么一直没被发现**：
//    - E2E 只测了**负路**（未签名 ⇒ 「启动安装」按钮被禁用）⇒ 走不到启动那一步；
//    - 单测全部**注入替身**（`openPath`）⇒ 从不碰真实的惰性解析。
//
// ⇒ 本文件钉住三件事：
//    ① `require` 的**挑选顺序**（模块作用域优先 ⇒ 主进程拿得到）；
//    ② 惰性解析的**容错口径**（各种拿不到的情形一律 `null`，不抛）；
//    ③ 拿不到 Electron 时**只返回可读文案**（不抛错 ⇒ 界面显示得出来）。
//
// ⚠️ 「主进程里真的能取到 shell」这件事**单测验不了**（单测环境没有 Electron）
//    ⇒ 由 `release/verify/t89-6-entry.ts` 的真机实证负责（F8 / F9）。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  defaultOpenPath,
  pickRequire,
  resolveElectronShell,
  resolveElectronShellFrom,
} from '../electron/update'

// ---------------------------------------------------------------------------
// ① require 的挑选顺序
// ---------------------------------------------------------------------------

describe('pickRequire：模块作用域的 require 优先', () => {
  it('两个都有 ⇒ 取**模块作用域**那个（主进程只有它是有的）', () => {
    const moduleRequire = (id: string): unknown => ({ from: 'module', id })
    const globalRequire = (id: string): unknown => ({ from: 'global', id })
    expect(pickRequire(moduleRequire, globalRequire)).toBe(moduleRequire)
  })

  it('只有 globalThis.require ⇒ 取它', () => {
    const globalRequire = (id: string): unknown => ({ from: 'global', id })
    expect(pickRequire(undefined, globalRequire)).toBe(globalRequire)
  })

  it('两个都没有 ⇒ null（单测环境就是这个结果）', () => {
    expect(pickRequire(undefined, undefined)).toBeNull()
  })

  it('不是函数的东西一律当「没有」（别被真值骗了）', () => {
    const notAFunction = 'require' as unknown as (id: string) => unknown
    expect(pickRequire(notAFunction, undefined)).toBeNull()
    expect(pickRequire(undefined, notAFunction)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ② 惰性解析的容错口径
// ---------------------------------------------------------------------------

/** 造一个假的 `electron` 模块。 */
function fakeElectron(shell: unknown): (id: string) => unknown {
  return (id: string): unknown => {
    if (id !== 'electron') return undefined
    return { shell }
  }
}

describe('resolveElectronShellFrom：拿不到就返回 null，绝不抛', () => {
  it('require 是 null ⇒ null', () => {
    expect(resolveElectronShellFrom(null)).toBeNull()
  })

  it('require 抛错 ⇒ null（不把异常冒给调用方）', () => {
    const throwing = (): never => {
      throw new Error('boom')
    }
    expect(resolveElectronShellFrom(throwing)).toBeNull()
  })

  it('require 返回**字符串**（非 Electron 进程里的 `require("electron")`）⇒ null', () => {
    // ⚠️ 在普通 Node 里 `require('electron')` 返回的是**可执行文件路径字符串**，
    //    不是模块对象 ⇒ 这条分支必须判成「拿不到」。
    expect(resolveElectronShellFrom((id: string) => `/path/to/${id}`)).toBeNull()
  })

  it('模块里没有 shell ⇒ null', () => {
    expect(resolveElectronShellFrom(fakeElectron(undefined))).toBeNull()
    expect(resolveElectronShellFrom(fakeElectron(null))).toBeNull()
    expect(resolveElectronShellFrom(fakeElectron('不是对象'))).toBeNull()
  })

  it('shell 里没有 openPath ⇒ null', () => {
    expect(resolveElectronShellFrom(fakeElectron({}))).toBeNull()
    expect(resolveElectronShellFrom(fakeElectron({ openPath: '不是函数' }))).toBeNull()
  })

  it('正常 ⇒ 返回适配器，且 openPath **转发给原来的 shell**', async () => {
    const openPath = vi.fn(async (target: string) => `opened:${target}`)
    const shell = { openPath }
    const adapter = resolveElectronShellFrom(fakeElectron(shell))
    expect(adapter).not.toBeNull()
    if (!adapter) throw new Error('拿不到 shell')
    await expect(adapter.openPath('C:/安装包.exe')).resolves.toBe('opened:C:/安装包.exe')
    expect(openPath).toHaveBeenCalledWith('C:/安装包.exe')
  })

  it('openPath 是**被 bind 的**（脱离原对象单独调用也不丢 this）', async () => {
    const shell = {
      marker: 'SANLOS',
      async openPath(this: { marker: string }, target: string): Promise<string> {
        return `${this.marker}:${target}`
      },
    }
    const adapter = resolveElectronShellFrom(fakeElectron(shell))
    if (!adapter) throw new Error('拿不到 shell')
    const detached = adapter.openPath
    await expect(detached('x.exe')).resolves.toBe('SANLOS:x.exe')
  })
})

// ---------------------------------------------------------------------------
// ③ resolveElectronShell 的注入口 + 默认启动器的容错
// ---------------------------------------------------------------------------

describe('resolveElectronShell：注入口', () => {
  it('传了 require ⇒ 用传的那个', () => {
    const openPath = vi.fn(async () => '')
    const adapter = resolveElectronShell(fakeElectron({ openPath }))
    expect(adapter).not.toBeNull()
  })

  it('显式传 null ⇒ null（**不回落**到当前环境）', () => {
    expect(resolveElectronShell(null)).toBeNull()
  })

  it('不传 ⇒ 用当前环境的 require（单测环境里没有 ⇒ null）', () => {
    const adapter = resolveElectronShell()
    // ⚠️ 单测环境是 ESM ⇒ 两个 `require` 都没有 ⇒ 必须是 null。
    //    （主进程里这里会拿到 shell —— 由真机实证负责，见文件头说明。）
    expect(adapter).toBeNull()
  })
})

describe('defaultOpenPath：拿不到 Electron 运行时也不抛', () => {
  it('返回**可读的中文文案**（界面要能显示出来）', async () => {
    const message = await defaultOpenPath('C:/不存在的安装包.exe')
    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(0)
    expect(message).toContain('安装包')
  })
})
