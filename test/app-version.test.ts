// ---------------------------------------------------------------------------
// T82：版本号 + 项目地址 + 自动更新从项目拉取（主进程侧）
// ---------------------------------------------------------------------------
//
// ⚠️ **钉的是什么**：
// 1. `app:version` → 渲染层能拿到**当前版本号**（渲染层是 sandbox，读不到
//    `package.json` ⇒ 版本号**只能**主进程给）。
// 2. 「检查更新」在**没配地址**时**回落项目地址** ⇒ 「从项目拉取」开箱即用；
//    配了别的地址就用别的源（渲染层不能指定地址）。
// 3. `allowUnsigned`（**默认关**）能落盘、只认**布尔**；关着时未签名包照旧拒绝。
//
// ⚠️ 测试数据全是占位数据（假 URL、假版本号），**不写真实更新服务器地址**。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APP_INFO } from '../shared/appInfo'
import {
  PrefsStore,
  registerPlayerIpc,
  registerUpdateIpc,
  type IpcMainEventsLike,
} from '../electron/ipc'
import type { UpdateController } from '../electron/update'

/** IPC 处理器的形状。 */
type Handler = (event: unknown, arg: unknown) => unknown

const tempDirs: string[] = []

/** 造一个临时偏好文件。 */
function tempFile(name = 'prefs.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnm-t82-'))
  tempDirs.push(dir)
  return join(dir, name)
}

/** 假 `ipcMain`（收集 handler）。 */
function fakeIpcMain(): { ipcMain: IpcMainEventsLike; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ipcMain: IpcMainEventsLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    on() {
      /* 本测试用不到推送通道 */
    },
  }
  return { ipcMain, handlers }
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 版本号
// ---------------------------------------------------------------------------

describe('版本号 IPC（T82）', () => {
  it('`app:version` → 返回主进程给的版本号', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      appVersion: '0.2.1',
    })

    const handler = handlers.get('app:version')
    expect(handler).toBeTruthy()
    expect(await handler?.({}, undefined)).toBe('0.2.1')
  })

  it('没注入版本号 → 返回**空串**（不报错、不给假版本）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    registerPlayerIpc({ ipcMain, prefs: new PrefsStore({ filePath: tempFile() }) })

    const handler = handlers.get('app:version')
    expect(await handler?.({}, undefined)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 自动更新从项目拉取
// ---------------------------------------------------------------------------

describe('自动更新从项目拉取（T82）', () => {
  /** 记下被调用的更新控制器方法。 */
  function stubController(): { controller: UpdateController; checked: string[] } {
    const checked: string[] = []
    const controller: UpdateController = {
      check: async (baseUrl: string) => {
        checked.push(baseUrl)
        return { status: 'up-to-date', current: '0.2.1' }
      },
      download: async () => ({ status: 'error', message: '用不到' }),
      install: async () => ({ status: 'error', message: '用不到' }),
    }
    return { controller, checked }
  }

  it('**没配地址** → 自动用**项目地址**（不用手填一遍）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const { controller, checked } = stubController()
    registerUpdateIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      update: controller,
    })

    const handler = handlers.get('update:check')
    await handler?.({}, undefined)

    expect(checked).toEqual([APP_INFO.updateBaseUrl])
  })

  it('**配了别的地址** → 用那个地址（不回落）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const { controller, checked } = stubController()
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ update: { baseUrl: 'https://updates.example.com/fnmusic' } })
    registerUpdateIpc({ ipcMain, prefs, update: controller })

    const handler = handlers.get('update:check')
    await handler?.({}, undefined)

    expect(checked).toEqual(['https://updates.example.com/fnmusic'])
  })

  it('`allowUnsigned` 能落盘，且**只认布尔**（别的类型整段丢弃）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })

    prefs.write({ update: { baseUrl: '', expectedSigner: '', allowUnsigned: true } })
    expect(prefs.read().update?.allowUnsigned).toBe(true)

    // ⚠️ 非布尔 → **不写进落盘的那份**（清洗时整段丢掉）。
    //    （`update` 是个整体替换 ⇒ 顺带把上一条也换掉了。）
    prefs.write({ update: { baseUrl: '', expectedSigner: '', allowUnsigned: 'yes' } as never })
    expect(prefs.read().update?.allowUnsigned).toBeUndefined()

    // ⚠️ 显式写 `false` 是**允许**的（关掉这条授权）。
    prefs.write({ update: { allowUnsigned: false } })
    expect(prefs.read().update?.allowUnsigned).toBe(false)
  })

  it('**默认没开** `allowUnsigned`（未签名包照旧被拒）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    expect(prefs.read().update?.allowUnsigned).toBeUndefined()
  })

  it('`update:install` 把 `allowUnsigned` **透传给控制器**', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const install = vi.fn(async () => ({ status: 'ok' as const, path: 'C:/占位/a.exe' }))
    const controller: UpdateController = {
      check: async () => ({ status: 'up-to-date', current: '0.2.1' }),
      download: async () => ({ status: 'error', message: '用不到' }),
      install,
    }
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ update: { allowUnsigned: true } })
    registerUpdateIpc({ ipcMain, prefs, update: controller })

    const handler = handlers.get('update:install')
    await handler?.({}, { name: 'FN-Music-Setup-9.9.9.exe' })

    expect(install).toHaveBeenCalledWith('FN-Music-Setup-9.9.9.exe', undefined, true)
  })
})
